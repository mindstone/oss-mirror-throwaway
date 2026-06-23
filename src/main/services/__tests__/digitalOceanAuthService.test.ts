import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ProviderOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountEmail?: string;
  teamName?: string;
  teamUuid?: string;
};

const mocks = vi.hoisted(() => ({
  mockShellOpenExternal: vi.fn(),
  mockGenerateCsrfState: vi.fn(() => 'csrf-state-123'),
  mockBringAppToForeground: vi.fn(),
  mockFetchWithTimeoutBestEffort: vi.fn(),
  mockTrackOAuthBrowserOpened: vi.fn(),
  mockResolveDigitalOceanCredentials: vi.fn(),
  storedOAuthTokens: null as ProviderOAuthTokens | null,
}));

vi.mock('electron', () => ({
  shell: {
    openExternal: mocks.mockShellOpenExternal,
  },
}));

vi.mock('../oauthPrimitives', () => ({
  generateCsrfState: mocks.mockGenerateCsrfState,
  bringAppToForeground: mocks.mockBringAppToForeground,
  fetchWithTimeoutBestEffort: mocks.mockFetchWithTimeoutBestEffort,
}));

vi.mock('../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: mocks.mockTrackOAuthBrowserOpened,
}));

vi.mock('../oauthCredentials', () => ({
  resolveDigitalOceanCredentials: mocks.mockResolveDigitalOceanCredentials,
}));

vi.mock('../providerTokenStorage', () => ({
  saveProviderOAuthTokens: vi.fn((_providerId: string, tokens: ProviderOAuthTokens) => {
    mocks.storedOAuthTokens = { ...tokens };
  }),
  loadProviderOAuthTokens: vi.fn((_providerId: string) => {
    if (!mocks.storedOAuthTokens) return null;
    return { ...mocks.storedOAuthTokens };
  }),
  clearProviderOAuthTokens: vi.fn((_providerId: string) => {
    mocks.storedOAuthTokens = null;
  }),
}));

import {
  DigitalOceanOAuthExpiredError,
  disconnectDigitalOceanOAuth,
  getDigitalOceanOAuthStatus,
  getValidDigitalOceanToken,
  handleDigitalOceanOAuthCallback,
  startDigitalOceanOAuth,
} from '../digitalOceanAuthService';

