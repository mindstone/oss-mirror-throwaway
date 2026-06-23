/**
 * Google Workspace Auth Service
 *
 * Handles OAuth2 authentication for Google Workspace (Gmail, Calendar, Drive)
 * directly in the main process. Uses the same storage format as the vendored
 * google-workspace-mcp so the MCP can read the tokens.
 *
 * Flow:
 * 1. Start loopback HTTP server on dynamic port
 * 2. Generate Google OAuth URL with redirect to localhost
 * 3. Open system browser for OAuth consent
 * 4. Handle callback with authorization code
 * 5. Exchange code for tokens
 * 6. Save tokens in MCP-compatible format
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { app, shell } from 'electron';
import { OAuth2Client } from 'google-auth-library';
import { createScopedLogger } from '@core/logger';
import { atomicCredentialWrite, sweepStaleTemps } from '@core/utils/atomicCredentialWrite';
import { generateInstanceId } from '@shared/utils/mcpInstanceUtils';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { trackOAuthBrowserOpened, trackOAuthCallbackReceived } from './oauthTelemetry';
import { getAvailablePort } from '../utils/systemUtils';
import { googleOAuthHtml } from './oauthHtmlTemplates';
import {
  generateCsrfState,
  fetchWithTimeoutBestEffort,
  bringAppToForeground,
} from './oauthPrimitives';

const log = createScopedLogger({ service: 'google-workspace-auth' });

/**
 * Google OAuth scopes for Workspace integration.
 * 
 * These are requested during OAuth, but users can opt out of individual scopes
 * via Google's granular consent UI. The app handles partial consent gracefully.
 * 
 * Note: Full-access scopes (calendar, drive, documents, spreadsheets, presentations)
 * include their readonly counterparts, so we don't request both.
 * 
 * @see docs/plans/finished/251228_google_oauth_consolidation_and_granular_consent.md
 */
const GOOGLE_SCOPES = [
  // Required for account identification
  'https://www.googleapis.com/auth/userinfo.email',
  
  // Gmail (5 scopes)
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  
  // Calendar (3 scopes - full access includes readonly)
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.settings.readonly',
  
  // Drive (3 scopes - full access includes readonly and metadata)
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.appdata',
  
  // Docs, Sheets, Slides (full access includes readonly)
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  
  // Contacts (readonly only - no write operations needed)
  'https://www.googleapis.com/auth/contacts.readonly',
];

export interface GoogleAccount {
  email: string;
  category: string;
  description: string;
}

interface AccountsConfig {
  accounts: GoogleAccount[];
}

interface TokenData {
  access_token: string;
  refresh_token?: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}

// Module state
let pendingAuth: {
  oauth2Client: OAuth2Client;
  server: http.Server;
  resolve: (email: string) => void;
  reject: (error: Error) => void;
  configDir?: string; // Instance-specific config directory
  state: string; // CSRF protection token
  returnMode: 'await' | 'authUrl';
} | null = null;

const pendingAuthTargetsByState = new Map<string, { email?: string; startedAt: number }>();

function clearPendingAuthState(state: string | undefined): void {
  if (state) {
    pendingAuthTargetsByState.delete(state);
  }
}

/**
 * Get the Google Workspace config directory.
 * Uses instance-specific dir if provided, otherwise legacy shared dir.
 */
function getConfigDir(instanceDir?: string): string {
  return instanceDir ?? path.join(app.getPath('userData'), 'google-workspace-mcp');
}

/**
 * Get the credentials directory for token files
 */
function getCredentialsDir(instanceDir?: string): string {
  return path.join(getConfigDir(instanceDir), 'credentials');
}

/**
 * Get accounts.json path
 */
function getAccountsPath(instanceDir?: string): string {
  return path.join(getConfigDir(instanceDir), 'accounts.json');
}

/**
 * Sanitize email for use in filename (matches MCP format)
 */
function sanitizeEmail(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Get token file path for an account
 */
function getTokenPath(email: string, instanceDir?: string): string {
  return path.join(getCredentialsDir(instanceDir), `${sanitizeEmail(email)}.token.json`);
}

async function ensureCredentialDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await sweepStaleTemps(dir);
}

