/**
 * Plaud OAuth Auth Service
 *
 * Handles Plaud OAuth 2.0 flow using system browser + Cloudflare Worker + deep link callback.
 * Flow: System browser → Plaud auth → Cloudflare Worker redirect → mindstone:// deep link → App
 *
 * Note: Plaud does not support localhost callbacks, so we use rebel-auth.mindstone.com worker.
 */

import { URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { app, shell } from 'electron';
import { createScopedLogger } from '@core/logger';
import { getOAuthRedirectUri } from '@core/services/oauthRedirectUri';
import { trackOAuthBrowserOpened } from '../oauthTelemetry';
import { bringAppToForeground } from '../oauthPrimitives';
import type { PlaudUser, PlaudTokens, PlaudAccount } from './types';

const log = createScopedLogger({ service: 'plaud-auth' });

// Plaud OAuth endpoints
const PLAUD_AUTH_URL = 'https://app.plaud.ai/platform/oauth';
const PLAUD_TOKEN_URL = 'https://platform.plaud.ai/developer/api/oauth/third-party/access-token';
const PLAUD_REFRESH_URL = 'https://platform.plaud.ai/developer/api/oauth/third-party/access-token/refresh';
const PLAUD_API_BASE = 'https://platform.plaud.ai/developer/api/open/third-party';

// Cloudflare Worker callback (Plaud doesn't accept localhost)
const getRedirectUri = () => getOAuthRedirectUri('plaud');

// OAuth scopes
const PLAUD_SCOPES = 'profile,files-20,file-sources,file-notes,file-audio';

/** Result of successful OAuth */
export interface PlaudOAuthResult {
  userId: string;
  email: string;
  nickname?: string;
}

// Pending auth state
let pendingAuth: {
  clientId: string;
  clientSecret: string;
  redirectUri: string; // snapshotted at auth start; reused at token exchange to prevent env mutation drift
  resolve: (result: PlaudOAuthResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
} | null = null;

export interface PlaudAuthResult {
  authUrl: string;
  completion: Promise<PlaudOAuthResult>;
}

/**
 * Start Plaud OAuth flow.
 * Returns the auth URL and a promise that resolves when OAuth completes.
 */
export function startPlaudAuth(
  clientId: string,
  clientSecret: string,
  options: { autoOpen?: boolean } = {}
): PlaudAuthResult {
  const { autoOpen = true } = options;

  // Cancel any pending auth
  cancelPlaudAuth();

  // Snapshot the redirect URI once per auth flow so token exchange uses the same value
  // as the authorization request (Plaud rejects mismatched redirect_uri).
  const redirectUri = getRedirectUri();

  // Build OAuth URL
  const authUrl = new URL(PLAUD_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', PLAUD_SCOPES);

  const completion = new Promise<PlaudOAuthResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuth) {
        pendingAuth = null;
        reject(new Error('Authorization timed out'));
      }
    }, 5 * 60 * 1000); // 5 minute timeout

    pendingAuth = { clientId, clientSecret, redirectUri, resolve, reject, timeout };
  });

  if (autoOpen) {
    // Open in system browser — reject on failure so the UI can show an error
    shell.openExternal(authUrl.toString()).then(() => {
      trackOAuthBrowserOpened({ connectorName: 'Plaud', connectorType: 'bundled', oauthUrl: authUrl.toString(), callbackMethod: 'deep_link' });
    }).catch((err) => {
      log.error({ err }, 'Failed to open browser for Plaud OAuth');
      if (pendingAuth) {
        clearTimeout(pendingAuth.timeout);
        pendingAuth.reject(new Error('Failed to open browser for authentication'));
        pendingAuth = null;
      }
    });
    log.info('Opened Plaud OAuth in system browser');
  } else {
    log.info({ authUrl: authUrl.toString() }, 'Generated Plaud OAuth URL (not auto-opening)');
  }

  return { authUrl: authUrl.toString(), completion };
}

/**
 * Handle the OAuth callback from the deep link.
 * Called from the protocol handler when mindstone://plaud/callback is received.
 */
