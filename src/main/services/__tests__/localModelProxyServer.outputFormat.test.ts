 
/**
 * Proxy-side regression tests for `output_format` propagation on the four
 * non-Codex helper application sites in `localModelProxyServer.ts`:
 *
 *   1. `handleStreamingRequest` (~line 2225) — generic OpenAI-compat streaming
 *   2. `handleStreamingViaResponsesApi` (~line 2962) — Responses-API streaming
 *   3. Generic Responses-API non-streaming branch (~line 3567)
 *   4. Generic OpenAI-compat non-streaming branch (~line 3624)
 *
 * Each test asserts that an inbound Anthropic-shaped `output_format` is
 * translated to the upstream-API enforcement field (`response_format.json_schema`
 * for chat completions, `text.format.json_schema` for the Responses API), with
 * Chat-Completions sampling params gated by model capability. Closes the bug-class gap identified in
 * `docs-private/investigations/260509_bts_output_format_dropped_codex_proxy.md`:
 * the Codex passthrough branches already had regression coverage in
 * `localModelProxyServer.codexSubscription.test.ts`; the four non-Codex
 * helper application sites did not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({ providerKeys: { openai: 'fake-shared-openai' }, customProviders: [] }),
}));

vi.mock('@core/codexAuth', () => ({
  CODEX_ENDPOINT_URL: 'https://chatgpt.com/backend-api/codex',
  getCodexAuthProvider: vi.fn(() => ({
    isConnected: vi.fn(() => false),
    getAccessToken: vi.fn(async () => 'codex-token'),
    getAccountId: vi.fn(() => 'org_123'),
    forceRefreshToken: vi.fn(async () => 'codex-token-refreshed'),
    getStatus: vi.fn(() => ({ connected: false })),
  })),
}));

import { proxyManager, type ModelRouteTable } from '../localModelProxyServer';

function makeNonCodexOpenAIProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'gpt-direct',
    name: 'GPT direct',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    createdAt: 0,
    ...overrides,
  };
}

function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; contentType: string }> {
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
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            contentType: (res.headers['content-type'] as string | undefined) ?? '',
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function makeChatCompletionsJsonResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl_456',
      model: 'gpt-5.5',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '{"x":1}' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeChatCompletionsStreamingResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl_stream","model":"gpt-5.5","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"{"},"finish_reason":null}]}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl_stream","model":"gpt-5.5","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n',
        ),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeResponsesApiJsonResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'resp_456',
      model: 'gpt-5.5',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '{"x":1}', annotations: [] }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 3 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeResponsesApiStreamingResponse(): Response {
  const encoder = new TextEncoder();
  const completedResponse = {
    id: 'resp_stream',
    model: 'gpt-5.5',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '{"x":1}', annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    status: 'completed',
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'event: response.created\ndata: {"type":"response.created","id":"resp_stream","model":"gpt-5.5"}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`,
        ),
      );
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface CapturedUpstream {
  url: string;
  body: Record<string, unknown>;
}

let nextPort = 49800;

describe('localModelProxyServer non-Codex output_format / temperature propagation', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let captured: CapturedUpstream[] = [];

  beforeEach(() => {
    captured = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      let parsedBody: Record<string, unknown> = {};
      try {
        parsedBody = JSON.parse(bodyStr) as Record<string, unknown>;
      } catch {
        /* leave empty */
      }
      captured.push({ url: urlStr, body: parsedBody });

      if (urlStr.includes('/v1/responses') || urlStr.endsWith('/responses')) {
        if (parsedBody.stream === true) return makeResponsesApiStreamingResponse();
        return makeResponsesApiJsonResponse();
      }
      if (urlStr.includes('/v1/chat/completions') || urlStr.endsWith('/chat/completions')) {
        if (parsedBody.stream === true) return makeChatCompletionsStreamingResponse();
        return makeChatCompletionsJsonResponse();
      }
      return new Response('not-found', { status: 404 });
    });
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await proxyManager.stop();
    nextPort += 10;
  });

  it('handleStreamingRequest forwards output_format and strips temperature for OpenAI reasoning chat completions streaming', async () => {
    const profile = makeNonCodexOpenAIProfile();
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', profile]]) };
    await proxyManager.addRoutes('turn-stream-chat', routeTable, undefined, nextPort++, false, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const inboundSchema = {
      type: 'object',
      properties: { x: { type: 'number' } },
      required: ['x'],
      additionalProperties: false,
    };

    await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        temperature: 0.4,
        output_format: { type: 'json_schema', schema: inboundSchema },
      }),
      token,
      { 'x-routed-turn-id': 'turn-stream-chat', 'x-routed-model': 'gpt-5.5' },
    );

    const upstream = captured.find((entry) => entry.url.includes('/chat/completions'));
    expect(upstream).toBeDefined();
    const body = upstream!.body as {
      stream?: boolean;
      temperature?: number;
      response_format?: { type?: string; json_schema?: { name?: string; schema?: unknown } };
    };
    expect(body.stream).toBe(true);
    expect(body.temperature).toBeUndefined();
    expect(body.response_format?.type).toBe('json_schema');
    expect(body.response_format?.json_schema?.name).toBe('structured_output');
    expect(body.response_format?.json_schema?.schema).toEqual(inboundSchema);
  });

  it('handleStreamingRequest preserves temperature for OpenAI non-reasoning chat completions streaming', async () => {
    const profile = makeNonCodexOpenAIProfile({ model: 'gpt-4.1' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-4.1', profile]]) };
    await proxyManager.addRoutes('turn-stream-chat-non-reasoning', routeTable, undefined, nextPort++, false, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-4.1',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        temperature: 0.4,
      }),
      token,
      { 'x-routed-turn-id': 'turn-stream-chat-non-reasoning', 'x-routed-model': 'gpt-4.1' },
    );

    const upstream = captured.find((entry) => entry.url.includes('/chat/completions'));
    expect(upstream).toBeDefined();
    expect(upstream!.body.temperature).toBe(0.4);
  });

  it('handleStreamingRequest strips reasoning_effort for OpenAI non-reasoning chat completions streaming', async () => {
    const profile = makeNonCodexOpenAIProfile({ model: 'gpt-4.1', reasoningEffort: 'high' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-4.1', profile]]) };
    await proxyManager.addRoutes('turn-stream-chat-effort-non-reasoning', routeTable, undefined, nextPort++, false, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-4.1',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        temperature: 0.4,
      }),
      token,
      { 'x-routed-turn-id': 'turn-stream-chat-effort-non-reasoning', 'x-routed-model': 'gpt-4.1' },
    );

    const upstream = captured.find((entry) => entry.url.includes('/chat/completions'));
    expect(upstream).toBeDefined();
    expect(upstream!.body.stream).toBe(true);
    expect(upstream!.body.temperature).toBe(0.4);
    expect(upstream!.body).not.toHaveProperty('reasoning_effort');
  });

  it('handleStreamingRequest preserves reasoning_effort for OpenAI reasoning chat completions streaming', async () => {
    const profile = makeNonCodexOpenAIProfile({ reasoningEffort: 'high' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', profile]]) };
    await proxyManager.addRoutes('turn-stream-chat-effort-reasoning', routeTable, undefined, nextPort++, false, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
      token,
      { 'x-routed-turn-id': 'turn-stream-chat-effort-reasoning', 'x-routed-model': 'gpt-5.5' },
    );

    const upstream = captured.find((entry) => entry.url.includes('/chat/completions'));
    expect(upstream).toBeDefined();
    expect(upstream!.body.stream).toBe(true);
    expect(upstream!.body.reasoning_effort).toBe('high');
  });

  it('handleStreamingViaResponsesApi forwards output_format → text.format.json_schema and strips temperature on Responses-API streaming (reasoning models reject it)', async () => {
    const profile = makeNonCodexOpenAIProfile({ reasoningEffort: 'high' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', profile]]) };
    await proxyManager.addRoutes('turn-stream-resp', routeTable, undefined, nextPort++, false, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const inboundSchema = {
      type: 'object',
      properties: { y: { type: 'string' } },
      required: ['y'],
      additionalProperties: false,
    };

    await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        temperature: 0.6,
        tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
        output_format: { type: 'json_schema', schema: inboundSchema },
      }),
      token,
      { 'x-routed-turn-id': 'turn-stream-resp', 'x-routed-model': 'gpt-5.5' },
    );

    const upstream = captured.find((entry) => entry.url.includes('/v1/responses'));
    expect(upstream).toBeDefined();
    const body = upstream!.body as {
      stream?: boolean;
      temperature?: number;
      text?: { format?: { type?: string; name?: string; schema?: unknown } };
    };
    expect(body.stream).toBe(true);
    // OpenAI reasoning models on the Responses API reject temperature; it is stripped at the translator.
    expect(body.temperature).toBeUndefined();
    expect(body.text?.format?.type).toBe('json_schema');
    expect(body.text?.format?.name).toBe('structured_output');
    expect(body.text?.format?.schema).toEqual(inboundSchema);
  });

  it('forwardViaResponsesApi (non-streaming Responses-API branch) forwards output_format and strips temperature (reasoning models reject it)', async () => {
    const profile = makeNonCodexOpenAIProfile({ reasoningEffort: 'high' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', profile]]) };
    await proxyManager.addRoutes('turn-ns-resp', routeTable, undefined, nextPort++, false, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const inboundSchema = {
      type: 'object',
      properties: { z: { type: 'number' } },
      required: ['z'],
      additionalProperties: false,
    };

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        temperature: 0.1,
        tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
        output_format: { type: 'json_schema', schema: inboundSchema },
      }),
      token,
      { 'x-routed-turn-id': 'turn-ns-resp', 'x-routed-model': 'gpt-5.5' },
    );

    expect(response.status).toBe(200);
    const upstream = captured.find((entry) => entry.url.includes('/v1/responses'));
    expect(upstream).toBeDefined();
    const body = upstream!.body as {
      stream?: boolean;
      temperature?: number;
      text?: { format?: { type?: string; schema?: unknown } };
    };
    expect(body.stream).toBe(false);
    // OpenAI reasoning models on the Responses API reject temperature; it is stripped at the translator.
    expect(body.temperature).toBeUndefined();
    expect(body.text?.format?.type).toBe('json_schema');
    expect(body.text?.format?.schema).toEqual(inboundSchema);
  });

  it('forwardToLocalModel (non-streaming chat completions branch) forwards output_format and strips temperature for OpenAI reasoning models', async () => {
    const profile = makeNonCodexOpenAIProfile();
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', profile]]) };
    await proxyManager.addRoutes('turn-ns-chat', routeTable, undefined, nextPort++, false, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const inboundSchema = {
      type: 'object',
      properties: { w: { type: 'boolean' } },
      required: ['w'],
      additionalProperties: false,
    };

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        temperature: 0.9,
        output_format: { type: 'json_schema', schema: inboundSchema },
      }),
      token,
      { 'x-routed-turn-id': 'turn-ns-chat', 'x-routed-model': 'gpt-5.5' },
    );

    expect(response.status).toBe(200);
    const upstream = captured.find((entry) => entry.url.includes('/chat/completions'));
    expect(upstream).toBeDefined();
    const body = upstream!.body as {
      stream?: boolean;
      temperature?: number;
      response_format?: { type?: string; json_schema?: { name?: string; schema?: unknown } };
    };
    expect(body.stream).toBe(false);
    expect(body.temperature).toBeUndefined();
    expect(body.response_format?.type).toBe('json_schema');
    expect(body.response_format?.json_schema?.name).toBe('structured_output');
    expect(body.response_format?.json_schema?.schema).toEqual(inboundSchema);
  });

  it('forwardToLocalModel preserves temperature for OpenAI non-reasoning chat completions models', async () => {
    const profile = makeNonCodexOpenAIProfile({ model: 'gpt-4.1' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-4.1', profile]]) };
    await proxyManager.addRoutes('turn-ns-chat-non-reasoning', routeTable, undefined, nextPort++, false, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-4.1',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        temperature: 0.9,
      }),
      token,
      { 'x-routed-turn-id': 'turn-ns-chat-non-reasoning', 'x-routed-model': 'gpt-4.1' },
    );

    expect(response.status).toBe(200);
    const upstream = captured.find((entry) => entry.url.includes('/chat/completions'));
    expect(upstream).toBeDefined();
    expect(upstream!.body.stream).toBe(false);
    expect(upstream!.body.temperature).toBe(0.9);
  });

  it('forwardToLocalModel strips reasoning_effort for OpenAI non-reasoning chat completions models', async () => {
    const profile = makeNonCodexOpenAIProfile({ model: 'gpt-4.1', reasoningEffort: 'high' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-4.1', profile]]) };
    await proxyManager.addRoutes('turn-ns-chat-effort-non-reasoning', routeTable, undefined, nextPort++, false, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-4.1',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        temperature: 0.9,
      }),
      token,
      { 'x-routed-turn-id': 'turn-ns-chat-effort-non-reasoning', 'x-routed-model': 'gpt-4.1' },
    );

    expect(response.status).toBe(200);
    const upstream = captured.find((entry) => entry.url.includes('/chat/completions'));
    expect(upstream).toBeDefined();
    expect(upstream!.body.stream).toBe(false);
    expect(upstream!.body.temperature).toBe(0.9);
    expect(upstream!.body).not.toHaveProperty('reasoning_effort');
  });

  it('forwardToLocalModel preserves reasoning_effort for OpenAI reasoning chat completions models', async () => {
    const profile = makeNonCodexOpenAIProfile({ reasoningEffort: 'high' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', profile]]) };
    await proxyManager.addRoutes('turn-ns-chat-effort-reasoning', routeTable, undefined, nextPort++, false, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
      token,
      { 'x-routed-turn-id': 'turn-ns-chat-effort-reasoning', 'x-routed-model': 'gpt-5.5' },
    );

    expect(response.status).toBe(200);
    const upstream = captured.find((entry) => entry.url.includes('/chat/completions'));
    expect(upstream).toBeDefined();
    expect(upstream!.body.stream).toBe(false);
    expect(upstream!.body.reasoning_effort).toBe('high');
  });
});
