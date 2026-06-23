/**
 * Salesforce Auth Service
 *
 * Handles OAuth2 authentication for Salesforce CRM.
 * Uses system browser + deep link callback pattern (like Microsoft/Slack).
 *
 * Flow:
 * 1. Generate Salesforce OAuth URL with PKCE and Cloudflare redirect
 * 2. Open system browser for OAuth consent
 * 3. Cloudflare redirects to mindstone://salesforce/callback with code
 * 4. App handles deep link, exchanges code for tokens via PKCE
 * 5. Save tokens in MCP-compatible format
 */

import { URL } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { app, shell } from 'electron';
import { createScopedLogger } from '@core/logger';
import { getOAuthRedirectUri } from '@core/services/oauthRedirectUri';
import { trackOAuthBrowserOpened } from './oauthTelemetry';
import { getSettings } from '@core/services/settingsStore';
import {
  generateCsrfState,
  fetchWithTimeoutBestEffort,
  bringAppToForeground,
} from './oauthPrimitives';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'salesforce-auth' });

// Salesforce OAuth URL helpers — sandbox uses test.salesforce.com
function getSalesforceLoginUrl(): string {
  const settings = getSettings();
  const environment = (settings.salesforce as { environment?: string } | undefined)?.environment;
  return environment === 'sandbox'
    ? 'https://test.salesforce.com'
    : 'https://login.salesforce.com';
}

function getSalesforceAuthUrl(): string {
  return `${getSalesforceLoginUrl()}/services/oauth2/authorize`;
}

function getSalesforceTokenUrl(): string {
  return `${getSalesforceLoginUrl()}/services/oauth2/token`;
}

// Salesforce OAuth scopes
const SALESFORCE_SCOPES = [
  'api',
  'refresh_token',
  'offline_access',
];

/**
 * Salesforce account shape persisted to `accounts.json`.
 *
 * **MUST stay byte-compatible with the OSS package's `SalesforceAccount`**
 * (`@mindstone-engineering/mcp-server-salesforce` — `dist/types.d.ts`). The host
 * writes this file; the spawned MCP child reads it via `loadAccounts()` and
 * then loads each account's token by `id` (NOT username). Any drift here
 * (camelCase, missing `id`, etc.) causes `getActiveToken()` to fail with
 * `NO_CREDENTIALS` and `salesforce_list_connected_accounts` to report every
 * account as `expired` even when tokens are fresh on disk.
 *
 * Locked by regression test `salesforceAuthService.ossSchema.test.ts`.
 */
export interface SalesforceAccount {
  id: string;
  username: string;
  instance_url: string;
  is_sandbox: boolean;
  connected_at: string;
  organization_id?: string;
}

interface AccountsConfig {
  accounts: SalesforceAccount[];
}

/**
 * Legacy account shape written by builds before 2026-04-30. Kept here only
 * so `loadAccounts()` can migrate-on-read (and thus heal accounts.json
 * silently on the next save).
 */
interface LegacySalesforceAccountShape {
  id?: string;
  username?: string;
  instance_url?: string;
  instanceUrl?: string;
  organizationId?: string;
  organization_id?: string;
  is_sandbox?: boolean;
  connected_at?: string;
}

interface TokenData {
  access_token: string;
  refresh_token: string;
  instance_url: string;
  id: string;
  issued_at: string;
  signature: string;
  expires_at?: number;
  username?: string;
  organization_id?: string;
  login_url?: string;
}

// Redirect URI - Cloudflare redirects this to mindstone://salesforce/callback
const getRedirectUri = () => getOAuthRedirectUri('salesforce');

