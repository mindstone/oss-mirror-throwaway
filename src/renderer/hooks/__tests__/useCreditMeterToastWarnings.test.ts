// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatHumanizedResetDate } from '@rebel/shared';
import { renderHook } from '../../test-utils/hookTestHarness';
import { useCreditMeterToastWarnings } from '../useCreditMeterToastWarnings';
import { tracking } from '@renderer/src/tracking';
import type { ManagedProviderInfo } from '@shared/types/managedProvider';
import type { SubscriptionState } from '@shared/types';

const DEFAULT_RESETS_AT = '2026-06-01T00:00:00.000Z';
const DEFAULT_PERIOD_KEY = '2026-06';
const DEFAULT_LIMIT = 20000;

type AllowanceThresholdLabel = '75' | '90';
type AllowanceThresholdBroadcastPayload = {
  periodKey: string;
  threshold: AllowanceThresholdLabel;
};

type MockBroadcastChannel = {
  name: string;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  triggerMessage: (payload: AllowanceThresholdBroadcastPayload) => void;
};

function buildSubscription(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    tier: 'dash',
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
    creditLimitMonthly: DEFAULT_LIMIT,
    creditUsedMonthly: 0,
    resetsAt: DEFAULT_RESETS_AT,
    currency: 'USD',
    period: 'month',
    ...overrides,
  };
}

function getFallbackPeriodKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

