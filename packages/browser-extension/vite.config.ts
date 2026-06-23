/**
 * Vite config for the Rebel browser extension.
 *
 * This is a Stage 6a scaffold: it builds the MV3 shell (manifest, service
 * worker, offscreen document, popup) using @crxjs/vite-plugin. The bundle
 * is not shipped to users yet — we surface it behind a dev flag in
 * Stage 6a and unlock distribution in Stage 9.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6a)
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react-swc';
import manifest from './src/manifest.config';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      '@rebel/shared': resolve(rootDir, '../shared/src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    // @crxjs/vite-plugin only walks entries declared in the manifest.
    // The offscreen document is created at runtime via
    // `chrome.offscreen.createDocument({ url })` — there's no manifest
    // field for it — so rollup never sees `offscreen.html` as an input
    // and the bundle ships without the WS owner, silently killing all
    // bridge connectivity after mint succeeds. Declaring it explicitly
    // as a rollup input forces the HTML + its module graph into `dist/`.
    rollupOptions: {
      input: {
        offscreen: resolve(rootDir, 'src/offscreen/offscreen.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5174,
    },
  },
  test: {
    environment: 'happy-dom',
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      '__tests__/**/*.test.ts',
      '__tests__/**/*.test.tsx',
    ],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
