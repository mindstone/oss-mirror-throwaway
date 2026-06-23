/**
 * Unit tests for updateInstallMarker.
 *
 * Covers the marker store accessors only — REBEL-53B deleted the legacy
 * `reconcileUpdateInstallMarkerOnStartup` helper; reconciliation policy
 * now lives exclusively in
 * `installCompletionReconciliation.ts::decideInstallCompletion()`. See
 * `docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md`.
 *
 * Covers:
 * - `markUpdateInstallRequested` / `getUpdateInstallMarker` /
 *   `clearUpdateInstallMarker` round-trip behavior
 * - back-compat with OLD markers that don't carry `targetVersion` / `updateKey`
 * - corrupt-JSON guard returns `null` instead of crashing
 *
 * Mocking strategy: tests rely on the global `@core/logger` mock from
 * `vitest.setup.ts` (silent noop logger) and the global TestMemoryStore-backed
 * `setStoreFactory` from the same setup. The corrupt-JSON test installs a
 * test-local throwing store factory via `setStoreFactory()` to simulate the
 * `electron-store`/`conf` parse-failure surface.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

async function loadModule() {
  vi.resetModules();
  await initTestPlatformConfig();
  return await import('../updateInstallMarker');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getUpdateInstallMarker', () => {
  it('returns null when no marker is set (no file)', async () => {
    const mod = await loadModule();
    expect(mod.getUpdateInstallMarker()).toBeNull();
  });

  it('returns null and does not throw when the underlying store throws (corrupt JSON guard)', async () => {
    // Inject a store factory that throws on .get() to simulate `electron-store`
    // / `conf` parse failure on a malformed JSON file. The fact that the call
    // doesn't propagate is the contract — module-load reconciliation in
    // main/index.ts must NOT crash on a corrupt marker.
    vi.resetModules();
    await initTestPlatformConfig();

    const { setStoreFactory } = await import('@core/storeFactory');
    setStoreFactory(() => ({
      get: () => {
        throw new SyntaxError('Unexpected token } in JSON at position 7');
      },
      set: () => {},
      has: () => false,
      delete: () => {},
      clear: () => {},
      get store() { return {}; },
      set store(_v) {},
      path: '/tmp/test-stores/update-install-marker.json',
      onDidChange: () => () => {},
      onDidAnyChange: () => () => {},
      reload: () => {},
       
    }) as never);

    const mod = await import('../updateInstallMarker');
    expect(() => mod.getUpdateInstallMarker()).not.toThrow();
    expect(mod.getUpdateInstallMarker()).toBeNull();
  });

  it('round-trips the new optional fields through markUpdate / getUpdate', async () => {
    const mod = await loadModule();
    mod.markUpdateInstallRequested({
      updateKey: 'beta:win32:x64:2.0.0',
      fromVersion: '1.9.0',
      targetVersion: '2.0.0',
      requestedAt: 42,
    });
    const marker = mod.getUpdateInstallMarker();
    expect(marker).toEqual({
      updateKey: 'beta:win32:x64:2.0.0',
      fromVersion: '1.9.0',
      targetVersion: '2.0.0',
      requestedAt: 42,
    });
  });

  it('clearUpdateInstallMarker removes the persisted marker', async () => {
    const mod = await loadModule();
    mod.markUpdateInstallRequested({
      updateKey: 'beta:darwin:arm64:1.0.0',
      fromVersion: '0.9.0',
      targetVersion: '1.0.0',
      requestedAt: 1,
    });
    expect(mod.getUpdateInstallMarker()).not.toBeNull();
    mod.clearUpdateInstallMarker();
    expect(mod.getUpdateInstallMarker()).toBeNull();
  });
});
