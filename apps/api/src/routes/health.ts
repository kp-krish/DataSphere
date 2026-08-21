/**
 * Health endpoints.
 *
 * Two of them, because they answer different questions:
 *
 *   /health  - liveness. "Is this process running?" Never touches a
 *              dependency, so a database blip cannot cause an orchestrator to
 *              kill an otherwise healthy container.
 *   /ready   - readiness. "Can this process actually serve traffic?" Checks
 *              Postgres and Redis and reports 503 when it cannot.
 *
 * docker-compose's healthcheck uses /health so the API is considered up as
 * soon as it can answer; /ready is what a load balancer would gate on.
 */

import { Router } from 'express';
import { pingDatabase } from '../db/pool.js';
import { pingCache } from '../cache/redis.js';
import { env } from '../config/env.js';

export const healthRouter: Router = Router();

const startedAt = Date.now();

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'datasphere-api',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
});

healthRouter.get('/ready', async (_req, res) => {
  const [database, cache] = await Promise.all([pingDatabase(), pingCache()]);

  // Redis being down is a degradation, not an outage: queries still run, they
  // just miss the cache every time. Postgres being down means we cannot serve
  // anything, so only that flips readiness to false.
  const ready = database;

  res.status(ready ? 200 : 503).json({
    status: ready ? (cache ? 'ok' : 'degraded') : 'unavailable',
    checks: {
      database: database ? 'up' : 'down',
      cache: cache ? 'up' : env.CACHE_ENABLED ? 'down' : 'disabled',
    },
  });
});
