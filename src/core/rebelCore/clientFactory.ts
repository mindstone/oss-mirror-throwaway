/**
 * Client Factory — Creates the appropriate ModelClient based on provider routing.
 *
 * Routing precedence (critical — preserves council/ad-hoc/tier routing):
 *
 * 1. proxyConfig present (executor injected ANTHROPIC_BASE_URL)
 *    → AnthropicClient pointed at proxy URL
 * 2. No active profile (getWorkingModelProfile returns null)
 *    → AnthropicClient (direct Anthropic API)
 * 3. profile.providerType === 'anthropic'
 *    → AnthropicClient (direct Anthropic API)
 * 4. profile.providerType === 'google'
 *    → AnthropicClient pointed at proxy URL (Gemini thought signatures need proxy)
 *    NOTE: This is intentional, not an SDK artifact. Google's Gemini API requires
 *    per-turn state for thought signatures (extra_content.google.thought_signature)
 *    captured from tool call responses and re-injected in subsequent requests.
 *    The proxy handles this state management. When/if Google adds native thought
 *    signature support, PRECEDENCE 3 can be removed and Gemini routed directly
 *    through OpenAIClient via their OpenAI-compatible endpoint.
 * 4. Profile with cloud serverUrl (non-Gemini)
 *    → OpenAIClient (direct to provider)
 * 5. Profile with localhost serverUrl
 *    → OpenAIClient via proxy
 *
 * @see docs/project/PROVIDER_RESOLUTION_AND_ROUTING.md — client-construction layer + dual-resolver note
 * @see docs/project/PROXY_AUTH_BOUNDARY.md — createModelClient is the sanctioned sentinel producer (PRECEDENCE 1)
 */
import { createScopedLogger } from '@core/logger';
import { diagLog, fingerprint } from '@core/devDiag/anthropicAuthDiag';
import { getAuthForDirectUse, isDirectAnthropicConfig } from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';
import { getWorkingModelProfile } from '@shared/types';
import type { ModelProfile } from '@shared/types/settings';
import { isProfileSelectable } from '@shared/utils/profileHelpers';
import {
  ConnectionNotConfiguredError,
  resolveConnectionCredentials,
} from '@shared/utils/connectionCredentials';
import { isCodexSubscriptionProfile, resolveProfileApiKey } from '@shared/utils/providerKeys';
import { AnthropicClient } from './clients/anthropicClient';
import { OpenAIClient } from './clients/openaiClient';
import { shouldSuppressProfileReasoning } from './modelLimits';
import { normalizeToOpenAIProviderType } from './clients/openaiClientTypes';
import type { CodexModeConfig } from './codexModeTypes';
import type { ModelClient } from './modelClient';
import { assertNever, buildRecoverableTerminalRouteError, captureRouteInvariantBreach, isProfileReference, isRouteTableDispatch, nonPassthroughAnthropicSlashBodyError, profileReferenceId, resolveDirectAnthropicModel, type DispatchableRouteDecision } from './providerRouteDecision';
import { CODEX_TURN_HEADER, OPENROUTER_TURN_HEADER } from './providerRouteHeaders';
import type { ProviderRouteRuntimeContext } from './providerRoutePlan';
import { isTerminalRoutePlan, type DispatchableRoutePlan, type ProviderRoutePlan, type TerminalRoutePlan } from './providerRoutePlanTypes';
import { resolveProviderRoutePlan, type ProviderRoutePlanRequest } from './providerRouting';
import { PROXY_HANDLES_AUTH_SENTINEL } from './proxyAuthContract';
import { getApiKey, getAuthMethod, getOAuthToken } from './settingsAccessors';

const log = createScopedLogger({ service: 'clientFactory' });

export interface CreateModelClientOptions {
  settings: AppSettings;
  proxyConfig?: { baseURL?: string; defaultHeaders?: Record<string, string> } | null;
  /** Enable Anthropic context_management (clear_tool_uses) for server-side pruning. Defaults to true for direct-Anthropic paths. Set to false to disable (kill switch). */
  enableContextManagement?: boolean;
  /** Explicit profile override — bypasses `getWorkingModelProfile()` for PRECEDENCE 2-5. */
  profileOverride?: ModelProfile;
  /** Override the provider label shown in error messages (e.g. 'OpenRouter' when proxying through Anthropic-compatible protocol). */
  providerLabel?: string;
  /**
   * Pre-resolved route decision from the caller (the modern
   * `createClientForModel → resolveProviderRoutePlan → createClientFromRoutePlan`
   * path). When present, PRECEDENCE 1 derives proxy provider-identity
   * (codex/openrouter/route-table) and the sentinel-vs-real-key choice from the
   * VERDICT (`transport`/`dispatchPath`) instead of re-sniffing the proxy headers
   * — so clientFactory stops being a second routing authority. Header-sniffing is
   * preserved verbatim as the fallback for legacy callers that have no decision
   * (the two legacy-precedence branches + any external direct `createModelClient`
   * caller). See WS1b / docs/plans/260620_ws1-routing-authority-spine.
   */
  routeDecision?: DispatchableRouteDecision;
}

export interface CreateClientForModelOptions {
  model: string;
  /** Direct profile reference — preferred over model-string matching */
  profile?: ModelProfile | null;
  settings: AppSettings;
  proxyConfig?: { baseURL?: string; defaultHeaders?: Record<string, string> } | null;
  /** Routing context for logging/diagnostics */
  context?: 'execution' | 'planning' | 'routed-execution' | 'escalated-execution' | 'subagent' | 'bts';
  /** Codex OAuth mode — injected by the executor when Codex is connected and no API key is present */
  codexMode?: CodexModeConfig;
}

