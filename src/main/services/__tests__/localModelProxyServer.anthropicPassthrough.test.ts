/**
 * Anthropic Passthrough Auth Injection Tests
 *
 * Regression tests for the Stage 2 fix in
 * `docs/plans/260430_eval_harness_recovery_and_anthropic_auth_fix.md`.
 *
 * Bug: `handleAnthropicPassthrough` previously forwarded client-supplied
 * `x-api-key` and `authorization` headers as-is to api.anthropic.com.
 * In route-table-proxy mode (eval harness, council/ad-hoc routing) the SDK
 * sends `x-api-key: 'proxy-handles-auth'` (sentinel) + a proxy-internal
 * Bearer token. Anthropic rejected those credentials with 401, breaking the
 * eval bundle for any Anthropic working/judge model.
 *
 * Fix: `injectAnthropicUpstreamAuth(headers)` strips inbound auth and
 * re-injects from `getAuthForDirectUse(getSettings())`. Fail-closed 401 if
 * no Anthropic key is configured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

// Test-only fixture strings. NOT real keys. Avoids the `sk-ant-` /
// `Bearer sk-` prefixes so secret-detection scanners (Droid-Shield, GitGuardian,
// etc.) don't false-positive on test fixtures.
const REAL_SETTINGS_KEY_FIXTURE = 'fake-test-real-settings-key';
const SDK_DRIFT_KEY_FIXTURE = 'fake-test-client-side-drift-key';
const PROXY_INTERNAL_BEARER = 'Bearer fake-test-proxy-internal-bearer';

// Mutable settings snapshot — individual tests override before adding routes.
const mockSettings: { models?: { apiKey?: string }; providerKeys?: Record<string, string> } = {
  models: { apiKey: REAL_SETTINGS_KEY_FIXTURE },
  providerKeys: {},
};

// Stub the env var so fail-closed cases aren't contaminated by developer environment state.
const ENV_BACKUP = process.env.ANTHROPIC_API_KEY;

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockSettings,
}));

vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => ({ apiKey: 'fake-or-test-key', refreshToken: null })),
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
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let nextPort = 49500;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let capturedRequests: Array<{ url: string; headers: Record<string, string> }> = [];

function fakeAnthropicResponse(): Partial<Response> {
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
  // Reset settings before each test
  mockSettings.models = { apiKey: REAL_SETTINGS_KEY_FIXTURE };
  mockSettings.providerKeys = {};
  // Scrub env so fail-closed tests aren't contaminated
  delete process.env.ANTHROPIC_API_KEY;

  fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    const reqHeaders: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        reqHeaders[k.toLowerCase()] = v;
      }
    }
    capturedRequests.push({ url: u, headers: reqHeaders });
    return fakeAnthropicResponse() as unknown as Response;
  });
});

afterEach(async () => {
  fetchSpy.mockRestore();
  await proxyManager.stop();
  if (ENV_BACKUP === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ENV_BACKUP;
});

describe('Anthropic passthrough auth injection', () => {
  it('strips sentinel x-api-key and injects real Anthropic key from settings', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(proxyUrl, makeAnthropicBody(), token, {
      'x-api-key': 'proxy-handles-auth',
      'authorization': 'Bearer proxy-internal-bearer-token',
    });

    expect(res.status).toBe(200);
    expect(capturedRequests).toHaveLength(1);
    const upstream = capturedRequests[0];
    expect(upstream.url).toContain('api.anthropic.com');
    // The sentinel must NOT survive
    expect(upstream.headers['x-api-key']).not.toBe('proxy-handles-auth');
    // The proxy-internal Bearer must NOT survive
    expect(upstream.headers['authorization']).toBeUndefined();
    // The real settings key must be injected
    expect(upstream.headers['x-api-key']).toBe(REAL_SETTINGS_KEY_FIXTURE);
  });

  it('overwrites client-supplied real-looking key with settings key (always-overwrite invariant)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(proxyUrl, makeAnthropicBody(), token, {
      'x-api-key': SDK_DRIFT_KEY_FIXTURE,
    });

    expect(res.status).toBe(200);
    expect(capturedRequests[0].headers['x-api-key']).toBe(REAL_SETTINGS_KEY_FIXTURE);
    expect(capturedRequests[0].headers['x-api-key']).not.toBe(SDK_DRIFT_KEY_FIXTURE);
  });

  it('fails closed with 401 when no Anthropic key is configured', async () => {
    mockSettings.models = {};
    delete process.env.ANTHROPIC_API_KEY;

    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(proxyUrl, makeAnthropicBody(), token, {
      'x-api-key': 'proxy-handles-auth',
    });

    expect(res.status).toBe(401);
    const errBody = JSON.parse(res.body);
    expect(errBody.error.type).toBe('authentication_error');
    expect(errBody.error.message).toMatch(/Anthropic API key not configured/i);
    // Critically, fetch must NOT have been called — fail-closed before egress
    expect(capturedRequests).toHaveLength(0);
  });

  it('preserves non-auth Anthropic SDK headers (anthropic-version, anthropic-beta)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(proxyUrl, makeAnthropicBody(), token, {
      'x-api-key': 'proxy-handles-auth',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'context-management-2025-06-27',
    });

    expect(res.status).toBe(200);
    expect(capturedRequests[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(capturedRequests[0].headers['anthropic-beta']).toBe('context-management-2025-06-27');
  });
});
