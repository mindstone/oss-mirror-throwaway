/**
 * Gated live OpenAI Chat-Completions proxy integration test.
 *
 * Drives real no-tools requests through the local loopback proxy
 * (`proxyManager`) to OpenAI's `/v1/chat/completions` endpoint, while
 * capturing the outbound fetch body and allowing the request to continue
 * upstream.
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
import type { AppSettings, ModelProfile } from '@shared/types';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describeLiveApi } from '../../src/test-utils/liveApiHarness';

const REASONING_MODEL = unsafeAssertRoutingModelId('gpt-5-nano');
const NON_REASONING_MODEL = unsafeAssertRoutingModelId('gpt-4.1-nano');

const LIVE_TIMEOUT_MS = 60_000;
const LATENCY_WARN_MS = 20_000;
const MAX_TOKENS = 512;

/**
 * Minimal AppSettings built from a pure object literal. `models: { apiKey }`
 * is a WRITE, so the provider-gate AST check does not flag it. OpenAI auth is
 * resolved from each route profile's `apiKey`.
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
  model: typeof REASONING_MODEL | typeof NON_REASONING_MODEL,
  overrides: Partial<ModelProfile> = {},
): ModelProfile {
  return {
    id: `openai-${model}-proxy-live`,
    name: `OpenAI ${model} proxy live`,
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

function findOpenAIChatCompletionsCall(captured: CapturedUpstream[]): CapturedUpstream | undefined {
  return captured.find((entry) => entry.url === 'https://api.openai.com/v1/chat/completions');
}

let nextPort = 49960;

describeLiveApi(
  {
    provider: 'openai',
    label: 'localModelProxyServer OpenAI Chat Completions - live integration',
    envVar: 'TEST_OPENAI_API_KEY',
    model: REASONING_MODEL,
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
    'round-trips gpt-5-nano through /chat/completions with temperature stripped and reasoning_effort preserved',
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
        routes: new Map([[REASONING_MODEL, makeOpenAIProfile(key, REASONING_MODEL, { reasoningEffort: 'low' })]]),
      };
      const turnId = 'turn-openai-chat-completions-reasoning-live';
      await proxyManager.addRoutes(turnId, routeTable, undefined, nextPort++, false, false);
      const proxyUrl = proxyManager.getUrl()!;
      const token = proxyManager.getAuthToken()!;

      const startedAt = Date.now();
      const response = await sendToProxy(
        proxyUrl,
        JSON.stringify({
          model: REASONING_MODEL,
          max_tokens: MAX_TOKENS,
          stream: false,
          temperature: 0.2,
          system: 'You are terse.',
          messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        }),
        token,
        { 'x-routed-turn-id': turnId, 'x-routed-model': REASONING_MODEL },
      );
      const latencyMs = Date.now() - startedAt;

      const latencyLabel = latencyMs > LATENCY_WARN_MS ? 'past generous budget' : 'within generous budget';
      console.warn(`[live] OpenAI gpt-5-nano Chat Completions proxy call took ${latencyMs}ms (${latencyLabel})`);

      expect(response.status, `OpenAI proxy response body: ${response.body}`).toBe(200);
      expect(response.contentType).toContain('application/json');

      const responseJson = JSON.parse(response.body) as AnthropicProxyResponse;
      expect(responseJson.type).toBe('message');
      expect(responseJson.role).toBe('assistant');
      assertUsagePresent(responseJson);

      const upstream = findOpenAIChatCompletionsCall(captured);
      expect(
        upstream,
        `no OpenAI /v1/chat/completions call captured; saw: ${captured.map((entry) => entry.url).join(', ')}`,
      ).toBeDefined();

      expect(upstream!.body.model).toBe(REASONING_MODEL);
      expect(upstream!.body.max_completion_tokens).toBe(MAX_TOKENS);
      expect(upstream!.body.stream).toBe(false);
      expect(upstream!.body).not.toHaveProperty('temperature');
      expect(upstream!.body.reasoning_effort).toBe('low');
      // Assert the Bearer shape WITHOUT placing the real key in a matcher that
      // Vitest would render on assertion failure (live-tier keys-never-logged invariant).
      const authHeader = upstream!.headers['authorization'];
      expect(authHeader?.startsWith('Bearer ')).toBe(true);
      expect(authHeader?.length ?? 0).toBeGreaterThan('Bearer '.length);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'round-trips gpt-4.1-nano through /chat/completions with reasoning_effort stripped and temperature preserved',
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
        routes: new Map([[NON_REASONING_MODEL, makeOpenAIProfile(key, NON_REASONING_MODEL, { reasoningEffort: 'low' })]]),
      };
      const turnId = 'turn-openai-chat-completions-non-reasoning-live';
      await proxyManager.addRoutes(turnId, routeTable, undefined, nextPort++, false, false);
      const proxyUrl = proxyManager.getUrl()!;
      const token = proxyManager.getAuthToken()!;

      const startedAt = Date.now();
      const response = await sendToProxy(
        proxyUrl,
        JSON.stringify({
          model: NON_REASONING_MODEL,
          max_tokens: MAX_TOKENS,
          stream: false,
          temperature: 0.2,
          system: 'You are terse.',
          messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        }),
        token,
        { 'x-routed-turn-id': turnId, 'x-routed-model': NON_REASONING_MODEL },
      );
      const latencyMs = Date.now() - startedAt;

      const latencyLabel = latencyMs > LATENCY_WARN_MS ? 'past generous budget' : 'within generous budget';
      console.warn(`[live] OpenAI gpt-4.1-nano Chat Completions proxy call took ${latencyMs}ms (${latencyLabel})`);

      expect(response.status, `OpenAI proxy response body: ${response.body}`).toBe(200);
      expect(response.contentType).toContain('application/json');

      const responseJson = JSON.parse(response.body) as AnthropicProxyResponse;
      expect(responseJson.type).toBe('message');
      expect(responseJson.role).toBe('assistant');
      expect(textFromAnthropicContent(responseJson.content).trim().length).toBeGreaterThan(0);
      assertUsagePresent(responseJson);
      expect(responseJson.usage!.output_tokens as number).toBeGreaterThan(0);

      const upstream = findOpenAIChatCompletionsCall(captured);
      expect(
        upstream,
        `no OpenAI /v1/chat/completions call captured; saw: ${captured.map((entry) => entry.url).join(', ')}`,
      ).toBeDefined();

      expect(upstream!.body.model).toBe(NON_REASONING_MODEL);
      expect(upstream!.body.max_completion_tokens).toBe(MAX_TOKENS);
      expect(upstream!.body.stream).toBe(false);
      expect(upstream!.body.temperature).toBe(0.2);
      expect(upstream!.body).not.toHaveProperty('reasoning_effort');
      // Assert the Bearer shape WITHOUT placing the real key in a matcher that
      // Vitest would render on assertion failure (live-tier keys-never-logged invariant).
      const authHeader = upstream!.headers['authorization'];
      expect(authHeader?.startsWith('Bearer ')).toBe(true);
      expect(authHeader?.length ?? 0).toBeGreaterThan('Bearer '.length);
    },
    LIVE_TIMEOUT_MS,
  );
  },
);
