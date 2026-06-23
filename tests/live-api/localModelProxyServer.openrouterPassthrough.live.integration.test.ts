/**
 * Gated live OpenRouter passthrough proxy integration test.
 *
 * Drives a real request through the local loopback proxy (`proxyManager`) to
 * OpenRouter's Anthropic-compatible Messages endpoint, while capturing the
 * outbound fetch body/headers and allowing the request to continue upstream.
 *
 * Gating contract:
 *  - Gated SOLELY on `TEST_OPENROUTER_API_KEY` (loaded from `.env.test` by
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

// modelCatalog OpenRouter id for DeepSeek V4 Flash (~$1e-5/call).
const MODEL = unsafeAssertRoutingModelId('deepseek/deepseek-v4-flash');

const LIVE_TIMEOUT_MS = 60_000;
const LATENCY_WARN_MS = 20_000;
const MAX_TOKENS = 256;
let liveOpenRouterKey = '';

/**
 * Minimal AppSettings built from a pure object literal. `models: { apiKey }`
 * is a WRITE, so the provider-gate AST check does not flag it. OpenRouter
 * passthrough auth is resolved from `openRouter.oauthToken`.
 */
function makeSettings(): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    activeProvider: 'openrouter',
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
    openRouter: { oauthToken: liveOpenRouterKey },
    localModel: { profiles: [], activeProfileId: null },
  } as unknown as AppSettings;
}

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => makeSettings(),
}));

vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => null),
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

function makeOpenRouterProfile(apiKey: string): ModelProfile {
  return {
    id: 'openrouter-deepseek-proxy-live',
    name: 'OpenRouter DeepSeek proxy live',
    providerType: 'openrouter',
    serverUrl: 'https://openrouter.ai/api/v1',
    apiKey,
    model: MODEL,
    enabled: true,
    createdAt: 0,
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

let nextPort = 49940;

describeLiveApi(
  {
    provider: 'openrouter',
    label: 'localModelProxyServer OpenRouter passthrough — live integration',
    envVar: 'TEST_OPENROUTER_API_KEY',
    model: MODEL,
  },
  ({ key }) => {
  liveOpenRouterKey = key;
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
    'round-trips through the proxy to OpenRouter /v1/messages and strips non-Anthropic-only context params',
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

      const routeTable: ModelRouteTable = { routes: new Map([[MODEL, makeOpenRouterProfile(key)]]) };
      const turnId = 'turn-openrouter-passthrough-live';
      await proxyManager.addRoutes(turnId, routeTable, undefined, nextPort++, false, false);
      const proxyUrl = proxyManager.getUrl()!;
      const token = proxyManager.getAuthToken()!;

      const inboundBody = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: false,
        system: 'You are terse. Reply with one short word.',
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        thinking: { type: 'enabled', budget_tokens: 64 },
        context_management: {
          edits: [{ type: 'clear_tool_uses_20250919' }],
        },
      };

      const startedAt = Date.now();
      const response = await sendToProxy(proxyUrl, JSON.stringify(inboundBody), token, {
        'x-openrouter-turn': 'true',
        'x-routed-turn-id': turnId,
        'x-routed-model': MODEL,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'context-management-2025-06-27,compact-2026-01-12,structured-outputs-2025-11-13',
      });
      const latencyMs = Date.now() - startedAt;

      const latencyLabel = latencyMs > LATENCY_WARN_MS ? 'past generous budget' : 'within generous budget';
      console.warn(`[live] OpenRouter proxy passthrough call took ${latencyMs}ms (${latencyLabel})`);

      expect(response.status).toBe(200);
      expect(response.contentType).toContain('application/json');

      const responseJson = JSON.parse(response.body) as {
        type?: unknown;
        role?: unknown;
        content?: unknown;
        stop_reason?: unknown;
        usage?: { input_tokens?: unknown; output_tokens?: unknown };
      };
      expect(responseJson.type).toBe('message');
      expect(responseJson.role).toBe('assistant');
      expect(textFromAnthropicContent(responseJson.content).trim().length).toBeGreaterThan(0);
      expect(typeof responseJson.stop_reason).toBe('string');
      expect(typeof responseJson.usage?.input_tokens).toBe('number');
      expect(typeof responseJson.usage?.output_tokens).toBe('number');
      expect(responseJson.usage!.input_tokens as number).toBeGreaterThan(0);
      expect(responseJson.usage!.output_tokens as number).toBeGreaterThan(0);

      const upstream = captured.find(
        (entry) => entry.url === 'https://openrouter.ai/api/v1/messages',
      );
      expect(
        upstream,
        `no OpenRouter /v1/messages call captured; saw: ${captured.map((entry) => entry.url).join(', ')}`,
      ).toBeDefined();

      expect(upstream!.body.model).toBe(MODEL);
      expect(upstream!.body.max_tokens).toBe(MAX_TOKENS);
      expect(upstream!.body.stream).toBe(false);

      expect(upstream!.body).not.toHaveProperty('context_management');
      expect(upstream!.body).not.toHaveProperty('thinking');
      expect(upstream!.body).toHaveProperty('reasoning');
      expect(upstream!.body.reasoning).toEqual({ max_tokens: 64 });

      expect(upstream!.headers['anthropic-beta']).toBe('structured-outputs-2025-11-13');
      // Assert the Bearer shape WITHOUT placing the real key in a matcher that
      // Vitest would render on assertion failure (live-tier keys-never-logged invariant).
      const authHeader = upstream!.headers['authorization'];
      expect(authHeader?.startsWith('Bearer ')).toBe(true);
      expect(authHeader?.length ?? 0).toBeGreaterThan('Bearer '.length);
      expect(upstream!.headers['x-zdr']).toBe('true');
    },
    LIVE_TIMEOUT_MS,
  );
  },
);
