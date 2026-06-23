/**
 * Behind The Scenes Client
 *
 * Utility for making LLM calls for background tasks (safety, memory, quips, etc.).
 * Routes through model profiles (via `profile:<id>` encoding) or calls Anthropic directly.
 *
 * NOTE: Uses native fetch instead of axios to work in hook callback contexts
 * where module imports may not be available.
 *
 * OAuth Support (2026-02-10):
 * Added auth-aware functions that support both API key and OAuth authentication.
 * - callBehindTheScenesWithAuth(): Routes to fetch (API key) or direct OAuth API
 * - callWithModelAuthAware(): New wrapper that takes settings instead of apiKey
 * See: docs/plans/finished/260210_oauth_tool_safety_fix.md
 */

import { diagLog, fingerprint } from '@core/devDiag/anthropicAuthDiag';
import { AppSettings, type ModelProfile, getWorkingModelProfile } from '@shared/types';
import { DEFAULT_AUXILIARY_MODEL } from '@shared/utils/modelNormalization';
import { normalizeApiKey, resolveProfileApiKey } from '@shared/utils/providerKeys';
import { resolveBtsModel } from '@shared/utils/btsModelResolver';
import { calculateCostOrWarn } from '@shared/utils/pricingCalculator';
import {
  appendCostEntry,
  type AuxiliaryCostCategory,
} from './costLedgerService';
import { createScopedLogger, getTurnContext } from '@core/logger';
import { type ApiRateLimitCooldown, apiRateLimitCooldown } from '@core/services/apiRateLimitCooldown';
import { classifyError, ModelError } from '@core/rebelCore/modelErrors';
import { deriveResolvedAuthLabel } from '@core/rebelCore/providerAuthPlan';
import {
  assertNever,
  captureRouteInvariantBreach,
  isProxyDispatch,
  type TerminalRouteDecision,
} from '@core/rebelCore/providerRouteDecision';
import { materializePlanRuntime } from '@core/rebelCore/providerRoutePlan';
import type { ProviderRoutePlan, TerminalRoutePlan } from '@core/rebelCore/providerRoutePlanTypes';
import { isTerminalRoutePlan } from '@core/rebelCore/providerRoutePlanTypes';
import { proxyRuntimeForDecision } from '@core/rebelCore/proxyRuntimeForDecision';
import { ProviderRouter } from '@core/rebelCore/providerRouting';
import {
  getManagedKeyAvailability,
  registerManagedKeyAvailability,
} from '@core/rebelCore/managedKeyAvailability';
import { getApiKey, getOAuthToken } from '@core/rebelCore/settingsAccessors';
import { resolveConfiguredRoleFallback } from '@core/rebelCore/configuredRoleFallback';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
// ─── Stage 7: typed transport adapters + central dispatch ────────────────────
// The eight copy-pasted transport functions now live behind the
// `BtsTransportAdapter` interface in `bts/transports/`; this file owns
// orchestration (routing, structured-output fallback, cooldown pre-checks,
// cost) and dispatches via an exhaustive switch over BTS_TRANSPORT_ADAPTERS.
import { BTS_TRANSPORT_ADAPTERS } from './bts/transports';
import { markProfileChatIncompatible, markProfileJsonIncompatible } from './bts/profileCompatibility';
// ─── Stage 10: centralised cooldown discipline at the dispatch layer ─────────
// Recording moved out of the per-transport adapters into `executeBtsPlan`; the
// per-category bucket is selected once via `cooldownBucketFor`; the fail-fast
// "cooldown unavailable" case throws a discriminable `SelfImposedRateLimitError`.
import {
  SelfImposedRateLimitError,
  cooldownBucketFor,
  recordBtsCooldownRateLimitFromError,
  recordBtsCooldownSuccess,
} from './bts/cooldown';
import {
  type BehindTheScenesRequestOptions,
  type BehindTheScenesResponse,
  type TrackingOptions,
  assertBtsProxyWired,
  getProxyAuth,
  getProxyUrl,
  sanitizeBtsOptionsForWireModel,
  withTransientRetry,
} from './bts/transports/shared';
import { isAlwaysOnThinkingModel } from '@core/rebelCore/modelLimits';
import { resolveOrModelToSdkId } from '@shared/data/openRouterModels';
import { callAnthropic } from './bts/transports/anthropic';
import { callDirectWithProfile } from './bts/transports/profile-http';
// ─── Stage 8: typed dispatch-core return shape + structured-output fallback ──
// `BtsCallResult` is the internal dispatch-core Result type (F4/F7); the four
// public entry points unwrap it to `BehindTheScenesResponse` at the boundary so
// the ~45 consumers stay untouched. `executeWithStructuredOutputProfileFallback`
// + its helpers (sink-boundary decode, profile resolution, the parse-failure
// strike counter, the one-shot bypass notice, the JSON-capability discriminator)
// were extracted to `bts/structuredOutputFallback.ts`. Re-exported below to keep
// the module's long-standing public surface (clientFactory + the BTS test suites
// import these names from here).
import type { BtsCallResult, BtsCostAttribution, BtsCostSource } from './bts/types';
import {
  type ExecutedBtsCall,
  decodeSinkBoundaryModel,
  executeWithStructuredOutputProfileFallback,
  resolveProfileFromModel,
} from './bts/structuredOutputFallback';

// ─── Re-exported public surface (moved to bts/transports/* in Stage 7) ───────
// These names are part of this module's long-standing public API (≈115
// importers / 45 consumers, plus the BTS test suites). Re-export so the
// extraction is fully behaviour-preserving and zero consumers change.
export { stripThinkingBlocks } from '@core/utils/stripThinkingBlocks';
export {
  type BehindTheScenesRequestOptions,
  type BehindTheScenesResponse,
  type TrackingOptions,
  type WireSafeBtsOptions,
  ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS,
  extractJsonFromStructuredResponse,
  getProxyAuth,
  getProxyUrl,
  isTransientNetworkError,
  parseJsonResponseBody,
  registerBtsProxyProviders,
  declareNoBtsProxy,
  registerPreOAuthCallHook,
  sanitizeBtsOptionsForWireModel,
} from './bts/transports/shared';
// Re-exported public surface extracted to `bts/structuredOutputFallback.ts` in
// Stage 8 (zero-consumer-change extraction — clientFactory + BTS test suites
// import these from here).
export {
  resolveProfileFromModel,
  executeWithStructuredOutputProfileFallback,
  __resetJsonParseFailureStrikesForTesting,
  __resetStructuredOutputBypassNoticesForTesting,
} from './bts/structuredOutputFallback';
// Stage 8 typed dispatch-core Result + cost-attribution types (F4/F7).
export type { BtsCallResult, BtsCostAttribution, BtsCostSource } from './bts/types';
// Stage 10: the discriminable self-imposed rate-limit class (invariant 4, PM
// 260428). Re-exported so consumers (e.g. generateCompactionSummary) can tell a
// self-imposed cooldown skip from a real upstream 429 via `instanceof`.
export { SelfImposedRateLimitError, cooldownBucketFor } from './bts/cooldown';

