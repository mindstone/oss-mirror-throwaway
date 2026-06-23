/**
 * HubSpot Auth Service
 *
 * Handles OAuth2 authentication for HubSpot CRM.
 * Uses the same pattern as Google Workspace for consistency.
 *
 * Flow:
 * 1. Start loopback HTTP server on dynamic port
 * 2. Generate HubSpot OAuth URL with redirect to localhost
 * 3. Open system browser for OAuth consent
 * 4. Handle callback with authorization code
 * 5. Exchange code for tokens
 * 6. Save tokens in MCP-compatible format
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { app, shell } from 'electron';
import { createScopedLogger } from '@core/logger';
import { atomicCredentialWrite, sweepStaleTemps } from '@core/utils/atomicCredentialWrite';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { trackOAuthBrowserOpened, trackOAuthCallbackReceived } from './oauthTelemetry';
import { generateCsrfState, fetchWithTimeoutBestEffort } from './oauthPrimitives';
import { withAccountsAndEmailLock, withAccountsAndEmailLocks } from './hubspotCredentialLock';
import { deriveHubSpotAccountHash, emitHubSpotTelemetry } from './hubspotTelemetry';

const log = createScopedLogger({ service: 'hubspot-auth' });

// HubSpot OAuth URLs
const HUBSPOT_AUTH_URL = 'https://app.hubspot.com/oauth/authorize';
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const HUBSPOT_TOKEN_INFO_URL = 'https://api.hubapi.com/oauth/v1/access-tokens';
const HUBSPOT_TOKEN_SCHEMA_VERSION = 1;
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

// Scope tiers for HubSpot OAuth
export type HubSpotScopeTier = 'readonly' | 'full';

// ⚠️ KEEP IN SYNC with the HubSpot OSS connector's scope list at
// https://github.com/mindstone/mcp-servers/tree/main/connectors/hubspot
// (src/modules/accounts/oauth.ts). These scope arrays are duplicated because the OSS
// connector is published as a standalone npm package and cannot import from
// src/main/. When adding or removing scopes, update BOTH places.

// Base scopes required for all tiers
const HUBSPOT_BASE_SCOPES = [
  'oauth',
  'crm.objects.owners.read',
  'crm.schemas.contacts.read',
  'crm.schemas.companies.read',
  'crm.schemas.deals.read',
];

// Read-only scopes (safe for free HubSpot accounts)
const HUBSPOT_READ_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.companies.read',
  'crm.objects.deals.read',
  'crm.objects.products.read',
  'crm.objects.line_items.read',
  'crm.lists.read', // Lists/segments API - requires re-auth for existing users
];

// Optional scopes (requested via optional_scope; some require paid HubSpot)
const HUBSPOT_WRITE_SCOPES = [
  'crm.objects.contacts.write',
  'crm.objects.companies.write',
  'crm.objects.deals.write',
  'crm.objects.products.write',
  'crm.objects.line_items.write',
  'crm.objects.leads.read', // Leads API (Sales Hub Professional+)
  'crm.objects.leads.write',
  'files', // File manager: upload, manage, attach files to records
  'forms', // Read access to forms and submissions
  'tickets', // Service Hub feature
  'content', // Marketing Hub: analytics, marketing emails
  'automation', // Workflow read-only interrogation (v4 BETA) — in write array for optional_scope pattern
  'cms.knowledge_base.articles.read', // Knowledge Base article read via GraphQL (Service Hub Pro+)
  'collector.graphql_query.execute', // GraphQL API access (Content Hub Pro / Sales Hub Ent / Service Hub Ent)
  // FOX-3376 Conversations Inbox API (read ticket thread/message bodies). Lives in
  // optional_scope (not required-tier) so existing tokens without this scope keep
  // working — the connector handles missing scope at call time with SCOPE_MISSING.
  // ALSO REQUIRES: enable 'conversations.read' in the Mindstone HubSpot dev-portal
  // app config (App Settings → Auth → Scopes), or HubSpot rejects the install URL.
  'conversations.read',
];

// Full scope set (existing behavior)
const HUBSPOT_FULL_SCOPES = [
  ...HUBSPOT_BASE_SCOPES,
  ...HUBSPOT_READ_SCOPES,
  ...HUBSPOT_WRITE_SCOPES,
];

// Read-only scope set (for free accounts)
const HUBSPOT_READONLY_SCOPES = [
  ...HUBSPOT_BASE_SCOPES,
  ...HUBSPOT_READ_SCOPES,
];

/**
 * Get OAuth scopes for a given tier
 */
