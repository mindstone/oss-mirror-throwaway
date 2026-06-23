import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { registerManagedKeyAvailability } from '../managedKeyAvailability';
import { ProviderRouter } from '../providerRouting';
import type { DispatchPath, ProviderRouteDecision, ProviderRouteTransport } from '../providerRouteDecision';

type ActiveProvider = 'anthropic' | 'openrouter' | 'mindstone';

interface ExpectedRoute {
  provider: ProviderRouteDecision['provider'];
  transport: ProviderRouteTransport;
  dispatchPath: DispatchPath;
  credentialSource: ProviderRouteDecision['credentialSource'];
  invalidReason: ProviderRouteDecision['invalidReason'];
}

interface PrecedenceRow {
  name: string;
  postmortem: '260531' | '260421' | '260601' | 'control';
  router: 'forBTS' | 'forTurn';
  activeProvider: ActiveProvider;
  model?: string | null;
  openRouterToken?: string | null;
  anthropicApiKey?: string | null;
  hasManagedKey?: boolean;
  profile?: ModelProfile | null;
  providerKeys?: AppSettings['providerKeys'];
  expected: ExpectedRoute;
}

function connectionManagedOpenRouterProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'or-managed-profile',
    name: 'OpenRouter managed connection',
    providerType: 'openrouter',
    profileSource: 'connection',
    serverUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-haiku-4-5',
    enabled: true,
    createdAt: 1,
    ...overrides,
  } as ModelProfile;
}

function settings(row: PrecedenceRow): AppSettings {
  return {
    activeProvider: row.activeProvider,
    models: {
      apiKey: row.anthropicApiKey ?? null,
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
    },
    openRouter: {
      enabled: row.activeProvider === 'openrouter' || row.activeProvider === 'mindstone',
      oauthToken: row.openRouterToken ?? null,
      selectedModel: 'anthropic/claude-haiku-4-5',
    },
    localModel: {
      activeProfileId: null,
      profiles: row.profile ? [row.profile] : [],
    },
    providerKeys: row.providerKeys ?? {},
    customProviders: [],
    hasManagedKey: row.hasManagedKey,
  } as unknown as AppSettings;
}

function expectRoute(decision: ProviderRouteDecision, expected: ExpectedRoute): void {
  expect(decision.provider).toBe(expected.provider);
  expect(decision.transport).toBe(expected.transport);
  expect(decision.dispatchPath).toBe(expected.dispatchPath);
  expect(decision.credentialSource).toBe(expected.credentialSource);
  expect(decision.invalidReason).toBe(expected.invalidReason);
}