const log = createScopedLogger({ service: 'behindTheScenesClient' });

export interface AuthAwareDispatchOptions {
  /** Enforce a single dispatch and skip configured operational reroute. */
  disableOperationalFallback?: boolean;
}

/** @internal — test seam for the chat marker guard (A0 unit test). */
export function __markProfileChatIncompatibleForTesting(profileId: string): void {
  markProfileChatIncompatible(profileId);
}

/** @internal — test seam for the JSON marker guard (A0 unit test). */
export function __markProfileJsonIncompatibleForTesting(profileId: string): void {
  markProfileJsonIncompatible(profileId);
}

/**
 * Managed-key availability resolver now lives in the cycle-free leaf module
 * `@core/rebelCore/managedKeyAvailability` (so `providerRouting` can consume it
 * without a circular import). Re-exported here for back-compat: the desktop-main,
 * cloud, and CLI registrars still import these from this module.
 */
export { getManagedKeyAvailability, registerManagedKeyAvailability };
export const CODEX_BTS_DISCONNECTED_ERROR =
  'Background task cannot use the selected ChatGPT Pro model because ChatGPT Pro is not connected. ' +
  'Reconnect ChatGPT Pro in Settings or choose a different model for this task.';

export class CodexDisconnectedBtsError extends ModelError {
  constructor() {
    super('model_unavailable', CODEX_BTS_DISCONNECTED_ERROR);
    this.name = 'CodexDisconnectedBtsError';
  }
}

const CODEX_BTS_CAPTURE_DEDUPE_MAX = 200;
const CODEX_BTS_CAPTURE_RATE_LIMIT_MS = 5 * 60 * 1000;
const codexBtsCapturedSessions = new Map<string, number>();
let codexBtsLastUnscopedCaptureMs = 0;

/** @internal Test-only — reset the per-session dedupe state. */
export function _resetCodexBtsCaptureDedupeForTests(): void {
  codexBtsCapturedSessions.clear();
  codexBtsLastUnscopedCaptureMs = 0;
}

function shouldCaptureCodexBtsDisconnect(sessionId: string | undefined): boolean {
  const now = Date.now();
  if (sessionId) {
    if (codexBtsCapturedSessions.has(sessionId)) return false;
    if (codexBtsCapturedSessions.size >= CODEX_BTS_CAPTURE_DEDUPE_MAX) {
      const oldestKey = codexBtsCapturedSessions.keys().next().value;
      if (oldestKey !== undefined) codexBtsCapturedSessions.delete(oldestKey);
    }
    codexBtsCapturedSessions.set(sessionId, now);
    return true;
  }
  if (now - codexBtsLastUnscopedCaptureMs < CODEX_BTS_CAPTURE_RATE_LIMIT_MS) return false;
  codexBtsLastUnscopedCaptureMs = now;
  return true;
}

function throwCodexDisconnectedBtsError(ctx: {
  category?: AuxiliaryCostCategory;
  caller: 'callBehindTheScenes' | 'callBehindTheScenesWithAuth' | 'callWithModelAuthAware';
}): never {
  const error = new CodexDisconnectedBtsError();
  log.warn(
    { ...ctx, codexConnected: false, reason: 'codex-disconnected-bts-blocked' },
    'codex-profile-bts-blocked',
  );
  const sessionId = getTurnContext()?.sessionId;
  if (shouldCaptureCodexBtsDisconnect(sessionId)) {
    captureKnownCondition(
      'codex_disconnected_bts',
      {
        tags: {
          reason: 'codex-profile-bts-blocked',
          caller: ctx.caller,
          ...(ctx.category ? { category: ctx.category } : {}),
        },
        extra: {
          codexConnected: false,
          sessionId: sessionId ?? null,
        },
      },
      error,
    );
  }
  throw error;
}


export async function createBtsRoutePlan(
  settings: AppSettings,
  model: string,
  options: BehindTheScenesRequestOptions,
  category?: AuxiliaryCostCategory,
): Promise<ProviderRoutePlan> {
  type AppSettingsWithManagedKey = AppSettings & { hasManagedKey?: boolean };
  const decodedModel = decodeSinkBoundaryModel(model, 'createBtsRoutePlan');
  if (decodedModel === null) {
    throw new Error(
      `createBtsRoutePlan: invalid model value '${model}' after sink-boundary decode (empty after strip). ` +
      'This indicates a settings persistence or migration bug.',
    );
  }
  model = decodedModel;
  const callerManagedKey = (settings as AppSettingsWithManagedKey).hasManagedKey;
  const settingsWithManagedKey: AppSettingsWithManagedKey =
    typeof callerManagedKey === 'boolean'
      ? (settings as AppSettingsWithManagedKey)
      : { ...(settings as AppSettingsWithManagedKey), hasManagedKey: getManagedKeyAvailability() };
  const profile = resolveProfileFromModel(model, settings.localModel?.profiles);
  const profileApiKey = profile
    ? resolveProfileApiKey(profile, settingsWithManagedKey.providerKeys, settingsWithManagedKey.customProviders)
    : null;
  const proxyBaseURL = await getProxyUrl();
  const proxyAuthToken = await getProxyAuth();
  const decision = ProviderRouter.forBTS({
    model,
    settings: settingsWithManagedKey,
    profile,
    codexConnectivity: options.codexConnectivity,
    category,
  });
  // F1: the PRIMARY dispatch path carries the proxy runtime into the adapters via
  // the route plan, so the adapters' `plan?.proxyBaseURL` branch skips the HARD
  // `resolveBtsProxyForTransport()`. Hard-assert wiring HERE — once the route
  // decision is known and ONLY for proxy-backed dispatch — so an unwired proxy on
  // the real path fails LOUD with `BtsProxyNotWiredError` + the `bts-proxy-unwired`
  // marker instead of the generic transient guard. Non-proxy dispatch
  // (anthropic-direct / profile-direct) never reaches this branch (I8); explicit
  // `none` and wired-but-stopped are no-ops here and continue to the adapter's
  // transient `if (!url || !auth) throw` guard (I5).
  if (isProxyDispatch(decision.dispatchPath)) {
    assertBtsProxyWired();
  }
  const decisionProxyRuntime = proxyRuntimeForDecision(decision, {
    baseURL: proxyBaseURL,
    authToken: proxyAuthToken,
  });

  // Diag-only: capture the BTS routing decision when the eval-harness diag flag
  // is enabled. Masks all credentials. Removable once Stage 2 of the eval-harness
  // recovery plan lands a permanent fix.
  diagLog({ site: 'btsRoutePlan' }, {
    model,
    category,
    activeProvider: settingsWithManagedKey.activeProvider ?? '<unset>',
    hasManagedKey: settingsWithManagedKey.hasManagedKey ?? false,
    decisionKind: decision.kind,
    decisionTransport: decision.transport,
    decisionDispatchPath: decision.dispatchPath,
    decisionInvalidReason: decision.invalidReason ?? null,
    wireModel: 'wireModelId' in decision ? decision.wireModelId : '<n/a>',
    profileMatched: !!profile,
    profileId: profile?.id ?? null,
    anthropicKeyFp: fingerprint(getApiKey(settingsWithManagedKey)),
    anthropicOauthFp: fingerprint(getOAuthToken(settingsWithManagedKey)),
    openRouterOauthFp: fingerprint(settingsWithManagedKey.openRouter?.oauthToken),
    openAiKeyFp: fingerprint(settingsWithManagedKey.providerKeys?.openai ?? null),
    profileApiKeyFp: fingerprint(profileApiKey),
  });

  return materializePlanRuntime(decision, {
    turnId: null,
    anthropicApiKey: normalizeApiKey(getApiKey(settingsWithManagedKey)),
    anthropicOAuthToken: getOAuthToken(settingsWithManagedKey) ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    openAIApiKey: settingsWithManagedKey.providerKeys?.openai ?? null,
    openRouterOAuthToken: settingsWithManagedKey.openRouter?.oauthToken ?? null,
    profileApiKey,
    proxyBaseURL: decisionProxyRuntime.proxyBaseURL,
    proxyAuthToken: decisionProxyRuntime.proxyAuthToken,
    routedModel: decisionProxyRuntime.routedModel,
    endpointBaseURL: profile?.serverUrl ?? null,
    includeStructuredOutputBeta: !!options.outputFormat,
  });
}

