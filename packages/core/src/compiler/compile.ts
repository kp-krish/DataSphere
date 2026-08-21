/**
 * The query compiler.
 *
 * Takes a JSON query spec plus an introspected catalog and returns
 * parameterised SQL. This is the security boundary of DataSphere, so the
 * invariants it maintains are worth stating plainly:
 *
 *   1. Every identifier that reaches the SQL text was matched, with `===`,
 *      against a name the database reported about itself during introspection.
 *      There is no path by which a name absent from the catalog becomes SQL.
 *
 *   2. Every value supplied by the client becomes a bind parameter. Not one
 *      is interpolated - including LIMIT and OFFSET, which are integers and
 *      would have been safe to inline. Holding the line at "no exceptions"
 *      means there is no judgement call to get wrong later.
 *
 *   3. Every SQL keyword the spec can influence - aggregate function,
 *      comparison operator, date grain, sort direction - is emitted from a
 *      `switch` over a closed union that returns hardcoded string literals.
 *      Client input selects a branch; it never supplies the text.
 *
 *   4. The output is bounded. Row count is clamped to the configured ceiling
 *      regardless of what the spec asked for, and the spec itself is capped in
 *      how many fields it may carry.
 *
 * The module has no I/O and no dependencies, so every one of these properties
 * is directly unit-testable. See compile.test.ts and injection.test.ts.
 */

import { QueryCompileError } from '../errors.js';
import {
  assertValidAlias,
  deriveAlias,
  escapeLikePattern,
  quoteIdent,
  quoteQualified,
} from '../sql/identifiers.js';
import {
  aggregateAcceptsKind,
  isAggregateFn,
  isDateGrain,
  isGroupable,
  kindSupportsGrain,
  operandArity,
  operatorAcceptsKind,
} from '../catalog/rules.js';
import {
  createCatalogIndex,
  resolveDataset,
  resolveField,
  type CatalogIndex,
} from '../catalog/lookup.js';
import { assertValuesMatchKind } from './values.js';
import type {
  AggregateFn,
  BoundValue,
  Catalog,
  CatalogColumn,
  CatalogDataset,
  CatalogTable,
  CompiledQuery,
  DateGrain,
  Dimension,
  Filter,
  FilterOperator,
  Measure,
  QuerySpec,
  Sort,
} from '../types.js';

/* -------------------------------------------------------------------------- */
/* Options and limits                                                         */
/* -------------------------------------------------------------------------- */

export interface CompileOptions {
  /** Absolute ceiling on returned rows. A spec's own limit is clamped to this. */
  maxRows: number;
  /** Applied when the spec does not specify a limit. */
  defaultLimit?: number;
}

/**
 * Structural ceilings on a spec.
 *
 * These are not arbitrary tidiness. Each field in a spec becomes a select
 * item, a join, or a WHERE clause, and a spec with two hundred dimensions
 * compiles into a query that is expensive to plan before it is even executed.
 */
export const SPEC_LIMITS = {
  dimensions: 12,
  measures: 12,
  filters: 32,
  sorts: 8,
} as const;

/* -------------------------------------------------------------------------- */
/* Bind parameter collection                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Accumulates bind parameters and hands back the placeholder to put in the SQL.
 *
 * Centralising this is what makes invariant 2 checkable: `$` appears in the
 * compiler's output in exactly one place, the return value of `bind()`.
 */
class Params {
  private readonly values: BoundValue[] = [];

  bind(value: BoundValue): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  toArray(): BoundValue[] {
    return [...this.values];
  }
}

/* -------------------------------------------------------------------------- */
/* Keyword emission - closed switches over closed unions                      */
/* -------------------------------------------------------------------------- */

/**
 * date_trunc's field argument.
 *
 * The grain has already been validated as a member of the DateGrain union, but
 * this switch returns literals regardless, so the string in the SQL originates
 * here and not from the request body.
 */
function grainLiteral(grain: DateGrain): string {
  switch (grain) {
    case 'day':
      return "'day'";
    case 'week':
      return "'week'";
    case 'month':
      return "'month'";
    case 'quarter':
      return "'quarter'";
    case 'year':
      return "'year'";
  }
}

function comparisonOperator(operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'): string {
  switch (operator) {
    case 'eq':
      return '=';
    case 'neq':
      return '<>';
    case 'gt':
      return '>';
    case 'gte':
      return '>=';
    case 'lt':
      return '<';
    case 'lte':
      return '<=';
  }
}

/* -------------------------------------------------------------------------- */
/* Expression building                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The SQL expression for a dimension: a qualified column, optionally bucketed.
 *
 * A `date` bucketed by date_trunc comes back as a timestamp, so it is cast
 * back to date. Without that, "revenue by month" returns `2024-03-01T00:00:00`
 * instead of `2024-03-01` and every chart axis has to strip the time.
 */