export async function handlePlaudOAuthCallback(url: string): Promise<void> {
  if (!pendingAuth) {
    log.warn({ uptimeSeconds: Math.round(process.uptime()) },
      'Received Plaud OAuth callback but no auth is pending');
    return;
  }

  const { clientId, clientSecret, redirectUri, resolve, reject, timeout } = pendingAuth;
  clearTimeout(timeout);
  pendingAuth = null;

  try {
    const callbackUrl = new URL(url);
    const code = callbackUrl.searchParams.get('code');
    const error = callbackUrl.searchParams.get('error');

    if (error || !code) {
      throw new Error(error || 'No authorization code received');
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, clientId, clientSecret, redirectUri);

    // Fetch user info
    const user = await fetchPlaudUser(tokens.access_token);

    // Save account and tokens
    await savePlaudAccount(
      {
        userId: user.id,
        email: user.email,
        nickname: user.nickname,
        connectedAt: new Date().toISOString(),
      },
      tokens
    );

    // Bring app to foreground
    bringAppToForeground();

    log.info({ email: user.email }, 'Plaud OAuth completed successfully');
    resolve({ userId: user.id, email: user.email, nickname: user.nickname });
  } catch (err) {
    log.error({ err }, 'Plaud OAuth callback failed');
    reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Exchange authorization code for tokens.
 */
async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<PlaudTokens> {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(PLAUD_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const data = await response.json();

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

/**
 * Fetch current user info from Plaud API.
 */
async function fetchPlaudUser(accessToken: string): Promise<PlaudUser> {
  const response = await fetch(`${PLAUD_API_BASE}/users/current`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user info: ${response.status}`);
  }

  return response.json();
}

/**
 * Cancel pending auth.
 */
export function cancelPlaudAuth(): void {
  if (pendingAuth) {
    clearTimeout(pendingAuth.timeout);
    pendingAuth.reject(new Error('Authorization cancelled'));
    pendingAuth = null;
  }
}

// Config file paths
export const getPlaudConfigDir = () => path.join(app.getPath('userData'), 'mcp', 'plaud');
const getAccountPath = () => path.join(getPlaudConfigDir(), 'account.json');
const getTokenPath = () => path.join(getPlaudConfigDir(), 'tokens.json');
const getSyncStatePath = () => path.join(getPlaudConfigDir(), 'sync-state.json');

/**
 * Get the connected Plaud account, if any.
 */
export async function getPlaudAccount(): Promise<PlaudAccount | null> {
  try {
    const data = await fs.readFile(getAccountPath(), 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Save Plaud account and tokens.
 */
async function savePlaudAccount(account: PlaudAccount, tokens: PlaudTokens): Promise<void> {
  const configDir = getPlaudConfigDir();
  await fs.mkdir(configDir, { recursive: true });

  await fs.writeFile(getAccountPath(), JSON.stringify(account, null, 2), 'utf8');
  await fs.writeFile(getTokenPath(), JSON.stringify(tokens, null, 2), {
    encoding: 'utf8',
    mode: 0o600, // Secure permissions for tokens
  });

  log.info({ email: account.email }, 'Plaud account connected');
}

/**
 * Get stored tokens.
 */
export async function getPlaudTokens(): Promise<PlaudTokens | null> {
  try {
    const data = await fs.readFile(getTokenPath(), 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Save updated tokens (after refresh).
 */
async function saveTokens(tokens: PlaudTokens): Promise<void> {
  await fs.writeFile(getTokenPath(), JSON.stringify(tokens, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Ensure we have a valid access token, refreshing if needed.
 * Returns the access token or throws if not connected/refresh fails.
 */
export async function ensureValidToken(): Promise<string> {
  const tokens = await getPlaudTokens();
  if (!tokens) {
    throw new Error('Plaud not connected');
  }

  // Check if token expires in less than 5 minutes
  const bufferMs = 5 * 60 * 1000;
  if (tokens.expires_at > Date.now() + bufferMs) {
    return tokens.access_token;
  }

  // Refresh the token
  log.info('Refreshing Plaud access token');

  const response = await fetch(PLAUD_REFRESH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: `refresh_token=${tokens.refresh_token}`,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const data = await response.json();

  const newTokens: PlaudTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  await saveTokens(newTokens);
  log.info('Plaud access token refreshed');

  return newTokens.access_token;
}

/**
 * Disconnect Plaud (local cleanup only - no server revocation endpoint).
 */
export async function disconnectPlaud(): Promise<void> {
  const account = await getPlaudAccount();

  try {
    await fs.rm(getAccountPath());
  } catch {
    /* ignore */
  }

  try {
    await fs.rm(getTokenPath());
  } catch {
    /* ignore */
  }

  try {
    await fs.rm(getSyncStatePath());
  } catch {
    /* ignore */
  }

  log.info({ email: account?.email }, 'Plaud disconnected (local cleanup)');
}

/**
 * Check if Plaud is connected.
 */
export async function isPlaudConnected(): Promise<boolean> {
  const account = await getPlaudAccount();
  return account !== null;
}
