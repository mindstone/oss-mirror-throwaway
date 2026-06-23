// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test-utils/hookTestHarness';
import { useCreditMeterThresholdAnalytics } from '../useCreditMeterThresholdAnalytics';
import { tracking } from '@renderer/src/tracking';
import type { ManagedProviderInfo } from '@shared/types/managedProvider';
import type { SubscriptionState } from '@shared/types';

const TIER: SubscriptionState['tier'] = 'dash';

function buildSubscription(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    tier: TIER,
    status: 'active',
    currentPeriodEnd: '2026-06-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    graceEndsAt: null,
    routingAvailable: true,
    ...overrides,
  };
}

function buildManagedProvider(overrides: Partial<ManagedProviderInfo> = {}): ManagedProviderInfo {
  return {
    provider: 'openrouter',
    keyHash: 'hash-1',
    allowedModels: ['anthropic/claude-sonnet'],
    creditLimitMonthly: 20000, // $200
    creditUsedMonthly: 0,
    resetsAt: '2026-06-01T00:00:00.000Z',
    currency: 'USD',
    period: 'month',
    ...overrides,
  };
}

describe('useCreditMeterThresholdAnalytics (Stage B3)', () => {
  let trackSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    trackSpy = vi.spyOn(tracking.subscription, 'creditMeterThresholdHit');
  });

  afterEach(() => {
    trackSpy.mockRestore();
    localStorage.clear();
  });

  it('does not fire below 80%', () => {
    renderHook(() =>
      useCreditMeterThresholdAnalytics({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 15000 }), // 75%
        subscription: buildSubscription(),
      }),
    );
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('fires 80 threshold when crossing 80%', () => {
    renderHook(() =>
      useCreditMeterThresholdAnalytics({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 16500 }), // 82.5%
        subscription: buildSubscription(),
      }),
    );
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith({ threshold: '80', tier: 'dash' });
  });

  it('fires both 80 and 95 thresholds when crossing 95%', () => {
    renderHook(() =>
      useCreditMeterThresholdAnalytics({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 19500 }), // 97.5%
        subscription: buildSubscription(),
      }),
    );
    expect(trackSpy).toHaveBeenCalledTimes(2);
    expect(trackSpy).toHaveBeenCalledWith({ threshold: '80', tier: 'dash' });
    expect(trackSpy).toHaveBeenCalledWith({ threshold: '95', tier: 'dash' });
  });

  it('dedupes within the same period (resetsAt unchanged)', () => {
    const { rerender } = renderHook(
      (props: { used: number }) =>
        useCreditMeterThresholdAnalytics({
          managedProvider: buildManagedProvider({ creditUsedMonthly: props.used }),
          subscription: buildSubscription(),
        }),
      { initialProps: { used: 16500 } }, // 82.5%
    );
    expect(trackSpy).toHaveBeenCalledTimes(1);
    rerender({ used: 17000 }); // 85% — still 80 threshold already-fired
    expect(trackSpy).toHaveBeenCalledTimes(1);
    rerender({ used: 19000 }); // 95% exactly — should fire 95 once
    expect(trackSpy).toHaveBeenCalledTimes(2);
    rerender({ used: 19800 }); // still above 95, no duplicate
    expect(trackSpy).toHaveBeenCalledTimes(2);
  });

  it('re-fires after period reset (resetsAt changes)', () => {
    const { rerender } = renderHook(
      (props: { resetsAt: string; used: number }) =>
        useCreditMeterThresholdAnalytics({
          managedProvider: buildManagedProvider({
            creditUsedMonthly: props.used,
            resetsAt: props.resetsAt,
          }),
          subscription: buildSubscription(),
        }),
      { initialProps: { resetsAt: '2026-06-01T00:00:00.000Z', used: 19500 } },
    );
    expect(trackSpy).toHaveBeenCalledTimes(2); // both 80 + 95

    // Period resets — different storage key.
    rerender({ resetsAt: '2026-07-01T00:00:00.000Z', used: 19500 });
    expect(trackSpy).toHaveBeenCalledTimes(4); // both fire again
  });

  it('skips emission when credit limit is zero/missing', () => {
    renderHook(() =>
      useCreditMeterThresholdAnalytics({
        managedProvider: buildManagedProvider({
          creditLimitMonthly: 0,
          creditUsedMonthly: 1000,
        }),
        subscription: buildSubscription(),
      }),
    );
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('skips emission when credit used is undefined', () => {
    renderHook(() =>
      useCreditMeterThresholdAnalytics({
        managedProvider: buildManagedProvider({
          creditUsedMonthly: undefined,
        }),
        subscription: buildSubscription(),
      }),
    );
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('skips emission when subscription is null', () => {
    renderHook(() =>
      useCreditMeterThresholdAnalytics({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 19500 }),
        subscription: null,
      }),
    );
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('falls back to month-bucket key when resetsAt is missing', () => {
    renderHook(() =>
      useCreditMeterThresholdAnalytics({
        managedProvider: buildManagedProvider({
          creditUsedMonthly: 19500,
          resetsAt: undefined,
        }),
        subscription: buildSubscription(),
      }),
    );
    expect(trackSpy).toHaveBeenCalledTimes(2);
    // Persisted storage key should be YYYY-MM-bucketed.
    const persistedKeys = Object.keys(localStorage).filter((k) =>
      k.startsWith('subscription:creditMeterThresholds:'),
    );
    expect(persistedKeys).toHaveLength(1);
    expect(persistedKeys[0]).toMatch(/^subscription:creditMeterThresholds:\d{4}-\d{2}$/);
  });

  it('segments analytics by tier', () => {
    renderHook(() =>
      useCreditMeterThresholdAnalytics({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 19500 }),
        subscription: buildSubscription({ tier: 'rogue' }),
      }),
    );
    expect(trackSpy).toHaveBeenCalledWith({ threshold: '80', tier: 'rogue' });
    expect(trackSpy).toHaveBeenCalledWith({ threshold: '95', tier: 'rogue' });
  });
});