function dimensionExpression(
  table: CatalogTable,
  column: CatalogColumn,
  grain: DateGrain | undefined,
): string {
  const qualified = quoteQualified(table.name, column.name);
  if (!grain) return qualified;

  const truncated = `date_trunc(${grainLiteral(grain)}, ${qualified})`;
  return column.kind === 'date' ? `${truncated}::date` : truncated;
}

function measureExpression(fn: AggregateFn, table: CatalogTable, column: CatalogColumn): string {
  const qualified = quoteQualified(table.name, column.name);
  switch (fn) {
    case 'COUNT':
      return `COUNT(${qualified})`;
    case 'COUNT_DISTINCT':
      return `COUNT(DISTINCT ${qualified})`;
    case 'SUM':
      return `SUM(${qualified})`;
    case 'AVG':
      return `AVG(${qualified})`;
    case 'MIN':
      return `MIN(${qualified})`;
    case 'MAX':
      return `MAX(${qualified})`;
  }
}

/* -------------------------------------------------------------------------- */
/* Compilation stages                                                         */
/* -------------------------------------------------------------------------- */

interface Projection {
  alias: string;
  expression: string;
  /** Dimensions are also GROUP BY keys; measures are not. */
  isDimension: boolean;
}

interface CompileState {
  index: CatalogIndex;
  dataset: CatalogDataset;
  params: Params;
  /** Tables actually referenced, so unreferenced dimensions are not joined. */
  referenced: Set<string>;
}

function compileDimensions(state: CompileState, dimensions: readonly Dimension[]): Projection[] {
  return dimensions.map((dimension, position) => {
    const context = { section: 'dimensions', position };
    const { table, column } = resolveField(state.index, state.dataset, dimension);
    state.referenced.add(table.name);

    if (!isGroupable(column.kind)) {
      throw new QueryCompileError(
        'not_groupable',
        `Column "${table.name}"."${column.name}" (${column.kind}) cannot be used as a dimension`,
        { ...context, table: table.name, column: column.name, kind: column.kind },
      );
    }

    let grain: DateGrain | undefined;
    if (dimension.grain !== undefined) {
      if (!isDateGrain(dimension.grain)) {
        throw new QueryCompileError('invalid_grain', `Unknown date grain "${dimension.grain}"`, {
          ...context,
          grain: dimension.grain,
        });
      }
      if (!kindSupportsGrain(column.kind)) {
        throw new QueryCompileError(
          'invalid_grain',
          `Grain is only valid on date or timestamp columns, not ${column.kind}`,
          { ...context, table: table.name, column: column.name, kind: column.kind },
        );
      }
      grain = dimension.grain;
    }

    const alias =
      dimension.alias === undefined
        ? deriveAlias(column.name, grain ?? '')
        : assertValidAlias(dimension.alias, context);

    return {
      alias,
      expression: dimensionExpression(table, column, grain),
      isDimension: true,
    };
  });
}

function compileMeasures(state: CompileState, measures: readonly Measure[]): Projection[] {
  return measures.map((measure, position) => {
    const context = { section: 'measures', position };

    if (!isAggregateFn(measure.fn)) {
      throw new QueryCompileError('invalid_aggregate', `Unknown aggregate "${measure.fn}"`, {
        ...context,
        fn: measure.fn,
      });
    }

    const { table, column } = resolveField(state.index, state.dataset, measure);
    state.referenced.add(table.name);

    if (!aggregateAcceptsKind(measure.fn, column.kind)) {
      throw new QueryCompileError(
        'not_aggregatable',
        `${measure.fn} cannot be applied to "${table.name}"."${column.name}" (${column.kind})`,
        { ...context, fn: measure.fn, table: table.name, column: column.name, kind: column.kind },
      );
    }

    const alias =
      measure.alias === undefined
        ? deriveAlias(column.name, measure.fn.toLowerCase())
        : assertValidAlias(measure.alias, context);

    return {
      alias,
      expression: measureExpression(measure.fn, table, column),
      isDimension: false,
    };
  });
}

