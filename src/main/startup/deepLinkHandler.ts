/**
 * Deep-link handling (OAuth callbacks + navigation deep links).
 *
 * Extracted from `src/main/index.ts` (Stage 2 of the index.ts startup refactor —
 * see docs/plans/260623_refactor-index-startup-extract/PLAN.md). Behaviour is
 * preserved verbatim; this module owns the deep-link cluster and imports all of
 * its non-local service dependencies (OAuth callback handlers, MCP services,
 * subscription retry, tracking) DIRECTLY.
 *
 * The only state that genuinely lives in index.ts is injected via `deps`:
 *   - `getMainWindow()` — index.ts owns `mainWindow` as the single source of truth.
 *   - `setPendingNavigationUrl(url)` — the cold-start nav buffer (the A→B coupling
 *     with createWindow, routed through index.ts-owned state, NOT a direct import,
 *     to avoid a module cycle).
 *
 * The `app.on('open-url')` / `app.on('second-instance')` listener registrations
 * and the whenReady protocol setup stay in index.ts (invariants #4/#6) so listener
 * attachment timing is unchanged; index.ts constructs the handler via
 * `createDeepLinkHandler(...)` and calls into it.
 */

import type { BrowserWindow } from 'electron';
import { logger } from '@core/logger';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { SubscriptionCallbackPayload } from '@shared/ipc/channels/subscription';
import { getRebelAuthProvider } from '@core/rebelAuth';
import { forceAuthConfigRefresh } from '@private/mindstone/bootstrap';
import {
  resolveMcpConfigPath,
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution,
  isOAuthAuthInFlight,
} from '../services/mcpService';
import { superMcpHttpManager } from '../services/superMcpHttpManager';
import { trackDeepLinkCallback } from '../services/oauthTelemetry';
import { fetchWithSubscriptionRetry } from '../subscription/subscriptionCheckoutRetry';
import { mainTracking } from '../tracking';
import { getSettings } from '../settingsStore';
import { clearPendingCheckout, getPendingCheckout } from '../services/pendingCheckoutTier';
import { handleSlackOAuthCallback } from '../services/slackAuthService';
import { handleGitHubOAuthCallback } from '../services/githubAuthService';
import { handleContributionGitHubOAuthCallback } from '../services/contributionGitHubAuthService';
import { handleDigitalOceanOAuthCallback } from '../services/digitalOceanAuthService';
import { handleDiscourseAuthCallback } from '../services/discourseAuthService';
import { handleOpenRouterDeepLinkCallback } from '../services/openRouterSetupService';
import { handleMicrosoftOAuthCallback } from '../services/microsoftAuthService';
import { handleSalesforceOAuthCallback } from '../services/salesforceAuthService';
import { handleOutreachOAuthCallback } from '../services/outreachAuthService';
import { handlePlaudOAuthCallback } from '../services/plaud';

// Deep link protocol handler for OAuth callbacks
export const DEEP_LINK_PROTOCOL = 'mindstone';
export const NAV_DEEP_LINK_PROTOCOL = 'rebel';

/**
 * Index.ts-local accessors the deep-link handler depends on. Everything else is
 * imported directly (Decision Log §8.2 refinement) — only these two pieces of
 * state genuinely live in index.ts.
 */
export interface DeepLinkHandlerDeps {
  /** Single source of truth for the main window (index.ts-owned `let`). */
  getMainWindow: () => BrowserWindow | null;
  /** Buffer a navigation URL for cold start (flushed by createWindow). */
  setPendingNavigationUrl: (url: string | null) => void;
}

/**
 * Redact sensitive OAuth params from deep link URLs for safe logging.
 * @param url - The deep link URL to redact
 * @returns The URL with sensitive params replaced with [REDACTED], or [INVALID_URL] on parse error
 */
export function redactDeepLinkUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const sensitiveParams = ['code', 'state', 'token', 'access_token', 'refresh_token', 'payload'];
    for (const param of sensitiveParams) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[REDACTED]');
      }
    }
    return parsed.toString();
  } catch {
    return '[INVALID_URL]';
  }
}

/**
 * Create the deep-link handler. `lastOAuthDeepLinkReconfigure` lives as private
 * closure state here (the 5s OAuth-reconfigure debounce — invariant #9).
 */
