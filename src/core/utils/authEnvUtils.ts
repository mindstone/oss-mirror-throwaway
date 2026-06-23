import type { AppSettings, ProviderKeys, ActiveProvider } from '@shared/types';
import { normalizeApiKey } from '@shared/utils/providerKeys';
import { DEFAULT_MODEL } from '@shared/utils/modelNormalization';
import { getCodexAuthProvider } from '@core/codexAuth';
import { getApiKey, getThinkingFallback, getWorkingFallback } from '@core/rebelCore/settingsAccessors';
// `inferTierFallbackProvider` is byte-identical to providerSwitch's rule → reuse that adapter.
import { toProviderSwitchProvider } from '@shared/utils/modelIdClassifier';
import { validateProviderCredentials } from './validateProviderCredentials';

/**
 * Source-of-truth list of **auth-shape-only** helpers exported from this module.
 *
 * **Inclusion criterion (strict):** A helper belongs in this list iff it
 * answers "are direct-Anthropic credentials present?" *purely from
 * credential state*, **without** consulting `settings.activeProvider`,
 * `isUsingOpenRouter(settings)`, `getCodexAuthProvider().isConnected()`,
 * or any other provider-routing signal. The 260419 regression was caused
 * by an integration test gating `canRun` on a member of this list
 * (specifically `getApiKeyForDirectUse`) without ALSO composing a
 * provider-shape predicate (`isDirectAnthropicConfig`).
 *
 * **Why provider-aware helpers must be excluded:** If a helper *already*
 * checks `activeProvider` / `isUsingOpenRouter`, gating on it ALONE is
 * actually correct — it inherently fails closed when the provider is
 * proxied. Including it here would force tests that legitimately gate
 * on `hasValidAuth` (e.g., an OpenRouter integration test) to also
 * compose `isDirectAnthropicConfig`, which would always be false for
 * OpenRouter and silently skip the test. That's a false-positive trap
 * we don't want.
 *
 * **Imported by** `scripts/check-integration-test-provider-gates.ts` (A3b)
 * to mechanically detect the misuse class inside `**\/*.integration.test.ts`
 * gate expressions. Co-locating the list here prevents silent drift —
 * if you add a new auth-shape-only helper to this module, append it here
 * so the AST check picks it up; if a helper changes shape (e.g., becomes
 * provider-shape-aware), remove it.
 *
 * **Currently included (verified auth-shape-only):**
 *   - `getAuthForDirectUse` — reads model namespace API key + env.
 *   - `hasDirectAuth` — calls `getAuthForDirectUse`, no provider check.
 *   - `getApiKeyForDirectUse` — reads `getAuthForDirectUse().apiKey`.
 *   - `getApiKeyAuthEnvVars` — reads model namespace API key + env.
 *
 * **NOT in this list:**
 *   - `getAuthEnvVars` — provider-aware (early-returns on
 *     `isUsingOpenRouter` / `activeProvider === 'codex'`).
 *   - `hasValidAuth` — provider-aware (checks `isUsingOpenRouter`,
 *     `activeProvider === 'codex'`).
 *   - `isUsingOpenRouter`, `isUsingOAuth`, `hasOpenRouterCredentials` —
 *     cross-provider routing helpers; they DO encode provider semantics.
 *   - `isDirectAnthropicConfig` — the provider-shape predicate itself.
 *
 * @see isDirectAnthropicConfig (the provider-shape predicate that must
 *      compose with these helpers in live-API integration test gates).
 * @see docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md
 * @see docs/plans/260419_prepush_followups_roadmap.md
 */
export const AUTH_SHAPE_HELPERS = [
  'getAuthForDirectUse',
  'hasDirectAuth',
  'getApiKeyForDirectUse',
  'getApiKeyAuthEnvVars',
] as const;
export type AuthShapeHelperName = (typeof AUTH_SHAPE_HELPERS)[number];

/** Strip all whitespace from a credential (handles copy-paste artifacts, wrapped terminal output) */
const sanitize = (value: string | null | undefined): string =>
  value?.replace(/\s/g, '') ?? '';

