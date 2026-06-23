import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';
import type { ManagedProviderInfo } from '@shared/types/managedProvider';

const logWarnMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());
const getCachedAuthConfigMock = vi.hoisted(() => vi.fn());
const loadManagedOpenRouterKeyMock = vi.hoisted(() => vi.fn<() => string | null>(() => 'fake-managed-key'));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: logWarnMock,
    error: logErrorMock,
  }),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({
    activeProvider: 'mindstone',
    claude: { apiKey: 'fake-ant-key' },
    providerKeys: {},
    customProviders: [],
  }),
}));

vi.mock('../openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => null),
  loadManagedOpenRouterKey: loadManagedOpenRouterKeyMock,
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
      onAuthStateChange: vi.fn(() => () => {}),
      getAccessToken: vi.fn(async () => null),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      refreshLicenseTier: vi.fn(async () => 'free'),
      clearCachedProviderKey: vi.fn(),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      getCachedAuthConfig: getCachedAuthConfigMock,
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

import { proxyManager } from '../localModelProxyServer';

function makeProfile(
  overrides: Partial<ModelProfile> & { id: string; name: string; model: string },
): ModelProfile {
  return {
    providerType: 'openai',
    serverUrl: 'http://localhost:11434',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeAnthropicBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'anthropic/claude-sonnet-4',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
    ...overrides,
  });
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
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Auth': authToken,
          Host: '127.0.0.1',
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

function fakeOpenRouterResponse(model = 'anthropic/claude-sonnet-4'): Partial<Response> {
  const body = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'pong' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const serialized = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => Promise.resolve(serialized),
    json: () => Promise.resolve(body),
  };
}

function makeManagedProviderInfo(
  overrides: Partial<ManagedProviderInfo> = {},
): ManagedProviderInfo {
  return {
    provider: 'openrouter',
    keyHash: 'fake-key-hash',
    allowedModels: [],
    defaultModels: {
      working: 'anthropic/claude-sonnet-4',
      thinking: 'openai/gpt-5',
      bts: 'openai/gpt-4o-mini',
    },
    creditLimitMonthly: 0,
    creditUsedMonthly: 0,
    ...overrides,
  };
}

let nextPort = 49800;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let capturedUrls: string[] = [];

beforeEach(() => {
  logWarnMock.mockReset();
  logErrorMock.mockReset();
  getCachedAuthConfigMock.mockReset();
  loadManagedOpenRouterKeyMock.mockReset();
  loadManagedOpenRouterKeyMock.mockReturnValue('fake-managed-key');
  capturedUrls = [];
  fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    capturedUrls.push(typeof url === 'string' ? url : url.toString());
    return fakeOpenRouterResponse() as unknown as Response;
  });
});

afterEach(async () => {
  fetchSpy.mockRestore();
  await proxyManager.stop();
});

