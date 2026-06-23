import type { BillingSource } from '@shared/utils/billingSource';
import { assertNever } from '@shared/utils/assertNever';
import type { ProviderCredentialSource } from '@shared/types/providerRoute';

export type { BillingSource } from '@shared/utils/billingSource';

/**
 * Provenance-only billing-source classification for a resolved route's
 * `credentialSource`, derived ONCE when the route decision is built
 * (`makeDecision` / `noCredentialsDecision` in providerRouting.ts) and carried on
 * the verdict + the route-plan trace. WS1a deliverable (#1).
 *
 * INTENTIONALLY DISTINCT FROM `credentialSource`. `credentialSource` names the
 * concrete credential CHANNEL (which key/token/session authenticates the wire);
 * `billingSource` names WHO PAYS, on the same axis the user-facing cost label uses
 * (`resolveBillingSourceForModel`'s `BillingSource` vocabulary:
 * `subscription | pool | pay-per-use | local`). Several distinct credential
 * channels collapse to the same billing axis, and one provider's channels can span
 * billing axes — so the two are NOT 1:1:
 *  - `mindstone-managed-key` (managed pool key) AND `codex-subscription`
 *    (OAuth subscription) AND `anthropic-oauth-token` (Claude Max subscription) all
 *    bill as `subscription` despite being three different credential channels.
 *  - `openrouter-oauth-token` bills as `pool` (prepaid credits), NOT pay-per-use.
 *  - `anthropic-api-key` / `openai-api-key` / `profile-api-key` (user-BYOK / env)
 *    all bill as `pay-per-use`.
 *  - `local-none` bills as `local` (no charge).
 *
 * Alignment note: this mapper agrees with `resolveBillingSourceForModel` /
 * `resolveBillingSourceForProfile` on the overlapping cases (mindstone→subscription,
 * codex-connected→subscription, openrouter-OAuth→pool, local→local, BYOK→pay-per-use).
 * It works off the ALREADY-RESOLVED `credentialSource` rather than re-classifying a
 * model-id string, so it cannot drift on the route-conditional flips.
 *
 * Terminal/missing credential sources have no billing identity → `null`.
 *
 * NOTE: nothing CONSUMES this yet (WS1a is additive). It exists for WS1b's proxy
 * billing re-decision and the observability surface.
 */
export function billingSourceForCredentialSource(
  credentialSource: ProviderCredentialSource,
): BillingSource | null {
  switch (credentialSource) {
    // Managed pool key, OAuth subscriptions (Codex / Claude Max) — someone else's
    // plan pays per the user's subscription, not per request.
    case 'mindstone-managed-key':
    case 'codex-subscription':
    case 'anthropic-oauth-token':
      return 'subscription';
    // Prepaid OpenRouter credits (account-wide OAuth pool).
    case 'openrouter-oauth-token':
      return 'pool';
    // User-supplied keys (BYOK) / env keys: billed per request to the user.
    case 'anthropic-api-key':
    case 'openai-api-key':
    case 'profile-api-key':
      return 'pay-per-use';
    // Local models: no charge.
    case 'local-none':
      return 'local';
    // Missing/terminal credential sources carry no billing identity.
    case 'missing-anthropic':
    case 'missing-openrouter':
    case 'missing-mindstone':
    case 'missing-codex':
    case 'missing-profile':
      return null;
    default:
      return assertNever(credentialSource, 'ProviderCredentialSource in billingSourceForCredentialSource');
  }
}
