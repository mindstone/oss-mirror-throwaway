/**
 * localModelProxyServer — Behavioural Invariant Contract Suite (Stage 11)
 *
 * Part of the CHIEF_ENGINEER2 hotspot-refactor roadmap
 * (`docs/plans/260526_hotspot-refactor-roadmap/PLAN.md`). This file is the
 * behaviour-preservation net for Stages 12-14 (typed RequestClassification,
 * upstream-auth / output-format helpers, stream-lifecycle helpers). It pins
 * the CURRENT behaviour of the proxy — if a refactor changes any assertion
 * here, that is a behavioural regression to be justified, not silently
 * accepted.
 *
 * Scope note: the existing six+ proxy test files already cover most single-axis
 * invariants (auth symmetry, output_format per-branch, Codex SSE stream:true,
 * route-table header gate, timeout derivation). This suite deliberately does
 * NOT duplicate them; it fills the **request-classification matrix** gap
 * (consumer × provider × transport × auth × stream × structured-output) where
 * the recurring "omitted-axis" bugs cluster (PMs 260429 / 260504 / 260507),
 * plus a handful of cross-handler / cross-surface constraints with no prior
 * runnable home (`x-rebel-or-provider`, OpenRouter `usage.cost`, OpenAI
 * no-[DONE] terminal events, no-electron-import).
 *
 * Each `it()` references its invariant number (INV-#) from the compiled set in
 * the Stage 11 implementer report, and the originating PM where applicable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelProfile } from '@shared/types';

// --- Mocks: same module-boundary shape the sibling proxy test files use. ----

const settingsMock = vi.hoisted(() => ({
  current: {
    models: { apiKey: 'fake-test-anthropic-key' },
    providerKeys: { openai: 'fake-shared-openai' },
    customProviders: [],
  } as Record<string, unknown>,
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => settingsMock.current,
}));

vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => ({ apiKey: 'fake-or-resolved-key', refreshToken: null })),
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

// --- Shared fixtures --------------------------------------------------------

const POISON_API_KEY = 'fake-test-poison-inbound-key';
const POISON_BEARER = 'Bearer POISON-INBOUND-TOKEN';
const SENTINEL = 'proxy-handles-auth';

function makeOpenAIProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
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

function makeCodexProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return makeOpenAIProfile({
    id: 'codex-gpt-5.5',
    name: 'GPT-5.5 (ChatGPT Pro)',
    authSource: 'codex-subscription',
    reasoningEffort: 'high',
    ...overrides,
  });
}

function makeLocalProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return makeOpenAIProfile({
    id: 'local-llama',
    name: 'Local Llama',
    serverUrl: 'http://localhost:11434',
    model: 'llama-3',
    ...overrides,
  });
}

function makeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'gpt-5.5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
    ...overrides,
  });
}

interface ProxyResult {
  status: number;
  body: string;
  contentType: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * Send a request to the proxy. Uses `agent: false` + `Connection: close` to
 * avoid the keep-alive socket race that produces sporadic ECONNRESETs when
 * `proxyManager.stop()` runs between tests (same mitigation as routing.test.ts
 * and timeout.test.ts).
 */
