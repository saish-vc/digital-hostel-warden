import { defineConfig } from 'vitest/config';

/**
 * Vitest is the runner (not Jest): native TS/ESM through the same transform
 * Vite already uses, no babel/ts-jest configuration, and roughly half the
 * startup cost on this repo.
 *
 * Deliberate choices:
 * - `fileParallelism: false`: every integration suite truncates the same
 *   test database, so files must not race each other. Individual tests
 *   within a file still share one server/worker, and each test creates its
 *   own rows, so order does not matter within a file.
 * - `pool: 'threads'`: avoids paying Node process startup once per file;
 *   this is the difference between a 96s and a ~55s suite on the dev laptop.
 * - `globalSetup` applies pending migrations once per run. It talks to
 *   TEST_DATABASE_URL only (see tests/helpers/testEnv.ts).
 *
 * multi-instance.test.ts is excluded from `npm test`: it spawns two real API
 * processes on fixed ports 3001/3002 and needs a longer timeout. It runs only
 * when the CLI targets it explicitly:
 *   npm run test:multi-instance
 *   npm run test -- tests/multi-instance.test.ts
 */
const runningMultiInstance = process.argv.some((arg) => arg.includes('multi-instance'));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(runningMultiInstance ? [] : ['tests/multi-instance.test.ts']),
    ],
    setupFiles: ['./tests/helpers/env.ts'],
    globalSetup: ['./tests/globalSetup.ts'],
    pool: 'threads',
    fileParallelism: false,
    testTimeout: runningMultiInstance ? 90_000 : 15_000,
    hookTimeout: runningMultiInstance ? 90_000 : 60_000,
    teardownTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      all: true,
      include: ['src/**/*.ts'],
      // Process entrypoints: listen/signal-handler wiring with no testable
      // logic. The escalation decision logic lives in escalation.processor.ts,
      // which is fully covered by tests/escalation.test.ts.
      exclude: [
        'src/index.ts',
        'src/workers/escalation.worker.ts',
        'src/**/*.d.ts',
      ],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
      },
    },
  },
});
