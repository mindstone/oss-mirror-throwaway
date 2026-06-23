/**
 * Renderer-side OSS build signal.
 *
 * Reads the compile-time `__REBEL_IS_OSS__` literal injected by the renderer
 * vite configs (`vite.renderer.config.mjs` + the renderer section of
 * `electron.vite.config.ts`). The `typeof` guard makes this safe under vitest
 * and any non-vite build where the define is absent — those contexts fall back
 * to `false` (non-OSS / enterprise), and tests inject OSS behaviour via a
 * different seam (e.g. `PlatformConfig.isOss`) rather than this literal.
 *
 * This is the renderer leg of the cross-surface `isOss` seam introduced in
 * Stage 1 (260607_oss-b6-launch-polish). It is drift-proof-by-construction:
 * the literal is derived from the SAME `existsSync` check the main/forge
 * configs use, with no preload/argv plumbing. Stage 1 ships the seam only; no
 * renderer module consumes it behaviourally yet (Stage 3 does).
 */
export function rendererIsOss(): boolean {
  return typeof __REBEL_IS_OSS__ !== 'undefined' ? __REBEL_IS_OSS__ : false;
}
