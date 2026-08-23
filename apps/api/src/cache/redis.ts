/**
 * Redis client.
 *
 * The cache is an optimisation, never a source of truth. Every helper here
 * degrades to "cache miss" on failure rather than throwing, so a Redis outage
 * makes DataSphere slower, not broken. That property is what lets the API
 * report a cache status of `bypass` instead of returning a 500.
 */

// ioredis ships ESM-syntax types inside a CommonJS package, so under NodeNext
// TypeScript resolves the default export to the module namespace rather than
// the class. The named export is unambiguous in both module systems.
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

export const redis = new Redis(env.REDIS_URL, {
  // Fail fast instead of queueing commands forever behind a dead connection;
  // a request would rather take the database path than hang.
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  connectTimeout: 3_000,
  lazyConnect: false,
  retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
});

/**
 * A second connection, used only for pub/sub.
 *
 * Redis puts a connection into subscriber mode when it subscribes, and in that
 * mode it will not accept ordinary commands. Sharing one client between GET
 * and SUBSCRIBE therefore breaks the cache the moment invalidation is wired
 * up, so the two are kept apart. Created lazily: a process that never
 * subscribes never opens it.
 */
let subscriberClient: Redis | null = null;

export function getSubscriber(): Redis {
  if (!subscriberClient) {
    subscriberClient = new Redis(env.REDIS_URL, {
      // A subscriber has no request to fail fast for; it should keep trying to
      // reconnect so invalidation resumes on its own after an outage.
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      connectTimeout: 3_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });

    subscriberClient.on('error', (error: Error) => {
      logger.debug({ err: error }, 'Redis subscriber connection error');
    });
  }
  return subscriberClient;
}

let hasLoggedConnectionError = false;

redis.on('error', (error: Error) => {
  // ioredis retries forever, so an unreachable Redis would otherwise emit an
  // error every few hundred milliseconds and flood the logs.
  if (!hasLoggedConnectionError) {
    hasLoggedConnectionError = true;
    logger.warn({ err: error }, 'Redis unavailable - queries will bypass the cache');
  }
});

redis.on('ready', () => {
  hasLoggedConnectionError = false;
  logger.info('Redis connected');
});

/** True when Redis is connected and responding. Used by /health. */
export async function pingCache(): Promise<boolean> {
  if (redis.status !== 'ready') return false;
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export function isCacheAvailable(): boolean {
  return env.CACHE_ENABLED && redis.status === 'ready';
}

export async function closeCache(): Promise<void> {
  const clients = subscriberClient ? [redis, subscriberClient] : [redis];

  await Promise.all(
    clients.map(async (client) => {
      try {
        await client.quit();
      } catch {
        // Already disconnected; nothing to clean up.
        client.disconnect();
      }
    }),
  );
  subscriberClient = null;
}
