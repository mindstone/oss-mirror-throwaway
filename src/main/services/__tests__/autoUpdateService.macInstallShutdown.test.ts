import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  // Sentinel returned by the mocked captureNativeLivenessSnapshot() so we can
  // assert it is threaded into the deadlock emit by reference (and captured
  // BEFORE the Tier-2 emit/sweep).
  const nativeLivenessSentinel = { __sentinel: 'native-liveness' } as const;
  return {
    calls,
    nativeLivenessSentinel,
    captureNativeLivenessSnapshot: vi.fn(() => {
      calls.push('captureNativeLivenessSnapshot');
      return nativeLivenessSentinel;
    }),
    appGetPath: vi.fn((name?: string) => (
      name === 'exe'
        ? '/Applications/Mindstone Rebel Beta.app/Contents/MacOS/Mindstone Rebel Beta'
        : '/tmp/rebel-user-data'
    )),
    appGetVersion: vi.fn(() => '0.4.4616185'),
    appReleaseSingleInstanceLock: vi.fn(() => {
      calls.push('releaseSingleInstanceLock');
      return true;
    }),
    appRequestSingleInstanceLock: vi.fn(() => true),
    appOnce: vi.fn(),
    appQuit: vi.fn(),
    appExit: vi.fn(),
    autoUpdaterQuitAndInstall: vi.fn(() => {
      calls.push('quitAndInstall');
    }),
    closeNativeWatchersForUpdate: vi.fn(async (..._args: unknown[]) => {
      calls.push('closeNativeWatchersForUpdate:start');
      await Promise.resolve();
      calls.push('closeNativeWatchersForUpdate:end');
      return { completed: true, restore: mocks.restoreNativeWatchers };
    }),
    restoreNativeWatchers: vi.fn(() => {
      calls.push('restoreNativeWatchers');
    }),
    markCleanExit: vi.fn((..._args: unknown[]) => {
      calls.push('markCleanExit');
    }),
    immediateExitWithFseventsSweep: vi.fn(async (reason: unknown, exitCode: unknown) => {
      calls.push(`immediateExitWithFseventsSweep:${String(reason)}:${String(exitCode)}`);
    }),
    rearmCleanExitFlagAfterFailedUpdate: vi.fn((..._args: unknown[]) => {
      calls.push('rearmCleanExitFlagAfterFailedUpdate');
    }),
    emitQuitDeadlockDetected: vi.fn(async (tier: string, ..._rest: unknown[]) => {
      calls.push(`emit:${tier}`);
    }),
    removeBeforeQuitHandlerForUpdate: vi.fn((..._args: unknown[]) => {
      calls.push('removeBeforeQuitHandlerForUpdate');
    }),
    setQuittingForUpdate: vi.fn((..._args: unknown[]) => {
      calls.push('setQuittingForUpdate');
    }),
    clearQuittingForUpdate: vi.fn(),
    markUpdateInstallRequested: vi.fn(),
    appendDiagnosticEvent: vi.fn(),
    spawn: vi.fn((..._args: unknown[]) => ({ pid: 12345, unref: vi.fn() })),
    processKill: vi.spyOn(process, 'kill').mockImplementation(() => true),
  };
});

vi.mock('electron', () => ({
  app: {
    getVersion: () => mocks.appGetVersion(),
    getPath: (name: string) => mocks.appGetPath(name),
    getName: () => 'Mindstone Rebel Beta',
    getBundleId: () => 'com.mindstone.rebel.beta',
    isPackaged: true,
    once: (...args: unknown[]) => mocks.appOnce(...args),
    requestSingleInstanceLock: () => mocks.appRequestSingleInstanceLock(),
    releaseSingleInstanceLock: () => mocks.appReleaseSingleInstanceLock(),
    quit: () => mocks.appQuit(),
    exit: (code?: number) => mocks.appExit(code),
    commandLine: { hasSwitch: () => false },
  },
  autoUpdater: {
    checkForUpdates: vi.fn(),
    quitAndInstall: () => mocks.autoUpdaterQuitAndInstall(),
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
  spawn: (...args: unknown[]) => mocks.spawn(...args),
}));

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
  default: {
    constants: { R_OK: 4, W_OK: 2 },
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock('@core/services/diagnosticEventsLedger', () => ({
  appendDiagnosticEvent: (...args: unknown[]) => mocks.appendDiagnosticEvent(...args),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  }),
}));

