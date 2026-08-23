/**
 * Dataset generations - how invalidation works.
 *
 * The naive way to invalidate a query cache is to find and delete the affected
 * keys. That means either SCANning the keyspace on every invalidation, or
 * maintaining a set of keys per table and keeping it in step with expiry. Both
 * are O(keys) and both have a way to go wrong.
 *
 * Instead, each dataset carries a monotonically increasing generation counter,
 * and the generation is part of every cache key. Invalidating a dataset is a
 * single INCR: every key written under the old generation is instantly
 * unreachable, because nothing will ever compute that key again. The orphans
 * are never read and are reclaimed by their TTL, or sooner by Redis's
 * allkeys-lru policy. Invalidation is O(1) regardless of how much is cached.
 *
 * The generation has to be known before a key can be computed, and fetching it
 * from Redis on every query would add a round trip to the hot path. So it is
 * held in process and kept current three ways:
 *
 *   1. read from Redis at startup, and again whenever Redis reconnects
 *   2. pushed over pub/sub the moment any instance invalidates - which is what
 *      makes this correct across more than one API process
 *   3. re-read periodically, as a backstop for a pub/sub message that was
 *      missed while the subscriber was down
 *
 * The worst case if all three fail is bounded: a stale generation serves
 * cached rows until the entry's own TTL expires. That is the same staleness
 * the TTL already permits, so nothing new is risked.
 */

import { EventEmitter } from 'node:events';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { getSubscriber, redis } from './redis.js';

/** Redis key holding a dataset's generation counter. */
const generationKey = (dataset: string): string => `${env.CACHE_KEY_PREFIX}:gen:${dataset}`;

/** Channel every instance publishes invalidations to and listens on. */
const INVALIDATION_CHANNEL = `${env.CACHE_KEY_PREFIX}:invalidate`;

/** Backstop re-read interval, for a pub/sub message missed during an outage. */
const RESYNC_INTERVAL_MS = 30_000;

export interface InvalidationEvent {
  dataset: string;
  generation: number;
  /** Free-text explanation, surfaced in the UI and the SSE stream. */
  reason: string;
  at: string;
}

/**
 * Emits `invalidate` with an InvalidationEvent.
 *
 * The SSE endpoint subscribes to this, which is how a browser learns to
 * refetch without polling. Note the events arrive here from *any* API
 * instance, not just this one, because they come off Redis pub/sub.
 */
export const invalidationEvents = new EventEmitter();

const generations = new Map<string, number>();
let resyncTimer: NodeJS.Timeout | null = null;
let subscribed = false;

/**
 * The generation currently believed for a dataset.
 *
 * Synchronous by design: it sits on the query hot path, and an unknown dataset
 * defaulting to 0 is safe. If it turns out to be behind, the consequence is a
 * cache hit on data at most one TTL old.
 */
export function getGeneration(dataset: string): number {
  return generations.get(dataset) ?? 0;
}

export function getAllGenerations(): Record<string, number> {
  return Object.fromEntries(generations);
}

/**
 * Bump a dataset's generation, making every result cached against it
 * unreachable, and tell every other instance.
 *
 * Returns the new generation, or null when Redis is unavailable - in which
 * case nothing was cached to invalidate either, so the caller has lost
 * nothing.
 */
export async function invalidateDataset(
  dataset: string,
  reason = 'manual invalidation',
): Promise<number | null> {
  if (redis.status !== 'ready') {
    logger.warn({ dataset }, 'Cannot invalidate: Redis is unavailable');
    return null;
  }

  try {
    // INCR is atomic, so two instances invalidating at once cannot land on the
    // same generation and leave one of them reading the other's stale entries.
    const generation = await redis.incr(generationKey(dataset));

    const event: InvalidationEvent = {
      dataset,
      generation,
      reason,
      at: new Date().toISOString(),
    };

    // Apply locally first: this instance must not serve a stale hit in the
    // window before its own subscriber delivers the message back to it.
    applyEvent(event);

    await redis.publish(INVALIDATION_CHANNEL, JSON.stringify(event));

    logger.info({ dataset, generation, reason }, 'Cache invalidated');
    return generation;
  } catch (error) {
    logger.error({ err: error, dataset }, 'Failed to invalidate cache');
    return null;
  }
}

