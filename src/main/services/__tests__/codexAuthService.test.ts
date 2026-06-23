/**
 * Tests for Codex OAuth Auth Service (Stage 2).
 *
 * Focuses on testable parts: JWT decode, token refresh logic,
 * storage integration, loopback-server binding, and public API state management.
 * Mocks: fetch, shell.openExternal, safeStorage, storeFactory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';

// ─── Mock state ─────────────────────────────────────────────────────
const mockStore: Record<string, unknown> = {};

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(key: string) { return mockStore[key]; },
    set(key: string, value: unknown) { mockStore[key] = value; },
    has(key: string) { return key in mockStore; },
    delete(key: string) { delete mockStore[key]; },
    clear() { for (const k of Object.keys(mockStore)) delete mockStore[k]; },
    get store() { return { ...mockStore }; },
    path: '/tmp/test-store.json',
  })),
}));

vi.mock('@core/lazyElectron', () => {
  const mockElectron = {
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
  };
  return {
    getElectronModule: vi.fn(() => mockElectron),
  };
});

vi.mock('../../utils/testIsolation', () => ({
  isE2eTestMode: vi.fn(() => false),
}));

vi.mock('../oauthPrimitives', () => ({
  generateCsrfState: vi.fn(() => 'mock-csrf-state-abc123'),
  bringAppToForeground: vi.fn(),
}));

// ─── Import modules under test (after mocks) ───────────────────────
import {
  decodeJwtPayload,
  codexLogin,
  codexLogout,
  getCodexAccessToken,
  getCodexAccountId,
  isCodexConnected,
  getCodexStatus,
  bindLoopbackServers,
} from '../codexAuthService';

import {
  saveCodexTokens,
  loadCodexTokens,
  clearCodexTokens,
  hasCodexTokens,
  type CodexTokens,
} from '../codexTokenStorage';

// ─── Helpers ────────────────────────────────────────────────────────

/** Create a valid JWT with the given payload */
function createMockJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = 'mock-signature';
  return `${header}.${body}.${signature}`;
}

/** Create valid stored tokens */
function createMockTokens(overrides: Partial<CodexTokens> = {}): CodexTokens {
  return {
    accessToken: createMockJwt({
      chatgpt_account_id: 'acct_123',
      email: 'user@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refreshToken: 'refresh_token_abc',
    expiresAt: Date.now() + 3600_000,
    accountId: 'acct_123',
    accountEmail: 'user@example.com',
    ...overrides,
  };
}

/**
 * Find an ephemeral port that is free on BOTH loopback families (or only IPv4
 * if the host has no IPv6 stack). The service dual-binds 127.0.0.1 + ::1, so a
 * port free on IPv4 alone could still flake if ::1:port happened to be taken.
 */
async function findFreeLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = http.createServer();
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        const p = addr && typeof addr === 'object' ? addr.port : 0;
        s.close(() => (p ? resolve(p) : reject(new Error('No address'))));
      });
    });
    const ipv6Ok = await new Promise<boolean>((resolve) => {
      const s6 = http.createServer();
      // EADDRINUSE ⇒ port taken on ::1, retry; any other error ⇒ no IPv6 stack, accept.
      s6.once('error', (err: NodeJS.ErrnoException) => resolve(err.code !== 'EADDRINUSE'));
      s6.listen(port, '::1', () => s6.close(() => resolve(true)));
    });
    if (ipv6Ok) return port;
  }
  throw new Error('Could not find a dual-family-free ephemeral port');
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('decodeJwtPayload', () => {
  it('decodes a valid JWT payload', () => {
    const payload = {
      chatgpt_account_id: 'acct_test123',
      email: 'test@example.com',
      exp: 1700000000,
    };
    const token = createMockJwt(payload);
    const decoded = decodeJwtPayload(token);

    expect(decoded).not.toBeNull();
    expect(decoded?.chatgpt_account_id).toBe('acct_test123');
    expect(decoded?.email).toBe('test@example.com');
    expect(decoded?.exp).toBe(1700000000);
  });

  it('returns null for empty string', () => {
    expect(decodeJwtPayload('')).toBeNull();
  });

  it('returns null for token with wrong number of parts', () => {
    expect(decodeJwtPayload('only-one-part')).toBeNull();
    expect(decodeJwtPayload('two.parts')).toBeNull();
    expect(decodeJwtPayload('too.many.parts.here')).toBeNull();
  });

  it('returns null for invalid base64 payload', () => {
    expect(decodeJwtPayload('header.!!!invalid!!!.signature')).toBeNull();
  });

  it('returns null for non-JSON payload', () => {
    const nonJson = Buffer.from('not-json').toString('base64url');
    expect(decodeJwtPayload(`header.${nonJson}.signature`)).toBeNull();
  });

  it('handles payload without chatgpt_account_id', () => {
    const token = createMockJwt({ sub: 'user123', exp: 1700000000 });
    const decoded = decodeJwtPayload(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.chatgpt_account_id).toBeUndefined();
    expect(decoded?.sub).toBe('user123');
  });

  it('handles base64url encoded characters correctly', () => {
    // Create a payload that would use + and / in standard base64
    const payload = { chatgpt_account_id: 'acct_with+special/chars==end' };
    const token = createMockJwt(payload);
    const decoded = decodeJwtPayload(token);
    expect(decoded?.chatgpt_account_id).toBe('acct_with+special/chars==end');
  });

  it('handles payload with padding needed', () => {
    // Short payload that needs base64 padding
    const payload = { a: 1 };
    const token = createMockJwt(payload);
    const decoded = decodeJwtPayload(token);
    expect(decoded?.a).toBe(1);
  });
});

