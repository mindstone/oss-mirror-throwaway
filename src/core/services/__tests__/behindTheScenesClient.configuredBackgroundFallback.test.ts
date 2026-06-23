import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { DEFAULT_AUXILIARY_MODEL } from '@shared/utils/modelNormalization';
import { apiRateLimitCooldown, safetyEvalRateLimitCooldown } from '../apiRateLimitCooldown';
import {
  callWithModelAuthAware,
  registerBtsProxyProviders,
} from '../behindTheScenesClient';

const settingsStoreMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getTurnContext: vi.fn(() => undefined),
}));

vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: settingsStoreMocks.getSettings,
  updateSettings: settingsStoreMocks.updateSettings,
}));

vi.mock('@core/utils/systemUtils', () => ({
  setupNodeEnvironment: vi.fn().mockResolvedValue('/usr/bin'),
}));

vi.mock('../codexAuthCore', () => ({
  isCodexConnected: vi.fn(() => false),
}));

const TEST_MESSAGES = [{ role: 'user' as const, content: 'test' }];

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'profile-primary',
    name: 'Primary',
    providerType: 'openai',
    serverUrl: 'https://primary.example.com/v1',
    model: 'gpt-4o-mini',
    apiKey: 'primary-api-key',
    createdAt: 0,
    ...overrides,
  };
}

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'anthropic',
    coreDirectory: '/tmp/test',
    models: {
      apiKey: 'fake-ant-test-key',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: false,
    },
    openRouter: {
      enabled: true,
      oauthToken: 'fake-or-token',
      selectedModel: 'anthropic/claude-sonnet-4.6',
    },
    providerKeys: {},
    customProviders: [],
    localModel: {
      activeProfileId: null,
      profiles: [],
    },
    ...overrides,
  } as AppSettings;
}

function openAiSuccessResponse(model: string, text: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    model,
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  }), { status: 200 });
}

function anthropicSuccessResponse(model: string, text: string): Response {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text }],
    model,
    usage: { input_tokens: 12, output_tokens: 7 },
  }), { status: 200 });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

function requestBodyModel(
  fetchSpy: ReturnType<typeof vi.spyOn>,
  callIndex: number,
): string | undefined {
  const init = fetchSpy.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  const body = typeof init?.body === 'string' ? init.body : null;
  if (!body) return undefined;
  return (JSON.parse(body) as { model?: string }).model;
}