function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string | undefined,
  headers: Record<string, string> = {},
): Promise<ProxyResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${proxyUrl}/v1/messages`);
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Host: '127.0.0.1',
      Connection: 'close',
      ...headers,
    };
    if (authToken) baseHeaders['X-Proxy-Auth'] = authToken;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: baseHeaders,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            contentType: (res.headers['content-type'] as string | undefined) ?? '',
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  rawBody: string;
}

let nextPort = 49850;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let captured: Captured[] = [];

function chatCompletionsJson(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl_inv',
      model: 'gpt-5.5',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function anthropicJson(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_inv',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'pong' }],
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * OpenRouter (Anthropic-Messages-shaped) response that carries an upstream
 * `provider` field (→ x-rebel-or-provider) and a `usage.cost` (exact-cost
 * telemetry). The OR passthrough forwards the body verbatim aside from
 * reasoning→thinking translation, so both must survive to the client.
 */
function openRouterJson(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_or',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'pong' }],
      model: 'anthropic/claude-opus-4.7',
      provider: 'Anthropic',
      usage: { input_tokens: 10, output_tokens: 5, cost: 0.0123 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function codexCompletedSse(): Response {
  const encoder = new TextEncoder();
  const completed = {
    id: 'resp_inv',
    model: 'gpt-5.5',
    output: [
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'codex', annotations: [] }] },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    status: 'completed',
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","id":"resp_inv","model":"gpt-5.5"}\n\n'));
      controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * OpenAI chat-completions streaming response that ends WITHOUT a `[DONE]`
 * sentinel (the MiniMax case from PMs 260424 / 260427). The proxy must still
 * synthesize Anthropic terminal events (message_stop) so the SDK doesn't hang.
 */
function chatCompletionsStreamNoDone(): Response {
  const encoder = new TextEncoder();
  const sse = [
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'gpt-5.5', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'gpt-5.5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`,
    // NB: deliberately NO `data: [DONE]` and NO stream close-via-DONE.
  ].join('');
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function parseSSEEvents(body: string): Array<{ event: string }> {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => ({ event: (block.split('\n').find((l) => l.startsWith('event:')) ?? '').replace('event: ', '') }));
}

beforeEach(() => {
  captured = [];
  settingsMock.current = {
    models: { apiKey: 'fake-test-anthropic-key' },
    providerKeys: { openai: 'fake-shared-openai' },
    customProviders: [],
  };
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    let parsedBody: Record<string, unknown> = {};
    try { parsedBody = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* leave empty */ }
    const reqHeaders: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        reqHeaders[k.toLowerCase()] = String(v);
      }
    }
    captured.push({ url: urlStr, headers: reqHeaders, body: parsedBody, rawBody });

    if (urlStr.includes('chatgpt.com/backend-api/codex')) {
      // Codex Responses API rejects stream:false (real-world 400). Mock it.
      if (parsedBody.stream !== true) {
        return new Response(JSON.stringify({ detail: 'Stream must be set to true' }), {
          status: 400, headers: { 'content-type': 'application/json' },
        });
      }
      return codexCompletedSse();
    }
    if (urlStr.includes('openrouter.ai')) {
      return openRouterJson();
    }
    if (urlStr.includes('api.anthropic.com')) {
      return anthropicJson();
    }
    if (urlStr.includes('/responses')) {
      return chatCompletionsJson(); // unused by these tests; defensive
    }
    // OpenAI-compatible chat completions (direct / local / route-table)
    if (parsedBody.stream === true) {
      return chatCompletionsStreamNoDone();
    }
    return chatCompletionsJson();
  });
});

afterEach(async () => {
  fetchSpy.mockRestore();
  await proxyManager.stop();
  nextPort += 10;
});