function compileFilter(state: CompileState, filter: Filter, position: number): string {
  const context = { section: 'filters', position };
  const { table, column } = resolveField(state.index, state.dataset, filter);
  state.referenced.add(table.name);

  const operator = filter.operator;
  if (!operatorAcceptsKind(operator as FilterOperator, column.kind)) {
    throw new QueryCompileError(
      'invalid_operator',
      `Operator "${String(operator)}" is not valid for "${table.name}"."${column.name}" (${column.kind})`,
      { ...context, operator, table: table.name, column: column.name, kind: column.kind },
    );
  }

  const qualified = quoteQualified(table.name, column.name);
  const supplied = filter.values ?? [];
  const arity = operandArity(operator);

  if (supplied.length < arity.min || (arity.max !== null && supplied.length > arity.max)) {
    const expectation = arity.max === null ? `at least ${arity.min}` : `exactly ${arity.min}`;
    throw new QueryCompileError(
      'invalid_arity',
      `Operator "${operator}" takes ${expectation} operand(s), got ${supplied.length}`,
      { ...context, operator, provided: supplied.length },
    );
  }

  // Operands are validated against the column's kind before any of them is
  // bound, so a partially-bound parameter list can never be left behind.
  const values = assertValuesMatchKind(supplied, column.kind, {
    ...context,
    table: table.name,
    column: column.name,
  });

  switch (operator) {
    case 'is_null':
      return `${qualified} IS NULL`;
    case 'is_not_null':
      return `${qualified} IS NOT NULL`;

    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return `${qualified} ${comparisonOperator(operator)} ${state.params.bind(values[0]!)}`;

    case 'between':
      return `${qualified} BETWEEN ${state.params.bind(values[0]!)} AND ${state.params.bind(values[1]!)}`;

    // `= ANY($n)` rather than `IN ($1, $2, ...)`: one placeholder however many
    // operands there are, so the plan cache is not churned by a filter that
    // differs only in list length.
    case 'in':
      return `${qualified} = ANY(${state.params.bind(values)})`;
    case 'not_in':
      return `NOT (${qualified} = ANY(${state.params.bind(values)}))`;

    // ILIKE for case-insensitive matching, which is what a dashboard user
    // means by "contains". ESCAPE is stated explicitly so the behaviour does
    // not depend on the server's standard_conforming_strings setting.
    case 'contains':
      return `${qualified} ILIKE ${state.params.bind(`%${escapeLikePattern(values[0] as string)}%`)} ESCAPE '\\'`;
    case 'starts_with':
      return `${qualified} ILIKE ${state.params.bind(`${escapeLikePattern(values[0] as string)}%`)} ESCAPE '\\'`;
    case 'ends_with':
      return `${qualified} ILIKE ${state.params.bind(`%${escapeLikePattern(values[0] as string)}`)} ESCAPE '\\'`;

    default:
      throw new QueryCompileError('invalid_operator', `Unknown operator "${String(operator)}"`, {
        ...context,
        operator,
      });
  }
}

/**
 * Emit only the joins the query actually needs.
 *
 * A spec that groups by product category has no reason to join dim_customer.
 * Pruning unreferenced dimensions is not cosmetic: each unnecessary join is a
 * real hash build over a real table at execution time.
 *
 * The join is INNER when the fact's foreign key column is NOT NULL and LEFT
 * when it is nullable, so an optional dimension cannot silently drop fact rows
 * from an aggregate.
 */
function compileJoins(state: CompileState): string[] {
  const factTable = state.index.tables.get(state.dataset.factTable);

  return state.dataset.joins
    .filter((join) => state.referenced.has(join.table))
    .map((join) => {
      const factColumn = factTable?.columns.find((column) => column.name === join.factColumn);
      const joinType = factColumn?.nullable ? 'LEFT JOIN' : 'JOIN';

      return (
        `${joinType} ${quoteQualified(state.index.catalog.schema, join.table)} AS ${quoteIdent(join.table)}\n` +
        `  ON ${quoteQualified(join.table, join.dimensionColumn)}` +
        ` = ${quoteQualified(state.dataset.factTable, join.factColumn)}`
      );
    });
}

