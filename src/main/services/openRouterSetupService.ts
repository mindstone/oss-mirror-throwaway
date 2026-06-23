/**
 * OpenRouter OAuth PKCE Setup Service
 *
 * Implements OpenRouter's OAuth PKCE flow using the system browser. Packaged
 * builds use a Cloudflare Worker callback + deep link, matching the pattern
 * used by all other OAuth providers (GitHub, Slack, Microsoft, etc.). Dev/OSS
 * builds use a localhost loopback callback so source builds do not depend on
 * OS custom-protocol registration.
 *
 * Key difference from Claude Max: OpenRouter returns a permanent API key
 * (no refresh token, no expiry). This simplifies the service significantly —
 * no token refresh logic, with setup concurrency guarded by generation-scoped
 * single-flight state.
 *
 * The flow:
 *   1. Open the system browser to rebel-auth.mindstone.com/openrouter/start
 *      (sets the Referer header that OpenRouter requires for app attribution)
 *   2. Worker redirects to openrouter.ai/auth with PKCE challenge
 *   3. User authorizes the app on OpenRouter
 *   4. OpenRouter redirects to the selected callback transport:
 *      packaged deep link via rebel-auth.mindstone.com/openrouter/callback,
 *      or dev/OSS localhost loopback on 127.0.0.1
 *   5. App receives the code, exchanges code + code_verifier for permanent API key
 *   6. Store the API key in encrypted storage
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { app, shell } from 'electron';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { getOAuthRedirectUri } from '@core/services/oauthRedirectUri';
import { getSettings } from '@core/services/settingsStore';
import { getBroadcastService } from '@core/broadcastService';
import { bringAppToForeground, generateCsrfState } from './oauthPrimitives';
import { trackOAuthBrowserOpened } from './oauthTelemetry';
import { applyOpenRouterProfileSourceMigration, updateSettings } from '../settingsStore';
import {
  saveOpenRouterTokens,
  clearOpenRouterTokens,
} from './openRouterTokenStorage';
import { getAvailablePort } from '../utils/systemUtils';
import type { AppSettings } from '@shared/types';
import { DEFAULT_OPENROUTER_SETTINGS } from '@shared/types/settings';
import { applyOpenRouterModelDefaults } from '@shared/utils/openRouterDefaults';
import { normalizeApiKey } from '@shared/utils/providerKeys';
import { resolveModelSettings } from '@shared/utils/settingsUtils';

const log = createScopedLogger({ service: 'openrouter-setup' });

// ─── OpenRouter OAuth constants ─────────────────────────────────────

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/auth/keys';

/** Full 10-minute timeout for users to finish browser OAuth without rushing. */
const SETUP_TIMEOUT_MS = 600_000;

/**
 * Cloudflare Worker callback URL (port 443, HTTPS).
 * OpenRouter's OAuth-PKCE docs restrict HTTPS production callback URLs to
 * ports 443 and 3000, but localhost/127.0.0.1 callbacks are allowed on any
 * port; dev/OSS loopback therefore uses a dynamic free port.
 * See: https://openrouter.ai/docs/api/api-reference/o-auth/create-auth-keys-code
 */
const getRedirectUri = () => getOAuthRedirectUri('openrouter');

/**
 * Cloudflare Worker start page that sets the Referer header before redirecting
 * to OpenRouter. OpenRouter uses Referer for app attribution and returns a 409
 * without one. The /start route accepts a ?redirect= param with the full
 * OpenRouter auth URL and serves an HTML meta-refresh redirect.
 */
const getAuthStartUrl = () => getOAuthRedirectUri('openrouter-start');

// ─── Result types ───────────────────────────────────────────────────

export type OpenRouterSetupResult =
  | { outcome: 'success'; maskedKey: string }
  | { outcome: 'cancelled' }
  | { outcome: 'error'; error: string };

// ─── Module state ───────────────────────────────────────────────────

