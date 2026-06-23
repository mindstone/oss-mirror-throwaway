/**
 * Exhaustive provider resolver parity matrix for Slice 3.
 *
 * Cells derive the route-plan/client observation from raw
 * settings/model/profile/runtime inputs, then snapshot the new engine
 * observation as the golden fixture.
 *
 * Terminal cells assert the fail-closed route-plan shape that production gates
 * upstream at turnAdmission.ts:205-275; see reachability report 260531_184632.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { PLAN_MODE_ALIAS } from '@shared/utils/modelNormalization';
import { brandRouteWireModel } from '@shared/utils/wireModelId';

const clientMocks = vi.hoisted(() => {
  class CapturedAnthropicClient {
    readonly __clientKind = 'anthropic' as const;
    constructor(readonly config: Record<string, unknown>) {}
  }

  class CapturedOpenAIClient {
    readonly __clientKind = 'openai' as const;
    constructor(readonly config: Record<string, unknown>) {}
  }

  return { CapturedAnthropicClient, CapturedOpenAIClient };
});

vi.mock('../clients/anthropicClient', () => ({
  AnthropicClient: clientMocks.CapturedAnthropicClient,
}));

vi.mock('../clients/openaiClient', () => ({
  OpenAIClient: clientMocks.CapturedOpenAIClient,
}));

import {
  createClientFromRoutePlan,
} from '../clientFactory';
import {
  buildTerminalReconnectMessage,
} from '../providerRouteDecision';
import type { ProviderRouteRuntimeContext } from '../providerRoutePlan';
import { resolveProviderRoutePlan, type ProviderRoutePlanRequest } from '../providerRouting';
import { isTerminalRoutePlan, type DispatchableRoutePlan, type ProviderRoutePlan } from '../providerRoutePlanTypes';
import {
  ANTHROPIC_KEY,
  CODEX_ACCESS_TOKEN,
  OPENROUTER_TOKEN,
  PROXY_AUTH_TOKEN,
  PROXY_BASE_URL,
  authShapeFromConfig,
  emptyObservation,
  headersObject,
  isCapturedClient,
  modelSettings,
  profile,
  settings,
  type ObservableClientConfig,
  type RawCell,
} from './helpers/providerResolutionHarness';

function terminalObservation(plan: ProviderRoutePlan): ObservableClientConfig {
  if (!isTerminalRoutePlan(plan)) {
    throw new Error('terminalObservation called for dispatchable plan');
  }
  const reconnect = plan.decision.invalidReason === 'proxy-dialect-in-direct-anthropic'
    ? { provider: 'Anthropic' }
    : buildTerminalReconnectMessage(plan.decision);
  return emptyObservation({
    status: 'error',
    routeProvider: plan.decision.provider,
    credentialSource: plan.decision.credentialSource,
    resolvedAuthLabel: plan.resolvedAuthLabel,
    defaultHeaders: headersObject(plan.headers),
    wireModelId: plan.decision.wireModelId,
    dispatchPath: plan.decision.dispatchPath,
    errorKind: plan.decision.invalidReason === 'proxy-dialect-in-direct-anthropic' ? 'routing' : 'auth',
    messageClass: plan.decision.invalidReason,
    providerLabel: reconnect.provider,
  });
}

function observeNewClient(plan: DispatchableRoutePlan, cell: RawCell): ObservableClientConfig {
  const client = createClientFromRoutePlan(plan, cell.settings, { routeProfile: cell.fallback?.routeProfile ?? cell.profile });
  if (!isCapturedClient(client)) {
    throw new Error('createClientFromRoutePlan did not return a captured test client');
  }
  const headers = typeof client.config.defaultHeaders === 'object' && client.config.defaultHeaders !== null
    ? client.config.defaultHeaders as Record<string, string>
    : {};
  return emptyObservation({
    clientKind: client.__clientKind,
    routeProvider: plan.decision.provider,
    providerLabel: typeof client.config.provider === 'string' ? client.config.provider : null,
    providerTypeLabel: typeof client.config.providerType === 'string' ? client.config.providerType : null,
    credentialSource: plan.decision.credentialSource,
    resolvedAuthLabel: plan.resolvedAuthLabel,
    authShape: authShapeFromConfig(client.config),
    baseURL: typeof client.config.baseURL === 'string' ? client.config.baseURL : null,
    proxyBaseURL: plan.proxyBaseURL,
    endpointURL: plan.endpoint?.baseURL ?? null,
    defaultHeaders: headers,
    wireModelId: plan.decision.wireModelId,
    dispatchPath: plan.decision.dispatchPath,
    maxRetries: typeof client.config.maxRetries === 'number' ? client.config.maxRetries : null,
    enableContextManagement: typeof client.config.enableContextManagement === 'boolean'
      ? client.config.enableContextManagement
      : null,
    enableCompact: typeof client.config.enableCompact === 'boolean' ? client.config.enableCompact : null,
  });
}

async function observeNew(cell: RawCell): Promise<ObservableClientConfig> {
  const baseInput = {
    settings: cell.settings,
    model: cell.model,
    profile: cell.profile,
    routedModel: cell.routedModel,
    routeScope: cell.routeScope,
    codexConnectivity: cell.codexConnectivity ?? 'unknown',
  };
  const kind = cell.kind ?? 'forTurn';
  const request: ProviderRoutePlanRequest = kind === 'forBTS'
    ? { kind, input: { ...baseInput, category: cell.category } }
    : kind === 'forSubagent'
      ? { kind, input: baseInput }
      : {
          kind,
          input: {
            ...baseInput,
            role: cell.role === 'planning' ? 'planning' : 'execution',
          },
          ...(cell.fallback
            ? { fallback: { fallbackHint: cell.fallback.hint, inFlightPlan: cell.fallback.inFlightPlan } }
            : {}),
        };
  const plan = await resolveProviderRoutePlan(request, cell.runtimeContext);
  return isTerminalRoutePlan(plan)
    ? terminalObservation(plan)
    : observeNewClient(plan, cell);
}

function fakeInFlightPlan(overrides: Partial<DispatchableRoutePlan['decision']> = {}): DispatchableRoutePlan {
  return {
    decision: {
      kind: 'dispatchable',
      provider: 'anthropic',
      transport: 'anthropic-direct',
      dispatchPath: 'direct-provider',
      modelDialect: 'anthropic-native',
      role: 'execution',
      routeScope: 'normal-turn',
      canonicalModelId: 'claude-sonnet-4-20250514',
      wireModelId: brandRouteWireModel('claude-sonnet-4-20250514'),
      profileId: null,
      resolvedFrom: 'settings',
      codexConnectivity: 'unknown',
      fallbackHint: null,
      credentialSource: 'anthropic-api-key',
      invalidReason: 'none',
      ...overrides,
    },
    auth: {
      kind: 'api-key',
      resolvedAuthLabel: 'api-key',
      credentialSource: 'anthropic-api-key',
      credentialStatus: 'available',
      apiKey: ANTHROPIC_KEY,
      env: [],
    },
    headers: [],
    proxyBaseURL: null,
    resolvedAuthLabel: 'api-key',
    proxyRequired: false,
    invalidReason: null,
  };
}

const fallbackProfile = profile({
  id: 'long-context-profile',
  name: 'Long context Together',
  providerType: 'together',
  serverUrl: 'https://api.together.xyz/v1',
  model: 'deepseek-chat',
  apiKey: 'together-test-key',
});

const missingProfileKey = profile({
  id: 'missing-profile-key',
  name: 'Missing profile key',
  providerType: 'together',
  serverUrl: 'https://api.together.xyz/v1',
  model: 'deepseek-chat',
  apiKey: undefined,
});

const localProfile = profile({
  id: 'local-profile',
  name: 'Local profile',
  providerType: 'local',
  serverUrl: 'http://localhost:11434/v1',
  model: 'llama-3.1-local',
  apiKey: undefined,
});

const openAiProfile = profile({
  id: 'openai-profile',
  name: 'OpenAI profile',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  apiKey: 'openai-profile-key',
});

const googleProfile = profile({
  id: 'google-profile',
  name: 'Google profile',
  providerType: 'google',
  serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  model: 'gemini-2.5-pro',
  apiKey: 'google-profile-key',
});

const anthropicSelfPrefixProfile = profile({
  id: 'anthropic-self-prefix-profile',
  name: 'Anthropic self-prefix profile',
  providerType: 'anthropic',
  serverUrl: 'https://api.anthropic.com/v1',
  model: 'anthropic/claude-opus-4-7',
  apiKey: undefined,
});

const anthropicForeignProfile = profile({
  id: 'anthropic-foreign-profile',
  name: 'Anthropic foreign profile',
  providerType: 'anthropic',
  serverUrl: 'https://api.anthropic.com/v1',
  model: 'openai/gpt-5.5',
  apiKey: undefined,
});

const codexSubscriptionProfile = profile({
  id: 'codex-working-profile',
  name: 'Codex subscription profile',
  authSource: 'codex-subscription',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  apiKey: undefined,
});

const workingProfile = profile({
  id: 'working-profile',
  name: 'Working OpenAI profile',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5-mini',
  apiKey: 'working-profile-key',
});

function codexRuntimeContext(): ProviderRouteRuntimeContext {
  return {
    proxyBaseURL: PROXY_BASE_URL,
    codexAuthProvider: {
      getAccessToken: async () => CODEX_ACCESS_TOKEN,
      getAccountId: () => 'codex-account',
      isConnected: () => true,
      forceRefreshToken: async () => CODEX_ACCESS_TOKEN,
      getStatus: () => ({ connected: true, accountEmail: 'codex@example.test' }),
    },
  };
}

const cells: RawCell[] = [
  {
    name: 'working baseline: Anthropic BYOK execution',
    mode: 'dispatchable',
    settings: settings({ experimental: { compactEnabled: true } }),
    model: 'claude-sonnet-4-20250514',
    role: 'execution',
  },
  {
    name: 'planning role: Anthropic direct',
    mode: 'dispatchable',
    settings: settings(),
    model: 'claude-opus-4-7',
    role: 'planning',
  },
  {
    name: 'planning role: OpenRouter proxy',
    mode: 'dispatchable',
    settings: settings({
      activeProvider: 'openrouter',
      claude: modelSettings({ apiKey: null }),
      openRouter: {
        enabled: true,
        oauthToken: OPENROUTER_TOKEN,
        selectedModel: 'anthropic/claude-opus-4-7',
      },
    }),
    model: 'anthropic/claude-opus-4-7',
    role: 'planning',
    runtimeContext: {
      proxyBaseURL: PROXY_BASE_URL,
      openRouterOAuthToken: OPENROUTER_TOKEN,
    },
  },
  {
    name: 'working baseline: OpenRouter native model proxy',
    mode: 'dispatchable',
    settings: settings({
      activeProvider: 'openrouter',
      claude: modelSettings({ apiKey: null }),
      openRouter: {
        enabled: true,
        oauthToken: OPENROUTER_TOKEN,
        selectedModel: 'claude-sonnet-4-20250514',
      },
    }),
    model: 'claude-sonnet-4-20250514',
    role: 'execution',
    runtimeContext: {
      proxyBaseURL: PROXY_BASE_URL,
      openRouterOAuthToken: OPENROUTER_TOKEN,
    },
  },
  {
    name: 'working baseline: Mindstone managed routes through OpenRouter',
    mode: 'dispatchable',
    settings: settings({
      activeProvider: 'mindstone',
      claude: modelSettings({ apiKey: null }),
      hasManagedKey: true,
      openRouter: {
        enabled: true,
        oauthToken: null,
        selectedModel: 'openai/gpt-5.5',
      },
    }),
    model: 'openai/gpt-5.5',
    role: 'execution',
    runtimeContext: { proxyBaseURL: PROXY_BASE_URL },
  },
  {
    name: 'working baseline: Codex connected app model proxy',
    mode: 'dispatchable',
    settings: settings({
      activeProvider: 'codex',
      claude: modelSettings({ apiKey: null }),
    }),
    model: 'gpt-5.5',
    role: 'execution',
    codexConnectivity: 'connected',
    runtimeContext: codexRuntimeContext(),
  },
  {
    name: 'codex provider: native Anthropic model routes direct despite disconnected connectivity',
    mode: 'dispatchable',
    settings: settings({ activeProvider: 'codex' }),
    model: 'claude-sonnet-4-20250514',
    role: 'execution',
    codexConnectivity: 'disconnected',
  },
  {
    name: 'codex provider: Anthropic self-prefix model routes direct stripped',
    mode: 'dispatchable',
    settings: settings({ activeProvider: 'codex' }),
    model: 'anthropic/claude-opus-4-7',
    role: 'execution',
    codexConnectivity: 'disconnected',
  },
  {
    name: 'profile dispatch: local OpenAI-compatible profile',
    mode: 'dispatchable',
    settings: settings({
      localModel: { activeProfileId: null, profiles: [localProfile] },
    }),
    model: localProfile.model,
    role: 'execution',
    profile: localProfile,
  },
  {
    name: 'profile dispatch: cloud OpenAI-compatible profile',
    mode: 'dispatchable',
    settings: settings({
      localModel: { activeProfileId: null, profiles: [fallbackProfile] },
    }),
    model: fallbackProfile.model,
    role: 'execution',
    profile: fallbackProfile,
  },
  {
    name: 'profile dispatch: OpenAI profile with profile key',
    mode: 'dispatchable',
    settings: settings({
      localModel: { activeProfileId: null, profiles: [openAiProfile] },
    }),
    model: openAiProfile.model,
    role: 'execution',
    profile: openAiProfile,
  },
  {
    name: 'profile dispatch: Google profile normal turn via anthropic-compatible proxy',
    mode: 'dispatchable',
    settings: settings({
      localModel: { activeProfileId: null, profiles: [googleProfile] },
    }),
    model: googleProfile.model,
    role: 'execution',
    profile: googleProfile,
    runtimeContext: {
      proxyBaseURL: PROXY_BASE_URL,
      profileApiKey: googleProfile.apiKey,
    },
  },
  {
    name: 'profile dispatch: Anthropic self-prefix profile strips matching prefix',
    mode: 'dispatchable',
    settings: settings({
      localModel: { activeProfileId: null, profiles: [anthropicSelfPrefixProfile] },
    }),
    model: anthropicSelfPrefixProfile.model,
    role: 'execution',
    profile: anthropicSelfPrefixProfile,
  },
  {
    name: 'profile terminal routing guard: Anthropic foreign profile cannot dispatch direct Anthropic',
    mode: 'terminal',
    settings: settings({
      localModel: { activeProfileId: null, profiles: [anthropicForeignProfile] },
    }),
    model: anthropicForeignProfile.model,
    role: 'execution',
    profile: anthropicForeignProfile,
  },
  {
    name: 'profile dispatch: Google profile BTS uses OpenAI-compatible HTTP',
    // new-oracle: prod BTS routes Google profiles to direct OpenAI-compatible HTTP via ProviderRouter.forBTS
    // (providerRouting.ts:774-789, role==='bts').
    mode: 'new-oracle',
    kind: 'forBTS',
    settings: settings({
      localModel: { activeProfileId: null, profiles: [googleProfile] },
    }),
    model: googleProfile.model,
    profile: googleProfile,
    category: 'summary-title',
    runtimeContext: {
      endpointBaseURL: googleProfile.serverUrl,
      profileApiKey: googleProfile.apiKey,
    },
  },
  {
    name: 'BTS role: OpenRouter BYO proxy',
    mode: 'dispatchable',
    kind: 'forBTS',
    settings: settings({
      activeProvider: 'openrouter',
      claude: modelSettings({ apiKey: null }),
      openRouter: {
        enabled: true,
        oauthToken: OPENROUTER_TOKEN,
        selectedModel: 'anthropic/claude-haiku-4-5',
      },
    }),
    model: 'anthropic/claude-haiku-4-5',
    category: 'hero-choice',
    runtimeContext: {
      proxyBaseURL: PROXY_BASE_URL,
      openRouterOAuthToken: OPENROUTER_TOKEN,
    },
  },
  {
    name: 'subagent role: council route-table coercion',
    mode: 'dispatchable',
    kind: 'forSubagent',
    settings: settings(),
    model: 'claude-sonnet-4-20250514',
    routedModel: 'claude-sonnet-4-20250514',
    routeScope: 'council',
    runtimeContext: {
      proxyBaseURL: PROXY_BASE_URL,
      proxyAuthToken: PROXY_AUTH_TOKEN,
      routedModel: 'claude-sonnet-4-20250514',
      turnId: 'turn-council',
    },
  },
  {
    name: 'subagent role: ad-hoc route-table coercion',
    mode: 'dispatchable',
    kind: 'forSubagent',
    settings: settings(),
    model: 'claude-opus-4-7',
    routedModel: 'claude-opus-4-7',
    routeScope: 'ad-hoc',
    runtimeContext: {
      proxyBaseURL: PROXY_BASE_URL,
      proxyAuthToken: PROXY_AUTH_TOKEN,
      routedModel: 'claude-opus-4-7',
      turnId: 'turn-ad-hoc',
    },
  },
  {
    name: 'role-default: working-profile promotion with no explicit model',
    mode: 'dispatchable',
    settings: settings({
      localModel: { activeProfileId: workingProfile.id, profiles: [workingProfile] },
    }),
    model: null,
    role: 'execution',
    runtimeContext: {
      endpointBaseURL: workingProfile.serverUrl,
      profileApiKey: workingProfile.apiKey,
    },
  },
  {
    name: 'BTS role: stale profile reference sanitizes to default fast model',
    mode: 'dispatchable',
    kind: 'forBTS',
    settings: settings({
      behindTheScenesModel: 'profile:missing-bts-profile',
    } as Partial<AppSettings>),
    model: null,
    category: 'stale-profile-sanitize',
  },
  {
    name: 'codex terminal: disconnected connectivity',
    mode: 'terminal',
    settings: settings({ activeProvider: 'codex', claude: modelSettings({ apiKey: null }) }),
    model: 'gpt-5.5',
    role: 'execution',
    codexConnectivity: 'disconnected',
    runtimeContext: codexRuntimeContext(),
  },
  {
    name: 'codex terminal: unknown connectivity',
    mode: 'terminal',
    settings: settings({ activeProvider: 'codex', claude: modelSettings({ apiKey: null }) }),
    model: 'gpt-5.5',
    role: 'execution',
    codexConnectivity: 'unknown',
    runtimeContext: codexRuntimeContext(),
  },
  {
    name: 'codex terminal: unsupported app model',
    mode: 'terminal',
    settings: settings({ activeProvider: 'codex', claude: modelSettings({ apiKey: null }) }),
    model: 'gpt-5.5-pro',
    role: 'execution',
    codexConnectivity: 'connected',
    runtimeContext: codexRuntimeContext(),
  },
  {
    name: 'profile terminal: Codex subscription profile disconnected for BTS',
    mode: 'terminal',
    kind: 'forBTS',
    settings: settings({
      localModel: { activeProfileId: null, profiles: [codexSubscriptionProfile] },
    }),
    model: codexSubscriptionProfile.model,
    profile: codexSubscriptionProfile,
    codexConnectivity: 'disconnected',
    runtimeContext: { proxyBaseURL: PROXY_BASE_URL },
  },
  {
    name: 'terminal no credentials: OpenRouter missing OAuth',
    mode: 'terminal',
    settings: settings({
      activeProvider: 'openrouter',
      claude: modelSettings({ apiKey: null }),
      openRouter: {
        enabled: true,
        oauthToken: null,
        selectedModel: 'anthropic/claude-opus-4-7',
      },
    }),
    model: 'anthropic/claude-opus-4-7',
    role: 'execution',
    runtimeContext: { proxyBaseURL: PROXY_BASE_URL },
  },
  {
    name: 'terminal no credentials: Mindstone managed key missing',
    mode: 'terminal',
    settings: settings({
      activeProvider: 'mindstone',
      claude: modelSettings({ apiKey: null }),
      hasManagedKey: false,
      openRouter: {
        enabled: true,
        oauthToken: null,
        selectedModel: 'openai/gpt-5.5',
      },
    }),
    model: 'openai/gpt-5.5',
    role: 'execution',
    runtimeContext: { proxyBaseURL: PROXY_BASE_URL },
  },
  {
    name: 'terminal no credentials: explicit profile key missing',
    mode: 'terminal',
    settings: settings({
      models: modelSettings({ apiKey: null }),
      localModel: { activeProfileId: null, profiles: [missingProfileKey] },
    }),
    model: 'deepseek-chat',
    role: 'execution',
    profile: missingProfileKey,
  },
  {
    name: 'terminal no credentials: direct Anthropic missing credentials',
    mode: 'terminal',
    settings: settings({
      models: modelSettings({ apiKey: null }),
    }),
    model: 'claude-sonnet-4-20250514',
    role: 'execution',
  },
  {
    // A *foreign* slash dialect (here OpenAI) on direct Anthropic must fail closed as
    // proxy-dialect-in-direct-anthropic. (Previously this row used `anthropic/claude-opus-4-7`,
    // a matching self-prefix; that input is now legitimately normalized + dispatched — see the
    // 'self-prefix normalize' dispatchable row below.)
    name: 'terminal routing guard: foreign dialect cannot dispatch direct Anthropic',
    mode: 'terminal',
    settings: settings(),
    model: 'openai/gpt-5.5',
    role: 'execution',
  },
  {
    // A matching `anthropic/<native Claude>` self-prefix on direct Anthropic is stripped to a
    // bare native id and dispatched anthropic-direct (foreign-only reject contract).
    name: 'self-prefix normalize: direct Anthropic strips matching anthropic/ prefix',
    mode: 'dispatchable',
    settings: settings(),
    model: 'anthropic/claude-opus-4-7',
    role: 'execution',
  },
  {
    name: 'fallback rebuild: long-context-profile routes to explicit profile',
    mode: 'dispatchable',
    settings: settings({
      localModel: { activeProfileId: null, profiles: [fallbackProfile] },
    }),
    model: 'claude-sonnet-4-20250514',
    role: 'execution',
    fallback: {
      hint: { kind: 'long-context-profile', profileId: fallbackProfile.id },
      inFlightPlan: fakeInFlightPlan({ codexConnectivity: 'unknown' }),
      routeProfile: fallbackProfile,
    },
  },
  {
    // memory-BTS route mismatch fix: an `alt-model` fallback to a SLASH id
    // (`openai/gpt-5.5`) under active-provider codex is NOT codex-servable — the
    // codex proxy is a non-passthrough AnthropicClient (`x-codex-turn`) and a
    // slash body model fails closed at the wire guard (`anthropicClient.ts:802`,
    // `/routing mismatch/`; cf. modelIdLifecycle.integration.test.ts:419). The
    // pre-fix snapshot recorded that latently-broken dispatchable route (body
    // `wireModelId: "openai/gpt-5.5"` on a `clientKind: anthropic`,
    // `x-codex-turn: true` client). The codex-servable guard now turns it into a
    // clean `codex-unsupported-model` terminal at the route seam instead of a wire
    // throw. (The fallback rebuild should hand the BARE `gpt-5.5`, not the slash id;
    // that selection-layer concern is the spun-out Stage 2b dialect-aware selection.)
    name: 'fallback rebuild: alt-model stays on Codex provider',
    mode: 'terminal',
    settings: settings({
      activeProvider: 'codex',
      claude: modelSettings({ apiKey: null }),
      openRouter: {
        enabled: true,
        oauthToken: OPENROUTER_TOKEN,
        selectedModel: 'openai/gpt-5.5',
      },
    }),
    model: 'gpt-5.5',
    role: 'execution',
    fallback: {
      hint: { kind: 'alt-model', model: 'openai/gpt-5.5' },
      inFlightPlan: fakeInFlightPlan({
        provider: 'codex',
        transport: 'codex-proxy',
        dispatchPath: 'local-proxy-passthrough',
        modelDialect: 'openai-compatible',
        wireModelId: brandRouteWireModel('gpt-5.5'),
        canonicalModelId: 'gpt-5.5',
        codexConnectivity: 'connected',
        credentialSource: 'codex-subscription',
      }),
    },
    runtimeContext: codexRuntimeContext(),
  },
  {
    name: 'fallback rebuild: configured-role thinking fallback maps to planning role',
    mode: 'dispatchable',
    settings: settings({
      activeProvider: 'openrouter',
      claude: modelSettings({ apiKey: null }),
      openRouter: {
        enabled: true,
        oauthToken: OPENROUTER_TOKEN,
        selectedModel: 'anthropic/claude-opus-4-7',
      },
    }),
    model: 'claude-sonnet-4-20250514',
    role: 'execution',
    fallback: {
      hint: {
        kind: 'configured-role-fallback',
        role: 'thinking',
        target: { kind: 'model', model: 'anthropic/claude-opus-4-7' },
        failedModel: 'claude-sonnet-4-20250514',
        errorKind: 'rate-limit',
      },
      inFlightPlan: fakeInFlightPlan({ codexConnectivity: 'unknown' }),
    },
    runtimeContext: {
      proxyBaseURL: PROXY_BASE_URL,
      openRouterOAuthToken: OPENROUTER_TOKEN,
    },
  },
  {
    name: 'fallback rebuild: codex rate-limit provider falls back to OpenRouter',
    mode: 'dispatchable',
    settings: settings({
      activeProvider: 'codex',
      claude: modelSettings({ apiKey: null }),
      openRouter: {
        enabled: true,
        oauthToken: OPENROUTER_TOKEN,
        selectedModel: 'openai/gpt-5.5',
      },
    }),
    model: 'gpt-5.5',
    role: 'execution',
    fallback: {
      hint: { kind: 'codex-rate-limit-provider', forceNonCodexTransport: true },
      inFlightPlan: fakeInFlightPlan({
        provider: 'codex',
        transport: 'codex-proxy',
        dispatchPath: 'local-proxy-passthrough',
        modelDialect: 'openai-compatible',
        wireModelId: brandRouteWireModel('gpt-5.5'),
        canonicalModelId: 'gpt-5.5',
        codexConnectivity: 'connected',
        credentialSource: 'codex-subscription',
      }),
    },
    runtimeContext: {
      proxyBaseURL: PROXY_BASE_URL,
      openRouterOAuthToken: OPENROUTER_TOKEN,
    },
  },
  {
    name: 'fallback rebuild: codex rate-limit tier uses working fallback',
    mode: 'dispatchable',
    settings: settings({
      activeProvider: 'codex',
      claude: modelSettings({ apiKey: null }),
      models: {
        ...modelSettings(),
        workingFallback: 'model:openai/gpt-5.5-mini',
      },
      openRouter: {
        enabled: true,
        oauthToken: OPENROUTER_TOKEN,
        selectedModel: 'openai/gpt-5.5',
      },
    }),
    model: 'gpt-5.5',
    role: 'execution',
    fallback: {
      hint: { kind: 'codex-rate-limit-tier', tier: 'standard' },
      inFlightPlan: fakeInFlightPlan({
        provider: 'codex',
        transport: 'codex-proxy',
        dispatchPath: 'local-proxy-passthrough',
        modelDialect: 'openai-compatible',
        wireModelId: brandRouteWireModel('gpt-5.5'),
        canonicalModelId: 'gpt-5.5',
        codexConnectivity: 'connected',
        credentialSource: 'codex-subscription',
      }),
    },
    runtimeContext: {
      proxyBaseURL: PROXY_BASE_URL,
      openRouterOAuthToken: OPENROUTER_TOKEN,
    },
  },
  {
    name: 'plan-mode alias: planner raw model at resolver seam',
    mode: 'dispatchable',
    settings: settings({
      models: {
        ...modelSettings(),
        model: 'claude-sonnet-4-20250514',
        thinkingModel: 'claude-opus-4-7',
      },
    }),
    model: PLAN_MODE_ALIAS,
    role: 'planning',
  },
];

describe('provider resolution parity matrix', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('REBEL_DISABLE_CONTEXT_MANAGEMENT', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(cells)('$name', async (cell) => {
    const current = await observeNew(cell);
    expect(current).toMatchSnapshot(cell.name);

    if (cell.mode === 'terminal') {
      expect(current).toEqual(expect.objectContaining({
        status: 'error',
        dispatchPath: 'none',
      }));
      return;
    }

    if (cell.mode === 'new-oracle') {
      return;
    }
  });
});
