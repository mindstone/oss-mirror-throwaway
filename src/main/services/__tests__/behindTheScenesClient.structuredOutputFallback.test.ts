import type { AppSettings, ModelProfile } from '@shared/types';
import { createAuthEnvUtilsMock } from '@core/utils/__tests__/authEnvUtilsMock';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import { DEFAULT_AUXILIARY_MODEL } from '@shared/utils/modelNormalization';

const { mockCaptureKnownCondition, mockRecordKnownConditionLedgerOnly } = vi.hoisted(() => ({
  mockCaptureKnownCondition: vi.fn(),
  mockRecordKnownConditionLedgerOnly: vi.fn(),
}));

 
vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: (...args: unknown[]) => {
    mockRecordKnownConditionLedgerOnly(args[0]);
    return mockCaptureKnownCondition(...args);
  },
  recordKnownConditionLedgerOnly: (condition: unknown) => mockRecordKnownConditionLedgerOnly(condition),
}));

 
vi.mock('@anthropic-ai/sdk', () => ({
  Anthropic: vi.fn(),
  APIUserAbortError: class APIUserAbortError extends Error {},
  APIError: class APIError extends Error {},
  AnthropicError: class AnthropicError extends Error {},
}));

 
vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

 
vi.mock('@core/services/codexAuthCore', () => ({
  isCodexConnected: vi.fn(() => false),
}));

 
vi.mock('@core/utils/authEnvUtils', () => createAuthEnvUtilsMock());

 
vi.mock('@core/utils/systemUtils', () => ({
  setupNodeEnvironment: vi.fn().mockResolvedValue('/usr/bin'),
}));

import { callBehindTheScenes } from '../behindTheScenesClient';
import {
  __resetStructuredOutputBypassNoticesForTesting,
  executeWithStructuredOutputProfileFallback,
} from '@core/services/behindTheScenesClient';

function makeProfileSettings(): AppSettings {
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
      activeProfileId: null,
    },
    behindTheScenesModel: 'profile:test-profile',
    providerKeys: { together: 'test-key' },
  } as AppSettings;
}

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

