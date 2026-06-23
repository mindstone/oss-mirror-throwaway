 
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';

const messagesCreateMock = vi.hoisted(() => vi.fn());

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

vi.mock('@core/utils/systemUtils', () => ({
  setupNodeEnvironment: vi.fn().mockResolvedValue('/usr/bin'),
}));

vi.mock('../codexAuthCore', () => ({
  isCodexConnected: vi.fn(() => false),
}));

vi.mock('@core/utils/authEnvUtils', () => ({
  isUsingOpenRouter: vi.fn().mockReturnValue(false),
  isUsingOAuth: vi.fn().mockReturnValue(false),
  hasValidAuth: vi.fn().mockReturnValue(true),
  isDirectAnthropicConfig: vi.fn().mockReturnValue(true),
  getAuthEnvVars: vi.fn().mockReturnValue({}),
}));

vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
  class MockAnthropic {
    static RateLimitError = actual.RateLimitError;
    messages = { create: messagesCreateMock };
  }

  return {
    ...actual,
    Anthropic: MockAnthropic,
  };
});

import { Anthropic } from '@anthropic-ai/sdk';
import { hasValidAuth, isDirectAnthropicConfig, isUsingOAuth, isUsingOpenRouter } from '@core/utils/authEnvUtils';
import { ModelError } from '@core/rebelCore/modelErrors';
import { apiRateLimitCooldown, safetyEvalRateLimitCooldown } from '../apiRateLimitCooldown';
import {
  callBehindTheScenesWithAuth,
  callWithModel,
  callWithModelAuthAware,
  registerBtsProxyProviders,
} from '../behindTheScenesClient';

const TEST_MESSAGES = [{ role: 'user' as const, content: 'test' }];

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const settings = {
    activeProvider: 'anthropic',
    coreDirectory: '/tmp/test',
    models: {
      apiKey: 'fake-ant-test',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-20250514',
    },
    providerKeys: { openai: 'fake-openai-test' },
    customProviders: [],
    localModel: {
      activeProfileId: null,
      profiles: [
        {
          id: 'test-profile',
          name: 'Test Profile',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
          createdAt: 0,
        },
      ],
    },
    ...overrides,
  } as AppSettings;

  setSettingsStoreAdapter({
    getSettings: () => settings,
    updateSettings: () => {},
    updateSettingsAtomic: () => {},
  });

  return settings;
}

function createProxySuccessResponse(): Response {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text: 'ok' }],
    model: 'claude-sonnet-4-20250514',
    usage: { input_tokens: 10, output_tokens: 5 },
  }), { status: 200 });
}

function createProfileSuccessResponse(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    model: 'gpt-4o-mini',
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200 });
}