// ===========================================================================
// Request-classification matrix: transport dispatch by consumer × header.
//
// This is the axis-omission class (PMs 260429 Anthropic-native-under-Codex,
// 260504 Codex passthrough Claude leak, 260507 lead-agent transport×routeScope).
// Each row asserts which UPSTREAM the proxy selects for a given inbound shape.
// ===========================================================================
describe('localModelProxyServer invariants — request-classification matrix', () => {
  it('INV-5/PM260429: route-table OpenAI profile (no codex) dispatches to its OpenAI-compatible serverUrl, not Codex', async () => {
    const profile = makeOpenAIProfile();
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', profile]]) };
    await proxyManager.addRoutes('turn-openai', routeTable, undefined, nextPort++, false, false);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'gpt-5.5' }), token, {
      'x-routed-turn-id': 'turn-openai',
      'x-routed-model': 'gpt-5.5',
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('api.openai.com');
    expect(captured[0].url).not.toContain('chatgpt.com/backend-api/codex');
  });

  it('INV-1/PM260504: route-table Codex-subscription profile (codexEnabled) dispatches to the Codex Responses endpoint', async () => {
    const profile = makeCodexProfile();
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', profile]]) };
    await proxyManager.addRoutes('turn-codex', routeTable, undefined, nextPort++, false, true);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'gpt-5.5' }), token, {
      'x-routed-turn-id': 'turn-codex',
      'x-routed-model': 'gpt-5.5',
    });

    expect(res.status).toBe(200);
    expect(captured.map((c) => c.url)).toEqual(['https://chatgpt.com/backend-api/codex']);
  });

  it('INV-7: x-openrouter-turn dispatches to OpenRouter regardless of route table', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'anthropic/claude-opus-4.7' }), token, {
      'x-openrouter-turn': 'true',
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('openrouter.ai');
  });

  it('INV-3/PM260430: bare Anthropic passthrough (no transport header, route-table mode) dispatches to api.anthropic.com', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'claude-sonnet-4-5' }), token);

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('api.anthropic.com');
  });

  it('INV-6/PM260507: base-profile (no route table) lead-agent traffic does NOT require x-routed-model and routes to the base profile', async () => {
    // PM 260507: the route-table fail-closed gate is correct for subagents,
    // but lead-agent/direct traffic with no route table must not be forced
    // through the proxy route gate (which rejects for missing x-routed-model).
    const base = makeLocalProfile({ serverUrl: 'http://localhost:11600' });
    await proxyManager.startSingleProfile(base, nextPort++);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'llama-3' }), token);

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('localhost:11600');
  });

  it('INV-5/PM260504: x-codex-turn passthrough with a Codex-unsupported model is remapped before egress (no bad model reaches Codex)', async () => {
    // Defence-in-depth model-dialect guard (REBEL-520 / Claude-leak mirror):
    // a stale/invalid model on the Codex passthrough must be remapped, never
    // forwarded verbatim to the Codex endpoint.
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeCodexProfile()]]) };
    await proxyManager.addRoutes('turn-codex-remap', routeTable, undefined, nextPort++, false, true);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'gpt-5.5-pro' }), token, { 'x-codex-turn': 'true' });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('chatgpt.com/backend-api/codex');
    expect(captured[0].body.model).not.toBe('gpt-5.5-pro');
    expect(captured[0].body.model).toBe('gpt-5.5');
  });

  it('INV-5/PM260429+260504: x-codex-turn passthrough with a `claude-*` model is remapped before egress — NO `claude-`-prefixed model reaches the Codex endpoint (Claude-leak guard)', async () => {
    // This is the literal PM 260429 (Anthropic-native model routed to Codex) /
    // PM 260504 (Claude-model leak at the proxy egress) regression site. It is a
    // DISTINCT branch from the gpt-5.5-pro REBEL-520 remap above
    // (localModelProxyServer.ts:3555-3563 vs :3569): when a `claude-*` model name
    // reaches the Codex handler, the proxy must remap it to the working-profile
    // model — or, when no working profile is configured (as in these test
    // settings: no `localModel.profiles` → getWorkingModelProfile() returns
    // null), the Codex default `'gpt-5.5'`. It must NEVER forward the
    // `claude-`-prefixed model to the Codex Responses endpoint.
    //
    // Regression intent: this test would go RED if the `claude-` guard were
    // dropped or mis-ordered (e.g. during the Stage 12 RequestClassification /
    // REBEL-540 refactor), because the inbound `claude-opus-4-7` would then
    // egress verbatim to Codex — exactly the PM 260429/260504 leak. The
    // assertion traces the real upstream egress body, not a mock of the remap.
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeCodexProfile()]]) };
    await proxyManager.addRoutes('turn-codex-claude-leak', routeTable, undefined, nextPort++, false, true);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'claude-opus-4-7' }), token, { 'x-codex-turn': 'true' });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('chatgpt.com/backend-api/codex');
    // The Claude-leak invariant: the egress model must NOT carry the `claude-`
    // dialect prefix. (Asserting on the egress dialect, per F1.)
    expect(String(captured[0].body.model).startsWith('claude-')).toBe(false);
    // With no working profile in the test settings, the remap target is the
    // deterministic Codex default.
    expect(captured[0].body.model).toBe('gpt-5.5');
  });

  it('INV-12/F1: route-resolved → Codex (NO x-codex-turn header) with a `claude-*` profile model must NOT egress a `claude-`-prefixed model (the route-resolved leak path)', async () => {
    // F1 (Stage 12 refinement): the route-resolved → Codex egress path is a
    // SECOND, fully independent way to reach the Codex Responses upstream — it
    // does NOT carry the `x-codex-turn` header and is therefore classified as
    // `route-resolved`, dispatching through resolveRouteProfile →
    // handleStreamingRequest / forwardToLocalModel → handleCodexStreamingRequest
    // / forwardToCodexModel. BEFORE the fix, those Codex handlers built the
    // egress model from a raw `profile.model || anthropicRequest.model`, so a
    // codex-subscription route-table profile carrying `model: 'claude-opus-4-7'`
    // egressed a `claude-`-prefixed model to chatgpt.com/backend-api/codex with
    // no remap — the exact REBEL-540 leak, surviving on the symmetric site.
    //
    // Regression intent: this test goes RED without the F1 fix (the egress
    // model would be `claude-opus-4-7`). It guards BOTH the streaming
    // (handleCodexStreamingRequest) and non-streaming (forwardToCodexModel)
    // route-resolved Codex egress sites.
    const claudeCodexProfile = makeCodexProfile({ model: 'claude-opus-4-7' });
    const routeTable: ModelRouteTable = {
      routes: new Map([['claude-opus-4-7', claudeCodexProfile]]),
    };
    await proxyManager.addRoutes('turn-route-codex-claude', routeTable, undefined, nextPort++, false, true);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // Streaming variant → handleStreamingRequest → handleCodexStreamingRequest.
    const resStream = await sendToProxy(
      url,
      makeBody({ model: 'claude-opus-4-7', stream: true }),
      token,
      { 'x-routed-turn-id': 'turn-route-codex-claude', 'x-routed-model': 'claude-opus-4-7' },
    );
    expect(resStream.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('chatgpt.com/backend-api/codex');
    expect(String(captured[0].body.model).startsWith('claude-')).toBe(false);
    expect(captured[0].body.model).toBe('gpt-5.5');

    // Non-streaming variant → forwardToLocalModel → forwardToCodexModel.
    captured = [];
    const resNonStream = await sendToProxy(
      url,
      makeBody({ model: 'claude-opus-4-7', stream: false }),
      token,
      { 'x-routed-turn-id': 'turn-route-codex-claude', 'x-routed-model': 'claude-opus-4-7' },
    );
    expect(resNonStream.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('chatgpt.com/backend-api/codex');
    expect(String(captured[0].body.model).startsWith('claude-')).toBe(false);
    expect(captured[0].body.model).toBe('gpt-5.5');
  });

  it('INV-13/R1: x-codex-turn `claude-*` leak with a `gpt-5.5-pro` working profile must cascade through REBEL-520 and egress `gpt-5.5` (not `gpt-5.5-pro`)', async () => {
    // R1 (Stage 12 refinement): HEAD's inline claude-leak guard fed its remap
    // target into the REBEL-520 second-stage check — so a claude-leak that
    // remapped onto a Codex-DENIED working-profile model (`gpt-5.5-pro`, the
    // single deny-listed Codex model) got corrected to the Codex default
    // `gpt-5.5`. The Stage-12 refactor early-returned in the anthropic-native
    // branch and SKIPPED that second-stage check, so it egressed `gpt-5.5-pro`
    // (which Codex rejects with HTTP 400) — a defence-in-depth regression.
    //
    // Regression intent: this test goes RED without the R1 fix (the egress
    // model would be `gpt-5.5-pro`). It pins the `claude-* + wp=gpt-5.5-pro →
    // gpt-5.5` cascade cell that no prior invariant covered.
    settingsMock.current = {
      models: { apiKey: 'fake-test-anthropic-key' },
      providerKeys: { openai: 'fake-shared-openai' },
      customProviders: [],
      localModel: {
        activeProfileId: 'wp-pro',
        profiles: [
          {
            id: 'wp-pro',
            name: 'Working (gpt-5.5-pro)',
            providerType: 'openai',
            serverUrl: 'https://api.openai.com/v1',
            model: 'gpt-5.5-pro',
            createdAt: 0,
          },
        ],
      },
    };
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeCodexProfile()]]) };
    await proxyManager.addRoutes('turn-codex-claude-cascade', routeTable, undefined, nextPort++, false, true);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'claude-opus-4-7' }), token, { 'x-codex-turn': 'true' });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('chatgpt.com/backend-api/codex');
    // The cascade: claude-leak → wp.model=gpt-5.5-pro → REBEL-520 second-stage
    // re-check → Codex default. Must NOT egress the deny-listed gpt-5.5-pro.
    expect(captured[0].body.model).not.toBe('gpt-5.5-pro');
    expect(captured[0].body.model).toBe('gpt-5.5');
  });
});