export function getScopesForTier(tier: HubSpotScopeTier = 'full'): string[] {
  return tier === 'readonly' ? HUBSPOT_READONLY_SCOPES : HUBSPOT_FULL_SCOPES;
}

export interface HubSpotAccount {
  email: string;
  hubId: number;
  portalId?: number;
  scopeTier?: 'readonly' | 'full';
  grantedScopes?: string[];
}

interface AccountsConfig {
  accounts: HubSpotAccount[];
}

interface TokenData {
  schemaVersion: number;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
  hub_id?: number;
  user?: string;
}

export class HubSpotAuthError extends Error {
  readonly code: 'ACCOUNT_NOT_FOUND';
  readonly email_hash?: string;

  constructor(message: string, details: { code: 'ACCOUNT_NOT_FOUND'; email_hash?: string }) {
    super(message);
    this.name = 'HubSpotAuthError';
    this.code = details.code;
    this.email_hash = details.email_hash;
  }
}

// Module state
let pendingAuth: {
  server: http.Server;
  resolve: (email: string) => void;
  reject: (error: Error) => void;
  state: string; // CSRF protection token
  consumed: boolean;
} | null = null;

/**
 * Get the HubSpot config directory.
 * Must match the path used by bundledMcpManager.ts: userData/mcp/hubspot
 */
function getConfigDir(): string {
  return path.join(app.getPath('userData'), 'mcp', 'hubspot');
}

/**
 * Get the credentials directory for token files
 */
function getCredentialsDir(): string {
  return path.join(getConfigDir(), 'credentials');
}

/**
 * Get accounts.json path
 */
function getAccountsPath(): string {
  return path.join(getConfigDir(), 'accounts.json');
}

/**
 * Sanitize email for use in filename
 */