describe('ProviderRouter OpenRouter routing precedence matrix', () => {
  afterEach(() => {
    registerManagedKeyAvailability(() => false);
  });

  const managedProfile = connectionManagedOpenRouterProfile();
  const byokOpenRouterProfile = connectionManagedOpenRouterProfile({
    id: 'or-byok-profile',
    name: 'OpenRouter BYOK profile',
    apiKey: 'profile-or-key',
  });

  const rows: PrecedenceRow[] = [
    {
      name: 'PM260531: OpenRouter active + lingering Anthropic key still routes BTS through OpenRouter proxy',
      postmortem: '260531',
      router: 'forBTS',
      activeProvider: 'openrouter',
      model: 'claude-haiku-4-5',
      openRouterToken: 'or-oauth-token',
      anthropicApiKey: 'fake-anthropic-lingering-key',
      hasManagedKey: true,
      expected: {
        provider: 'openrouter',
        transport: 'openrouter-proxy',
        dispatchPath: 'local-proxy-passthrough',
        credentialSource: 'openrouter-oauth-token',
        invalidReason: 'none',
      },
    },
    {
      name: 'PM260531: OpenRouter active + slash Claude model keeps BTS on OpenRouter proxy',
      postmortem: '260531',
      router: 'forBTS',
      activeProvider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      openRouterToken: 'or-oauth-token',
      anthropicApiKey: 'fake-anthropic-lingering-key',
      hasManagedKey: true,
      expected: {
        provider: 'openrouter',
        transport: 'openrouter-proxy',
        dispatchPath: 'local-proxy-passthrough',
        credentialSource: 'openrouter-oauth-token',
        invalidReason: 'none',
      },
    },
    {
      name: 'PM260531: OpenRouter active + selected-model fallback keeps BTS on OpenRouter proxy',
      postmortem: '260531',
      router: 'forBTS',
      activeProvider: 'openrouter',
      model: null,
      openRouterToken: 'or-oauth-token',
      anthropicApiKey: 'fake-anthropic-lingering-key',
      hasManagedKey: true,
      expected: {
        provider: 'openrouter',
        transport: 'openrouter-proxy',
        dispatchPath: 'local-proxy-passthrough',
        credentialSource: 'openrouter-oauth-token',
        invalidReason: 'none',
      },
    },
    {
      name: 'PM260421: OpenRouter active + missing token fails closed even with lingering Anthropic key',
      postmortem: '260421',
      router: 'forTurn',
      activeProvider: 'openrouter',
      model: 'claude-haiku-4-5',
      openRouterToken: null,
      anthropicApiKey: 'fake-anthropic-lingering-key',
      hasManagedKey: true,
      expected: {
        provider: 'openrouter',
        transport: 'no-credentials',
        dispatchPath: 'none',
        credentialSource: 'missing-openrouter',
        invalidReason: 'missing-openrouter-credentials',
      },
    },
    {
      name: 'PM260421: OpenRouter active + selected model + missing token fails closed before Anthropic fallback',
      postmortem: '260421',
      router: 'forTurn',
      activeProvider: 'openrouter',
      model: null,
      openRouterToken: null,
      anthropicApiKey: 'fake-anthropic-lingering-key',
      hasManagedKey: false,
      expected: {
        provider: 'openrouter',
        transport: 'no-credentials',
        dispatchPath: 'none',
        credentialSource: 'missing-openrouter',
        invalidReason: 'missing-openrouter-credentials',
      },
    },
    {
      name: 'PM260421: setting-driven OpenRouter ignores providerKeys.openrouter when shared OAuth is missing',
      postmortem: '260421',
      router: 'forTurn',
      activeProvider: 'openrouter',
      model: 'claude-haiku-4-5',
      openRouterToken: null,
      anthropicApiKey: 'fake-anthropic-lingering-key',
      providerKeys: { openrouter: 'profile-byok-should-not-mask-shared-oauth' },
      hasManagedKey: false,
      expected: {
        provider: 'openrouter',
        transport: 'no-credentials',
        dispatchPath: 'none',
        credentialSource: 'missing-openrouter',
        invalidReason: 'missing-openrouter-credentials',
      },
    },
    {
      name: 'PM260531: Mindstone active + managed key ignores lingering personal/Anthropic credentials',
      postmortem: '260531',
      router: 'forBTS',
      activeProvider: 'mindstone',
      model: 'deepseek/deepseek-chat-v3-0324',
      openRouterToken: 'or-personal-token',
      anthropicApiKey: 'fake-anthropic-lingering-key',
      hasManagedKey: true,
      expected: {
        provider: 'openrouter',
        transport: 'openrouter-proxy',
        dispatchPath: 'local-proxy-passthrough',
        credentialSource: 'mindstone-managed-key',
        invalidReason: 'none',
      },
    },
    {
      name: 'PM260421: Mindstone active + missing managed key fails closed despite personal/Anthropic credentials',
      postmortem: '260421',
      router: 'forBTS',
      activeProvider: 'mindstone',
      model: 'deepseek/deepseek-chat-v3-0324',
      openRouterToken: 'or-personal-token',
      anthropicApiKey: 'fake-anthropic-lingering-key',
      hasManagedKey: false,
      expected: {
        provider: 'openrouter',
        transport: 'no-credentials',
        dispatchPath: 'none',
        credentialSource: 'missing-mindstone',
        invalidReason: 'missing-mindstone-credentials',
      },
    },
    {
      name: 'control: Anthropic active keeps native Claude BTS on direct Anthropic even when OpenRouter credentials exist',
      postmortem: 'control',
      router: 'forBTS',
      activeProvider: 'anthropic',
      model: 'claude-haiku-4-5',
      openRouterToken: 'or-oauth-token',
      anthropicApiKey: 'fake-anthropic-active-key',
      hasManagedKey: true,
      expected: {
        provider: 'anthropic',
        transport: 'anthropic-direct',
        dispatchPath: 'direct-provider',
        credentialSource: 'anthropic-api-key',
        invalidReason: 'none',
      },
    },
    {
      name: 'PM260601: explicit connection-managed OpenRouter profile routes through proxy via shared OAuth',
      postmortem: '260601',
      router: 'forTurn',
      activeProvider: 'anthropic',
      model: `profile:${managedProfile.id}`,
      openRouterToken: 'or-oauth-token',
      anthropicApiKey: 'fake-anthropic-lingering-key',
      hasManagedKey: false,
      profile: managedProfile,
      expected: {
        provider: 'openrouter',
        transport: 'openrouter-proxy',
        dispatchPath: 'local-proxy-passthrough',
        credentialSource: 'openrouter-oauth-token',
        invalidReason: 'none',
      },
    },
    {
      name: 'PM260421: explicit connection-managed OpenRouter profile fails closed without shared OAuth',
      postmortem: '260421',
      router: 'forTurn',
      activeProvider: 'anthropic',
      model: `profile:${managedProfile.id}`,
      openRouterToken: null,
      anthropicApiKey: 'fake-anthropic-lingering-key',
      hasManagedKey: false,
      profile: managedProfile,
      expected: {
        provider: 'openrouter',
        transport: 'no-credentials',
        dispatchPath: 'none',
        credentialSource: 'missing-openrouter',
        invalidReason: 'missing-openrouter-credentials',
      },
    },
    {
      name: 'control: explicit OpenRouter BYOK profile is direct profile transport, not managed proxy',
      postmortem: 'control',
      router: 'forTurn',
      activeProvider: 'anthropic',
      model: `profile:${byokOpenRouterProfile.id}`,
      openRouterToken: null,
      anthropicApiKey: 'fake-anthropic-lingering-key',
      hasManagedKey: false,
      profile: byokOpenRouterProfile,
      expected: {
        provider: 'profile',
        transport: 'openai-compatible-http',
        dispatchPath: 'direct-provider',
        credentialSource: 'profile-api-key',
        invalidReason: 'none',
      },
    },
  ];

  it.each(rows)('$name', (row) => {
    const baseInput = {
      settings: settings(row),
      model: row.model,
      profile: row.profile,
    };
    const decision = row.router === 'forBTS'
      ? ProviderRouter.forBTS({
        codexConnectivity: 'unknown', ...baseInput, category: 'routing-precedence-contract' })
      : ProviderRouter.forTurn({
        codexConnectivity: 'unknown', ...baseInput, role: 'execution' });

    expectRoute(decision, row.expected);
  });
});