describe('codexTokenStorage integration', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockStore)) delete mockStore[k];
  });

  it('saves and loads tokens', () => {
    const tokens = createMockTokens();
    saveCodexTokens(tokens);
    const loaded = loadCodexTokens();
    expect(loaded).not.toBeNull();
    expect(loaded?.accountId).toBe('acct_123');
    expect(loaded?.accountEmail).toBe('user@example.com');
    expect(loaded?.refreshToken).toBe('refresh_token_abc');
  });

  it('returns null when no tokens stored', () => {
    expect(loadCodexTokens()).toBeNull();
  });

  it('clears tokens', () => {
    saveCodexTokens(createMockTokens());
    expect(hasCodexTokens()).toBe(true);
    clearCodexTokens({ cause: 'manual_logout', source: 'codex_auth_core' });
    expect(hasCodexTokens()).toBe(false);
    expect(loadCodexTokens()).toBeNull();
  });

  it('hasCodexTokens reflects stored state', () => {
    expect(hasCodexTokens()).toBe(false);
    saveCodexTokens(createMockTokens());
    expect(hasCodexTokens()).toBe(true);
  });
});

describe('getCodexAccessToken', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockStore)) delete mockStore[k];
    vi.restoreAllMocks();
  });

  it('returns null when not connected', async () => {
    const token = await getCodexAccessToken();
    expect(token).toBeNull();
  });

  it('returns cached token when not expired', async () => {
    const tokens = createMockTokens({ expiresAt: Date.now() + 30 * 60_000 }); // 30 min left
    saveCodexTokens(tokens);
    const result = await getCodexAccessToken();
    expect(result).toBe(tokens.accessToken);
  });

  it('refreshes token when expiring soon', async () => {
    const newAccessToken = createMockJwt({
      chatgpt_account_id: 'acct_123',
      email: 'user@example.com',
      exp: Math.floor(Date.now() / 1000) + 7200,
    });

    // Store tokens that are expiring within the 5-minute buffer
    const tokens = createMockTokens({ expiresAt: Date.now() + 2 * 60_000 }); // 2 min left
    saveCodexTokens(tokens);

    // Mock fetch for token refresh
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: newAccessToken,
        refresh_token: 'new_refresh_token',
        expires_in: 7200,
      }), { status: 200 })
    );

    const result = await getCodexAccessToken();
    expect(result).toBe(newAccessToken);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Verify refreshed tokens were saved
    const saved = loadCodexTokens();
    expect(saved?.refreshToken).toBe('new_refresh_token');
  });

  it('clears tokens on refresh failure', async () => {
    const tokens = createMockTokens({ expiresAt: Date.now() + 2 * 60_000 });
    saveCodexTokens(tokens);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    );

    const result = await getCodexAccessToken();
    expect(result).toBeNull();
    expect(hasCodexTokens()).toBe(false);
  });

  it('preserves existing refresh_token when refresh response omits it', async () => {
    const newAccessToken = createMockJwt({
      chatgpt_account_id: 'acct_123',
      exp: Math.floor(Date.now() / 1000) + 7200,
    });

    const tokens = createMockTokens({
      expiresAt: Date.now() + 2 * 60_000,
      refreshToken: 'original_refresh',
    });
    saveCodexTokens(tokens);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: newAccessToken,
        // No refresh_token in response
        expires_in: 7200,
      }), { status: 200 })
    );

    await getCodexAccessToken();
    const saved = loadCodexTokens();
    expect(saved?.refreshToken).toBe('original_refresh');
  });
});