/**
 * Check if OpenRouter is the active LLM provider.
 * Used by auth, proxy routing, and UI to determine OR-specific behavior.
 *
 * Checks both `openRouter.enabled` AND `activeProvider === 'openrouter'` because
 * the two fields can get out of sync (e.g., settings migrated from older versions
 * may have activeProvider set without the enabled flag). The activeProvider field
 * is the authoritative source; enabled is a legacy signal.
 */
export function isUsingOpenRouter(settings: AppSettings): boolean {
  // Mindstone managed mode also routes through OpenRouter
  if (settings.activeProvider === 'mindstone') return true;
  return !!(settings.openRouter?.oauthToken
    && (settings.openRouter?.enabled || settings.activeProvider === 'openrouter'));
}

/**
 * Check if OpenRouter credentials exist regardless of active provider.
 * Used by cross-provider BTS routing to route OR-format model IDs through
 * the OR proxy even when Anthropic or Codex is the active provider.
 */
export function hasOpenRouterCredentials(settings: AppSettings): boolean {
  return !!settings.openRouter?.oauthToken;
}

/**
 * Returns the appropriate auth environment variables based on user settings.
 * Centralizes auth resolution so all services use the same logic.
 *
 * Priority order:
 * 0. If OpenRouter is active, return empty ANTHROPIC_API_KEY (SDK requires it to accept custom base URL)
 * 1. User's explicit authMethod selection in settings
 * 2. Fall back to whichever credential is available
 * 3. Check process.env for dev/CI scenarios
 */
export function getAuthEnvVars(settings: AppSettings): Record<string, string> {
  // OpenRouter active: SDK needs ANTHROPIC_API_KEY set (even empty) to honor ANTHROPIC_BASE_URL.
  // The proxy handles real auth injection.
  if (isUsingOpenRouter(settings)) {
    return { ANTHROPIC_API_KEY: '' };
  }

  // Codex active + connected: same pattern — SDK needs the key present to honor ANTHROPIC_BASE_URL.
  // The proxy injects the real ChatGPT OAuth token.
  if (settings.activeProvider === 'codex' && getCodexAuthProvider().isConnected()) {
    return { ANTHROPIC_API_KEY: '' };
  }

  // API key is the only supported Claude auth path (OAuth deprecated April 2026)
  const apiKey = sanitize(getApiKey(settings));

  if (apiKey) {
    return { ANTHROPIC_API_KEY: apiKey };
  }

  // Check environment variables (for dev/CI scenarios)
  if (process.env.ANTHROPIC_API_KEY) {
    return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  }

  return {}; // No auth configured
}

/**
 * Check if valid authentication is configured for ANY supported provider.
 * Used by health checks and UI to determine if the agent can run.
 *
 * Returns true when ANY of these are present:
 * 1. A Claude API key or OAuth token (direct Anthropic auth)
 * 2. A working model profile with resolvable API key (profile.apiKey, customProvider.apiKey, or providerKeys[type])
 * 3. A local model profile (providerType === 'local') — no API key needed
 */
export function hasValidAuth(settings: AppSettings, codexConnected = getCodexAuthProvider().isConnected()): boolean {
  const state = validateProviderCredentials(settings, codexConnected);
  return state.status === 'valid' || state.status === 'connected';
}

/**
 * Get a display-friendly description of the current auth method.
 * Used for logging and UI feedback.
 */
export function getAuthMethodDescription(settings: AppSettings): string {
  if (isUsingOpenRouter(settings)) {
    return 'OpenRouter';
  }
  const authEnv = getAuthEnvVars(settings);
  if ('ANTHROPIC_API_KEY' in authEnv) {
    return 'API Key';
  }
  return 'None';
}

