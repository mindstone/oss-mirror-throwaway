/**
 * GitHub Auth Service
 *
 * Handles OAuth2 authentication for GitHub using system browser + deep link callback.
 *
 * Flow:
 * 1. Generate GitHub OAuth URL with PKCE + CSRF state
 * 2. Open system browser
 * 3. Cloudflare redirects to mindstone://github/callback with code
 * 4. App handles deep link, validates state, exchanges code for tokens
 * 5. Save tokens and client metadata in Super-MCP compatible storage
 */

import { URL } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { shell } from 'electron';
import { createScopedLogger } from '@core/logger';
import { getOAuthRedirectUri } from '@core/services/oauthRedirectUri';
import { githubCredentialSource, resolveOAuthCredentials } from './oauthCredentials';
import { trackOAuthBrowserOpened } from './oauthTelemetry';
import { bringAppToForeground, generateCsrfState } from './oauthPrimitives';
import { getSuperMcpOAuthTokensDir } from '../utils/testIsolation';

const log = createScopedLogger({ service: 'github-auth' });

// GitHub OAuth URLs
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// Redirect URI - Cloudflare redirects this to mindstone://github/callback
const getRedirectUri = () => getOAuthRedirectUri('github');

// GitHub OAuth scopes requested for the bundled GitHub MCP connector.
//
// These are the minimum scopes that satisfy the read side of the hosted
// github-mcp-server tool surface:
//   - `repo`       → read/write repo, issues, PRs, code search
//   - `read:org`   → team membership + org-scoped issue type listing
//
// We pair this broad OAuth scope with the `/readonly` server URL variant in
// resources/connector-catalog.json so that writes are blocked server-side even
// though the token technically permits them. See:
//   docs-private/investigations/260423_github_mcp_partial_auth_empty_scopes.md
//   https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server#read-only-mode
export const GITHUB_SCOPES: readonly string[] = ['repo', 'read:org'];

/**
 * Scopes that MUST be present on a persisted token for the connector to work.
 * Used to detect zero/under-scoped tokens left over from the pre-fix flow
 * (see `migrateStaleGitHubTokens()`).
 */
const REQUIRED_SCOPES: readonly string[] = GITHUB_SCOPES;

// Lazy getters — must NOT be module-level constants because os.homedir() would
// evaluate at import time, before E2E test isolation redirects are active.
function getTokensDir(): string { return getSuperMcpOAuthTokensDir(); }
function getTokensPath(): string { return path.join(getTokensDir(), 'GitHub_tokens.json'); }
function getClientPath(): string { return path.join(getTokensDir(), 'GitHub_client.json'); }

interface GitHubTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
  error_uri?: string;
}

// Module state for pending OAuth
let pendingAuth: {
  clientId: string;
  clientSecret: string;
  codeVerifier: string;
  redirectUri: string;
  state: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
} | null = null;

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function ensureTokenDir(): Promise<void> {
  await fs.mkdir(getTokensDir(), { recursive: true });
}

function getGitHubCredentialsOrThrow(): { clientId: string; clientSecret: string } {
  const credentials = resolveOAuthCredentials(githubCredentialSource);
  if (!credentials) {
    throw new Error('GitHub OAuth credentials are not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in your environment.');
  }
  return credentials;
}

async function writeClientFile(
  credentials: { clientId: string; clientSecret: string } = getGitHubCredentialsOrThrow(),
  redirectUri: string = getRedirectUri(),
): Promise<void> {
  await ensureTokenDir();
  const clientJson: Record<string, unknown> = {
    client_id: credentials.clientId,
    redirect_uris: [redirectUri],
  };
  clientJson.client_secret = credentials.clientSecret;
  await fs.writeFile(getClientPath(), JSON.stringify(clientJson, null, 2), { mode: 0o600 });
}