function hashEmail(email: string): string {
  return crypto.createHash('sha256').update(email).digest('hex').slice(0, 12);
}

function assertNoInstanceIdCollisions(accounts: GoogleAccount[]): void {
  const emailsByInstanceId = new Map<string, string[]>();
  for (const account of accounts) {
    const email = account.email.trim();
    if (!email) continue;
    const instanceId = generateInstanceId('GoogleWorkspace', email);
    const emails = emailsByInstanceId.get(instanceId) ?? [];
    emails.push(email);
    emailsByInstanceId.set(instanceId, emails);
  }

  const collision = [...emailsByInstanceId.entries()].find(([, emails]) => emails.length > 1);
  if (!collision) return;

  const [collidedSlug, emails] = collision;
  log.error(
    {
      event: 'google.sanitiser_collision',
      severity: 'security',
      collidingEmailsHashed: emails.map(hashEmail),
      collidedSlug,
    },
    'Email-slug collision — token files would overwrite; refusing write',
  );
  throw new Error(`Google Workspace account instance-id collision for "${collidedSlug}"`);
}

/**
 * Load accounts from accounts.json
 */
async function loadAccounts(instanceDir?: string): Promise<AccountsConfig> {
  const accountsPath = getAccountsPath(instanceDir);
  try {
    const data = await fs.readFile(accountsPath, 'utf-8');
    return JSON.parse(data) as AccountsConfig;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return { accounts: [] };
    }
    log.error({ accountsPath, err: error }, 'Failed to load Google Workspace accounts');
    throw error;
  }
}

/**
 * Save accounts to accounts.json
 */
