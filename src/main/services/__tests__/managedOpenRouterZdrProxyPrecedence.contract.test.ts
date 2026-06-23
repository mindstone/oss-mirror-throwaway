import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';
import type { ManagedProviderInfo } from '@shared/types/managedProvider';
import { CHINA_ORIGIN_PROVIDER_ALLOWLISTS } from '@shared/openrouterProviderAllowlists';

const settingsMock = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const getCachedAuthConfigMock = vi.hoisted(() => vi.fn());
const loadManagedOpenRouterKeyMock = vi.hoisted(() => vi.fn<() => string | null>(() => 'fake-managed-openrouter-key'));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => settingsMock.current,
}));

vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => null),
}));

vi.mock('../openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => null),
  loadManagedOpenRouterKey: loadManagedOpenRouterKeyMock,
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
    getCachedAuthConfig: getCachedAuthConfigMock,
  }),
}));

import { ProviderRouter } from '@core/rebelCore/providerRouting';
import { materializePlanRuntime } from '@core/rebelCore/providerRoutePlan';
import {
  deriveHeaders,
  OPENROUTER_ATTRIBUTION_REFERER,
  OPENROUTER_ATTRIBUTION_TITLE,
} from '@core/rebelCore/providerRouteHeaders';
import { createClientForModel } from '@core/rebelCore/clientFactory';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { proxyManager, type ModelRouteTable } from '../localModelProxyServer';

const MANAGED_CN_MODEL = 'deepseek/deepseek-chat-v3-0324';

interface CapturedUpstream {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let nextPort = 49990;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let originalFetch: typeof globalThis.fetch;
let captured: CapturedUpstream[] = [];
let localProxyFetches: CapturedUpstream[] = [];

function managedOpenRouterProfile(): ModelProfile {
  return {
    id: 'managed-or-connection',
    name: 'Managed OpenRouter connection',
    providerType: 'openrouter',
    profileSource: 'connection',
    serverUrl: 'https://openrouter.ai/api/v1',
    model: MANAGED_CN_MODEL,
    createdAt: 1,
  } as ModelProfile;
}

function managedProviderInfo(): ManagedProviderInfo {
  return {
    provider: 'openrouter',
    keyHash: 'fake-key-hash',
    allowedModels: [],
    defaultModels: {
      working: MANAGED_CN_MODEL,
    },
    creditLimitMonthly: 0,
    creditUsedMonthly: 0,
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

function makeAnthropicBody(model = MANAGED_CN_MODEL): string {
  return JSON.stringify({
    model,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'ping' }],
    stream: false,
  });
}

function fakeOpenRouterResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_managed_or_contract',
      type: 'message',
      role: 'assistant',
      model: MANAGED_CN_MODEL,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'pong' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function normalizeHeaders(headersInit: RequestInit['headers']): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!headersInit) return headers;
  if (headersInit instanceof Headers) {
    headersInit.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return headers;
  }
  if (Array.isArray(headersInit)) {
    for (const [key, value] of headersInit) {
      headers[key.toLowerCase()] = String(value);
    }
    return headers;
  }
  for (const [key, value] of Object.entries(headersInit)) {
    headers[key.toLowerCase()] = String(value);
  }
  return headers;
}

beforeEach(() => {
  captured = [];
  localProxyFetches = [];
  settingsMock.current = {
    activeProvider: 'mindstone',
    claude: { apiKey: null },
    openRouter: { enabled: true, oauthToken: 'fake-shared-oauth-token', selectedModel: MANAGED_CN_MODEL },
    providerKeys: {},
    customProviders: [],
    localModel: { activeProfileId: null, profiles: [managedOpenRouterProfile()] },
  };
  getCachedAuthConfigMock.mockReset();
  getCachedAuthConfigMock.mockReturnValue({
    managedProvider: managedProviderInfo(),
    hasManagedKey: true,
  });
  loadManagedOpenRouterKeyMock.mockReset();
  loadManagedOpenRouterKeyMock.mockReturnValue('fake-managed-openrouter-key');
  originalFetch = globalThis.fetch;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const urlText = typeof url === 'string' ? url : url.toString();
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const headers = normalizeHeaders(init?.headers);
    const request = {
      url: urlText,
      headers,
      body: JSON.parse(rawBody) as Record<string, unknown>,
    };
    if (urlText.startsWith('http://127.0.0.1:') || urlText.startsWith('http://localhost:')) {
      localProxyFetches.push(request);
      return originalFetch(url, init);
    }
    captured.push(request);
    return fakeOpenRouterResponse();
  });
});

afterEach(async () => {
  fetchSpy.mockRestore();
  await proxyManager.stop();
  nextPort += 10;
});

