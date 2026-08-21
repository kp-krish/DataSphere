import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest 4 replaced vitest.workspace.ts with inline projects.
    projects: ['packages/core', 'apps/api'],
  },
});