describe('localModelProxyServer managed-mode allowlist enforcement (Stage G2)', () => {
  it('rejects with 403 MANAGED_MODEL_NOT_ALLOWED when managedProvider is undefined', async () => {
    getCachedAuthConfigMock.mockReturnValue({
      managedProvider: undefined,
      hasManagedKey: true,
    });

    const baseProfile = makeProfile({
      id: 'base-managed-noprovider',
      name: 'Base profile',
      model: 'gpt-5.5',
      serverUrl: 'http://localhost:11436',
    });
    await proxyManager.startSingleProfile(baseProfile, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: 'anthropic/claude-sonnet-4' }),
      authToken,
      { 'x-openrouter-turn': 'true' },
    );

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'MANAGED_MODEL_NOT_ALLOWED',
        requested: 'anthropic/claude-sonnet-4',
        allowed: [],
      },
    });
    expect(capturedUrls).toHaveLength(0);
    expect(
      logWarnMock.mock.calls.some(([payload, message]) =>
        typeof message === 'string'
        && message.includes('Managed model not allowed')
        && (payload as { model?: unknown }).model === 'anthropic/claude-sonnet-4'
        && Array.isArray((payload as { allowed?: unknown }).allowed)
        && ((payload as { allowed: unknown[] }).allowed).length === 0
        && (payload as { isManagedMode?: unknown }).isManagedMode === true
      ),
    ).toBe(true);
  });

  it('rejects with 403 MANAGED_MODEL_NOT_ALLOWED when defaultModels is empty', async () => {
    getCachedAuthConfigMock.mockReturnValue({
      managedProvider: makeManagedProviderInfo({ defaultModels: {} }),
      hasManagedKey: true,
    });

    const baseProfile = makeProfile({
      id: 'base-managed-emptydefaults',
      name: 'Base profile',
      model: 'gpt-5.5',
      serverUrl: 'http://localhost:11436',
    });
    await proxyManager.startSingleProfile(baseProfile, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: 'anthropic/claude-sonnet-4' }),
      authToken,
      { 'x-openrouter-turn': 'true' },
    );

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'MANAGED_MODEL_NOT_ALLOWED',
        requested: 'anthropic/claude-sonnet-4',
        allowed: [],
      },
    });
    expect(capturedUrls).toHaveLength(0);
  });

  it('rejects with 403 MANAGED_MODEL_NOT_ALLOWED when requested model is not in defaultModels', async () => {
    const managedInfo = makeManagedProviderInfo();
    getCachedAuthConfigMock.mockReturnValue({
      managedProvider: managedInfo,
      hasManagedKey: true,
    });

    const baseProfile = makeProfile({
      id: 'base-managed-mismatch',
      name: 'Base profile',
      model: 'gpt-5.5',
      serverUrl: 'http://localhost:11436',
    });
    await proxyManager.startSingleProfile(baseProfile, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: 'anthropic/claude-opus-4' }),
      authToken,
      { 'x-openrouter-turn': 'true' },
    );

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'MANAGED_MODEL_NOT_ALLOWED',
        requested: 'anthropic/claude-opus-4',
        allowed: ['anthropic/claude-sonnet-4', 'openai/gpt-5', 'openai/gpt-4o-mini'],
      },
    });
    expect(capturedUrls).toHaveLength(0);
    expect(
      logWarnMock.mock.calls.some(([payload, message]) =>
        typeof message === 'string'
        && message.includes('Managed model not allowed')
        && (payload as { model?: unknown }).model === 'anthropic/claude-opus-4'
        && Array.isArray((payload as { allowed?: unknown }).allowed)
        && (payload as { isManagedMode?: unknown }).isManagedMode === true
      ),
    ).toBe(true);
  });

  it.each([
    ['working', 'anthropic/claude-sonnet-4'],
    ['thinking', 'openai/gpt-5'],
    ['bts', 'openai/gpt-4o-mini'],
  ])('forwards to OpenRouter with 200 when requested model matches %s default', async (_label, modelId) => {
    getCachedAuthConfigMock.mockReturnValue({
      managedProvider: makeManagedProviderInfo(),
      hasManagedKey: true,
    });

    const baseProfile = makeProfile({
      id: `base-managed-match-${modelId.replace(/[^a-z0-9]/gi, '-')}`,
      name: 'Base profile',
      model: 'gpt-5.5',
      serverUrl: 'http://localhost:11436',
    });
    await proxyManager.startSingleProfile(baseProfile, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: modelId }),
      authToken,
      { 'x-openrouter-turn': 'true' },
    );

    expect(response.status).toBe(200);
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain('openrouter.ai/api/v1/messages');
    expect(logWarnMock.mock.calls.some(([, message]) =>
      typeof message === 'string' && message.includes('Managed model not allowed'),
    )).toBe(false);
  });

  it('returns 401 authentication_error with managed-specific message when managed key is missing', async () => {
    loadManagedOpenRouterKeyMock.mockReturnValue(null);
    getCachedAuthConfigMock.mockReturnValue({
      managedProvider: makeManagedProviderInfo(),
      hasManagedKey: false,
    });

    const baseProfile = makeProfile({
      id: 'base-managed-nokey',
      name: 'Base profile',
      model: 'gpt-5.5',
      serverUrl: 'http://localhost:11436',
    });
    await proxyManager.startSingleProfile(baseProfile, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const authToken = proxyManager.getAuthToken()!;

    const response = await sendToProxy(
      proxyUrl,
      makeAnthropicBody({ model: 'anthropic/claude-sonnet-4' }),
      authToken,
      { 'x-openrouter-turn': 'true' },
    );

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Managed subscription key not available — please check your subscription status',
      },
    });
    expect(capturedUrls).toHaveLength(0);
    expect(
      logErrorMock.mock.calls.some(([payload, message]) =>
        typeof message === 'string'
        && message.includes('OpenRouter passthrough failed: no API key available')
        && (payload as { isManagedMode?: unknown }).isManagedMode === true
      ),
    ).toBe(true);
  });
});
