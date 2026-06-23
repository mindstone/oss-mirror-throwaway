import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: {
      '@rebel/shared': path.resolve(__dirname, '../packages/shared/src'),
      '@shared': path.resolve(__dirname, '../src/shared'),
      '@core': path.resolve(__dirname, '../src/core'),
    },
  },
});