describe('managed OpenRouter ZDR/proxy precedence contract', () => {
  it('resolves a connection-managed OpenRouter profile to the proxy transport, not direct OpenRouter', async () => {
    const profile = managedOpenRouterProfile();
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settingsMock.current as never,
      model: `profile:${profile.id}`,
      profile,
    });

    expect(decision.kind).toBe('dispatchable');
    expect(decision.transport).toBe('openrouter-proxy');
    expect(decision.dispatchPath).toBe('local-proxy-passthrough');
    expect(decision.credentialSource).toBe('openrouter-oauth-token');

    const plan = await materializePlanRuntime(decision, {
      proxyBaseURL: 'http://127.0.0.1:49999',
      proxyAuthToken: 'fake-proxy-auth-token',
      openRouterOAuthToken: 'fake-shared-oauth-token',
    });
    expect(plan.proxyRequired).toBe(true);
    expect(plan.proxyBaseURL).toBe('http://127.0.0.1:49999');
    expect(plan).not.toHaveProperty('endpoint');
    // Attribution must be the CANONICAL value on every path (user-confirmed
    // 2026-06-06: we own rebel.mindstone.com, NOT mindstone.app). Both the route
    // plan and the proxy passthrough (asserted below) must emit it, via the shared
    // OPENROUTER_ATTRIBUTION_* SSOT — so the two paths can never drift again.
    const planHeaders = Object.fromEntries(plan.headers);
    expect(planHeaders).toMatchObject({
      'http-referer': OPENROUTER_ATTRIBUTION_REFERER,
      'x-title': OPENROUTER_ATTRIBUTION_TITLE,
      'x-openrouter-turn': 'true',
    });

    expect(Object.fromEntries(deriveHeaders(decision, {
      proxyAuthToken: 'fake-proxy-auth-token',
      openRouterApiKey: 'fake-shared-oauth-token',
    }))).toMatchObject({
      'http-referer': OPENROUTER_ATTRIBUTION_REFERER,
      'x-title': OPENROUTER_ATTRIBUTION_TITLE,
    });
  });

  it('forwards managed OpenRouter egress through the local proxy with ZDR, provider routing, and attribution', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody(),
      authToken,
      { 'x-openrouter-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    const upstream = captured[0];
    expect(upstream.url).toBe('https://openrouter.ai/api/v1/messages');
    expect(upstream.headers['x-zdr']).toBe('true');
    // Canonical attribution on egress (proves the request traversed the proxy AND
    // carries the domain we actually own — guards the mindstone.app stale-literal
    // regression the proxy passthrough shipped).
    expect(upstream.headers['http-referer']).toBe(OPENROUTER_ATTRIBUTION_REFERER);
    expect(upstream.headers['x-title']).toBe(OPENROUTER_ATTRIBUTION_TITLE);
    expect(upstream.headers.authorization?.startsWith('Bearer ')).toBe(true);
    expect(upstream.headers.authorization?.length).toBeGreaterThan('Bearer '.length);
    expect(upstream.headers.authorization).not.toContain('fake-shared-oauth-token');
    expect(upstream.body.provider).toEqual({
      only: CHINA_ORIGIN_PROVIDER_ALLOWLISTS.find((entry) => MANAGED_CN_MODEL.startsWith(entry.prefix))?.providers,
    });
  });

  it('createClientForModel reaches managed OpenRouter through the local proxy, never direct OpenRouter egress', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;
    const profile = managedOpenRouterProfile();

    const client = await createClientForModel({
      model: `profile:${profile.id}`,
      profile,
      settings: settingsMock.current as never,
      proxyConfig: {
        baseURL: proxyUrl,
        defaultHeaders: {
          'x-proxy-auth': authToken,
          'x-openrouter-turn': 'true',
        },
      },
      context: 'execution',
    });

    await client.create({
      model: unsafeAssertRoutingModelId(MANAGED_CN_MODEL),
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 32,
    });

    expect(localProxyFetches).toHaveLength(1);
    const localFetch = localProxyFetches[0];
    expect(localFetch.url).toBe(`${proxyUrl}/v1/messages?beta=true`);
    expect(localFetch.headers['x-openrouter-turn']).toBe('true');
    expect(localFetch.headers['x-proxy-auth']).toBe(authToken);
    expect(localFetch.headers.authorization ?? '').not.toContain('fake-shared-oauth-token');
    expect(localFetch.body.model).toBe(MANAGED_CN_MODEL);

    expect(captured).toHaveLength(1);
    const upstream = captured[0];
    expect(upstream.url).toBe('https://openrouter.ai/api/v1/messages');
    expect(upstream.headers['x-zdr']).toBe('true');
    expect(upstream.headers['http-referer']).toBe(OPENROUTER_ATTRIBUTION_REFERER);
    expect(upstream.headers['x-title']).toBe(OPENROUTER_ATTRIBUTION_TITLE);
    expect(upstream.headers.authorization?.startsWith('Bearer ')).toBe(true);
    expect(upstream.headers.authorization).not.toContain('fake-shared-oauth-token');
    expect(upstream.body.provider).toEqual({
      only: CHINA_ORIGIN_PROVIDER_ALLOWLISTS.find((entry) => MANAGED_CN_MODEL.startsWith(entry.prefix))?.providers,
    });
    expect(captured.some((request) => (
      request.url.startsWith('https://openrouter.ai/')
      && request.headers['x-zdr'] !== 'true'
      && request.headers.authorization?.includes('fake-shared-oauth-token')
    ))).toBe(false);
  });
});