vi.mock('@core/logger', () => {
  const noop = {
    debug: vi.fn(),
    error: vi.fn(),
    flush: (cb?: () => void) => cb?.(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return { createScopedLogger: () => noop, logger: noop };
});

vi.mock('../../analytics', () => ({
  getOrGenerateAnonymousId: vi.fn(() => 'anon-id'),
  trackMainEvent: vi.fn(),
}));

vi.mock('../updateNotificationState', () => ({
  acknowledgeDownloadedUpdate: vi.fn(),
  clearPendingDownloadedUpdate: vi.fn(),
  getPendingDownloadedUpdate: vi.fn(() => ({
    updateKey: 'beta:darwin:arm64:0.4.4616463',
    versionLabel: '0.4.4616463',
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
  closeNativeWatchersForUpdate: (...args: unknown[]) => mocks.closeNativeWatchersForUpdate(...args),
  gracefulShutdownForUpdate: vi.fn(),
  gracefulShutdownServicesOnly: vi.fn(),
  isShuttingDown: () => false,
  markCleanExit: (...args: unknown[]) => mocks.markCleanExit(...args),
  rearmCleanExitFlagAfterFailedUpdate: (...args: unknown[]) => mocks.rearmCleanExitFlagAfterFailedUpdate(...args),
  removeBeforeQuitHandlerForUpdate: (...args: unknown[]) => mocks.removeBeforeQuitHandlerForUpdate(...args),
  setQuittingForUpdate: (...args: unknown[]) => mocks.setQuittingForUpdate(...args),
}));

vi.mock('../finalExit', () => ({
  immediateExitWithFseventsSweep: (...args: unknown[]) =>
    mocks.immediateExitWithFseventsSweep(...(args as [unknown, unknown])),
}));

// Stage 3b: stub the quit-deadlock emit (ledger-first / bounded-flush ordering
// is unit-tested in quitDeadlockTelemetry.test.ts) so the mac Tier-1/Tier-2
// emit call sites are observable here without exercising the real Sentry flush.
vi.mock('../quitDeadlockTelemetry', async () => {
  const actual = await vi.importActual<typeof import('../quitDeadlockTelemetry')>('../quitDeadlockTelemetry');
  return {
    ...actual,
    emitQuitDeadlockDetected: (...args: unknown[]) =>
      mocks.emitQuitDeadlockDetected(...(args as [string, ...unknown[]])),
  };
});

// 260622: the mac Tier-1/Tier-2 paths capture a synchronous native-liveness
// snapshot and thread it into emitQuitDeadlockDetected(tier, {}, snapshot).
// Stub it with a sentinel so we can assert the emit arg shape AND that the
// capture happens before the Tier-2 emit/sweep — without exercising the real
// main-process service singletons.
vi.mock('../nativeLivenessSnapshot', () => ({
  captureNativeLivenessSnapshot: () => mocks.captureNativeLivenessSnapshot(),
}));

vi.mock('@main/utils/buildChannel', () => ({ getBuildChannel: () => 'beta' }));
vi.mock('@main/utils/nativeArch', () => ({ getNativeArch: () => 'arm64' }));
vi.mock('../visibilityAwareScheduler', () => ({
  createPausableInterval: vi.fn(() => ({ pause: vi.fn(), resume: vi.fn(), stop: vi.fn() })),
}));
vi.mock('../../utils/testIsolation', () => ({ isRebelTestMode: () => false }));

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('safeQuitAndInstallMacOS shutdown ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.autoUpdaterQuitAndInstall.mockImplementation(() => {
      mocks.calls.push('quitAndInstall');
    });
    mocks.appReleaseSingleInstanceLock.mockImplementation(() => {
      mocks.calls.push('releaseSingleInstanceLock');
      return true;
    });
    setPlatform('darwin');
  });

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
    vi.useRealTimers();
  });

  it('awaits native watcher cleanup and marks clean exit before handing off to ShipIt', async () => {
    const { _safeQuitAndInstallMacOSForTesting } = await import('../autoUpdateService');

    const result = await _safeQuitAndInstallMacOSForTesting({
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    });

    expect(result).toEqual({ success: true });
    expect(mocks.closeNativeWatchersForUpdate).toHaveBeenCalledOnce();
    expect(mocks.calls).toEqual([
      'closeNativeWatchersForUpdate:start',
      'closeNativeWatchersForUpdate:end',
      'markCleanExit',
      'removeBeforeQuitHandlerForUpdate',
      'releaseSingleInstanceLock',
      'setQuittingForUpdate',
      'quitAndInstall',
    ]);
  });

  it('still proceeds to quitAndInstall when native watcher cleanup times out (proceed-with-loud-telemetry policy)', async () => {
    mocks.closeNativeWatchersForUpdate.mockImplementationOnce(async (..._args: unknown[]) => {
      mocks.calls.push('closeNativeWatchersForUpdate:start');
      await Promise.resolve();
      mocks.calls.push('closeNativeWatchersForUpdate:end');
      return { completed: false, restore: mocks.restoreNativeWatchers };
    });
    const { _safeQuitAndInstallMacOSForTesting } = await import('../autoUpdateService');

    const result = await _safeQuitAndInstallMacOSForTesting({
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    });

    expect(result).toEqual({ success: true });
    expect(mocks.calls).toEqual([
      'closeNativeWatchersForUpdate:start',
      'closeNativeWatchersForUpdate:end',
      'markCleanExit',
      'removeBeforeQuitHandlerForUpdate',
      'releaseSingleInstanceLock',
      'setQuittingForUpdate',
      'quitAndInstall',
    ]);
    // Success (even with timed-out cleanup) must never restore watchers or re-arm the crash counter.
    expect(mocks.restoreNativeWatchers).not.toHaveBeenCalled();
    expect(mocks.rearmCleanExitFlagAfterFailedUpdate).not.toHaveBeenCalled();
  });

  it('Tier-2 fallback exits through the final-exit primitive (fsevents sweep) after marking clean exit, never via bare app.exit', async () => {
    // Stage 2 of docs/plans/260611_fsevents-shutdown-crash/PLAN.md (amendment
    // F2): app.exit() emits NO lifecycle events, so the Tier-2 forced exit
    // bypasses every will-quit listener — it must sweep leaked fsevents
    // instances itself via immediateExitWithFseventsSweep(). This is exactly
    // the path of the 260609 update-quit crash cohort.
    const { _safeQuitAndInstallMacOSForTesting } = await import('../autoUpdateService');

    const result = await _safeQuitAndInstallMacOSForTesting({
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    });
    expect(result).toEqual({ success: true });

    // Fire Tier-1 (3s, app.quit) and Tier-2 (8s, forced exit). before-quit is
    // never simulated here, so both deadlock tiers fire.
    await vi.advanceTimersByTimeAsync(8000);

    // The mocked logger.flush invokes its callback synchronously, so the
    // primary (flush-callback) Tier-2 branch runs: markCleanExit, then the
    // sweep+exit primitive. The bare app.exit must never fire.
    expect(mocks.appExit).not.toHaveBeenCalled();
    expect(mocks.immediateExitWithFseventsSweep).toHaveBeenCalledExactlyOnceWith('update-tier2-fallback', 0);

    const tier2MarkCleanExitIndex = mocks.calls.lastIndexOf('markCleanExit');
    const sweepExitIndex = mocks.calls.indexOf('immediateExitWithFseventsSweep:update-tier2-fallback:0');
    expect(tier2MarkCleanExitIndex).toBeGreaterThanOrEqual(0);
    expect(sweepExitIndex).toBeGreaterThan(tier2MarkCleanExitIndex);

    // Stage 3b: both deadlock tiers emit the observable signal. Tier-1 (3s,
    // before-quit didn't fire) and Tier-2 (8s, still alive) each fire once.
    // 260622: each emit carries the native-liveness snapshot sentinel as its
    // third arg — captureNativeLivenessSnapshot() is mocked to return it, and
    // the impl threads it through as emitQuitDeadlockDetected(tier, {}, snapshot).
    expect(mocks.emitQuitDeadlockDetected).toHaveBeenCalledWith(
      'mac_tier1',
      {},
      mocks.nativeLivenessSentinel,
    );
    expect(mocks.emitQuitDeadlockDetected).toHaveBeenCalledWith(
      'mac_tier2',
      {},
      mocks.nativeLivenessSentinel,
    );
    // The Tier-2 emit precedes its force-exit (ledger-first contract).
    const tier2EmitIndex = mocks.calls.indexOf('emit:mac_tier2');
    expect(tier2EmitIndex).toBeGreaterThanOrEqual(0);
    expect(sweepExitIndex).toBeGreaterThan(tier2EmitIndex);
    // 260622: the native-liveness snapshot MUST be captured BEFORE the Tier-2
    // emit (and therefore before the sweep) — a post-sweep read would always
    // see 0 fsevents instances. The last capture before the emit is Tier-2's.
    const captureBeforeTier2Emit = mocks.calls
      .slice(0, tier2EmitIndex)
      .lastIndexOf('captureNativeLivenessSnapshot');
    expect(captureBeforeTier2Emit).toBeGreaterThanOrEqual(0);
  });

  it('does NOT emit mac_tier1/mac_tier2 when before-quit fires within the budget (clean handoff)', async () => {
    const { _safeQuitAndInstallMacOSForTesting } = await import('../autoUpdateService');

    // Capture the before-quit handler the install path registers so we can
    // simulate a normal quit handoff that pre-empts both deadlock tiers.
    let beforeQuitHandler: (() => void) | undefined;
    mocks.appOnce.mockImplementation((event: unknown, handler: unknown) => {
      if (event === 'before-quit') beforeQuitHandler = handler as () => void;
    });

    await _safeQuitAndInstallMacOSForTesting({
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    });

    // Normal handoff: before-quit fires immediately (sets quitEventFired).
    beforeQuitHandler?.();

    await vi.advanceTimersByTimeAsync(8000);

    // Tier-1 is gated on `!quitEventFired`, so it must NOT emit; Tier-2 still
    // force-exits (the 8s ultimate fallback is unconditional by design), but
    // Tier-1's deadlock signal must not be a false positive here.
    expect(mocks.emitQuitDeadlockDetected).not.toHaveBeenCalledWith('mac_tier1');
  });

  it('restores watchers, rearms clean-exit tracking, and kills the watchdog when quitAndInstall throws', async () => {
    mocks.autoUpdaterQuitAndInstall.mockImplementation(() => {
      mocks.calls.push('quitAndInstall');
      throw new Error('ShipIt refused');
    });
    const { _safeQuitAndInstallMacOSForTesting } = await import('../autoUpdateService');

    const result = await _safeQuitAndInstallMacOSForTesting({
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(mocks.restoreNativeWatchers).toHaveBeenCalledOnce();
    expect(mocks.rearmCleanExitFlagAfterFailedUpdate).toHaveBeenCalledOnce();
    expect(mocks.processKill).toHaveBeenCalledWith(12345, 'SIGTERM');
  });
});
