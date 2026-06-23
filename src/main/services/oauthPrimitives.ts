/**
 * OAuth Primitives
 *
 * Common patterns extracted from auth services to reduce duplication.
 * These are mechanics-only - callers handle provider-specific logic.
 */

import crypto from 'node:crypto';
import { getElectronModule } from '@core/lazyElectron';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'oauth-primitives' });

/**
 * Generate cryptographically secure CSRF state token.
 * Used by all OAuth flows to prevent CSRF attacks.
 */
export function generateCsrfState(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Best-effort fetch with timeout.
 * Used for token revocation where we don't want to block on failure.
 *
 * @param url - URL to fetch
 * @param options - Fetch options plus optional timeoutMs (default: 5000)
 * @returns Response if successful, null on any error (timeout, network, etc.)
 */
export async function fetchWithTimeoutBestEffort(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<Response | null> {
  const { timeoutMs = 5000, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (err) {
    // Best effort - log and return null
    // SECURITY: Don't log err.message as it may contain sensitive URL data
    if (err instanceof Error && err.name === 'AbortError') {
      log.debug('Best-effort fetch timed out');
    } else {
      log.debug({ reason: err instanceof Error ? err.name : 'unknown' }, 'Best-effort fetch failed');
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Bring the main app window to foreground.
 * Used after OAuth callback to return focus to the app.
 */
export function bringAppToForeground(): void {
  const electron = getElectronModule();
  if (!electron) return;
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: OAuth foregrounding is legacy first-window focusing, no webContents.send; migrate later to main-window getter.
  const mainWindow = electron.BrowserWindow.getAllWindows()[0];
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  electron.app.focus({ steal: true });
}
