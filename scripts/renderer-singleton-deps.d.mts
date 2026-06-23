/**
 * Type declaration for scripts/renderer-singleton-deps.mjs.
 *
 * The source file is intentionally `.mjs` so that `vite.renderer.config.mjs`
 * can import it as pure ESM without a transpile step. This declaration
 * keeps `electron.vite.config.ts` (which is type-checked in tsconfig.node.json)
 * happy by giving the runtime export a concrete type.
 */
export const RENDERER_SINGLETON_DEPS: readonly [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'zustand',
];

export type RendererSingletonDep = (typeof RENDERER_SINGLETON_DEPS)[number];