async function writeTokensFile(tokens: GitHubTokenResponse): Promise<void> {
  await ensureTokenDir();
  await fs.writeFile(getTokensPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function readTokensFile(): Promise<GitHubTokenResponse | null> {
  try {
    const content = await fs.readFile(getTokensPath(), 'utf-8');
    return JSON.parse(content) as GitHubTokenResponse;
  } catch {
    return null;
  }
}

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  credentials: { clientId: string; clientSecret: string },
): Promise<GitHubTokenResponse> {
  const bodyParams: Record<string, string> = {
    client_id: credentials.clientId,
    code,
    redirect_uri: redirectUri,
    client_secret: credentials.clientSecret,
    code_verifier: codeVerifier,
  };

  const body = new URLSearchParams(bodyParams);

  log.info({
    hasClientSecret: true,
    redirectUri,
    clientId: credentials.clientId,
  }, 'Exchanging code for tokens');

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  const responseText = await response.text();
  log.info({ status: response.status }, 'Token exchange response received');

  let data: GitHubTokenResponse;
  try {
    data = JSON.parse(responseText) as GitHubTokenResponse;
  } catch {
    throw new Error(`Token exchange failed: ${response.status} - invalid JSON response`);
  }

  log.info({ hasAccessToken: !!data.access_token, hasRefreshToken: !!data.refresh_token }, 'Token exchange parsed');

  if (data.error || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? 'Token exchange failed');
  }

  return data;
}

/**
 * Start GitHub OAuth flow.
 * The callback will be handled by handleGitHubOAuthCallback when the deep link arrives.
 */
export async function startGitHubAuth(): Promise<void> {
  cancelGitHubAuth();
  const credentials = getGitHubCredentialsOrThrow();

  return new Promise((resolve, reject) => {
    const { verifier, challenge } = generatePkce();
    const state = generateCsrfState();
    const redirectUri = getRedirectUri();

    const authUrl = new URL(GITHUB_AUTH_URL);
    authUrl.searchParams.set('client_id', credentials.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);

    if (GITHUB_SCOPES.length > 0) {
      authUrl.searchParams.set('scope', GITHUB_SCOPES.join(' '));
    }

    const timeout = setTimeout(() => {
      if (pendingAuth) {
        pendingAuth = null;
        reject(new Error('Authorization timed out'));
      }
    }, 5 * 60 * 1000);

    pendingAuth = {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      codeVerifier: verifier,
      redirectUri,
      state,
      resolve,
      reject,
      timeout,
    };

    // Open in system browser — reject on failure so the UI can show an error
    shell.openExternal(authUrl.toString()).then(() => {
      trackOAuthBrowserOpened({ connectorName: 'GitHub', connectorType: 'bundled', oauthUrl: authUrl.toString(), callbackMethod: 'deep_link' });
    }).catch((err) => {
      log.error({ err }, 'Failed to open browser for GitHub OAuth');
      clearTimeout(timeout);
      pendingAuth = null;
      reject(new Error('Failed to open browser for authentication'));
    });
    log.info('Opened GitHub OAuth in system browser');
  });
}

/**
 * Handle the OAuth callback from the deep link.
 * Called from the protocol handler when mindstone://github/callback is received.
 */