function throwMissingCredentialsForPlan(plan: TerminalRoutePlan): never {
  const invalidReason = plan.decision.invalidReason;
  switch (invalidReason) {
    // `missing-anthropic-credentials-for-claude-model` is primary-turn-only by
    // construction (providerRouting scopes it via isPrimaryTurnRole); BTS keeps
    // `missing-anthropic-credentials`. Mapped here defensively so a hypothetical
    // scope regression still yields a sensible BTS message, not an assertNever.
    case 'missing-anthropic-credentials':
    case 'missing-anthropic-credentials-for-claude-model':
      throw new Error(
        'No model configured for background tasks. Add an API key in Settings or assign a model to the background tasks role.'
      );
    case 'missing-openrouter-credentials':
      throw new Error('OpenRouter credentials are not available for background task routing.');
    case 'missing-mindstone-credentials':
      throw new Error('Your Mindstone subscription is not ready for background task routing. Check your subscription status in Settings.');
    case 'missing-codex-connection':
      throw new Error('ChatGPT Pro is not connected for background task routing.');
    case 'codex-unsupported-model':
      throw new Error(`ChatGPT Pro does not support background task model "${plan.decision.wireModelId}".`);
    case 'missing-profile-credentials':
      throw new Error('The selected model profile is missing credentials for background task routing.');
    case 'proxy-dialect-in-direct-anthropic':
      throw new Error(`Background task model "${plan.decision.wireModelId}" cannot be sent directly to Anthropic.`);
    case 'codex-disconnected-bts-blocked':
      throwCodexDisconnectedBtsError({ caller: 'callBehindTheScenesWithAuth' });
    default:
      return assertNever(invalidReason, 'TerminalRouteDecision.invalidReason in throwMissingCredentialsForPlan');
  }
}

async function handleTerminalBts(
  plan: ProviderRoutePlan & { decision: TerminalRouteDecision },
  settings: AppSettings,
  options: BehindTheScenesRequestOptions,
  caller: 'callBehindTheScenes' | 'callBehindTheScenesWithAuth' | 'callWithModelAuthAware',
  tracking?: TrackingOptions,
): Promise<BehindTheScenesResponse> {
  const transport = plan.decision.transport;
  switch (transport) {
    case 'no-credentials': {
      if (plan.decision.invalidReason === 'missing-anthropic-credentials') {
        const fallbackProfile = getWorkingProfileFallback(settings);
        if (fallbackProfile) {
          log.info(
            { profile: fallbackProfile.name, originalModel: plan.decision.wireModelId },
            'No Anthropic credentials and no BTS profile — using working model for background task (may have different cost)'
          );
          // Sanitize per dispatch, keyed on the FALLBACK PROFILE'S actual model
          // (not plan.decision.wireModelId — this dispatch goes to the profile).
          const wireSafeOptions = sanitizeBtsOptionsForWireModel(
            fallbackProfile.model ?? '',
            options,
          );
          // Cooldown is recorded by the wrapping executeBtsPlan (dispatch layer).
          return withTransientRetry(
            () => callDirectWithProfile(
              fallbackProfile,
              wireSafeOptions,
              settings.providerKeys,
              settings.customProviders,
              null,
            ),
            options.signal,
          );
        }
      }
      return throwMissingCredentialsForPlan(plan);
    }
    case 'fail-closed-codex-disconnected':
      throwCodexDisconnectedBtsError({ category: tracking?.category, caller });
    default:
      return assertNever(transport, 'BTS terminal transport');
  }
}

/**
 * Central dispatch + cooldown discipline (Stage 10).
 *
 * Cooldown RECORDING is centralised here so every transport is covered by
 * construction — no individual adapter calls `cooldown.record*` (PM 260429: a
 * transport silently dropping its recorder can no longer regress because no
 * adapter holds the recorder). The adapters parse provider-specific
 * `retry-after` and surface a typed signal (see `bts/cooldown.ts`):
 *   - SUCCESS: `executeBtsPlanInner` resolving a response is recorded as success
 *     HERE, which is strictly AFTER the adapter's body parse — so an SSE body
 *     (which throws inside `parseJsonResponseBody`) never records success
 *     (invariants 12/13).
 *   - RATE-LIMIT: an adapter that classified a genuine 429 attached a signal to
 *     the thrown `ModelError`; `recordBtsCooldownRateLimitFromError` records it
 *     (billing/quota 429s carry no signal, so they are NOT recorded — preserved).
 *
 * `cooldown` is the per-category bucket selected by the entry point via
 * `cooldownBucketFor` (invariant 5).
 */
async function executeBtsPlan(
  plan: ProviderRoutePlan,
  settings: AppSettings,
  options: BehindTheScenesRequestOptions,
  caller: 'callBehindTheScenes' | 'callBehindTheScenesWithAuth' | 'callWithModelAuthAware',
  tracking?: TrackingOptions,
  cooldown: ApiRateLimitCooldown = apiRateLimitCooldown,
): Promise<BehindTheScenesResponse> {
  try {
    const response = await executeBtsPlanInner(plan, settings, options, caller, tracking);
    recordBtsCooldownSuccess(cooldown);
    return response;
  } catch (error) {
    recordBtsCooldownRateLimitFromError(cooldown, error);
    throw error;
  }
}

