import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
/**
 * Query Router Tests
 *
 * Validates that the router correctly extracts proxy configuration
 * from env vars for alt-model / council / tier routing, AND that
 * queryWithRuntime routes turns through Rebel Core.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock factories for queryWithRuntime routing tests
// ---------------------------------------------------------------------------
const {
  rebelCoreQueryMock,
  getSettingsMock,
  mockLogger,
} = vi.hoisted(() => ({
  rebelCoreQueryMock: vi.fn(),
  getSettingsMock: vi.fn(),
  mockLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Module mocks — hoisted above all imports automatically
// ---------------------------------------------------------------------------
vi.mock('../rebelCoreQuery', () => ({
  rebelCoreQuery: rebelCoreQueryMock,
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: getSettingsMock,
}));

// ---------------------------------------------------------------------------
// Import under test (after all vi.mock calls)
// ---------------------------------------------------------------------------
import { extractProxyConfig, queryWithRuntime } from '../queryRouter';
import type { TurnParams } from '../turnParams';

describe('Query Router: extractProxyConfig', () => {
  it('returns null when env is undefined', () => {
    expect(extractProxyConfig(undefined)).toBeNull();
  });

  it('returns null when ANTHROPIC_BASE_URL is not set', () => {
    expect(extractProxyConfig({ PATH: '/usr/bin' })).toBeNull();
  });

  it('extracts baseURL from ANTHROPIC_BASE_URL', () => {
    const result = extractProxyConfig({
      ANTHROPIC_BASE_URL: 'http://localhost:18765',
    });
    expect(result).toEqual({ baseURL: 'http://localhost:18765' });
  });

  it('extracts single custom header', () => {
    const result = extractProxyConfig({
      ANTHROPIC_BASE_URL: 'http://localhost:18765',
      ANTHROPIC_CUSTOM_HEADERS: 'x-proxy-auth: secret-token',
    });
    expect(result).toEqual({
      baseURL: 'http://localhost:18765',
      defaultHeaders: { 'x-proxy-auth': 'secret-token' },
    });
  });

  it('extracts multiple custom headers (newline-separated)', () => {
    const result = extractProxyConfig({
      ANTHROPIC_BASE_URL: 'http://localhost:18765/council',
      ANTHROPIC_CUSTOM_HEADERS: 'x-proxy-auth: secret-token\nx-routed-turn-id: turn-abc-123',
    });
    expect(result).toEqual({
      baseURL: 'http://localhost:18765/council',
      defaultHeaders: {
        'x-proxy-auth': 'secret-token',
        'x-routed-turn-id': 'turn-abc-123',
      },
    });
  });

  it('handles CRLF line endings', () => {
    const result = extractProxyConfig({
      ANTHROPIC_BASE_URL: 'http://localhost:18765',
      ANTHROPIC_CUSTOM_HEADERS: 'x-proxy-auth: tok\r\nx-routed-turn-id: t-1',
    });
    expect(result?.defaultHeaders).toEqual({
      'x-proxy-auth': 'tok',
      'x-routed-turn-id': 't-1',
    });
  });

  it('handles header values with colons (e.g. URLs)', () => {
    const result = extractProxyConfig({
      ANTHROPIC_BASE_URL: 'http://localhost:18765',
      ANTHROPIC_CUSTOM_HEADERS: 'x-forward-to: http://remote:8080/api',
    });
    expect(result?.defaultHeaders).toEqual({
      'x-forward-to': 'http://remote:8080/api',
    });
  });

  it('skips empty ANTHROPIC_CUSTOM_HEADERS', () => {
    const result = extractProxyConfig({
      ANTHROPIC_BASE_URL: 'http://localhost:18765',
      ANTHROPIC_CUSTOM_HEADERS: '',
    });
    expect(result).toEqual({ baseURL: 'http://localhost:18765' });
  });

  it('handles real alt-model profile pattern', () => {
    const result = extractProxyConfig({
      ANTHROPIC_BASE_URL: 'http://localhost:18765',
      ANTHROPIC_CUSTOM_HEADERS: 'x-proxy-auth: abc123def',
    });
    expect(result?.baseURL).toBe('http://localhost:18765');
    expect(result?.defaultHeaders?.['x-proxy-auth']).toBe('abc123def');
  });

  it('handles real tier routing pattern', () => {
    const result = extractProxyConfig({
      ANTHROPIC_BASE_URL: 'http://localhost:18765',
      ANTHROPIC_CUSTOM_HEADERS: 'x-proxy-auth: tok\nx-routed-turn-id: turn-uuid-here',
    });
    expect(result?.baseURL).toBe('http://localhost:18765');
    expect(result?.defaultHeaders?.['x-proxy-auth']).toBe('tok');
    expect(result?.defaultHeaders?.['x-routed-turn-id']).toBe('turn-uuid-here');
  });
});

// ---------------------------------------------------------------------------
// queryWithRuntime routing tests
// ---------------------------------------------------------------------------

describe('queryWithRuntime routing', () => {
  /** Minimal valid TurnParams for routing tests. */
  const minimalParams: TurnParams = {
    prompt: 'test prompt',
    model: unsafeAssertRoutingModelId('claude-sonnet-4-5'),
    cwd: '/tmp',
    systemPrompt: 'test system',
    permissionMode: 'bypassPermissions',
  };

  /** Create a mock async generator that yields a single message with a marker. */
  async function* createMockGenerator(marker: string): AsyncGenerator<{ type: string; marker: string }, void, undefined> {
    yield { type: 'assistant', marker };
  }

  /** Collect all messages from an async generator into an array. */
  async function collectMessages(gen: AsyncGenerator<unknown, void, undefined>): Promise<unknown[]> {
    const messages: unknown[] = [];
    for await (const msg of gen) {
      messages.push(msg);
    }
    return messages;
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // Default settings are irrelevant for routing (always Rebel Core)
    getSettingsMock.mockReturnValue({});
    rebelCoreQueryMock.mockImplementation(() => createMockGenerator('rebel-core'));
  });

  // -------------------------------------------------------------------------
  // Test 1: always routes to Rebel Core
  // -------------------------------------------------------------------------
  it('routes to Rebel Core', async () => {
    const messages = await collectMessages(queryWithRuntime(minimalParams));

    expect(rebelCoreQueryMock).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({ marker: 'rebel-core' }));
  });

  // -------------------------------------------------------------------------
  // Test 2: settings no longer gate routing
  // -------------------------------------------------------------------------
  it('routes to Rebel Core regardless of settings', async () => {
    getSettingsMock.mockReturnValue({ experimental: {} });
    await collectMessages(queryWithRuntime(minimalParams));

    getSettingsMock.mockReturnValue({ experimental: {} });
    await collectMessages(queryWithRuntime(minimalParams));

    getSettingsMock.mockReturnValue({});
    await collectMessages(queryWithRuntime(minimalParams));

    expect(rebelCoreQueryMock).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // Test 3: OAuth-only settings still route to Rebel Core
  // -------------------------------------------------------------------------
  it('routes to Rebel Core with OAuth-only auth settings', async () => {
    getSettingsMock.mockReturnValue({
      auth: { oauthToken: 'oauth-test-token' },
    });

    const messages = await collectMessages(queryWithRuntime(minimalParams));

    expect(rebelCoreQueryMock).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({ marker: 'rebel-core' }));
  });

  // -------------------------------------------------------------------------
  // Test 4: Proxy config extracted correctly when routing to Rebel Core
  // -------------------------------------------------------------------------
  it('extracts proxy config and passes it to rebelCoreQuery', async () => {
    const paramsWithProxy: TurnParams = {
      ...minimalParams,
      env: {
        ANTHROPIC_BASE_URL: 'http://proxy.local:8080',
        ANTHROPIC_CUSTOM_HEADERS: 'x-proxy-auth: test-token',
      },
    };

    await collectMessages(queryWithRuntime(paramsWithProxy));

    expect(rebelCoreQueryMock).toHaveBeenCalledTimes(1);
    const [, context] = rebelCoreQueryMock.mock.calls[0] as [TurnParams, Record<string, unknown>];
    expect(context.proxyConfig).toEqual({
      baseURL: 'http://proxy.local:8080',
      defaultHeaders: { 'x-proxy-auth': 'test-token' },
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: routerContext (superMcpUrl, sessionId, onMcpError) passed through
  // -------------------------------------------------------------------------
  it('passes routerContext fields through to rebelCoreQuery', async () => {
    const onMcpError = vi.fn();
    const routerContext = {
      superMcpUrl: 'http://super-mcp:3456',
      sessionId: 'session-abc-123',
      onMcpError,
    };

    await collectMessages(queryWithRuntime(minimalParams, routerContext));

    expect(rebelCoreQueryMock).toHaveBeenCalledTimes(1);
    const [, context] = rebelCoreQueryMock.mock.calls[0] as [TurnParams, Record<string, unknown>];
    expect(context.superMcpUrl).toBe('http://super-mcp:3456');
    expect(context.sessionId).toBe('session-abc-123');
    expect(context.onMcpError).toBe(onMcpError);
  });

  // -------------------------------------------------------------------------
  // Test 6: model override fields passed through to rebelCoreQuery
  // -------------------------------------------------------------------------
  it('passes executionModelOverride and planningModelOverride through to rebelCoreQuery', async () => {
    const routerContext = {
      executionModelOverride: unsafeAssertRoutingModelId('gpt-5.5'),
      planningModelOverride: unsafeAssertRoutingModelId('deepseek-r1'),
    };

    await collectMessages(queryWithRuntime(minimalParams, routerContext));

    expect(rebelCoreQueryMock).toHaveBeenCalledTimes(1);
    const [, context] = rebelCoreQueryMock.mock.calls[0] as [TurnParams, Record<string, unknown>];
    expect(context.executionModelOverride).toBe('gpt-5.5');
    expect(context.planningModelOverride).toBe('deepseek-r1');
  });

  it('passes perConversationModelOverride through to rebelCoreQuery', async () => {
    const routerContext = {
      perConversationModelOverride: true,
    };

    await collectMessages(queryWithRuntime(minimalParams, routerContext));

    const [, context] = rebelCoreQueryMock.mock.calls[0] as [TurnParams, Record<string, unknown>];
    expect(context.perConversationModelOverride).toBe(true);
  });

  it('does not set model overrides when routerContext omits them', async () => {
    const routerContext = {
      superMcpUrl: 'http://super-mcp:3456',
    };

    await collectMessages(queryWithRuntime(minimalParams, routerContext));

    const [, context] = rebelCoreQueryMock.mock.calls[0] as [TurnParams, Record<string, unknown>];
    expect(context.executionModelOverride).toBeUndefined();
    expect(context.planningModelOverride).toBeUndefined();
    expect(context.perConversationModelOverride).toBeUndefined();
  });
});
