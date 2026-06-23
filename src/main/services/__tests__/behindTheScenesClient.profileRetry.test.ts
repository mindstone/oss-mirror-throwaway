import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSettings } from '@shared/types';
import { createAuthEnvUtilsMock } from '@core/utils/__tests__/authEnvUtilsMock';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import { __resetJsonParseFailureStrikesForTesting } from '@core/services/behindTheScenesClient';
import { DEFAULT_AUXILIARY_MODEL } from '@shared/utils/modelNormalization';

vi.mock('@anthropic-ai/sdk', () => ({
  Anthropic: vi.fn(),
  // Referenced by classifyError() for abort detection.
  APIUserAbortError: class APIUserAbortError extends Error {},
  APIError: class APIError extends Error {},
  AnthropicError: class AnthropicError extends Error {},
}));

const { mockLog } = vi.hoisted(() => ({
  mockLog: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLog,
}));

vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

 
vi.mock('@core/services/codexAuthCore', () => ({
  isCodexConnected: vi.fn(() => false),
}));

// F1 (plan 260422 routing-follow-ups): mock shape centralised in
// `createAuthEnvUtilsMock`. Defaults match the API-key direct-Anthropic
// baseline for profile-retry tests.
vi.mock('@core/utils/authEnvUtils', () => createAuthEnvUtilsMock());

vi.mock('@core/utils/systemUtils', () => ({
  setupNodeEnvironment: vi.fn().mockResolvedValue('/usr/bin'),
}));

import { callBehindTheScenes } from '../behindTheScenesClient';

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    models: { apiKey: 'fake-test' },
    localModel: {
      profiles: [{
        id: 'test-profile',
        name: 'Test Model',
        providerType: 'together',
        serverUrl: 'https://api.test.xyz/v1',
        model: 'test/model',
        createdAt: Date.now(),
      }],
    },
    behindTheScenesModel: 'profile:test-profile',
    providerKeys: { together: 'test-key' },
    ...overrides,
  } as AppSettings;
}

function makeReasoningSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    models: { apiKey: 'fake-test' },
    localModel: {
      profiles: [{
        id: 'reasoning-profile',
        name: 'Reasoning Model',
        providerType: 'together',
        serverUrl: 'https://api.test.xyz/v1',
        model: 'test/reasoning-model',
        createdAt: Date.now(),
        reasoningEffort: 'high',
      }],
    },
    behindTheScenesModel: 'profile:reasoning-profile',
    providerKeys: { together: 'test-key' },
    ...overrides,
  } as AppSettings;
}

function mockFetchResponse(
  text: string,
  finishReason: string = 'stop',
  usage = { prompt_tokens: 10, completion_tokens: 20 }
): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: finishReason }],
      model: 'test/model',
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function mockFetchError(status: number, message: string): Response {
  return {
    ok: false,
    status,
    text: async () => message,
  } as unknown as Response;
}

describe('callDirectWithProfile: reasoning model inflation', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes callerMaxTokens unchanged for non-reasoning profiles', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse('ok'));

    await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 256,
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBe(256);
  });

  it('inflates max_completion_tokens by 4x for reasoning profiles', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse('ok'));

    await callBehindTheScenes(makeReasoningSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 2048,
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBe(8192); // 2048 * 4, above floor, below cap
  });

  it('applies floor of 4096 for reasoning profiles with small maxTokens', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse('ok'));

    await callBehindTheScenes(makeReasoningSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 128,
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBe(4096); // floor
  });

  it('caps inflated max_tokens at 16384', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse('ok'));

    await callBehindTheScenes(makeReasoningSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 8192,
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBe(16384); // cap, not 8192 * 4 = 32768
  });
});

