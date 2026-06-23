/**
 * Unit tests for `silentAutoHealStuckInstall`.
 *
 * REBEL-53B rearchitecture — see
 * `docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md`.
 *
 * The recovery is best-effort and bounded once per `updateKey`. We mock
 * electron / node:fs/promises so we can inspect side effects without
 * touching the real filesystem.
 */

 

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    appGetBundleId: vi.fn(() => 'com.mindstone.rebel.test'),
    appGetVersion: vi.fn(() => '0.4.33'),
    appGetPath: vi.fn((_p?: string) => '/tmp/test-userdata'),
    autoUpdaterCheckForUpdates: vi.fn(),
    fsRm: vi.fn((..._args: unknown[]) => Promise.resolve(undefined as void)),
    storeRecoveryAttempts: {} as Record<string, number>,
    setStateChecked: vi.fn(),
    trackMainEvent: vi.fn(),
    getOrGenerateAnonymousId: vi.fn(() => 'anon-id'),
  };
});

vi.mock('electron', () => ({
  app: {
    getVersion: () => mocks.appGetVersion(),
    getPath: (p: string) => mocks.appGetPath(p),
    getName: () => 'Test',
    getBundleId: () => mocks.appGetBundleId(),
    isPackaged: false,
    once: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    releaseSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    exit: vi.fn(),
    commandLine: { hasSwitch: () => false },
  },
  autoUpdater: {
    checkForUpdates: () => mocks.autoUpdaterCheckForUpdates(),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ pid: 12345, unref: vi.fn() })),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    rm: (...args: unknown[]) => mocks.fsRm(...args),
    access: vi.fn(),
    stat: vi.fn().mockRejectedValue(new Error('no stat in tests')),
    readFile: vi.fn().mockRejectedValue(new Error('no readFile in tests')),
    readdir: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    constants: { R_OK: 4, W_OK: 2 },
  },
}));

vi.mock('../../analytics', () => ({
  trackMainEvent: (payload: unknown) => mocks.trackMainEvent(payload),
  getOrGenerateAnonymousId: () => mocks.getOrGenerateAnonymousId(),
}));

vi.mock('../updateNotificationState', () => ({
  acknowledgeDownloadedUpdate: vi.fn(),
  clearPendingDownloadedUpdate: vi.fn(),
  getPendingDownloadedUpdate: vi.fn(() => null),
  getPendingDownloadedUpdateForRenderer: vi.fn(() => null),
  getUpdatePrimaryWindow: () => null,
  setPendingDownloadedUpdate: vi.fn(),
  setUpdateMainWindowGetter: vi.fn(),
}));

vi.mock('../updateInstallMarker', () => ({
  markUpdateInstallRequested: vi.fn(),
  getUpdateInstallMarker: vi.fn(),
  clearUpdateInstallMarker: vi.fn(),
}));

vi.mock('../autoUpdateStateStore', () => ({
  updateAutoUpdateState: vi.fn(),
  updateAutoUpdateStateChecked: vi.fn((partial: { recoveryAttempts?: Record<string, number> }) => {
    mocks.setStateChecked(partial);
    if (partial.recoveryAttempts) {
      mocks.storeRecoveryAttempts = partial.recoveryAttempts;
    }
    return { ok: true };
  }),
  getAutoUpdateState: () => ({
    recoveryAttempts: mocks.storeRecoveryAttempts ?? {},
  }),
}));

vi.mock('../gracefulShutdown', () => ({
  setQuittingForUpdate: vi.fn(),
  clearQuittingForUpdate: vi.fn(),
  closeNativeWatchersForUpdate: vi.fn(async () => ({ completed: true, restore: vi.fn() })),
  markCleanExit: vi.fn(),
  rearmCleanExitFlagAfterFailedUpdate: vi.fn(),
  removeBeforeQuitHandlerForUpdate: vi.fn(),
  gracefulShutdownForUpdate: vi.fn(),
  gracefulShutdownServicesOnly: vi.fn(),
  isShuttingDown: () => false,
}));

vi.mock('@main/utils/buildChannel', () => ({ getBuildChannel: () => 'beta' }));
vi.mock('@main/utils/nativeArch', () => ({ getNativeArch: () => 'arm64' }));
vi.mock('../visibilityAwareScheduler', () => ({
  createPausableInterval: vi.fn(() => ({ pause: vi.fn(), resume: vi.fn(), stop: vi.fn() })),
}));
vi.mock('../../utils/testIsolation', () => ({ isRebelTestMode: () => false }));

vi.mock('@core/logger', () => {
  const noop = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: (cb?: () => void) => cb?.(),
  };
  return { logger: noop, createScopedLogger: () => noop };
});

import {
  silentAutoHealStuckInstall,
  _setElectronUpdaterForTesting,
  _readRecoveryAttemptsForTesting,
} from '../autoUpdateService';

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  mocks.fsRm.mockReset().mockResolvedValue(undefined);
  mocks.autoUpdaterCheckForUpdates.mockReset();
  mocks.setStateChecked.mockClear();
  mocks.trackMainEvent.mockClear();
  mocks.storeRecoveryAttempts = {};
  _setElectronUpdaterForTesting(null);
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

