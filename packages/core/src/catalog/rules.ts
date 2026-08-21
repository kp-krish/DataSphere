/**
 * What a column is allowed to do.
 *
 * The compiler never asks "is this Postgres type numeric?" - it asks the
 * semantic `ColumnKind` recorded in the catalog. That indirection is what lets
 * the rules below be a small, closed, testable table instead of string
 * matching against whatever `format_type()` happened to return.
 */

import type { AggregateFn, ColumnKind, DateGrain, FilterOperator } from '../types.js';

/**
 * Map a Postgres type name onto a semantic kind.
 *
 * Returns `null` for anything DataSphere cannot safely expose - json, arrays,
 * geometric types, enums. A column whose type is not understood is left out of
 * the catalog entirely, which means it cannot be named in a query spec at all.
 * Failing closed here is the whole point: adding a jsonb column to the schema
 * must not silently make it queryable.
 */
export function columnKindForPostgresType(dataType: string): ColumnKind | null {
  // format_type() returns things like `numeric(12,2)` and
  // `character varying(255)`; the precision is irrelevant to the semantics.
  const base = dataType.toLowerCase().replace(/\(.*$/, '').trim();

  switch (base) {
    case 'smallint':
    case 'integer':
    case 'bigint':
    case 'int2':
    case 'int4':
    case 'int8':
      return 'integer';

    case 'numeric':
    case 'decimal':
    case 'real':
    case 'double precision':
    case 'float4':
    case 'float8':
      return 'number';

    case 'boolean':
    case 'bool':
      return 'boolean';

    case 'date':
      return 'date';

    case 'timestamp':
    case 'timestamp without time zone':
    case 'timestamp with time zone':
    case 'timestamptz':
      return 'timestamp';

    case 'text':
    case 'character varying':
    case 'character':
    case 'varchar':
    case 'char':
    case 'bpchar':
    case 'uuid':
      return 'string';

    default:
      return null;
  }
}

/**
 * Kinds that make sense as a GROUP BY key.
 *
 * `number` is excluded on purpose. Grouping by a continuous measure such as
 * `revenue numeric(12,2)` produces one group per distinct value - two million
 * rows in, close to two million rows out - which is never what a dashboard
 * wants and is an easy way to accidentally ask for an enormous result.
 * Integers stay groupable because they are routinely categorical here
 * (`year_num`, `month_num`, `quantity`).
 */
const GROUPABLE_KINDS: ReadonlySet<ColumnKind> = new Set<ColumnKind>([
  'string',
  'boolean',
  'date',
  'timestamp',
  'integer',
]);

const AGGREGATABLE_KINDS: ReadonlySet<ColumnKind> = new Set<ColumnKind>(['integer', 'number']);

export function isGroupable(kind: ColumnKind): boolean {
  return GROUPABLE_KINDS.has(kind);
}

export function isAggregatable(kind: ColumnKind): boolean {
  return AGGREGATABLE_KINDS.has(kind);
}

/** The complete set of aggregate functions the compiler will emit. */
export const AGGREGATE_FUNCTIONS: readonly AggregateFn[] = [
  'SUM',
  'AVG',
  'COUNT',
  'COUNT_DISTINCT',
  'MIN',
  'MAX',
];

const AGGREGATE_SET: ReadonlySet<string> = new Set(AGGREGATE_FUNCTIONS);

export function isAggregateFn(value: unknown): value is AggregateFn {
  return typeof value === 'string' && AGGREGATE_SET.has(value);
}

/**
 * Which aggregates apply to which kinds.
 *
 * COUNT and COUNT_DISTINCT work on anything. SUM and AVG need something
 * numeric. MIN and MAX are defined for any ordered type, which includes text.
 */
export function aggregateAcceptsKind(fn: AggregateFn, kind: ColumnKind): boolean {
  switch (fn) {
    case 'COUNT':
    case 'COUNT_DISTINCT':
      return true;
    case 'SUM':
    case 'AVG':
      return isAggregatable(kind);
    case 'MIN':
    case 'MAX':
      return kind !== 'boolean';
  }
}

/**
 * Filter operators permitted per kind.
 *
 * Ordering comparisons are withheld from strings deliberately: `>` on text
 * applies collation-dependent ordering that almost never means what a
 * dashboard user intends, and offering it invites confusing results.
 */
const OPERATORS_BY_KIND: Record<ColumnKind, readonly FilterOperator[]> = {
  string: [
    'eq',
    'neq',
    'in',
    'not_in',
    'contains',
    'starts_with',
    'ends_with',
    'is_null',
    'is_not_null',
  ],
  integer: [
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'not_in',
    'between',
    'is_null',
    'is_not_null',
  ],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'is_not_null'],
  boolean: ['eq', 'neq', 'is_null', 'is_not_null'],
  date: [
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'not_in',
    'between',
    'is_null',
    'is_not_null',
  ],
  timestamp: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'is_not_null'],
};

export function operatorsForKind(kind: ColumnKind): readonly FilterOperator[] {
  return OPERATORS_BY_KIND[kind];
}

export function operatorAcceptsKind(operator: FilterOperator, kind: ColumnKind): boolean {
  return OPERATORS_BY_KIND[kind].includes(operator);
}

/** How many operands each operator takes. `null` upper bound means unbounded. */
export function operandArity(operator: FilterOperator): { min: number; max: number | null } {
  switch (operator) {
    case 'is_null':
    case 'is_not_null':
      return { min: 0, max: 0 };
    case 'between':
      return { min: 2, max: 2 };
    case 'in':
    case 'not_in':
      return { min: 1, max: null };
    default:
      return { min: 1, max: 1 };
  }
}

export const DATE_GRAINS: readonly DateGrain[] = ['day', 'week', 'month', 'quarter', 'year'];

const GRAIN_SET: ReadonlySet<string> = new Set(DATE_GRAINS);

export function isDateGrain(value: unknown): value is DateGrain {
  return typeof value === 'string' && GRAIN_SET.has(value);
}

/** Grain only means anything on a date or timestamp. */
export function kindSupportsGrain(kind: ColumnKind): boolean {
  return kind === 'date' || kind === 'timestamp';
}
