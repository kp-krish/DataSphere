/**
 * Schema catalog introspection.
 *
 * The allowlist that governs the query engine is not written by hand - it is
 * read out of the database. Table names, column names, types, nullability,
 * primary keys and the join graph all come from `pg_catalog`. Adding a column
 * to a migration makes it queryable; nothing has to be kept in sync, and there
 * is no hand-maintained list that can drift out of agreement with reality.
 *
 * This module runs SQL but does not own a connection. The caller passes a
 * `SqlRunner`, which keeps `@datasphere/core` free of a `pg` dependency and
 * lets the API, the benchmark harness and tests each supply their own. The
 * compiler stays testable against a plain object catalog with no database at
 * all.
 *
 * Queries read `pg_catalog` rather than `information_schema`. The former is
 * exact about composite key ordering and gives `format_type()`, which reports
 * the real declared type (`numeric(12,2)`) rather than information_schema's
 * lossy `data_type` split across three columns.
 */

import { columnKindForPostgresType, isAggregatable, isGroupable } from './rules.js';
import type {
  Catalog,
  CatalogColumn,
  CatalogDataset,
  CatalogJoin,
  CatalogTable,
  TableRole,
} from '../types.js';

/**
 * Minimal contract for running a parameterised query.
 *
 * Deliberately narrow: enough to introspect, not enough to be mistaken for a
 * general database handle inside this package.
 */
export type SqlRunner = <TRow extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[],
) => Promise<TRow[]>;

export interface IntrospectOptions {
  /** Schema to introspect. Only this schema becomes queryable. */
  schema?: string;
}

/* -------------------------------------------------------------------------- */
/* Introspection queries                                                      */
/* -------------------------------------------------------------------------- */

const COLUMNS_SQL = `
  SELECT c.relname                                  AS table_name,
         a.attname                                  AS column_name,
         format_type(a.atttypid, a.atttypmod)       AS data_type,
         NOT a.attnotnull                           AS nullable,
         a.attnum                                   AS ordinal,
         col_description(c.oid, a.attnum)           AS description
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = $1
     AND c.relkind = 'r'
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY c.relname, a.attnum
`;

const TABLES_SQL = `
  SELECT c.relname                          AS table_name,
         c.reltuples::bigint                AS row_estimate,
         obj_description(c.oid, 'pg_class') AS description
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1
     AND c.relkind = 'r'
   ORDER BY c.relname
`;

// unnest ... WITH ORDINALITY preserves composite key column order, which
// information_schema does not reliably expose.
const PRIMARY_KEYS_SQL = `
  SELECT c.relname AS table_name,
         a.attname AS column_name,
         k.ord     AS ordinal
    FROM pg_constraint con
    JOIN pg_class c     ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
   WHERE con.contype = 'p'
     AND n.nspname = $1
   ORDER BY c.relname, k.ord
`;

// The join graph. unnest of conkey alongside confkey pairs each referencing
// column with the column it references, in order.
const FOREIGN_KEYS_SQL = `
  SELECT src.relname    AS from_table,
         srcatt.attname AS from_column,
         tgt.relname    AS to_table,
         tgtatt.attname AS to_column,
         con.conname    AS constraint_name
    FROM pg_constraint con
    JOIN pg_class src     ON src.oid = con.conrelid
    JOIN pg_class tgt     ON tgt.oid = con.confrelid
    JOIN pg_namespace n   ON n.oid = src.relnamespace
    JOIN pg_namespace tn  ON tn.oid = tgt.relnamespace
   CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(src_attnum, tgt_attnum)
    JOIN pg_attribute srcatt ON srcatt.attrelid = con.conrelid  AND srcatt.attnum = k.src_attnum
    JOIN pg_attribute tgtatt ON tgtatt.attrelid = con.confrelid AND tgtatt.attnum = k.tgt_attnum
   WHERE con.contype = 'f'
     AND n.nspname = $1
     AND tn.nspname = $1
   ORDER BY src.relname, con.conname
`;

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                 */
/* -------------------------------------------------------------------------- */

interface ColumnRow extends Record<string, unknown> {
  table_name: string;
  column_name: string;
  data_type: string;
  nullable: boolean;
  ordinal: number;
  description: string | null;
}

interface TableRow extends Record<string, unknown> {
  table_name: string;
  row_estimate: string | number;
  description: string | null;
}

interface PrimaryKeyRow extends Record<string, unknown> {
  table_name: string;
  column_name: string;
  ordinal: string | number;
}

