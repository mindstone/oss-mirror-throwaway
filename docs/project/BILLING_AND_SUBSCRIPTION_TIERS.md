---
description: "Reference for Rebel's billing models (the four activeProvider modes), subscription tiers (Dash/Rogue), the BillingSource label vocabulary, and the distinct entitlement axes that are easily conflated."
last_updated: "2026-05-30"
---

# Billing and subscription tiers

How a user pays for model inference in Rebel, and the vocabulary the codebase uses to label it. This is intent/orientation; the code is the source of truth for the resolution logic.

## The four billing models (one per `activeProvider`)

`activeProvider` (`ActiveProvider` in [`src/shared/types/settings.ts`](../../src/shared/types/settings.ts)) is the single mutually-exclusive switch for *who pays and how*. The four values map one-to-one onto billing models:

| `activeProvider` | Who pays | Mechanism |
|---|---|---|
| `anthropic` | The user, directly | **BYOK pay-per-use** — user's own Anthropic API key, billed by Anthropic per token. |
| `openrouter` | The user, directly | **BYO pool / Credits** — user's own OpenRouter account (OAuth token); spend drawn from their OpenRouter credit pool. |
| `codex` | OpenAI subscription | **ChatGPT-Pro subscription** — server-billed via the user's ChatGPT Pro plan; OpenAI models only. |
| `mindstone` | Mindstone (flat fee) | **Mindstone-managed subscription** — user pays Mindstone a flat fee via Stripe; Mindstone pays the OpenRouter bill behind a server-provisioned *managed key*. |

The `mindstone` model is the involved one: the desktop client never sees an OpenRouter key — it routes through a managed key provisioned and metered server-side. The activation/reconcile pipeline (`extractManagedProviderInfo` in [`private/mindstone/src/services/authService.ts`](../../private/mindstone/src/services/authService.ts)) is documented separately in the sibling **MANAGED_PROVIDER_LIFECYCLE.md** — read that for the provisioning, reconcile, and switch-away machinery.

## Subscription tiers: Dash and Rogue

`SubscriptionTier = 'dash' | 'rogue'` ([`src/shared/types/settings.ts`](../../src/shared/types/settings.ts)). These apply only to the `mindstone` billing model (the Stripe subscription). `SubscriptionState` (same file) carries the live `tier`, `status`, period, and grace fields.

> **Rename note — read this to avoid confusion.** Older postmortems and planning docs call these tiers **"Pro"** and **"Expert"**. Those are the *same two tiers, since renamed* to **Dash** and **Rogue**. The live `SubscriptionTier` union does **not** contain `pro`/`expert`. So [`260520_pro_to_expert_upgrade_postmortem`](../../docs-private/postmortems/260520_pro_to_expert_upgrade_postmortem.md) (which talks about a `pro`→`expert` Stripe upgrade race) describes today's `dash`→`rogue` upgrade path. The credit allowance is identical across both tiers (the meter/thresholds are tier-agnostic — see the credit-meter hooks below).

## BillingSource label vocabulary

`BillingSource` ([`src/shared/utils/billingSource.ts`](../../src/shared/utils/billingSource.ts)) is the *display* abstraction that turns "active provider + selected model/profile" into a human-readable suffix on model-picker options:

- `resolveBillingSourceForOption(...)` / `resolveBillingSourceForProfile(...)` — resolve a model option or profile to one of `'subscription' | 'pool' | 'pay-per-use' | 'local'`.
- `billingSourceLabelSuffix(...)` — maps those to the label suffixes: `subscription` → `" — Subscription"`, `pool` → `" — Credits"`, `pay-per-use` → `" — Pay-per-use"`, `local` → `" — Local"`.

Note the deliberate split: the `mindstone` provider relabels OpenRouter models from `Credits` to `Subscription` (because Mindstone is footing the bill), and Codex `gpt-*` models flip to `Subscription` only when `codexConnected`. This is a labelling layer, not an enforcement layer.

## Three distinct entitlement axes (do not conflate)

These are independent and frequently confused:

