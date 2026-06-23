import type { ActiveProvider, AppSettings, CustomProvider, ModelProfile, ProviderKeys } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { normalizeModel } from '@shared/utils/modelNormalization';
import { brandRouteWireModel, type DirectAnthropicBareWireModel, type WireModelId } from '@shared/utils/wireModelId';
import { isCodexSubscriptionProfile, resolveProfileApiKey } from '@shared/utils/providerKeys';
import {
  classifyAnthropicSettingsCredential,
  resolveCredentialsForProfile,
} from '@shared/utils/credentialResolution';
import { isProfileSelectable } from '@shared/utils/profileHelpers';
import { canRouteSlashFormModel as canRouteSlashFormModelFromSettings } from '@shared/utils/slashFormRouting';
import { isCodexServableModel } from '@shared/data/codexModels';
import { normalizeOrModelId } from '@shared/data/openRouterModels';
import { MODEL_PREFIX, normalizeStoredBtsModelValue, PROFILE_PREFIX } from '@shared/utils/modelChoiceCodec';
import { getEnabledProviders } from '@shared/utils/settingsUtils';
import { toActiveProviderForFallback } from '@shared/utils/modelIdClassifier';
import { getManagedKeyAvailability } from './managedKeyAvailability';
import { billingSourceForCredentialSource } from './providerBillingSource';
import { materializePlanRuntime, type ProviderRouteRuntimeContext } from './providerRoutePlan';
import type { ProviderRoutePlan } from './providerRoutePlanTypes';
import { createRoleResolutionModelError } from './modelErrors';
import { resolveDefaultModelForRole, type ModelRole } from './modelRoleResolver';
import type { ConfiguredFallbackRole } from './configuredRoleFallback';
import {
  getThinkingFallback,
  getWorkingFallback,
  getWorkingProfileId,
} from './settingsAccessors';
import {
  assertNever,
  DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT,
  deriveDispatchPath,
  getProfileModel,
  inferModelDialect,
  isDispatchableDecision,
  isRouteTableDispatch,
  isRouteTableScope,
  isLocalhostUrl,
  profileReferenceId,
  resolveDirectAnthropicModel,
  stripAnthropicProviderPrefix,
  type CodexConnectivity,
  type DirectAnthropicModelResolution,
  type DispatchableDispatchPath,
  type DispatchableRouteDecision,
  type DispatchableTransport,
  type ProviderCredentialSource,
  type ProviderFallbackHint,
  type ProviderInvalidReason,
  type ProviderModelDialect,
  type ProviderResolvedFrom,
  type ProviderRouteDecision,
  type ProviderRouteProvider,
  type ProviderRouteRole,
  type ProviderRouteScope,
  type RouteRebuildHint,
  type TerminalRouteDecision,
} from './providerRouteDecision';

export interface ProviderRouteSettings {
  activeProvider?: ActiveProvider;
  models?: {
    apiKey?: string | null;
    oauthToken?: string | null;
    authMethod?: 'api-key' | 'oauth-token';
    model?: string;
    thinkingModel?: string;
    workingProfileId?: string;
    thinkingProfileId?: string;
    thinkingFallback?: string;
    workingFallback?: string;
  };
  openRouter?: {
    enabled?: boolean;
    oauthToken?: string | null;
    selectedModel?: string;
  };
  localModel?: {
    activeProfileId?: string | null;
    profiles?: ModelProfile[];
  };
  behindTheScenesModel?: string;
  behindTheScenesOverrides?: Partial<Record<string, string>>;
  providerKeys?: ProviderKeys;
  customProviders?: CustomProvider[];
  /** Whether a managed (Mindstone subscription) OpenRouter key exists in secure storage. Injected by the main process. */
  hasManagedKey?: boolean;
  /**
   * Ordered (highest-priority-first) multi-provider list (Phase 2 foundation).
   * Read via `getEnabledProviders`. Consumed by `enumerateProviderModeCandidates`
   * ONLY when `experimental.multiProviderRoutingEnabled` is on — otherwise the
   * single `activeProvider` is used exactly as before.
   */
  enabledProviders?: ActiveProvider[];
  /**
   * Routing-relevant experimental flags. The full `AppSettings` (which carries
   * `experimental`) flows in here at runtime; only the routing flag is typed at
   * this boundary. Absent in narrowed test/literal settings → the flag reads
   * false → behaviour-preserving.
   */
  experimental?: { multiProviderRoutingEnabled?: boolean };
}

const log = createScopedLogger({ service: 'providerRouting' });

export type ProviderMode =
  | { provider: 'anthropic'; credentialSource: 'anthropic-api-key' | 'anthropic-oauth-token' | 'missing-anthropic' }
  | { provider: 'openrouter'; credentialSource: 'openrouter-oauth-token' | 'missing-openrouter' | 'mindstone-managed-key' | 'missing-mindstone' }
  | { provider: 'codex'; credentialSource: 'codex-subscription' | 'missing-codex' };

interface ProviderRouterBaseInput {
  settings: ProviderRouteSettings;
  model?: string | null;
  profile?: ModelProfile | null;
  routedModel?: string | null;
  codexConnectivity: CodexConnectivity;
  routeScope?: ProviderRouteScope;
  fallbackHint?: ProviderFallbackHint | null;
  /**
   * Credential sources currently in a rate-limit cooldown (Stage 4 failover
   * input). A SNAPSHOT the caller derives from `providerRateLimitCooldowns` and
   * threads in (like `codexConnectivity`), keeping the router pure. Only affects
   * multi-provider selection; absent/empty ⇒ no cooldown skipping (today's default).
   */
  cooledDownCredentialSources?: ReadonlySet<ProviderCredentialSource>;
}

export interface ProviderRouterTurnInput extends ProviderRouterBaseInput {
  role?: 'execution' | 'planning';
}

export interface ProviderRouterFallbackOptions {
  fallbackHint: RouteRebuildHint;
  inFlightPlan: ProviderRoutePlan;
}

export interface ProviderRouterBtsInput extends ProviderRouterBaseInput {
  category?: string | null;
}

export type ProviderRouterSubagentInput = ProviderRouterBaseInput;

export type ProviderRoutePlanRequest =
  | {
      kind: 'forTurn';
      input: ProviderRouterTurnInput;
      fallback?: ProviderRouterFallbackOptions;
    }
  | { kind: 'forBTS'; input: ProviderRouterBtsInput }
  | { kind: 'forSubagent'; input: ProviderRouterSubagentInput };

function sanitize(value: string | null | undefined): string {
  return value?.replace(/\s/g, '') ?? '';
}

/**
 * The router carries the narrowed `ProviderRouteSettings` view (only the routing-relevant
 * fields are typed at this boundary); the canonical credential authority
 * (`@shared/utils/credentialResolution`) is typed against the full `AppSettings`. Every field
 * the authority reads (`models`, `claude`, `openRouter`, `providerKeys`, `customProviders`,
 * `serverUrl`) is present on `ProviderRouteSettings` (or absent ⇒ read as undefined), so the
 * widening is read-only and behaviour-preserving — this adapter localises the cast.
 */
