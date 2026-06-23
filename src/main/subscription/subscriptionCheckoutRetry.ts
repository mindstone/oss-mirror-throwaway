/**
 * Subscription-checkout callback retry loop.
 *
 * Extracted verbatim (behaviour-preserving) from the inline closure inside
 * `handleDeepLink` in `src/main/index.ts` (CHIEF_ENGINEER2 run
 * `260607_decompose-main-index`, Stage 2). This is the live home of 3 of the 5
 * `timing`-class postmortems attributed to index.ts in the 30d pathologist report
 * (subscription_key/webhook provisioning races + the pro→expert upgrade window),
 * so it is lifted behind an explicit dependency seam to make it **unit-testable** —
 * the first regression coverage for that timing class.
 *
 * Behavioural invariants that MUST hold (see
 * 260520_pro_to_expert_upgrade_not_reflected.md DI-2):
 * - Auth config is fetched FIRST each attempt so the managed key lands in secure
 *   storage before the renderer is told to switch provider.
 * - For an UPGRADE (`expectedTier` set), a pre-existing active subscription on the
 *   OLD tier must NOT short-circuit the loop — it keeps retrying until the tier
 *   reflects `expectedTier` (or the budget is exhausted).
 * - Retry budget is 4 retries with exponential backoff from 2000ms
 *   (2+4+8+16+32 ≈ 62s authoritative window). A `fetchAuthConfig` throw on the
 *   final attempt ends the loop (no further state check).
 *
 * The "expected terminal state reached" check delegates to the shared
 * {@link isExpectedSubscriptionState} predicate so the main and renderer retry
 * paths cannot drift (the root cause of the `subscription_checkout_eventual_consistency`
 * timing-bug family). The no-`expectedTier` fallback stays inline here because
 * main's fallback (active + managed) differs deliberately from the renderer's.
 */
import { isExpectedSubscriptionState } from '@shared/subscription/expectedSubscriptionState';
import type { SubscriptionTier } from '@shared/types';

/** Minimal pino-style logger surface — `(obj, msg)` calls only. */
export interface RetryLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface SubscriptionStateLike {
  status?: string;
  tier?: string | null;
}

export interface CachedAuthConfigLike {
  managedProvider?: unknown;
  hasManagedKey?: unknown;
}

export interface SubscriptionCheckoutRetryDeps {
  /** Refresh auth config from the server (stores managed key in secure storage). */
  fetchAuthConfig: () => Promise<void>;
  /** Current subscription state from the auth provider. */
  getSubscriptionState: () => SubscriptionStateLike | null | undefined;
  /** Current cached auth config from the auth provider. */
  getCachedAuthConfig: () => CachedAuthConfigLike | null | undefined;
  logger: RetryLogger;
  /** Injectable for tests; defaults to a real setTimeout-backed delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults preserve the production retry budget. */
  maxRetries?: number;
  initialDelayMs?: number;
}

export interface SubscriptionCheckoutRetryArgs {
  /** Callback status from the deep-link URL (`success` | `cancel` | ...). */
  status: string;
  /** Tier the user is expected to land on after this checkout, or null. */
  expectedTier: SubscriptionTier | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export async function fetchWithSubscriptionRetry(
  { status, expectedTier }: SubscriptionCheckoutRetryArgs,
  deps: SubscriptionCheckoutRetryDeps,
): Promise<void> {
  const { fetchAuthConfig, getSubscriptionState, getCachedAuthConfig, logger } = deps;
  const MAX_RETRIES = deps.maxRetries ?? 4;
  const INITIAL_DELAY_MS = deps.initialDelayMs ?? 2000;
  const sleep = deps.sleep ?? defaultSleep;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await fetchAuthConfig();
    } catch (err) {
      logger.error({ err, attempt }, 'Auth config fetch failed after subscription callback');
      if (attempt === MAX_RETRIES) return;
    }

    const subState = getSubscriptionState();
    const authConfig = getCachedAuthConfig();
    const hasManagedProvider = !!authConfig?.managedProvider || !!authConfig?.hasManagedKey;
    // With an expected tier, defer to the shared predicate so this never drifts
    // from the renderer's check (and so a stale active OLD-tier row can't
    // short-circuit an upgrade). Without one, keep main's historical fallback:
    // active + managed (deliberately stricter than the renderer's `sub !== null`).
    const reconciled = expectedTier
      ? isExpectedSubscriptionState(
          subState,
          { tier: expectedTier, entitledStatuses: ['active'], requireManagedProvider: true },
          hasManagedProvider,
        )
      : !!subState && subState.status === 'active' && hasManagedProvider;
    if (reconciled) {
      logger.info(
        { attempt, hasManagedProvider, tier: subState?.tier, expectedTier },
        'Subscription and managed provider confirmed after checkout callback',
      );
      return;
    }

    // Only retry for successful checkouts where we expect subscription data
    if (status !== 'success' || attempt === MAX_RETRIES) {
      logger.warn(
        {
          attempt,
          status,
          hasSubscription: !!subState,
          subStatus: subState?.status,
          tier: subState?.tier,
          expectedTier,
        },
        'Subscription data not confirmed after checkout — proceeding with current state',
      );
      return;
    }

    const delay = INITIAL_DELAY_MS * Math.pow(2, attempt);
    logger.info(
      { attempt, nextDelayMs: delay, tier: subState?.tier, expectedTier },
      'Subscription not yet matching after checkout — retrying',
    );
    await sleep(delay);
  }
}