type ProxyConfig = { baseURL?: string; defaultHeaders?: Record<string, string> };

export interface CreateClientFromRoutePlanOptions {
  /** Codex OAuth mode — passed through for Codex subscription profiles. */
  codexMode?: CodexModeConfig;
  /** Already-resolved route profile from the caller, when available. */
  routeProfile?: ModelProfile | null;
  /** Caller-provided proxy config to preserve byte-identical proxy dispatch when requested. */
  proxyConfigOverride?: ProxyConfig | null;
}

export { ConnectionNotConfiguredError };

function headersRecord(plan: Pick<ProviderRoutePlan, 'headers'>): Record<string, string> {
  return Object.fromEntries(plan.headers);
}

function stripRouteTableProviderIdentityHeaders(plan: Pick<ProviderRoutePlan, 'headers'>): ProviderRoutePlan['headers'] {
  return plan.headers.filter(([key]) => key !== OPENROUTER_TURN_HEADER && key !== CODEX_TURN_HEADER);
}

function proxyConfigFromRoutePlan(
  plan: DispatchableRoutePlan,
): ProxyConfig | undefined {
  const dispatchPath = plan.decision.dispatchPath;
  switch (dispatchPath) {
    case 'direct-provider':
      return undefined;
    case 'local-proxy-route-table': {
      if (!plan.proxyBaseURL) return undefined;
      return {
        baseURL: plan.proxyBaseURL,
        defaultHeaders: Object.fromEntries(stripRouteTableProviderIdentityHeaders(plan)),
      };
    }
    case 'local-proxy-passthrough':
      if (!plan.proxyBaseURL) return undefined;
      return {
        baseURL: plan.proxyBaseURL,
        defaultHeaders: headersRecord(plan),
      };
    default:
      return assertNever(dispatchPath, 'DispatchableDispatchPath');
  }
}

function createRoutePlanClientError(
  message: string,
  kind: 'auth' | 'routing' = 'auth',
): Error {
  const error = new Error(message);
  Object.defineProperty(error, '__agentErrorKind', {
    value: kind,
    enumerable: true,
    configurable: true,
  });
  return error;
}

/**
 * The signed/witness route-FACTS CARRIER family — the headers the proxy uses to BIND
 * a request to a route decision and consume its credentialSource for BILLING (plus
 * the WS1b-2 telemetry witness/digest minted from the same facts). On override reuse
 * these are ALWAYS DROPPED (the carrier cannot be re-minted authoritatively — see
 * `composeProxyConfigFromRoutePlan`).
 */
const ROUTE_FACTS_CARRIER_HEADERS = [
  'x-route-id',
  'x-route-facts',
  'x-route-wire-model',
  'x-route-tag',
] as const;

/**
 * The DISPATCH-MARKER headers — they select WHICH proxy handler runs / which route
 * the proxy keys. A reroute can change these (and route-table strips the
 * passthrough markers — see `proxyConfigFromRoutePlan`), so on override reuse they
 * are REFRESHED from the fresh plan (set where present, deleted where the fresh plan
 * omits them).
 */
const ROUTE_DISPATCH_MARKER_HEADERS = [
  'x-routed-model',
  'x-routed-turn-id',
  CODEX_TURN_HEADER,
  OPENROUTER_TURN_HEADER,
] as const;

/**
 * Compose the proxy dispatch config from a caller-supplied override's TRANSPORT,
 * dropping the stale route-facts carrier and refreshing the dispatch markers.
 *
 * BILLING-CORRECTNESS (260621): the in-turn reroute sites (rebelCoreQuery
 * planning/adaptive-route/escalate/context-overflow-fallback) reuse the ORIGINAL
 * turn's `proxyConfig` as the override while resolving a FRESH plan for a DIFFERENT
 * route. Returning the override's `defaultHeaders` WHOLESALE replayed the PRIOR
 * plan's `x-route-id` + `x-route-facts` TOGETHER — they still self-consistently
 * match, so the proxy's `verifyInboundRouteFacts` route-id binding PASSES and the
 * proxy consumes STALE billing facts (a personal request charged to managed, or
 * vice-versa).
 *
 * We CANNOT re-mint the carrier from the fresh plan: `createClientForModel`'s
 * runtime context does NOT inject managed-key availability, so the fresh plan
 * resolves the WRONG credentialSource for a managed (`activeProvider==='mindstone'`)
 * turn (personal instead of managed) — re-minting would FLIP managed billing to
 * personal. The executor's full-context plan that produced the override is the
 * authoritative one. So on override reuse we DROP the carrier family
 * ({@link ROUTE_FACTS_CARRIER_HEADERS}) and let the proxy fall back to its existing
 * fail-safe re-derivation (`facts === null → activeProvider`), which is CORRECT
 * within a turn (activeProvider is stable; only the model changes). The dispatch
 * markers ({@link ROUTE_DISPATCH_MARKER_HEADERS}) ARE refreshed from the fresh plan
 * because they pick the proxy handler / route key. (Cross-family review: GPT-5.5-xhigh.)
 *
 * Everything else is route-INDEPENDENT transport, preserved from the override
 * verbatim: upstream auth (`authorization`/`x-api-key` — stripped + re-injected by
 * the proxy on egress), the localhost `x-proxy-auth` secret, and protocol headers
 * (`anthropic-version`/`content-type`/`http-referer`/`x-title`). This keeps the
 * executor→proxy local hop byte-identical to the original turn's for those headers.
 *
 * When NO override is supplied, the fresh plan's full header set is used as-is (the
 * normal sub-agent path — the plan IS authoritative there). When an override has a
 * `baseURL` but the plan has none, the override's baseURL is the transport.
 */
