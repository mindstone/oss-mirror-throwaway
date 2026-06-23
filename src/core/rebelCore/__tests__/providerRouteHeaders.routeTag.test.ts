import { describe, expect, it } from 'vitest';
import { brandRouteWireModel } from '@shared/utils/wireModelId';
import type { DispatchableRouteDecision, ProviderRouteDecision } from '../providerRouteDecision';
import {
  ROUTE_FACTS_HEADER,
  ROUTE_ID_HEADER,
  ROUTE_TAG_HEADER,
  ROUTE_WIRE_MODEL_HEADER,
  appendRouteTagHeaders,
  deriveHeaders,
} from '../providerRouteHeaders';
import { computeRouteTag, inspectRouteTag, verifyRouteFacts, type RouteTagFacts } from '../providerRouteTag';

/**
 * WS1b-2 emit-side contract: `deriveHeaders` (via `appendRouteTagHeaders`) emits the
 * three proxy integrity-gate headers (`x-route-tag` opaque digest, `x-route-id`
 * anchor, `x-route-wire-model` plaintext witness) for ALL proxy-dispatch transports
 * — including passthrough (codex/openrouter), which does NOT carry `x-routed-turn-id`
 * — and NOT for direct/terminal transports.
 */

function dispatchable(overrides: Partial<DispatchableRouteDecision> = {}): DispatchableRouteDecision {
  return {
    kind: 'dispatchable',
    provider: 'openrouter',
    transport: 'openrouter-proxy',
    dispatchPath: 'local-proxy-passthrough',
    modelDialect: 'openrouter-prefixed',
    role: 'execution',
    routeScope: 'normal-turn',
    canonicalModelId: 'anthropic/claude-sonnet-4-6',
    wireModelId: brandRouteWireModel('anthropic/claude-sonnet-4-6'),
    profileId: null,
    resolvedFrom: 'settings',
    codexConnectivity: 'unknown',
    fallbackHint: null,
    credentialSource: 'openrouter-oauth-token',
    billingSource: 'pool',
    invalidReason: 'none',
    ...overrides,
  };
}

function headerMap(decision: ProviderRouteDecision, runtimeCtx: Parameters<typeof deriveHeaders>[1]): Record<string, string> {
  return Object.fromEntries(deriveHeaders(decision, runtimeCtx));
}

describe('appendRouteTagHeaders / deriveHeaders route-tag emission', () => {
  it('emits all three route-tag headers on a proxy passthrough route (which lacks x-routed-turn-id)', () => {
    const decision = dispatchable();
    const headers = headerMap(decision, { turnId: 'turn-123', proxyAuthToken: 'auth-tok' });

    // Passthrough does NOT carry x-routed-turn-id...
    expect(headers['x-routed-turn-id']).toBeUndefined();
    // ...so the dedicated anchor + tag + witness must be present on this path.
    expect(headers[ROUTE_ID_HEADER]).toBe('turn-123');
    expect(headers[ROUTE_WIRE_MODEL_HEADER]).toBe('anthropic/claude-sonnet-4-6');
    expect(inspectRouteTag(headers[ROUTE_TAG_HEADER])).toBe('current');
  });

  it('the emitted x-route-tag is the digest of the decision facts (round-trips computeRouteTag)', () => {
    const decision = dispatchable();
    const headers = headerMap(decision, { turnId: 'turn-xyz', proxyAuthToken: 'auth-tok' });

    const facts: RouteTagFacts = {
      routeId: 'turn-xyz',
      provider: decision.provider,
      transport: decision.transport,
      wireModelId: decision.wireModelId,
      credentialSource: decision.credentialSource,
      billingSource: decision.billingSource ?? null,
      role: decision.role,
      profileId: decision.profileId,
    };
    expect(headers[ROUTE_TAG_HEADER]).toBe(computeRouteTag(facts));
  });

  it('emits on a route-table dispatch too (alongside x-routed-turn-id)', () => {
    const decision = dispatchable({
      provider: 'profile',
      transport: 'openai-compatible-http',
      dispatchPath: 'local-proxy-route-table',
      modelDialect: 'profile-ref',
      credentialSource: 'profile-api-key',
      billingSource: 'pay-per-use',
      profileId: 'profile-1',
      routedModel: 'gpt-5.5',
    });
    const headers = headerMap(decision, {
      turnId: 'turn-rt',
      routedModel: 'gpt-5.5',
      proxyAuthToken: 'auth-tok',
    });

    expect(headers['x-routed-turn-id']).toBe('turn-rt');
    expect(headers[ROUTE_ID_HEADER]).toBe('turn-rt');
    expect(headers[ROUTE_WIRE_MODEL_HEADER]).toBe('anthropic/claude-sonnet-4-6');
    expect(inspectRouteTag(headers[ROUTE_TAG_HEADER])).toBe('current');
  });

  it('falls back to a stable synthetic routeId when no turnId is present', () => {
    const decision = dispatchable({ routeScope: 'ad-hoc' });
    const headers = headerMap(decision, { proxyAuthToken: 'auth-tok' });
    expect(headers[ROUTE_ID_HEADER]).toBe('ad-hoc:anthropic/claude-sonnet-4-6');
  });

  it('emits NOTHING for a direct (non-proxy) transport', () => {
    const decision = dispatchable({
      provider: 'anthropic',
      transport: 'anthropic-direct',
      dispatchPath: 'direct-provider',
      modelDialect: 'anthropic-native',
      canonicalModelId: 'claude-opus-4-7',
      wireModelId: brandRouteWireModel('claude-opus-4-7'),
      credentialSource: 'anthropic-api-key',
      billingSource: 'pay-per-use',
    });
    expect(appendRouteTagHeaders(decision, { turnId: 'turn-direct' })).toEqual([]);
    const headers = headerMap(decision, { turnId: 'turn-direct', anthropicApiKey: 'k' });
    expect(headers[ROUTE_TAG_HEADER]).toBeUndefined();
    expect(headers[ROUTE_ID_HEADER]).toBeUndefined();
    expect(headers[ROUTE_WIRE_MODEL_HEADER]).toBeUndefined();
  });
});