describe('getCodexAccountId', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockStore)) delete mockStore[k];
  });

  it('returns null when not connected', () => {
    expect(getCodexAccountId()).toBeNull();
  });

  it('returns account ID from stored tokens', () => {
    saveCodexTokens(createMockTokens({ accountId: 'acct_456' }));
    expect(getCodexAccountId()).toBe('acct_456');
  });
});

describe('isCodexConnected', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockStore)) delete mockStore[k];
  });

  it('returns false when not connected', () => {
    expect(isCodexConnected()).toBe(false);
  });

  it('returns true when tokens stored', () => {
    saveCodexTokens(createMockTokens());
    expect(isCodexConnected()).toBe(true);
  });
});

describe('getCodexStatus', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockStore)) delete mockStore[k];
  });

  it('returns disconnected status when no tokens', () => {
    const status = getCodexStatus();
    expect(status).toEqual({ connected: false });
  });

  it('returns connected status with email', () => {
    saveCodexTokens(createMockTokens({ accountEmail: '[external-email]' }));
    const status = getCodexStatus();
    expect(status).toEqual({
      connected: true,
      accountEmail: '[external-email]',
    });
  });

  it('returns connected status without email', () => {
    saveCodexTokens(createMockTokens({ accountEmail: undefined }));
    const status = getCodexStatus();
    expect(status).toEqual({
      connected: true,
      accountEmail: undefined,
    });
  });
});

describe('codexLogout', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockStore)) delete mockStore[k];
  });

  it('clears tokens on logout', async () => {
    saveCodexTokens(createMockTokens());
    expect(isCodexConnected()).toBe(true);
    await codexLogout();
    expect(isCodexConnected()).toBe(false);
  });
});

