/**
 * pairRoutes — `/pair/*` HTTP routes (Stage 2).
 *
 * Three endpoints:
 *
 *   - `POST /pair/start` — mints a fresh 6-digit pairing code bound to an
 *     `appId`. Requires the router-internal token (Stage 4) OR
 *     `REBEL_APP_BRIDGE_DEV=1`. Origin + Host-gated like every route.
 *
 *   - `POST /pair/claim` — public (Origin + Host-gated). Consumes a code and
 *     returns an app pairing token on success. Wrong codes burn the pending
 *     pool after 10 attempts per R7.
 *
 *   - `POST /pair/revoke` — requires a previously-issued app pairing token
 *     (`Authorization: Bearer <token>`) and removes it.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import type { ErrorReporter } from '@core/errorReporter';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { Logger } from 'pino';
import { installEvent } from '../shared/installEvent';
import { ErrorCode, createAppBridgeError, type AppBridgeError } from '../shared/errors';
import { isAppType, type AppType } from '../shared/protocol';
import {
  assertAllowedHost,
  assertAllowedOrigin,
  CHROME_EXTENSION_ORIGIN_REGEX,
  type OriginGuardOptions,
} from './originGuard';
import { PairingStore } from './pairingStore';
import type { TokenStore } from './tokenStore';
import {
  applyErrorResponse,
  extractBearer,
  readJsonBody,
  sendJson,
  type RouterHandler,
} from './httpUtils';
import type { PairEventBus } from './pairEventBus';

export interface PairRoutesOptions {
  pairingStore: PairingStore;
  tokenStore: TokenStore;
  pairEventBus: PairEventBus;
  getPort: () => number;
  originGuardOptions: OriginGuardOptions;
  errorReporter?: ErrorReporter;
  expirySweepMs?: number;
  forgetTrackedPairSession?: (pairSessionId: string) => void;
  logger?: Logger;
  /**
   * Fire-and-forget callback invoked when a `/pair/claim` succeeds against
   * an unknown-but-well-formed `chrome-extension://` Origin (preview-mode
   * TOFU-at-claim path). The host is expected to persist the extension ID
   * to the shared trust file AND register it with the pair session so
   * `resetInstall` can forget it later. Must not throw; implementation is
   * responsible for its own logging / error handling.
   *
   * See docs-private/investigations/260423_tofu_vs_claim_timeout_bug.md for why
   * claim-success is now the trust-persistence trigger rather than a
   * standalone TOFU approval.
   */
  onClaimPersistTrust?: (args: {
    pairSessionId: string;
    extensionId: string;
  }) => void;
}

export interface PairRoutesHandle extends RouterHandler {
  dispose?: () => void;
}

const START_PATH = '/pair/start';
const CLAIM_PATH = '/pair/claim';
const REVOKE_PATH = '/pair/revoke';

function isDevAccessAllowed(): boolean {
  return process.env['REBEL_APP_BRIDGE_DEV'] === '1';
}

function assertInternalOrDevAccess(
  routerToken: string,
  presentedToken: string,
): void {
  if (routerToken && presentedToken === routerToken) {
    return;
  }
  if (isDevAccessAllowed()) {
    return;
  }
  throw createAppBridgeError(
    ErrorCode.UNAUTHORIZED,
    'This route requires the router-internal token (Stage 4) or REBEL_APP_BRIDGE_DEV=1.',
  );
}

function parseAppId(body: Record<string, unknown>): AppType {
  const rawAppId = body['appId'];
  if (!isAppType(rawAppId)) {
    throw createAppBridgeError(
      ErrorCode.BAD_REQUEST,
      'Field "appId" is required and must be a non-empty string.',
    );
  }
  return rawAppId;
}

function parseClientId(body: Record<string, unknown>): string {
  const clientId = body['clientId'];
  if (typeof clientId !== 'string' || clientId.trim().length === 0) {
    throw createAppBridgeError(
      ErrorCode.BAD_REQUEST,
      'Field "clientId" is required and must be a non-empty string.',
    );
  }
  return clientId;
}

function parseCode(body: Record<string, unknown>): string {
  const code = body['code'];
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw createAppBridgeError(
      ErrorCode.BAD_REQUEST,
      'Field "code" is required and must be a non-empty string.',
    );
  }
  return code;
}

function extractOriginExtensionId(req: Parameters<RouterHandler>[0]): string | undefined {
  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (typeof origin !== 'string') {
    return undefined;
  }

  const match = /^(chrome-extension|moz-extension):\/\/([^/]+)$/.exec(origin);
  return match?.[2];
}

