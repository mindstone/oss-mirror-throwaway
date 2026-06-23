/**
 * CORS + Private Network Access (PNA) handling for the App Bridge.
 *
 * Why this exists:
 *   Modern Chromium (Chrome 117+, and stricter forks like Comet) enforces
 *   a Private Network Access preflight for any fetch from a
 *   `chrome-extension://` origin to `http://127.0.0.1:<port>/*`. The
 *   browser sends an `OPTIONS` request with
 *   `Access-Control-Request-Private-Network: true` BEFORE the real GET/POST.
 *   If the server does not respond with a matching
 *   `Access-Control-Allow-Private-Network: true` + standard CORS headers,
 *   the browser aborts the real request and the extension's `fetch()`
 *   throws a generic "Failed to fetch". Popup-level error message:
 *   "Couldn't find Rebel on this computer. Is the app open?" — which is
 *   very misleading because the bridge IS running, the browser just
 *   refused to talk to it.
 *
 *   Before this module existed the bridge had zero CORS/PNA handling:
 *   OPTIONS requests fell through to `intentRouter` / `pairRoutes` which
 *   don't accept OPTIONS, hit the origin allowlist / auth gate, returned
 *   401 with no `Access-Control-*` headers, and the extension install
 *   flow silently broke on Comet and similar Chromium forks.
 *
 * Design:
 *   - Preflight (OPTIONS) runs BEFORE the router chain in `bridge.ts` so
 *     it catches every extension-reachable path and any future route.
 *   - Response headers are set via `setHeader()` BEFORE routing, so every
 *     real response (200/401/403/404) also carries `Access-Control-Allow-Origin`
 *     and `Vary: Origin`. This gives the extension a readable status code
 *     instead of an opaque network error — a big debugging win.
 *   - Origin echo is strict: only well-formed `chrome-extension://[a-p]{32}`
 *     or `moz-extension://[a-p]{32}` origins get echoed. `null`, wildcard,
 *     arbitrary http(s) pages, etc. get no CORS echo — they fail preflight
 *     and any follow-up request with a readable 401.
 *   - We never set `Access-Control-Allow-Credentials`. All extension fetches
 *     use `credentials: 'omit'` (see `packages/browser-extension/src/lib/*`)
 *     so enabling credentials would be both unused and a needless widening
 *     of attack surface.
 *   - PNA (`Access-Control-Allow-Private-Network`) is echoed ONLY when the
 *     request sent `Access-Control-Request-Private-Network: true`. We never
 *     blanket-include it.
 *   - Host header is still validated in the preflight path. A request with
 *     a non-loopback Host can still fail fast with 401, keeping the DNS
 *     rebinding guard intact.
 *
 *   NOTE: Preflight does NOT check the origin token allowlist. Browsers
 *   never send Bearer tokens or `X-Rebel-*` headers on OPTIONS preflights,
 *   so the allowlist would always fail. Real auth / origin gates still run
 *   on the follow-up GET/POST via the existing `assertAllowedOrigin` +
 *   `assertGatedAccess` checks in `intentRouter` / `pairRoutes`. This is
 *   the standard CORS pattern.
 *
 * Related code:
 *   - Extension client: `packages/browser-extension/src/lib/port-discovery.ts`
 *     probes `/intent/health` to find the bridge port.
 *   - Origin shape guard: `@core/appBridge/server/originGuard.isValidExtensionId`.
 *   - Reference implementation in the same repo:
 *     `src/main/services/localModelProxyServer.ts` — uses the same pattern
 *     for the local-model proxy on loopback.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ErrorCode } from '../shared/errors';
import type { ErrorReporter } from '@core/errorReporter';
import { applyErrorResponse } from './httpUtils';
import { createAppBridgeError } from '../shared/errors';
import { installEvent } from '../shared/installEvent';
import type { Logger } from 'pino';

type CorsLogger = Logger;

/**
 * Strict shape check for extension origins. Matches the same
 * `[a-p]{32}` format enforced by `originGuard.isValidExtensionId` so
 * we can't drift — if that guard changes, update this regex too and
 * flush the `intentRouter.test.ts` / `corsHeaders.test.ts` snapshots.
 *
 * Exported for tests and any future caller that needs the same check
 * outside the preflight path.
 */
export const EXTENSION_ORIGIN_RE =
  /^(chrome-extension|moz-extension):\/\/[a-p]{32}$/;