describe('callDirectWithProfile: retry on truncation', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries once when finish_reason is length', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse('truncated', 'length'))
      .mockResolvedValueOnce(mockFetchResponse('complete', 'stop'));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 256,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toBe('complete');
  });

  it('inflates retry budget by 4x', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse('truncated', 'length'))
      .mockResolvedValueOnce(mockFetchResponse('complete', 'stop'));

    await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 256,
    });

    const firstBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const retryBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(retryBody.max_completion_tokens).toBe(firstBody.max_completion_tokens * 4);
  });

  it('caps retry max_tokens at 16384', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse('truncated', 'length'))
      .mockResolvedValueOnce(mockFetchResponse('complete', 'stop'));

    await callBehindTheScenes(makeReasoningSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 4096,
    });

    const retryBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(retryBody.max_completion_tokens).toBe(16384); // not 16384 * 4
  });

  it('does not retry when finish_reason is stop', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse('complete', 'stop'));

    await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 256,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry when finish_reason is missing', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }], model: 'test/model' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 256,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns truncated first result and logs warning when retry still truncated', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse('first', 'length'))
      .mockResolvedValueOnce(mockFetchResponse('second', 'length'));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 256,
    });

    expect(result.content[0].text).toBe('second');
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'Test Model' }),
      expect.stringContaining('still truncated after retry'),
    );
  });
});

describe('callDirectWithProfile: retry error fallback', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns truncated first result when retry throws (e.g. provider 400)', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse('partial', 'length'))
      .mockResolvedValueOnce(mockFetchError(400, 'max_tokens exceeds limit'));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 256,
    });

    expect(result.content[0].text).toBe('partial');
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'Test Model' }),
      expect.stringContaining('Retry failed'),
    );
  });

  it('returns truncated first result when retry throws network error', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse('partial', 'length'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 256,
    });

    expect(result.content[0].text).toBe('partial');
  });
});

describe('callDirectWithProfile: JSON extraction for structured output', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts JSON from markdown code fences when outputFormat is set', async () => {
    const json = JSON.stringify({ picks: [{ videoId: '1', relevanceHint: 'test' }] });
    fetchSpy.mockResolvedValue(mockFetchResponse('```json\n' + json + '\n```'));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(result.content[0].text).toBe(json);
    expect(JSON.parse(result.content[0].text ?? '')).toEqual({ picks: [{ videoId: '1', relevanceHint: 'test' }] });
  });

  it('extracts JSON from response with preamble text when outputFormat is set', async () => {
    const json = JSON.stringify({ result: 'ok' });
    fetchSpy.mockResolvedValue(mockFetchResponse('Here is the result:\n' + json));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(result.content[0].text).toBe(json);
  });

  it('passes through clean JSON unchanged when outputFormat is set', async () => {
    const json = JSON.stringify({ data: 'clean' });
    fetchSpy.mockResolvedValue(mockFetchResponse(json));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(result.content[0].text).toBe(json);
  });

  it('does not modify response text when outputFormat is not set', async () => {
    const text = 'Here is some ```json\n{"x":1}\n``` in the middle';
    fetchSpy.mockResolvedValue(mockFetchResponse(text));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.content[0].text).toBe(text);
  });
});