describe('behindTheScenesClient configured background fallback', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    apiRateLimitCooldown.reset();
    safetyEvalRateLimitCooldown.reset();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });
    settingsStoreMocks.getSettings.mockReturnValue(createSettings());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('retries server/model-unavailable operational failures with configured background fallback', async () => {
    const primary = makeProfile({ id: 'primary', serverUrl: 'https://primary.example.com/v1', model: 'gpt-4o-mini' });
    const backup = makeProfile({ id: 'backup', serverUrl: 'https://backup.example.com/v1', model: 'gpt-4.1-mini' });
    const settings = createSettings({
      backgroundFallback: 'profile:backup',
      localModel: { activeProfileId: null, profiles: [primary, backup] },
    });

    fetchSpy.mockResolvedValueOnce(errorResponse(404, 'model not found'));
    fetchSpy.mockResolvedValueOnce(openAiSuccessResponse('gpt-4.1-mini', 'fallback ok'));

    const result = await callWithModelAuthAware(
      settings,
      'profile:primary',
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://primary.example.com/v1/chat/completions');
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://backup.example.com/v1/chat/completions');
    expect(requestBodyModel(fetchSpy, 0)).toBe('gpt-4o-mini');
    expect(requestBodyModel(fetchSpy, 1)).toBe('gpt-4.1-mini');
    expect(result.content[0]?.text).toBe('fallback ok');
  });

  it('skips configured operational fallback when single-dispatch is requested', async () => {
    const primary = makeProfile({ id: 'primary', serverUrl: 'https://primary.example.com/v1', model: 'gpt-4o-mini' });
    const backup = makeProfile({ id: 'backup', serverUrl: 'https://backup.example.com/v1', model: 'gpt-4.1-mini' });
    const settings = createSettings({
      backgroundFallback: 'profile:backup',
      localModel: { activeProfileId: null, profiles: [primary, backup] },
    });

    fetchSpy.mockResolvedValueOnce(errorResponse(404, 'model not found'));

    await expect(callWithModelAuthAware(
      settings,
      'profile:primary',
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'safety' },
      { disableOperationalFallback: true },
    )).rejects.toMatchObject({ kind: 'model_unavailable' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://primary.example.com/v1/chat/completions');
    expect(requestBodyModel(fetchSpy, 0)).toBe('gpt-4o-mini');
  });

  it('retries codex-disconnected failures with configured background fallback', async () => {
    const codexPrimary = makeProfile({
      id: 'codex-primary',
      model: 'gpt-5.5',
      authSource: 'codex-subscription',
      apiKey: undefined,
    });
    const backup = makeProfile({
      id: 'backup',
      serverUrl: 'https://backup.example.com/v1',
      model: 'gpt-4.1-mini',
    });
    const settings = createSettings({
      backgroundFallback: 'profile:backup',
      localModel: { activeProfileId: null, profiles: [codexPrimary, backup] },
    });

    fetchSpy.mockResolvedValueOnce(openAiSuccessResponse('gpt-4.1-mini', 'fallback after codex disconnect'));

    const result = await callWithModelAuthAware(
      settings,
      'profile:codex-primary',
      {
        codexConnectivity: 'disconnected',
        messages: TEST_MESSAGES,
      },
      { category: 'memory' },
    );

    // Primary Codex route fails closed before any fetch; only fallback executes.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://backup.example.com/v1/chat/completions');
    expect(requestBodyModel(fetchSpy, 0)).toBe('gpt-4.1-mini');
    expect(result.content[0]?.text).toBe('fallback after codex disconnect');
  });

  it('does not use configured background fallback for rate-limit errors', async () => {
    const primary = makeProfile({ id: 'primary', serverUrl: 'https://primary.example.com/v1' });
    const backup = makeProfile({ id: 'backup', serverUrl: 'https://backup.example.com/v1', model: 'gpt-4.1-mini' });
    const settings = createSettings({
      backgroundFallback: 'profile:backup',
      localModel: { activeProfileId: null, profiles: [primary, backup] },
    });

    fetchSpy.mockResolvedValueOnce(errorResponse(429, 'Too many requests'));

    await expect(callWithModelAuthAware(
      settings,
      'profile:primary',
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    )).rejects.toMatchObject({ kind: 'rate_limit' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when configured background fallback route resolves terminal (no legacy fallback chaining)', async () => {
    const primary = makeProfile({ id: 'primary', serverUrl: 'https://primary.example.com/v1' });
    const fallbackNoKey = makeProfile({
      id: 'backup-no-key',
      serverUrl: 'https://backup.example.com/v1',
      model: 'gpt-4.1-mini',
      apiKey: undefined,
    });
    const settings = createSettings({
      backgroundFallback: 'profile:backup-no-key',
      localModel: { activeProfileId: null, profiles: [primary, fallbackNoKey] },
    });

    fetchSpy.mockResolvedValueOnce(errorResponse(404, 'model not found'));

    await expect(callWithModelAuthAware(
      settings,
      'profile:primary',
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    )).rejects.toThrow('missing credentials for background task routing');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps structured-output capability fallback separate from configured operational fallback', async () => {
    const primary = makeProfile({ id: 'primary', serverUrl: 'https://primary.example.com/v1' });
    const settings = createSettings({
      activeProvider: 'openrouter',
      backgroundFallback: 'model:claude-opus-4-7',
      localModel: { activeProfileId: null, profiles: [primary] },
    });
    const options = {
      messages: TEST_MESSAGES,
      outputFormat: {
        type: 'json_schema',
        name: 'bts_schema',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      },
      codexConnectivity: 'unknown',
    } as Parameters<typeof callWithModelAuthAware>[2];

    fetchSpy.mockResolvedValueOnce(errorResponse(400, 'response_format json_schema is not supported for this model'));
    fetchSpy.mockResolvedValueOnce(anthropicSuccessResponse(DEFAULT_AUXILIARY_MODEL, 'structured fallback ok'));

    const result = await callWithModelAuthAware(
      settings,
      'profile:primary',
      options,
      { category: 'memory' },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('http://127.0.0.1:9999/v1/messages');
    expect(requestBodyModel(fetchSpy, 1)).toBe(DEFAULT_AUXILIARY_MODEL);
    expect(requestBodyModel(fetchSpy, 1)).not.toBe('claude-opus-4-7');
    expect(result.content[0]?.text).toBe('structured fallback ok');
  });

  it('does not mark the primary profile JSON-incompatible when operational fallback produced the non-json response', async () => {
    const primary = makeProfile({ id: 'primary', name: 'Primary', serverUrl: 'https://primary.example.com/v1' });
    const backup = makeProfile({ id: 'backup', name: 'Backup', serverUrl: 'https://backup.example.com/v1', model: 'gpt-4.1-mini' });
    const settings = createSettings({
      backgroundFallback: 'profile:backup',
      localModel: { activeProfileId: null, profiles: [primary, backup] },
    });
    settingsStoreMocks.getSettings.mockReturnValue(settings);
    const options = {
      messages: TEST_MESSAGES,
      outputFormat: {
        type: 'json_schema',
        name: 'bts_schema',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      },
      codexConnectivity: 'unknown',
    } as Parameters<typeof callWithModelAuthAware>[2];

    fetchSpy.mockResolvedValueOnce(errorResponse(404, 'model not found'));
    fetchSpy.mockResolvedValueOnce(openAiSuccessResponse('gpt-4.1-mini', 'not json'));
    fetchSpy.mockResolvedValueOnce(anthropicSuccessResponse(DEFAULT_AUXILIARY_MODEL, '{"ok":true}'));

    const result = await callWithModelAuthAware(
      settings,
      'profile:primary',
      options,
      { category: 'memory' },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://backup.example.com/v1/chat/completions');
    expect(requestBodyModel(fetchSpy, 2)).toBe(DEFAULT_AUXILIARY_MODEL);
    expect(result.content[0]?.text).toBe('{"ok":true}');
    expect(settingsStoreMocks.updateSettings).not.toHaveBeenCalled();
  });
});
