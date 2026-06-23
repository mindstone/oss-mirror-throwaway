import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { RENDERER_SINGLETON_DEPS } from '../scripts/renderer-singleton-deps.mjs';

export default defineConfig({
  plugins: [react()],
  base: '/app/',
  resolve: {
    alias: {
      '@rebel/cloud-client': path.resolve(__dirname, '../cloud-client/src'),
      '@rebel/shared': path.resolve(__dirname, '../packages/shared/src'),
      '@core': path.resolve(__dirname, '../src/core'),
      '@shared': path.resolve(__dirname, '../src/shared'),
    },
    dedupe: [...RENDERER_SINGLETON_DEPS, 'zod'],
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