1. **Subscription tier** — `dash` / `rogue` (`SubscriptionTier`). Determines the Stripe plan within the `mindstone` billing model.
2. **License tier (the "enterprise"/feature-gate axis)** — `LicenseTier = 'free' | 'teams'` ([`src/shared/ipc/schemas/auth.ts`](../../src/shared/ipc/schemas/auth.ts)), consumed by [`useFeatureGate`](../../src/renderer/hooks/useFeatureGate.ts) to gate features (e.g. `spaces:create-additional`). This is an **orthogonal feature-gate**, not a billing model — a user's license tier is independent of their `activeProvider` and `SubscriptionTier`. See planning doc [`260314_enterprise_license_gating`](../plans/260314_enterprise_license_gating.md).
3. **"Mindstone Managed Cloud"** — a **completely different system** that merely shares the word *managed*.

> **Disambiguation callout.** "Mindstone-managed subscription/provider" (billing — the `mindstone` `activeProvider`, a managed *OpenRouter key*) is **not** "Mindstone Managed Cloud" (the Fly.io infrastructure that runs the agent brain remotely). The latter is about *where compute runs*, not *who pays for tokens*. See [CLOUD_ARCHITECTURE](./CLOUD_ARCHITECTURE.md). When you read "managed", check which subsystem is meant.

## Credit / usage metering is display-only

There is **no client-side spend enforcement**. The credit meter is purely for display and notification:

- [`useCreditMeterToastWarnings`](../../src/renderer/hooks/useCreditMeterToastWarnings.ts) — surfaces toast warnings at the **75%** and **90%** usage thresholds (deduped per billing period).
- [`useCreditMeterThresholdAnalytics`](../../src/renderer/hooks/useCreditMeterThresholdAnalytics.ts) — fires analytics at the **80%** and **95%** thresholds.

Both read `creditUsedMonthly` / `creditLimitMonthly` from the managed-provider auth config. The meter does not throttle, block, or downgrade routing when the allowance is exceeded.

> **Documented caveat (not a live bug claim).** Per [`260520_subscription_tier_ux_combined_postmortem`](../../docs-private/postmortems/260520_subscription_tier_ux_combined_postmortem.md), the server-side `creditUsedMonthly` accumulator under-reporting (the subscription backend not aggregating real OpenRouter passthrough spend into the field) was a **deferred follow-up** — an out-of-repo backend handoff. Until that lands, paying users may see a low/zero "% used" figure even with real consumption. The desktop client hardened the parser and added warning logs (`authService.ts`) but the actual fix is server-side. Treat any "% used" anomaly through this lens before assuming a client regression.

## See also

- **MANAGED_PROVIDER_LIFECYCLE.md** (sibling) — the activation/reconcile/switch-away pipeline for the `mindstone` managed provider; the *how* behind the `mindstone` billing model.
- [COST_TRACKING](./COST_TRACKING.md) — per-turn cost accounting; complements the billing-model view here.
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) — where `activeProvider`, OpenRouter OAuth, and subscription state live in `AppSettings`.
- [AUTHENTICATION](./AUTHENTICATION.md) — auth config delivery (the `auth:get-config` payload carrying subscription + credit fields).
- [CLOUD_ARCHITECTURE](./CLOUD_ARCHITECTURE.md) — the "Mindstone Managed Cloud" (Fly.io) system — distinct from managed billing despite the shared word.
- [`260521_provider_switch_mindstone_to_openrouter_postmortem`](../../docs-private/postmortems/260521_provider_switch_mindstone_to_openrouter_postmortem.md) — switching away from the managed provider; rationale for the deliberate-switch handling.
- [`260520_subscription_tier_ux_combined_postmortem`](../../docs-private/postmortems/260520_subscription_tier_ux_combined_postmortem.md) — the credit-meter UX and the deferred server-side accumulator follow-up.
- [`260520_pro_to_expert_upgrade_postmortem`](../../docs-private/postmortems/260520_pro_to_expert_upgrade_postmortem.md) — tier upgrade (Stripe webhook) race; uses the old Pro/Expert names for today's Dash/Rogue.