// ===========================================================================
// Auth symmetry across handlers (extends crossHandlerAuth.test.ts to assert
// the sentinel never egresses on the OpenRouter branch either).
// ===========================================================================
describe('localModelProxyServer invariants — upstream auth symmetry', () => {
  it('INV-3/PM260430: OpenRouter passthrough strips poison + sentinel auth and injects the OR bearer', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'anthropic/claude-opus-4.7' }), token, {
      'x-openrouter-turn': 'true',
      'x-api-key': POISON_API_KEY,
      authorization: POISON_BEARER,
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('openrouter.ai');
    expect(captured[0].headers['x-api-key']).not.toBe(POISON_API_KEY);
    expect(captured[0].headers['x-api-key']).not.toBe(SENTINEL);
    expect(captured[0].headers['authorization']).toBe('Bearer fake-or-resolved-key');
  });

  it('INV-4/PM260430: route-table Anthropic passthrough never forwards the PROXY_HANDLES_AUTH_SENTINEL upstream', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'claude-sonnet-4-5' }), token, {
      'x-api-key': SENTINEL,
      authorization: 'Bearer proxy-internal-bearer',
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('api.anthropic.com');
    expect(captured[0].headers['x-api-key']).not.toBe(SENTINEL);
    expect(captured[0].headers['x-api-key']).toBe('fake-test-anthropic-key');
    expect(captured[0].headers['authorization']).toBeUndefined();
  });
});