/**
 * Get direct-use credentials for Anthropic API calls.
 *
 * **AUTH-SHAPE helper** — answers "are credentials present?", NOT "should we
 * route to Anthropic directly?". A legacy `claude.apiKey` can coexist with
 * `activeProvider === 'openrouter'` or `'codex'`; this helper does not look
 * at `activeProvider`.
 *
 * @warning Do NOT use as a provider-gate discriminator. Pair with
 * {@link isDirectAnthropicConfig} for any code path that calls
 * `createDirectAnthropicClient` / `callAnthropic` / direct-Anthropic API
 * surface. Auth-shape alone lies when the user has switched providers but
 * left a stale Anthropic key behind.
 *
 * @example Anti-pattern (the 260419 shape — DO NOT do this):
 * ```ts
 * const auth = getAuthForDirectUse(settings);
 * if (auth.apiKey) { callAnthropic(auth.apiKey, ...); } // leaks for OR/Codex users
 * ```
 *
 * @example Correct pattern (provider-shape + auth-shape composed):
 * ```ts
 * if (!isDirectAnthropicConfig(settings)) return; // provider gate first
 * const auth = getAuthForDirectUse(settings);
 * if (!auth.apiKey) return;                       // then auth gate
 * callAnthropic(auth.apiKey, ...);
 * ```
 *
 * Returns API key when available. OAuth token path removed (deprecated April 2026).
 *
 * @see isDirectAnthropicConfig
 * @see docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md
 * @see docs-private/postmortems/260406_auth_fallback_truthiness_postmortem.md
 */
export function getAuthForDirectUse(settings: AppSettings): { apiKey?: string; authToken?: string } {
  const apiKey = sanitize(getApiKey(settings)) || sanitize(process.env.ANTHROPIC_API_KEY) || '';

  return {
    ...(apiKey ? { apiKey } : {}),
  };
}

/**
 * Check if the given settings route directly to Anthropic's native API.
 * Integration tests that pass model IDs straight to the Anthropic SDK must
 * distinguish "has Anthropic auth" from "is actually using Anthropic directly" —
 * an Anthropic key may still be present when the effective provider is proxied.
 *
 * Rejects any proxy-routed provider (OpenRouter, Codex). The `activeProvider`
 * check is intentionally independent of `isUsingOpenRouter` so partial/broken
 * OpenRouter configs (e.g., `activeProvider: 'openrouter'` without an
 * `oauthToken`) still fail closed rather than slipping through and producing
 * 404s downstream.
 */
export function isDirectAnthropicConfig(settings: AppSettings): boolean {
  if (!settings) return false;
  if (isUsingOpenRouter(settings)) return false;
  // R3 (plan 260422): exhaustive switch on ActiveProvider. Adding a new
  // provider variant (e.g. 'bedrock', 'azure') forces a compile error at the
  // `const _exhaustive: never` line, preventing silent "is-this-anthropic?"
  // drift where the default "return true" path would otherwise misclassify a
  // new proxy provider as direct-Anthropic.
  switch (settings.activeProvider) {
    case 'openrouter':
    case 'codex':
    case 'mindstone':
      return false;
    case 'anthropic':
    case undefined:
      // 'anthropic' is the explicit direct path; `undefined` covers legacy
      // settings predating the activeProvider field — treat as direct-Anthropic
      // for backward compatibility.
      return true;
    default: {
      const _exhaustive: never = settings.activeProvider;
      // Runtime fail-closed: if an unknown provider slipped through type
      // narrowing (e.g. corrupted settings JSON), refuse direct-Anthropic
      // rather than silently allowing the call. Pairs with the compile-time
      // exhaustive check above.
      void _exhaustive;
      return false;
    }
  }
}

/**
 * Check if direct Anthropic auth credentials are available (API key or OAuth token).
 *
 * **AUTH-SHAPE helper** — answers "are credentials present?", NOT "is this
 * the right provider?". Use this instead of truthiness-checking
 * `getAuthForDirectUse()`, which returns `{}` (truthy) when no credentials
 * exist (postmortem 260406).
 *
 * @warning Do NOT use as a provider-gate discriminator. Pair with
 * {@link isDirectAnthropicConfig} for any code path that calls
 * `createDirectAnthropicClient` / `callAnthropic` / direct-Anthropic API
 * surface. A `true` here when `activeProvider === 'openrouter' | 'codex'`
 * means a stale key is around, not that direct-Anthropic is the right route.
 *
 * @example Anti-pattern (DO NOT do this):
 * ```ts
 * if (hasDirectAuth(settings)) { callAnthropic(...); } // leaks for OR/Codex
 * ```
 *
 * @example Correct pattern:
 * ```ts
 * if (isDirectAnthropicConfig(settings) && hasDirectAuth(settings)) {
 *   callAnthropic(...);
 * }
 * ```
 *
 * @see isDirectAnthropicConfig
 * @see docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md
 * @see docs-private/postmortems/260406_auth_fallback_truthiness_postmortem.md
 */