describe('useCreditMeterToastWarnings (Stage H4)', () => {
  let trackSpy: ReturnType<typeof vi.spyOn>;
  let channelInstances: MockBroadcastChannel[];

  beforeEach(() => {
    localStorage.clear();
    trackSpy = vi.spyOn(tracking.subscription, 'allowanceThresholdHit');

    channelInstances = [];
    const broadcastChannelCtor = vi.fn(function BroadcastChannelMock(name: string) {
      const channel: MockBroadcastChannel = {
        name,
        onmessage: null,
        postMessage: vi.fn(),
        close: vi.fn(),
        triggerMessage(payload: AllowanceThresholdBroadcastPayload) {
          this.onmessage?.({ data: payload } as MessageEvent<unknown>);
        },
      };
      channelInstances.push(channel);
      return channel;
    });
    vi.stubGlobal('BroadcastChannel', broadcastChannelCtor as unknown as typeof BroadcastChannel);
  });

  afterEach(() => {
    trackSpy.mockRestore();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('does not fire below 75%', () => {
    const showToast = vi.fn(() => 'toast-1');

    renderHook(() =>
      useCreditMeterToastWarnings({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 14000 }), // 70%
        subscription: buildSubscription(),
        showToast,
        openSettings: vi.fn(),
      }),
    );

    expect(showToast).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('fires the 75 toast and analytics event when crossing 75% but not 90%', () => {
    const showToast = vi.fn(() => 'toast-1');
    const formattedResetDate = formatHumanizedResetDate(DEFAULT_RESETS_AT);

    renderHook(() =>
      useCreditMeterToastWarnings({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 16000 }), // 80%
        subscription: buildSubscription(),
        showToast,
        openSettings: vi.fn(),
      }),
    );

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      title: "You've used 75% of your Mindstone allowance this month",
      description: `Resets on ${formattedResetDate}.`,
      variant: 'warning',
      duration: 10000,
    });
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith({ threshold: '75', tier: 'dash' });
  });

  it('fires both 75 and 90 toasts and analytics events in order when crossing 90%', () => {
    const showToast = vi.fn(() => 'toast-1');

    renderHook(() =>
      useCreditMeterToastWarnings({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 19000 }), // 95%
        subscription: buildSubscription(),
        showToast,
        openSettings: vi.fn(),
      }),
    );

    expect(showToast).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: "You've used 75% of your Mindstone allowance this month",
      }),
    );
    expect(showToast).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        title: "You've used 90% of your Mindstone allowance",
      }),
    );
    expect(trackSpy).toHaveBeenCalledTimes(2);
    expect(trackSpy).toHaveBeenNthCalledWith(1, { threshold: '75', tier: 'dash' });
    expect(trackSpy).toHaveBeenNthCalledWith(2, { threshold: '90', tier: 'dash' });
  });

  it('dedupes within the same period (resetsAt unchanged)', () => {
    const showToast = vi.fn(() => 'toast-1');

    const { rerender } = renderHook(
      (props: { used: number }) =>
        useCreditMeterToastWarnings({
          managedProvider: buildManagedProvider({
            creditUsedMonthly: props.used,
            resetsAt: DEFAULT_RESETS_AT,
          }),
          subscription: buildSubscription(),
          showToast,
          openSettings: vi.fn(),
        }),
      { initialProps: { used: 16000 } }, // 80% -> 75 only
    );

    expect(showToast).toHaveBeenCalledTimes(1);
    rerender({ used: 17000 }); // still only 75 crossed
    expect(showToast).toHaveBeenCalledTimes(1);
    rerender({ used: 19000 }); // now crosses 90
    expect(showToast).toHaveBeenCalledTimes(2);
    rerender({ used: 19800 }); // no duplicate
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(trackSpy).toHaveBeenCalledTimes(2);
  });

  it('re-fires after period reset (different resetsAt)', () => {
    const showToast = vi.fn(() => 'toast-1');

    const { rerender } = renderHook(
      (props: { resetsAt: string }) =>
        useCreditMeterToastWarnings({
          managedProvider: buildManagedProvider({
            creditUsedMonthly: 19500,
            resetsAt: props.resetsAt,
          }),
          subscription: buildSubscription(),
          showToast,
          openSettings: vi.fn(),
        }),
      { initialProps: { resetsAt: '2026-06-01T00:00:00.000Z' } },
    );

    expect(showToast).toHaveBeenCalledTimes(2);
    rerender({ resetsAt: '2026-07-01T00:00:00.000Z' });
    expect(showToast).toHaveBeenCalledTimes(4);
    expect(trackSpy).toHaveBeenCalledTimes(4);
  });

  it('skips emission when creditLimitMonthly is zero or missing', () => {
    const showToast = vi.fn(() => 'toast-1');

    const { rerender } = renderHook(
      (props: { creditLimitMonthly: number | undefined }) =>
        useCreditMeterToastWarnings({
          managedProvider: buildManagedProvider({
            creditUsedMonthly: 15000,
            creditLimitMonthly: props.creditLimitMonthly,
          }),
          subscription: buildSubscription(),
          showToast,
          openSettings: vi.fn(),
        }),
      { initialProps: { creditLimitMonthly: 0 as number | undefined } },
    );

    expect(showToast).not.toHaveBeenCalled();
    rerender({ creditLimitMonthly: undefined });
    expect(showToast).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('skips emission when creditUsedMonthly is undefined', () => {
    const showToast = vi.fn(() => 'toast-1');

    renderHook(() =>
      useCreditMeterToastWarnings({
        managedProvider: buildManagedProvider({
          creditUsedMonthly: undefined,
        }),
        subscription: buildSubscription(),
        showToast,
        openSettings: vi.fn(),
      }),
    );

    expect(showToast).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('skips emission when subscription is null', () => {
    const showToast = vi.fn(() => 'toast-1');

    renderHook(() =>
      useCreditMeterToastWarnings({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 19500 }),
        subscription: null,
        showToast,
        openSettings: vi.fn(),
      }),
    );

    expect(showToast).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('falls back to YYYY-MM bucket key when resetsAt is missing', () => {
    const showToast = vi.fn(() => 'toast-1');

    renderHook(() =>
      useCreditMeterToastWarnings({
        managedProvider: buildManagedProvider({
          creditUsedMonthly: 19500,
          resetsAt: undefined,
        }),
        subscription: buildSubscription(),
        showToast,
        openSettings: vi.fn(),
      }),
    );

    expect(showToast).toHaveBeenCalledTimes(2);
    const expectedKey = `subscription:allowanceToastWarnings:${getFallbackPeriodKey()}`;
    expect(localStorage.getItem(expectedKey)).toBe(JSON.stringify(['75', '90']));
  });

  it('segments analytics tier correctly for Rogue plan tier', () => {
    renderHook(() =>
      useCreditMeterToastWarnings({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 19500 }),
        subscription: buildSubscription({ tier: 'rogue' }),
        showToast: vi.fn(() => 'toast-1'),
        openSettings: vi.fn(),
      }),
    );

    expect(trackSpy).toHaveBeenNthCalledWith(1, { threshold: '75', tier: 'rogue' });
    expect(trackSpy).toHaveBeenNthCalledWith(2, { threshold: '90', tier: 'rogue' });
  });

  it('posts broadcast payload on fire and honors inbound cross-window dedup', () => {
    const showToast = vi.fn(() => 'toast-1');

    const { rerender } = renderHook(
      (props: { used: number }) =>
        useCreditMeterToastWarnings({
          managedProvider: buildManagedProvider({
            creditUsedMonthly: props.used,
            resetsAt: DEFAULT_RESETS_AT,
          }),
          subscription: buildSubscription(),
          showToast,
          openSettings: vi.fn(),
        }),
      { initialProps: { used: 14000 } }, // below 75
    );

    expect(channelInstances).toHaveLength(1);
    const channel = channelInstances[0];

    channel.triggerMessage({ periodKey: DEFAULT_PERIOD_KEY, threshold: '75' });

    rerender({ used: 16000 }); // crosses 75 locally but should be deduped by inbound message
    expect(showToast).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();

    rerender({ used: 19000 }); // 90 should still fire
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "You've used 90% of your Mindstone allowance",
      }),
    );
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith({ threshold: '90', tier: 'dash' });
    expect(channel.postMessage).toHaveBeenCalledWith({
      periodKey: DEFAULT_PERIOD_KEY,
      threshold: '90',
    });
  });

  it('passes Add your own key action at 90% and action click invokes openSettings', () => {
    const showToast = vi.fn(() => 'toast-1');
    const openSettings = vi.fn();

    renderHook(() =>
      useCreditMeterToastWarnings({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 19500 }),
        subscription: buildSubscription(),
        showToast,
        openSettings,
      }),
    );

    const calls = showToast.mock.calls as unknown as Array<
      [{ action?: { label: string; onClick: () => void } }]
    >;
    const secondToast = calls[1]?.[0];
    if (!secondToast) throw new Error('expected a second toast call');

    expect(secondToast.action).toEqual(
      expect.objectContaining({
        label: 'Add your own key',
        onClick: expect.any(Function),
      }),
    );
    secondToast.action?.onClick();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('suppresses both threshold toasts at and above 100% allowance usage', () => {
    // At ≥100% the Q7.1 exhaustion banner (Stage H2) owns the surface; the
    // 75/90 toasts must NOT fire on top of it.
    const showToast = vi.fn(() => 'toast-1');

    renderHook(() =>
      useCreditMeterToastWarnings({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 20000 }), // 100%
        subscription: buildSubscription(),
        showToast,
        openSettings: vi.fn(),
      }),
    );

    expect(showToast).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();

    renderHook(() =>
      useCreditMeterToastWarnings({
        managedProvider: buildManagedProvider({ creditUsedMonthly: 25000 }), // 125%
        subscription: buildSubscription(),
        showToast,
        openSettings: vi.fn(),
      }),
    );

    expect(showToast).not.toHaveBeenCalled();
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('normalises resetsAt to YYYY-MM so server precision drift in the same period does not re-fire', () => {
    // Two server ISOs that resolve to the same calendar month should produce
    // a single period bucket — no re-toast on a server precision/timezone
    // refresh.
    const showToast = vi.fn(() => 'toast-1');

    const { rerender } = renderHook(
      (props: { resetsAt: string }) =>
        useCreditMeterToastWarnings({
          managedProvider: buildManagedProvider({
            creditUsedMonthly: 19000, // 95% — crosses both thresholds
            resetsAt: props.resetsAt,
          }),
          subscription: buildSubscription(),
          showToast,
          openSettings: vi.fn(),
        }),
      { initialProps: { resetsAt: '2026-06-01T00:00:00.000Z' } },
    );

    expect(showToast).toHaveBeenCalledTimes(2);
    expect(trackSpy).toHaveBeenCalledTimes(2);

    // Same calendar month, different millis / sub-second precision — must
    // be deduped.
    rerender({ resetsAt: '2026-06-01T00:00:00.500Z' });
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(trackSpy).toHaveBeenCalledTimes(2);

    // Same calendar month, different day-of-month — still the same period
    // bucket (June 2026), so no re-fire.
    rerender({ resetsAt: '2026-06-15T12:00:00.000Z' });
    expect(showToast).toHaveBeenCalledTimes(2);
    expect(trackSpy).toHaveBeenCalledTimes(2);

    // Different calendar month — fresh period, must re-fire.
    rerender({ resetsAt: '2026-07-01T00:00:00.000Z' });
    expect(showToast).toHaveBeenCalledTimes(4);
    expect(trackSpy).toHaveBeenCalledTimes(4);
  });

  it('uses formatHumanizedResetDate for toast descriptions with fixed resetsAt', () => {
    const showToast = vi.fn(() => 'toast-1');
    const formattedResetDate = formatHumanizedResetDate(DEFAULT_RESETS_AT);

    renderHook(() =>
      useCreditMeterToastWarnings({
        managedProvider: buildManagedProvider({
          creditUsedMonthly: 16000,
          resetsAt: DEFAULT_RESETS_AT,
        }),
        subscription: buildSubscription(),
        showToast,
        openSettings: vi.fn(),
      }),
    );

    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: `Resets on ${formattedResetDate}.`,
      }),
    );
  });
});