/**
 * Headers an authenticated extension request may carry. Kept in sync with
 * `packages/browser-extension/src/lib/intents.ts` (which sets authorization,
 * content-type, x-rebel-app-id, x-rebel-client-id, x-rebel-client-fingerprint)
 * plus `Accept` for forward compatibility.
 *
 * Browsers lowercase header names during preflight comparison, so casing
 * here is informational; the echo is what matters.
 */
const ALLOWED_REQUEST_HEADERS = [
  'authorization',
  'content-type',
  'x-rebel-app-id',
  'x-rebel-client-id',
  'x-rebel-client-fingerprint',
  'x-rebel-pair-session-id',
  'accept',
].join(', ');

const ALLOWED_METHODS = 'GET, POST, OPTIONS';

/** Chromium caps this at 7200s. 600s gives sensible re-check cadence. */
const MAX_AGE_SECONDS = '600';

/**
 * Header name consts. Node lowercases incoming headers; we use these only
 * to set outgoing headers where canonical casing is conventional.
 */
const H_ACAO = 'Access-Control-Allow-Origin';
const H_ACAM = 'Access-Control-Allow-Methods';
const H_ACAH = 'Access-Control-Allow-Headers';
const H_ACAP = 'Access-Control-Allow-Private-Network';
const H_ACMA = 'Access-Control-Max-Age';
const H_VARY = 'Vary';
const REQ_PNA = 'access-control-request-private-network';

function extractHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Strict check: is this origin a well-formed extension origin we should
 * accept for CORS echo? Rejects `null`, empty strings, http(s) pages, and
 * malformed extension IDs. Same shape as `originGuard.isValidExtensionId`.
 */
export function isExtensionOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return false;
  return EXTENSION_ORIGIN_RE.test(origin);
}

/**
 * Idempotent: attaches CORS response headers to `res` for the real
 * (non-preflight) request. Must be called BEFORE `res.writeHead()` /
 * `res.end()`. Safe to call for non-extension requests — in that case
 * only `Vary: Origin` is added for cache correctness.
 *
 * NOTE ON Node's `writeHead(status, headers)` merge semantics:
 *   Node merges `setHeader()` values into the object passed to `writeHead`.
 *   So a later `res.writeHead(200, { 'Content-Type': ... })` will still
 *   include the `Access-Control-Allow-Origin` we set here. SSE handlers
 *   (e.g. `appBridgeIntentService.ts` conversation/:id/stream) rely on
 *   that merge behavior. This is pinned by
 *   `corsHeaders.test.ts > real responses > SSE response keeps ACAO`.
 *
 *   Caveat: a handler that later calls
 *   `res.removeHeader('Access-Control-Allow-Origin')` or
 *   `res.setHeader('Vary', ...)` unconditionally will still clobber us.
 *   No handler in-tree does that today; if one is added, make the CORS
 *   headers the last writes before writeHead.
 */
export function applyCorsResponseHeaders(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  // Always set Vary: Origin so caches don't serve the wrong ACAO across
  // origins. Merge into any existing Vary header rather than replacing.
  // Handles both string and string[] values (Node allows either).
  const existingVary = res.getHeader(H_VARY);
  const existingVaryTokens = normalizeVaryHeader(existingVary);
  const hasOrigin = existingVaryTokens.some(
    (token) => token.toLowerCase() === 'origin',
  );
  if (!hasOrigin) {
    const merged =
      existingVaryTokens.length > 0
        ? `${existingVaryTokens.join(', ')}, Origin`
        : 'Origin';
    res.setHeader(H_VARY, merged);
  }

  const origin = extractHeader(req, 'origin');
  if (isExtensionOrigin(origin)) {
    // Echo the exact origin — never wildcard, never credentials.
    res.setHeader(H_ACAO, origin as string);
  }
  // Non-extension origins get no Access-Control-Allow-Origin header.
  // They will receive the real response body (e.g. 401) but the browser
  // will hide it from the JS caller. That's correct — we don't want to
  // advertise the bridge to arbitrary web pages.
}

/**
 * Normalize a Vary header value (which Node can expose as string, string[],
 * number, or undefined) into a clean array of tokens. Empty tokens and
 * leading/trailing whitespace are stripped.
 */
