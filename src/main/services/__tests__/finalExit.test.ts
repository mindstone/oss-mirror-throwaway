/**
 * Stage 2 of docs/plans/260611_fsevents-shutdown-crash/PLAN.md — the
 * final-exit primitive and the guarded will-quit backstop.
 *
 * Ordering contract under test: enterQuitMode → sweepLeakedInstances →
 * app.exit/process.exit; the backstop NEVER sweeps a cancelled
 * (defaultPrevented) quit and NEVER calls an exit itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enterQuitMode = vi.fn();
const sweepLeakedInstances = vi.fn(async () => 0);
const liveNativeInstanceCount = vi.fn(() => 0);
const captureMainMessage = vi.fn();
const flushMainSentry = vi.fn(async () => true);
const appendDiagnosticEvent = vi.fn();
const flushDiagnosticEventsLedger = vi.fn(async () => undefined);
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

// Reassigned per-test: null = cloud surface (no electron module).
let electronModuleMock: { app: { exit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } } | null = null;

vi.mock('../fseventsLeakGuard', () => ({
  enterQuitMode,
  sweepLeakedInstances,
  liveNativeInstanceCount,
}));
vi.mock('../../sentry', () => ({
  captureMainMessage,
  flushMainSentry,
}));
vi.mock('@core/services/diagnosticEventsLedger', () => ({
  appendDiagnosticEvent,
}));
vi.mock('../diagnosticEventsLedgerWriter', () => ({
  flushDiagnosticEventsLedger,
}));
vi.mock('@core/logger', () => ({
  logger,
  createScopedLogger: () => logger,
}));
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => electronModuleMock,
}));

function makeElectronMock() {
  return { app: { exit: vi.fn(), on: vi.fn() } };
}

const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

describe('immediateExitWithFseventsSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sweepLeakedInstances.mockResolvedValue(0);
    flushMainSentry.mockImplementation(async () => true);
    flushDiagnosticEventsLedger.mockImplementation(async () => undefined);
    electronModuleMock = makeElectronMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enters quit mode, sweeps, then exits via app.exit on desktop — in that order', async () => {
    await import('../finalExit').then(({ immediateExitWithFseventsSweep }) =>
      immediateExitWithFseventsSweep('test-reason', 0),
    );

    const appExit = electronModuleMock!.app.exit;
    expect(enterQuitMode).toHaveBeenCalledOnce();
    expect(sweepLeakedInstances).toHaveBeenCalledOnce();
    expect(appExit).toHaveBeenCalledExactlyOnceWith(0);
    expect(processExitSpy).not.toHaveBeenCalled();
    expect(enterQuitMode.mock.invocationCallOrder[0]).toBeLessThan(
      sweepLeakedInstances.mock.invocationCallOrder[0],
    );
    expect(sweepLeakedInstances.mock.invocationCallOrder[0]).toBeLessThan(
      appExit.mock.invocationCallOrder[0],
    );
  });

  it('propagates the exit code', async () => {
    const { immediateExitWithFseventsSweep } = await import('../finalExit');
    await immediateExitWithFseventsSweep('nonzero', 3);
    expect(electronModuleMock!.app.exit).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('exits via process.exit on cloud (no electron module), after the sweep', async () => {
    electronModuleMock = null;
    const { immediateExitWithFseventsSweep } = await import('../finalExit');

    await immediateExitWithFseventsSweep('cloud-reason', 0);

    expect(sweepLeakedInstances).toHaveBeenCalledOnce();
    expect(processExitSpy).toHaveBeenCalledExactlyOnceWith(0);
    expect(sweepLeakedInstances.mock.invocationCallOrder[0]).toBeLessThan(
      processExitSpy.mock.invocationCallOrder[0],
    );
  });

  it('reports a Sentry warning with the swept count when leaked instances were found', async () => {
    sweepLeakedInstances.mockResolvedValue(2);
    const { immediateExitWithFseventsSweep } = await import('../finalExit');

    await immediateExitWithFseventsSweep('leaky', 0);

    expect(captureMainMessage).toHaveBeenCalledExactlyOnceWith(
      'fsevents leak sweep stopped 2 instances',
      expect.objectContaining({ level: 'warning', extra: { sweptCount: 2 } }),
    );
    expect(electronModuleMock!.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('persists a ledger entry and flushes both sinks BEFORE exiting when instances were swept (RS F1)', async () => {
    sweepLeakedInstances.mockResolvedValue(2);
    const { immediateExitWithFseventsSweep } = await import('../finalExit');

    await immediateExitWithFseventsSweep('leaky', 0);

    expect(appendDiagnosticEvent).toHaveBeenCalledExactlyOnceWith({
      kind: 'fsevents_leak_sweep',
      data: { sweptCount: 2, trigger: 'immediate_exit', exitReason: 'leaky' },
    });
    expect(flushMainSentry).toHaveBeenCalledExactlyOnceWith(1_500);
    expect(flushDiagnosticEventsLedger).toHaveBeenCalledOnce();

    // The whole telemetry leg (append + both flushes) must precede the exit —
    // an unflushed capture microtasks before app.exit is mostly lost.
    const appExit = electronModuleMock!.app.exit;
    expect(appExit).toHaveBeenCalledExactlyOnceWith(0);
    expect(appendDiagnosticEvent.mock.invocationCallOrder[0]).toBeLessThan(
      appExit.mock.invocationCallOrder[0],
    );
    expect(flushMainSentry.mock.invocationCallOrder[0]).toBeLessThan(
      appExit.mock.invocationCallOrder[0],
    );
    expect(flushDiagnosticEventsLedger.mock.invocationCallOrder[0]).toBeLessThan(
      appExit.mock.invocationCallOrder[0],
    );
  });

  it('does NOT capture, persist, or flush anything on a clean (0-swept) exit', async () => {
    sweepLeakedInstances.mockResolvedValue(0);
    const { immediateExitWithFseventsSweep } = await import('../finalExit');

    await immediateExitWithFseventsSweep('clean', 0);

    expect(captureMainMessage).not.toHaveBeenCalled();
    expect(appendDiagnosticEvent).not.toHaveBeenCalled();
    expect(flushMainSentry).not.toHaveBeenCalled();
    expect(flushDiagnosticEventsLedger).not.toHaveBeenCalled();
  });

  it('caps the pre-exit telemetry flush at its 2s belt and still exits when both flushes hang', async () => {
    vi.useFakeTimers();
    sweepLeakedInstances.mockResolvedValue(1);
    flushMainSentry.mockImplementation(() => new Promise<boolean>(() => undefined));
    flushDiagnosticEventsLedger.mockImplementation(() => new Promise<undefined>(() => undefined));
    const { immediateExitWithFseventsSweep } = await import('../finalExit');

    const pending = immediateExitWithFseventsSweep('hung-flush', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(electronModuleMock!.app.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    expect(appendDiagnosticEvent).toHaveBeenCalledOnce();
    expect(electronModuleMock!.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('still exits when the ledger append throws (fail-open telemetry)', async () => {
    sweepLeakedInstances.mockResolvedValue(1);
    appendDiagnosticEvent.mockImplementationOnce(() => {
      throw new Error('ledger surprise');
    });
    const { immediateExitWithFseventsSweep } = await import('../finalExit');

    await immediateExitWithFseventsSweep('ledger-broke', 0);

    expect(electronModuleMock!.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('still exits when the sweep rejects (fail-open)', async () => {
    sweepLeakedInstances.mockRejectedValue(new Error('native surprise'));
    const { immediateExitWithFseventsSweep } = await import('../finalExit');

    await immediateExitWithFseventsSweep('sweep-broke', 0);

    expect(electronModuleMock!.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('still exits when enterQuitMode throws (fail-open)', async () => {
    enterQuitMode.mockImplementationOnce(() => {
      throw new Error('guard surprise');
    });
    const { immediateExitWithFseventsSweep } = await import('../finalExit');

    await immediateExitWithFseventsSweep('guard-broke', 0);

    expect(electronModuleMock!.app.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('exits after the 2s outer belt when the sweep hangs', async () => {
    vi.useFakeTimers();
    sweepLeakedInstances.mockImplementation(() => new Promise<number>(() => undefined));
    const { immediateExitWithFseventsSweep } = await import('../finalExit');

    const pending = immediateExitWithFseventsSweep('hung-sweep', 0);
    expect(electronModuleMock!.app.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    expect(electronModuleMock!.app.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(captureMainMessage).not.toHaveBeenCalled();
  });
});

describe('registerWillQuitFseventsSweepBackstop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sweepLeakedInstances.mockResolvedValue(0);
    liveNativeInstanceCount.mockReturnValue(0);
    flushMainSentry.mockImplementation(async () => true);
    flushDiagnosticEventsLedger.mockImplementation(async () => undefined);
    electronModuleMock = makeElectronMock();
  });

  function registeredWillQuitHandler(): (event: { defaultPrevented: boolean }) => void {
    const call = electronModuleMock!.app.on.mock.calls.find(([eventName]) => eventName === 'will-quit');
    expect(call).toBeDefined();
    return call![1] as (event: { defaultPrevented: boolean }) => void;
  }

  it('no-ops when an earlier handler cancelled the quit (defaultPrevented)', async () => {
    const { registerWillQuitFseventsSweepBackstop } = await import('../finalExit');
    registerWillQuitFseventsSweepBackstop();

    registeredWillQuitHandler()({ defaultPrevented: true });

    // A cancelled quit means the app stays alive: sweeping/entering one-way
    // quit mode here would dead-watcher a live app (amendment review F1).
    expect(enterQuitMode).not.toHaveBeenCalled();
    expect(sweepLeakedInstances).not.toHaveBeenCalled();
  });

  it('passive leg (nothing live): enters quit mode, never calls an exit, lets Electron quit', async () => {
    liveNativeInstanceCount.mockReturnValue(0);
    const { registerWillQuitFseventsSweepBackstop } = await import('../finalExit');
    registerWillQuitFseventsSweepBackstop();

    registeredWillQuitHandler()({ defaultPrevented: false });

    expect(enterQuitMode).toHaveBeenCalledOnce();
    expect(sweepLeakedInstances).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(sweepLeakedInstances.mock.results[0]).toBeDefined();
    });
    // Electron continues its own quit — the passive leg must not exit.
    expect(electronModuleMock!.app.exit).not.toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('DETERMINISTIC leg (live instances): awaits the sweep then forces app.exit(0) — the microtask race fix (final review F1)', async () => {
    // The real fsevents stop closure schedules Native.stop as a MICROTASK
    // (fsevents.js:33); a fire-and-forget backstop would let env teardown
    // race it. With live instances the backstop must exit through the
    // awaited primitive core instead.
    liveNativeInstanceCount.mockReturnValue(2);
    sweepLeakedInstances.mockResolvedValue(2);
    const { registerWillQuitFseventsSweepBackstop } = await import('../finalExit');
    registerWillQuitFseventsSweepBackstop();

    registeredWillQuitHandler()({ defaultPrevented: false });

    const appExit = electronModuleMock!.app.exit;
    await vi.waitFor(() => {
      expect(appExit).toHaveBeenCalledExactlyOnceWith(0);
    });
    // Ordering: the sweep (and its telemetry) resolved BEFORE the exit.
    expect(sweepLeakedInstances).toHaveBeenCalledOnce();
    expect(sweepLeakedInstances.mock.invocationCallOrder[0]).toBeLessThan(
      appExit.mock.invocationCallOrder[0],
    );
    expect(captureMainMessage).toHaveBeenCalledExactlyOnceWith(
      'fsevents leak sweep stopped 2 instances',
      expect.objectContaining({ level: 'warning' }),
    );
    expect(captureMainMessage.mock.invocationCallOrder[0]).toBeLessThan(
      appExit.mock.invocationCallOrder[0],
    );
  });

  it('no-skipped-exit invariant: a non-prevented will-quit with live instances always reaches an exit', async () => {
    // The backstop must never RETURN from the live-instance leg without
    // committing an exit: on a non-prevented will-quit (the FOX-3489 macOS
    // update/relaunch handoff shape, post-removeBeforeQuitHandlerForUpdate),
    // Electron is free to continue teardown, so the only safe completion is
    // forcing app.exit(0) through the awaited sweep core. Empirically anchored
    // by 260611 Stage 4(e) Leg B (15/15 clean on Electron 39). This guards the
    // invariant against a future refactor silently turning the leg into a
    // no-op return (which would re-open the SIGABRT/deadlock window).
    liveNativeInstanceCount.mockReturnValue(1);
    sweepLeakedInstances.mockResolvedValue(1);
    const { registerWillQuitFseventsSweepBackstop } = await import('../finalExit');
    registerWillQuitFseventsSweepBackstop();

    registeredWillQuitHandler()({ defaultPrevented: false });

    // The live-instance leg reaches an exit (app.exit(0)) — never returns
    // without exiting. process.exit is the cloud leg and must not fire here.
    await vi.waitFor(() => {
      expect(electronModuleMock!.app.exit).toHaveBeenCalledExactlyOnceWith(0);
    });
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('records the will_quit_backstop trigger (no exitReason) in the ledger entry on the deterministic leg', async () => {
    liveNativeInstanceCount.mockReturnValue(3);
    sweepLeakedInstances.mockResolvedValue(3);
    const { registerWillQuitFseventsSweepBackstop } = await import('../finalExit');
    registerWillQuitFseventsSweepBackstop();

    registeredWillQuitHandler()({ defaultPrevented: false });

    await vi.waitFor(() => {
      expect(appendDiagnosticEvent).toHaveBeenCalledExactlyOnceWith({
        kind: 'fsevents_leak_sweep',
        data: { sweptCount: 3, trigger: 'will_quit_backstop' },
      });
    });
    // Deterministic leg DOES exit (through the primitive core), with code 0.
    await vi.waitFor(() => {
      expect(electronModuleMock!.app.exit).toHaveBeenCalledExactlyOnceWith(0);
    });
  });

  it('is inert on cloud surfaces (no electron module)', async () => {
    electronModuleMock = null;
    const { registerWillQuitFseventsSweepBackstop } = await import('../finalExit');

    expect(() => registerWillQuitFseventsSweepBackstop()).not.toThrow();
  });
});
