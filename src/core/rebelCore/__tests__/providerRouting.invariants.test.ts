import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { CodexAuthProvider } from '@core/codexAuth';
import type { ModelProfile } from '@shared/types';
import { brandRouteWireModel } from '@shared/utils/wireModelId';

const logInfoMock = vi.hoisted(() => vi.fn());
const logDebugMock = vi.hoisted(() => vi.fn());

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: logInfoMock,
    debug: logDebugMock,
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { applyAuthPlanToEnv, deriveAuthPlan, deriveResolvedAuthLabel, withRuntimeAuth } from '../providerAuthPlan';
import { ensureDirectAnthropicCapable } from '../ensureDirectAnthropicCapable';
import { appendProxyIdentityHeaders, headerNames, InvalidRoutedModelHeaderError } from '../providerRouteHeaders';
import { materializePlanRuntime, type ProviderRoutePlan } from '../providerRoutePlan';
import { forTurnWithFallback, ProviderRouter, selectProviderMode } from '../providerRouting';
import { registerManagedKeyAvailability } from '../managedKeyAvailability';
import {
  assertDispatchableRoutePlan,
  deriveDispatchPath,
  isProxyDispatch,
  RouteTableRuntimeContextError,
  NonDispatchableRoutePlanError,
  type DispatchableDispatchPath,
  type DispatchableRouteDecision,
  type DispatchableTransport,
  type ProviderRouteDecision,
  type ProviderRouteScope,
  type ProviderRouteTransport,
  type TerminalTransport,
} from '../providerRouteDecision';
import { buildSdkQueryOptions, type QueryOptionsContext } from '../../../main/services/queryOptionsBuilder';

const ALL_TRANSPORTS: readonly ProviderRouteTransport[] = [
  'anthropic-direct',
  'anthropic-compatible-local-proxy',
  'openai-compatible-http',
  'local-openai-compatible-http',
  'codex-proxy',
  'openrouter-proxy',
  'no-credentials',
  'fail-closed-codex-disconnected',
];

const codexAuthProvider: CodexAuthProvider = {
  isConnected: () => true,
  getAccessToken: async () => 'codex-access-token',
  getAccountId: () => 'codex-account',
  forceRefreshToken: async () => 'codex-access-token',
  getStatus: () => ({ connected: true, accountEmail: 'test@example.com' }),
};

function settings(overrides: {
  activeProvider?: 'anthropic' | 'openrouter' | 'codex' | 'mindstone';
  apiKey?: string | null;
  oauthToken?: string | null;
  authMethod?: 'api-key' | 'oauth-token';
  openRouterToken?: string | null;
} = {}) {
  const apiKey = Object.hasOwn(overrides, 'apiKey') ? overrides.apiKey : 'fake-ant-test';
  return {
    activeProvider: overrides.activeProvider ?? 'anthropic',
    models: {
      apiKey,
      oauthToken: overrides.oauthToken ?? null,
      authMethod: overrides.authMethod ?? 'api-key',
      model: 'claude-sonnet-4-6',
    },
    openRouter: {
      enabled: overrides.activeProvider === 'openrouter',
      oauthToken: overrides.openRouterToken ?? null,
      selectedModel: 'anthropic/claude-sonnet-4.6',
    },
    localModel: { activeProfileId: null, profiles: [] },
    providerKeys: {},
  };
}

function authLabel(decision: ProviderRouteDecision) {
  return deriveResolvedAuthLabel(deriveAuthPlan(decision));
}

function anthropicProfile(model: string): ModelProfile {
  return {
    id: `anthropic-profile-${model.replace(/[^a-z0-9]+/gi, '-')}`,
    name: 'Anthropic profile',
    providerType: 'anthropic',
    serverUrl: 'https://api.anthropic.com/v1',
    model,
    enabled: true,
    createdAt: 1,
  };
}

function isTerminalTransport(transport: ProviderRouteTransport): transport is TerminalTransport {
  return transport === 'no-credentials' || transport === 'fail-closed-codex-disconnected';
}

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

