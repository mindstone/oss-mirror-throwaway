 
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';

// Hoisted mutable settings holder so individual tests can install
// `localModel.profiles` / `models.workingProfileId` for tests that exercise
// `getWorkingModelProfile()` (e.g. the Codex passthrough reasoning-effort
// inheritance suite below). Default keeps the original shape used by every
// other test in this file.
const settingsMock = vi.hoisted(() => ({
  current: { providerKeys: { openai: 'fake-shared-openai' }, customProviders: [] } as Record<string, unknown>,
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => settingsMock.current,
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

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'codex-gpt-5.5',
    name: 'GPT-5.5 (ChatGPT Pro)',
    authSource: 'codex-subscription',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    createdAt: 0,
    reasoningEffort: 'high',
    ...overrides,
  };
}

function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string,
  headers: Record<string, string> = {}
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

function makeResponsesApiResponse() {
  return {
    id: 'resp_123',
    model: 'gpt-5.5',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello from Codex', annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function makeChatCompletionsResponse() {
  return {
    id: 'chatcmpl_123',
    model: 'gpt-5.5',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello from OpenAI direct' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeStreamingCodexResponse(): Response {
  const encoder = new TextEncoder();
  // Full ResponsesApiResponse payload for response.completed so the buffered
  // SSE consumer (readResponsesSseToCompletion) passes Zod validation. Used
  // by both the streaming-branch test (raw SSE forwarded to client) and the
  // non-streaming-branch test (proxy buffers this SSE → JSON via the helper).
  const completedResponse = {
    id: 'resp_1',
    model: 'gpt-5.5',
    output: [{
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Hello from Codex SSE', annotations: [] }],
    }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    status: 'completed',
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","id":"resp_1","model":"gpt-5.5"}\n\n'));
      controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n'));
      controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeUnwrappedCompletedCodexResponse(): Response {
  const encoder = new TextEncoder();
  const completedResponse = {
    type: 'response.completed',
    id: 'resp_unwrapped',
    model: 'gpt-5.5',
    output: [{
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Hello from unwrapped Codex SSE', annotations: [] }],
    }],
    usage: { input_tokens: 11, output_tokens: 6, total_tokens: 17 },
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify(completedResponse)}\n\n`));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeCompletedErrorCodexResponse(message: string): Response {
  const encoder = new TextEncoder();
  const completedResponse = {
    id: 'resp_error',
    model: 'gpt-5.5',
    output: [],
    usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    status: 'failed',
    error: { message, type: 'invalid_request_error' },
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeDeltaThenCompletedErrorCodexResponse(message: string): Response {
  const encoder = new TextEncoder();
  const completedResponse = {
    id: 'resp_delta_then_error',
    model: 'gpt-5.5',
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    status: 'failed',
    error: { message, type: 'invalid_request_error' },
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","id":"resp_delta_then_error","model":"gpt-5.5"}\n\n'));
      controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial text"}\n\n'));
      controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

let nextPort = 49600;

describe('localModelProxyServer codex subscription routing', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let capturedUrls: string[] = [];
  let capturedCodexBodies: Record<string, unknown>[] = [];

  beforeEach(() => {
    capturedUrls = [];
    capturedCodexBodies = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      capturedUrls.push(urlStr);
      const body = typeof init?.body === 'string' ? init.body : '';
      const isCodexEndpoint = urlStr.includes('chatgpt.com/backend-api/codex');

      if (isCodexEndpoint) {
        let parsedBody: Record<string, unknown> = {};
        try { parsedBody = JSON.parse(body) as Record<string, unknown>; } catch { /* leave empty */ }
        capturedCodexBodies.push(parsedBody);
        // INVARIANT: Codex Responses API rejects stream:false with HTTP 400.
        // Mock simulates real Codex behavior so any future regression to
        // stream:false fails fast in tests.
        if (parsedBody.stream !== true) {
          return new Response(
            JSON.stringify({ detail: 'Stream must be set to true' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        return makeStreamingCodexResponse();
      }
      // Direct OpenAI chat/completions for non-Codex routes — supports streaming + non-streaming.
      if (body.includes('"stream":true')) {
        return makeStreamingCodexResponse();
      }
      return new Response(JSON.stringify(makeChatCompletionsResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await proxyManager.stop();
    nextPort += 10;
  });

  it('uses the Codex endpoint for non-streaming routed profiles even when providerKeys.openai is set', async () => {
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };

    await proxyManager.addRoutes('turn-codex', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
        tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
      }),
      token,
      { 'x-routed-turn-id': 'turn-codex', 'x-routed-model': 'gpt-5.5' },
    );

    expect(response.status).toBe(200);
    expect(capturedUrls).toEqual(['https://chatgpt.com/backend-api/codex']);
  });

  it('route-resolved Codex 429 usage_limit_reached → 429/rate_limit_error/code preserved, NOT 500/api_error (REBEL-4GH route-resolved catch)', async () => {
    // The route-resolved catch must honour CodexUpstreamError.upstreamStatus (not
    // only a `statusCode` field, which CodexUpstreamError lacks) — else a Team-plan
    // quota cap collapses to 500/api_error, invisible to the QUOTA_EXHAUSTION
    // classifier. This is the path the live `addRoutes(...)` Codex traffic hits;
    // mirrors the x-codex-turn 429 contract (codexUpstreamStatus.test.ts).
    fetchSpy.mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('chatgpt.com/backend-api/codex')) {
        return new Response(
          JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 9770 } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-codex-429', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({ model: 'gpt-5.5', max_tokens: 256, messages: [{ role: 'user', content: 'Hello' }], stream: false }),
      token,
      { 'x-routed-turn-id': 'turn-codex-429', 'x-routed-model': 'gpt-5.5' },
    );

    expect(response.status, `body=${response.body}`).toBe(429);
    const parsed = JSON.parse(response.body) as { error?: { type?: string; code?: string; resets_in_seconds?: number } };
    expect(parsed.error?.type).toBe('rate_limit_error');
    expect(parsed.error?.code).toBe('usage_limit_reached');
    expect(parsed.error?.resets_in_seconds).toBe(9770);
  });

  it('uses the Codex endpoint for streaming routed profiles from the turn snapshot even when live connectivity is false', async () => {
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };

    await proxyManager.addRoutes('turn-codex-stream', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
      token,
      { 'x-routed-turn-id': 'turn-codex-stream', 'x-routed-model': 'gpt-5.5' },
    );

    expect(response.status).toBe(200);
    expect(capturedUrls).toEqual(['https://chatgpt.com/backend-api/codex']);
  });

  it('falls back to direct OpenAI API with observability log when Codex-tagged profile has codexEnabled=false', async () => {
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };

    // codexEnabled=false simulates Codex disconnected at turn start
    await proxyManager.addRoutes('turn-codex-off', routeTable, undefined, nextPort++, false, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-routed-turn-id': 'turn-codex-off', 'x-routed-model': 'gpt-5.5' },
    );

    expect(response.status).toBe(200);
    // Should fall back to direct OpenAI (chat/completions), NOT Codex endpoint
    expect(capturedUrls[0]).toContain('api.openai.com');
    expect(capturedUrls[0]).not.toContain('chatgpt.com/backend-api/codex');
  });

  // Plan 260429 BTS SSE fix — Codex passthrough (x-codex-turn: true) routing.
  // The passthrough path is used by BTS calls (callViaCodexProxy) and must
  // route stream:false requests through the non-streaming Codex path so the
  // client gets JSON, not SSE. See docs/plans/260429_bts_sse_parsing_fix.md.

  it('returns JSON (not SSE) for non-streaming Codex passthrough requests (x-codex-turn + stream:false)', async () => {
    // No routes needed for x-codex-turn passthrough — it bypasses the route table.
    // We still need addRoutes to start the proxy server.
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-codex-bts', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(200);
    // Response must be JSON, not text/event-stream — this is the bug fix.
    expect(response.contentType).toContain('application/json');
    expect(response.contentType).not.toContain('text/event-stream');
    // Body must be valid JSON in Anthropic Messages format.
    const parsed = JSON.parse(response.body) as {
      type?: string;
      content?: unknown;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    expect(parsed.type).toBe('message');
    expect(parsed.content).toBeDefined();
    expect(parsed.usage).toBeDefined();
    // Verify the proxy used the Codex Responses endpoint, not direct OpenAI.
    expect(capturedUrls).toEqual(['https://chatgpt.com/backend-api/codex']);
  });

  it('returns JSON for non-streaming Codex passthrough when response.completed is unwrapped', async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      capturedUrls.push(urlStr);
      const body = typeof init?.body === 'string' ? init.body : '';
      if (urlStr.includes('chatgpt.com/backend-api/codex')) {
        const parsedBody = JSON.parse(body) as Record<string, unknown>;
        capturedCodexBodies.push(parsedBody);
        if (parsedBody.stream !== true) {
          return new Response(
            JSON.stringify({ detail: 'Stream must be set to true' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        return makeUnwrappedCompletedCodexResponse();
      }
      return new Response(JSON.stringify(makeChatCompletionsResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-codex-unwrapped', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('application/json');
    expect(response.contentType).not.toContain('text/event-stream');
    const parsed = JSON.parse(response.body) as {
      type?: string;
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    expect(parsed.type).toBe('message');
    expect(parsed.content?.[0]?.text).toBe('Hello from unwrapped Codex SSE');
    expect(parsed.usage).toMatchObject({ input_tokens: 11, output_tokens: 6 });
    expect(capturedUrls).toEqual(['https://chatgpt.com/backend-api/codex']);
  });

  it('surfaces upstream response.completed errors in non-streaming Codex passthrough bodies', async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      capturedUrls.push(urlStr);
      const body = typeof init?.body === 'string' ? init.body : '';
      if (urlStr.includes('chatgpt.com/backend-api/codex')) {
        const parsedBody = JSON.parse(body) as Record<string, unknown>;
        capturedCodexBodies.push(parsedBody);
        return makeCompletedErrorCodexResponse('model X not supported');
      }
      return new Response(JSON.stringify(makeChatCompletionsResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-codex-error-body', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(502);
    expect(response.contentType).toContain('application/json');
    expect(response.body).toContain('model X not supported');
    expect(response.body).not.toContain('paths=error');
  });

  it('surfaces translator error chunks on streaming Codex passthrough instead of silently stopping', async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      capturedUrls.push(urlStr);
      const body = typeof init?.body === 'string' ? init.body : '';
      if (urlStr.includes('chatgpt.com/backend-api/codex')) {
        const parsedBody = JSON.parse(body) as Record<string, unknown>;
        capturedCodexBodies.push(parsedBody);
        return makeCompletedErrorCodexResponse('stream model X not supported');
      }
      return new Response(JSON.stringify(makeChatCompletionsResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-codex-stream-error', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/event-stream');
    expect(response.body).toContain('stream model X not supported');
    expect(response.body).toContain('event: error');
  });

  it('emits streaming error events when response.completed fails after a text delta', async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      capturedUrls.push(urlStr);
      const body = typeof init?.body === 'string' ? init.body : '';
      if (urlStr.includes('chatgpt.com/backend-api/codex')) {
        const parsedBody = JSON.parse(body) as Record<string, unknown>;
        capturedCodexBodies.push(parsedBody);
        return makeDeltaThenCompletedErrorCodexResponse('stream failed after delta');
      }
      return new Response(JSON.stringify(makeChatCompletionsResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-codex-stream-error-after-delta', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/event-stream');
    expect(response.body).toContain('stream failed after delta');
    expect(response.body).toContain('event: error');
    expect(response.body).not.toContain('event: message_stop');
  });

  // REBEL-520: defence-in-depth at the Codex passthrough entry. If a stale
  // routing path lets gpt-5.5-pro reach the proxy, remap it to a supported
  // model rather than letting Codex 400. Mirrors the Claude-leak guard.
  it('remaps Codex-unsupported model (gpt-5.5-pro) on x-codex-turn passthrough so request does not hit Codex with the bad ID', async () => {
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-codex-unsupported', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5-pro',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(capturedUrls).toEqual(['https://chatgpt.com/backend-api/codex']);
    // Verify the outbound payload was remapped — the Codex endpoint must NOT
    // have received gpt-5.5-pro as the model.
    const codexCall = fetchSpy.mock.calls.find((c: unknown[]) => {
      const first = c[0];
      const url = typeof first === 'string' ? first : String(first);
      return url.includes('chatgpt.com/backend-api/codex');
    });
    expect(codexCall).toBeDefined();
    const init = codexCall![1] as RequestInit;
    const sentBody = typeof init.body === 'string' ? init.body : '';
    expect(sentBody).not.toContain('"model":"gpt-5.5-pro"');
    expect(sentBody).toContain('"model":"gpt-5.5"');
  });

  // Plan 260504 codex passthrough streaming fix — TRIPWIRE.
  // The Codex Responses API requires stream:true upstream and rejects
  // stream:false with HTTP 400. forwardToCodexModel must force stream:true
  // upstream and buffer SSE → JSON via readResponsesSseToCompletion.
  // See docs/plans/260504_codex_passthrough_streaming_fix.md.

  it('TRIPWIRE: forwardToCodexModel sends stream:true upstream for non-streaming BTS passthrough (x-codex-turn + stream:false)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-tripwire-1', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(capturedCodexBodies).toHaveLength(1);
    expect(capturedCodexBodies[0]).toMatchObject({ stream: true });
    // Negative assertion makes regression intent explicit.
    expect(capturedCodexBodies[0].stream).not.toBe(false);
  });

  it('TRIPWIRE: forwardToCodexModel sends stream:true upstream for non-streaming routed-profile requests (no x-codex-turn header)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-tripwire-2', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-routed-turn-id': 'turn-tripwire-2', 'x-routed-model': 'gpt-5.5' },
    );

    expect(response.status).toBe(200);
    expect(capturedCodexBodies).toHaveLength(1);
    expect(capturedCodexBodies[0]).toMatchObject({ stream: true });
  });

  // Plan 260509 BTS output_format propagation — REGRESSION TESTS.
  // The Codex non-streaming proxy branch was silently dropping `output_format`
  // from inbound BTS requests because the typed `AnthropicRequest`/`OpenAIRequest`
  // interfaces in localModelProxyServer.ts didn't declare the field. The fix
  // forwards Anthropic-shaped `output_format` → OpenAI `response_format.json_schema`
  // → Codex Responses `text.format.json_schema` on every translation branch.
  // See docs-private/investigations/260509_bts_output_format_dropped_codex_proxy.md.

  it('forwards inbound output_format → upstream Codex text.format.json_schema for non-streaming BTS (x-codex-turn + stream:false)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-bts-output-format-ns', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const inboundSchema = {
      type: 'object',
      properties: {
        estimate_minutes_low: { type: 'number' },
        estimate_minutes_high: { type: 'number' },
      },
      required: ['estimate_minutes_low', 'estimate_minutes_high'],
      additionalProperties: false,
    };

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
        temperature: 0.2,
        output_format: {
          type: 'json_schema',
          schema: inboundSchema,
        },
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(capturedCodexBodies).toHaveLength(1);
    const codexBody = capturedCodexBodies[0] as {
      stream?: boolean;
      temperature?: number;
      text?: { format?: { type?: string; name?: string; schema?: unknown } };
    };
    expect(codexBody.stream).toBe(true);
    // Codex Responses API rejects temperature ("Unsupported parameter: temperature"); it is stripped at the translator.
    expect(codexBody.temperature).toBeUndefined();
    expect(codexBody.text?.format?.type).toBe('json_schema');
    expect(codexBody.text?.format?.name).toBe('structured_output');
    expect(codexBody.text?.format?.schema).toEqual(inboundSchema);
  });

  it('forwards inbound output_format → upstream Codex text.format.json_schema for streaming BTS (x-codex-turn + stream:true)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-bts-output-format-stream', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const inboundSchema = {
      type: 'object',
      properties: { x: { type: 'number' } },
      required: ['x'],
      additionalProperties: false,
    };

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
        temperature: 0.7,
        output_format: {
          type: 'json_schema',
          schema: inboundSchema,
        },
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/event-stream');
    expect(capturedCodexBodies).toHaveLength(1);
    const codexBody = capturedCodexBodies[0] as {
      stream?: boolean;
      temperature?: number;
      text?: { format?: { type?: string; schema?: unknown } };
    };
    expect(codexBody.stream).toBe(true);
    // Codex Responses API rejects temperature ("Unsupported parameter: temperature"); it is stripped at the translator.
    expect(codexBody.temperature).toBeUndefined();
    expect(codexBody.text?.format?.type).toBe('json_schema');
    expect(codexBody.text?.format?.schema).toEqual(inboundSchema);
  });

  it('defaults Codex text.format to text when no output_format is provided (regression-safe for non-structured BTS)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-no-output-format', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(capturedCodexBodies).toHaveLength(1);
    const codexBody = capturedCodexBodies[0] as {
      stream?: boolean;
      text?: { format?: { type?: string } };
    };
    expect(codexBody.stream).toBe(true);
    expect(codexBody.text?.format?.type).toBe('text');
  });

  it('preserves streaming response (text/event-stream) for streaming Codex passthrough requests (x-codex-turn + stream:true)', async () => {
    // Regression guard: main agent turns via the SDK always stream — they
    // must continue to receive SSE from the Codex passthrough. The Content-Type
    // header is the deterministic signal that the streaming branch was taken
    // (the existing mock streaming response uses a simplified Codex SSE shape
    // that the proxy translator skips, so the body is empty in tests; that is
    // sufficient — we only need to verify the streaming branch is selected).
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-codex-stream-bts', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(200);
    // Streaming requests get SSE headers — the streaming branch was taken.
    expect(response.contentType).toContain('text/event-stream');
    expect(response.contentType).not.toContain('application/json');
    expect(capturedUrls).toEqual(['https://chatgpt.com/backend-api/codex']);
  });
});

// =============================================================================
// Codex passthrough reasoning-effort inheritance
//
// REBEL-4GH / FOX-3152: BTS Codex passthrough calls (stream:false) must NOT
// inherit the working profile's reasoningEffort. The working profile defaults
// to `high`, which triggers a 150s firstByteMs upper bound on every BTS call
// (bug-report analysis, titles, summaries, time-saved, memory updates) — that
// bloats per-call latency and accelerates ChatGPT Team plan quota burn.
// Main agent turns (stream:true) still inherit `high` reasoning as before.
// =============================================================================

describe('Codex passthrough reasoning-effort inheritance', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let capturedCodexBodies: Record<string, unknown>[] = [];

  beforeEach(() => {
    capturedCodexBodies = [];

    // Install a working profile with reasoningEffort:'high' so the inheritance
    // path has something to copy. Mirrors a real Codex user's settings shape:
    // working profile is `codex-gpt-5.5`, BTS profile is `codex-gpt-5.4-mini`
    // and has no explicit reasoning effort.
    settingsMock.current = {
      providerKeys: { openai: 'fake-shared-openai' },
      customProviders: [],
      models: {
        workingProfileId: 'codex-gpt-5.5',
        model: 'gpt-5.5',
      },
      localModel: {
        profiles: [
          {
            id: 'codex-gpt-5.5',
            name: 'GPT-5.5 (ChatGPT Pro)',
            authSource: 'codex-subscription',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            model: 'gpt-5.5',
            createdAt: 0,
            reasoningEffort: 'high',
          },
          {
            id: 'codex-gpt-5.4-mini',
            name: 'GPT-5.4 mini (ChatGPT Pro)',
            authSource: 'codex-subscription',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            model: 'gpt-5.4-mini',
            createdAt: 0,
            // No reasoningEffort — defaults to provider default for BTS.
          },
        ],
        activeProfileId: 'codex-gpt-5.5',
      },
    };

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = typeof init?.body === 'string' ? init.body : '';
      const isCodexEndpoint = urlStr.includes('chatgpt.com/backend-api/codex');

      if (isCodexEndpoint) {
        let parsedBody: Record<string, unknown> = {};
        try { parsedBody = JSON.parse(body) as Record<string, unknown>; } catch { /* leave empty */ }
        capturedCodexBodies.push(parsedBody);
        // Codex Responses API only accepts stream:true upstream, even for
        // BTS calls that the client requested as stream:false (the proxy
        // buffers the SSE response into JSON via readResponsesSseToCompletion).
        return makeStreamingCodexResponse();
      }
      return new Response(JSON.stringify(makeChatCompletionsResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await proxyManager.stop();
    // Restore default settings mock so unrelated tests run later are unaffected.
    settingsMock.current = { providerKeys: { openai: 'fake-shared-openai' }, customProviders: [] };
    nextPort += 10;
  });

  it('omits reasoning_effort on BTS Codex passthrough (x-codex-turn + stream:false) even when working profile has reasoningEffort:high', async () => {
    // Start the proxy (any port) — the x-codex-turn branch reads settings
    // and getWorkingModelProfile() directly; no route table needed.
    const routeTable: ModelRouteTable = {
      routes: new Map([['gpt-5.4-mini', makeProfile({ id: 'codex-gpt-5.4-mini', model: 'gpt-5.4-mini' })]]),
    };
    await proxyManager.addRoutes('bts-codex', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.4-mini',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(capturedCodexBodies).toHaveLength(1);
    // The fix: BTS Codex passthrough (stream:false) must NOT carry
    // reasoning_effort from the working profile. Both the OpenAI-shape field
    // and the Codex Responses translation are asserted absent.
    expect(capturedCodexBodies[0]).not.toHaveProperty('reasoning_effort');
    expect(capturedCodexBodies[0]).not.toHaveProperty('reasoning');
  });

  it('forwards upstream Codex 429 usage_limit_reached type as `code` on proxy-rewritten error (BTS path)', async () => {
    // REBEL-4GH / FOX-3152: the proxy rewrites every upstream 429 to
    // `{type: 'rate_limit_error'}` for Anthropic SDK compatibility, but the
    // upstream quota signal must survive so downstream classifyHttpError can
    // reclassify to `billing`. The proxy now forwards `error.type` or
    // `error.code` from upstream as `code` on the rewritten body.
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;

    // Override the fetch mock for this test only — Codex upstream returns 429.
    fetchSpy.mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('chatgpt.com/backend-api/codex')) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'usage_limit_reached',
              message: 'The usage limit has been reached',
              plan_type: 'team',
              resets_at: resetsAt,
            },
          }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        );
      }
      // Fallback for unexpected URLs
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const routeTable: ModelRouteTable = {
      routes: new Map([['gpt-5.4-mini', makeProfile({ id: 'codex-gpt-5.4-mini', model: 'gpt-5.4-mini' })]]),
    };
    await proxyManager.addRoutes('bts-codex-429', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.4-mini',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(429);
    const parsed = JSON.parse(response.body) as { error: Record<string, unknown> };
    // Top-level type must stay SDK-compatible.
    expect(parsed.error.type).toBe('rate_limit_error');
    // Upstream quota signal preserved as `code` so classifyHttpError can detect it.
    expect(parsed.error.code).toBe('usage_limit_reached');
    // Reset timing preserved.
    expect(parsed.error.resets_at).toBe(resetsAt);
  });

  it('preserves reasoning_effort on main agent Codex passthrough (x-codex-turn + stream:true) when working profile has reasoningEffort:high', async () => {
    const routeTable: ModelRouteTable = {
      routes: new Map([['gpt-5.5', makeProfile()]]),
    };
    await proxyManager.addRoutes('main-codex', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(capturedCodexBodies).toHaveLength(1);
    // Main agent turns (streaming) still get high reasoning — this is the
    // intended user-facing behaviour.
    const reasoning = capturedCodexBodies[0].reasoning as { effort?: string } | undefined;
    expect(reasoning?.effort).toBe('high');
  });
});