function asAppSettings(settings: ProviderRouteSettings): AppSettings {
  return settings as unknown as AppSettings;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMutableModelNamespace(settings: ProviderRouteSettings): NonNullable<ProviderRouteSettings['models']> {
  if (isObjectRecord(settings.models)) {
    return settings.models as NonNullable<ProviderRouteSettings['models']>;
  }
  return {};
}

function hasOpenRouterCredentials(settings: Pick<ProviderRouteSettings, 'openRouter'>): boolean {
  // Normalize before the presence check so a whitespace-only token reads as
  // missing — matching the client resolver (`resolveConnectionCredentials` →
  // `normalizeApiKey`) and the profileSource backfill migration. A raw
  // truthiness check would let the router classify a blank token as dispatchable
  // while the client and the actual request see no credential (silent divergence).
  return !!sanitize(settings.openRouter?.oauthToken);
}

export function canRouteSlashFormModel(
  settings: Pick<ProviderRouteSettings, 'activeProvider' | 'openRouter'>,
): boolean {
  return canRouteSlashFormModelFromSettings(settings);
}

/**
 * The `ProviderMode` a GIVEN provider resolves to under the current credentials —
 * the per-provider core of {@link selectProviderMode}, extracted so the Stage 3
 * multi-provider enumeration can ask "what mode would provider X yield?" for each
 * candidate in `enabledProviders` (not only `settings.activeProvider`). Behaviour
 * is unchanged: `selectProviderMode(settings)` is exactly
 * `providerModeFor(settings.activeProvider ?? 'anthropic', settings)`.
 */
function providerModeFor(provider: ActiveProvider, settings: ProviderRouteSettings): ProviderMode {
  switch (provider) {
    case 'openrouter':
      return {
        provider: 'openrouter',
        credentialSource: hasOpenRouterCredentials(settings) ? 'openrouter-oauth-token' : 'missing-openrouter',
      };
    case 'mindstone': {
      // Mindstone managed subscription routes through OpenRouter with a managed key.
      // Fail-closed: if managed key is not in secure storage, report missing (never fall back to personal key).
      //
      // `hasManagedKey` is an inject-at-call-time augmentation, not a persisted setting.
      // Resolve it centrally here so that call sites which forward bare settings
      // (forSubagent, preflight, model-name fallback) still see a provisioned key instead
      // of silently collapsing to `missing-mindstone`. Explicit injection still wins via `??`.
      const hasManagedKey = settings.hasManagedKey ?? getManagedKeyAvailability();
      return {
        provider: 'openrouter',
        credentialSource: hasManagedKey ? 'mindstone-managed-key' : 'missing-mindstone',
      };
    }
    case 'codex':
      return { provider: 'codex', credentialSource: 'codex-subscription' };
    case 'anthropic': {
      // Single Anthropic credential authority (E2b). Identical classification to the prior
      // inline ladder — `classifyAnthropicSettingsCredential` reads the same `models.*` fields
      // (`getApiKey`/`getAuthMethod`/`getOAuthToken`) with the same precedence — so the
      // `ProviderMode.credentialSource` feeding the multi-provider chain (Invariant F) is
      // byte-identical.
      return { provider: 'anthropic', credentialSource: classifyAnthropicSettingsCredential(asAppSettings(settings)) };
    }
    default:
      return assertNever(provider, 'ActiveProvider');
  }
}

export function selectProviderMode(settings: ProviderRouteSettings): ProviderMode {
  // `undefined` activeProvider collapses to the Anthropic/default arm exactly as
  // before (the old `case 'anthropic': case undefined:` shared body). NOTE one
  // deliberate divergence on OFF-TYPE input: a literal `null` (not in the
  // `ActiveProvider` union; only reachable from malformed persisted/cast data)
  // used to hit the old switch `default` → `assertNever` and THROW; via `??` it
  // now defaults to Anthropic like `undefined`. This is a safe hardening (no
  // crash on garbage), not a routing change for any in-type input. A genuinely
  // unknown string (e.g. `'bogus'`) still reaches `assertNever` in `providerModeFor`.
  return providerModeFor(settings.activeProvider ?? 'anthropic', settings);
}

function findProfileById(settings: ProviderRouteSettings, id: string | null): ModelProfile | null {
  if (!id) return null;
  return settings.localModel?.profiles?.find((profile) => profile.id === id) ?? null;
}

function isRoutableProfile(profile: ModelProfile | null | undefined): profile is ModelProfile {
  if (!profile) return false;
  if (profile.enabled === false) return false;
  if (!isProfileSelectable(profile)) return false;
  return Boolean(profile.model?.trim());
}

/**
 * NOT consolidated onto the canonical `@shared/utils/btsModelValueNormalization`
 * decoders because its behaviour DIVERGES from all three in load-bearing ways
 * (pinned by `btsStoragePrefixParsers.truthTable.test.ts`):
 *  - BARE / unknown-prefix input must return `null` so `applyEncodedFallback`
 *    clears the profile (treats it as "no encoded fallback"). `decodePrefixed`
 *    would instead pass bare values through as `{kind:'model'}`, hijacking the
 *    Codex rate-limit fallback path. This is the same divergence as the
 *    `authEnvUtils` clone, with a different result shape (`{kind,model}` here).
 *  - Payload IS trimmed (`'model:   '` → null) but the whole input is NOT trimmed
 *    before `startsWith` (`'  model:x'` → null), matching the historical raw shape.
 * Treat any "just use the shared decoder here" refactor as a behaviour change.
 */
function parseFallbackEncoding(value: string | null | undefined): { kind: 'model'; model: string } | { kind: 'profile'; profileId: string } | null {
  if (!value) return null;
  if (value.startsWith('model:')) {
    const model = value.slice('model:'.length).trim();
    return model ? { kind: 'model', model } : null;
  }
  if (value.startsWith('profile:')) {
    const profileId = value.slice('profile:'.length).trim();
    return profileId ? { kind: 'profile', profileId } : null;
  }
  return null;
}

/** Test-only seam exposing {@link parseFallbackEncoding} so the storage-prefix
 *  truth-table test can pin its exact (divergent-from-canonical) behaviour. */
export const __parseFallbackEncodingProviderRoutingForTests = parseFallbackEncoding;

function inferActiveProviderForFallbackModel(model: string): ActiveProvider | undefined {
  // Delegates to the centralized adapter, which deliberately omits the `gpt-` arm
  // (its result widens cleanly into ActiveProvider).
  return toActiveProviderForFallback(model);
}

function withActiveProvider(settings: ProviderRouteSettings, activeProvider: ActiveProvider): ProviderRouteSettings {
  const currentModels = getMutableModelNamespace(settings);
  return {
    ...settings,
    activeProvider,
    ...(activeProvider === 'openrouter' && settings.openRouter
      ? { openRouter: { ...settings.openRouter, enabled: true } }
      : {}),
    models: {
      ...currentModels,
      workingProfileId: undefined,
      thinkingProfileId: undefined,
    },
    localModel: {
      profiles: settings.localModel?.profiles ?? [],
      activeProfileId: null,
    },
  };
}

function hasAnthropicCredentials(settings: ProviderRouteSettings): boolean {
  // Single Anthropic credential authority (E2b): reachable IFF the classifier resolves a
  // concrete source (api-key or oauth-token), identical to the prior inline ladder.
  return classifyAnthropicSettingsCredential(asAppSettings(settings)) !== 'missing-anthropic';
}

function codexDirectAnthropicDivertWireModel(
  resolution: DirectAnthropicModelResolution,
): DirectAnthropicBareWireModel | null {
  switch (resolution.kind) {
    case 'native-claude':
      return resolution.wireModel;
    case 'bare-non-claude':
    case 'foreign-dialect':
      return null;
  }
  const _exhaustive: never = resolution;
  return _exhaustive;
}

function bestNonCodexProvider(settings: ProviderRouteSettings): ActiveProvider | null {
  if (hasOpenRouterCredentials(settings)) return 'openrouter';
  if (hasAnthropicCredentials(settings)) return 'anthropic';
  return null;
}

/**
 * A non-empty list of provider candidates, head-first. The head is the
 * highest-priority candidate. Today the list always has exactly one element
 * (see {@link enumerateProviderModeCandidates}); the tuple shape makes that
 * non-emptiness a TYPE guarantee so the selection step ({@link pickProviderMode})
 * cannot be handed an empty list, and so Stage 2 can widen the tail without
 * relaxing this invariant.
 */
type ProviderModeCandidates = readonly [ProviderMode, ...ProviderMode[]];

/**
 * Compile-time exhaustiveness guard for the provider axis of the
 * "enumerate candidates → pick one" seam. The provider-choice point routes the
 * picked candidate's provider through this so that ANY future widening of the
 * `ProviderMode` provider union (or a new `ActiveProvider` that produces a new
 * provider tag) fails to compile here until it is consciously handled —
 * preventing a new provider from silently falling through the selection seam.
 *
 * This is purely a by-construction guard: at runtime it returns the provider
 * unchanged (it is the identity on `ProviderMode['provider']`), so it introduces
 * zero behaviour.
 */
function assertExhaustiveProviderMode(mode: ProviderMode): ProviderMode {
  switch (mode.provider) {
    case 'anthropic':
    case 'openrouter':
    case 'codex':
      return mode;
    default:
      return assertNever(mode, 'ProviderMode in provider-choice seam');
  }
}

/**
 * By-construction validation set for `enabledProviders` items. A
 * `Record<ActiveProvider, true>` so adding a new provider to the union forces a
 * compile error here until it is listed — and so a malformed persisted/cloud
 * value (a typo, a retired provider id) is FILTERED OUT before it reaches
 * `providerModeFor`'s `assertNever` (which would otherwise throw at runtime).
 * See Stage 2 GPT carry-forward invariant (2): don't trust persisted list data.
 */
const KNOWN_ACTIVE_PROVIDERS: Record<ActiveProvider, true> = {
  anthropic: true,
  openrouter: true,
  codex: true,
  mindstone: true,
};

function isKnownActiveProvider(value: unknown): value is ActiveProvider {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KNOWN_ACTIVE_PROVIDERS, value);
}

/**
 * Managed-billing invariant (WS4b billing-correctness, GPT-5.5-extra-high MUST-ADDRESS):
 * `mindstone` is MANAGED billing (Mindstone pays, via `mindstone-managed-key`). It must be
 * used ONLY when the user has EXPLICITLY chosen it as their primary `activeProvider` — it is
 * NEVER auto-selected as a FAILOVER / backup candidate. The UI already hides Mindstone from
 * the backup chooser (`BackupConnectionsSection`), but the router must enforce the same
 * invariant so a persisted / cloud-synced / hand-edited `enabledProviders` list containing
 * `mindstone` can never auto-route a 429 failover onto managed billing (which the WS4b reroute
 * path would then mis-derive as personal/401 from the global non-mindstone `activeProvider`).
 *
 * This is the SINGLE authoritative chokepoint: it filters the validated `enabledProviders`
 * candidate id list (the input to {@link enumerateProviderModeCandidates}, which feeds BOTH
 * the primary `pickProviderMode` and the failover `getFailoverCredentialCandidates`). A
 * `mindstone` entry survives ONLY when it equals the explicit primary `activeProvider`;
 * any other position (tail = backup / failover) is dropped. The flag-OFF / degenerate
 * single-provider path goes through {@link selectProviderMode} and never reaches here, so an
 * explicit `activeProvider === 'mindstone'` primary turn is untouched.
 */
function excludeManagedFromFailover(
  providers: ActiveProvider[],
  activeProvider: ActiveProvider | undefined,
): ActiveProvider[] {
  return providers.filter((provider) => provider !== 'mindstone' || provider === activeProvider);
}

