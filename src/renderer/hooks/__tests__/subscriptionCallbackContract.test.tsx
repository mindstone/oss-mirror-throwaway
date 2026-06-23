// @vitest-environment happy-dom
/**
 * Cross-surface contract test for the subscription-checkout reconciliation
 * lifecycle — the test the `subscription_checkout_eventual_consistency` family
 * never had. It binds the main→renderer `subscription:callback` seam to the
 * renderer's retry loop and asserts the two properties that the three timing
 * postmortems came from:
 *
 *  1. The IPC payload main emits and the renderer parses share ONE schema
 *     (`SubscriptionCallbackPayloadSchema`), so `expectedTier` cannot drift
 *     between producer and consumer (a malformed tier degrades, never crashes).
 *  2. When a `success` callback carries `expectedTier`, the renderer keeps
 *     polling until the OBSERVED tier equals the expected tier — a stale active
 *     subscription on the OLD tier never reconciles it (the dash→rogue upgrade
 *     race, 260531_wait_for_tier_change_after_stripe).
 *
 * The main-side `.finally(emit)` ordering invariant (bug #1) is pinned in
 * src/main/subscription/__tests__/subscriptionCheckoutRetry.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionState } from '@shared/types';
import {
  SubscriptionCallbackPayloadSchema,
  coerceSubscriptionCallbackPayload,
  type SubscriptionCallbackPayload,
} from '@shared/ipc/channels/subscription';
import {
  act,
  flushAsync,
  renderHook,
  setupFakeTimers,
  cleanupFakeTimers,
} from '../../test-utils/hookTestHarness';
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

describe('subscription:callback payload contract (main ↔ preload schema)', () => {
  it('accepts the shapes main emits and round-trips expectedTier', () => {
    const success = SubscriptionCallbackPayloadSchema.safeParse({ status: 'success', expectedTier: 'rogue' });
    expect(success.success).toBe(true);
    expect(success.success && success.data.expectedTier).toBe('rogue');

    const firstTime = SubscriptionCallbackPayloadSchema.safeParse({ status: 'success' });
    expect(firstTime.success).toBe(true);
    expect(firstTime.success && firstTime.data.expectedTier).toBeUndefined();

    const cancel = SubscriptionCallbackPayloadSchema.safeParse({ status: 'cancel' });
    expect(cancel.success).toBe(true);
  });

  it('rejects a malformed expectedTier so the bridge degrades to status-only instead of forwarding garbage', () => {
    const bad = SubscriptionCallbackPayloadSchema.safeParse({ status: 'success', expectedTier: 'platinum' });
    expect(bad.success).toBe(false);
  });

  // The bridge's tolerant parse (the path the preload listener actually runs).
  describe('coerceSubscriptionCallbackPayload (preload bridge fallback)', () => {
    it('returns the validated payload on a schema match', () => {
      expect(coerceSubscriptionCallbackPayload({ status: 'success', expectedTier: 'rogue' })).toEqual({
        status: 'success',
        expectedTier: 'rogue',
      });
    });

    it('degrades a malformed expectedTier to status-only (never forwards garbage, never drops the callback)', () => {
      // A future/unknown tier the schema does not know yet must not crash or be
      // forwarded — the renderer falls back to its no-expectation refresh.
      expect(coerceSubscriptionCallbackPayload({ status: 'success', expectedTier: 'platinum' })).toEqual({
        status: 'success',
      });
    });

    it('preserves a plain status string with no expectedTier', () => {
      expect(coerceSubscriptionCallbackPayload({ status: 'cancel' })).toEqual({ status: 'cancel' });
    });

    it.each([null, undefined, 42, 'success', {}, { status: 123 }])(
      'returns null for an unusable payload (%s)',
      (input) => {
        expect(coerceSubscriptionCallbackPayload(input)).toBeNull();
      },
    );
  });
});

describe('renderer reconciliation lifecycle on subscription:callback', () => {
  // Mutable server-observed subscription; get-status reads it live each call.
  let observed: SubscriptionState | null;
  let getStatus: ReturnType<typeof vi.fn>;
  // Captured handler the preload bridge would invoke.
  let deliverCallback: ((data: SubscriptionCallbackPayload) => void) | null;

  beforeEach(() => {
    setupFakeTimers();
    observed = makeSubscription({ tier: 'dash', status: 'active' });
    getStatus = vi.fn(async () => ({ subscription: observed }));
    deliverCallback = null;

    Object.defineProperty(window, 'subscriptionApi', {
      configurable: true,
      value: { getStatus },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onAuthConfigReceived: () => () => {},
        onSubscriptionCallback: (cb: (data: SubscriptionCallbackPayload) => void) => {
          deliverCallback = cb;
          return () => {
            deliverCallback = null;
          };
        },
      },
    });
  });

  afterEach(() => {
    cleanupFakeTimers();
    vi.restoreAllMocks();
    delete (window as WindowWithApis).subscriptionApi;
    delete (window as WindowWithApis).api;
  });

  it('polls past a stale active OLD-tier subscription until the expected upgrade tier is observed', async () => {
    const { result } = renderHook(() => useSubscriptionState());
    await flushAsync(); // mount refresh — observes stale dash
    expect(result.current.subscription?.tier).toBe('dash');

    // Main emits success + the upgrade target. Renderer must NOT reconcile on the
    // pre-existing active dash row.
    await act(async () => {
      deliverCallback?.({ status: 'success', expectedTier: 'rogue' });
    });
    await flushAsync(); // immediate refresh inside refreshWithRetry — still dash, keeps polling
    expect(result.current.subscription?.tier).toBe('dash');

    // Webhook lands: server now reports rogue. Advance one backoff tick.
    observed = makeSubscription({ tier: 'rogue', status: 'active' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.subscription?.tier).toBe('rogue');
    expect(result.current.isActive).toBe(true);
    // Proves it actually polled rather than short-circuiting on the stale dash:
    // mount + immediate + at least one backoff retry.
    expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('never reconciles to the expected tier while only the stale tier is observed (exhausts the retry budget)', async () => {
    const { result } = renderHook(() => useSubscriptionState());
    await flushAsync();

    await act(async () => {
      deliverCallback?.({ status: 'success', expectedTier: 'rogue' });
    });
    // Drive the full renderer backoff budget [2000,3000,4000,5000,5000]; server
    // stays on the stale active dash the entire time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000 + 3000 + 4000 + 5000 + 5000);
    });

    // The observed tier is still dash — the renderer never treated dash as rogue.
    expect(result.current.subscription?.tier).toBe('dash');
    // It kept polling: mount + immediate + 5 backoff retries.
    expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(7);
  });

  it('does a single plain refresh (no tier-gated polling) for a non-success callback', async () => {
    renderHook(() => useSubscriptionState());
    await flushAsync();
    const callsAfterMount = getStatus.mock.calls.length;

    await act(async () => {
      deliverCallback?.({ status: 'cancel' });
    });
    await flushAsync();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });

    // Exactly one extra fetch (the plain refresh), no backoff loop.
    expect(getStatus.mock.calls.length).toBe(callsAfterMount + 1);
  });
});
