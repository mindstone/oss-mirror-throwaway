import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSchedulerLogger, mockPowerMonitor } = vi.hoisted(() => {
  const resumeHandlers = new Set<() => void>();
  return {
    mockSchedulerLogger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    },
    mockPowerMonitor: {
      on: (event: string, handler: () => void): void => {
        if (event === 'resume') resumeHandlers.add(handler);
      },
      removeListener: (event: string, handler: () => void): void => {
        if (event === 'resume') resumeHandlers.delete(handler);
      },
      isOnBatteryPower: (): boolean => false,
      /** Test-only: fire the `resume` event to all live subscribers. */
      emitResume: (): void => {
        for (const handler of [...resumeHandlers]) handler();
      },
      /** Test-only: number of live `resume` subscribers (for cleanup assertions). */
      resumeHandlerCount: (): number => resumeHandlers.size,
    },
  };
});

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockSchedulerLogger,
  createTurnSessionLogger: () => mockSchedulerLogger,
}));

 
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => ({
    BrowserWindow: {
      getFocusedWindow: vi.fn().mockReturnValue(null),
    },
    powerMonitor: mockPowerMonitor,
  }),
}));

 
vi.mock('@core/services/autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import {
  createBackgroundConsumerLatch,
  _resetForTesting,
  _resetBackgroundConsumerLatchesForTesting,
  _simulateWatchdogFireForTesting,
  type BackgroundConsumerLatch,
} from '../visibilityAwareScheduler';

const trackedTurnIds = new Set<string>();
let counter = 0;

function nextTurnId(): string {
  counter += 1;
  const id = `degraded-test-${counter}`;
  trackedTurnIds.add(id);
  return id;
}

function registerTurn(turnId: string): AbortController {
  const controller = new AbortController();
  agentTurnRegistry.setActiveTurnController(turnId, controller);
  return controller;
}

function findStructuredCall(
  spy: ReturnType<typeof vi.fn>,
  predicate: (data: Record<string, unknown>, msg: string) => boolean,
): [Record<string, unknown>, string] | undefined {
  for (const call of spy.mock.calls) {
    const [data, msg] = call as [unknown, unknown];
    if (
      data && typeof data === 'object' &&
      typeof msg === 'string' &&
      predicate(data as Record<string, unknown>, msg)
    ) {
      return [data as Record<string, unknown>, msg];
    }
  }
  return undefined;
}