async function executeBtsPlanInner(
  plan: ProviderRoutePlan,
  settings: AppSettings,
  options: BehindTheScenesRequestOptions,
  caller: 'callBehindTheScenes' | 'callBehindTheScenesWithAuth' | 'callWithModelAuthAware',
  tracking?: TrackingOptions,
): Promise<BehindTheScenesResponse> {
  if (isTerminalRoutePlan(plan)) {
    return handleTerminalBts(plan, settings, options, caller, tracking);
  }
  const dispatchablePlan = plan;
  const transport = dispatchablePlan.decision.transport;

  // Exhaustive transport switch (Stage 7). Each arm selects the typed
  // `BtsTransportAdapter` for the transport and invokes its uniform `execute`.
  // The switch is retained (rather than a bare registry lookup) so that:
  //   (a) adding a `DispatchableTransport` without an arm is a compile error,
  //   (b) the per-transport debug logs that aided proxy-routing triage stay,
  //   (c) the `default` arm still fires `captureRouteInvariantBreach` if a
  //       non-dispatchable transport slips through the narrow.
  switch (transport) {
    case 'anthropic-direct':
      break;
    case 'anthropic-compatible-local-proxy':
      break;
    case 'codex-proxy':
      log.debug({ model: dispatchablePlan.decision.wireModelId }, 'Using Codex proxy for background task');
      break;
    case 'openrouter-proxy':
      log.debug({ model: dispatchablePlan.decision.wireModelId }, 'Using OpenRouter proxy for background task');
      break;
    case 'openai-compatible-http':
    case 'local-openai-compatible-http':
      break;
    default: {
      captureRouteInvariantBreach(
        dispatchablePlan.decision,
        'Impossible state: dispatchable narrow breached in BTS executeBtsPlan',
      );
      return assertNever(transport, 'BTS transport');
    }
  }

  const adapter = BTS_TRANSPORT_ADAPTERS[transport];
  // Sanitize per dispatch, keyed on THIS dispatch's resolved wire model
  // (sampling-forbidden / always-on axes). The sanitizer is pure (fresh object), so the
  // operational-fallback re-dispatch below re-sanitizes from the CALLER'S
  // ORIGINAL options for the fallback model instead of inheriting the primary
  // dispatch's stripped sampling params or max_tokens floor.
  const wireSafeOptions = sanitizeBtsOptionsForWireModel(
    dispatchablePlan.decision.wireModelId,
    options,
  );
  return adapter.execute({ plan: dispatchablePlan, options: wireSafeOptions, settings });
}

function failClosedTerminalBtsFallback(
  plan: ProviderRoutePlan & { decision: TerminalRouteDecision },
  caller: 'callBehindTheScenes' | 'callBehindTheScenesWithAuth' | 'callWithModelAuthAware',
  tracking?: TrackingOptions,
): never {
  switch (plan.decision.transport) {
    case 'no-credentials':
      return throwMissingCredentialsForPlan(plan);
    case 'fail-closed-codex-disconnected':
      throwCodexDisconnectedBtsError({ category: tracking?.category, caller });
    default:
      return assertNever(plan.decision.transport, 'Terminal BTS transport');
  }
}

async function executeBtsPlanWithOperationalFallback(params: {
  plan: ProviderRoutePlan;
  modelToUse: string;
  settings: AppSettings;
  options: BehindTheScenesRequestOptions;
  caller: 'callBehindTheScenes' | 'callBehindTheScenesWithAuth' | 'callWithModelAuthAware';
  tracking?: TrackingOptions;
  cooldown?: ApiRateLimitCooldown;
  backgroundFallbackAttempted?: boolean;
}): Promise<ExecutedBtsCall> {
  const {
    plan,
    modelToUse,
    settings,
    options,
    caller,
    tracking,
    cooldown = apiRateLimitCooldown,
    backgroundFallbackAttempted = false,
  } = params;

  const primaryProfile = plan.decision.profileId
    ? settings.localModel?.profiles?.find((candidate) => candidate.id === plan.decision.profileId) ?? null
    : null;
  const primaryResolvedAuth = deriveResolvedAuthLabel(plan.auth);

  try {
    const response = await executeBtsPlan(plan, settings, options, caller, tracking, cooldown);
    return {
      response,
      resolvedModel: modelToUse,
      profile: primaryProfile,
      resolvedAuth: primaryResolvedAuth,
      usedOperationalFallback: false,
    };
  } catch (primaryError) {
    const classifiedPrimaryError = classifyError(primaryError, options.signal);
    const fallbackDecision = resolveConfiguredRoleFallback({
      role: 'background',
      settings,
      availableProfiles: settings.localModel?.profiles ?? [],
      attempted: backgroundFallbackAttempted,
      errorKind: classifiedPrimaryError.kind,
      errorMessage: classifiedPrimaryError.message,
      allowRateLimit: false,
      currentModel: modelToUse,
      currentProfileId: plan.decision.profileId ?? null,
    });

    // eslint-disable-next-line no-restricted-syntax -- non-routing kind discriminator: configured fallback decision union (not provider feature gate)
    if (fallbackDecision.kind !== 'use_fallback') {
      throw primaryError;
    }

    const fallbackModel = fallbackDecision.target.encoded;
    log.warn(
      {
        category: tracking?.category,
        role: 'background',
        primaryModel: modelToUse,
        fallbackModel,
        errorKind: classifiedPrimaryError.kind,
      },
      'BTS operational failure — retrying with configured background fallback',
    );

    const fallbackPlan = await createBtsRoutePlan(settings, fallbackModel, options, tracking?.category);
    if (isTerminalRoutePlan(fallbackPlan)) {
      failClosedTerminalBtsFallback(fallbackPlan, caller, tracking);
    }

    const fallbackProfile = fallbackPlan.decision.profileId
      ? settings.localModel?.profiles?.find((candidate) => candidate.id === fallbackPlan.decision.profileId) ?? null
      : null;
    const fallbackResolvedAuth = deriveResolvedAuthLabel(fallbackPlan.auth);
    const fallbackResponse = await executeBtsPlan(fallbackPlan, settings, options, caller, tracking, cooldown);

    return {
      response: fallbackResponse,
      resolvedModel: fallbackModel,
      profile: fallbackProfile,
      resolvedAuth: fallbackResolvedAuth,
      usedOperationalFallback: true,
    };
  }
}

