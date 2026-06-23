/**
 * Golden-pin safety net for createClientForModel().
 *
 * This intentionally observes the public facade, not resolveTargetForModel() or
 * the route-plan path. Stage 3.2 will rewire the facade; this snapshot captures
 * today's legacy-backed ModelClient construction surface so deliberate provider
 * integrity flips are easy to review.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { PREFERRED_PLANNING_MODEL } from '@shared/utils/modelNormalization';

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

import { createClientForModel, type CreateClientForModelOptions } from '../clientFactory';
import type { CodexModeConfig } from '../codexModeTypes';
import {
  CODEX_ACCESS_TOKEN,
  OPENROUTER_TOKEN,
  PROXY_AUTH_TOKEN,
  PROXY_BASE_URL,
  authShapeFromConfig,
  commonProxyHeaders,
  isCapturedClient,
  modelSettings,
  profile,
  settings,
} from './helpers/providerResolutionHarness';

type FacadeClientConfig = {
  clientKind: 'anthropic' | 'openai';
  providerLabel: string | null;
  providerType: string | null;
  baseURL: string | null;
  endpointURL: string | null;
  authShape: ReturnType<typeof authShapeFromConfig>;
  defaultHeaders: Record<string, string>;
  maxRetries: number | null;
  enableContextManagement: boolean | null;
  codexModePresent: boolean;
};

type CriticalExpectation =
  | 'managed-openrouter-proxy'
  | 'byok-openrouter-direct'
  | 'bare-proxy'
  | 'codex-subscription-proxy';

type FacadeCase = {
  name: string;
  options: CreateClientForModelOptions;
  criticalExpectation?: CriticalExpectation;
};

const codexMode: CodexModeConfig = {
  endpointUrl: 'https://chatgpt.com/backend-api/codex',
  getAccessToken: vi.fn(async () => CODEX_ACCESS_TOKEN),
  getAccountId: vi.fn(() => 'codex-account'),
  forceRefreshToken: vi.fn(async () => `${CODEX_ACCESS_TOKEN}-refreshed`),
};

const directAnthropicSettings = settings({
  experimental: { compactEnabled: true },
});

const openRouterTurnSettings = settings({
  activeProvider: 'openrouter',
  claude: modelSettings({ apiKey: null }),
  openRouter: {
    enabled: true,
    oauthToken: OPENROUTER_TOKEN,
    selectedModel: 'anthropic/claude-opus-4-7',
  },
});

const managedOpenRouterSettings = settings({
  openRouter: {
    enabled: true,
    oauthToken: OPENROUTER_TOKEN,
    selectedModel: 'openai/gpt-5.5',
  },
});

const byokOpenRouterSettings = settings({
  providerKeys: { openrouter: 'openrouter-provider-key-byok' },
  openRouter: {
    enabled: true,
    oauthToken: null,
    selectedModel: 'openai/gpt-5.5',
  },
});

const codexSubscriptionSettings = settings();

const openRouterProxyConfig = {
  baseURL: PROXY_BASE_URL,
  defaultHeaders: {
    ...commonProxyHeaders(),
    authorization: `Bearer ${OPENROUTER_TOKEN}`,
    'http-referer': 'https://rebel.mindstone.com',
    'x-openrouter-turn': 'true',
    'x-title': 'Rebel',
  },
};

const anthropicProxyConfig = {
  baseURL: PROXY_BASE_URL,
  defaultHeaders: commonProxyHeaders(),
};

const routeTableProxyConfig = {
  baseURL: PROXY_BASE_URL,
  defaultHeaders: {
    ...commonProxyHeaders(),
    'x-proxy-auth': PROXY_AUTH_TOKEN,
    'x-routed-model': 'claude-sonnet-4-20250514',
    'x-routed-turn-id': 'turn-facade-route-table',
  },
};

const localProfile = profile({
  id: 'local-profile',
  name: 'Local profile',
  providerType: 'local',
  routeSurface: 'local',
  serverUrl: 'http://localhost:11434/v1',
  model: 'llama-3.1-local',
  apiKey: undefined,
});

const cloudProfile = profile({
  id: 'cloud-profile',
  name: 'Cloud OpenAI-compatible profile',
  providerType: 'together',
  serverUrl: 'https://api.together.xyz/v1',
  model: 'deepseek-chat',
  apiKey: 'together-test-key',
});

const googleProfile = profile({
  id: 'google-profile',
  name: 'Google profile',
  providerType: 'google',
  serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  model: 'gemini-2.5-pro',
  apiKey: 'google-profile-key',
});

const codexSubscriptionProfile = profile({
  id: 'codex-subscription-profile',
  name: 'Codex subscription profile',
  authSource: 'codex-subscription',
  routeSurface: 'subscription',
  profileSource: 'connection',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  apiKey: undefined,
});

const managedOpenRouterProfile = profile({
  id: 'or-connection-profile-managed',
  name: 'OpenRouter managed connection profile',
  providerType: 'openrouter',
  routeSurface: 'pool',
  profileSource: 'connection',
  serverUrl: 'https://openrouter.ai/api/v1',
  model: 'openai/gpt-5.5',
  apiKey: undefined,
});

const byokOpenRouterProfile = profile({
  id: 'or_connection_profile_provider_key_byok',
  name: 'OpenRouter BYOK connection profile',
  providerType: 'openrouter',
  routeSurface: 'pool',
  profileSource: 'connection',
  serverUrl: 'https://openrouter.ai/api/v1',
  model: 'openai/gpt-5.5',
  apiKey: undefined,
});

const profileSettings = (...profiles: ModelProfile[]): AppSettings => settings({
  localModel: { activeProfileId: null, profiles },
});

function explicitProfileCase(
  name: string,
  context: CreateClientForModelOptions['context'],
  modelProfile: ModelProfile,
  profileSettingsForCase: AppSettings,
  criticalExpectation?: CriticalExpectation,
  proxyConfig: CreateClientForModelOptions['proxyConfig'] = openRouterProxyConfig,
): FacadeCase {
  return {
    name,
    options: {
      model: modelProfile.model ?? name,
      profile: modelProfile,
      settings: profileSettingsForCase,
      proxyConfig,
      context,
      codexMode,
    },
    criticalExpectation,
  };
}

const facadeCases: FacadeCase[] = [
  {
    name: 'execution / anthropic-direct',
    options: {
      model: 'claude-sonnet-4-20250514',
      settings: directAnthropicSettings,
      proxyConfig: null,
      context: 'execution',
      codexMode,
    },
  },
  {
    name: 'execution / anthropic-via-proxy turn-router',
    // MUST-PRESERVE: bare model + proxyConfig stays proxied through the turn router.
    criticalExpectation: 'bare-proxy',
    options: {
      model: 'anthropic/claude-opus-4-7',
      settings: openRouterTurnSettings,
      proxyConfig: openRouterProxyConfig,
      context: 'execution',
      codexMode,
    },
  },
  {
    name: 'execution / route-table-header proxyConfig',
    options: {
      model: 'claude-sonnet-4-20250514',
      settings: directAnthropicSettings,
      proxyConfig: routeTableProxyConfig,
      context: 'execution',
      codexMode,
    },
  },
  {
    name: 'planning / anthropic-direct',
    options: {
      model: 'claude-opus-4-7',
      settings: directAnthropicSettings,
      proxyConfig: null,
      context: 'planning',
      codexMode,
    },
  },
  {
    name: 'planning / anthropic-via-proxy turn-router',
    // MUST-PRESERVE: bare model + proxyConfig stays proxied through the turn router.
    criticalExpectation: 'bare-proxy',
    options: {
      model: 'anthropic/claude-opus-4-7',
      settings: openRouterTurnSettings,
      proxyConfig: openRouterProxyConfig,
      context: 'planning',
      codexMode,
    },
  },
  explicitProfileCase(
    'routed-execution / google-thought-signatures',
    'routed-execution',
    googleProfile,
    profileSettings(googleProfile),
    undefined,
    anthropicProxyConfig,
  ),
  explicitProfileCase(
    'routed-execution / openai-compatible local',
    'routed-execution',
    localProfile,
    profileSettings(localProfile),
  ),
  explicitProfileCase(
    'routed-execution / openai-compatible cloud',
    'routed-execution',
    cloudProfile,
    profileSettings(cloudProfile),
  ),
  explicitProfileCase(
    'routed-execution / codex-subscription connected',
    // EXPECTED-CHANGE@3.2: codex-subscription flips direct->codex-proxy (verified byte-equivalent).
    'routed-execution',
    codexSubscriptionProfile,
    profileSettings(codexSubscriptionProfile),
    'codex-subscription-proxy',
  ),
  explicitProfileCase(
    'routed-execution / openrouter connection-MANAGED',
    // EXPECTED-CHANGE@3.2: managed-OpenRouter explicit profile flips direct->proxy (intended).
    'routed-execution',
    managedOpenRouterProfile,
    managedOpenRouterSettings,
    'managed-openrouter-proxy',
  ),
  explicitProfileCase(
    'routed-execution / openrouter connection-BYOK',
    // MUST-PRESERVE: BYOK OpenRouter explicit profile stays direct.
    'routed-execution',
    byokOpenRouterProfile,
    byokOpenRouterSettings,
    'byok-openrouter-direct',
  ),
  explicitProfileCase(
    'escalated-execution / openai-compatible cloud',
    'escalated-execution',
    cloudProfile,
    profileSettings(cloudProfile),
  ),
  explicitProfileCase(
    'escalated-execution / codex-subscription connected',
    // EXPECTED-CHANGE@3.2: codex-subscription flips direct->codex-proxy (verified byte-equivalent).
    'escalated-execution',
    codexSubscriptionProfile,
    profileSettings(codexSubscriptionProfile),
    'codex-subscription-proxy',
  ),
  explicitProfileCase(
    'escalated-execution / openrouter connection-MANAGED',
    // EXPECTED-CHANGE@3.2: managed-OpenRouter explicit profile flips direct->proxy (intended).
    'escalated-execution',
    managedOpenRouterProfile,
    managedOpenRouterSettings,
    'managed-openrouter-proxy',
  ),
  explicitProfileCase(
    'escalated-execution / openrouter connection-BYOK',
    // MUST-PRESERVE: BYOK OpenRouter explicit profile stays direct.
    'escalated-execution',
    byokOpenRouterProfile,
    byokOpenRouterSettings,
    'byok-openrouter-direct',
  ),
  explicitProfileCase(
    'overflow-fallback-profile / google-thought-signatures',
    'execution',
    googleProfile,
    profileSettings(googleProfile),
    undefined,
    anthropicProxyConfig,
  ),
  explicitProfileCase(
    'overflow-fallback-profile / codex-subscription connected',
    // EXPECTED-CHANGE@3.2: codex-subscription flips direct->codex-proxy (verified byte-equivalent).
    'execution',
    codexSubscriptionProfile,
    profileSettings(codexSubscriptionProfile),
    'codex-subscription-proxy',
  ),
  explicitProfileCase(
    'overflow-fallback-profile / openrouter connection-MANAGED',
    // EXPECTED-CHANGE@3.2: managed-OpenRouter explicit profile flips direct->proxy (intended).
    'execution',
    managedOpenRouterProfile,
    managedOpenRouterSettings,
    'managed-openrouter-proxy',
  ),
  explicitProfileCase(
    'overflow-fallback-profile / openrouter connection-BYOK',
    // MUST-PRESERVE: BYOK OpenRouter explicit profile stays direct.
    'execution',
    byokOpenRouterProfile,
    byokOpenRouterSettings,
    'byok-openrouter-direct',
  ),
  {
    name: 'overflow-fallback-model / anthropic-via-proxy turn-router',
    // MUST-PRESERVE: bare model + proxyConfig stays proxied through the turn router.
    criticalExpectation: 'bare-proxy',
    options: {
      model: 'anthropic/claude-haiku-4-5',
      settings: openRouterTurnSettings,
      proxyConfig: openRouterProxyConfig,
      context: 'execution',
      codexMode,
    },
  },
  {
    name: 'preflight-active-profile / openrouter connection-MANAGED',
    // EXPECTED-CHANGE@3.2: managed-OpenRouter explicit profile flips direct->proxy (intended).
    criticalExpectation: 'managed-openrouter-proxy',
    options: {
      model: managedOpenRouterProfile.model!,
      profile: managedOpenRouterProfile,
      settings: managedOpenRouterSettings,
      proxyConfig: openRouterProxyConfig,
      codexMode,
    },
  },
  {
    name: 'preflight-active-profile / codex-subscription connected',
    // EXPECTED-CHANGE@3.2: codex-subscription flips direct->codex-proxy (verified byte-equivalent).
    criticalExpectation: 'codex-subscription-proxy',
    options: {
      model: codexSubscriptionProfile.model!,
      profile: codexSubscriptionProfile,
      settings: codexSubscriptionSettings,
      proxyConfig: openRouterProxyConfig,
      codexMode,
    },
  },
  {
    name: 'preflight-thinking-profile / google-thought-signatures',
    options: {
      model: googleProfile.model!,
      profile: googleProfile,
      settings: profileSettings(googleProfile),
      proxyConfig: null,
      codexMode,
    },
  },
  {
    name: 'preflight-thinking-profile / openrouter connection-BYOK',
    // MUST-PRESERVE: BYOK OpenRouter explicit profile stays direct.
    criticalExpectation: 'byok-openrouter-direct',
    options: {
      model: byokOpenRouterProfile.model!,
      profile: byokOpenRouterProfile,
      settings: byokOpenRouterSettings,
      proxyConfig: null,
      codexMode,
    },
  },
  {
    name: 'preflight-planning-fallback / preferred planning model',
    options: {
      model: PREFERRED_PLANNING_MODEL,
      settings: directAnthropicSettings,
      proxyConfig: null,
    },
  },
  {
    name: 'preflight-bare-claude / direct claude',
    options: {
      model: 'claude-sonnet-4-20250514',
      settings: directAnthropicSettings,
      proxyConfig: null,
    },
  },
];

function stableHeaders(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, string>)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function observeFacade(options: CreateClientForModelOptions): Promise<FacadeClientConfig> {
  const client = await createClientForModel(options);
  if (!isCapturedClient(client)) {
    throw new Error('createClientForModel did not return a captured test client');
  }
  return {
    clientKind: client.__clientKind,
    providerLabel: typeof client.config.provider === 'string' ? client.config.provider : null,
    providerType: typeof client.config.providerType === 'string' ? client.config.providerType : null,
    baseURL: typeof client.config.baseURL === 'string' ? client.config.baseURL : null,
    endpointURL: typeof client.config.endpointURL === 'string' ? client.config.endpointURL : null,
    authShape: authShapeFromConfig(client.config),
    defaultHeaders: stableHeaders(client.config.defaultHeaders),
    maxRetries: typeof client.config.maxRetries === 'number' ? client.config.maxRetries : null,
    enableContextManagement: typeof client.config.enableContextManagement === 'boolean'
      ? client.config.enableContextManagement
      : null,
    codexModePresent: Boolean(client.config.codexMode),
  };
}

function assertCriticalExpectation(observed: FacadeClientConfig, expectation: CriticalExpectation): void {
  switch (expectation) {
    case 'managed-openrouter-proxy':
      expect(observed).toEqual(expect.objectContaining({
        clientKind: 'anthropic',
        providerLabel: 'OpenRouter',
        providerType: null,
        baseURL: PROXY_BASE_URL,
        authShape: 'proxy-sentinel',
      }));
      expect(observed.defaultHeaders).toEqual(expect.objectContaining({
        'x-openrouter-turn': 'true',
      }));
      break;
    case 'byok-openrouter-direct':
      expect(observed).toEqual(expect.objectContaining({
        clientKind: 'openai',
        providerLabel: 'OpenRouter',
        providerType: 'other',
        baseURL: 'https://openrouter.ai/api/v1',
        authShape: 'real-key',
      }));
      expect(observed.defaultHeaders).toEqual({});
      break;
    case 'bare-proxy':
      expect(observed).toEqual(expect.objectContaining({
        clientKind: 'anthropic',
        baseURL: PROXY_BASE_URL,
        authShape: 'proxy-sentinel',
        enableContextManagement: true,
      }));
      break;
    case 'codex-subscription-proxy':
      expect(observed).toEqual(expect.objectContaining({
        clientKind: 'anthropic',
        providerLabel: 'ChatGPT Pro',
        providerType: null,
        baseURL: PROXY_BASE_URL,
        authShape: 'proxy-sentinel',
        codexModePresent: false,
      }));
      expect(observed.defaultHeaders).toEqual(expect.objectContaining({
        authorization: `Bearer ${CODEX_ACCESS_TOKEN}`,
        'x-codex-turn': 'true',
      }));
      break;
  }
}

describe('createClientForModel facade parity golden', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('REBEL_DISABLE_CONTEXT_MANAGEMENT', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('pins facade output by fixture name', async () => {
    const observations: Record<string, FacadeClientConfig> = {};
    for (const facadeCase of facadeCases) {
      const observed = await observeFacade(facadeCase.options);
      observations[facadeCase.name] = observed;
      if (facadeCase.criticalExpectation) {
        assertCriticalExpectation(observed, facadeCase.criticalExpectation);
      }
    }
    expect(observations).toMatchSnapshot();
  });
});
