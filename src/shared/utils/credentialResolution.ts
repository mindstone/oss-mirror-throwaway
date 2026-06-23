import type { AppSettings, ModelProfile } from '@shared/types';
import { isCodexSubscriptionProfile, normalizeApiKey, resolveProfileApiKey } from './providerKeys';
import { resolveModelSettings } from './modelSettingsResolver';

/**
 * Concrete connection-credential material for a dispatchable profile. Defined here (the
 * canonical credential module) and re-exported from connectionCredentials.ts for back-compat;
 * keeping the type here makes the dependency one-directional (connectionCredentials.ts depends
 * on this module, not vice versa — avoids a circular import).
 */
export interface ConnectionCredentials {
  apiKey?: string;
  oauthToken?: string;
  sessionMode?: 'codex' | 'oauth' | 'api-key';
}

/**
 * Canonical credential-resolution chokepoint (Stage E2).
 *
 * This is the single ladder that decides, for a given `(profile, settings, codexMode)`,
 * BOTH which credential is reachable AND the concrete material to dispatch with. It is the
 * extracted, source-stamped form of the client-side resolver `resolveConnectionCredentials`
 * (which is now a thin projection over this function — see connectionCredentials.ts).
 *
 * WHY this exists: credential reachability was historically computed independently by the
 * client resolver and the router's `profileDecision()` (providerRouting.ts). Two shipped
 * bugs (260513, 260611) were divergences in that ladder — the router was blind to the shared
 * OpenRouter OAuth token the client could see. The `providerRouting.profileCredentialMatrix`
 * test pins the two sides equal; this module turns the *client* side of that agreement into a
 * named, reusable, single-source-of-truth ladder so additional consumers (eligibility, future
 * routeRef binding) can ask the same question without re-deriving it.
 *
 * SCOPE NOTE (E2b, deferred): the router (`profileDecision`) is NOT yet routed through this
 * chokepoint. It is a structurally distinct decision tree (organised by providerType, reading
 * the *settings* Anthropic key via `getApiKey`, not the profile key) that only agrees with the
 * client resolver on the matrix-tested rows. Unifying it safely requires expanding the
 * credential matrix to lock the currently-untested divergence edges (non-managed Anthropic
 * with a per-profile key; `anthropic-oauth-token`; the `getApiKey` models-only read vs
 * `resolveModelSettings` models+legacy-`claude.*` read) and a dedicated AUTH review. Until
 * then the router keeps its own ladder, pinned equal to this one by the matrix test.
 */

/** Credential sources that represent a reachable, dispatchable credential. */
export type ReachableCredentialSource =
  | 'anthropic-api-key'
  | 'openrouter-oauth-token'
  | 'profile-api-key'
  | 'openai-api-key'
  | 'codex-subscription'
  | 'local-none';

/** Credential sources that represent a missing/unreachable credential. */
export type MissingCredentialSource =
  | 'missing-anthropic'
  | 'missing-openrouter'
  | 'missing-codex'
  | 'missing-profile';

/**
 * The verdict every consumer reads. `kind` gives the boolean reachability; `source` gives the
 * exact classification (so the result lines up with the matrix's `expectedCredentialSource`);
 * `credentials` carries the dispatch material for reachable verdicts.
 */
export type CredentialResolution =
  | { kind: 'reachable'; source: ReachableCredentialSource; credentials: ConnectionCredentials }
  | { kind: 'unreachable'; source: MissingCredentialSource };

function isManagedConnectionProfile(profile: ModelProfile | null | undefined): boolean {
  return profile?.profileSource === 'connection' || profile?.profileSource === 'auto';
}

function hasCodexSession(codexMode: unknown): boolean {
  return codexMode !== undefined && codexMode !== null && codexMode !== false;
}

/**
 * The missing-credential source for a non-local, non-openrouter profile whose credential could
 * not be resolved in the non-managed fall-through.
 */
function missingSourceFor(profile: ModelProfile): MissingCredentialSource {
  if (isCodexSubscriptionProfile(profile)) return 'missing-codex';
  if (profile.providerType === 'anthropic') return 'missing-anthropic';
  return 'missing-profile';
}