function sanitizeEmail(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Get token file path for an account
 */
function getTokenPath(email: string): string {
  return path.join(getCredentialsDir(), `${sanitizeEmail(email)}.token.json`);
}

// HubSpot requires pre-registered redirect URLs with specific ports
// These are the ports configured in our HubSpot OAuth app settings
const HUBSPOT_CALLBACK_PORTS = [8081, 8082, 8083, 8084];

function withSecurityHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    ...SECURITY_HEADERS,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function redact(value: string): string {
  if (value.length <= 4) return '***';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

async function hashEmail(email: string): Promise<string> {
  return deriveHubSpotAccountHash(email);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return origin.startsWith('http://127.0.0.1:') || origin.startsWith('http://localhost:');
}

function generateHubSpotErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connection Failed - Rebel</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #e0e0e0;
      }
      .container { max-width: 480px; padding: 48px; text-align: center; }
      .rebel-icon {
        width: 80px; height: 80px; margin-bottom: 24px;
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        border-radius: 20px; display: inline-flex;
        align-items: center; justify-content: center;
        font-size: 40px;
        box-shadow: 0 8px 32px rgba(239, 68, 68, 0.3);
      }
      h1 { font-size: 28px; font-weight: 600; margin-bottom: 12px; color: #ffffff; }
      .subtitle { font-size: 16px; color: #a0a0a0; margin-bottom: 32px; line-height: 1.5; }
      .error-detail {
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.3);
        border-radius: 12px; padding: 16px;
        font-family: 'SF Mono', Monaco, monospace;
        font-size: 13px; color: #f87171;
      }
      .hint { font-size: 13px; color: #666; margin-top: 24px; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="rebel-icon">H</div>
      <h1>Well, that didn't work</h1>
      <p class="subtitle">HubSpot declined. Perhaps try again?</p>
      <div class="error-detail">${escapeHtml(message)}</div>
      <p class="hint">You can close this window.</p>
    </div>
  </body>
</html>`;
}

function generateHubSpotSuccessPage(code: string, state: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connected to HubSpot - Rebel</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #e0e0e0;
      }
      .container { max-width: 480px; padding: 48px; text-align: center; }
      .rebel-icon {
        width: 80px; height: 80px; margin-bottom: 24px;
        background: linear-gradient(135deg, #ff7a59 0%, #ff5c35 100%);
        border-radius: 20px; display: inline-flex;
        align-items: center; justify-content: center;
        font-size: 40px;
        box-shadow: 0 8px 32px rgba(255, 122, 89, 0.3);
      }
      h1 { font-size: 28px; font-weight: 600; margin-bottom: 12px; color: #ffffff; }
      .subtitle { font-size: 16px; color: #a0a0a0; margin-bottom: 32px; line-height: 1.5; }
      .status-card {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 16px; padding: 24px; margin-bottom: 24px;
      }
      .status-card.success {
        border-color: rgba(34, 197, 94, 0.3);
        background: rgba(34, 197, 94, 0.1);
      }
      .status-icon { font-size: 48px; margin-bottom: 16px; }
      .status-text { font-size: 18px; font-weight: 500; color: #ffffff; }
      .status-detail { font-size: 14px; color: #a0a0a0; margin-top: 8px; }
      .loading-spinner {
        display: inline-block; width: 20px; height: 20px;
        border: 2px solid rgba(255, 255, 255, 0.2);
        border-top-color: #ff7a59; border-radius: 50%;
        animation: spin 0.8s linear infinite;
        margin-left: 8px; vertical-align: middle;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .hint { font-size: 13px; color: #666; margin-top: 24px; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="rebel-icon">H</div>
      <h1>HubSpot Connected</h1>
      <p class="subtitle">Your CRM awaits. Time to get productive.</p>

      <div class="status-card" id="statusCard">
        <div class="status-icon" id="statusIcon">⏳</div>
        <div class="status-text" id="statusText">Finishing up<span class="loading-spinner"></span></div>
        <div class="status-detail" id="statusDetail">Securing the connection...</div>
      </div>

      <p class="hint" id="hint"></p>
    </div>

    <script>
      async function completeAuth() {
        try {
          const response = await fetch('/complete-auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: ${JSON.stringify(code)}, state: ${JSON.stringify(state)} }),
          });

          if (response.ok) {
            document.getElementById('statusCard').classList.add('success');
            document.getElementById('statusIcon').textContent = '✓';
            document.getElementById('statusText').innerHTML = 'All set';
            document.getElementById('statusDetail').textContent = 'You can close this window and return to Rebel.';
            document.getElementById('hint').textContent = 'Contacts, companies, deals, and more are now at your service.';
          } else {
            throw new Error('Failed');
          }
        } catch {
          document.getElementById('statusIcon').textContent = '⚠';
          document.getElementById('statusText').innerHTML = 'Minor hiccup';
          document.getElementById('statusDetail').textContent = 'Please try again or contact support.';
        }
      }
      setTimeout(completeAuth, 500);
    </script>
  </body>
</html>`;
}

async function ensureConfigDir(): Promise<void> {
  const configDir = getConfigDir();
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await fs.chmod(configDir, 0o700);
  }
}

async function ensureCredentialsDir(): Promise<void> {
  const credentialsDir = getCredentialsDir();
  await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await fs.chmod(credentialsDir, 0o700);
  }
}

/**
 * Load accounts from accounts.json
 */
async function loadAccounts(): Promise<AccountsConfig> {
  const accountsPath = getAccountsPath();
  try {
    const data = await fs.readFile(accountsPath, 'utf-8');
    return JSON.parse(data) as AccountsConfig;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return { accounts: [] };
    }
    log.error({ accountsPath, err: error }, 'Failed to load HubSpot accounts');
    throw error;
  }
}

