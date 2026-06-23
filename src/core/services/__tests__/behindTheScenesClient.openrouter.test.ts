import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSettings } from '@shared/types';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import { ModelError } from '@core/rebelCore/modelErrors';

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

 
vi.mock('../codexAuthCore', () => ({
  isCodexConnected: vi.fn(() => false),
}));

vi.mock('@core/utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn().mockReturnValue(false),
  isUsingOAuth: vi.fn().mockReturnValue(false),
  isUsingOpenRouter: vi.fn().mockReturnValue(true),
  getAuthEnvVars: vi.fn().mockReturnValue({}),
  // R1 guard: direct-Anthropic shortcut requires the active provider to be
  // actually Anthropic. In OR-test settings, return false (OR is active).
  isDirectAnthropicConfig: vi.fn().mockReturnValue(false),
}));

vi.mock('@core/utils/systemUtils', () => ({
  setupNodeEnvironment: vi.fn().mockResolvedValue('/usr/bin'),
}));

import { appendCostEntry } from '../costLedgerService';

import {
  callBehindTheScenes,
  callBehindTheScenesWithAuth,
  callWithModelAuthAware,
  registerBtsProxyProviders,
  declareNoBtsProxy,
} from '../behindTheScenesClient';
import { BtsProxyNotWiredError, __resetBtsProxyProvidersForTesting } from '../bts/transports/shared';

function createOpenRouterSettings(): AppSettings {
  const settings = {
    activeProvider: 'openrouter',
    models: {},
    coreDirectory: '/tmp/test',
    openRouter: { enabled: true, oauthToken: 'fake-or-test-key' },
  } as AppSettings;

  setSettingsStoreAdapter({
    getSettings: () => settings,
    updateSettings: () => {},
    updateSettingsAtomic: () => {},
  });

  return settings;
}

async function expectRejectedModelError(
  promise: Promise<unknown>,
  expected: Partial<ModelError>,
): Promise<ModelError> {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject(expected);
    return error as ModelError;
  }
}