// Module state for pending OAuth
let pendingAuth: {
  clientId: string;
  clientSecret: string;
  codeVerifier: string;
  state: string; // CSRF protection token
  redirectUri: string; // snapshotted at auth start; reused at token exchange to prevent env mutation drift
  resolve: (username: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
} | null = null;

/**
 * Get the Salesforce config directory.
 * Must match bundledMcpManager.ts: userData/mcp/salesforce
 */
function getConfigDir(): string {
  return path.join(app.getPath('userData'), 'mcp', 'salesforce');
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
 * Sanitize a name for use as the OSS-package's account id and token filename.
 *
 * **MUST match the OSS package's `sanitizeFilename` regex byte-for-byte**
 * (`@mindstone-engineering/mcp-server-salesforce` — `dist/auth.js`). The OSS
 * regex preserves `.`, `_`, and `-`. Any drift means the host writes token
 * files at one path while the MCP child looks for them at another → null
 * token → `getActiveToken()` throws `NO_CREDENTIALS`.
 *
 * Locked by regression test `salesforceAuthService.ossSchema.test.ts`.
 */
function sanitizeAccountId(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * The host's pre-2026-04-30 sanitizer (stricter — also stripped `.`).
 * Retained ONLY to migrate legacy token files written under that scheme.
 */
function legacyHostSanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Derive a stable, OSS-compatible account id from a username.
 *
 * The same accountId is used in three places:
 *   1. `accounts.json`'s `id` field (read by OSS `loadAccounts()`)
 *   2. The token filename (read by OSS `loadToken(accountId)`)
 *   3. All host-side internal lookups
 */
function deriveAccountId(username: string): string {
  return sanitizeAccountId(username);
}

/**
 * Get token file path for an account, keyed by accountId (NOT username).
 *
 * Callers must pass an accountId (already sanitized via `deriveAccountId`).
 * The extra `sanitizeAccountId` call here is defence-in-depth — a no-op for
 * a well-formed accountId but keeps us safe if a stale legacy username
 * accidentally leaks in.
 */
function getTokenPath(accountId: string): string {
  return path.join(getCredentialsDir(), `${sanitizeAccountId(accountId)}.token.json`);
}

function isSandboxFromUrl(instanceUrl: string | undefined): boolean {
  if (!instanceUrl) return false;
  return /(\.sandbox\.|test\.salesforce\.com)/i.test(instanceUrl);
}

/**
 * Migrate a legacy accounts.json entry to the OSS-compatible shape.
 * Called from `loadAccounts()`; resulting accounts get persisted on next save.
 */
function normalizeAccount(
  raw: LegacySalesforceAccountShape,
  fallbackTimestamp: string
): SalesforceAccount {
  const username = raw.username ?? '';
  const instanceUrl = raw.instance_url ?? raw.instanceUrl ?? '';
  return {
    id: raw.id ?? deriveAccountId(username),
    username,
    instance_url: instanceUrl,
    is_sandbox: raw.is_sandbox ?? isSandboxFromUrl(instanceUrl),
    connected_at: raw.connected_at ?? fallbackTimestamp,
    organization_id: raw.organization_id ?? raw.organizationId,
  };
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Try to rename a legacy-named token file (host's stricter sanitization, which
 * stripped `.`) to the new OSS-compatible filename. No-op if the new file
 * already exists or the legacy file is absent. Idempotent + best-effort.
 */
async function migrateLegacyTokenFileIfNeeded(
  username: string,
  accountId: string
): Promise<void> {
  if (!username) return;
  const newPath = getTokenPath(accountId);
  const legacyName = legacyHostSanitize(username);
  const legacyPath = path.join(getCredentialsDir(), `${legacyName}.token.json`);
  if (newPath === legacyPath) return;
  try {
    await fs.access(newPath);
    return; // OSS-named file already exists; nothing to do
  } catch {
    // newPath missing — try to rename legacy file into place
  }
  try {
    await fs.access(legacyPath);
  } catch {
    return; // No legacy file either
  }
  try {
    await fs.rename(legacyPath, newPath);
    log.info(
      { from: legacyName, to: accountId },
      'Migrated legacy Salesforce token file to OSS-compatible filename'
    );
  } catch (err) {
    log.warn(
      { err, from: legacyName, to: accountId },
      'Failed to rename legacy Salesforce token file (account may need re-connect)'
    );
  }
}

/**
 * Load accounts from accounts.json with migrate-on-read.
 *
 * Heals legacy entries (camelCase fields, missing `id`) silently. If any
 * normalisation actually changed the on-disk representation, we write it
 * back so the OSS package's next read sees the canonical shape — and also
 * rename any legacy-named token files so OSS can find them.
 */
async function loadAccounts(): Promise<AccountsConfig> {
  const accountsPath = getAccountsPath();
  let raw: { accounts?: LegacySalesforceAccountShape[] };
  try {
    const data = await fs.readFile(accountsPath, 'utf-8');
    raw = JSON.parse(data) as { accounts?: LegacySalesforceAccountShape[] };
  } catch {
    return { accounts: [] };
  }
  const fallbackTimestamp = new Date().toISOString();
  const rawAccounts = Array.isArray(raw.accounts) ? raw.accounts : [];
  const normalized: SalesforceAccount[] = rawAccounts.map((entry) =>
    normalizeAccount(entry, fallbackTimestamp)
  );
  const config: AccountsConfig = { accounts: normalized };

  // If shape drift detected, persist the canonical version + migrate token files.
  // Compared against the original parsed object so we don't churn on every read.
  const driftDetected = JSON.stringify({ accounts: rawAccounts }) !== JSON.stringify(config);
  if (driftDetected) {
    log.info(
      { accountCount: normalized.length },
      'Migrated Salesforce accounts.json to OSS-compatible schema'
    );
    await Promise.all(
      normalized.map((acc) => migrateLegacyTokenFileIfNeeded(acc.username, acc.id))
    );
    await saveAccounts(config);
  }

  return config;
}

/**
 * Save accounts to accounts.json
 */
async function saveAccounts(config: AccountsConfig): Promise<void> {
  const configDir = getConfigDir();
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(getAccountsPath(), JSON.stringify(config, null, 2));
}

/**
 * Save token for an account, keyed by accountId.
 *
 * Caller is responsible for passing a sanitized accountId (use
 * `deriveAccountId(username)`); we don't accept raw usernames here to keep
 * the writer / reader filename derivation centralised.
 */
async function saveToken(accountId: string, tokenData: TokenData): Promise<void> {
  const credentialsDir = getCredentialsDir();
  await fs.mkdir(credentialsDir, { recursive: true });
  await fs.writeFile(getTokenPath(accountId), JSON.stringify(tokenData, null, 2), { mode: 0o600 });
}

/**
 * Load token for an account, keyed by accountId.
 */
async function loadToken(accountId: string): Promise<TokenData | null> {
  try {
    const data = await fs.readFile(getTokenPath(accountId), 'utf-8');
    return JSON.parse(data) as TokenData;
  } catch {
    return null;
  }
}

/**
 * Delete token for an account, keyed by accountId.
 */
async function deleteToken(accountId: string): Promise<void> {
  try {
    await fs.unlink(getTokenPath(accountId));
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Revoke a Salesforce OAuth token with the provider.
 * Best-effort operation: logs success/failure but never throws.
 */
async function revokeSalesforceToken(tokenData: TokenData): Promise<void> {
  const token = tokenData.refresh_token ?? tokenData.access_token;
  if (!token) {
    log.warn('No token available to revoke');
    return;
  }

  const instanceUrl = tokenData.instance_url;
  if (!instanceUrl) {
    log.warn('No instance_url available for token revocation');
    return;
  }

  const response = await fetchWithTimeoutBestEffort(`${instanceUrl}/services/oauth2/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(token)}`,
    timeoutMs: 5000,
  });

  if (response?.ok) {
    log.info('Salesforce OAuth token revoked successfully');
  } else if (response) {
    log.warn({ status: response.status }, 'Salesforce token revocation returned non-OK status');
  }
  // null response means timeout or network error - already logged by fetchWithTimeoutBestEffort
}

/**
 * Exchange authorization code for tokens using PKCE
 */
async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  codeVerifier: string,
  redirectUri: string
): Promise<TokenData> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier,
  });

  const response = await fetch(getSalesforceTokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Provide actionable errors for common misconfigurations
    if (errorText.includes('redirect_uri_mismatch') || errorText.includes('invalid_client')) {
      throw new Error(
        `Salesforce OAuth failed: ${errorText}. ` +
        `Ensure your Connected App callback URL is set to: ${redirectUri}`
      );
    }
    if (errorText.includes('OAUTH_APP_ACCESS_DENIED') || errorText.includes('insufficient_scope')) {
      throw new Error(
        "Your Salesforce admin hasn't granted access to this Connected App. " +
        "Ask your admin to enable 'All users may self-authorize' in the Connected App settings, " +
        "or have them pre-authorize your profile under Setup > Connected Apps > Manage Connected Apps."
      );
    }
    if (errorText.includes('invalid_grant')) {
      throw new Error(
        'Authorization code expired or already used. Please try connecting again.'
      );
    }
    if (errorText.includes('unsupported_grant_type')) {
      throw new Error(
        "Connected App may not have OAuth enabled. " +
        "Check that 'Enable OAuth Settings' is checked in your Connected App configuration."
      );
    }
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    instance_url: data.instance_url,
    id: data.id,
    issued_at: data.issued_at,
    signature: data.signature,
    expires_at: Date.now() + 2 * 60 * 60 * 1000, // 2 hours
    login_url: getSalesforceLoginUrl(),
  };
}

/**
 * Get user info from the Identity URL returned in token response.
 * 
 * Salesforce returns an `id` field in the token response which is a URL like:
 * https://login.salesforce.com/id/00Dxx0000001gPLEAY/005xx000001SfOQAA0
 * 
 * Calling this URL with the access token returns user/org info without
 * requiring additional OAuth scopes (unlike /userinfo which needs openid).
 */
async function getUserInfo(
  accessToken: string,
  identityUrl: string
): Promise<{ username: string; organization_id: string }> {
  const response = await fetch(identityUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to get user info: ${response.status}`);
  }

  const data = await response.json();
  return {
    username: data.username || data.email,
    organization_id: data.organization_id,
  };
}

/**
 * Get all connected Salesforce accounts with their status
 */
export async function getSalesforceAccounts(): Promise<Array<{
  username: string;
  instanceUrl: string;
  status: 'active' | 'expired' | 'error';
}>> {
  const config = await loadAccounts();
  const results = [];

  for (const account of config.accounts) {
    const token = await loadToken(account.id);
    let status: 'active' | 'expired' | 'error' = 'error';

    if (token) {
      const bufferMs = 5 * 60 * 1000;
      const expiresAt = token.expires_at || (parseInt(token.issued_at) + 2 * 60 * 60 * 1000);
      const isValid = expiresAt > (Date.now() + bufferMs);

      if (isValid) {
        status = 'active';
      } else if (token.refresh_token) {
        status = 'active'; // MCP will auto-refresh
      } else {
        status = 'expired';
      }
    }

    results.push({
      username: account.username,
      instanceUrl: account.instance_url,
      status,
    });
  }

  return results;
}

/**
 * Remove a Salesforce account.
 *
 * `loadAccounts()` runs first so the migrate-on-read pass renames any
 * legacy-named token file (`<username-with-dots-stripped>.token.json`) into
 * the OSS-compatible name (`<accountId>.token.json`) BEFORE we try to delete
 * it. Without this, disconnecting an account that's still in legacy shape
 * silently leaves the token file on disk.
 */
export async function removeSalesforceAccount(username: string): Promise<void> {
  log.info({ username }, 'Removing Salesforce account');

  const config = await loadAccounts();
  const accountId = deriveAccountId(username);
  const tokenData = await loadToken(accountId);
  if (tokenData) {
    fireAndForget(revokeSalesforceToken(tokenData), 'salesforceAuthService.line537');
  }

  await deleteToken(accountId);

  config.accounts = config.accounts.filter((a) => a.username !== username);
  await saveAccounts(config);

  log.info({ username }, 'Salesforce account removed');
}

/**
 * Cancel any pending OAuth flow
 */
export function cancelSalesforceAuth(): void {
  if (pendingAuth) {
    log.info('Cancelling pending Salesforce auth');
    clearTimeout(pendingAuth.timeout);
    pendingAuth.reject(new Error('Auth cancelled by user'));
    pendingAuth = null;
  }
}

/**
 * Start OAuth flow for a new Salesforce account.
 * The callback will be handled by handleSalesforceOAuthCallback when the deep link arrives.
 */
export async function startSalesforceAuth(
  clientId: string,
  clientSecret: string
): Promise<string> {
  // Cancel any pending auth
  cancelSalesforceAuth();

  return new Promise((resolve, reject) => {
    // Generate PKCE codes
    const { verifier, challenge } = generatePkce();

    // Generate CSRF protection state token
    const state = generateCsrfState();

    // Snapshot the redirect URI once per auth flow so token exchange uses the same value
    // as the authorization request (Salesforce rejects mismatched redirect_uri).
    const redirectUri = getRedirectUri();

    // Build OAuth URL
    const authUrl = new URL(getSalesforceAuthUrl());
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', SALESFORCE_SCOPES.join(' '));
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state); // CSRF protection

    // Store pending auth state
    const timeout = setTimeout(() => {
      if (pendingAuth) {
        pendingAuth = null;
        reject(new Error('Authorization timed out'));
      }
    }, 5 * 60 * 1000); // 5 minute timeout

    pendingAuth = { clientId, clientSecret, codeVerifier: verifier, state, redirectUri, resolve, reject, timeout };

    // Open in system browser — reject on failure so the UI can show an error
    shell.openExternal(authUrl.toString()).then(() => {
      trackOAuthBrowserOpened({ connectorName: 'Salesforce', connectorType: 'bundled', oauthUrl: authUrl.toString(), callbackMethod: 'deep_link' });
    }).catch((err) => {
      log.error({ err }, 'Failed to open browser for Salesforce OAuth');
      clearTimeout(timeout);
      pendingAuth = null;
      reject(new Error('Failed to open browser for authentication'));
    });
    log.info('Opened Salesforce OAuth in system browser');
  });
}

/**
 * Handle the OAuth callback from the deep link.
 * Called from the protocol handler when mindstone://salesforce/callback is received.
 */
export async function handleSalesforceOAuthCallback(url: string): Promise<void> {
  if (!pendingAuth) {
    log.warn({ uptimeSeconds: Math.round(process.uptime()) },
      'Received Salesforce OAuth callback but no auth is pending');
    return;
  }

  const { clientId, clientSecret, codeVerifier, state, redirectUri, resolve, reject, timeout } = pendingAuth;
  clearTimeout(timeout);
  pendingAuth = null;

  try {
    const callbackUrl = new URL(url);
    const code = callbackUrl.searchParams.get('code');
    const error = callbackUrl.searchParams.get('error');
    const errorDescription = callbackUrl.searchParams.get('error_description');
    const returnedState = callbackUrl.searchParams.get('state');

    // Security: Validate state parameter to prevent CSRF attacks
    if (!returnedState || returnedState !== state) {
      log.error({ returnedState, expectedState: '[present]' },
        '[SECURITY] OAuth state mismatch - possible CSRF attack');
      throw new Error('OAuth state mismatch - possible CSRF attack');
    }

    if (error || !code) {
      if (error === 'access_denied') {
        throw new Error(
          "Access was denied. If you're not a Salesforce admin, ask your admin to pre-authorize " +
          "your profile for this Connected App, or enable 'All users may self-authorize'."
        );
      }
      throw new Error(errorDescription ?? error ?? 'No authorization code received');
    }

    // Exchange code for tokens
    log.info('Exchanging code for tokens');
    const tokenData = await exchangeCodeForTokens(code, clientId, clientSecret, codeVerifier, redirectUri);

    // Get user info from identity URL (returned in token response)
    const userInfo = await getUserInfo(tokenData.access_token, tokenData.id);
    const username = userInfo.username;
    const organizationId = userInfo.organization_id;

    if (!username) {
      throw new Error('Could not determine username from token');
    }

    // Save token with user info, keyed by OSS-compatible accountId so the
    // spawned MCP child can find it via loadToken(account.id).
    tokenData.username = username;
    tokenData.organization_id = organizationId;
    const accountId = deriveAccountId(username);
    await saveToken(accountId, tokenData);

    // Update accounts list — write the OSS-compatible shape (snake_case +
    // `id` field). loadAccounts() above already migrated any legacy entries.
    //
    // CRITICAL: place the just-connected account at index 0. OSS
    // `getActiveToken()` does `config.accounts[0].id` — i.e. it always
    // operates on whichever account is first in the array. Without this
    // re-ordering, a stale earlier account (e.g. one whose access_token
    // expired and whose refresh path is broken) keeps winning, and every
    // Salesforce tool call returns 'expired' even after the user just
    // re-connected a different account. See Round 5 follow-up in
    // docs/plans/260430_salesforce_oauth_browser_never_opens_settings.md.
    const config = await loadAccounts();
    const isSandbox = isSandboxFromUrl(tokenData.instance_url);
    const connectedAt = new Date().toISOString();
    const existingIndex = config.accounts.findIndex((a) => a.username === username);
    const updatedAccount: SalesforceAccount =
      existingIndex >= 0
        ? {
            ...config.accounts[existingIndex],
            id: accountId,
            instance_url: tokenData.instance_url,
            is_sandbox: isSandbox,
            connected_at: connectedAt,
            organization_id: organizationId,
          }
        : {
            id: accountId,
            username,
            instance_url: tokenData.instance_url,
            is_sandbox: isSandbox,
            connected_at: connectedAt,
            organization_id: organizationId,
          };
    if (existingIndex >= 0) {
      config.accounts.splice(existingIndex, 1);
    }
    config.accounts.unshift(updatedAccount);
    await saveAccounts(config);

    // Bring app to foreground
    bringAppToForeground();

    log.info({ username, instanceUrl: tokenData.instance_url }, 'Salesforce OAuth completed successfully');
    resolve(username);
  } catch (err) {
    log.error({ err }, 'Salesforce OAuth callback failed');
    reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Get the config directory path (for MCP environment variable)
 */
export function getSalesforceConfigDir(): string {
  return getConfigDir();
}