export async function handleGitHubOAuthCallback(url: string): Promise<void> {
  if (!pendingAuth) {
    log.warn({ uptimeSeconds: Math.round(process.uptime()) },
      'Received GitHub OAuth callback but no auth is pending');
    return;
  }

  const { clientId, clientSecret, codeVerifier, redirectUri, state, resolve, reject, timeout } = pendingAuth;
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
      log.error(
        { returnedState, expectedState: '[present]' },
        '[SECURITY] OAuth state mismatch - possible CSRF attack'
      );
      throw new Error('OAuth state mismatch - possible CSRF attack');
    }

    if (error || !code) {
      throw new Error(errorDescription ?? error ?? 'No authorization code received');
    }

    log.info('Exchanging code for tokens');
    const credentials = { clientId, clientSecret };
    const tokenData = await exchangeCodeForTokens(code, codeVerifier, redirectUri, credentials);

    // Write both files expected by Super-MCP
    await writeTokensFile(tokenData);
    await writeClientFile(credentials, redirectUri);

    bringAppToForeground();

    log.info('GitHub OAuth completed successfully');
    resolve();
  } catch (err) {
    log.error({ err }, 'GitHub OAuth callback failed');
    reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Parse a GitHub OAuth `scope` response string into a set of scopes.
 *
 * GitHub returns scopes as a space-separated list (e.g. `"repo,read:org"` or
 * `"repo read:org"` depending on the endpoint); we accept either separator.
 */
function parseScopes(scopeString: string | undefined | null): Set<string> {
  if (!scopeString) return new Set();
  return new Set(
    scopeString
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * `true` if the persisted token string covers every scope in `REQUIRED_SCOPES`.
 *
 * Note on `repo`: GitHub issues `repo` as an umbrella scope that implies
 * `repo:status`, `public_repo`, `repo_deployment`, etc. Callers should not rely
 * on sub-scope recognition here — we only check literal membership.
 */
function hasSufficientScopes(scopeString: string | undefined | null): boolean {
  const have = parseScopes(scopeString);
  return REQUIRED_SCOPES.every((s) => have.has(s));
}

/**
 * Check if GitHub is connected with a sufficiently-scoped token.
 *
 * Returns `connected: false` for:
 *   - missing token file
 *   - token file with no `access_token`
 *   - token file with `access_token` but insufficient `scope` — these are
 *     the zero-scope tokens written by the pre-fix OAuth flow. See
 *     `docs-private/investigations/260423_github_mcp_partial_auth_empty_scopes.md`.
 */
export async function getGitHubStatus(): Promise<{ connected: boolean }> {
  const tokens = await readTokensFile();
  if (!tokens?.access_token) {
    return { connected: false };
  }
  if (!hasSufficientScopes(tokens.scope)) {
    log.warn(
      { persistedScope: tokens.scope ?? '', required: REQUIRED_SCOPES },
      'GitHub token is missing required scopes; treating connector as disconnected',
    );
    return { connected: false };
  }
  return { connected: true };
}

/**
 * One-shot migration for users who connected GitHub before the scope fix.
 *
 * Deletes the persisted `GitHub_tokens.json` / `GitHub_client.json` when the
 * token's `scope` is missing anything in `REQUIRED_SCOPES`. The user will see
 * GitHub as "not connected" and can reconnect through the normal Settings flow,
 * which will now request the correct scopes.
 *
 * Why delete (rather than just reporting insufficient): Super-MCP caches tokens
 * via its own file watcher; leaving a broken token on disk risks the connector
 * silently reappearing as "connected" with a useless token. Deleting is
 * observable (log line) and recoverable (user reconnects).
 *
 * Safe to call on every app startup — a no-op when tokens are absent, valid,
 * or already sufficient.
 */
export async function migrateStaleGitHubTokens(): Promise<void> {
  const tokens = await readTokensFile();
  if (!tokens?.access_token) return;
  if (hasSufficientScopes(tokens.scope)) return;

  log.warn(
    { persistedScope: tokens.scope ?? '', required: REQUIRED_SCOPES },
    'Removing stale under-scoped GitHub tokens; user will be prompted to reconnect',
  );

  for (const filePath of [getTokensPath(), getClientPath()]) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err, filePath }, 'Failed to delete stale GitHub OAuth file');
      }
    }
  }
}

/**
 * Remove GitHub tokens/client files.
 */
export async function removeGitHubAccount(): Promise<void> {
  cancelGitHubAuth();

  for (const filePath of [getTokensPath(), getClientPath()]) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err, filePath }, 'Failed to delete GitHub OAuth file');
      }
    }
  }
}

/**
 * Cancel any pending OAuth flow.
 */
export function cancelGitHubAuth(): void {
  if (pendingAuth) {
    log.info('Cancelling pending GitHub auth');
    clearTimeout(pendingAuth.timeout);
    pendingAuth.reject(new Error('Auth cancelled by user'));
    pendingAuth = null;
  }
}

/** @internal Exposed for regression test only (REBEL-12M). */
export const _testOnly = { writeClientFile } as const;
