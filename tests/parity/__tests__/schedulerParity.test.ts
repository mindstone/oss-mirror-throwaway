import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scheduler, SchedulerTimerHandle } from '@core/scheduler';
import {
  INTERACTIVE_DEFERRAL_DEFAULTS,
  createAutomationRunDeduper,
  evaluateRateLimitCooldownRule,
  scheduleDefinitionWithMaxTimeout,
  waitForInteractiveTurnToSettle,
} from '@core/services/automation/automationRules';
import { ElectronScheduler } from '@main/services/scheduler/electronScheduler';
import { _resetForTesting as resetVisibilitySchedulerForTesting } from '@main/services/visibilityAwareScheduler';
import { CloudScheduler } from '../../../cloud-service/src/services/scheduler/cloudScheduler';

interface MutableDefinition {
  id: string;
  delayMs: number;
}

const POLL_INTERVAL_MS = INTERACTIVE_DEFERRAL_DEFAULTS.POLL_INTERVAL_MS;
const GRACE_MS = INTERACTIVE_DEFERRAL_DEFAULTS.GRACE_MS;

async function runSharedRuleScenario(scheduler: Scheduler): Promise<{
  firedAt: number[];
  nextRunAts: number[];
  deferral: Awaited<ReturnType<typeof waitForInteractiveTurnToSettle>>;
}> {
  const definition: MutableDefinition = { id: 'adapter-rule', delayMs: 350 };
  const timers = new Map<string, SchedulerTimerHandle>();
  const firedAt: number[] = [];
  const nextRunAts: number[] = [];
  let interactiveTurnActive = true;

  scheduleDefinitionWithMaxTimeout<MutableDefinition>({
    definitionId: definition.id,
    timers,
    scheduler,
    maxTimeoutMs: 100,
    getDefinitionById: (id) => (id === definition.id ? definition : undefined),
    calculateNextRunAt: (freshDefinition, fromMs) => fromMs + freshDefinition.delayMs,
    onNextRunAt: (_definition, nextRunAt) => {
      nextRunAts.push(nextRunAt);
    },
    onFire: () => {
      firedAt.push(scheduler.now());
    },
  });

  scheduler.registerTimeout(() => {
    definition.delayMs = 20;
  }, 90);

  scheduler.registerTimeout(() => {
    interactiveTurnActive = false;
  }, POLL_INTERVAL_MS);

  const deferralPromise = waitForInteractiveTurnToSettle({
    hasInteractiveTurn: () => interactiveTurnActive,
    isShuttingDown: () => false,
    scheduler,
    waitForVisible: true,
    maxDeferralMs: 30_000,
    pollIntervalMs: POLL_INTERVAL_MS,
    graceMs: GRACE_MS,
  });

  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + GRACE_MS);

  return {
    firedAt,
    nextRunAts,
    deferral: await deferralPromise,
  };
}

describe('scheduler parity contracts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetVisibilitySchedulerForTesting();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetVisibilitySchedulerForTesting();
  });

  it('rate-limit cooldown rule returns deterministic defer decisions', () => {
    expect(
      evaluateRateLimitCooldownRule({
        isAvailable: true,
        remainingMs: 9999,
      }),
    ).toEqual({
      shouldDefer: false,
      deferMs: 0,
      reason: null,
    });

    expect(
      evaluateRateLimitCooldownRule({
        isAvailable: false,
        remainingMs: -15,
        reason: 'API rate-limit cooldown active',
      }),
    ).toEqual({
      shouldDefer: true,
      deferMs: 0,
      reason: 'API rate-limit cooldown active',
    });
  });

  it('dedup rule blocks duplicate starts until finish', () => {
    const deduper = createAutomationRunDeduper();

    expect(deduper.tryStart('automation-a')).toBe(true);
    expect(deduper.tryStart('automation-a')).toBe(false);
    expect(deduper.isRunning('automation-a')).toBe(true);

    deduper.finish('automation-a');
    expect(deduper.isRunning('automation-a')).toBe(false);
    expect(deduper.tryStart('automation-a')).toBe(true);
  });

  it('interactive-turn deferral is deterministic with fake timers', async () => {
    const scheduler = new CloudScheduler();
    let interactiveTurnActive = true;

    scheduler.registerTimeout(() => {
      interactiveTurnActive = false;
    }, POLL_INTERVAL_MS);

    const resultPromise = waitForInteractiveTurnToSettle({
      hasInteractiveTurn: () => interactiveTurnActive,
      isShuttingDown: () => false,
      scheduler,
      pollIntervalMs: POLL_INTERVAL_MS,
      graceMs: GRACE_MS,
      maxDeferralMs: 30_000,
    });

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + GRACE_MS);
    const result = await resultPromise;

    expect(result).toEqual({
      deferred: true,
      deferredMs: POLL_INTERVAL_MS + GRACE_MS,
      timedOut: false,
      shuttingDown: false,
    });
  });

  it('MAX_TIMEOUT chained timer re-reads fresh definition before fire', async () => {
    const scheduler = new CloudScheduler();
    const definition: MutableDefinition = { id: 'max-timeout-rule', delayMs: 350 };
    const timers = new Map<string, SchedulerTimerHandle>();
    const firedAt: number[] = [];
    const nextRunAts: number[] = [];

    scheduleDefinitionWithMaxTimeout<MutableDefinition>({
      definitionId: definition.id,
      timers,
      scheduler,
      maxTimeoutMs: 100,
      getDefinitionById: (id) => (id === definition.id ? definition : undefined),
      calculateNextRunAt: (freshDefinition, fromMs) => fromMs + freshDefinition.delayMs,
      onNextRunAt: (_definition, nextRunAt) => {
        nextRunAts.push(nextRunAt);
      },
      onFire: () => {
        firedAt.push(scheduler.now());
      },
    });

    scheduler.registerTimeout(() => {
      definition.delayMs = 20;
    }, 90);

    await vi.advanceTimersByTimeAsync(120);

    expect(nextRunAts).toEqual([350, 120]);
    expect(firedAt).toEqual([120]);
  });

  it('desktop and cloud scheduler adapters make identical fire decisions for shared rule scenarios', async () => {
    const desktopResult = await runSharedRuleScenario(new ElectronScheduler());

    vi.clearAllTimers();
    vi.setSystemTime(0);
    resetVisibilitySchedulerForTesting();

    const cloudResult = await runSharedRuleScenario(new CloudScheduler());

    expect(desktopResult).toEqual(cloudResult);
    expect(cloudResult.firedAt).toEqual([120]);
    expect(cloudResult.deferral.deferredMs).toBe(POLL_INTERVAL_MS + GRACE_MS);
  });
});