async function saveAccounts(config: AccountsConfig, instanceDir?: string): Promise<void> {
  const configDir = getConfigDir(instanceDir);
  assertNoInstanceIdCollisions(config.accounts);
  await ensureCredentialDir(configDir);
  await atomicCredentialWrite(getAccountsPath(instanceDir), JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Save token for an account
 */
async function saveToken(email: string, tokenData: TokenData, instanceDir?: string): Promise<void> {
  const credentialsDir = getCredentialsDir(instanceDir);
  await ensureCredentialDir(credentialsDir);
  await atomicCredentialWrite(getTokenPath(email, instanceDir), JSON.stringify(tokenData, null, 2), { mode: 0o600 });
}

/**
 * Load token for an account
 */
async function loadToken(email: string, instanceDir?: string): Promise<TokenData | null> {
  try {
    const data = await fs.readFile(getTokenPath(email, instanceDir), 'utf-8');
    return JSON.parse(data) as TokenData;
  } catch {
    return null;
  }
}

/**
 * Delete token for an account
 */
async function deleteToken(email: string, instanceDir?: string): Promise<void> {
  try {
    await fs.unlink(getTokenPath(email, instanceDir));
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Revoke a Google OAuth token with the provider.
 * 
 * Best-effort operation: logs success/failure but never throws.
 * Uses 5-second timeout to prevent UI hangs.
 * Prefers refresh_token (which cascades to access_token) if available.
 * 
 * @see https://developers.google.com/identity/protocols/oauth2/native-app#revoking-a-token
 */
export async function revokeGoogleToken(tokenData: TokenData): Promise<void> {
  // Prefer refresh_token as revoking it cascades to access_token
  const token = tokenData.refresh_token ?? tokenData.access_token;
  if (!token) {
    log.warn('No token available to revoke');
    return;
  }

  const response = await fetchWithTimeoutBestEffort('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(token)}`,
    timeoutMs: 5000,
  });

  if (response?.ok) {
    log.info('Google OAuth token revoked successfully');
  } else if (response) {
    log.warn({ status: response.status }, 'Google token revocation returned non-OK status');
  }
  // null response means timeout or network error - already logged by fetchWithTimeoutBestEffort
}

/**
 * Remove a Google account
 */
export async function removeGoogleAccount(email: string): Promise<void> {
  log.info({ email }, 'Removing Google account');

  // Load token BEFORE any deletion (required for revocation)
  const tokenData = await loadToken(email);

  // Best-effort revocation - fire and forget, don't block on result
  if (tokenData) {
    // Don't await - proceed with deletion regardless
    fireAndForget(revokeGoogleToken(tokenData), 'googleWorkspaceAuthService.line293');
  }

  // Delete token file
  await deleteToken(email);

  // Remove from accounts.json
  const config = await loadAccounts();
  config.accounts = config.accounts.filter((a) => a.email !== email);
  await saveAccounts(config);

  log.info({ email }, 'Google account removed');
}

/**
 * Start OAuth flow for a new Google account
 */
export async function startGoogleAuth(
  clientId: string,
  clientSecret: string,
  options: { targetEmail?: string; returnMode?: 'await' | 'authUrl' } = {},
): Promise<string> {
  const returnMode = options.returnMode ?? 'await';
  log.info({ targetEmailHash: options.targetEmail ? hashEmail(options.targetEmail) : undefined }, 'Starting Google OAuth flow');

  // Cancel any pending auth
  if (pendingAuth) {
    clearPendingAuthState(pendingAuth.state);
    pendingAuth.server.close();
    pendingAuth.reject(new Error('Auth cancelled - new auth started'));
    pendingAuth = null;
  }

  // Find available port
  const port = await getAvailablePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // Create OAuth2 client
  const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);

  // Generate CSRF protection state token
  const state = generateCsrfState();
  pendingAuthTargetsByState.set(state, { email: options.targetEmail, startedAt: Date.now() });

  // Generate auth URL with state parameter
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    prompt: 'consent',
    state, // CSRF protection
  });

  return new Promise((resolve, reject) => {
    // Create loopback server
    const server = http.createServer((req, res) => {
      fireAndForget((async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const returnedState = url.searchParams.get('state');

      // Security: Validate state parameter to prevent CSRF attacks
      if (!returnedState || returnedState !== pendingAuth?.state) {
        log.error({ returnedState, expectedState: pendingAuth?.state ? '[present]' : '[missing]' },
          '[SECURITY] OAuth state mismatch - possible CSRF attack');
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(googleOAuthHtml.error('Security validation failed - please try again'));
        trackOAuthCallbackReceived({ connectorName: 'Google Workspace', success: false, errorMessage: 'OAuth state mismatch' });
        server.close();
        clearPendingAuthState(pendingAuth?.state);
        pendingAuth = null;
        reject(new Error('OAuth state mismatch - possible CSRF attack'));
        return;
      }

      if (error) {
        log.error({ error }, 'OAuth error from Google');
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(googleOAuthHtml.error(error));
        trackOAuthCallbackReceived({ connectorName: 'Google Workspace', success: false, errorMessage: error });
        server.close();
        clearPendingAuthState(pendingAuth?.state);
        pendingAuth = null;
        reject(new Error(`Google OAuth error: ${error}`));
        return;
      }

      if (!code) {
        log.error('No authorization code received');
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(googleOAuthHtml.error('No authorization code received'));
        trackOAuthCallbackReceived({ connectorName: 'Google Workspace', success: false, errorMessage: 'No authorization code received' });
        server.close();
        clearPendingAuthState(pendingAuth?.state);
        pendingAuth = null;
        reject(new Error('No authorization code received'));
        return;
      }

      trackOAuthCallbackReceived({ connectorName: 'Google Workspace', success: true });

      try {
        // Exchange code for tokens
        log.info('Exchanging code for tokens');
        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens.access_token) {
          throw new Error('No access token received');
        }

        // Get user email from token
        oauth2Client.setCredentials(tokens);
        const ticket = await oauth2Client.getTokenInfo(tokens.access_token);
        const email = ticket.email;

        if (!email) {
          throw new Error('Could not determine email from token');
        }

        const expectedTarget = returnedState ? pendingAuthTargetsByState.get(returnedState)?.email : undefined;
        if (expectedTarget && expectedTarget.toLowerCase() !== email.toLowerCase()) {
          throw new Error('Authenticated Google account did not match the requested account');
        }

        log.info({ email }, 'OAuth successful, saving tokens');

        const existingConfig = await loadAccounts();
        const accountExists = existingConfig.accounts.some((a) => a.email === email);
        const projectedAccounts = accountExists
          ? existingConfig.accounts
          : [
              ...existingConfig.accounts,
              { email, category: 'personal', description: 'Connected via Rebel' },
            ];
        assertNoInstanceIdCollisions(projectedAccounts);

        const tokenData: TokenData = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? undefined,
          scope: tokens.scope ?? GOOGLE_SCOPES.join(' '),
          token_type: tokens.token_type ?? 'Bearer',
          expiry_date: tokens.expiry_date ?? Date.now() + 3600 * 1000,
        };
        await saveToken(email, tokenData);

        if (!accountExists) {
          existingConfig.accounts = projectedAccounts;
          await saveAccounts(existingConfig);
        }

        // Send success response
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(googleOAuthHtml.success(email));

        // Bring app to foreground
        bringAppToForeground();

        server.close();
        clearPendingAuthState(pendingAuth?.state);
        pendingAuth = null;
        if (returnMode !== 'authUrl') {
          resolve(email);
        }
      } catch (err) {
        log.error({ err }, 'Failed to exchange code for tokens');
        const message = err instanceof Error ? err.message : 'Token exchange failed';
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(googleOAuthHtml.error(message));
        trackOAuthCallbackReceived({ connectorName: 'Google Workspace', success: false, errorMessage: message });
        server.close();
        clearPendingAuthState(pendingAuth?.state);
        pendingAuth = null;
        reject(err);
      }
      })().catch((err: unknown) => {
        log.error({ err }, 'Google OAuth callback handler failed');
        const message = err instanceof Error ? err.message : 'Token exchange failed';
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(googleOAuthHtml.error(message));
        }
        trackOAuthCallbackReceived({ connectorName: 'Google Workspace', success: false, errorMessage: message });
        server.close();
        clearPendingAuthState(pendingAuth?.state);
        pendingAuth = null;
        reject(err);
      }), 'googleWorkspaceAuth.callback');
    });

    // Start server
    server.listen(port, '127.0.0.1', () => {
      log.info({ port }, 'OAuth callback server started');
      pendingAuth = { oauth2Client, server, resolve, reject, state, returnMode };

      // Open browser
      shell.openExternal(authUrl).then(() => {
        trackOAuthBrowserOpened({ connectorName: 'Google Workspace', connectorType: 'bundled', oauthUrl: authUrl, callbackMethod: 'localhost' });
        if (returnMode === 'authUrl') {
          resolve(authUrl);
        }
      }).catch((err) => {
        log.error({ err }, 'Failed to open browser for Google OAuth');
        server.close();
        clearPendingAuthState(state);
        pendingAuth = null;
        reject(new Error('Failed to open browser for authentication'));
      });
      log.info('Opened browser for Google OAuth');
    });

    server.on('error', (err) => {
      log.error({ err }, 'OAuth callback server error');
      clearPendingAuthState(state);
      pendingAuth = null;
      reject(err);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (pendingAuth && pendingAuth.server === server) {
        log.warn('OAuth flow timed out');
        server.close();
        clearPendingAuthState(pendingAuth.state);
        pendingAuth = null;
        reject(new Error('OAuth flow timed out'));
      }
    }, 5 * 60 * 1000);
  });
}

/**
 * Cancel any pending OAuth flow
 */
export function cancelGoogleAuth(): void {
  if (pendingAuth) {
    log.info('Cancelling pending Google OAuth');
    pendingAuth.server.close();
    clearPendingAuthState(pendingAuth.state);
    pendingAuth.reject(new Error('OAuth cancelled by user'));
    pendingAuth = null;
  }
}

export const _testOnly = {
  loadAccounts,
  saveAccounts,
  assertNoInstanceIdCollisions,
};