describe('structured-output profile safeguards', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bypasses JSON-incompatible profiles before calling profile endpoint', async () => {
    const settings = makeSettings({
      localModel: {
        profiles: [{
          id: 'test-profile',
          name: 'Test Model',
          providerType: 'together',
          serverUrl: 'https://api.test.xyz/v1',
          model: 'test/model',
          createdAt: Date.now(),
          jsonCompatibility: 'incompatible',
        }],
        activeProfileId: null,
      },
    });

    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"ok":true}' }],
          model: DEFAULT_AUXILIARY_MODEL,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await callBehindTheScenes(settings, {
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(init.body);
    expect(body.model).toBe(DEFAULT_AUXILIARY_MODEL);
  });

  it('falls back on a single profile JSON parse failure but does NOT yet auto-mark (strike threshold not reached — 260521 BTS Haiku-fallback A0b)', async () => {
    __resetJsonParseFailureStrikesForTesting();
    const settings = makeSettings();
    const applyPartial = (partial: Partial<AppSettings>) => {
      if (partial.localModel) {
        settings.localModel = {
          profiles: partial.localModel.profiles ?? settings.localModel?.profiles ?? [],
          activeProfileId: partial.localModel.activeProfileId ?? settings.localModel?.activeProfileId ?? null,
        };
      }
    };
    setSettingsStoreAdapter({
      getSettings: () => settings,
      updateSettings: applyPartial,
      updateSettingsAtomic: (updater) => applyPartial(updater(settings)),
    });

    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse('not json', 'stop'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"ok":true}' }],
            model: DEFAULT_AUXILIARY_MODEL,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const result = await callBehindTheScenes(settings, {
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.test.xyz/v1/chat/completions');
    expect(fetchSpy.mock.calls[1][0]).toBe('https://api.anthropic.com/v1/messages');
    expect(result.content[0].text).toBe('{"ok":true}');
    // Single transient parse-failure must NOT sticky-mark the profile —
    // strike counter requires two consecutive failures (260521 BTS
    // Haiku-fallback A0b).
    expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBeUndefined();
  });

  it('auto-marks profile JSON-incompatible only after two consecutive parse failures (260521 BTS Haiku-fallback A0b)', async () => {
    __resetJsonParseFailureStrikesForTesting();
    const settings = makeSettings();
    const applyPartial = (partial: Partial<AppSettings>) => {
      if (partial.localModel) {
        settings.localModel = {
          profiles: partial.localModel.profiles ?? settings.localModel?.profiles ?? [],
          activeProfileId: partial.localModel.activeProfileId ?? settings.localModel?.activeProfileId ?? null,
        };
      }
    };
    setSettingsStoreAdapter({
      getSettings: () => settings,
      updateSettings: applyPartial,
      updateSettingsAtomic: (updater) => applyPartial(updater(settings)),
    });

    const profileFailure = () => mockFetchResponse('not json', 'stop');
    const fallbackSuccess = () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"ok":true}' }],
          model: DEFAULT_AUXILIARY_MODEL,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    fetchSpy
      .mockResolvedValueOnce(profileFailure())
      .mockResolvedValueOnce(fallbackSuccess())
      .mockResolvedValueOnce(profileFailure())
      .mockResolvedValueOnce(fallbackSuccess());

    await callBehindTheScenes(settings, {
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });
    expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBeUndefined();

    await callBehindTheScenes(settings, {
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });
    expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBe('incompatible');
    expect(settings.localModel?.profiles?.[0]?.jsonCompatibilityCheckedAt).toBeTruthy();
  });

  it('parseable response between failures resets the strike counter (260521 BTS Haiku-fallback A0b)', async () => {
    __resetJsonParseFailureStrikesForTesting();
    const settings = makeSettings();
    const applyPartial = (partial: Partial<AppSettings>) => {
      if (partial.localModel) {
        settings.localModel = {
          profiles: partial.localModel.profiles ?? settings.localModel?.profiles ?? [],
          activeProfileId: partial.localModel.activeProfileId ?? settings.localModel?.activeProfileId ?? null,
        };
      }
    };
    setSettingsStoreAdapter({
      getSettings: () => settings,
      updateSettings: applyPartial,
      updateSettingsAtomic: (updater) => applyPartial(updater(settings)),
    });

    const profileFailure = () => mockFetchResponse('not json', 'stop');
    const profileSuccess = () => mockFetchResponse('{"ok":true}', 'stop');
    const fallbackSuccess = () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"ok":true}' }],
          model: DEFAULT_AUXILIARY_MODEL,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    fetchSpy
      .mockResolvedValueOnce(profileFailure())
      .mockResolvedValueOnce(fallbackSuccess())
      .mockResolvedValueOnce(profileSuccess())
      .mockResolvedValueOnce(profileFailure())
      .mockResolvedValueOnce(fallbackSuccess());

    await callBehindTheScenes(settings, {
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });
    await callBehindTheScenes(settings, {
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });
    await callBehindTheScenes(settings, {
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });
    expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBeUndefined();
  });

  // Auto-profile marker guard (260521 BTS Haiku-fallback A0) is unit-tested
  // separately in `behindTheScenesClient.markProfileGuard.test.ts` — going
  // through `callBehindTheScenes` here would also exercise the Codex-disconnect
  // BTS pre-call gate (since `codex-*` ids imply codex-subscription auth in
  // production), which is unrelated to the marker guard itself.

  // Catch-path execution + auto-mark gating (Option D, merge resolution review
  // 260428, plus 260428 follow-up). The catch branch only runs the silent
  // reroute to DEFAULT_AUXILIARY_MODEL when the primary error is identifiably
  // JSON-capability-specific. Everything else (rate-limit, auth, abort,
  // server, billing, unrelated 400) MUST rethrow so the user sees the real
  // operational failure rather than a silent route to Claude. See AGENTS.md
  // "Silent failure is a bug".
  describe('catch-path execution + auto-mark gating', () => {
    function setupSettingsAdapter(settings: AppSettings): void {
      const applyPartial = (partial: Partial<AppSettings>) => {
        if (partial.localModel) {
          settings.localModel = {
            profiles: partial.localModel.profiles ?? settings.localModel?.profiles ?? [],
            activeProfileId: partial.localModel.activeProfileId ?? settings.localModel?.activeProfileId ?? null,
          };
        }
      };
      setSettingsStoreAdapter({
        getSettings: () => settings,
        updateSettings: applyPartial,
        updateSettingsAtomic: (updater) => applyPartial(updater(settings)),
      });
    }

    function fallbackParseable(): Response {
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '{"ok":true}' }],
          model: DEFAULT_AUXILIARY_MODEL,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      } as unknown as Response;
    }

    it('rethrows 429 rate-limit error from primary profile (no silent reroute, no mark)', async () => {
      const settings = makeSettings();
      setupSettingsAdapter(settings);

      fetchSpy
        .mockResolvedValueOnce(mockFetchError(429, JSON.stringify({ error: { message: 'Too many requests' } })))
        .mockResolvedValueOnce(fallbackParseable());

      await expect(callBehindTheScenes(settings, {
        messages: [{ role: 'user', content: 'test' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })).rejects.toThrow();

      // Only the primary fetch — no fallback to DEFAULT_AUXILIARY_MODEL.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBeUndefined();
    });

    it('rethrows 401 auth error from primary profile (no silent reroute, no mark)', async () => {
      const settings = makeSettings();
      setupSettingsAdapter(settings);

      fetchSpy
        .mockResolvedValueOnce(mockFetchError(401, JSON.stringify({ error: { message: 'Invalid API key' } })))
        .mockResolvedValueOnce(fallbackParseable());

      await expect(callBehindTheScenes(settings, {
        messages: [{ role: 'user', content: 'test' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })).rejects.toThrow();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBeUndefined();
    });

    it('rethrows 503 server error after transient retries exhaust (no silent reroute, no mark)', async () => {
      const settings = makeSettings();
      setupSettingsAdapter(settings);

      // 503 is transient → withTransientRetry retries up to 3 times before giving up.
      // The 4th call (fallback) must NOT happen — the error rethrows instead.
      const errBody = JSON.stringify({ error: { message: 'Service unavailable' } });
      fetchSpy
        .mockResolvedValueOnce(mockFetchError(503, errBody))
        .mockResolvedValueOnce(mockFetchError(503, errBody))
        .mockResolvedValueOnce(mockFetchError(503, errBody))
        .mockResolvedValueOnce(fallbackParseable());

      await expect(callBehindTheScenes(settings, {
        messages: [{ role: 'user', content: 'test' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })).rejects.toThrow();

      // 3 transient retries, no fallback.
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBeUndefined();
    }, 30_000);

    it('AUTO-MARKS profile and falls back when primary 400 rejects response_format', async () => {
      const settings = makeSettings();
      setupSettingsAdapter(settings);

      fetchSpy
        .mockResolvedValueOnce(mockFetchError(
          400,
          JSON.stringify({
            error: {
              message: "response_format json_object is not supported by this model",
            },
          }),
        ))
        .mockResolvedValueOnce(fallbackParseable());

      const result = await callBehindTheScenes(settings, {
        messages: [{ role: 'user', content: 'test' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.content[0].text).toBe('{"ok":true}');
      expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBe('incompatible');
      expect(settings.localModel?.profiles?.[0]?.jsonCompatibilityCheckedAt).toBeTruthy();
    });

    it('rethrows 400 with unrelated message (no JSON-capability tokens), no silent reroute, no mark', async () => {
      const settings = makeSettings();
      setupSettingsAdapter(settings);

      fetchSpy
        .mockResolvedValueOnce(mockFetchError(
          400,
          JSON.stringify({ error: { message: 'messages array must not be empty' } }),
        ))
        .mockResolvedValueOnce(fallbackParseable());

      await expect(callBehindTheScenes(settings, {
        messages: [{ role: 'user', content: 'test' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })).rejects.toThrow();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBeUndefined();
    });

    it('rethrows user-abort error from primary profile (no silent reroute, no mark)', async () => {
      const settings = makeSettings();
      setupSettingsAdapter(settings);

      const controller = new AbortController();
      controller.abort();

      fetchSpy
        .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        .mockResolvedValueOnce(fallbackParseable());

      await expect(callBehindTheScenes(settings, {
        messages: [{ role: 'user', content: 'test' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
        signal: controller.signal,
      })).rejects.toThrow();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBeUndefined();
    });
  });
});

describe('callDirectWithProfile: _finishReason does not leak', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strips _finishReason from returned response (no retry)', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse('ok', 'stop'));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result).not.toHaveProperty('_finishReason');
  });

  it('strips _finishReason from returned response (after retry)', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse('truncated', 'length'))
      .mockResolvedValueOnce(mockFetchResponse('complete', 'stop'));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result).not.toHaveProperty('_finishReason');
  });

  it('strips _finishReason when retry fails and first result is returned', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockFetchResponse('partial', 'length'))
      .mockRejectedValueOnce(new Error('fail'));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result).not.toHaveProperty('_finishReason');
  });

  it('strips _hasReasoningContent from returned response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok', reasoning_content: 'thinking...' }, finish_reason: 'stop' }],
          model: 'test/model',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result).not.toHaveProperty('_hasReasoningContent');
  });
});