describe('behindTheScenesClient cooldown recording (Stage 4)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let apiRecordRateLimitSpy: ReturnType<typeof vi.spyOn>;
  let apiRecordSuccessSpy: ReturnType<typeof vi.spyOn>;
  let safetyRecordRateLimitSpy: ReturnType<typeof vi.spyOn>;
  let safetyRecordSuccessSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    messagesCreateMock.mockReset();

    apiRecordRateLimitSpy = vi.spyOn(apiRateLimitCooldown, 'recordRateLimit').mockImplementation(() => {});
    apiRecordSuccessSpy = vi.spyOn(apiRateLimitCooldown, 'recordSuccess').mockImplementation(() => {});
    safetyRecordRateLimitSpy = vi.spyOn(safetyEvalRateLimitCooldown, 'recordRateLimit').mockImplementation(() => {});
    safetyRecordSuccessSpy = vi.spyOn(safetyEvalRateLimitCooldown, 'recordSuccess').mockImplementation(() => {});

    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('OpenRouter proxy path', () => {
    it('records safety cooldown for 429 rate limits (and parses Retry-After)', async () => {
      const settings = createSettings({
        activeProvider: 'openrouter',
        openRouter: { enabled: true, oauthToken: 'fake-or-test', selectedModel: 'anthropic/claude-sonnet-4.6' } as AppSettings['openRouter'],
      });

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'Too many requests' },
      }), { status: 429, headers: { 'retry-after': '12' } }));

      await expect(callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'safety' })).rejects.toThrow();

      expect(safetyRecordRateLimitSpy).toHaveBeenCalledWith(12_000);
      expect(apiRecordRateLimitSpy).not.toHaveBeenCalled();
    });

    it('does not record cooldown for 429 billing/quota responses', async () => {
      const settings = createSettings({
        activeProvider: 'openrouter',
        openRouter: { enabled: true, oauthToken: 'fake-or-test', selectedModel: 'anthropic/claude-sonnet-4.6' } as AppSettings['openRouter'],
      });

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'Key limit exceeded (daily limit)' },
      }), { status: 429 }));

      await expect(callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'safety' })).rejects.toThrow();

      expect(safetyRecordRateLimitSpy).not.toHaveBeenCalled();
      expect(apiRecordRateLimitSpy).not.toHaveBeenCalled();
    });

    it('records success on non-safety calls (effectiveCooldown -> api singleton)', async () => {
      const settings = createSettings({
        activeProvider: 'openrouter',
        openRouter: { enabled: true, oauthToken: 'fake-or-test', selectedModel: 'anthropic/claude-sonnet-4.6' } as AppSettings['openRouter'],
      });

      fetchSpy.mockResolvedValueOnce(createProxySuccessResponse());

      await callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'memory' });

      expect(apiRecordSuccessSpy).toHaveBeenCalledOnce();
      expect(safetyRecordSuccessSpy).not.toHaveBeenCalled();
    });
  });

  describe('Codex proxy path', () => {
    it('records safety cooldown for 429 rate limits', async () => {
      const settings = createSettings({
        activeProvider: 'codex' as AppSettings['activeProvider'],
      });

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'Too many requests' },
      }), { status: 429, headers: { 'retry-after': '9' } }));

      await expect(callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
        messages: TEST_MESSAGES,
        codexConnectivity: 'connected',
      }, { category: 'safety' })).rejects.toThrow();

      expect(safetyRecordRateLimitSpy).toHaveBeenCalledWith(9_000);
      expect(apiRecordRateLimitSpy).not.toHaveBeenCalled();
    });

    it('does not record cooldown for 429 billing/quota responses', async () => {
      const settings = createSettings({
        activeProvider: 'codex' as AppSettings['activeProvider'],
      });

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'You exceeded your current quota, please check your plan and billing details.' },
      }), { status: 429 }));

      await expect(callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
        messages: TEST_MESSAGES,
        codexConnectivity: 'connected',
      }, { category: 'safety' })).rejects.toThrow();

      expect(safetyRecordRateLimitSpy).not.toHaveBeenCalled();
      expect(apiRecordRateLimitSpy).not.toHaveBeenCalled();
    });

    it('records success on non-safety calls (effectiveCooldown -> api singleton)', async () => {
      const settings = createSettings({
        activeProvider: 'codex' as AppSettings['activeProvider'],
      });

      fetchSpy.mockResolvedValueOnce(createProxySuccessResponse());

      await callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
        messages: TEST_MESSAGES,
        codexConnectivity: 'connected',
      }, { category: 'memory' });

      expect(apiRecordSuccessSpy).toHaveBeenCalledOnce();
      expect(safetyRecordSuccessSpy).not.toHaveBeenCalled();
    });
  });

  describe('Profile direct HTTP path', () => {
    it('records safety cooldown for 429 rate limits', async () => {
      const settings = createSettings();

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'Too many requests' },
      }), { status: 429, headers: { 'retry-after': '7' } }));

      await expect(callWithModelAuthAware(settings, 'profile:test-profile', {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'safety' })).rejects.toThrow();

      expect(safetyRecordRateLimitSpy).toHaveBeenCalledWith(7_000);
      expect(apiRecordRateLimitSpy).not.toHaveBeenCalled();
    });

    it('does not record cooldown for 429 billing/quota responses', async () => {
      const settings = createSettings();

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        error: { type: 'insufficient_quota', message: 'Quota exhausted' },
      }), { status: 429 }));

      await expect(callWithModelAuthAware(settings, 'profile:test-profile', {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'safety' })).rejects.toThrow();

      expect(safetyRecordRateLimitSpy).not.toHaveBeenCalled();
      expect(apiRecordRateLimitSpy).not.toHaveBeenCalled();
    });

    it('records success on non-safety calls (effectiveCooldown -> api singleton)', async () => {
      const settings = createSettings();

      fetchSpy.mockResolvedValueOnce(createProfileSuccessResponse());

      await callWithModelAuthAware(settings, 'profile:test-profile', {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'memory' });

      expect(apiRecordSuccessSpy).toHaveBeenCalledOnce();
      expect(safetyRecordSuccessSpy).not.toHaveBeenCalled();
    });
  });

  describe('OAuth SDK path', () => {
    it('records safety cooldown for 429 rate limits', async () => {
      const settings = createSettings({
        models: {
          apiKey: null,
          oauthToken: 'oauth-token',
          authMethod: 'oauth-token',
          model: 'claude-sonnet-4-20250514',
        } as AppSettings['models'],
      });

      const RateLimitErrorCtor = (Anthropic as unknown as {
        RateLimitError: new (...args: unknown[]) => Error;
      }).RateLimitError;
      const sdkRateLimitError = new RateLimitErrorCtor(
        429,
        undefined,
        'Rate limit reached',
        new Headers({ 'retry-after': '11' }),
      );
      messagesCreateMock.mockRejectedValueOnce(sdkRateLimitError);

      await expect(callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'safety' })).rejects.toThrow();

      expect(safetyRecordRateLimitSpy).toHaveBeenCalledWith(11_000);
      expect(apiRecordRateLimitSpy).not.toHaveBeenCalled();
    });

    it('does not record cooldown for 429 billing/quota responses', async () => {
      const settings = createSettings({
        models: {
          apiKey: null,
          oauthToken: 'oauth-token',
          authMethod: 'oauth-token',
          model: 'claude-sonnet-4-20250514',
        } as AppSettings['models'],
      });

      const RateLimitErrorCtor = (Anthropic as unknown as {
        RateLimitError: new (...args: unknown[]) => Error;
      }).RateLimitError;
      const sdkQuotaError = new RateLimitErrorCtor(
        429,
        undefined,
        'You exceeded your current quota, please check your plan and billing details.',
        undefined,
      );
      messagesCreateMock.mockRejectedValueOnce(sdkQuotaError);

      await expect(callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'safety' })).rejects.toThrow();

      expect(safetyRecordRateLimitSpy).not.toHaveBeenCalled();
      expect(apiRecordRateLimitSpy).not.toHaveBeenCalled();
    });

    it('records success on non-safety calls (effectiveCooldown -> api singleton)', async () => {
      const settings = createSettings({
        models: {
          apiKey: null,
          oauthToken: 'oauth-token',
          authMethod: 'oauth-token',
          model: 'claude-sonnet-4-20250514',
        } as AppSettings['models'],
      });

      messagesCreateMock.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      await callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'memory' });

      expect(apiRecordSuccessSpy).toHaveBeenCalledOnce();
      expect(safetyRecordSuccessSpy).not.toHaveBeenCalled();
    });
  });
});