function composeProxyConfigFromRoutePlan(
  plan: DispatchableRoutePlan,
  proxyConfigOverride?: ProxyConfig | null,
): ProxyConfig | undefined {
  const planProxyConfig = proxyConfigFromRoutePlan(plan);
  const baseURL = proxyConfigOverride?.baseURL ?? planProxyConfig?.baseURL;
  if (!baseURL) return undefined;
  const freshHeaders = planProxyConfig?.defaultHeaders ?? {};
  if (!proxyConfigOverride?.defaultHeaders) {
    // No override: the fresh plan's own headers are authoritative.
    return { baseURL, defaultHeaders: { ...freshHeaders } };
  }
  // Override reuse: keep the override's transport/auth/protocol headers verbatim,
  // DROP the stale route-facts carrier (proxy re-derives — the fail-safe), and
  // REFRESH the dispatch markers from the fresh plan.
  const merged: Record<string, string> = { ...proxyConfigOverride.defaultHeaders };
  for (const name of ROUTE_FACTS_CARRIER_HEADERS) {
    delete merged[name];
  }
  for (const name of ROUTE_DISPATCH_MARKER_HEADERS) {
    const fresh = freshHeaders[name];
    if (fresh !== undefined) merged[name] = fresh;
    else delete merged[name];
  }
  return { baseURL, defaultHeaders: merged };
}

function requireProxyConfigFromRoutePlan(
  plan: DispatchableRoutePlan,
  proxyConfigOverride?: ProxyConfig | null,
): ProxyConfig {
  const proxyConfig = composeProxyConfigFromRoutePlan(plan, proxyConfigOverride);
  if (!proxyConfig?.baseURL) {
    throw createRoutePlanClientError(
      `Sub-agent route resolved to ${plan.decision.transport}, but the local model proxy is not available.`,
      'routing',
    );
  }
  return proxyConfig;
}

function findSelectableProfileForRoutePlan(settings: AppSettings, model: string): ModelProfile | null {
  const profiles = settings.localModel?.profiles;
  if (!profiles?.length) return null;
  if (isProfileReference(model)) {
    const profileId = profileReferenceId(model) ?? '';
    const byId = profiles.find((profile) => profile.id === profileId);
    if (!byId) return null;
    if (byId.enabled === false) return null;
    if (!isProfileSelectable(byId)) return null;
    return byId;
  }
  return profiles.find(
    (profile) => profile.model === model
      && profile.enabled !== false
      && isProfileSelectable(profile),
  ) ?? null;
}

function profileForRoutePlan(
  plan: DispatchableRoutePlan,
  settings: AppSettings,
  routeProfile: ModelProfile | null | undefined,
): ModelProfile {
  if (routeProfile && (!plan.decision.profileId || routeProfile.id === plan.decision.profileId)) {
    return routeProfile;
  }
  const profileById = plan.decision.profileId
    ? settings.localModel?.profiles?.find((profile) => profile.id === plan.decision.profileId)
    : null;
  if (profileById && profileById.enabled !== false && isProfileSelectable(profileById)) {
    return profileById;
  }
  const profileByModel = findSelectableProfileForRoutePlan(settings, plan.decision.wireModelId);
  if (profileByModel) return profileByModel;
  throw createRoutePlanClientError(
    `Sub-agent route resolved to model profile "${plan.decision.profileId ?? plan.decision.wireModelId}", but that profile is no longer available.`,
    'routing',
  );
}

/**
 * Create a ModelClient based on the active provider profile and proxy state.
 *
 * Throws a provider-aware auth error if the required credentials are missing.
 */
