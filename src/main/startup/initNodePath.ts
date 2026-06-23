/* eslint-disable no-console -- bootstrap shim runs before the structured logger (pino) is initialised; same constraint as applyThreadpoolSize/installGracefulFs */
/**
 * Desktop boot-time NODE_PATH shim for unpacked native modules.
 *
 * MUST be imported very early in `bootstrap.ts` — after `applyThreadpoolSize`
 * (the libuv pool buffer, which must be first) and `installGracefulFs` (the
 * first fs touch), but BEFORE any import that transitively pulls chokidar.
 *
 * Why so early: native modules (fsevents, etc.) are copied to
 * `app.asar.unpacked/node_modules` by forge.config.cjs, but aren't discoverable
 * by default because electron-vite bundles all code into the asar without a
 * `node_modules/` — `require()` has no parent node_modules to walk up from. This
 * shim prepends the unpacked dir to `NODE_PATH` and re-initialises Node's global
 * module paths so subsequent `require()` calls can resolve unpacked natives.
 *
 * The load-order constraint is load-bearing: chokidar is BUNDLED into the main
 * asar while `fsevents` is externalized. chokidar's `fsevents-handler.js` runs
 * an eager `require('fsevents')` during the rollup module-hoist phase. If this
 * shim ran later (e.g. as a top-level statement after the import block), the
 * hoisted chokidar require would fire with `NODE_PATH=undefined`, throw
 * `Cannot find module 'fsevents'`, and chokidar would permanently memoize
 * `fsevents=undefined` → fall back off the native fsevents backend (degraded /
 * CPU-heavy `fs.watchFile` polling on macOS) AND disarm the quit-time fsevents
 * leak guard (it then tracks 0 native instances). Running this as the head of
 * the hoist phase — via an early side-effect import — guarantees the shim
 * executes before any hoisted `require('fsevents')`. See
 * docs/plans/260623_fsevents-interception-regression/PLAN.md and
 * docs/plans/260611_fsevents-shutdown-crash/PLAN.md.
 *
 * This module ONLY needs `node:path` + `node:module`; it must NOT transitively
 * import chokidar (or anything that does), or it would defeat its own purpose.
 */

/**
 * Prepend `app.asar.unpacked/node_modules` to `NODE_PATH` and re-initialise
 * Node's global module paths. No-op in dev / non-packaged (no
 * `process.resourcesPath`). Never throws — a failure here must not break boot.
 *
 * Returns a human-readable outcome so the caller can log it (mirroring
 * `applyThreadpoolSizeAtBoot`). A failure returns a non-fatal descriptive string
 * rather than swallowing silently — the throw is absorbed (boot must not break)
 * but the cause is surfaced to the caller's `console` line.
 */
export function initNodePathAtBoot(): string {
  try {
    const nodePath = require('node:path') as typeof import('node:path');
    if (!process.resourcesPath) {
      return 'NODE_PATH shim skipped (no process.resourcesPath — dev / non-packaged)';
    }
    const unpackedModules = nodePath.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
    // Add to NODE_PATH so all require() calls can find unpacked native modules
    process.env.NODE_PATH = process.env.NODE_PATH
      ? `${unpackedModules}${nodePath.delimiter}${process.env.NODE_PATH}`
      : unpackedModules;
    // Force Module to re-initialize global paths from updated NODE_PATH
    const nodeModule = require('node:module') as typeof import('node:module');
    (nodeModule.Module as typeof nodeModule.Module & { _initPaths: () => void })._initPaths();
    return `NODE_PATH shim applied (prepended ${unpackedModules})`;
  } catch (error) {
    // Defensive: NODE_PATH setup must never break boot. Return the cause so the
    // caller logs it (non-fatal) rather than swallowing it silently.
    return `NODE_PATH shim skipped (non-fatal): ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Side-effect on import: applied immediately so it precedes any hoisted
// `require('fsevents')` (chokidar's bundled fsevents-handler). The single
// console line is intentional (pre-logger boot; same constraint as
// applyThreadpoolSize/installGracefulFs).
const initNodePathOutcome = initNodePathAtBoot();
console.log(`[bootstrap] ${initNodePathOutcome}`);
