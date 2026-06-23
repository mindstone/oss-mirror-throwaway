/**
 * Codex OAuth — desktop-only login flow.
 *
 * Implements the interactive PKCE flow (loopback HTTP server + browser launch).
 * Token storage, refresh, and all query helpers live in `@core/services/codexAuthCore`
 * so they run identically on cloud / mobile.
 *
 * Re-exports the core API for backward compatibility with existing desktop
 * callers. NEW code should prefer `@core/services/codexAuthCore` directly.
 *
 * @see docs/plans/finished/260312_codex_oauth_support.md (original OAuth flow)
 * @see docs/plans/260422_codex_cloud_parity_and_fallback.md (centralisation)
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { getElectronModule } from '@core/lazyElectron';
import { createScopedLogger } from '@core/logger';
import {
  decodeJwtPayload,
  extractAccountId,
} from '@core/services/codexAuthCore';
import { saveCodexTokens, type CodexTokens } from '@core/services/codexTokenStorage';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { generateCsrfState, bringAppToForeground } from './oauthPrimitives';
import { codexOAuthHtml } from './oauthHtmlTemplates';

// Re-export core API so existing desktop callers keep working.
export {
  codexLogout,
  decodeJwtPayload,
  extractAccountId,
  forceRefreshCodexAccessToken,
  getCodexAccessToken,
  getCodexAccountId,
  getCodexStatus,
  isCodexConnected,
  CODEX_ENDPOINT_URL,
} from '@core/services/codexAuthCore';
export type { CodexTokens } from '@core/services/codexTokenStorage';

const log = createScopedLogger({ service: 'codex-auth' });

// ─── Constants ──────────────────────────────────────────────────────
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke';

/** Login flow timeout (2 minutes). */
const LOGIN_TIMEOUT_MS = 2 * 60_000;

/**
 * Allow-listed loopback callback ports, in preference order.
 *
 * We reuse the official Codex CLI's OAuth client (see `CODEX_CLIENT_ID` +
 * `originator=codex_cli_rs`), so OpenAI's authorization server validates our
 * `redirect_uri` against the *exact* allow-list registered for that client.
 * Only `http://localhost:1455/auth/callback` and `…:1457/…` are accepted — an
 * arbitrary/ephemeral port is rejected with a redirect_uri mismatch. This
 * mirrors codex-rs (`DEFAULT_PORT = 1455`, `FALLBACK_PORT = 1457`).
 */
const CODEX_LOOPBACK_PORTS: readonly number[] = [1455, 1457];

/** Loopback servers for the currently-pending login (one per address family). */
let activeLoopbackServers: http.Server[] = [];

/** The result of binding the loopback callback servers for one login attempt. */
export interface LoopbackBinding {
  /** The allow-listed port both servers are listening on. */
  port: number;
  /** Bound servers (IPv4 always; IPv6 too when the host has an IPv6 stack). */
  servers: http.Server[];
}

