import { createScopedLogger } from '@core/logger';
import {
  assertNever,
  assertRouteTableRuntimeContext,
  isProxyDispatch,
  isRouteTableDispatch,
  type ProviderRouteDecision,
  type ProviderRouteHeaderTuples,
} from './providerRouteDecision';
import { computeRouteTag, signRouteFacts, type RouteTagFacts } from './providerRouteTag';

export interface ProviderRouteHeaderRuntimeContext {
  turnId?: string | null;
  agentId?: string | null;
  routedModel?: string | null;
  logLevel?: 'info' | 'debug';
  proxyAuthToken?: string | null;
  anthropicApiKey?: string | null;
  openAIApiKey?: string | null;
  openRouterApiKey?: string | null;
  codexAccessToken?: string | null;
  includeStructuredOutputBeta?: boolean;
}

const log = createScopedLogger({ service: 'providerRouteHeaders' });

/**
 * Canonical OpenRouter app-attribution (sent as `http-referer` / `x-title` on
 * managed/proxy OpenRouter egress for the openrouter.ai/apps leaderboard). SSOT
 * so the route-plan path (here) and the local-proxy passthrough
 * (`localModelProxyServer.ts`) can't drift — they once disagreed, with the proxy
 * sending `https://mindstone.app` (a domain we DO NOT own) instead of the real
 * `https://rebel.mindstone.com`. See PM 260601 + boundary seam
 * `managed-traffic-zdr-proxy-precedence`.
 */
export const OPENROUTER_ATTRIBUTION_REFERER = 'https://rebel.mindstone.com';
export const OPENROUTER_ATTRIBUTION_TITLE = 'Rebel';

/**
 * WS1b-2 proxy integrity-gate header names (executor → in-process proxy).
 *
 * - `x-route-tag` — the opaque SHA-256 digest from `computeRouteTag` over the full
 *   `RouteTagFacts`. The proxy CANNOT reconstruct all 8 facts (it lacks
 *   role/profileId/credentialSource/billingSource), so it uses this only as a
 *   LOUD divergence DETECTOR (telemetry), never to fail-closed.
 * - `x-route-id` — the identity anchor (`routeId`), emitted on EVERY proxy path
 *   (route-table dispatch already has `x-routed-turn-id`, but passthrough does not),
 *   so the proxy can correlate the tag to a turn/route on all ingress classes.
 * - `x-route-wire-model` — the executor-minted plaintext witness of the RESOLVED
 *   wire model the request body's `model` must equal. This is the ONLY fail-closed
 *   signal: a `body.model` ≠ `x-route-wire-model` is a genuine correctness violation
 *   with no legitimate cause. NOT tamper-proof (the proxy can't recompute the digest
 *   to bind the plaintext), but this is an AUTHENTICATED localhost boundary
 *   (`x-proxy-auth` is required before dispatch), not a crypto-adversarial one.
 *
 * All THREE are additive and internal — added to the proxy passthrough-blocklist so
 * they never leak to an upstream API. See `localModelProxyServer.ts`.
 */
export const ROUTE_TAG_HEADER = 'x-route-tag';
export const ROUTE_ID_HEADER = 'x-route-id';
export const ROUTE_WIRE_MODEL_HEADER = 'x-route-wire-model';

/**
 * WS4a signed fact-CARRIER header (executor → in-process proxy).
 *
 * Unlike the three WS1b-2 headers above (which let the proxy DETECT divergence but
 * not reconstruct the decision), `x-route-facts` TRANSPORTS the full `RouteTagFacts`
 * as an HMAC-signed payload keyed on the shared `x-proxy-auth` secret. WS4b will have
 * the proxy verify + DECODE this (`verifyRouteFacts`) and TRUST the facts instead of
 * re-deriving provider/credential/transport from loose wire headers. In WS4a it is
 * ADDITIVE and UNCONSUMED — emitted, blocklisted from upstream, and tested, but the
 * proxy gate stays telemetry-only.
 *
 * Emitted ONLY when a `proxyAuthToken` is available (the HMAC key IS that token);
 * this is the SAME availability condition as `x-proxy-auth` itself, which every
 * proxy-dispatch egress already carries (the proxy rejects un-authed requests before
 * any header is read). Like the other three, it is added to the proxy
 * passthrough-blocklist so it never leaks upstream. See `localModelProxyServer.ts`.
 */
export const ROUTE_FACTS_HEADER = 'x-route-facts';

/**
 * Turn-router DISPATCH-MARKER header NAMES. `x-codex-turn` / `x-openrouter-turn`
 * select WHICH proxy passthrough handler runs; they are dispatch markers, NOT a
 * routing-class re-derivation (the decision itself flows through ProviderRoutePlan).
 *
 * Centralised here as the SINGLE source for these names so consumers reference the
 * constant instead of re-typing the literal — the `provider-routing-class-central-resolver`
 * boundary rule forbids the bare literals to prevent imperative routing-class drift.
 * The two definition lines below are the one sanctioned site for the literal.
 */
