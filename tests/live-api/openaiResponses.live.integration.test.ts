/**
 * Gated live OpenAI Responses-API proxy integration test.
 *
 * Drives a real tools+reasoning request through the local loopback proxy
 * (`proxyManager`) to OpenAI's `/v1/responses` endpoint, while capturing the
 * outbound fetch body and allowing the request to continue upstream.
 *
 * Gating contract:
 *  - Gated SOLELY on `TEST_OPENAI_API_KEY` (loaded from `.env.test` by
 *    vitest.setup.ts). Absent key -> the whole describe SKIPS, never fails, so
 *    CI without secrets stays green.
 *  - The gate intentionally does NOT touch getAuthForDirectUse /
 *    getApiKeyForDirectUse / hasDirectAuth and never READS a `settings.claude.*`
 *    field, so scripts/check-integration-test-provider-gates.ts reports no
 *    violation. Settings are constructed via a pure object literal where
 *    `models: { apiKey: ... }` is a write (property assignment), not a read.
 */
import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createClientForModel } from '@core/rebelCore/clientFactory';
import { OpenAIClient } from '@core/rebelCore/clients/openaiClient';
import { ModelError } from '@core/rebelCore/modelErrors';
import type { CreateParams } from '@core/rebelCore/modelClient';
import type { AppSettings, ModelProfile } from '@shared/types';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describeLiveApi } from '../../src/test-utils/liveApiHarness';

const MODEL = unsafeAssertRoutingModelId('gpt-5-nano');
const LIVE_TIMEOUT_MS = 60_000;
const LATENCY_WARN_MS = 20_000;
const MAX_TOKENS = 64;
const BOGUS_OPENAI_KEY = 'fake-invalid-openai-key-000000000000';

/**
 * Minimal AppSettings built from a pure object literal. `models: { apiKey }`
 * is a WRITE, so the provider-gate AST check does not flag it. OpenAI auth is
 * resolved from the explicit route/profile supplied by each test.
 */
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

interface CapturedUpstream {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface AnthropicProxyResponse {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  stop_reason?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
}

function makeOpenAIProfile(
  apiKey: string,
  model: typeof MODEL,
  overrides: Partial<ModelProfile> = {},
): ModelProfile {
  return {
    id: `openai-${model}-responses-live`,
    name: `OpenAI ${model} Responses live`,
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    apiKey,
    model,
    enabled: true,
    createdAt: 0,
    ...overrides,
  } as unknown as ModelProfile;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key.toLowerCase(), value]));
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
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

function textFromAnthropicContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const text = (block as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

function assertUsagePresent(responseJson: AnthropicProxyResponse): void {
  expect(typeof responseJson.usage?.input_tokens).toBe('number');
  expect(typeof responseJson.usage?.output_tokens).toBe('number');
  expect(responseJson.usage!.input_tokens as number).toBeGreaterThan(0);
  expect(responseJson.usage!.output_tokens as number).toBeGreaterThanOrEqual(0);
}

function findOpenAIResponsesCall(captured: CapturedUpstream[]): CapturedUpstream | undefined {
  return captured.find((entry) => entry.url === 'https://api.openai.com/v1/responses');
}

function createParams(model: typeof MODEL): CreateParams {
  return {
    model,
    systemPrompt: 'You are terse. Reply with one short word.',
    messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
    maxTokens: 16,
  };
}

let nextPort = 50060;

describeLiveApi(
  {
    provider: 'openai',
    label: 'localModelProxyServer OpenAI Responses API — live integration',
    envVar: 'TEST_OPENAI_API_KEY',
    model: MODEL,
  },
  ({ key }) => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
  let captured: CapturedUpstream[] = [];

  afterEach(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    captured = [];
    await proxyManager.stop();
    nextPort += 10;
  });

  it(
    'round-trips tools+reasoning through /responses with the production egress contract',
    async () => {
      const originalFetch = globalThis.fetch;
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        let parsedBody: Record<string, unknown> = {};
        if (bodyStr) {
          parsedBody = JSON.parse(bodyStr) as Record<string, unknown>;
        }
        captured.push({
          url: urlStr,
          headers: normalizeHeaders(init?.headers),
          body: parsedBody,
        });
        return originalFetch(url, init);
      });

      const routeTable: ModelRouteTable = {
        routes: new Map([[MODEL, makeOpenAIProfile(key, MODEL, { reasoningEffort: 'low' })]]),
      };
      const turnId = 'turn-openai-responses-tools-reasoning-live';
      await proxyManager.addRoutes(turnId, routeTable, undefined, nextPort++, false, false);
      const proxyUrl = proxyManager.getUrl()!;
      const token = proxyManager.getAuthToken()!;

      const startedAt = Date.now();
      const response = await sendToProxy(
        proxyUrl,
        JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          stream: false,
          temperature: 0.2,
          system: 'You are terse. Do not call tools for this request.',
          messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
          tools: [
            {
              name: 'get_time',
              description: 'Routing trigger only. Do not call this tool unless the user asks for the time.',
              input_schema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        }),
        token,
        { 'x-routed-turn-id': turnId, 'x-routed-model': MODEL },
      );
      const latencyMs = Date.now() - startedAt;

      const latencyLabel = latencyMs > LATENCY_WARN_MS ? 'past generous budget' : 'within generous budget';
      console.warn(`[live] OpenAI gpt-5-nano Responses proxy call took ${latencyMs}ms (${latencyLabel})`);

      expect(response.status, `OpenAI Responses proxy response body: ${response.body}`).toBe(200);
      expect(response.contentType).toContain('application/json');

      const responseJson = JSON.parse(response.body) as AnthropicProxyResponse;
      expect(responseJson.type).toBe('message');
      expect(responseJson.role).toBe('assistant');
      expect(textFromAnthropicContent(responseJson.content).trim().length).toBeGreaterThan(0);
      assertUsagePresent(responseJson);

      const upstream = findOpenAIResponsesCall(captured);
      expect(
        upstream,
        `no OpenAI /v1/responses call captured; saw: ${captured.map((entry) => entry.url).join(', ')}`,
      ).toBeDefined();
      expect(captured.some((entry) => entry.url === 'https://api.openai.com/v1/chat/completions')).toBe(false);

      // Regression record (scope: FIRST-PARTY OpenAI `/v1/responses` only). The
      // 260530/260430 cluster mocked a desired 200 while the real Responses endpoint
      // 400ed on forwarded sampling/token-budget params; this cell catches that
      // SEND-vs-ACCEPT drift because only the real endpoint rejects it. It does NOT
      // cover the Codex OAuth Responses endpoint (260504/260429 stream-invariant) —
      // that surface authenticates via ChatGPT OAuth, is not sourceable in this
      // API-key tier, and remains a documented blind spot (see PLAN Stage 7).
      expect(upstream!.body.model).toBe(MODEL);
      expect(upstream!.body.stream).toBe(false);
      expect(upstream!.body.store).toBe(false);
      // The Codex Responses translator attaches a reasoning summary channel
      // (CODEX_REASONING_SUMMARY_MODE = 'auto', codexResponsesTranslator.ts) on
      // every /responses egress so GPT reasoning self-talk routes to BTS — assert
      // the full intended contract, not just effort.
      expect(upstream!.body.reasoning).toEqual({ effort: 'low', summary: 'auto' });
      expect(upstream!.body.text).toEqual({ format: { type: 'text' } });
      expect(upstream!.body).not.toHaveProperty('temperature');
      expect(upstream!.body).not.toHaveProperty('max_tokens');
      expect(upstream!.body).not.toHaveProperty('max_completion_tokens');
      expect(upstream!.body).not.toHaveProperty('max_output_tokens');
      expect(upstream!.body.tools).toEqual([
        {
          type: 'function',
          name: 'get_time',
          description: 'Routing trigger only. Do not call this tool unless the user asks for the time.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ]);
      // Assert the Bearer shape WITHOUT placing the real key in a matcher that
      // Vitest would render on assertion failure (live-tier keys-never-logged invariant).
      const authHeader = upstream!.headers['authorization'];
      expect(authHeader?.startsWith('Bearer ')).toBe(true);
      expect(authHeader?.length ?? 0).toBeGreaterThan('Bearer '.length);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'invalid OpenAI key fails closed with a classified auth/401 ModelError',
    async () => {
      const settings = makeSettings();
      const profile = makeOpenAIProfile(BOGUS_OPENAI_KEY, MODEL);
      const client = await createClientForModel({ model: MODEL, profile, settings });
      expect(client).toBeInstanceOf(OpenAIClient);

      let caught: unknown;
      try {
        await client.create(createParams(MODEL));
        throw new Error('expected OpenAI create to reject on invalid key');
      } catch (err) {
        caught = err;
      }

      // Distinguish provider-unreachable from classified upstream rejection. A
      // reachable OpenAI API returns 401 -> classifyHttpError -> ModelError('auth',
      // 401). Raw fetch failures are transport/reachability problems and should
      // fail with a direct diagnostic instead of a misleading classification diff.
      if (!(caught instanceof ModelError)) {
        throw new Error(
          'provider unreachable (network/transport) - not a wrong-key ' +
            'classification failure. The OpenAI API could not be reached, so ' +
            'the 401 fail-closed path was never exercised. This is a ' +
            'harness-health / reachability problem, not a routing regression. ' +
            `Underlying error: ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`,
        );
      }

      expect(caught.kind).toBe('auth');
      expect(caught.status).toBe(401);
    },
    LIVE_TIMEOUT_MS,
  );
  },
);