// ===========================================================================
// OpenRouter telemetry preservation: usage.cost (body) + x-rebel-or-provider
// (downstream header). No prior runnable home for these two.
// ===========================================================================
describe('localModelProxyServer invariants — OpenRouter telemetry preservation', () => {
  it('INV-7: forwards x-rebel-or-provider header from the upstream `provider` field to the client', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'anthropic/claude-opus-4.7' }), token, {
      'x-openrouter-turn': 'true',
    });

    expect(res.status).toBe(200);
    expect(res.headers['x-rebel-or-provider']).toBe('Anthropic');
  });

  it('INV-7: preserves upstream usage.cost in the forwarded OpenRouter response body', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'anthropic/claude-opus-4.7' }), token, {
      'x-openrouter-turn': 'true',
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { usage?: { cost?: number } };
    expect(parsed.usage?.cost).toBe(0.0123);
  });

  it('INV-2/F3: OpenRouter passthrough forwards inbound `output_format` VERBATIM (no translation to response_format) — pins the empty structured-output × OR cell', async () => {
    // Structured-output matrix cell that previously had no runnable home (F3).
    // Unlike the four non-Codex chat/Responses sites and the three Codex sites
    // (which translate Anthropic `output_format` → OpenAI `response_format` /
    // Codex `text.format`), handleOpenRouterPassthrough forwards the body
    // verbatim (it only does thinking→reasoning, context-management strip, and
    // provider routing). OR receives Anthropic-shaped bodies and extracts JSON
    // itself, so the CURRENT correct behaviour is that `output_format` passes
    // through unchanged. This pins that: if a future change inserts a translator
    // here (or strips the field), this goes red.
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const outputFormat = {
      type: 'json_schema',
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    };
    const res = await sendToProxy(
      url,
      makeBody({ model: 'anthropic/claude-opus-4.7', output_format: outputFormat }),
      token,
      { 'x-openrouter-turn': 'true' },
    );

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('openrouter.ai');
    // Forwarded verbatim: output_format survives, and it was NOT translated to
    // an OpenAI-style response_format.
    expect(captured[0].body.output_format).toEqual(outputFormat);
    expect(captured[0].body.response_format).toBeUndefined();
  });

  it('INV-8/REBEL-4GH: upstream Codex 429 quota signal survives as `code` while top-level type stays SDK-compatible', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('chatgpt.com/backend-api/codex')) {
        return new Response(
          JSON.stringify({ error: { type: 'usage_limit_reached', message: 'limit reached', resets_at: resetsAt } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeCodexProfile()]]) };
    await proxyManager.addRoutes('turn-429', routeTable, undefined, nextPort++, false, true);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'gpt-5.5' }), token, { 'x-codex-turn': 'true' });

    expect(res.status).toBe(429);
    const parsed = JSON.parse(res.body) as { error: Record<string, unknown> };
    expect(parsed.error.type).toBe('rate_limit_error');
    expect(parsed.error.code).toBe('usage_limit_reached');
    expect(parsed.error.resets_at).toBe(resetsAt);
  });
});