interface ForeignKeyRow extends Record<string, unknown> {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  constraint_name: string;
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Turn a physical name into something presentable: `dim_customer` becomes
 * "Customer", `unit_cost` becomes "Unit Cost".
 *
 * Purely cosmetic - the UI shows these while every lookup still uses the
 * physical name.
 */
export function humanizeName(name: string): string {
  return name
    .replace(/^(dim|fact)_/, '')
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/* Build                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Read the schema and build a catalog.
 *
 * Table roles and the join graph are derived structurally, not from naming
 * conventions: a table with at least one foreign key into another table in the
 * same schema is a fact table, and each of those foreign keys becomes a join
 * edge on the dataset built from it. Everything else is a dimension.
 */
export async function introspectCatalog(
  run: SqlRunner,
  options: IntrospectOptions = {},
): Promise<Catalog> {
  const schema = options.schema ?? 'analytics';

  // Sequential, not Promise.all. A SqlRunner may well be backed by a single
  // `pg` Client rather than a Pool, and a Client cannot have two queries in
  // flight at once. Four fast catalog reads are not worth a contract that
  // silently requires concurrency support from the caller.
  const columnRows = await run<ColumnRow>(COLUMNS_SQL, [schema]);
  const tableRows = await run<TableRow>(TABLES_SQL, [schema]);
  const primaryKeyRows = await run<PrimaryKeyRow>(PRIMARY_KEYS_SQL, [schema]);
  const foreignKeyRows = await run<ForeignKeyRow>(FOREIGN_KEYS_SQL, [schema]);

  /* ---- primary keys ------------------------------------------------------ */
  const primaryKeysByTable = new Map<string, string[]>();
  for (const row of primaryKeyRows) {
    const existing = primaryKeysByTable.get(row.table_name);
    if (existing) {
      existing.push(row.column_name);
    } else {
      primaryKeysByTable.set(row.table_name, [row.column_name]);
    }
  }

  /* ---- join graph -------------------------------------------------------- */
  const joinsByFactTable = new Map<string, CatalogJoin[]>();
  for (const row of foreignKeyRows) {
    // A composite foreign key cannot be expressed as a single join edge in
    // this model, and a second edge to a table already joined would need an
    // alias (a role-playing dimension - two date keys on one fact, say).
    // Neither appears in DataSphere's schema; both are skipped rather than
    // emitted as something subtly wrong.
    const existing = joinsByFactTable.get(row.from_table) ?? [];
    if (existing.some((join) => join.table === row.to_table)) continue;

    existing.push({
      table: row.to_table,
      factColumn: row.from_column,
      dimensionColumn: row.to_column,
    });
    joinsByFactTable.set(row.from_table, existing);
  }

  /* ---- columns ----------------------------------------------------------- */
  const columnsByTable = new Map<string, CatalogColumn[]>();
  for (const row of columnRows) {
    // A type the compiler has no rules for is left out entirely, so it cannot
    // be named in a query spec. Failing closed matters here: a jsonb column
    // added to a migration must not become silently queryable.
    const kind = columnKindForPostgresType(row.data_type);
    if (kind === null) continue;

    const column: CatalogColumn = {
      name: row.column_name,
      label: humanizeName(row.column_name),
      dataType: row.data_type,
      kind,
      nullable: Boolean(row.nullable),
      groupable: isGroupable(kind),
      aggregatable: isAggregatable(kind),
      ...(row.description ? { description: row.description } : {}),
    };

    const existing = columnsByTable.get(row.table_name);
    if (existing) {
      existing.push(column);
    } else {
      columnsByTable.set(row.table_name, [column]);
    }
  }

  /* ---- tables ------------------------------------------------------------ */
  const tables: CatalogTable[] = tableRows.map((row) => {
    const role: TableRole = joinsByFactTable.has(row.table_name) ? 'fact' : 'dimension';

    return {
      name: row.table_name,
      label: humanizeName(row.table_name),
      role,
      primaryKey: primaryKeysByTable.get(row.table_name) ?? [],
      columns: columnsByTable.get(row.table_name) ?? [],
      rowEstimate: Number(row.row_estimate) || 0,
      ...(row.description ? { description: row.description } : {}),
    };
  });

  /* ---- datasets ---------------------------------------------------------- */
  const datasets: CatalogDataset[] = tables
    .filter((table) => table.role === 'fact')
    .map((table) => {
      const joins = joinsByFactTable.get(table.name) ?? [];
      return {
        name: table.name.replace(/^fact_/, ''),
        label: humanizeName(table.name),
        factTable: table.name,
        joins,
        ...(table.description ? { description: table.description } : {}),
      };
    });

  return {
    schema,
    datasets,
    tables,
    generatedAt: new Date().toISOString(),
  };
}