function compileSort(sorts: readonly Sort[], aliases: ReadonlySet<string>): string[] {
  return sorts.map((sort, position) => {
    const context = { section: 'sort', position };

    if (typeof sort.alias !== 'string' || !aliases.has(sort.alias)) {
      throw new QueryCompileError(
        'unknown_sort_alias',
        `Cannot sort by "${String(sort.alias)}" - it is not one of this query's output columns`,
        { ...context, alias: sort.alias, available: [...aliases] },
      );
    }

    if (sort.direction !== 'asc' && sort.direction !== 'desc') {
      throw new QueryCompileError(
        'invalid_sort_direction',
        `Sort direction must be "asc" or "desc", got "${String(sort.direction)}"`,
        { ...context, direction: sort.direction },
      );
    }

    // NULLS LAST in both directions. Postgres defaults to NULLS FIRST for
    // DESC, which puts empty values at the top of a "biggest first" chart -
    // never what someone reading a dashboard wants.
    return `${quoteIdent(sort.alias)} ${sort.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
  });
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

function assertWithinSpecLimits(spec: QuerySpec): void {
  const checks: [keyof typeof SPEC_LIMITS, number][] = [
    ['dimensions', spec.dimensions?.length ?? 0],
    ['measures', spec.measures?.length ?? 0],
    ['filters', spec.filters?.length ?? 0],
    ['sorts', spec.sort?.length ?? 0],
  ];

  for (const [section, count] of checks) {
    if (count > SPEC_LIMITS[section]) {
      throw new QueryCompileError(
        'too_many_fields',
        `A query may have at most ${SPEC_LIMITS[section]} ${section}, got ${count}`,
        { section, count, limit: SPEC_LIMITS[section] },
      );
    }
  }
}

function resolveLimit(spec: QuerySpec, options: CompileOptions): number {
  const requested = spec.limit ?? options.defaultLimit ?? options.maxRows;

  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1) {
    throw new QueryCompileError('invalid_limit', 'LIMIT must be a positive whole number', {
      limit: spec.limit,
    });
  }
  // Clamped, not rejected: asking for more than the ceiling is a reasonable
  // thing for a client to do, and silently capping is friendlier than a 400.
  return Math.min(requested, options.maxRows);
}

function resolveOffset(spec: QuerySpec): number {
  const requested = spec.offset ?? 0;

  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 0) {
    throw new QueryCompileError('invalid_offset', 'OFFSET must be a whole number of zero or more', {
      offset: spec.offset,
    });
  }
  return requested;
}

/**
 * Compile a query spec into parameterised SQL.
 *
 * Throws {@link QueryCompileError} for anything the catalog does not permit.
 */
export function compileQuery(
  spec: QuerySpec,
  catalog: Catalog,
  options: CompileOptions,
): CompiledQuery {
  if (spec === null || typeof spec !== 'object') {
    throw new QueryCompileError('empty_projection', 'Query spec must be an object', { spec });
  }

  assertWithinSpecLimits(spec);

  const index = createCatalogIndex(catalog);
  const dataset = resolveDataset(index, spec.dataset);

  const state: CompileState = {
    index,
    dataset,
    params: new Params(),
    // The fact table is always in the FROM clause.
    referenced: new Set([dataset.factTable]),
  };

  const dimensions = compileDimensions(state, spec.dimensions ?? []);
  const measures = compileMeasures(state, spec.measures ?? []);
  const projections = [...dimensions, ...measures];

  if (projections.length === 0) {
    throw new QueryCompileError(
      'empty_projection',
      'A query must select at least one dimension or measure',
    );
  }

  // Duplicate output names would make the result set ambiguous: two columns
  // called "city" leave the client unable to tell customer city from store
  // city, and ORDER BY on that name is genuinely ambiguous.
  const aliases = new Set<string>();
  for (const projection of projections) {
    if (aliases.has(projection.alias)) {
      throw new QueryCompileError(
        'duplicate_alias',
        `Duplicate output column "${projection.alias}". Give one of them an explicit alias.`,
        { alias: projection.alias },
      );
    }
    aliases.add(projection.alias);
  }

  // WHERE is compiled before the joins so that filtering on a dimension pulls
  // that dimension into the join set.
  const conditions = (spec.filters ?? []).map((filter, position) =>
    compileFilter(state, filter, position),
  );

  const joins = compileJoins(state);
  const orderBy = compileSort(spec.sort ?? [], aliases);

  const appliedLimit = resolveLimit(spec, options);
  const offset = resolveOffset(spec);

  /* ---- assemble ---------------------------------------------------------- */

  const selectList = projections
    .map((projection) => `  ${projection.expression} AS ${quoteIdent(projection.alias)}`)
    .join(',\n');

  const parts: string[] = [
    `SELECT\n${selectList}`,
    `FROM ${quoteQualified(catalog.schema, dataset.factTable)} AS ${quoteIdent(dataset.factTable)}`,
  ];

  if (joins.length > 0) {
    parts.push(joins.join('\n'));
  }

  if (conditions.length > 0) {
    parts.push(`WHERE ${conditions.join('\n  AND ')}`);
  }

  // Grouping is required whenever a dimension is selected. With measures only,
  // the whole result is one implicit group; with dimensions only, GROUP BY
  // gives DISTINCT semantics.
  if (dimensions.length > 0) {
    parts.push(`GROUP BY ${dimensions.map((dimension) => dimension.expression).join(', ')}`);
  }

  if (orderBy.length > 0) {
    parts.push(`ORDER BY ${orderBy.join(', ')}`);
  }

  // Bound rather than interpolated. These are integers that have already been
  // validated and clamped, so inlining them would be safe - but "every client
  // value is a bind parameter" is a rule with no exceptions to remember.
  parts.push(`LIMIT ${state.params.bind(appliedLimit)}`);
  if (offset > 0) {
    parts.push(`OFFSET ${state.params.bind(offset)}`);
  }

  return {
    text: parts.join('\n'),
    values: state.params.toArray(),
    columns: projections.map((projection) => projection.alias),
    appliedLimit,
  };
}
