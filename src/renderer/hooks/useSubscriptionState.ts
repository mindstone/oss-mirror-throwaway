import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubscriptionState, SubscriptionTier } from '@shared/types';
import { SubscriptionStateSchema } from '@shared/ipc/channels/subscription';
import {
  ENTITLED_STATUSES,
  isEntitledStatus,
  isExpectedSubscriptionState,
} from '@shared/subscription/expectedSubscriptionState';

type SubscriptionPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface SubscriptionStateResult {
  /** Current subscription state, or null if no subscription. */
  subscription: SubscriptionState | null;
  /** Loading/ready phase for subscription fetch. */
  phase: SubscriptionPhase;
  /** Convenience flag — `subscription?.status === 'active'` or `'trialing'`. */
  isActive: boolean;
  /** Convenience flag — past_due (within grace) is treated as still entitled. */
  isPastDueWithinGrace: boolean;
  /**
   * Manually re-fetch subscription state. Resolves when fetch completes.
   * When `expectedTier` is supplied, the boolean result reflects whether the
   * fetched subscription matches that tier — used by `refreshWithRetry` to
   * keep polling after an upgrade callback until the Stripe webhook flips
   * the tier server-side.
   */
  refresh: (expectedTier?: SubscriptionTier) => Promise<boolean | void>;
}

// Retry-budget asymmetry is intentional: main process keeps the authoritative
// expectedTier window for ~62s (2+4+8+16+32), while renderer stays a cosmetic
// short-window catch-up at ~14s (2+3+4+5+5). If webhook delays exceed ~62s,
// both paths can exhaust and the UI may stay stale (see DI-2 in
// 260520_pro_to_expert_upgrade_not_reflected.md).
const RETRY_DELAYS_MS = [2000, 3000, 4000, 5000, 5000];

function computeIsPastDueWithinGrace(state: SubscriptionState | null): boolean {
  if (!state) return false;
  if (state.status !== 'past_due') return false;
  if (!state.graceEndsAt) return true;
  const graceMs = Date.parse(state.graceEndsAt);
  if (Number.isNaN(graceMs)) return true;
  return graceMs > Date.now();
}

function normalizeSubscriptionFromIpc(rawSubscription: unknown): SubscriptionState | null {
  if (rawSubscription === null || rawSubscription === undefined) return null;
  const parsed = SubscriptionStateSchema.safeParse(rawSubscription);
  if (!parsed.success) {
    console.warn(
      { rawSubscription, issues: parsed.error.issues },
      '[useSubscriptionState] Malformed subscription payload from subscription:get-status; rejecting',
    );
    return null;
  }
  return parsed.data;
}

/**
 * Subscribes to the user's Mindstone subscription state.
 *
 * State is fetched via `subscriptionApi['subscription:get-status']` and
 * refreshed when:
 *   - the auth config is re-broadcast (`auth:config-received`), and
 *   - the Stripe checkout deep link returns (`subscription:callback`).
 *
 * After a Stripe callback, retries with backoff to handle the webhook
 * processing delay — the server may not have the subscription data ready
 * when the redirect fires.
 */
export function useSubscriptionState(): SubscriptionStateResult {
  const [subscription, setSubscription] = useState<SubscriptionState | null>(null);
  const [phase, setPhase] = useState<SubscriptionPhase>('idle');
  const isMountedRef = useRef(true);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (expectedTier?: SubscriptionTier): Promise<boolean> => {
    setPhase((current) => (current === 'idle' ? 'loading' : current));
    try {
      const result = await window.subscriptionApi.getStatus();
      if (!isMountedRef.current) return false;
      const sub = normalizeSubscriptionFromIpc(result.subscription);
      setSubscription(sub);
      setPhase('ready');
      if (expectedTier) {
        // Shared predicate — same rule the main retry loop applies, so the two
        // cannot drift (kills the dash→rogue stale-active short-circuit).
        return isExpectedSubscriptionState(sub, {
          tier: expectedTier,
          entitledStatuses: ENTITLED_STATUSES,
          requireManagedProvider: false,
        });
      }
      // No-expectation fallback kept verbatim (renderer-specific; not the bug path).
      return sub !== null;
    } catch (error) {
      if (!isMountedRef.current) return false;
      console.warn('[useSubscriptionState] Failed to fetch subscription status:', error);
      setPhase('error');
      return false;
    }
  }, []);

  // Retry with backoff — used after Stripe callback to handle webhook race.
  // Checks refresh() return value directly to avoid stale-closure reads of state.
  // When `expectedTier` is supplied, polling continues until the tier matches —
  // required for upgrades (e.g. Dash -> Rogue), where a pre-existing active
  // subscription would otherwise satisfy the "subscription exists" condition
  // before the Stripe webhook updates the tier.
  const refreshWithRetry = useCallback(
    async (expectedTier?: SubscriptionTier) => {
      // Immediate attempt before entering delay loop.
      if (await refresh(expectedTier)) return;
      if (!isMountedRef.current) return;

      for (const delay of RETRY_DELAYS_MS) {
        await new Promise<void>((resolve) => {
          retryTimerRef.current = setTimeout(resolve, delay);
        });
        if (!isMountedRef.current) return;
        if (await refresh(expectedTier)) return;
        if (!isMountedRef.current) return;
      }
    },
    [refresh],
  );

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();
    return () => {
      isMountedRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [refresh]);

  // Re-fetch on auth config broadcast (covers login, post-checkout config refresh).
  useEffect(() => {
    const handler = window.api?.onAuthConfigReceived;
    if (typeof handler !== 'function') return;
    const unsubscribe = handler(() => {
      void refresh();
    });
    return () => unsubscribe();
  }, [refresh]);

  // Re-fetch with retry on Stripe deep-link return.
  // The Stripe webhook may not have been processed when the redirect fires,
  // so we poll with backoff until subscription data appears (and, for an
  // upgrade, until the tier reflects the requested upgrade target).
  useEffect(() => {
    const handler = window.api?.onSubscriptionCallback;
    if (typeof handler !== 'function') return;
    const unsubscribe = handler((data) => {
      if (data?.status !== 'success') {
        void refresh();
        return;
      }
      void refreshWithRetry(data.expectedTier);
    });
    return () => unsubscribe();
  }, [refresh, refreshWithRetry]);

  const isActive = !!subscription && isEntitledStatus(subscription.status);
  const isPastDueWithinGrace = computeIsPastDueWithinGrace(subscription);

  return {
    subscription,
    phase,
    isActive,
    isPastDueWithinGrace,
    refresh,
  };
}
