/**
 * Single source of truth for "has the expected terminal subscription state been
 * reached after a Stripe checkout?" — consumed by BOTH the main-process retry
 * loop (`src/main/subscription/subscriptionCheckoutRetry.ts`) and the renderer
 * retry hook (`src/renderer/hooks/useSubscriptionState.ts`).
 *
 * WHY THIS EXISTS (kill-by-construction). The `timing` postmortems in the
 * `subscription_checkout_eventual_consistency` family
 * (`260531_subscription_webhook_authconfig_race`,
 *  `260531_wait_for_tier_change_after_stripe`) came from this success predicate
 * being reimplemented inline in two processes and DRIFTING — most damagingly,
 * stopping on a stale `active` status of the OLD tier during a `dash→rogue`
 * upgrade. Routing both processes through this one predicate makes that drift
 * unrepresentable: the function ALWAYS requires the observed tier to equal the
 * expected tier. Both postmortems explicitly recommend this shared predicate
 * (`type_constraint`: "so billing-state waits cannot drift across the process
 * boundary").
 *
 * SCOPE — with-expectation only. This handles the case where a concrete
 * `expectedTier` is known (the bug-bearing path). The no-expectation fallback
 * (first-time checkout with no recorded tier) stays in each caller, deliberately
 * unchanged, because the two callers' fallbacks differ on purpose (main requires
 * active+managed; renderer accepts any non-null subscription) and neither was the
 * source of the bug family.
 *
 * PURE: no electron / `@core` imports, so it is safe to bundle into the renderer.
 */
import type { SubscriptionStatus, SubscriptionTier } from '@shared/types';

/**
 * Statuses that count as "entitled". Single canonical copy — replaces the bare
 * `new Set(['active', 'trialing'])` previously duplicated in
 * `useSubscriptionState.ts` and `useSubscriptionLifecycle.ts`.
 */
export const ENTITLED_STATUSES: readonly SubscriptionStatus[] = ['active', 'trialing'];

/** True when `status` is one of the entitled statuses. Replaces ad-hoc `Set.has`. */
export function isEntitledStatus(status: string | null | undefined): boolean {
  return ENTITLED_STATUSES.some(s => s === status);
}

/**
 * Minimal shape of an observed subscription. Deliberately loose (`string`) so a
 * caller with its own loosely-typed state (the main retry seam, whose unit tests
 * use bare `{ status, tier }` fixtures) needs no casts at the call site.
 */
export interface ObservedSubscriptionLike {
  tier?: string | null;
  status?: string | null;
}

export interface ExpectedSubscriptionCriteria {
  /** The tier this checkout is expected to land on. Required — see SCOPE above. */
  tier: SubscriptionTier;
  /**
   * Statuses that count as reconciled for this caller.
   * main: `['active']`; renderer: {@link ENTITLED_STATUSES} (`active`+`trialing`).
   */
  entitledStatuses: readonly SubscriptionStatus[];
  /** Whether a managed provider/key must also be present (main: `true`; renderer: `false`). */
  requireManagedProvider: boolean;
}

/**
 * Has the observed subscription reached the expected terminal state for a checkout?
 *
 * Returns true only when ALL hold:
 *  - an observed subscription exists,
 *  - its tier === the expected tier (kills the stale-tier short-circuit by construction),
 *  - its status is in `entitledStatuses`,
 *  - and, if `requireManagedProvider`, the managed provider/key is present.
 *
 * @param managedProviderPresent Only consulted when `criteria.requireManagedProvider`.
 */
export function isExpectedSubscriptionState(
  observed: ObservedSubscriptionLike | null | undefined,
  criteria: ExpectedSubscriptionCriteria,
  managedProviderPresent?: boolean,
): boolean {
  if (!observed) return false;
  if (observed.tier !== criteria.tier) return false;
  if (!criteria.entitledStatuses.some(s => s === observed.status)) return false;
  if (criteria.requireManagedProvider && !managedProviderPresent) return false;
  return true;
}
