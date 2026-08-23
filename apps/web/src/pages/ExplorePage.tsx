/**
 * The query builder.
 *
 * A user assembles a query spec here without writing SQL: pick a dataset, then
 * dimensions, measures, filters, sort and a row limit. The spec is JSON, and
 * the server compiles it.
 *
 * Two decisions shape this page.
 *
 * The field and operator lists come from `GET /api/catalog`, never from
 * constants in the client. The catalog reports each column's semantic kind and
 * the operators valid for it, so the UI cannot offer a filter the compiler
 * would reject - and adding a column to a migration makes it appear here with
 * no frontend change.
 *
 * The generated SQL is shown live, next to the spec that produced it, and is
 * compiled by the *server* rather than approximated in the browser. That means
 * what is displayed is exactly what would run, with the bound values listed
 * separately so it is visible that they are not in the SQL text.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  AggregateFn,
  CatalogColumn,
  CatalogTable,
  DateGrain,
  Filter,
  FilterOperator,
  QuerySpec,
  QueryResult,
  WidgetType,
} from '@datasphere/core';
import {
  ApiError,
  compileQuerySpec,
  createWidget,
  getCatalog,
  listDashboards,
  runQuery,
  type CatalogResponse,
} from '../lib/api.js';
import { CacheBadge } from '../components/CacheBadge.js';
import { WidgetView, defaultConfigFor } from '../widgets/WidgetView.js';

const AGGREGATES: AggregateFn[] = ['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MIN', 'MAX'];
const GRAINS: DateGrain[] = ['day', 'week', 'month', 'quarter', 'year'];
const WIDGET_TYPES: WidgetType[] = ['bar', 'line', 'pie', 'kpi', 'table'];

/** Operators that take no operand, so the value box is hidden for them. */
const NO_OPERAND: FilterOperator[] = ['is_null', 'is_not_null'];

/**
 * Column names that usually classify rather than identify, so grouping by one
 * produces a readable number of bars instead of one per row.
 */
const CLASSIFIER_NAMES = [
  'category',
  'segment',
  'channel',
  'subcategory',
  'region',
  'brand',
  'order_status',
  'country',
];

/**
 * Measures that are meaningful to add up. A per-unit price is not: summing
 * `unit_price` across orders produces a number with no interpretation.
 */
const ADDITIVE_NAMES = ['revenue', 'profit', 'amount', 'total', 'cost', 'quantity'];

interface FieldRef {
  table: string;
  column: string;
}

/** `table.column` round-trips through a <select> value cleanly. */
const encodeField = (ref: FieldRef): string => `${ref.table}.${ref.column}`;
const decodeField = (value: string): FieldRef => {
  const separator = value.indexOf('.');
  return { table: value.slice(0, separator), column: value.slice(separator + 1) };
};

