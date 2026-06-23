/**
 * Proxy Reasoning Effort Injection Tests
 *
 * Verifies that `reasoning_effort` is correctly included/omitted in the
 * OpenAI request body depending on the profile's `reasoningEffort` field.
 *
 * Both streaming and non-streaming request paths are covered.
 * Anthropic passthrough (Claude models) is verified to skip injection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';

// Mock the settings store (proxy imports getSettings for provider key resolution).
// `models.apiKey` satisfies handleAnthropicPassthrough's fail-closed auth gate;
// the claude key remains as legacy fixture coverage.
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({
    claude: { apiKey: 'fake-test-anthropic-key' },
    models: { apiKey: 'fake-test-anthropic-key' },
    providerKeys: {},
  }),
}));

import {
  proxyManager,
} from '../localModelProxyServer';
import type { ModelRouteTable } from '../localModelProxyServer';

// ── Helpers ────────────────────────────────────────────────────────

/** Minimal profile factory */
function makeProfile(overrides: Partial<ModelProfile> & { id: string; name: string }): ModelProfile {
  return {
    serverUrl: 'http://localhost:11434',
    createdAt: Date.now(),
    model: 'test-model',
    ...overrides,
  };
}

/** Build a minimal Anthropic Messages API request body */
function makeAnthropicBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'test-model',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
    ...overrides,
  });
}