/**
 * The Anthropic credential source classification keyed on the GLOBAL settings credential
 * (`models.*`), independent of any profile. The single authority for "which Anthropic
 * credential the ROUTER sees" — the router's three Anthropic ladders (`providerModeFor`,
 * `profileDecision`, the codex-divert native-Claude read) all derive their Anthropic
 * `credentialSource` from this one function (E2b).
 *
 * Precedence (preserved verbatim from the router's historical ladder): a settings api-key wins;
 * else an OAuth token under `authMethod: 'oauth-token'` (the deprecated Claude Max OAuth path,
 * `anthropic-oauth-token`); else missing. Reads via `resolveModelSettings`, which reads
 * `models.*` only — byte-identical to the router's `getApiKey`/`getOAuthToken`/`getAuthMethod`
 * accessors (all three resolve the same `models.*` fields), so routing the router through this
 * helper preserves its classification exactly. Presence is checked with `normalizeApiKey`
 * (trim-empty ⇒ missing), which agrees with the router's `sanitize` on presence.
 *
 * SCOPE — this is the router's authority ONLY. `resolveCredentialsForProfile` (the client-side
 * dispatch-material ladder) deliberately does NOT use it for its managed-Anthropic arm: that arm
 * stays api-key-only and treats `anthropic-oauth-token` as unreachable, because its consumers
 * (`createOpenAIClientFromProfile`, the proxy bearer path) would mis-project an Anthropic OAuth
 * token as an OpenAI-style bearer. Anthropic dispatch never flows through the client resolver
 * (it goes anthropic-direct), so the two sides diverge harmlessly on the OAuth path — pinned by
 * the `providerRouting.profileCredentialMatrix` edge-(a) test.
 */
export function classifyAnthropicSettingsCredential(
  settings: AppSettings,
): 'anthropic-api-key' | 'anthropic-oauth-token' | 'missing-anthropic' {
  const resolved = resolveModelSettings(settings);
  if (normalizeApiKey(resolved.apiKey)) return 'anthropic-api-key';
  if (resolved.authMethod === 'oauth-token' && normalizeApiKey(resolved.oauthToken)) {
    return 'anthropic-oauth-token';
  }
  return 'missing-anthropic';
}

/**
 * Resolve the reachable credential (and its source) for a profile, or report it unreachable.
 *
 * Mirrors `resolveConnectionCredentials` exactly — same inputs, same two-branch (non-managed
 * vs managed) structure, same precedence — and additionally stamps the
 * `ProviderCredentialSource`-aligned classification. The structure is preserved VERBATIM
 * (rather than hoisting a unified localhost check) so the projection in
 * `resolveConnectionCredentials` is behaviour-identical: a direct/profile key still wins over
 * the local-none fall-through (non-managed `local` profiles with an explicit key), and the
 * managed localhost short-circuit / managed-`local`-non-localhost throw are both preserved.
 */
