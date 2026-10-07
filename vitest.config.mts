import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Packages are consumed as TypeScript source (see ARCHITECTURE.md → "Internal
    // packages"), so Vitest can run the whole workspace from one config.
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