export function createPairRoutes(options: PairRoutesOptions): RouterHandler {
  const trackedPairSessionExpiries = new Map<string, number>();
  const originalCreatePendingSession =
    options.pairingStore.createPendingSession.bind(options.pairingStore);
  options.pairingStore.createPendingSession = ((...args) => {
    const session = originalCreatePendingSession(...args);
    if (session.pairSessionId) {
      trackedPairSessionExpiries.set(session.pairSessionId, session.expiresAt);
    }
    return session;
  }) as PairingStore['createPendingSession'];

  const sweepInterval = setInterval(() => {
    const now = Date.now();
    const liveExpiries = new Map<string, number>();
    for (const session of options.pairingStore.listActive()) {
      if (session.pairSessionId) {
        liveExpiries.set(session.pairSessionId, session.expiresAt);
        trackedPairSessionExpiries.set(session.pairSessionId, session.expiresAt);
      }
    }

    for (const [pairSessionId, expiresAt] of trackedPairSessionExpiries.entries()) {
      if (liveExpiries.has(pairSessionId)) {
        continue;
      }
      trackedPairSessionExpiries.delete(pairSessionId);
      if (now < expiresAt) {
        continue;
      }
      options.pairEventBus.emit({
        type: 'code-expired',
        cause: 'ttl-expired',
        pairSessionId,
        emittedAt: now,
      });
    }
  }, options.expirySweepMs ?? 1_000);
  sweepInterval.unref?.();

  const pairRoutes = function pairRoutes(req, res): boolean {
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.split('?')[0] ?? '/';
    if (!pathname.startsWith('/pair/')) {
      return false;
    }

    // Host guard is sync and cheap — enforce before dispatching.
    try {
      assertAllowedHost(req, options.getPort(), {
        errorReporter: options.errorReporter,
      });
    } catch (err) {
      applyErrorResponse(res, err);
      return true;
    }

    // `/pair/claim` is the first contact point for an unknown extension;
    // in preview mode we accept any well-formed `chrome-extension://[a-p]{32}`
    // Origin so the extension's 5-second claim fetch can succeed on first
    // install. Consent is delegated to the 6-digit pair code (10-min TTL,
    // 10-attempt rate limit, fresh-per-install) rather than an unresolvable
    // TOFU prompt. Other pair routes stay on the strict sync guard below.
    // See docs-private/investigations/260423_tofu_vs_claim_timeout_bug.md.
    if (req.method === 'POST' && pathname === CLAIM_PATH) {
      fireAndForget(handleClaim(req, res, {
        ...options,
        forgetTrackedPairSession: (pairSessionId: string) => {
          trackedPairSessionExpiries.delete(pairSessionId);
        },
      }), 'appBridge.pairRoutes.handleClaim');
      return true;
    }

    try {
      assertAllowedOrigin(req, {
        ...options.originGuardOptions,
        errorReporter: options.errorReporter,
      });
    } catch (err) {
      applyErrorResponse(res, err);
      return true;
    }

    if (req.method === 'POST' && pathname === START_PATH) {
      fireAndForget(handleStart(req, res, options), 'appBridge.pairRoutes.handleStart');
      return true;
    }

    if (req.method === 'POST' && pathname === REVOKE_PATH) {
      fireAndForget(handleRevoke(req, res, options), 'appBridge.pairRoutes.handleRevoke');
      return true;
    }

    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.BAD_REQUEST,
        `Unknown pair route: ${req.method} ${pathname}`,
      ),
    );
    return true;
  } as PairRoutesHandle;

  pairRoutes.dispose = (): void => {
    clearInterval(sweepInterval);
    trackedPairSessionExpiries.clear();
    options.pairingStore.createPendingSession = originalCreatePendingSession;
  };

  return pairRoutes;
}

async function handleStart(
  req: Parameters<RouterHandler>[0],
  res: Parameters<RouterHandler>[1],
  options: PairRoutesOptions,
): Promise<void> {
  try {
    const routerToken = options.tokenStore.getRouterInternalToken();
    assertInternalOrDevAccess(routerToken, extractBearer(req));

    const body = await readJsonBody(req);
    const appId = parseAppId(body);
    const session = options.pairingStore.createPendingSession(appId);
    options.errorReporter?.addBreadcrumb({
      category: 'app-bridge.pair',
      level: 'info',
      message: 'pair-start',
      data: { appId, expiresAt: session.expiresAt },
    });
    if (options.logger) {
      installEvent(options.logger, 'info', 'app-bridge.pair.start', {
        appId,
        expiresAt: session.expiresAt,
      });
    }
    sendJson(res, 200, {
      code: session.code,
      expiresAt: session.expiresAt,
    });
  } catch (err) {
    applyErrorResponse(res, err);
  }
}