describe('visibilityAwareScheduler — degraded-mode latch (F10)', () => {
  let latch: BackgroundConsumerLatch | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetForTesting();
    _resetBackgroundConsumerLatchesForTesting();
  });

  afterEach(() => {
    latch?.dispose();
    latch = null;
    _resetBackgroundConsumerLatchesForTesting();
    _resetForTesting();
    for (const turnId of trackedTurnIds) {
      try { agentTurnRegistry.cleanupTurn(turnId); } catch { /* ignore */ }
    }
    trackedTurnIds.clear();
    vi.useRealTimers();
  });

  it('starts in armed state when no turn is active', () => {
    latch = createBackgroundConsumerLatch('test-consumer', { watchdogTimeoutMs: 5_000 });
    expect(latch.getState()).toBe('armed');
    expect(latch.shouldDeferForTurnActive()).toBe(false);
    expect(latch.getPausedSinceMs()).toBeNull();
  });

  it('starts in paused state when a turn is already active at construction', () => {
    const t1 = nextTurnId();
    registerTurn(t1);

    latch = createBackgroundConsumerLatch('test-consumer', { watchdogTimeoutMs: 5_000 });
    expect(latch.getState()).toBe('paused');
    expect(latch.shouldDeferForTurnActive()).toBe(true);
    expect(latch.getPausedSinceMs()).not.toBeNull();
  });

  describe('normal pause/resume cycle', () => {
    it('paused → armed transition fires resume waiter and clears pausedSinceMs', async () => {
      latch = createBackgroundConsumerLatch('test-consumer', { watchdogTimeoutMs: 5_000 });
      expect(latch.getState()).toBe('armed');

      const t1 = nextTurnId();
      registerTurn(t1);
      expect(latch.getState()).toBe('paused');

      const waitPromise = latch.waitUntilResumeOrDegraded();

      agentTurnRegistry.cleanupTurn(t1);

      await expect(waitPromise).resolves.toEqual({ outcome: 'resumed' });
      expect(latch.getState()).toBe('armed');
      expect(latch.getPausedSinceMs()).toBeNull();
    });

    it('does not pause again after resume on a fresh engagement (cycles normally)', () => {
      latch = createBackgroundConsumerLatch('test-consumer', { watchdogTimeoutMs: 5_000 });

      const t1 = nextTurnId();
      registerTurn(t1);
      expect(latch.getState()).toBe('paused');
      agentTurnRegistry.cleanupTurn(t1);
      expect(latch.getState()).toBe('armed');

      const t2 = nextTurnId();
      registerTurn(t2);
      expect(latch.getState()).toBe('paused');
      agentTurnRegistry.cleanupTurn(t2);
      expect(latch.getState()).toBe('armed');
    });
  });

  describe('watchdog fire → degraded mode', () => {
    it('paused → degraded transition resumes immediately for real stuckness and emits structured warn log', async () => {
      latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 5_000 });

      const t1 = nextTurnId();
      registerTurn(t1);
      expect(latch.getState()).toBe('paused');

      const waitPromise = latch.waitUntilResumeOrDegraded();

      // Fire watchdog manually to avoid relying on timer internals.
      _simulateWatchdogFireForTesting(latch);

      await expect(waitPromise).resolves.toEqual({
        outcome: 'degraded',
        reason: 'stuck_active_turn_signal',
      });
      expect(latch.getState()).toBe('degraded');
      expect(latch.shouldDeferForTurnActive()).toBe(false);
      expect(latch.isInDegradedMode()).toBe(true);

      const entry = findStructuredCall(
        mockSchedulerLogger.warn,
        (data, msg) =>
          msg === 'Indexer/embedder degraded mode entered: active-turn signal stuck with no recent progress' &&
          (data as { reason?: unknown }).reason === 'stuck_active_turn_signal',
      );
      expect(entry).toBeDefined();
      const [data] = entry!;
      expect(data.turnIds).toEqual([t1]);
      expect(data.watchdogTimeoutMs).toBe(5_000);
      expect(data.stuckThresholdMs).toBe(5_000);
      expect(typeof data.pauseDurationMs).toBe('number');
      expect((data.pauseDurationMs as number) >= 0).toBe(true);
      expect(data.stuckTurnId).toBe(t1);
      expect(data.stuckTurnMissingProgress).toBe(true);
      expect(data.activeTurnProgressSnapshot).toEqual([
        { turnId: t1, lastProgressAt: null },
      ]);
    });

    it('watchdog fires through real timer when timeout elapses', () => {
      latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 1_000 });

      const t1 = nextTurnId();
      registerTurn(t1);
      expect(latch.getState()).toBe('paused');

      vi.advanceTimersByTime(1_000);
      expect(latch.getState()).toBe('degraded');
    });

    it('real stuck branch: signal true and no progress for 6 minutes enters degraded mode', async () => {
      latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 6 * 60 * 1_000 });
      const t1 = nextTurnId();
      registerTurn(t1);
      expect(latch.getState()).toBe('paused');

      const waitPromise = latch.waitUntilResumeOrDegraded();
      vi.advanceTimersByTime(6 * 60 * 1_000);

      await expect(waitPromise).resolves.toEqual({
        outcome: 'degraded',
        reason: 'stuck_active_turn_signal',
      });
      expect(latch.getState()).toBe('degraded');

      const entry = findStructuredCall(
        mockSchedulerLogger.warn,
        (data, msg) =>
          msg === 'Indexer/embedder degraded mode entered: active-turn signal stuck with no recent progress' &&
          (data as { reason?: unknown }).reason === 'stuck_active_turn_signal',
      );
      expect(entry).toBeDefined();
    });

    it('concurrent turns: missing progress on one active turn degrades and reports stuck turnId', async () => {
      latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 10 * 60 * 1_000 });
      const turnA = nextTurnId();
      const turnB = nextTurnId();
      registerTurn(turnA);
      registerTurn(turnB);
      expect(latch.getState()).toBe('paused');

      vi.advanceTimersByTime(30_000);
      agentTurnRegistry.markTurnProgress(turnB);
      const turnBProgressAt = agentTurnRegistry.getLastProgressAt(turnB);

      const waitPromise = latch.waitUntilResumeOrDegraded();
      _simulateWatchdogFireForTesting(latch);

      await expect(waitPromise).resolves.toEqual({
        outcome: 'degraded',
        reason: 'stuck_active_turn_signal',
      });
      expect(latch.getState()).toBe('degraded');

      const entry = findStructuredCall(
        mockSchedulerLogger.warn,
        (data, msg) =>
          msg === 'Indexer/embedder degraded mode entered: active-turn signal stuck with no recent progress' &&
          (data as { reason?: unknown }).reason === 'stuck_active_turn_signal',
      );
      expect(entry).toBeDefined();
      const [data] = entry!;
      expect(data.stuckTurnId).toBe(turnA);
      expect(data.stuckTurnIds).toEqual([turnA]);
      expect(data.activeTurnProgressSnapshot).toEqual([
        { turnId: turnA, lastProgressAt: null },
        { turnId: turnB, lastProgressAt: turnBProgressAt },
      ]);
    });

    it('concurrent turns: stale progress on one active turn degrades and reports that turnId', async () => {
      latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 10 * 60 * 1_000 });
      const turnA = nextTurnId();
      const turnB = nextTurnId();
      registerTurn(turnA);
      registerTurn(turnB);
      expect(latch.getState()).toBe('paused');

      const baseline = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(baseline);
      agentTurnRegistry.markTurnProgress(turnA);
      const turnAProgressAt = agentTurnRegistry.getLastProgressAt(turnA);
      vi.setSystemTime(new Date(baseline.getTime() + (7 * 60 * 1_000)));
      agentTurnRegistry.markTurnProgress(turnB);
      const turnBProgressAt = agentTurnRegistry.getLastProgressAt(turnB);

      const waitPromise = latch.waitUntilResumeOrDegraded();
      _simulateWatchdogFireForTesting(latch);

      await expect(waitPromise).resolves.toEqual({
        outcome: 'degraded',
        reason: 'stuck_active_turn_signal',
      });
      expect(latch.getState()).toBe('degraded');

      const entry = findStructuredCall(
        mockSchedulerLogger.warn,
        (data, msg) =>
          msg === 'Indexer/embedder degraded mode entered: active-turn signal stuck with no recent progress' &&
          (data as { reason?: unknown }).reason === 'stuck_active_turn_signal',
      );
      expect(entry).toBeDefined();
      const [data] = entry!;
      expect(data.stuckTurnId).toBe(turnA);
      expect(data.stuckTurnIds).toEqual([turnA]);
      expect(data.stuckTurnLastProgressAt).toBe(turnAProgressAt);
      expect((data.stuckTurnStalledMs as number) >= 7 * 60 * 1_000).toBe(true);
      expect(data.stuckTurnMissingProgress).toBe(false);
      expect(data.activeTurnProgressSnapshot).toEqual([
        { turnId: turnA, lastProgressAt: turnAProgressAt },
        { turnId: turnB, lastProgressAt: turnBProgressAt },
      ]);
    });

    it('active-but-long branch: signal true with recent progress logs info and does not degrade', async () => {
      latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 6 * 60 * 1_000 });
      const t1 = nextTurnId();
      registerTurn(t1);
      expect(latch.getState()).toBe('paused');

      vi.advanceTimersByTime(4 * 60 * 1_000);
      agentTurnRegistry.markTurnProgress(t1);

      const waitPromise = latch.waitUntilResumeOrDegraded();
      vi.advanceTimersByTime(1 * 60 * 1_000);

      expect(latch.getState()).toBe('paused');
      expect(mockSchedulerLogger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'stuck_active_turn_signal' }),
        expect.any(String),
      );

      const activeLongEntry = findStructuredCall(
        mockSchedulerLogger.info,
        (data, msg) =>
          msg === 'Indexer/embedder active-turn signal remains active with recent progress; staying paused' &&
          (data as { reason?: unknown }).reason === 'long_running_active_turn_signal',
      );
      expect(activeLongEntry).toBeDefined();

      agentTurnRegistry.cleanupTurn(t1);
      await expect(waitPromise).resolves.toEqual({ outcome: 'resumed' });
      expect(latch.getState()).toBe('armed');
    });

    it('concurrent turns: all active turns with recent progress stay long-running and do not degrade', async () => {
      latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 10 * 60 * 1_000 });
      const turnA = nextTurnId();
      const turnB = nextTurnId();
      registerTurn(turnA);
      registerTurn(turnB);
      expect(latch.getState()).toBe('paused');

      vi.advanceTimersByTime(4 * 60 * 1_000);
      agentTurnRegistry.markTurnProgress(turnA);
      const turnAProgressAt = agentTurnRegistry.getLastProgressAt(turnA);
      vi.advanceTimersByTime(30_000);
      agentTurnRegistry.markTurnProgress(turnB);
      const turnBProgressAt = agentTurnRegistry.getLastProgressAt(turnB);

      const waitPromise = latch.waitUntilResumeOrDegraded();
      _simulateWatchdogFireForTesting(latch);

      expect(latch.getState()).toBe('paused');
      expect(mockSchedulerLogger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'stuck_active_turn_signal' }),
        expect.any(String),
      );

      const activeLongEntry = findStructuredCall(
        mockSchedulerLogger.info,
        (data, msg) =>
          msg === 'Indexer/embedder active-turn signal remains active with recent progress; staying paused' &&
          (data as { reason?: unknown }).reason === 'long_running_active_turn_signal',
      );
      expect(activeLongEntry).toBeDefined();
      const [data] = activeLongEntry!;
      expect(data.mostStalledTurnId).toBe(turnA);
      expect(data.activeTurnProgressSnapshot).toEqual([
        { turnId: turnA, lastProgressAt: turnAProgressAt },
        { turnId: turnB, lastProgressAt: turnBProgressAt },
      ]);

      agentTurnRegistry.cleanupTurn(turnA);
      agentTurnRegistry.cleanupTurn(turnB);
      await expect(waitPromise).resolves.toEqual({ outcome: 'resumed' });
      expect(latch.getState()).toBe('armed');
    });

    it('leak-label branch: no active turns still emits MEMORY LEAK DETECTED reason and degrades', async () => {
      latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 5_000 });
      const t1 = nextTurnId();
      registerTurn(t1);
      expect(latch.getState()).toBe('paused');

      const waitPromise = latch.waitUntilResumeOrDegraded();
      const hasAnyActiveTurnSpy = vi.spyOn(agentTurnRegistry, 'hasAnyActiveTurn').mockReturnValue(false);
      const getActiveTurnIdsSpy = vi.spyOn(agentTurnRegistry, 'getActiveTurnIds').mockReturnValue([]);
      try {
        _simulateWatchdogFireForTesting(latch);
      } finally {
        hasAnyActiveTurnSpy.mockRestore();
        getActiveTurnIdsSpy.mockRestore();
      }

      await expect(waitPromise).resolves.toEqual({
        outcome: 'degraded',
        reason: 'leaked_active_turn_signal',
      });
      expect(latch.getState()).toBe('degraded');
      const leakEntry = findStructuredCall(
        mockSchedulerLogger.warn,
        (data, msg) =>
          msg === 'Indexer/embedder degraded mode entered: MEMORY LEAK DETECTED in active-turn pause latch' &&
          (data as { reason?: unknown }).reason === 'leaked_active_turn_signal',
      );
      expect(leakEntry).toBeDefined();
    });

    it('indexer trigger contract: degraded resumes only after progress becomes stale', async () => {
      latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 6 * 60 * 1_000 });
      const t1 = nextTurnId();
      registerTurn(t1);
      expect(latch.getState()).toBe('paused');

      vi.advanceTimersByTime(4 * 60 * 1_000);
      agentTurnRegistry.markTurnProgress(t1);

      let settled: Awaited<ReturnType<typeof latch.waitUntilResumeOrDegraded>> | null = null;
      const waitPromise = latch.waitUntilResumeOrDegraded().then((result) => {
        settled = result;
        return result;
      });

      // First watchdog check lands at 5 minutes from pause-start, sees recent
      // progress, and keeps the latch paused (no degraded trigger yet).
      vi.advanceTimersByTime(1 * 60 * 1_000);
      await Promise.resolve();
      expect(settled).toBeNull();
      expect(latch.getState()).toBe('paused');

      // Once the same turn stops making progress long enough, the watchdog
      // emits degraded and waiting consumers resume fail-open.
      vi.advanceTimersByTime(5 * 60 * 1_000);
      await expect(waitPromise).resolves.toEqual({
        outcome: 'degraded',
        reason: 'stuck_active_turn_signal',
      });
      expect(latch.getState()).toBe('degraded');
    });

    it('does not pause again on subsequent engagements while in degraded', () => {
      latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 1_000 });
      const t1 = nextTurnId();
      registerTurn(t1);
      _simulateWatchdogFireForTesting(latch);
      expect(latch.getState()).toBe('degraded');

      // Another turn engages (e.g. retry loop firing while signal still set).
      const t2 = nextTurnId();
      registerTurn(t2);
      expect(latch.getState()).toBe('degraded');
      expect(latch.shouldDeferForTurnActive()).toBe(false);

      agentTurnRegistry.cleanupTurn(t2);
      // Still degraded — t1 keeps the signal high.
      expect(latch.getState()).toBe('degraded');
    });
  });

  describe('degraded → armed-after-clear → armed transitions', () => {
    it('signal clears → degraded → armed-after-clear with info exit log', () => {
      latch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 1_000 });

      const t1 = nextTurnId();
      registerTurn(t1);
      _simulateWatchdogFireForTesting(latch);
      expect(latch.getState()).toBe('degraded');

      agentTurnRegistry.cleanupTurn(t1);
      expect(latch.getState()).toBe('armed-after-clear');

      const exit = findStructuredCall(
        mockSchedulerLogger.info,
        (data, msg) =>
          msg === 'Indexer/embedder degraded mode exited' &&
          (data as { recoveryReason?: unknown }).recoveryReason === 'signal_cleared_and_reengaged',
      );
      expect(exit).toBeDefined();
      const [data] = exit!;
      expect(typeof data.pauseDurationMs).toBe('number');
    });

    it('next active turn after armed-after-clear does NOT pause (latch suppressed)', () => {
      latch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 1_000 });

      const t1 = nextTurnId();
      registerTurn(t1);
      _simulateWatchdogFireForTesting(latch);
      agentTurnRegistry.cleanupTurn(t1);
      expect(latch.getState()).toBe('armed-after-clear');

      const t2 = nextTurnId();
      registerTurn(t2);
      // Latch suppresses the pause-on-engage; transitions back to armed.
      expect(latch.getState()).toBe('armed');
      expect(latch.shouldDeferForTurnActive()).toBe(false);
    });

    it('full cycle — armed-after-clear → armed → paused on next engagement', () => {
      latch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 1_000 });

      const t1 = nextTurnId();
      registerTurn(t1);
      _simulateWatchdogFireForTesting(latch);
      agentTurnRegistry.cleanupTurn(t1);
      expect(latch.getState()).toBe('armed-after-clear');

      const t2 = nextTurnId();
      registerTurn(t2);
      expect(latch.getState()).toBe('armed');

      agentTurnRegistry.cleanupTurn(t2);
      expect(latch.getState()).toBe('armed');

      const t3 = nextTurnId();
      registerTurn(t3);
      expect(latch.getState()).toBe('paused');
      expect(latch.shouldDeferForTurnActive()).toBe(true);

      agentTurnRegistry.cleanupTurn(t3);
      expect(latch.getState()).toBe('armed');
    });
  });

  describe('rapid signal flapping does not churn watchdog timers', () => {
    it('multiple cleanup/setActive cycles before watchdog fire reuse a single watchdog window', () => {
      latch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 1_000 });

      const t1 = nextTurnId();
      registerTurn(t1);
      // First registration: paused, watchdog started.
      expect(latch.getState()).toBe('paused');

      // Adding a second turn while paused: no churn.
      const t2 = nextTurnId();
      registerTurn(t2);
      expect(latch.getState()).toBe('paused');

      // Drop one — the count is still > 0 so the registry does NOT fire its
      // turn-idle listener and the latch stays paused.
      agentTurnRegistry.cleanupTurn(t1);
      expect(latch.getState()).toBe('paused');

      agentTurnRegistry.cleanupTurn(t2);
      expect(latch.getState()).toBe('armed');
    });
  });

  describe('waitUntilResumeOrDegraded', () => {
    it('resolves "resumed" immediately when not paused', async () => {
      latch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 1_000 });
      await expect(latch.waitUntilResumeOrDegraded()).resolves.toEqual({ outcome: 'resumed' });
    });

    it('resolves "aborted" when the signal aborts mid-pause', async () => {
      latch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 5_000 });

      const t1 = nextTurnId();
      registerTurn(t1);

      const controller = new AbortController();
      const waitPromise = latch.waitUntilResumeOrDegraded(controller.signal);
      controller.abort();

      await expect(waitPromise).resolves.toEqual({ outcome: 'aborted' });
    });

    it('resolves "aborted" immediately for a pre-aborted signal', async () => {
      latch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 5_000 });
      const t1 = nextTurnId();
      registerTurn(t1);

      const controller = new AbortController();
      controller.abort();

      await expect(latch.waitUntilResumeOrDegraded(controller.signal)).resolves.toEqual({
        outcome: 'aborted',
      });
    });
  });

  describe('dispose', () => {
    it('cancels pending watchdog and unsubscribes', () => {
      latch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 1_000 });
      const t1 = nextTurnId();
      registerTurn(t1);
      expect(latch.getState()).toBe('paused');

      latch.dispose();
      // Subsequent registry mutations must not transition disposed latch.
      const beforeState = latch.getState();
      agentTurnRegistry.cleanupTurn(t1);
      expect(latch.getState()).toBe(beforeState);
    });

    it('resolves pending waiters as "resumed" so callers do not hang', async () => {
      latch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 5_000 });
      const t1 = nextTurnId();
      registerTurn(t1);

      const waitPromise = latch.waitUntilResumeOrDegraded();
      latch.dispose();

      await expect(waitPromise).resolves.toEqual({ outcome: 'resumed' });
    });

    it('is idempotent', () => {
      latch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 5_000 });
      latch.dispose();
      expect(() => latch?.dispose()).not.toThrow();
    });

    it('unsubscribes the powerMonitor resume listener on dispose', () => {
      const before = mockPowerMonitor.resumeHandlerCount();
      latch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 5_000 });
      expect(mockPowerMonitor.resumeHandlerCount()).toBe(before + 1);
      latch.dispose();
      expect(mockPowerMonitor.resumeHandlerCount()).toBe(before);
    });
  });

  describe('sleep/wake resilience (Stage 7) — powerMonitor resume re-baselines progress', () => {
    it('sleep jump + resume event: healthy long-running turn does NOT enter degraded mode', () => {
      latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 10 * 60 * 1_000 });
      const t1 = nextTurnId();
      registerTurn(t1);
      expect(latch.getState()).toBe('paused');

      // Healthy turn makes progress just before the machine sleeps.
      const baseline = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(baseline);
      agentTurnRegistry.markTurnProgress(t1);

      // Laptop sleeps for 3h: wall clock jumps forward while lastProgressAt is frozen.
      vi.setSystemTime(new Date(baseline.getTime() + (3 * 60 * 60 * 1_000)));

      // OS fires `resume` on wake → re-baseline progress + reset grace window.
      mockPowerMonitor.emitResume();

      // Watchdog fires after the resume re-baseline; the 3h gap was absorbed so the
      // turn looks freshly active and the latch stays paused (not degraded).
      _simulateWatchdogFireForTesting(latch);

      expect(latch.getState()).toBe('paused');
      expect(mockSchedulerLogger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'stuck_active_turn_signal' }),
        expect.any(String),
      );

      const rebaselineEntry = findStructuredCall(
        mockSchedulerLogger.info,
        (data, msg) =>
          msg === 'Background consumer re-baselined active-turn progress after power resume; watchdog grace window reset' &&
          Array.isArray((data as { turnIds?: unknown }).turnIds),
      );
      expect(rebaselineEntry).toBeDefined();

      const longRunningEntry = findStructuredCall(
        mockSchedulerLogger.info,
        (data, msg) =>
          msg === 'Indexer/embedder active-turn signal remains active with recent progress; staying paused' &&
          (data as { reason?: unknown }).reason === 'long_running_active_turn_signal',
      );
      expect(longRunningEntry).toBeDefined();

      agentTurnRegistry.cleanupTurn(t1);
      expect(latch.getState()).toBe('armed');
    });

    it('genuine >threshold stall with NO resume event still enters degraded stuck_active_turn_signal', async () => {
      latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 10 * 60 * 1_000 });
      const t1 = nextTurnId();
      registerTurn(t1);
      expect(latch.getState()).toBe('paused');

      const baseline = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(baseline);
      agentTurnRegistry.markTurnProgress(t1);

      // Genuine stall: 6 min pass (> 5 min stuckThreshold) with NO powerMonitor resume.
      vi.setSystemTime(new Date(baseline.getTime() + (6 * 60 * 1_000)));

      const waitPromise = latch.waitUntilResumeOrDegraded();
      _simulateWatchdogFireForTesting(latch);

      await expect(waitPromise).resolves.toEqual({
        outcome: 'degraded',
        reason: 'stuck_active_turn_signal',
      });
      expect(latch.getState()).toBe('degraded');

      const stuckEntry = findStructuredCall(
        mockSchedulerLogger.warn,
        (data, msg) =>
          msg === 'Indexer/embedder degraded mode entered: active-turn signal stuck with no recent progress' &&
          (data as { reason?: unknown }).reason === 'stuck_active_turn_signal',
      );
      expect(stuckEntry).toBeDefined();
      const [data] = stuckEntry!;
      expect(data.stuckTurnId).toBe(t1);
      expect((data.stuckTurnStalledMs as number) >= 6 * 60 * 1_000).toBe(true);
    });
  });
});
