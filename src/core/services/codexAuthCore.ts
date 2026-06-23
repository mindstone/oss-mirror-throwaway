/**
 * Codex OAuth — cross-surface auth core.
 *
 * Everything in this file is platform-agnostic (pure HTTP + JWT decode + store
 * access). Desktop, cloud, and mobile all run the SAME refresh + getter logic.
 *
 * What does NOT live here: the interactive OAuth LOGIN flow (loopback HTTP
 * server + `shell.openExternal`) — that is genuinely desktop-only and lives in
 * `src/main/services/codexAuthService.ts`.
 *
 * Historical context: previously these functions lived in
 * `src/main/services/codexAuthService.ts` and were inaccessible from cloud /
 * mobile, which caused the Codex proxy retry loop when `activeProvider: 'codex'`
 * synced to a surface that had no tokens. Moving them here (combined with the
 * token-sync IPC channel) is what actually makes ChatGPT Pro work on cloud.
 */

import { createScopedLogger } from '@core/logger';
import {
  saveCodexTokens,
  loadCodexTokens,
  clearCodexTokens,
  hasCodexTokens,
  type CodexTokens,
} from '@core/services/tokenStorage/codexTokenStorage';

const log = createScopedLogger({ service: 'codex-auth-core' });

// ─── Constants ──────────────────────────────────────────────────────
/**
 * Public Codex CLI client ID — published alongside the OAuth flow.
 * Shared across desktop, cloud, mobile (they all refresh the same way).
 */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/** Codex Responses API endpoint (ChatGPT subscription). */
export const CODEX_ENDPOINT_URL = 'https://chatgpt.com/backend-api/codex/responses';

/** Refresh tokens when within this many ms of expiry. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;
const TOKEN_REFRESH_MAX_ATTEMPTS = 3;
const TOKEN_REFRESH_RETRY_BASE_DELAY_MS = 500;

// ─── Module state ───────────────────────────────────────────────────
let pendingRefreshPromise: Promise<CodexTokens | null> | null = null;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── JWT decode ─────────────────────────────────────────────────────

interface CodexJwtPayload {
  chatgpt_account_id?: string;
  'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
  organizations?: Array<{ id?: string }>;
  email?: string;
  exp?: number;
  [key: string]: unknown;
}

export function decodeJwtPayload(token: string): CodexJwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      log.warn('JWT does not have 3 parts');
      return null;
    }
    const payloadB64 = parts[1];
    const base64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    const payload = JSON.parse(json) as CodexJwtPayload;
    if (typeof payload !== 'object' || payload === null) {
      log.warn('JWT payload is not an object');
      return null;
    }
    return payload;
  } catch (error) {
    log.warn({ err: error }, 'Failed to decode JWT payload');
    return null;
  }
}

/**
 * Extract `chatgpt_account_id` from a JWT payload using a 3-level fallback.
 * Tries id_token first, then access_token.
 */
export function extractAccountId(...tokens: (string | undefined | null)[]): string | null {
  for (const token of tokens) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload) continue;

    if (typeof payload.chatgpt_account_id === 'string' && payload.chatgpt_account_id) {
      return payload.chatgpt_account_id;
    }
    const authNs = payload['https://api.openai.com/auth'];
    if (authNs && typeof authNs.chatgpt_account_id === 'string' && authNs.chatgpt_account_id) {
      return authNs.chatgpt_account_id;
    }
    const orgs = payload.organizations;
    if (Array.isArray(orgs) && orgs.length > 0 && typeof orgs[0]?.id === 'string' && orgs[0].id) {
      return orgs[0].id;
    }
  }
  return null;
}

// ─── Token refresh ──────────────────────────────────────────────────

/**
 * Refresh Codex tokens using the refresh_token grant.
 * Single-flight: concurrent callers share the same promise.
 * Pure HTTP — runs on desktop and cloud identically.
 */