export function createModelClient(options: CreateModelClientOptions): ModelClient {
  const { settings, proxyConfig, profileOverride } = options;
  // Default to true unless explicitly disabled (kill switch or env override for eval A/B testing)
  const contextManagementEnabled = options.enableContextManagement !== false
    && process.env.REBEL_DISABLE_CONTEXT_MANAGEMENT !== '1';
  const compactEnabled = settings.experimental?.compactEnabled === true;

  // PRECEDENCE 1: proxyConfig present — executor injected proxy URL for
  // council/ad-hoc/tier routing. Always use AnthropicClient via proxy.
  // Proxy routes to Anthropic, so context_management is safe to include.
  if (proxyConfig?.baseURL) {
    // ── Provider-identity header detection ──────────────────────────
    // These headers are set by queryOptionsBuilder proxy env builders
    // and parsed by queryRouter.extractProxyConfig(). They indicate that
    // the local proxy handles auth injection, so we use a sentinel API key
    // instead of requiring a real Anthropic key.
    //
    // If you add a new proxy provider, you must:
    // 1. Add its identity header here (e.g., `isNewProxy`)
    // 2. Add it to the `proxyHandlesAuth` check below
    // 3. Ensure ALL proxy env builders in queryOptionsBuilder.ts re-emit
    //    this header (council/ad-hoc builders overwrite earlier headers)
    // 4. Add regression tests in clientFactory.test.ts
    //
    // See: docs-private/postmortems/260417_openrouter_adhoc_auth_failure_postmortem.md
    // ────────────────────────────────────────────────────────────────
    //
    // WS1b: when the caller already resolved a route decision (the modern
    // createClientFromRoutePlan path), READ the proxy provider-identity from the
    // SAME inputs `deriveHeaders` (providerRouteHeaders.ts) used to EMIT these
    // headers — the verdict (transport/dispatchPath) AND the runtime proxy-auth
    // presence — rather than re-sniffing the headers it produced. Mirroring
    // deriveHeaders' exact emit conditions makes this provably equivalent to the
    // old sniff:
    //   - codex/openrouter: deriveHeaders emits x-codex-turn/x-openrouter-turn
    //     UNCONDITIONALLY from `transport`, so transport alone suffices.
    //   - route-table: deriveHeaders only emits x-routed-turn-id/x-proxy-auth WHEN
    //     `proxyAuthToken` is present (appendProxyIdentityHeaders gate), and
    //     `proxyBaseURL` is set independently in materializePlanRuntime — so a
    //     route-table dispatch WITHOUT a proxy-auth token is a representable plan
    //     whose old sniff was FALSE. We therefore require BOTH the route-table
    //     dispatch AND the x-proxy-auth header (the observable proof the token was
    //     present), matching the old `!!x-routed-turn-id && !!x-proxy-auth` result
    //     exactly. (route-table dispatch only arises from
    //     `anthropic-compatible-local-proxy`; codex/openrouter always dispatch
    //     passthrough.)
    // Header-sniffing stays as the fallback for legacy callers with no decision
    // (the two legacy-precedence branches + external direct `createModelClient`).
    const decision = options.routeDecision;
    const isCodexProxy = decision
      ? decision.transport === 'codex-proxy'
      : proxyConfig.defaultHeaders?.['x-codex-turn'] === 'true';
    const isOpenRouterProxy = decision
      ? decision.transport === 'openrouter-proxy'
      : proxyConfig.defaultHeaders?.['x-openrouter-turn'] === 'true';
    const isRouteTableProxy = decision
      ? (isRouteTableDispatch(decision.dispatchPath)
        && !!proxyConfig.defaultHeaders?.['x-proxy-auth'])
      : (!!proxyConfig.defaultHeaders?.['x-routed-turn-id']
        && !!proxyConfig.defaultHeaders?.['x-proxy-auth']);
    const effectiveProviderLabel = options.providerLabel
      ?? (isOpenRouterProxy ? 'OpenRouter' : undefined)
      ?? (isCodexProxy ? 'ChatGPT Pro' : undefined);

    log.info({
      baseURL: proxyConfig.baseURL,
      isCodexProxy,
      isOpenRouterProxy,
      isRouteTableProxy,
      hasDefaultHeaders: !!proxyConfig.defaultHeaders,
      headerKeys: proxyConfig.defaultHeaders ? Object.keys(proxyConfig.defaultHeaders) : [],
      effectiveProviderLabel,
    }, '[CODEX-DIAG] PRECEDENCE 1: AnthropicClient via proxy');
    // Codex / OpenRouter turns route through proxy with their own auth injection —
    // no Anthropic key needed. Use a sentinel value because AnthropicClient constructor
    // rejects empty strings. The proxy intercepts all requests before they reach
    // Anthropic's servers, so this key never leaves the local machine.
    //
    // Council/ad-hoc route-table requests intentionally strip provider-identity
    // headers before client construction so the local proxy reads the
    // routed-model header instead of short-circuiting to provider passthrough.
    // The x-routed-turn-id + x-proxy-auth pair still proves the local proxy
    // owns route resolution and auth injection for this request.
    const proxyHandlesAuth = isCodexProxy || isOpenRouterProxy || isRouteTableProxy;
    // The local proxy is the auth boundary — it strips this sentinel and injects
    // the real upstream credential. See `src/core/rebelCore/proxyAuthContract.ts`.
    const auth = proxyHandlesAuth ? { apiKey: PROXY_HANDLES_AUTH_SENTINEL } : getAnthropicAuth(settings);
    diagLog({ site: 'clientFactory:precedence-1-proxy' }, {
      proxyHandlesAuth,
      isCodexProxy,
      isOpenRouterProxy,
      isRouteTableProxy,
      baseURL: proxyConfig.baseURL,
      effectiveProviderLabel,
      apiKeyFp: fingerprint(auth.apiKey),
      // Proxy-branch auth is { apiKey: 'proxy-handles-auth' } | { apiKey?: string };
      // neither shape carries an authToken, so this site is structurally <none>.
      authTokenFp: '<none>',
    });
    return new AnthropicClient({
      ...auth,
      baseURL: proxyConfig.baseURL,
      ...(proxyConfig.defaultHeaders ? { defaultHeaders: proxyConfig.defaultHeaders } : {}),
      enableContextManagement: contextManagementEnabled,
      enableCompact: compactEnabled,
      ...(effectiveProviderLabel ? { provider: effectiveProviderLabel } : {}),
      // Codex rate limits are subscription-tier-based — SDK retries just amplify
      // load on an already-rate-limited API. Disable SDK-level retries so 429s
      // surface immediately.
      ...(isCodexProxy ? { maxRetries: 0 } : {}),
    });
  }

  // When profileOverride is provided, skip getWorkingModelProfile() and use
  // the override directly. Used by the context overflow fallback path to route
  // through a specific fallback profile instead of the active working profile.
  const profile = profileOverride ?? getWorkingModelProfile(settings);

  // PRECEDENCE 2: No active profile — direct Anthropic API
  if (!profile) {
    log.debug('No active profile — using direct AnthropicClient');
    // F2 bypass guard (260604): this legacy direct-Anthropic branch resolves auth
    // via getAuthForDirectUse(), which is AUTH-SHAPE-ONLY — it ignores
    // `activeProvider` and so will happily dispatch a stale `claude.apiKey` even
    // when the user has switched to OpenRouter/Codex/Mindstone. That is the B1
    // raw-key-as-route shape (260419). The sanctioned modern path
    // (createClientForModel → resolveProviderRoutePlan → createClientFromRoutePlan)
    // never reaches here for non-direct providers; a caller that does has bypassed
    // the route-plan provenance. We do NOT change behaviour (no throw, no reroute)
    // to keep this zero-blast-radius for the many legitimate legacy direct-Anthropic
    // call sites — `isDirectAnthropicConfig` is silent for `activeProvider`
    // anthropic/undefined — but we surface a dev-warning so a NEW bypassing caller
    // is visible in logs rather than silently leaking the key.
    if (!isDirectAnthropicConfig(settings)) {
      log.warn({
        site: 'clientFactory:precedence-2-direct-anthropic',
        activeProvider: settings.activeProvider ?? '<unset>',
      }, '[clientFactory] direct-Anthropic bypass entered with a non-direct activeProvider; '
        + 'a stale Anthropic key may be dispatched for a proxied provider (B1 shape). '
        + 'Route this caller through createClientForModel/createClientFromRoutePlan instead.');
    }
    const auth = getAuthForDirectUse(settings);
    diagLog({ site: 'clientFactory:precedence-2-direct-anthropic' }, {
      authMethod: getAuthMethod(settings) ?? '<unset>',
      activeProvider: settings.activeProvider ?? '<unset>',
      apiKeyFp: fingerprint(auth.apiKey),
      authTokenFp: 'authToken' in auth ? fingerprint(auth.authToken) : '<none>',
      claudeApiKeyFp: fingerprint(getApiKey(settings)),
      claudeOauthFp: fingerprint(getOAuthToken(settings)),
    });
    if (!auth.apiKey) {
      const authError = new Error(
        'No model provider configured. Please add an API key or model profile in Settings.',
      ) as Error & { __agentErrorKind?: string };
      authError.__agentErrorKind = 'auth';
      throw authError;
    }
    return new AnthropicClient({
      ...auth,
      enableContextManagement: contextManagementEnabled,
      enableCompact: compactEnabled,
    });
  }

  // PRECEDENCE 3: Gemini (google) — route through proxy for thought signatures.
  // Underlying model is NOT Anthropic — do NOT enable context_management.
  if (profile.providerType === 'google') {
    log.debug({ profile: profile.name }, 'Gemini profile — using AnthropicClient via proxy (context_management disabled)');
    const auth = getAnthropicAuth(settings);
    return new AnthropicClient({
      ...auth,
      enableContextManagement: false,
      // Gemini traffic goes through the proxy which handles thought signatures.
      // The proxy URL should be set by the executor; if not, fall back to direct.
    });
  }

  // PRECEDENCE 4 & 5: OpenAI-compatible provider (cloud or local)
  return createOpenAIClientFromProfile(profile, settings);
}

