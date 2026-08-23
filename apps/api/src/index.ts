/**
 * Server bootstrap: bind the port, and shut down cleanly.
 *
 * Graceful shutdown matters more than it looks. `docker compose down` and any
 * container orchestrator send SIGTERM and then SIGKILL a grace period later.
 * Without a handler the process is killed mid-request, in-flight queries are
 * abandoned, and pooled Postgres connections are left for the server to time
 * out on its own.
 */

import process from 'node:process';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { closePool } from './db/pool.js';
import { closeCache } from './cache/redis.js';
import { getCatalog, warmCatalog } from './catalog/service.js';
import { startInvalidationListener, stopInvalidationListener } from './cache/generations.js';

const app = createApp();

const server = app.listen(env.API_PORT, () => {
  logger.info(
    { port: env.API_PORT, env: env.NODE_ENV, cacheEnabled: env.CACHE_ENABLED },
    'DataSphere API listening',
  );

  // Warm the catalog so the first real request is not the one paying for
  // introspection, then start listening for cache invalidations. Neither is
  // fatal on failure: the catalog retries on demand, and without the listener
  // the periodic resync still converges.
  void warmCatalog()
    .then(() => getCatalog())
    .then((catalog) => startInvalidationListener(catalog.datasets.map((d) => d.name)))
    .catch((error: unknown) => {
      logger.warn({ err: error }, 'Startup warm-up incomplete; continuing');
    });
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  // A second Ctrl-C should not start a second teardown on top of the first.
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Shutting down');

  // Stop accepting new connections, then wait for in-flight requests to finish.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));

  // Bounded, so a hung keep-alive connection cannot block shutdown forever.
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      logger.warn('Shutdown grace period elapsed; closing anyway');
      resolve();
    }, 10_000).unref();
  });

  await Promise.race([closed, timeout]);

  // Stop the resync timer and drop SSE listeners before closing the
  // connections they use.
  stopInvalidationListener();
  await Promise.allSettled([closePool(), closeCache()]);

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// A rejected promise nobody awaited means state is now unknown. Log it loudly
// and let the orchestrator restart us rather than limping on.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});
