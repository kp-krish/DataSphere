/**
 * Application logger.
 *
 * pino writes structured JSON, which is what a log aggregator wants in
 * production. In development that is unreadable, so we pipe through
 * pino-pretty - but only there, since pretty-printing costs real CPU and the
 * transport is a second thread we do not want in a container.
 */

import pino from 'pino';
import { env } from './config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Redact anything that could carry a credential if a connection error is
  // logged with its config attached.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'connectionString', 'password'],
    censor: '[redacted]',
  },
  ...(env.isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }),
});

export type Logger = typeof logger;