// Stage 10 refinement (F1 regression guard): callWithModel is the off-plan entry
// point that invokes the transports directly (NOT through executeBtsPlan). Stage
// 10 moved cooldown recording to the dispatch layer, which silently dropped this
// entry point's recording. These tests pin that callWithModel records cooldown
// (success + rate-limit) like the other three entry points, so the bypass cannot
// regress. callWithModel(apiKey, model, localModelSettings, options, tracking)
// with an apiKey + plain model routes through callAnthropic (the direct fetch
// path), so we drive it with the same fetchSpy harness.
describe('callWithModel cooldown recording (Stage 10 F1 regression guard)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let apiRecordRateLimitSpy: ReturnType<typeof vi.spyOn>;
  let apiRecordSuccessSpy: ReturnType<typeof vi.spyOn>;
  let safetyRecordSuccessSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    messagesCreateMock.mockReset();

    apiRecordRateLimitSpy = vi.spyOn(apiRateLimitCooldown, 'recordRateLimit').mockImplementation(() => {});
    apiRecordSuccessSpy = vi.spyOn(apiRateLimitCooldown, 'recordSuccess').mockImplementation(() => {});
    safetyRecordSuccessSpy = vi.spyOn(safetyEvalRateLimitCooldown, 'recordSuccess').mockImplementation(() => {});

    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('records success on a resolved call (api bucket, no double-record)', async () => {
    fetchSpy.mockResolvedValueOnce(createProxySuccessResponse());

    await callWithModel('fake-ant-test', 'claude-sonnet-4-20250514', undefined, {
      codexConnectivity: 'unknown',
      messages: TEST_MESSAGES,
    }, { category: 'memory' });

    expect(apiRecordSuccessSpy).toHaveBeenCalledOnce();
    expect(apiRecordRateLimitSpy).not.toHaveBeenCalled();
    expect(safetyRecordSuccessSpy).not.toHaveBeenCalled();
  });

  it('records rate-limit cooldown for a classified 429 (and re-throws the ModelError)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { type: 'rate_limit_error', message: 'Too many requests' },
    }), { status: 429, headers: { 'retry-after': '8' } }));

    const err = await callWithModel('fake-ant-test', 'claude-sonnet-4-20250514', undefined, {
      codexConnectivity: 'unknown',
      messages: TEST_MESSAGES,
    }, { category: 'memory' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('rate_limit');
    expect(apiRecordRateLimitSpy).toHaveBeenCalledWith(8_000);
    expect(apiRecordSuccessSpy).not.toHaveBeenCalled();
  });

  it('does NOT record cooldown for a 429 billing/quota response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { type: 'billing_error', message: 'You exceeded your current quota, please check your plan and billing details.' },
    }), { status: 429 }));

    await expect(callWithModel('fake-ant-test', 'claude-sonnet-4-20250514', undefined, {
      codexConnectivity: 'unknown',
      messages: TEST_MESSAGES,
    }, { category: 'memory' })).rejects.toThrow();

    expect(apiRecordRateLimitSpy).not.toHaveBeenCalled();
    expect(apiRecordSuccessSpy).not.toHaveBeenCalled();
  });

  it('records on the safety bucket when category is safety (invariant 5)', async () => {
    fetchSpy.mockResolvedValueOnce(createProxySuccessResponse());

    await callWithModel('fake-ant-test', 'claude-sonnet-4-20250514', undefined, {
      codexConnectivity: 'unknown',
      messages: TEST_MESSAGES,
    }, { category: 'safety' });

    expect(safetyRecordSuccessSpy).toHaveBeenCalledOnce();
    expect(apiRecordSuccessSpy).not.toHaveBeenCalled();
  });
});

