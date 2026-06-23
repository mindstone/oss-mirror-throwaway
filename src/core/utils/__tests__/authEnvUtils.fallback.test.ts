import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveTierFallback,
  getRateLimitFallbackTarget,
} from '@core/utils/authEnvUtils';
import type { ActiveProvider, AppSettings } from '@shared/types';

/** Minimal mock settings for fallback tests. */
function createSettings(overrides: {
  activeProvider?: ActiveProvider;
  thinkingFallback?: string;
  workingFallback?: string;
  openRouterToken?: string;
  openRouterSelectedModel?: string;
  apiKey?: string;
  hasManagedKey?: boolean;
} = {}): AppSettings {
  const models = {
    apiKey: overrides.apiKey ?? null,
    oauthToken: null,
    authMethod: 'api-key',
    model: 'gpt-5.5',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
    thinkingFallback: overrides.thinkingFallback,
    workingFallback: overrides.workingFallback,
  };

  return {
    claude: models,
    models,
    openRouter: {
      enabled: !!overrides.openRouterToken,
      oauthToken: overrides.openRouterToken ?? null,
      selectedModel: overrides.openRouterSelectedModel ?? 'openai/gpt-5.5',
    },
    activeProvider: overrides.activeProvider ?? 'codex',
    hasManagedKey: overrides.hasManagedKey ?? false,
    voice: {} as any,
    coreDirectory: '/test',
    mcpConfigFile: null,
    onboardingCompleted: true,
    appearance: { theme: 'system' },
    privacy: { allowTelemetry: true },
    diagnostics: { sentryEnabled: true } as any,
  } as unknown as AppSettings;
}


describe('resolveTierFallback', () => {
  it('returns null when neither fallback is configured', () => {
    expect(resolveTierFallback(createSettings())).toBeNull();
  });

  it('resolves thinkingFallback with model encoding', () => {
    const result = resolveTierFallback(createSettings({
      thinkingFallback: 'model:claude-sonnet-4-6',
    }));
    expect(result).toEqual({
      modelOverride: 'claude-sonnet-4-6',
      rawValue: 'model:claude-sonnet-4-6',
    });
  });

  it('resolves workingFallback with profile encoding', () => {
    const result = resolveTierFallback(createSettings({
      workingFallback: 'profile:prof_openrouter_1',
    }));
    expect(result).toEqual({
      profileOverrideId: 'prof_openrouter_1',
      rawValue: 'profile:prof_openrouter_1',
    });
  });

  it('prefers thinkingFallback over workingFallback when both set', () => {
    const result = resolveTierFallback(createSettings({
      thinkingFallback: 'model:claude-opus-4-7',
      workingFallback: 'model:claude-sonnet-4-6',
    }));
    expect(result?.rawValue).toBe('model:claude-opus-4-7');
  });

  it('falls through to workingFallback when thinkingFallback is undefined', () => {
    const result = resolveTierFallback(createSettings({
      workingFallback: 'model:claude-sonnet-4-6',
    }));
    expect(result?.rawValue).toBe('model:claude-sonnet-4-6');
  });

  it('returns null for empty model encoding', () => {
    expect(resolveTierFallback(createSettings({
      thinkingFallback: 'model:',
    }))).toBeNull();
  });

  it('returns null for unknown encoding prefix', () => {
    expect(resolveTierFallback(createSettings({
      thinkingFallback: 'unknown:value',
    }))).toBeNull();
  });
});


