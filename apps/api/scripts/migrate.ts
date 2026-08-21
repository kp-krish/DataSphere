/**
 * Migration runner.
 *
 * node-pg-migrate ships a CLI, but it reads its database URL from a mix of
 * flags and ambient env in a way that behaves differently on Windows, in the
 * Docker init container, and in CI. Driving the programmatic `runner()` API
 * from one small script removes that variance: there is exactly one place that
 * decides which database is migrated and where the migration files live.
 *
 * Usage:
 *   tsx scripts/migrate.ts up            # apply all pending migrations
 *   tsx scripts/migrate.ts down          # roll back the most recent migration
 *   tsx scripts/migrate.ts down 3        # roll back the last three
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { runner } from 'node-pg-migrate';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'migrations');

type Direction = 'up' | 'down';

function parseArgs(argv: string[]): { direction: Direction; count: number } {
  const [rawDirection = 'up', rawCount] = argv;

  if (rawDirection !== 'up' && rawDirection !== 'down') {
    throw new Error(`Unknown direction "${rawDirection}". Expected "up" or "down".`);
  }

  // Applying "everything pending" is the sane default going up; going down,
  // rolling back the whole schema by accident is not, so default to one step.
  const defaultCount = rawDirection === 'up' ? Infinity : 1;
  const count = rawCount === undefined ? defaultCount : Number(rawCount);

  if (!Number.isFinite(count) && count !== Infinity) {
    throw new Error(`Invalid count "${rawCount}".`);
  }

  return { direction: rawDirection, count };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env, or export it before running migrations.',
    );
  }

  const { direction, count } = parseArgs(process.argv.slice(2));

  const applied = await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction,
    count,
    migrationsTable: 'pgmigrations',
    // Every migration runs inside one transaction, so a failure half way
    // through leaves the schema exactly as it was.
    singleTransaction: true,
    // Echoing every DDL statement is useful when a migration misbehaves and
    // pure noise the rest of the time. Opt in with MIGRATE_VERBOSE=true.
    verbose: process.env.MIGRATE_VERBOSE === 'true',
  });

  if (applied.length === 0) {
    console.log(`No migrations to run (${direction}). Schema is up to date.`);
  } else {
    console.log(`\nApplied ${applied.length} migration(s) ${direction}:`);
    for (const migration of applied) {
      console.log(`  - ${migration.name}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('\nMigration failed:');
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