/** Settings/connectivity context the multi-provider pick needs beyond the candidate itself. */
interface ProviderModeUsabilityContext {
  codexConnectivity: CodexConnectivity;
  /**
   * Credential sources currently in a rate-limit cooldown (Stage 4 failover). A
   * SNAPSHOT threaded in by the caller (like `codexConnectivity`) so the seam
   * stays pure — never read from the cooldown store here. A candidate whose
   * `credentialSource` is in this set is skipped so selection fails over to the
   * next usable provider. Empty/undefined ⇒ no cooldown skipping (today's default).
   */
  cooledDownCredentialSources?: ReadonlySet<ProviderCredentialSource>;
}

/**
 * Is this resolved `ProviderMode` USABLE right now — i.e. would the provider-arm
 * switch in `routeDecision` produce a dispatchable route on the CREDENTIAL +
 * (for Codex) CONNECTIVITY axes, rather than a `missing-*` terminal — AND is its
 * credential not in a rate-limit cooldown (Stage 4)?
 *
 * This is the Stage 3 selection axis. It deliberately does NOT model per-model
 * capability (e.g. a Claude model on Codex diverts to Anthropic; a foreign
 * dialect on Anthropic is a terminal) — that is a model-specific concern owned by
 * the eligibility/failover layer (`routeEligibility.eligible()` and Stage 4),
 * not the static provider pick. Honest scope: "highest-priority provider whose
 * credentials are present (and, for ChatGPT Pro, whose connection is live) and
 * which is not rate-limit-cooled-down".
 */
function isUsableProviderMode(mode: ProviderMode, ctx: ProviderModeUsabilityContext): boolean {
  // Stage 4: a credential in rate-limit cooldown is unusable, so the pick fails
  // over to the next provider. (Identity on single-element lists — `pickProviderMode`
  // falls back to the head — so a single-provider user is never blocked here.)
  if (ctx.cooledDownCredentialSources?.has(mode.credentialSource)) {
    return false;
  }
  switch (mode.provider) {
    case 'anthropic':
      return mode.credentialSource !== 'missing-anthropic';
    case 'openrouter':
      return mode.credentialSource === 'openrouter-oauth-token' || mode.credentialSource === 'mindstone-managed-key';
    case 'codex':
      // Codex always resolves to `codex-subscription` statically; live connectivity
      // is what makes it dispatchable. When connectivity is unknown/disconnected and
      // alternatives exist, skip it (conservative) — a single-Codex list still routes
      // to Codex unchanged because `pickProviderMode` falls back to the head.
      return mode.credentialSource === 'codex-subscription' && ctx.codexConnectivity === 'connected';
    default:
      return assertNever(mode, 'ProviderMode in usability check');
  }
}

/**
 * ENUMERATION seam of the provider-choice point.
 *
 * Restructures "pick the one active provider" into an explicit
 * "enumerate the candidate providers → pick one" shape.
 *
 * DEFAULT (flag off, or no `enabledProviders` list): the candidate set is exactly
 * the single provider that {@link selectProviderMode} resolves from
 * `settings.activeProvider` — byte-for-byte today's choice as a single-element
 * list. This is the path EVERY user takes today (nothing writes the list until Stage 6).
 *
 * MULTI-PROVIDER (Stage 3, flag-gated on `experimental.multiProviderRoutingEnabled`):
 * the candidates are the ordered `enabledProviders` list (validated + de-duped),
 * each mapped via {@link providerModeFor}. An EMPTY enabled list (e.g. a fresh
 * user with `activeProvider === undefined` → `getEnabledProviders` returns `[]`)
 * falls back to `[selectProviderMode(settings)]` — NOT fail-closed (Stage 2 GPT
 * carry-forward invariant (1): empty list ⇒ legacy default path, so fresh users
 * keep today's Anthropic/default behaviour).
 *
 * NOTE: `selectProviderMode` is deliberately left as the single mapping from
 * `activeProvider` → `ProviderMode`; this seam layers the list on top of the
 * per-provider `providerModeFor`.
 */
function enumerateProviderModeCandidates(settings: ProviderRouteSettings): ProviderModeCandidates {
  if (settings.experimental?.multiProviderRoutingEnabled !== true) {
    return [selectProviderMode(settings)];
  }
  // Validate items (don't trust persisted/cloud data) and de-dupe while
  // preserving priority order; never mutate the array `getEnabledProviders`
  // returns (we map into a fresh array).
  const ordered = getEnabledProviders(settings).filter(isKnownActiveProvider);
  const deduped = ordered.filter((provider, index) => ordered.indexOf(provider) === index);
  // Managed-billing invariant: drop any `mindstone` that is NOT the explicit primary
  // (`activeProvider`) so managed billing is never an auto-failover candidate. See
  // `excludeManagedFromFailover`. Applied to the candidate id list (the shared input to
  // both the primary pick and the failover cap) before mode-mapping.
  const failoverEligible = excludeManagedFromFailover(deduped, settings.activeProvider);
  const modes = failoverEligible.map((provider) => providerModeFor(provider, settings));
  const [head, ...tail] = modes;
  if (!head) {
    // Empty/invalid list ⇒ legacy default path (invariant 1). The `!head` guard
    // also re-establishes the non-empty-tuple type for the caller.
    return [selectProviderMode(settings)];
  }
  return [head, ...tail];
}

/**
 * Stage 4b (C3) — the failover cap helper.
 *
 * Returns the distinct credential sources among the currently enabled providers
 * that are USABLE IGNORING COOLDOWN (i.e. have credentials + required connectivity
 * but are NOT filtered by any active rate-limit cooldown). This is the set the
 * Stage-4b failover branch can cycle through before declaring "all providers
 * rate-limited."
 *
 * PURE: does not read the cooldown store; the caller supplies the usability context
 * (with an EMPTY cooldown set so cooldown is intentionally ignored). Only called
 * from the recovery handler — not the routing hot path.
 *
 * Reads the turn-start settings snapshot (routeInput.settings), NOT ctx.settings —
 * the routeInput version has hasManagedKey injected by the executor. Callers must
 * pass routeInput.settings, not ctx.settings.
 *
 * Flag-sensitive: when `multiProviderRoutingEnabled` is off, `enumerateProviderModeCandidates`
 * returns a degenerate single-element list (the legacy single-provider path), so this
 * function effectively returns size=1 even if multiple providers are configured.
 *
 * Returns a `ReadonlySet` of `ProviderCredentialSource` (distinct; preserves
 * priority order of the first occurrence per source).
 */
export function getFailoverCredentialCandidates(
  settings: ProviderRouteSettings,
  usability: Pick<ProviderModeUsabilityContext, 'codexConnectivity'>,
): ReadonlySet<ProviderCredentialSource> {
  // Call enumerateProviderModeCandidates with an EMPTY cooldown set so every
  // candidate is evaluated purely on credential presence + Codex connectivity.
  const candidates = enumerateProviderModeCandidates(settings);
  const ctx: ProviderModeUsabilityContext = {
    codexConnectivity: usability.codexConnectivity,
    // Deliberately empty: we want "usable ignoring cooldown"
    cooledDownCredentialSources: new Set(),
  };
  const seen = new Set<ProviderCredentialSource>();
  for (const mode of candidates) {
    if (isUsableProviderMode(mode, ctx)) {
      seen.add(mode.credentialSource);
    }
  }
  return seen;
}

/**
 * SELECTION seam of the provider-choice point: "pick one" from the enumerated
 * candidates. Picks the **highest-priority candidate that is usable**
 * ({@link isUsableProviderMode}); if none is usable it returns the head, so the
 * head's `missing-*` terminal still surfaces (e.g. "connect your top provider").
 *
 * This is IDENTITY on a single-element list — `find` returns the head when usable,
 * else `?? candidates[0]` returns the same head — so the default path above is
 * byte-for-byte unchanged. Behaviour only changes when the flag is on AND a
 * configured `enabledProviders` list differs from the implicit `[activeProvider]`
 * (and nothing writes that list until Stage 6).
 *
 * The picked candidate is routed through {@link assertExhaustiveProviderMode} so
 * the provider axis of the seam is exhaustiveness-checked.
 */
function pickProviderMode(candidates: ProviderModeCandidates, ctx: ProviderModeUsabilityContext): ProviderMode {
  const usable = candidates.find((mode) => isUsableProviderMode(mode, ctx));
  return assertExhaustiveProviderMode(usable ?? candidates[0]);
}

function applyEncodedFallback(
  input: ProviderRouterTurnInput,
  encoded: { kind: 'model'; model: string } | { kind: 'profile'; profileId: string } | null,
): ProviderRouterTurnInput {
  if (!encoded) return { ...input, profile: null };
  switch (encoded.kind) {
    case 'profile': {
      const profile = findProfileById(input.settings, encoded.profileId);
      return {
        ...input,
        model: `profile:${encoded.profileId}`,
        profile: profile ?? null,
      };
    }
    case 'model': {
      const provider = inferActiveProviderForFallbackModel(encoded.model);
      return {
        ...input,
        model: encoded.model,
        profile: null,
        ...(provider ? { settings: withActiveProvider(input.settings, provider) } : {}),
      };
    }
    default:
      return assertNever(encoded, 'FallbackEncoding');
  }
}