/**
 * Save accounts to accounts.json
 */
async function saveAccounts(
  config: AccountsConfig,
  options: { lockEmail?: string; lockAlreadyHeld?: boolean } = {},
): Promise<void> {
  const persist = async () => {
    await ensureConfigDir();
    await sweepStaleTemps(getConfigDir());
    await atomicCredentialWrite(getAccountsPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
  };

  if (options.lockAlreadyHeld) {
    await persist();
    return;
  }

  const lockEmails = options.lockEmail
    ? [options.lockEmail]
    : config.accounts.map((account) => account.email);
  await withAccountsAndEmailLocks(lockEmails, persist);
}

/**
 * Save token for an account
 */
async function saveToken(
  email: string,
  tokenData: TokenData,
  options: {
    lockAlreadyHeld?: boolean;
    mutateAccounts?: (config: AccountsConfig) => AccountsConfig | Promise<AccountsConfig>;
  } = {},
): Promise<void> {
  const persistToken = async () => {
    await ensureCredentialsDir();
    await sweepStaleTemps(getCredentialsDir());
    const persistedToken: TokenData = {
      ...tokenData,
      schemaVersion: HUBSPOT_TOKEN_SCHEMA_VERSION,
    };
    await atomicCredentialWrite(getTokenPath(email), JSON.stringify(persistedToken, null, 2), { mode: 0o600 });
  };

  const persistTokenAndAccounts = async () => {
    await persistToken();
    if (!options.mutateAccounts) {
      return;
    }
    const config = await loadAccounts();
    const updatedConfig = await options.mutateAccounts(config);
    await saveAccounts(updatedConfig, { lockEmail: email, lockAlreadyHeld: true });
  };

  if (options.lockAlreadyHeld) {
    await persistTokenAndAccounts();
    return;
  }

  await withAccountsAndEmailLock(email, persistTokenAndAccounts);
}

/**
 * Load token for an account
 */
async function loadToken(email: string): Promise<TokenData | null> {
  const tokenPath = getTokenPath(email);
  const accountHash = await hashEmail(email);
  let data: string;
  try {
    data = await fs.readFile(tokenPath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return null;
    }
    log.error({ accountHash, err: error }, 'Failed to read HubSpot token (unexpected error)');
    throw error;
  }

  let parsed: Partial<TokenData>;
  try {
    parsed = JSON.parse(data) as Partial<TokenData>;
  } catch (error) {
    log.error({ accountHash, err: error }, 'Failed to parse HubSpot token (corrupt JSON)');
    throw error;
  }
  const schemaVersion = parsed.schemaVersion;

  if (typeof schemaVersion === 'number' && schemaVersion > HUBSPOT_TOKEN_SCHEMA_VERSION) {
    throw new Error(`Unsupported HubSpot token schema version: ${schemaVersion}`);
  }

  return {
    ...parsed,
    schemaVersion: HUBSPOT_TOKEN_SCHEMA_VERSION,
  } as TokenData;
}

/**
 * Delete token for an account
 */
async function deleteToken(email: string): Promise<void> {
  try {
    await fs.unlink(getTokenPath(email));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return;
    }
    const accountHash = await hashEmail(email);
    log.error({ accountHash, err: error }, 'Failed to delete HubSpot token');
    throw error;
  }
}

/**
 * Revoke a HubSpot OAuth refresh token with the provider.
 *
 * Best-effort operation: logs success/failure but never throws.
 * Uses 5-second timeout to prevent UI hangs.
 *
 * Note: HubSpot does NOT cascade revocation to access tokens - they remain
 * valid until natural expiry (~30 min). This is a known HubSpot limitation.
 *
 * @see https://developers.hubspot.com/docs/api/oauth/tokens#delete-refresh-token
 */
