/**
 * HTTP integration tests.
 *
 * These drive the real Express app with Supertest against the real seeded
 * database. No mocks: the point is to catch what unit tests structurally
 * cannot - routing, status codes, JSON shapes, and whether the compiler's
 * guarantees actually survive the trip through HTTP.
 *
 * The app is imported dynamically inside beforeAll because importing it
 * evaluates the environment schema, which throws when DATABASE_URL is absent.
 * A static import would take the whole file down instead of skipping it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

let app: Express;
let closeResources: () => Promise<void>;

/** Dashboards created during the run, torn down at the end. */
const createdDashboards: string[] = [];

async function createDashboard(name = 'Test dashboard'): Promise<string> {
  const response = await request(app).post('/api/dashboards').send({ name }).expect(201);
  createdDashboards.push(response.body.id);
  return response.body.id;
}

/** A spec that is valid against the real catalog. */
const VALID_SPEC = {
  dataset: 'orders',
  dimensions: [{ table: 'dim_product', column: 'category', alias: 'category' }],
  measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
  sort: [{ alias: 'revenue', direction: 'desc' }],
};

beforeAll(async () => {
  if (!DATABASE_URL) return;

  const [{ createApp }, { closePool }, { closeCache }] = await Promise.all([
    import('../src/app.js'),
    import('../src/db/pool.js'),
    import('../src/cache/redis.js'),
  ]);

  app = createApp();
  closeResources = async () => {
    await Promise.allSettled([closePool(), closeCache()]);
  };
});

afterAll(async () => {
  if (!DATABASE_URL) return;

  for (const id of createdDashboards) {
    await request(app).delete(`/api/dashboards/${id}`);
  }
  await closeResources?.();
});

/* -------------------------------------------------------------------------- */

describeWithDb('GET /api/catalog', () => {
  it('returns the introspected schema plus the rules the UI needs', async () => {
    const { body } = await request(app).get('/api/catalog').expect(200);

    expect(body.schema).toBe('analytics');
    expect(body.datasets.map((d: { name: string }) => d.name)).toEqual(['orders']);
    expect(body.tables).toHaveLength(5);

    // The operator matrix ships with the catalog so the client does not have
    // to reimplement the compiler's rules and drift from them.
    expect(body.meta.operators.string).toContain('contains');
    expect(body.meta.operators.number).not.toContain('contains');
    expect(body.meta.limits.maxRows).toBeGreaterThan(0);
  });

  it('never exposes application tables', async () => {
    const { body } = await request(app).get('/api/catalog').expect(200);
    const names = body.tables.map((t: { name: string }) => t.name);

    expect(names).not.toContain('dashboards');
    expect(names).not.toContain('widgets');
  });
});

