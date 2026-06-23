import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DIRECT_ANTHROPIC_API_KEY = 'fake-test-anthropic-direct-key';
const OPENROUTER_API_KEY = 'fake-test-openrouter-key';
const OPENAI_PROFILE_API_KEY = 'fake-test-openai-profile-key';
const PROXY_PORT_BASE = 50580;

// Synthetic upstream host the verified-fake spy intercepts. Distinct from the
// proxy's own 127.0.0.1 listener so the spy can tell "proxy egress to a real
// backend" apart from "the client talking to the local proxy" (which must reach
// the real in-process server). Must NOT be a loopback host (the route plan would
// classify it as `local-openai-compatible-http`).
const FAKE_CLOUD_OPENAI_BASE_URL = 'https://fake-openai-upstream.test/v1';
// Loopback upstream for the local-openai-compatible-http transport. `localhost`
// (not 127.0.0.1) so the spy can intercept it as a fake local server WITHOUT
// colliding with the real proxy listener on 127.0.0.1 — closing the Codex review
// caveat that a local fixture would otherwise flakily hit a real local server.
const FAKE_LOCAL_OPENAI_BASE_URL = 'http://localhost:65500/v1';

const mockSettings = {
  coreDirectory: null,
  mcpConfigFile: null,
  onboardingCompleted: true,
  userEmail: null,
  onboardingFirstCompletedAt: null,
  voice: { enabled: false },
  diagnostics: { debugBreadcrumbsUntil: null },
  activeProvider: 'anthropic',
  models: {
    apiKey: DIRECT_ANTHROPIC_API_KEY,
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'plan',
    executablePath: null,
    planMode: true,
    extendedContext: false,
    thinkingEffort: 'high',
  },
  openRouter: {
    enabled: false,
    oauthToken: null,
    selectedModel: 'anthropic/claude-sonnet-4-20250514',
  },
  localModel: { activeProfileId: null, profiles: [] },
  providerKeys: {},
  customProviders: [],
  experimental: { compactEnabled: false },
};

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockSettings,
}));

vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => ({ apiKey: OPENROUTER_API_KEY, refreshToken: null })),
}));

vi.mock('@core/codexAuth', () => ({
  CODEX_ENDPOINT_URL: 'https://chatgpt.com/backend-api/codex',
  getCodexAuthProvider: vi.fn(() => ({
    isConnected: vi.fn(() => false),
    getAccessToken: vi.fn(async () => 'fake-test-codex-token'),
    getAccountId: vi.fn(() => 'fake-test-account'),
    forceRefreshToken: vi.fn(async () => 'fake-test-codex-token-refreshed'),
    getStatus: vi.fn(() => ({ connected: false })),
  })),
}));

import type { AppSettings, ModelProfile } from '@shared/types';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { createClientFromRoutePlan } from '@core/rebelCore/clientFactory';
import { resolveProviderRoutePlan, type ProviderRoutePlanRequest } from '@core/rebelCore/providerRouting';
import { isTerminalRoutePlan, type DispatchableRoutePlan } from '@core/rebelCore/providerRoutePlanTypes';
import { proxyManager, type ModelRouteTable } from '../localModelProxyServer';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  Object.assign(mockSettings, {
    activeProvider: overrides.activeProvider ?? 'anthropic',
    openRouter: {
      enabled: overrides.activeProvider === 'openrouter',
      oauthToken: overrides.activeProvider === 'openrouter' ? OPENROUTER_API_KEY : null,
      selectedModel: 'anthropic/claude-sonnet-4-20250514',
    },
  });
  return {
    ...mockSettings,
    ...overrides,
    models: {
      ...mockSettings.models,
      ...(overrides.models ?? {}),
    },
    openRouter: {
      ...mockSettings.openRouter,
      ...(overrides.openRouter ?? {}),
    },
  } as unknown as AppSettings;
}