async function revokeHubSpotToken(refreshToken: string): Promise<void> {
  // URL-encode the token before putting in path
  const encodedToken = encodeURIComponent(refreshToken);
  const response = await fetchWithTimeoutBestEffort(
    `https://api.hubapi.com/oauth/v1/refresh-tokens/${encodedToken}`,
    { method: 'DELETE', timeoutMs: 5000 }
  );

  if (response?.ok || response?.status === 204) {
    log.info('HubSpot OAuth refresh token revoked successfully');
  } else if (response) {
    log.warn({ status: response.status }, 'HubSpot token revocation returned non-OK status');
  }
  // null response means timeout or network error - already logged by fetchWithTimeoutBestEffort
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<TokenData> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });

  const response = await fetch(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return {
    schemaVersion: HUBSPOT_TOKEN_SCHEMA_VERSION,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    expires_at: Date.now() + data.expires_in * 1000,
    token_type: data.token_type,
  };
}

/**
 * Get user info and granted scopes from access token.
 * The HubSpot token info API returns which scopes were actually granted,
 * which may be a subset of what was requested (when using optional_scope).
 */
async function getTokenInfo(accessToken: string): Promise<{ user: string; hub_id: number; scopes: string[] }> {
  const response = await fetch(`${HUBSPOT_TOKEN_INFO_URL}/${accessToken}`);
  
  if (!response.ok) {
    throw new Error(`Failed to get token info: ${response.status}`);
  }
  
  const data = await response.json();
  return {
    user: data.user,
    hub_id: data.hub_id,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
  };
}

/**
 * Get all connected HubSpot accounts with their status
 */
export async function getHubSpotAccounts(): Promise<Array<{
  email: string;
  hubId: number;
  status: 'active' | 'expired' | 'error';
  scopeTier?: 'readonly' | 'full';
  grantedScopes?: string[];
}>> {
  const config = await loadAccounts();
  const results = [];

  for (const account of config.accounts) {
    const token = await loadToken(account.email);
    let status: 'active' | 'expired' | 'error' = 'error';

    if (token) {
      // Use 5-minute buffer to match MCP auto-refresh logic
      const bufferMs = 5 * 60 * 1000;
      const isValid = token.expires_at > (Date.now() + bufferMs);
      
      if (isValid) {
        status = 'active';
      } else if (token.refresh_token) {
        // Token expired but has refresh_token - MCP will auto-refresh on next use
        status = 'active';
      } else {
        status = 'expired';
      }
    }

    results.push({
      email: account.email,
      hubId: account.hubId,
      status,
      scopeTier: await getStoredScopeTier(account.email),
      grantedScopes: account.grantedScopes,
    });
  }

  return results;
}

/**
 * Remove a HubSpot account
 */
export async function removeHubSpotAccount(email: string): Promise<void> {
  const accountHash = await hashEmail(email);
  log.info({ accountHash }, 'Removing HubSpot account');

  // Load token BEFORE any deletion (required for revocation)
  const tokenData = await loadToken(email);

  // Best-effort revocation - fire and forget, don't block on result
  // Only revoke if refresh_token exists (HubSpot only supports revoking refresh tokens)
  if (tokenData?.refresh_token) {
    // Don't await - proceed with deletion regardless
    fireAndForget(revokeHubSpotToken(tokenData.refresh_token), 'hubspotAuthService.line673');
  }

  await withAccountsAndEmailLock(email, async () => {
    // Delete token file
    await deleteToken(email);

    // Remove from accounts.json
    const config = await loadAccounts();
    config.accounts = config.accounts.filter((a) => a.email !== email);
    await saveAccounts(config, { lockEmail: email, lockAlreadyHeld: true });
  });

  log.info({ accountHash }, 'HubSpot account removed');
}