async function refreshTokens(currentTokens: CodexTokens): Promise<CodexTokens | null> {
  if (pendingRefreshPromise) {
    return pendingRefreshPromise;
  }

  pendingRefreshPromise = (async () => {
    try {
      log.info('Refreshing Codex access token');

      const response = await fetch(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CODEX_CLIENT_ID,
          refresh_token: currentTokens.refreshToken,
        }).toString(),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        log.error({ status: response.status, error: errorText }, 'Codex token refresh failed');
        // Only clear tokens on auth errors (400/401 = invalid/revoked grant).
        // Preserve tokens on transient server errors (5xx) or rate limits (429).
        if (response.status === 400 || response.status === 401) {
          clearCodexTokens({
            cause: 'refresh_auth_failure',
            source: 'codex_auth_core',
            httpStatus: response.status,
          });
        }
        return null;
      }

      const data = await response.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };

      if (!data.access_token) {
        log.error('No access_token in refresh response');
        clearCodexTokens({
          cause: 'refresh_malformed_response',
          source: 'codex_auth_core',
        });
        return null;
      }

      const accountId = extractAccountId(data.access_token) ?? currentTokens.accountId;
      const payload = decodeJwtPayload(data.access_token);
      const accountEmail = payload?.email ?? currentTokens.accountEmail;

      const expiresIn = data.expires_in ?? 3600;
      const newTokens: CodexTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? currentTokens.refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
        accountId,
        accountEmail,
      };

      saveCodexTokens(newTokens, {
        cause: 'refresh_success',
        source: 'codex_auth_core',
      });
      log.info('Codex tokens refreshed successfully');
      return newTokens;
    } catch (error) {
      log.error({ err: error }, 'Codex token refresh error (transient, tokens preserved)');
      return null;
    } finally {
      pendingRefreshPromise = null;
    }
  })();

  return pendingRefreshPromise;
}

async function refreshTokensWithRetry(currentTokens: CodexTokens): Promise<CodexTokens | null> {
  for (let attempt = 1; attempt <= TOKEN_REFRESH_MAX_ATTEMPTS; attempt++) {
    const refreshed = await refreshTokens(currentTokens);
    if (refreshed) return refreshed;

    // Auth failures clear tokens in refreshTokens(); retrying them only delays
    // the reconnect prompt. Transient failures preserve tokens and can retry.
    if (!hasCodexTokens() || attempt === TOKEN_REFRESH_MAX_ATTEMPTS) {
      return null;
    }

    const delayMs = TOKEN_REFRESH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    log.warn({ attempt, maxAttempts: TOKEN_REFRESH_MAX_ATTEMPTS, delayMs }, 'Codex token refresh failed; retrying');
    await delay(delayMs);
  }

  return null;
}

// ─── Public API ─────────────────────────────────────────────────────

/** Clear stored tokens (logout). */
export async function codexLogout(): Promise<void> {
  log.info('Codex logout');
  clearCodexTokens({
    cause: 'manual_logout',
    source: 'codex_auth_core',
  });
  pendingRefreshPromise = null;
}

/**
 * Force-refresh the Codex access token (e.g. after a 401 from Codex).
 * Bypasses expiry check. Returns null if no refresh token or refresh fails.
 */
export async function forceRefreshCodexAccessToken(): Promise<string | null> {
  const tokens = loadCodexTokens();
  if (!tokens) return null;
  const refreshed = await refreshTokensWithRetry(tokens);
  return refreshed?.accessToken ?? null;
}

/**
 * Get a valid Codex access token, auto-refreshing if needed.
 * Returns null if not connected or refresh fails.
 */
export async function getCodexAccessToken(): Promise<string | null> {
  const tokens = loadCodexTokens();
  if (!tokens) return null;
  if (tokens.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    return tokens.accessToken;
  }
  const refreshed = await refreshTokensWithRetry(tokens);
  return refreshed?.accessToken ?? null;
}

/** Get the ChatGPT account ID from stored tokens. */
export function getCodexAccountId(): string | null {
  const tokens = loadCodexTokens();
  return tokens?.accountId ?? null;
}

/** Check if Codex OAuth tokens are stored. */
export function isCodexConnected(): boolean {
  return hasCodexTokens();
}

/** Codex connection status for IPC / UI. */
export function getCodexStatus(): { connected: boolean; accountEmail?: string } {
  const tokens = loadCodexTokens();
  if (!tokens) return { connected: false };
  return { connected: true, accountEmail: tokens.accountEmail };
}
