/**
 * Deterministic regression test for the SAFETY-EVAL structured-output path on
 * the OpenRouter passthrough route (the prod path for DeepSeek/managed models).
 *
 * Companion to `safetyEvalLiveModels.integration.test.ts` (which exercises the
 * same hop LIVE but skips in keyless CI). This test mocks `fetch` so it runs
 * everywhere — including keyless CI — and locks the contract that the May-2026
 * incident exposed (see docs/plans/260529_safety-eval-live-tests/PLAN.md):
 *
 *   1. The proxy forwards the structured-output safety call to OpenRouter's
 *      Anthropic-compatible Messages endpoint (`/v1/messages`), NOT a streaming
 *      or chat-completions endpoint.
 *   2. `output_format` (json_schema) is PRESERVED upstream — structured output is
 *      not silently dropped (the 260509 bug class).
 *   3. `stream:false` is preserved end-to-end (BTS safety calls are non-streaming).
 *   4. NO reasoning/thinking is injected for the safety call. The incident root
 *      cause was the marginal latency of this path; enabling reasoning fat-tails
 *      it past the 15s budget (probe v3). This asserts the proxy does not add
 *      `thinking` / `reasoning` / `reasoning_effort` when the caller didn't.
 *
 * Mirrors the boot/spy pattern of `localModelProxyServer.outputFormat.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({
    activeProvider: 'openrouter',
    openRouter: { oauthToken: 'fake-openrouter-key-not-used-upstream-is-mocked' },
    providerKeys: {},
    customProviders: [],
  }),
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

// Verbatim copy of EVAL_OUTPUT_SCHEMA from src/core/safetyPromptLogic.ts:67
// (full shape incl. optional persistenceIntent) so the preserved-upstream
// assertion catches schema drift, not just the three top-level fields.
const EVAL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['allow', 'block'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
    persistenceIntent: {
      type: 'object',
      properties: {
        detected: { type: 'boolean' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        scopeHint: { type: 'string', enum: ['trusted_tool', 'broad', 'specific'] },
        triggerPhrase: { type: 'string' },
        rationale: { type: 'string' },
      },
      required: ['detected', 'confidence', 'scopeHint', 'triggerPhrase', 'rationale'],
      additionalProperties: false,
    },
  },
  required: ['decision', 'confidence', 'reason'],
  additionalProperties: false,
} as const;

function makeMessagesJsonResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      model: 'deepseek/deepseek-v4-flash',
      content: [{ type: 'text', text: '{"decision":"allow","confidence":"high","reason":"benign local op"}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 20 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
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
        headers: { 'Content-Type': 'application/json', 'X-Proxy-Auth': authToken, Host: '127.0.0.1', ...headers },
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

interface CapturedUpstream {
  url: string;
  body: Record<string, unknown>;
}

let nextPort = 49870;

describe('safety-eval OpenRouter passthrough — structured-output contract', () => {
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
      if (urlStr.includes('openrouter.ai') && urlStr.includes('/v1/messages')) {
        return makeMessagesJsonResponse();
      }
      return new Response('not-found', { status: 404 });
    });
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    await proxyManager.stop();
    nextPort += 10;
  });

  it('forwards a non-streaming structured-output safety call to OpenRouter /v1/messages with output_format preserved and no reasoning injected', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.addRoutes('safety-passthrough', routeTable, undefined, nextPort++, false, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        max_tokens: 4096,
        stream: false,
        system: "You are Rebel's safety evaluator. Respond with valid JSON only.",
        messages: [{ role: 'user', content: 'Tool: Bash "git status". Safe?' }],
        output_format: { type: 'json_schema', schema: EVAL_OUTPUT_SCHEMA },
      }),
      token,
      { 'x-openrouter-turn': 'true', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'structured-outputs-2025-11-13' },
    );

    expect(response.status).toBe(200);

    const upstream = captured.find((e) => e.url.includes('openrouter.ai') && e.url.includes('/v1/messages'));
    expect(upstream, `no upstream /v1/messages call captured; saw: ${captured.map((c) => c.url).join(', ')}`).toBeDefined();

    const body = upstream!.body as {
      model?: string;
      stream?: boolean;
      output_format?: { type?: string; schema?: unknown };
      thinking?: unknown;
      reasoning?: unknown;
      reasoning_effort?: unknown;
    };

    // (1) Routed to the Anthropic-compat Messages endpoint.
    expect(upstream!.url).toContain('https://openrouter.ai/api/v1/messages');
    expect(body.model).toBe('deepseek/deepseek-v4-flash');

    // (2) Structured output preserved (not dropped — 260509 bug class).
    expect(body.output_format?.type).toBe('json_schema');
    expect(body.output_format?.schema).toEqual(EVAL_OUTPUT_SCHEMA);

    // (3) Non-streaming preserved.
    expect(body.stream).toBe(false);

    // (4) No reasoning/thinking injected by the proxy for the safety call —
    // the latency-fat-tail root cause. If a future change enables reasoning on
    // this path, this assertion fails and flags the regression.
    expect(body.thinking, 'proxy must not inject thinking on the safety path').toBeUndefined();
    expect(body.reasoning, 'proxy must not inject reasoning on the safety path').toBeUndefined();
    expect(body.reasoning_effort, 'proxy must not inject reasoning_effort on the safety path').toBeUndefined();
  });
});
