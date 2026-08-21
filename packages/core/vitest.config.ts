import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    // The compiler has no I/O, so its tests need no environment beyond Node
    // and no setup file. That is the payoff for keeping the package pure.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