function turnRoleFromConfiguredFallbackRole(
  role: ConfiguredFallbackRole,
): ProviderRouterTurnInput['role'] {
  switch (role) {
    case 'thinking':
      return 'planning';
    case 'working':
    case 'background':
      return 'execution';
    default:
      return assertNever(role, 'ConfiguredFallbackRole');
  }
}

function fallbackInputForHint(input: ProviderRouterTurnInput, fallbackHint: RouteRebuildHint): ProviderRouterTurnInput {
  switch (fallbackHint.kind) {
    case 'long-context-profile': {
      const profile = findProfileById(input.settings, fallbackHint.profileId);
      return {
        ...input,
        model: `profile:${fallbackHint.profileId}`,
        profile: profile ?? null,
      };
    }
    case 'thinking-downgrade':
      return { ...input, profile: null };
    case 'alt-model':
      return { ...input, model: fallbackHint.model, profile: null };
    case 'configured-role-fallback': {
      const target = fallbackHint.target.kind === 'model'
        ? { kind: 'model' as const, model: fallbackHint.target.model }
        : { kind: 'profile' as const, profileId: fallbackHint.target.profileId };
      const fallbackInput = applyEncodedFallback(input, target);
      return {
        ...fallbackInput,
        role: turnRoleFromConfiguredFallbackRole(fallbackHint.role),
      };
    }
    case 'codex-rate-limit-tier': {
      const rawFallback = fallbackHint.tier === 'priority'
        ? getThinkingFallback(input.settings)
        : getWorkingFallback(input.settings);
      return applyEncodedFallback(input, parseFallbackEncoding(rawFallback));
    }
    case 'codex-rate-limit-provider': {
      const currentProvider = input.settings.activeProvider;
      const provider = currentProvider && currentProvider !== 'codex'
        ? currentProvider
        : bestNonCodexProvider(input.settings);
      return provider
        ? { ...input, settings: withActiveProvider(input.settings, provider), profile: null }
        : { ...input, profile: null };
    }
    default:
      return assertNever(fallbackHint, 'RouteRebuildHint');
  }
}

function codexConnectivityForFallback(
  fallbackHint: RouteRebuildHint,
  inFlightPlan: ProviderRoutePlan,
): CodexConnectivity {
  switch (fallbackHint.kind) {
    case 'codex-rate-limit-provider':
      return fallbackHint.forceNonCodexTransport === true
        ? 'disconnected'
        : inFlightPlan.decision.codexConnectivity;
    case 'long-context-profile':
    case 'thinking-downgrade':
    case 'alt-model':
    case 'configured-role-fallback':
    case 'codex-rate-limit-tier':
      return inFlightPlan.decision.codexConnectivity;
    default:
      return assertNever(fallbackHint, 'RouteRebuildHint');
  }
}

function resolveProfile(input: ProviderRouterBaseInput): { profile: ModelProfile | null; resolvedFrom: ProviderResolvedFrom } {
  if (isRoutableProfile(input.profile)) {
    return { profile: input.profile, resolvedFrom: 'explicit-profile' };
  }
  const modelProfileId = input.model ? profileReferenceId(input.model) : null;
  const fromModel = findProfileById(input.settings, modelProfileId);
  if (isRoutableProfile(fromModel)) {
    return { profile: fromModel, resolvedFrom: 'explicit-profile' };
  }
  const workingProfile = findProfileById(
    input.settings,
    getWorkingProfileId(input.settings) ?? input.settings.localModel?.activeProfileId ?? null,
  );
  if (isRoutableProfile(workingProfile) && !input.model) {
    return { profile: workingProfile, resolvedFrom: 'working-profile' };
  }
  return { profile: null, resolvedFrom: 'settings' };
}

/**
 * Canonical mapping from the routing layer's role taxonomy (`ProviderRouteRole`:
 * execution | planning | bts | subagent) onto the user-facing model trio
 * (`ModelRole`: working | thinking | fast). The routing layer is intentionally
 * finer-grained than the trio the user configures, so this is a deliberate
 * narrowing — NOT a duplicate type to be merged away (see the role-vocabulary
 * layering note in docs/plans/260614_smart-model-routing/MULTIPROVIDER_ROADMAP.md).
 *
 * This is the single authority for the route-role → trio direction, and it is
 * exhaustiveness-checked (kill-by-construction): adding a member to
 * `ProviderRouteRole` fails to compile here until its trio mapping is declared,
 * so a new routing role can never silently fall through to `working`.
 */
export function modelRoleForRouteRole(role: ProviderRouteRole): ModelRole {
  switch (role) {
    case 'planning':
      return 'thinking';
    case 'bts':
      return 'background';
    case 'execution':
    case 'subagent':
      return 'working';
    default:
      return assertNever(role, 'ProviderRouteRole');
  }
}

/**
 * A PRIMARY user turn is one the user is actively waiting on in the conversation
 * (`execution` / `planning`). `bts` (background, e.g. auto-title) and `subagent`
 * are NOT primary: they must keep the existing terminals unchanged so the
 * deliberate `claude-*`→Anthropic BTS divert (260501 auto-title fix) is never
 * regressed. Exhaustiveness-checked so a new role can't silently fall through.
 */
export function isPrimaryTurnRole(role: ProviderRouteRole): boolean {
  switch (role) {
    case 'execution':
    case 'planning':
      return true;
    case 'bts':
    case 'subagent':
      return false;
    default:
      return assertNever(role, 'ProviderRouteRole');
  }
}

function resolveInputModel(input: ProviderRouterBaseInput, role: ProviderRouteRole): string {
  if (input.model && input.model.trim().length > 0) return normalizeOrModelId(input.model.trim());
  if ((input.settings.activeProvider === 'openrouter' || input.settings.activeProvider === 'mindstone') && input.settings.openRouter?.selectedModel) {
    return normalizeOrModelId(input.settings.openRouter.selectedModel);
  }
  const mappedRole = modelRoleForRouteRole(role);
  const resolution = resolveDefaultModelForRole(
    mappedRole,
    input.settings,
    input.settings.localModel?.profiles ?? [],
  );
  if (!resolution.ok) {
    throw createRoleResolutionModelError(resolution);
  }
  return normalizeOrModelId(resolution.model);
}

function sanitizeStaleProfileReference(
  input: ProviderRouterBaseInput,
  role: ProviderRouteRole,
): { input: ProviderRouterBaseInput; sanitized: boolean } {
  // eslint-disable-next-line bts-flow-shape/no-raw-bts-model-read -- S3 router sanitize is the reviewed last-mile boundary for stale BTS profile references before route resolution.
  const configuredBtsModel = input.settings.behindTheScenesModel;
  const profileCandidate = input.model?.startsWith(PROFILE_PREFIX)
    ? { reference: input.model, forceSanitize: false }
    : !input.model?.trim() && role === 'bts'
      ? profileReferenceCandidateFromStoredBtsSetting(configuredBtsModel)
      : null;
  if (!profileCandidate) return { input, sanitized: false };

  // Rev 2: trim before classification so 'profile:   ' is empty-id, not missing.
  const modelProfileIdRaw = profileReferenceId(profileCandidate.reference);
  const modelProfileId = modelProfileIdRaw?.trim() ?? '';
  const referencedProfile = modelProfileId ? findProfileById(input.settings, modelProfileId) : null;
  const classifiedProfileState = classifyProfileReference(referencedProfile, modelProfileIdRaw);
  // Rev 3 S3 refinement: a stored 'model:profile:abc' is a defensive collision
  // that would otherwise decode back to bare 'profile:abc' and leak to the wire.
  // Treat it as stale even if a profile with that id currently exists.
  const profileState = profileCandidate.forceSanitize && classifiedProfileState === 'routable'
    ? 'missing'
    : classifiedProfileState;

  if (profileState === 'routable') return { input, sanitized: false };

  const sentryProfileId = modelProfileId || '<empty>';

  log.warn({
    siteId: 'providerRouting:sanitizeStaleProfileReference',
    role,
    missingProfileId: sentryProfileId,
    profileState,
  }, '[routeDecision] Routing input references unusable profile; clearing stale BTS setting and degrading to role default');

  // Rev 2: pass a real Error so captureKnownCondition skips the
  // 'synthetic-error' warn-path noise (see captureKnownCondition.ts).
  captureKnownCondition(
    'bts_profile_missing',
    { role, profileState, missingProfileId: sentryProfileId },
    new Error(
      `Routing input references unusable profile (role=${role}, ` +
      `profileState=${profileState}, profileId=${sentryProfileId})`,
    ),
  );

  const clearedSettings = clearStaleBtsProfileSetting(input.settings, profileCandidate.reference);
  const sanitizedInputBase: ProviderRouterBaseInput = {
    ...input,
    model: null,
    profile: null,
    settings: clearedSettings,
  };
  // S3-refine-2 Fix 5: pre-resolve the role-default model so that
  // `resolveProfile` cannot silently promote `models.workingProfileId` after
  // sanitize clears `input.model`. Without this guard a routable Opus working
  // profile would hijack BTS routing (10x cost regression) any time sanitize
  // fired for an unrelated stale BTS reference.
  const resolvedModel = resolveInputModel(sanitizedInputBase, role);
  return {
    input: { ...sanitizedInputBase, model: resolvedModel },
    sanitized: true,
  };
}

type ProfileReferenceState = 'routable' | 'missing' | 'disabled' | 'incomplete' | 'empty-id';