/** Send an HTTP POST to the proxy and return parsed response */
function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${proxyUrl}/v1/messages`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Auth': authToken,
          Host: '127.0.0.1',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Fake upstream OpenAI response ──────────────────────────────────

function fakeOpenAIResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: Date.now(),
      model: 'test-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Test response' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    text: async () => '',
  };
}

// ── Tests ──────────────────────────────────────────────────────────

// Use a unique port range to avoid conflicts with other tests / running proxy
let testPort = 19800;

describe('proxy reasoning_effort injection', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let capturedBodies: Record<string, unknown>[] = [];
  let capturedUrls: string[] = [];

  beforeEach(() => {
    capturedBodies = [];
    capturedUrls = [];
    // Mock global.fetch to intercept outgoing requests to the upstream model
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedUrls.push(String(_url));
      if (init?.body) {
        capturedBodies.push(JSON.parse(init.body as string));
      }
      return fakeOpenAIResponse() as unknown as Response;
    });
  });

  afterEach(async () => {
    proxyManager.clearBaseProfile();
    proxyManager.removeRoutes('__test__');
    await proxyManager.stop();
    fetchSpy.mockRestore();
    testPort += 10; // Avoid port conflicts between tests
  });

  it('includes reasoning_effort: "high" when profile has reasoningEffort: "high"', async () => {
    const profile = makeProfile({
      id: 'gpt52-high',
      name: 'GPT-5.2 High',
      model: 'gpt-5.2',
      reasoningEffort: 'high',
    });

    const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
    const token = proxyManager.getAuthToken()!;
    const body = makeAnthropicBody({ model: 'gpt-5.2' });

    await sendToProxy(proxyUrl, body, token);

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).toHaveProperty('reasoning_effort', 'high');
  });

  it('includes reasoning_effort: "medium" when profile has reasoningEffort: "medium"', async () => {
    const profile = makeProfile({
      id: 'gpt52-med',
      name: 'GPT-5.2 Med',
      model: 'gpt-5.2',
      reasoningEffort: 'medium',
    });

    const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
    const token = proxyManager.getAuthToken()!;
    const body = makeAnthropicBody({ model: 'gpt-5.2' });

    await sendToProxy(proxyUrl, body, token);

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).toHaveProperty('reasoning_effort', 'medium');
  });

  it('includes reasoning_effort: "low" when profile has reasoningEffort: "low"', async () => {
    const profile = makeProfile({
      id: 'gpt52-low',
      name: 'GPT-5.2 Low',
      model: 'gpt-5.2',
      reasoningEffort: 'low',
    });

    const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
    const token = proxyManager.getAuthToken()!;
    const body = makeAnthropicBody({ model: 'gpt-5.2' });

    await sendToProxy(proxyUrl, body, token);

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).toHaveProperty('reasoning_effort', 'low');
  });

  it('includes reasoning_effort: "xhigh" when profile has reasoningEffort: "xhigh"', async () => {
    const profile = makeProfile({
      id: 'gpt52-xhigh',
      name: 'GPT-5.2 Pro',
      model: 'gpt-5.2-pro',
      reasoningEffort: 'xhigh',
    });

    const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
    const token = proxyManager.getAuthToken()!;
    const body = makeAnthropicBody({ model: 'gpt-5.2-pro' });

    await sendToProxy(proxyUrl, body, token);

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).toHaveProperty('reasoning_effort', 'xhigh');
  });

  it('uses developer role for GPT-5+ models', async () => {
    const profile = makeProfile({
      id: 'gpt52-dev-role',
      name: 'GPT-5.2',
      model: 'gpt-5.2',
    });

    const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
    const token = proxyManager.getAuthToken()!;
    const body = makeAnthropicBody({
      model: 'gpt-5.2',
      system: 'You are a helpful assistant.',
    });

    await sendToProxy(proxyUrl, body, token);

    expect(capturedBodies).toHaveLength(1);
    const messages = capturedBodies[0].messages as Array<{ role: string; content: string }>;
    const systemMsg = messages.find(m => m.role === 'developer' || m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.role).toBe('developer');
  });

  it('uses system role for non-GPT-5 models (e.g., Gemini)', async () => {
    const profile = makeProfile({
      id: 'gemini-sys-role',
      name: 'Gemini 3 Flash',
      model: 'gemini-3-flash-preview',
    });

    const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
    const token = proxyManager.getAuthToken()!;
    const body = makeAnthropicBody({
      model: 'gemini-3-flash-preview',
      system: 'You are a helpful assistant.',
    });

    await sendToProxy(proxyUrl, body, token);

    expect(capturedBodies).toHaveLength(1);
    const messages = capturedBodies[0].messages as Array<{ role: string; content: string }>;
    const systemMsg = messages.find(m => m.role === 'developer' || m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.role).toBe('system');
  });

  it('omits reasoning_effort when profile has no reasoningEffort', async () => {
    const profile = makeProfile({
      id: 'gpt52-default',
      name: 'GPT-5.2 Default',
      model: 'gpt-5.2',
      // No reasoningEffort set
    });

    const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
    const token = proxyManager.getAuthToken()!;
    const body = makeAnthropicBody({ model: 'gpt-5.2' });

    await sendToProxy(proxyUrl, body, token);

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it('omits reasoning_effort when profile is thinkingCompatibility "incompatible" (auto-detected, REBEL-5RJ)', async () => {
    // Cross-surface gate: the desktop proxy must honour the same suppression signal
    // as the direct OpenAIClient. The profile "Test" button marked this gateway
    // thinking-incompatible, so the proxy must emit NO reasoning_effort even though
    // reasoningEffort is set — a gateway that mistranslates it into a native thinking
    // shape never sees it.
    const profile = makeProfile({
      id: 'gw-incompatible',
      name: 'Gateway (Incompatible)',
      model: 'gpt-5.2',
      reasoningEffort: 'high',
      thinkingCompatibility: 'incompatible',
    });

    const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
    const token = proxyManager.getAuthToken()!;
    const body = makeAnthropicBody({ model: 'gpt-5.2' });

    await sendToProxy(proxyUrl, body, token);

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it('keeps a suppressed openai+tools profile on chat/completions, not the Responses route (REBEL-5RJ)', async () => {
    // `needsResponsesApiRoute` now keys on the SAME suppression-aware effort the wire
    // body uses, so a suppressed profile that would otherwise take the reasoning+tools
    // Responses route instead stays on chat/completions — route decision and body can't
    // disagree. (The positive non-suppressed → /responses route is deferred; it needs a
    // Responses-API fake-response harness — see PLAN Discovered Improvements.)
    const profile = makeProfile({
      id: 'gw-openai-tools-off',
      name: 'OpenAI gateway + tools (incompatible)',
      model: 'gpt-5.2',
      providerType: 'openai',
      apiKey: 'fake-openai-key',
      reasoningEffort: 'high',
      thinkingCompatibility: 'incompatible',
    });

    const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
    const token = proxyManager.getAuthToken()!;
    const body = makeAnthropicBody({
      model: 'gpt-5.2',
      tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: {} } }],
    });

    await sendToProxy(proxyUrl, body, token);

    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).not.toContain('/responses');
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it('includes reasoning_effort in streaming requests', async () => {
    const profile = makeProfile({
      id: 'gpt52-stream',
      name: 'GPT-5.2 Stream',
      model: 'gpt-5.2',
      reasoningEffort: 'high',
    });

    const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
    const token = proxyManager.getAuthToken()!;
    const body = makeAnthropicBody({ model: 'gpt-5.2', stream: true });

    // For streaming, fetch returns an SSE stream. Mock it accordingly.
    fetchSpy.mockRestore();
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.body) {
        capturedBodies.push(JSON.parse(init.body as string));
      }
      // Return a minimal SSE streaming response
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const chunk = `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":${Date.now()},"model":"gpt-5.2","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":${Date.now()},"model":"gpt-5.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}\n\ndata: [DONE]\n\n`;
          controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: stream,
      } as unknown as Response;
    });

    await sendToProxy(proxyUrl, body, token);

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).toHaveProperty('reasoning_effort', 'high');
    expect(capturedBodies[0]).toHaveProperty('stream', true);
  });

  it('omits reasoning_effort for Anthropic passthrough (Claude models)', async () => {
    // In multi-route mode, Claude models are passed through to Anthropic API
    // via handleAnthropicPassthrough — no OpenAI request constructed, no reasoning_effort injected.
    const gptProfile = makeProfile({
      id: 'gpt52',
      name: 'GPT-5.2',
      model: 'gpt-5.2',
      reasoningEffort: 'high',
      councilEnabled: true,
    });

    const routeTable: ModelRouteTable = {
      routes: new Map([['gpt-5.2', gptProfile]]),
    };

    await proxyManager.addRoutes('__test__', routeTable, undefined, testPort);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // Send a request for a Claude model — should passthrough to Anthropic, not translate
    const body = makeAnthropicBody({ model: 'claude-sonnet-4-5' });

    // Mock fetch for the Anthropic passthrough (which forwards the raw body)
    fetchSpy.mockRestore();
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.body) {
        const parsed = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as ArrayBuffer));
        capturedBodies.push(parsed);
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          model: 'claude-sonnet-4-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        body: null,
      } as unknown as Response;
    });

    await sendToProxy(proxyUrl, body, token);

    // The passthrough path sends the raw Anthropic body, not an OpenAI-translated one
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).not.toHaveProperty('reasoning_effort');
    // The body should still be in Anthropic format (has max_tokens, not max_completion_tokens)
    expect(capturedBodies[0]).toHaveProperty('max_tokens');
    expect(capturedBodies[0]).not.toHaveProperty('max_completion_tokens');
  });
});
