import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
    // Every api/indexer file boots its own PGlite (Postgres in WASM). With one
    // worker per core on a laptop the timing-sensitive indexer suites
    // (durability, operability, replay) start flaking under memory pressure;
    // four workers keeps the full run green without a noticeable slowdown.
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      // The Phase 0.B review gate: every listed pure function is covered.
      include: ['packages/shared/src/**/*.ts'],
      exclude: ['packages/shared/src/types.ts', 'packages/shared/src/index.ts'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
