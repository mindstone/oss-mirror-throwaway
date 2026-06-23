import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudErrorCategory } from '@core/services/cloud/cloudErrorCategory';

const mockSendToAllWindows = vi.hoisted(() => vi.fn());
vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ sendToAllWindows: mockSendToAllWindows });
});

import { CloudFailureCooldown } from '../cloudFailureCooldown';

const networkFetchFailed: CloudErrorCategory = { kind: 'network', subkind: 'fetch_failed' };

type CaptureContext = {
  level: 'warning' | 'info';
  extra: Record<string, unknown>;
};

type CaptureMessage = (message: string, context: CaptureContext) => void;

function installCaptureHooks(cooldown: CloudFailureCooldown, captureMessage: CaptureMessage): void {
  cooldown.setObservabilityHooks({
    onDegradedEnter: ({ category, writer, escalationLevel, consecutiveFailures }) => {
      captureMessage('cloud_connection_degraded', {
        level: 'warning',
        extra: { category, writer, escalationLevel, consecutiveFailures },
      });
    },
    onDegradedEscalated: ({ category, writer, escalationLevel, consecutiveFailures }) => {
      captureMessage('cloud_connection_degraded_escalated', {
        level: 'warning',
        extra: { category, writer, escalationLevel, consecutiveFailures },
      });
    },
    onDegradedExit: ({ downtimeMs, ticksToRecovery, lastCategory, lastWriter }) => {
      captureMessage('cloud_connection_recovered', {
        level: 'info',
        extra: {
          downtime_ms: downtimeMs,
          ticks_to_recovery: ticksToRecovery,
          lastCategory,
          lastWriter,
        },
      });
    },
  });
}

