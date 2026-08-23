import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests need DATABASE_URL. Load the repo-root .env the same way
// the dev scripts do, so `npx vitest` behaves identically to `npm test`.
// Any value already in the environment wins, which is how CI overrides it.
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'));
} catch {
  // No .env checked out - fine. Integration tests skip themselves, and CI
  // supplies DATABASE_URL directly.
}

// pino writes a full request/response object per call at info level, which
// buries test failures in thousands of lines. Tests that care about logging
// can still opt in by exporting LOG_LEVEL before running.
process.env.LOG_LEVEL = process.env.VITEST_LOG_LEVEL ?? 'silent';

export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Integration tests share one Postgres database; running files in
    // parallel would have them stepping on each other's fixtures.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