function normalizeVaryHeader(
  value: string | string[] | number | undefined,
): string[] {
  if (value === undefined || typeof value === 'number') return [];
  if (Array.isArray(value)) {
    return value
      .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Handle an incoming OPTIONS preflight request. Must be called BEFORE
 * the router chain in `bridge.ts`. Always terminates the response
 * (either 204 for valid extension origins or a readable 4xx for
 * anything else) — the caller must not fall through to the router.
 *
 * Host header validation runs first so a request with a spoofed Host
 * still fails fast (preserves the DNS rebinding guard).
 *
 * We do NOT check the token/origin allowlist here. Browsers do not send
 * Bearer tokens or `X-Rebel-*` headers on preflights — the real request
 * will re-run `assertAllowedOrigin` / `assertGatedAccess`.
 */
export function handleCorsPreflight(
  req: IncomingMessage,
  res: ServerResponse,
  getPort: () => number,
  errorReporter?: ErrorReporter,
  logger?: CorsLogger,
): void {
  // Host header guard — unchanged from `assertAllowedHost` but inlined
  // so we don't pull in the full origin-guard module (keeps this helper
  // narrowly scoped).
  //
  // Host-mismatch fails even if origin looks extension-shaped. In that
  // case `applyCorsResponseHeaders` has already set ACAO (it only looks
  // at origin shape, not host). We strip it here so a DNS-rebinding
  // preflight doesn't get a readable "ACAO echoed" 401 — the caller
  // should see a pure CORS failure, matching the documented behavior.
  const host = extractHeader(req, 'host');
  const port = getPort();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!host || !allowedHosts.has(host)) {
    if (res.hasHeader(H_ACAO)) res.removeHeader(H_ACAO);
    const reason = host ? 'host-mismatch' : 'missing-host';
    errorReporter?.addBreadcrumb({
      category: 'app-bridge.cors',
      level: 'warning',
      message: 'preflight-host-rejected',
      data: { reason },
    });
    if (logger) installEvent(logger, 'warn', 'app-bridge.cors.preflight.reject.host', { reason });
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.UNAUTHORIZED,
        host ? `Host "${host}" is not permitted.` : 'Missing Host header.',
      ),
    );
    return;
  }

  const origin = extractHeader(req, 'origin');
  if (!isExtensionOrigin(origin)) {
    // Deliberately NO CORS echo on rejection. The caller sees a readable
    // 401 status, but the browser will surface it as a CORS failure
    // because no ACAO header is set — which is the correct outcome: we
    // never want to advertise the bridge to arbitrary origins. Belt-and-
    // suspenders: also clear ACAO in case something upstream set it.
    if (res.hasHeader(H_ACAO)) res.removeHeader(H_ACAO);
    const reason = origin ? 'origin-shape' : 'missing-origin';
    errorReporter?.addBreadcrumb({
      category: 'app-bridge.cors',
      level: 'warning',
      message: 'preflight-origin-rejected',
      data: { reason },
    });
    if (logger) installEvent(logger, 'warn', 'app-bridge.cors.preflight.reject.origin', { reason });
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.UNAUTHORIZED,
        origin
          ? `Origin "${origin}" is not permitted.`
          : 'Missing Origin header.',
      ),
    );
    return;
  }

  // Valid extension origin — build the preflight response.
  // `applyCorsResponseHeaders` was already called by the outer dispatcher
  // and set ACAO + Vary. We add the preflight-specific headers here.
  res.setHeader(H_ACAM, ALLOWED_METHODS);
  res.setHeader(H_ACAH, ALLOWED_REQUEST_HEADERS);
  res.setHeader(H_ACMA, MAX_AGE_SECONDS);

  // Only echo PNA when the browser asked for it. Blanket-including is
  // harmless but confusing in packet captures. Case-insensitive match
  // in case a browser fork ever capitalizes — spec is lowercase 'true'.
  const pna = requestedPrivateNetwork(req);
  if (pna) {
    res.setHeader(H_ACAP, 'true');
  }

  res.writeHead(204);
  res.end();

  // Success log at debug level — silent under normal conditions but
  // shows up when we raise the log level to diagnose an install.
  if (logger) {
    installEvent(logger, 'debug', 'app-bridge.cors.preflight.accepted', {
      pna,
      path: (req.url ?? '').split('?')[0],
    });
  }
}

/**
 * Internal helper for the request-logging path in `bridge.ts` — tells the
 * logger whether this was a preflight so ops can filter noise.
 */
export function isPreflightRequest(req: IncomingMessage): boolean {
  return req.method === 'OPTIONS';
}

/**
 * Internal helper: did the client request Private Network Access?
 * Used both for the ACAP echo in the preflight response and for
 * telemetry in the request-logging path. Case-insensitive because
 * browser forks occasionally drift from spec.
 */
export function requestedPrivateNetwork(req: IncomingMessage): boolean {
  return extractHeader(req, REQ_PNA)?.toLowerCase() === 'true';
}
