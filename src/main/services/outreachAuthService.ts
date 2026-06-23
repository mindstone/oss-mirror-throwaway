/**
 * Outreach Auth Service
 *
 * Handles OAuth2 authentication for Outreach sales engagement platform.
 * Uses system browser + deep link callback pattern (like Salesforce).
 *
 * Flow:
 * 1. User provides Client ID + Client Secret (Outreach requires app registration)
 * 2. Generate OAuth URL with state parameter
 * 3. Open system browser for OAuth consent
 * 4. Cloudflare redirects to mindstone://outreach/callback with code
 * 5. Exchange code for tokens, save in MCP-compatible format
 */

import { URL } from 'node:url';
import _crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { app, shell } from 'electron';
import { createScopedLogger } from '@core/logger';
import { trackOAuthBrowserOpened } from './oauthTelemetry';
import {
  generateCsrfState,
  bringAppToForeground,
} from './oauthPrimitives';

const log = createScopedLogger({ service: 'outreach-auth' });

const OUTREACH_AUTH_URL = 'https://api.outreach.io/oauth/authorize';
const OUTREACH_TOKEN_URL = 'https://api.outreach.io/oauth/token';

const OUTREACH_SCOPES = [
  'prospects.all',
  'sequences.all',
  'sequenceStates.all',
  'accounts.all',
  'mailings.read',
  'tasks.all',
  'users.read',
];

const REDIRECT_URI = 'https://rebel-auth.mindstone.com/outreach/callback';

interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  created_at: number;
  expires_at?: number;
  username?: string;
}

interface OutreachAccount {
  id: string;
  username: string;
  connected_at: string;
}

interface AccountsConfig {
  accounts: OutreachAccount[];
}

let pendingAuth: {
  clientId: string;
  clientSecret: string;
  state: string;
  resolve: (username: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
} | null = null;

function getConfigDir(): string {
  return path.join(app.getPath('userData'), 'mcp', 'outreach');
}

function getCredentialsDir(): string {
  return path.join(getConfigDir(), 'credentials');
}

function getAccountsPath(): string {
  return path.join(getConfigDir(), 'accounts.json');
}

function sanitizeUsername(username: string): string {
  return username.replace(/[^a-zA-Z0-9]/g, '-');
}

function getTokenPath(username: string): string {
  return path.join(getCredentialsDir(), `${sanitizeUsername(username)}.token.json`);
}

async function loadAccounts(): Promise<AccountsConfig> {
  try {
    const data = await fs.readFile(getAccountsPath(), 'utf-8');
    return JSON.parse(data) as AccountsConfig;
  } catch {
    return { accounts: [] };
  }
}

async function saveAccounts(config: AccountsConfig): Promise<void> {
  await fs.mkdir(getConfigDir(), { recursive: true });
  await fs.writeFile(getAccountsPath(), JSON.stringify(config, null, 2));
}

async function saveToken(username: string, tokenData: TokenData): Promise<void> {
  await fs.mkdir(getCredentialsDir(), { recursive: true });
  await fs.writeFile(getTokenPath(username), JSON.stringify(tokenData, null, 2), { mode: 0o600 });
}

async function deleteToken(username: string): Promise<void> {
  try { await fs.unlink(getTokenPath(username)); } catch { /* ignore */ }
}

async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string
): Promise<TokenData> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    code,
  });

  const response = await fetch(OUTREACH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (errorText.includes('invalid_client')) {
      throw new Error(
        `Outreach OAuth failed: invalid client credentials. ` +
        `Ensure your Client ID and Client Secret are correct and the app redirect URI is: ${REDIRECT_URI}`
      );
    }
    if (errorText.includes('invalid_grant')) {
      throw new Error('Authorization code expired or already used. Please try connecting again.');
    }
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in || 7200,
    scope: data.scope,
    created_at: data.created_at || Math.floor(Date.now() / 1000),
    expires_at: Date.now() + (data.expires_in || 7200) * 1000,
  };
}

async function getUserInfo(accessToken: string): Promise<{ email: string; id: number }> {
  const response = await fetch('https://api.outreach.io/api/v2/users/me', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/vnd.api+json',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to get user info: ${response.status}`);
  }
  const data = await response.json();
  const attrs = data.data?.attributes || {};
  return {
    email: attrs.email || attrs.username || 'unknown',
    id: data.data?.id,
  };
}

