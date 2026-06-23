import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { RENDERER_SINGLETON_DEPS } from '../scripts/renderer-singleton-deps.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@rebel/cloud-client': path.resolve(__dirname, '../cloud-client/src'),
      '@rebel/shared': path.resolve(__dirname, '../packages/shared/src'),
    },
    // Mirror vite.config.ts dedupe list so cloud-client (consumed as source
    // via alias) cannot pull a second React/react-dom/zustand from its own
    // node_modules when running under jsdom. See
    // docs-private/investigations/260422_renderer_null_useState_post_dedupe.md.
    dedupe: [...RENDERER_SINGLETON_DEPS],
  },
  test: {
    globals: true,
    // Default to node for cheap pure-TS tests. Tests that need a DOM opt in
    // via `// @vitest-environment jsdom` at the top of the file (e.g.
    // ConversationScreen RTL harness).
    environment: 'node',
    setupFiles: [path.resolve(__dirname, './vitest.setup.ts')],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 120_000,
  },
});