function mockFetchOk(body: unknown): Response {
  return new Response(
    JSON.stringify(body),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function mockFetchHttpError(status: number, message: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: async () => message,
  } as unknown as Response;
}

describe('executeWithStructuredOutputProfileFallback — known_condition emit', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetStructuredOutputBypassNoticesForTesting();
    vi.clearAllMocks();
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
  });

  afterEach(() => {
    __resetStructuredOutputBypassNoticesForTesting();
    vi.restoreAllMocks();
  });

  function makeIncompatibleProfile(id: string, name: string): ModelProfile {
    return {
      id,
      name,
      providerType: 'together',
      serverUrl: 'https://api.test.xyz/v1',
      model: `test/${id}`,
      jsonCompatibility: 'incompatible',
      createdAt: Date.now(),
    };
  }

  function makeStructuredResult(text = '{"ok":true}') {
    return {
      response: {
        content: [{ type: 'text', text }],
        model: DEFAULT_AUXILIARY_MODEL,
      },
      resolvedModel: DEFAULT_AUXILIARY_MODEL,
      profile: null,
    };
  }

  it('dedupes profile-flag-bypass Sentry emits while recording every bypass in the ledger', async () => {
    const profile = makeIncompatibleProfile('incompat-profile', 'Incompatible Profile');
    const executeForModel = vi.fn().mockResolvedValue(makeStructuredResult('{"safe":true}'));
    const options = {
      messages: [{ role: 'user' as const, content: 'safety check' }],
      outputFormat: { type: 'json_schema' as const, schema: { type: 'object' } },
      codexConnectivity: 'unknown' as const,
    };

    const first = await executeWithStructuredOutputProfileFallback(
      `profile:${profile.id}`,
      options,
      [profile],
      'safety',
      executeForModel,
    );
    const second = await executeWithStructuredOutputProfileFallback(
      `profile:${profile.id}`,
      options,
      [profile],
      'safety',
      executeForModel,
    );

    expect(executeForModel).toHaveBeenCalledTimes(2);
    expect(executeForModel).toHaveBeenNthCalledWith(
      1,
      DEFAULT_AUXILIARY_MODEL,
      { backgroundFallbackAttempted: false },
    );
    expect(executeForModel).toHaveBeenNthCalledWith(
      2,
      DEFAULT_AUXILIARY_MODEL,
      { backgroundFallbackAttempted: false },
    );
    expect(first.response.content?.[0]?.text).toBe('{"safe":true}');
    expect(second.response.content?.[0]?.text).toBe('{"safe":true}');
    expect(mockCaptureKnownCondition).toHaveBeenCalledTimes(1);
    expect(mockRecordKnownConditionLedgerOnly).toHaveBeenCalledTimes(2);
    expect(mockRecordKnownConditionLedgerOnly).toHaveBeenNthCalledWith(1, 'bts_structured_output_fallback');
    expect(mockRecordKnownConditionLedgerOnly).toHaveBeenNthCalledWith(2, 'bts_structured_output_fallback');
    expect(mockCaptureKnownCondition).toHaveBeenCalledWith(
      'bts_structured_output_fallback',
      expect.objectContaining({
        extra: expect.objectContaining({
          attemptedProfile: 'Incompatible Profile',
          profileId: 'incompat-profile',
          fellBackTo: DEFAULT_AUXILIARY_MODEL,
          trigger: 'profile-flag-bypass',
        }),
      }),
    );
  });

  it('dedupes profile-flag-bypass emits per profile id, not globally', async () => {
    const firstProfile = makeIncompatibleProfile('first-incompat-profile', 'First Incompatible Profile');
    const secondProfile = makeIncompatibleProfile('second-incompat-profile', 'Second Incompatible Profile');
    const executeForModel = vi.fn().mockResolvedValue(makeStructuredResult());
    const options = {
      messages: [{ role: 'user' as const, content: 'safety check' }],
      outputFormat: { type: 'json_schema' as const, schema: { type: 'object' } },
      codexConnectivity: 'unknown' as const,
    };

    await executeWithStructuredOutputProfileFallback(
      `profile:${firstProfile.id}`,
      options,
      [firstProfile, secondProfile],
      'safety',
      executeForModel,
    );
    await executeWithStructuredOutputProfileFallback(
      `profile:${firstProfile.id}`,
      options,
      [firstProfile, secondProfile],
      'safety',
      executeForModel,
    );
    await executeWithStructuredOutputProfileFallback(
      `profile:${secondProfile.id}`,
      options,
      [firstProfile, secondProfile],
      'safety',
      executeForModel,
    );

    expect(executeForModel).toHaveBeenCalledTimes(3);
    expect(mockCaptureKnownCondition).toHaveBeenCalledTimes(2);
    expect(mockRecordKnownConditionLedgerOnly).toHaveBeenCalledTimes(3);
    expect(mockCaptureKnownCondition).toHaveBeenCalledWith(
      'bts_structured_output_fallback',
      expect.objectContaining({
        extra: expect.objectContaining({
          profileId: 'first-incompat-profile',
          trigger: 'profile-flag-bypass',
        }),
      }),
    );
    expect(mockCaptureKnownCondition).toHaveBeenCalledWith(
      'bts_structured_output_fallback',
      expect.objectContaining({
        extra: expect.objectContaining({
          profileId: 'second-incompat-profile',
          trigger: 'profile-flag-bypass',
        }),
      }),
    );
  });

  it('emits bts_structured_output_fallback with trigger=parse-failure on profile parse failure', async () => {
    const settings = makeProfileSettings();
    setupSettingsAdapter(settings);

    fetchSpy
      .mockResolvedValueOnce(
        mockFetchOk({
          choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }],
          model: 'test/model',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      )
      .mockResolvedValueOnce(
        mockFetchOk({
          content: [{ type: 'text', text: '{"ok":true}' }],
          model: DEFAULT_AUXILIARY_MODEL,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );

    await callBehindTheScenes(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(mockCaptureKnownCondition).toHaveBeenCalledWith(
      'bts_structured_output_fallback',
      expect.objectContaining({
        extra: expect.objectContaining({
          attemptedProfile: 'Test Model',
          fellBackTo: DEFAULT_AUXILIARY_MODEL,
          trigger: 'parse-failure',
        }),
      }),
    );
  });

  it('emits bts_structured_output_fallback with trigger=json-capability on JSON-capability HTTP error', async () => {
    const settings = makeProfileSettings();
    setupSettingsAdapter(settings);

    fetchSpy
      .mockResolvedValueOnce(
        mockFetchHttpError(
          400,
          JSON.stringify({ error: { message: 'response_format is not supported by this model' } }),
        ),
      )
      .mockResolvedValueOnce(
        mockFetchOk({
          content: [{ type: 'text', text: '{"ok":true}' }],
          model: DEFAULT_AUXILIARY_MODEL,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );

    await callBehindTheScenes(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(mockCaptureKnownCondition).toHaveBeenCalledWith(
      'bts_structured_output_fallback',
      expect.objectContaining({
        extra: expect.objectContaining({
          attemptedProfile: 'Test Model',
          fellBackTo: DEFAULT_AUXILIARY_MODEL,
          trigger: 'json-capability',
        }),
      }),
    );
  });

  it('does not emit when no structured-output fallback occurs (normal parseable response)', async () => {
    const settings = makeProfileSettings();
    setupSettingsAdapter(settings);

    fetchSpy.mockResolvedValueOnce(
      mockFetchOk({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        model: 'test/model',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    await callBehindTheScenes(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(mockCaptureKnownCondition).not.toHaveBeenCalled();
  });

  it('survives captureKnownCondition throwing — fallback still completes', async () => {
    const settings = makeProfileSettings();
    setupSettingsAdapter(settings);

    fetchSpy
      .mockResolvedValueOnce(
        mockFetchOk({
          choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }],
          model: 'test/model',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      )
      .mockResolvedValueOnce(
        mockFetchOk({
          content: [{ type: 'text', text: '{"ok":true}' }],
          model: DEFAULT_AUXILIARY_MODEL,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );

    mockCaptureKnownCondition.mockImplementation(() => {
      throw new Error('reporter exploded');
    });

    const result = await callBehindTheScenes(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(result.content?.[0]?.text).toBe('{"ok":true}');
    expect(mockCaptureKnownCondition).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regression tests for docs-private/investigations/260520_time_saved_zero_or_missing.md.
 *
 * Before the broadening: when a non-profile auxiliary BTS model (e.g.
 * `minimax/minimax-m2.7`) returned 200 OK with non-JSON text, the post-success
 * parse-failure branch in `executeWithStructuredOutputProfileFallback` was
 * gated on `!originalProfile` and silently skipped the fallback — leaving
 * timeSavedService and other structured-output consumers with no entry. These
 * tests drive `executeWithStructuredOutputProfileFallback` directly with a
 * stub `executeForModel` so the regression is locked in at the policy boundary
 * (provider routing is exercised separately by the openrouter / profileRetry
 * suites — duplicating the full HTTP mock setup here would just add brittleness).
 */
describe('executeWithStructuredOutputProfileFallback — raw (non-profile) model parse-failure fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeExecutedCall(text: string, resolvedModel: string, profile: ModelProfile | null = null) {
    return {
      response: {
        content: [{ type: 'text', text }],
        model: resolvedModel,
      },
      resolvedModel,
      profile,
    };
  }

  it('falls back to DEFAULT_AUXILIARY_MODEL when a raw non-default model returns non-parseable text', async () => {
    const executeForModel = vi.fn()
      .mockResolvedValueOnce(makeExecutedCall('sorry, I cannot produce JSON for this', 'minimax/minimax-m2.7'))
      .mockResolvedValueOnce(makeExecutedCall(
        '{"estimate_minutes_low":10,"estimate_minutes_high":15}',
        DEFAULT_AUXILIARY_MODEL,
      ));

    const result = await executeWithStructuredOutputProfileFallback(
      'minimax/minimax-m2.7',
      {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'estimate this' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      undefined,
      'timeSaved',
      executeForModel,
    );

    expect(executeForModel).toHaveBeenCalledTimes(2);
    expect(executeForModel).toHaveBeenNthCalledWith(
      1,
      'minimax/minimax-m2.7',
      { backgroundFallbackAttempted: false },
    );
    expect(executeForModel).toHaveBeenNthCalledWith(
      2,
      DEFAULT_AUXILIARY_MODEL,
      { backgroundFallbackAttempted: false },
    );
    expect(result.response.content?.[0]?.text).toBe(
      '{"estimate_minutes_low":10,"estimate_minutes_high":15}',
    );
    expect(mockCaptureKnownCondition).toHaveBeenCalledWith(
      'bts_structured_output_fallback',
      expect.objectContaining({
        extra: expect.objectContaining({
          attemptedProfile: 'minimax/minimax-m2.7',
          fellBackTo: DEFAULT_AUXILIARY_MODEL,
          trigger: 'parse-failure',
        }),
      }),
    );
  });

  it('does NOT loop when the primary model is already DEFAULT_AUXILIARY_MODEL', async () => {
    const executeForModel = vi.fn().mockResolvedValue(
      makeExecutedCall('still not json', DEFAULT_AUXILIARY_MODEL),
    );

    const result = await executeWithStructuredOutputProfileFallback(
      DEFAULT_AUXILIARY_MODEL,
      {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'test' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      undefined,
      'timeSaved',
      executeForModel,
    );

    expect(executeForModel).toHaveBeenCalledTimes(1);
    expect(result.response.content?.[0]?.text).toBe('still not json');
    expect(mockCaptureKnownCondition).not.toHaveBeenCalled();
  });

  it('does not write a profile JSON-incompatibility marker when no profile is involved', async () => {
    // We hook the settings store so any accidental call to
    // markProfileJsonIncompatible would mutate this settings object; if the
    // fallback wrongly tried to mark, an unrelated profile would flip.
    const unrelatedProfile: ModelProfile = {
      id: 'unrelated',
      name: 'Unrelated',
      providerType: 'together',
      serverUrl: 'https://api.test.xyz/v1',
      model: 'unrelated/model',
      createdAt: Date.now(),
    };
    const settings = {
      models: { apiKey: 'fake-test' },
      localModel: { profiles: [unrelatedProfile], activeProfileId: null },
    } as AppSettings;
    setupSettingsAdapter(settings);

    const executeForModel = vi.fn()
      .mockResolvedValueOnce(makeExecutedCall('free-form text', 'z-ai/glm-5'))
      .mockResolvedValueOnce(makeExecutedCall('{"ok":true}', DEFAULT_AUXILIARY_MODEL));

    await executeWithStructuredOutputProfileFallback(
      'z-ai/glm-5',
      {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'test' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      settings.localModel?.profiles,
      'timeSaved',
      executeForModel,
    );

    expect(settings.localModel?.profiles?.[0]?.jsonCompatibility).toBeUndefined();
    expect(settings.localModel?.profiles?.[0]?.jsonCompatibilityCheckedAt).toBeUndefined();
  });

  it('still skips fallback for raw models when outputFormat is unset (free-form responses are valid)', async () => {
    const executeForModel = vi.fn().mockResolvedValueOnce(
      makeExecutedCall('a free-form answer', 'minimax/minimax-m2.7'),
    );

    const result = await executeWithStructuredOutputProfileFallback(
      'minimax/minimax-m2.7',
      {
        codexConnectivity: 'unknown', messages: [{ role: 'user', content: 'test' }] }, // no outputFormat
      undefined,
      'timeSaved',
      executeForModel,
    );

    expect(executeForModel).toHaveBeenCalledTimes(1);
    expect(result.response.content?.[0]?.text).toBe('a free-form answer');
    expect(mockCaptureKnownCondition).not.toHaveBeenCalled();
  });
});