function classifyProfileReference(
  profile: ModelProfile | null,
  profileIdRaw: string | null,
): ProfileReferenceState {
  // Rev 2: trim before length check so whitespace-only ids classify as empty-id.
  const profileId = profileIdRaw?.trim() ?? '';
  if (!profileId) return 'empty-id';
  if (!profile) return 'missing';
  if (profile.enabled === false) return 'disabled';
  if (!profile.model?.trim()) return 'incomplete';
  if (!isProfileSelectable(profile)) return 'incomplete';
  return 'routable';
}

function profileReferenceCandidateFromStoredBtsSetting(
  rawBtsSetting: string | undefined,
): { reference: string; forceSanitize: boolean } | null {
  if (!rawBtsSetting) return null;
  const normalized = normalizeStoredBtsModelValue(rawBtsSetting);
  if (normalized.ok) {
    if (normalized.kind === 'profile') {
      return { reference: `${PROFILE_PREFIX}${normalized.profileId}`, forceSanitize: false };
    }
    return null;
  }

  // S3-refine-2 Fix 2: `'model:profile:<id>'` is rejected by the normalizer with
  // reason `'model-with-profile-prefix'`. The router still needs to sanitize the
  // embedded `profile:<id>` shape so it cannot leak to the wire via a per-site
  // rebuild that flattened it back to a bare `profile:<id>` string.
  if (normalized.reason === 'model-with-profile-prefix') {
    const stripped = rawBtsSetting.trim().slice(MODEL_PREFIX.length).trim();
    return { reference: stripped, forceSanitize: true };
  }

  // Preserve the Rev 2 empty-profile-id path: 'profile:' / 'profile:   ' must
  // still sanitize and classify as empty-id even though the kinded normalizer
  // rejects them.
  const trimmed = rawBtsSetting.trim();
  return trimmed.startsWith(PROFILE_PREFIX)
    ? { reference: trimmed, forceSanitize: false }
    : null;
}

function clearStaleBtsProfileSetting(
  settings: ProviderRouteSettings,
  sanitizedReference: string,
): ProviderRouteSettings {
  // eslint-disable-next-line bts-flow-shape/no-raw-bts-model-read -- S3 router sanitize intentionally detects whether the persisted BTS setting is the stale profile reference being cleared.
  const configuredBtsModel = settings.behindTheScenesModel;
  const candidate = profileReferenceCandidateFromStoredBtsSetting(configuredBtsModel);
  if (!candidate) return settings;

  // S3-refine-2 Fix 4: bound the sanitize blast radius. Only clear the stored
  // BTS setting when (a) it IS the stale reference that triggered sanitize, or
  // (b) the stored setting is itself unusable (defensive collision or its own
  // profile is missing/disabled/incomplete). Otherwise, a stale per-task
  // override or stale `input.model` should not wipe a valid global preference.
  if (candidate.reference !== sanitizedReference && !candidate.forceSanitize) {
    const profileId = profileReferenceId(candidate.reference)?.trim() ?? '';
    const profile = profileId ? findProfileById(settings, profileId) : null;
    if (classifyProfileReference(profile, profileId) === 'routable') return settings;
  }

  // Rev 2: we intentionally do NOT clear settings.behindTheScenesOverrides here:
  // - The override map isn't read by the role-default cascade we are about to fall into
  //   (resolveDefaultModelForRole walks role defaults, not the override map).
  // - Persistently clearing overrides is a settings-mutation hygiene concern outside
  //   the router's boundary (see § Out of scope and the P2 follow-up note).
  // - Subsequent routing calls with stale overrides will retrigger sanitize per call,
  //   producing one warn + one Sentry capture each call (fingerprinted in Sentry).
  return { ...settings, behindTheScenesModel: undefined };
}

function noCredentialsDecision(input: {
  role: ProviderRouteRole;
  routeScope: ProviderRouteScope;
  model: string;
  provider: ProviderRouteProvider;
  credentialSource: ProviderCredentialSource;
  invalidReason: Exclude<ProviderInvalidReason, 'none'>;
  codexConnectivity: CodexConnectivity;
  fallbackHint: ProviderFallbackHint | null;
  resolvedFrom: ProviderResolvedFrom;
  profileId?: string | null;
  dialect?: ProviderModelDialect;
}): TerminalRouteDecision {
  const transport = input.invalidReason === 'codex-disconnected-bts-blocked'
    ? 'fail-closed-codex-disconnected'
    : 'no-credentials';
  return {
    kind: 'terminal',
    provider: input.provider,
    transport,
    dispatchPath: 'none',
    modelDialect: input.dialect ?? inferModelDialect(input.model, null),
    role: input.role,
    routeScope: input.routeScope,
    canonicalModelId: normalizeModel(stripAnthropicProviderPrefix(input.model)),
    wireModelId: brandRouteWireModel(input.model),
    profileId: input.profileId ?? null,
    resolvedFrom: input.resolvedFrom,
    codexConnectivity: input.codexConnectivity,
    fallbackHint: input.fallbackHint,
    credentialSource: input.credentialSource,
    // Terminal/missing credential sources carry no billing identity (null) — see
    // billingSourceForCredentialSource. Derived ONCE here (WS1a #1).
    billingSource: billingSourceForCredentialSource(input.credentialSource),
    invalidReason: input.invalidReason,
  };
}

function codexUnsupportedModelDecision(input: {
  role: ProviderRouteRole;
  routeScope: ProviderRouteScope;
  model: string;
  codexConnectivity: CodexConnectivity;
  fallbackHint: ProviderFallbackHint | null;
  resolvedFrom: ProviderResolvedFrom;
  profileId?: string | null;
}): TerminalRouteDecision {
  // REBEL-520: ChatGPT-account Codex rejects gpt-5.5-pro. Fail closed before
  // proxy dispatch so stale settings do not produce provider 400s in Sentry.
  return noCredentialsDecision({
    role: input.role,
    routeScope: input.routeScope,
    model: input.model,
    provider: 'codex',
    credentialSource: 'missing-codex',
    invalidReason: 'codex-unsupported-model',
    codexConnectivity: input.codexConnectivity,
    fallbackHint: input.fallbackHint,
    resolvedFrom: input.resolvedFrom,
    profileId: input.profileId ?? null,
    dialect: 'openai-compatible',
  });
}

