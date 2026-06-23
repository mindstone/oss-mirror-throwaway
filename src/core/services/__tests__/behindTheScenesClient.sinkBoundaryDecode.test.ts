import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { ProviderRouter } from '@core/rebelCore/providerRouting';
import { DEFAULT_AUXILIARY_MODEL } from '@shared/utils/modelNormalization';

const logWarnMock = vi.hoisted(() => vi.fn());

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: logWarnMock,
    error: vi.fn(),
  }),
  getTurnContext: vi.fn(() => undefined),
}));

vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
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

vi.mock('@core/utils/systemUtils', () => ({
  setupNodeEnvironment: vi.fn().mockResolvedValue('/usr/bin'),
}));

import {
  callWithModelAuthAware,
  createBtsRoutePlan,
  executeWithStructuredOutputProfileFallback,
} from '../behindTheScenesClient';

const BACKSTOP_WARN =
  'sink-boundary backstop stripped a `model:` prefix — upstream caller bypassed S2; investigate';

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'anthropic',
    coreDirectory: '/tmp/test',
    models: {
      apiKey: 'fake-anthropic-key',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
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

function btsOptions() {
  return {
    messages: [{ role: 'user' as const, content: 'test' }],
    maxTokens: 32,
    codexConnectivity: 'unknown' as const,
  };
}

function expectSinkWarn(sinkName: string, rawModel: string): void {
  expect(logWarnMock).toHaveBeenCalledWith(
    expect.objectContaining({
      sinkName,
      rawTruncated: rawModel.slice(0, 32),
    }),
    BACKSTOP_WARN,
  );
}

describe('behindTheScenesClient sink-boundary decode backstop', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('createBtsRoutePlan strips model:gpt-5.4-mini and emits a warn', async () => {
    const settings = createSettings();
    const forBtsSpy = vi.spyOn(ProviderRouter, 'forBTS');

    const plan = await createBtsRoutePlan(
      settings,
      'model:gpt-5.4-mini',
      btsOptions(),
      'safety',
    );

    expect(forBtsSpy).toHaveBeenCalledOnce();
    expect(forBtsSpy.mock.calls[0][0].model).toBe('gpt-5.4-mini');
    expect(plan.decision.wireModelId).toBe('gpt-5.4-mini');
    expectSinkWarn('createBtsRoutePlan', 'model:gpt-5.4-mini');
  });

  it('createBtsRoutePlan throws when model strips to empty and emits a warn', async () => {
    const settings = createSettings();
    const forBtsSpy = vi.spyOn(ProviderRouter, 'forBTS');

    await expect(
      createBtsRoutePlan(settings, 'model:', btsOptions(), 'safety'),
    ).rejects.toThrow(
      "createBtsRoutePlan: invalid model value 'model:' after sink-boundary decode (empty after strip). This indicates a settings persistence or migration bug.",
    );

    expect(forBtsSpy).not.toHaveBeenCalled();
    expectSinkWarn('createBtsRoutePlan', 'model:');
  });

  it('callWithModelAuthAware strips model:claude-haiku-4-5 and emits a warn', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const settings = createSettings();
    await callWithModelAuthAware(settings, 'model:claude-haiku-4-5', btsOptions(), { category: 'memory' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, requestInit] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(requestInit?.body)) as { model?: string };
    expect(body.model).toBe('claude-haiku-4-5');
    expectSinkWarn('callWithModelAuthAware', 'model:claude-haiku-4-5');
  });

  it('callWithModelAuthAware with model: falls through to default model and emits a warn', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      model: DEFAULT_AUXILIARY_MODEL,
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const settings = createSettings();
    await callWithModelAuthAware(settings, 'model:', btsOptions(), { category: 'memory' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, requestInit] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(requestInit?.body)) as { model?: string };
    expect(body.model).toBe(DEFAULT_AUXILIARY_MODEL);
    expectSinkWarn('callWithModelAuthAware', 'model:');
  });

  it('callWithModelAuthAware with undefined uses default model without sink warn', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      model: DEFAULT_AUXILIARY_MODEL,
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const settings = createSettings();
    await callWithModelAuthAware(settings, undefined, btsOptions(), { category: 'memory' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, requestInit] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(requestInit?.body)) as { model?: string };
    expect(body.model).toBe(DEFAULT_AUXILIARY_MODEL);
    expect(logWarnMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ sinkName: 'callWithModelAuthAware' }),
      BACKSTOP_WARN,
    );
  });

  it('executeWithStructuredOutputProfileFallback strips model:gpt-5.4-mini and emits a warn', async () => {
    const executeForModel = vi.fn(async (modelToUse: string) => ({
      response: { content: [{ type: 'text', text: 'ok' }], model: modelToUse },
      resolvedModel: modelToUse,
      profile: null,
      resolvedAuth: 'api-key',
    }));

    const result = await executeWithStructuredOutputProfileFallback(
      'model:gpt-5.4-mini',
      btsOptions(),
      undefined,
      'memory',
      executeForModel,
    );

    expect(executeForModel).toHaveBeenCalledWith('gpt-5.4-mini', { backgroundFallbackAttempted: false });
    expect(result.resolvedModel).toBe('gpt-5.4-mini');
    expectSinkWarn('executeWithStructuredOutputProfileFallback', 'model:gpt-5.4-mini');
  });

  it('executeWithStructuredOutputProfileFallback throws when model strips to empty and emits a warn', async () => {
    const executeForModel = vi.fn(async (modelToUse: string) => ({
      response: { content: [{ type: 'text', text: 'ok' }], model: modelToUse },
      resolvedModel: modelToUse,
      profile: null,
      resolvedAuth: 'api-key',
    }));

    await expect(
      executeWithStructuredOutputProfileFallback(
        'model:',
        btsOptions(),
        undefined,
        'memory',
        executeForModel,
      ),
    ).rejects.toThrow(
      "executeWithStructuredOutputProfileFallback: invalid model value 'model:' after sink-boundary decode. Empty model id after stripping prefix.",
    );

    expect(executeForModel).not.toHaveBeenCalled();
    expectSinkWarn('executeWithStructuredOutputProfileFallback', 'model:');
  });

  it('does not warn when model is already bare', async () => {
    const executeForModel = vi.fn(async (modelToUse: string) => ({
      response: { content: [{ type: 'text', text: 'ok' }], model: modelToUse },
      resolvedModel: modelToUse,
      profile: null,
      resolvedAuth: 'api-key',
    }));

    await executeWithStructuredOutputProfileFallback(
      'gpt-5.4-mini',
      btsOptions(),
      undefined,
      undefined,
      executeForModel,
    );

    expect(executeForModel).toHaveBeenCalledWith('gpt-5.4-mini', { backgroundFallbackAttempted: false });
    expect(logWarnMock).not.toHaveBeenCalledWith(expect.objectContaining({ sinkName: expect.any(String) }), BACKSTOP_WARN);
  });

  it('does not warn when model is a profile ref', async () => {
    const executeForModel = vi.fn(async (modelToUse: string) => ({
      response: { content: [{ type: 'text', text: 'ok' }], model: modelToUse },
      resolvedModel: modelToUse,
      profile: null,
      resolvedAuth: 'api-key',
    }));

    await executeWithStructuredOutputProfileFallback(
      'profile:abc-123',
      btsOptions(),
      undefined,
      undefined,
      executeForModel,
    );

    expect(executeForModel).toHaveBeenCalledWith('profile:abc-123', { backgroundFallbackAttempted: false });
    expect(logWarnMock).not.toHaveBeenCalledWith(expect.objectContaining({ sinkName: expect.any(String) }), BACKSTOP_WARN);
  });
});
