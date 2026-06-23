/**
 * Slack OAuth Auth Service
 *
 * Handles Slack OAuth 2.0 flow using system browser + deep link callback.
 * Flow: System browser → Slack auth → Cloudflare redirect → mindstone:// deep link → App
 * This uses the user's existing Slack session for seamless auth.
 */

import { URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { app, shell } from 'electron';
import { createScopedLogger } from '@core/logger';
import { getOAuthRedirectUri } from '@core/services/oauthRedirectUri';
import { atomicCredentialWrite, sweepStaleTemps } from '@core/utils/atomicCredentialWrite';
import { SLACK_BOT_SCOPE_PARAM, SLACK_USER_SCOPE_PARAM } from '@shared/utils/slackOAuthScopes';
import { getSlackApiBaseUrl } from '@shared/utils/slackApiBaseUrl';
import { trackOAuthBrowserOpened } from './oauthTelemetry';
import {
  generateCsrfState,
  fetchWithTimeoutBestEffort,
  bringAppToForeground,
} from './oauthPrimitives';
import {
  resolveOAuthCredentials,
  slackCredentialSource,
} from './oauthCredentials';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'slack-auth' });

const SLACK_BOT_SCOPES = SLACK_BOT_SCOPE_PARAM;
const SLACK_USER_SCOPES = SLACK_USER_SCOPE_PARAM;

// Redirect URI - Cloudflare redirects this to mindstone://slack/callback
const getRedirectUri = () => getOAuthRedirectUri('slack');
const PENDING_AUTH_TIMEOUT_MS = 30 * 60 * 1000;
const PENDING_AUTH_FRESHNESS_MS = 25 * 60 * 1000;

function slackApiUrl(path: string): string {
  return new URL(path, getSlackApiBaseUrl()).toString();
}

export interface SlackWorkspace {
  teamId: string;
  teamName: string;
  authedAt: string;
}

interface SlackTokens {
  botToken: string;
  userToken?: string;
  botUserId: string;
  botUsername?: string;
  /** Slack user ID of the person who authorized this workspace */
  authedUserId?: string;
  // Token rotation support (present when Slack app has token rotation enabled)
  botRefreshToken?: string;
  botExpiresAt?: number;        // Epoch ms
  userRefreshToken?: string;
  userExpiresAt?: number;       // Epoch ms
}

interface SlackOAuthResponse {
  ok: boolean;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  refresh_token?: string;     // Present when token rotation is enabled
  expires_in?: number;        // Seconds until token expires (token rotation)
  team?: { id: string; name: string };
  authed_user?: {
    id: string;
    access_token?: string;
    refresh_token?: string;   // Present when token rotation is enabled
    expires_in?: number;      // Seconds until token expires (token rotation)
  };
  error?: string;
}

/**
 * Result of a successful Slack OAuth flow.
 */
export interface SlackOAuthResult {
  teamId: string;
  teamName: string;
}