function headerDecision(
  transport: ProviderRouteTransport,
  routeScope: ProviderRouteScope,
  role: ProviderRouteDecision['role'] = 'execution',
): ProviderRouteDecision {
  const base = {
    provider: transport === 'openrouter-proxy' ? 'openrouter' : transport === 'codex-proxy' ? 'codex' : 'anthropic',
    modelDialect: transport === 'local-openai-compatible-http'
      ? 'local-openai-compatible'
      : transport === 'openai-compatible-http'
        ? 'openai-compatible'
        : 'anthropic-native',
    role,
    routeScope,
    canonicalModelId: 'claude-sonnet-4-6',
    wireModelId: brandRouteWireModel('claude-sonnet-4-6'),
    profileId: null,
    resolvedFrom: 'settings',
    codexConnectivity: transport === 'codex-proxy' ? 'connected' : 'unknown',
    fallbackHint: null,
    credentialSource: transport === 'openrouter-proxy'
      ? 'openrouter-oauth-token'
      : transport === 'codex-proxy'
        ? 'codex-subscription'
        : 'anthropic-api-key',
  } as const;

  if (isTerminalTransport(transport)) {
    return {
      ...base,
      kind: 'terminal',
      transport,
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
    routedModel: routeScope === 'council' || routeScope === 'ad-hoc' ? 'routed-model' : null,
    invalidReason: 'none',
  };
}

describe('ProviderRouter Stage 1 invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Codex connectivity input matrix', () => {
    it.each([
      {
        name: 'turn codex active connected dispatches through codex-proxy',
        kind: 'forTurn' as const,
        input: {
          settings: settings({ activeProvider: 'codex' }),
          model: 'gpt-5.5',
          codexConnectivity: 'connected' as const,
        },
        expectedKind: 'dispatchable' as const,
        expectedTransport: 'codex-proxy' as const,
        expectedInvalidReason: 'none' as const,
        expectCodexHeader: true,
      },
      {
        name: 'turn codex active disconnected fails closed before codex-proxy',
        kind: 'forTurn' as const,
        input: {
          settings: settings({ activeProvider: 'codex' }),
          model: 'gpt-5.5',
          codexConnectivity: 'disconnected' as const,
        },
        expectedKind: 'terminal' as const,
        expectedTransport: 'no-credentials' as const,
        expectedInvalidReason: 'missing-codex-connection' as const,
        expectCodexHeader: false,
      },
      {
        name: 'BTS codex-subscription profile connected dispatches through codex-proxy',
        kind: 'forBTS' as const,
        input: {
          settings: {
            ...settings(),
            localModel: {
              activeProfileId: null,
              profiles: [{
                id: 'codex-working',
                name: 'Codex Working',
                providerType: 'openai' as const,
                serverUrl: 'https://api.openai.com/v1',
                model: 'gpt-5.5',
                authSource: 'codex-subscription' as const,
                createdAt: 0,
              }],
            },
          },
          model: 'profile:codex-working',
          codexConnectivity: 'connected' as const,
        },
        expectedKind: 'dispatchable' as const,
        expectedTransport: 'codex-proxy' as const,
        expectedInvalidReason: 'none' as const,
        expectCodexHeader: true,
      },
      {
        name: 'BTS codex-subscription profile disconnected fails closed before codex-proxy',
        kind: 'forBTS' as const,
        input: {
          settings: {
            ...settings(),
            localModel: {
              activeProfileId: null,
              profiles: [{
                id: 'codex-working',
                name: 'Codex Working',
                providerType: 'openai' as const,
                serverUrl: 'https://api.openai.com/v1',
                model: 'gpt-5.5',
                authSource: 'codex-subscription' as const,
                createdAt: 0,
              }],
            },
          },
          model: 'profile:codex-working',
          codexConnectivity: 'disconnected' as const,
        },
        expectedKind: 'terminal' as const,
        expectedTransport: 'fail-closed-codex-disconnected' as const,
        expectedInvalidReason: 'codex-disconnected-bts-blocked' as const,
        expectCodexHeader: false,
      },
      {
        name: '260429 native Claude under Codex disconnected diverts only with real Anthropic credentials',
        kind: 'forTurn' as const,
        input: {
          settings: settings({ activeProvider: 'codex', apiKey: 'sk-ant-real' }),
          model: 'claude-haiku-4-5',
          codexConnectivity: 'disconnected' as const,
        },
        expectedKind: 'dispatchable' as const,
        expectedTransport: 'anthropic-direct' as const,
        expectedInvalidReason: 'none' as const,
        expectCodexHeader: false,
      },
    ])('$name', async (row) => {
      const decision = row.kind === 'forBTS'
        ? ProviderRouter.forBTS(row.input)
        : ProviderRouter.forTurn(row.input);
      const plan = await materializePlanRuntime(decision, { codexAuthProvider });
      const headers = Object.fromEntries(plan.headers);

      expect(plan.decision.kind).toBe(row.expectedKind);
      expect(plan.decision.transport).toBe(row.expectedTransport);
      expect(plan.decision.invalidReason).toBe(row.expectedInvalidReason);
      expect(headers['x-codex-turn']).toBe(row.expectCodexHeader ? 'true' : undefined);
      if (!row.expectCodexHeader) {
        expect(plan.decision.transport).not.toBe('codex-proxy');
      }
    });
  });

  it('I1 preserves provider identity headers across council and ad-hoc proxy scopes', async () => {
    const councilDecision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ activeProvider: 'openrouter', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
      model: 'anthropic/claude-sonnet-4.6',
      routeScope: 'council',
    });
    const councilPlan = await materializePlanRuntime(councilDecision, {
      turnId: 'turn-1',
      proxyAuthToken: 'proxy-token',
      openRouterOAuthToken: 'or-token',
    });
    expect(councilPlan.headers).not.toContainEqual(['x-routed-turn-id', 'turn-1']);
    expect(councilPlan.headers).toContainEqual(['x-openrouter-turn', 'true']);
    expect(councilPlan.headers).toContainEqual(['x-proxy-auth', 'proxy-token']);

    const adHocDecision = ProviderRouter.forTurn({
      settings: settings({ activeProvider: 'codex' }),
      model: 'gpt-5.5',
      routeScope: 'ad-hoc',
      codexConnectivity: 'connected',
    });
    const adHocPlan = await materializePlanRuntime(adHocDecision, {
      turnId: 'turn-2',
      proxyAuthToken: 'proxy-token',
      codexAuthProvider,
    });
    expect(adHocPlan.headers).not.toContainEqual(['x-routed-turn-id', 'turn-2']);
    expect(adHocPlan.headers).toContainEqual(['x-codex-turn', 'true']);
  });

  it('I2 prevents foreign slash dialects from being marked direct-Anthropic capable, while a matching self-prefix is normalized + capable', () => {
    // A matching `anthropic/<native Claude>` self-prefix is NOT a foreign dialect: the
    // direct-Anthropic arm strips it to a bare wire id and dispatches (consistent with
    // the profile-Anthropic / Codex arms + the documented wire boundary).
    const selfPrefix = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings(),
      model: 'anthropic/claude-sonnet-4.6',
    });
    expect(selfPrefix.transport).toBe('anthropic-direct');
    expect(selfPrefix.modelDialect).toBe('anthropic-native');
    expect(selfPrefix.wireModelId).toBe('claude-sonnet-4-6');
    expect(selfPrefix.canonicalModelId).toBe('claude-sonnet-4-6');
    expect(ensureDirectAnthropicCapable(selfPrefix)).toEqual({ ok: true });

    // Foreign / nested / non-Claude slash dialects still fail closed as
    // proxy-dialect-in-direct-anthropic and are NOT capable.
    for (const model of [
      'openai/gpt-5.5',
      'deepseek/deepseek-v4-flash',
      'anthropic/anthropic/claude-sonnet-4.6',
      'anthropic/not-claude',
    ]) {
      const decision = ProviderRouter.forTurn({
        codexConnectivity: 'unknown', settings: settings(), model });
      expect(decision.transport, model).toBe('no-credentials');
      expect(decision.invalidReason, model).toBe('proxy-dialect-in-direct-anthropic');
      expect(ensureDirectAnthropicCapable(decision), model).toEqual({ ok: false, reason: 'no-credentials' });
    }
  });

  it('I2a normalizes matching Anthropic self-prefixes through every direct-Anthropic routing arm', () => {
    const model = 'anthropic/claude-opus-4-7';
    const profile = anthropicProfile(model);
    const routeSettings = {
      ...settings({ activeProvider: 'codex' }),
      localModel: { activeProfileId: null, profiles: [profile] },
    };

    const activeProvider = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ activeProvider: 'anthropic' }),
      model,
    });
    const profileAnthropic = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: routeSettings,
      profile,
    });
    const codexAnthropicDivert = ProviderRouter.forTurn({
      settings: routeSettings,
      model,
      codexConnectivity: 'disconnected',
    });

    for (const decision of [activeProvider, profileAnthropic, codexAnthropicDivert]) {
      expect(decision.kind).toBe('dispatchable');
      expect(decision.provider).toBe('anthropic');
      expect(decision.transport).toBe('anthropic-direct');
      expect(decision.modelDialect).toBe('anthropic-native');
      expect(decision.wireModelId).toBe('claude-opus-4-7');
      expect(decision.canonicalModelId).toBe('claude-opus-4-7');
      expect(ensureDirectAnthropicCapable(decision)).toEqual({ ok: true });
    }
  });

  it('I2b fails profile-Anthropic foreign dialects closed instead of dispatching them to Anthropic direct', () => {
    const profile = anthropicProfile('openai/gpt-5.5');
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: {
        ...settings({ activeProvider: 'anthropic' }),
        localModel: { activeProfileId: null, profiles: [profile] },
      },
      profile,
    });

    expect(decision.kind).toBe('terminal');
    expect(decision.provider).toBe('anthropic');
    expect(decision.transport).toBe('no-credentials');
    expect(decision.invalidReason).toBe('proxy-dialect-in-direct-anthropic');
    expect(decision.wireModelId).toBe('openai/gpt-5.5');
    expect(ensureDirectAnthropicCapable(decision)).toEqual({ ok: false, reason: 'no-credentials' });
  });

  it('I2c keeps OpenRouter slash prefixes as proxy dialects while direct Anthropic fails the same foreign corpus closed', () => {
    const foreignModels = [
      'openai/gpt-5.5',
      'deepseek/deepseek-v4-flash',
      'anthropic/anthropic/claude-sonnet-4.6',
    ];

    for (const model of foreignModels) {
      const profile = anthropicProfile(model);
      const activeProvider = ProviderRouter.forTurn({
        codexConnectivity: 'unknown',
        settings: settings({ activeProvider: 'anthropic' }),
        model,
      });
      const profileAnthropic = ProviderRouter.forTurn({
        codexConnectivity: 'unknown',
        settings: {
          ...settings({ activeProvider: 'anthropic' }),
          localModel: { activeProfileId: null, profiles: [profile] },
        },
        profile,
      });
      const openRouter = ProviderRouter.forTurn({
        codexConnectivity: 'unknown',
        settings: settings({ activeProvider: 'openrouter', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
        model,
      });

      for (const decision of [activeProvider, profileAnthropic]) {
        expect(decision.kind, model).toBe('terminal');
        expect(decision.provider, model).toBe('anthropic');
        expect(decision.invalidReason, model).toBe('proxy-dialect-in-direct-anthropic');
      }
      expect(openRouter.kind, model).toBe('dispatchable');
      expect(openRouter.provider, model).toBe('openrouter');
      expect(openRouter.transport, model).toBe('openrouter-proxy');
      expect(openRouter.wireModelId, model).toBe(model);
    }
  });

  it('I2d keeps bare GPT models on Codex instead of diverting them to direct Anthropic', () => {
    const decision = ProviderRouter.forTurn({
      settings: settings({ activeProvider: 'codex' }),
      model: 'gpt-5.5',
      codexConnectivity: 'connected',
    });

    expect(decision.kind).toBe('dispatchable');
    expect(decision.provider).toBe('codex');
    expect(decision.transport).toBe('codex-proxy');
    expect(decision.modelDialect).toBe('openai-compatible');
    expect(decision.wireModelId).toBe('gpt-5.5');
  });

  it('I2e keeps bare non-Claude models dispatchable through active-provider and profile Anthropic arms', () => {
    const model = 'gpt-5.5';
    const profile = anthropicProfile(model);
    const activeProvider = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ activeProvider: 'anthropic' }),
      model,
    });
    const profileAnthropic = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: {
        ...settings({ activeProvider: 'anthropic' }),
        localModel: { activeProfileId: null, profiles: [profile] },
      },
      profile,
    });

    for (const decision of [activeProvider, profileAnthropic]) {
      expect(decision.kind).toBe('dispatchable');
      expect(decision.provider).toBe('anthropic');
      expect(decision.transport).toBe('anthropic-direct');
      expect(decision.modelDialect).toBe('anthropic-native');
      expect(decision.wireModelId).toBe(model);
      expect(decision.canonicalModelId).toBe(model);
    }
  });

  function routeTableSubagentDecision(routedModel: string): ProviderRouteDecision {
    return ProviderRouter.forSubagent({
      codexConnectivity: 'unknown',
      settings: settings(),
      model: 'working',
      routeScope: 'ad-hoc',
      routedModel,
    });
  }

  it('Stage 3 sets x-routed-model when routedModel is present', () => {
    const decision = routeTableSubagentDecision('valid-model-id');

    const headers = appendProxyIdentityHeaders(decision, {
      turnId: 'turn-routed-header',
      routedModel: 'valid-model-id',
      proxyAuthToken: 'proxy-token',
    });

    expect(headers).toContainEqual(['x-routed-model', 'valid-model-id']);
  });

  it('Stage 3 fails route-table dispatch when routedModel is an empty string', () => {
    const decision = routeTableSubagentDecision('');
    expect(() => appendProxyIdentityHeaders(decision, {
      turnId: 'turn-routed-header',
      routedModel: '',
      proxyAuthToken: 'proxy-token',
    })).toThrow(RouteTableRuntimeContextError);
  });

  it('Stage 3 fails route-table dispatch when routedModel is whitespace-only', () => {
    const decision = routeTableSubagentDecision('   ');
    expect(() => appendProxyIdentityHeaders(decision, {
      turnId: 'turn-routed-header',
      routedModel: '   ',
      proxyAuthToken: 'proxy-token',
    })).toThrow(RouteTableRuntimeContextError);
  });

  it('Stage 3 rejects x-routed-model values containing carriage return characters', () => {
    const decision = routeTableSubagentDecision('valid-model-id');

    try {
      appendProxyIdentityHeaders(decision, {
        turnId: 'turn-routed-header',
        routedModel: 'invalid\rinjection',
        proxyAuthToken: 'proxy-token',
      });
      throw new Error('Expected InvalidRoutedModelHeaderError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRoutedModelHeaderError);
      expect(error).toMatchObject({
        headerName: 'x-routed-model',
        reason: 'non-printable-ascii',
      });
    }
  });

  it('Stage 3 rejects x-routed-model values containing newline characters', () => {
    const decision = routeTableSubagentDecision('valid-model-id');

    try {
      appendProxyIdentityHeaders(decision, {
        turnId: 'turn-routed-header',
        routedModel: '\nleading-newline',
        proxyAuthToken: 'proxy-token',
      });
      throw new Error('Expected InvalidRoutedModelHeaderError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRoutedModelHeaderError);
      expect(error).toMatchObject({
        headerName: 'x-routed-model',
        reason: 'non-printable-ascii',
      });
    }
  });

  it('Stage 3 rejects x-routed-model values containing non-ASCII characters', () => {
    const decision = routeTableSubagentDecision('valid-model-id');

    expect(() => appendProxyIdentityHeaders(decision, {
      turnId: 'turn-routed-header',
      routedModel: 'gemini-2.5-pro\u00FF',
      proxyAuthToken: 'proxy-token',
    })).toThrow(InvalidRoutedModelHeaderError);
    expect(() => appendProxyIdentityHeaders(decision, {
      turnId: 'turn-routed-header',
      routedModel: 'café',
      proxyAuthToken: 'proxy-token',
    })).toThrow(InvalidRoutedModelHeaderError);
    expect(() => appendProxyIdentityHeaders(decision, {
      turnId: 'turn-routed-header',
      routedModel: 'price-€-tier',
      proxyAuthToken: 'proxy-token',
    })).toThrow(InvalidRoutedModelHeaderError);
  });

  it('Stage 3 rejects x-routed-model values containing tab characters', () => {
    const decision = routeTableSubagentDecision('valid-model-id');

    expect(() => appendProxyIdentityHeaders(decision, {
      turnId: 'turn-routed-header',
      routedModel: 'gpt\t5',
      proxyAuthToken: 'proxy-token',
    })).toThrow(InvalidRoutedModelHeaderError);
  });

  it('Stage 3 rejects x-routed-model values containing other control characters', () => {
    const decision = routeTableSubagentDecision('valid-model-id');

    expect(() => appendProxyIdentityHeaders(decision, {
      turnId: 'turn-routed-header',
      routedModel: 'gpt-5.\x01',
      proxyAuthToken: 'proxy-token',
    })).toThrow(InvalidRoutedModelHeaderError);
  });

  it('forTurn lead via anthropic-compatible-local-proxy in council scope carries x-routed-model on wire headers', async () => {
    const geminiProfile = {
      id: 'gemini-lead-1',
      name: 'Gemini Pro',
      providerType: 'google' as const,
      serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'google-key-test',
      model: 'gemini-2.5-pro',
      enabled: true,
      routingEligible: true,
      createdAt: 1,
    };
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: {
        ...settings(),
        localModel: { activeProfileId: geminiProfile.id, profiles: [geminiProfile] },
      } as never,
      model: 'gemini-2.5-pro',
      profile: geminiProfile as never,
      routeScope: 'council',
    });

    expect(decision.transport).toBe('anthropic-compatible-local-proxy');
    expect(decision.routeScope).toBe('council');
    expect(decision.routedModel).toBe('gemini-2.5-pro');

    const plan = await materializePlanRuntime(decision, {
      turnId: 'turn-gemini-lead',
      proxyAuthToken: 'proxy-token',
    });
    expect(plan.headers).toContainEqual(['x-routed-turn-id', 'turn-gemini-lead']);
    expect(plan.headers).toContainEqual(['x-routed-model', 'gemini-2.5-pro']);
  });

  it('forTurn lead via anthropic-compatible-local-proxy in ad-hoc scope carries x-routed-model on wire headers', async () => {
    const geminiProfile = {
      id: 'gemini-lead-2',
      name: 'Gemini Pro',
      providerType: 'google' as const,
      serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'google-key-test',
      model: 'gemini-2.5-pro',
      enabled: true,
      routingEligible: true,
      createdAt: 1,
    };
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: {
        ...settings(),
        localModel: { activeProfileId: geminiProfile.id, profiles: [geminiProfile] },
      } as never,
      model: 'gemini-2.5-pro',
      profile: geminiProfile as never,
      routeScope: 'ad-hoc',
    });

    expect(decision.transport).toBe('anthropic-compatible-local-proxy');
    expect(decision.routeScope).toBe('ad-hoc');
    expect(decision.routedModel).toBe('gemini-2.5-pro');

    const plan = await materializePlanRuntime(decision, {
      turnId: 'turn-gemini-lead',
      proxyAuthToken: 'proxy-token',
    });
    expect(plan.headers).toContainEqual(['x-routed-model', 'gemini-2.5-pro']);
  });

  it('forTurn lead via anthropic-compatible-local-proxy in normal-turn scope does NOT carry x-routed-model', async () => {
    const geminiProfile = {
      id: 'gemini-lead-3',
      name: 'Gemini Pro',
      providerType: 'google' as const,
      serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'google-key-test',
      model: 'gemini-2.5-pro',
      enabled: true,
      routingEligible: true,
      createdAt: 1,
    };
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: {
        ...settings(),
        localModel: { activeProfileId: geminiProfile.id, profiles: [geminiProfile] },
      } as never,
      model: 'gemini-2.5-pro',
      profile: geminiProfile as never,
      routeScope: 'normal-turn',
    });

    expect(decision.transport).toBe('anthropic-compatible-local-proxy');
    expect(decision.routeScope).toBe('normal-turn');
    expect(decision.routedModel ?? null).toBeNull();

    const plan = await materializePlanRuntime(decision, {
      turnId: 'turn-gemini-lead',
      proxyAuthToken: 'proxy-token',
    });
    expect(plan.headers.some(([h]) => h === 'x-routed-model')).toBe(false);
  });

  it('forTurn lead with anthropic-direct transport never carries routedModel even in council/ad-hoc scope', () => {
    const councilDirect = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings(),
      model: 'claude-sonnet-4-6',
      routeScope: 'council',
    });
    expect(councilDirect.transport).toBe('anthropic-direct');
    expect(councilDirect.routedModel ?? null).toBeNull();

    const adHocDirect = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings(),
      model: 'claude-sonnet-4-6',
      routeScope: 'ad-hoc',
    });
    expect(adHocDirect.transport).toBe('anthropic-direct');
    expect(adHocDirect.routedModel ?? null).toBeNull();
  });

  describe('proxy-identity header gate (dispatchPath-gated producer + consumer)', () => {
    const decisionByDispatchPath = {
      'direct-provider': headerDecision('anthropic-direct', 'council'),
      'local-proxy-route-table': headerDecision('anthropic-compatible-local-proxy', 'council'),
      'local-proxy-passthrough': headerDecision('openrouter-proxy', 'normal-turn'),
      none: headerDecision('no-credentials', 'normal-turn'),
    } as const;

    const runtimeVariants = [
      { runtimeLabel: 'valid-runtime', turnId: 'turn-header-gate', routedModel: 'routed-model' },
      { runtimeLabel: 'empty-turn-id', turnId: '', routedModel: 'routed-model' },
      { runtimeLabel: 'empty-routed-model', turnId: 'turn-header-gate', routedModel: '' },
    ] as const;

    const cells = (Object.keys(decisionByDispatchPath) as ReadonlyArray<keyof typeof decisionByDispatchPath>)
      .flatMap((dispatchPath) =>
        [true, false].flatMap((hasProxyToken) =>
          runtimeVariants.map((runtime) => ({
            dispatchPath,
            hasProxyToken,
            ...runtime,
          })),
        ),
      );

    const emittedProxyHeaderPushCount = (calls: unknown[][]): number => calls.reduce((count, [value]) => {
      if (!Array.isArray(value) || value.length !== 2) return count;
      const [headerName, headerValue] = value;
      if (typeof headerName !== 'string' || typeof headerValue !== 'string') return count;
      if (
        headerName === 'x-proxy-auth'
        || headerName === 'x-routed-turn-id'
        || headerName === 'x-routed-model'
      ) {
        return count + 1;
      }
      return count;
    }, 0);

    it.each(cells)('F4 $dispatchPath / hasProxyToken=$hasProxyToken / $runtimeLabel', (cell) => {
      const decision = decisionByDispatchPath[cell.dispatchPath];
      expect(decision.kind).toBe(cell.dispatchPath === 'none' ? 'terminal' : 'dispatchable');
      const run = () => appendProxyIdentityHeaders(decision, {
        turnId: cell.turnId,
        routedModel: cell.routedModel,
        proxyAuthToken: cell.hasProxyToken ? 'proxy-token' : null,
      });

      if (
        cell.dispatchPath === 'local-proxy-route-table'
        && cell.hasProxyToken
        && (cell.turnId.length === 0 || cell.routedModel.length === 0)
      ) {
        expect(run).toThrow(RouteTableRuntimeContextError);
        return;
      }

      const headers = run();
      const expectedHeaderNames = new Set<string>();
      if (decision.transport === 'codex-proxy') {
        expectedHeaderNames.add('x-codex-turn');
      }
      if (decision.transport === 'openrouter-proxy') {
        expectedHeaderNames.add('x-openrouter-turn');
      }
      if (cell.hasProxyToken && isProxyDispatch(decision.dispatchPath)) {
        expectedHeaderNames.add('x-proxy-auth');
      }
      if (cell.hasProxyToken && decision.dispatchPath === 'local-proxy-route-table') {
        expectedHeaderNames.add('x-routed-turn-id');
        expectedHeaderNames.add('x-routed-model');
      }
      expect(new Set(headerNames(headers))).toEqual(expectedHeaderNames);
    });

    it('F6 direct-provider dispatch ignores accidental proxyAuthToken', () => {
      const headers = appendProxyIdentityHeaders(headerDecision('anthropic-direct', 'council'), {
        turnId: 'turn-direct-council',
        routedModel: 'routed-model',
        proxyAuthToken: 'proxy-token',
      });
      const names = headerNames(headers);
      expect(names).not.toContain('x-proxy-auth');
      expect(names).not.toContain('x-routed-turn-id');
      expect(names).not.toContain('x-routed-model');
    });

    it('F11 throws when route-table runtime misses turnId', () => {
      const decision = headerDecision('anthropic-compatible-local-proxy', 'council');
      const pushSpy = vi.spyOn(Array.prototype, 'push');
      try {
        const before = emittedProxyHeaderPushCount(pushSpy.mock.calls as unknown[][]);
        expect(() => appendProxyIdentityHeaders(decision, {
          turnId: '',
          routedModel: 'routed-model',
          proxyAuthToken: 'proxy-token',
        })).toThrow(RouteTableRuntimeContextError);
        const after = emittedProxyHeaderPushCount(pushSpy.mock.calls as unknown[][]);
        expect(after).toBe(before);
      } finally {
        pushSpy.mockRestore();
      }
    });

    it('F11 throws when route-table runtime misses routedModel', () => {
      const decision = headerDecision('anthropic-compatible-local-proxy', 'council');
      const pushSpy = vi.spyOn(Array.prototype, 'push');
      try {
        const before = emittedProxyHeaderPushCount(pushSpy.mock.calls as unknown[][]);
        expect(() => appendProxyIdentityHeaders(decision, {
          turnId: 'turn-route-table',
          routedModel: '',
          proxyAuthToken: 'proxy-token',
        })).toThrow(RouteTableRuntimeContextError);
        const after = emittedProxyHeaderPushCount(pushSpy.mock.calls as unknown[][]);
        expect(after).toBe(before);
      } finally {
        pushSpy.mockRestore();
      }
    });
  });

  it.each(ALL_TRANSPORTS.flatMap((transport) => ([
    { transport, role: 'execution' as const },
    { transport, role: 'subagent' as const },
  ])))('F5 $transport / $role proxyRequired aligns with dispatchPath', async ({ transport, role }) => {
    const routeScope = transport === 'anthropic-compatible-local-proxy' ? 'council' : 'normal-turn';
    const decision = headerDecision(transport, routeScope, role);
    expect(decision.kind).toBe(
      transport === 'no-credentials' || transport === 'fail-closed-codex-disconnected'
        ? 'terminal'
        : 'dispatchable',
    );
    const plan = await materializePlanRuntime(decision, {
      proxyBaseURL: 'http://proxy.local',
      proxyAuthToken: 'proxy-token',
      turnId: 'turn-f5',
      routedModel: decision.routedModel ?? null,
      codexAuthProvider,
    });
    expect(plan.proxyRequired).toBe(isProxyDispatch(plan.decision.dispatchPath));
  });

  it('F7 allows different dispatchPath values for lead and sub-agent in the same turn', async () => {
    const leadDecision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings(),
      model: 'claude-sonnet-4-6',
      routeScope: 'council',
    });
    const subagentDecision = ProviderRouter.forSubagent({
      codexConnectivity: 'unknown',
      settings: settings(),
      model: 'claude-sonnet-4-6',
      routeScope: 'council',
      routedModel: 'claude-sonnet-4-6',
    });

    expect(leadDecision.dispatchPath).toBe('direct-provider');
    expect(leadDecision.kind).toBe('dispatchable');
    expect(subagentDecision.dispatchPath).toBe('local-proxy-route-table');
    expect(subagentDecision.kind).toBe('dispatchable');

    const leadPlan = await materializePlanRuntime(leadDecision, {
      turnId: 'shared-turn',
      proxyAuthToken: 'proxy-token',
    });
    const subagentPlan = await materializePlanRuntime(subagentDecision, {
      turnId: 'shared-turn',
      proxyAuthToken: 'proxy-token',
      proxyBaseURL: 'http://proxy.local',
    });

    expect(headerNames(leadPlan.headers)).not.toContain('x-proxy-auth');
    expect(subagentPlan.headers).toContainEqual(['x-proxy-auth', 'proxy-token']);
    expect(subagentPlan.headers).toContainEqual(['x-routed-turn-id', 'shared-turn']);
  });

  it('F8 code-walk keeps dispatchPath assignments in allowed construction sites', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const testDirname = path.dirname(url.fileURLToPath(import.meta.url));
    const decisionSource = await fs.readFile(path.resolve(testDirname, '../providerRouteDecision.ts'), 'utf8');
    const routingSource = await fs.readFile(path.resolve(testDirname, '../providerRouting.ts'), 'utf8');
    const assignmentLines = [...decisionSource.split('\n'), ...routingSource.split('\n')]
      .map((line) => line.trim())
      .filter((line) => /dispatchPath:\s*(?:'[^']+'|deriveDispatchPath\()/.test(line));

    expect(assignmentLines.length).toBeGreaterThan(0);
    const disallowed = assignmentLines.filter((line) => !(
      line.includes("dispatchPath: 'local-proxy-route-table'")
      || line.includes("dispatchPath: 'none'")
      || line.includes('dispatchPath: deriveDispatchPath(')
    ));
    expect(disallowed).toEqual([]);
  });

  it('F10 throws for terminal dispatchPath and guards all three dispatch boundaries', async () => {
    expect(() => assertDispatchableRoutePlan({ decision: headerDecision('no-credentials', 'normal-turn') })).toThrow(NonDispatchableRoutePlanError);
    expect(() => assertDispatchableRoutePlan({ decision: headerDecision('anthropic-direct', 'normal-turn') })).not.toThrow();

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const testDirname = path.dirname(url.fileURLToPath(import.meta.url));
    const executorSource = await fs.readFile(path.resolve(testDirname, '../../services/turnPipeline/agentTurnExecute.ts'), 'utf8');
    const btsSource = await fs.readFile(path.resolve(testDirname, '../../services/behindTheScenesClient.ts'), 'utf8');
    const agentToolSource = await fs.readFile(path.resolve(testDirname, '../agentTool.ts'), 'utf8');

    expect(executorSource).toContain('assertDispatchableQueryOptionsPlan(queryOptionsCtx.plan);');
    expect(btsSource).toContain('isTerminalRoutePlan(plan)');
    expect(agentToolSource).toContain('isTerminalRoutePlan(plan)');
  });

  it('T1 narrows ProviderRouteDecision by kind discriminator', () => {
    const decision = ProviderRouter.forSubagent({
      codexConnectivity: 'unknown',
      settings: settings(),
      model: 'claude-sonnet-4-6',
      routeScope: 'normal-turn',
    });

    if (decision.kind === 'terminal') return;

    expectTypeOf(decision).toEqualTypeOf<DispatchableRouteDecision>();
    expect(decision.dispatchPath).not.toBe('none');
  });

  it('I3 derives only the four legacy _resolvedAuth labels', () => {
    const apiKey = ProviderRouter.forTurn({
      codexConnectivity: 'unknown', settings: settings(), model: 'claude-sonnet-4-6' });
    const oauth = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({ apiKey: null, oauthToken: 'oauth-token', authMethod: 'oauth-token' }),
      model: 'claude-haiku-4-5',
    });
    const openrouter = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ activeProvider: 'openrouter', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
      model: 'claude-sonnet-4-6',
    });
    const codex = ProviderRouter.forTurn({
      settings: settings({ activeProvider: 'codex' }),
      model: 'gpt-5.5',
      codexConnectivity: 'connected',
    });
    expect([authLabel(apiKey), authLabel(oauth), authLabel(openrouter), authLabel(codex)].sort()).toEqual([
      'api-key',
      'codex-subscription',
      'oauth-token',
      'openrouter',
    ]);
  });

  it.skip('I4 CodexDisconnectedBtsError contract is asserted during Stage 3 when BTS callers migrate to the plan');

  it('I5 fails closed for partial OpenRouter credentials instead of falling back to Anthropic', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({ activeProvider: 'openrouter', apiKey: 'fake-ant-linger', openRouterToken: null }),
      model: 'claude-haiku-4-5',
    });
    expect(decision.provider).toBe('openrouter');
    expect(decision.transport).toBe('no-credentials');
    expect(decision.invalidReason).toBe('missing-openrouter-credentials');
  });

  it('I5m routes Mindstone BTS calls with managed key through mindstone-managed-key', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: {
        ...settings({ activeProvider: 'mindstone' }),
        hasManagedKey: true,
      },
      model: 'deepseek/deepseek-v4-flash',
    });

    expect(decision.provider).toBe('openrouter');
    expect(decision.transport).toBe('openrouter-proxy');
    expect(decision.credentialSource).toBe('mindstone-managed-key');
    expect(decision.invalidReason).toBe('none');
  });

  it('I5n keeps Mindstone BTS fail-closed without managed key', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: {
        ...settings({ activeProvider: 'mindstone' }),
        hasManagedKey: false,
      },
      model: 'deepseek/deepseek-v4-flash',
    });

    expect(decision.provider).toBe('openrouter');
    expect(decision.transport).toBe('no-credentials');
    expect(decision.credentialSource).toBe('missing-mindstone');
    // A missing Mindstone managed key must carry the Mindstone-specific invalid reason
    // (not the OpenRouter one) so the user is told about their subscription, not OpenRouter.
    expect(decision.invalidReason).toBe('missing-mindstone-credentials');
  });

  // Injection-gap regression (rebel://conversation/a176b2e2): `hasManagedKey` is an
  // inject-at-call-time augmentation; call sites that forward bare settings (forSubagent,
  // preflight, model-name fallback) must still see a provisioned managed key via the
  // central resolver instead of silently collapsing to missing-mindstone.
  describe('Mindstone managed-key central resolver', () => {
    afterEach(() => {
      // Reset the global resolver so registration doesn't leak across tests.
      registerManagedKeyAvailability(() => false);
    });

    it('resolves a provisioned managed key when the caller omits hasManagedKey (resolver=true)', () => {
      registerManagedKeyAvailability(() => true);
      const mode = selectProviderMode(settings({ activeProvider: 'mindstone' }));
      expect(mode.provider).toBe('openrouter');
      expect(mode.credentialSource).toBe('mindstone-managed-key');
    });

    it('forSubagent (bare settings) sees the provisioned key via the resolver — the incident path', () => {
      registerManagedKeyAvailability(() => true);
      const decision = ProviderRouter.forSubagent({
        codexConnectivity: 'unknown',
        settings: settings({ activeProvider: 'mindstone' }),
        model: 'deepseek/deepseek-v4-flash',
      });
      expect(decision.credentialSource).toBe('mindstone-managed-key');
      expect(decision.invalidReason).toBe('none');
    });

    it('forSubagent falls closed to missing-mindstone-credentials when resolver=false', () => {
      registerManagedKeyAvailability(() => false);
      const decision = ProviderRouter.forSubagent({
        codexConnectivity: 'unknown',
        settings: settings({ activeProvider: 'mindstone' }),
        model: 'deepseek/deepseek-v4-flash',
      });
      expect(decision.credentialSource).toBe('missing-mindstone');
      expect(decision.invalidReason).toBe('missing-mindstone-credentials');
    });

    it('explicit hasManagedKey:false overrides resolver=true', () => {
      registerManagedKeyAvailability(() => true);
      const mode = selectProviderMode({ ...settings({ activeProvider: 'mindstone' }), hasManagedKey: false });
      expect(mode.credentialSource).toBe('missing-mindstone');
    });

    it('explicit hasManagedKey:true overrides resolver=false', () => {
      registerManagedKeyAvailability(() => false);
      const mode = selectProviderMode({ ...settings({ activeProvider: 'mindstone' }), hasManagedKey: true });
      expect(mode.credentialSource).toBe('mindstone-managed-key');
    });
  });

  // Locks the cap-exhausted managed user invariant: next turn with active OpenRouter uses the personal token.
  it('I5a chooses openrouter-oauth-token when active OpenRouter has a personal token even with managed key present', () => {
    const providerMode = selectProviderMode({
      ...settings({ activeProvider: 'openrouter', openRouterToken: 'or-test-token' }),
      hasManagedKey: true,
      openRouter: {
        enabled: true,
        oauthToken: 'or-test-token',
        selectedModel: 'anthropic/claude-sonnet-4.6',
      },
    });

    expect(providerMode.provider).toBe('openrouter');
    expect(providerMode.credentialSource).toBe('openrouter-oauth-token');
  });

  it('I5d routes OpenRouter connection-managed OAuth profiles as dispatchable across turn/BTS/subagent', () => {
    const routeSettings = {
      ...settings({ activeProvider: 'anthropic', openRouterToken: 'or-oauth-token' }),
      localModel: {
        activeProfileId: null,
        profiles: [{
          id: 'or-connection-profile',
          name: 'OR Connection Profile',
          providerType: 'openrouter' as const,
          profileSource: 'connection' as const,
          serverUrl: 'https://openrouter.ai/api/v1',
          model: 'anthropic/claude-sonnet-4.6',
          createdAt: 1,
        }],
      },
    };

    const forTurn = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: routeSettings as never,
      model: 'profile:or-connection-profile',
    });
    const forBTS = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: routeSettings as never,
      model: 'profile:or-connection-profile',
    });
    const forSubagent = ProviderRouter.forSubagent({
      codexConnectivity: 'unknown',
      settings: routeSettings as never,
      model: 'profile:or-connection-profile',
    });

    for (const decision of [forTurn, forBTS, forSubagent]) {
      expect(decision.kind).toBe('dispatchable');
      expect(decision.provider).toBe('openrouter');
      expect(decision.transport).toBe('openrouter-proxy');
      expect(decision.credentialSource).toBe('openrouter-oauth-token');
    }
  });

  it('I5b fails closed for Codex models unsupported by ChatGPT accounts', () => {
    const decision = ProviderRouter.forTurn({
      settings: settings({ activeProvider: 'codex' }),
      model: 'gpt-5.5-pro',
      codexConnectivity: 'connected',
    });
    expect(decision.provider).toBe('codex');
    expect(decision.transport).toBe('no-credentials');
    expect(decision.invalidReason).toBe('codex-unsupported-model');
    expect(decision.wireModelId).toBe('gpt-5.5-pro');
  });

  it('I5c normalizes stale dotted OpenRouter Claude IDs before routing', () => {
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ activeProvider: 'openrouter', apiKey: 'sk-ant-linger', openRouterToken: 'or-token' }),
      model: 'anthropic/claude-sonnet-4.6',
    });
    expect(decision.provider).toBe('openrouter');
    expect(decision.transport).toBe('openrouter-proxy');
    expect(decision.wireModelId).toBe('anthropic/claude-sonnet-4-6');
  });

  it('routes unselectable workingProfileId fallback as settings (not profile)', () => {
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: {
        ...settings(),
        models: {
          ...settings().models,
          model: 'claude-sonnet-4-6',
          workingProfileId: 'broken-working-profile',
        },
        localModel: {
          activeProfileId: null,
          profiles: [
            {
              id: 'broken-working-profile',
              name: 'Broken Working Profile',
              providerType: 'openai',
              serverUrl: '',
              model: 'gpt-5.5',
              apiKey: 'fake-openai',
              createdAt: 1,
            },
          ],
        },
      },
    });

    expect(decision.resolvedFrom).toBe('settings');
    expect(decision.profileId).toBeNull();
    expect(decision.provider).toBe('anthropic');
    expect(decision.transport).toBe('anthropic-direct');
    expect(decision.wireModelId).toBe('claude-sonnet-4-6');
  });

  it('I6 keeps Stage 1 discriminants closed through exhaustive switch helpers', async () => {
    type ExpectedTransportVariants =
      | 'anthropic-direct'
      | 'anthropic-compatible-local-proxy'
      | 'openai-compatible-http'
      | 'local-openai-compatible-http'
      | 'codex-proxy'
      | 'openrouter-proxy'
      | 'no-credentials'
      | 'fail-closed-codex-disconnected';
    expectTypeOf<ProviderRouteTransport>().toEqualTypeOf<ExpectedTransportVariants>();

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    // Resolve relative to this test file so the assertion works on any developer's machine.
    const testDirname = path.dirname(url.fileURLToPath(import.meta.url));
    const source = await fs.readFile(
      path.resolve(testDirname, '../providerRouting.ts'),
      'utf8',
    );
    // Stage 3 extracted the ActiveProvider switch into `providerModeFor(provider, …)`
    // (so multi-provider enumeration can resolve a mode for ANY candidate, not just
    // `settings.activeProvider`); the exhaustiveness guard moved with it and now
    // reads `assertNever(provider, …)`. Same axis, same guarantee.
    expect(source).toContain("assertNever(provider, 'ActiveProvider')");
    expect(source).toContain("assertNever(providerMode, 'ProviderMode')");
  });

  it('I7 rebuilds Codex provider rate-limit fallback through the next non-Codex provider and forces connectivity disconnected', async () => {
    const inFlightDecision = ProviderRouter.forTurn({
      settings: settings({ activeProvider: 'codex', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
      model: 'gpt-5.5',
      codexConnectivity: 'connected',
    });
    const inFlightPlan = await materializePlanRuntime(inFlightDecision);

    const fallbackDecision = forTurnWithFallback(
      {
        settings: settings({ activeProvider: 'codex', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
        model: 'claude-sonnet-4-6',
        codexConnectivity: 'disconnected',
      },
      { kind: 'codex-rate-limit-provider', forceNonCodexTransport: true },
      inFlightPlan,
    );

    expect(fallbackDecision.provider).toBe('openrouter');
    expect(fallbackDecision.transport).toBe('openrouter-proxy');
    expect(fallbackDecision.codexConnectivity).toBe('disconnected');
    expect(fallbackDecision.fallbackHint).toEqual({ kind: 'codex-rate-limit-provider', forceNonCodexTransport: true });
  });

  it('I7 respects pre-set activeProvider for Codex provider rate-limit fallback', async () => {
    const inFlightDecision = ProviderRouter.forTurn({
      settings: settings({ activeProvider: 'codex', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
      model: 'gpt-5.5',
      codexConnectivity: 'connected',
    });
    const inFlightPlan = await materializePlanRuntime(inFlightDecision);

    const fallbackDecision = forTurnWithFallback(
      {
        settings: settings({ activeProvider: 'anthropic', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
        model: 'claude-sonnet-4-6',
        codexConnectivity: 'disconnected',
      },
      { kind: 'codex-rate-limit-provider', forceNonCodexTransport: true },
      inFlightPlan,
    );

    expect(fallbackDecision.provider).toBe('anthropic');
    expect(fallbackDecision.transport).toBe('anthropic-direct');
    expect(fallbackDecision.fallbackHint).toEqual({ kind: 'codex-rate-limit-provider', forceNonCodexTransport: true });
  });

  it('I7 reuses the in-flight Codex connectivity snapshot for non-provider fallback rebuilds', async () => {
    const inFlightDecision = ProviderRouter.forTurn({
      settings: settings({ activeProvider: 'codex' }),
      model: 'gpt-5.5',
      codexConnectivity: 'connected',
    });
    const inFlightPlan = await materializePlanRuntime(inFlightDecision);

    const fallbackDecision = forTurnWithFallback(
      {
        settings: {
          ...settings({ activeProvider: 'codex' }),
          models: {
            ...settings({ activeProvider: 'codex' }).models,
            workingFallback: 'model:gpt-5.4-mini',
          },
        },
        model: 'gpt-5.5',
        codexConnectivity: 'disconnected',
      },
      { kind: 'codex-rate-limit-tier', tier: 'standard' },
      inFlightPlan,
    );

    expect(fallbackDecision.provider).toBe('codex');
    expect(fallbackDecision.transport).toBe('codex-proxy');
    expect(fallbackDecision.wireModelId).toBe('gpt-5.4-mini');
    expect(fallbackDecision.codexConnectivity).toBe('connected');
  });

  it('I8 long-context profile fallback rebuild overrides the active profile through the resolver', async () => {
    const profiles = [
      {
        id: 'short-profile',
        name: 'Short Profile',
        providerType: 'openai' as const,
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'fake-short',
        createdAt: 1,
      },
      {
        id: 'long-profile',
        name: 'Long Profile',
        providerType: 'openai' as const,
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.5',
        apiKey: 'fake-long',
        createdAt: 2,
      },
    ];
    const routeSettings = {
      ...settings(),
      localModel: { activeProfileId: 'short-profile', profiles },
    };
    const inFlightPlan = await materializePlanRuntime(ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: routeSettings,
      profile: profiles[0],
      model: profiles[0].model,
    }));

    const fallbackDecision = forTurnWithFallback(
      {
        settings: routeSettings,
        profile: profiles[0],
        model: profiles[0].model,
        codexConnectivity: 'unknown',
      },
      { kind: 'long-context-profile', profileId: 'long-profile' },
      inFlightPlan,
    );

    expect(fallbackDecision.provider).toBe('profile');
    expect(fallbackDecision.profileId).toBe('long-profile');
    expect(fallbackDecision.wireModelId).toBe('gpt-5.5');
    expect(fallbackDecision.fallbackHint).toEqual({ kind: 'long-context-profile', profileId: 'long-profile' });
  });

  it('I8 rebuilds configured role fallback targets through turn fallback routing with role remapping', async () => {
    const inFlightPlan = await materializePlanRuntime(ProviderRouter.forTurn({
      settings: settings({ activeProvider: 'anthropic', apiKey: 'fake-ant-linger' }),
      model: 'claude-opus-4-7',
      role: 'planning',
      codexConnectivity: 'connected',
    }));

    const fallbackDecision = forTurnWithFallback(
      {
        settings: settings({ activeProvider: 'anthropic', apiKey: 'fake-ant-linger' }),
        model: 'claude-opus-4-7',
        role: 'execution',
        codexConnectivity: 'disconnected',
      },
      {
        kind: 'configured-role-fallback',
        role: 'thinking',
        target: { kind: 'model', model: 'claude-haiku-4-5' },
        failedModel: 'claude-opus-4-7',
        errorKind: 'server_error',
      },
      inFlightPlan,
    );

    expect(fallbackDecision.role).toBe('planning');
    expect(fallbackDecision.wireModelId).toBe('claude-haiku-4-5');
    expect(fallbackDecision.fallbackHint).toEqual({
      kind: 'configured-role-fallback',
      role: 'thinking',
      target: { kind: 'model', model: 'claude-haiku-4-5' },
      failedModel: 'claude-opus-4-7',
      errorKind: 'server_error',
    });
    expect(fallbackDecision.codexConnectivity).toBe('connected');
  });

  it('I9 encodes council/ad-hoc/subagent routing scope in Stage 1 decisions', () => {
    const council = ProviderRouter.forSubagent({
      codexConnectivity: 'unknown',
      settings: settings({ activeProvider: 'openrouter', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
      model: 'claude-haiku-4-5',
      routeScope: 'council',
    });
    const adHoc = ProviderRouter.forSubagent({
      codexConnectivity: 'unknown',
      settings: settings(),
      model: 'claude-haiku-4-5',
      routeScope: 'ad-hoc',
    });
    expect(council.role).toBe('subagent');
    expect(council.routeScope).toBe('council');
    expect(adHoc.routeScope).toBe('ad-hoc');
  });

  it('I10 gates prompt-cache warmup and use-case generation to direct Anthropic native plans', () => {
    const direct = ProviderRouter.forTurn({
      codexConnectivity: 'unknown', settings: settings(), model: 'claude-sonnet-4-6' });
    const openrouter = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ activeProvider: 'openrouter', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
      model: 'claude-sonnet-4-6',
    });
    const codexGpt = ProviderRouter.forTurn({
      settings: settings({ activeProvider: 'codex' }),
      model: 'gpt-5.5',
      codexConnectivity: 'connected',
    });
    // REBEL-538: Codex active + Anthropic-native model + Anthropic creds → anthropic-direct
    const codexClaude = ProviderRouter.forTurn({
      settings: settings({ activeProvider: 'codex' }),
      model: 'claude-sonnet-4-6',
      codexConnectivity: 'connected',
    });
    expect(ensureDirectAnthropicCapable(direct)).toEqual({ ok: true });
    expect(ensureDirectAnthropicCapable(openrouter)).toEqual({ ok: false, reason: 'non-direct-provider' });
    expect(ensureDirectAnthropicCapable(codexGpt)).toEqual({ ok: false, reason: 'codex-active' });
    expect(ensureDirectAnthropicCapable(codexClaude)).toEqual({ ok: true });
  });

  it('I11 header-emission-from-plan-only — buildSdkQueryOptions emits no header outside plan.headers', async () => {
    const decision = ProviderRouter.forTurn({
      settings: settings({ activeProvider: 'openrouter', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
      model: 'anthropic/claude-sonnet-4.6',
      routeScope: 'ad-hoc',
      codexConnectivity: 'disconnected',
    });
    const plan = await materializePlanRuntime(decision, {
      turnId: 'turn-i11',
      proxyBaseURL: 'http://localhost:4001',
      proxyAuthToken: 'proxy-token',
      openRouterOAuthToken: 'or-token',
    });
    const ctx: QueryOptionsContext = {
      turnId: 'turn-i11',
      coreDirectory: '/workspace',
      effectivePath: '/usr/bin',
      effectiveThinkingEffort: 'medium',
      modelConfig: { model: 'anthropic/claude-sonnet-4.6' },
      getEffectiveModel: () => 'anthropic/claude-sonnet-4.6',
      plan,
      rawSystemPrompt: 'Raw prompt',
      finalSystemPrompt: 'Final prompt',
      turnHooks: { PreToolUse: [], SubagentStart: [], PostToolUse: [], Stop: [], SubagentStop: [] },
      mcpServers: undefined,
      capabilityResolution: { disallowedTools: [], promptGuidance: [], activeCapabilities: [] },
      agentMcpSpecs: undefined,
      councilConfig: null,
      adHocConfig: {
        agents: { 'adhoc-or': { description: 'OpenRouter adhoc', prompt: 'work', routedModel: 'anthropic/claude-sonnet-4.6' } },
        routeTable: { routes: new Map() },
        systemPromptHint: '',
        modelDisplayNames: new Map(),
      },
      claudeSubagentConfig: null,
      getProviderKeyEnv: () => ({}),
      permissionMode: 'bypassPermissions',
      knowledgeWorkerAgentName: 'Rebel',
      knowledgeWorkerAgentDescription: 'Knowledge worker assistant',
      processEnv: {
        PATH: '/bin',
        ANTHROPIC_CUSTOM_HEADERS: 'x-codex-turn: stale',
        X_RANDOM: 'unchanged',
      },
    };

    const queryOptions = buildSdkQueryOptions(ctx);
    const env = queryOptions.env ?? {};
    const expectedHeaders = plan.headers.map(([key, value]) => `${key}: ${value}`).join('\n');

    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(expectedHeaders);
    for (const [headerKey] of plan.headers) {
      const escapedHeaderKey = headerKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const [envKey, envValue] of Object.entries(env)) {
        if (envKey === 'ANTHROPIC_CUSTOM_HEADERS') continue;
        expect(envKey.toLowerCase()).not.toBe(headerKey.toLowerCase());
        expect(envValue).not.toMatch(new RegExp(`(?:^|\\n)${escapedHeaderKey}\\s*:`, 'i'));
      }
    }
  });

  it('I12 applyAuthPlanToEnv is pure, idempotent, and deletes stale managed keys', async () => {
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ activeProvider: 'openrouter', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
      model: 'claude-sonnet-4-6',
    });
    const plan = await materializePlanRuntime(decision, { openRouterOAuthToken: 'or-token' });
    const baseEnv = {
      ANTHROPIC_API_KEY: 'stale-anthropic',
      ANTHROPIC_BASE_URL: 'http://stale-proxy',
      ANTHROPIC_CUSTOM_HEADERS: 'x-stale: true',
      OPENAI_API_KEY: 'stale-openai',
      CODEX_ACCESS_TOKEN: 'stale-codex',
      PATH: '/usr/bin',
    };
    const applied = applyAuthPlanToEnv(plan, baseEnv);
    expect(baseEnv).toEqual({
      ANTHROPIC_API_KEY: 'stale-anthropic',
      ANTHROPIC_BASE_URL: 'http://stale-proxy',
      ANTHROPIC_CUSTOM_HEADERS: 'x-stale: true',
      OPENAI_API_KEY: 'stale-openai',
      CODEX_ACCESS_TOKEN: 'stale-codex',
      PATH: '/usr/bin',
    });
    expect(applied).toEqual({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_CUSTOM_HEADERS: [
        'anthropic-version: 2023-06-01',
        'authorization: Bearer or-token',
        'content-type: application/json',
        'http-referer: https://rebel.mindstone.com',
        'x-openrouter-turn: true',
        // WS1b-2 proxy integrity-gate headers (additive). No turnId in this
        // runtime context → routeId falls back to `${routeScope}:${wireModelId}`.
        'x-route-id: normal-turn:claude-sonnet-4-6',
        'x-route-tag: rt1.05de83e88ef0d733b5b0dfa16e6b4f2fb7a5a1adabab9e646505bdea2164565b',
        'x-route-wire-model: claude-sonnet-4-6',
        'x-title: Rebel',
      ].join('\n'),
      OPENROUTER_API_KEY: 'or-token',
      PATH: '/usr/bin',
    });
    expect(applyAuthPlanToEnv(plan, applied)).toEqual(applied);
  });

  it('I12 projects proxy base URL and sorted custom headers from the full ProviderRoutePlan', () => {
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ activeProvider: 'openrouter', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
      model: 'anthropic/claude-sonnet-4.6',
    });
    if (decision.kind === 'terminal') {
      throw new Error('Expected dispatchable decision for openrouter profile test');
    }
    const auth = deriveAuthPlan(decision);
    const plan: ProviderRoutePlan = {
      decision,
      auth,
      headers: [['x-openrouter-turn', 'v']],
      proxyBaseURL: 'http://localhost:4001',
      resolvedAuthLabel: deriveResolvedAuthLabel(auth),
      proxyRequired: true,
      invalidReason: null,
    };
    const applied = applyAuthPlanToEnv(plan, {});
    expect(applied.ANTHROPIC_BASE_URL).toBe('http://localhost:4001');
    expect(applied.ANTHROPIC_CUSTOM_HEADERS).toBe('x-openrouter-turn: v');
  });

  it('preserves missing-profile runtime auth as unavailable without leaking local Anthropic keys', () => {
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: {
        ...settings({ apiKey: 'fake-ant-linger' }),
        localModel: {
          activeProfileId: null,
          profiles: [
            {
              id: 'missing-profile',
              name: 'Missing Profile',
              providerType: 'openai',
              serverUrl: 'https://api.openai.com/v1',
              model: 'gpt-5.5',
              createdAt: 0,
            },
          ],
        },
      },
      model: 'profile:missing-profile',
    });
    const runtimeAuth = withRuntimeAuth(deriveAuthPlan(decision), { anthropicApiKey: 'fake-leak' });
    expect(runtimeAuth.kind).toBe('api-key');
    if (runtimeAuth.kind !== 'api-key') {
      throw new Error('Expected missing-profile auth to use api-key auth plan shape');
    }
    expect(runtimeAuth.apiKey).toBeNull();
    expect(runtimeAuth.credentialStatus).toBe('unavailable');
    expect(runtimeAuth.env).not.toContainEqual(['ANTHROPIC_API_KEY', 'fake-leak']);
    expect(runtimeAuth.env).not.toContainEqual(['OPENROUTER_API_KEY', 'fake-leak']);
    expect(runtimeAuth.env).not.toContainEqual(['OPENAI_API_KEY', 'fake-leak']);
  });

  it('I13 logs one structured [ROUTER] event with header names only', async () => {
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ activeProvider: 'openrouter', apiKey: 'fake-ant-linger', openRouterToken: 'or-token' }),
      model: 'anthropic/claude-sonnet-4.6',
      routeScope: 'council',
    });
    await materializePlanRuntime(decision, {
      turnId: 'turn-log',
      proxyAuthToken: 'secret-proxy-token',
      openRouterOAuthToken: 'secret-openrouter-token',
    });
    expect(logInfoMock).toHaveBeenCalledTimes(1);
    const [event, message] = logInfoMock.mock.calls[0];
    expect(message).toBe('[ROUTER] provider route plan resolved');
    expect(event).toMatchObject({
      turnId: 'turn-log',
      role: 'execution',
      routeScope: 'council',
      provider: 'openrouter',
      transport: 'openrouter-proxy',
      dispatchPath: 'local-proxy-passthrough',
      modelDialect: 'openrouter-prefixed',
      wireModelId: brandRouteWireModel('anthropic/claude-sonnet-4-6'),
      resolvedAuthLabel: 'openrouter',
      codexConnectivity: 'unknown',
      profileId: null,
      fallbackHint: null,
      proxyRequired: true,
      invalidReason: null,
    });
    expect(event.headerNames).toEqual([
      'anthropic-version',
      'authorization',
      'content-type',
      'http-referer',
      'x-openrouter-turn',
      'x-proxy-auth',
      // WS4a signed fact-carrier (additive) emitted on proxy dispatch when a
      // proxyAuthToken is present (the HMAC key). Only the header NAME is logged.
      'x-route-facts',
      // WS1b-2 proxy integrity-gate headers (additive) emitted on proxy dispatch.
      'x-route-id',
      'x-route-tag',
      'x-route-wire-model',
      'x-title',
    ]);
    expect(JSON.stringify(event)).not.toContain('secret-proxy-token');
    expect(JSON.stringify(event)).not.toContain('secret-openrouter-token');
  });

  it('I13 logs invalidReason when the router fails closed', async () => {
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ activeProvider: 'openrouter', apiKey: 'fake-ant-linger', openRouterToken: null }),
      model: 'claude-sonnet-4-6',
    });
    await materializePlanRuntime(decision);
    expect(logInfoMock).toHaveBeenCalledTimes(1);
    const [event, message] = logInfoMock.mock.calls[0];
    expect(message).toBe('[ROUTER] provider route plan resolved');
    expect(event).toMatchObject({
      provider: 'openrouter',
      transport: 'no-credentials',
      invalidReason: 'missing-openrouter-credentials',
    });
  });

});
