/**
 * Single source of truth for renderer-bundle singleton dependencies.
 *
 * Both renderer Vite configs (vite.renderer.config.mjs — active, used by
 * electron-forge; and electron.vite.config.ts — legacy) MUST include these
 * in `resolve.dedupe` so that aliased source packages (notably
 * `@rebel/cloud-client` → `cloud-client/src`) cannot pull in a second
 * React/react-dom/zustand via their own `node_modules` tree.
 *
 * Enforced by scripts/check-alias-integrity.ts.
 *
 * See docs-private/investigations/260422_renderer_null_useState_post_dedupe.md
 * for the failure mode and evidence.
 */
export const RENDERER_SINGLETON_DEPS = Object.freeze([
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'zustand',
]);
