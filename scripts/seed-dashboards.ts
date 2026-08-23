/**
 * Create the demo dashboard.
 *
 *   npm run seed:dashboards
 *
 * `docker compose up` should land on something worth looking at, not an empty
 * state with a "create your first dashboard" button. This builds one dashboard
 * covering all five widget types against the seeded star schema.
 *
 * Every spec is compiled against the introspected catalog before it is
 * written, exactly as the API does on POST /widgets. A demo dashboard whose
 * widgets fail to load is worse than no demo dashboard, and compiling here
 * means a schema change that breaks one of these fails the seed loudly rather
 * than showing up as a broken card in the UI.
 *
 * Idempotent: it does nothing if the dashboard already exists.
 */

import process from 'node:process';
import { Client } from 'pg';
import {
  compileQuery,
  introspectCatalog,
  type QuerySpec,
  type SqlRunner,
  type WidgetConfig,
  type WidgetType,
} from '@datasphere/core';

const DASHBOARD_NAME = 'Sales overview';

interface DemoWidget {
  title: string;
  type: WidgetType;
  spec: QuerySpec;
  config: WidgetConfig;
  width: number;
  height: number;
}

/**
 * The demo set is chosen to exercise the engine, not just to look busy: a
 * bucketed date dimension, a multi-dimension grouping, a filtered aggregate, a
 * COUNT DISTINCT, and a no-dimension KPI.
 */