/**
 * Track cost for a successful API response if tracking is enabled.
 *
 * Fire-and-forget: logs warnings on failure but NEVER throws (invariant 17).
 * The entire body is wrapped in try/catch so a ledger fault cannot break the
 * BTS call.
 *
 * Stage 8 (F7): returns a typed {@link BtsCostAttribution} so the dispatch core
 * can carry cost as first-class state on {@link BtsCallResult}. Cost-source
 * priority (invariants 18-19) is preserved exactly:
 *   `_exactCostUsd` (provider/OpenRouter `usage.cost`) → token-calculated →
 *   `_sdkCostUsd` (legacy).
 *
 * `UnknownPricing` first-class state (PM 260405, invariant 18): when tokens were
 * consumed but `MODEL_CATALOG` has no pricing, `calculateCostOrWarn` returns
 * `null` and emits its own process-scoped warn-once. We additionally surface the
 * `source: 'unknown'` state as an observable structured log + the returned
 * attribution discriminant, instead of silently dropping it. No synthetic ledger
 * row is written for unknown pricing — `CostLedgerEntry.cost` is a required
 * number and a placeholder `0` would corrupt cost summaries (invariant 19c pins
 * "no usage/exact ⇒ no ledger row"). The observability lives in the log +
 * `BtsCallResult.cost.source`, not a fabricated entry; surfacing it to a
 * consumer's control flow would be a product decision and is out of scope.
 */
function trackCostIfEnabled(
  response: BehindTheScenesResponse,
  tracking?: TrackingOptions
): BtsCostAttribution {
  // Skip if tracking not requested. `none` (no derivable cost) — benign no-op.
  if (!tracking) return { source: 'none', amountUsd: null, ledgerWritten: false };

  try {
    let cost: number | null = null;
    let costSource: BtsCostSource;

    // Prefer exact cost from provider (e.g., OpenRouter's usage.cost)
    if (response._exactCostUsd != null) {
      cost = response._exactCostUsd;
      costSource = 'exact';
    } else if (response.usage) {
      // Calculate cost from token usage — wrapper handles warn-once for unknown models
      cost = calculateCostOrWarn(
        response.model,
        response.usage.input_tokens,
        response.usage.output_tokens,
        log,
        tracking.category,
        response.usage.cache_creation_input_tokens ?? undefined,
        response.usage.cache_read_input_tokens ?? undefined,
      );
      // F7: when tokens were consumed but no pricing exists, this is the
      // first-class UnknownPricing state — not "calculated". Forward it as an
      // observable structured state instead of silently dropping it.
      costSource = cost === null ? 'unknown' : 'calculated';
    } else if (response._sdkCostUsd != null) {
      // Legacy fallback path
      cost = response._sdkCostUsd;
      costSource = 'legacy-sdk';
    } else {
      log.debug({ model: response.model, category: tracking.category }, 'No cost data available, skipping cost tracking');
      return { source: 'none', amountUsd: null, ledgerWritten: false };
    }

    // Unknown pricing: tokens consumed, no catalog price. Observable (structured
    // log + returned discriminant), but no ledger row (see fn doc — invariant
    // 19c). `calculateCostOrWarn` already fired the process-scoped warn-once;
    // this info-level line records the per-call UnknownPricing forwarding so the
    // state is provably observable on every occurrence, not just the first.
    if (cost === null) {
      log.info(
        { model: response.model, category: tracking.category, pricingSource: 'unknown' },
        'BTS cost attribution: model unpriced — forwarding UnknownPricing state (no ledger row written)',
      );
      return { source: 'unknown', amountUsd: null, ledgerWritten: false };
    }

    // Append to ledger (fire-and-forget)
    const outcomePolicy = tracking.outcomePolicy ?? 'auxiliary';
    appendCostEntry({
      ts: Date.now(),
      cost,
      cat: tracking.category,
      m: response.model,
      sid: tracking.sessionId,
      tid: tracking.turnId,
      auth: tracking.auth,
      outcome: outcomePolicy === 'turn_bearing'
        ? { kind: 'success' }
        : outcomePolicy === 'late_resolve'
          ? undefined
          : { kind: 'auxiliary_success' },
      ...(response._openRouterProvider ? { orProvider: response._openRouterProvider } : {}),
    });

    log.debug(
      { cost, costSource, model: response.model, category: tracking.category, sid: tracking.sessionId },
      'Tracked auxiliary cost'
    );
    return { source: costSource, amountUsd: cost, ledgerWritten: true };
  } catch (err) {
    // Log but don't throw - cost tracking should never break the main flow.
    log.warn({ err, model: response.model, category: tracking.category }, 'Failed to track auxiliary cost');
    return { source: 'none', amountUsd: null, ledgerWritten: false };
  }
}

/**
 * Compile-time exhaustiveness ledger for `BtsCallResult.kind`.
 *
 * This is the lever the Phase-5 reviewers asked for: it forces `settleBtsCall`
 * (and any future dispatch-core mapping) to be revisited when the union grows.
 * Every member of `BtsCallResult['kind']` must be classified here as either
 * `'settled'` (produced/handled by `settleBtsCall` today) or `'reserved'`
 * (declared but not yet emitted — `rate_limit` / `capability_skipped`, promoted
 * to live in Stage 10). Adding a new `BtsCallResult` kind without adding an entry
 * makes this object fail to satisfy the `Record` over the full key set → a
 * compile error precisely at this ledger. Promoting a `'reserved'` kind to live
 * is then a deliberate edit (flip it to `'settled'` AND add its `case` to the
 * `settleBtsCall` switch), not a silent omission.
 */
const BTS_CALL_RESULT_KIND_DISPOSITION = {
  ok: 'settled',
  degraded: 'settled',
  rate_limit: 'reserved',
  capability_skipped: 'reserved',
} satisfies Record<BtsCallResult['kind'], 'settled' | 'reserved'>;

/**
 * Build the internal {@link BtsCallResult} from a resolved {@link ExecutedBtsCall}
 * and its cost attribution, then run fire-and-forget cost tracking.
 *
 * This is the single dispatch-core → Result boundary (Stage 8, F4/F7). Every
 * public entry point funnels its resolved call through here and then unwraps
 * `result.response` to a `BehindTheScenesResponse` so consumers stay untouched.
 *
 * The Result discriminant is `degraded` whenever the configured-role operational
 * fallback actually rerouted the call (`usedOperationalFallback` is the only signal
 * the orchestration surfaces to this boundary today), otherwise `ok`.
 *
 * Observability is per-axis and the `proof` is truthful to the trigger that
 * produced the variant:
 *   - The operational-fallback axis (the one that drives `degraded` here) emits a
 *     structured `log.warn` ('BTS operational failure — retrying with configured
 *     background fallback', see `executeBtsPlanWithOperationalFallback`) and NO
 *     `captureKnownCondition`. So its proof is `{ logged: true, structured: true }`
 *     with NO `sentryClass` — claiming a Sentry fingerprint here would be a false
 *     observability claim (the exact rubber-stamp `ProofOfObservability` forbids).
 *   - The structured-output ladder triggers DO emit
 *     `captureKnownCondition('bts_structured_output_fallback')`, but they do not set
 *     `usedOperationalFallback`, so they never reach this `degraded` branch — they
 *     settle as `ok` (documented under-reporting; see `bts/types.ts`).
 *
 * The trailing `switch` over the constructed `kind` is an exhaustiveness guard: it
 * `assertNever`s the default arm so promoting a reserved `BtsCallResult` variant
 * (`rate_limit`/`capability_skipped`, Stage 10) without handling it here fails to
 * compile rather than silently under-classifying.
 */