export async function getOutreachAccounts(): Promise<Array<{
  username: string;
  status: 'active' | 'expired' | 'error';
}>> {
  const config = await loadAccounts();
  const results = [];
  for (const account of config.accounts) {
    try {
      const data = await fs.readFile(getTokenPath(account.username), 'utf-8');
      const token = JSON.parse(data) as TokenData;
      const hasRefresh = !!token.refresh_token;
      const isValid = (token.expires_at || 0) > Date.now();
      const status: 'active' | 'expired' = isValid || hasRefresh ? 'active' : 'expired';
      results.push({ username: account.username, status });
    } catch {
      results.push({ username: account.username, status: 'error' as const });
    }
  }
  return results;
}

export async function removeOutreachAccount(username: string): Promise<void> {
  log.info({ username }, 'Removing Outreach account');
  await deleteToken(username);
  const config = await loadAccounts();
  config.accounts = config.accounts.filter(a => a.username !== username);
  await saveAccounts(config);
  log.info({ username }, 'Outreach account removed');
}

export function cancelOutreachAuth(): void {
  if (pendingAuth) {
    log.info('Cancelling pending Outreach auth');
    clearTimeout(pendingAuth.timeout);
    pendingAuth.reject(new Error('Auth cancelled by user'));
    pendingAuth = null;
  }
}

export async function startOutreachAuth(
  clientId: string,
  clientSecret: string
): Promise<string> {
  cancelOutreachAuth();

  return new Promise((resolve, reject) => {
    const state = generateCsrfState();

    const authUrl = new URL(OUTREACH_AUTH_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('scope', OUTREACH_SCOPES.join(' '));
    authUrl.searchParams.set('state', state);

    const timeout = setTimeout(() => {
      if (pendingAuth) {
        pendingAuth = null;
        reject(new Error('Authorization timed out'));
      }
    }, 5 * 60 * 1000);

    pendingAuth = { clientId, clientSecret, state, resolve, reject, timeout };

    shell.openExternal(authUrl.toString()).then(() => {
      trackOAuthBrowserOpened({ connectorName: 'Outreach', connectorType: 'bundled', oauthUrl: authUrl.toString(), callbackMethod: 'deep_link' });
    }).catch((err) => {
      log.error({ err }, 'Failed to open browser for Outreach OAuth');
      clearTimeout(timeout);
      pendingAuth = null;
      reject(new Error('Failed to open browser for authentication'));
    });
    log.info('Opened Outreach OAuth in system browser');
  });
}

export async function handleOutreachOAuthCallback(url: string): Promise<void> {
  if (!pendingAuth) {
    log.warn({ uptimeSeconds: Math.round(process.uptime()) },
      'Received Outreach OAuth callback but no auth is pending');
    return;
  }

  const { clientId, clientSecret, state, resolve, reject, timeout } = pendingAuth;
  clearTimeout(timeout);
  pendingAuth = null;

  try {
    const callbackUrl = new URL(url);
    const code = callbackUrl.searchParams.get('code');
    const error = callbackUrl.searchParams.get('error');
    const errorDescription = callbackUrl.searchParams.get('error_description');
    const returnedState = callbackUrl.searchParams.get('state');

    if (!returnedState || returnedState !== state) {
      log.error({ returnedState, expectedState: '[present]' },
        '[SECURITY] OAuth state mismatch - possible CSRF attack');
      throw new Error('OAuth state mismatch - possible CSRF attack');
    }

    if (error || !code) {
      if (error === 'access_denied') {
        throw new Error('Access was denied. Ask your Outreach admin for API access.');
      }
      throw new Error(errorDescription ?? error ?? 'No authorization code received');
    }

    log.info('Exchanging code for tokens');
    const tokenData = await exchangeCodeForTokens(code, clientId, clientSecret);

    const userInfo = await getUserInfo(tokenData.access_token);
    const username = userInfo.email;

    if (!username) {
      throw new Error('Could not determine username from token');
    }

    tokenData.username = username;
    await saveToken(username, tokenData);

    const config = await loadAccounts();
    const existingIndex = config.accounts.findIndex(a => a.username === username);
    const accountEntry = { id: sanitizeUsername(username), username, connected_at: new Date().toISOString() };
    if (existingIndex >= 0) {
      config.accounts[existingIndex] = accountEntry;
    } else {
      config.accounts.push(accountEntry);
    }
    await saveAccounts(config);

    bringAppToForeground();

    log.info({ username }, 'Outreach OAuth completed successfully');
    resolve(username);
  } catch (err) {
    log.error({ err }, 'Outreach OAuth callback failed');
    reject(err instanceof Error ? err : new Error(String(err)));
  }
}

export function getOutreachConfigDir(): string {
  return getConfigDir();
}
