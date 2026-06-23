/**
 * Stage 3b tests for the quit-deadlock telemetry helper
 * (docs/plans/260617_bricked-state-0448-electron42/PLAN.md).
 *
 * The load-bearing contract:
 *   - `emitQuitDeadlockDetected` writes the on-device ledger FIRST (survives a
 *     process exit where the Sentry capture is lost), THEN fires a
 *     registry-owned Sentry capture, THEN performs a BOUNDED flush.
 *   - `scheduleWindowsForceExitFallback` fires the emit + force-exit only after
 *     the budget elapses (the Windows path previously had NO force-exit timer).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WINDOWS_FORCE_EXIT_BUDGET_MS,
  emitQuitDeadlockDetected,
  scheduleWindowsForceExitFallback,
} from '../quitDeadlockTelemetry';

describe('emitQuitDeadlockDetected — ledger-first, bounded-flush ordering', () => {
  it('appends the diagnostic ledger event BEFORE flushing Sentry, and the capture fires in between', async () => {
    const callOrder: string[] = [];
    const appendDiagnosticEvent = vi.fn(() => {
      callOrder.push('append');
    });
    const captureKnownCondition = vi.fn(() => {
      callOrder.push('capture');
    });
    const flushMainSentry = vi.fn(async () => {
      callOrder.push('flush');
      return true;
    });

    await emitQuitDeadlockDetected('mac_tier2', {
      // The injected deps stand in for the real safe-by-construction sinks.
      appendDiagnosticEvent: appendDiagnosticEvent as never,
      captureKnownCondition: captureKnownCondition as never,
      flushMainSentry: flushMainSentry as never,
    });

    // CRITICAL ORDERING: ledger first, then Sentry capture, then bounded flush.
    expect(callOrder).toEqual(['append', 'capture', 'flush']);

    // Ledger record carries the closed tier + platform enum (redaction-safe).
    expect(appendDiagnosticEvent).toHaveBeenCalledWith({
      kind: 'quit_deadlock_detected',
      data: { tier: 'mac_tier2', platform: process.platform },
    });

    // Registry-owned capture passes the tier (drives the fingerprint split).
    const captureArgs = captureKnownCondition.mock.calls[0] as unknown[];
    expect(captureArgs[0]).toBe('quit_deadlock_detected');
    expect(captureArgs[1]).toMatchObject({ tier: 'mac_tier2' });
    expect(captureArgs[2]).toBeInstanceOf(Error);
  });

  it('passes a BOUNDED flush budget (<= 2000ms) to flushMainSentry', async () => {
    const flushMainSentry = vi.fn(async (_timeoutMs?: number) => true);
    await emitQuitDeadlockDetected('win', {
      appendDiagnosticEvent: vi.fn() as never,
      captureKnownCondition: vi.fn() as never,
      flushMainSentry: flushMainSentry as never,
    });
    const budget = flushMainSentry.mock.calls[0]?.[0];
    expect(budget).toBeLessThanOrEqual(2_000);
    expect(budget).toBeGreaterThan(0);
  });

  it('still writes the ledger and never throws when the Sentry capture throws', async () => {
    const appendDiagnosticEvent = vi.fn();
    const flushMainSentry = vi.fn(async () => true);
    const captureKnownCondition = vi.fn(() => {
      throw new Error('reporter down');
    });

    await expect(
      emitQuitDeadlockDetected('graceful_10s', {
        appendDiagnosticEvent: appendDiagnosticEvent as never,
        captureKnownCondition: captureKnownCondition as never,
        flushMainSentry: flushMainSentry as never,
      }),
    ).resolves.toBeUndefined();

    // Ledger (the durable record) still ran; the bounded flush still ran.
    expect(appendDiagnosticEvent).toHaveBeenCalledTimes(1);
    expect(flushMainSentry).toHaveBeenCalledTimes(1);
  });

  it('never throws when the bounded flush itself rejects (must not break the exit path)', async () => {
    await expect(
      emitQuitDeadlockDetected('mac_tier1', {
        appendDiagnosticEvent: vi.fn() as never,
        captureKnownCondition: vi.fn() as never,
        flushMainSentry: (vi.fn(async () => {
          throw new Error('flush exploded');
        })) as never,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('emitQuitDeadlockDetected — native-liveness snapshot threading (260622)', () => {
  const sampleLiveness = {
    fseventsLiveInstances: 3,
    moonshineSessions: 2,
    superMcpPid: 4242,
    superMcpRunning: true,
    lancedbConnections: { conversation: 1, file: 2, tool: 1 },
    embedding: { workerAlive: false, gpuBackendAlive: false, disposed: true },
  };

  it('threads the snapshot into BOTH the ledger data and the Sentry capture (extra + scalar tags) when provided', async () => {
    const appendDiagnosticEvent = vi.fn();
    const captureKnownCondition = vi.fn();
    const flushMainSentry = vi.fn(async () => true);

    await emitQuitDeadlockDetected(
      'mac_tier2',
      {
        appendDiagnosticEvent: appendDiagnosticEvent as never,
        captureKnownCondition: captureKnownCondition as never,
        flushMainSentry: flushMainSentry as never,
      },
      sampleLiveness,
    );

    // (a) survives-process-death ledger copy carries the full snapshot.
    expect(appendDiagnosticEvent).toHaveBeenCalledWith({
      kind: 'quit_deadlock_detected',
      data: { tier: 'mac_tier2', platform: process.platform, nativeLiveness: sampleLiveness },
    });

    // (b) Sentry capture: full object in extra, scalar counts as filterable tags.
    const ctx = (captureKnownCondition.mock.calls[0] as unknown[])[1] as {
      tags: Record<string, string>;
      extra: { nativeLiveness: typeof sampleLiveness };
    };
    expect(ctx.extra.nativeLiveness).toEqual(sampleLiveness);
    expect(ctx.tags).toMatchObject({
      native_fsevents_live: '3',
      native_moonshine_sessions: '2',
      native_lancedb_conv: '1',
      native_lancedb_file: '2',
      native_lancedb_tool: '1',
      native_supermcp_running: 'true',
    });
  });

  it('omits the snapshot cleanly when not provided (existing callers unchanged)', async () => {
    const appendDiagnosticEvent = vi.fn();
    const captureKnownCondition = vi.fn();
    const flushMainSentry = vi.fn(async () => true);

    await emitQuitDeadlockDetected('mac_tier1', {
      appendDiagnosticEvent: appendDiagnosticEvent as never,
      captureKnownCondition: captureKnownCondition as never,
      flushMainSentry: flushMainSentry as never,
    });

    // Ledger data is exactly { tier, platform } — no nativeLiveness key.
    expect(appendDiagnosticEvent).toHaveBeenCalledWith({
      kind: 'quit_deadlock_detected',
      data: { tier: 'mac_tier1', platform: process.platform },
    });
    const ctx = (captureKnownCondition.mock.calls[0] as unknown[])[1] as {
      tags: Record<string, string>;
      extra?: unknown;
    };
    expect(ctx.extra).toBeUndefined();
    expect(ctx.tags).not.toHaveProperty('native_fsevents_live');
  });
});

describe('scheduleWindowsForceExitFallback — fake-timer force-exit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT emit or force-exit before the budget elapses', async () => {
    const emit = vi.fn(async () => {});
    const forceExit = vi.fn();

    scheduleWindowsForceExitFallback({ emit, forceExit });

    await vi.advanceTimersByTimeAsync(WINDOWS_FORCE_EXIT_BUDGET_MS - 1);
    expect(emit).not.toHaveBeenCalled();
    expect(forceExit).not.toHaveBeenCalled();
  });

  it('emits quit_deadlock_detected(win) and THEN force-exits once the budget elapses', async () => {
    const order: string[] = [];
    const emit = vi.fn(async (tier: string) => {
      order.push(`emit:${tier}`);
    });
    const forceExit = vi.fn(() => {
      order.push('forceExit');
    });

    scheduleWindowsForceExitFallback({ emit, forceExit });

    await vi.advanceTimersByTimeAsync(WINDOWS_FORCE_EXIT_BUDGET_MS);
    expect(emit).toHaveBeenCalledWith('win');
    expect(forceExit).toHaveBeenCalledTimes(1);
    // Emit (ledger + bounded flush) completes before the force-exit.
    expect(order).toEqual(['emit:win', 'forceExit']);
  });

  it('still force-exits if the emit rejects (force-exit must not depend on telemetry)', async () => {
    const emit = vi.fn(async () => {
      throw new Error('emit failed');
    });
    const forceExit = vi.fn();

    scheduleWindowsForceExitFallback({ emit, forceExit });

    await vi.advanceTimersByTimeAsync(WINDOWS_FORCE_EXIT_BUDGET_MS);
    expect(forceExit).toHaveBeenCalledTimes(1);
  });

  it('does not fire if the timer is cleared before the budget (normal quit wins the race)', async () => {
    const emit = vi.fn(async () => {});
    const forceExit = vi.fn();

    const handle = scheduleWindowsForceExitFallback({ emit, forceExit });
    clearTimeout(handle);

    await vi.advanceTimersByTimeAsync(WINDOWS_FORCE_EXIT_BUDGET_MS + 1_000);
    expect(emit).not.toHaveBeenCalled();
    expect(forceExit).not.toHaveBeenCalled();
  });

  it('does NOT emit or force-exit when isStillStuck() is false at budget (defence-in-depth false-positive guard)', async () => {
    // The clearTimeout was somehow missed (timer/event race) but the quit is
    // genuinely proceeding — the in-callback gate must prevent a force-exit of
    // a normal install.
    const emit = vi.fn(async () => {});
    const forceExit = vi.fn();

    scheduleWindowsForceExitFallback({ emit, forceExit, isStillStuck: () => false });

    await vi.advanceTimersByTimeAsync(WINDOWS_FORCE_EXIT_BUDGET_MS + 1_000);
    expect(emit).not.toHaveBeenCalled();
    expect(forceExit).not.toHaveBeenCalled();
  });

  it('DOES emit+force-exit when isStillStuck() is true at budget (genuine hang)', async () => {
    const emit = vi.fn(async () => {});
    const forceExit = vi.fn();

    scheduleWindowsForceExitFallback({ emit, forceExit, isStillStuck: () => true });

    await vi.advanceTimersByTimeAsync(WINDOWS_FORCE_EXIT_BUDGET_MS);
    expect(emit).toHaveBeenCalledWith('win');
    expect(forceExit).toHaveBeenCalledTimes(1);
  });
});