export const CODEX_TURN_HEADER = 'x-codex-turn'; // boundary-allow: provider-routing-class-central-resolver — canonical header-name constant; the single sanctioned site for this literal so consumers reference the constant
export const OPENROUTER_TURN_HEADER = 'x-openrouter-turn'; // boundary-allow: provider-routing-class-central-resolver — canonical header-name constant; the single sanctioned site for this literal so consumers reference the constant

const compareHeaderNames = (left: string, right: string): number => {
  if (left === right) return 0;
  if (left === 'x-routed-turn-id' && right === 'x-proxy-auth') return -1;
  if (left === 'x-proxy-auth' && right === 'x-routed-turn-id') return 1;
  return left.localeCompare(right);
};

function sortedHeaders(headers: ProviderRouteHeaderTuples): ProviderRouteHeaderTuples {
  return [...headers].sort(([left], [right]) => compareHeaderNames(left, right));
}

const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]+$/;

export class InvalidRoutedModelHeaderError extends Error {
  readonly headerName = 'x-routed-model';
  readonly reason = 'non-printable-ascii';
  readonly value: string;

  constructor(value: string) {
    super('Invalid x-routed-model header value: must contain printable ASCII only');
    this.name = 'InvalidRoutedModelHeaderError';
    this.value = value;
  }
}

function validateRoutedModelHeaderValue(value: string): void {
  if (!PRINTABLE_ASCII_PATTERN.test(value)) {
    throw new InvalidRoutedModelHeaderError(value);
  }
}

/** Producer+consumer gate: route decisions are discriminated by `kind`, while proxy identity headers key off `dispatchPath`; proxy dispatch requires proxyAuthToken, and route-table dispatch additionally requires non-empty turn/routed-model runtime context. */
export function appendProxyIdentityHeaders(
  decision: ProviderRouteDecision,
  runtimeCtx: ProviderRouteHeaderRuntimeContext,
): ProviderRouteHeaderTuples {
  const headers: Array<readonly [string, string]> = [];
  if (isProxyDispatch(decision.dispatchPath) && runtimeCtx.proxyAuthToken) {
    let routeTablePlan: { decision: ProviderRouteDecision; runtimeCtx: ProviderRouteHeaderRuntimeContext } | null = null;
    if (isRouteTableDispatch(decision.dispatchPath)) {
      routeTablePlan = { decision, runtimeCtx };
      assertRouteTableRuntimeContext(routeTablePlan);
    }
    headers.push(['x-proxy-auth', runtimeCtx.proxyAuthToken]);
    if (routeTablePlan) {
      headers.push(['x-routed-turn-id', routeTablePlan.runtimeCtx.turnId]);
      validateRoutedModelHeaderValue(routeTablePlan.runtimeCtx.routedModel);
      headers.push(['x-routed-model', routeTablePlan.runtimeCtx.routedModel]);
    }
  }
  const transport = decision.transport;
  switch (transport) {
    case 'codex-proxy':
      headers.push(['x-codex-turn', 'true']);
      break;
    case 'openrouter-proxy':
      headers.push(['x-openrouter-turn', 'true']);
      break;
    case 'anthropic-compatible-local-proxy':
    case 'anthropic-direct':
    case 'openai-compatible-http':
    case 'local-openai-compatible-http':
    case 'no-credentials':
    case 'fail-closed-codex-disconnected':
      break;
    default:
      return assertNever(transport, 'ProviderRouteTransport');
  }
  const transportHeaders = sortedHeaders(headers);
  if (runtimeCtx.logLevel === 'debug') {
    log.debug(
      {
        turnId: runtimeCtx.turnId ?? null,
        agentId: runtimeCtx.agentId ?? null,
        routedModel: runtimeCtx.routedModel ?? null,
        transportHeaders,
      },
      'appendProxyIdentityHeaders: transport headers resolved',
    );
  }
  return transportHeaders;
}

/**
 * Build the `RouteTagFacts` from a route decision + the routeId anchor. The proxy
 * verifies the resulting tag against its own re-derived facts (divergence telemetry)
 * and the plaintext wire-model witness (fail-closed). Field set must stay in lockstep
 * with `RouteTagFacts` (`providerRouteTag.ts`).
 */
function routeTagFactsForDecision(decision: ProviderRouteDecision, routeId: string): RouteTagFacts {
  return {
    routeId,
    provider: decision.provider,
    transport: decision.transport,
    wireModelId: decision.wireModelId,
    credentialSource: decision.credentialSource,
    billingSource: decision.billingSource ?? null,
    role: decision.role,
    profileId: decision.profileId,
  };
}