describe('digitalOceanAuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mocks.storedOAuthTokens = null;

    mocks.mockShellOpenExternal.mockResolvedValue(undefined);
    mocks.mockGenerateCsrfState.mockReturnValue('csrf-state-123');
    mocks.mockResolveDigitalOceanCredentials.mockReturnValue({
      clientId: 'do-client-id',
      clientSecret: 'do-client-secret',
    });
    mocks.mockFetchWithTimeoutBestEffort.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('startOAuth() generates valid authorize URL with state', async () => {
    const startPromise = startDigitalOceanOAuth();
    await Promise.resolve();

    expect(mocks.mockShellOpenExternal).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(mocks.mockShellOpenExternal.mock.calls[0][0]);

    expect(openedUrl.origin).toBe('https://cloud.digitalocean.com');
    expect(openedUrl.pathname).toBe('/v1/oauth/authorize');
    expect(openedUrl.searchParams.get('client_id')).toBe('do-client-id');
    expect(openedUrl.searchParams.get('redirect_uri')).toBe('https://rebel-auth.mindstone.com/digitalocean/callback');
    expect(openedUrl.searchParams.get('response_type')).toBe('code');
    expect(openedUrl.searchParams.get('state')).toBe('csrf-state-123');
    expect(openedUrl.searchParams.get('scope')).toBe('account:read droplet:create droplet:read droplet:delete block_storage:create block_storage:read block_storage:delete block_storage_action:create firewall:create firewall:read firewall:delete');

    await disconnectDigitalOceanOAuth();
    await expect(startPromise).rejects.toThrow('Authorization cancelled');
  });

  it('startOAuth() uses DIGITAL_OCEAN_REDIRECT_URI when configured', async () => {
    vi.stubEnv('DIGITAL_OCEAN_REDIRECT_URI', 'https://example.test/digitalocean/callback');

    const startPromise = startDigitalOceanOAuth();
    startPromise.catch(() => {});
    await Promise.resolve();

    expect(mocks.mockShellOpenExternal).toHaveBeenCalledTimes(1);
    const openedUrl = new URL(mocks.mockShellOpenExternal.mock.calls[0][0]);

    expect(openedUrl.searchParams.get('redirect_uri')).toBe(
      'https://example.test/digitalocean/callback',
    );

    await disconnectDigitalOceanOAuth();
    await expect(startPromise).rejects.toThrow('Authorization cancelled');
  });

  it('startOAuth() rejects concurrent attempts', async () => {
    const firstStart = startDigitalOceanOAuth();
    await Promise.resolve();

    await expect(startDigitalOceanOAuth()).rejects.toThrow('DigitalOcean authorization is already in progress');

    await disconnectDigitalOceanOAuth();
    await expect(firstStart).rejects.toThrow('Authorization cancelled');
  });

  it('handleCallback() validates state and exchanges code', async () => {
    const startPromise = startDigitalOceanOAuth();
    await Promise.resolve();

    const openedUrl = new URL(mocks.mockShellOpenExternal.mock.calls[0][0]);
    const state = openedUrl.searchParams.get('state');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: 'do-access-token',
      refresh_token: 'do-refresh-token',
      expires_in: 1800,
      info: {
        email: 'do@example.com',
        team_name: 'Rebel Team',
        team_uuid: 'team-uuid-1',
      },
    }), { status: 200 }));

    await handleDigitalOceanOAuthCallback(`mindstone://digitalocean/callback?code=auth-code-1&state=${state}`);
    await expect(startPromise).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://cloud.digitalocean.com/v1/oauth/token');
    expect(mocks.mockBringAppToForeground).toHaveBeenCalledTimes(1);

    expect(mocks.storedOAuthTokens).toMatchObject({
      accessToken: 'do-access-token',
      refreshToken: 'do-refresh-token',
      accountEmail: 'do@example.com',
      teamName: 'Rebel Team',
      teamUuid: 'team-uuid-1',
    });
    expect(mocks.storedOAuthTokens?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('handleCallback() rejects mismatched state', async () => {
    const startPromise = startDigitalOceanOAuth();
    await Promise.resolve();

    await handleDigitalOceanOAuthCallback('mindstone://digitalocean/callback?code=auth-code-1&state=wrong-state');
    await expect(startPromise).rejects.toThrow('OAuth state mismatch - possible CSRF attack');
  });

  it('getValidDigitalOceanToken() returns cached token when not expired', async () => {
    mocks.storedOAuthTokens = {
      accessToken: 'cached-access-token',
      refreshToken: 'cached-refresh-token',
      expiresAt: Date.now() + 10 * 60 * 1000,
      accountEmail: 'cached@example.com',
    };

    const token = await getValidDigitalOceanToken();
    expect(token).toBe('cached-access-token');
  });

  it('getValidDigitalOceanToken() refreshes when within 5min of expiry', async () => {
    mocks.storedOAuthTokens = {
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      expiresAt: Date.now() + 60 * 1000,
      accountEmail: 'old@example.com',
      teamName: 'Old Team',
      teamUuid: 'old-team-uuid',
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 3600,
      info: {
        email: 'new@example.com',
        team_name: 'New Team',
        team_uuid: 'new-team-uuid',
      },
    }), { status: 200 }));

    const token = await getValidDigitalOceanToken();

    expect(token).toBe('new-access-token');
    expect(mocks.storedOAuthTokens).toMatchObject({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      accountEmail: 'new@example.com',
      teamName: 'New Team',
      teamUuid: 'new-team-uuid',
    });
    expect(mocks.storedOAuthTokens?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('getValidDigitalOceanToken() throws DigitalOceanOAuthExpiredError on invalid_grant', async () => {
    mocks.storedOAuthTokens = {
      accessToken: 'expiring-access-token',
      refreshToken: 'expiring-refresh-token',
      expiresAt: Date.now() + 60 * 1000,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'invalid_grant',
    }), { status: 400 }));

    await expect(getValidDigitalOceanToken()).rejects.toBeInstanceOf(DigitalOceanOAuthExpiredError);
    expect(mocks.storedOAuthTokens).toBeNull();
  });

  it('getValidDigitalOceanToken() preserves tokens on network error', async () => {
    const originalTokens: ProviderOAuthTokens = {
      accessToken: 'network-access-token',
      refreshToken: 'network-refresh-token',
      expiresAt: Date.now() + 60 * 1000,
      accountEmail: 'network@example.com',
      teamName: 'Network Team',
      teamUuid: 'network-team-uuid',
    };
    mocks.storedOAuthTokens = { ...originalTokens };

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network is down'));

    await expect(getValidDigitalOceanToken()).rejects.toThrow('Failed to refresh DigitalOcean access token');
    expect(mocks.storedOAuthTokens).toEqual(originalTokens);
  });

  it('getValidDigitalOceanToken() single-flights concurrent refreshes', async () => {
    mocks.storedOAuthTokens = {
      accessToken: 'concurrent-access-token',
      refreshToken: 'concurrent-refresh-token',
      expiresAt: Date.now() + 60 * 1000,
      accountEmail: 'concurrent@example.com',
    };

    let refreshCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({
        access_token: 'single-flight-token',
        refresh_token: 'single-flight-refresh',
        expires_in: 3600,
      }), { status: 200 });
    });

    const [tokenA, tokenB, tokenC] = await Promise.all([
      getValidDigitalOceanToken(),
      getValidDigitalOceanToken(),
      getValidDigitalOceanToken(),
    ]);

    expect(tokenA).toBe('single-flight-token');
    expect(tokenB).toBe('single-flight-token');
    expect(tokenC).toBe('single-flight-token');
    expect(refreshCalls).toBe(1);
  });

  it('disconnectOAuth() clears tokens', async () => {
    mocks.storedOAuthTokens = {
      accessToken: 'disconnect-access-token',
      refreshToken: 'disconnect-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
    };

    await disconnectDigitalOceanOAuth();

    expect(mocks.storedOAuthTokens).toBeNull();
    expect(mocks.mockFetchWithTimeoutBestEffort).toHaveBeenCalledTimes(1);
  });

  it('getStatus() returns correct connected/disconnected state', () => {
    expect(getDigitalOceanOAuthStatus()).toEqual({ connected: false });

    mocks.storedOAuthTokens = {
      accessToken: 'status-access-token',
      refreshToken: 'status-refresh-token',
      expiresAt: 123456789,
      accountEmail: 'status@example.com',
    };

    expect(getDigitalOceanOAuthStatus()).toEqual({
      connected: true,
      accountEmail: 'status@example.com',
      expiresAt: 123456789,
    });
  });
});