export async function getStoredScopeTier(email: string | undefined): Promise<HubSpotScopeTier> {
  const envTier = process.env.HUBSPOT_SCOPE_TIER;
  if (envTier === 'readonly' || envTier === 'full') {
    return envTier;
  }

  const config = await loadAccounts();
  if (!email) {
    return config.accounts[0]?.scopeTier ?? 'full';
  }

  const account = config.accounts.find((entry) => entry.email === email);
  if (!account) {
    const emailHash = await hashEmail(email);
    throw new HubSpotAuthError(
      `getStoredScopeTier: account not found for email=${redact(email)}; refusing to silently default to 'full' (would escalate consent).`,
      { code: 'ACCOUNT_NOT_FOUND', email_hash: emailHash }
    );
  }

  return account.scopeTier ?? 'full';
}

/**
 * Cancel any pending OAuth flow
 */
export function cancelHubSpotAuth(): void {
  if (pendingAuth) {
    log.info('Cancelling pending HubSpot auth');
    pendingAuth.server.close();
    pendingAuth.reject(new Error('Auth cancelled by user'));
    pendingAuth = null;
  }
}

/**
 * Start OAuth flow for a new HubSpot account
 * @param clientId - OAuth client ID
 * @param clientSecret - OAuth client secret
 * @param scopeTier - Scope tier for OAuth: 'readonly' (for restricted/free accounts) or 'full' (default).
 *   Controls both the OAuth scopes requested AND the MCP tool filtering (see server.ts).
 */
