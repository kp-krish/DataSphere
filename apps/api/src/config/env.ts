/**
 * Environment configuration, validated once at startup.
 *
 * Reading `process.env` at the point of use scatters string parsing and
 * fallback defaults across the codebase, and a typo in a variable name only
 * surfaces when that code path first runs - typically in production. Parsing
 * the whole environment through a schema at boot means the process either
 * starts with a fully valid, typed config or refuses to start at all.
 */

import process from 'node:process';
import { z } from 'zod';

/** Accepts "true"/"false"/"1"/"0", case-insensitively. */
const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const positiveInt = (defaultValue: number, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected an integer between ${min} and ${max}, got "${value}"`,
        });
        return z.NEVER;
      }
      return parsed;
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  API_PORT: positiveInt(4000, { min: 1, max: 65535 }),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PG_POOL_MAX: positiveInt(10, { min: 1, max: 200 }),
  PG_IDLE_TIMEOUT_MS: positiveInt(30_000),
  PG_CONNECTION_TIMEOUT_MS: positiveInt(5_000),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  /**
   * Absolute ceiling on rows returned by any compiled query. A user-supplied
   * LIMIT is clamped to this; it is not a default that can be raised from the
   * client. Guards both the database and the JSON response size.
   */
  QUERY_MAX_ROWS: positiveInt(10_000, { min: 1, max: 1_000_000 }),
  /** Applied as a Postgres statement_timeout on every analytical query. */
  QUERY_TIMEOUT_MS: positiveInt(15_000, { min: 100 }),

  CACHE_ENABLED: booleanish(true),
  CACHE_TTL_SECONDS: positiveInt(300, { min: 1 }),
  CACHE_KEY_PREFIX: z.string().default('ds:q'),

  /** Comma-separated allowlist. `*` disables origin checking (dev only). */
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
});

export type Env = z.infer<typeof envSchema> & {
  isProduction: boolean;
  corsOrigins: string[] | '*';
};

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const value = parsed.data;
  const trimmedCors = value.CORS_ORIGIN.trim();

  return {
    ...value,
    isProduction: value.NODE_ENV === 'production',
    corsOrigins:
      trimmedCors === '*'
        ? '*'
        : trimmedCors
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean),
  };
}

export const env: Env = loadEnv();
