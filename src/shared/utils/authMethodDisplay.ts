/**
 * Auth Method Display & Subscription Savings — Pure Data + Logic
 *
 * Display metadata for auth methods and subscription savings calculation.
 * Lives in @shared/ so both renderer and core can import it.
 */

/** Auth method display metadata for UI */
export const AUTH_METHOD_DISPLAY: Record<string, { label: string; description: string; isSubscription: boolean }> = {
  'api-key': { label: 'Anthropic (API key)', description: 'Pay-per-token with your own Anthropic API key', isSubscription: false },
  'codex-subscription': { label: 'ChatGPT Subscription', description: 'Covered by your ChatGPT plan', isSubscription: true },
  'openrouter': { label: 'OpenRouter', description: 'A routing layer — sends each request to one of many upstream providers on your behalf', isSubscription: false },
  'profile-direct': { label: 'Custom providers', description: "One or more direct provider connections you set up. Shown together — we don't record which one ran.", isSubscription: false },
  'local': { label: 'Local Model', description: 'Running on your machine', isSubscription: false },
  'oauth-token': { label: 'Claude Subscription', description: 'Legacy Claude subscription', isSubscription: true },
  'mindstone': { label: 'Mindstone Subscription', description: 'Covered by your Mindstone plan', isSubscription: true },
  // Managed Mindstone plan (emitted as resolvedAuthLabel by providerAuthPlan.ts for
  // mindstone-managed-key / missing-mindstone paths). Covered, like 'mindstone'.
  'mindstone-managed': { label: 'Mindstone Subscription (managed)', description: 'Covered by your managed Mindstone plan', isSubscription: true },
  'unknown': { label: 'Before cost tracking', description: 'Usage we could not attribute to a payment method', isSubscription: false },
};

export interface SubscriptionSavings {
  /** Covered by a subscription (ChatGPT/Claude/Mindstone) — API-equivalent value, not money paid. */
  subscriptionCoveredUsd: number;
  /** Known out-of-pocket spend (api-key, openrouter, profile-direct, …). The honest "You paid" number. */
  actualCostUsd: number;
  /** Local models — free. */
  freeUsd: number;
  /**
   * Cost we genuinely cannot attribute to a payment method: the 'unknown' bucket
   * ("Before cost tracking") plus any unmapped auth value. Deliberately kept SEPARATE
   * from actualCostUsd so the UI never claims the user paid money we can't attribute
   * (e.g. historical compaction-bts rows that predate the auth-stamping fix).
   */
  unclassifiedUsd: number;
  hasSubscriptionUsage: boolean;
}

export function calculateSubscriptionSavings(
  byAuthMethod: Record<string, number>
): SubscriptionSavings {
  let subscriptionCoveredUsd = 0;
  let actualCostUsd = 0;
  let freeUsd = 0;
  let unclassifiedUsd = 0;

  for (const [auth, cost] of Object.entries(byAuthMethod)) {
    const meta = AUTH_METHOD_DISPLAY[auth];
    // 'unknown' or any auth value we don't have a display row for is unclassified —
    // we don't know who paid, so don't fold it into the user's out-of-pocket total.
    if (!meta || auth === 'unknown') {
      unclassifiedUsd += cost;
    } else if (meta.isSubscription) {
      subscriptionCoveredUsd += cost;
    } else if (auth === 'local') {
      freeUsd += cost;
    } else {
      actualCostUsd += cost;
    }
  }

  return {
    subscriptionCoveredUsd,
    actualCostUsd,
    freeUsd,
    unclassifiedUsd,
    hasSubscriptionUsage: subscriptionCoveredUsd > 0,
  };
}