/** Listen a fresh `http.Server` (running `handler`) on `host:port`. */
function listenOn(handler: http.RequestListener, host: string, port: number): Promise<http.Server> {
  return new Promise<http.Server>((resolve, reject) => {
    const server = http.createServer(handler);
    function onError(err: NodeJS.ErrnoException) {
      server.removeListener('listening', onListening);
      reject(err);
    }
    function onListening() {
      server.removeListener('error', onError);
      resolve(server);
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Close a server, ignoring "not running" errors. */
function closeQuietly(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Bind loopback callback servers for the OAuth redirect, returning the chosen
 * port and the bound servers.
 *
 * For each candidate port we bind BOTH the IPv4 (`127.0.0.1`) and IPv6 (`::1`)
 * loopback with the same `handler`. This is deliberate: the browser is
 * redirected to `http://localhost:PORT` (the host OpenAI's allow-list requires),
 * and `localhost` resolves to BOTH families. On dual-stack macOS the browser
 * (RFC 6724 / Happy Eyeballs) typically tries `::1` first and only falls back to
 * IPv4 on connection *refusal* — so if we listen on `127.0.0.1` alone while
 * another process holds `::1:PORT`, the browser delivers the auth callback to
 * that other process and our flow silently times out. (This is the regression
 * behind the `EADDRINUSE ::1:1455` incident: `getAvailablePort` probed IPv4 but
 * `server.listen(port, 'localhost')` bound `::1`.) Owning both families closes
 * the gap and prevents a squatter from appearing mid-flow.
 *
 * A port is usable only if BOTH families are free; if either is in use we move
 * to the next allow-listed port. We cannot fall back to a random port — OpenAI
 * validates `redirect_uri` against the fixed `CODEX_LOOPBACK_PORTS` allow-list.
 * If the host simply has no IPv6 stack (`EADDRNOTAVAIL` / `EAFNOSUPPORT`) we
 * proceed IPv4-only: with no IPv6 for the browser to prefer, the gap can't occur.
 *
 * Rejects with an `EADDRINUSE`-coded error when every candidate port is taken.
 *
 * NOTE: unlike the official codex-rs CLI we don't send a `/cancel` request to a
 * stale login server before falling back; if BOTH allow-listed ports are held
 * by stale Codex login servers the user gets an actionable error rather than
 * automatic reclamation. Acceptable given dual-bind covers the realistic cases.
 *
 * Exported for unit testing; not part of the public auth API.
 */
export async function bindLoopbackServers(
  handler: http.RequestListener,
  ports: readonly number[],
): Promise<LoopbackBinding> {
  for (const port of ports) {
    const servers: http.Server[] = [];
    try {
      // IPv4 first — the family the official client and the eventual token
      // exchange ultimately rely on.
      servers.push(await listenOn(handler, '127.0.0.1', port));

      // IPv6 companion so the browser can't be routed to an `::1` squatter.
      try {
        servers.push(await listenOn(handler, '::1', port));
      } catch (ipv6Err) {
        const code = (ipv6Err as NodeJS.ErrnoException).code;
        // Only a genuine "no IPv6 loopback on this host" is safe to ignore and
        // proceed IPv4-only. EADDRINUSE means `::1:PORT` is squatted (this port
        // is unsafe — fall to the next); anything else (e.g. EMFILE) is an
        // unexpected failure we must not mask. Both rethrow.
        if (code !== 'EADDRNOTAVAIL' && code !== 'EAFNOSUPPORT') {
          throw ipv6Err;
        }
        log.warn(
          { port, err: ipv6Err },
          'Codex OAuth: IPv6 loopback unavailable, binding IPv4 only',
        );
      }

      return { port, servers };
    } catch (err) {
      await Promise.all(servers.map(closeQuietly));
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        log.warn({ port }, 'Codex OAuth loopback port in use (either family), trying next');
        continue;
      }
      throw err; // Non-EADDRINUSE (e.g. EACCES) → surface immediately.
    }
  }

  const exhausted = new Error(
    `All Codex loopback ports are in use: ${ports.join(', ')}`,
  ) as NodeJS.ErrnoException;
  exhausted.code = 'EADDRINUSE';
  throw exhausted;
}

// ─── PKCE helpers ───────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ─── OAuth login flow (desktop-only) ────────────────────────────────

/**
 * Initiate the Codex OAuth PKCE login flow.
 *
 * Opens the system browser for authorization, starts a loopback server for
 * the callback, exchanges the code for tokens, and stores them securely via
 * core token storage. The `codexTokenEvents.emit('changed')` that fires
 * inside `saveCodexTokens()` causes the bootstrap-registered listener to
 * push the new tokens to the user's cloud instance.
 *
 * @param options.loopbackPorts Override the callback ports (tests only). In
 *   production the fixed allow-listed `CODEX_LOOPBACK_PORTS` are required.
 */
export async function codexLogin(
  options?: { loopbackPorts?: readonly number[] },
): Promise<{ success: boolean; email?: string; error?: string }> {
  log.info('Starting Codex OAuth login flow');

  // Close any servers left over from a prior, abandoned login attempt.
  for (const stale of activeLoopbackServers) {
    stale.close();
  }
  activeLoopbackServers = [];

  try {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateCsrfState();
    const loopbackPorts = options?.loopbackPorts ?? CODEX_LOOPBACK_PORTS;

    // Port, redirect URI, and servers are determined once the loopback binds (below).
    let port = 0;
    let redirectUri = '';
    let servers: http.Server[] = [];

    const result = await new Promise<{ success: boolean; email?: string; error?: string }>((resolve) => {
      let timeoutHandle: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        // Close THIS login's own servers only — never the module slot directly,
        // or a stale timeout from a superseded login could close a newer
        // login's live servers. Only clear the slot if it still points at us.
        for (const s of servers) {
          s.close();
        }
        if (activeLoopbackServers === servers) {
          activeLoopbackServers = [];
        }
      };

      const requestHandler: http.RequestListener = (req, res) => {
        fireAndForget((async () => {
        const url = new URL(req.url ?? '/', `http://localhost:${port}`);

        if (url.pathname !== '/auth/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const receivedState = url.searchParams.get('state');
        if (receivedState !== state) {
          log.error({ expected: state, received: receivedState }, 'Codex OAuth state mismatch');
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(codexOAuthHtml.error('Security validation failed — please try again'));
          cleanup();
          resolve({ success: false, error: 'State mismatch — possible CSRF attack' });
          return;
        }

        const error = url.searchParams.get('error');
        if (error) {
          const errorDescription = url.searchParams.get('error_description') ?? error;
          log.error({ error, errorDescription }, 'Codex OAuth error in callback');
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(codexOAuthHtml.error(errorDescription));
          cleanup();
          resolve({ success: false, error: errorDescription });
          return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
          log.error('No authorization code in Codex OAuth callback');
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(codexOAuthHtml.error('No authorization code received'));
          cleanup();
          resolve({ success: false, error: 'No authorization code received' });
          return;
        }

        try {
          const tokenResponse = await fetch(CODEX_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: CODEX_CLIENT_ID,
              code,
              redirect_uri: redirectUri,
              code_verifier: codeVerifier,
            }).toString(),
          });

          if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text().catch(() => 'Unknown error');
            log.error({ status: tokenResponse.status, error: errorText }, 'Codex token exchange failed');
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(codexOAuthHtml.error(`Token exchange failed: ${errorText}`));
            cleanup();
            resolve({ success: false, error: `Token exchange failed: ${errorText}` });
            return;
          }

          const tokenData = await tokenResponse.json() as {
            access_token?: string;
            refresh_token?: string;
            id_token?: string;
            expires_in?: number;
          };

          if (!tokenData.access_token || !tokenData.refresh_token) {
            log.error('Missing tokens in Codex token exchange response');
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(codexOAuthHtml.error('Missing tokens in exchange response'));
            cleanup();
            resolve({ success: false, error: 'Missing tokens in exchange response' });
            return;
          }

          const accountId = extractAccountId(tokenData.id_token, tokenData.access_token);

          if (!accountId) {
            log.error('No chatgpt_account_id in any Codex JWT (id_token or access_token)');
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(codexOAuthHtml.error('Could not extract account ID from token'));
            cleanup();
            resolve({ success: false, error: 'Could not extract account ID from token' });
            return;
          }

          const jwtPayload = decodeJwtPayload(tokenData.id_token ?? tokenData.access_token);
          const email = typeof jwtPayload?.email === 'string' ? jwtPayload.email : undefined;
          const expiresIn = tokenData.expires_in ?? 3600;

          const tokens: CodexTokens = {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: Date.now() + expiresIn * 1000,
            accountId,
            accountEmail: email,
          };
          saveCodexTokens(tokens, {
            cause: 'login_success',
            source: 'codex_auth_service',
          });

          log.info({ accountId, hasEmail: !!email }, 'Codex OAuth login successful');

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(codexOAuthHtml.success(email));

          bringAppToForeground();
          cleanup();
          resolve({ success: true, email });
        } catch (exchangeError) {
          log.error({ err: exchangeError }, 'Codex token exchange error');
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(codexOAuthHtml.error('Token exchange failed'));
          cleanup();
          resolve({ success: false, error: 'Token exchange failed' });
        }
        })().catch((callbackError: unknown) => {
          log.error({ err: callbackError }, 'Codex OAuth callback handler failed');
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(codexOAuthHtml.error('Token exchange failed'));
          }
          cleanup();
          resolve({ success: false, error: 'Token exchange failed' });
        }), 'codexAuth.loopbackCallback');
      };

      fireAndForget((async () => {
        // Convert a bind rejection into a tagged value: exhausted ports are an
        // expected, surfaced outcome (not a swallowed error).
        const bound = await bindLoopbackServers(requestHandler, loopbackPorts).then(
          (binding) => ({ ok: true as const, binding }),
          (err: unknown) => ({ ok: false as const, err }),
        );

        if (!bound.ok) {
          const code = (bound.err as NodeJS.ErrnoException | undefined)?.code;
          log.error(
            { err: bound.err, ports: loopbackPorts },
            'Codex OAuth loopback server failed to bind',
          );
          cleanup();
          resolve({
            success: false,
            // Only blame a busy port when that's actually what happened.
            error: code === 'EADDRINUSE'
              ? `Couldn't start sign-in — another app on this computer is using the connection Rebel needs (port${
                  loopbackPorts.length > 1 ? 's' : ''
                } ${loopbackPorts.join(' and ')}). Close any other ChatGPT or Codex sign-in that's running, or restart your computer, then try again.`
              : `Couldn't start the sign-in helper. Please try again, and restart Rebel if it keeps happening.`,
          });
          return;
        }

        port = bound.binding.port;
        servers = bound.binding.servers;
        activeLoopbackServers = servers;
        redirectUri = `http://localhost:${port}/auth/callback`;
        log.info({ port, families: servers.length }, 'Codex OAuth loopback server started');

        // Surface runtime errors that occur after a successful bind (any family).
        for (const s of servers) {
          s.on('error', (err) => {
            log.error({ err }, 'Codex OAuth loopback server error');
            cleanup();
            resolve({ success: false, error: 'Callback server error' });
          });
        }

        const authUrl = new URL(CODEX_AUTH_URL);
        authUrl.searchParams.set('client_id', CODEX_CLIENT_ID);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('scope', CODEX_SCOPES);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('id_token_add_organizations', 'true');
        authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
        authUrl.searchParams.set('originator', 'codex_cli_rs');

        getElectronModule()?.shell.openExternal(authUrl.toString()).catch((err) => {
          log.error({ err }, 'Failed to open browser for Codex OAuth');
          cleanup();
          resolve({ success: false, error: 'Failed to open browser' });
        });
      })(), 'codexAuth.loopbackBind');

      timeoutHandle = setTimeout(() => {
        log.warn('Codex OAuth login timed out');
        cleanup();
        resolve({ success: false, error: 'Login timed out' });
      }, LOGIN_TIMEOUT_MS);
    });

    return result;
  } catch (error) {
    log.error({ err: error }, 'Codex OAuth login error');
    return { success: false, error: 'Login failed' };
  }
}