export async function startHubSpotAuth(
  clientId: string,
  clientSecret: string,
  scopeTier: HubSpotScopeTier = 'full',
  options: { targetEmail?: string; returnMode?: 'email' | 'authUrl' } = {},
): Promise<string> {
  const targetEmailHash = options.targetEmail ? await hashEmail(options.targetEmail) : undefined;
  log.info({ scopeTier, targetEmailHash }, 'Starting HubSpot OAuth flow');

  // Cancel any pending auth
  if (pendingAuth) {
    pendingAuth.server.close();
    pendingAuth.reject(new Error('Auth cancelled - new auth started'));
    pendingAuth = null;
  }

  return new Promise((resolve, reject) => {
    let redirectUri: string;

    // Create loopback server
    const server = http.createServer((req, res) => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (requestUrl.pathname === '/callback' && req.method === 'GET') {
        const code = requestUrl.searchParams.get('code');
        const error = requestUrl.searchParams.get('error');
        const returnedState = requestUrl.searchParams.get('state');

        if (error) {
          const errorMessage = `HubSpot OAuth error: ${error}`;
          log.error({ error }, 'OAuth error from HubSpot');
          emitHubSpotTelemetry({
            event: 'hubspot.auth_required.callback_failed',
            errorCode: 'oauth_error',
            accountEmail: options.targetEmail,
          }).catch((err) => {
            log.error({ err }, 'hubspot.telemetry_emit_failed');
          });
          res.writeHead(400, withSecurityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
          res.end(generateHubSpotErrorPage(error));
          trackOAuthCallbackReceived({ connectorName: 'HubSpot', success: false, errorMessage: error });
          server.close();
          pendingAuth = null;
          reject(new Error(errorMessage));
          return;
        }

        if (!returnedState || returnedState !== pendingAuth?.state) {
          log.error(
            { returnedState, expectedState: pendingAuth?.state ? '[present]' : '[missing]' },
            '[SECURITY] OAuth state mismatch - possible CSRF attack'
          );
          res.writeHead(400, withSecurityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
          res.end(generateHubSpotErrorPage('Security validation failed - please try again'));
          trackOAuthCallbackReceived({
            connectorName: 'HubSpot',
            success: false,
            errorMessage: 'OAuth state mismatch',
          });
          emitHubSpotTelemetry({
            event: 'hubspot.auth_required.callback_failed',
            errorCode: 'state_mismatch',
            accountEmail: options.targetEmail,
          }).catch((err) => {
            log.error({ err }, 'hubspot.telemetry_emit_failed');
          });
          server.close();
          pendingAuth = null;
          reject(new Error('OAuth state mismatch - possible CSRF attack'));
          return;
        }

        if (!code) {
          log.error('No authorization code received');
          res.writeHead(400, withSecurityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
          res.end(generateHubSpotErrorPage('No authorization code received'));
          trackOAuthCallbackReceived({
            connectorName: 'HubSpot',
            success: false,
            errorMessage: 'No authorization code received',
          });
          emitHubSpotTelemetry({
            event: 'hubspot.auth_required.callback_failed',
            errorCode: 'missing_code',
            accountEmail: options.targetEmail,
          }).catch((err) => {
            log.error({ err }, 'hubspot.telemetry_emit_failed');
          });
          server.close();
          pendingAuth = null;
          reject(new Error('No authorization code received'));
          return;
        }

        res.writeHead(200, withSecurityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
        res.end(generateHubSpotSuccessPage(code, returnedState));
        return;
      }

      if (requestUrl.pathname === '/complete-auth' && req.method === 'POST') {
        const contentTypeHeader = req.headers['content-type'];
        const contentType = Array.isArray(contentTypeHeader) ? (contentTypeHeader[0] ?? '') : (contentTypeHeader ?? '');
        if (!contentType.includes('application/json')) {
          res.writeHead(400, withSecurityHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ success: false, error: 'Invalid content type' }));
          return;
        }

        const originHeader = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
        if (!isAllowedOrigin(originHeader)) {
          res.writeHead(403, withSecurityHeaders({ 'Content-Type': 'application/json' }));
          res.end(JSON.stringify({ success: false, error: 'Forbidden' }));
          return;
        }

        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          fireAndForget((async () => {
          try {
            const payload = JSON.parse(body) as { code?: string; state?: string };
            const code = payload.code;
            const state = payload.state;

            if (!code || !state || state !== pendingAuth?.state || pendingAuth?.consumed) {
              res.writeHead(400, withSecurityHeaders({ 'Content-Type': 'application/json' }));
              res.end(JSON.stringify({ success: false, error: 'Invalid or expired security token' }));
              return;
            }

            pendingAuth.consumed = true;

            log.info('Exchanging authorization code for tokens');
            const tokenData = await exchangeCodeForTokens(code, clientId, clientSecret, redirectUri);
            const userInfo = await getTokenInfo(tokenData.access_token);
            const email = userInfo.user;
            const hubId = userInfo.hub_id;
            const grantedScopes = userInfo.scopes;

            tokenData.user = email;
            tokenData.hub_id = hubId;
            tokenData.schemaVersion = HUBSPOT_TOKEN_SCHEMA_VERSION;
            await saveToken(email, tokenData, {
              mutateAccounts: async (config) => {
                const existingIndex = config.accounts.findIndex((entry) => entry.email === email);
                if (existingIndex >= 0) {
                  config.accounts[existingIndex].hubId = hubId;
                  config.accounts[existingIndex].scopeTier = scopeTier;
                  config.accounts[existingIndex].grantedScopes = grantedScopes;
                } else {
                  config.accounts.push({ email, hubId, scopeTier, grantedScopes });
                }
                return config;
              },
            });

            const accountHash = await hashEmail(email);
            log.info({ accountHash, hubId }, 'HubSpot account connected successfully');
            trackOAuthCallbackReceived({ connectorName: 'HubSpot', success: true });
            emitHubSpotTelemetry({
              event: 'hubspot.auth_required.callback_success',
              accountEmail: email,
            }).catch((err) => {
              log.error({ err }, 'hubspot.telemetry_emit_failed');
            });

            res.writeHead(200, withSecurityHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ success: true, email }));
            server.close();
            pendingAuth = null;
            if (options.returnMode !== 'authUrl') {
              resolve(email);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            log.error({ error: err }, 'Failed to complete OAuth flow');
            trackOAuthCallbackReceived({
              connectorName: 'HubSpot',
              success: false,
              errorMessage: message,
            });
            emitHubSpotTelemetry({
              event: 'hubspot.auth_required.callback_failed',
              errorCode: 'callback_exchange_failed',
              accountEmail: options.targetEmail,
            }).catch((err) => {
              log.error({ err }, 'hubspot.telemetry_emit_failed');
            });
            res.writeHead(500, withSecurityHeaders({ 'Content-Type': 'application/json' }));
            res.end(JSON.stringify({ success: false, error: message }));
            server.close();
            pendingAuth = null;
            reject(err instanceof Error ? err : new Error(message));
          }
          })(), 'hubspotAuth.completeAuth');
        });
        return;
      }

      res.writeHead(404, withSecurityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
      res.end('<html><body><h1>Not found</h1></body></html>');
    });

    // Try each registered callback port until one is available
    const tryListenOnPort = (portIndex: number) => {
      if (portIndex >= HUBSPOT_CALLBACK_PORTS.length) {
        reject(new Error('All HubSpot callback ports (8081-8084) are in use. Please close other applications using these ports.'));
        return;
      }

      const port = HUBSPOT_CALLBACK_PORTS[portIndex];
      
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          log.warn({ port }, 'Port in use, trying next port');
          server.removeListener('error', onError);
          tryListenOnPort(portIndex + 1);
        } else {
          log.error({ error: err }, 'OAuth server error');
          pendingAuth = null;
          reject(err);
        }
      };

      server.once('error', onError);

      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        redirectUri = `http://localhost:${port}/callback`;

        log.info({ port }, 'OAuth callback server started');

        // Generate CSRF protection state token
        const state = generateCsrfState();

        // Generate auth URL with required scopes + optional scopes.
        // optional_scope allows HubSpot to grant only the scopes the user has access to,
        // instead of failing the entire OAuth flow for restricted users.
        const authParams = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: [...HUBSPOT_BASE_SCOPES, ...HUBSPOT_READ_SCOPES].join(' '),
          optional_scope: HUBSPOT_WRITE_SCOPES.join(' '),
          response_type: 'code',
          state, // CSRF protection
        });
        const authUrl = `${HUBSPOT_AUTH_URL}?${authParams.toString()}`;

        // Save pending auth state
        pendingAuth = {
          server,
          resolve,
          reject,
          state,
          consumed: false,
        };

        // Open browser
        shell.openExternal(authUrl).then(() => {
          trackOAuthBrowserOpened({ connectorName: 'HubSpot', connectorType: 'bundled', oauthUrl: authUrl, callbackMethod: 'localhost' });
          if (options.returnMode === 'authUrl') {
            resolve(authUrl);
          }
        }).catch((err) => {
          log.error({ error: err }, 'Failed to open browser');
          server.close();
          pendingAuth = null;
          reject(new Error('Failed to open browser for authentication'));
        });
      });
    };

    // Start trying ports
    tryListenOnPort(0);

    // General error handler for non-port errors
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') {
        log.error({ error: err }, 'OAuth server error');
        pendingAuth = null;
        reject(err);
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (pendingAuth?.server === server) {
        log.warn('OAuth flow timed out');
        server.close();
        pendingAuth = null;
        reject(new Error('OAuth flow timed out'));
      }
    }, OAUTH_TIMEOUT_MS);
  });
}

/**
 * Get the config directory path (for MCP environment variable)
 */
export function getHubSpotConfigDir(): string {
  return getConfigDir();
}

/**
 * Get a valid access token for an account (refreshing if needed)
 */
export async function getHubSpotAccessToken(email: string): Promise<string | null> {
  const token = await loadToken(email);
  if (!token) {
    return null;
  }

  // Check if token is expired and needs refresh
  if (token.expires_at < Date.now() && token.refresh_token) {
    const accountHash = await hashEmail(email);
    log.info({ accountHash }, 'Refreshing expired HubSpot token');
    // Token refresh would need client credentials - for now, return null to trigger re-auth
    // In production, you'd store client_id/secret securely and refresh here
    return null;
  }

  return token.access_token;
}

export const _testOnly = {
  getConfigDir,
  getCredentialsDir,
  getAccountsPath,
  getTokenPath,
  loadAccounts,
  saveAccounts,
  loadToken,
  saveToken,
  deleteToken,
  generateHubSpotErrorPage,
  generateHubSpotSuccessPage,
} as const;