describe('silentAutoHealStuckInstall', () => {
  it('macOS happy path: clears ShipIt cache, triggers checkForUpdates, bumps counter', async () => {
    setPlatform('darwin');
    const result = await silentAutoHealStuckInstall('beta:darwin:arm64:0.4.34');
    expect(result).toEqual({ attempted: true, reason: 'completed' });
    expect(mocks.fsRm).toHaveBeenCalledOnce();
    const [path, opts] = mocks.fsRm.mock.calls[0]!;
    expect(typeof path).toBe('string');
    expect(String(path)).toMatch(/Library\/Caches\/com\.mindstone\.rebel\.test\.ShipIt$/);
    expect(opts).toEqual({ recursive: true, force: true });
    expect(mocks.autoUpdaterCheckForUpdates).toHaveBeenCalledOnce();
    expect(mocks.setStateChecked).toHaveBeenCalledWith({
      recoveryAttempts: { 'beta:darwin:arm64:0.4.34': 1 },
    });
  });

  it('Windows: skips ShipIt cache clear, bumps counter, calls electronUpdater.checkForUpdates when set', async () => {
    setPlatform('win32');
    const fakeElectronUpdater = {
      checkForUpdates: vi.fn().mockResolvedValue({}),
    } as unknown as typeof import('electron-updater').autoUpdater;
    _setElectronUpdaterForTesting(fakeElectronUpdater);

    const result = await silentAutoHealStuckInstall('stable:win32:x64:0.4.34');
    expect(result).toEqual({ attempted: true, reason: 'completed' });
    // No ShipIt cache on Windows
    expect(mocks.fsRm).not.toHaveBeenCalled();
    expect(fakeElectronUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(mocks.setStateChecked).toHaveBeenCalledWith({
      recoveryAttempts: { 'stable:win32:x64:0.4.34': 1 },
    });
  });

  it('macOS: cache-clear failure is best-effort — counter still bumps + checkForUpdates fires', async () => {
    setPlatform('darwin');
    mocks.fsRm.mockRejectedValue(new Error('eacces'));
    const result = await silentAutoHealStuckInstall('beta:darwin:arm64:0.4.34');
    expect(result.attempted).toBe(true);
    expect(mocks.autoUpdaterCheckForUpdates).toHaveBeenCalledOnce();
    expect(mocks.setStateChecked).toHaveBeenCalled();
  });

  it('returns exhausted when the counter is already >= 1 (no second silent retry)', async () => {
    setPlatform('darwin');
    mocks.storeRecoveryAttempts = { 'beta:darwin:arm64:0.4.34': 1 };
    const result = await silentAutoHealStuckInstall('beta:darwin:arm64:0.4.34');
    expect(result).toEqual({ attempted: false, reason: 'exhausted' });
    expect(mocks.fsRm).not.toHaveBeenCalled();
    expect(mocks.autoUpdaterCheckForUpdates).not.toHaveBeenCalled();
    expect(mocks.setStateChecked).not.toHaveBeenCalled();
  });

  it('returns no-update-key when called without an updateKey', async () => {
    const result = await silentAutoHealStuckInstall('');
    expect(result).toEqual({ attempted: false, reason: 'no-update-key' });
    expect(mocks.fsRm).not.toHaveBeenCalled();
    expect(mocks.autoUpdaterCheckForUpdates).not.toHaveBeenCalled();
  });

  it('Windows without electronUpdaterRef: warns + bumps counter (no second silent retry next launch)', async () => {
    setPlatform('win32');
    _setElectronUpdaterForTesting(null);
    const result = await silentAutoHealStuckInstall('stable:win32:x64:0.4.34');
    expect(result.attempted).toBe(true);
    // Counter still bumps so we don't loop on next startup.
    expect(mocks.setStateChecked).toHaveBeenCalledWith({
      recoveryAttempts: { 'stable:win32:x64:0.4.34': 1 },
    });
  });

  it('emits an analytics event on attempt', async () => {
    setPlatform('darwin');
    await silentAutoHealStuckInstall('beta:darwin:arm64:0.4.34');
    const events = mocks.trackMainEvent.mock.calls.map((c) => c[0] as { event?: string });
    expect(events.some((e) => e.event === 'Auto-Update Silent Auto-Heal Triggered')).toBe(true);
  });
});

// ── HIGH #2 — push payload contract for `update:downloaded` ──────────────
// `_readRecoveryAttemptsForTesting()` is the helper used by both the
// Windows and macOS `update-downloaded` event handlers to enrich the push
// payload with the silent auto-heal counter. Verifying it directly gives
// us confidence that:
//   1. A push-first sequence (push fires before the renderer's mount-time
//      pull lands) carries the same `recoveryAttempts` value the pull
//      would have produced.
//   2. The `lastAppliedUpdateKeyRef` dedup in `useIpcListeners` is
//      therefore safe — push and pull deliver consistent state for the
//      same `updateKey` regardless of which lands first.

describe('readRecoveryAttempts (push-payload contract)', () => {
  it('returns 0 when the counter has not been bumped for the updateKey', () => {
    mocks.storeRecoveryAttempts = {};
    expect(_readRecoveryAttemptsForTesting('beta:darwin:arm64:0.4.34')).toBe(0);
  });

  it('returns the persisted counter when present (push payload matches pull payload)', () => {
    mocks.storeRecoveryAttempts = { 'beta:darwin:arm64:0.4.34': 1 };
    expect(_readRecoveryAttemptsForTesting('beta:darwin:arm64:0.4.34')).toBe(1);
  });

  it('returns 0 for an unrelated updateKey even when other entries exist', () => {
    mocks.storeRecoveryAttempts = { 'beta:darwin:arm64:0.4.34': 1 };
    expect(_readRecoveryAttemptsForTesting('beta:darwin:arm64:9.9.9')).toBe(0);
  });
});
