/**
 * Query execution.
 *
 * The path a request takes: validate shape (zod, at the route) -> resolve the
 * catalog -> compile to parameterised SQL -> derive a cache key -> execute
 * under a statement timeout -> report what happened.
 *
 * Caching lands in phase 4. The cache key is already derived here because the
 * response contract exposes it, and because deriving it is a pure function of
 * the spec and the catalog - the only thing phase 4 adds is the Redis
 * round trip around `execute()`.
 */

import { createHash } from 'node:crypto';
import {
  cacheKeyMaterial,
  compileQuery,
  type Catalog,
  type CompiledQuery,
  type QueryResult,
  type QuerySpec,
} from '@datasphere/core';
import { env } from '../config/env.js';
import { withStatementTimeout } from '../db/pool.js';
import { getCatalog } from '../catalog/service.js';
import { coerceRows } from './coerce.js';

export interface ExecuteOptions {
  /** Go straight to Postgres, reporting cache: "bypass". */
  noCache?: boolean;
  /** Echo the generated SQL back in the response meta. */
  includeSql?: boolean;
}

/**
 * Hash the canonical key material.
 *
 * sha256 truncated to 32 hex characters (128 bits). Full length is wasted
 * bytes in every Redis key and log line; 128 bits is far beyond collision
 * risk for a cache whose entries expire in minutes.
 */
export function cacheKeyFor(spec: QuerySpec, catalog: Catalog, appliedLimit: number): string {
  const material = cacheKeyMaterial(spec, catalog, {
    appliedLimit,
    maxRows: env.QUERY_MAX_ROWS,
  });
  const digest = createHash('sha256').update(material).digest('hex').slice(0, 32);
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
 * Compile and run a query spec.
 *
 * Every execution goes through `withStatementTimeout`, so a spec that turns
 * out to be far more expensive than it looked cannot hold a pooled connection
 * indefinitely. Postgres cancels it and the error handler turns that into a
 * 504 naming the limit.
 */
export async function executeQuery(
  spec: QuerySpec,
  options: ExecuteOptions = {},
): Promise<QueryResult> {
  const startedAt = performance.now();

  const { compiled, cacheKey } = await compileOnly(spec);

  const executionStartedAt = performance.now();
  const rows = await withStatementTimeout(env.QUERY_TIMEOUT_MS, async (client) => {
    const result = await client.query(compiled.text, compiled.values as unknown[]);
    // `pg` hands back numeric and bigint as strings to preserve precision.
    // Convert them where that is provably lossless, so chart code does not
    // have to parse every value it receives. See coerce.ts.
    return coerceRows(result.rows, result.fields);
  });
  const executionMs = performance.now() - executionStartedAt;

  return {
    columns: compiled.columns,
    rows,
    meta: {
      rowCount: rows.length,
      executionMs: round(executionMs),
      totalMs: round(performance.now() - startedAt),
      // Phase 4 replaces this with a real lookup. Until then the response is
      // honest about the fact that nothing is being cached.
      cache: env.CACHE_ENABLED ? (options.noCache ? 'bypass' : 'miss') : 'disabled',
      cacheKey,
      appliedLimit: compiled.appliedLimit,
      ...(options.includeSql ? { sql: compiled.text } : {}),
    },
  };
}

function round(milliseconds: number): number {
  return Math.round(milliseconds * 100) / 100;
}