interface PendingAuth {
  generation: number;
  state: string;
  resolve: (value: { code: string }) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingLoopbackAuth {
  generation: number;
  state: string;
  server: http.Server;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

type OpenRouterCallbackMethod = 'deep_link' | 'loopback';

let pendingAuth: PendingAuth | null = null;
let pendingLoopbackAuth: PendingLoopbackAuth | null = null;
let activeSetupGeneration = 0;

// ─── Sentinel errors ────────────────────────────────────────────────

class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError'; }
}

class SetupTimeoutError extends Error {
  constructor() { super('Setup timed out after 10 minutes. Please try again.'); this.name = 'SetupTimeoutError'; }
}

// ─── PKCE helpers ───────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ─── Internal helpers ───────────────────────────────────────────────

function maskKey(key: string): string {
  if (key.length <= 12) return '****';
  return key.slice(0, 8) + '****' + key.slice(-4);
}

function shouldUseLoopbackCallback(): boolean {
  return process.env.OPENROUTER_CALLBACK_MODE === 'loopback'
    || (process.env.OPENROUTER_CALLBACK_MODE !== 'deeplink' && !app.isPackaged);
}

function isCurrent(generation: number): boolean {
  return generation === activeSetupGeneration;
}

function closeHttpServer(server: http.Server): void {
  server.close((err?: Error & { code?: string }) => {
    if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
      log.warn({ err }, 'OpenRouter loopback callback server close failed');
    }
  });
}

function clearDeepLinkAuth(generation: number): void {
  if (pendingAuth?.generation !== generation) return;
  clearTimeout(pendingAuth.timeout);
  pendingAuth = null;
}

function clearLoopbackAuth(generation: number, server: http.Server): void {
  if (pendingLoopbackAuth?.generation !== generation || pendingLoopbackAuth.server !== server) {
    return;
  }
  clearTimeout(pendingLoopbackAuth.timeout);
  pendingLoopbackAuth = null;
}

function cleanup(): void {
  if (pendingAuth) {
    clearTimeout(pendingAuth.timeout);
    pendingAuth = null;
  }
  if (pendingLoopbackAuth) {
    const { server, timeout } = pendingLoopbackAuth;
    clearTimeout(timeout);
    pendingLoopbackAuth = null;
    closeHttpServer(server);
  }
}

function buildOpenRouterAuthUrl(callbackWithState: string, codeChallenge: string): URL {
  const authUrl = new URL(OPENROUTER_AUTH_URL);
  authUrl.searchParams.set('callback_url', callbackWithState);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  return authUrl;
}

async function openOpenRouterAuthInBrowser(
  authUrl: URL,
  authStartUrl: string,
  callbackMethod: OpenRouterCallbackMethod,
): Promise<void> {
  const startUrl = new URL(authStartUrl);
  startUrl.searchParams.set('redirect', authUrl.toString());

  await shell.openExternal(startUrl.toString());
  trackOAuthBrowserOpened({
    connectorName: 'OpenRouter',
    connectorType: 'bundled',
    oauthUrl: authUrl.toString(),
    callbackMethod,
  });
  log.info(
    { callbackMethod },
    'Opened system browser for OpenRouter OAuth',
  );
}

function sendLoopbackHtml(
  res: http.ServerResponse,
  status: number,
  title: string,
  message: string,
): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
</head>
<body>
  <h1>${title}</h1>
  <p>${message}</p>