/**
 * Get Anthropic auth credentials, throwing a provider-aware error if missing.
 */
/**
 * Create a direct AnthropicClient bypassing profile-based routing.
 * Used by alt-model fallback when Claude model needs to go directly to Anthropic
 * even when an OpenAI-compatible profile is active.
 *
 * R2 (plan 260422): accepts an optional `model` parameter and asserts that it
 * is a native Anthropic ID (no slash). If an OR-dialect ID leaks through the
 * routing resolver (e.g. `anthropic/claude-opus-4.7`), we fail loudly with a
 * classified routing error rather than silently 404ing against Anthropic's
 * native endpoint. The assertion is the structural lock-in for the class of
 * bug originally tracked in plan 260419.
 */
function createDirectAnthropicClient(
  settings: AppSettings,
  options?: { enableContextManagement?: boolean; model?: string },
): AnthropicClient {
  if (options?.model && options.model.includes('/')) {
    // R2 (plan 260422) + F2 (plan 260422_routing_followups_mock_and_kind):
    // classify as 'routing' — now a first-class AgentErrorKind with dedicated
    // humanizer copy. The `__routingCause` side-channel carries the sub-cause
    // for logs/telemetry; downstream classifiers (getErrorKind, humanizer)
    // recognise the kind natively.
    const routingError = new Error(
      `createDirectAnthropicClient received non-native model ID "${options.model}" — expected an Anthropic-format ID (no slash). ` +
      'This indicates a routing bug: a proxy-dialect model string reached the direct-Anthropic client. ' +
      'Please report with your Settings → Models config.',
    ) as Error & { __agentErrorKind?: string; __routingCause?: string };
    routingError.__agentErrorKind = 'routing';
    routingError.__routingCause = 'proxy-dialect-in-direct-anthropic';
    throw routingError;
  }
  const auth = getAnthropicAuth(settings);
  return new AnthropicClient({
    ...auth,
    enableContextManagement: options?.enableContextManagement !== false
      && process.env.REBEL_DISABLE_CONTEXT_MANAGEMENT !== '1',
    enableCompact: settings.experimental?.compactEnabled === true,
  });
}

/**
 * Create a ModelClient directly from the provider route plan.
 *
 * This is the plan-backed strangler path for sub-agents: transport stays the
 * executable discriminator, while each arm still delegates to the same client
 * construction primitives used by the public model-client factories.
 */