function profileDecision(input: {
  profile: ModelProfile;
  model: string;
  role: ProviderRouteRole;
  routeScope: ProviderRouteScope;
  resolvedFrom: ProviderResolvedFrom;
  codexConnectivity: CodexConnectivity;
  fallbackHint: ProviderFallbackHint | null;
  settings: ProviderRouteSettings;
}): ProviderRouteDecision {
  const wireModel = getProfileModel(input.profile, input.model);
  const dialect = inferModelDialect(wireModel, input.profile);
  if (isCodexSubscriptionProfile(input.profile)) {
    // memory-BTS route mismatch (Stage 2b): the codex SUBSCRIPTION-PROFILE arm had
    // the SAME hole as the active-provider arm — gated only on the
    // `isCodexModelSupported` deny-list, with NO codex-servable check AND NO
    // native-Claude divert. A codex-subscription profile whose `profile.model` was
    // a slash foreign-dialect id (`deepseek/…`) threw at the wire, a bare non-OpenAI
    // id (`gemini-2.5-flash`) dispatched SILENTLY to the wrong proxy, and a
    // `claude-*` id shipped a Claude wire body to the codex proxy (BROADER-broken
    // than the active arm, which diverts claude-*). Reachable via the sibling aux
    // turns' `workingProfileOverrideId`. Mirror the active arm:
    //   (1) native-Claude divert (claude-* profile model → Anthropic if creds, else
    //       clean terminal),
    //   (2) servable-dialect guard (only a bare OpenAI-compatible id dispatches
    //       codex-proxy; everything else → clean `codex-unsupported-model` terminal),
    // via the SHARED `isCodexServableModel` predicate (single source of truth with
    // the active arm — prevents future drift, mirrors the resolveDirectAnthropicModel
    // chokepoint pattern). Route-table scope is irrelevant here: profiles are
    // resolved from a concrete `profile.model`, never an alias placeholder, so no
    // `isRouteTableScope` exemption is needed (cf. the active arm, where the alias
    // `'working'` rides the body model under council/ad-hoc).
    const profileDirectAnthropicResolution = resolveDirectAnthropicModel(wireModel);
    const profileAnthropicWireModel = codexDirectAnthropicDivertWireModel(
      profileDirectAnthropicResolution,
    );
    if (profileAnthropicWireModel) {
      const profileAnthropicCredentialSource = classifyAnthropicSettingsCredential(
        asAppSettings(input.settings),
      );
      if (profileAnthropicCredentialSource !== 'missing-anthropic') {
        return makeDecision({
          provider: 'anthropic',
          transport: DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT.anthropic['anthropic-native'],
          modelDialect: 'anthropic-native',
          role: input.role,
          routeScope: input.routeScope,
          canonicalModelId: input.model,
          wireModelId: profileAnthropicWireModel,
          profileId: input.profile.id,
          resolvedFrom: input.resolvedFrom,
          codexConnectivity: input.codexConnectivity,
          fallbackHint: input.fallbackHint,
          credentialSource: profileAnthropicCredentialSource,
        });
      }
      // No Anthropic credentials: a claude-* profile model under a codex
      // subscription has nowhere to dispatch → clean terminal. Mirrors the active
      // arm's FOX-3494 actionable-terminal split (primary turn + connected codex →
      // "switch to a GPT model"; BTS/subagent keep the generic Anthropic terminal).
      return noCredentialsDecision({
        role: input.role,
        routeScope: input.routeScope,
        model: wireModel,
        provider: 'anthropic',
        credentialSource: 'missing-anthropic',
        invalidReason:
          input.codexConnectivity === 'connected' && isPrimaryTurnRole(input.role)
            ? 'missing-anthropic-credentials-for-claude-model'
            : 'missing-anthropic-credentials',
        codexConnectivity: input.codexConnectivity,
        fallbackHint: input.fallbackHint,
        resolvedFrom: input.resolvedFrom,
        profileId: input.profile.id,
        dialect: 'anthropic-native',
      });
    }
    if (!isCodexServableModel(wireModel)) {
      return codexUnsupportedModelDecision({
        role: input.role,
        routeScope: input.routeScope,
        model: wireModel,
        codexConnectivity: input.codexConnectivity,
        fallbackHint: input.fallbackHint,
        resolvedFrom: input.resolvedFrom,
        profileId: input.profile.id,
      });
    }
    if (input.codexConnectivity === 'connected') {
      const modelDialect = 'openai-compatible';
      return makeDecision({
        provider: 'codex',
        transport: DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT.codex[modelDialect],
        modelDialect,
        role: input.role,
        routeScope: input.routeScope,
        canonicalModelId: input.model,
        wireModelId: brandRouteWireModel(wireModel),
        profileId: input.profile.id,
        resolvedFrom: input.resolvedFrom,
        codexConnectivity: input.codexConnectivity,
        fallbackHint: input.fallbackHint,
        credentialSource: 'codex-subscription',
      });
    }
    return noCredentialsDecision({
      role: input.role,
      routeScope: input.routeScope,
      model: wireModel,
      provider: 'codex',
      credentialSource: 'missing-codex',
      invalidReason: 'codex-disconnected-bts-blocked',
      codexConnectivity: input.codexConnectivity,
      fallbackHint: input.fallbackHint,
      resolvedFrom: input.resolvedFrom,
      profileId: input.profile.id,
      dialect: 'openai-compatible',
    });
  }

  if (input.profile.providerType === 'anthropic') {
    const directAnthropicModelResolution = resolveDirectAnthropicModel(wireModel);
    // Anthropic reachability keys on the GLOBAL settings credential (`models.*`), NOT a
    // per-profile `profile.apiKey`. This is deliberate: the profile wizard excludes Anthropic
    // BYOK profiles (`WizardProviderType = Exclude<ModelProviderType, 'anthropic' | 'local'>`,
    // useProfileWizard.ts) — Anthropic profiles are virtual/catalog/managed and never carry a
    // per-profile key. The canonical chokepoint `resolveCredentialsForProfile` WOULD honour a
    // per-profile key on an anthropic-typed profile, so the two intentionally diverge on that
    // (unreachable-in-practice) input — which is why this branch uses the SETTINGS-only
    // `classifyAnthropicSettingsCredential` authority rather than `resolveCredentialsForProfile`
    // (E2b). A documented-divergence pin in providerRouting.profileCredentialMatrix.test.ts
    // asserts this; if a BYOK-Anthropic-profile flow is ever added, that test fails and this
    // branch must switch to the profile-aware chokepoint.
    const credentialSource: ProviderCredentialSource = classifyAnthropicSettingsCredential(
      asAppSettings(input.settings),
    );
    if (credentialSource === 'missing-anthropic') {
      // FOX-3494: an anthropic-typed (native-Claude) profile pinned for a PRIMARY
      // turn while the ACTIVE provider is a connected ChatGPT Pro and no Anthropic
      // key exists → actionable "switch to a GPT model" terminal. Gating on
      // `activeProvider === 'codex'` (not merely `codexConnectivity` — F2) keeps a
      // genuine-Anthropic / openrouter / mindstone user (who happens to have codex
      // connected in the background) on the existing generic Anthropic terminal,
      // so they aren't mis-attributed to "ChatGPT Pro". Foreign-dialect keeps its
      // own reason; BTS/subagent keep the generic Anthropic terminal (260501).
      const profileAnthropicInvalidReason =
        directAnthropicModelResolution.kind === 'foreign-dialect'
          ? directAnthropicModelResolution.invalidReason
          : input.settings.activeProvider === 'codex' &&
              input.codexConnectivity === 'connected' &&
              isPrimaryTurnRole(input.role) &&
              directAnthropicModelResolution.kind === 'native-claude'
            ? 'missing-anthropic-credentials-for-claude-model'
            : 'missing-anthropic-credentials';
      return noCredentialsDecision({
        role: input.role,
        routeScope: input.routeScope,
        model: wireModel,
        provider: 'anthropic',
        credentialSource,
        invalidReason: profileAnthropicInvalidReason,
        codexConnectivity: input.codexConnectivity,
        fallbackHint: input.fallbackHint,
        resolvedFrom: input.resolvedFrom,
        profileId: input.profile.id,
        dialect: 'anthropic-native',
      });
    }
    if (directAnthropicModelResolution.kind === 'foreign-dialect') {
      return noCredentialsDecision({
        role: input.role,
        routeScope: input.routeScope,
        model: wireModel,
        provider: 'anthropic',
        credentialSource,
        invalidReason: directAnthropicModelResolution.invalidReason,
        codexConnectivity: input.codexConnectivity,
        fallbackHint: input.fallbackHint,
        resolvedFrom: input.resolvedFrom,
        profileId: input.profile.id,
        dialect: 'anthropic-native',
      });
    }
    return makeDecision({
      provider: 'anthropic',
      transport: DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT.anthropic['anthropic-native'],
      modelDialect: 'anthropic-native',
      role: input.role,
      routeScope: input.routeScope,
      canonicalModelId: directAnthropicModelResolution.wireModel,
      wireModelId: directAnthropicModelResolution.wireModel,
      profileId: input.profile.id,
      resolvedFrom: input.resolvedFrom,
      codexConnectivity: input.codexConnectivity,
      fallbackHint: input.fallbackHint,
      credentialSource,
    });
  }

  if (input.profile.providerType === 'local' || isLocalhostUrl(input.profile.serverUrl)) {
    return makeDecision({
      provider: 'local',
      transport: DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT.local['local-openai-compatible'],
      modelDialect: 'local-openai-compatible',
      role: input.role,
      routeScope: input.routeScope,
      canonicalModelId: input.model,
      wireModelId: brandRouteWireModel(wireModel),
      profileId: input.profile.id,
      resolvedFrom: input.resolvedFrom,
      codexConnectivity: input.codexConnectivity,
      fallbackHint: input.fallbackHint,
      credentialSource: 'local-none',
    });
  }

  // OpenRouter profiles authenticate via the shared account-wide OAuth token
  // (settings.openRouter.oauthToken), not a per-profile API key — regardless of
  // profileSource. Connection-managed profiles (auto-created on connect) and
  // user-added custom models alike resolve through OAuth when they carry no
  // explicit key material. This mirrors the client-side resolver
  // `resolveConnectionCredentials` (shared/utils/connectionCredentials.ts), which
  // already falls back to the OAuth token for non-managed OpenRouter profiles;
  // gating this intercept on `profileSource === 'connection'` left user-added
  // custom models dead-ending at missing-profile-credentials (see
  // docs-private/postmortems/260513_openrouter_oauth_profile_resolver_missing_credentials_postmortem.md
  // for the connection-managed shape of the same bug family). BYOK still wins: an
  // explicit profile/custom-provider/providerKeys key skips this block and routes
  // through the api-key fall-through below.
  if (
    input.profile.providerType === 'openrouter' &&
    !sanitize(input.profile.apiKey) &&
    !sanitize(input.profile.customProviderId) &&
    !sanitize(input.settings.providerKeys?.openrouter)
  ) {
    // Canonical chokepoint (E2b): within this keyless-OpenRouter gate `resolveProfileApiKey`
    // is null, so `resolveCredentialsForProfile` resolves the shared account-wide OAuth token
    // (the 260513/260611 fix) → `openrouter-oauth-token` when present, else `missing-openrouter`.
    // Identical to the prior `hasOpenRouterCredentials` read; the dialect/transport/invalidReason
    // routing below is unchanged.
    const openRouterResolution = resolveCredentialsForProfile(input.profile, asAppSettings(input.settings));
    if (openRouterResolution.kind === 'reachable') {
      const modelDialect = wireModel.includes('/') ? 'openrouter-prefixed' : 'anthropic-native';
      return makeDecision({
        provider: 'openrouter',
        transport: DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT.openrouter[modelDialect],
        modelDialect,
        role: input.role,
        routeScope: input.routeScope,
        canonicalModelId: input.model,
        wireModelId: brandRouteWireModel(wireModel),
        profileId: input.profile.id,
        resolvedFrom: input.resolvedFrom,
        codexConnectivity: input.codexConnectivity,
        fallbackHint: input.fallbackHint,
        credentialSource: 'openrouter-oauth-token',
      });
    }
    return noCredentialsDecision({
      role: input.role,
      routeScope: input.routeScope,
      model: wireModel,
      provider: 'openrouter',
      credentialSource: 'missing-openrouter',
      invalidReason: 'missing-openrouter-credentials',
      codexConnectivity: input.codexConnectivity,
      fallbackHint: input.fallbackHint,
      resolvedFrom: input.resolvedFrom,
      profileId: input.profile.id,
      dialect: 'openrouter-prefixed',
    });
  }

  // Profile-key fall-through: reachability is the profile's OWN explicit key only
  // (profile/custom-provider/providerKeys), via `resolveProfileApiKey` — the SAME building
  // block `resolveCredentialsForProfile` uses for its `directApiKey`. Deliberately NOT the full
  // `resolveCredentialsForProfile` here: an OpenRouter profile that fell past the keyless
  // intercept above (because it carries a `customProviderId` whose key is empty) must NOT
  // re-acquire the account-wide OAuth token at this point — the intercept already owns the
  // OAuth path, and the OAuth fall-through belongs only to keyless OpenRouter profiles.
  const profileApiKey = resolveProfileApiKey(input.profile, input.settings.providerKeys, input.settings.customProviders);
  if (!profileApiKey) {
    return noCredentialsDecision({
      role: input.role,
      routeScope: input.routeScope,
      model: wireModel,
      provider: 'profile',
      credentialSource: 'missing-profile',
      invalidReason: 'missing-profile-credentials',
      codexConnectivity: input.codexConnectivity,
      fallbackHint: input.fallbackHint,
      resolvedFrom: input.resolvedFrom,
      profileId: input.profile.id,
      dialect,
    });
  }

  if (input.profile.providerType === 'google') {
    return makeDecision({
      provider: 'profile',
      transport: input.role === 'bts' ? 'openai-compatible-http' : 'anthropic-compatible-local-proxy',
      modelDialect: 'profile-ref',
      role: input.role,
      routeScope: input.routeScope,
      canonicalModelId: input.model,
      wireModelId: brandRouteWireModel(wireModel),
      profileId: input.profile.id,
      resolvedFrom: input.resolvedFrom,
      codexConnectivity: input.codexConnectivity,
      fallbackHint: input.fallbackHint,
      credentialSource: 'profile-api-key',
    });
  }

  return makeDecision({
    provider: 'profile',
    transport: 'openai-compatible-http',
    modelDialect: dialect,
    role: input.role,
    routeScope: input.routeScope,
    canonicalModelId: input.model,
    wireModelId: brandRouteWireModel(wireModel),
    profileId: input.profile.id,
    resolvedFrom: input.resolvedFrom,
    codexConnectivity: input.codexConnectivity,
    fallbackHint: input.fallbackHint,
    credentialSource: input.profile.providerType === 'openai' ? 'openai-api-key' : 'profile-api-key',
  });
}

