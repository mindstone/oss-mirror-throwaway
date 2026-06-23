/**
 * Codex Responses-API GOLDEN-FIXTURE contract test (deterministic, runs in CI).
 *
 * Replays a REAL upstream Codex Responses SSE stream — captured from the live
 * ChatGPT Pro endpoint by the `RECORD_CODEX_FIXTURE=1` mode of
 * `tests/live-api/codexSubscription.live.integration.test.ts` — through the
 * production proxy buffering/translation path, and asserts it round-trips to the
 * expected Anthropic shape. This guards our parser against the REAL response
 * shape on every push (deterministic), complementing the gated live test which
 * catches NEW upstream drift.
 *
 * Why this exists (260617 analysis): the Codex SSE seam regressed 5× in 22 days,
 * partly because hand-built fixtures encoded the wrong shape as a passing test.
 * A recorded-from-reality fixture removes that failure mode. To refresh it after
 * a known-good upstream change:
 *   RUN_LIVE_API_TESTS=1 RECORD_CODEX_FIXTURE=1 npx vitest run --project=desktop \
 *     tests/live-api/codexSubscription.live.integration.test.ts
 * then review the diff and commit the updated fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelProfile } from '@shared/types';

const settingsMock = vi.hoisted(() => ({
  current: { providerKeys: { openai: 'fake-shared-openai' }, customProviders: [] } as Record<string, unknown>,
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => settingsMock.current,
}));

vi.mock('@core/codexAuth', () => ({
  CODEX_ENDPOINT_URL: 'https://chatgpt.com/backend-api/codex',
  getCodexAuthProvider: () => ({
    isConnected: () => true,
    getAccessToken: vi.fn(async () => 'codex-token'),
    getAccountId: () => 'org_123',
    forceRefreshToken: vi.fn(async () => 'codex-token-refreshed'),
    getStatus: () => ({ connected: true }),
  }),
}));

import { proxyManager, type ModelRouteTable } from '../localModelProxyServer';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../tests/live-api/__fixtures__/codex-responses-completed.golden.sse.txt',
);

function makeProfile(): ModelProfile {
  return {
    id: 'codex-gpt-5.5',
    name: 'GPT-5.5 (ChatGPT Pro)',
    authSource: 'codex-subscription',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    createdAt: 0,
    reasoningEffort: 'low',
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

interface AnthropicShape {
  type?: unknown;
  role?: unknown;
  content?: { type?: unknown; text?: unknown }[];
  stop_reason?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

let nextPort = 49920;

describe('localModelProxyServer — Codex golden-fixture round-trip (real recorded SSE → Anthropic)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(async () => {
    fetchSpy?.mockRestore();
    await proxyManager.stop();
    nextPort += 10;
  });

  beforeEach(() => {
    // Fail loud + actionable if the recorded fixture is missing (it's committed;
    // a missing one means a bad checkout or a deleted fixture, not a flake).
    expect(fs.existsSync(FIXTURE), `Missing golden fixture at ${FIXTURE} — re-record via RECORD_CODEX_FIXTURE=1 (see file header)`).toBe(true);
  });

  it('parses the recorded real Codex SSE into a well-formed Anthropic message (deterministic)', async () => {
    const goldenSse = fs.readFileSync(FIXTURE, 'utf8');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('chatgpt.com/backend-api/codex')) {
        return new Response(goldenSse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeProfile()]]) };
    await proxyManager.addRoutes('codex-golden', routeTable, undefined, nextPort++, false, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(
      proxyUrl,
      JSON.stringify({ model: 'gpt-5.5', max_tokens: 256, messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }], stream: false }),
      token,
      { 'x-codex-turn': 'true' },
    );

    expect(res.status, `body=${res.body}`).toBe(200);
    const parsed = JSON.parse(res.body) as AnthropicShape;
    expect(parsed.type).toBe('message');
    expect(parsed.role).toBe('assistant');
    expect(Array.isArray(parsed.content)).toBe(true);
    const text = (parsed.content ?? [])
      .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('');
    expect(text.trim().length).toBeGreaterThan(0); // real reply text survived parse+translate
    expect(typeof parsed.stop_reason).toBe('string');
    expect(typeof parsed.usage?.input_tokens).toBe('number');
    expect(parsed.usage!.input_tokens as number).toBeGreaterThan(0);
    expect(typeof parsed.usage?.output_tokens).toBe('number');
  });
});
