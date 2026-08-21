/**
 * Express application factory.
 *
 * Exported as a function returning the app rather than a module-level
 * singleton so integration tests can build an isolated instance and hand it
 * straight to Supertest without binding a port.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
// Named export: pino-http is a CommonJS package shipping ESM-syntax types,
// so under NodeNext its default export resolves to the module namespace.
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { healthRouter } from './routes/health.js';

export function createApp(): Express {
  const app = express();

  // Behind nginx in the compose stack, so client IPs arrive in X-Forwarded-For.
  app.set('trust proxy', 1);
  // Advertising the framework and version invites targeted probing.
  app.disable('x-powered-by');

  app.use(helmet());

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

  // Mounted twice, deliberately.
  //
  // At the root for infrastructure: the container HEALTHCHECK and any
  // orchestrator probe hit /health and /ready directly on the API port.
  //
  // Under /api for the browser: nginx only proxies /api/* through to this
  // service, so a page fetching /ready would be served the SPA's index.html
  // by the fallback route instead of JSON.
  app.use(healthRouter);
  app.use('/api', healthRouter);

  // 404 for anything unmatched, in the same JSON shape as real errors so
  // clients only need one error parser.
  app.use((req, res) => {
    res.status(404).json({
      error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
    });
  });

  // Express 5 forwards rejected async handlers here automatically.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    req.log?.error({ err }, 'Unhandled request error');

    if (res.headersSent) return;

    // Never leak an internal message or stack to the client in production; the
    // log above retains the detail for whoever has to debug it.
    res.status(500).json({
      error: {
        code: 'internal_error',
        message: env.isProduction
          ? 'An unexpected error occurred.'
          : err instanceof Error
            ? err.message
            : String(err),
      },
    });
  });

  return app;
}
