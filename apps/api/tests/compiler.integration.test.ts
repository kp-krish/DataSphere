/**
 * Compiler integration tests.
 *
 * The unit tests in @datasphere/core prove the compiler produces *safe* SQL.
 * They cannot prove it produces *valid* SQL, because they run without a
 * database - a compiler that emitted `GROUP BY` in the wrong place would pass
 * every one of them.
 *
 * These tests close that gap. They introspect the real schema, compile a
 * representative set of dashboard queries, and execute them against the real
 * seeded database. A syntax error, a wrong join, or a parameter type Postgres
 * cannot infer fails here and nowhere else.
 *
 * Requires a migrated, seeded database. `docker compose up -d postgres` plus
 * `npm run migrate && npm run seed` is enough; CI provides one as a service.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  compileQuery,
  introspectCatalog,
  type Catalog,
  type CompileOptions,
  type QuerySpec,
  type SqlRunner,
} from '@datasphere/core';

const DATABASE_URL = process.env.DATABASE_URL;

const OPTIONS: CompileOptions = { maxRows: 10_000, defaultLimit: 500 };

let client: Client;
let catalog: Catalog;

/**
 * The seeded row count, read rather than assumed. SEED_FACT_ROWS is two
 * million locally and a tenth of that in CI, and none of these tests is about
 * how large the fixture is.
 */
let factRows: number;

/**
 * Skipped rather than failed when no database is configured, so `npm test` on
 * a fresh clone is still useful. CI sets DATABASE_URL, so the coverage is not
 * optional where it counts.
 */
const describeWithDb = DATABASE_URL ? describe : describe.skip;

beforeAll(async () => {
  if (!DATABASE_URL) return;

  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const run: SqlRunner = async (text, values) => {
    const result = await client.query(text, values as unknown[]);
    return result.rows;
  };
  catalog = await introspectCatalog(run, { schema: 'analytics' });

  const counted = await client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM analytics.fact_orders',
  );
  factRows = Number(counted.rows[0]!.n);
});

afterAll(async () => {
  await client?.end();
});

/** Compile a spec and run it, returning the rows. */
async function runSpec(spec: QuerySpec): Promise<Record<string, unknown>[]> {
  const compiled = compileQuery(spec, catalog, OPTIONS);
  const result = await client.query(compiled.text, compiled.values as unknown[]);
  return result.rows;
}

describeWithDb('introspection against the live schema', () => {
  it('discovers the star without being told about it', () => {
    expect(catalog.schema).toBe('analytics');
    expect(catalog.datasets).toHaveLength(1);

    const dataset = catalog.datasets[0]!;
    expect(dataset.name).toBe('orders');
    expect(dataset.factTable).toBe('fact_orders');
    expect(dataset.joins.map((join) => join.table).sort()).toEqual([
      'dim_customer',
      'dim_date',
      'dim_product',
      'dim_store',
    ]);
  });

  it('classifies tables by their foreign keys, not their names', () => {
    const roles = Object.fromEntries(catalog.tables.map((table) => [table.name, table.role]));
    expect(roles).toEqual({
      fact_orders: 'fact',
      dim_customer: 'dimension',
      dim_date: 'dimension',
      dim_product: 'dimension',
      dim_store: 'dimension',
    });
  });

  it('excludes application tables, which live outside the introspected schema', () => {
    const names = catalog.tables.map((table) => table.name);
    expect(names).not.toContain('dashboards');
    expect(names).not.toContain('widgets');
    expect(names).not.toContain('pgmigrations');
  });

  it('maps declared Postgres types onto the semantic kinds the compiler uses', () => {
    const fact = catalog.tables.find((table) => table.name === 'fact_orders')!;
    const byName = Object.fromEntries(fact.columns.map((column) => [column.name, column]));

    expect(byName.revenue!.dataType).toBe('numeric(12,2)');
    expect(byName.revenue!.kind).toBe('number');
    expect(byName.revenue!.aggregatable).toBe(true);
    // Continuous money is not a sensible GROUP BY key.
    expect(byName.revenue!.groupable).toBe(false);

    expect(byName.store_id!.dataType).toBe('smallint');
    expect(byName.store_id!.kind).toBe('integer');
    expect(byName.ordered_at!.kind).toBe('timestamp');
    expect(byName.order_status!.kind).toBe('string');
  });

  it('records the generated profit column as an ordinary measure', () => {
    const fact = catalog.tables.find((table) => table.name === 'fact_orders')!;
    const profit = fact.columns.find((column) => column.name === 'profit')!;
    expect(profit.kind).toBe('number');
    expect(profit.aggregatable).toBe(true);
  });
});

