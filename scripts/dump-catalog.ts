/**
 * Regenerate the compiler's test fixture from the live database.
 *
 *   npm run dump:catalog
 *
 * The compiler's unit tests need a catalog to compile against, and a
 * hand-written one is a liability: it drifts from the migrations, and once it
 * has drifted the tests are asserting against a schema that does not exist.
 *
 * So the fixture is generated. Running this against a migrated database writes
 * `packages/core/src/__fixtures__/catalog.ts`, which the tests then import as
 * plain typed data - no database needed at test time, but no invented schema
 * either. Re-run it after any migration that changes the analytics schema; CI
 * checks the committed file is up to date.
 */

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { introspectCatalog, type SqlRunner } from '@datasphere/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.resolve(HERE, '..', 'packages', 'core', 'src', '__fixtures__', 'catalog.ts');

const BANNER = `/**
 * GENERATED FILE - do not edit by hand.
 *
 * Produced by \`npm run dump:catalog\`, which introspects a migrated database
 * and serialises the result. Regenerate it after any migration that changes
 * the analytics schema.
 *
 * Committing the generated catalog is what lets the compiler's tests run with
 * no database while still compiling against the real schema rather than an
 * invented one.
 */

import type { Catalog } from '../types.js';

export const FIXTURE_CATALOG: Catalog = `;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const run: SqlRunner = async (text, values) => {
      const result = await client.query(text, values as unknown[]);
      return result.rows;
    };

    const catalog = await introspectCatalog(run, { schema: process.env.ANALYTICS_SCHEMA });

    // reltuples drifts with every VACUUM, which would make the fixture show up
    // as modified on unrelated runs. The compiler never reads it, so pin it.
    const stable = {
      ...catalog,
      generatedAt: '1970-01-01T00:00:00.000Z',
      tables: catalog.tables.map((table) => ({ ...table, rowEstimate: 0 })),
    };

    await writeFile(OUTPUT, `${BANNER}${JSON.stringify(stable, null, 2)};\n`, 'utf8');

    console.log(`Wrote ${OUTPUT}`);
    console.log(
      `  ${stable.datasets.length} dataset(s), ${stable.tables.length} tables, ` +
        `${stable.tables.reduce((sum, table) => sum + table.columns.length, 0)} columns`,
    );
    for (const dataset of stable.datasets) {
      console.log(
        `  - ${dataset.name}: ${dataset.factTable} + ${dataset.joins
          .map((join) => join.table)
          .join(', ')}`,
      );
    }
  } finally {
    await client.end();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('Catalog dump failed:');
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
