import { describe, it, expect, vi } from 'vitest';
import {
  fetchWithSubscriptionRetry,
  type SubscriptionCheckoutRetryDeps,
  type SubscriptionStateLike,
  type CachedAuthConfigLike,
} from '../subscriptionCheckoutRetry';

/**
 * First regression coverage for the subscription-callback timing-bug class
 * (3 of the 5 `timing` postmortems attributed to src/main/index.ts):
 *  - 260531_wait_for_tier_change_after_stripe (upgrade tier-match window)
 *  - subscription_key / subscription_webhook provisioning races (webhook lag)
 * Extracted from the inline closure in handleDeepLink so it can be exercised
 * with an injected `sleep` (no real timers) and scripted provider state.
 *
 * Tier fixtures use the real product tiers `dash`/`rogue` (migrated from the
 * legacy `pro`/`expert` names — the `tier` field is loosely typed as `string`
 * here so the migration is behaviour-identical string comparison). The
 * "expected terminal state reached" check now delegates to the shared
 * `isExpectedSubscriptionState` predicate; these tests pin that the main
 * retry-loop behaviour is unchanged by that consolidation.
 */

const noopLogger: SubscriptionCheckoutRetryDeps['logger'] = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Build deps whose subscription/auth state is read fresh each attempt from a script. */
function makeDeps(
  states: Array<{ sub: SubscriptionStateLike | null; auth: CachedAuthConfigLike | null }>,
  overrides: Partial<SubscriptionCheckoutRetryDeps> = {},
) {
  let call = -1;
  const fetchAuthConfig = vi.fn(async () => {
    call += 1;
  });
  // Each get* reflects the state for the current attempt (clamped to last).
  const at = () => states[Math.min(call, states.length - 1)] ?? { sub: null, auth: null };
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
  const deps: SubscriptionCheckoutRetryDeps = {
    fetchAuthConfig,
    getSubscriptionState: () => at().sub,
    getCachedAuthConfig: () => at().auth,
    logger: noopLogger,
    sleep,
    ...overrides,
  };
  return { deps, fetchAuthConfig, sleep };
}

const ACTIVE_MANAGED = { sub: { status: 'active', tier: 'dash' }, auth: { hasManagedKey: true } };

describe('fetchWithSubscriptionRetry', () => {
  it('confirms immediately and does not sleep when active + managed + tier matches on first attempt', async () => {
    const { deps, fetchAuthConfig, sleep } = makeDeps([ACTIVE_MANAGED]);
    await fetchWithSubscriptionRetry({ status: 'success', expectedTier: 'dash' }, deps);
    expect(fetchAuthConfig).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit on a stale pre-existing tier during an upgrade (dash→rogue regression)', async () => {
    // Pre-existing active 'dash' subscription; the upgrade target is 'rogue'.
    // The loop must keep retrying until the tier reflects 'rogue' — a flat
    // "active subscription exists" check would have returned on attempt 0.
    // (This is the 260531_wait_for_tier_change_after_stripe failure.)
    const { deps, fetchAuthConfig, sleep } = makeDeps([
      { sub: { status: 'active', tier: 'dash' }, auth: { hasManagedKey: true } }, // attempt 0
      { sub: { status: 'active', tier: 'dash' }, auth: { hasManagedKey: true } }, // attempt 1
      { sub: { status: 'active', tier: 'rogue' }, auth: { hasManagedKey: true } }, // attempt 2 — matches
    ]);
    await fetchWithSubscriptionRetry({ status: 'success', expectedTier: 'rogue' }, deps);
    // Returned on attempt 2 → fetched 3 times, slept twice (after attempts 0 and 1).
    expect(fetchAuthConfig).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(sleep).toHaveBeenNthCalledWith(2, 4000);
  });

  it('retries through webhook lag until the subscription becomes active+managed', async () => {
    const { deps, fetchAuthConfig, sleep } = makeDeps([
      { sub: null, auth: null }, // attempt 0 — webhook not processed yet
      { sub: { status: 'incomplete', tier: 'dash' }, auth: null }, // attempt 1 — partial
      { sub: { status: 'active', tier: 'dash' }, auth: { managedProvider: 'mindstone' } }, // attempt 2 — confirmed
    ]);
    await fetchWithSubscriptionRetry({ status: 'success', expectedTier: null }, deps);
    expect(fetchAuthConfig).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('exhausts the retry budget with exponential backoff when state never confirms', async () => {
    const { deps, fetchAuthConfig, sleep } = makeDeps([{ sub: null, auth: null }]);
    await fetchWithSubscriptionRetry({ status: 'success', expectedTier: 'rogue' }, deps);
    // attempts 0..4 inclusive = 5 fetches; sleeps after attempts 0..3 = 4 sleeps.
    expect(fetchAuthConfig).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(c => c[0])).toEqual([2000, 4000, 8000, 16000]);
  });

  it('does not retry for a non-success status', async () => {
    const { deps, fetchAuthConfig, sleep } = makeDeps([{ sub: null, auth: null }]);
    await fetchWithSubscriptionRetry({ status: 'cancel', expectedTier: null }, deps);
    expect(fetchAuthConfig).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps looping when fetchAuthConfig throws on non-final attempts and stops on a final throw', async () => {
    const sleep = vi.fn(async () => {});
    const fetchAuthConfig = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('network'));
    const deps: SubscriptionCheckoutRetryDeps = {
      fetchAuthConfig,
      getSubscriptionState: () => null,
      getCachedAuthConfig: () => null,
      logger: noopLogger,
      sleep,
    };
    await fetchWithSubscriptionRetry({ status: 'success', expectedTier: null }, deps);
    // Throw is caught each attempt; loop proceeds; on the final attempt the
    // early return fires before state evaluation. 5 fetches, 4 sleeps.
    expect(fetchAuthConfig).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it('an emit attached via .finally fires only AFTER the retry loop fully settles (index.ts sequencing invariant — bug #1)', async () => {
    // index.ts emits `subscription:callback` in `.finally()` on the promise this
    // returns, so the renderer is never told to switch provider before the loop
    // has finished fetching auth config / persisting the managed key. Pin that
    // the emit lands last even when the loop runs the full budget.
    const timeline: string[] = [];
    const fetchAuthConfig = vi.fn(async () => {
      timeline.push('fetch');
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
      timeline.push('sleep');
    });
    const deps: SubscriptionCheckoutRetryDeps = {
      fetchAuthConfig,
      getSubscriptionState: () => null, // never confirms → full budget
      getCachedAuthConfig: () => null,
      logger: noopLogger,
      sleep,
    };
    await fetchWithSubscriptionRetry({ status: 'success', expectedTier: 'rogue' }, deps).finally(() =>
      timeline.push('emit'),
    );
    expect(timeline[timeline.length - 1]).toBe('emit');
    expect(timeline.filter(t => t === 'fetch')).toHaveLength(5);
  });

  it('respects custom maxRetries / initialDelayMs (budget is configurable, defaults preserved elsewhere)', async () => {
    const { deps, fetchAuthConfig, sleep } = makeDeps([{ sub: null, auth: null }], {
      maxRetries: 1,
      initialDelayMs: 500,
    });
    await fetchWithSubscriptionRetry({ status: 'success', expectedTier: 'dash' }, deps);
    expect(fetchAuthConfig).toHaveBeenCalledTimes(2); // attempts 0,1
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });
});
