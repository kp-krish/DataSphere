/**
 * Query result cache.
 *
 * Every function here swallows its own failures. The cache is an optimisation,
 * never a source of truth, so a Redis outage must degrade DataSphere to "as
 * fast as Postgres" rather than break it. A `get` that fails returns null,
 * which the caller cannot distinguish from a miss - and does not need to.
 *
 * Hit and miss counters live in Redis rather than in process memory so they
 * aggregate across API instances and survive a restart. They are incremented
 * fire-and-forget: a failed counter must never fail a request that otherwise
 * succeeded.
 */

import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { redis } from './redis.js';

/**
 * Refuse to cache a payload larger than this.
 *
 * Redis runs with a 256MB ceiling and allkeys-lru. A single 10,000-row result
 * can serialise to several megabytes, and letting a handful of those in would
 * evict everything else - turning a cache that serves many small dashboard
 * queries into one that serves a few enormous exports. The large query still
 * runs and still returns; it just is not stored.
 */
const MAX_CACHED_BYTES = 1_048_576; // 1 MiB

const statsKey = (name: string): string => `${env.CACHE_KEY_PREFIX}:stats:${name}`;

/** What actually goes into Redis. */
export interface CachedResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /**
   * What the query cost in Postgres when it was originally run. Kept so a hit
   * can report the time it saved rather than just claiming it saved some.
   */
  executionMs: number;
  appliedLimit: number;
  cachedAt: string;
  generation: number;
}

/**
 * Look up a cached result.
 *
 * Returns the payload plus the entry's remaining TTL, which the response
 * surfaces so the UI can show how stale the numbers are.
 */
export async function getCached(
  key: string,
): Promise<{ result: CachedResult; ttlRemaining: number } | null> {
  if (!env.CACHE_ENABLED || redis.status !== 'ready') return null;

  try {
    // One round trip for both the value and its TTL. Issuing them separately
    // would also race: the key can expire between the two calls.
    const replies = await redis.multi().get(key).ttl(key).exec();
    if (!replies) return null;

    const payload = replies[0]?.[1] as string | null | undefined;
    if (!payload) return null;

    const ttl = replies[1]?.[1] as number | undefined;

    return {
      result: JSON.parse(payload) as CachedResult,
      // -1 means the key has no expiry, -2 that it vanished between the two
      // commands. Neither is a meaningful "seconds remaining".
      ttlRemaining: Math.max(ttl ?? 0, 0),
    };
  } catch (error) {
    logger.debug({ err: error, key }, 'Cache read failed; treating as a miss');
    return null;
  }
}

/**
 * Store a result under the configured TTL.
 *
 * Fire-and-forget from the caller's point of view: the response has already
 * been computed, and failing to cache it is not a reason to fail the request.
 */
export async function setCached(key: string, result: CachedResult): Promise<boolean> {
  if (!env.CACHE_ENABLED || redis.status !== 'ready') return false;

  try {
    const payload = JSON.stringify(result);

    if (Buffer.byteLength(payload, 'utf8') > MAX_CACHED_BYTES) {
      logger.debug(
        { key, bytes: Buffer.byteLength(payload, 'utf8'), rowCount: result.rowCount },
        'Result too large to cache; serving it uncached',
      );
      return false;
    }

    await redis.set(key, payload, 'EX', env.CACHE_TTL_SECONDS);
    return true;
  } catch (error) {
    logger.debug({ err: error, key }, 'Cache write failed; result served uncached');
    return false;
  }
}

/** Count a hit or a miss. Never awaited on the request path. */
export function recordOutcome(outcome: 'hit' | 'miss' | 'bypass'): void {
  if (!env.CACHE_ENABLED || redis.status !== 'ready') return;

  redis.incr(statsKey(outcome)).catch(() => {
    // A dropped counter is not worth a log line on every request.
  });
}

export interface CacheStats {
  enabled: boolean;
  connected: boolean;
  hits: number;
  misses: number;
  bypasses: number;
  /** Hits as a fraction of hits + misses. Null before any traffic. */
  hitRate: number | null;
  /** Number of cached query results currently held. */
  entries: number;
  ttlSeconds: number;
  memoryUsedBytes: number | null;
}

export async function getStats(): Promise<CacheStats> {
  const base: CacheStats = {
    enabled: env.CACHE_ENABLED,
    connected: redis.status === 'ready',
    hits: 0,
    misses: 0,
    bypasses: 0,
    hitRate: null,
    entries: 0,
    ttlSeconds: env.CACHE_TTL_SECONDS,
    memoryUsedBytes: null,
  };

  if (!base.connected) return base;

  try {
    const [hits, misses, bypasses] = await redis.mget(
      statsKey('hit'),
      statsKey('miss'),
      statsKey('bypass'),
    );

    // SCAN rather than KEYS: KEYS blocks the server for the length of the
    // keyspace, which is exactly the wrong thing to do from a stats endpoint.
    const entries = await countEntries();
    const memory = await readMemoryUsed();

    const hitCount = Number(hits ?? 0);
    const missCount = Number(misses ?? 0);
    const total = hitCount + missCount;

    return {
      ...base,
      hits: hitCount,
      misses: missCount,
      bypasses: Number(bypasses ?? 0),
      hitRate: total === 0 ? null : Math.round((hitCount / total) * 10_000) / 10_000,
      entries,
      memoryUsedBytes: memory,
    };
  } catch (error) {
    logger.debug({ err: error }, 'Could not read cache stats');
    return base;
  }
}

/** Count cached result entries, excluding generation counters and stats. */
async function countEntries(): Promise<number> {
  const match = `${env.CACHE_KEY_PREFIX}:*`;
  let cursor = '0';
  let count = 0;

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 500);
    cursor = next;
    count += keys.filter(
      (key) =>
        !key.startsWith(`${env.CACHE_KEY_PREFIX}:gen:`) &&
        !key.startsWith(`${env.CACHE_KEY_PREFIX}:stats:`),
    ).length;
  } while (cursor !== '0');

  return count;
}

async function readMemoryUsed(): Promise<number | null> {
  try {
    const info = await redis.info('memory');
    const match = /used_memory:(\d+)/.exec(info);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export async function resetStats(): Promise<void> {
  if (redis.status !== 'ready') return;
  try {
    await redis.del(statsKey('hit'), statsKey('miss'), statsKey('bypass'));
  } catch (error) {
    logger.debug({ err: error }, 'Could not reset cache stats');
  }
}

/**
 * Delete every cached result, leaving generation counters intact.
 *
 * Bumping generations is the normal way to invalidate and is O(1); this exists
 * for the benchmark harness, which needs a genuinely cold cache between
 * configurations rather than a logically-empty one still occupying memory.
 */
export async function flushResults(): Promise<number> {
  if (redis.status !== 'ready') return 0;

  const match = `${env.CACHE_KEY_PREFIX}:*`;
  let cursor = '0';
  let deleted = 0;

  try {
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 500);
      cursor = next;

      const targets = keys.filter(
        (key) =>
          !key.startsWith(`${env.CACHE_KEY_PREFIX}:gen:`) &&
          !key.startsWith(`${env.CACHE_KEY_PREFIX}:stats:`),
      );

      if (targets.length > 0) {
        // UNLINK reclaims memory on a background thread; DEL blocks.
        deleted += await redis.unlink(...targets);
      }
    } while (cursor !== '0');
  } catch (error) {
    logger.warn({ err: error }, 'Cache flush did not complete');
  }

  return deleted;
}
