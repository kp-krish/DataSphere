/**
 * PostgreSQL connection pool.
 *
 * One pool for the whole process. `pg` pools are lazy, so constructing this at
 * import time costs nothing until the first query; what it buys is a single
 * place that owns connection limits, timeouts and shutdown.
 */

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: env.PG_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.PG_CONNECTION_TIMEOUT_MS,
  // Name the connection so `pg_stat_activity` shows who is holding it. Worth
  // its weight the first time you have to work out what is running a slow query.
  application_name: 'datasphere-api',
});

// An idle client can fail out from under us - the database restarts, a proxy
// times it out. `pg` emits this on the pool rather than throwing, and an
// unhandled 'error' event on an EventEmitter terminates the process.
pool.on('error', (error) => {
  logger.error({ err: error }, 'Idle PostgreSQL client errored');
});

/** Thin typed wrapper so call sites do not each import pg's generics. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, values as unknown[]);
}

/**
 * Run `fn` against a dedicated client with a statement timeout applied.
 *
 * Analytical queries are user-composed, and a sufficiently expensive
 * GROUP BY over two million rows can pin a connection indefinitely. The
 * timeout is set with SET LOCAL inside a transaction so it reverts when the
 * transaction ends, rather than leaking onto the next borrower of this pooled
 * connection.
 */
export async function withStatementTimeout<T>(
  timeoutMs: number,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Integer-interpolated, never user input - SET LOCAL does not accept a
    // bind parameter, so the value is coerced to an integer first.
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Rollback can itself fail if the connection died; the original error is
    // the interesting one, so swallow this and let the outer throw stand.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** True when the database answers a trivial query. Used by /health. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'Database ping failed');
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
