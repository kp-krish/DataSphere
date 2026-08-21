/**
 * Catalog lookups - the allowlist itself.
 *
 * Every table and column name in a query spec is resolved through these
 * functions. They compare against the catalog with `===` on strings the
 * database reported about itself. There is no normalisation, no
 * case-folding, no "close enough" matching: a name either is one the
 * introspection returned, or the query is rejected.
 *
 * That strictness is the point. Fuzzy matching is how an allowlist stops being
 * an allowlist.
 */

import { QueryCompileError } from '../errors.js';
import type { Catalog, CatalogColumn, CatalogDataset, CatalogTable } from '../types.js';

/**
 * Pre-built lookup maps for one catalog.
 *
 * Built once per compile. The catalog is small (a handful of tables), so this
 * costs microseconds, but doing it up front keeps the compiler's own code free
 * of repeated linear scans.
 */
export interface CatalogIndex {
  catalog: Catalog;
  datasets: ReadonlyMap<string, CatalogDataset>;
  tables: ReadonlyMap<string, CatalogTable>;
  /** table name -> (column name -> column) */
  columns: ReadonlyMap<string, ReadonlyMap<string, CatalogColumn>>;
}

export function createCatalogIndex(catalog: Catalog): CatalogIndex {
  const datasets = new Map(catalog.datasets.map((dataset) => [dataset.name, dataset]));
  const tables = new Map(catalog.tables.map((table) => [table.name, table]));
  const columns = new Map(
    catalog.tables.map((table) => [
      table.name,
      new Map(table.columns.map((column) => [column.name, column])),
    ]),
  );

  return { catalog, datasets, tables, columns };
}

export function resolveDataset(index: CatalogIndex, name: unknown): CatalogDataset {
  if (typeof name !== 'string' || name.length === 0) {
    throw new QueryCompileError('unknown_dataset', 'Query spec must name a dataset', {
      dataset: name,
    });
  }

  const dataset = index.datasets.get(name);
  if (!dataset) {
    throw new QueryCompileError('unknown_dataset', `Unknown dataset "${name}"`, {
      dataset: name,
      available: [...index.datasets.keys()],
    });
  }
  return dataset;
}

/**
 * The set of tables a given dataset may reference: its fact table plus every
 * dimension reachable by a declared join edge.
 *
 * Because this is derived from the dataset rather than from the catalog as a
 * whole, a spec cannot reach a table that exists in the schema but is not part
 * of this star - even though that table is in the catalog.
 */
export function tablesForDataset(dataset: CatalogDataset): ReadonlySet<string> {
  return new Set([dataset.factTable, ...dataset.joins.map((join) => join.table)]);
}

export function resolveTable(
  index: CatalogIndex,
  dataset: CatalogDataset,
  tableName: unknown,
): CatalogTable {
  if (typeof tableName !== 'string' || tableName.length === 0) {
    throw new QueryCompileError('unknown_table', 'Field reference is missing a table name', {
      table: tableName,
    });
  }

  const table = index.tables.get(tableName);
  if (!table) {
    throw new QueryCompileError('unknown_table', `Unknown table "${tableName}"`, {
      table: tableName,
    });
  }

  // In the catalog, but not part of this dataset's star.
  if (!tablesForDataset(dataset).has(tableName)) {
    throw new QueryCompileError(
      'table_not_joinable',
      `Table "${tableName}" is not joinable from dataset "${dataset.name}"`,
      { table: tableName, dataset: dataset.name, joinable: [...tablesForDataset(dataset)] },
    );
  }

  return table;
}

export function resolveColumn(
  index: CatalogIndex,
  table: CatalogTable,
  columnName: unknown,
): CatalogColumn {
  if (typeof columnName !== 'string' || columnName.length === 0) {
    throw new QueryCompileError('unknown_column', 'Field reference is missing a column name', {
      table: table.name,
      column: columnName,
    });
  }

  const column = index.columns.get(table.name)?.get(columnName);
  if (!column) {
    throw new QueryCompileError(
      'unknown_column',
      `Unknown column "${columnName}" on table "${table.name}"`,
      { table: table.name, column: columnName },
    );
  }
  return column;
}

/** Resolve a `{ table, column }` reference in one step. */
export function resolveField(
  index: CatalogIndex,
  dataset: CatalogDataset,
  ref: { table: unknown; column: unknown },
): { table: CatalogTable; column: CatalogColumn } {
  const table = resolveTable(index, dataset, ref.table);
  const column = resolveColumn(index, table, ref.column);
  return { table, column };
}
