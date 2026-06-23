/**
 * Microsoft Graph API Fetch Utility
 *
 * Wraps `fetch()` calls to Microsoft Graph API with automatic 401-retry-with-token-refresh.
 * Manages Microsoft OAuth token lifecycle (read from disk, pre-emptive refresh, 401 retry).
 *
 * Token files are shared with Microsoft MCPs at:
 *   {userData}/microsoft-mcp/credentials/{sanitized-email}.token.json
 *
 * Uses the canonical email sanitization pattern: email.replace(/[^a-zA-Z0-9]/g, '-')
 * (matches microsoftAuthService.ts and MCP tokenProvider.ts)
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { microsoftCredentialSource, resolveMicrosoftClientId } from './oauthCredentials';

const logger = createScopedLogger({ service: 'microsoft-graph-fetch' });

const FIVE_MIN_MS = 5 * 60 * 1000;
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/** Microsoft OAuth token as stored on disk (shared with MCPs). */
interface MicrosoftToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  token_type: string;
  scope: string;
}

/**
 * Canonical email sanitization for token file paths.
 * Matches microsoftAuthService.ts and MCP tokenProvider.ts.
 */
function sanitizeEmail(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Resolve the token file path for a given email. */
function getTokenPath(email: string): string {
  const sanitized = sanitizeEmail(email);
  return path.join(getDataPath(), 'microsoft-mcp', 'credentials', `${sanitized}.token.json`);
}

/** Read the token file from disk. Returns null if not found. */
async function readTokenFromDisk(tokenPath: string): Promise<MicrosoftToken | null> {
  try {
    const data = await fs.readFile(tokenPath, 'utf-8');
    return JSON.parse(data) as MicrosoftToken;
  } catch {
    return null;
  }
}

/** Refresh a Microsoft OAuth token via the token endpoint. Writes the new token to disk. */
async function refreshMicrosoftToken(token: MicrosoftToken, tokenPath: string): Promise<string> {
  const clientId = resolveMicrosoftClientId(microsoftCredentialSource);
  if (!clientId) {
    throw new Error('Microsoft OAuth client ID is not configured. Set MICROSOFT_CLIENT_ID in your environment.');
  }

  const response = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
      scope: token.scope,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh Microsoft token: ${error}`);
  }

  const newToken = await response.json();
  const updatedToken: MicrosoftToken = {
    ...token,
    access_token: newToken.access_token,
    refresh_token: newToken.refresh_token || token.refresh_token,
    expires_at: Date.now() + (newToken.expires_in * 1000),
  };

  await fs.writeFile(tokenPath, JSON.stringify(updatedToken, null, 2));
  logger.info('Refreshed Microsoft token');
  return updatedToken.access_token;
}

/**
 * Get a valid Microsoft access token for the given email.
 * Reads from disk and pre-emptively refreshes if within 5 minutes of expiry.
 */
async function getMicrosoftAccessToken(email: string): Promise<string> {
  const tokenPath = getTokenPath(email);
  const token = await readTokenFromDisk(tokenPath);

  if (!token) {
    throw new Error(
      `No Microsoft token found for ${email}. Please connect your Microsoft account.`,
    );
  }

  // Pre-emptive refresh if expiring within 5 minutes
  if (token.expires_at < Date.now() + FIVE_MIN_MS) {
    logger.info({ email }, 'Token near expiry, pre-emptively refreshing');
    return await refreshMicrosoftToken(token, tokenPath);
  }

  return token.access_token;
}

/**
 * Handle a 401 response by re-reading the token from disk (another process may
 * have refreshed it) and retrying. If the disk token has the same access_token
 * that just failed, force-refresh regardless of expiry.
 */
async function handleUnauthorized(email: string, failedAccessToken: string): Promise<string> {
  const tokenPath = getTokenPath(email);

  // Re-read from disk: another process (MCP) may have already refreshed
  const diskToken = await readTokenFromDisk(tokenPath);

  if (!diskToken) {
    throw new Error(
      `No Microsoft token found for ${email}. Please connect your Microsoft account.`,
    );
  }

  // If disk token differs from the failed one and is fresh, another process refreshed it
  if (diskToken.access_token !== failedAccessToken && diskToken.expires_at > Date.now() + FIVE_MIN_MS) {
    logger.info({ email }, '401 received but disk token is fresh (refreshed by another process)');
    return diskToken.access_token;
  }

  // Same token or stale — force refresh
  logger.info({ email }, '401 received, forcing token refresh');
  return await refreshMicrosoftToken(diskToken, tokenPath);
}

/**
 * Fetch from Microsoft Graph API with automatic token management and 401 retry.
 *
 * - Reads the access token from disk and injects the Authorization header
 * - Pre-emptively refreshes tokens within 5 minutes of expiry
 * - On 401: re-reads disk (another process may have refreshed), then force-refreshes if needed
 * - Retries the request exactly once on 401
 * - Returns the Response (even if the retry also returns 401)
 * - Network errors from fetch propagate unchanged
 *
 * @param url - The Microsoft Graph API URL
 * @param email - The Microsoft account email (used to locate the token file)
 * @param init - Optional RequestInit (headers are merged, Authorization is always set)
 */
export async function fetchMicrosoftGraph(
  url: string,
  email: string,
  init?: RequestInit,
): Promise<Response> {
  const accessToken = await getMicrosoftAccessToken(email);

  // Merge caller headers with Authorization
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);

  const response = await fetch(url, { ...init, headers });

  if (response.status !== 401) {
    return response;
  }

  // 401 — attempt token recovery and retry once
  logger.warn({ email, url }, 'Received 401 from Microsoft Graph, attempting token recovery');
  const freshToken = await handleUnauthorized(email, accessToken);

  const retryHeaders = new Headers(init?.headers);
  retryHeaders.set('Authorization', `Bearer ${freshToken}`);

  return await fetch(url, { ...init, headers: retryHeaders });
}
