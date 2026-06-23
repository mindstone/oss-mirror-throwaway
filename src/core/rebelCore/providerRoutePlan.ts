import type { CodexAuthProvider } from '@core/codexAuth';
import { createScopedLogger } from '@core/logger';
import type { WireModelId } from '@shared/utils/wireModelId';
import { deriveAuthPlan, deriveResolvedAuthLabel, withRuntimeAuth } from './providerAuthPlan';
import type { ResolvedAuthLabel } from './providerAuthPlanTypes';
import { deriveHeaders, headerNames, type ProviderRouteHeaderRuntimeContext } from './providerRouteHeaders';
import { assertNever, isProxyDispatch, type DispatchPath, type ProviderRouteDecision } from './providerRouteDecision';
import type { DispatchableRoutePlan, ProviderRoutePlan, TerminalRoutePlan } from './providerRoutePlanTypes';

export type { DispatchableRoutePlan, ProviderRoutePlan };

const log = createScopedLogger({ service: 'providerRouting' });

export interface ProviderRouteRuntimeContext extends ProviderRouteHeaderRuntimeContext {
  proxyBaseURL?: string | null;
  endpointBaseURL?: string | null;
  anthropicOAuthToken?: string | null;
  openRouterOAuthToken?: string | null;
  profileApiKey?: string | null;
  codexAuthProvider?: CodexAuthProvider | null;
  processEnv?: Record<string, string>;
}

export interface ProviderRouteLogEvent {
  turnId: string | null;
  role: ProviderRouteDecision['role'];
  routeScope: ProviderRouteDecision['routeScope'];
  kind: ProviderRouteDecision['kind'];
  provider: ProviderRouteDecision['provider'];
  transport: ProviderRouteDecision['transport'];
  dispatchPath: DispatchPath;
  modelDialect: ProviderRouteDecision['modelDialect'];
  /**
   * The model the turn REQUESTED (canonical id), distinct from `wireModelId` (the
   * RESOLVED wire model). Stage 5 routing observability: surfaces requested →
   * resolved so a remap/divert/fallback is legible in the log.
   */
  canonicalModelId: string;
  wireModelId: WireModelId;
  resolvedAuthLabel: ResolvedAuthLabel;
  /**
   * The resolved-route credential identity (Stage 5). The billing identity of a
   * turn is read off this: `mindstone-managed-key`/`codex-subscription` are
   * subscription routes; `anthropic-*`/`openrouter-oauth-token`/`*-api-key` are
   * own-credential (paid) routes. This is what makes a paid-route FALLBACK
   * visible — the safeguard for the auto/no-cap paid-fallback policy (PLAN §8 #3).
   */
  credentialSource: ProviderRouteDecision['credentialSource'];
  /**
   * Provenance-only "who pays" axis derived from `credentialSource` (WS1a #1):
   * `subscription` / `pool` (credits) / `pay-per-use` / `local`, or `null` for
   * terminal/missing routes. Distinct from `credentialSource` (the credential
   * channel) — see `billingSourceForCredentialSource`. Makes a paid-vs-subscription
   * fallback legible in the trace without re-deriving billing downstream.
   */
  billingSource: ProviderRouteDecision['billingSource'];
  /** WHY this route was chosen (settings / explicit-profile / working-profile / …). */
  resolvedFrom: ProviderRouteDecision['resolvedFrom'];
  codexConnectivity: ProviderRouteDecision['codexConnectivity'];
  profileId: string | null;
  fallbackHint: ProviderRouteDecision['fallbackHint'];
  headerNames: ReadonlyArray<string>;
  proxyRequired: boolean;
  invalidReason: string | null;
}

function proxyRequired(decision: ProviderRouteDecision): boolean {
  return isProxyDispatch(decision.dispatchPath);
}

function endpointForDecision(
  decision: ProviderRouteDecision,
  runtimeContext: ProviderRouteRuntimeContext,
): { baseURL: string } | undefined {
  const transport = decision.transport;
  switch (transport) {
    case 'openai-compatible-http':
    case 'local-openai-compatible-http':
      return runtimeContext.endpointBaseURL ? { baseURL: runtimeContext.endpointBaseURL } : undefined;
    case 'anthropic-direct':
    case 'anthropic-compatible-local-proxy':
    case 'codex-proxy':
    case 'openrouter-proxy':
    case 'no-credentials':
    case 'fail-closed-codex-disconnected':
      return undefined;
    default:
      return assertNever(transport, 'ProviderRouteTransport');
  }
}

