import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/index.ts', 'src/shell.ts'],
      thresholds: { lines: 85, functions: 85, statements: 85, branches: 70 },
    },
  },
});