/**
 * True when an always-on-thinking model's BTS reply exhausted its whole token
 * budget on thinking: `stop_reason: 'max_tokens'` with ZERO non-empty text
 * blocks (BTS parsers read only `type === 'text'`, so this otherwise
 * masquerades as watchdog fail-open `parse_failed` / safety fail-closed
 * parse failure). Pure predicate, exported for unit tests (Fable 5 Stage 4
 * item 6 — Runtime Safety F6).
 * @internal
 */
export function isAlwaysOnThinkingBudgetExhaustion(response: BehindTheScenesResponse): boolean {
  if (response._stopReason !== 'max_tokens') return false;
  // The OR proxy echoes OpenRouter's response `model`, which may be OR's
  // internal canonical slug (e.g. `anthropic/claude-5-fable-20260609`) —
  // a form `isAlwaysOnThinkingModel`'s normalization does NOT resolve
  // (catalog `openRouter.legacyIds` live only in the OR resolution chain).
  // Resolve OR-format ids the same way the pricing path does before the
  // capability check (GPT F1, Fable 5 Phase-6 refinement).
  const capabilityModel = response.model.includes('/')
    ? (resolveOrModelToSdkId(response.model.toLowerCase()) ?? response.model)
    : response.model;
  if (!isAlwaysOnThinkingModel(capabilityModel)) return false;
  return !response.content.some(
    (block) => block.type === 'text' && typeof block.text === 'string' && block.text.length > 0,
  );
}

function reportAlwaysOnThinkingBudgetExhaustion(
  response: BehindTheScenesResponse,
  tracking?: TrackingOptions,
): void {
  if (!isAlwaysOnThinkingBudgetExhaustion(response)) return;
  log.warn(
    {
      event: 'bts_always_on_thinking_budget_exhausted',
      model: response.model,
      category: tracking?.category,
      outputTokens: response.usage?.output_tokens,
      contentBlockCount: response.content.length,
    },
    'BTS reply from always-on-thinking model hit max_tokens with zero text blocks — thinking consumed the whole budget (downstream parsers will see this as a parse failure)',
  );
}

function settleBtsCall(
  executedCall: ExecutedBtsCall,
  tracking?: TrackingOptions,
): Extract<BtsCallResult, { kind: 'ok' | 'degraded' }> {
  // Distinct observability for the always-on-thinking budget-exhaustion class
  // BEFORE downstream parsers misreport it (Fable 5 Stage 4 item 6).
  reportAlwaysOnThinkingBudgetExhaustion(executedCall.response, tracking);
  const cost = trackCostIfEnabled(executedCall.response, tracking);
  const usedOperationalFallback = executedCall.usedOperationalFallback ?? false;

  const result: Extract<BtsCallResult, { kind: 'ok' | 'degraded' }> = usedOperationalFallback
    ? {
        kind: 'degraded',
        response: executedCall.response,
        resolvedModel: executedCall.resolvedModel,
        resolvedAuth: executedCall.resolvedAuth,
        usedOperationalFallback,
        // The trigger axis for this branch is the configured-role operational
        // fallback — NOT a structured-output ladder reroute. Label it honestly.
        reason: 'operational-fallback',
        cost,
        // Truthful per-axis proof: the operational-fallback site emits a
        // structured `log.warn` and NO `captureKnownCondition`, so no
        // `sentryClass` is claimed here (see fn doc).
        proof: {
          logged: true,
          structured: true,
        },
      }
    : {
        kind: 'ok',
        response: executedCall.response,
        resolvedModel: executedCall.resolvedModel,
        resolvedAuth: executedCall.resolvedAuth,
        usedOperationalFallback,
        cost,
      };

  // Runtime exhaustiveness over what this boundary actually constructs today
  // (ok | degraded). assertNever in the default arm rejects any future
  // construction path that yields an unhandled kind. The compile-time half of
  // the guard lives in BTS_CALL_RESULT_KIND_DISPOSITION below (a `satisfies
  // Record` over the FULL union key set) — that is what makes *adding a kind to
  // the union* fail to compile, since this switch's `result` is narrowed to the
  // response-bearing variants and would not otherwise see a new member.
  // eslint-disable-next-line no-restricted-syntax -- non-routing kind discriminator: BtsCallResult dispatch-outcome union (ok | degraded), not a provider feature gate; exhaustiveness guard per Stage 8 Phase-6 review.
  switch (result.kind) {
    case 'ok':
    case 'degraded':
      // The dispatch-outcome kind is a legitimate non-routing discriminant; the
      // disposition ledger pins that both arms are classified `'settled'`.
      void BTS_CALL_RESULT_KIND_DISPOSITION[result.kind];
      return result;
    default:
      return assertNever(result, 'BtsCallResult.kind in settleBtsCall');
  }
}

/**
 * Make an LLM call for background tasks.
 * Automatically routes through model profiles when a `profile:<id>` model is selected.
 *
 * @param settings - App settings containing API key and model preference
 * @param options - Request options (messages, maxTokens, etc.)
 * @param tracking - Optional cost tracking configuration
 *
 * NOTE: This legacy entry point intentionally does NOT check rate-limit cooldown.
 * Its callers (Atlas search insights in searchHandlers.ts) are user-triggered and
 * should be allowed to attempt the call even during cooldown. Use
 * `callBehindTheScenesWithAuth` for background tasks that should respect cooldown.
 */
export async function callBehindTheScenes(
  settings: AppSettings,
  options: BehindTheScenesRequestOptions,
  tracking?: TrackingOptions
): Promise<BehindTheScenesResponse> {
  // no-cooldown: user-triggered. Invariant 3 — this legacy entry point
  // intentionally does NOT pre-check the rate-limit cooldown (Atlas Insights
  // search is user-initiated and must be allowed to attempt even during a
  // cooldown). It still goes through executeBtsPlan, so a successful call/429
  // is still RECORDED at the dispatch layer on the default api bucket; only the
  // pre-check fail-fast gate is intentionally absent here.
  const model = resolveBtsModel(settings, tracking?.category);
  const executedCall = await executeWithStructuredOutputProfileFallback(
    model,
    options,
    settings.localModel?.profiles,
    tracking?.category,
    async (modelToUse, context) => executeBtsPlanWithOperationalFallback({
      plan: await createBtsRoutePlan(settings, modelToUse, options, tracking?.category),
      modelToUse,
      settings,
      options,
      caller: 'callBehindTheScenes',
      tracking,
      backgroundFallbackAttempted: context.backgroundFallbackAttempted,
    }),
  );

  // Settle through the internal BtsCallResult boundary (runs fire-and-forget
  // cost tracking) and unwrap to the public BehindTheScenesResponse.
  const result = settleBtsCall(executedCall, tracking);

  // Public contract: legacy callBehindTheScenes does not expose _resolvedAuth.
  return result.response;
}

