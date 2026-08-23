/**
 * Query execution.
 *
 * The path a request takes:
 *
 *   validate shape (zod, at the route)
 *     -> resolve the catalog
 *     -> compile to parameterised SQL
 *     -> derive a cache key from the normalised spec
 *     -> look in Redis
 *          hit  : return the stored rows, reporting the time saved
 *          miss : execute under a statement timeout, then store
 *     -> report what happened
 *
 * The cache is never load-bearing. Every path through it degrades to "run the
 * query" if Redis is unavailable, and the response says so rather than
 * pretending the cache was consulted.
 */

import { createHash } from 'node:crypto';
import {
  cacheKeyMaterial,
  compileQuery,
  type CacheStatus,
  type Catalog,
  type CompiledQuery,
  type QueryResult,
  type QuerySpec,
} from '@datasphere/core';
import { env } from '../config/env.js';
import { withStatementTimeout } from '../db/pool.js';
import { getCatalog } from '../catalog/service.js';
import { getGeneration } from '../cache/generations.js';
import { getCached, recordOutcome, setCached, type CachedResult } from '../cache/queryCache.js';
import { redis } from '../cache/redis.js';
import { coerceRows } from './coerce.js';

export interface ExecuteOptions {
  /** Go straight to Postgres, reporting cache: "bypass". */
  noCache?: boolean;
  /** Echo the generated SQL back in the response meta. */
  includeSql?: boolean;
}

/**
 * Hash the canonical key material into a Redis key.
 *
 * The dataset's generation is folded in, which is what makes invalidation an
 * O(1) INCR: bumping it changes every key for that dataset at once, so
 * previously cached entries can never be computed - and therefore never read -
 * again. See cache/generations.ts.
 *
 * sha256 truncated to 32 hex characters (128 bits). The full digest is wasted
 * bytes in every key and log line, and 128 bits is far beyond collision risk
 * for a cache whose entries expire in minutes.
 */
export function cacheKeyFor(spec: QuerySpec, catalog: Catalog, appliedLimit: number): string {
  const generation = getGeneration(spec.dataset);

  const material = cacheKeyMaterial(spec, catalog, {
    appliedLimit,
    maxRows: env.QUERY_MAX_ROWS,
  });

  const digest = createHash('sha256')
    .update(`${material} gen:${generation}`)
    .digest('hex')
    .slice(0, 32);

  return `${env.CACHE_KEY_PREFIX}:${digest}`;
}

/** Compile without executing. Backs POST /api/query/compile. */
export async function compileOnly(spec: QuerySpec): Promise<{
  compiled: CompiledQuery;
  catalog: Catalog;
  cacheKey: string;
}> {
  const catalog = await getCatalog();
  const compiled = compileQuery(spec, catalog, {
    maxRows: env.QUERY_MAX_ROWS,
    defaultLimit: env.QUERY_DEFAULT_LIMIT,
  });

  return { compiled, catalog, cacheKey: cacheKeyFor(spec, catalog, compiled.appliedLimit) };
}

/**
 * Why the cache was not consulted, if it was not.
 *
 * `disabled` and `bypass` are kept apart deliberately: one is a property of
 * the system, the other a choice the caller made. Reporting a Redis outage as
 * `bypass` would make it invisible in the stats.
 */
function skipReason(noCache: boolean | undefined): CacheStatus | null {
  if (!env.CACHE_ENABLED || redis.status !== 'ready') return 'disabled';
  if (noCache) return 'bypass';
  return null;
}

/**
 * Compile and run a query spec, using the cache unless told not to.
 *
 * Execution goes through `withStatementTimeout`, so a spec that turns out far
 * more expensive than it looked cannot hold a pooled connection indefinitely:
 * Postgres cancels it and the error handler turns that into a 504.
 */
export async function executeQuery(
  spec: QuerySpec,
  options: ExecuteOptions = {},
): Promise<QueryResult> {
  const startedAt = performance.now();

  const { compiled, cacheKey } = await compileOnly(spec);
  const generation = getGeneration(spec.dataset);
  const skip = skipReason(options.noCache);

  /* ---- try the cache ----------------------------------------------------- */

  if (skip === null) {
    const cached = await getCached(cacheKey);

    if (cached) {
      recordOutcome('hit');

      return {
        columns: cached.result.columns,
        rows: cached.result.rows,
        meta: {
          rowCount: cached.result.rowCount,
          // Postgres was not touched, so the query cost nothing this time.
          executionMs: 0,
          totalMs: round(performance.now() - startedAt),
          cache: 'hit',
          cacheKey,
          cacheTtlRemaining: cached.ttlRemaining,
          cachedAt: cached.result.cachedAt,
          // What this hit actually saved, measured when the entry was written.
          savedMs: cached.result.executionMs,
          generation: cached.result.generation,
          appliedLimit: cached.result.appliedLimit,
          ...(options.includeSql ? { sql: compiled.text } : {}),
        },
      };
    }
  }

  /* ---- run it ------------------------------------------------------------ */

  const executionStartedAt = performance.now();
  const rows = await withStatementTimeout(env.QUERY_TIMEOUT_MS, async (client) => {
    const result = await client.query(compiled.text, compiled.values as unknown[]);
    // `pg` hands back numeric and bigint as strings to preserve precision.
    // Convert them where the magnitude allows, so chart code does not have to
    // parse every value it receives. See coerce.ts.
    return coerceRows(result.rows, result.fields);
  });
  const executionMs = round(performance.now() - executionStartedAt);

  const status: CacheStatus = skip ?? 'miss';
  recordOutcome(status === 'disabled' ? 'miss' : status);

  /* ---- store it ---------------------------------------------------------- */

  // A bypass still refreshes the entry: the caller asked for current data, and
  // having paid for it there is no reason for the next reader to pay again.
  if (status === 'miss' || status === 'bypass') {
    const payload: CachedResult = {
      columns: compiled.columns,
      rows,
      rowCount: rows.length,
      executionMs,
      appliedLimit: compiled.appliedLimit,
      cachedAt: new Date().toISOString(),
      generation,
    };
    // Not awaited: the result is ready, and a slow or failing cache write must
    // not delay or fail a response that already succeeded.
    void setCached(cacheKey, payload);
  }

  return {
    columns: compiled.columns,
    rows,
    meta: {
      rowCount: rows.length,
      executionMs,
      totalMs: round(performance.now() - startedAt),
      cache: status,
      cacheKey,
      generation,
      appliedLimit: compiled.appliedLimit,
      ...(options.includeSql ? { sql: compiled.text } : {}),
    },
  };
}

function round(milliseconds: number): number {
  return Math.round(milliseconds * 100) / 100;
}
