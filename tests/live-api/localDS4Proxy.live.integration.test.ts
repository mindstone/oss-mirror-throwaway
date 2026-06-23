/**
 * Gated live integration test: local DS4 (DwarfStar / DeepSeek V4 Flash) through
 * the local model proxy.
 *
 * Drives real Anthropic `/v1/messages` requests through the loopback proxy
 * (`proxyManager`) to a LOCAL `ds4-server` (antirez/ds4) speaking the
 * OpenAI-compatible `/v1/chat/completions` dialect at `http://127.0.0.1:8000/v1`.
 * This exercises the exact code path the desktop app uses for the `local:ds4`
 * preset: Anthropic in -> translate to OpenAI -> ds4 -> translate response back
 * to Anthropic out (`forwardToLocalModel` / `handleStreamingRequest`).
 *
 * The point of this test (vs the curl spikes in
 * docs/plans/260608_ds4-local-call-improvements/SPIKES.md) is to prove the full
 * Rebel proxy round-trip — including the Anthropic<->OpenAI tool translation —
 * preserves correctly-TYPED tool-call arguments (integer/boolean), the single
 * biggest divergence from the OpenRouter-hosted DS4-Flash path (which
 * stringified them; see docs/plans/260608_minimax-ds4-mcp-toolcall-eval/PLAN.md).
 *
 * Gating contract (mirrors the OpenAI chat-completions live test):
 *  - Whole tier opt-in via `RUN_LIVE_API_TESTS` (handled by `describeLiveApi`).
 *  - Cell gated on `TEST_OPENAI_API_KEY` (harness invariant; the local profile
 *    has NO apiKey and never uses the resolved key — it is required only so the
 *    file conforms to the shared keys-never-logged harness, and is a backstop
 *    that keeps the cell inert in any environment lacking the key).
 *  - PLUS an explicit `RUN_DS4_LOCAL_LIVE` prerequisite: a local ds4-server must
 *    be running on 127.0.0.1:8000. Unset -> SKIP (so CI / normal `npm run
 *    test:live` never tries to reach a server that isn't there).
 *
 * To run locally (with ds4-server up):
 *   RUN_LIVE_API_TESTS=1 RUN_DS4_LOCAL_LIVE=1 TEST_OPENAI_API_KEY=<any-real-key> \
 *     npx vitest run --project=desktop tests/live-api/localDS4Proxy.live.integration.test.ts
 */
import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AppSettings, ModelProfile } from '@shared/types';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describeLiveApi } from '../../src/test-utils/liveApiHarness';

const DS4_MODEL = unsafeAssertRoutingModelId('deepseek-v4-flash');
const DS4_SERVER_URL = 'http://127.0.0.1:8000/v1';

const LIVE_TIMEOUT_MS = 120_000;
const LATENCY_WARN_MS = 60_000;
const MAX_TOKENS = 512;

const ds4LiveOptIn = !!process.env.RUN_DS4_LOCAL_LIVE?.trim();

function makeSettings(): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    activeProvider: 'openai',
    voice: { enabled: false },
    models: {
      apiKey: 'dummy-anthropic-key-not-used',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-20250514',
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
    },
    diagnostics: { enabled: false },
    providerKeys: {},
    openRouter: { oauthToken: null },
    localModel: { profiles: [], activeProfileId: null },
  } as unknown as AppSettings;
}

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => makeSettings(),
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

import { proxyManager, type ModelRouteTable } from '@main/services/localModelProxyServer';

interface ProxyResult {
  status: number;
  body: string;
  contentType: string;
}

interface AnthropicProxyResponse {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  stop_reason?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

/**
 * Profile mirrors the real `local:ds4` preset shape produced by the profile
 * wizard for a local server: providerType 'other', routeSurface 'local',
 * presetKey 'local:ds4', loopback serverUrl, no apiKey.
 */
function makeLocalDs4Profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'local-ds4-flash-proxy-live',
    name: 'Local DS4 Flash proxy live',
    providerType: 'other',
    routeSurface: 'local',
    presetKey: 'local:ds4',
    serverUrl: DS4_SERVER_URL,
    model: DS4_MODEL,
    reasoningEffort: 'low',
    enabled: true,
    createdAt: 0,
    ...overrides,
  } as unknown as ModelProfile;
}