// ─── Working profile fallback for BTS calls ────────────────────────────────

/** Known/trusted provider types safe for BTS fallback routing */
const TRUSTED_BTS_FALLBACK_PROVIDERS = new Set<string>(['openai', 'google', 'together', 'cerebras']);

/**
 * Attempt to fall back to the working model profile for BTS calls
 * when no Anthropic credentials are available and no BTS profile is set.
 *
 * Security: Only falls back to profiles with known/trusted provider types.
 * Returns null if no suitable fallback profile exists.
 * @internal
 */
export function getWorkingProfileFallback(settings: Pick<AppSettings, 'models' | 'localModel'>): ModelProfile | null {
  const profile = getWorkingModelProfile(settings);
  if (!profile) return null;

  const providerType = profile.providerType ?? 'other';
  // eslint-disable-next-line no-restricted-syntax -- routing-decision: TRUSTED_BTS_FALLBACK_PROVIDERS is a curated allowlist of providers known to support BTS streaming, not a feature-capability gate. Routing-allowlist membership belongs at the call site, not in providerFeatureGuards.ts. See docs/plans/260505_typed_provider_capability_matrix.md.
  if (!TRUSTED_BTS_FALLBACK_PROVIDERS.has(providerType)) {
    log.warn(
      { profile: profile.name, providerType },
      'Working profile has untrusted provider type — not using as BTS fallback'
    );
    return null;
  }

  return profile;
}

/**
 * Get the effective model name for logging/display purposes.
 */
export function getEffectiveModelName(settings: AppSettings): string {
  const model = resolveBtsModel(settings);

  const profile = resolveProfileFromModel(model, settings.localModel?.profiles);
  if (profile) {
    return profile.name;
  }

  return model;
}

/**
 * Make an LLM call using a model string that might be "profile:<id>".
 * For services that receive model as a parameter rather than full settings.
 *
 * @param apiKey - Anthropic API key
 * @param model - Model string, may be "profile:<id>"
 * @param localModelSettings - Local model settings for resolving profiles
 * @param options - Request options
 * @param tracking - Optional cost tracking configuration
 */
export async function callWithModel(
  apiKey: string,
  model: string | undefined,
  localModelSettings: AppSettings['localModel'],
  options: BehindTheScenesRequestOptions,
  tracking?: TrackingOptions
): Promise<BehindTheScenesResponse> {
  const effectiveModel = model ?? DEFAULT_AUXILIARY_MODEL;

  // Cooldown RECORDING for this off-plan entry point (Stage 10 refinement).
  // Unlike the other three entry points, callWithModel invokes the transports
  // (`callDirectWithProfile`/`callAnthropic`) DIRECTLY from its callback rather
  // than routing through `executeBtsPlan` — so the dispatch-layer recorder never
  // runs for it. Stage 10 moved recording OUT of the adapter bodies into
  // `executeBtsPlan`, which silently dropped the success/429 recording this entry
  // point performed in HEAD (via the adapters' former default-param recorders).
  // We restore it HERE, mirroring `executeBtsPlan`'s try/catch shape exactly:
  //   - record success AFTER the adapter resolves a parsed response (so an SSE
  //     body, which throws inside parseJsonResponseBody before the adapter
  //     returns, never records success — invariants 12/13), and
  //   - record a rate-limit from the signal an adapter attached to its thrown
  //     ModelError, then re-throw the original error unchanged for consumers.
  // No double-record: this entry point does NOT pass through `executeBtsPlan`, so
  // this is the sole recorder on its path. Bucket is selected by `cooldownBucketFor`
  // consistently with the other three entry points (invariant 5). No fail-fast
  // pre-check (invariant 3 class): like callBehindTheScenes this entry point is
  // recorder-only, not a gate.
  const cooldown = cooldownBucketFor(tracking?.category);

  // Wrap through the structured-output fallback so this entry point gets the
  // same JSON-capability runtime guard as callBehindTheScenes,
  // callBehindTheScenesWithAuth, and callWithModelAuthAware. Matches the
  // coverage stated in docs/plans/260427_json_capability_detection_bts_gating.md.
  const executedCall = await executeWithStructuredOutputProfileFallback(
    effectiveModel,
    options,
    localModelSettings?.profiles,
    tracking?.category,
    async (modelToUse, _context) => {
      const profile = resolveProfileFromModel(modelToUse, localModelSettings?.profiles);
      try {
        let response: BehindTheScenesResponse;
        // This off-plan entry point invokes the transports directly, so it
        // sanitizes per branch, keyed on each branch's actual wire model
        // (the profile's model for profile dispatch, the bare model id for
        // anthropic-direct) — mirroring executeBtsPlanInner.
        if (profile) {
          response = await callDirectWithProfile(
            profile,
            sanitizeBtsOptionsForWireModel(profile.model ?? '', options),
          );
        } else if (apiKey) {
          response = await callAnthropic(
            apiKey,
            modelToUse,
            sanitizeBtsOptionsForWireModel(modelToUse, options),
          );
        } else {
          const fallbackProfile = getWorkingProfileFallback(
            { localModel: localModelSettings } as Pick<AppSettings, 'models' | 'localModel'>
          );
          if (fallbackProfile) {
            log.info(
              { profile: fallbackProfile.name, originalModel: modelToUse },
              'No Anthropic credentials and no BTS profile — using working model for background task (may have different cost)'
            );
            response = await callDirectWithProfile(
              fallbackProfile,
              sanitizeBtsOptionsForWireModel(fallbackProfile.model ?? '', options),
            );
          } else {
            throw new Error(
              'No model configured for background tasks. Add an API key in Settings or assign a model to the background tasks role.'
            );
          }
        }
        // Mirror executeBtsPlan: success is recorded strictly AFTER the adapter
        // resolves a parsed response.
        recordBtsCooldownSuccess(cooldown);
        return { response, resolvedModel: modelToUse, profile };
      } catch (error) {
        // Mirror executeBtsPlan: record a 429 only when the adapter attached a
        // rate-limit signal (billing/quota 429s carry none), then re-throw the
        // original ModelError untouched so consumers see the same error.
        recordBtsCooldownRateLimitFromError(cooldown, error);
        throw error;
      }
    }
  );

  // Settle through the internal BtsCallResult boundary and unwrap.
  const result = settleBtsCall(executedCall, tracking);
  return result.response;
}

// =============================================================================
// OAuth-Aware Functions (Added 2026-02-10)
// These functions support both API key and OAuth authentication, routing to the
// appropriate path based on the user's auth method.
// See: docs/plans/finished/260210_oauth_tool_safety_fix.md
// =============================================================================