describe('CloudFailureCooldown', () => {
  let cooldown: CloudFailureCooldown;

  beforeEach(() => {
    cooldown = new CloudFailureCooldown();
    mockSendToAllWindows.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is available by default', () => {
    expect(cooldown.isAvailable()).toBe(true);
  });

  it('remains available after fewer than 3 failures', () => {
    cooldown.recordFailure();
    cooldown.recordFailure();
    expect(cooldown.isAvailable()).toBe(true);
  });

  it('becomes unavailable after 3 consecutive failures', () => {
    for (let i = 0; i < 3; i++) cooldown.recordFailure();
    expect(cooldown.isAvailable()).toBe(false);
  });

  // --- Escalation levels ---

  it('uses 30s cooldown at 3 failures', () => {
    for (let i = 0; i < 3; i++) cooldown.recordFailure();
    expect(cooldown._getState().currentCooldownMs).toBe(30_000);
    expect(cooldown.isAvailable()).toBe(false);

    vi.advanceTimersByTime(29_999);
    expect(cooldown.isAvailable()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(cooldown.isAvailable()).toBe(true);
  });

  it('escalates to 2min cooldown at 6 failures', () => {
    for (let i = 0; i < 6; i++) cooldown.recordFailure();
    expect(cooldown._getState().currentCooldownMs).toBe(120_000);
    expect(cooldown.isAvailable()).toBe(false);

    vi.advanceTimersByTime(119_999);
    expect(cooldown.isAvailable()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(cooldown.isAvailable()).toBe(true);
  });

  it('escalates to 5min cooldown at 10 failures', () => {
    for (let i = 0; i < 10; i++) cooldown.recordFailure();
    expect(cooldown._getState().currentCooldownMs).toBe(300_000);
  });

  it('escalates to 15min cooldown at 15 failures', () => {
    for (let i = 0; i < 15; i++) cooldown.recordFailure();
    expect(cooldown._getState().currentCooldownMs).toBe(900_000);
  });

  it('caps at 15min cooldown for any number of failures beyond 15', () => {
    for (let i = 0; i < 50; i++) cooldown.recordFailure();
    expect(cooldown._getState().currentCooldownMs).toBe(900_000);
  });

  // --- degradedSince ---

  it('sets degradedSince on first failure', () => {
    const now = Date.now();
    cooldown.recordFailure();
    expect(cooldown.getDegradedSince()).toBe(now);
  });

  it('does not update degradedSince on subsequent failures', () => {
    cooldown.recordFailure();
    const firstDegraded = cooldown.getDegradedSince();

    vi.advanceTimersByTime(5000);
    cooldown.recordFailure();
    expect(cooldown.getDegradedSince()).toBe(firstDegraded);
  });

  it('clears degradedSince on success', () => {
    cooldown.recordFailure();
    expect(cooldown.getDegradedSince()).not.toBeNull();

    cooldown.recordSuccess();
    expect(cooldown.getDegradedSince()).toBeNull();
  });

  it('records a partial feeder verdict as failure and does not clear active cooldown', () => {
    for (let i = 0; i < 3; i++) cooldown.recordFailure();
    expect(cooldown.isAvailable()).toBe(false);

    cooldown.recordCooldownVerdict({ ok: 1, failed: 1, authFailures: 0, sampleError: new Error('item failed') });

    expect(cooldown.isAvailable()).toBe(false);
    expect(cooldown.getDegradedSince()).not.toBeNull();
    expect(cooldown._getState().consecutiveFailures).toBe(4);
  });

  it('records an auth-failure feeder verdict as failure', () => {
    cooldown.recordCooldownVerdict({ ok: 2, failed: 0, authFailures: 1, sampleError: new Error('HTTP 401') });

    expect(cooldown.getDegradedSince()).not.toBeNull();
    expect(cooldown._getState().consecutiveFailures).toBe(1);
  });

  it('records an all-ok feeder verdict with the same recovery state as recordSuccess()', () => {
    const legacy = new CloudFailureCooldown();
    for (let i = 0; i < 3; i++) {
      cooldown.recordFailure();
      legacy.recordFailure();
    }

    cooldown.recordCooldownVerdict({ ok: 1, failed: 0, authFailures: 0 });
    legacy.recordSuccess();

    expect(cooldown.getState()).toEqual(legacy.getState());
    expect(cooldown._getState()).toEqual(legacy._getState());
  });

  // --- Recovery trigger ---

  it('triggers recovery when degraded exceeds threshold', () => {
    for (let i = 0; i < 3; i++) cooldown.recordFailure();

    vi.advanceTimersByTime(300_000); // 5 minutes
    expect(cooldown.shouldTriggerRecovery(300_000)).toBe(true);
  });

  it('does not trigger recovery before threshold', () => {
    for (let i = 0; i < 3; i++) cooldown.recordFailure();

    vi.advanceTimersByTime(299_999);
    expect(cooldown.shouldTriggerRecovery(300_000)).toBe(false);
  });

  it('only triggers recovery once per degraded period', () => {
    for (let i = 0; i < 3; i++) cooldown.recordFailure();

    vi.advanceTimersByTime(300_000);
    expect(cooldown.shouldTriggerRecovery(300_000)).toBe(true);
    expect(cooldown.shouldTriggerRecovery(300_000)).toBe(false);
  });

  it('re-triggers recovery after success and new degraded period', () => {
    for (let i = 0; i < 3; i++) cooldown.recordFailure();
    vi.advanceTimersByTime(300_000);
    expect(cooldown.shouldTriggerRecovery(300_000)).toBe(true);

    cooldown.recordSuccess();

    for (let i = 0; i < 3; i++) cooldown.recordFailure();
    vi.advanceTimersByTime(300_000);
    expect(cooldown.shouldTriggerRecovery(300_000)).toBe(true);
  });

  it('does not trigger when not degraded', () => {
    expect(cooldown.shouldTriggerRecovery(300_000)).toBe(false);
  });

  // --- Broadcasts ---

  it('broadcasts cloud:circuit-state on failure', () => {
    cooldown.recordFailure();
    expect(mockSendToAllWindows).toHaveBeenCalledWith('cloud:circuit-state', expect.objectContaining({
      consecutiveFailures: 1,
      degradedSince: expect.any(Number),
    }));
  });

  it('broadcasts cloud:circuit-state on success after being degraded', () => {
    cooldown.recordFailure();
    mockSendToAllWindows.mockClear();

    cooldown.recordSuccess();
    expect(mockSendToAllWindows).toHaveBeenCalledWith('cloud:circuit-state', expect.objectContaining({
      available: true,
      consecutiveFailures: 0,
      degradedSince: null,
    }));
  });

  it('does not broadcast on success when never degraded', () => {
    cooldown.recordSuccess();
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });

  // --- getState ---

  it('returns full state via getState()', () => {
    const state = cooldown.getState();
    expect(state).toEqual({
      available: true,
      consecutiveFailures: 0,
      cooldownMs: 0,
      degradedSince: null,
    });
  });

  // --- Reset ---

  it('resets fully via reset()', () => {
    for (let i = 0; i < 10; i++) cooldown.recordFailure();
    cooldown.reset();

    expect(cooldown.isAvailable()).toBe(true);
    expect(cooldown.getDegradedSince()).toBeNull();
    expect(cooldown._getState().currentCooldownMs).toBe(0);
    expect(cooldown._getState().recoveryTriggered).toBe(false);
  });

  it('broadcasts cloud:circuit-state on reset() when degraded', () => {
    for (let i = 0; i < 3; i++) cooldown.recordFailure();
    mockSendToAllWindows.mockClear();

    cooldown.reset();
    expect(mockSendToAllWindows).toHaveBeenCalledWith('cloud:circuit-state', expect.objectContaining({
      available: true,
      consecutiveFailures: 0,
      degradedSince: null,
    }));
  });

  it('does not broadcast on reset() when not degraded', () => {
    cooldown.reset();
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });

  it('resets fully on success', () => {
    for (let i = 0; i < 10; i++) cooldown.recordFailure();
    cooldown.recordSuccess();

    expect(cooldown.isAvailable()).toBe(true);
    expect(cooldown._getState().consecutiveFailures).toBe(0);
    expect(cooldown._getState().degradedSince).toBeNull();
  });

  // --- Probe after cooldown ---

  it('allows probe after cooldown and re-enters on failure', () => {
    for (let i = 0; i < 3; i++) cooldown.recordFailure();
    expect(cooldown.isAvailable()).toBe(false);

    vi.advanceTimersByTime(30_000);
    expect(cooldown.isAvailable()).toBe(true);

    cooldown.recordFailure(); // probe failed
    expect(cooldown.isAvailable()).toBe(false);
  });

  // --- Graceful broadcast failure ---

  it('handles broadcast service not ready gracefully', () => {
    mockSendToAllWindows.mockImplementation(() => { throw new Error('not ready'); });

    for (let i = 0; i < 3; i++) cooldown.recordFailure();
    expect(cooldown.isAvailable()).toBe(false);

    cooldown.recordSuccess();
    expect(cooldown.isAvailable()).toBe(true);
  });

  describe('observability', () => {
    it('captures cloud_connection_degraded on first failure (degradedSince undefined → set)', () => {
      const captureMessage = vi.fn<CaptureMessage>();
      installCaptureHooks(cooldown, captureMessage);

      cooldown.recordFailure({ writer: 'startup-health', category: networkFetchFailed });

      expect(captureMessage).toHaveBeenCalledTimes(1);
      expect(captureMessage).toHaveBeenCalledWith(
        'cloud_connection_degraded',
        expect.objectContaining({
          level: 'warning',
          extra: expect.objectContaining({
            category: networkFetchFailed,
            writer: 'startup-health',
            escalationLevel: 0,
            consecutiveFailures: 1,
          }),
        }),
      );
    });

    it('captures escalation transitions exactly once per level during a synthetic 100-failure storm', () => {
      const captureMessage = vi.fn<CaptureMessage>();
      installCaptureHooks(cooldown, captureMessage);

      for (let i = 0; i < 100; i++) {
        cooldown.recordFailure({ writer: 'startup-health', category: networkFetchFailed });
      }

      expect(captureMessage).toHaveBeenCalledTimes(5);
      expect(captureMessage.mock.calls.map(([message]) => message)).toEqual([
        'cloud_connection_degraded',
        'cloud_connection_degraded_escalated',
        'cloud_connection_degraded_escalated',
        'cloud_connection_degraded_escalated',
        'cloud_connection_degraded_escalated',
      ]);
      expect(captureMessage.mock.calls.slice(1).map(([, context]) => context.extra.escalationLevel)).toEqual([0, 1, 2, 3]);
      expect(captureMessage.mock.calls.slice(1).map(([, context]) => context.extra.consecutiveFailures)).toEqual([3, 6, 10, 15]);
    });

    it('captures cloud_connection_recovered exactly once on degraded → healthy transition', () => {
      const captureMessage = vi.fn<CaptureMessage>();
      installCaptureHooks(cooldown, captureMessage);

      cooldown.recordFailure({ writer: 'startup-health', category: networkFetchFailed });
      captureMessage.mockClear();
      vi.advanceTimersByTime(1234);

      cooldown.recordSuccess({ writer: 'focus' });

      expect(captureMessage).toHaveBeenCalledTimes(1);
      expect(captureMessage).toHaveBeenCalledWith(
        'cloud_connection_recovered',
        expect.objectContaining({
          level: 'info',
          extra: expect.objectContaining({
            downtime_ms: expect.any(Number),
            ticks_to_recovery: 1,
            lastCategory: networkFetchFailed,
            lastWriter: 'focus',
          }),
        }),
      );
    });

    it('does NOT re-capture cloud_connection_recovered if recordSuccess fires while not degraded', () => {
      const captureMessage = vi.fn<CaptureMessage>();
      installCaptureHooks(cooldown, captureMessage);

      cooldown.recordSuccess({ writer: 'focus' });

      expect(captureMessage).not.toHaveBeenCalled();
    });

    it('keeps cooldown flow alive when an observability hook throws', () => {
      cooldown.setObservabilityHooks({
        onDegradedEnter: () => {
          throw new Error('Sentry transport unavailable');
        },
      });

      expect(() => cooldown.recordFailure({ writer: 'startup-health', category: networkFetchFailed })).not.toThrow();
      expect(cooldown.getDegradedSince()).not.toBeNull();
    });
  });

  // --- A11: diagnostic events ledger emits (cooldown-active axis, not degradedSince) ---

  describe('diagnostic events ledger emits', () => {
    let appendSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      appendSpy = vi.fn();
       
      vi.doMock('@core/services/diagnosticEventsLedger', () => ({
        appendDiagnosticEvent: appendSpy,
      }));
      const { CloudFailureCooldown: ReloadedClass } = await import('../cloudFailureCooldown');
      cooldown = new ReloadedClass();
    });

    afterEach(() => {
      vi.doUnmock('@core/services/diagnosticEventsLedger');
    });

    it('emits cooldown_enter only on inactive→active cooldown transition (3rd failure)', () => {
      cooldown.recordFailure();
      cooldown.recordFailure();
      // Two failures: degraded but not yet in cooldown — must NOT emit cooldown_enter.
      expect(appendSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'cooldown_enter' }),
      );

      cooldown.recordFailure();
      // 3rd failure crosses isAvailable() threshold → cooldown_enter once.
      const enterCalls = appendSpy.mock.calls.filter(
        ([entry]) => entry?.kind === 'cooldown_enter',
      );
      expect(enterCalls).toHaveLength(1);
      expect(enterCalls[0][0]).toMatchObject({
        kind: 'cooldown_enter',
        data: { scope: 'cloud', retryAfterProvided: false },
      });

      // 4th failure (still in same cooldown) — must NOT re-emit cooldown_enter.
      cooldown.recordFailure();
      const enterCallsAfter = appendSpy.mock.calls.filter(
        ([entry]) => entry?.kind === 'cooldown_enter',
      );
      expect(enterCallsAfter).toHaveLength(1);
    });

    it('emits cooldown_exit only when active→inactive (recordSuccess from in-cooldown state)', () => {
      // recordSuccess on healthy state — must NOT emit cooldown_exit.
      cooldown.recordSuccess();
      expect(appendSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'cooldown_exit' }),
      );

      // 1 failure: degraded but not in cooldown. recordSuccess clears, must NOT emit cooldown_exit.
      cooldown.recordFailure();
      cooldown.recordSuccess();
      expect(appendSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'cooldown_exit' }),
      );

      // Cross threshold then recover — emit exactly one cooldown_exit.
      for (let i = 0; i < 3; i++) cooldown.recordFailure();
      cooldown.recordSuccess();
      const exitCalls = appendSpy.mock.calls.filter(
        ([entry]) => entry?.kind === 'cooldown_exit',
      );
      expect(exitCalls).toHaveLength(1);
      expect(exitCalls[0][0]).toMatchObject({
        kind: 'cooldown_exit',
        data: { scope: 'cloud', reason: 'success' },
      });
    });
  });

  describe('superseded outcomes (F1)', () => {
    it('records neither success nor failure for a superseded sync', () => {
      const cd = new CloudFailureCooldown();
      for (let i = 0; i < 6; i++) {
        cd.recordCooldownVerdict({ ok: 0, failed: 1, authFailures: 0 });
      }
      expect(cd.isAvailable()).toBe(false); // degraded + within cooldown window

      // A superseded outcome (connection changed mid-flight) must be ignored —
      // it neither resets the failure streak nor escalates the cooldown.
      cd.recordCooldownVerdict({ ok: 0, failed: 0, authFailures: 0, superseded: true });
      expect(cd.isAvailable()).toBe(false);

      // Sanity: a real success DOES clear the streak — proves the assertion
      // above is meaningful (superseded is not silently behaving like success).
      cd.recordCooldownVerdict({ ok: 1, failed: 0, authFailures: 0 });
      expect(cd.isAvailable()).toBe(true);
    });
  });
});