function makeDecision(input: {
  provider: ProviderRouteProvider;
  transport: DispatchableTransport;
  modelDialect: ProviderModelDialect;
  role: ProviderRouteRole;
  routeScope: ProviderRouteScope;
  canonicalModelId: string;
  wireModelId: WireModelId;
  profileId: string | null;
  resolvedFrom: ProviderResolvedFrom;
  codexConnectivity: CodexConnectivity;
  fallbackHint: ProviderFallbackHint | null;
  credentialSource: ProviderCredentialSource;
}): DispatchableRouteDecision {
  return {
    kind: 'dispatchable',
    provider: input.provider,
    transport: input.transport,
    dispatchPath: deriveDispatchableDispatchPath(input.transport, input.routeScope),
    modelDialect: input.modelDialect,
    role: input.role,
    routeScope: input.routeScope,
    canonicalModelId: normalizeModel(stripAnthropicProviderPrefix(input.canonicalModelId)),
    wireModelId: input.wireModelId,
    profileId: input.profileId,
    resolvedFrom: input.resolvedFrom,
    codexConnectivity: input.codexConnectivity,
    fallbackHint: input.fallbackHint,
    credentialSource: input.credentialSource,
    // Provenance-only "who pays" tag, derived ONCE from credentialSource (WS1a #1).
    billingSource: billingSourceForCredentialSource(input.credentialSource),
    invalidReason: 'none',
  };
}

function deriveDispatchableDispatchPath(
  transport: DispatchableTransport,
  routeScope: ProviderRouteScope,
): DispatchableDispatchPath {
  const dispatchPath = deriveDispatchPath(transport, routeScope);
  switch (dispatchPath) {
    case 'direct-provider':
    case 'local-proxy-route-table':
    case 'local-proxy-passthrough':
      return dispatchPath;
    case 'none':
      throw new Error(`Dispatchable transport resolved terminal dispatchPath: ${transport}`);
    default:
      return assertNever(dispatchPath, 'DispatchPath in deriveDispatchableDispatchPath');
  }
}

function coerceToRouteTable(decision: DispatchableRouteDecision): DispatchableRouteDecision {
  return {
    ...decision,
    transport: 'anthropic-compatible-local-proxy',
    dispatchPath: deriveDispatchableDispatchPath('anthropic-compatible-local-proxy', 'council'),
  };
}

