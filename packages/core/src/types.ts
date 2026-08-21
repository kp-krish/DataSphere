/**
 * Shared contracts between the API, the scripts and the web client.
 *
 * Everything in this package is pure data + pure functions: it never opens a
 * socket and has no runtime dependencies. That is deliberate - the query
 * compiler is the security-critical part of DataSphere, and keeping it free of
 * I/O means it can be exhaustively unit tested without a database.
 */

/* -------------------------------------------------------------------------- */
/* Schema catalog                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The semantic type of a column, derived from its Postgres type during
 * introspection. Filter operators and aggregate functions are permitted or
 * rejected based on this, not on the raw Postgres type name.
 */
export type ColumnKind = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'timestamp';

/** How a column may be used in a query spec. */
export interface CatalogColumn {
  /** Physical column name. User input is matched literally against this allowlist. */
  name: string;
  /** Human label for the UI. */
  label: string;
  /** Raw Postgres type, e.g. `numeric(12,2)`. Informational. */
  dataType: string;
  kind: ColumnKind;
  nullable: boolean;
  /** True when the column is sensible to group by (low/medium cardinality). */
  groupable: boolean;
  /** True when the column is numeric and sensible to aggregate. */
  aggregatable: boolean;
  description?: string;
}

export type TableRole = 'fact' | 'dimension';

export interface CatalogTable {
  /** Physical table name, e.g. `fact_orders`. */
  name: string;
  label: string;
  role: TableRole;
  /** Ordered primary key column names. */
  primaryKey: string[];
  columns: CatalogColumn[];
  /** Planner row estimate from pg_class.reltuples. Informational. */
  rowEstimate: number;
  description?: string;
}

/**
 * A pre-declared join edge. The compiler will only ever emit joins that appear
 * here, so a client cannot ask for an arbitrary join condition.
 */
export interface CatalogJoin {
  /** Dimension table being joined in. */
  table: string;
  /** Column on the fact table. */
  factColumn: string;
  /** Column on the dimension table (its primary key). */
  dimensionColumn: string;
}

/**
 * A queryable star: one fact table plus the dimensions reachable from it.
 * The dataset is the unit the UI lets a user pick first.
 */
export interface CatalogDataset {
  name: string;
  label: string;
  factTable: string;
  joins: CatalogJoin[];
  description?: string;
}

export interface Catalog {
  /** The single Postgres schema this catalog was introspected from. */
  schema: string;
  datasets: CatalogDataset[];
  tables: CatalogTable[];
  /** ISO timestamp of when this catalog was introspected. */
  generatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Query spec - the JSON the client sends instead of SQL                       */
/* -------------------------------------------------------------------------- */

export type AggregateFn = 'SUM' | 'AVG' | 'COUNT' | 'COUNT_DISTINCT' | 'MIN' | 'MAX';

/** Optional bucketing applied to a date/timestamp dimension. */
export type DateGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'between'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'is_null'
  | 'is_not_null';

export type SortDirection = 'asc' | 'desc';

/** A column reference, always qualified by table so the compiler can validate it. */
export interface FieldRef {
  table: string;
  column: string;
}

export interface Dimension extends FieldRef {
  /** Output column name. Sanitised and quoted by the compiler. */
  alias?: string;
  /** Only valid on date/timestamp columns. */
  grain?: DateGrain;
}

export interface Measure extends FieldRef {
  fn: AggregateFn;
  alias?: string;
}

/** Scalar values permitted as filter operands. */
export type FilterValue = string | number | boolean | null;

export interface Filter extends FieldRef {
  operator: FilterOperator;
  /**
   * Operand list. Arity is validated per operator: `is_null` and `is_not_null`
   * take 0, `between` takes exactly 2, `in` and `not_in` take 1 or more, and
   * everything else takes exactly 1.
   */
  values?: FilterValue[];
}

/** Sort target: an output alias belonging to this same spec. */
export interface Sort {
  /** Alias of a dimension or measure in this spec. */
  alias: string;
  direction: SortDirection;
}

export interface QuerySpec {
  /** Must match a CatalogDataset name. */
  dataset: string;
  dimensions: Dimension[];
  measures: Measure[];
  filters?: Filter[];
  sort?: Sort[];
  /** Clamped to QUERY_MAX_ROWS by the compiler. */
  limit?: number;
  offset?: number;
}

/* -------------------------------------------------------------------------- */
/* Compiled output and execution results                                       */
/* -------------------------------------------------------------------------- */

/**
 * A value bound to a placeholder. Arrays are used for `in`/`not_in`, which
 * compile to `= ANY($n)` - one placeholder regardless of how many operands the
 * client supplied.
 */
export type BoundValue = FilterValue | FilterValue[];

export interface CompiledQuery {
  /** Parameterised SQL. Contains only numbered placeholders for user values. */
  text: string;
  /** Values bound to the placeholders, in order. */
  values: BoundValue[];
  /** Output column names in select order. */
  columns: string[];
  /** The effective LIMIT after clamping. */
  appliedLimit: number;
}

export type CacheStatus = 'hit' | 'miss' | 'bypass' | 'disabled';

export interface QueryResultMeta {
  rowCount: number;
  /** Milliseconds spent in Postgres. Zero on a cache hit. */
  executionMs: number;
  /** Milliseconds for the whole request, cache lookup included. */
  totalMs: number;
  cache: CacheStatus;
  cacheKey: string;
  /** Seconds remaining on the cached entry, when known. */
  cacheTtlRemaining?: number;
  appliedLimit: number;
  /** Echoed back so the UI can show what actually ran. */
  sql?: string;
}

export interface QueryResult<TRow = Record<string, unknown>> {
  columns: string[];
  rows: TRow[];
  meta: QueryResultMeta;
}

/* -------------------------------------------------------------------------- */
/* Dashboards                                                                  */
/* -------------------------------------------------------------------------- */

export type WidgetType = 'line' | 'bar' | 'pie' | 'kpi' | 'table';

export interface WidgetConfig {
  /** Dimension alias plotted on the x axis, or used as the slice label. */
  xKey?: string;
  /** Measure aliases plotted as series. */
  yKeys?: string[];
  /** For KPI cards: which measure alias to display. */
  valueKey?: string;
  /** Number formatting hint for the client. */
  format?: 'number' | 'currency' | 'percent' | 'compact';
  stacked?: boolean;
  showLegend?: boolean;
  /** Seconds between automatic refreshes. 0 disables live updates. */
  refreshInterval?: number;
}

export interface Widget {
  id: string;
  dashboardId: string;
  title: string;
  type: WidgetType;
  querySpec: QuerySpec;
  config: WidgetConfig;
  /** Ordinal within the dashboard grid. */
  position: number;
  /** Grid column span, 1 to 12. */
  width: number;
  height: number;
  createdAt: string;
  updatedAt: string;
}

export interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  widgets?: Widget[];
}
