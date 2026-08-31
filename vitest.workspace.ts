import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'integration',
      include: ['packages/*/src/**/*.integration.test.ts', 'apps/*/src/**/*.integration.test.ts'],
      exclude: ['**/node_modules/**'],
      environment: 'node',
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  },
]);