async function resolveCodexRuntimeAuth(runtimeContext: ProviderRouteRuntimeContext): Promise<{
  codexAccessToken: string | null;
  codexAccountId: string | null;
}> {
  const provider = runtimeContext.codexAuthProvider;
  if (!provider) {
    return { codexAccessToken: null, codexAccountId: null };
  }
  return {
    codexAccessToken: await provider.getAccessToken(),
    codexAccountId: provider.getAccountId(),
  };
}

function logPlan(plan: ProviderRoutePlan, runtimeContext: ProviderRouteRuntimeContext): void {
  const event: ProviderRouteLogEvent = {
    turnId: runtimeContext.turnId ?? null,
    role: plan.decision.role,
    routeScope: plan.decision.routeScope,
    kind: plan.decision.kind,
    provider: plan.decision.provider,
    transport: plan.decision.transport,
    dispatchPath: plan.decision.dispatchPath,
    modelDialect: plan.decision.modelDialect,
    canonicalModelId: plan.decision.canonicalModelId,
    wireModelId: plan.decision.wireModelId,
    resolvedAuthLabel: plan.resolvedAuthLabel,
    credentialSource: plan.decision.credentialSource,
    billingSource: plan.decision.billingSource ?? null,
    resolvedFrom: plan.decision.resolvedFrom,
    codexConnectivity: plan.decision.codexConnectivity,
    profileId: plan.decision.profileId,
    fallbackHint: plan.decision.fallbackHint,
    headerNames: headerNames(plan.headers),
    proxyRequired: plan.proxyRequired,
    invalidReason: plan.invalidReason,
  };
  if (runtimeContext.logLevel === 'debug') {
    log.debug(event, '[ROUTER] provider route plan resolved');
    return;
  }
  log.info(event, '[ROUTER] provider route plan resolved');
}

export async function materializePlanRuntime(
  decision: ProviderRouteDecision,
  runtimeContext: ProviderRouteRuntimeContext = {},
): Promise<ProviderRoutePlan> {
  const codexAuth = decision.credentialSource === 'codex-subscription'
    ? await resolveCodexRuntimeAuth(runtimeContext)
    : { codexAccessToken: null, codexAccountId: null };
  const baseAuth = deriveAuthPlan(decision);
  const auth = withRuntimeAuth(baseAuth, {
    anthropicApiKey: runtimeContext.anthropicApiKey,
    anthropicOAuthToken: runtimeContext.anthropicOAuthToken,
    openRouterOAuthToken: runtimeContext.openRouterOAuthToken ?? runtimeContext.openRouterApiKey,
    openAIApiKey: runtimeContext.openAIApiKey,
    profileApiKey: runtimeContext.profileApiKey,
    codexAccessToken: codexAuth.codexAccessToken,
    codexAccountId: codexAuth.codexAccountId,
  });
  const headers = deriveHeaders(decision, {
    turnId: runtimeContext.turnId,
    agentId: runtimeContext.agentId,
    routedModel: runtimeContext.routedModel ?? decision.routedModel ?? null,
    logLevel: runtimeContext.logLevel,
    proxyAuthToken: runtimeContext.proxyAuthToken,
    anthropicApiKey: runtimeContext.anthropicApiKey,
    openAIApiKey: runtimeContext.openAIApiKey ?? runtimeContext.profileApiKey,
    openRouterApiKey: runtimeContext.openRouterApiKey ?? runtimeContext.openRouterOAuthToken,
    codexAccessToken: codexAuth.codexAccessToken,
    includeStructuredOutputBeta: runtimeContext.includeStructuredOutputBeta,
  });
  const endpoint = endpointForDecision(decision, runtimeContext);
  const basePlan = {
    auth,
    headers,
    proxyBaseURL: runtimeContext.proxyBaseURL ?? null,
    ...(endpoint ? { endpoint } : {}),
    resolvedAuthLabel: deriveResolvedAuthLabel(auth),
    proxyRequired: proxyRequired(decision),
  };
  if (decision.kind === 'terminal') {
    const terminalPlan: TerminalRoutePlan = {
      ...basePlan,
      decision,
      invalidReason: decision.invalidReason,
    };
    logPlan(terminalPlan, runtimeContext);
    return terminalPlan;
  }

  const dispatchablePlan: DispatchableRoutePlan = {
    ...basePlan,
    decision,
    invalidReason: null,
  };
  logPlan(dispatchablePlan, runtimeContext);
  return dispatchablePlan;
}