// Helper for responses with reasoning_content (MiniMax, DeepSeek R1, etc.)
function mockFetchReasoningResponse(
  content: string | null,
  reasoningContent: string | null,
  finishReason: string = 'stop',
): Response {
  return new Response(
    JSON.stringify({
      choices: [{
        message: {
          content,
          ...(reasoningContent != null ? { reasoning_content: reasoningContent } : {}),
        },
        finish_reason: finishReason,
      }],
      model: 'test/model',
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('callDirectWithProfile: reasoning_content fallback', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses content when both content and reasoning_content are present', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchReasoningResponse('{"result":"from content"}', 'I was thinking about this...')
    );

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.content[0].text).toBe('{"result":"from content"}');
  });

  it('falls back to reasoning_content when content is empty', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchReasoningResponse('', '{"result":"from reasoning"}')
    );

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.content[0].text).toBe('{"result":"from reasoning"}');
  });

  it('falls back to reasoning_content when content is null', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchReasoningResponse(null, '{"result":"from reasoning"}')
    );

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.content[0].text).toBe('{"result":"from reasoning"}');
  });

  it('applies JSON extraction to reasoning_content fallback when outputFormat is set', async () => {
    const json = JSON.stringify({ estimate: 42 });
    fetchSpy.mockResolvedValue(
      mockFetchReasoningResponse(null, '```json\n' + json + '\n```')
    );

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(result.content[0].text).toBe(json);
  });

  it('strips <think> blocks from reasoning_content fallback', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchReasoningResponse('', '<think>internal thoughts</think>{"result":"clean"}')
    );

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.content[0].text).toBe('{"result":"clean"}');
  });
});

