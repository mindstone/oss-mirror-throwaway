/**
 * BTS wire-safety for sampling-forbidden / always-on-thinking models.
 *
 * Sampling-forbidden models reject sampling params (`temperature`/`top_p`/
 * `top_k`) with a 400. Always-on-thinking models also risk tiny BTS token
 * budgets being consumed entirely by thinking. `sanitizeBtsOptionsForWireModel`
 * is the per-dispatch chokepoint: strips sampling params for sampling-forbidden
 * models, floors max_tokens for always-on models, and returns an identity copy
 * for models that allow sampling.
 *
 * Integration tests run the REAL entry points against a fetch spy and assert
 * on the actual wire bodies — including the operational-fallback
 * non-poisoning case (primary Fable → fallback Opus keeps the caller's
 * original temperature: 0), which is the regression vector all three
 * cross-family reviewers flagged. See docs/plans/260611_fable-5-support/PLAN.md
 * Stage 4.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { apiRateLimitCooldown, safetyEvalRateLimitCooldown } from '../apiRateLimitCooldown';
import {
  ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS,
  callWithModel,
  callWithModelAuthAware,
  isAlwaysOnThinkingBudgetExhaustion,
  registerBtsProxyProviders,
  sanitizeBtsOptionsForWireModel,
  type BehindTheScenesRequestOptions,
  type BehindTheScenesResponse,
} from '../behindTheScenesClient';

const settingsStoreMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
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

function baseOptions(overrides: Partial<BehindTheScenesRequestOptions> = {}): BehindTheScenesRequestOptions {
  return {
    messages: TEST_MESSAGES,
    codexConnectivity: 'unknown',
    ...overrides,
  };
}

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

function anthropicSuccessResponse(model: string, text: string): Response {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 7 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function openAiSuccessResponse(model: string, text: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    model,
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

function requestBody(
  fetchSpy: ReturnType<typeof vi.spyOn>,
  callIndex: number,
): Record<string, unknown> {
  const init = fetchSpy.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  const body = typeof init?.body === 'string' ? init.body : null;
  expect(body, `fetch call ${callIndex} has a string body`).toBeTruthy();
  return JSON.parse(body!) as Record<string, unknown>;
}

// ─── Sanitizer unit behaviour ────────────────────────────────────────────────

describe('sanitizeBtsOptionsForWireModel — pure per-dispatch sanitizer', () => {
  it.each([
    'claude-fable-5',
    'anthropic/claude-fable-5',
    'claude-fable-5[1m]',
  ])('strips temperature and floors maxTokens for always-on model form %s', (model) => {
    const options = baseOptions({ temperature: 0, maxTokens: 256 });
    const sanitized = sanitizeBtsOptionsForWireModel(model, options);

    expect(sanitized.temperature).toBeUndefined();
    expect(sanitized.maxTokens).toBe(ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS);
    // Structured adjustment log (pino arg order: object first).
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        model,
        strippedParams: ['temperature'],
        raisedMaxTokens: ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS,
      }),
      expect.any(String),
    );
  });

  it('NEVER mutates the caller options (purity — operational-fallback non-poisoning depends on it)', () => {
    const options = baseOptions({ temperature: 0, maxTokens: 256 });
    const sanitized = sanitizeBtsOptionsForWireModel('claude-fable-5', options);

    expect(sanitized).not.toBe(options);
    expect(options.temperature).toBe(0);
    expect(options.maxTokens).toBe(256);
  });

  it('floors an UNDEFINED maxTokens (transports default to 512 < floor)', () => {
    const sanitized = sanitizeBtsOptionsForWireModel('claude-fable-5', baseOptions());
    expect(sanitized.maxTokens).toBe(ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS);
  });

  it('leaves a caller budget above the floor untouched', () => {
    const sanitized = sanitizeBtsOptionsForWireModel(
      'claude-fable-5',
      baseOptions({ maxTokens: 8192 }),
    );
    expect(sanitized.maxTokens).toBe(8192);
  });

  it.each([
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
  ])('strips smuggled top_p/top_k for sampling-forbidden model %s', (model) => {
    const options = baseOptions({ temperature: 0.5 }) as BehindTheScenesRequestOptions & {
      top_p?: number;
      top_k?: number;
    };
    options.top_p = 0.9;
    options.top_k = 40;
    const sanitized = sanitizeBtsOptionsForWireModel(model, options) as unknown as Record<string, unknown>;
    expect(sanitized.temperature).toBeUndefined();
    expect(sanitized.top_p).toBeUndefined();
    expect(sanitized.top_k).toBeUndefined();
  });

  it.each([
    'claude-opus-4-8',
    'claude-opus-4-7',
    'anthropic/claude-opus-4.8',
  ])('strips temperature but does NOT floor maxTokens for sampling-forbidden non-always-on model %s', (model) => {
    const options = baseOptions({ temperature: 0, maxTokens: 256 });
    const sanitized = sanitizeBtsOptionsForWireModel(model, options);

    expect(sanitized).not.toBe(options);
    expect(sanitized.temperature).toBeUndefined();
    expect(sanitized.maxTokens).toBe(256);
  });

  it.each([
    'claude-opus-4-6',
    'anthropic/claude-opus-4.6',
    'claude-sonnet-4-6',
    'gpt-4o-mini',
    'openai/gpt-5.5',
  ])('identity copy for model that allows sampling params %s (temperature + maxTokens untouched)', (model) => {
    const options = baseOptions({ temperature: 0, maxTokens: 256 });
    const sanitized = sanitizeBtsOptionsForWireModel(model, options);

    expect(sanitized).not.toBe(options);
    expect(sanitized.temperature).toBe(0);
    expect(sanitized.maxTokens).toBe(256);
    expect(sanitized).toEqual(options);
  });

  it('identity copy preserves an undefined maxTokens for models that allow sampling params', () => {
    const sanitized = sanitizeBtsOptionsForWireModel('claude-opus-4-6', baseOptions({ temperature: 0 }));
    expect(sanitized.maxTokens).toBeUndefined();
  });
});

// ─── Budget-exhaustion observability predicate ──────────────────────────────

describe('isAlwaysOnThinkingBudgetExhaustion — distinct event predicate', () => {
  const exhausted: BehindTheScenesResponse = {
    content: [{ type: 'thinking' }],
    model: 'claude-fable-5',
    _stopReason: 'max_tokens',
  };

  it('true for an always-on model at max_tokens with zero text blocks', () => {
    expect(isAlwaysOnThinkingBudgetExhaustion(exhausted)).toBe(true);
    expect(isAlwaysOnThinkingBudgetExhaustion({ ...exhausted, content: [] })).toBe(true);
    expect(isAlwaysOnThinkingBudgetExhaustion({
      ...exhausted,
      content: [{ type: 'text', text: '' }],
    })).toBe(true);
  });

  it('false when text exists, stop_reason differs, model is not always-on, or stop_reason is unknown', () => {
    expect(isAlwaysOnThinkingBudgetExhaustion({
      ...exhausted,
      content: [{ type: 'text', text: 'ok' }],
    })).toBe(false);
    expect(isAlwaysOnThinkingBudgetExhaustion({ ...exhausted, _stopReason: 'end_turn' })).toBe(false);
    expect(isAlwaysOnThinkingBudgetExhaustion({ ...exhausted, model: 'claude-opus-4-8' })).toBe(false);
    expect(isAlwaysOnThinkingBudgetExhaustion({ ...exhausted, _stopReason: undefined })).toBe(false);
  });
});

// ─── Wire-level integration through the real entry points ───────────────────

describe('BTS wire safety — sampling-forbidden / always-on models through real dispatch', () => {
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

  it('anthropic-direct: Fable wire body has NO temperature and max_tokens floored (consult-shaped call: execution-route model = fable, temp 0.2)', async () => {
    fetchSpy.mockResolvedValueOnce(anthropicSuccessResponse('claude-fable-5', 'consult ok'));

    // operatorConsultRunner dispatches consults through callWithModelAuthAware
    // with temperature 0.2 — the exact path that 400s without the sanitizer.
    const result = await callWithModelAuthAware(
      createSettings(),
      'claude-fable-5',
      baseOptions({ temperature: 0.2, maxTokens: 1000 }),
      { category: 'memory' },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages');
    const body = requestBody(fetchSpy, 0);
    expect(body.model).toBe('claude-fable-5');
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS);
    expect(result.content[0]?.text).toBe('consult ok');
  });

  it('anthropic-direct: Opus 4.8 wire body strips temperature but keeps caller max_tokens', async () => {
    fetchSpy.mockResolvedValueOnce(anthropicSuccessResponse('claude-opus-4-8', 'opus ok'));

    await callWithModelAuthAware(
      createSettings(),
      'claude-opus-4-8',
      baseOptions({ temperature: 0, maxTokens: 256 }),
      { category: 'memory' },
    );

    const body = requestBody(fetchSpy, 0);
    expect(body.model).toBe('claude-opus-4-8');
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(256);
  });

  it('openrouter-proxy: OR-routed Fable wire body is sanitized (GPT F3 path pin)', async () => {
    fetchSpy.mockResolvedValueOnce(anthropicSuccessResponse('anthropic/claude-fable-5', 'or ok'));
    const settings = createSettings({ activeProvider: 'openrouter' });
    settingsStoreMocks.getSettings.mockReturnValue(settings);

    await callWithModelAuthAware(
      settings,
      'anthropic/claude-fable-5',
      baseOptions({ temperature: 0, maxTokens: 256 }),
      { category: 'memory' },
    );

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9999/v1/messages');
    const body = requestBody(fetchSpy, 0);
    expect(body.model).toBe('anthropic/claude-fable-5');
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS);
  });

  it('profile-http: non-always-on profile wire body keeps temperature and budget (GPT F3 path pin / invariant 3)', async () => {
    const primary = makeProfile();
    const settings = createSettings({
      localModel: { activeProfileId: null, profiles: [primary] },
    });
    settingsStoreMocks.getSettings.mockReturnValue(settings);
    fetchSpy.mockResolvedValueOnce(openAiSuccessResponse('gpt-4o-mini', 'profile ok'));

    await callWithModelAuthAware(
      settings,
      'profile:profile-primary',
      baseOptions({ temperature: 0, maxTokens: 256 }),
      { category: 'memory' },
    );

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://primary.example.com/v1/chat/completions');
    const body = requestBody(fetchSpy, 0);
    expect(body.temperature).toBe(0);
    expect(body.max_completion_tokens).toBe(256);
  });

  it('operational-fallback NON-POISONING: primary Fable → fallback Opus preserves caller max_tokens before re-sanitizing', async () => {
    const settings = createSettings({ backgroundFallback: 'model:claude-opus-4-8' });
    settingsStoreMocks.getSettings.mockReturnValue(settings);

    // Primary Fable dispatch fails operationally (model_unavailable)...
    fetchSpy.mockResolvedValueOnce(errorResponse(404, 'model not found'));
    // ...fallback Opus succeeds.
    fetchSpy.mockResolvedValueOnce(anthropicSuccessResponse('claude-opus-4-8', 'fallback ok'));

    const result = await callWithModelAuthAware(
      settings,
      'claude-fable-5',
      baseOptions({ temperature: 0, maxTokens: 256 }),
      { category: 'memory' },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Dispatch 1 (Fable): sanitized — no temperature, floored budget.
    const primaryBody = requestBody(fetchSpy, 0);
    expect(primaryBody.model).toBe('claude-fable-5');
    expect(primaryBody.temperature).toBeUndefined();
    expect(primaryBody.max_tokens).toBe(ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS);

    // Dispatch 2 (Opus fallback): re-sanitized from the CALLER'S ORIGINAL
    // options — Opus 4.8 strips temperature, but the caller budget survives
    // instead of inheriting Fable's max_tokens floor.
    const fallbackBody = requestBody(fetchSpy, 1);
    expect(fallbackBody.model).toBe('claude-opus-4-8');
    expect(fallbackBody.temperature).toBeUndefined();
    expect(fallbackBody.max_tokens).toBe(256);

    expect(result.content[0]?.text).toBe('fallback ok');
  });

  it('legacy callWithModel entry point routes its direct callAnthropic branch through the sanitizer', async () => {
    fetchSpy.mockResolvedValueOnce(anthropicSuccessResponse('claude-fable-5', 'legacy ok'));

    await callWithModel(
      'fake-ant-test-key',
      'claude-fable-5',
      undefined,
      baseOptions({ temperature: 0, maxTokens: 256 }),
    );

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages');
    const body = requestBody(fetchSpy, 0);
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS);
  });

  it('emits the distinct budget-exhaustion event when an always-on reply hits max_tokens with zero text', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'thinking' }],
      model: 'claude-fable-5',
      stop_reason: 'max_tokens',
      usage: { input_tokens: 12, output_tokens: 2048 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await callWithModelAuthAware(
      createSettings(),
      'claude-fable-5',
      baseOptions({ maxTokens: 256 }),
      { category: 'memory' },
    );

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'bts_always_on_thinking_budget_exhausted',
        model: 'claude-fable-5',
      }),
      expect.any(String),
    );
  });

  it('does NOT emit the budget-exhaustion event for a normal Fable reply', async () => {
    fetchSpy.mockResolvedValueOnce(anthropicSuccessResponse('claude-fable-5', 'fine'));

    await callWithModelAuthAware(
      createSettings(),
      'claude-fable-5',
      baseOptions({ maxTokens: 256 }),
      { category: 'memory' },
    );

    const exhaustionCalls = mockLog.warn.mock.calls.filter(
      ([ctx]) => (ctx as { event?: string } | undefined)?.event === 'bts_always_on_thinking_budget_exhausted',
    );
    expect(exhaustionCalls).toHaveLength(0);
  });

  describe('isAlwaysOnThinkingBudgetExhaustion — response-model echo forms (GPT F1)', () => {
    const exhaustedReply = (model: string): BehindTheScenesResponse => ({
      content: [{ type: 'thinking' }],
      model,
      _stopReason: 'max_tokens',
      usage: { input_tokens: 12, output_tokens: 2048 },
    });

    it('recognizes OpenRouter\'s internal canonical Fable slug (legacyIds resolution)', () => {
      // OR echoes its own canonical slug, not the catalog id; legacyIds only
      // resolve via the OR chain, not normalizeForCapabilityCheck.
      expect(isAlwaysOnThinkingBudgetExhaustion(exhaustedReply('anthropic/claude-5-fable-20260609'))).toBe(true);
    });

    it('recognizes the catalog OR id and the plain SDK id', () => {
      expect(isAlwaysOnThinkingBudgetExhaustion(exhaustedReply('anthropic/claude-fable-5'))).toBe(true);
      expect(isAlwaysOnThinkingBudgetExhaustion(exhaustedReply('claude-fable-5'))).toBe(true);
    });

    it('stays false for non-always-on echoes, including OR legacy Opus slugs', () => {
      expect(isAlwaysOnThinkingBudgetExhaustion(exhaustedReply('claude-opus-4-8'))).toBe(false);
      expect(isAlwaysOnThinkingBudgetExhaustion(exhaustedReply('anthropic/claude-opus-4.8'))).toBe(false);
    });
  });
});
