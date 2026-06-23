import http from 'node:http';
import type { ModelProfile } from '@shared/types';

const logInfoMock = vi.hoisted(() => vi.fn());
const settingsMock = vi.hoisted(() => ({
  current: {
    claude: { apiKey: 'fake-ant-key' },
    providerKeys: {},
    customProviders: [],
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: logInfoMock,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => settingsMock.current,
}));

vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => ({ apiKey: 'fake-or-test-key', refreshToken: null })),
}));

import {
  _setUpstreamTimeoutsScaleForTesting,
  proxyManager,
  type ModelRouteTable,
} from '../localModelProxyServer';

function makeProfile(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    id: 'profile-timeout-test',
    name: 'Timeout test profile',
    providerType: 'other',
    routeSurface: undefined,
    serverUrl: 'https://api.example.com/v1',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'medium',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeAnthropicBody(stream: boolean): string {
  return JSON.stringify({
    model: 'working',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream,
  });
}

function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string,
  routedModel: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${proxyUrl}/v1/messages`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Auth': authToken,
          'x-routed-turn-id': 'turn-timeout-test',
          'x-routed-model': routedModel,
          Host: '127.0.0.1',
          Connection: 'close',
          ...extraHeaders,
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

function fakeOpenAIResponse(model = 'deepseek-v4-flash'): Partial<Response> {
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

function fakeOpenAIStreamingResponse(model = 'deepseek-v4-flash'): Partial<Response> {
  const encoder = new TextEncoder();
  const sseBody = [
    `data: ${JSON.stringify({
      id: 'chatcmpl_test',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model,
      choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: null }],
      usage: null,
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'chatcmpl_test',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
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

let nextPort = 49800;

afterEach(async () => {
  vi.restoreAllMocks();
  _setUpstreamTimeoutsScaleForTesting(1);
  await proxyManager.stop();
});

describe('localModelProxyServer timeout derivation for BYO loopback profiles', () => {
  it.each([
    {
      label: 'BYO local route surface',
      profile: makeProfile({
        id: 'profile-loopback-route',
        routeSurface: 'local',
        providerType: 'other',
        serverUrl: 'https://api.example.com/v1',
      }),
      expectedFirstByteMs: 180_000,
    },
    {
      label: 'cloud-routable default profile',
      profile: makeProfile({
        id: 'profile-cloud-default',
        routeSurface: 'api-key',
        providerType: 'other',
        serverUrl: 'https://api.example.com/v1',
      }),
      expectedFirstByteMs: 90_000,
    },
  ])('uses $expectedFirstByteMs ms first-byte timeout for non-streaming path ($label)', async ({ profile, expectedFirstByteMs }) => {
    const abortTimeoutSpy = vi.spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms: number) => {
        const controller = new AbortController();
        (controller.signal as AbortSignal & { __timeoutMs?: number }).__timeoutMs = ms;
        return controller.signal;
      });
    vi.spyOn(global, 'fetch').mockResolvedValue(fakeOpenAIResponse(profile.model) as Response);

    const routeTable: ModelRouteTable = { routes: new Map([[profile.model ?? 'deepseek-v4-flash', profile]]) };
    await proxyManager.addRoutes('turn-timeout-test', routeTable, undefined, nextPort++);
    const response = await sendToProxy(
      proxyManager.getUrl()!,
      makeAnthropicBody(false),
      proxyManager.getAuthToken()!,
      profile.model ?? 'deepseek-v4-flash',
    );

    expect(response.status).toBe(200);
    expect(abortTimeoutSpy).toHaveBeenCalledWith(expectedFirstByteMs);
  });

  it.each([
    {
      label: 'BYO loopback URL profile',
      profile: makeProfile({
        id: 'profile-loopback-url',
        routeSurface: undefined,
        providerType: 'other',
        serverUrl: 'http://127.0.0.1:8000/v1',
      }),
      expectedFirstByteMs: 180_000,
    },
    {
      label: 'cloud-routable default profile',
      profile: makeProfile({
        id: 'profile-stream-cloud-default',
        routeSurface: 'api-key',
        providerType: 'other',
        serverUrl: 'https://api.example.com/v1',
      }),
      expectedFirstByteMs: 90_000,
    },
  ])('logs $expectedFirstByteMs ms first-byte timeout for streaming path ($label)', async ({ profile, expectedFirstByteMs }) => {
    logInfoMock.mockReset();
    vi.spyOn(global, 'fetch').mockResolvedValue(fakeOpenAIStreamingResponse(profile.model) as Response);

    const routeTable: ModelRouteTable = { routes: new Map([[profile.model ?? 'deepseek-v4-flash', profile]]) };
    await proxyManager.addRoutes('turn-timeout-test', routeTable, undefined, nextPort++);
    const response = await sendToProxy(
      proxyManager.getUrl()!,
      makeAnthropicBody(true),
      proxyManager.getAuthToken()!,
      profile.model ?? 'deepseek-v4-flash',
    );

    expect(response.status).toBe(200);
    expect(logInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveFirstByteMs: expectedFirstByteMs }),
      'Starting streaming request to local model',
    );
  });
});