/**
 * WS1b-2: emit the three proxy integrity-gate headers for ALL proxy-dispatch
 * transports. `routeId` anchors to the turn id where present (route-table dispatch
 * has `turnId`; passthrough often does too via runtime context), else a stable
 * `${routeScope}:${wireModelId}` synthetic — the anchor only needs to be a stable
 * correlation key, the digest carries the real facts. Returns `[]` for non-proxy
 * (direct/terminal) transports so direct-Anthropic egress is untouched.
 */
export function appendRouteTagHeaders(
  decision: ProviderRouteDecision,
  runtimeCtx: ProviderRouteHeaderRuntimeContext,
): ProviderRouteHeaderTuples {
  if (!isProxyDispatch(decision.dispatchPath)) {
    return [];
  }
  const routeId = runtimeCtx.turnId && runtimeCtx.turnId.length > 0
    ? runtimeCtx.turnId
    : `${decision.routeScope}:${decision.wireModelId}`;
  const facts = routeTagFactsForDecision(decision, routeId);
  const headers: Array<readonly [string, string]> = [
    [ROUTE_TAG_HEADER, computeRouteTag(facts)],
    [ROUTE_ID_HEADER, routeId],
    [ROUTE_WIRE_MODEL_HEADER, facts.wireModelId],
  ];
  // WS4a: emit the signed fact-carrier alongside the WS1b-2 detector headers, ONLY
  // when the shared localhost secret is present (it is the HMAC key, and the same
  // condition under which `x-proxy-auth` is emitted). Additive + unconsumed in WS4a.
  if (runtimeCtx.proxyAuthToken) {
    headers.push([ROUTE_FACTS_HEADER, signRouteFacts(facts, runtimeCtx.proxyAuthToken)]);
  }
  return headers;
}

export function deriveHeaders(
  decision: ProviderRouteDecision,
  runtimeCtx: ProviderRouteHeaderRuntimeContext = {},
): ProviderRouteHeaderTuples {
  const headers: Array<readonly [string, string]> = [
    ...appendProxyIdentityHeaders(decision, runtimeCtx),
    ...appendRouteTagHeaders(decision, runtimeCtx),
  ];

  if (runtimeCtx.includeStructuredOutputBeta) {
    headers.push(['anthropic-beta', 'structured-outputs-2025-11-13']);
  }

  const transport = decision.transport;
  switch (transport) {
    case 'anthropic-direct':
      if (runtimeCtx.anthropicApiKey) headers.push(['x-api-key', runtimeCtx.anthropicApiKey]);
      headers.push(['anthropic-version', '2023-06-01']);
      headers.push(['content-type', 'application/json']);
      return sortedHeaders(headers);
    case 'openai-compatible-http':
      if (runtimeCtx.openAIApiKey) headers.push(['authorization', `Bearer ${runtimeCtx.openAIApiKey}`]);
      headers.push(['content-type', 'application/json']);
      return sortedHeaders(headers);
    case 'local-openai-compatible-http':
      headers.push(['content-type', 'application/json']);
      return sortedHeaders(headers);
    case 'openrouter-proxy':
      if (runtimeCtx.openRouterApiKey) headers.push(['authorization', `Bearer ${runtimeCtx.openRouterApiKey}`]);
      headers.push(['anthropic-version', '2023-06-01']);
      headers.push(['content-type', 'application/json']);
      headers.push(['http-referer', OPENROUTER_ATTRIBUTION_REFERER]);
      headers.push(['x-title', OPENROUTER_ATTRIBUTION_TITLE]);
      return sortedHeaders(headers);
    case 'codex-proxy':
      if (runtimeCtx.codexAccessToken) headers.push(['authorization', `Bearer ${runtimeCtx.codexAccessToken}`]);
      headers.push(['anthropic-version', '2023-06-01']);
      headers.push(['content-type', 'application/json']);
      return sortedHeaders(headers);
    case 'anthropic-compatible-local-proxy':
      headers.push(['anthropic-version', '2023-06-01']);
      headers.push(['content-type', 'application/json']);
      return sortedHeaders(headers);
    case 'no-credentials':
    case 'fail-closed-codex-disconnected':
      return sortedHeaders(headers);
    default:
      return assertNever(transport, 'ProviderRouteTransport');
  }
}

export function headersToAnthropicCustomHeaders(headers: ProviderRouteHeaderTuples): string {
  return headers.map(([key, value]) => `${key}: ${value}`).join('\n');
}

export function headerNames(headers: ProviderRouteHeaderTuples): ReadonlyArray<string> {
  return headers.map(([key]) => key).sort((left, right) => compareHeaderNames(left, right));
}
