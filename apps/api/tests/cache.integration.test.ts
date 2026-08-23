/**
 * Caching and invalidation, end to end.
 *
 * Run against the real Redis and the real seeded database. Mocking Redis here
 * would test that the mock behaves like Redis, which is not the risky part -
 * the risky parts are TTL handling, generation propagation through pub/sub,
 * and whether an invalidation actually makes a subsequent read miss.
 *
 * Anything that mutates the fact table cleans up after itself, so the row
 * count returns to its seeded baseline and the other suites keep their
 * assumptions.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

let app: Express;
let pool: Pool;
let closeResources: () => Promise<void>;

/** Demo rows are stamped with now(); the seed never goes past 2025. */
const DEMO_ROW_PREDICATE = "ordered_at >= '2026-01-01'";

const SPEC = {
  dataset: 'orders',
  dimensions: [{ table: 'dim_store', column: 'channel', alias: 'channel' }],
  measures: [{ table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' }],
};

/** A spec nobody else in this file uses, so its cache entry starts cold. */
function uniqueSpec(tag: number) {
  return {
    ...SPEC,
    measures: [
      { table: 'fact_orders', column: 'revenue', fn: 'SUM', alias: 'revenue' },
      { table: 'fact_orders', column: 'quantity', fn: 'SUM', alias: 'qty' },
    ],
    limit: 100 + tag,
  };
}

async function runQuery(spec: unknown, extra: Record<string, unknown> = {}) {
  const response = await request(app)
    .post('/api/query')
    .send({ spec, ...extra })
    .expect(200);
  return response.body;
}

beforeAll(async () => {
  if (!DATABASE_URL) return;

  const [{ createApp }, poolModule, { closeCache }] = await Promise.all([
    import('../src/app.js'),
    import('../src/db/pool.js'),
    import('../src/cache/redis.js'),
  ]);

  app = createApp();
  pool = poolModule.pool;
  closeResources = async () => {
    await Promise.allSettled([poolModule.closePool(), closeCache()]);
  };

  // Start from a known state.
  await request(app).delete('/api/cache?resetStats=1');
});

afterEach(async () => {
  if (!DATABASE_URL) return;
  // Undo anything the demo endpoint inserted.
  await pool.query(`DELETE FROM analytics.fact_orders WHERE ${DEMO_ROW_PREDICATE}`);
});

afterAll(async () => {
  if (!DATABASE_URL) return;
  await request(app).delete('/api/cache?resetStats=1');
  await closeResources?.();
});

/* -------------------------------------------------------------------------- */

describeWithDb('cache hit and miss', () => {
  it('misses first, then hits, and reports what the hit saved', async () => {
    const spec = uniqueSpec(1);

    const first = await runQuery(spec);
    expect(first.meta.cache).toBe('miss');
    expect(first.meta.executionMs).toBeGreaterThan(0);
    expect(first.meta.savedMs).toBeUndefined();

    const second = await runQuery(spec);
    expect(second.meta.cache).toBe('hit');
    // Postgres was not touched on a hit.
    expect(second.meta.executionMs).toBe(0);
    // savedMs is the original execution cost, measured when the entry was
    // written - not an estimate.
    expect(second.meta.savedMs).toBeCloseTo(first.meta.executionMs, 1);
    expect(second.meta.cachedAt).toBeTruthy();
    expect(second.meta.cacheTtlRemaining).toBeGreaterThan(0);

    // The whole point: serving from cache is dramatically cheaper.
    expect(second.meta.totalMs).toBeLessThan(first.meta.totalMs);
  });

  it('returns byte-identical rows from cache', async () => {
    const spec = uniqueSpec(2);
    const fresh = await runQuery(spec);
    const cached = await runQuery(spec);

    expect(cached.meta.cache).toBe('hit');
    expect(cached.rows).toEqual(fresh.rows);
    expect(cached.columns).toEqual(fresh.columns);
  });

  it('bypasses on request but still refreshes the entry', async () => {
    const spec = uniqueSpec(3);
    await runQuery(spec);

    const bypassed = await runQuery(spec, { noCache: true });
    expect(bypassed.meta.cache).toBe('bypass');
    // It went to Postgres...
    expect(bypassed.meta.executionMs).toBeGreaterThan(0);

    // ...and having paid for fresh data, the next reader gets it free.
    const after = await runQuery(spec);
    expect(after.meta.cache).toBe('hit');
    expect(after.meta.savedMs).toBeCloseTo(bypassed.meta.executionMs, 1);
  });

  it('gives specs that differ semantically different keys', async () => {
    const a = await runQuery({ ...SPEC, limit: 501 });
    const b = await runQuery({ ...SPEC, limit: 502 });

    expect(a.meta.cacheKey).not.toBe(b.meta.cacheKey);
  });

  it('shares one entry between specs that mean the same thing', async () => {
    // Filters are ANDed, so their order carries no meaning. The normaliser
    // sorts them, which is what lets these two share a cache entry instead of
    // computing the same answer twice.
    const filters = [
      { table: 'fact_orders', column: 'order_status', operator: 'eq', values: ['completed'] },
      { table: 'dim_store', column: 'channel', operator: 'eq', values: ['Online'] },
    ];

    const first = await runQuery({ ...SPEC, limit: 777, filters });
    const second = await runQuery({ ...SPEC, limit: 777, filters: [...filters].reverse() });

    expect(second.meta.cacheKey).toBe(first.meta.cacheKey);
    expect(second.meta.cache).toBe('hit');
  });
});

/* -------------------------------------------------------------------------- */

describeWithDb('invalidation', () => {
  it('makes a cached result unreachable and bumps the generation', async () => {
    const spec = uniqueSpec(10);

    await runQuery(spec);
    const warm = await runQuery(spec);
    expect(warm.meta.cache).toBe('hit');

    const { body } = await request(app)
      .post('/api/cache/invalidate')
      .send({ dataset: 'orders', reason: 'test' })
      .expect(200);

    expect(body.invalidated.orders).toBeGreaterThan(warm.meta.generation);

    const after = await runQuery(spec);
    expect(after.meta.cache).toBe('miss');
    expect(after.meta.generation).toBe(body.invalidated.orders);
    // A new generation means a new key, not a rewritten one.
    expect(after.meta.cacheKey).not.toBe(warm.meta.cacheKey);
  });

  it('invalidates every dataset when none is named', async () => {
    const { body } = await request(app).post('/api/cache/invalidate').send({}).expect(200);
    expect(Object.keys(body.invalidated)).toEqual(['orders']);
  });

  it('rejects an unknown dataset rather than silently doing nothing', async () => {
    const { body } = await request(app)
      .post('/api/cache/invalidate')
      .send({ dataset: 'not_a_dataset' })
      .expect(400);

    expect(body.error.code).toBe('unknown_dataset');
    expect(body.error.details.available).toEqual(['orders']);
  });
});

/* -------------------------------------------------------------------------- */

describeWithDb('data changes invalidate automatically', () => {
  it('inserting orders bumps the generation and the next read sees the new rows', async () => {
    const countSpec = {
      dataset: 'orders',
      dimensions: [],
      measures: [{ table: 'fact_orders', column: 'order_id', fn: 'COUNT', alias: 'n' }],
    };

    const before = await runQuery(countSpec);
    const warm = await runQuery(countSpec);
    expect(warm.meta.cache).toBe('hit');
    const baseline = before.rows[0].n;

    const { body: inserted } = await request(app)
      .post('/api/demo/orders')
      .send({ count: 7 })
      .expect(201);

    expect(inserted.inserted).toBe(7);
    expect(inserted.generation).toBeGreaterThan(warm.meta.generation);

    // Not a stale hit: the cache was invalidated as part of the write.
    const after = await runQuery(countSpec);
    expect(after.meta.cache).toBe('miss');
    expect(after.rows[0].n).toBe(baseline + 7);
  });

  it('caps how many rows a single demo insert can add', async () => {
    await request(app).post('/api/demo/orders').send({ count: 10_000 }).expect(400);
  });
});

/* -------------------------------------------------------------------------- */

describeWithDb('GET /api/cache/stats', () => {
  it('counts hits and misses and computes a hit rate', async () => {
    await request(app).delete('/api/cache?resetStats=1').expect(200);

    const spec = uniqueSpec(20);
    await runQuery(spec); // miss
    await runQuery(spec); // hit
    await runQuery(spec); // hit

    const { body } = await request(app).get('/api/cache/stats').expect(200);

    expect(body.enabled).toBe(true);
    expect(body.connected).toBe(true);
    expect(body.hits).toBe(2);
    expect(body.misses).toBe(1);
    expect(body.hitRate).toBeCloseTo(2 / 3, 3);
    expect(body.entries).toBeGreaterThan(0);
    expect(body.generations.orders).toBeGreaterThanOrEqual(0);
  });

  it('flushing removes stored results without touching generations', async () => {
    const spec = uniqueSpec(21);
    await runQuery(spec);

    const before = await request(app).get('/api/cache/stats').expect(200);
    expect(before.body.entries).toBeGreaterThan(0);
    const generation = before.body.generations.orders;

    await request(app).delete('/api/cache').expect(200);

    const after = await request(app).get('/api/cache/stats').expect(200);
    expect(after.body.entries).toBe(0);
    // Flushing is not invalidating: the counters are untouched.
    expect(after.body.generations.orders).toBe(generation);

    // And the query simply misses, rather than erroring.
    expect((await runQuery(spec)).meta.cache).toBe('miss');
  });
});

/* -------------------------------------------------------------------------- */

describeWithDb('SSE /api/events', () => {
  /**
   * Supertest cannot read a stream that never ends, so this binds a real
   * ephemeral port and reads the response body incrementally.
   */
  async function collectEvents(trigger: () => Promise<void>, ms = 2_500): Promise<string> {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };

    const controller = new AbortController();
    let received = '';

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      const pump = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += decoder.decode(value, { stream: true });
          }
        } catch {
          // Aborted, which is how this loop is meant to end.
        }
      })();

      // Let the stream open before anything is published.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await trigger();
      await new Promise((resolve) => setTimeout(resolve, ms));

      controller.abort();
      await pump;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    return received;
  }

  it('announces the stream is open', async () => {
    const received = await collectEvents(async () => {}, 300);
    expect(received).toContain('event: connected');
    // Tells the browser how long to wait before reconnecting.
    expect(received).toContain('retry:');
  });

  it('delivers an invalidation exactly once', async () => {
    // The instance that invalidates also receives its own message back off
    // Redis pub/sub. Emitting on both paths would make every widget refetch
    // twice for a single change.
    const received = await collectEvents(async () => {
      await request(app)
        .post('/api/cache/invalidate')
        .send({ dataset: 'orders', reason: 'sse test' })
        .expect(200);
    });

    const events = received.split('\n').filter((line) => line === 'event: invalidate');
    expect(events).toHaveLength(1);
    expect(received).toContain('"dataset":"orders"');
    expect(received).toContain('"reason":"sse test"');
  });

  it('delivers one event per distinct invalidation', async () => {
    const received = await collectEvents(async () => {
      await request(app).post('/api/cache/invalidate').send({ reason: 'one' }).expect(200);
      await request(app).post('/api/cache/invalidate').send({ reason: 'two' }).expect(200);
    });

    const events = received.split('\n').filter((line) => line === 'event: invalidate');
    expect(events).toHaveLength(2);
  });
});
