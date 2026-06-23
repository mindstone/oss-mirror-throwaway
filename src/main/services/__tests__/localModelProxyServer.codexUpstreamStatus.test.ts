/**
 * Codex egress error/status CONTRACT test (REBEL-66Q/5K4/5NC/520 + FOX-3152 family).
 *
 * Pins what the proxy does with each NON-OK upstream status from the Codex
 * Responses endpoint, using the REAL upstream body shapes seen in production
 * (per the codex postmortem history) — NOT a desired/hand-wished response. This
 * is the seam multiple chronic Sentry classes flow through (C4 fetch-failed→500,
 * C5 429-usage-limit, C6 400 model-unsupported, C11 auth→500), and the coverage
 * audit (260617) found it PARTIAL: the proxy's OWN 401→forceRefreshToken→retry
 * path and non-429 status forwarding were untested (only the SDK-client analog
 * `openaiClient.codexCreate.test.ts` was, and they are separate code paths).
 *
 * Drives the proxy via the `x-codex-turn` BTS path (stream:false →
 * forwardToCodexModel), which forwards the upstream status cleanly — see the
 * sibling 429 test in localModelProxyServer.codexSubscription.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';

const settingsMock = vi.hoisted(() => ({
  current: { providerKeys: { openai: 'fake-shared-openai' }, customProviders: [] } as Record<string, unknown>,
}));

// Stable Codex auth provider so we can assert the refresh path was exercised.
const codexMock = vi.hoisted(() => ({
  getAccessToken: vi.fn(async (): Promise<string | null> => 'codex-token'),
  forceRefreshToken: vi.fn(async (): Promise<string | null> => 'codex-token-refreshed'),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => settingsMock.current,
}));

vi.mock('@core/codexAuth', () => ({
  CODEX_ENDPOINT_URL: 'https://chatgpt.com/backend-api/codex',
  getCodexAuthProvider: () => ({
    isConnected: () => true,
    getAccessToken: codexMock.getAccessToken,
    getAccountId: () => 'org_123',
    forceRefreshToken: codexMock.forceRefreshToken,
    getStatus: () => ({ connected: true }),
  }),
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
        hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'X-Proxy-Auth': authToken, Host: '127.0.0.1', Connection: 'close', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function makeStreamingCodexResponse(): Response {
  const enc = new TextEncoder();
  const completed = {
    id: 'resp_1', model: 'gpt-5.5', status: 'completed',
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  };
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function btsRequest(): string {
  return JSON.stringify({ model: 'gpt-5.5', max_tokens: 256, messages: [{ role: 'user', content: 'Hello' }], stream: false });
}

let nextPort = 49860;

describe('localModelProxyServer — Codex upstream error/status contract (BTS x-codex-turn path)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    codexMock.getAccessToken.mockClear().mockResolvedValue('codex-token');
    codexMock.forceRefreshToken.mockClear().mockResolvedValue('codex-token-refreshed');
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    await proxyManager.stop();
    nextPort += 10;
  });

  async function driveWithUpstream(
    turnId: string,
    upstream: (codexCallIndex: number) => Response,
  ): Promise<{ status: number; body: string; codexCalls: number; codexAuthHeaders: string[] }> {
    let codexCalls = 0;
    const codexAuthHeaders: string[] = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('chatgpt.com/backend-api/codex')) {
        codexCalls += 1;
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        codexAuthHeaders.push(hdrs.Authorization ?? hdrs.authorization ?? '');
        return upstream(codexCalls);
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes(turnId, routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;
    const res = await sendToProxy(proxyUrl, btsRequest(), token, { 'x-codex-turn': 'true' });
    return { ...res, codexCalls, codexAuthHeaders };
  }

  it('401 → force-refreshes the token and retries once → success (proxy 401-refresh path)', async () => {
    const res = await driveWithUpstream('codex-401-refresh', (i) =>
      i === 1
        ? new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Unauthorized' } }), { status: 401, headers: { 'content-type': 'application/json' } })
        : makeStreamingCodexResponse(),
    );
    expect(res.status, `body=${res.body}`).toBe(200);
    expect(res.codexCalls).toBe(2); // first 401, retried after refresh
    expect(codexMock.forceRefreshToken).toHaveBeenCalledTimes(1);
    // The retry must carry the REFRESHED token, not the stale one (else the
    // "refresh" would be a no-op that happens to pass on a flaky upstream).
    expect(res.codexAuthHeaders[0]).toContain('codex-token');
    expect(res.codexAuthHeaders[1]).toContain('codex-token-refreshed');
  });

  it('401 → refresh returns null → fails closed (no infinite retry; auth surfaces, REBEL-5NC/C11)', async () => {
    // Production: forwardToCodexModel throws "Codex OAuth: token refresh failed"
    // when forceRefreshToken yields null; the catch maps it to a 500 api_error.
    // Pin that terminal contract (and that we do NOT loop retrying).
    codexMock.forceRefreshToken.mockResolvedValueOnce(null);
    const res = await driveWithUpstream('codex-401-terminal', () =>
      new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Unauthorized' } }), { status: 401, headers: { 'content-type': 'application/json' } }),
    );
    expect(res.status).not.toBe(200);
    expect(res.codexCalls).toBe(1); // initial 401 only — refresh failed, no retry
    expect(codexMock.forceRefreshToken).toHaveBeenCalledTimes(1);
  });

  it('403 (permission) → forwarded as 403, not collapsed to 500', async () => {
    const res = await driveWithUpstream('codex-403', () =>
      new Response(JSON.stringify({ error: { type: 'permission_error', message: 'forbidden' } }), { status: 403, headers: { 'content-type': 'application/json' } }),
    );
    expect(res.status).toBe(403);
    expect(res.codexCalls).toBe(1); // not retried
    const parsed = JSON.parse(res.body) as { error?: { type?: string } };
    expect(parsed.error?.type).toBe('permission_error');
  });

  it('500 (upstream server error) → forwarded as 500', async () => {
    const res = await driveWithUpstream('codex-500', () =>
      new Response(JSON.stringify({ error: { type: 'server_error', message: 'upstream boom' } }), { status: 500, headers: { 'content-type': 'application/json' } }),
    );
    expect(res.status).toBe(500);
    expect(res.codexCalls).toBe(1);
    // Body must preserve the upstream cause, not collapse to a generic 500 —
    // a blind collapse-to-500 bug would still satisfy a status-only assert.
    expect(res.body).toContain('upstream boom');
  });

  it('400 model-not-supported (real C6 body) → forwarded as 400 with the upstream message', async () => {
    // REBEL-520 family: "The 'gpt-5.5-pro' model is not supported when using
    // Codex with a ChatGPT account." Must surface as a 400 the caller can act on.
    const res = await driveWithUpstream('codex-400', () =>
      new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: "The 'gpt-5.5-pro' model is not supported when using Codex with a ChatGPT account." } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    );
    expect(res.status).toBe(400);
    expect(res.codexCalls).toBe(1);
    expect(res.body).toContain('not supported');
  });
});