describeWithDb('POST /api/query', () => {
  it('executes a spec and reports how it went', async () => {
    const { body } = await request(app).post('/api/query').send({ spec: VALID_SPEC }).expect(200);

    expect(body.columns).toEqual(['category', 'revenue']);
    expect(body.rows).toHaveLength(4);
    expect(body.meta.rowCount).toBe(4);
    expect(body.meta.executionMs).toBeGreaterThan(0);
    expect(body.meta.cacheKey).toMatch(/^ds:q:[0-9a-f]{32}$/);
  });

  it('returns numeric aggregates as numbers, not strings', async () => {
    const { body } = await request(app)
      .post('/api/query')
      .send({
        spec: {
          dataset: 'orders',
          dimensions: [],
          measures: [
            { table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' },
            { table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'orders' },
            { table: 'fact_orders', column: 'quantity', fn: 'AVG', alias: 'avg_qty' },
          ],
        },
      })
      .expect(200);

    const row = body.rows[0];
    expect(typeof row.revenue).toBe('number');
    expect(typeof row.orders).toBe('number');
    // AVG returns numeric with 16 decimal places; it must still arrive usable.
    expect(typeof row.avg_qty).toBe('number');
    expect(row.orders).toBe(2_000_000);
  });

  it('omits the SQL unless it is asked for', async () => {
    const without = await request(app).post('/api/query').send({ spec: VALID_SPEC }).expect(200);
    expect(without.body.meta.sql).toBeUndefined();

    const with_ = await request(app)
      .post('/api/query')
      .send({ spec: VALID_SPEC, includeSql: true })
      .expect(200);
    expect(with_.body.meta.sql).toContain('SELECT');
  });

  it('clamps a limit above the ceiling instead of refusing it', async () => {
    const { body } = await request(app)
      .post('/api/query')
      .send({
        spec: {
          dataset: 'orders',
          // email is unique per customer, so this groups into 50,000 rows -
          // comfortably more than the ceiling, which is the point.
          dimensions: [{ table: 'dim_customer', column: 'email', alias: 'email' }],
          measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
          limit: 999_999,
        },
      })
      .expect(200);

    expect(body.meta.appliedLimit).toBeLessThanOrEqual(10_000);
    expect(body.rows.length).toBe(body.meta.appliedLimit);
  });

  it('rejects a spec naming a table outside the catalog', async () => {
    const { body } = await request(app)
      .post('/api/query')
      .send({
        spec: {
          dataset: 'orders',
          dimensions: [{ table: 'dashboards', column: 'name' }],
          measures: [],
        },
      })
      .expect(400);

    // The compiler's own code survives the trip, so the UI can act on it.
    expect(body.error.code).toBe('unknown_table');
  });

  it('rejects an unknown column with the column named', async () => {
    const { body } = await request(app)
      .post('/api/query')
      .send({
        spec: {
          dataset: 'orders',
          dimensions: [],
          measures: [{ table: 'fact_orders', column: 'password', fn: 'SUM' }],
        },
      })
      .expect(400);

    expect(body.error.code).toBe('unknown_column');
    expect(body.error.details.column).toBe('password');
  });

  it('rejects a malformed body with field-level detail', async () => {
    const { body } = await request(app)
      .post('/api/query')
      .send({ spec: { dataset: 'orders', dimensions: 'not-an-array', measures: [] } })
      .expect(400);

    expect(body.error.code).toBe('invalid_request');
    expect(body.error.details[0].path).toContain('dimensions');
  });

  it('rejects unknown keys rather than ignoring them', async () => {
    // `filter` instead of `filters` would otherwise silently run unfiltered.
    const { body } = await request(app)
      .post('/api/query')
      .send({
        spec: {
          dataset: 'orders',
          dimensions: [],
          measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM' }],
          filter: [{ table: 'fact_orders', column: 'order_status', operator: 'eq', values: ['x'] }],
        },
      })
      .expect(400);

    expect(body.error.code).toBe('invalid_request');
  });

  it('binds a hostile filter operand instead of executing it', async () => {
    const payload = `'; DROP TABLE analytics.fact_orders; --`;

    const { body } = await request(app)
      .post('/api/query')
      .send({
        spec: {
          dataset: 'orders',
          dimensions: [],
          measures: [{ table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'n' }],
          filters: [
            { table: 'dim_product', column: 'product_name', operator: 'eq', values: [payload] },
          ],
        },
        includeSql: true,
      })
      .expect(200);

    expect(body.rows[0].n).toBe(0);
    expect(body.meta.sql).not.toContain('DROP');

    // And the table is still there.
    const check = await request(app)
      .post('/api/query')
      .send({
        spec: {
          dataset: 'orders',
          dimensions: [],
          measures: [{ table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'n' }],
        },
      })
      .expect(200);
    expect(check.body.rows[0].n).toBe(2_000_000);
  });
});

describeWithDb('POST /api/query/compile', () => {
  it('returns SQL and its bound values separately, without executing', async () => {
    const { body } = await request(app)
      .post('/api/query/compile')
      .send({
        ...VALID_SPEC,
        filters: [
          { table: 'fact_orders', column: 'order_status', operator: 'eq', values: ['completed'] },
        ],
      })
      .expect(200);

    expect(body.sql).toContain('SUM("fact_orders"."revenue")');
    expect(body.sql).toContain('$1');
    // The value is in `values`, never in `sql` - which is the whole point.
    expect(body.sql).not.toContain('completed');
    expect(body.values).toContain('completed');
    expect(body.columns).toEqual(['category', 'revenue']);
  });
});

/* -------------------------------------------------------------------------- */

describeWithDb('dashboard lifecycle', () => {
  it('creates, reads, updates and deletes', async () => {
    const created = await request(app)
      .post('/api/dashboards')
      .send({ name: '  Q4 Review  ', description: 'Quarterly' })
      .expect(201);

    // Whitespace is trimmed by the schema.
    expect(created.body.name).toBe('Q4 Review');
    expect(created.headers.location).toBe(`/api/dashboards/${created.body.id}`);
    const id = created.body.id;

    const fetched = await request(app).get(`/api/dashboards/${id}`).expect(200);
    expect(fetched.body.widgets).toEqual([]);

    const updated = await request(app)
      .patch(`/api/dashboards/${id}`)
      .send({ description: null })
      .expect(200);
    // An explicit null must clear the field, not be read as "leave unchanged".
    expect(updated.body.description).toBeNull();
    expect(updated.body.name).toBe('Q4 Review');

    await request(app).delete(`/api/dashboards/${id}`).expect(204);
    await request(app).get(`/api/dashboards/${id}`).expect(404);
  });

  it('rejects a blank name', async () => {
    const { body } = await request(app).post('/api/dashboards').send({ name: '   ' }).expect(400);
    expect(body.error.code).toBe('invalid_request');
  });

  it('rejects an empty PATCH rather than answering 200 to a no-op', async () => {
    const id = await createDashboard();
    const { body } = await request(app).patch(`/api/dashboards/${id}`).send({}).expect(400);
    expect(body.error.code).toBe('invalid_request');
  });

  it('answers 400, not 500, for a malformed id', async () => {
    const { body } = await request(app).get('/api/dashboards/not-a-uuid').expect(400);
    expect(body.error.code).toBe('invalid_id');
  });

  it('answers 404 for a well-formed id that does not exist', async () => {
    await request(app).get('/api/dashboards/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('lists dashboards with their widget counts', async () => {
    const id = await createDashboard('Counted dashboard');
    await request(app)
      .post(`/api/dashboards/${id}/widgets`)
      .send({ title: 'W', type: 'kpi', querySpec: VALID_SPEC })
      .expect(201);

    const { body } = await request(app).get('/api/dashboards').expect(200);
    const found = body.dashboards.find((d: { id: string }) => d.id === id);
    expect(found.widgetCount).toBe(1);
  });
});

describeWithDb('widgets', () => {
  it('appends widgets at increasing positions', async () => {
    const id = await createDashboard();

    const first = await request(app)
      .post(`/api/dashboards/${id}/widgets`)
      .send({ title: 'First', type: 'bar', querySpec: VALID_SPEC })
      .expect(201);
    const second = await request(app)
      .post(`/api/dashboards/${id}/widgets`)
      .send({ title: 'Second', type: 'line', querySpec: VALID_SPEC })
      .expect(201);

    expect(first.body.position).toBe(0);
    expect(second.body.position).toBe(1);
    // Defaults come from the database, not the client.
    expect(first.body.width).toBe(6);
    expect(first.body.height).toBe(1);
  });

  it('refuses to store a widget whose spec cannot compile', async () => {
    const id = await createDashboard();

    const { body } = await request(app)
      .post(`/api/dashboards/${id}/widgets`)
      .send({
        title: 'Broken',
        type: 'kpi',
        querySpec: {
          dataset: 'orders',
          dimensions: [],
          measures: [{ table: 'fact_orders', column: 'nonexistent', fn: 'SUM' }],
        },
      })
      .expect(400);

    expect(body.error.code).toBe('unknown_column');

    // Nothing was written - the dashboard is still empty.
    const dashboard = await request(app).get(`/api/dashboards/${id}`).expect(200);
    expect(dashboard.body.widgets).toEqual([]);
  });

  it('revalidates the spec on update', async () => {
    const id = await createDashboard();
    const widget = await request(app)
      .post(`/api/dashboards/${id}/widgets`)
      .send({ title: 'Fine', type: 'bar', querySpec: VALID_SPEC })
      .expect(201);

    await request(app)
      .patch(`/api/widgets/${widget.body.id}`)
      .send({
        querySpec: {
          dataset: 'orders',
          dimensions: [{ table: 'widgets', column: 'title' }],
          measures: [],
        },
      })
      .expect(400);

    // The stored spec is untouched.
    const after = await request(app).get(`/api/widgets/${widget.body.id}`).expect(200);
    expect(after.body.querySpec.dataset).toBe('orders');
    expect(after.body.querySpec.dimensions[0].table).toBe('dim_product');
  });

  it('enforces the width bounds that the database also enforces', async () => {
    const id = await createDashboard();
    const { body } = await request(app)
      .post(`/api/dashboards/${id}/widgets`)
      .send({ title: 'Too wide', type: 'bar', querySpec: VALID_SPEC, width: 99 })
      .expect(400);

    expect(body.error.code).toBe('invalid_request');
  });

  it('runs a stored spec through GET /api/widgets/:id/data', async () => {
    const id = await createDashboard();
    const widget = await request(app)
      .post(`/api/dashboards/${id}/widgets`)
      .send({ title: 'Data', type: 'bar', querySpec: VALID_SPEC })
      .expect(201);

    const { body } = await request(app).get(`/api/widgets/${widget.body.id}/data`).expect(200);

    expect(body.widgetId).toBe(widget.body.id);
    expect(body.rows).toHaveLength(4);
    expect(body.meta.rowCount).toBe(4);
  });

  it('deletes widgets with their dashboard', async () => {
    const id = await createDashboard();
    const widget = await request(app)
      .post(`/api/dashboards/${id}/widgets`)
      .send({ title: 'Doomed', type: 'kpi', querySpec: VALID_SPEC })
      .expect(201);

    await request(app).delete(`/api/dashboards/${id}`).expect(204);
    // ON DELETE CASCADE on app.widgets.dashboard_id.
    await request(app).get(`/api/widgets/${widget.body.id}`).expect(404);
  });
});

describeWithDb('PUT /api/dashboards/:id/widgets/order', () => {
  async function makeThree(): Promise<{ dashboardId: string; widgetIds: string[] }> {
    const dashboardId = await createDashboard();
    const widgetIds: string[] = [];

    for (const title of ['A', 'B', 'C']) {
      const response = await request(app)
        .post(`/api/dashboards/${dashboardId}/widgets`)
        .send({ title, type: 'bar', querySpec: VALID_SPEC })
        .expect(201);
      widgetIds.push(response.body.id);
    }
    return { dashboardId, widgetIds };
  }

  it('reassigns positions from the given order', async () => {
    const { dashboardId, widgetIds } = await makeThree();
    const reversed = [...widgetIds].reverse();

    const { body } = await request(app)
      .put(`/api/dashboards/${dashboardId}/widgets/order`)
      .send({ widgetIds: reversed })
      .expect(200);

    expect(body.widgets.map((w: { id: string }) => w.id)).toEqual(reversed);
    expect(body.widgets.map((w: { position: number }) => w.position)).toEqual([0, 1, 2]);
  });

  it('is idempotent, so a retried drag does not corrupt the order', async () => {
    const { dashboardId, widgetIds } = await makeThree();
    const order = [widgetIds[1]!, widgetIds[2]!, widgetIds[0]!];

    const first = await request(app)
      .put(`/api/dashboards/${dashboardId}/widgets/order`)
      .send({ widgetIds: order })
      .expect(200);
    const second = await request(app)
      .put(`/api/dashboards/${dashboardId}/widgets/order`)
      .send({ widgetIds: order })
      .expect(200);

    expect(second.body.widgets.map((w: { id: string }) => w.id)).toEqual(
      first.body.widgets.map((w: { id: string }) => w.id),
    );
  });

  it('refuses ids belonging to another dashboard, leaving the order intact', async () => {
    const { dashboardId, widgetIds } = await makeThree();
    const other = await makeThree();

    const { body } = await request(app)
      .put(`/api/dashboards/${dashboardId}/widgets/order`)
      .send({ widgetIds: [widgetIds[0]!, other.widgetIds[0]!] })
      .expect(400);

    expect(body.error.code).toBe('widget_not_on_dashboard');

    // The transaction rolled back: the original order survives.
    const after = await request(app).get(`/api/dashboards/${dashboardId}`).expect(200);
    expect(after.body.widgets.map((w: { id: string }) => w.id)).toEqual(widgetIds);
  });

  it('rejects duplicate ids', async () => {
    const { dashboardId, widgetIds } = await makeThree();
    const { body } = await request(app)
      .put(`/api/dashboards/${dashboardId}/widgets/order`)
      .send({ widgetIds: [widgetIds[0]!, widgetIds[0]!] })
      .expect(400);

    expect(body.error.code).toBe('duplicate_widget_id');
  });
});

describeWithDb('routing and errors', () => {
  it('answers unmatched routes in the standard error envelope', async () => {
    const { body } = await request(app).get('/api/nope').expect(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('/api/nope');
  });

  it('answers 400, not 500, for malformed JSON', async () => {
    const { body } = await request(app)
      .post('/api/query')
      .set('content-type', 'application/json')
      .send('{"spec": {')
      .expect(400);

    expect(body.error.code).toBe('invalid_json');
  });

  it('rejects a body larger than the configured limit with 413', async () => {
    const { body } = await request(app)
      .post('/api/query')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ spec: { dataset: 'x'.repeat(300 * 1024) } }))
      .expect(413);

    expect(body.error.code).toBe('payload_too_large');
  });
});
