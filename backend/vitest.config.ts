import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // tests/** is the primary suite; src/**/__tests__ holds the
    // colocated mock-based unit tests (OCI routes, bundles routes,
    // audit/scheduler services) — both run.
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      // Redirect src/db/index.ts to our test proxy in tests
      [path.resolve(__dirname, 'src/db/index.ts')]: path.resolve(__dirname, 'tests/fixtures/db-proxy.ts'),
    },
  },
});
