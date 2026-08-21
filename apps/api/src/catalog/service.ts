/**
 * Catalog cache.
 *
 * Introspection is four `pg_catalog` queries. That is cheap, but not cheap
 * enough to repeat on every query request, and the result only changes when a
 * migration runs. So it is read once and reused for a TTL.
 *
 * Two properties matter here beyond the caching itself:
 *
 *   Single-flight. A cold start under load would otherwise have every
 *   concurrent request introspect simultaneously. Callers arriving while a
 *   read is in progress await the same promise.
 *
 *   Serve-stale-on-failure. If a refresh fails but a previous catalog is in
 *   hand, the old one keeps being served. A blip in the database should not
 *   turn "your dashboard is slightly stale" into "your dashboard is broken" -
 *   and the schema almost certainly has not changed anyway.
 */

import { introspectCatalog, type Catalog, type SqlRunner } from '@datasphere/core';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { pool } from '../db/pool.js';

/**
 * Raised when there is no catalog to serve and none can be read.
 *
 * Distinct from a generic database error because it means something specific:
 * the query engine cannot validate anything at all, so the API is degraded
 * rather than broken. The HTTP layer answers 503.
 */
export class CatalogUnavailableError extends Error {
  constructor(cause: unknown) {
    // Error's own `cause` option, rather than a shadowing property: it is what
    // logger serialisers and `console.error` already know how to follow.
    super('The schema catalog could not be read from the database', { cause });
    this.name = 'CatalogUnavailableError';
    Object.setPrototypeOf(this, CatalogUnavailableError.prototype);
  }
}

interface CachedCatalog {
  catalog: Catalog;
  loadedAt: number;
}

let cached: CachedCatalog | null = null;
let inFlight: Promise<Catalog> | null = null;

/** Introspection runs through the pool, like everything else. */
const runner: SqlRunner = async (text, values) => {
  const result = await pool.query(text, values as unknown[]);
  return result.rows;
};

function isFresh(entry: CachedCatalog): boolean {
  return Date.now() - entry.loadedAt < env.CATALOG_TTL_SECONDS * 1_000;
}

async function load(): Promise<Catalog> {
  const startedAt = Date.now();
  const catalog = await introspectCatalog(runner, { schema: env.ANALYTICS_SCHEMA });

  cached = { catalog, loadedAt: Date.now() };

  logger.info(
    {
      schema: catalog.schema,
      datasets: catalog.datasets.length,
      tables: catalog.tables.length,
      columns: catalog.tables.reduce((sum, table) => sum + table.columns.length, 0),
      durationMs: Date.now() - startedAt,
    },
    'Schema catalog introspected',
  );

  return catalog;
}

/**
 * The current catalog, introspecting it if the cache is cold or expired.
 */
export async function getCatalog(): Promise<Catalog> {
  if (cached && isFresh(cached)) {
    return cached.catalog;
  }

  // Someone else is already reading it; join them rather than piling on.
  if (inFlight) return inFlight;

  inFlight = load().finally(() => {
    inFlight = null;
  });

  try {
    return await inFlight;
  } catch (error) {
    if (cached) {
      logger.warn(
        { err: error, ageSeconds: Math.round((Date.now() - cached.loadedAt) / 1_000) },
        'Catalog refresh failed; continuing to serve the previous catalog',
      );
      return cached.catalog;
    }
    // Nothing cached and the read failed - there is no catalog to serve, and
    // without one no query can be validated.
    throw new CatalogUnavailableError(error);
  }
}

/** Force a re-read, ignoring the TTL. Used by POST /api/catalog/refresh. */
export async function refreshCatalog(): Promise<Catalog> {
  cached = null;
  return getCatalog();
}

/** Whatever is cached right now, without triggering a read. Used by /ready. */
export function peekCatalog(): { catalog: Catalog; ageSeconds: number } | null {
  if (!cached) return null;
  return {
    catalog: cached.catalog,
    ageSeconds: Math.round((Date.now() - cached.loadedAt) / 1_000),
  };
}

/**
 * Warm the cache at startup so the first real request is not the one paying
 * for introspection. Failure is logged, not fatal: the database may simply
 * not be up yet, and the next request will retry.
 */
export async function warmCatalog(): Promise<void> {
  try {
    await getCatalog();
  } catch (error) {
    logger.warn(
      { err: error },
      'Could not warm the schema catalog at startup; will retry on demand',
    );
  }
}

/** Test seam: drop all cached state. */
export function resetCatalogCache(): void {
  cached = null;
  inFlight = null;
}
