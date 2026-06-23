/**
 * DigitalOcean OAuth Service
 *
 * Handles OAuth2 authentication for DigitalOcean using system browser + deep link callback.
 * Flow: System browser → DigitalOcean auth → Cloudflare redirect → mindstone:// deep link → App
 */

import { URL } from 'node:url';
import { shell } from 'electron';
import { createScopedLogger } from '@core/logger';
import { getOAuthRedirectUri } from '@core/services/oauthRedirectUri';
import { resolveDigitalOceanCredentials } from './oauthCredentials';
import { trackOAuthBrowserOpened } from './oauthTelemetry';
import {
  bringAppToForeground,
  fetchWithTimeoutBestEffort,
  generateCsrfState,
} from './oauthPrimitives';
import {
  clearProviderOAuthTokens,
  loadProviderOAuthTokens,
  saveProviderOAuthTokens,
  type ProviderOAuthTokens,
} from './providerTokenStorage';

const log = createScopedLogger({ service: 'digitalocean-auth' });

const DIGITALOCEAN_AUTH_URL = 'https://cloud.digitalocean.com/v1/oauth/authorize';
const DIGITALOCEAN_TOKEN_URL = 'https://cloud.digitalocean.com/v1/oauth/token';
const DIGITALOCEAN_REVOKE_URL = 'https://cloud.digitalocean.com/v1/oauth/revoke';
const getRedirectUri = () => getOAuthRedirectUri('digitalocean');
const DIGITALOCEAN_SCOPES = 'account:read droplet:create droplet:read droplet:delete block_storage:create block_storage:read block_storage:delete block_storage_action:create firewall:create firewall:read firewall:delete';

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface DigitalOceanTokenInfo {
  name?: string;
  email?: string;
  uuid?: string;
  team_uuid?: string;
  team_name?: string;
}

interface DigitalOceanTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  info?: DigitalOceanTokenInfo;
  error?: string;
  error_description?: string;
}

interface DigitalOceanTokenPayload {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  info?: DigitalOceanTokenInfo;
}

let pendingAuth: {
  state: string;
  redirectUri: string; // snapshotted at auth start; reused at token exchange to prevent env mutation drift
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
} | null = null;

let refreshPromise: Promise<ProviderOAuthTokens> | null = null;

export class DigitalOceanOAuthExpiredError extends Error {
  constructor() {
    super('DigitalOcean connection expired. Please reconnect in Settings.');
    this.name = 'DigitalOceanOAuthExpiredError';
  }
}

function getDigitalOceanCredentialsOrThrow(): { clientId: string; clientSecret: string } {
  const credentials = resolveDigitalOceanCredentials();
  if (!credentials) {
    throw new Error('DigitalOcean OAuth credentials are not configured. Set DIGITAL_OCEAN_CLIENT_ID and DIGITAL_OCEAN_CLIENT_SECRET in your environment.');
  }
  return credentials;
}

function buildDigitalOceanAuthorizeUrl(clientId: string, state: string, redirectUri: string): string {
  const authorizeUrl = new URL(DIGITALOCEAN_AUTH_URL);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', DIGITALOCEAN_SCOPES);
  authorizeUrl.searchParams.set('state', state);
  return authorizeUrl.toString();
}