// ===========================================================================
// Stream terminal / liveness invariants (PMs 260424 / 260427 watchdog class).
// The existing routing.test.ts streaming test uses a stream WITH [DONE]; the
// no-[DONE] terminal-synthesis path (MiniMax) had no runnable home.
// ===========================================================================
describe('localModelProxyServer invariants — stream terminal events', () => {
  it('INV-10/PM260424: OpenAI streaming that ends without [DONE] still emits a synthesized message_stop', async () => {
    const profile = makeOpenAIProfile({ serverUrl: 'http://localhost:11700', model: 'gpt-5.5' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', profile]]) };
    await proxyManager.addRoutes('turn-nodone', routeTable, undefined, nextPort++, false, false);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'gpt-5.5', stream: true }), token, {
      'x-routed-turn-id': 'turn-nodone',
      'x-routed-model': 'gpt-5.5',
    });

    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');
    const events = parseSSEEvents(res.body);
    expect(events.some((e) => e.event === 'message_start')).toBe(true);
    expect(events.some((e) => e.event === 'message_stop')).toBe(true);
  });

  it('INV-10: streaming Codex passthrough returns SSE (text/event-stream), not JSON', async () => {
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', makeCodexProfile()]]) };
    await proxyManager.addRoutes('turn-codex-sse', routeTable, undefined, nextPort++, false, true);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'gpt-5.5', stream: true }), token, { 'x-codex-turn': 'true' });

    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');
    expect(res.contentType).not.toContain('application/json');
  });
});

// ===========================================================================
// HTTP shell / security invariants (DNS-rebinding host check kept in the shell
// across Stage 12 classification extraction).
// ===========================================================================
describe('localModelProxyServer invariants — HTTP security shell', () => {
  it('INV-11: fails closed with 401 when X-Proxy-Auth is missing', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const url = proxyManager.getUrl()!;

    const res = await sendToProxy(url, makeBody({ model: 'claude-sonnet-4-5' }), undefined);

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized: Missing authentication' });
    expect(captured).toHaveLength(0);
  });

  it('INV-12/PM260507: route-table turn request missing x-routed-model fails closed with 400 route_required (subagent gate)', async () => {
    const profile = makeOpenAIProfile();
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.5', profile]]) };
    await proxyManager.addRoutes('turn-gate', routeTable, undefined, nextPort++);
    const url = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(url, makeBody({ model: 'gpt-5.5' }), token, { 'x-routed-turn-id': 'turn-gate' });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'route_required' });
    expect(captured).toHaveLength(0);
  });
});

// ===========================================================================
// Cross-surface constraint: the proxy is imported by the cloud bootstrap
// (cloud-service/src/bootstrap.ts), so it MUST NOT import `electron`. Stages
// 12-14 extract helpers into ./localModelProxy/* — this static guard exists to
// make an accidental electron import (which would break the cloud runtime) a
// loud test failure rather than a runtime crash.
// ===========================================================================
describe('localModelProxyServer invariants — cross-surface no-electron-import', () => {
  it('INV-13: the proxy module source contains no `electron` import', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.resolve(here, '../localModelProxyServer.ts'), 'utf8');
    // Match an actual import/require of the electron package, not the word in comments.
    const importRe = /\bfrom\s+['"]electron['"]|\brequire\(\s*['"]electron['"]\s*\)|\bimport\s+['"]electron['"]/;
    expect(importRe.test(source)).toBe(false);
  });
});