export function createClientFromRoutePlan(
  plan: DispatchableRoutePlan,
  settings: AppSettings,
  options: CreateClientFromRoutePlanOptions = {},
): ModelClient {
  // Route-IDENTITY headers always come from the FRESH plan; only the override's
  // transport (baseURL) is reused. See `composeProxyConfigFromRoutePlan` — a
  // wholesale-override return here would replay a prior plan's
  // `x-route-id`/`x-route-facts` and flip billing mode on an in-turn reroute.
  const routeTableProxyConfig = composeProxyConfigFromRoutePlan(plan, options.proxyConfigOverride);
  if (isRouteTableDispatch(plan.decision.dispatchPath) && routeTableProxyConfig?.baseURL) {
    // Pass the verdict so PRECEDENCE 1 reads proxy provider-identity from the
    // decision instead of re-sniffing the (intentionally provider-identity-stripped)
    // route-table headers.
    return createModelClient({ settings, proxyConfig: routeTableProxyConfig, routeDecision: plan.decision });
  }

  // Stage 3 class-killer (memory-BTS route mismatch / REBEL-5N8): at this single
  // client-build seam — AFTER the route-table early-return above (route-table
  // legitimately carries an alias body with the slash backend in x-routed-model) —
  // fail LOUD if a non-passthrough Anthropic transport (codex-proxy /
  // anthropic-compatible-local-proxy / anthropic-direct) would be paired with a
  // slash-namespaced BODY model. This makes the invalid {non-passthrough client ×
  // slash body} state unreachable from EVERY dispatch door (top-level turns, BTS,
  // sub-agents), throwing a CLASSIFIED routing error here instead of the confusing
  // `invalid_request` the wire guard (anthropicClient.ts:802) would throw. The
  // wire guard stays as the last-ditch defense; openrouter-proxy (passthrough) is
  // intentionally exempt.
  const slashBodyError = nonPassthroughAnthropicSlashBodyError(
    plan.decision.transport,
    plan.decision.wireModelId,
    { door: 'createClientFromRoutePlan' },
  );
  if (slashBodyError) throw slashBodyError;

  const transport = plan.decision.transport;
  switch (transport) {
    case 'anthropic-direct':
      return createDirectAnthropicClient(settings, { model: plan.decision.wireModelId });
    case 'anthropic-compatible-local-proxy':
    case 'codex-proxy':
    case 'openrouter-proxy':
      return createModelClient({
        settings,
        proxyConfig: requireProxyConfigFromRoutePlan(plan, options.proxyConfigOverride),
        // PRECEDENCE 1 reads proxy provider-identity from this verdict rather than
        // re-deriving it from the proxy headers (WS1b consolidation).
        routeDecision: plan.decision,
      });
    case 'openai-compatible-http':
    case 'local-openai-compatible-http':
      return createOpenAIClientFromProfile(
        profileForRoutePlan(plan, settings, options.routeProfile),
        settings,
        options.codexMode,
      );
    default:
      // Runtime-impossible transport (dispatchable-narrow breach): capture the
      // route-invariant breach telemetry BEFORE failing closed, preserving the
      // instrumentation that previously lived in agentTool's sub-agent switch.
      // Centralizing it here means every createClientFromRoutePlan caller (not
      // just sub-agents) gets the breach capture.
      captureRouteInvariantBreach(
        plan.decision,
        'Impossible state: dispatchable narrow breached in plan-backed client construction',
      );
      return assertNever(transport, 'DispatchableTransport');
  }
}

function codexAuthProviderFromMode(codexMode: CodexModeConfig | undefined): ProviderRouteRuntimeContext['codexAuthProvider'] {
  if (!codexMode) return null;
  return {
    isConnected: codexMode.isConnected ?? (() => true),
    getAccessToken: codexMode.getAccessToken,
    getAccountId: codexMode.getAccountId,
    forceRefreshToken: codexMode.forceRefreshToken,
    getStatus: () => ({ connected: codexMode.isConnected?.() ?? true }),
  };
}

function routeProfileForRuntime(options: CreateClientForModelOptions): ModelProfile | null {
  return options.profile ?? resolveProfileFromModelString(options.model, options.settings);
}

function runtimeContextForCreateClientForModel(options: CreateClientForModelOptions): ProviderRouteRuntimeContext {
  const proxyHeaders = options.proxyConfig?.defaultHeaders;
  const routeProfile = routeProfileForRuntime(options);
  return {
    proxyBaseURL: options.proxyConfig?.baseURL ?? null,
    proxyAuthToken: proxyHeaders?.['x-proxy-auth'] ?? null,
    routedModel: proxyHeaders?.['x-routed-model'] ?? null,
    anthropicApiKey: getApiKey(options.settings),
    anthropicOAuthToken: getOAuthToken(options.settings),
    openRouterOAuthToken: options.settings.openRouter?.oauthToken ?? null,
    profileApiKey: routeProfile
      ? resolveProfileApiKey(routeProfile, options.settings.providerKeys, options.settings.customProviders)
      : null,
    endpointBaseURL: routeProfile?.serverUrl ?? null,
    codexAuthProvider: codexAuthProviderFromMode(options.codexMode),
  };
}

function throwTerminalRoutePlanForCreateClient(plan: TerminalRoutePlan): never {
  if (plan.decision.invalidReason === 'proxy-dialect-in-direct-anthropic') {
    const routingError = new Error(
      `createClientForModel resolved non-native model ID "${plan.decision.wireModelId}" for direct Anthropic routing. ` +
      'This indicates a routing bug: a proxy-dialect model string reached the direct-Anthropic client. ' +
      'Please report with your Settings → Models config.',
    ) as Error & { __agentErrorKind?: string; __routingCause?: string };
    routingError.__agentErrorKind = 'routing';
    routingError.__routingCause = 'proxy-dialect-in-direct-anthropic';
    throw routingError;
  }

  // FOX-3494: recoverable terminal reasons (incl. the primary-turn claude-* model
  // under connected ChatGPT Pro with no Anthropic key, which stays a
  // ConnectionNotConfiguredError carrying wire model + role so the renderer can
  // lead with "switch to a GPT model") go through the single shared mapper so all
  // producers agree on the class + structured detail.
  throw buildRecoverableTerminalRouteError(plan.decision);
}

