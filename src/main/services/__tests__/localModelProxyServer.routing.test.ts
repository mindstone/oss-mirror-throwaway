import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';

const logWarnMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());
const settingsMock = vi.hoisted(() => ({
  current: {
    claude: { apiKey: 'fake-ant-key' },
    providerKeys: {},
    customProviders: [],
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: logWarnMock,
    error: logErrorMock,
  }),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => settingsMock.current,
}));

vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => ({ apiKey: 'fake-or-test-key', refreshToken: null })),
}));

import { proxyManager, type ModelRouteTable } from '../localModelProxyServer';

function makeProfile(
  overrides: Partial<ModelProfile> & { id: string; name: string; model: string },
): ModelProfile {
  return {
    providerType: 'openai',
    serverUrl: 'http://localhost:11434',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeAnthropicBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'working',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
    ...overrides,
  });
}

function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${proxyUrl}/v1/messages`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        // afterEach calls proxyManager.stop(); but Node's default global HTTP agent
        // keeps the response socket in its keep-alive pool, which races with the
        // next test's fresh server startup and produces sporadic ECONNRESETs.
        // Force a fresh socket per request and tell the server to close it
        // immediately after the response.
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Auth': authToken,
          Host: '127.0.0.1',
          Connection: 'close',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fakeOpenAIResponse(model = 'gpt-5.5'): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve({
      id: 'chatcmpl_test',
      object: 'chat.completion',
      created: Date.now(),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  };
}

function fakeOpenAIStreamingResponse(chunks: unknown[]): Partial<Response> {
  const encoder = new TextEncoder();
  const sseBody = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    'data: [DONE]\n\n',
  ].join('');

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseBody));
      controller.close();
    },
  });

  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: stream,
  };
}

function parseSSEEvents(body: string): Array<{ event: string; data: Record<string, unknown> | null }> {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const eventLine = block.split('\n').find((line) => line.startsWith('event:'));
      const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
      const event = eventLine?.replace('event: ', '') ?? '';
      if (!dataLine) return { event, data: null };
      return {
        event,
        data: JSON.parse(dataLine.replace('data: ', '')) as Record<string, unknown>,
      };
    });
}

let nextPort = 49700;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let capturedUrls: string[] = [];
let capturedUpstreamBodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  logWarnMock.mockReset();
  logErrorMock.mockReset();
  settingsMock.current = {
    claude: { apiKey: 'fake-ant-key' },
    providerKeys: {},
    customProviders: [],
  };
  capturedUrls = [];
  capturedUpstreamBodies = [];
  fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    capturedUrls.push(typeof url === 'string' ? url : url.toString());
    const rawBody = (init as RequestInit | undefined)?.body;
    if (typeof rawBody === 'string') {
      try {
        capturedUpstreamBodies.push(JSON.parse(rawBody) as Record<string, unknown>);
      } catch {
        // non-JSON upstream body (e.g. multipart) — ignore for this assertion
      }
    }
    return fakeOpenAIResponse() as unknown as Response;
  });
});

afterEach(async () => {
  fetchSpy.mockRestore();
  await proxyManager.stop();
});

describe('localModelProxyServer route-table routed model header handling', () => {
  it('returns 400 route_required when turn route table request is missing x-routed-model', async () => {
    const routedProfile = makeProfile({ id: 'profile-gpt55', name: 'GPT 5.5', model: 'gpt-5.5' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', routedProfile]]) };
    await proxyManager.addRoutes('turn-route-required', routeTable, undefined, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: 'working' }),
      authToken,
      { 'x-routed-turn-id': 'turn-route-required' },
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'route_required',
      message: 'Missing x-routed-model header for route-table turn request',
    });
    expect(capturedUrls).toHaveLength(0);
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'turn-route-required',
        requestPath: '/v1/messages',
        reason: 'missing-routed-model-header',
        registeredRoutes: ['gpt-5.5'],
      }),
      expect.stringContaining('Route-table turn request rejected'),
    );
  });

  it('returns 400 route_required when turn route table request has an empty x-routed-model', async () => {
    const routedProfile = makeProfile({ id: 'profile-gpt55', name: 'GPT 5.5', model: 'gpt-5.5' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', routedProfile]]) };
    await proxyManager.addRoutes('turn-route-empty', routeTable, undefined, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: 'working' }),
      authToken,
      {
        'x-routed-turn-id': 'turn-route-empty',
        'x-routed-model': '   ',
      },
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'route_required',
      message: 'Empty x-routed-model header for route-table turn request',
    });
    expect(capturedUrls).toHaveLength(0);
  });

  it('returns 400 route_required when turn route table request has unknown x-routed-model', async () => {
    const routedProfile = makeProfile({ id: 'profile-gpt55', name: 'GPT 5.5', model: 'gpt-5.5' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', routedProfile]]) };
    await proxyManager.addRoutes('turn-route-unknown', routeTable, undefined, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: 'working' }),
      authToken,
      {
        'x-routed-turn-id': 'turn-route-unknown',
        'x-routed-model': 'unknown-model',
      },
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'route_required',
      message: 'Unknown x-routed-model "unknown-model" for route-table turn request',
    });
    expect(capturedUrls).toHaveLength(0);
  });

  it('routes correctly when turn route table request has valid x-routed-model', async () => {
    const routedProfile = makeProfile({
      id: 'profile-gpt55',
      name: 'GPT 5.5',
      model: 'gpt-5.5',
      serverUrl: 'http://localhost:11435',
    });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', routedProfile]]) };
    await proxyManager.addRoutes('turn-route-valid', routeTable, undefined, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: 'working' }),
      authToken,
      {
        'x-routed-turn-id': 'turn-route-valid',
        'x-routed-model': 'gpt-5.5',
      },
    );

    expect(response.status).toBe(200);
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain('localhost:11435');
    expect(capturedUrls[0]).toContain('/chat/completions');
  });

  // REBEL-5N8 (Stage 5, Codex F2): pin that the upstream request body `model`
  // equals the routed profile's model — the route-table-safe alias the sub-agent
  // streams (body `model: 'working'`) is rewritten to the concrete routed model
  // from `x-routed-model`/the route-table profile, and the alias NEVER leaks
  // upstream. Uses the foreign slash id (openai/gpt-5.5) — the REBEL-5N8 shape.
  it('rewrites the upstream body model to the routed profile.model (alias never leaks upstream)', async () => {
    const routedProfile = makeProfile({
      id: 'profile-or-gpt55',
      name: 'OpenRouter GPT 5.5',
      model: 'openai/gpt-5.5',
      providerType: 'openai',
      serverUrl: 'http://localhost:11437',
    });
    const routeTable: ModelRouteTable = { routes: new Map([['openai/gpt-5.5', routedProfile]]) };
    await proxyManager.addRoutes('turn-route-body-rewrite', routeTable, undefined, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      // The sub-agent streams the route-table-safe alias as the body model.
      makeAnthropicBody({ model: 'working' }),
      authToken,
      {
        'x-routed-turn-id': 'turn-route-body-rewrite',
        'x-routed-model': 'openai/gpt-5.5',
      },
    );

    expect(response.status).toBe(200);
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain('localhost:11437');
    // The upstream body carries the routed concrete model, NOT the 'working' alias.
    expect(capturedUpstreamBodies).toHaveLength(1);
    expect(capturedUpstreamBodies[0].model).toBe('openai/gpt-5.5');
    expect(capturedUpstreamBodies[0].model).not.toBe('working');
  });

  it('fails closed with reconnect guidance for disconnected connection-managed routed profiles', async () => {
    const routedProfile = makeProfile({
      id: 'profile-openrouter',
      name: 'OpenRouter GPT 5.5',
      model: 'openai/gpt-5.5',
      providerType: 'openrouter',
      routeSurface: 'pool',
      profileSource: 'connection',
      serverUrl: 'https://openrouter.ai/api/v1',
    });
    const routeTable: ModelRouteTable = { routes: new Map([['openai/gpt-5.5', routedProfile]]) };
    await proxyManager.addRoutes('turn-route-disconnected', routeTable, undefined, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: 'working' }),
      authToken,
      {
        'x-routed-turn-id': 'turn-route-disconnected',
        'x-routed-model': 'openai/gpt-5.5',
      },
    );

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Reconnect OpenRouter to use this model',
      },
    });
    expect(capturedUrls).toHaveLength(0);
  });

  it('uses existing base-profile path when no route table is registered and x-routed-model is missing', async () => {
    const baseProfile = makeProfile({
      id: 'base-profile',
      name: 'Base profile',
      model: 'gpt-5.5',
      serverUrl: 'http://localhost:11436',
    });
    await proxyManager.startSingleProfile(baseProfile, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: 'gpt-5.5' }),
      authToken,
    );

    expect(response.status).toBe(200);
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain('localhost:11436');
  });

  it('warns on unknown x-routed-* headers while preserving request success', async () => {
    const baseProfile = makeProfile({
      id: 'base-profile-unknown-header',
      name: 'Base profile',
      model: 'gpt-5.5',
      serverUrl: 'http://localhost:11436',
    });
    await proxyManager.startSingleProfile(baseProfile, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: 'gpt-5.5' }),
      authToken,
      { 'x-routed-unknown': 'mystery' },
    );

    expect(response.status).toBe(200);
    expect(
      logWarnMock.mock.calls.some(([payload, message]) =>
        typeof message === 'string'
        && message.includes('Unknown x-routed-* headers received on proxy request')
        && Array.isArray((payload as { unknownHeaders?: unknown[] }).unknownHeaders)
        && ((payload as { unknownHeaders?: unknown[] }).unknownHeaders ?? []).includes('x-routed-unknown')
      ),
    ).toBe(true);
  });

  it('keeps SSE text block identity stable across route-table stream chunks (Bug 4 verification)', async () => {
    const routedProfile = makeProfile({
      id: 'profile-gpt55-sse-stable',
      name: 'GPT 5.5',
      model: 'gpt-5.5',
      serverUrl: 'http://localhost:11435',
    });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', routedProfile]]) };
    await proxyManager.addRoutes('turn-sse-stable', routeTable, undefined, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    fetchSpy.mockImplementationOnce(async (url: unknown) => {
      capturedUrls.push(typeof url === 'string' ? url : String(url));
      return fakeOpenAIStreamingResponse([
        {
          id: 'chatcmpl-parent',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'gpt-5.5',
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-subagent',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'gpt-5.5',
          choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-subagent',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'gpt-5.5',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ]) as unknown as Response;
    });

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: 'working', stream: true }),
      authToken,
      {
        'x-routed-turn-id': 'turn-sse-stable',
        'x-routed-model': 'gpt-5.5',
      },
    );

    expect(response.status).toBe(200);
    const events = parseSSEEvents(response.body);
    const messageStart = events.find((event) => event.event === 'message_start');
    const textStarts = events.filter((event) =>
      event.event === 'content_block_start'
      && event.data?.content_block
      && typeof event.data.content_block === 'object'
      && (event.data.content_block as { type?: unknown }).type === 'text'
    );
    const textDeltas = events.filter((event) =>
      event.event === 'content_block_delta'
      && event.data?.delta
      && typeof event.data.delta === 'object'
      && (event.data.delta as { type?: unknown }).type === 'text_delta'
    );

    expect(messageStart?.data?.message && typeof messageStart.data.message === 'object'
      ? (messageStart.data.message as { id?: unknown }).id
      : null).toBe('chatcmpl-parent');
    expect(textStarts).toHaveLength(1);
    expect(textStarts[0].data?.index).toBe(0);
    expect(textDeltas.map((event) => event.data?.index)).toEqual([0, 0]);
    expect(
      textDeltas
        .map((event) =>
          event.data?.delta && typeof event.data.delta === 'object'
            ? ((event.data.delta as { text?: unknown }).text ?? '')
            : '',
        )
        .join(''),
    ).toBe('Hello world');
  });

});