export function createDeepLinkHandler(deps: DeepLinkHandlerDeps): {
  handleDeepLink: (url: string) => void;
  handleNavigationDeepLink: (url: string) => void;
} {
  const { getMainWindow, setPendingNavigationUrl } = deps;
  let lastOAuthDeepLinkReconfigure = 0;

  /**
   * Handle navigation deep links (rebel://space/..., rebel://settings/..., rebel://plugin/..., etc.)
   * Sends the URL to the renderer for navigation, or buffers it if the renderer isn't ready.
   */
  function handleNavigationDeepLink(url: string): void {
    logger.info({ url }, 'Received navigation deep link');
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:navigate-deep-link', url);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      setPendingNavigationUrl(url);
    }
  }

  /**
   * Handle incoming deep link URLs (e.g., mindstone://slack/callback?code=xxx)
   */
  function handleDeepLink(url: string): void {
    logger.info({ url: redactDeepLinkUrl(url) }, 'Received deep link');

    // Navigation deep links (rebel://space/..., rebel://settings/..., etc.)
    if (url.startsWith(`${NAV_DEEP_LINK_PROTOCOL}://`)) {
      handleNavigationDeepLink(url);
      return;
    }

    if (url.startsWith(`${DEEP_LINK_PROTOCOL}://subscription/callback`)) {
      logger.info('Received subscription callback deep link');
      // Restore/focus window immediately for responsive UX
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
      const urlObj = new URL(url);
      const status = urlObj.searchParams.get('status') ?? 'unknown';
      const sessionId = urlObj.searchParams.get('session_id');
      // Capture the expected tier (consumes the pending stash) so every retry
      // iteration sees the same expectation, and so cancel callbacks below
      // also clear it without polling.
      const expectedTier = status === 'success' ? getPendingCheckout(sessionId) : null;
      const emitSubscriptionCallback = (): void => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          // Typed via the shared SubscriptionCallbackPayload so the expectedTier
          // carried to the renderer can't drift from what the bridge parses.
          const payload: SubscriptionCallbackPayload = {
            status,
            ...(status === 'success' && expectedTier ? { expectedTier } : {}),
          };
          win.webContents.send('subscription:callback', payload);
        }
        if (status === 'success' || status === 'cancel') {
          const finalSubState = getRebelAuthProvider().getSubscriptionState();
          mainTracking.subscription.checkoutCallbackReceived({
            status,
            ...(finalSubState?.tier ? { tier: finalSubState.tier } : {})
          });
        }
      };
      if (status !== 'success') {
        clearPendingCheckout(sessionId);
        emitSubscriptionCallback();
        return;
      }
      // Fetch auth config FIRST so the managed API key is stored in secure
      // storage before notifying the renderer. Without this sequencing, the
      // onboarding auto-select can switch to 'mindstone' provider before the
      // key exists, causing a "key not available" error on first message.
      //
      // For successful checkouts, retry with backoff if subscription data
      // hasn't been populated yet — the Stripe webhook may not have been
      // processed by the server when the redirect fires. For upgrades, also
      // wait until the tier reflects the requested upgrade target; otherwise
      // a pre-existing active subscription would short-circuit the loop.
      //
      // Retry-budget asymmetry is intentional: main process keeps the
      // authoritative expectedTier window for ~62s (2+4+8+16+32), while the
      // renderer stays a cosmetic short-window catch-up at ~14s (2+3+4+5+5).
      // If Stripe webhook delays exceed ~62s, both paths can exhaust and the
      // UI may stay stale (see DI-2 in 260520_pro_to_expert_upgrade_not_reflected.md).
      // The loop itself lives in ../subscription/subscriptionCheckoutRetry (testable seam).
      //
      // B3 carve-out (S5/R1): the seam's `fetchAuthConfig` dependency is injected with
      // forceAuthConfigRefresh from @private/mindstone/bootstrap (real → raw fetchAuthConfig;
      // OSS stub → no-op). It must be the RAW force-refresh, not the debounced
      // requestAuthConfigRefresh, so the retry loop actually re-fetches each attempt.
      fireAndForget(
        fetchWithSubscriptionRetry(
          { status, expectedTier },
          {
            fetchAuthConfig: forceAuthConfigRefresh,
            getSubscriptionState: () => getRebelAuthProvider().getSubscriptionState(),
            getCachedAuthConfig: () => getRebelAuthProvider().getCachedAuthConfig(),
            logger,
          },
        ).finally(() => {
          clearPendingCheckout(sessionId);
          emitSubscriptionCallback();
        }),
        'index.handleDeepLink.subscriptionCheckoutFetch',
      );
      return;
    }

    if (url.startsWith(`${DEEP_LINK_PROTOCOL}://slack/callback`)) {
      handleSlackOAuthCallback(url).catch((err) => {
        logger.error({ err }, 'Failed to handle Slack OAuth callback');
      });
    } else if (url.startsWith(`${DEEP_LINK_PROTOCOL}://microsoft/callback`)) {
      handleMicrosoftOAuthCallback(url).catch((err) => {
        logger.error({ err }, 'Failed to handle Microsoft OAuth callback');
      });
    } else if (url.startsWith(`${DEEP_LINK_PROTOCOL}://salesforce/callback`)) {
      handleSalesforceOAuthCallback(url).catch((err) => {
        logger.error({ err }, 'Failed to handle Salesforce OAuth callback');
      });
    } else if (url.startsWith(`${DEEP_LINK_PROTOCOL}://outreach/callback`)) {
      handleOutreachOAuthCallback(url).catch((err) => {
        logger.error({ err }, 'Failed to handle Outreach OAuth callback');
      });
    } else if (url.startsWith(`${DEEP_LINK_PROTOCOL}://plaud/callback`)) {
      handlePlaudOAuthCallback(url).catch((err) => {
        logger.error({ err }, 'Failed to handle Plaud OAuth callback');
      });
    } else if (url.startsWith(`${DEEP_LINK_PROTOCOL}://contribution/callback`)) {
      handleContributionGitHubOAuthCallback(url).catch((err) => {
        logger.error({ err }, 'Failed to handle contribution GitHub OAuth callback');
      });
    } else if (url.startsWith(`${DEEP_LINK_PROTOCOL}://github/callback`)) {
      handleGitHubOAuthCallback(url).catch((err) => {
        logger.error({ err }, 'Failed to handle GitHub OAuth callback');
      });
    } else if (url.startsWith(`${DEEP_LINK_PROTOCOL}://digitalocean/callback`)) {
      handleDigitalOceanOAuthCallback(url).catch((err) => {
        logger.error({ err }, 'Failed to handle DigitalOcean OAuth callback');
      });
    } else if (url.startsWith(`${DEEP_LINK_PROTOCOL}://discourse/callback`)) {
      handleDiscourseAuthCallback(url).catch((err) => {
        logger.error({ err }, 'Failed to handle Discourse auth callback');
      });
    } else if (url.startsWith(`${DEEP_LINK_PROTOCOL}://openrouter/callback`)) {
      handleOpenRouterDeepLinkCallback(url).catch((err) => {
        logger.error({ err }, 'Failed to handle OpenRouter OAuth callback');
      });
    } else if (url.startsWith(`${DEEP_LINK_PROTOCOL}://settings/connectors`)) {
      // OAuth success pages redirect here after completing authentication.
      // Trigger a Super-MCP reconfigure to pick up newly saved tokens,
      // but only if no auth call is currently in-flight (to avoid restarting
      // Super-MCP while callSuperMcpAuthenticate is waiting for a response).
      // Debounce: skip if triggered within last 5s (auto-redirect + manual click).
      const now = Date.now();
      if (now - lastOAuthDeepLinkReconfigure < 5000) {
        logger.debug('Skipping deep-link reconfigure — triggered within last 5s');
      } else if (!isOAuthAuthInFlight()) {
        lastOAuthDeepLinkReconfigure = now;
        const configPath = resolveMcpConfigPath(getSettings());
        if (configPath) {
          // Execution-awaiting opt-in by name (260610 API split), deliberately
          // NOT awaited: the .then below genuinely depends on the restart having
          // completed (it tells the renderer the new tokens are live), but this
          // deep-link handler must not block on the deferred restart.
          reconfigureSuperMcpWithCacheRefreshAndAwaitExecution(configPath, { context: 'oauth-deep-link-return' })
            .then(() => {
              // Notify renderer so connections panel refreshes (same event as initial startup)
              const win = getMainWindow();
              if (win && !win.isDestroyed()) {
                const smState = superMcpHttpManager.getState();
                win.webContents.send('super-mcp:startup-succeeded', {
                  port: smState.port ?? 0,
                  attempts: 1,
                });
              }
            })
            .catch((err) => {
              logger.warn({ err }, 'Failed to reconfigure Super-MCP after OAuth deep link return');
            });
        }
      } else {
        logger.debug('Skipping deep-link reconfigure — OAuth auth call still in flight');
      }
    }

    // Track OAuth callback receipt for deep-link providers (after dispatch, never blocks callback handling)
    if (url.includes('/callback')) {
      trackDeepLinkCallback(url);
    }

    // Bring app to foreground
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  }

  return { handleDeepLink, handleNavigationDeepLink };
}