/** Invalidate every dataset the catalog knows about. */
export async function invalidateAll(
  datasets: readonly string[],
  reason = 'manual invalidation',
): Promise<Record<string, number | null>> {
  const results = await Promise.all(
    datasets.map(async (dataset) => [dataset, await invalidateDataset(dataset, reason)] as const),
  );
  return Object.fromEntries(results);
}

/**
 * Record an invalidation and notify listeners, exactly once.
 *
 * The instance that triggers an invalidation applies it locally *and*
 * publishes it, then receives its own message back off the channel. Emitting
 * on both would deliver every invalidation twice to connected browsers, and
 * every widget would refetch twice for one change.
 *
 * Advancing the generation is therefore the thing that gates the event: an
 * event that does not move the counter forward has already been handled, or is
 * an out-of-order message that must not regress it - and in both cases there
 * is nothing new to tell anyone.
 */
function applyEvent(event: InvalidationEvent): void {
  const current = generations.get(event.dataset) ?? 0;
  if (event.generation <= current) return;

  generations.set(event.dataset, event.generation);
  invalidationEvents.emit('invalidate', event);
}

/** Read the current generation for each dataset straight from Redis. */
async function resync(datasets: readonly string[]): Promise<void> {
  if (redis.status !== 'ready' || datasets.length === 0) return;

  try {
    const keys = datasets.map(generationKey);
    const values = await redis.mget(...keys);

    datasets.forEach((dataset, index) => {
      const raw = values[index];
      const value = raw === null || raw === undefined ? 0 : Number(raw);
      if (!Number.isFinite(value)) return;

      // A generation that moved while we were not listening means an
      // invalidation was published during an outage - pub/sub has no replay,
      // so this is the only way that change is ever noticed. Route it through
      // applyEvent so connected clients are told, exactly as they would have
      // been had the message arrived.
      applyEvent({
        dataset,
        generation: value,
        reason: 'detected on resync',
        at: new Date().toISOString(),
      });
    });
  } catch (error) {
    logger.debug({ err: error }, 'Generation resync failed; keeping current values');
  }
}

/**
 * Start listening for invalidations and keep generations current.
 *
 * `datasets` comes from the catalog, so this is called once the catalog is
 * warm. Safe to call more than once.
 */
export async function startInvalidationListener(datasets: readonly string[]): Promise<void> {
  await resync(datasets);

  if (!subscribed) {
    subscribed = true;
    const subscriber = getSubscriber();

    subscriber.on('message', (channel: string, payload: string) => {
      if (channel !== INVALIDATION_CHANNEL) return;
      try {
        applyEvent(JSON.parse(payload) as InvalidationEvent);
      } catch (error) {
        logger.warn({ err: error, payload }, 'Ignoring malformed invalidation message');
      }
    });

    // On reconnect the subscription is restored by ioredis, but messages sent
    // while disconnected are gone - pub/sub has no replay. Re-reading the
    // counters is what closes that hole.
    subscriber.on('ready', () => {
      void resync(datasets);
    });

    try {
      await subscriber.subscribe(INVALIDATION_CHANNEL);
      logger.info({ channel: INVALIDATION_CHANNEL }, 'Listening for cache invalidations');
    } catch (error) {
      subscribed = false;
      logger.warn({ err: error }, 'Could not subscribe to invalidations; will rely on resync');
    }
  }

  if (!resyncTimer) {
    resyncTimer = setInterval(() => void resync(datasets), RESYNC_INTERVAL_MS);
    // Do not hold the process open for a cache backstop.
    resyncTimer.unref();
  }
}

export function stopInvalidationListener(): void {
  if (resyncTimer) {
    clearInterval(resyncTimer);
    resyncTimer = null;
  }
  invalidationEvents.removeAllListeners();
  subscribed = false;
}

/** Test seam. */
export function resetGenerations(): void {
  generations.clear();
}