export function hasDirectAuth(settings: AppSettings): boolean {
  const { apiKey, authToken } = getAuthForDirectUse(settings);
  return !!(apiKey || authToken);
}

/**
 * Get the API key for direct Anthropic SDK usage.
 *
 * **AUTH-SHAPE helper** — answers "what API key is available?", NOT "should
 * we route this through Anthropic directly?". A returned key may be a stale
 * Anthropic credential while `activeProvider === 'openrouter' | 'codex'`.
 *
 * Returns empty string if no API key is available.
 *
 * @warning Do NOT use as a provider-gate discriminator (e.g. in
 * `canRun` / `describe.skipIf` expressions). Pair with
 * {@link isDirectAnthropicConfig} for any code path that calls
 * `createDirectAnthropicClient` / `callAnthropic` / direct-Anthropic API
 * surface. The 260419 bug was exactly this misuse: a `canRun` gated on
 * `!!getApiKeyForDirectUse(settings)` let a live integration test hit
 * Anthropic's native API even when the user routed through OpenRouter.
 *
 * @example Anti-pattern (the 260419 shape — DO NOT do this):
 * ```ts
 * const canRun = !!getApiKeyForDirectUse(settings); // lies for OR/Codex users
 * describe.skipIf(!canRun)('live API', () => { ... });
 * ```
 *
 * @example Correct pattern:
 * ```ts
 * const canRun =
 *   isDirectAnthropicConfig(settings) && hasDirectAuth(settings);
 * if (!canRun) console.log('[skip] not direct-Anthropic configured');
 * describe.skipIf(!canRun)('live API', () => { ... });
 * ```
 *
 * @see isDirectAnthropicConfig
 * @see docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md
 * @see docs-private/postmortems/260406_auth_fallback_truthiness_postmortem.md
 */
export function getApiKeyForDirectUse(settings: AppSettings): string {
  return getAuthForDirectUse(settings).apiKey ?? '';
}

/**
 * Check if currently using OAuth token for auth.
 * Claude OAuth is deprecated (April 2026) — this now only returns true for OpenRouter OAuth.
 */
export function isUsingOAuth(settings: AppSettings): boolean {
  return isUsingOpenRouter(settings);
}

/**
 * Get API key auth env vars for fallback scenarios.
 * Used when OAuth doesn't support a feature (like 1M context) but API key does.
 * Returns null if no API key is available.
 */
export function getApiKeyAuthEnvVars(settings: AppSettings): Record<string, string> | null {
  const key = sanitize(getApiKey(settings));
  if (key) return { ANTHROPIC_API_KEY: key };
  if (process.env.ANTHROPIC_API_KEY) {
    return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  }
  return null;
}

/**
 * Build env vars for configured third-party provider API keys.
 * Convention: provider key ID → UPPERCASE_API_KEY (e.g. 'openai' → 'OPENAI_API_KEY').
 *
 * Future-proof: new entries in ProviderKeys are automatically mapped
 * without code changes — just add the provider to ModelProviderType.
 */
export function getProviderKeyEnvVars(providerKeys: ProviderKeys | undefined): Record<string, string> {
  if (!providerKeys) return {};
  const env: Record<string, string> = {};
  for (const [provider, key] of Object.entries(providerKeys)) {
    const normalized = normalizeApiKey(key);
    if (normalized) {
      env[`${provider.toUpperCase()}_API_KEY`] = normalized;
    }
  }
  return env;
}


// ---------------------------------------------------------------------------
// Rate-limit fallback helpers
// See: docs/plans/260415_codex_rate_limit_fallback.md
// ---------------------------------------------------------------------------

/** Result of resolving a tier-specific model fallback from settings. */
export type TierFallbackResult = {
  modelOverride?: string;
  profileOverrideId?: string;
  provider?: 'anthropic' | 'openai' | 'openrouter';
  /** Original setting value for logging (e.g. "model:claude-sonnet-4-6") */
  rawValue: string;
};

/**
 * Resolve a tier-specific model fallback from settings.
 * Tries thinkingFallback first (if set), then workingFallback.
 * No tier detection — in a rate-limit scenario any working model beats a dead conversation.
 *
 * Returns null if neither fallback is configured.
 */
