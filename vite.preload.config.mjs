import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { createLegacySentryPlugin, resolveSourcemapUpload } from './scripts/vite-sentry-plugin.mjs';
import { visualizer } from 'rollup-plugin-visualizer';

const enableSourcemapUpload = resolveSourcemapUpload();

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@rebel/shared': resolve(__dirname, 'packages/shared/src'),
    },
  },
  build: {
    sourcemap: enableSourcemapUpload,
    rollupOptions: {
      output: {
        entryFileNames: 'preload.js',
      },
    },
  },
  plugins: [
    // Main and preload builds share `.vite/build` and can run concurrently in Forge.
    // Delete only this entrypoint's sourcemap to avoid cross-build races.
    createLegacySentryPlugin(__dirname, ['.vite/build/preload.js.map']),
    ...(process.env.ANALYZE === '1'
      ? [
          visualizer({
            filename: 'stats-preload.html',
            template: 'treemap',
            gzipSize: true,
          }),
        ]
      : []),
  ],
});
