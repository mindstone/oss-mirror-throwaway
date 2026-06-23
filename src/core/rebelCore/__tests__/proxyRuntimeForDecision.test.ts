import { describe, expect, it } from 'vitest';
import { brandRouteWireModel } from '@shared/utils/wireModelId';
import {
  deriveDispatchPath,
  type DispatchableDispatchPath,
  type DispatchableTransport,
  type ProviderRouteDecision,
  type ProviderRouteScope,
  type ProviderRouteTransport,
  type TerminalTransport,
} from '../providerRouteDecision';

function deriveDispatchableTestPath(
  transport: DispatchableTransport,
  routeScope: ProviderRouteScope,
): DispatchableDispatchPath {
  const dispatchPath = deriveDispatchPath(transport, routeScope);
  if (dispatchPath === 'none') {
    throw new Error(`Unexpected terminal dispatchPath for ${transport}`);
  }
  return dispatchPath;
}
import { proxyRuntimeForDecision } from '../proxyRuntimeForDecision';

function makeDecision(
  transport: ProviderRouteTransport,
  routeScope: ProviderRouteScope,
  canonicalModelId = 'claude-sonnet-4-6',
): ProviderRouteDecision {
  const base = {
    provider: transport === 'openrouter-proxy' ? 'openrouter' : transport === 'codex-proxy' ? 'codex' : 'anthropic',
    modelDialect: 'anthropic-native',
    role: 'execution',
    routeScope,
    canonicalModelId,
    wireModelId: brandRouteWireModel(canonicalModelId),
    profileId: null,
    resolvedFrom: 'settings',
    codexConnectivity: 'unknown',
    fallbackHint: null,
    credentialSource: 'anthropic-api-key',
  } as const;

  if (transport === 'no-credentials' || transport === 'fail-closed-codex-disconnected') {
    const terminalTransport: TerminalTransport = transport;
    return {
      ...base,
      kind: 'terminal',
      transport: terminalTransport,
      dispatchPath: 'none',
      credentialSource: 'missing-anthropic',
      invalidReason: 'missing-anthropic-credentials',
    };
  }

  return {
    ...base,
    kind: 'dispatchable',
    transport: transport satisfies DispatchableTransport,
    dispatchPath: deriveDispatchableTestPath(transport, routeScope),
    routedModel: routeScope === 'council' || routeScope === 'ad-hoc' ? canonicalModelId : null,
    invalidReason: 'none',
  };
}

describe('proxyRuntimeForDecision', () => {
  it.each([
    {
      name: 'direct-provider dispatch ignores proxy manager',
      decision: makeDecision('anthropic-direct', 'normal-turn'),
      proxyManager: { baseURL: 'http://proxy.local:7070', authToken: 'proxy-token' },
      expected: { proxyBaseURL: null, proxyAuthToken: null, routedModel: null },
    },
    {
      name: 'route-table dispatch returns proxy runtime and routed model',
      decision: makeDecision('anthropic-compatible-local-proxy', 'council', 'gemini-2.5-pro'),
      proxyManager: { baseURL: 'http://proxy.local:7070', authToken: 'proxy-token' },
      expected: {
        proxyBaseURL: 'http://proxy.local:7070',
        proxyAuthToken: 'proxy-token',
        routedModel: 'gemini-2.5-pro',
      },
    },
    {
      name: 'passthrough dispatch returns proxy runtime without routed model',
      decision: makeDecision('openrouter-proxy', 'normal-turn', 'anthropic/claude-sonnet-4-6'),
      proxyManager: { baseURL: 'http://proxy.local:7070', authToken: 'proxy-token' },
      expected: {
        proxyBaseURL: 'http://proxy.local:7070',
        proxyAuthToken: 'proxy-token',
        routedModel: null,
      },
    },
    {
      name: 'terminal dispatch always returns null proxy runtime',
      decision: makeDecision('no-credentials', 'normal-turn'),
      proxyManager: { baseURL: 'http://proxy.local:7070', authToken: 'proxy-token' },
      expected: { proxyBaseURL: null, proxyAuthToken: null, routedModel: null },
    },
    {
      name: 'route-table dispatch preserves routed model even when proxy manager is unavailable',
      decision: makeDecision('anthropic-compatible-local-proxy', 'ad-hoc', 'gpt-5.5'),
      proxyManager: { baseURL: null, authToken: null },
      expected: { proxyBaseURL: null, proxyAuthToken: null, routedModel: 'gpt-5.5' },
    },
  ])('F9 $name', ({ decision, proxyManager, expected }) => {
    expect(proxyRuntimeForDecision(decision, proxyManager)).toEqual(expected);
  });
});