export function resolveTierFallback(settings: AppSettings): TierFallbackResult | null {
  const candidates = [
    getThinkingFallback(settings),
    getWorkingFallback(settings),
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    const parsed = parseFallbackEncoding(raw);
    if (parsed) return { ...parsed, rawValue: raw };
  }

  return null;
}

/**
 * Parse a "model:<name>" or "profile:<id>" encoded fallback value.
 *
 * NOT consolidated onto the canonical `@shared/utils/btsModelValueNormalization`
 * decoders (`decodePrefixed` / `normalizeStoredBtsModelValue` / `stripStoredModelPrefix`)
 * because this parser's behaviour DIVERGES from all three in load-bearing ways
 * (pinned by `btsStoragePrefixParsers.truthTable.test.ts`):
 *  - BARE / unknown-prefix input (e.g. `'claude-sonnet-4-6'`, `'unknown:value'`)
 *    must return `null` so the rate-limit waterfall (`resolveTierFallback`) SKIPS it.
 *    `decodePrefixed` instead PASSES bare values through as `{kind:'model'}`, which
 *    would make every plain string a "configured" tier fallback — wrong here.
 *  - Payload is intentionally NOT trimmed (`'model:   '` → `{modelOverride:'   '}`),
 *    matching the historical raw `.slice()` (the canonical decoders `.trim()` the payload).
 *  - Input is typed `string` and is NOT null/undefined-guarded by this fn — the
 *    only caller (`resolveTierFallback`) pre-filters falsy values.
 * Treat any future "just use the shared decoder here" refactor as a behaviour change.
 */
function parseFallbackEncoding(value: string): { modelOverride?: string; profileOverrideId?: string } | null {
  if (value.startsWith('model:')) {
    const model = value.slice('model:'.length);
    return model ? { modelOverride: model } : null;
  }
  if (value.startsWith('profile:')) {
    const profileId = value.slice('profile:'.length);
    return profileId ? { profileOverrideId: profileId } : null;
  }
  return null;
}

/** Test-only seam exposing {@link parseFallbackEncoding} so the storage-prefix
 *  truth-table test can pin its exact (divergent-from-canonical) behaviour. */
export const __parseFallbackEncodingAuthEnvForTests = parseFallbackEncoding;

function inferTierFallbackProvider(model: string | undefined): 'anthropic' | 'openai' | 'openrouter' | undefined {
  if (!model) return undefined;
  return toProviderSwitchProvider(model);
}

/** The single best fallback target for a Codex rate-limit. */
export type RateLimitFallbackTarget =
  | {
    kind: 'tier_model';
    modelOverride?: string;
    profileOverrideId?: string;
    provider?: 'anthropic' | 'openai' | 'openrouter';
    rawValue: string;
  }
  | { kind: 'provider'; provider: Exclude<ActiveProvider, 'codex'>; model: string };

/**
 * Evaluate the full fallback waterfall and return the single best configured option.
 * Returns null if nothing is configured.
 *
 * Waterfall order (picks the first that's set up):
 * 1. Tier fallback (thinkingFallback → workingFallback)
 * 2. OpenRouter (if credentials present)
 * 3. Anthropic direct API key
 */
export function getRateLimitFallbackTarget(settings: AppSettings): RateLimitFallbackTarget | null {
  // 1. Tier fallback
  const tier = resolveTierFallback(settings);
  if (tier) {
    return {
      kind: 'tier_model',
      ...tier,
      provider: tier.provider ?? inferTierFallbackProvider(tier.modelOverride),
    };
  }

  // 2. OpenRouter
  if (hasOpenRouterCredentials(settings) && settings.openRouter?.selectedModel) {
    return {
      kind: 'provider',
      provider: 'openrouter',
      model: settings.openRouter.selectedModel,
    };
  }

  // 3. Anthropic direct
  if (hasDirectAuth(settings)) {
    return {
      kind: 'provider',
      provider: 'anthropic',
      // Anthropic-pinned by branch contract: this branch only fires when hasDirectAuth() is true,
      // so DEFAULT_MODEL (a Claude model) is the correct provider-aligned default here.

      model: DEFAULT_MODEL,
    };
  }

  return null;
}
