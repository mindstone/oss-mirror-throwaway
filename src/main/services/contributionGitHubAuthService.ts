/**
 * Contribution GitHub Auth Service
 *
 * COMPLETELY SEPARATE OAuth2 flow for community connector contributions.
 * Requests `public_repo` scope (unlike the existing zero-scope GitHub MCP OAuth).
 *
 * NOTE (OSS Stage-5 strategic cut, 260604): the connect/disconnect/status entry
 * points (`startContributionGitHubAuth` / `removeContributionGitHubAccount` /
 * `getContributionGitHubAuthStatus`) and their IPC/renderer surfaces were
 * removed. What remains live is the stored-token path: `getContributionGitHubToken()`
 * (with silent single-flight refresh) for PR submission, plus the deep-link
 * callback handler wired in `src/main/index.ts`.
 *
 * Flow (token storage/refresh):
 * 1. App handles the mindstone://contribution/callback deep link, validates
 *    state, exchanges code for tokens
 * 2. Save tokens in contribution-specific storage (NOT ~/.super-mcp/)
 * 3. `getContributionGitHubToken()` serves + silently refreshes the stored token
 *
 * Security:
 * - Token directory: 0o700
 * - Token files: 0o600, written atomically (temp + rename)
 * - PKCE with S256 challenge method
 * - CSRF state validation on callback
 * - Expiry check on auth status
 *
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P4.5 + D7)
 */

import { URL } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createScopedLogger } from '@core/logger';

import { bringAppToForeground } from './oauthPrimitives';
import { clearCachedUsername } from './contributionGitHubUsernameCache';

const log = createScopedLogger({ service: 'contribution-github-auth' });

// ─── Constants ──────────────────────────────────────────────────────

/** GitHub OAuth token endpoint */
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/**
 * Redirect URI — must match the GitHub OAuth App's "Authorization callback URL".
 * The backend at this endpoint redirects to the mindstone://contribution/callback deep link.
 * (separate endpoint from the MCP connector callback)
 */
const REDIRECT_URI = 'https://rebel.mindstone.com/connect/contribution/callback';

/**
 * Contribution OAuth App credentials — separate from the MCP connector GitHub OAuth App.
 * The MCP connector app has zero scopes; this one requests `public_repo` for fork/push/PR.
 * OSS scrub: env-only resolution; missing env throws at first use.
 */
const CONTRIBUTION_CLIENT_ID = process.env.CONTRIBUTION_GITHUB_CLIENT_ID ?? '';
const CONTRIBUTION_CLIENT_SECRET = process.env.CONTRIBUTION_GITHUB_CLIENT_SECRET ?? '';

/** Request public_repo scope — needed to fork, push, and create PRs. */
const CONTRIBUTION_SCOPES = ['public_repo'];

/**
 * Pre-expiry refresh buffer: treat a token as expired when it is within this
 * window of its `expires_at`. Avoids the race where `isTokenExpired()` says
 * "still valid" but GitHub has already rejected the access token by the time
 * the HTTPS request arrives. Matches `codexAuthService.ts`'s 5-minute buffer.
 *
 * See docs/plans/260424_contribution_github_refresh_token.md §4 D14.
 */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;

/**
 * Maximum time to wait on a single refresh `fetch` call before aborting.
 * Prevents the `getContributionGitHubToken()` path from hanging
 * indefinitely on a slow/stalled GitHub connection.
 *
 * See docs/plans/260424_contribution_github_refresh_token.md §4 D18.
 */
const REFRESH_TIMEOUT_MS = 10_000;

// ─── Token Storage Paths ────────────────────────────────────────────

/**
 * Get the contribution token storage directory.
 * Uses ~/.rebel-contribution/ — completely separate from ~/.super-mcp/.
 * Lazy getter so test isolation can redirect os.homedir() if needed.
 */
export function getContributionTokensDir(): string {
  return path.join(os.homedir(), '.rebel-contribution', 'oauth-tokens');
}

function getContributionTokensPath(): string {
  return path.join(getContributionTokensDir(), 'contribution_github_tokens.json');
}

// ─── Types ──────────────────────────────────────────────────────────

