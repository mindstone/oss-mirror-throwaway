/**
 * Bottom-of-graph registry that breaks the circular import between
 * `ipc/plugins/shared.ts` and `services/pluginSpaceService.ts`.
 *
 * Both sides used dynamic imports (`await import('...')`) of each other —
 * shared.ts pulled `scanSpacePlugins` from pluginSpaceService, and
 * pluginSpaceService pulled `invalidatePluginIdentityCache` and
 * `invalidatePermissionCache` from shared.ts. Madge still flags dynamic
 * imports as cycles.
 *
 * Each owning module registers its function at module-load time; the other
 * side imports through this registry only.
 *
 * Pre-registration calls are safe no-ops (logs a warning rather than throws)
 * — invalidations during early boot are best-effort by design.
 */

import { createScopedLogger } from '@core/logger';
import type { PluginConflict, SpacePluginInfo } from '@shared/ipc/schemas/plugins';

const log = createScopedLogger({ service: 'pluginIdentityRegistry' });

type InvalidatePluginIdentityCacheFn = (reason?: string) => void;
type InvalidatePermissionCacheFn = () => void;
type ScanSpacePluginsResult = { plugins: SpacePluginInfo[]; conflicts: PluginConflict[] };
type ScanSpacePluginsFn = (options?: { includeArchived?: boolean }) => Promise<ScanSpacePluginsResult>;

let invalidatePluginIdentityCacheFn: InvalidatePluginIdentityCacheFn | null = null;
let invalidatePermissionCacheFn: InvalidatePermissionCacheFn | null = null;
let scanSpacePluginsFn: ScanSpacePluginsFn | null = null;

export function registerInvalidatePluginIdentityCache(fn: InvalidatePluginIdentityCacheFn): void {
  invalidatePluginIdentityCacheFn = fn;
}

export function invalidatePluginIdentityCache(reason?: string): void {
  if (invalidatePluginIdentityCacheFn) {
    invalidatePluginIdentityCacheFn(reason);
    return;
  }
  log.warn({ reason }, 'invalidatePluginIdentityCache called before handler registered (no-op)');
}

export function registerInvalidatePermissionCache(fn: InvalidatePermissionCacheFn): void {
  invalidatePermissionCacheFn = fn;
}

export function invalidatePermissionCache(): void {
  if (invalidatePermissionCacheFn) {
    invalidatePermissionCacheFn();
    return;
  }
  log.warn({}, 'invalidatePermissionCache called before handler registered (no-op)');
}

export function registerScanSpacePlugins(fn: ScanSpacePluginsFn): void {
  scanSpacePluginsFn = fn;
}

export async function scanSpacePlugins(
  options?: { includeArchived?: boolean },
): Promise<ScanSpacePluginsResult> {
  if (scanSpacePluginsFn) {
    return scanSpacePluginsFn(options);
  }
  // Pre-registration: empty result means "no known plugins yet" — callers
  // that hit this during boot will get a fresh result once pluginSpaceService
  // finishes loading and registers.
  log.warn({}, 'scanSpacePlugins called before handler registered; returning empty result');
  return { plugins: [], conflicts: [] };
}

/**
 * Test-only: reset all registered handlers so a fresh test pass starts clean.
 */
export function _resetPluginIdentityRegistryForTesting(): void {
  invalidatePluginIdentityCacheFn = null;
  invalidatePermissionCacheFn = null;
  scanSpacePluginsFn = null;
}