const WIDGETS: DemoWidget[] = [
  {
    title: 'Total revenue',
    type: 'kpi',
    width: 3,
    height: 1,
    spec: {
      dataset: 'orders',
      dimensions: [],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      filters: [
        { table: 'fact_orders', column: 'order_status', operator: 'eq', values: ['completed'] },
      ],
    },
    config: { valueKey: 'revenue', format: 'currency' },
  },
  {
    title: 'Completed orders',
    type: 'kpi',
    width: 3,
    height: 1,
    spec: {
      dataset: 'orders',
      dimensions: [],
      measures: [{ table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'orders' }],
      filters: [
        { table: 'fact_orders', column: 'order_status', operator: 'eq', values: ['completed'] },
      ],
    },
    config: { valueKey: 'orders', format: 'number' },
  },
  {
    title: 'Distinct customers',
    type: 'kpi',
    width: 3,
    height: 1,
    spec: {
      dataset: 'orders',
      dimensions: [],
      measures: [
        { table: 'fact_orders', column: 'customer_id', fn: 'COUNT_DISTINCT', alias: 'customers' },
      ],
    },
    config: { valueKey: 'customers', format: 'number' },
  },
  {
    title: 'Average order value',
    type: 'kpi',
    width: 3,
    height: 1,
    spec: {
      dataset: 'orders',
      dimensions: [],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'AVG', alias: 'avg_order' }],
      filters: [
        { table: 'fact_orders', column: 'order_status', operator: 'eq', values: ['completed'] },
      ],
    },
    config: { valueKey: 'avg_order', format: 'currency' },
  },
  {
    title: 'Revenue by month',
    type: 'line',
    width: 8,
    height: 1,
    spec: {
      dataset: 'orders',
      dimensions: [{ table: 'dim_date', column: 'full_date', grain: 'month', alias: 'month' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      filters: [
        { table: 'dim_date', column: 'year_num', operator: 'gte', values: [2024] },
        { table: 'fact_orders', column: 'order_status', operator: 'eq', values: ['completed'] },
      ],
      sort: [{ alias: 'month', direction: 'asc' }],
      limit: 36,
    },
    config: { xKey: 'month', yKeys: ['revenue'], format: 'currency', refreshInterval: 0 },
  },
  {
    title: 'Revenue share by category',
    type: 'pie',
    width: 4,
    height: 1,
    spec: {
      dataset: 'orders',
      dimensions: [{ table: 'dim_product', column: 'category', alias: 'category' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      sort: [{ alias: 'revenue', direction: 'desc' }],
    },
    config: { xKey: 'category', valueKey: 'revenue', format: 'currency' },
  },
  {
    title: 'Revenue by subcategory',
    type: 'bar',
    width: 6,
    height: 1,
    spec: {
      dataset: 'orders',
      dimensions: [{ table: 'dim_product', column: 'subcategory', alias: 'subcategory' }],
      measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
      sort: [{ alias: 'revenue', direction: 'desc' }],
      limit: 10,
    },
    config: { xKey: 'subcategory', yKeys: ['revenue'], format: 'currency' },
  },
  {
    title: 'Profit by channel',
    type: 'bar',
    width: 6,
    height: 1,
    spec: {
      dataset: 'orders',
      dimensions: [{ table: 'dim_store', column: 'channel', alias: 'channel' }],
      measures: [
        { table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' },
        { table: 'fact_orders', column: 'profit', fn: 'SUM', alias: 'profit' },
      ],
      sort: [{ alias: 'revenue', direction: 'desc' }],
    },
    config: { xKey: 'channel', yKeys: ['revenue', 'profit'], format: 'currency' },
  },
  {
    title: 'Top customer segments',
    type: 'table',
    width: 12,
    height: 1,
    spec: {
      dataset: 'orders',
      dimensions: [
        { table: 'dim_customer', column: 'segment', alias: 'segment' },
        { table: 'dim_customer', column: 'region', alias: 'region' },
      ],
      measures: [
        { table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' },
        { table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'orders' },
        { table: 'fact_orders', column: 'quantity', fn: 'AVG', alias: 'avg_qty' },
      ],
      sort: [{ alias: 'revenue', direction: 'desc' }],
      limit: 25,
    },
    config: { format: 'number' },
  },
];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  const force = process.argv.includes('--force');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM app.dashboards WHERE name = $1',
      [DASHBOARD_NAME],
    );

    if (existing.rows.length > 0 && !force) {
      console.log(`Dashboard "${DASHBOARD_NAME}" already exists. Nothing to do.`);
      console.log('Pass --force to rebuild it.');
      return;
    }

    // Validate every spec before writing anything, so a broken one cannot
    // leave a half-built dashboard behind.
    const run: SqlRunner = async (text, values) => {
      const result = await client.query(text, values as unknown[]);
      return result.rows;
    };
    const catalog = await introspectCatalog(run, { schema: process.env.ANALYTICS_SCHEMA });

    for (const widget of WIDGETS) {
      try {
        compileQuery(widget.spec, catalog, { maxRows: 10_000, defaultLimit: 1_000 });
      } catch (error) {
        throw new Error(
          `Demo widget "${widget.title}" does not compile against the current schema: ${
            error instanceof Error ? error.message : String(error)
          }`,
          // Keep the QueryCompileError attached: its `code` and `detail` name
          // the offending column, which the message alone does not.
          { cause: error },
        );
      }
    }

    await client.query('BEGIN');

    if (existing.rows.length > 0) {
      // Widgets cascade.
      await client.query('DELETE FROM app.dashboards WHERE name = $1', [DASHBOARD_NAME]);
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO app.dashboards (name, description)
       VALUES ($1, $2)
       RETURNING id`,
      [
        DASHBOARD_NAME,
        'Demo dashboard covering every widget type, built from the seeded star schema.',
      ],
    );
    const dashboardId = rows[0]!.id;

    for (const [position, widget] of WIDGETS.entries()) {
      await client.query(
        `INSERT INTO app.widgets
           (dashboard_id, title, type, query_spec, config, position, width, height)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
        [
          dashboardId,
          widget.title,
          widget.type,
          JSON.stringify(widget.spec),
          JSON.stringify(widget.config),
          position,
          widget.width,
          widget.height,
        ],
      );
    }

    await client.query('COMMIT');

    console.log(`Created "${DASHBOARD_NAME}" with ${WIDGETS.length} widgets.`);
    console.log(`  http://localhost:5173/dashboards/${dashboardId}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('Dashboard seed failed:');
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
