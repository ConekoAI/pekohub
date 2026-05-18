import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
