import { defineConfig } from 'vitest/config';

/**
 * Manual integration tests that call a real model runtime. Never run by
 * `npm test` or `npm run verify`; use `npm run ai:live`.
 */
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.live.ts'],
    environment: 'node',
    testTimeout: 180_000,
    disableConsoleIntercept: true,
  },
});