describe('callDirectWithProfile: runtime reasoning model detection and retry', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to reasoning_content when content is empty (no retry needed since fallback provides text)', async () => {
    // First call: reasoning model eats all tokens, content is empty, but
    // reasoning_content has the answer. The fallback fills text from reasoning_content.
    fetchSpy.mockResolvedValueOnce(mockFetchReasoningResponse('', '{"result":"from reasoning"}', 'stop'));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 512,
      timeout: 60000,
    });

    // No retry needed: reasoning_content fallback provided usable text
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toBe('{"result":"from reasoning"}');
  });

  it('retries with inflated budget when reasoning model returns truncated empty content', async () => {
    // Reasoning model used all budget for reasoning, content AND reasoning are empty/truncated
    fetchSpy
      .mockResolvedValueOnce(mockFetchReasoningResponse('', '', 'length'))
      .mockResolvedValueOnce(mockFetchReasoningResponse('{"result":"success"}', 'Thinking...', 'stop'));

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 512,
      timeout: 60000,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toBe('{"result":"success"}');
  });

  it('does not retry when reasoning_content is present but content is also non-empty', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchReasoningResponse('{"result":"ok"}', 'I was thinking...', 'stop')
    );

    const result = await callBehindTheScenes(makeSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 512,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toBe('{"result":"ok"}');
  });

  it('does not retry for known reasoning model profiles (already inflated upfront)', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchReasoningResponse('{"result":"ok"}', 'thinking', 'stop')
    );

    await callBehindTheScenes(makeReasoningSettings(), {
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 512,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
