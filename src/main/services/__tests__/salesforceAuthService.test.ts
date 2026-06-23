import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron before importing the module
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user-data'),
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock oauthPrimitives
vi.mock('../oauthPrimitives', () => ({
  generateCsrfState: vi.fn().mockReturnValue('mock-csrf-state'),
  fetchWithTimeoutBestEffort: vi.fn().mockResolvedValue({ ok: true }),
  bringAppToForeground: vi.fn(),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock settingsStore — default to production (no environment set)
const mockGetSettings = vi.fn().mockReturnValue({});
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}));

import {
  startSalesforceAuth,
  handleSalesforceOAuthCallback,
  cancelSalesforceAuth,
} from '../salesforceAuthService';
import { shell } from 'electron';

// Helper to build a callback URL with given params
function buildCallbackUrl(params: Record<string, string>): string {
  const url = new URL('mindstone://salesforce/callback');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

describe('salesforceAuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // Cancel any pending auth between tests
    cancelSalesforceAuth();
  });

  describe('PKCE generation', () => {
    it('generates a valid PKCE verifier and challenge pair', async () => {
      // Start auth to trigger PKCE generation internally; we verify the OAuth URL
      // contains the challenge parameters
      const authPromise = startSalesforceAuth('test-client-id', 'test-client-secret');

      // Verify shell.openExternal was called with an OAuth URL containing PKCE params
      expect(shell.openExternal).toHaveBeenCalledTimes(1);
      const oauthUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsedUrl = new URL(oauthUrl);

      expect(parsedUrl.searchParams.get('code_challenge')).toBeTruthy();
      expect(parsedUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsedUrl.searchParams.get('client_id')).toBe('test-client-id');
      expect(parsedUrl.searchParams.get('response_type')).toBe('code');

      // Clean up pending auth
      cancelSalesforceAuth();
      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });
  });

  describe('token exchange URL construction', () => {
    it('constructs OAuth URL with correct parameters', async () => {
      const authPromise = startSalesforceAuth('my-client-id', 'my-secret');

      const oauthUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsedUrl = new URL(oauthUrl);

      expect(parsedUrl.origin + parsedUrl.pathname).toBe(
        'https://login.salesforce.com/services/oauth2/authorize'
      );
      expect(parsedUrl.searchParams.get('client_id')).toBe('my-client-id');
      expect(parsedUrl.searchParams.get('redirect_uri')).toBe(
        'https://rebel-auth.mindstone.com/salesforce/callback'
      );
      expect(parsedUrl.searchParams.get('scope')).toContain('api');
      expect(parsedUrl.searchParams.get('scope')).toContain('refresh_token');
      expect(parsedUrl.searchParams.get('state')).toBe('mock-csrf-state');

      cancelSalesforceAuth();
      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });

    it('uses SALESFORCE_REDIRECT_URI when configured', async () => {
      vi.stubEnv('SALESFORCE_REDIRECT_URI', 'https://example.test/salesforce/callback');

      const authPromise = startSalesforceAuth('my-client-id', 'my-secret');

      const oauthUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsedUrl = new URL(oauthUrl);

      expect(parsedUrl.searchParams.get('redirect_uri')).toBe(
        'https://example.test/salesforce/callback',
      );

      cancelSalesforceAuth();
      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });
  });

  describe('exchangeCodeForTokens error messages', () => {
    it('provides actionable error for redirect_uri_mismatch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"redirect_uri_mismatch","error_description":"redirect_uri must match"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow('Ensure your Connected App callback URL is set to');
    });

    it('provides actionable error for invalid_client', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"invalid_client","error_description":"Invalid client credentials"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow('Ensure your Connected App callback URL is set to');
    });

    it('provides actionable error for OAUTH_APP_ACCESS_DENIED', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('{"error":"OAUTH_APP_ACCESS_DENIED","error_description":"user hasn\'t approved this consumer"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow("admin hasn't granted access");
    });

    it('provides actionable error for insufficient_scope', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('{"error":"insufficient_scope"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow("admin hasn't granted access");
    });

    it('provides actionable error for invalid_grant', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"invalid_grant","error_description":"expired authorization code"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow('Authorization code expired or already used');
    });

    it('provides actionable error for unsupported_grant_type', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"unsupported_grant_type"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow("Connected App may not have OAuth enabled");
    });

    it('falls through to generic error for unknown error types', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow('Token exchange failed: 500');
    });
  });

  describe('handleSalesforceOAuthCallback error handling', () => {
    it('provides actionable error for access_denied callback', async () => {
      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({
        error: 'access_denied',
        error_description: 'end-user denied authorization',
        state: 'mock-csrf-state',
      });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow(
        "Access was denied. If you're not a Salesforce admin"
      );
    });

    it('uses error_description for non-access_denied errors', async () => {
      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({
        error: 'server_error',
        error_description: 'Something went wrong on Salesforce side',
        state: 'mock-csrf-state',
      });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow('Something went wrong on Salesforce side');
    });

    it('rejects on CSRF state mismatch', async () => {
      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({
        code: 'test-code',
        state: 'wrong-state',
      });

      await handleSalesforceOAuthCallback(callbackUrl);
      await expect(authPromise).rejects.toThrow('OAuth state mismatch');
    });

    it('ignores callback when no auth is pending', async () => {
      // No startSalesforceAuth called — callback should be ignored silently
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'some-state' });
      await handleSalesforceOAuthCallback(callbackUrl);
      // Should not throw — just return silently
    });
  });

  describe('sandbox environment support', () => {
    it('uses production OAuth URL by default (no environment set)', async () => {
      mockGetSettings.mockReturnValue({});

      const authPromise = startSalesforceAuth('client-id', 'client-secret');

      const oauthUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsedUrl = new URL(oauthUrl);

      expect(parsedUrl.origin).toBe('https://login.salesforce.com');
      expect(parsedUrl.pathname).toBe('/services/oauth2/authorize');

      cancelSalesforceAuth();
      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });

    it('uses production OAuth URL when environment is explicitly production', async () => {
      mockGetSettings.mockReturnValue({ salesforce: { environment: 'production' } });

      const authPromise = startSalesforceAuth('client-id', 'client-secret');

      const oauthUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsedUrl = new URL(oauthUrl);

      expect(parsedUrl.origin).toBe('https://login.salesforce.com');

      cancelSalesforceAuth();
      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });

    it('uses sandbox OAuth URL when environment is sandbox', async () => {
      mockGetSettings.mockReturnValue({ salesforce: { environment: 'sandbox' } });

      const authPromise = startSalesforceAuth('client-id', 'client-secret');

      const oauthUrl = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const parsedUrl = new URL(oauthUrl);

      expect(parsedUrl.origin).toBe('https://test.salesforce.com');
      expect(parsedUrl.pathname).toBe('/services/oauth2/authorize');

      cancelSalesforceAuth();
      await expect(authPromise).rejects.toThrow('Auth cancelled by user');
    });

    it('uses sandbox token URL for token exchange in sandbox environment', async () => {
      mockGetSettings.mockReturnValue({ salesforce: { environment: 'sandbox' } });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"invalid_grant"}'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const authPromise = startSalesforceAuth('client-id', 'client-secret');
      const callbackUrl = buildCallbackUrl({ code: 'test-code', state: 'mock-csrf-state' });

      await handleSalesforceOAuthCallback(callbackUrl);

      // Verify fetch was called with sandbox token URL
      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.salesforce.com/services/oauth2/token',
        expect.any(Object)
      );

      await expect(authPromise).rejects.toThrow('Authorization code expired');
    });
  });
});
