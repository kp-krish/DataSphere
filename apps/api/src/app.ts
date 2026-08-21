/**
 * Express application factory.
 *
 * Exported as a function returning the app rather than a module-level
 * singleton so integration tests can build an isolated instance and hand it
 * straight to Supertest without binding a port.
 */

import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
// Named export: pino-http is a CommonJS package shipping ESM-syntax types,
// so under NodeNext its default export resolves to the module namespace.
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { healthRouter } from './routes/health.js';
import { catalogRouter } from './routes/catalog.js';
import { queryRouter } from './routes/query.js';
import { dashboardsRouter, widgetsRouter } from './routes/dashboards.js';

export function createApp(): Express {
  const app = express();

  // Behind nginx in the compose stack, so client IPs arrive in X-Forwarded-For.
  app.set('trust proxy', 1);
  // Advertising the framework and version invites targeted probing.
  app.disable('x-powered-by');

  // This service returns JSON and never a document, so the headers that earn
  // their keep are the sniffing and framing ones. CSP is disabled here and set
  // by the web container, which is what actually serves HTML.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.use(
    cors({
      origin: env.corsOrigins === '*' ? true : env.corsOrigins,
      credentials: false,
    }),
  );

  // Query specs are nested JSON but bounded; 256kb is generous for a spec and
  // small enough that an oversized body is rejected before it costs anything.
  app.use(express.json({ limit: '256kb' }));

  app.use(
    pinoHttp({
      logger,
      // Health checks fire every ten seconds per container and would otherwise
      // drown out anything worth reading.
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/ready',
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  /* ---- routes ------------------------------------------------------------ */

  // Health is mounted twice, deliberately.
  //
  // At the root for infrastructure: the container HEALTHCHECK and any
  // orchestrator probe hit /health and /ready directly on the API port.
  //
  // Under /api for the browser: nginx only proxies /api/* through to this
  // service, so a page fetching /ready would be served the SPA's index.html
  // by the fallback route instead of JSON.
  app.use(healthRouter);
  app.use('/api', healthRouter);

  app.use('/api', catalogRouter);
  app.use('/api', queryRouter);
  app.use('/api', dashboardsRouter);
  app.use('/api', widgetsRouter);

  /* ---- fallbacks --------------------------------------------------------- */

  // 404 for anything unmatched, in the same JSON envelope as real errors so
  // clients only need one error parser.
  app.use(notFoundHandler);

  // Express 5 forwards rejected async handlers here automatically, so route
  // code needs no try/catch wrapper. Must be registered last.
  app.use(errorHandler);

  return app;
}
