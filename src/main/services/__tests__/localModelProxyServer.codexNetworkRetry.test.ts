import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';

// Mirror the codexSubscription harness: codex connected via a stub auth provider,
// shared-key settings present, real proxyManager driven over loopback.
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
    isConnected: vi.fn(() => true),
    getAccessToken: vi.fn(async () => 'codex-token'),
    getAccountId: vi.fn(() => 'org_123'),
    forceRefreshToken: vi.fn(async () => 'codex-token-refreshed'),
    getStatus: vi.fn(() => ({ connected: true })),
  })),
}));

import {
  proxyManager,
  isRetriableUpstreamNetworkError,
  type ModelRouteTable,
} from '../localModelProxyServer';

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'codex-gpt-5.5',
    name: 'GPT-5.5 (ChatGPT Pro)',
    authSource: 'codex-subscription',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    createdAt: 0,
    reasoningEffort: 'low',
    ...overrides,
  };
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

function makeStreamingCodexResponse(): Response {
  const encoder = new TextEncoder();
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
      controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function requestBody(stream: boolean): string {
  return JSON.stringify({
    model: 'gpt-5.5',
    max_tokens: 64,
    stream,
    system: 'You are terse.',
    messages: [{ role: 'user', content: 'ping' }],
  });
}

function networkBlip(code = 'ECONNRESET'): Error {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = { code };
  return err;
}

describe('isRetriableUpstreamNetworkError', () => {
  it('matches undici "fetch failed" TypeError and known errno codes (direct or via cause)', () => {
    expect(isRetriableUpstreamNetworkError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetriableUpstreamNetworkError(networkBlip('ECONNRESET'))).toBe(true);
    const direct = new Error('boom');
    (direct as { code?: unknown }).code = 'ETIMEDOUT';
    expect(isRetriableUpstreamNetworkError(direct)).toBe(true);
  });

  it('does NOT match deliberate timeouts/aborts or non-network errors', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isRetriableUpstreamNetworkError(abort)).toBe(false);
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(isRetriableUpstreamNetworkError(timeout)).toBe(false);
    expect(isRetriableUpstreamNetworkError(new Error('something else'))).toBe(false);
    expect(isRetriableUpstreamNetworkError('not an error')).toBe(false);
  });
});

let nextPort = 49980;

describe('localModelProxyServer — Codex upstream network retry (REBEL-5EZ / REBEL-5K4)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let fetchCalls: number;

  beforeEach(() => {
    fetchCalls = 0;
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    await proxyManager.stop();
    nextPort += 10;
  });

  it('retries ONCE on a pre-response network blip and succeeds (non-streaming)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) throw networkBlip('ECONNRESET');
      return makeStreamingCodexResponse();
    });

    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-net-retry-ns', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(proxyUrl, requestBody(false), token, {
      'x-routed-turn-id': 'turn-net-retry-ns',
      'x-routed-model': 'gpt-5.5',
    });

    expect(res.status, `body: ${res.body}`).toBe(200);
    expect(fetchCalls).toBe(2); // first threw, retried once, second succeeded
  });

  it('retries ONCE on a pre-response network blip and succeeds (streaming)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) throw networkBlip('ETIMEDOUT');
      return makeStreamingCodexResponse();
    });

    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-net-retry-s', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(proxyUrl, requestBody(true), token, {
      'x-routed-turn-id': 'turn-net-retry-s',
      'x-routed-model': 'gpt-5.5',
    });

    expect(res.status, `body: ${res.body}`).toBe(200);
    expect(fetchCalls).toBe(2);
  });

  it('does NOT retry a real upstream 429 (no fallback amplification)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'cap', resets_in_seconds: 213 } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    });

    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-429', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // Use the x-codex-turn BTS path (REBEL-5EZ), which forwards the upstream
    // status cleanly, so we can assert the 429 directly.
    const res = await sendToProxy(proxyUrl, requestBody(false), token, {
      'x-codex-turn': 'true',
    });

    // A real upstream RESPONSE (429) must never be network-retried — only THROWN
    // pre-response blips are.
    expect(res.status, `body=${res.body}`).toBe(429); // forwarded, not collapsed to 500
    expect(fetchCalls).toBe(1); // never retried
  });

  it('does NOT retry a deliberate abort/timeout (single attempt, surfaces error)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCalls += 1;
      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      throw abort;
    });

    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('turn-abort', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(proxyUrl, requestBody(false), token, {
      'x-routed-turn-id': 'turn-abort',
      'x-routed-model': 'gpt-5.5',
    });

    expect(res.status).not.toBe(200);
    expect(fetchCalls).toBe(1); // abort is not retried
  });
});