describe('BTS OpenRouter proxy routing', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    // Reset the proxy seam to the unwired state between tests. With the combined
    // API there is no "register null" hack — unwired is simply "never wired."
    __resetBtsProxyProvidersForTesting();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('rejects an unwired proxy seam at dispatch with the DISTINCT BtsProxyNotWiredError (F1)', async () => {
    // beforeEach reset the seam to unwired (no registerBtsProxyProviders /
    // declareNoBtsProxy call). The FULL dispatch path builds a route plan and
    // carries the (null) proxy runtime into the adapter, so the adapter's
    // `plan?.proxyBaseURL` branch would skip the HARD resolver and only fire the
    // generic transient guard. F1 hard-asserts wiring at decision-time (once the
    // route is known to be proxy-backed), so an UNWIRED proxy on the PRIMARY path
    // now fails LOUD with the distinct BtsProxyNotWiredError + the
    // `bts-proxy-unwired` marker — the refactor's main observability goal, on the
    // path that matters (the original eval incident).
    const settings = createOpenRouterSettings();
    await expect(
      callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' })
    ).rejects.toBeInstanceOf(BtsProxyNotWiredError);
  });

  it('throws the transient "proxy not available" guard when wired but auth returns null (proxy stopped)', async () => {
    // Wired (not a bootstrap bug) but auth transiently unavailable — this is the
    // legitimate restart-pending / stopped state, NOT the unwired error. The
    // adapter's own `if (!proxyUrl || !proxyAuth) throw` guard fires here.
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => null });
    const settings = createOpenRouterSettings();
    await expect(
      callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' })
    ).rejects.toThrow('OpenRouter proxy not available');
  });

  it('explicit declareNoBtsProxy() on full dispatch yields the generic transient guard, NOT the unwired error (I5)', async () => {
    // Explicit-`none` is a legitimate runtime state (teardown / direct-only
    // surface), NOT a bootstrap bug. The decision-time assert no-ops on `none`,
    // so dispatch proceeds and the adapter's own `if (!url || !auth) throw`
    // transient guard fires — the distinct BtsProxyNotWiredError must NOT appear.
    declareNoBtsProxy();
    const settings = createOpenRouterSettings();
    await expect(
      callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' })
    ).rejects.toThrow('OpenRouter proxy not available');
  });

  it('routes through proxy with correct headers via callBehindTheScenesWithAuth', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    const result = await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'safety' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9999/v1/messages');
    expect((init?.headers as Record<string, string>)['x-proxy-auth']).toBe('test-proxy-token');
    expect((init?.headers as Record<string, string>)['x-openrouter-turn']).toBe('true');
    expect(result._resolvedAuth).toBe('openrouter');
    expect(result.content[0].text).toBe('response');
  });

  it('routes through proxy via callWithModelAuthAware', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'auth-aware response' }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 8, output_tokens: 3 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    const result = await callWithModelAuthAware(settings, undefined, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'memory' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9999/v1/messages');
    expect(result._resolvedAuth).toBe('openrouter');
    expect(result.content[0].text).toBe('auth-aware response');
  });

  // Plan 260419 matrix row 18 / plan 260422 R1: when OpenRouter is the active
  // provider, a lingering claude.apiKey must NOT silently bypass the OR proxy.
  // Previously, these two tests asserted the buggy direct-Anthropic behaviour;
  // they were inverted in the R1 residual PR so they now codify the correct
  // behaviour (route through OR).
  it('routes Claude BTS through OpenRouter proxy even when an Anthropic key is configured (matrix row 18)', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'proxied response' }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    settings.models = { apiKey: 'fake-ant-test-key' } as AppSettings['models'];
    settings.behindTheScenesModel = 'claude-sonnet-4-20250514';

    const result = await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'safety' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9999/v1/messages');
    expect((init?.headers as Record<string, string>)['x-openrouter-turn']).toBe('true');
    expect(result._resolvedAuth).toBe('openrouter');
    // Ensure we did NOT send x-api-key to Anthropic directly
    expect((init?.headers as Record<string, string>)['x-api-key']).toBeUndefined();
  });

  it('routes Claude auth-aware calls through OpenRouter proxy even when an Anthropic key is configured (matrix row 18)', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'proxied auth-aware response' }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 8, output_tokens: 3 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    settings.models = { apiKey: 'fake-ant-test-key' } as AppSettings['models'];

    const result = await callWithModelAuthAware(settings, 'claude-sonnet-4-20250514', {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'memory' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9999/v1/messages');
    expect(result._resolvedAuth).toBe('openrouter');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBeUndefined();
  });

  // Plan 260422 routing test hardening — Stage 3 (row-18 legacy):
  // Symmetric with the two row-18 tests above, targeting the legacy
  // `callBehindTheScenes(...)` path at behindTheScenesClient.ts:383. R1 added
  // the `isUsingOpenRouter(settings)` branch BEFORE the direct-Anthropic
  // shortcut in this legacy path too; lock it in so a future refactor can't
  // silently reintroduce the cross-provider bypass. Note: legacy path does
  // NOT populate `_resolvedAuth` (only the *WithAuth / *AuthAware wrappers
  // do). We assert on proxy URL + x-openrouter-turn header + absent x-api-key.
  it('routes Claude BTS through OpenRouter proxy on the legacy callBehindTheScenes() path when an Anthropic key is configured (matrix row 18 — legacy)', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'proxied legacy response' }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    settings.models = { apiKey: 'fake-ant-test-key' } as AppSettings['models'];
    settings.behindTheScenesModel = 'claude-sonnet-4-20250514';

    await callBehindTheScenes(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'safety' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9999/v1/messages');
    expect((init?.headers as Record<string, string>)['x-openrouter-turn']).toBe('true');
    // Regression guard: the direct-Anthropic shortcut must NOT fire when OR is
    // active, even if a lingering claude.apiKey is present.
    expect((init?.headers as Record<string, string>)['x-api-key']).toBeUndefined();
  });

  it('classifies proxy 402 responses as billing ModelErrors', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    const body = JSON.stringify({
      error: {
        message: 'This request requires more credits, or fewer max_tokens.',
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response(body, { status: 402 }));

    const settings = createOpenRouterSettings();
    const error = await expectRejectedModelError(
      callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' }),
      {
        kind: 'billing',
        status: 402,
        provider: 'OpenRouter',
      },
    );

    expect(error.message).toBe('This request requires more credits, or fewer max_tokens.');
    expect(error.__rawMessage).toBe(body);
  });

  it('classifies proxy 429 key-limit responses as billing ModelErrors', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    const body = JSON.stringify({
      error: {
        message: 'Key limit exceeded (daily limit). Manage it using https://openrouter.ai/settings/keys',
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response(body, { status: 429 }));

    const settings = createOpenRouterSettings();
    const error = await expectRejectedModelError(
      callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' }),
      {
        kind: 'billing',
        status: 429,
        provider: 'OpenRouter',
      },
    );

    expect(error.__rawMessage).toBe(body);
  });

  it('preserves OpenRouter upstream provider_name on ModelErrors', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    const body = JSON.stringify({
      error: {
        message: 'This request requires more credits, or fewer max_tokens.',
        metadata: {
          provider_name: 'anthropic',
        },
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response(body, { status: 402 }));

    const settings = createOpenRouterSettings();
    const error = await expectRejectedModelError(
      callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' }),
      {
        kind: 'billing',
        status: 402,
        provider: 'OpenRouter',
        upstreamProvider: 'anthropic',
      },
    );

    expect(error.upstreamProvider).toBe('anthropic');
  });

  it('classifies direct Anthropic HTTP errors as ModelErrors (activeProvider=anthropic)', async () => {
    // This test exercises the direct-Anthropic error path. Post-R1, that path
    // only fires when activeProvider is Anthropic (isDirectAnthropicConfig=true).
    // Override the default OR-active mocks for this single test.
    const { isUsingOpenRouter, isDirectAnthropicConfig } = await import('@core/utils/authEnvUtils');
    vi.mocked(isUsingOpenRouter).mockReturnValueOnce(false);
    vi.mocked(isDirectAnthropicConfig).mockReturnValueOnce(true);

    const body = JSON.stringify({
      error: {
        message: 'Internal server error',
      },
    });
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(body, { status: 500 })));

    const settings = createOpenRouterSettings();
    settings.models = { apiKey: 'fake-ant-test-key' } as AppSettings['models'];
    settings.behindTheScenesModel = 'claude-sonnet-4-20250514';
    settings.activeProvider = 'anthropic';

    const error = await expectRejectedModelError(
      callBehindTheScenesWithAuth(settings, {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'test' }],
      }, { category: 'safety' }),
      {
        kind: 'server_error',
        status: 500,
        provider: 'Anthropic',
      },
    );

    expect(error.__rawMessage).toBe(body);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('inflates max_tokens for non-Anthropic models', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      model: 'z-ai/glm-5-20260211',
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    settings.behindTheScenesModel = 'z-ai/glm-5';
    await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 64,
    }, { category: 'metadata' });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    // Non-Anthropic model should get inflated max_tokens (min 4096)
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
  });

  it('does NOT inflate max_tokens for Anthropic models', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      model: 'anthropic/claude-sonnet-4.6',
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    settings.behindTheScenesModel = 'anthropic/claude-sonnet-4.6';
    await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 64,
    }, { category: 'metadata' });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.max_tokens).toBe(64);
  });

  it('passes through thinking-only response without injecting fallback text', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [
        { type: 'thinking', thinking: 'Let me reason about this...' },
        { type: 'redacted_thinking', data: 'base64stuff' },
      ],
      model: 'z-ai/glm-5-20260211',
      usage: { input_tokens: 50, output_tokens: 64 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    settings.behindTheScenesModel = 'z-ai/glm-5';
    const result = await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 64,
    }, { category: 'metadata' });

    // Should NOT inject synthetic text from thinking — let consumers handle the missing text
    const textBlock = result.content.find(b => b.type === 'text');
    expect(textBlock).toBeUndefined();
  });

  it('sends structured output headers when outputFormat is provided', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: '{}' }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    }, { category: 'safety' });

    const [, init] = fetchSpy.mock.calls[0];
    expect((init?.headers as Record<string, string>)['anthropic-beta']).toBe('structured-outputs-2025-11-13');
  });

  it('injects JSON hint for Anthropic models when outputFormat is provided (REBEL-4ZM)', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"result":"ok"}' }],
      model: 'anthropic/claude-haiku-4.5',
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'generate queries' }],
      system: 'You are a search query generator.',
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    }, { category: 'queryGeneration' });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    // JSON hint should be injected even for Anthropic models via OpenRouter
    expect(body.system).toContain('Respond with valid JSON.');
  });

  it('extracts JSON from markdown fences for Anthropic models via OpenRouter (REBEL-4ZM)', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    // Simulate OpenRouter returning JSON wrapped in markdown fences
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: '```json\n{"file_query":"test"}\n```' }],
      model: 'anthropic/claude-haiku-4.5',
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    const result = await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    }, { category: 'queryGeneration' });

    const textBlock = result.content.find(b => b.type === 'text');
    expect(textBlock?.text).toBe('{"file_query":"test"}');
  });

  it('extracts exact cost from OpenRouter response and tracks it', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 10, output_tokens: 5, cost: 0.00042 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'safety' });

    expect(appendCostEntry).toHaveBeenCalledOnce();
    expect(appendCostEntry).toHaveBeenCalledWith(
      expect.objectContaining({ cost: 0.00042, cat: 'safety' })
    );
  });

  it('falls back to token-based calculation when usage.cost is absent', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'safety' });

    // Should still track cost via calculateCostOrWarn fallback
    // (may or may not call appendCostEntry depending on model pricing availability,
    // but _exactCostUsd should NOT be set on the response)
    expect(appendCostEntry).toHaveBeenCalledWith(
      expect.objectContaining({ cat: 'safety' })
    );
    // Verify the cost is NOT the exact value (it's calculated from tokens)
    const callArgs = vi.mocked(appendCostEntry).mock.calls[0]?.[0] as { cost: number } | undefined;
    if (callArgs) {
      expect(callArgs.cost).not.toBe(0.00042);
    }
  });

  it('handles usage.cost = 0 correctly', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
    }, { category: 'safety' });

    // cost=0 is valid and should be tracked, not skipped
    expect(appendCostEntry).toHaveBeenCalledOnce();
    expect(appendCostEntry).toHaveBeenCalledWith(
      expect.objectContaining({ cost: 0, cat: 'safety' })
    );
  });

  it('skips cost tracking when no tracking options provided', async () => {
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'response' }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 10, output_tokens: 5, cost: 0.00042 },
    }), { status: 200 }));

    const settings = createOpenRouterSettings();
    // Call WITHOUT tracking parameter
    await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(appendCostEntry).not.toHaveBeenCalled();
  });
});