describe('codexLogin', () => {
  let serverCloseHandles: Array<() => void> = [];

  beforeEach(() => {
    for (const k of Object.keys(mockStore)) delete mockStore[k];
    vi.restoreAllMocks();
    serverCloseHandles = [];
  });

  afterEach(() => {
    // Clean up any lingering servers
    for (const close of serverCloseHandles) {
      try { close(); } catch { /* ignore */ }
    }
  });

  /** A free ephemeral port (verified on both loopback families). */
  const ephemeralPort = findFreeLoopbackPort;

  it('opens browser with correct OAuth URL parameters', async () => {
    const { getElectronModule } = await import('@core/lazyElectron');
    const shell = getElectronModule()!.shell;

    const port = await ephemeralPort();

    // Start login but don't wait for callback — we'll inspect the URL.
    // Inject the ephemeral port so we don't contend for the real 1455/1457.
    const loginPromise = codexLogin({ loopbackPorts: [port] });

    // Give the server time to start and openExternal to be called
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(shell.openExternal).toHaveBeenCalledTimes(1);
    const calledUrl = vi.mocked(shell.openExternal).mock.calls[0][0];
    const url = new URL(calledUrl);

    expect(url.origin).toBe('https://auth.openai.com');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url.searchParams.get('response_type')).toBe('code');
    // redirect_uri uses the `localhost` host (matching OpenAI's allow-list),
    // even though the server itself binds 127.0.0.1.
    expect(url.searchParams.get('redirect_uri')).toBe(`http://localhost:${port}/auth/callback`);
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access api.connectors.read api.connectors.invoke');
    expect(url.searchParams.get('state')).toBe('mock-csrf-state-abc123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(url.searchParams.get('originator')).toBe('codex_cli_rs');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();

    // Simulate callback to resolve the login promise (mismatched state ends the
    // flow). Connect via 127.0.0.1 — that is where the server actually binds.
    try {
      await fetch(`http://127.0.0.1:${port}/auth/callback?state=wrong&code=test`);
    } catch {
      // Connection may fail if server already closed
    }

    const result = await loginPromise;
    expect(result.success).toBe(false);
  });

  it('handles successful OAuth callback with token exchange', async () => {
    const port = await ephemeralPort();

    const accessToken = createMockJwt({
      chatgpt_account_id: 'acct_test_flow',
      email: 'flow@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    // Mock fetch for token exchange — use mockImplementation so we can
    // pass through the test's http.get callback while intercepting
    // the real token exchange POST
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('auth.openai.com')) {
        return new Response(JSON.stringify({
          access_token: accessToken,
          refresh_token: 'refresh_flow_token',
          expires_in: 3600,
        }), { status: 200 });
      }
      // Should not reach here
      return new Response('Not mocked', { status: 500 });
    });

    // Start login
    const loginPromise = codexLogin({ loopbackPorts: [port] });

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 150));

    // Simulate successful callback using http.get (bypasses mocked fetch).
    // Connect via 127.0.0.1 to match the server's bind address.
    await new Promise<void>((resolve) => {
      http.get(
        `http://127.0.0.1:${port}/auth/callback?state=mock-csrf-state-abc123&code=auth_code_123`,
        () => resolve()
      ).on('error', () => resolve());
    });

    const result = await loginPromise;
    expect(result.success).toBe(true);
    expect(result.email).toBe('flow@example.com');

    // Verify tokens were saved
    const saved = loadCodexTokens();
    expect(saved).not.toBeNull();
    expect(saved?.accountId).toBe('acct_test_flow');
    expect(saved?.accountEmail).toBe('flow@example.com');
    expect(saved?.refreshToken).toBe('refresh_flow_token');
  });

  it('handles token exchange failure', async () => {
    const port = await ephemeralPort();

    // Mock fetch to return error for token exchange
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('{"error":"invalid_grant"}', { status: 400 });
    });

    const loginPromise = codexLogin({ loopbackPorts: [port] });
    await new Promise(resolve => setTimeout(resolve, 150));

    // Simulate callback using http.get (bypasses mocked fetch), via 127.0.0.1.
    await new Promise<void>((resolve) => {
      http.get(
        `http://127.0.0.1:${port}/auth/callback?state=mock-csrf-state-abc123&code=bad_code`,
        () => resolve()
      ).on('error', () => resolve());
    });

    const result = await loginPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain('Token exchange failed');
  });

  it('fails with an actionable message when every callback port is in use', async () => {
    const { getElectronModule } = await import('@core/lazyElectron');
    const shell = getElectronModule()!.shell;
    // The shell mock is a module-level singleton shared across tests; clear
    // prior call history so the not-called assertion below is meaningful.
    vi.mocked(shell.openExternal).mockClear();

    // Occupy a single candidate port on 127.0.0.1 so the bind cannot succeed.
    const port = await ephemeralPort();
    const blocker = http.createServer();
    serverCloseHandles.push(() => blocker.close());
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(port, '127.0.0.1', () => resolve());
    });

    const result = await codexLogin({ loopbackPorts: [port] });

    expect(result.success).toBe(false);
    expect(result.error).toContain('another app');
    // The browser must NOT be opened when we couldn't start the callback server.
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe('bindLoopbackServers (dual-stack loopback binding)', () => {
  const openServers: http.Server[] = [];
  const noopHandler: http.RequestListener = (_req, res) => res.end('ok');

  afterEach(async () => {
    await Promise.all(
      openServers.splice(0).map(
        (s) => new Promise<void>((res) => s.close(() => res())),
      ),
    );
  });

  /** Track returned servers so afterEach can close them. */
  function track(servers: http.Server[]): http.Server[] {
    openServers.push(...servers);
    return servers;
  }

  /** Bind a throwaway server to host:port, tracked for cleanup. */
  function occupy(host: string, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const s = http.createServer();
      s.once('error', reject);
      s.listen(port, host, () => {
        openServers.push(s);
        resolve();
      });
    });
  }

  /** A free ephemeral port (verified on both loopback families). */
  const freePort = findFreeLoopbackPort;

  /** True if the IPv6 loopback can be bound in this environment. */
  async function ipv6Available(): Promise<boolean> {
    const probePort = await freePort();
    try {
      await occupy('::1', probePort);
      return true;
    } catch {
      return false;
    }
  }

  it('skips a port whose ::1 family is occupied and selects the next one (the regression)', async (ctx) => {
    if (!(await ipv6Available())) {
      ctx.skip('IPv6 loopback unavailable in this environment');
      return;
    }
    const first = await freePort();
    const second = await freePort();
    // Squat ONLY the IPv6 family of `first` — the exact production shape
    // (something on ::1:1455 while 127.0.0.1:1455 is free). Because the browser
    // is sent to http://localhost and may prefer ::1, this port is unsafe and
    // must be skipped rather than half-bound on IPv4.
    await occupy('::1', first);

    const { port, servers } = await bindLoopbackServers(noopHandler, [first, second]);
    track(servers);

    expect(port).toBe(second);
    // Both families of the chosen port are owned by us.
    expect(servers).toHaveLength(2);
    expect(servers.every((s) => s.listening)).toBe(true);
  });

  it('owns both loopback families for the chosen port', async (ctx) => {
    if (!(await ipv6Available())) {
      ctx.skip('IPv6 loopback unavailable in this environment');
      return;
    }
    const port = await freePort();
    const { port: bound, servers } = await bindLoopbackServers(noopHandler, [port, await freePort()]);
    track(servers);

    expect(bound).toBe(port);
    expect(servers).toHaveLength(2);
  });

  it('falls back to the next port when the first is taken on 127.0.0.1', async () => {
    const first = await freePort();
    const second = await freePort();
    await occupy('127.0.0.1', first);

    const { port, servers } = await bindLoopbackServers(noopHandler, [first, second]);
    track(servers);

    expect(port).toBe(second);
  });

  it('rejects with EADDRINUSE when every candidate port is taken', async () => {
    const first = await freePort();
    const second = await freePort();
    await occupy('127.0.0.1', first);
    await occupy('127.0.0.1', second);

    await expect(
      bindLoopbackServers(noopHandler, [first, second]),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('single-flight token refresh', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockStore)) delete mockStore[k];
    vi.restoreAllMocks();
  });

  it('concurrent refresh calls share the same promise', async () => {
    const newAccessToken = createMockJwt({
      chatgpt_account_id: 'acct_123',
      exp: Math.floor(Date.now() / 1000) + 7200,
    });

    const tokens = createMockTokens({ expiresAt: Date.now() + 60_000 }); // Expires in 1 min (within buffer)
    saveCodexTokens(tokens);

    let fetchCallCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCallCount++;
      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 50));
      return new Response(JSON.stringify({
        access_token: newAccessToken,
        refresh_token: 'refreshed',
        expires_in: 7200,
      }), { status: 200 });
    });

    // Fire three concurrent requests
    const [r1, r2, r3] = await Promise.all([
      getCodexAccessToken(),
      getCodexAccessToken(),
      getCodexAccessToken(),
    ]);

    // All should get the same token
    expect(r1).toBe(newAccessToken);
    expect(r2).toBe(newAccessToken);
    expect(r3).toBe(newAccessToken);

    // But fetch should only be called once (single-flight)
    expect(fetchCallCount).toBe(1);
  });
});