describe('WS4a signed fact-carrier (x-route-facts) emission', () => {
  it('emits a verifiable signed fact-carrier for a proxy route when proxyAuthToken is present', () => {
    const decision = dispatchable();
    const secret = 'proxy-auth-token';
    const headers = headerMap(decision, { turnId: 'turn-fc', proxyAuthToken: secret });

    const carrier = headers[ROUTE_FACTS_HEADER];
    expect(carrier).toBeDefined();

    // Verify+decode under the SAME secret → exact decision facts.
    const result = verifyRouteFacts(carrier, secret);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.facts).toEqual<RouteTagFacts>({
        routeId: 'turn-fc',
        provider: decision.provider,
        transport: decision.transport,
        wireModelId: decision.wireModelId,
        credentialSource: decision.credentialSource,
        billingSource: decision.billingSource ?? null,
        role: decision.role,
        profileId: decision.profileId,
      });
    }
  });

  it('does NOT emit the fact-carrier on a proxy route when proxyAuthToken is absent (the HMAC key is missing)', () => {
    // The detector headers still emit (gated only on proxy dispatch), but the signed
    // carrier requires the shared secret.
    const decision = dispatchable();
    const headers = headerMap(decision, { turnId: 'turn-no-auth' });
    expect(headers[ROUTE_TAG_HEADER]).toBeDefined();
    expect(headers[ROUTE_FACTS_HEADER]).toBeUndefined();
  });

  it('does NOT emit the fact-carrier for a direct (non-proxy) transport even with proxyAuthToken', () => {
    const decision = dispatchable({
      provider: 'anthropic',
      transport: 'anthropic-direct',
      dispatchPath: 'direct-provider',
      modelDialect: 'anthropic-native',
      canonicalModelId: 'claude-opus-4-7',
      wireModelId: brandRouteWireModel('claude-opus-4-7'),
      credentialSource: 'anthropic-api-key',
      billingSource: 'pay-per-use',
    });
    const headers = headerMap(decision, {
      turnId: 'turn-direct',
      anthropicApiKey: 'k',
      proxyAuthToken: 'proxy-auth-token',
    });
    expect(headers[ROUTE_FACTS_HEADER]).toBeUndefined();
  });

  it('a carrier minted under one token does not verify under another (binds to the localhost secret)', () => {
    const decision = dispatchable();
    const headers = headerMap(decision, { turnId: 'turn-fc', proxyAuthToken: 'token-A' });
    expect(verifyRouteFacts(headers[ROUTE_FACTS_HEADER], 'token-B')).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });
});