function shouldReuseCallerProxyConfig(plan: DispatchableRoutePlan, proxyConfig: ProxyConfig | null | undefined): boolean {
  if (!proxyConfig?.baseURL) return false;
  if (plan.decision.transport === 'codex-proxy') return false;
  return plan.proxyRequired;
}

/**
 * Historical turn-router precedence: a caller-supplied
 * proxyConfig + no explicit profile + a Claude-ish model IS itself the routing decision —
 * route through the local proxy. This MUST run BEFORE the route-plan resolver, because the
 * resolver takes no proxyConfig and classifies a bare `anthropic/claude-*` as a
 * `proxy-dialect-in-direct-anthropic` terminal (the intentional 260529 fail-closed guard),
 * which would throw before any post-plan bridge could recover the normal OpenRouter-Claude
 * turn-router flow (e.g. `x-openrouter-turn` turns reaching rebelCoreQuery site 679 with
 * proxyConfig + no profile). `x-openrouter-turn` preserves the `anthropic/...` wire model
 * through the proxy; non-OpenRouter proxy paths still strip at the AnthropicClient wire
 * boundary. Codex turns (`x-codex-turn`) are excluded — they route via the resolver's codex
 * path. Returns null when the legacy precedence does not apply (fall through to the resolver).
 */
function tryCreateLegacyTurnRouterClaudeProxyClient(options: CreateClientForModelOptions): ModelClient | null {
  if (!options.proxyConfig?.baseURL) return null;
  if (options.profile) return null;
  if (options.proxyConfig.defaultHeaders?.['x-codex-turn'] === 'true') return null;
  // "Claude-ish" = bare `claude-*` OR `anthropic/claude-*`. This is exactly the
  // `native-claude` arm of the canonical direct-Anthropic chokepoint
  // (`resolveDirectAnthropicModel`): both bare `claude-*` and the `anthropic/`
  // self-prefixed form resolve to `native-claude`; foreign/non-Claude ids do not.
  //
  // INTENTIONAL STRICTER BEHAVIOUR vs the deleted `stripAnthropicPrefix` (WS0 stage 4):
  // a malformed NESTED slash id like `anthropic/claude-x/y` was previously ACCEPTED
  // as Claude (old helper sliced `anthropic/` and returned the still-slashed remainder),
  // but the chokepoint REJECTS it — after stripping one `anthropic/`, the remainder
  // `claude-x/y` still contains `/`, so `isNativeClaude` is false (→ `bare-non-claude`).
  // Unreachable for real Anthropic model ids (none carry a second slash); documented
  // so the tighter result is not mistaken for a regression.
  if (resolveDirectAnthropicModel(options.model).kind !== 'native-claude') return null;
  return createModelClient({ settings: options.settings, proxyConfig: options.proxyConfig });
}

function createLegacyMissingProxyGoogleClient(
  options: CreateClientForModelOptions,
  plan: DispatchableRoutePlan,
): ModelClient | null {
  if (plan.decision.transport !== 'anthropic-compatible-local-proxy') return null;
  if (plan.proxyBaseURL) return null;
  const routeProfile = routeProfileForRuntime(options);
  if (routeProfile?.providerType !== 'google') return null;
  return createModelClient({
    settings: options.settings,
    proxyConfig: options.proxyConfig ?? {},
    profileOverride: routeProfile,
  });
}

/**
 * Create a ModelClient matched to a specific model, optionally with a direct profile.
 *
 * Thin wrapper around the route-plan resolver + createClientFromRoutePlan().
 * Used for sub-agents, planning phase, and BTS where the model may differ
 * from the parent's active profile.
 */
export async function createClientForModel(options: CreateClientForModelOptions): Promise<ModelClient> {
  const { context } = options;
  // Legacy turn-router precedence runs BEFORE the resolver (see fn doc): a caller-supplied
  // proxy + no explicit profile + Claude-ish model routes through the proxy. Preserves the
  // normal OpenRouter-Claude (`x-openrouter-turn`) passthrough the resolver would otherwise
  // reject as a proxy-dialect-in-direct-anthropic terminal.
  const turnRouterClient = tryCreateLegacyTurnRouterClaudeProxyClient(options);
  if (turnRouterClient) return turnRouterClient;
  const role = context === 'planning' ? 'planning' : 'execution';
  // Faithfully reproduce the legacy resolver's profile resolution: legacy did
  // `profile ?? resolveProfileFromModelString(model, settings)`, matching a bare
  // model string to a configured profile by its `.model` field. The route-plan
  // resolver's own `resolveProfile` only handles `profile:<id>` references + the
  // working profile, so a bare non-Claude model string that matches a profile by
  // model-field would otherwise misroute to default/Anthropic. Pass the resolved
  // profile in explicitly so profileDecision routes by it.
  const routeProfile = routeProfileForRuntime(options);
  const request: ProviderRoutePlanRequest = {
    kind: 'forTurn',
    input: {
      model: options.model,
      profile: routeProfile,
      settings: options.settings,
      routeScope: 'normal-turn',
      codexConnectivity: options.codexMode ? 'connected' : 'unknown',
      role,
    },
  };
  const plan = await resolveProviderRoutePlan(request, runtimeContextForCreateClientForModel(options));
  log.debug({
    model: plan.decision.wireModelId,
    context,
    transport: plan.decision.transport,
    resolvedFrom: plan.decision.resolvedFrom,
  }, 'createClientForModel: resolved route plan');
  if (isTerminalRoutePlan(plan)) {
    throwTerminalRoutePlanForCreateClient(plan);
  }
  const legacyGoogleClient = createLegacyMissingProxyGoogleClient(options, plan);
  if (legacyGoogleClient) return legacyGoogleClient;
  return createClientFromRoutePlan(plan, options.settings, {
    codexMode: options.codexMode,
    routeProfile,
    proxyConfigOverride: shouldReuseCallerProxyConfig(plan, options.proxyConfig)
      ? options.proxyConfig
      : null,
  });
}