describe('getRateLimitFallbackTarget', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns null when nothing is configured', () => {
    expect(getRateLimitFallbackTarget(createSettings())).toBeNull();
  });

  it('picks tier fallback when configured (highest priority)', () => {
    const result = getRateLimitFallbackTarget(createSettings({
      thinkingFallback: 'model:claude-sonnet-4-6',
      openRouterToken: 'tok_or',
      apiKey: 'fake-test',
    }));
    expect(result).toEqual({
      kind: 'tier_model',
      modelOverride: 'claude-sonnet-4-6',
      provider: 'anthropic',
      rawValue: 'model:claude-sonnet-4-6',
    });
  });

  it('picks OpenRouter when no tier fallback but OR is configured', () => {
    const result = getRateLimitFallbackTarget(createSettings({
      openRouterToken: 'tok_or',
      openRouterSelectedModel: 'anthropic/claude-opus-4.6',
    }));
    expect(result).toEqual({
      kind: 'provider',
      provider: 'openrouter',
      model: 'anthropic/claude-opus-4.6',
    });
  });

  it('picks Anthropic when no tier fallback and no OpenRouter', () => {
    const result = getRateLimitFallbackTarget(createSettings({
      apiKey: 'fake-ant-test',
    }));
    expect(result).toEqual({
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  it('skips OpenRouter when token exists but no selectedModel', () => {
    const result = getRateLimitFallbackTarget(createSettings({
      openRouterToken: 'tok_or',
      openRouterSelectedModel: '',
      apiKey: 'fake-ant-test',
    }));
    // Should skip OR (no selectedModel) and pick Anthropic
    expect(result).toEqual({
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  it('respects waterfall order: tier > OpenRouter > Anthropic', () => {
    // Only Anthropic configured
    const anthropicOnly = getRateLimitFallbackTarget(createSettings({ apiKey: 'fake-test' }));
    expect(anthropicOnly?.kind).toBe('provider');
    expect((anthropicOnly as any)?.provider).toBe('anthropic');

    // OR + Anthropic both configured → OR wins
    const orAndAnthropic = getRateLimitFallbackTarget(createSettings({
      openRouterToken: 'tok_or',
      apiKey: 'fake-test',
    }));
    expect(orAndAnthropic?.kind).toBe('provider');
    expect((orAndAnthropic as any)?.provider).toBe('openrouter');

    // Tier + OR + Anthropic all configured → tier wins
    const allThree = getRateLimitFallbackTarget(createSettings({
      thinkingFallback: 'profile:prof_1',
      openRouterToken: 'tok_or',
      apiKey: 'fake-test',
    }));
    expect(allThree?.kind).toBe('tier_model');
  });

  it('handles profile-encoded tier fallback', () => {
    const result = getRateLimitFallbackTarget(createSettings({
      workingFallback: 'profile:my_profile_id',
    }));
    expect(result).toEqual({
      kind: 'tier_model',
      profileOverrideId: 'my_profile_id',
      provider: undefined,
      rawValue: 'profile:my_profile_id',
    });
  });

  // Merged from authEnvUtils.inferProvider.test.ts (file deleted). These cases
  // exercise the tier-fallback provider inference branch (authEnvUtils.ts
  // inferTierFallbackProvider). The tier branch does NOT consult
  // activeProvider, so createSettings's hardcoded activeProvider:'codex' is
  // irrelevant to these assertions — they turn purely on the model-ID shape.
  describe('getRateLimitFallbackTarget — provider inference', () => {
    it('infers OpenRouter for OR-format model IDs', () => {
      expect(getRateLimitFallbackTarget(createSettings({ thinkingFallback: 'model:openai/gpt-5.5' }))).toEqual({
        kind: 'tier_model',
        modelOverride: 'openai/gpt-5.5',
        provider: 'openrouter',
        rawValue: 'model:openai/gpt-5.5',
      });
    });

    it('infers Anthropic for Claude-style model IDs', () => {
      expect(getRateLimitFallbackTarget(createSettings({ thinkingFallback: 'model:claude-opus-4-7' }))).toEqual({
        kind: 'tier_model',
        modelOverride: 'claude-opus-4-7',
        provider: 'anthropic',
        rawValue: 'model:claude-opus-4-7',
      });
    });

    it('infers OpenAI for GPT-style model IDs', () => {
      expect(getRateLimitFallbackTarget(createSettings({ thinkingFallback: 'model:gpt-5.5' }))).toEqual({
        kind: 'tier_model',
        modelOverride: 'gpt-5.5',
        provider: 'openai',
        rawValue: 'model:gpt-5.5',
      });
    });

    it('leaves provider undefined for unknown model IDs', () => {
      expect(getRateLimitFallbackTarget(createSettings({ thinkingFallback: 'model:unknown-model' }))).toEqual({
        kind: 'tier_model',
        modelOverride: 'unknown-model',
        provider: undefined,
        rawValue: 'model:unknown-model',
      });
    });
  });

  it('characterizes the Codex rate-limit waterfall across provider and credential states', () => {
    // CHARACTERIZATION: documents current behavior, not necessarily desired.
    // The waterfall ignores activeProvider and hasManagedKey; tier fallback wins
    // first, then OpenRouter credentials, then Anthropic direct auth.
    const cases = [
      {
        name: 'codex tier fallback gpt-style divergent provider inference',
        settings: createSettings({
          activeProvider: 'codex',
          thinkingFallback: 'model:gpt-5.5',
          openRouterToken: 'tok-or',
          apiKey: 'anthropic-key',
        }),
      },
      {
        name: 'mindstone managed key without tier or BYOK fallback',
        settings: createSettings({
          activeProvider: 'mindstone',
          hasManagedKey: true,
        }),
      },
      {
        name: 'openrouter credentials win before direct Anthropic',
        settings: createSettings({
          activeProvider: 'anthropic',
          openRouterToken: 'tok-or',
          openRouterSelectedModel: 'anthropic/claude-opus-4.7',
          apiKey: 'anthropic-key',
        }),
      },
      {
        name: 'openrouter selectedModel missing falls through to Anthropic direct',
        settings: createSettings({
          activeProvider: 'openrouter',
          openRouterToken: 'tok-or',
          openRouterSelectedModel: '',
          apiKey: 'anthropic-key',
        }),
      },
      {
        name: 'anthropic direct auth final fallback',
        settings: createSettings({
          activeProvider: 'codex',
          apiKey: 'anthropic-key',
        }),
      },
      {
        name: 'profile tier fallback has no inferred provider',
        settings: createSettings({
          activeProvider: 'codex',
          workingFallback: 'profile:backup-profile',
          openRouterToken: 'tok-or',
          apiKey: 'anthropic-key',
        }),
      },
    ];

    expect(cases.map(({ name, settings }) => ({
      name,
      activeProvider: settings.activeProvider,
      target: getRateLimitFallbackTarget(settings),
    }))).toMatchInlineSnapshot(`
      [
        {
          "activeProvider": "codex",
          "name": "codex tier fallback gpt-style divergent provider inference",
          "target": {
            "kind": "tier_model",
            "modelOverride": "gpt-5.5",
            "provider": "openai",
            "rawValue": "model:gpt-5.5",
          },
        },
        {
          "activeProvider": "mindstone",
          "name": "mindstone managed key without tier or BYOK fallback",
          "target": null,
        },
        {
          "activeProvider": "anthropic",
          "name": "openrouter credentials win before direct Anthropic",
          "target": {
            "kind": "provider",
            "model": "anthropic/claude-opus-4.7",
            "provider": "openrouter",
          },
        },
        {
          "activeProvider": "openrouter",
          "name": "openrouter selectedModel missing falls through to Anthropic direct",
          "target": {
            "kind": "provider",
            "model": "claude-sonnet-4-6",
            "provider": "anthropic",
          },
        },
        {
          "activeProvider": "codex",
          "name": "anthropic direct auth final fallback",
          "target": {
            "kind": "provider",
            "model": "claude-sonnet-4-6",
            "provider": "anthropic",
          },
        },
        {
          "activeProvider": "codex",
          "name": "profile tier fallback has no inferred provider",
          "target": {
            "kind": "tier_model",
            "profileOverrideId": "backup-profile",
            "provider": undefined,
            "rawValue": "profile:backup-profile",
          },
        },
      ]
    `);
  });
});