interface ContributionGitHubTokenResponse {
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

interface StoredContributionToken {
  access_token: string;
  token_type: string;
  scope: string;
  refresh_token?: string;
  /** ISO timestamp when the token was obtained. */
  obtained_at: string;
  /**
   * ISO timestamp when the access token expires (computed from obtained_at +
   * expires_in). **Only present when the server returned `expires_in`** —
   * historical pre-2026-04 records may have this stamped from the old 8-hour
   * fallback (see D10 backwards-compatibility note).
   */
  expires_at?: string;
  /**
   * ISO timestamp when the *refresh* token expires (GitHub Apps issue these
   * with ~6-month lifetimes). Stored for a future "your GitHub connection
   * will expire soon" warning.
   * TODO: consume in UI warning when refresh token nears expiry (I3).
   */
  refresh_token_expires_at?: string;
}

// ─── Module State for Pending OAuth ─────────────────────────────────

let pendingAuth: {
  codeVerifier: string;
  state: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
} | null = null;

/**
 * Monotonic counter incremented whenever the stored auth state is
 * deliberately changed out from under any in-flight refresh — on
 * successful callback (re-auth with a new identity). In-flight refreshes
 * capture this value at start and bail without writing if it changes by
 * the time they complete.
 *
 * See docs/plans/260424_contribution_github_refresh_token.md §4 D15.
 */
let currentAuthGeneration = 0;

/**
 * Single-flight lock for token refresh: concurrent callers of
 * `getContributionGitHubToken()` share one in-flight request.
 * Reset to null in `finally`.
 */
let pendingRefreshPromise: Promise<StoredContributionToken | null> | null = null;

// ─── Token Storage with Security Hardening ──────────────────────────

/**
 * Ensure the token directory exists with restrictive permissions (0o700).
 */
async function ensureContributionTokenDir(): Promise<void> {
  const dir = getContributionTokensDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Enforce permissions after creation (mkdir may not apply mode on existing dirs)
  if (process.platform !== 'win32') {
    await fs.chmod(dir, 0o700);
  }
}

/**
 * Write token file atomically: write to temp file, then rename.
 * File permissions: 0o600 (owner read/write only).
 */
async function writeContributionTokenFile(token: StoredContributionToken): Promise<void> {
  await ensureContributionTokenDir();
  const targetPath = getContributionTokensPath();
  const tempPath = `${targetPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;

  try {
    await fs.writeFile(tempPath, JSON.stringify(token, null, 2), { mode: 0o600 });
    // Enforce permissions after write (some systems ignore mode in writeFile)
    if (process.platform !== 'win32') {
      await fs.chmod(tempPath, 0o600);
    }
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    // Clean up temp file on failure
    try { await fs.unlink(tempPath); } catch { /* ignore cleanup errors */ }
    throw err;
  }
}

/**
 * Read stored contribution token.
 * Returns null if no token file exists or it's unreadable.
 */
async function readContributionTokenFile(): Promise<StoredContributionToken | null> {
  try {
    const content = await fs.readFile(getContributionTokensPath(), 'utf-8');
    return JSON.parse(content) as StoredContributionToken;
  } catch {
    return null;
  }
}

// ─── Expiry Check ───────────────────────────────────────────────────

/**
 * Check if a stored token has expired or is about to expire (within
 * `TOKEN_REFRESH_BUFFER_MS` of `expires_at`).
 *
 * Treats tokens without `expires_at` as non-expired: GitHub OAuth App
 * tokens don't expire, and GitHub App tokens now persist `expires_at`
 * only when the server actually returned `expires_in` (per D1 — no more
 * 8-hour artificial fallback).
 */
function isTokenExpired(token: StoredContributionToken): boolean {
  if (!token.expires_at) {
    return false;
  }
  return new Date(token.expires_at).getTime() - Date.now() <= TOKEN_REFRESH_BUFFER_MS;
}

// ─── Token Exchange ─────────────────────────────────────────────────

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
): Promise<ContributionGitHubTokenResponse> {
  const bodyParams: Record<string, string> = {
    client_id: CONTRIBUTION_CLIENT_ID,
    client_secret: CONTRIBUTION_CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  };

  const body = new URLSearchParams(bodyParams);

  log.info({
    redirectUri: REDIRECT_URI,
    clientId: CONTRIBUTION_CLIENT_ID,
  }, 'Exchanging contribution auth code for tokens');

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  const responseText = await response.text();
  log.info({ status: response.status }, 'Contribution token exchange response received');

  let data: ContributionGitHubTokenResponse;
  try {
    data = JSON.parse(responseText) as ContributionGitHubTokenResponse;
  } catch {
    throw new Error(`Token exchange failed: ${response.status} - invalid JSON response`);
  }

  if (data.error || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? 'Token exchange failed');
  }

  return data;
}

// ─── Token Refresh (on-demand, single-flight) ───────────────────────

/**
 * Best-effort unlink of the stored token file. Swallows ENOENT (file
 * may not exist yet) but lets other errors surface to the caller.
 */
async function unlinkStoredTokenFile(): Promise<void> {
  try {
    await fs.unlink(getContributionTokensPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Refresh the contribution GitHub access token using the stored
 * refresh_token (GitHub App rotating-refresh-token flow).
 *
 * Single-flight: concurrent callers share the same `pendingRefreshPromise`.
 *
 * Security:
 * - Never logs access_token, refresh_token, client_secret, or any provider-
 *   supplied `error_description` / response body / Error.message (D13).
 * - Auth-generation guard: if a successful re-auth callback runs while this
 *   is in flight, the generation counter diverges and the result is
 *   discarded without writing (D15).
 * - `AbortController` with 10-second timeout on the fetch (D18).
 * - Atomic rotation via the existing `writeContributionTokenFile`. If the
 *   rename fails after a successful GitHub refresh, the stored token file is
 *   explicitly unlinked (D19) — the old refresh_token is already invalid
 *   server-side, so silently retaining it would produce a confusing
 *   `bad_refresh_token` on the next call.
 *
 * Failure taxonomy (only `bad_refresh_token` in the response body is a WIPE;
 * everything else is TRANSIENT, see D16 + §6 Failure Matrix):
 * - Body has `error: "bad_refresh_token"` (any HTTP status) → wipe, return null
 * - Any other HTTP error (4xx / 5xx without that body)     → retain, return null
 * - Network throw, abort/timeout, invalid JSON             → retain, return null
 * - 200 but missing `access_token` (without bad-token sig) → retain, return null (D16)
 * - 200 with `access_token` but missing `expires_in`       → retain, return null (D17)
 * - Generation mismatch on completion                      → discard, return null (D15)
 * - Persist (rename) throws after success                  → unlink stored file, return null (D19)
 *
 * @param current The currently stored token (must have a `refresh_token`).
 * @returns The rotated `StoredContributionToken` on success, `null` on any failure.
 */
async function refreshContributionGitHubToken(
  current: StoredContributionToken,
): Promise<StoredContributionToken | null> {
  if (pendingRefreshPromise) {
    return pendingRefreshPromise;
  }

  const refreshToken = current.refresh_token;
  if (!refreshToken) {
    // Caller is expected to guard against this, but be defensive.
    log.warn(
      { event: 'refresh_skipped_no_refresh_token' },
      'refreshContributionGitHubToken called without a stored refresh_token',
    );
    return null;
  }

  const startGeneration = currentAuthGeneration;

  pendingRefreshPromise = (async (): Promise<StoredContributionToken | null> => {
    log.info({ event: 'refresh_attempt' }, 'Refreshing contribution GitHub access token');

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: CONTRIBUTION_CLIENT_ID,
          client_secret: CONTRIBUTION_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure or abort. Preserve tokens — this is transient.
      const aborted = (err as { name?: string } | null)?.name === 'AbortError';
      log.warn(
        { event: 'refresh_failed_transient', reason: aborted ? 'timeout' : 'network' },
        'Contribution GitHub refresh failed (transient)',
      );
      return null;
    } finally {
      clearTimeout(timeoutHandle);
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch {
      log.warn(
        { event: 'refresh_failed_transient', reason: 'body_read_failed', status: response.status },
        'Contribution GitHub refresh failed (transient)',
      );
      return null;
    }

    let data: ContributionGitHubTokenResponse | null = null;
    try {
      data = JSON.parse(bodyText) as ContributionGitHubTokenResponse;
    } catch {
      log.warn(
        { event: 'refresh_failed_transient', reason: 'invalid_json', status: response.status },
        'Contribution GitHub refresh failed (transient)',
      );
      return null;
    }

    // D16: ONLY `error === 'bad_refresh_token'` in the body is a wipe signal,
    // regardless of HTTP status. Any other non-OK response is transient.
    if (data?.error === 'bad_refresh_token') {
      log.warn(
        { event: 'refresh_failed_bad_token', status: response.status },
        'Contribution GitHub refresh_token is invalid; wiping stored token file',
      );
      try {
        await unlinkStoredTokenFile();
      } catch (unlinkErr) {
        log.warn(
          { event: 'refresh_failed_bad_token', reason: 'unlink_failed', code: (unlinkErr as NodeJS.ErrnoException).code },
          'Failed to remove contribution token file after bad_refresh_token',
        );
      }
      return null;
    }

    if (!response.ok) {
      // Bare 4xx / 5xx without a `bad_refresh_token` body — transient per D16.
      log.warn(
        { event: 'refresh_failed_transient', status: response.status, errorCode: data?.error ?? null },
        'Contribution GitHub refresh failed (transient)',
      );
      return null;
    }

    const accessToken = data?.access_token;
    if (!accessToken) {
      // 200 OK with a body that has no access_token AND is not a bad_refresh_token
      // signal — treat as malformed / transient per D16 (never wipe on bare
      // missing fields).
      log.warn(
        { event: 'refresh_failed_transient', reason: 'missing_access_token', errorCode: data?.error ?? null },
        'Contribution GitHub refresh failed (transient)',
      );
      return null;
    }

    const expiresIn = data?.expires_in;
    if (typeof expiresIn !== 'number' || !(expiresIn > 0)) {
      // D17: a successful refresh response MUST include expires_in. Without
      // it we can't compute a correct expires_at, so treat as transient and
      // retain the stored tokens for the next attempt.
      log.warn(
        { event: 'refresh_failed_transient', reason: 'missing_expires_in' },
        'Contribution GitHub refresh response missing expires_in',
      );
      return null;
    }

    // Check the auth-generation guard BEFORE writing. A re-auth callback
    // may have landed while we were waiting for the network (D15).
    if (currentAuthGeneration !== startGeneration) {
      log.info(
        { event: 'refresh_discarded_disconnect' },
        'Contribution GitHub refresh result discarded: auth state changed during refresh',
      );
      return null;
    }

    const obtainedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const refreshTokenExpiresAt = typeof data?.refresh_token_expires_in === 'number'
      && data.refresh_token_expires_in > 0
      ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString()
      : current.refresh_token_expires_at;

    const rotated = Boolean(data?.refresh_token);
    const newStored: StoredContributionToken = {
      access_token: accessToken,
      token_type: data?.token_type ?? current.token_type,
      scope: data?.scope ?? current.scope,
      // Rotate when present (D8); preserve old otherwise. GitHub Apps
      // always rotate in practice.
      refresh_token: data?.refresh_token ?? refreshToken,
      obtained_at: obtainedAt,
      expires_at: expiresAt,
      ...(refreshTokenExpiresAt && { refresh_token_expires_at: refreshTokenExpiresAt }),
    };

    try {
      await writeContributionTokenFile(newStored);
    } catch {
      // D19: persist failure after a successful GitHub refresh. GitHub has
      // already rotated the refresh_token server-side, so the stored one is
      // dead. Explicitly unlink — next call will surface a re-auth prompt
      // rather than a misleading `bad_refresh_token` on the next refresh.
      try {
        await unlinkStoredTokenFile();
      } catch {
        // ignore — best effort; the write failure is the primary issue.
      }
      log.error(
        { event: 'refresh_failed_persist_wiped' },
        'Contribution GitHub refresh succeeded but persist failed; stored token file wiped',
      );
      return null;
    }

    // Re-check generation after the successful atomic write: if a disconnect
    // landed in the narrow window between our pre-write check and the
    // rename, undo our write so disconnect wins.
    if (currentAuthGeneration !== startGeneration) {
      try {
        await unlinkStoredTokenFile();
      } catch {
        // ignore — best effort.
      }
      log.info(
        { event: 'refresh_discarded_disconnect' },
        'Contribution GitHub refresh result discarded after write: auth state changed during refresh',
      );
      return null;
    }

    log.info(
      { event: 'refresh_succeeded', rotated },
      'Contribution GitHub access token refreshed',
    );
    return newStored;
  })().finally(() => {
    pendingRefreshPromise = null;
  });

  return pendingRefreshPromise;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Handle the OAuth callback from the deep link.
 * Called from the protocol handler when mindstone://contribution/callback is received.
 */
export async function handleContributionGitHubOAuthCallback(url: string): Promise<void> {
  if (!pendingAuth) {
    log.warn(
      { uptimeSeconds: Math.round(process.uptime()) },
      'Received contribution GitHub OAuth callback but no auth is pending',
    );
    return;
  }

  const { codeVerifier, state, resolve, reject, timeout } = pendingAuth;
  clearTimeout(timeout);
  pendingAuth = null;

  try {
    const callbackUrl = new URL(url);
    const code = callbackUrl.searchParams.get('code');
    const error = callbackUrl.searchParams.get('error');
    const errorDescription = callbackUrl.searchParams.get('error_description');
    const returnedState = callbackUrl.searchParams.get('state');

    // Security: Validate CSRF state parameter
    if (!returnedState || returnedState !== state) {
      log.error(
        { returnedState, expectedState: '[present]' },
        '[SECURITY] Contribution OAuth state mismatch - possible CSRF attack',
      );
      throw new Error('OAuth state mismatch - possible CSRF attack');
    }

    if (error || !code) {
      throw new Error(errorDescription ?? error ?? 'No authorization code received');
    }

    // Clear any cached username from the GitHub service so that
    // the next API call fetches the (potentially different) authenticated user.
    clearCachedUsername();

    log.info('Exchanging contribution auth code for tokens');
    const tokenData = await exchangeCodeForTokens(code, codeVerifier);

    // Compute expiry timestamp ONLY when the server actually returned
    // expires_in. Per D1: no more 8-hour artificial fallback — a missing
    // `expires_in` means "don't know / doesn't expire", not "assume 8h".
    const obtainedAt = new Date().toISOString();
    const expiresAt = typeof tokenData.expires_in === 'number' && tokenData.expires_in > 0
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : undefined;
    const refreshTokenExpiresAt = typeof tokenData.refresh_token_expires_in === 'number'
      && tokenData.refresh_token_expires_in > 0
      ? new Date(Date.now() + tokenData.refresh_token_expires_in * 1000).toISOString()
      : undefined;

    // access_token is guaranteed non-null: exchangeCodeForTokens throws if missing
    const accessToken = tokenData.access_token ?? '';
    const storedToken: StoredContributionToken = {
      access_token: accessToken,
      token_type: tokenData.token_type ?? 'bearer',
      scope: tokenData.scope ?? CONTRIBUTION_SCOPES.join(' '),
      ...(tokenData.refresh_token && { refresh_token: tokenData.refresh_token }),
      obtained_at: obtainedAt,
      ...(expiresAt && { expires_at: expiresAt }),
      ...(refreshTokenExpiresAt && { refresh_token_expires_at: refreshTokenExpiresAt }),
    };

    // Bump the auth-generation counter BEFORE the atomic write so that any
    // in-flight refresh racing with this callback detects the generation
    // change at its pre-write check and bails without overwriting the
    // freshly-minted tokens (and won't unlink them via its post-write
    // re-check either). Per D15 + refinement Fix 1
    // (see planning doc §Implementation Notes, Fix 1).
    currentAuthGeneration += 1;

    await writeContributionTokenFile(storedToken);

    bringAppToForeground();

    log.info('Contribution GitHub OAuth completed successfully');
    resolve();
  } catch (err) {
    log.error({ err }, 'Contribution GitHub OAuth callback failed');
    reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Get the stored contribution GitHub access token.
 *
 * Returns the access token when valid. When expired (or within the
 * pre-expiry buffer) and a `refresh_token` is available, attempts a
 * silent single-flight refresh and returns the new access token on
 * success. Returns `null` when no token is stored, no refresh_token is
 * available, or the refresh fails.
 */
export async function getContributionGitHubToken(): Promise<string | null> {
  const token = await readContributionTokenFile();
  if (!token?.access_token) return null;
  if (!isTokenExpired(token)) return token.access_token;

  if (!token.refresh_token) {
    log.info(
      { event: 'refresh_skipped_no_refresh_token' },
      'Contribution token expired and no refresh_token stored',
    );
    return null;
  }

  const refreshed = await refreshContributionGitHubToken(token);
  return refreshed?.access_token ?? null;
}