describeWithDb('compiled SQL executes correctly', () => {
  it('runs a grouped aggregate and returns the declared columns', async () => {
    const rows = await runSpec({
      dataset: 'orders',
      dimensions: [{ table: 'dim_product', column: 'category' }],
      measures: [
        { table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' },
        { table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'orders' },
      ],
      sort: [{ alias: 'revenue', direction: 'desc' }],
    });

    expect(rows).toHaveLength(4);
    expect(Object.keys(rows[0]!)).toEqual(['category', 'revenue', 'orders']);

    // Descending sort actually applied.
    const revenues = rows.map((row) => Number(row.revenue));
    expect(revenues).toEqual([...revenues].sort((a, b) => b - a));

    // The seeded shape: Technology leads revenue, Office Supplies leads volume.
    expect(rows[0]!.category).toBe('Technology');
  });

  it('returns a single row for a KPI-style query with no dimensions', async () => {
    const rows = await runSpec({
      dataset: 'orders',
      dimensions: [],
      measures: [{ table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'total' }],
    });

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.total)).toBe(factRows);
  });

  it('buckets a date dimension by month and returns dates, not timestamps', async () => {
    const rows = await runSpec({
      dataset: 'orders',
      dimensions: [{ table: 'dim_date', column: 'full_date', grain: 'month', alias: 'month' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      filters: [{ table: 'dim_date', column: 'year_num', operator: 'eq', values: [2024] }],
      sort: [{ alias: 'month', direction: 'asc' }],
    });

    expect(rows).toHaveLength(12);
    // date_trunc(...)::date comes back as a JS Date at midnight, not a string.
    expect(rows[0]!.month).toBeInstanceOf(Date);

    // December must out-earn January: the seed applies retail seasonality.
    expect(Number(rows[11]!.revenue)).toBeGreaterThan(Number(rows[0]!.revenue));
  });

  it('resolves IN via = ANY for text, integer and date columns alike', async () => {
    // The riskiest thing the compiler emits: Postgres has to infer the array
    // element type from the comparison context for each of these.
    const text = await runSpec({
      dataset: 'orders',
      dimensions: [{ table: 'fact_orders', column: 'order_status', alias: 'status' }],
      measures: [{ table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'n' }],
      filters: [
        {
          table: 'fact_orders',
          column: 'order_status',
          operator: 'in',
          values: ['completed', 'returned'],
        },
      ],
    });
    expect(text.map((row) => row.status).sort()).toEqual(['completed', 'returned']);

    const integers = await runSpec({
      dataset: 'orders',
      dimensions: [{ table: 'dim_date', column: 'year_num', alias: 'y' }],
      measures: [{ table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'n' }],
      filters: [{ table: 'dim_date', column: 'year_num', operator: 'in', values: [2023, 2024] }],
    });
    expect(integers.map((row) => Number(row.y)).sort()).toEqual([2023, 2024]);

    const dates = await runSpec({
      dataset: 'orders',
      dimensions: [{ table: 'dim_date', column: 'full_date', alias: 'd' }],
      measures: [{ table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'n' }],
      filters: [
        {
          table: 'dim_date',
          column: 'full_date',
          operator: 'in',
          values: ['2024-06-01', '2024-06-02'],
        },
      ],
    });
    expect(dates).toHaveLength(2);
  });

  it('applies BETWEEN on dates inclusively', async () => {
    const rows = await runSpec({
      dataset: 'orders',
      dimensions: [{ table: 'dim_date', column: 'full_date', alias: 'd' }],
      measures: [{ table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'n' }],
      filters: [
        {
          table: 'dim_date',
          column: 'full_date',
          operator: 'between',
          values: ['2024-03-01', '2024-03-07'],
        },
      ],
    });
    expect(rows).toHaveLength(7);
  });

  it('matches case-insensitively and treats a literal % as text, not a wildcard', async () => {
    const matches = await runSpec({
      dataset: 'orders',
      dimensions: [{ table: 'dim_product', column: 'brand', alias: 'brand' }],
      measures: [{ table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'n' }],
      filters: [
        // Lowercase input against a capitalised brand proves ILIKE is in play.
        { table: 'dim_product', column: 'brand', operator: 'starts_with', values: ['north'] },
      ],
    });
    expect(matches.map((row) => row.brand)).toEqual(['Northwind']);

    // No brand contains a percent sign, so an escaped % must match nothing.
    // Were the wildcard unescaped, this would match every product.
    const escaped = await runSpec({
      dataset: 'orders',
      dimensions: [{ table: 'dim_product', column: 'brand', alias: 'brand' }],
      measures: [{ table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'n' }],
      filters: [{ table: 'dim_product', column: 'brand', operator: 'contains', values: ['%'] }],
    });
    expect(escaped).toHaveLength(0);
  });

  it('joins several dimensions in one query', async () => {
    const rows = await runSpec({
      dataset: 'orders',
      dimensions: [
        { table: 'dim_store', column: 'channel', alias: 'channel' },
        { table: 'dim_customer', column: 'segment', alias: 'segment' },
      ],
      measures: [{ table: 'fact_orders', column: 'profit', fn: 'SUM', alias: 'profit' }],
      filters: [
        { table: 'fact_orders', column: 'order_status', operator: 'eq', values: ['completed'] },
        { table: 'dim_product', column: 'category', operator: 'eq', values: ['Technology'] },
      ],
      sort: [{ alias: 'profit', direction: 'desc' }],
    });

    // 4 channels x 4 segments.
    expect(rows).toHaveLength(16);
    expect(Object.keys(rows[0]!)).toEqual(['channel', 'segment', 'profit']);
  });

  it('enforces the row ceiling in the database, not just in the response', async () => {
    const spec: QuerySpec = {
      dataset: 'orders',
      dimensions: [{ table: 'dim_customer', column: 'customer_name', alias: 'name' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      limit: 999_999,
    };

    const compiled = compileQuery(spec, catalog, { maxRows: 25 });
    expect(compiled.appliedLimit).toBe(25);

    const result = await client.query(compiled.text, compiled.values as unknown[]);
    expect(result.rows).toHaveLength(25);
  });

  it('does not join a dimension the query never mentions', async () => {
    const compiled = compileQuery(
      {
        dataset: 'orders',
        dimensions: [{ table: 'dim_store', column: 'channel' }],
        measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
      },
      catalog,
      OPTIONS,
    );

    const plan = await client.query(
      `EXPLAIN (FORMAT JSON) ${compiled.text}`,
      compiled.values as unknown[],
    );
    const planText = JSON.stringify(plan.rows);

    expect(planText).toContain('dim_store');
    expect(planText).not.toContain('dim_customer');
    expect(planText).not.toContain('dim_product');
  });

  it('binds a hostile operand without executing it', async () => {
    // The end-to-end proof: a filter value that is itself a SQL statement.
    // It must come back as zero matching rows, and the fact table must still
    // be there afterwards.
    const rows = await runSpec({
      dataset: 'orders',
      dimensions: [],
      measures: [{ table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'n' }],
      filters: [
        {
          table: 'dim_product',
          column: 'product_name',
          operator: 'eq',
          values: [`'; DROP TABLE analytics.fact_orders; --`],
        },
      ],
    });

    expect(Number(rows[0]!.n)).toBe(0);

    const survived = await client.query('SELECT count(*)::text AS n FROM analytics.fact_orders');
    expect(Number(survived.rows[0].n)).toBe(factRows);
  });
});

describeWithDb('committed fixture stays in step with the live schema', () => {
  it('matches what introspection currently reports', async () => {
    const { FIXTURE_CATALOG } = await import('@datasphere/core/fixtures');

    // reltuples and the timestamp are normalised away in the dump, so compare
    // on the same footing rather than on values that drift with every VACUUM.
    const normalise = (value: Catalog) => ({
      ...value,
      generatedAt: '1970-01-01T00:00:00.000Z',
      tables: value.tables.map((table) => ({ ...table, rowEstimate: 0 })),
    });

    expect(normalise(catalog)).toEqual(normalise(FIXTURE_CATALOG as Catalog));
  });
});