/**
 * Result of `assertClaimOriginAllowed`. Captures whether the request was
 * approved via the strict allowlist fast-path (`'allowlist'`) or via the
 * preview-mode bypass for unknown-but-well-formed chrome-extension
 * origins (`'preview-bypass'`). Callers use this distinction to decide
 * whether trust-persistence side-effects (e.g. `onClaimPersistTrust`)
 * should fire — the fast-path already has a persisted allowlist entry,
 * so re-persisting would be redundant; the bypass path has no such
 * entry and MUST persist so subsequent `/intent/*` requests succeed via
 * the strict sync guard.
 */
type ClaimOriginAllowed = { source: 'allowlist' | 'preview-bypass' };

/**
 * Claim-specific origin guard. The strict sync guard runs first — any
 * Origin that's already in the static allowlist or persisted trust file
 * succeeds via the fast path (`source: 'allowlist'`). Only if that
 * rejects AND preview mode is enabled AND the Origin is a well-formed
 * chrome-extension URL do we allow the claim to proceed via the bypass
 * (`source: 'preview-bypass'`).
 *
 * SECURITY TRADEOFF (intentional): the previous posture required BOTH a
 * valid pair code AND host-side TOFU approval for unknown origins. The
 * TOFU approval surface was unresolvable in practice during first-install
 * (no Approve button while the user is racing a 5s claim timeout), so
 * 100% of first installs failed. We now rely solely on the pair code
 * (6 digits, 10-min TTL, 10-attempt rate limit, clientId-bound, fresh
 * per install) as the consent gate at claim time. See the diagnosis doc
 * for the full rationale:
 *   docs-private/investigations/260423_tofu_vs_claim_timeout_bug.md
 */
function assertClaimOriginAllowed(
  req: Parameters<RouterHandler>[0],
  options: PairRoutesOptions,
): ClaimOriginAllowed {
  try {
    assertAllowedOrigin(req, {
      ...options.originGuardOptions,
      errorReporter: options.errorReporter,
    });
    return { source: 'allowlist' };
  } catch (err) {
    if (!options.originGuardOptions.previewMode) {
      throw err;
    }
    const originHeader = req.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    const extensionIdMatch =
      typeof origin === 'string' ? CHROME_EXTENSION_ORIGIN_REGEX.exec(origin) : null;
    if (!extensionIdMatch) {
      // Preserve the original sync-guard rejection posture for
      // moz-extension, null, wrong-scheme, or malformed IDs.
      throw err;
    }
    // Well-formed chrome-extension origin in preview mode — let the pair
    // code carry consent. Trust persistence happens on successful claim
    // via `onClaimPersistTrust` below, but ONLY when the bypass branch
    // was taken (see the caller in `handleClaim`).
    const bypassData = {
      extensionIdSuffix: extensionIdMatch[1].slice(-4),
      previewMode: true,
      source: 'pair-claim' as const,
    };
    options.errorReporter?.addBreadcrumb({
      category: 'app-bridge.pair',
      level: 'info',
      message: 'pair-claim-preview-bypass',
      data: bypassData,
    });
    if (options.logger) {
      installEvent(
        options.logger,
        'info',
        'app-bridge.pair.claim.preview-bypass',
        bypassData,
      );
    }
    return { source: 'preview-bypass' };
  }
}