function routeDecision(input: ProviderRouterBaseInput, role: ProviderRouteRole): ProviderRouteDecision {
  const routeScope = input.routeScope ?? 'normal-turn';
  const codexConnectivity = input.codexConnectivity;
  const fallbackHint = input.fallbackHint ?? null;

  // P1 Rev 2: detect stale profile references upfront.
  const { input: workingInput } = sanitizeStaleProfileReference(input, role);

  const model = resolveInputModel(workingInput, role);
  const resolvedProfile = resolveProfile(workingInput);
  let decision: ProviderRouteDecision;
  if (resolvedProfile.profile) {
    decision = profileDecision({
      profile: resolvedProfile.profile,
      model,
      role,
      routeScope,
      resolvedFrom: resolvedProfile.resolvedFrom,
      codexConnectivity,
      fallbackHint,
      settings: workingInput.settings,
    });
  } else {
    // Provider-choice point, restructured into "enumerate candidate providers →
    // pick one". Today the candidate set is the single provider that
    // `selectProviderMode` resolves from `activeProvider`, and `pickProviderMode`
    // returns its head — i.e. exactly today's choice. (Stage 2 widens the
    // enumeration to the ordered enabled-provider list; Stage 3 widens the pick
    // to per-route selection — both behaviour-preserving until flag-gated.)
    const providerModeCandidates = enumerateProviderModeCandidates(workingInput.settings);
    const providerMode = pickProviderMode(providerModeCandidates, {
      codexConnectivity,
      cooledDownCredentialSources: input.cooledDownCredentialSources,
    });
    switch (providerMode.provider) {
      case 'openrouter':
        if (providerMode.credentialSource === 'missing-openrouter') {
          decision = noCredentialsDecision({
            role,
            routeScope,
            model,
            provider: 'openrouter',
            credentialSource: 'missing-openrouter',
            invalidReason: 'missing-openrouter-credentials',
            codexConnectivity,
            fallbackHint,
            resolvedFrom: 'settings',
          });
          break;
        }
        if (providerMode.credentialSource === 'missing-mindstone') {
          decision = noCredentialsDecision({
            role,
            routeScope,
            model,
            provider: 'openrouter',
            credentialSource: 'missing-mindstone',
            invalidReason: 'missing-mindstone-credentials',
            codexConnectivity,
            fallbackHint,
            resolvedFrom: 'settings',
          });
          break;
        }
        const openRouterModelDialect = model.includes('/') ? 'openrouter-prefixed' : 'anthropic-native';
        decision = makeDecision({
          provider: 'openrouter',
          transport: DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT.openrouter[openRouterModelDialect],
          modelDialect: openRouterModelDialect,
          role,
          routeScope,
          canonicalModelId: model,
          wireModelId: brandRouteWireModel(model),
          profileId: null,
          resolvedFrom: 'settings',
          codexConnectivity,
          fallbackHint,
          credentialSource: providerMode.credentialSource,
        });
        break;
      case 'codex':
        // Native Claude models (claude-*) route directly to Anthropic API
        // regardless of Codex connectivity state. The Codex proxy cannot serve
        // Anthropic-native models anyway — this check MUST come before the
        // connectivity guard to avoid blocking BTS calls when Codex is transiently
        // unavailable. See: docs/plans/finished/260501_fix_auto_title_all_surfaces.md
        const codexDirectAnthropicModelResolution = resolveDirectAnthropicModel(model);
        const codexAnthropicWireModel = codexDirectAnthropicDivertWireModel(codexDirectAnthropicModelResolution);
        if (codexAnthropicWireModel) {
          // Single Anthropic credential authority (E2b): the classifier returns
          // `missing-anthropic` IFF the old `hasAnthropicCredentials` guard was false (same
          // api-key-then-oauth ladder), so the divert/terminal split and the dispatched
          // credentialSource are both byte-identical to the prior inline read — preserving the
          // 260501 auto-title native-Claude divert (BTS/subagent keep the generic terminal).
          const codexAnthropicCredentialSource = classifyAnthropicSettingsCredential(
            asAppSettings(workingInput.settings),
          );
          if (codexAnthropicCredentialSource !== 'missing-anthropic') {
            decision = makeDecision({
              provider: 'anthropic',
              transport: DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT.anthropic['anthropic-native'],
              modelDialect: 'anthropic-native',
              role,
              routeScope,
              canonicalModelId: model,
              wireModelId: codexAnthropicWireModel,
              profileId: null,
              resolvedFrom: 'settings',
              codexConnectivity,
              fallbackHint,
              credentialSource: codexAnthropicCredentialSource,
            });
            break;
          }
          decision = noCredentialsDecision({
            role,
            routeScope,
            model,
            provider: 'anthropic',
            credentialSource: 'missing-anthropic',
            // FOX-3494: ChatGPT-Pro-connected primary turn with a claude-* model
            // and no Anthropic key → actionable "switch to a GPT model" terminal.
            // BTS/subagent keep the generic Anthropic terminal (260501 divert).
            invalidReason: codexConnectivity === 'connected' && isPrimaryTurnRole(role)
              ? 'missing-anthropic-credentials-for-claude-model'
              : 'missing-anthropic-credentials',
            codexConnectivity,
            fallbackHint,
            resolvedFrom: 'settings',
          });
          break;
        }
        if (codexConnectivity !== 'connected') {
          decision = noCredentialsDecision({
            role,
            routeScope,
            model,
            provider: 'codex',
            credentialSource: 'missing-codex',
            invalidReason: 'missing-codex-connection',
            codexConnectivity,
            fallbackHint,
            resolvedFrom: 'settings',
            dialect: inferModelDialect(model, null),
          });
          break;
        }
        // memory-BTS route mismatch (rebel://conversation/mobile-1782164402735-51bh8pna):
        // the codex proxy can only serve BARE OpenAI-compatible models (`gpt-*`,
        // `o<...>`). The native-Claude divert above already peels off `claude-*`.
        // Everything else — slash foreign-dialect (`deepseek/…`, an OpenRouter id)
        // OR a bare non-OpenAI id (`gemini-2.5-flash`, which classifies
        // `bare-non-claude`, NOT `foreign-dialect`) — must fail closed HERE as a
        // clean terminal. Without this, such a model fell through to the dispatchable
        // codex-proxy decision below (`isCodexModelSupported` is a deny-list that
        // admits everything except `gpt-5.5-pro`), built a non-passthrough
        // AnthropicClient (`x-codex-turn`), and either threw at the wire
        // (`anthropicClient.ts:802`) for slash ids or dispatched SILENTLY to the wrong
        // proxy for bare non-OpenAI ids. Key on "is this codex-servable?" (dialect),
        // NOT on slash alone — a slash-only guard misses the silent bare variant.
        //
        // EXEMPT route-table scopes (council / ad-hoc): there `model` is an ALIAS
        // placeholder (e.g. the literal `'working'`) and the concrete backend rides
        // separately in `routedModel`/`x-routed-model`, validated at the proxy
        // egress — not here (cf. agentTool.ts:1308-1331). A dialect check on the
        // alias would wrongly terminal a legitimate route-table dispatch (mirrors
        // the Stage 3 backstop's "must not over-fire on route-table dispatch").
        // Key on "is this codex-servable?" (a PRECISE bare-OpenAI predicate,
        // `isCodexServableModel` — shared with the subscription-profile arm at
        // profileDecision:991-1018 to prevent drift), NOT on slash alone: a
        // slash-only guard misses the silent bare-non-OpenAI variant, and
        // `toModelDialect`'s broad `startsWith('o')` would wrongly admit
        // `ollama:`/`omni-*` ids. `isCodexServableModel` already folds in the
        // `isCodexModelSupported` deny-list (so `gpt-5.5-pro` still terminals).
        const codexModelDialect = 'openai-compatible';
        const isCodexServableForScope =
          isRouteTableScope(routeScope) || isCodexServableModel(model);
        if (!isCodexServableForScope) {
          decision = codexUnsupportedModelDecision({
            role,
            routeScope,
            model,
            codexConnectivity,
            fallbackHint,
            resolvedFrom: 'settings',
          });
          break;
        }
        decision = makeDecision({
          provider: 'codex',
          transport: DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT.codex[codexModelDialect],
          modelDialect: codexModelDialect,
          role,
          routeScope,
          canonicalModelId: model,
          wireModelId: brandRouteWireModel(model),
          profileId: null,
          resolvedFrom: 'settings',
          codexConnectivity,
          fallbackHint,
          credentialSource: 'codex-subscription',
        });
        break;
      case 'anthropic':
        const directAnthropicModelResolution = resolveDirectAnthropicModel(model);
        if (providerMode.credentialSource === 'missing-anthropic') {
          decision = noCredentialsDecision({
            role,
            routeScope,
            model,
            provider: 'anthropic',
            credentialSource: 'missing-anthropic',
            invalidReason:
              directAnthropicModelResolution.kind === 'foreign-dialect'
                ? directAnthropicModelResolution.invalidReason
                : 'missing-anthropic-credentials',
            codexConnectivity,
            fallbackHint,
            resolvedFrom: 'settings',
          });
          break;
        }
        if (directAnthropicModelResolution.kind === 'foreign-dialect') {
          decision = noCredentialsDecision({
            role,
            routeScope,
            model,
            provider: 'anthropic',
            credentialSource: providerMode.credentialSource,
            invalidReason: directAnthropicModelResolution.invalidReason,
            codexConnectivity,
            fallbackHint,
            resolvedFrom: 'settings',
          });
          break;
        }
        decision = makeDecision({
          provider: 'anthropic',
          transport: DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT.anthropic['anthropic-native'],
          modelDialect: 'anthropic-native',
          role,
          routeScope,
          canonicalModelId: model,
          wireModelId: directAnthropicModelResolution.wireModel,
          profileId: null,
          resolvedFrom: 'settings',
          codexConnectivity,
          fallbackHint,
          credentialSource: providerMode.credentialSource,
        });
        break;
      default:
        return assertNever(providerMode, 'ProviderMode');
    }
  }

  if (role === 'subagent') {
    return {
      ...decision,
      routedModel: workingInput.routedModel ?? null,
    };
  }

  if (isRouteTableDispatch(decision.dispatchPath)) {
    return {
      ...decision,
      routedModel: decision.canonicalModelId,
    };
  }

  return decision;
}

export function forTurnWithFallback(
  input: ProviderRouterTurnInput,
  fallbackHint: RouteRebuildHint,
  inFlightPlan: ProviderRoutePlan,
): ProviderRouteDecision {
  const effectiveInput = fallbackInputForHint(input, fallbackHint);
  return routeDecision(
    {
      ...effectiveInput,
      codexConnectivity: codexConnectivityForFallback(fallbackHint, inFlightPlan),
      fallbackHint,
    },
    effectiveInput.role ?? 'execution',
  );
}

export const ProviderRouter = {
  forTurn(input: ProviderRouterTurnInput, fallbackOptions?: ProviderRouterFallbackOptions): ProviderRouteDecision {
    if (fallbackOptions) {
      return forTurnWithFallback(input, fallbackOptions.fallbackHint, fallbackOptions.inFlightPlan);
    }
    return routeDecision(input, input.role ?? 'execution');
  },
  forBTS(input: ProviderRouterBtsInput): ProviderRouteDecision {
    return routeDecision({ ...input, routeScope: input.routeScope ?? 'normal-turn' }, 'bts');
  },
  forSubagent(input: ProviderRouterSubagentInput): ProviderRouteDecision {
    const decision = routeDecision({ ...input, routeScope: input.routeScope ?? 'normal-turn' }, 'subagent');
    if (isDispatchableDecision(decision) && isRouteTableScope(decision.routeScope)) {
      return coerceToRouteTable(decision);
    }
    return decision;
  },
};

function endpointBaseURLForRequest(decision: ProviderRouteDecision, request: ProviderRoutePlanRequest): string | null {
  if (decision.transport !== 'openai-compatible-http' && decision.transport !== 'local-openai-compatible-http') {
    return null;
  }
  const input = request.input;
  const profile = input.profile ?? findProfileById(input.settings, decision.profileId);
  return profile?.serverUrl ?? null;
}

function decisionForRequest(request: ProviderRoutePlanRequest): ProviderRouteDecision {
  switch (request.kind) {
    case 'forTurn':
      return ProviderRouter.forTurn(request.input, request.fallback);
    case 'forBTS':
      return ProviderRouter.forBTS(request.input);
    case 'forSubagent':
      return ProviderRouter.forSubagent(request.input);
    default:
      return assertNever(request, 'ProviderRoutePlanRequest');
  }
}

/**
 * The runtime context supplied to {@link resolveProviderRoutePlan}.
 *
 * It may be either a static object (callers that build context from request-level
 * inputs only) or a function of the decision. The function form lets a caller
 * derive the runtime context from the SAME {@link ProviderRouteDecision} that the
 * plan is materialized from — eliminating the same-request double-derive where a
 * caller would otherwise re-run `ProviderRouter.forTurn` just to seed the context
 * (GPT F1 / one-shot materialization). The decision is computed exactly once here
 * and threaded to the builder.
 */
export type ProviderRoutePlanRuntimeContextInput =
  | ProviderRouteRuntimeContext
  | ((decision: ProviderRouteDecision) => ProviderRouteRuntimeContext);

export async function resolveProviderRoutePlan(
  request: ProviderRoutePlanRequest,
  runtimeContext: ProviderRoutePlanRuntimeContextInput = {},
): Promise<ProviderRoutePlan> {
  const decision = decisionForRequest(request);
  const resolvedContext =
    typeof runtimeContext === 'function' ? runtimeContext(decision) : runtimeContext;
  return materializePlanRuntime(decision, {
    ...resolvedContext,
    endpointBaseURL: resolvedContext.endpointBaseURL ?? endpointBaseURLForRequest(decision, request),
  });
}