async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<DigitalOceanTokenPayload> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const response = await fetch(DIGITALOCEAN_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  const responseText = await response.text();
  let data: DigitalOceanTokenResponse;
  try {
    data = JSON.parse(responseText) as DigitalOceanTokenResponse;
  } catch {
    throw new Error(`DigitalOcean token exchange failed: ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(data.error_description ?? data.error ?? `DigitalOcean token exchange failed: ${response.status}`);
  }

  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== 'number') {
    throw new Error('DigitalOcean token exchange returned an invalid token payload');
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    info: data.info,
  };
}

async function refreshDigitalOceanTokens(currentTokens: ProviderOAuthTokens): Promise<ProviderOAuthTokens> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const { clientId, clientSecret } = getDigitalOceanCredentialsOrThrow();
      const response = await fetch(DIGITALOCEAN_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: currentTokens.refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });

      const responseText = await response.text();
      let data: DigitalOceanTokenResponse | null = null;
      try {
        data = JSON.parse(responseText) as DigitalOceanTokenResponse;
      } catch {
        data = null;
      }

      const isInvalidGrant = (response.status === 400 || response.status === 401)
        && data?.error === 'invalid_grant';
      if (isInvalidGrant) {
        clearProviderOAuthTokens('digitalocean');
        throw new DigitalOceanOAuthExpiredError();
      }

      if (!response.ok) {
        throw new Error(`DigitalOcean token refresh failed: ${response.status}`);
      }

      if (!data?.access_token || typeof data.expires_in !== 'number') {
        throw new Error('DigitalOcean token refresh returned an invalid token payload');
      }

      const refreshedTokens: ProviderOAuthTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? currentTokens.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
        accountEmail: data.info?.email ?? currentTokens.accountEmail,
        teamName: data.info?.team_name ?? currentTokens.teamName,
        teamUuid: data.info?.team_uuid ?? currentTokens.teamUuid,
      };

      saveProviderOAuthTokens('digitalocean', refreshedTokens);
      return refreshedTokens;
    } catch (error) {
      if (error instanceof DigitalOceanOAuthExpiredError) {
        throw error;
      }
      throw new Error('Failed to refresh DigitalOcean access token');
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Start DigitalOcean OAuth flow.
 * The callback will be handled by handleDigitalOceanOAuthCallback when the deep link arrives.
 */
export async function startDigitalOceanOAuth(): Promise<void> {
  if (pendingAuth) {
    throw new Error('DigitalOcean authorization is already in progress');
  }

  const { clientId } = getDigitalOceanCredentialsOrThrow();
  const state = generateCsrfState();
  // Snapshot the redirect URI once per auth flow so token exchange uses the same value
  // as the authorization request (DigitalOcean rejects mismatched redirect_uri).
  const redirectUri = getRedirectUri();
  const authorizeUrl = buildDigitalOceanAuthorizeUrl(clientId, state, redirectUri);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuth) {
        pendingAuth = null;
        reject(new Error('Authorization timed out'));
      }
    }, AUTH_TIMEOUT_MS);

    pendingAuth = {
      state,
      redirectUri,
      resolve,
      reject,
      timeout,
    };

    shell.openExternal(authorizeUrl).then(() => {
      trackOAuthBrowserOpened({
        connectorName: 'DigitalOcean',
        connectorType: 'bundled',
        oauthUrl: authorizeUrl,
        callbackMethod: 'deep_link',
      });
      log.info('Opened DigitalOcean OAuth in system browser');
    }).catch((err) => {
      log.error({ err }, 'Failed to open browser for DigitalOcean OAuth');
      clearTimeout(timeout);
      pendingAuth = null;
      reject(new Error('Failed to open browser for authentication'));
    });
  });
}

/**
 * Handle the OAuth callback from the deep link.
 * Called from the protocol handler when mindstone://digitalocean/callback is received.
 */
export async function handleDigitalOceanOAuthCallback(url: string): Promise<void> {
  if (!pendingAuth) {
    log.warn('Received DigitalOcean OAuth callback but no auth is pending');
    return;
  }

  const { state, redirectUri, resolve, reject, timeout } = pendingAuth;
  pendingAuth = null;
  clearTimeout(timeout);

  try {
    const callbackUrl = new URL(url);
    const code = callbackUrl.searchParams.get('code');
    const error = callbackUrl.searchParams.get('error');
    const errorDescription = callbackUrl.searchParams.get('error_description');
    const returnedState = callbackUrl.searchParams.get('state');

    if (returnedState !== state) {
      throw new Error('OAuth state mismatch - possible CSRF attack');
    }

    if (error || !code) {
      throw new Error(errorDescription ?? error ?? 'No authorization code received');
    }

    const { clientId, clientSecret } = getDigitalOceanCredentialsOrThrow();
    const tokenData = await exchangeCodeForTokens(code, clientId, clientSecret, redirectUri);

    saveProviderOAuthTokens('digitalocean', {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
      accountEmail: tokenData.info?.email,
      teamName: tokenData.info?.team_name,
      teamUuid: tokenData.info?.team_uuid,
    });

    bringAppToForeground();
    resolve();
  } catch (error) {
    log.error({ err: error }, 'DigitalOcean OAuth callback failed');
    reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Get a valid DigitalOcean access token, refreshing if needed.
 */
export async function getValidDigitalOceanToken(): Promise<string | null> {
  const storedTokens = loadProviderOAuthTokens('digitalocean');
  if (!storedTokens) {
    return null;
  }

  if (storedTokens.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    return storedTokens.accessToken;
  }

  const refreshedTokens = await refreshDigitalOceanTokens(storedTokens);
  return refreshedTokens.accessToken;
}

/**
 * Get DigitalOcean OAuth connection status.
 */
export function getDigitalOceanOAuthStatus(): { connected: boolean; accountEmail?: string; expiresAt?: number } {
  const storedTokens = loadProviderOAuthTokens('digitalocean');
  if (!storedTokens) {
    return { connected: false };
  }

  return {
    connected: true,
    accountEmail: storedTokens.accountEmail,
    expiresAt: storedTokens.expiresAt,
  };
}

/**
 * Disconnect DigitalOcean OAuth and clear stored tokens.
 */
export async function disconnectDigitalOceanOAuth(): Promise<void> {
  if (pendingAuth) {
    clearTimeout(pendingAuth.timeout);
    pendingAuth.reject(new Error('Authorization cancelled'));
    pendingAuth = null;
  }

  const tokens = loadProviderOAuthTokens('digitalocean');
  clearProviderOAuthTokens('digitalocean');

  if (tokens?.accessToken) {
    const credentials = resolveDigitalOceanCredentials();
    const body = new URLSearchParams({ token: tokens.accessToken });
    if (credentials) {
      body.set('client_id', credentials.clientId);
      body.set('client_secret', credentials.clientSecret);
    }
    await fetchWithTimeoutBestEffort(DIGITALOCEAN_REVOKE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${tokens.accessToken}`,
      },
      body: body.toString(),
      timeoutMs: 5000,
    });
  }
}
