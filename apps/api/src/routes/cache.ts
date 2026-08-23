/**
 * Cache management endpoints.
 *
 * These exist so the caching layer is observable and controllable rather than
 * an invisible claim. The UI shows the hit rate from `/cache/stats`, and the
 * benchmark harness uses `/cache` (DELETE) to get a genuinely cold cache
 * between configurations.
 */

import { Router } from 'express';
import { z } from 'zod';
import { getCatalog } from '../catalog/service.js';
import { getAllGenerations, invalidateAll, invalidateDataset } from '../cache/generations.js';
import { flushResults, getStats, resetStats } from '../cache/queryCache.js';
import { ApiError } from '../http/errors.js';

export const cacheRouter: Router = Router();

const invalidateSchema = z.strictObject({
  /** Omit to invalidate every dataset in the catalog. */
  dataset: z.string().min(1).max(63).optional(),
  reason: z.string().trim().min(1).max(200).optional(),
});

cacheRouter.get('/cache/stats', async (_req, res) => {
  const [stats, catalog] = await Promise.all([getStats(), getCatalog()]);

  res.json({
    ...stats,
    generations: getAllGenerations(),
    datasets: catalog.datasets.map((dataset) => dataset.name),
  });
});

/**
 * Invalidate cached results.
 *
 * Implemented as an INCR of the dataset's generation, not a scan-and-delete:
 * every key already written folds the old generation into its hash, so a
 * single increment makes all of them unreachable at once. Orphaned entries
 * expire on their own TTL. See cache/generations.ts.
 */
cacheRouter.post('/cache/invalidate', async (req, res) => {
  const { dataset, reason = 'manual invalidation' } = invalidateSchema.parse(req.body ?? {});
  const catalog = await getCatalog();
  const known = catalog.datasets.map((entry) => entry.name);

  if (dataset !== undefined) {
    // Reject an unknown dataset rather than silently incrementing a counter
    // nobody reads - a typo should be visible, not a no-op that looks fine.
    if (!known.includes(dataset)) {
      throw ApiError.badRequest('unknown_dataset', `Unknown dataset "${dataset}"`, {
        available: known,
      });
    }

    const generation = await invalidateDataset(dataset, reason);
    if (generation === null) {
      throw ApiError.serviceUnavailable(
        'cache_unavailable',
        'Redis is unreachable, so there is nothing cached to invalidate.',
      );
    }

    res.json({ invalidated: { [dataset]: generation }, reason });
    return;
  }

  res.json({ invalidated: await invalidateAll(known, reason), reason });
});

/**
 * Delete every cached result outright.
 *
 * Distinct from invalidation: this reclaims the memory immediately instead of
 * leaving unreachable entries to expire. The benchmark needs it, because
 * "cold cache" has to mean cold in Redis, not merely logically unreachable.
 */
cacheRouter.delete('/cache', async (req, res) => {
  const deleted = await flushResults();

  if (req.query.resetStats === '1' || req.query.resetStats === 'true') {
    await resetStats();
  }

  req.log?.info({ deleted }, 'Cache flushed');
  res.json({ deleted });
});
