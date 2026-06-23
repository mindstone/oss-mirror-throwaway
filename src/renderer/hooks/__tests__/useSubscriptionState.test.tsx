// @vitest-environment happy-dom
/**
 * Tests for useSubscriptionState — focuses on the tier-aware refresh()
 * predicate that gates the post-checkout retry loop on the matching tier.
 *
 * Context: docs-private/investigations/260520_pro_to_expert_upgrade_not_reflected.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionState } from '@shared/types';
import { act, flushAsync, renderHook } from '../../test-utils/hookTestHarness';
import { useSubscriptionState } from '../useSubscriptionState';

type WindowWithApis = Partial<Record<'api' | 'subscriptionApi', unknown>>;

function makeSubscription(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    tier: 'dash',
    status: 'active',
    currentPeriodEnd: '2026-06-20T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    graceEndsAt: null,
    routingAvailable: true,
    ...overrides,
  };
}

function installSubscriptionApi(getStatus: () => Promise<{ subscription: SubscriptionState | null }>) {
  Object.defineProperty(window, 'subscriptionApi', {
    configurable: true,
    value: { getStatus: vi.fn(getStatus) },
  });
}

function installRendererApiStub() {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onAuthConfigReceived: () => () => {},
      onSubscriptionCallback: () => () => {},
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as WindowWithApis).subscriptionApi;
  delete (window as WindowWithApis).api;
});

describe('useSubscriptionState refresh() with expectedTier', () => {
  beforeEach(() => {
    installRendererApiStub();
  });

  it('returns true when fetched tier matches expectedTier', async () => {
    installSubscriptionApi(async () => ({ subscription: makeSubscription({ tier: 'rogue' }) }));

    const { result } = renderHook(() => useSubscriptionState());
    await flushAsync();

    let outcome: boolean | void = false;
    await act(async () => {
      outcome = await result.current.refresh('rogue');
    });
    expect(outcome).toBe(true);
  });

  it('returns false when fetched tier does not match expectedTier', async () => {
    // Active Dash plan subscription, but caller is waiting for the Rogue webhook
    // to land. Without the tier check this would short-circuit as success.
    installSubscriptionApi(async () => ({ subscription: makeSubscription({ tier: 'dash' }) }));

    const { result } = renderHook(() => useSubscriptionState());
    await flushAsync();

    let outcome: boolean | void = true;
    await act(async () => {
      outcome = await result.current.refresh('rogue');
    });
    expect(outcome).toBe(false);
  });

  it('returns true when no expectedTier is supplied and a subscription exists', async () => {
    installSubscriptionApi(async () => ({ subscription: makeSubscription() }));

    const { result } = renderHook(() => useSubscriptionState());
    await flushAsync();

    let outcome: boolean | void = false;
    await act(async () => {
      outcome = await result.current.refresh();
    });
    expect(outcome).toBe(true);
  });

  it('returns false when subscription is null even with no expectedTier', async () => {
    installSubscriptionApi(async () => ({ subscription: null }));

    const { result } = renderHook(() => useSubscriptionState());
    await flushAsync();

    let outcome: boolean | void = true;
    await act(async () => {
      outcome = await result.current.refresh();
    });
    expect(outcome).toBe(false);
  });

  // Pins the no-expectation branch: success is `sub !== null`, regardless of
  // status. Routing the WITH-expectation path through the shared
  // isExpectedSubscriptionState predicate must NOT start applying entitled-status
  // checks here (GPT-5.5 plan-review F2) — a non-entitled status with no expected
  // tier still resolves the immediate refresh.
  it.each(['past_due', 'canceled', 'incomplete', 'inactive'] as const)(
    'returns true with no expectedTier even when status is %s (no-expectation branch unchanged)',
    async (status) => {
      installSubscriptionApi(async () => ({ subscription: makeSubscription({ status }) }));

      const { result } = renderHook(() => useSubscriptionState());
      await flushAsync();

      let outcome: boolean | void = false;
      await act(async () => {
        outcome = await result.current.refresh();
      });
      expect(outcome).toBe(true);
    },
  );

  it('returns false when expectedTier is supplied but subscription is null (first-time subscribe race)', async () => {
    installSubscriptionApi(async () => ({ subscription: null }));

    const { result } = renderHook(() => useSubscriptionState());
    await flushAsync();

    let outcome: boolean | void = true;
    await act(async () => {
      outcome = await result.current.refresh('dash');
    });
    expect(outcome).toBe(false);
  });

  it('returns false when tier matches expectedTier but subscription status is incomplete', async () => {
    // Tier match alone is insufficient — webhook may have created a row at
    // the requested tier but in `incomplete` state pending payment confirmation.
    installSubscriptionApi(async () => ({
      subscription: makeSubscription({ tier: 'rogue', status: 'incomplete' }),
    }));

    const { result } = renderHook(() => useSubscriptionState());
    await flushAsync();

    let outcome: boolean | void = true;
    await act(async () => {
      outcome = await result.current.refresh('rogue');
    });
    expect(outcome).toBe(false);
  });

  it('returns true when tier matches expectedTier and subscription is trialing', async () => {
    installSubscriptionApi(async () => ({
      subscription: makeSubscription({ tier: 'rogue', status: 'trialing' }),
    }));

    const { result } = renderHook(() => useSubscriptionState());
    await flushAsync();

    let outcome: boolean | void = false;
    await act(async () => {
      outcome = await result.current.refresh('rogue');
    });
    expect(outcome).toBe(true);
  });

  it.each(['pro', 'mystery'])('rejects an IPC subscription response with unknown tier %s', async (tier) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installSubscriptionApi(async () => ({
      subscription: makeSubscription({ tier: tier as SubscriptionState['tier'] }),
    }));

    const { result } = renderHook(() => useSubscriptionState());
    await flushAsync();

    expect(result.current.subscription).toBeNull();
    expect(result.current.phase).toBe('ready');
    expect(result.current.isActive).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        rawSubscription: expect.objectContaining({ tier }),
        issues: expect.any(Array),
      }),
      '[useSubscriptionState] Malformed subscription payload from subscription:get-status; rejecting',
    );
  });

  it('rejects an IPC subscription response with malformed non-tier fields', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installSubscriptionApi(async () => ({
      subscription: {
        ...makeSubscription(),
        status: 'totally-bogus',
      } as unknown as SubscriptionState,
    }));

    const { result } = renderHook(() => useSubscriptionState());
    await flushAsync();

    expect(result.current.subscription).toBeNull();
    expect(result.current.phase).toBe('ready');
    expect(result.current.isActive).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ issues: expect.any(Array) }),
      '[useSubscriptionState] Malformed subscription payload from subscription:get-status; rejecting',
    );
  });

  it('recovers when a valid IPC payload arrives after rejecting an unknown tier', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({
        subscription: makeSubscription({ tier: 'expert' as SubscriptionState['tier'] }),
      })
      .mockResolvedValueOnce({
        subscription: makeSubscription({ tier: 'rogue' }),
      });
    installSubscriptionApi(getStatus);

    const { result } = renderHook(() => useSubscriptionState());
    await flushAsync();

    expect(result.current.subscription).toBeNull();
    expect(result.current.isActive).toBe(false);

    let outcome: boolean | void = false;
    await act(async () => {
      outcome = await result.current.refresh('rogue');
    });

    expect(outcome).toBe(true);
    expect(result.current.subscription).toMatchObject({ tier: 'rogue', status: 'active' });
    expect(result.current.isActive).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        rawSubscription: expect.objectContaining({ tier: 'expert' }),
      }),
      '[useSubscriptionState] Malformed subscription payload from subscription:get-status; rejecting',
    );
  });
});
