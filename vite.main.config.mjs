import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createLegacySentryPlugin, resolveSourcemapUpload } from './scripts/vite-sentry-plugin.mjs';
import { visualizer } from 'rollup-plugin-visualizer';

const enableSourcemapUpload = resolveSourcemapUpload();
const privateMindstoneBootstrapPath = resolve(__dirname, 'private/mindstone/src/bootstrap.ts');
const privateMindstoneAliasTarget = existsSync(privateMindstoneBootstrapPath)
  ? resolve(__dirname, 'private/mindstone/src')
  : resolve(__dirname, 'src/main/oss/private-mindstone-stub');

// https://vitejs.dev/config
export default defineConfig({
  envPrefix: ['VITE_', 'MAIN_VITE_'],
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@private/mindstone': privateMindstoneAliasTarget,
      '@rebel/shared': resolve(__dirname, 'packages/shared/src'),
      '@rebel/cloud-client/cloudClient': resolve(__dirname, 'cloud-client/src/cloudClient.ts'),
      // linkedom has an optional peer dep on 'canvas' (native, not installed).
      // Vite hoists the require('canvas') and generates a top-level throw.
      // Alias to linkedom's built-in canvas-shim (no-op stub).
      'canvas': resolve(__dirname, 'node_modules/linkedom/commonjs/canvas-shim.cjs'),
    },
  },
  build: {
    sourcemap: enableSourcemapUpload,
    rollupOptions: {
      external: [
        'electron',
        'fsevents', // Native macOS file watcher - can't be bundled
        '@lancedb/lancedb', // Native vector database - has native bindings
        '@huggingface/transformers', // ML library with ONNX runtime - has native bindings
        'onnxruntime-node', // ONNX runtime native bindings
        '@stoprocent/noble', // BLE library for Limitless Pendant - has native bindings
        'win-ca', // Windows cert store - ships roots.exe binary that must be on disk
        // Keep pino and thread-stream bundled in the main chunk. pino is statically imported
        // before bootstrap.ts installs packaged-build NODE_PATH, and bundled pino statically
        // walks pino -> lib/tools -> lib/transport -> require('thread-stream') at module init.
        // Externalizing either package would therefore run require() before
        // app.asar.unpacked/node_modules is on Node's lookup path. Only pino-roll is safe to
        // externalize: it is resolved dynamically by pino's fixTarget() via
        // globalThis.__bundlerPathsOverrides after setupRotatingTransport() calls
        // ensureWorkerOverrides(), by which point bootstrap.ts has completed.
        // forge.config.cjs still unpacks all three packages so worker-thread targets can be
        // loaded from disk: pino/lib/worker.js, thread-stream/lib/worker.js, and pino-roll.
        'pino-roll',
        'canvas', // Avoid build-time resolution of linkedom's optional canvas peer
        // graceful-fs is intentionally NOT external — it must be bundled so the
        // main process (inside app.asar) can resolve it. The queue is shared via
        // Symbol.for('graceful-fs.queue') on the global fs module regardless.
        // External copies in app.asar.unpacked/node_modules/ remain for MCP
        // servers, super-mcp, and other out-of-asar consumers.
        // See docs/plans/260428_graceful_fs_emfile_fix.md, REBEL-536/REBEL-537.
      ],
    },
  },
  plugins: [
    // Main and preload builds share `.vite/build` and can run concurrently in Forge.
    // Delete only this entrypoint's sourcemap to avoid cross-build races.
    createLegacySentryPlugin(__dirname, ['.vite/build/bootstrap.js.map']),
    ...(process.env.ANALYZE === '1'
      ? [
          visualizer({
            filename: 'stats-main.html',
            template: 'treemap',
            gzipSize: true,
          }),
        ]
      : []),
  ],
});