/**
 * Create an OpenAIClient from a model profile's configuration.
 * Extracted from PRECEDENCE 4/5 in createModelClient() for reuse.
 *
 * When codexMode is provided for a Codex subscription profile, routes through
 * the Codex Responses endpoint (ChatGPT subscription) instead of consuming a
 * shared OpenAI API key. This keeps the core boundary clean — Codex auth
 * callbacks are injected by the caller (executor) rather than imported directly.
 *
 * Throws a provider-aware auth error if the profile requires an API key
 * that isn't configured and codexMode is not available.
 */
export function createOpenAIClientFromProfile(
  profile: ModelProfile,
  settings: AppSettings,
  codexMode?: CodexModeConfig,
): OpenAIClient {
  // By-construction guard (defense-in-depth): an Anthropic profile must NEVER build an OpenAI
  // client. Anthropic always dispatches anthropic-direct (`createDirectAnthropicClient`), so any
  // Anthropic profile reaching here is a routing bug — and projecting an Anthropic credential
  // (especially the `anthropic-oauth-token`) as an OpenAI-style bearer would be a wrong-protocol
  // credential leak. Fail closed before resolving any credential. See the E2b edge-(a) pin in
  // providerRouting.profileCredentialMatrix.test.ts.
  if (profile.providerType === 'anthropic') {
    const guardError = new Error(
      'Anthropic profiles dispatch direct and must not build an OpenAI client (createOpenAIClientFromProfile).',
    ) as Error & { __agentErrorKind?: string };
    guardError.__agentErrorKind = 'routing';
    throw guardError;
  }

  const credentials = resolveConnectionCredentials(profile, settings, codexMode);
  const apiKey = credentials.apiKey ?? credentials.oauthToken
    ?? resolveProfileApiKey(profile, settings.providerKeys, settings.customProviders);
  const isCodexSubscription = isCodexSubscriptionProfile(profile);
  const providerType = profile.providerType ?? 'other';
  const isLocal = isLocalhostUrl(profile.serverUrl);

  // Codex OAuth fallback: OpenAI profiles without an API key can route through
  // the Codex Responses endpoint using the user's ChatGPT subscription.
  if (!isLocal && providerType === 'openai' && credentials.sessionMode === 'codex' && isCodexSubscription) {
    log.debug(
      { profile: profile.name, providerType },
      'Using OpenAIClient in Codex mode (ChatGPT subscription)',
    );
    return new OpenAIClient({
      provider: 'OpenAI (Codex)',
      providerType: 'openai',
      codexMode,
      // Honour the suppression gate even in Codex mode: a codex-subscription profile
      // marked `thinkingCompatibility:'incompatible'` must not emit reasoning_effort.
      // See docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md (REBEL-5RJ).
      ...(shouldSuppressProfileReasoning(profile) ? { suppressReasoningEffort: true } : {}),
    });
  }

  if (!apiKey && !isLocal) {
    const providerName = getProviderDisplayName(providerType);
    const authError = new Error(
      `${providerName} requires an API key. Please add one in Settings → Models.`,
    ) as Error & { __agentErrorKind?: string };
    authError.__agentErrorKind = 'auth';
    throw authError;
  }

  log.debug(
    { profile: profile.name, providerType, isLocal },
    'Using OpenAIClient for provider',
  );

  return new OpenAIClient({
    provider: getProviderDisplayName(providerType),
    providerType: normalizeToOpenAIProviderType(providerType),
    baseURL: profile.serverUrl,
    ...(apiKey ? { apiKey } : {}),
    // Never send reasoning params to this provider when the profile is marked
    // thinking-incompatible (`thinkingCompatibility === 'incompatible'`, auto-detected
    // by the Test button) — e.g. a gateway that mistranslates reasoning_effort into a
    // thinking format the model rejects (Sentry REBEL-5RJ). See
    // docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md.
    ...(shouldSuppressProfileReasoning(profile) ? { suppressReasoningEffort: true } : {}),
  });
}

/**
 * Resolve a profile from a model string.
 * Handles 'profile:abc123' encoding (extract profile ID and look up)
 * and falls back to matching on the profile's model field.
 */
export function resolveProfileFromModelString(model: string, settings: AppSettings): ModelProfile | null {
  const profiles = settings.localModel?.profiles;
  if (!profiles?.length) return null;

  // Primary: profile:<id> encoding (e.g., from resolveBtsModel)
  if (isProfileReference(model)) {
    const profileId = profileReferenceId(model) ?? '';
    return profiles.find(p => p.id === profileId) ?? null;
  }

  // Secondary: match on profile.model field (less reliable — first enabled match wins)
  return profiles.find(p => p.model === model && p.enabled !== false) ?? null;
}

function getAnthropicAuth(settings: AppSettings): { apiKey?: string } {
  const auth = getAuthForDirectUse(settings);
  if (!auth.apiKey) {
    const authError = new Error(
      'Rebel needs an Anthropic API key. Please add one in Settings.',
    ) as Error & { __agentErrorKind?: string };
    authError.__agentErrorKind = 'auth';
    throw authError;
  }
  return auth;
}

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function getProviderDisplayName(providerType: string): string {
  switch (providerType) {
    case 'openai': return 'OpenAI';
    case 'google': return 'Google Gemini';
    case 'together': return 'Together';
    case 'cerebras': return 'Cerebras';
    case 'openrouter': return 'OpenRouter';
    default: return 'Your model provider';
  }
}
