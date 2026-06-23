/**
 * User-facing friendly names for provider credential sources.
 *
 * `ProviderCredentialSource` is an internal routing enum (e.g.
 * `openrouter-oauth-token`, `mindstone-managed-key`). Those raw enums belong on
 * the diagnostics "Details" surface, NOT on the user-facing tooltip
 * (BRAND_VOICE.md: raw enums are for the debug surface). This mapper turns each
 * into calm, plain language for the paid-fallback indicator and any other
 * user-facing provider label.
 *
 * Exhaustive over `PROVIDER_CREDENTIAL_SOURCES` via the `assertNever` default —
 * adding a credential source without a friendly name here is a compile error.
 *
 * See docs/plans/260621_paid-fallback-indicator/.
 */
import type { ProviderCredentialSource } from '../types/providerRoute';
import { assertNever } from './assertNever';

export function credentialSourceToFriendlyName(cs: ProviderCredentialSource): string {
  switch (cs) {
    case 'anthropic-api-key':
      return 'your Anthropic key';
    case 'anthropic-oauth-token':
      return 'your Claude subscription';
    case 'openrouter-oauth-token':
      return 'OpenRouter';
    case 'mindstone-managed-key':
      return 'Rebel';
    case 'codex-subscription':
      return 'ChatGPT';
    case 'profile-api-key':
      return 'your provider key';
    case 'openai-api-key':
      return 'your OpenAI key';
    case 'local-none':
      return 'your local model';
    // The `missing-*` arms are terminal/no-credential routes — they should never
    // be a *destination* of a successful failover, but the mapper stays total so
    // the diagnostics/debug paths never crash on an unexpected value.
    case 'missing-anthropic':
      return 'Anthropic';
    case 'missing-openrouter':
      return 'OpenRouter';
    case 'missing-mindstone':
      return 'Rebel';
    case 'missing-codex':
      return 'ChatGPT';
    case 'missing-profile':
      return 'your provider';
    default:
      return assertNever(cs, 'credentialSourceToFriendlyName');
  }
}