// Pending auth state
let pendingAuth: {
  clientId: string;
  clientSecret: string;
  state: string; // CSRF protection token
  redirectUri: string; // snapshotted at auth start; reused at token exchange to prevent env mutation drift
  authUrl: string;
  startedAt: number;
  completion: Promise<SlackOAuthResult>;
  resolve: (result: SlackOAuthResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
} | null = null;

export interface SlackAuthResult {
  authUrl: string;
  completion: Promise<SlackOAuthResult>; // Resolves with teamId and teamName when OAuth completes
}

/**
 * Start Slack OAuth flow.
 * Returns the auth URL and a promise that resolves when OAuth completes.
 * 
 * @param clientId - Slack OAuth client ID
 * @param clientSecret - Slack OAuth client secret  
 * @param options.autoOpen - Whether to auto-open browser (default: true for backwards compat)
 * @returns Auth URL and completion promise
 */
export function startSlackAuth(
  clientId: string,
  clientSecret: string,
  options: { autoOpen?: boolean } = {}
): SlackAuthResult {
  const shouldAutoOpen = options.autoOpen !== false;

  if (
    pendingAuth &&
    pendingAuth.clientId === clientId &&
    pendingAuth.clientSecret === clientSecret &&
    Date.now() - pendingAuth.startedAt < PENDING_AUTH_FRESHNESS_MS
  ) {
    const existingAuthUrl = pendingAuth.authUrl;
    const existingCompletion = pendingAuth.completion;
    if (shouldAutoOpen) {
      shell.openExternal(existingAuthUrl).then(() => {
        trackOAuthBrowserOpened({ connectorName: 'Slack', connectorType: 'bundled', oauthUrl: existingAuthUrl, callbackMethod: 'deep_link' });
      }).catch((err) => {
        log.error({ err }, 'Failed to open browser for Slack OAuth');
      });
      log.info('Opened existing Slack OAuth in system browser');
    } else {
      log.info({ authUrl: existingAuthUrl }, 'Reusing existing Slack OAuth URL (not auto-opening)');
    }
    return { authUrl: existingAuthUrl, completion: existingCompletion };
  }

  // Cancel any pending auth
  cancelSlackAuth();

  // Generate CSRF protection state token
  const state = generateCsrfState();

  // Snapshot the redirect URI once per auth flow so the token exchange uses the same value
  // as the authorization request (Slack rejects mismatched redirect_uri).
  const redirectUri = getRedirectUri();

  // Build OAuth URL
  const authUrl = new URL('https://slack.com/oauth/v2/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('scope', SLACK_BOT_SCOPES);
  authUrl.searchParams.set('user_scope', SLACK_USER_SCOPES);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state); // CSRF protection
  const authUrlString = authUrl.toString();

  let resolveCompletion!: (result: SlackOAuthResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<SlackOAuthResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  // Store pending auth state
  const timeout = setTimeout(() => {
    if (pendingAuth?.state === state) {
      pendingAuth = null;
      rejectCompletion(new Error('Authorization timed out'));
    }
  }, PENDING_AUTH_TIMEOUT_MS);

  pendingAuth = {
    clientId,
    clientSecret,
    state,
    redirectUri,
    authUrl: authUrlString,
    startedAt: Date.now(),
    completion,
    resolve: resolveCompletion,
    reject: rejectCompletion,
    timeout,
  };

  if (shouldAutoOpen) {
    // Open in system browser — reject on failure so the UI can show an error
    shell.openExternal(authUrlString).then(() => {
      trackOAuthBrowserOpened({ connectorName: 'Slack', connectorType: 'bundled', oauthUrl: authUrlString, callbackMethod: 'deep_link' });
    }).catch((err) => {
      log.error({ err }, 'Failed to open browser for Slack OAuth');
      if (pendingAuth?.state === state) {
        clearTimeout(pendingAuth.timeout);
        pendingAuth.reject(new Error('Failed to open browser for authentication'));
        pendingAuth = null;
      }
    });
    log.info('Opened Slack OAuth in system browser');
  } else {
    log.info({ authUrl: authUrlString }, 'Generated Slack OAuth URL (not auto-opening)');
  }

  return { authUrl: authUrlString, completion };
}

/**
 * Handle the OAuth callback from the deep link.
 * Called from the protocol handler when mindstone://slack/callback is received.
 */
export async function handleSlackOAuthCallback(url: string): Promise<void> {
  if (!pendingAuth) {
    log.warn({ uptimeSeconds: Math.round(process.uptime()) },
      'Received Slack OAuth callback but no auth is pending');
    return;
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(url);
  } catch (parseErr) {
    log.warn({ err: parseErr }, 'Slack OAuth callback URL parse failed');
    return;
  }

  const returnedState = callbackUrl.searchParams.get('state');
  if (!returnedState || returnedState !== pendingAuth.state) {
    log.warn(
      { returnedState, expectedState: '[present]' },
      'Slack OAuth callback state mismatch — likely stale link, preserving fresh pending auth',
    );
    return;
  }

  const { clientId, clientSecret, redirectUri, resolve, reject, timeout } = pendingAuth;
  clearTimeout(timeout);
  pendingAuth = null;

  try {
    const code = callbackUrl.searchParams.get('code');
    const error = callbackUrl.searchParams.get('error');

    if (error || !code) {
      throw new Error(error || 'No authorization code received');
    }

    // Exchange code for token
    const tokenResponse = await fetch(slackApiUrl('/api/oauth.v2.access'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const data: SlackOAuthResponse = await tokenResponse.json();

    if (!data.ok || !data.access_token) {
      throw new Error(data.error || 'Token exchange failed');
    }
    if (!data.team?.id || !data.team.name || !data.bot_user_id) {
      throw new Error('Token exchange response missing required workspace metadata');
    }

    const teamId = data.team.id;
    const teamName = data.team.name;
    const botUserId = data.bot_user_id;

    // Save workspace and tokens
    await saveSlackWorkspace(
      {
        teamId,
        teamName,
        authedAt: new Date().toISOString(),
      },
      {
        botToken: data.access_token,
        userToken: data.authed_user?.access_token,
        botUserId,
        authedUserId: data.authed_user?.id,
        // Token rotation fields (may be undefined if rotation not enabled on the Slack app)
        botRefreshToken: data.refresh_token,
        botExpiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
        userRefreshToken: data.authed_user?.refresh_token,
        userExpiresAt: data.authed_user?.expires_in ? Date.now() + data.authed_user.expires_in * 1000 : undefined,
      }
    );

    // Bring app to foreground
    bringAppToForeground();

    log.info({ teamName }, 'Slack OAuth completed successfully');
    resolve({ teamId, teamName });
  } catch (err) {
    log.error({ err }, 'Slack OAuth callback failed');
    reject(err instanceof Error ? err : new Error(String(err)));
  }
}

export function cancelSlackAuth(): void {
  if (pendingAuth) {
    clearTimeout(pendingAuth.timeout);
    pendingAuth.reject(new Error('Authorization cancelled'));
    pendingAuth = null;
  }
}

// Config file helpers
export const getSlackConfigDir = () => path.join(app.getPath('userData'), 'mcp', 'slack');
const getConfigDir = getSlackConfigDir;
const getConfigPath = () => path.join(getConfigDir(), 'config.json');
const getTokenPath = (teamId: string) => path.join(getConfigDir(), 'workspaces', `${teamId}.json`);

async function ensureSlackConfigDirectories(): Promise<void> {
  const configDir = getConfigDir();
  const workspaceDir = path.join(configDir, 'workspaces');

  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspaceDir, { recursive: true, mode: 0o700 });

  if (process.platform !== 'win32') {
    await fs.chmod(configDir, 0o700);
    await fs.chmod(workspaceDir, 0o700);
  }
}

export async function getSlackWorkspaces(): Promise<SlackWorkspace[]> {
  try {
    const data = await fs.readFile(getConfigPath(), 'utf8');
    return JSON.parse(data).workspaces || [];
  } catch (err) {
    // Config absent (ENOENT) is the normal not-yet-connected case — recover
    // silently. A corrupt/unreadable config silently presenting as "no
    // workspaces" would make the user's Slack connections vanish, so make it
    // observable before the empty fallback.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err }, 'Failed to read Slack workspaces config — treating as none (connected workspaces will appear missing)');
    }
    return [];
  }
}

async function saveSlackWorkspace(workspace: SlackWorkspace, tokens: SlackTokens): Promise<void> {
  const configDir = getConfigDir();
  await ensureSlackConfigDirectories();
  await sweepStaleTemps(configDir);
  await sweepStaleTemps(path.join(configDir, 'workspaces'));

  // Save workspace info
  const workspaces = await getSlackWorkspaces();
  const existing = workspaces.findIndex((w) => w.teamId === workspace.teamId);
  if (existing >= 0) {
    workspaces[existing] = workspace;
  } else {
    workspaces.push(workspace);
  }
  await atomicCredentialWrite(getConfigPath(), JSON.stringify({ workspaces }, null, 2), { mode: 0o600 });

  // Resolve botUsername via auth.test if not already provided (best-effort)
  if (!tokens.botUsername) {
    try {
      const botUsername = await resolveBotUsername(tokens.botToken);
      if (botUsername) {
        tokens.botUsername = botUsername;
      }
    } catch (err) {
      log.warn({ err, teamId: workspace.teamId }, 'Failed to resolve bot username during OAuth — will retry on adapter poll');
    }
  }

  // Save tokens separately (mode 0o600 for security - owner read/write only)
  await atomicCredentialWrite(getTokenPath(workspace.teamId), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  log.info({ teamId: workspace.teamId, teamName: workspace.teamName }, 'Slack workspace connected');
}

/**
 * Revoke a Slack token via auth.revoke endpoint.
 * Best-effort: logs errors but never throws. Uses 5-second timeout.
 * Works for both bot tokens and user tokens.
 */
async function revokeSlackToken(token: string, tokenType: 'bot' | 'user'): Promise<void> {
  const response = await fetchWithTimeoutBestEffort(slackApiUrl('/api/auth.revoke'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeoutMs: 5000,
  });

  if (response) {
    try {
      const data = await response.json();
      if (data.ok) {
        log.info({ tokenType }, 'Slack token revoked successfully');
      } else {
        log.warn({ tokenType, error: data.error }, 'Slack token revocation failed');
      }
    } catch {
      // Best-effort: if JSON parsing fails, just log and continue
      log.debug({ tokenType }, 'Slack revocation response was not valid JSON');
    }
  }
  // null response means timeout or network error - already logged by fetchWithTimeoutBestEffort
}

export async function removeSlackWorkspace(teamId: string): Promise<void> {
  // Load tokens BEFORE any deletion for revocation
  const tokens = await getSlackTokensForWorkspace(teamId);
  
  // Revoke tokens (fire-and-forget, best-effort)
  if (tokens) {
    // Revoke bot token
    fireAndForget(revokeSlackToken(tokens.botToken, 'bot'), 'slackAuthService.line415');
    // Revoke user token if present
    if (tokens.userToken) {
      fireAndForget(revokeSlackToken(tokens.userToken, 'user'), 'slackAuthService.line418');
    }
  }

  const workspaces = await getSlackWorkspaces();
  const filtered = workspaces.filter((w) => w.teamId !== teamId);
  await ensureSlackConfigDirectories();
  await sweepStaleTemps(getConfigDir());
  await atomicCredentialWrite(getConfigPath(), JSON.stringify({ workspaces: filtered }, null, 2), { mode: 0o600 });

  // Remove token file
  try {
    await fs.rm(getTokenPath(teamId));
  } catch {
    /* ignore */
  }

  log.info({ teamId }, 'Slack workspace removed');
}

export interface SlackTokensResult {
  botToken: string;
  userToken?: string;
}

/**
 * Get tokens for a specific workspace by team ID.
 */
export async function getSlackTokensForWorkspace(teamId: string): Promise<SlackTokensResult | null> {
  try {
    const data = await fs.readFile(getTokenPath(teamId), 'utf8');
    const tokens: SlackTokens = JSON.parse(data);
    return {
      botToken: tokens.botToken,
      userToken: tokens.userToken,
    };
  } catch {
    return null;
  }
}

/** Extended workspace details including bot identity info */
export interface SlackWorkspaceDetails {
  botToken: string;
  userToken?: string;
  botUserId: string;
  botUsername?: string;
  /** Slack user ID of the person who authorized this workspace */
  authedUserId?: string;
}

/**
 * Get full workspace details for a specific team, including bot identity.
 * Used by the inbound trigger adapter to construct search queries.
 */
export async function getSlackWorkspaceDetails(teamId: string): Promise<SlackWorkspaceDetails | null> {
  try {
    const data = await fs.readFile(getTokenPath(teamId), 'utf8');
    const tokens: SlackTokens = JSON.parse(data);
    return {
      botToken: tokens.botToken,
      userToken: tokens.userToken,
      botUserId: tokens.botUserId,
      botUsername: tokens.botUsername,
      authedUserId: tokens.authedUserId,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the bot's username via Slack's auth.test API.
 * Returns the username (e.g., "rebel-bot") or null on failure.
 */
export async function resolveBotUsername(botToken: string): Promise<string | null> {
  try {
    const response = await fetch(slackApiUrl('/api/auth.test'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    const data = await response.json();
    if (data.ok && data.user) {
      return data.user as string;
    }
    log.warn({ error: data.error }, 'auth.test did not return bot username');
    return null;
  } catch (err) {
    log.warn({ err }, 'Failed to call auth.test for bot username');
    return null;
  }
}

/**
 * Refresh Slack tokens for a workspace using stored refresh tokens.
 * Used by the main process (e.g., slackMentionAdapter) when API calls fail with auth errors.
 *
 * Flow:
 * 1. Read token file from disk
 * 2. Check if refresh tokens exist (no-op if token rotation is not enabled)
 * 3. Get OAuth credentials via resolveOAuthCredentials
 * 4. Call oauth.v2.access with grant_type=refresh_token for bot token
 * 5. Call oauth.v2.access with grant_type=refresh_token for user token (if exists)
 * 6. Write updated tokens back to disk (mode 0o600)
 *
 * @returns true on success, false on failure (no refresh token, revoked, or network error)
 */
export async function refreshSlackTokens(teamId: string): Promise<boolean> {
  try {
    // 1. Read current tokens from disk
    const rawData = await fs.readFile(getTokenPath(teamId), 'utf8');
    const tokens: SlackTokens = JSON.parse(rawData);

    // 2. Check if refresh tokens exist — if not, token rotation is not enabled
    if (!tokens.botRefreshToken) {
      log.debug({ teamId }, 'No bot refresh token stored — token rotation may not be enabled');
      return false;
    }

    // 3. Get OAuth credentials
    const credentials = resolveOAuthCredentials(slackCredentialSource);
    if (!credentials) {
      log.warn(
        { teamId, envVars: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'] },
        'Cannot refresh Slack tokens — OAuth credentials not available',
      );
      return false;
    }

    // 4. Refresh bot token
    const botRefreshResponse = await fetch(slackApiUrl('/api/oauth.v2.access'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: tokens.botRefreshToken,
      }),
    });

    const botData: SlackOAuthResponse = await botRefreshResponse.json();

    if (!botData.ok || !botData.access_token) {
      log.error({ teamId, error: botData.error }, 'Failed to refresh Slack bot token');
      return false;
    }

    // Update bot token fields
    tokens.botToken = botData.access_token;
    tokens.botRefreshToken = botData.refresh_token;
    tokens.botExpiresAt = botData.expires_in ? Date.now() + botData.expires_in * 1000 : undefined;

    // 5. Refresh user token if a user refresh token exists
    if (tokens.userRefreshToken) {
      const userRefreshResponse = await fetch(slackApiUrl('/api/oauth.v2.access'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: tokens.userRefreshToken,
        }),
      });

      const userData: SlackOAuthResponse = await userRefreshResponse.json();

      // Refresh responses return tokens at top level (not nested under authed_user)
      if (userData.ok && userData.access_token) {
        tokens.userToken = userData.access_token;
        tokens.userRefreshToken = userData.refresh_token;
        tokens.userExpiresAt = userData.expires_in
          ? Date.now() + userData.expires_in * 1000
          : undefined;
      } else {
        // User token refresh failed — log but don't fail the whole operation
        // Bot token was already refreshed successfully
        log.warn({ teamId, error: userData.error }, 'Failed to refresh Slack user token (bot token refreshed OK)');
      }
    }

    // 6. Write updated tokens back to disk
    await ensureSlackConfigDirectories();
    await sweepStaleTemps(path.join(getConfigDir(), 'workspaces'));
    await atomicCredentialWrite(getTokenPath(teamId), JSON.stringify(tokens, null, 2), { mode: 0o600 });
    log.info({ teamId }, 'Slack tokens refreshed successfully');
    return true;
  } catch (err) {
    log.error({ err, teamId }, 'Failed to refresh Slack tokens');
    // Re-read from disk: another process (e.g., MCP's SlackTokenProvider) may have
    // already refreshed successfully while we were failing
    try {
      const fallbackData = await fs.readFile(getTokenPath(teamId), 'utf8');
      const fallbackTokens: SlackTokens = JSON.parse(fallbackData);
      if (fallbackTokens.botExpiresAt && fallbackTokens.botExpiresAt > Date.now() + 60_000) {
        log.info({ teamId }, 'Another process refreshed tokens successfully');
        return true;
      }
    } catch { /* ignore — disk read failed too */ }
    return false;
  }
}

/**
 * @deprecated Use getSlackTokensForWorkspace for specific workspace.
 * This only returns tokens for the first workspace.
 */
export async function getSlackTokens(): Promise<SlackTokensResult | null> {
  const workspaces = await getSlackWorkspaces();
  if (workspaces.length === 0) return null;
  return getSlackTokensForWorkspace(workspaces[0].teamId);
}