export function ExplorePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const presetDashboard = searchParams.get('dashboard');

  const { data: catalog, error: catalogError } = useQuery<CatalogResponse>({
    queryKey: ['catalog'],
    queryFn: getCatalog,
    // The schema only changes when a migration runs.
    staleTime: 5 * 60 * 1000,
  });

  const [dataset, setDataset] = useState<string>('');
  const [dimensions, setDimensions] = useState<{ field: FieldRef; grain?: DateGrain }[]>([]);
  const [measures, setMeasures] = useState<{ field: FieldRef; fn: AggregateFn }[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [sortAlias, setSortAlias] = useState<string>('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [limit, setLimit] = useState<number>(100);
  const [widgetType, setWidgetType] = useState<WidgetType>('bar');
  const [result, setResult] = useState<QueryResult | null>(null);

  // Default to the first dataset once the catalog arrives.
  useEffect(() => {
    if (!dataset && catalog?.datasets[0]) setDataset(catalog.datasets[0].name);
  }, [catalog, dataset]);

  /* ---- what this dataset makes available -------------------------------- */

  const tables: CatalogTable[] = useMemo(() => {
    if (!catalog || !dataset) return [];
    const entry = catalog.datasets.find((candidate) => candidate.name === dataset);
    if (!entry) return [];

    const names = new Set([entry.factTable, ...entry.joins.map((join) => join.table)]);
    return catalog.tables.filter((table) => names.has(table.name));
  }, [catalog, dataset]);

  const groupableFields = useMemo(
    () =>
      tables.flatMap((table) =>
        table.columns.filter((column) => column.groupable).map((column) => ({ table, column })),
      ),
    [tables],
  );

  const allFields = useMemo(
    () => tables.flatMap((table) => table.columns.map((column) => ({ table, column }))),
    [tables],
  );

  const findColumn = (ref: FieldRef): CatalogColumn | undefined =>
    tables.find((table) => table.name === ref.table)?.columns.find((c) => c.name === ref.column);

  /**
   * Open on a working query rather than four empty boxes.
   *
   * An empty builder makes the user guess what the tool does before it will
   * show them anything. Starting from "revenue by category" means the SQL
   * panel, the run button and the chart preview are all immediately
   * meaningful, and clearing a row is easier than inventing the first one.
   *
   * Which fields to open with is a presentation heuristic, not semantics. The
   * naive pick - first groupable text column, first aggregatable measure -
   * landed on customer_name x SUM(unit_price): a hundred near-identical bars,
   * summing a per-unit price, which means nothing. So classifier-shaped and
   * additive-shaped names are preferred where the schema has them, and the
   * naive pick remains the fallback for a schema that uses other names.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !dataset || tables.length === 0) return;
    if (dimensions.length > 0 || measures.length > 0) return;

    const factTable = catalog?.datasets.find((entry) => entry.name === dataset)?.factTable;

    const textDimensions = groupableFields.filter(
      (entry) => entry.table.role === 'dimension' && entry.column.kind === 'string',
    );
    const dimensionPick =
      textDimensions.find((entry) => CLASSIFIER_NAMES.includes(entry.column.name)) ??
      textDimensions[0];

    const factColumns =
      tables
        .find((table) => table.name === factTable)
        ?.columns.filter((column) => column.aggregatable && column.kind === 'number') ?? [];
    const measurePick =
      factColumns.find((column) => ADDITIVE_NAMES.includes(column.name)) ?? factColumns[0];

    if (dimensionPick && measurePick && factTable) {
      seeded.current = true;
      setDimensions([
        { field: { table: dimensionPick.table.name, column: dimensionPick.column.name } },
      ]);
      setMeasures([{ field: { table: factTable, column: measurePick.name }, fn: 'SUM' }]);
      setSortAlias(measureAlias({ table: factTable, column: measurePick.name }, 'SUM'));
      setSortDirection('desc');
    }
  }, [catalog, dataset, tables, groupableFields, dimensions.length, measures.length]);

  /* ---- the spec ---------------------------------------------------------- */

  const spec: QuerySpec | null = useMemo(() => {
    if (!dataset) return null;
    if (dimensions.length === 0 && measures.length === 0) return null;

    const built: QuerySpec = {
      dataset,
      dimensions: dimensions.map((entry) => ({
        table: entry.field.table,
        column: entry.field.column,
        // Aliases are explicit so two columns of the same name on different
        // tables (dim_customer.city and dim_store.city) do not collide.
        alias: aliasFor(entry.field, entry.grain),
        ...(entry.grain ? { grain: entry.grain } : {}),
      })),
      measures: measures.map((entry) => ({
        table: entry.field.table,
        column: entry.field.column,
        fn: entry.fn,
        alias: measureAlias(entry.field, entry.fn),
      })),
      limit,
    };

    if (filters.length > 0) built.filters = filters;
    if (sortAlias) built.sort = [{ alias: sortAlias, direction: sortDirection }];

    return built;
  }, [dataset, dimensions, measures, filters, sortAlias, sortDirection, limit]);

  const outputAliases = useMemo(
    () => [
      ...dimensions.map((entry) => aliasFor(entry.field, entry.grain)),
      ...measures.map((entry) => measureAlias(entry.field, entry.fn)),
    ],
    [dimensions, measures],
  );

  // Drop a sort that points at a column no longer selected, rather than
  // letting the server reject the whole query for it.
  useEffect(() => {
    if (sortAlias && !outputAliases.includes(sortAlias)) setSortAlias('');
  }, [outputAliases, sortAlias]);

  /* ---- live SQL preview -------------------------------------------------- */

  const preview = useQuery({
    queryKey: ['compile', spec],
    queryFn: () => compileQuerySpec(spec as QuerySpec),
    enabled: Boolean(spec),
    // Compiling is cheap and touches no data, so a rejected spec here is the
    // fastest possible feedback that something is wrong.
    retry: false,
  });

  const execution = useMutation({
    mutationFn: (options: { noCache?: boolean }) =>
      runQuery(spec as QuerySpec, { ...options, includeSql: true }),
    onSuccess: setResult,
  });

  /* ---- saving as a widget ------------------------------------------------ */

  const { data: dashboardList } = useQuery({
    queryKey: ['dashboards'],
    queryFn: listDashboards,
  });

  const [targetDashboard, setTargetDashboard] = useState<string>(presetDashboard ?? '');
  const [widgetTitle, setWidgetTitle] = useState('');

  useEffect(() => {
    if (!targetDashboard && dashboardList?.dashboards[0]) {
      setTargetDashboard(dashboardList.dashboards[0].id);
    }
  }, [dashboardList, targetDashboard]);

  const save = useMutation({
    mutationFn: () =>
      createWidget(targetDashboard, {
        title: widgetTitle.trim() || 'Untitled widget',
        type: widgetType,
        querySpec: spec as QuerySpec,
        config: result ? defaultConfigFor(widgetType, result) : {},
        width: widgetType === 'kpi' ? 3 : 6,
        height: 1,
      }),
    onSuccess: () => navigate(`/dashboards/${targetDashboard}`),
  });

  /* ---- render ------------------------------------------------------------ */

  if (catalogError) {
    return (
      <div className="notice notice--error">
        {catalogError instanceof ApiError ? catalogError.message : 'Could not load the catalog.'}
      </div>
    );
  }

  if (!catalog) return <p className="muted">Loading catalog…</p>;

  const canRun = Boolean(spec) && !preview.isError;

  return (
    <>
      <header className="page__header">
        <div>
          <h1 className="page__title">Query builder</h1>
          <p className="page__subtitle">
            Compose a query against {catalog.tables.length} introspected tables. No SQL required —
            the server compiles the spec.
          </p>
        </div>
      </header>

      <div className="builder">
        {/* ---- left: the spec ---------------------------------------------- */}
        <div className="builder__panel">
          <section className="card">
            <h2 className="card__title">Dataset</h2>
            <select
              className="select"
              value={dataset}
              onChange={(event) => {
                setDataset(event.target.value);
                // Fields belong to a dataset, so nothing selected survives.
                setDimensions([]);
                setMeasures([]);
                setFilters([]);
                setSortAlias('');
                setResult(null);
              }}
            >
              {catalog.datasets.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.label}
                </option>
              ))}
            </select>
          </section>

          {/* ---- dimensions ---- */}
          <section className="card">
            <h2 className="card__title">
              Dimensions ({dimensions.length}/{catalog.meta.limits.maxDimensions})
            </h2>

            {dimensions.map((entry, index) => {
              const column = findColumn(entry.field);
              const temporal = column?.kind === 'date' || column?.kind === 'timestamp';

              return (
                <div className="spec-row" key={index}>
                  <div className="spec-row__main">
                    <div className="spec-row__line">
                      <select
                        className="select"
                        value={encodeField(entry.field)}
                        onChange={(event) =>
                          setDimensions((current) =>
                            current.map((item, position) =>
                              position === index
                                ? { field: decodeField(event.target.value) }
                                : item,
                            ),
                          )
                        }
                      >
                        {groupableFields.map(({ table, column: candidate }) => (
                          <option
                            key={`${table.name}.${candidate.name}`}
                            value={`${table.name}.${candidate.name}`}
                          >
                            {table.label} · {candidate.label}
                          </option>
                        ))}
                      </select>

                      {/* Grain only means something on a date or timestamp. */}
                      {temporal && (
                        <select
                          className="select"
                          value={entry.grain ?? ''}
                          onChange={(event) =>
                            setDimensions((current) =>
                              current.map((item, position) =>
                                position === index
                                  ? {
                                      ...item,
                                      grain: (event.target.value || undefined) as
                                        DateGrain | undefined,
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <option value="">no bucketing</option>
                          {GRAINS.map((grain) => (
                            <option key={grain} value={grain}>
                              by {grain}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>

                  <button
                    className="spec-row__remove"
                    onClick={() =>
                      setDimensions((current) => current.filter((_, p) => p !== index))
                    }
                    aria-label="Remove dimension"
                  >
                    ✕
                  </button>
                </div>
              );
            })}

            <button
              className="btn btn--sm"
              disabled={
                groupableFields.length === 0 ||
                dimensions.length >= catalog.meta.limits.maxDimensions
              }
              onClick={() => {
                const first = groupableFields[0];
                if (first) {
                  setDimensions((current) => [
                    ...current,
                    { field: { table: first.table.name, column: first.column.name } },
                  ]);
                }
              }}
            >
              + Add dimension
            </button>
          </section>

          {/* ---- measures ---- */}
          <section className="card">
            <h2 className="card__title">
              Measures ({measures.length}/{catalog.meta.limits.maxMeasures})
            </h2>

            {measures.map((entry, index) => (
              <div className="spec-row" key={index}>
                <div className="spec-row__main">
                  <div className="spec-row__line">
                    <select
                      className="select"
                      value={entry.fn}
                      onChange={(event) =>
                        setMeasures((current) =>
                          current.map((item, position) =>
                            position === index
                              ? { ...item, fn: event.target.value as AggregateFn }
                              : item,
                          ),
                        )
                      }
                      style={{ maxWidth: '9rem' }}
                    >
                      {AGGREGATES.map((fn) => (
                        <option key={fn} value={fn}>
                          {fn.replace('_', ' ')}
                        </option>
                      ))}
                    </select>

                    <select
                      className="select"
                      value={encodeField(entry.field)}
                      onChange={(event) =>
                        setMeasures((current) =>
                          current.map((item, position) =>
                            position === index
                              ? { ...item, field: decodeField(event.target.value) }
                              : item,
                          ),
                        )
                      }
                    >
                      {allFields.map(({ table, column }) => (
                        <option
                          key={`${table.name}.${column.name}`}
                          value={`${table.name}.${column.name}`}
                        >
                          {table.label} · {column.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <button
                  className="spec-row__remove"
                  onClick={() => setMeasures((current) => current.filter((_, p) => p !== index))}
                  aria-label="Remove measure"
                >
                  ✕
                </button>
              </div>
            ))}

            <button
              className="btn btn--sm"
              disabled={measures.length >= catalog.meta.limits.maxMeasures}
              onClick={() => {
                const numeric =
                  allFields.find((entry) => entry.column.aggregatable) ?? allFields[0];
                if (numeric) {
                  setMeasures((current) => [
                    ...current,
                    {
                      field: { table: numeric.table.name, column: numeric.column.name },
                      fn: numeric.column.aggregatable ? 'SUM' : 'COUNT',
                    },
                  ]);
                }
              }}
            >
              + Add measure
            </button>
          </section>

          {/* ---- filters ---- */}
          <section className="card">
            <h2 className="card__title">
              Filters ({filters.length}/{catalog.meta.limits.maxFilters})
            </h2>

            {filters.map((filter, index) => {
              const column = findColumn(filter);
              // The operator list is per column kind, straight from the server.
              const operators = column ? (catalog.meta.operators[column.kind] ?? []) : [];
              const takesOperand = !NO_OPERAND.includes(filter.operator);
              const isBetween = filter.operator === 'between';

              return (
                <div className="spec-row" key={index}>
                  <div className="spec-row__main">
                    <div className="spec-row__line">
                      <select
                        className="select"
                        value={encodeField(filter)}
                        onChange={(event) => {
                          const field = decodeField(event.target.value);
                          const nextColumn = findColumn(field);
                          const nextOperators = nextColumn
                            ? (catalog.meta.operators[nextColumn.kind] ?? [])
                            : [];
                          setFilters((current) =>
                            current.map((item, position) =>
                              position === index
                                ? {
                                    ...field,
                                    // The current operator may not be valid for
                                    // the new column's kind.
                                    operator: nextOperators.includes(item.operator)
                                      ? item.operator
                                      : (nextOperators[0] ?? 'eq'),
                                    values: [],
                                  }
                                : item,
                            ),
                          );
                        }}
                      >
                        {allFields.map(({ table, column: candidate }) => (
                          <option
                            key={`${table.name}.${candidate.name}`}
                            value={`${table.name}.${candidate.name}`}
                          >
                            {table.label} · {candidate.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="spec-row__line">
                      <select
                        className="select"
                        value={filter.operator}
                        onChange={(event) =>
                          setFilters((current) =>
                            current.map((item, position) =>
                              position === index
                                ? { ...item, operator: event.target.value as FilterOperator }
                                : item,
                            ),
                          )
                        }
                        style={{ maxWidth: '9rem' }}
                      >
                        {operators.map((operator) => (
                          <option key={operator} value={operator}>
                            {operator.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </select>

                      {takesOperand && (
                        <input
                          className="input"
                          placeholder={isBetween ? 'from, to' : 'value'}
                          value={(filter.values ?? []).join(', ')}
                          onChange={(event) =>
                            setFilters((current) =>
                              current.map((item, position) =>
                                position === index
                                  ? {
                                      ...item,
                                      values: parseOperands(event.target.value, column?.kind),
                                    }
                                  : item,
                              ),
                            )
                          }
                        />
                      )}
                    </div>
                  </div>

                  <button
                    className="spec-row__remove"
                    onClick={() => setFilters((current) => current.filter((_, p) => p !== index))}
                    aria-label="Remove filter"
                  >
                    ✕
                  </button>
                </div>
              );
            })}

            <button
              className="btn btn--sm"
              disabled={filters.length >= catalog.meta.limits.maxFilters}
              onClick={() => {
                const first = allFields[0];
                if (!first) return;
                const operators = catalog.meta.operators[first.column.kind] ?? ['eq'];
                setFilters((current) => [
                  ...current,
                  {
                    table: first.table.name,
                    column: first.column.name,
                    operator: operators[0] as FilterOperator,
                    values: [],
                  },
                ]);
              }}
            >
              + Add filter
            </button>
          </section>

          {/* ---- sort & limit ---- */}
          <section className="card">
            <h2 className="card__title">Sort &amp; limit</h2>
            <div className="stack">
              <div className="row">
                <select
                  className="select"
                  value={sortAlias}
                  onChange={(event) => setSortAlias(event.target.value)}
                  style={{ flex: 1 }}
                >
                  <option value="">no sort</option>
                  {outputAliases.map((alias) => (
                    <option key={alias} value={alias}>
                      {alias}
                    </option>
                  ))}
                </select>

                <select
                  className="select"
                  value={sortDirection}
                  onChange={(event) => setSortDirection(event.target.value as 'asc' | 'desc')}
                  disabled={!sortAlias}
                  style={{ maxWidth: '7rem' }}
                >
                  <option value="desc">desc</option>
                  <option value="asc">asc</option>
                </select>
              </div>

              <label className="field">
                <span className="field__label">
                  Row limit — capped at {catalog.meta.limits.maxRows.toLocaleString()}
                </span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={catalog.meta.limits.maxRows}
                  value={limit}
                  onChange={(event) => setLimit(Number(event.target.value) || 1)}
                />
              </label>
            </div>
          </section>
        </div>

        {/* ---- right: SQL, results, save ----------------------------------- */}
        <div className="builder__results">
          <section className="card">
            <div className="row" style={{ marginBottom: '0.75rem' }}>
              <h2 className="card__title" style={{ margin: 0 }}>
                Generated SQL
              </h2>
              <div style={{ marginLeft: 'auto' }} className="row">
                <button
                  className="btn btn--primary"
                  disabled={!canRun || execution.isPending}
                  onClick={() => execution.mutate({})}
                >
                  {execution.isPending ? 'Running…' : 'Run query'}
                </button>
                <button
                  className="btn"
                  disabled={!canRun || execution.isPending}
                  onClick={() => execution.mutate({ noCache: true })}
                  title="Skip the cache and go to Postgres"
                >
                  Run uncached
                </button>
              </div>
            </div>

            {!spec && (
              <p className="muted">Add at least one dimension or measure to build a query.</p>
            )}

            {preview.isError && (
              <div className="notice notice--error">
                <div>
                  <div>
                    {preview.error instanceof ApiError
                      ? preview.error.message
                      : 'This query spec is not valid.'}
                  </div>
                  {preview.error instanceof ApiError && (
                    <div className="notice__code">{preview.error.code}</div>
                  )}
                </div>
              </div>
            )}

            {preview.data && (
              <>
                <pre className="sql-preview">{preview.data.sql}</pre>
                <div className="sql-preview__values">
                  {/* Shown separately, because that is the point: the values
                      are bound parameters and never appear in the SQL text. */}
                  {preview.data.values.length} bound parameter
                  {preview.data.values.length === 1 ? '' : 's'}:{' '}
                  <span className="mono">{JSON.stringify(preview.data.values)}</span>
                </div>
              </>
            )}
          </section>

          {execution.isError && (
            <div className="notice notice--error">
              <div>
                <div>
                  {execution.error instanceof ApiError
                    ? execution.error.message
                    : 'The query failed.'}
                </div>
                {execution.error instanceof ApiError && (
                  <div className="notice__code">{execution.error.code}</div>
                )}
              </div>
            </div>
          )}

          {result && (
            <>
              <section className="card">
                <div className="row" style={{ marginBottom: '0.75rem' }}>
                  <h2 className="card__title" style={{ margin: 0 }}>
                    Preview
                  </h2>
                  <div className="row" style={{ marginLeft: 'auto' }}>
                    <CacheBadge meta={result.meta} />
                    <span className="muted">{result.meta.rowCount.toLocaleString()} rows</span>
                  </div>
                </div>

                <div className="row" style={{ marginBottom: '0.75rem' }}>
                  {WIDGET_TYPES.map((type) => (
                    <button
                      key={type}
                      className={`btn btn--sm${widgetType === type ? ' btn--primary' : ''}`}
                      onClick={() => setWidgetType(type)}
                      aria-pressed={widgetType === type}
                    >
                      {type}
                    </button>
                  ))}
                </div>

                <WidgetView
                  type={widgetType}
                  result={result}
                  config={defaultConfigFor(widgetType, result)}
                  height={280}
                />
              </section>

              <section className="card">
                <h2 className="card__title">Save as widget</h2>

                {dashboardList && dashboardList.dashboards.length === 0 ? (
                  <p className="muted">
                    No dashboards yet — <Link to="/">create one</Link> to save this.
                  </p>
                ) : (
                  <div className="stack">
                    <label className="field">
                      <span className="field__label">Title</span>
                      <input
                        className="input"
                        value={widgetTitle}
                        placeholder="Revenue by category"
                        onChange={(event) => setWidgetTitle(event.target.value)}
                      />
                    </label>

                    <label className="field">
                      <span className="field__label">Dashboard</span>
                      <select
                        className="select"
                        value={targetDashboard}
                        onChange={(event) => setTargetDashboard(event.target.value)}
                      >
                        {dashboardList?.dashboards.map((dashboard) => (
                          <option key={dashboard.id} value={dashboard.id}>
                            {dashboard.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    {save.isError && (
                      <div className="notice notice--error">
                        {save.error instanceof ApiError
                          ? save.error.message
                          : 'Could not save the widget.'}
                      </div>
                    )}

                    <button
                      className="btn btn--primary"
                      disabled={!targetDashboard || save.isPending}
                      onClick={() => save.mutate()}
                    >
                      {save.isPending ? 'Saving…' : `Save as ${widgetType} widget`}
                    </button>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Aliasing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Output names must be unique across the whole select list, and two tables can
 * carry the same column name. Qualifying with the table (minus its `dim_`
 * prefix) keeps them apart without making every alias unreadable.
 */
function aliasFor(field: FieldRef, grain?: DateGrain): string {
  const table = field.table.replace(/^(dim|fact)_/, '');
  const base = `${table}_${field.column}`.replace(/[^A-Za-z0-9_]/g, '_');
  return grain ? `${base}_${grain}` : base;
}

function measureAlias(field: FieldRef, fn: AggregateFn): string {
  const table = field.table.replace(/^(dim|fact)_/, '');
  return `${table}_${field.column}_${fn.toLowerCase()}`.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Turn the operand box's text into typed values.
 *
 * Numeric columns need real numbers - the compiler rejects the string "2024"
 * against an integer column, deliberately, so that a value never reaches a
 * comparison under a surprising cast.
 */
function parseOperands(raw: string, kind?: CatalogColumn['kind']): (string | number | boolean)[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (kind === 'integer' || kind === 'number') {
    return parts.map((part) => {
      const parsed = Number(part);
      // Leave an unparseable entry as text: the server will explain why it is
      // wrong, which is more useful than silently turning it into NaN.
      return Number.isFinite(parsed) ? parsed : part;
    });
  }

  if (kind === 'boolean') {
    return parts.map((part) => part.toLowerCase() === 'true');
  }

  return parts;
}
