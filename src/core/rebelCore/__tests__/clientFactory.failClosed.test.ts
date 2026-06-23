import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import {
  ConnectionNotConfiguredError,
  createClientForModel,
} from '../clientFactory';
import type { CodexModeConfig } from '../codexModeTypes';

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: '/tmp/rebel',
    models: {
      model: 'claude-sonnet-4-5',
      thinkingModel: null,
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: false,
      thinkingEffort: 'medium',
      apiKey: 'fake-ant-test',
      longContextFallbackModel: null,
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    localModel: { activeProfileId: null, profiles: [] },
    providerKeys: {},
    ...overrides,
  } as AppSettings;
}

function makeProfile(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    id: 'profile-1',
    name: 'Connection profile',
    providerType: 'openrouter',
    routeSurface: 'pool',
    serverUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-5.5',
    createdAt: 1,
    profileSource: 'connection',
    ...overrides,
  };
}

const codexMode: CodexModeConfig = {
  endpointUrl: 'https://chatgpt.com/backend-api/codex',
  getAccessToken: vi.fn(async () => 'codex-token'),
  getAccountId: vi.fn(() => 'org_123'),
  forceRefreshToken: vi.fn(async () => 'codex-token-refreshed'),
};

describe('clientFactory fail-closed connection profiles', () => {
  it('throws a connection-specific auth error when a connection profile has no credentials', async () => {
    const profile = makeProfile({});

    await expect(
      createClientForModel({
        model: profile.model!,
        profile,
        settings: makeSettings(),
      }),
    ).rejects.toThrow(ConnectionNotConfiguredError);
    await expect(
      createClientForModel({
        model: profile.model!,
        profile,
        settings: makeSettings(),
      }),
    ).rejects.toThrow('OpenRouter needs reconnecting. Sign in again in Settings to continue.');
    try {
      await createClientForModel({
        model: profile.model!,
        profile,
        settings: makeSettings(),
      });
      throw new Error('Expected createClientForModel to reject');
    } catch (error) {
      expect((error as { __agentErrorKind?: string }).__agentErrorKind).toBe('connection-not-configured');
    }
  });

  it('preserves existing user-added missing-key behavior', async () => {
    const profile = makeProfile({
      profileSource: 'user',
      providerType: 'openai',
      routeSurface: 'api-key',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
    });

    await expect(
      createClientForModel({
        model: profile.model!,
        profile,
        settings: makeSettings(),
      }),
    ).rejects.toThrow('This profile is missing a working API key. Add or update it in Settings to continue.');
  });

  it('dispatches a connection profile when credentials are present', async () => {
    const profile = makeProfile({});

    // Managed-OpenRouter connection profiles now route through the local proxy (openrouter-proxy) — full proxy-dispatch behaviour is pinned by the EXPECTED-CHANGE@3.2 cells in clientFactory.facadeParity.test.ts.
    await expect(createClientForModel({
      model: profile.model!,
      profile,
      settings: makeSettings({
        openRouter: { oauthToken: 'or-token', enabled: true },
      } as Partial<AppSettings>),
    })).rejects.toThrow(/local model proxy is not available/);
  });

  it('asks users to reconnect ChatGPT Pro when a subscription profile has no session', async () => {
    const profile = makeProfile({
      providerType: 'openai',
      routeSurface: 'subscription',
      authSource: 'codex-subscription',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
    });

    await expect(
      createClientForModel({
        model: profile.model!,
        profile,
        settings: makeSettings(),
      }),
    ).rejects.toThrow('ChatGPT Pro needs reconnecting. Sign in again in Settings to continue.');
  });

  it('fails closed for Codex auto profiles without a Codex session', async () => {
    const profile = makeProfile({
      providerType: 'openai',
      routeSurface: 'subscription',
      authSource: 'codex-subscription',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
      profileSource: 'auto',
    });

    await expect(
      createClientForModel({
        model: profile.model!,
        profile,
        settings: makeSettings({
          providerKeys: { openai: 'fake-shared-openai-key' },
        } as Partial<AppSettings>),
      }),
    ).rejects.toThrow(ConnectionNotConfiguredError);
  });

  it('dispatches a ChatGPT Pro subscription profile when codexMode is present', async () => {
    const profile = makeProfile({
      providerType: 'openai',
      routeSurface: 'subscription',
      authSource: 'codex-subscription',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
    });

    // Codex subscription profiles now route through the local proxy (codex-proxy); full proxy-dispatch behaviour is pinned by the EXPECTED-CHANGE@3.2 cells in clientFactory.facadeParity.test.ts.
    await expect(createClientForModel({
      model: profile.model!,
      profile,
      settings: makeSettings(),
      codexMode,
    })).rejects.toThrow(/local model proxy is not available/);
  });
});
