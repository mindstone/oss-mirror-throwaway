/**
 * Regression test for REBEL-1C8: BTS client sends model: "default" when profile.model is empty.
 *
 * Bug: callProfileHttp uses `profile.model || 'default'` which sends the literal
 * string "default" to OpenAI when profile.model is empty/undefined. OpenAI rejects
 * this with HTTP 400 (invalid_request). Under EMFILE conditions where config reads
 * fail, this creates a sustained 400-error storm (~150 requests in 2 minutes).
 *
 * Fix: Fail closed — throw a typed error when profile.model is missing, before
 * making the HTTP call.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAuthEnvUtilsMock } from '@core/utils/__tests__/authEnvUtilsMock';
import type { AppSettings } from '@shared/types';

// We need to test the pure validation behavior. callProfileHttp is not exported,
// but callDirectWithProfile is the entry point. We mock fetch to observe what
// model string is sent.

// Mock dependencies
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('@core/services/apiRateLimitCooldown', () => ({
  apiRateLimitCooldown: {
    isActive: () => false,
    isAvailable: () => true,
    remainingMs: () => 0,
    activate: vi.fn(),
    recordRateLimit: vi.fn(),
    recordSuccess: vi.fn(),
  },
  safetyEvalRateLimitCooldown: {
    isActive: () => false,
    isAvailable: () => true,
    remainingMs: () => 0,
    activate: vi.fn(),
    recordRateLimit: vi.fn(),
    recordSuccess: vi.fn(),
  },
}));

vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

 
vi.mock('../codexAuthCore', () => ({
  isCodexConnected: vi.fn(() => false),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => ({
    models: { apiKey: 'test-key' },
    providerKeys: {},
    customProviders: [],
    localModel: { profiles: [] },
  }),
}));

// F1 (plan 260422 routing-follow-ups): mock shape centralised in
// `createAuthEnvUtilsMock`. Defaults match the API-key direct-Anthropic
// baseline this test expects.
vi.mock('@core/utils/authEnvUtils', () => createAuthEnvUtilsMock());

vi.mock('@core/utils/systemUtils', () => ({
  setupNodeEnvironment: vi.fn(),
}));

function makeSettings(profileModel: string): AppSettings {
  return {
    coreDirectory: '/tmp/test',
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: null,
      activationHotkey: null,
      activationHotkeyVoiceMode: true,
    },
    models: {
      apiKey: null,
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-haiku-4-5',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    diagnostics: {
      debugBreadcrumbsUntil: null,
      forceDirectMcp: false,
      developerMode: false,
    },
    providerKeys: { openai: 'fake-test-profile' },
    customProviders: [],
    localModel: {
      profiles: [
        {
          id: 'test-profile',
          name: 'Test Profile',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          model: profileModel,
          createdAt: 0,
        },
      ],
      activeProfileId: 'test-profile',
    },
  };
}

describe('REBEL-1C8: BTS empty model guard', () => {
  it('should not send model: "default" to the provider when profile.model is empty', async () => {
    // Track what body is sent to fetch
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'test' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    // Import after mocks
    const { callWithModelAuthAware } = await import('../behindTheScenesClient');

    const settings = makeSettings(''); // Empty model — this is the bug trigger

    // The function should either throw or NOT send "default" as the model
    let error: Error | undefined;
    try {
      await callWithModelAuthAware(
        settings,
        'profile:test-profile',
        {
          codexConnectivity: 'unknown',
          messages: [{ role: 'user', content: 'test' }],
          maxTokens: 100,
        },
      );
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }

    if (error) {
      // Good path: the function threw before making the call
      expect(error.message).toMatch(/model.*missing|model.*empty|model.*required|model.*configured/i);
    } else {
      // If it didn't throw, verify the sent body doesn't contain "default"
      expect(fetchSpy).toHaveBeenCalled();
      const [, requestInit] = fetchSpy.mock.calls[0];
      const body = JSON.parse(requestInit.body as string);
      expect(body.model).not.toBe('default');
      expect(body.model).toBeTruthy();
    }

    vi.unstubAllGlobals();
  });

  it('should work normally when profile.model is set', async () => {
    const responseBody = JSON.stringify({
      choices: [{ message: { content: 'test response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const fetchSpy = vi.fn().mockResolvedValue(new Response(responseBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const { callWithModelAuthAware } = await import('../behindTheScenesClient');

    const settings = makeSettings('gpt-4o');

    const result = await callWithModelAuthAware(
      settings,
      'profile:test-profile',
      {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 100,
      },
    );

    expect(fetchSpy).toHaveBeenCalled();
    const [, requestInit] = fetchSpy.mock.calls[0];
    const body = JSON.parse(requestInit.body as string);
    expect(body.model).toBe('gpt-4o');

    vi.unstubAllGlobals();
  });
});