async function handleClaim(
  req: Parameters<RouterHandler>[0],
  res: Parameters<RouterHandler>[1],
  options: PairRoutesOptions,
): Promise<void> {
  try {
    let originOutcome: ClaimOriginAllowed;
    try {
      originOutcome = assertClaimOriginAllowed(req, options);
    } catch (err) {
      applyErrorResponse(res, err);
      return;
    }

    const body = await readJsonBody(req);
    const code = parseCode(body);
    const clientId = parseClientId(body);
    const fingerprintRaw = body['fingerprint'];
    const fingerprint =
      typeof fingerprintRaw === 'string' && fingerprintRaw.length > 0
        ? fingerprintRaw
        : undefined;
    const extensionId = extractOriginExtensionId(req);
    const result = options.pairingStore.claim(code, {
      clientId,
      fingerprint,
      extensionId,
    });
    if (result.ok) {
      if (result.pairSessionId) {
        options.forgetTrackedPairSession?.(result.pairSessionId);
        options.pairEventBus.emit({
          type: 'paired',
          cause: 'paired',
          pairSessionId: result.pairSessionId,
          ...(fingerprint ? { tokenFingerprint: fingerprint } : {}),
          emittedAt: Date.now(),
        });
      }
      // Fire-and-forget trust persistence — ONLY when the origin was
      // admitted via the preview-bypass branch. Allowlist-fast-path
      // origins already have a persisted trust entry so re-persisting
      // would be redundant; firing the callback there also risks
      // surprising future code that (correctly) assumes the callback
      // means "new trust was just granted".
      //
      // Scheme guard: `extractOriginExtensionId` also matches
      // `moz-extension://`, which must never reach
      // `rememberTrustedExtensionIdForPairSession` — that helper writes
      // to `dev-extension-ids.json`, a Chrome-only trust file. Today the
      // bypass branch can only trigger for chrome-extension origins
      // (the preview-bypass regex requires it), but we re-assert the
      // scheme here so a future expansion of the bypass can't silently
      // leak moz IDs into the chrome-only file.
      //
      // The host's callback handles the actual disk write + session-scoped
      // bookkeeping so `resetInstall` can forget the ID later. We
      // intentionally do NOT await — any failure inside the callback is
      // the host's responsibility to log, and the claim response must
      // not be blocked on disk IO.
      const originHeader = req.headers.origin;
      const originValue = Array.isArray(originHeader) ? originHeader[0] : originHeader;
      const isChromeExtensionOrigin =
        typeof originValue === 'string' &&
        CHROME_EXTENSION_ORIGIN_REGEX.test(originValue);
      if (
        originOutcome.source === 'preview-bypass' &&
        isChromeExtensionOrigin &&
        result.pairSessionId &&
        typeof extensionId === 'string' &&
        extensionId.length > 0 &&
        options.onClaimPersistTrust
      ) {
        try {
          options.onClaimPersistTrust({
            pairSessionId: result.pairSessionId,
            extensionId,
          });
        } catch (err) {
          // Defensive — the contract says the callback must not throw,
          // but we never let a bad host implementation kill a successful
          // claim. Log and move on; the pair token has already been
          // minted inside `pairingStore.claim()`.
          const threwData = {
            err: err instanceof Error ? err.message : String(err),
          };
          options.errorReporter?.addBreadcrumb({
            category: 'app-bridge.pair',
            level: 'warning',
            message: 'pair-claim-persist-trust-threw',
            data: threwData,
          });
          if (options.logger) {
            installEvent(
              options.logger,
              'warn',
              'app-bridge.pair.claim.persist-trust-threw',
              threwData,
            );
          }
        }
      }
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.pair',
        level: 'info',
        message: 'pair-claim-ok',
        data: { clientId },
      });
      if (options.logger) {
        installEvent(options.logger, 'info', 'app-bridge.pair.claim.ok', { clientId });
      }
      sendJson(res, 200, { token: result.token });
      return;
    }
    const errorCode = result.error;
    options.errorReporter?.addBreadcrumb({
      category: 'app-bridge.pair',
      level: 'warning',
      message: 'pair-claim-fail',
      data: { code: errorCode },
    });
    if (options.logger) {
      installEvent(options.logger, 'warn', 'app-bridge.pair.claim.fail', { code: errorCode });
    }
    applyErrorResponse(res, createAppBridgeError(errorCode));
  } catch (err) {
    applyErrorResponse(res, err);
  }
}

async function handleRevoke(
  req: Parameters<RouterHandler>[0],
  res: Parameters<RouterHandler>[1],
  options: PairRoutesOptions,
): Promise<void> {
  try {
    const token = extractBearer(req);
    if (!token) {
      throw createAppBridgeError(
        ErrorCode.UNAUTHORIZED,
        'Missing Authorization: Bearer <token> header.',
      );
    }

    // Token-scope enforcement (R5 / D13): the router-internal token may
    // never exercise `/pair/revoke`. Pair tokens are the only permitted
    // class here; any other class is a security reject (403 + breadcrumb).
    const kind = options.tokenStore.classifyToken(token);
    if (kind === 'router-internal') {
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.security',
        level: 'warning',
        message: 'router-internal-token-rejected-on-pair-revoke',
        data: { reason: 'router-internal-token-presented-on-pair-route' },
      });
      if (options.logger) {
        installEvent(options.logger, 'warn', 'app-bridge.security.router-internal-token-rejected', {
          route: '/pair/revoke',
          reason: 'router-internal-token-presented-on-pair-route',
        });
      }
      throw createAppBridgeError(
        ErrorCode.FORBIDDEN,
        'Router-internal token cannot be used on /pair/* routes.',
      );
    }
    if (kind !== 'pair') {
      throw createAppBridgeError(ErrorCode.UNAUTHORIZED, 'Token is not recognised.');
    }
    options.pairingStore.revoke(token);
    options.errorReporter?.addBreadcrumb({
      category: 'app-bridge.pair',
      level: 'info',
      message: 'pair-revoke',
    });
    if (options.logger) {
      installEvent(options.logger, 'info', 'app-bridge.pair.revoke', {});
    }
    res.writeHead(204);
    res.end();
  } catch (err) {
    applyErrorResponse(res, err);
  }
}

// Keep the explicit `AppBridgeError` type available for consumers that
// want to narrow on shape.
export type { AppBridgeError };