async function dispatchablePlan(
  request: ProviderRoutePlanRequest,
  runtimeContext: Parameters<typeof resolveProviderRoutePlan>[1] = {},
): Promise<DispatchableRoutePlan> {
  const plan = await resolveProviderRoutePlan(request, runtimeContext);
  if (isTerminalRoutePlan(plan)) {
    throw new Error(`Expected dispatchable plan, got ${plan.decision.invalidReason}`);
  }
  return plan;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key.toLowerCase(), String(value)]));
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): string {
  if (init?.method) return init.method;
  if (input instanceof Request) return input.method;
  return 'GET';
}

function requestHeaders(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): Record<string, string> {
  return {
    ...(input instanceof Request ? normalizeHeaders(input.headers) : {}),
    ...normalizeHeaders(init?.headers),
  };
}

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

function fakeAnthropicMessage(model: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_wire_contract_capture',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function fakeChatCompletion(model: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl_wire_contract_capture',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [
        { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function expectPath(url: string, path: string): void {
  expect(new URL(url).pathname).toBe(path);
}

function profile(overrides: Partial<ModelProfile> & { id: string; name: string; model: string }): ModelProfile {
  return {
    providerType: 'openai',
    serverUrl: FAKE_CLOUD_OPENAI_BASE_URL,
    createdAt: 0,
    enabled: true,
    ...overrides,
  };
}

function settingsWithProfiles(profiles: ModelProfile[], activeProfileId: string): AppSettings {
  return {
    ...settings({ activeProvider: 'anthropic' }),
    localModel: { activeProfileId, profiles },
  } as unknown as AppSettings;
}

// Pins Rebel's Anthropic context-management (context-editing) wire contract.
// Provider-contract literals (hand-typed from Anthropic docs, NOT Rebel constants):
//   - beta header token `context-management-2025-06-27`
//   - body key `context_management.edits[].type` === `clear_tool_uses_20250919`
//   - the option key shapes (`trigger`/`keep`/`clear_at_least`/`clear_tool_inputs`/`exclude_tools`)
//   docs: https://platform.claude.com/docs/en/build-with-claude/context-editing
// Rebel-policy literals (what our code emits for a 200k-window model, compact OFF):
//   - trigger 100000 (= round(window*0.5)), clear_at_least 20000 (= round(window*0.1)),
//     keep 10 tool_uses, clear_tool_inputs true, and the exclude_tools allow-list.
// With compact disabled the beta header is exactly the single context-management
// token (no `compact-2026-01-12`).
function expectAnthropicContextManagement(request: CapturedRequest): void {
  expect(request.headers['anthropic-beta']).toBe('context-management-2025-06-27');
  expect(request.body.context_management).toEqual({
    edits: [
      {
        type: 'clear_tool_uses_20250919',
        trigger: { type: 'input_tokens', value: 100000 },
        keep: { type: 'tool_uses', value: 10 },
        clear_at_least: { type: 'input_tokens', value: 20000 },
        clear_tool_inputs: true,
        exclude_tools: ['Read', 'rebel_search_files', 'WebSearch', 'WebFetch', 'SearchFiles', 'Glob', 'LS'],
      },
    ],
  });
}

function expectAnthropicMessagesBody(body: Record<string, unknown>, model: string): void {
  expect(body.model).toBe(model);
  expect(body.max_tokens).toBe(32);
  expect(body.system).toBe('System contract prompt');
  // This 200-only mock covers the initial top-level cache_control wire shape.
  // It does not exercise the OpenRouter 404 retry path that strips cache_control.
  expect(body.cache_control).toEqual({ type: 'ephemeral' });
  expect(body.messages).toEqual([{ role: 'user', content: 'Ping' }]);
  expect(body).not.toHaveProperty('response_format');
  expect(body).not.toHaveProperty('messages.0.role', 'system');
}

describe('provider wire-contract capture probe', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
  let originalFetch: typeof globalThis.fetch;
  let captured: CapturedRequest[];
  let nextPort = PROXY_PORT_BASE;

  beforeEach(() => {
    captured = [];
    // Neutralize the production context-management kill switch so the probe
    // exercises Rebel's real DEFAULT (context-management-on) path regardless of
    // the developer's environment. Not self-referential — it only restores the
    // default production config; '' is `!== '1'`, i.e. enabled.
    vi.stubEnv('REBEL_DISABLE_CONTEXT_MANAGEMENT', '');
    originalFetch = globalThis.fetch;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      const parsedUrl = new URL(url);
      if (parsedUrl.hostname === '127.0.0.1') {
        return originalFetch(input, init);
      }

      if (
        (parsedUrl.hostname === 'api.anthropic.com' && parsedUrl.pathname === '/v1/messages')
        || (parsedUrl.hostname === 'openrouter.ai' && parsedUrl.pathname === '/api/v1/messages')
      ) {
        captured.push({
          url,
          method: requestMethod(input, init),
          headers: requestHeaders(input, init),
          body: parseRequestBody(init),
        });
        return fakeAnthropicMessage('claude-sonnet-4-20250514');
      }

      // OpenAI-compatible Chat Completions upstream — covers (a) the direct
      // openai-compatible-http / local-openai-compatible-http transports and (b)
      // the bytes the route-table proxy (anthropic-compatible-local-proxy) emits
      // to its routed OpenAI-dialect backend. We capture the real egress bytes
      // (URL, auth, body `model`) leaving the process to assert each transport's
      // OWN wire contract.
      if (parsedUrl.pathname.endsWith('/chat/completions')) {
        const body = parseRequestBody(init);
        captured.push({
          url,
          method: requestMethod(input, init),
          headers: requestHeaders(input, init),
          body,
        });
        return fakeChatCompletion(typeof body.model === 'string' ? body.model : 'unknown');
      }

      throw new Error(`Unexpected non-local fetch in provider wire-contract probe: ${url}`);
    });
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    vi.unstubAllEnvs();
    await proxyManager.stop();
  });

  it('captures Anthropic-direct Messages API dialect and auth headers', async () => {
    const appSettings = settings({ activeProvider: 'anthropic' });
    const plan = await dispatchablePlan(
      {
        kind: 'forSubagent',
        input: {
          settings: appSettings,
          model: 'claude-sonnet-4-20250514',
          codexConnectivity: 'unknown',
        },
      },
      { anthropicApiKey: DIRECT_ANTHROPIC_API_KEY },
    );

    expect(plan.decision.transport).toBe('anthropic-direct');
    expect(plan.decision.modelDialect).toBe('anthropic-native');
    expect(plan.decision.dispatchPath).toBe('direct-provider');

    const client = createClientFromRoutePlan(plan, appSettings);
    await client.create({
      model: unsafeAssertRoutingModelId(plan.decision.wireModelId),
      systemPrompt: 'System contract prompt',
      messages: [{ role: 'user', content: 'Ping' }],
      maxTokens: 32,
    });

    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(request.method).toBe('POST');
    expectPath(request.url, '/v1/messages');
    expect(request.headers['x-api-key']).toBe(DIRECT_ANTHROPIC_API_KEY);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(request.headers['http-referer']).toBeUndefined();
    expect(request.headers['x-title']).toBeUndefined();
    expect(request.headers['x-openrouter-turn']).toBeUndefined();
    expect(request.headers['content-type']).toContain('application/json');
    expectAnthropicMessagesBody(request.body, 'claude-sonnet-4-20250514');
    expectAnthropicContextManagement(request);
  });

  it('captures OpenRouter proxy upstream dialect, attribution, and Bearer auth', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl();
    const proxyAuthToken = proxyManager.getAuthToken();
    if (!proxyUrl || !proxyAuthToken) {
      throw new Error('Expected local proxy to start');
    }

    const appSettings = settings({
      activeProvider: 'openrouter',
      openRouter: {
        enabled: true,
        oauthToken: OPENROUTER_API_KEY,
        selectedModel: 'anthropic/claude-sonnet-4-20250514',
      },
    });
    const plan = await dispatchablePlan(
      {
        kind: 'forSubagent',
        input: {
          settings: appSettings,
          model: 'anthropic/claude-sonnet-4-20250514',
          codexConnectivity: 'unknown',
        },
      },
      {
        proxyBaseURL: proxyUrl,
        proxyAuthToken,
        openRouterOAuthToken: OPENROUTER_API_KEY,
      },
    );

    expect(plan.decision.transport).toBe('openrouter-proxy');
    expect(plan.decision.modelDialect).toBe('openrouter-prefixed');
    expect(plan.decision.dispatchPath).toBe('local-proxy-passthrough');

    const client = createClientFromRoutePlan(plan, appSettings);
    await client.create({
      model: unsafeAssertRoutingModelId(plan.decision.wireModelId),
      systemPrompt: 'System contract prompt',
      messages: [{ role: 'user', content: 'Ping' }],
      maxTokens: 32,
    });

    const upstream = captured.find((request) => request.url === 'https://openrouter.ai/api/v1/messages');
    expect(
      upstream,
      `no OpenRouter provider egress captured; saw: ${captured.map((request) => request.url).join(', ')}`,
    ).toBeDefined();
    expect(upstream!.method).toBe('POST');
    expectPath(upstream!.url, '/api/v1/messages');
    expect(upstream!.headers.authorization).toBe(`Bearer ${OPENROUTER_API_KEY}`);
    expect(upstream!.headers['x-api-key']).toBeUndefined();
    expect(upstream!.headers['anthropic-version']).toBe('2023-06-01');
    expect(upstream!.headers['http-referer']).toBe('https://rebel.mindstone.com');
    expect(upstream!.headers['x-title']).toBe('Rebel');
    expect(upstream!.headers['x-zdr']).toBe('true');
    expect(upstream!.headers['x-proxy-auth']).toBeUndefined();
    expect(upstream!.headers['x-openrouter-turn']).toBeUndefined();
    expectAnthropicMessagesBody(upstream!.body, 'anthropic/claude-sonnet-4-20250514');
  });

  // ── Route-table proxy (anthropic-compatible-local-proxy) ──────────────────
  // The REBEL-5N8 contract, asserted at the BYTE layer (distinct from the
  // route-DECISION assertions in subAgentProxyRouting.test.ts /
  // localModelProxyServer.routing.test.ts): a sub-agent under a route-table
  // scope streams the route-table-safe ALIAS (`working`) as the body model into
  // the proxy, while the CONCRETE foreign backend (`openai/gpt-5.5`) rides the
  // `x-routed-model` header. The proxy MUST rewrite the upstream body `model` to
  // the concrete routed model — the alias must NEVER leak upstream. This drives
  // the full plan → createClientFromRoutePlan → AnthropicClient → real in-process
  // proxy → routed OpenAI-dialect upstream path and captures the real egress
  // bytes. Mutating the proxy choke point (`localModelProxyServer.ts`
  // `modelName = profile.model || anthropicRequest.model` → just
  // `anthropicRequest.model`) makes the alias leak and turns the body-model
  // assertion RED (verified red-spike).
  it('captures route-table proxy egress: alias is rewritten to the concrete routed model upstream (REBEL-5N8)', async () => {
    const turnId = 'wire-contract-route-table-turn';
    const routedProfile = profile({
      id: 'profile-or-gpt55',
      name: 'OpenRouter GPT 5.5',
      model: 'openai/gpt-5.5',
      providerType: 'openai',
      serverUrl: FAKE_CLOUD_OPENAI_BASE_URL,
      apiKey: OPENAI_PROFILE_API_KEY,
    });
    const routeTable: ModelRouteTable = { routes: new Map([['openai/gpt-5.5', routedProfile]]) };
    await proxyManager.addRoutes(turnId, routeTable, undefined, nextPort++);
    const proxyUrl = proxyManager.getUrl();
    const proxyAuthToken = proxyManager.getAuthToken();
    if (!proxyUrl || !proxyAuthToken) {
      throw new Error('Expected local proxy to start');
    }

    const appSettings = settings({ activeProvider: 'anthropic' });
    const plan = await dispatchablePlan(
      {
        kind: 'forSubagent',
        input: {
          settings: appSettings,
          model: 'working',
          routeScope: 'council',
          routedModel: 'openai/gpt-5.5',
          codexConnectivity: 'unknown',
        },
      },
      {
        proxyBaseURL: proxyUrl,
        proxyAuthToken,
        turnId,
        routedModel: 'openai/gpt-5.5',
        anthropicApiKey: DIRECT_ANTHROPIC_API_KEY,
      },
    );

    // Route-table contract on the DECISION/header side (the alias body model +
    // concrete x-routed-model + route-table dispatch path).
    expect(plan.decision.transport).toBe('anthropic-compatible-local-proxy');
    expect(plan.decision.dispatchPath).toBe('local-proxy-route-table');
    expect(plan.decision.wireModelId).toBe('working');
    const planHeaders = Object.fromEntries(plan.headers);
    expect(planHeaders['x-routed-model']).toBe('openai/gpt-5.5');
    expect(planHeaders['x-routed-turn-id']).toBe(turnId);
    expect(planHeaders['x-proxy-auth']).toBe(proxyAuthToken);

    const client = createClientFromRoutePlan(plan, appSettings);
    await client.create({
      // The sub-agent streams the route-table-safe alias as the body model.
      model: unsafeAssertRoutingModelId(plan.decision.wireModelId),
      systemPrompt: 'System contract prompt',
      messages: [{ role: 'user', content: 'Ping' }],
      maxTokens: 32,
    });

    // The DISTINCT byte-layer assertion: the bytes the proxy emits UPSTREAM carry
    // the concrete routed model, not the alias.
    const upstream = captured.find((request) => request.url.endsWith('/chat/completions'));
    expect(
      upstream,
      `no route-table proxy egress captured; saw: ${captured.map((request) => request.url).join(', ')}`,
    ).toBeDefined();
    expect(upstream!.method).toBe('POST');
    expectPath(upstream!.url, '/v1/chat/completions');
    expect(new URL(upstream!.url).hostname).toBe('fake-openai-upstream.test');
    // Load-bearing REBEL-5N8 invariant: concrete routed model upstream, NOT 'working'.
    expect(upstream!.body.model).toBe('openai/gpt-5.5');
    expect(upstream!.body.model).not.toBe('working');
    // Routed OpenAI-dialect backend authenticates with the profile's Bearer key.
    expect(upstream!.headers.authorization).toBe(`Bearer ${OPENAI_PROFILE_API_KEY}`);
    expect(upstream!.headers['x-api-key']).toBeUndefined();
    // Route-table identity headers are proxy-internal; they must NOT ride the
    // upstream egress to the foreign backend.
    expect(upstream!.headers['x-routed-model']).toBeUndefined();
    expect(upstream!.headers['x-routed-turn-id']).toBeUndefined();
    expect(upstream!.headers['x-proxy-auth']).toBeUndefined();
  });

  // ── Direct cloud OpenAI-compatible HTTP (openai-compatible-http) ──────────
  // A BYOK cloud profile dispatches DIRECTLY (no proxy) to the profile's
  // Chat Completions endpoint. Contract: body carries the CONCRETE profile model
  // (no alias indirection), `Authorization: Bearer <profile-key>`, and there is
  // NO `x-routed-model` header (that header is route-table-proxy-only). The
  // OpenAI dialect maps the system prompt to a `developer` role.
  it('captures direct openai-compatible-http egress: concrete model, Bearer auth, no x-routed-model', async () => {
    const openAIProfile = profile({
      id: 'profile-openai-cloud',
      name: 'OpenAI Cloud',
      model: 'gpt-5.5',
      providerType: 'openai',
      serverUrl: FAKE_CLOUD_OPENAI_BASE_URL,
      apiKey: OPENAI_PROFILE_API_KEY,
    });
    const appSettings = settingsWithProfiles([openAIProfile], openAIProfile.id);
    const plan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: `profile:${openAIProfile.id}`,
        profile: openAIProfile,
        codexConnectivity: 'unknown',
      },
    });

    expect(plan.decision.transport).toBe('openai-compatible-http');
    expect(plan.decision.dispatchPath).toBe('direct-provider');
    expect(plan.decision.wireModelId).toBe('gpt-5.5');

    const client = createClientFromRoutePlan(plan, appSettings, { routeProfile: openAIProfile });
    await client.create({
      model: unsafeAssertRoutingModelId(plan.decision.wireModelId),
      systemPrompt: 'System contract prompt',
      messages: [{ role: 'user', content: 'Ping' }],
      maxTokens: 32,
    });

    const upstream = captured.find((request) => request.url.endsWith('/chat/completions'));
    expect(
      upstream,
      `no openai-compatible egress captured; saw: ${captured.map((request) => request.url).join(', ')}`,
    ).toBeDefined();
    expect(upstream!.method).toBe('POST');
    expectPath(upstream!.url, '/v1/chat/completions');
    expect(new URL(upstream!.url).hostname).toBe('fake-openai-upstream.test');
    // Concrete model, NOT an alias.
    expect(upstream!.body.model).toBe('gpt-5.5');
    expect(upstream!.headers.authorization).toBe(`Bearer ${OPENAI_PROFILE_API_KEY}`);
    expect(upstream!.headers['x-api-key']).toBeUndefined();
    // The route-table-proxy-only reconciliation header MUST be absent here.
    expect(upstream!.headers['x-routed-model']).toBeUndefined();
    expect(upstream!.headers['x-proxy-auth']).toBeUndefined();
    // OpenAI cloud dialect lifts the system prompt to a `developer` role message.
    expect(Array.isArray(upstream!.body.messages)).toBe(true);
    expect((upstream!.body.messages as Array<{ role: string }>)[0].role).toBe('developer');
  });

  // ── Local OpenAI-compatible HTTP (local-openai-compatible-http) ──────────
  // A localhost profile dispatches DIRECTLY to the loopback server's Chat
  // Completions endpoint. Contract: body carries the concrete model, NO auth
  // header (local servers are keyless: credentialSource `local-none`), NO
  // `x-routed-model`. Local dialect keeps the system prompt as a `system` role.
  // The verified-fake spy intercepts the `localhost` host explicitly (distinct
  // from the proxy's 127.0.0.1 listener) so this never flakily reaches a real
  // local server (Codex review caveat).
  it('captures local-openai-compatible-http egress: concrete model, no auth header, system role', async () => {
    const localProfile = profile({
      id: 'profile-local-llama',
      name: 'Local Llama',
      model: 'llama-3',
      providerType: 'local',
      serverUrl: FAKE_LOCAL_OPENAI_BASE_URL,
    });
    const appSettings = settingsWithProfiles([localProfile], localProfile.id);
    const plan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: `profile:${localProfile.id}`,
        profile: localProfile,
        codexConnectivity: 'unknown',
      },
    });

    expect(plan.decision.transport).toBe('local-openai-compatible-http');
    expect(plan.decision.dispatchPath).toBe('direct-provider');
    expect(plan.decision.wireModelId).toBe('llama-3');

    const client = createClientFromRoutePlan(plan, appSettings, { routeProfile: localProfile });
    await client.create({
      model: unsafeAssertRoutingModelId(plan.decision.wireModelId),
      systemPrompt: 'System contract prompt',
      messages: [{ role: 'user', content: 'Ping' }],
      maxTokens: 32,
    });

    const upstream = captured.find((request) => request.url.endsWith('/chat/completions'));
    expect(
      upstream,
      `no local-openai egress captured; saw: ${captured.map((request) => request.url).join(', ')}`,
    ).toBeDefined();
    expect(upstream!.method).toBe('POST');
    expectPath(upstream!.url, '/v1/chat/completions');
    expect(new URL(upstream!.url).hostname).toBe('localhost');
    expect(upstream!.body.model).toBe('llama-3');
    // Local servers are keyless — no auth must be sent.
    expect(upstream!.headers.authorization).toBeUndefined();
    expect(upstream!.headers['x-api-key']).toBeUndefined();
    expect(upstream!.headers['x-routed-model']).toBeUndefined();
    // Local OpenAI-compatible dialect keeps the system prompt as a `system` role.
    expect(Array.isArray(upstream!.body.messages)).toBe(true);
    expect((upstream!.body.messages as Array<{ role: string }>)[0].role).toBe('system');
  });
});