</body>
</html>`);
}

function waitForDeepLinkAuthorization(
  generation: number,
  state: string,
  codeChallenge: string,
  authStartUrl: string,
): Promise<{ code: string }> {
  return new Promise<{ code: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!isCurrent(generation)) {
        reject(new CancelledError());
        return;
      }

      clearDeepLinkAuth(generation);
      log.warn('OpenRouter OAuth authorization timed out');
      reject(new SetupTimeoutError());
    }, SETUP_TIMEOUT_MS);

    pendingAuth = { generation, state, resolve, reject, timeout };

    // Build the OpenRouter auth URL with PKCE + CSRF state.
    // Note: OpenRouter may not echo state back (it's not in their API docs),
    // so we also embed it in the callback URL for reliable round-tripping.
    const callbackWithState = `${getRedirectUri()}?state=${encodeURIComponent(state)}`;
    const authUrl = buildOpenRouterAuthUrl(callbackWithState, codeChallenge);

    openOpenRouterAuthInBrowser(authUrl, authStartUrl, 'deep_link')
      .catch((err) => {
        if (!isCurrent(generation)) {
          reject(new CancelledError());
          return;
        }

        log.error({ err }, 'Failed to open browser for OpenRouter OAuth');
        clearDeepLinkAuth(generation);
        reject(new Error('Failed to open browser for authentication'));
      });
  });
}

async function waitForLoopbackAuthorization(
  generation: number,
  state: string,
  codeChallenge: string,
  authStartUrl: string,
): Promise<{ code: string }> {
  const port = await getAvailablePort();
  if (!isCurrent(generation)) {
    throw new CancelledError();
  }

  const callbackUrl = new URL(`http://127.0.0.1:${port}/callback`);
  callbackUrl.searchParams.set('state', state);
  const authUrl = buildOpenRouterAuthUrl(callbackUrl.toString(), codeChallenge);

  return new Promise<{ code: string }>((resolve, reject) => {
    const timeoutRef: { current: NodeJS.Timeout | null } = { current: null };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (req.method !== 'GET' || url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');
      const returnedState = url.searchParams.get('state');

      const finish = () => {
        if (isCurrent(generation)) {
          clearLoopbackAuth(generation, server);
        } else if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        closeHttpServer(server);
      };

      if (!isCurrent(generation)) {
        sendLoopbackHtml(
          res,
          410,
          'OpenRouter authorization expired',
          'This authorization request is no longer active. Please return to Rebel and try again.',
        );
        finish();
        reject(new CancelledError());
        return;
      }

      // Security: Validate state parameter to prevent CSRF attacks.
      // State is embedded in the callback URL so it always round-trips.
      if (!returnedState || returnedState !== state) {
        log.error(
          { returnedState, expectedState: '[present]' },
          '[SECURITY] OAuth state mismatch - possible CSRF attack',
        );
        sendLoopbackHtml(
          res,
          400,
          'OpenRouter authorization failed',
          'Security validation failed. Please return to Rebel and try again.',
        );
        finish();
        reject(new Error('OAuth state mismatch - possible CSRF attack'));
        return;
      }

      if (error) {
        const desc = errorDescription ?? error;
        log.error({ error, desc }, 'OpenRouter OAuth callback returned error');
        sendLoopbackHtml(
          res,
          400,
          'OpenRouter authorization failed',
          'OpenRouter returned an authorization error. Please return to Rebel and try again.',
        );
        finish();
        reject(new Error(`Authorization error: ${desc}`));
        return;
      }

      if (!code) {
        sendLoopbackHtml(
          res,
          400,
          'OpenRouter authorization failed',
          'No authorization code was received. Please return to Rebel and try again.',
        );
        finish();
        reject(new Error('No authorization code in callback'));
        return;
      }

      log.info('OpenRouter authorization code received via loopback callback');
      sendLoopbackHtml(
        res,
        200,
        'OpenRouter connected',
        'You can return to Rebel.',
      );
      finish();
      resolve({ code });
    });

    const timeout = setTimeout(() => {
      if (isCurrent(generation)) {
        clearLoopbackAuth(generation, server);
        log.warn('OpenRouter OAuth authorization timed out');
        closeHttpServer(server);
        reject(new SetupTimeoutError());
        return;
      }

      closeHttpServer(server);
      reject(new CancelledError());
    }, SETUP_TIMEOUT_MS);
    timeoutRef.current = timeout;

    pendingLoopbackAuth = { generation, state, server, reject, timeout };

    server.listen(port, '127.0.0.1', () => {
      log.info({ port }, 'OpenRouter loopback callback server started');
      openOpenRouterAuthInBrowser(authUrl, authStartUrl, 'loopback')
        .catch((err) => {
          if (!isCurrent(generation)) {
            clearTimeout(timeout);
            closeHttpServer(server);
            reject(new CancelledError());
            return;
          }

          log.error({ err }, 'Failed to open browser for OpenRouter OAuth');
          clearLoopbackAuth(generation, server);
          closeHttpServer(server);
          reject(new Error('Failed to open browser for authentication'));
        });
    });

    server.on('error', (err) => {
      if (!isCurrent(generation)) {
        clearTimeout(timeout);
        closeHttpServer(server);
        reject(new CancelledError());
        return;
      }

      log.error({ err }, 'OpenRouter loopback callback server error');
      clearLoopbackAuth(generation, server);
      closeHttpServer(server);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * Re-run the OR legacy profileSource migration after an OAuth save.
 *
 * The boot-time migration in `settingsStore.ts` can defer when the OAuth token
 * is momentarily absent at boot (e.g. previous session ended in a disconnected
 * state) or when a stale `providerKeys.openrouter` is set. In those cases the
 * version stamp is intentionally withheld so the migration retries on the next
 * boot — but customers who reconnect via OAuth mid-session then submit a turn
 * before restarting hit the runtime `missing-profile-credentials` failure
 * (the very thing 857fe7312 was meant to close).
 *
 * Running the migration on the save path is the natural closing of that
 * timing window: the act of completing OAuth is unambiguous evidence that
 * legacy OAuth-only OR profiles should be stamped `profileSource: 'connection'`.
 * The migration is idempotent (version-gated) and cheap, so this is safe to
 * call unconditionally after every OAuth save.
 *
 * See docs/postmortems/260513_openrouter_oauth_profile_resolver_missing_credentials_postmortem.md.
 */
function backfillProfileSourceAfterOAuthSave(currentSettings: AppSettings): void {
  try {
    const { migrated, stamped } = applyOpenRouterProfileSourceMigration(currentSettings, log);
    const versionChanged =
      migrated.openRouterProfileSourceMigrationVersion
      !== currentSettings.openRouterProfileSourceMigrationVersion;

    if (stamped === 0 && !versionChanged) return;

    const updates: Partial<AppSettings> = {};
    if (stamped > 0 && migrated.localModel) {
      updates.localModel = migrated.localModel;
    }
    if (versionChanged) {
      updates.openRouterProfileSourceMigrationVersion =
        migrated.openRouterProfileSourceMigrationVersion;
    }
    updateSettings(updates);

    if (stamped > 0) {
      log.info(
        { stamped, source: 'post-oauth-save' },
        'OR legacy profileSource stamped after OAuth save',
      );
    }
  } catch (err) {
    log.error(
      { err },
      'OR profileSource backfill after OAuth save failed — boot migration will retry',
    );
    getErrorReporter().captureException(
      err instanceof Error ? err : new Error(String(err)),
      {
        level: 'warning',
        tags: { area: 'openrouter-setup', migration: 'or-profile-source-backfill' },
        extra: { source: 'post-oauth-save' },
      },
    );
  }
}

/**
 * Exchange the authorization code for a permanent API key.
 */
async function exchangeCodeForKey(
  code: string,
  codeVerifier: string,
): Promise<string> {
  const response = await fetch(OPENROUTER_KEY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: 'S256',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    log.error(
      { status: response.status, responseBody: errorText },
      'OpenRouter key exchange failed',
    );
    getErrorReporter().captureException(new Error(`OR key exchange failed (${response.status})`), {
      level: 'error',
      tags: { area: 'openrouter-setup', operation: 'key-exchange', condition: 'openrouter_key_exchange_failed' },
      extra: { status: response.status, responseBody: errorText },
      fingerprint: ['openrouter-setup', 'key-exchange', String(response.status)],
    });
    throw new Error(`Key exchange failed (${response.status}). Please try again.`);
  }

  const data = (await response.json()) as { key?: string };

  if (!data.key) {
    throw new Error('No API key in exchange response');
  }

  return data.key;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Run the OpenRouter OAuth PKCE setup flow.
 *
 * Opens the system browser via Cloudflare Worker (for Referer header),
 * waits for deep link callback, exchanges code for a permanent API key,
 * and stores it securely.
 */
export async function setupOpenRouterToken(): Promise<OpenRouterSetupResult> {
  log.info('Starting OpenRouter OAuth setup');

  cancelOpenRouterSetup();
  const generation = ++activeSetupGeneration;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateCsrfState();
  const authStartUrl = getAuthStartUrl();
  const useLoopback = shouldUseLoopbackCallback();

  try {
    const { code } = useLoopback
      ? await waitForLoopbackAuthorization(generation, state, codeChallenge, authStartUrl)
      : await waitForDeepLinkAuthorization(generation, state, codeChallenge, authStartUrl);

    if (!isCurrent(generation)) {
      return { outcome: 'cancelled' };
    }

    cleanup();

    log.info('Exchanging OpenRouter authorization code for API key');
    const apiKey = await exchangeCodeForKey(code, codeVerifier);

    if (!isCurrent(generation)) {
      return { outcome: 'cancelled' };
    }

    const masked = maskKey(apiKey);

    saveOpenRouterTokens({ apiKey });

    const currentSettings = getSettings();
    const hasAnthropicKey = !!normalizeApiKey(resolveModelSettings(currentSettings).apiKey);
    const isGenuinelyFreshUser =
      currentSettings.activeProvider === undefined && !hasAnthropicKey;

    if (isGenuinelyFreshUser) {
      // Genuinely fresh user: no prior provider AND no Anthropic credentials.
      // Atomically activate OpenRouter and apply its model defaults so we never
      // persist the broken intermediate state (activeProvider='anthropic' while
      // only OR is connected). Previously, this code defaulted to 'anthropic'
      // and relied on the renderer's auto-select effect to repair the state,
      // but that effect doesn't fire if the user navigates away during OAuth —
      // leaving the colleague's machine stuck with Anthropic selected.
      const orDefaults = applyOpenRouterModelDefaults(currentSettings);
      updateSettings({
        ...orDefaults,
        openRouter: {
          ...DEFAULT_OPENROUTER_SETTINGS,
          ...currentSettings.openRouter,
          enabled: true,
          oauthToken: apiKey,
        },
      });
    } else {
      // Existing user — either explicit activeProvider, or legacy Anthropic-only
      // (pre-`activeProvider` era, has `claude.apiKey` but no activeProvider).
      // Preserve their current provider choice (the legacy-undefined case
      // defaults to 'anthropic', matching the prior behavior). The Settings UI's
      // auto-select effect handles the switch via planProviderSwitch when the
      // user is mounted on AgentsTab; switching preserves their model selections.
      updateSettings({
        activeProvider: currentSettings.activeProvider ?? 'anthropic',
        openRouter: {
          ...DEFAULT_OPENROUTER_SETTINGS,
          ...currentSettings.openRouter,
          enabled: true,
          oauthToken: apiKey,
        },
      });
    }

    // Diagnostic: verify the token actually persisted to settings.
    // If this log shows oauthTokenPersisted=false, the updateSettings call above
    // failed silently — the token was saved to secure storage but not to settings.
    const postSaveSettings = getSettings();
    log.info({
      maskedKey: masked,
      oauthTokenPersisted: !!postSaveSettings.openRouter?.oauthToken,
      enabled: postSaveSettings.openRouter?.enabled,
      activeProvider: postSaveSettings.activeProvider,
    }, 'OpenRouter API key stored — verified settings persistence');

    // Close the timing window that left REBEL-5D4 / Angus-shape customers
    // stuck: stamp profileSource on any legacy OR profiles now that an OAuth
    // token is unambiguously present. Idempotent if the boot migration
    // already ran successfully.
    backfillProfileSourceAfterOAuthSave(postSaveSettings);

    try {
      getBroadcastService().sendToAllWindows('settings:external-update');
    } catch { /* ignore if broadcast unavailable */ }

    bringAppToForeground();
    return { outcome: 'success', maskedKey: masked };
  } catch (err) {
    const current = isCurrent(generation);
    if (current) {
      cleanup();
    }

    if (!current || err instanceof CancelledError) {
      log.info('OpenRouter OAuth cancelled by user');
      return { outcome: 'cancelled' };
    }

    if (err instanceof SetupTimeoutError) {
      return { outcome: 'error', error: err.message };
    }

    const message = err instanceof Error ? err.message : 'Setup failed';
    log.error({ err }, 'OpenRouter OAuth setup failed');

    getErrorReporter().captureException(
      err instanceof Error ? err : new Error(message),
      {
        level: 'error',
        tags: { area: 'openrouter-setup', operation: 'setup-flow' },
        fingerprint: ['openrouter-setup', 'setup-flow-failed'],
      },
    );

    return { outcome: 'error', error: message };
  }
}

/**
 * Handle the OAuth callback from the deep link.
 * Called from the protocol handler when mindstone://openrouter/callback is received.
 */
export async function handleOpenRouterDeepLinkCallback(url: string): Promise<void> {
  if (!pendingAuth) {
    log.warn({ uptimeSeconds: Math.round(process.uptime()) },
      'Received OpenRouter OAuth callback but no auth is pending');
    return;
  }

  const { state, resolve, reject, timeout } = pendingAuth;
  clearTimeout(timeout);
  pendingAuth = null;

  try {
    const callbackUrl = new URL(url);
    const code = callbackUrl.searchParams.get('code');
    const error = callbackUrl.searchParams.get('error');
    const errorDescription = callbackUrl.searchParams.get('error_description');
    const returnedState = callbackUrl.searchParams.get('state');

    if (error) {
      const desc = errorDescription ?? error;
      log.error({ error, desc }, 'OpenRouter OAuth callback returned error');
      throw new Error(`Authorization error: ${desc}`);
    }

    // Security: Validate state parameter to prevent CSRF attacks.
    // State is embedded in the callback URL so it always round-trips.
    if (!returnedState || returnedState !== state) {
      log.error(
        { returnedState, expectedState: '[present]' },
        '[SECURITY] OAuth state mismatch - possible CSRF attack',
      );
      throw new Error('OAuth state mismatch - possible CSRF attack');
    }

    if (!code) {
      throw new Error('No authorization code in callback');
    }

    log.info('OpenRouter authorization code received via deep link callback');
    resolve({ code });
  } catch (err) {
    reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Cancel any running OpenRouter setup.
 */
export function cancelOpenRouterSetup(): void {
  log.info('Cancelling OpenRouter setup');
  ++activeSetupGeneration;
  if (pendingAuth) {
    pendingAuth.reject(new CancelledError());
  }
  if (pendingLoopbackAuth) {
    pendingLoopbackAuth.reject(new CancelledError());
  }
  cleanup();
}

/**
 * Disconnect OpenRouter — clear stored API key and settings.
 */
export function disconnectOpenRouter(): void {
  const preSettings = getSettings();
  log.info({
    hadToken: !!preSettings.openRouter?.oauthToken,
    wasEnabled: preSettings.openRouter?.enabled,
    activeProvider: preSettings.activeProvider,
  }, 'Disconnecting OpenRouter');
  clearOpenRouterTokens();

  const currentSettings = getSettings();
  updateSettings({
    openRouter: {
      ...DEFAULT_OPENROUTER_SETTINGS,
      ...currentSettings.openRouter,
      enabled: false,
      oauthToken: null,
    },
  });

  try {
    getBroadcastService().sendToAllWindows('settings:external-update');
  } catch { /* ignore if broadcast unavailable */ }
}