/**
 * Make an LLM call for background tasks with auth-aware routing.
 * Automatically routes based on the user's authentication method:
 * - API key users: Direct fetch (faster, ~10ms overhead)
 * - OAuth users: direct Anthropic API client with auth token
 *
 * Also routes directly to profile servers when a `profile:<id>` model is selected.
 *
 * @param settings - App settings containing auth credentials and model preference
 * @param options - Request options (messages, maxTokens, etc.)
 * @param tracking - Optional cost tracking configuration
 */
export async function callBehindTheScenesWithAuth(
  settings: AppSettings,
  options: BehindTheScenesRequestOptions,
  tracking?: TrackingOptions
): Promise<BehindTheScenesResponse> {
  // Fail-fast (invariant 4): skip the network call if the cooldown bucket is
  // active. Background tasks should not consume rate-limit budget better
  // reserved for user-initiated agent turns. Throws a discriminable
  // SelfImposedRateLimitError (a ModelError subclass with details.selfImposed)
  // so callers can mechanically tell our self-imposed skip from a real upstream
  // 429 (PM 260428). All callers handle it gracefully (e.g. bugReportAnalysisService
  // and compactionService return null on self-imposed rate_limit).
  const cooldown = cooldownBucketFor(tracking?.category);
  if (!cooldown.isAvailable()) {
    const remainingMs = cooldown.remainingMs();
    log.warn(
      { category: tracking?.category, remainingMs },
      'BTS call skipped — API rate-limit cooldown active',
    );
    throw new SelfImposedRateLimitError(
      remainingMs,
      `Background task skipped: API rate-limit cooldown active (${Math.ceil(remainingMs / 1000)}s remaining)`,
    );
  }

  const model = resolveBtsModel(settings, tracking?.category);
  const executedCall = await executeWithStructuredOutputProfileFallback(
    model,
    options,
    settings.localModel?.profiles,
    tracking?.category,
    async (modelToUse, context) => executeBtsPlanWithOperationalFallback({
      plan: await createBtsRoutePlan(settings, modelToUse, options, tracking?.category),
      modelToUse,
      settings,
      options,
      caller: 'callBehindTheScenesWithAuth',
      tracking,
      cooldown,
      backgroundFallbackAttempted: context.backgroundFallbackAttempted,
    }),
  );
  const response = executedCall.response;
  const profile = executedCall.profile;
  const resolvedAuth = executedCall.resolvedAuth;

  log.info({
    category: tracking?.category,
    resolvedModel: executedCall.resolvedModel,
    isProfile: !!profile,
    profileId: profile?.id,
    providerType: profile?.providerType,
    resolvedAuth,
  }, 'BTS routing resolved');

  response._resolvedModel = executedCall.resolvedModel;
  response._resolvedAuth = resolvedAuth;

  // Settle through the internal BtsCallResult boundary (runs fire-and-forget
  // cost tracking). Inject resolved auth into tracking if caller didn't set it.
  const effectiveTracking = tracking
    ? { ...tracking, auth: tracking.auth ?? resolvedAuth }
    : undefined;
  const result = settleBtsCall(executedCall, effectiveTracking);

  return result.response;
}

/**
 * Make an LLM call using a model string that might be "profile:<id>".
 * Auth-aware version that takes AppSettings instead of apiKey.
 *
 * This is a new wrapper that preserves backwards compatibility - existing
 * callWithModel() signature is unchanged. Services should be migrated to
 * use this function incrementally.
 *
 * @param settings - App settings containing auth credentials
 * @param model - Model string, may be "profile:<id>"
 * @param options - Request options
 * @param tracking - Optional cost tracking configuration
 */
export async function callWithModelAuthAware(
  settings: AppSettings,
  model: string | undefined,
  options: BehindTheScenesRequestOptions,
  tracking?: TrackingOptions,
  dispatchOptions?: AuthAwareDispatchOptions,
): Promise<BehindTheScenesResponse> {
  if (typeof model === 'string') {
    const decodedModel = decodeSinkBoundaryModel(model, 'callWithModelAuthAware');
    model = decodedModel ?? undefined;
  }
  const effectiveModel = model ?? DEFAULT_AUXILIARY_MODEL;
  // Invariant 5: safety category → safetyEvalRateLimitCooldown, else api bucket.
  // The selection rule is the typed single source of truth `cooldownBucketFor`.
  const effectiveCooldown = cooldownBucketFor(tracking?.category);

  // Fail-fast (invariant 4): skip network call if the effective cooldown bucket
  // is active. Mirrors callBehindTheScenesWithAuth; throws the discriminable
  // SelfImposedRateLimitError (PM 260428).
  if (!effectiveCooldown.isAvailable()) {
    const remainingMs = effectiveCooldown.remainingMs();
    log.warn(
      { category: tracking?.category, remainingMs },
      'BTS callWithModelAuthAware skipped — rate-limit cooldown active',
    );
    throw new SelfImposedRateLimitError(remainingMs);
  }

  const executedCall = await executeWithStructuredOutputProfileFallback(
    effectiveModel,
    options,
    settings.localModel?.profiles,
    tracking?.category,
    async (modelToUse, context) => {
      const plan = await createBtsRoutePlan(settings, modelToUse, options, tracking?.category);
      if (dispatchOptions?.disableOperationalFallback === true) {
        const profile = plan.decision.profileId
          ? settings.localModel?.profiles?.find((candidate) => candidate.id === plan.decision.profileId) ?? null
          : null;
        const resolvedAuth = deriveResolvedAuthLabel(plan.auth);
        const response = await executeBtsPlan(
          plan,
          settings,
          options,
          'callWithModelAuthAware',
          tracking,
          effectiveCooldown,
        );
        return {
          response,
          resolvedModel: modelToUse,
          profile,
          resolvedAuth,
          usedOperationalFallback: false,
        };
      }
      return executeBtsPlanWithOperationalFallback({
        plan,
        modelToUse,
        settings,
        options,
        caller: 'callWithModelAuthAware',
        tracking,
        cooldown: effectiveCooldown,
        backgroundFallbackAttempted: context.backgroundFallbackAttempted,
      });
    },
  );
  const response = executedCall.response;
  const profile = executedCall.profile;
  const resolvedAuth = executedCall.resolvedAuth;

  log.info({
    category: tracking?.category,
    resolvedModel: executedCall.resolvedModel,
    isProfile: !!profile,
    profileId: profile?.id,
    providerType: profile?.providerType,
    resolvedAuth,
  }, 'BTS routing resolved');

  response._resolvedModel = executedCall.resolvedModel;
  response._resolvedAuth = resolvedAuth;

  // Settle through the internal BtsCallResult boundary (runs fire-and-forget
  // cost tracking). Inject resolved auth into tracking if caller didn't set it.
  const effectiveTracking = tracking
    ? { ...tracking, auth: tracking.auth ?? resolvedAuth }
    : undefined;
  const result = settleBtsCall(executedCall, effectiveTracking);

  return result.response;
}
