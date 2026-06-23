/**
 * Stage 3b production-wiring tests for the Windows install force-exit backstop
 * (docs/plans/260617_bricked-state-0448-electron42/PLAN.md).
 *
 * The reviewer-confirmed blocker: `safeQuitAndInstallWindows` arms a force-exit
 * timer after `quitAndInstall(false, true)` but must NOT force-exit a normal —
 * if slow — install handoff. These tests drive the real
 * `scheduleWindowsForceExitFallback` through the production path and assert:
 *   - The timer is armed on entry (no immediate force-exit).
 *   - A clean handoff (before-quit / will-quit fired) CLEARS it → no force-exit.
 *   - A genuine past-budget hang (no lifecycle event) DOES emit + force-exit
 *     via the fsevents-sweeping primitive.
 *
 * `emitQuitDeadlockDetected` is stubbed to a spy (its ledger-first / bounded-
 * flush ordering is unit-tested separately in quitDeadlockTelemetry.test.ts);
 * `scheduleWindowsForceExitFallback` is kept REAL so the wiring is exercised
 * end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const quitListeners = new Map<string, () => void>();
  return {
    calls,
    quitListeners,
    appGetVersion: vi.fn(() => '0.4.4818058'),
    appReleaseSingleInstanceLock: vi.fn(() => true),
    appRequestSingleInstanceLock: vi.fn(() => true),
    appOnce: vi.fn((event: string, handler: () => void) => {
      quitListeners.set(event, handler);
    }),
    appExit: vi.fn(),
    quitAndInstall: vi.fn((..._args: unknown[]) => {
      calls.push('quitAndInstall');
    }),
    gracefulShutdownServicesOnly: vi.fn(async (..._args: unknown[]) => {
      calls.push('gracefulShutdownServicesOnly');
    }),
    markCleanExit: vi.fn((..._args: unknown[]) => {
      calls.push('markCleanExit');
    }),
    immediateExitWithFseventsSweep: vi.fn(async (...args: unknown[]) => {
      calls.push(`immediateExitWithFseventsSweep:${String(args[0])}:${String(args[1])}`);
    }),
    setQuittingForUpdate: vi.fn(),
    clearQuittingForUpdate: vi.fn(),
    markUpdateInstallRequested: vi.fn(),
    appendDiagnosticEvent: vi.fn((...args: unknown[]) => {
      const entry = args[0] as { kind?: string } | undefined;
      if (entry && typeof entry.kind === 'string') calls.push(`ledger:${entry.kind}`);
    }),
  };
});

vi.mock('electron', () => ({
  app: {
    getVersion: () => mocks.appGetVersion(),
    getPath: () => '/tmp/rebel-user-data',
    getName: () => 'Mindstone Rebel Beta',
    getBundleId: () => 'com.mindstone.rebel.beta',
    isPackaged: true,
    once: (event: string, handler: () => void) => mocks.appOnce(event, handler),
    requestSingleInstanceLock: () => mocks.appRequestSingleInstanceLock(),
    releaseSingleInstanceLock: () => mocks.appReleaseSingleInstanceLock(),
    quit: vi.fn(),
    exit: (code?: number) => mocks.appExit(code),
    commandLine: { hasSwitch: () => false },
  },
  autoUpdater: {
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ pid: 12345, unref: vi.fn() })) }));
vi.mock('node:fs/promises', () => ({
  default: {
    access: vi.fn(),
    readFile: vi.fn().mockRejectedValue(new Error('no readFile in tests')),
    readdir: vi.fn().mockResolvedValue([]),
    rm: vi.fn(),
    stat: vi.fn().mockRejectedValue(new Error('no stat in tests')),
  },
}));
vi.mock('node:fs', () => ({
  default: { constants: { R_OK: 4, W_OK: 2 }, existsSync: vi.fn(() => false), readFileSync: vi.fn(), unlinkSync: vi.fn() },
}));

vi.mock('@core/services/diagnosticEventsLedger', () => ({
  appendDiagnosticEvent: (...args: unknown[]) => mocks.appendDiagnosticEvent(...args),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ addBreadcrumb: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn() }),
  setErrorReporter: vi.fn(),
}));

vi.mock('@core/logger', () => {
  const noop = { debug: vi.fn(), error: vi.fn(), flush: (cb?: () => void) => cb?.(), info: vi.fn(), warn: vi.fn() };
  return { createScopedLogger: () => noop, logger: noop };
});

vi.mock('../../analytics', () => ({ getOrGenerateAnonymousId: vi.fn(() => 'anon-id'), trackMainEvent: vi.fn() }));

vi.mock('../updateNotificationState', () => ({
  acknowledgeDownloadedUpdate: vi.fn(),
  clearPendingDownloadedUpdate: vi.fn(),
  getPendingDownloadedUpdate: vi.fn(() => ({
    updateKey: 'beta:win32:x64:0.4.4818059',
    versionLabel: '0.4.4818059',
    downloadedAt: Date.now(),
  })),
  getPendingDownloadedUpdateForRenderer: vi.fn(() => null),
  getUpdatePrimaryWindow: () => null,
  setPendingDownloadedUpdate: vi.fn(),
  setUpdateMainWindowGetter: vi.fn(),
}));

vi.mock('../updateInstallMarker', () => ({
  clearUpdateInstallMarker: vi.fn(),
  getUpdateInstallMarker: vi.fn(),
  markUpdateInstallRequested: (...args: unknown[]) => mocks.markUpdateInstallRequested(...args),
}));

vi.mock('../autoUpdateStateStore', () => ({
  getAutoUpdateState: () => ({ recoveryAttempts: {} }),
  updateAutoUpdateState: vi.fn(),
  updateAutoUpdateStateChecked: vi.fn(() => ({ ok: true })),
}));

vi.mock('../gracefulShutdown', () => ({
  clearQuittingForUpdate: (...args: unknown[]) => mocks.clearQuittingForUpdate(...args),
  closeNativeWatchersForUpdate: vi.fn(async () => ({ completed: true, restore: vi.fn() })),
  gracefulShutdownForUpdate: vi.fn(),
  gracefulShutdownServicesOnly: (...args: unknown[]) => mocks.gracefulShutdownServicesOnly(...args),
  isShuttingDown: () => false,
  markCleanExit: (...args: unknown[]) => mocks.markCleanExit(...args),
  rearmCleanExitFlagAfterFailedUpdate: vi.fn(),
  removeBeforeQuitHandlerForUpdate: vi.fn(),
  setQuittingForUpdate: (...args: unknown[]) => mocks.setQuittingForUpdate(...args),
}));

vi.mock('../finalExit', () => ({
  immediateExitWithFseventsSweep: (...args: unknown[]) =>
    mocks.immediateExitWithFseventsSweep(...(args as [unknown, unknown])),
}));

// scheduleWindowsForceExitFallback is kept REAL (the wiring under test). Its
// default emit (emitQuitDeadlockDetected) is also REAL — its ledger-first /
// bounded-flush ordering is unit-tested in quitDeadlockTelemetry.test.ts — so
// the production fire is observed here via its durable side effect: the
// `quit_deadlock_detected` ledger write (mocks.appendDiagnosticEvent). The
// real emit's Sentry flush is a no-op in tests (SENTRY_DSN unset).

vi.mock('@main/utils/buildChannel', () => ({ getBuildChannel: () => 'beta' }));
vi.mock('@main/utils/nativeArch', () => ({ getNativeArch: () => 'x64' }));
vi.mock('../visibilityAwareScheduler', () => ({
  createPausableInterval: vi.fn(() => ({ pause: vi.fn(), resume: vi.fn(), stop: vi.fn() })),
}));
vi.mock('../../utils/testIsolation', () => ({ isRebelTestMode: () => false }));

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

const stubUpdater = () =>
  ({
    quitAndInstall: (...args: unknown[]) => mocks.quitAndInstall(...args),
  }) as unknown as typeof import('electron-updater').autoUpdater;

const stubLog = () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

describe('safeQuitAndInstallWindows force-exit backstop wiring (Stage 3b)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.quitListeners.clear();
    setPlatform('win32');
  });

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
    vi.useRealTimers();
  });

  it('arms the timer on entry without an immediate force-exit, and triggers install', async () => {
    const { _safeQuitAndInstallWindowsForTesting } = await import('../autoUpdateService');

    const result = await _safeQuitAndInstallWindowsForTesting(stubUpdater(), stubLog());

    expect(result).toEqual({ success: true });
    expect(mocks.calls).toContain('quitAndInstall');
    // Lifecycle listeners registered so a clean handoff can clear the timer.
    expect(mocks.quitListeners.has('before-quit')).toBe(true);
    expect(mocks.quitListeners.has('will-quit')).toBe(true);
    // No force-exit yet (we are still inside the budget) and no deadlock
    // signal yet (only the install_attempted ledger event has fired).
    expect(mocks.immediateExitWithFseventsSweep).not.toHaveBeenCalled();
    expect(mocks.calls).not.toContain('ledger:quit_deadlock_detected');
  });

  it('CLEARS the timer on a clean handoff (before-quit fired) → never force-exits a normal install', async () => {
    const { _safeQuitAndInstallWindowsForTesting } = await import('../autoUpdateService');

    await _safeQuitAndInstallWindowsForTesting(stubUpdater(), stubLog());

    // Simulate the normal quit handoff: before-quit fires shortly after.
    mocks.quitListeners.get('before-quit')?.();

    // Advance well past the budget — the cleared timer must NOT fire.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.calls).not.toContain('ledger:quit_deadlock_detected');
    expect(mocks.immediateExitWithFseventsSweep).not.toHaveBeenCalled();
    expect(mocks.markCleanExit).not.toHaveBeenCalled();
  });

  it('emits quit_deadlock_detected(win) and force-exits on a genuine past-budget hang (no lifecycle event)', async () => {
    const { _safeQuitAndInstallWindowsForTesting } = await import('../autoUpdateService');
    const { WINDOWS_FORCE_EXIT_BUDGET_MS } = await import('../quitDeadlockTelemetry');

    await _safeQuitAndInstallWindowsForTesting(stubUpdater(), stubLog());

    // No before-quit / will-quit fires → the quit is genuinely stuck.
    await vi.advanceTimersByTimeAsync(WINDOWS_FORCE_EXIT_BUDGET_MS);

    // The real emit ran (observed via its durable ledger side effect) and the
    // force-exit followed through the fsevents-sweeping primitive.
    expect(mocks.calls).toContain('ledger:quit_deadlock_detected');
    expect(mocks.markCleanExit).toHaveBeenCalledTimes(1);
    expect(mocks.immediateExitWithFseventsSweep).toHaveBeenCalledWith('update-win-fallback', 0);
    // Bare app.exit must never be used (final-exit primitive sweeps fsevents).
    expect(mocks.appExit).not.toHaveBeenCalled();
    // Ledger-first ordering: the quit_deadlock_detected record precedes the
    // force-exit primitive.
    const ledgerIdx = mocks.calls.indexOf('ledger:quit_deadlock_detected');
    const exitIdx = mocks.calls.indexOf('immediateExitWithFseventsSweep:update-win-fallback:0');
    expect(ledgerIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeGreaterThan(ledgerIdx);
  });
});