describe('behindTheScenesClient cooldown pre-check (fail-fast gate)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');

    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    vi.mocked(isUsingOpenRouter).mockReturnValue(false);
    vi.mocked(isUsingOAuth).mockReturnValue(false);
    vi.mocked(hasValidAuth).mockReturnValue(true);
    vi.mocked(isDirectAnthropicConfig).mockReturnValue(true);
  });

  afterEach(() => {
    // Clear any cooldown state set during tests
    apiRateLimitCooldown.recordSuccess();
    safetyEvalRateLimitCooldown.recordSuccess();
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe('callBehindTheScenesWithAuth', () => {
    it('throws ModelError(rate_limit) without calling fetch when api cooldown is active', async () => {
      apiRateLimitCooldown.recordRateLimit(10_000);
      const settings = createSettings();

      const err = await callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'compaction' }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ModelError);
      const modelErr = err as ModelError;
      expect(modelErr.kind).toBe('rate_limit');
      expect(modelErr.status).toBe(429);
      expect(modelErr.details?.selfImposed).toBe(true);
      expect(modelErr.resetAtMs).toBeGreaterThan(Date.now() - 1000);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('proceeds normally when api cooldown is not active', async () => {
      apiRateLimitCooldown.recordSuccess();
      const settings = createSettings();

      // Mock the direct Anthropic fetch path response
      fetchSpy.mockResolvedValueOnce(createProxySuccessResponse());

      // Should not throw — call goes through to the API
      const response = await callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'memory' });

      expect(response.content?.[0]?.text).toBe('ok');
      // Verify that the call actually reached the network (cooldown didn't block it)
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe('callWithModelAuthAware', () => {
    it('throws ModelError(rate_limit) for non-safety calls when api cooldown is active', async () => {
      apiRateLimitCooldown.recordRateLimit(10_000);
      const settings = createSettings();

      const err = await callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'memory' }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ModelError);
      const modelErr = err as ModelError;
      expect(modelErr.kind).toBe('rate_limit');
      expect(modelErr.status).toBe(429);
      expect(modelErr.details?.selfImposed).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does NOT block safety calls when only api cooldown is active', async () => {
      apiRateLimitCooldown.recordRateLimit(10_000);
      safetyEvalRateLimitCooldown.recordSuccess(); // safety cooldown clear

      // Must use OAuth settings so we go through SDK path (not direct fetch)
      vi.mocked(isUsingOAuth).mockReturnValue(true);
      vi.mocked(isDirectAnthropicConfig).mockReturnValue(false);
      const settings = createSettings({
        models: {
          apiKey: null,
          oauthToken: 'oauth-token',
          authMethod: 'oauth-token',
          model: 'claude-sonnet-4-20250514',
        } as AppSettings['models'],
      });

      messagesCreateMock.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'safe' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      // Safety calls use safetyEvalRateLimitCooldown, which is clear
      const response = await callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'safety' });

      expect(response.content?.[0]?.text).toBe('safe');
    });

    it('blocks safety calls when safety cooldown is active', async () => {
      safetyEvalRateLimitCooldown.recordRateLimit(10_000);
      const settings = createSettings();

      const err = await callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
      }, { category: 'safety' }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ModelError);
      const modelErr = err as ModelError;
      expect(modelErr.kind).toBe('rate_limit');
      expect(modelErr.details?.selfImposed).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