export function resolveCredentialsForProfile(
  profile: ModelProfile,
  settings: AppSettings,
  codexMode?: unknown,
): CredentialResolution {
  const directApiKey = normalizeApiKey(
    resolveProfileApiKey(profile, settings.providerKeys, settings.customProviders),
  ) ?? undefined;

  if (!isManagedConnectionProfile(profile)) {
    if (isCodexSubscriptionProfile(profile) && hasCodexSession(codexMode)) {
      return { kind: 'reachable', source: 'codex-subscription', credentials: { sessionMode: 'codex' } };
    }
    // A direct/profile key wins over the local-none fall-through below (preserves the original
    // ordering: non-managed `local` profiles with an explicit key dispatch with that key).
    if (directApiKey) {
      return {
        kind: 'reachable',
        source: profile.providerType === 'openai' ? 'openai-api-key' : 'profile-api-key',
        credentials: { apiKey: directApiKey, sessionMode: 'api-key' },
      };
    }
    if (profile.providerType === 'openrouter') {
      const oauthToken = normalizeApiKey(settings.openRouter?.oauthToken) ?? undefined;
      return oauthToken
        ? { kind: 'reachable', source: 'openrouter-oauth-token', credentials: { oauthToken, sessionMode: 'oauth' } }
        : { kind: 'unreachable', source: 'missing-openrouter' };
    }
    // Original non-managed fall-through returned `{}`; a `local` profile is the reachable
    // local-none case (matches profileDecision + the matrix's local row), everything else is
    // genuinely unreachable. Either way the projection returns `{}` for non-managed.
    if (profile.providerType === 'local') {
      return { kind: 'reachable', source: 'local-none', credentials: {} };
    }
    return { kind: 'unreachable', source: missingSourceFor(profile) };
  }

  // Managed (connection/auto) profiles. Localhost short-circuit is URL-based (matches the
  // original managed branch) — NOT providerType-based, so it cannot pre-empt real material.
  if (
    profile.serverUrl?.startsWith('http://localhost') ||
    profile.serverUrl?.startsWith('http://127.0.0.1')
  ) {
    return { kind: 'reachable', source: 'local-none', credentials: {} };
  }

  if (isCodexSubscriptionProfile(profile)) {
    return hasCodexSession(codexMode)
      ? { kind: 'reachable', source: 'codex-subscription', credentials: { sessionMode: 'codex' } }
      : { kind: 'unreachable', source: 'missing-codex' };
  }

  switch (profile.providerType) {
    case 'anthropic': {
      // Managed Anthropic profiles read the resolved Anthropic settings key, not a per-profile
      // key (matches the matrix's "managed anthropic" rows). DELIBERATELY api-key-only: this
      // resolver does NOT honour the legacy `anthropic-oauth-token` path, so it diverges from
      // the router (which classifies it via `classifyAnthropicSettingsCredential`). That
      // divergence is HARMLESS because nothing dispatches an Anthropic profile through this
      // resolver — Anthropic routes go anthropic-direct (`createDirectAnthropicClient`), never
      // through `createOpenAIClientFromProfile`/the proxy bearer path that consume this verdict.
      // Honouring the OAuth token here would let `createOpenAIClientFromProfile` project the
      // Anthropic OAuth token as an OpenAI-style bearer (wrong-protocol credential), so we keep
      // the arm api-key-only and pin the divergence in the matrix test.
      const apiKey = normalizeApiKey(resolveModelSettings(settings).apiKey) ?? undefined;
      return apiKey
        ? { kind: 'reachable', source: 'anthropic-api-key', credentials: { apiKey, sessionMode: 'api-key' } }
        : { kind: 'unreachable', source: 'missing-anthropic' };
    }
    case 'google': {
      const apiKey = directApiKey ?? normalizeApiKey(settings.providerKeys?.google) ?? undefined;
      return apiKey
        ? { kind: 'reachable', source: 'profile-api-key', credentials: { apiKey, sessionMode: 'api-key' } }
        : { kind: 'unreachable', source: 'missing-profile' };
    }
    case 'openrouter': {
      if (directApiKey) {
        return { kind: 'reachable', source: 'profile-api-key', credentials: { apiKey: directApiKey, sessionMode: 'api-key' } };
      }
      const oauthToken = normalizeApiKey(settings.openRouter?.oauthToken) ?? undefined;
      return oauthToken
        ? { kind: 'reachable', source: 'openrouter-oauth-token', credentials: { oauthToken, sessionMode: 'oauth' } }
        : { kind: 'unreachable', source: 'missing-openrouter' };
    }
    case 'openai': {
      const apiKey = directApiKey ?? normalizeApiKey(settings.providerKeys?.openai) ?? undefined;
      return apiKey
        ? { kind: 'reachable', source: 'openai-api-key', credentials: { apiKey, sessionMode: 'api-key' } }
        : { kind: 'unreachable', source: 'missing-profile' };
    }
    case 'together':
    case 'cerebras':
    case 'other':
      return directApiKey
        ? { kind: 'reachable', source: 'profile-api-key', credentials: { apiKey: directApiKey, sessionMode: 'api-key' } }
        : { kind: 'unreachable', source: 'missing-profile' };
    case undefined:
      return { kind: 'unreachable', source: 'missing-profile' };
  }

  return { kind: 'unreachable', source: 'missing-profile' };
}

/**
 * Convenience predicate for consumers that only need reachability (eligibility, route gating)
 * rather than the dispatch material. One call, one source of truth.
 */
export function isProfileCredentialReachable(
  profile: ModelProfile,
  settings: AppSettings,
  codexMode?: unknown,
): boolean {
  return resolveCredentialsForProfile(profile, settings, codexMode).kind === 'reachable';
}