function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string,
  headers: Record<string, string> = {},
): Promise<ProxyResult> {
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

function blocks(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

function textFromAnthropicContent(content: unknown): string {
  return blocks(content)
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function firstToolUse(content: unknown): Record<string, unknown> | undefined {
  return blocks(content).find((block) => block.type === 'tool_use');
}

let nextPort = 49980;

describeLiveApi(
  {
    provider: 'openai',
    label: 'localModelProxyServer -> local ds4 (DeepSeek V4 Flash) - live integration',
    envVar: 'TEST_OPENAI_API_KEY',
    model: DS4_MODEL,
    requires: [
      {
        name: 'RUN_DS4_LOCAL_LIVE',
        ok: ds4LiveOptIn,
        diagnostic:
          'set RUN_DS4_LOCAL_LIVE=1 and run a local ds4-server on 127.0.0.1:8000 (see docs/plans/260608_ds4-local-call-improvements/)',
      },
    ],
  },
  () => {
    afterEach(async () => {
      await proxyManager.stop();
      nextPort += 10;
    });

    async function startProxyForTurn(turnId: string, profile: ModelProfile): Promise<{ proxyUrl: string; token: string }> {
      const routeTable: ModelRouteTable = { routes: new Map([[DS4_MODEL, profile]]) };
      await proxyManager.addRoutes(turnId, routeTable, undefined, nextPort++, false, false);
      return { proxyUrl: proxyManager.getUrl()!, token: proxyManager.getAuthToken()! };
    }

    it(
      'round-trips a plain chat message through the proxy to local ds4',
      async () => {
        const turnId = 'turn-ds4-chat-live';
        const { proxyUrl, token } = await startProxyForTurn(turnId, makeLocalDs4Profile());

        const startedAt = Date.now();
        const response = await sendToProxy(
          proxyUrl,
          JSON.stringify({
            model: DS4_MODEL,
            max_tokens: MAX_TOKENS,
            stream: false,
            thinking: { type: 'disabled' },
            system: 'You are terse.',
            messages: [{ role: 'user', content: 'Reply with exactly the word: ok' }],
          }),
          token,
          { 'x-routed-turn-id': turnId, 'x-routed-model': DS4_MODEL },
        );
        const latencyMs = Date.now() - startedAt;
        console.warn(
          `[live] local ds4 chat proxy call took ${latencyMs}ms (${latencyMs > LATENCY_WARN_MS ? 'past' : 'within'} generous budget)`,
        );

        expect(response.status, `ds4 proxy response body: ${response.body}`).toBe(200);
        expect(response.contentType).toContain('application/json');
        const json = JSON.parse(response.body) as AnthropicProxyResponse;
        expect(json.type).toBe('message');
        expect(json.role).toBe('assistant');
        expect(textFromAnthropicContent(json.content).trim().length).toBeGreaterThan(0);
        expect(typeof json.usage?.output_tokens).toBe('number');
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      'preserves correctly-typed tool-call arguments through the full Anthropic<->OpenAI round-trip',
      async () => {
        const turnId = 'turn-ds4-tool-live';
        const { proxyUrl, token } = await startProxyForTurn(turnId, makeLocalDs4Profile());

        const response = await sendToProxy(
          proxyUrl,
          JSON.stringify({
            model: DS4_MODEL,
            max_tokens: MAX_TOKENS,
            stream: false,
            thinking: { type: 'disabled' },
            messages: [
              {
                role: 'user',
                content:
                  'Search Slack for the 25 most recent messages about the Q3 roadmap, including archived channels. Use the search_messages tool.',
              },
            ],
            tools: [
              {
                name: 'search_messages',
                description: 'Search messages across channels.',
                input_schema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string', description: 'search text' },
                    max_results: { type: 'integer', description: 'max number of results' },
                    include_archived: { type: 'boolean', description: 'include archived channels' },
                  },
                  required: ['query', 'max_results'],
                },
              },
            ],
          }),
          token,
          { 'x-routed-turn-id': turnId, 'x-routed-model': DS4_MODEL },
        );

        expect(response.status, `ds4 proxy response body: ${response.body}`).toBe(200);
        const json = JSON.parse(response.body) as AnthropicProxyResponse;
        expect(json.stop_reason).toBe('tool_use');
        const toolUse = firstToolUse(json.content);
        expect(toolUse, `expected a tool_use block; got: ${JSON.stringify(json.content)}`).toBeDefined();
        expect(toolUse!.name).toBe('search_messages');
        const input = toolUse!.input as Record<string, unknown>;
        // The headline assertion: scalars survive as their JSON types, NOT strings.
        expect(typeof input.max_results).toBe('number');
        expect(input.max_results).toBe(25);
        if ('include_archived' in input) {
          expect(typeof input.include_archived).toBe('boolean');
          expect(input.include_archived).toBe(true);
        }
        expect(typeof input.query).toBe('string');
      },
      LIVE_TIMEOUT_MS,
    );

    it(
      'completes a multi-turn tool round-trip (tool_use -> tool_result -> final answer)',
      async () => {
        const turnId = 'turn-ds4-multiturn-live';
        const { proxyUrl, token } = await startProxyForTurn(turnId, makeLocalDs4Profile());

        const response = await sendToProxy(
          proxyUrl,
          JSON.stringify({
            model: DS4_MODEL,
            max_tokens: MAX_TOKENS,
            stream: false,
            thinking: { type: 'disabled' },
            tools: [
              {
                name: 'count_prs',
                description: 'Count PRs by state.',
                input_schema: {
                  type: 'object',
                  properties: { state: { type: 'string', enum: ['open', 'closed'] } },
                  required: ['state'],
                },
              },
            ],
            messages: [
              { role: 'user', content: 'How many open PRs are there? Use the count_prs tool.' },
              {
                role: 'assistant',
                content: [
                  { type: 'tool_use', id: 'toolu_ds4_live_1', name: 'count_prs', input: { state: 'open' } },
                ],
              },
              {
                role: 'user',
                content: [
                  { type: 'tool_result', tool_use_id: 'toolu_ds4_live_1', content: '{"count": 7}' },
                ],
              },
            ],
          }),
          token,
          { 'x-routed-turn-id': turnId, 'x-routed-model': DS4_MODEL },
        );

        expect(response.status, `ds4 proxy response body: ${response.body}`).toBe(200);
        const json = JSON.parse(response.body) as AnthropicProxyResponse;
        expect(json.stop_reason).toBe('end_turn');
        expect(textFromAnthropicContent(json.content)).toContain('7');
      },
      LIVE_TIMEOUT_MS,
    );
  },
);