describe('localModelProxyServer OpenRouter passthrough liveness', () => {
  it('aborts OpenRouter passthrough when upstream never returns headers', async () => {
    _setUpstreamTimeoutsScaleForTesting(0.001);
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation((_, init) => new Promise<Response>((_resolve, reject) => {
      const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
      signal?.addEventListener('abort', () => {
        const err = new Error('aborted by timeout');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    }));

    await proxyManager.addRoutes('turn-openrouter-timeout', { routes: new Map() }, undefined, nextPort++);
    const response = await sendToProxy(
      proxyManager.getUrl()!,
      makeAnthropicBody(false),
      proxyManager.getAuthToken()!,
      'openai/gpt-5.5',
      { 'x-openrouter-turn': 'true' },
    );

    expect(response.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('openrouter.ai'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('ends OpenRouter streams with an SSE error when headers arrive but chunks stall', async () => {
    _setUpstreamTimeoutsScaleForTesting(0.001);
    const stalledBody = new ReadableStream<Uint8Array>({
      start() {
        // Headers are available, but no SSE chunks ever arrive.
      },
    });
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: stalledBody,
    } as Response);

    await proxyManager.addRoutes('turn-openrouter-stream-timeout', { routes: new Map() }, undefined, nextPort++);
    const response = await sendToProxy(
      proxyManager.getUrl()!,
      makeAnthropicBody(true),
      proxyManager.getAuthToken()!,
      'openai/gpt-5.5',
      { 'x-openrouter-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain('event: error');
    expect(response.body).toContain('OpenRouter stream timed out before Rebel received more data.');
  });

  it('times out OpenRouter non-streaming response bodies that stall after headers', async () => {
    _setUpstreamTimeoutsScaleForTesting(0.001);
    const stalledBody = new ReadableStream<Uint8Array>({
      start() {
        // Non-streaming JSON response headers arrived; body never completes.
      },
    });
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(stalledBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await proxyManager.addRoutes('turn-openrouter-body-timeout', { routes: new Map() }, undefined, nextPort++);
    const response = await sendToProxy(
      proxyManager.getUrl()!,
      makeAnthropicBody(false),
      proxyManager.getAuthToken()!,
      'openai/gpt-5.5',
      { 'x-openrouter-turn': 'true' },
    );

    expect(response.status).toBe(500);
    expect(response.body).toContain('OpenRouter passthrough failed');
  });

  it('ends OpenRouter streams with an SSE error when chunks stall after initial progress', async () => {
    _setUpstreamTimeoutsScaleForTesting(0.001);
    const encoder = new TextEncoder();
    const stalledAfterProgress = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n'));
      },
    });
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: stalledAfterProgress,
    } as Response);

    await proxyManager.addRoutes('turn-openrouter-midstream-timeout', { routes: new Map() }, undefined, nextPort++);
    const response = await sendToProxy(
      proxyManager.getUrl()!,
      makeAnthropicBody(true),
      proxyManager.getAuthToken()!,
      'openai/gpt-5.5',
      { 'x-openrouter-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain('hello');
    expect(response.body).toContain('event: error');
    expect(response.body).toContain('OpenRouter stream timed out before Rebel received more data.');
  });

  it('aborts the OpenRouter upstream fetch when the downstream client disconnects', async () => {
    let resolveFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => { resolveFetchStarted = resolve; });
    const upstreamAborted = new Promise<boolean>((resolve) => {
      vi.spyOn(global, 'fetch').mockImplementation((_, init) => new Promise<Response>((_responseResolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        resolveFetchStarted?.();
        signal?.addEventListener('abort', () => {
          const err = new Error('client disconnected');
          err.name = 'AbortError';
          resolve(true);
          reject(err);
        }, { once: true });
      }));
    });

    await proxyManager.addRoutes('turn-openrouter-client-abort', { routes: new Map() }, undefined, nextPort++);
    const url = new URL(`${proxyManager.getUrl()!}/v1/messages`);
    const clientReq = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Auth': proxyManager.getAuthToken()!,
          'x-routed-turn-id': 'turn-openrouter-client-abort',
          'x-routed-model': 'openai/gpt-5.5',
          'x-openrouter-turn': 'true',
          Host: '127.0.0.1',
          Connection: 'close',
        },
      },
    );
    clientReq.on('error', () => {});
    clientReq.write(makeAnthropicBody(false));
    clientReq.end();

    await fetchStarted;
    clientReq.destroy();

    await expect(upstreamAborted).resolves.toBe(true);
  });
});
