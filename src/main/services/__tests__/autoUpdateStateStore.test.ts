/**
 * Unit tests for autoUpdateStateStore.
 *
 * Covers:
 * - Schema additions: `stuckInstall` (legacy/back-compat),
 *   `watchdogInstallFailedBundleVersionUnchanged`, `watchdogOnDiskVersion`,
 *   `watchdogExternalForceKillSignal`, `watchdogExternalForceKillGuardOutcome`,
 *   `pendingStuckInstallEvents` (legacy), `recoveryAttempts` (REBEL-53B).
 * - Runtime normalization for OLD state files (no new fields → defaults, not undefined).
 * - `updateAutoUpdateStateChecked` returns `{ ok: false, error }` on `set()` throw.
 * - Corrupt JSON guard on `getAutoUpdateState()` returns defaults instead of throwing.
 *
 * Mocking strategy: tests rely on the global `@core/logger` mock from
 * `vitest.setup.ts` (silent noop logger) plus a test-local override of
 * `setStoreFactory()` for the throwing-store and OLD-state-shape cases.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

async function loadModule() {
  vi.resetModules();
  await initTestPlatformConfig();
  return await import('../autoUpdateStateStore');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getAutoUpdateState — runtime normalization', () => {
  it('returns all-default state when nothing has been written', async () => {
    const mod = await loadModule();
    const state = mod.getAutoUpdateState();

    // Pre-existing fields default to null.
    expect(state.lastCheckAt).toBeNull();
    expect(state.lastCheckResult).toBeNull();
    expect(state.watchdogOpenFired).toBeNull();
    // Schema additions:
    expect(state.stuckInstall).toBeNull();
    expect(state.watchdogInstallFailedBundleVersionUnchanged).toBeNull();
    expect(state.watchdogOnDiskVersion).toBeNull();
    expect(state.watchdogExternalForceKillSignal).toBeNull();
    expect(state.watchdogExternalForceKillGuardOutcome).toBeNull();
    expect(state.pendingStuckInstallEvents).toEqual([]);
    expect(state.recoveryAttempts).toEqual({});
  });

  it('normalizes an OLD state file (no Stage 1 fields) into the new shape', async () => {
    // Simulate a state file written by a pre-Stage-1 app version: the underlying
    // store contains only the old keys, with no `stuckInstall` /
    // `pendingStuckInstallEvents` / etc. Without runtime normalization the
    // returned object would have `undefined` for those fields and Stage 5/6
    // consumers would have to branch `null`-vs-`undefined` everywhere.
    vi.resetModules();
    await initTestPlatformConfig();

    const oldStored = {
      lastCheckAt: 1_700_000_000_000,
      lastCheckResult: 'available' as const,
      lastCheckUrl: 'https://example.test/updates',
      lastErrorAt: null,
      lastErrorMessage: null,
      lastDownloadedVersion: '1.2.0',
      lastDownloadedAt: 1_700_000_000_500,
      initSucceeded: true,
      appVersionAtLastEvent: '1.1.0',
      watchdogLastRanAt: null,
      watchdogOldPidWaitSec: null,
      watchdogShipItWaitSec: null,
      watchdogAppAlreadyRunning: null,
      watchdogOpenFired: null,
    };

    const { setStoreFactory } = await import('@core/storeFactory');
    setStoreFactory(() => ({
      get: (key: string) => (oldStored as Record<string, unknown>)[key],
      set: () => {},
      has: (key: string) => key in oldStored,
      delete: () => {},
      clear: () => {},
      get store() { return oldStored as never; },
      set store(_v) {},
      path: '/tmp/test-stores/auto-update-state.json',
      onDidChange: () => () => {},
      onDidAnyChange: () => () => {},
      reload: () => {},
       
    }) as never);

    const mod = await import('../autoUpdateStateStore');
    const state = mod.getAutoUpdateState();

    // Existing fields preserved.
    expect(state.lastCheckAt).toBe(1_700_000_000_000);
    expect(state.lastDownloadedVersion).toBe('1.2.0');
    // Schema additions normalized to defaults (NOT undefined).
    expect(state.stuckInstall).toBeNull();
    expect(state.watchdogInstallFailedBundleVersionUnchanged).toBeNull();
    expect(state.watchdogOnDiskVersion).toBeNull();
    expect(state.watchdogExternalForceKillSignal).toBeNull();
    expect(state.watchdogExternalForceKillGuardOutcome).toBeNull();
    expect(state.pendingStuckInstallEvents).toEqual([]);
    expect(state.recoveryAttempts).toEqual({});
  });

  it('returns defaults instead of throwing when the underlying store throws (corrupt JSON)', async () => {
    vi.resetModules();
    await initTestPlatformConfig();

    const { setStoreFactory } = await import('@core/storeFactory');
    setStoreFactory(() => ({
      get() { throw new SyntaxError('parse failure'); },
      set: () => {},
      has: () => false,
      delete: () => {},
      clear: () => {},
      get store(): never { throw new SyntaxError('parse failure'); },
      set store(_v) {},
      path: '/tmp/test-stores/auto-update-state.json',
      onDidChange: () => () => {},
      onDidAnyChange: () => () => {},
      reload: () => {},
       
    }) as never);

    const mod = await import('../autoUpdateStateStore');
    expect(() => mod.getAutoUpdateState()).not.toThrow();
    const state = mod.getAutoUpdateState();
    expect(state.stuckInstall).toBeNull();
    expect(state.pendingStuckInstallEvents).toEqual([]);
    expect(state.recoveryAttempts).toEqual({});
    expect(state.lastCheckAt).toBeNull();
  });
});

describe('recoveryAttempts (REBEL-53B silent auto-heal counter)', () => {
  it('persists and round-trips a per-updateKey counter', async () => {
    const mod = await loadModule();
    mod.updateAutoUpdateState({
      recoveryAttempts: { 'beta:darwin:arm64:0.4.34': 1 },
    });
    const state = mod.getAutoUpdateState();
    expect(state.recoveryAttempts).toEqual({ 'beta:darwin:arm64:0.4.34': 1 });
  });
});

describe('updateAutoUpdateState — silent variant', () => {
  it('persists partial updates and round-trips through getAutoUpdateState', async () => {
    const mod = await loadModule();
    mod.updateAutoUpdateState({
      stuckInstall: {
        updateKey: 'beta:darwin:arm64:0.4.34',
        fromVersion: '0.4.33',
        targetVersion: '0.4.34',
        attemptedAt: 1_700_000_000_000,
        platform: 'darwin',
        attemptCount: 1,
        lastFailedAt: 1_700_000_000_500,
      },
      watchdogInstallFailedBundleVersionUnchanged: true,
      watchdogOnDiskVersion: '0.4.33',
      watchdogExternalForceKillSignal: 'KILL',
      watchdogExternalForceKillGuardOutcome: 'identityMatched',
    });

    const state = mod.getAutoUpdateState();
    expect(state.stuckInstall?.updateKey).toBe('beta:darwin:arm64:0.4.34');
    expect(state.stuckInstall?.attemptCount).toBe(1);
    expect(state.watchdogInstallFailedBundleVersionUnchanged).toBe(true);
    expect(state.watchdogOnDiskVersion).toBe('0.4.33');
    expect(state.watchdogExternalForceKillSignal).toBe('KILL');
    expect(state.watchdogExternalForceKillGuardOutcome).toBe('identityMatched');
  });

  it('swallows errors when the store set() throws (back-compat with existing callers)', async () => {
    vi.resetModules();
    await initTestPlatformConfig();

    const { setStoreFactory } = await import('@core/storeFactory');
    setStoreFactory(() => ({
      get: () => undefined,
      set: () => { throw new Error('disk full'); },
      has: () => false,
      delete: () => {},
      clear: () => {},
      get store() { return {}; },
      set store(_v) {},
      path: '/tmp/test-stores/auto-update-state.json',
      onDidChange: () => () => {},
      onDidAnyChange: () => () => {},
      reload: () => {},
       
    }) as never);

    const mod = await import('../autoUpdateStateStore');
    expect(() => mod.updateAutoUpdateState({ stuckInstall: null })).not.toThrow();
  });
});

describe('updateAutoUpdateStateChecked — observable variant', () => {
  it('returns { ok: true } on successful write', async () => {
    const mod = await loadModule();
    const result = mod.updateAutoUpdateStateChecked({
      watchdogOnDiskVersion: '0.4.34',
    });
    expect(result).toEqual({ ok: true });
    expect(mod.getAutoUpdateState().watchdogOnDiskVersion).toBe('0.4.34');
  });

  it('returns { ok: false, error } when the store set() throws', async () => {
    vi.resetModules();
    await initTestPlatformConfig();

    const { setStoreFactory } = await import('@core/storeFactory');
    setStoreFactory(() => ({
      get: () => undefined,
      set: () => { throw new Error('disk full'); },
      has: () => false,
      delete: () => {},
      clear: () => {},
      get store() { return {}; },
      set store(_v) {},
      path: '/tmp/test-stores/auto-update-state.json',
      onDidChange: () => () => {},
      onDidAnyChange: () => () => {},
      reload: () => {},
       
    }) as never);

    const mod = await import('../autoUpdateStateStore');
    const result = mod.updateAutoUpdateStateChecked({
      stuckInstall: {
        updateKey: 'beta:darwin:arm64:0.4.34',
        fromVersion: '0.4.33',
        targetVersion: '0.4.34',
        attemptedAt: 1_700_000_000_000,
        platform: 'darwin',
        attemptCount: 1,
        lastFailedAt: 1_700_000_000_500,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('disk full');
  });
});
