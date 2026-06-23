/**
 * Cross-Handler Auth Injection Invariant
 *
 * Class-of-bug regression test for the Stage 2 fix in
 * `docs/plans/260430_eval_harness_recovery_and_anthropic_auth_fix.md`.
 *
 * **Invariant:** for every passthrough handler in
 * `localModelProxyServer.ts` that egresses to a real upstream provider,
 * client-supplied `x-api-key` and `authorization` headers MUST be stripped
 * before the upstream `fetch()` is invoked. The proxy is the canonical auth
 * boundary — no inbound credential should ever reach an upstream provider.
 *
 * Concretely: this test sends a request to each handler with poisoned
 * `x-api-key` and `authorization` headers, captures the upstream `fetch`
 * call, and asserts neither poison value appears on the outbound request.
 *
 * Scope: Anthropic + OpenRouter passthrough handlers (the two handlers
 * exercised by the SDK's local-proxy path). Codex and council-member
 * handlers route through the same `buildPassthroughHeaders` machinery but
 * have additional dependencies (Codex auth provider, profile-keyed routing)
 * that are covered by their own dedicated test files. Adding a 5th handler
 * requires extending this test.
 *
 * History: this test file was added 2026-05-01 alongside the symmetric
 * `injectAnthropicUpstreamAuth` helper. Before the fix,
 * `handleAnthropicPassthrough` was the asymmetric outlier that forwarded
 * the SDK's sentinel `x-api-key: 'proxy-handles-auth'` to api.anthropic.com,
 * causing 401s in the eval harness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

const POISON_API_KEY = 'fake-test-poison-inbound-key';
const POISON_BEARER = 'Bearer POISON-INBOUND-TOKEN';
const REAL_SETTINGS_KEY = 'fake-test-real-settings-key';

const mockSettings: { models?: { apiKey?: string }; providerKeys?: Record<string, string> } = {
  models: { apiKey: REAL_SETTINGS_KEY },
  providerKeys: {},
};

const ENV_ANTH_BACKUP = process.env.ANTHROPIC_API_KEY;
const ENV_OR_BACKUP = process.env.OPENROUTER_API_KEY;

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockSettings,
}));

vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => ({ apiKey: 'fake-test-or-resolved-key', refreshToken: null })),
}));

import { proxyManager, type ModelRouteTable } from '../localModelProxyServer';

function makeAnthropicBody(model = 'claude-sonnet-4-5'): string {
  return JSON.stringify({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
  });
}

/**
 * Send a request to the proxy. Uses `agent: false` + `Connection: close` to
 * avoid the keep-alive socket race that produced sporadic ECONNRESETs when
 * `proxyManager.stop()` runs between tests in a full proxy-folder run (the
 * pre-existing Stage-11/12 flake; same mitigation as
 * localModelProxyServer.invariants.test.ts / routing.test.ts / timeout.test.ts).
 * Stage 13 makes crossHandlerAuth the central-injector gate, so it must be
 * reliably green across folder runs.
 */
function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string,
  headers: Record<string, string> = {}
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

function sendToProxyWithoutAuth(
  proxyUrl: string,
  body: string,
  headers: Record<string, string> = {}
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

let nextPort = 49600;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let capturedRequests: Array<{ url: string; headers: Record<string, string> }> = [];

function fakeUpstreamResponse(): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => Promise.resolve(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'pong' }],
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
    body: null,
  };
}

beforeEach(() => {
  capturedRequests = [];
  mockSettings.models = { apiKey: REAL_SETTINGS_KEY };
  mockSettings.providerKeys = {};
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;

  fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    const reqHeaders: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        reqHeaders[k.toLowerCase()] = v;
      }
    }
    capturedRequests.push({ url: u, headers: reqHeaders });
    return fakeUpstreamResponse() as unknown as Response;
  });
});

afterEach(async () => {
  fetchSpy.mockRestore();
  await proxyManager.stop();
  if (ENV_ANTH_BACKUP === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ENV_ANTH_BACKUP;
  if (ENV_OR_BACKUP === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ENV_OR_BACKUP;
});

/**
 * Asserts the captured outbound request has neither poison value in its
 * auth headers.
 */
function expectNoPoisonAuth(captured: { headers: Record<string, string> }): void {
  expect(captured.headers['x-api-key']).not.toBe(POISON_API_KEY);
  expect(captured.headers['authorization']).not.toBe(POISON_BEARER);
  // Defensive: assert the proxy-internal sentinel never leaks either.
  expect(captured.headers['x-api-key']).not.toBe('proxy-handles-auth');
}

describe('Cross-handler auth injection invariant', () => {
  it('fails closed with 401 when a proxy request omits x-proxy-auth', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;

    const res = await sendToProxyWithoutAuth(proxyUrl, makeAnthropicBody());

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized: Missing authentication' });
    expect(capturedRequests).toHaveLength(0);
  });

  it('Anthropic passthrough strips poison x-api-key and authorization', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(proxyUrl, makeAnthropicBody(), token, {
      'x-routed-model': 'should-not-leak-upstream',
      'x-api-key': POISON_API_KEY,
      'authorization': POISON_BEARER,
    });

    expect(res.status).toBe(200);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toContain('api.anthropic.com');
    expectNoPoisonAuth(capturedRequests[0]);
    expect(capturedRequests[0].headers['x-routed-model']).toBeUndefined();
    // Outbound auth must be the real settings key.
    expect(capturedRequests[0].headers['x-api-key']).toBe(REAL_SETTINGS_KEY);
  });

  it('OpenRouter passthrough strips poison x-api-key and authorization', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(
      proxyUrl,
      makeAnthropicBody('anthropic/claude-opus-4.7'),
      token,
      {
        'x-openrouter-turn': 'true',
        'x-api-key': POISON_API_KEY,
        'authorization': POISON_BEARER,
      },
    );

    expect(res.status).toBe(200);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toContain('openrouter.ai');
    expectNoPoisonAuth(capturedRequests[0]);
    // Outbound auth must be the OR-resolved Bearer.
    expect(capturedRequests[0].headers['authorization']).toBe('Bearer fake-test-or-resolved-key');
  });
});
