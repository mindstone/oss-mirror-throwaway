import type { ErrorReporter } from '@core/errorReporter';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import {
  createAppBridgeError,
  ErrorCode,
  type AppBridgeError,
} from '../shared/errors';
import type { PairEventBus, PairEvent } from './pairEventBus';
import {
  applyErrorResponse,
  extractBearer,
  readJsonBody,
  sendJson,
  type RouterHandler,
} from './httpUtils';
import type { TokenStore } from './tokenStore';

export interface HostRoutesHandlers {
  prepareInstall: (
    browserId?: string,
  ) => Promise<{
    ok: boolean;
    reason: string;
    userMessage?: string;
    instructions?: string;
    retryable: boolean;
    data?: {
      attemptId: string;
      setupStatus: string;
      selectedBrowser?: {
        id: string;
        displayName: string;
        extensionsPageUrl: string;
      };
      browserChoices?: Array<{
        id: string;
        displayName: string;
        extensionsPageUrl: string;
      }>;
      pairSessionId?: string;
      nextStep: string;
      steps: Array<{
        name: string;
        ok: boolean;
        status?: string;
        reason?: string;
        retryable?: boolean;
      }>;
    };
  }>;
  extractExtension: (
    browserId: string,
  ) => Promise<{ ok: boolean; targetDir?: string; action?: string; pairSessionId?: string; reason?: string }>;
  revealExtensionFolder: (browserId: string) => Promise<{
    ok: boolean;
    reason?: string;
    userMessage?: string;
    instructions?: string;
    retryable?: boolean;
  }>;
  openBrowserExtensionsPage: (
    browserId: string,
  ) => Promise<{
    ok: boolean;
    fallbackUrl?: string;
    reason?: string;
    userMessage?: string;
    instructions?: string;
    retryable?: boolean;
  }>;
  startPairing: (opts: {
    browserId?: string;
  }) => {
    code: string;
    expiresAt: number;
    expiresInSeconds: number;
    pairSessionId: string;
    appId: string;
  };
  checkPairStatus: (pairSessionId: string) => {
    paired: { appId: string; clientId: string }[];
    hasPending: boolean;
    pairSessionExpired?: boolean;
    /**
     * True when the pairSessionId was never issued by this bridge.
     * Distinct from `pairSessionExpired` (we remember it, it aged out).
     * The extension/agent should treat this as a hard error instead of
     * retrying.
     */
    pairSessionNotFound?: boolean;
  };
  diagnose: (args: {
    browserId: string;
    pairSessionId?: string;
  }) => Promise<{
    ok: boolean;
    reason: string;
    userMessage?: string;
    instructions?: string;
    retryable: boolean;
    data?: {
      browserRunning: boolean;
      extensionExtracted: boolean;
      recentInstallBreadcrumbCount: number;
      recentInstallFailureCount: number;
      lastFailureReason: string | null;
      bridgeReachable: boolean;
      pairSessionActive: boolean;
    };
  }>;
  resetInstall: (args: {
    pairSessionId: string;
    full?: boolean;
  }) => Promise<{
    ok: boolean;
    reason: string;
    retryable: boolean;
    userMessage?: string;
    instructions?: string;
    data?: {
      revoked: number;
      idsRemoved: number;
      folderRemoved?: boolean;
      degraded?: boolean;
    };
  }>;
  listPendingApprovals: (pairSessionId: string) => {
    pendingApprovalId: string;
    fingerprint: string;
    extensionId: string;
    inferredBrowserId?: string;
    createdAt: number;
    expiresAt: number;
  }[];
  approvePending: (args: {
    pendingApprovalId: string;
    approved: boolean;
    fingerprint: string;
    pairSessionId: string;
  }) => { ok: boolean; reason?: string };
  listPaired: () => { appId: string; clientId: string; issuedAt: number }[];
  endPairSession: (pairSessionId: string) => void;
  /**
   * Mint a paired app token for a host-trusted companion process (e.g. the
   * Office sidecar) without running the interactive pair/claim flow.
   *
   * Only reachable via `/host/*` routes, so the caller must already hold
   * the router-internal token — which lives only in the bridge state file
   * (mode 0o600) and can be read only by processes under the same user as
   * the bridge (i.e. the Rebel desktop app and its spawned children like
   * the Office sidecar). Any process that can read that file is already
   * trusted at the same level as the Rebel app itself.
   *
   * The handler is responsible for:
   *   - Gating on `appId` — only known trusted-host appIds (today:
   *     `'office-addin'`) may mint through this route. Unknown appIds are
   *     rejected with `FORBIDDEN` to avoid turning this into a universal
   *     token-issuance backdoor.
   *   - Issuing a pair-class token via `TokenStore.issueAppToken(appId,
   *     clientId)` and returning it.
   */
  mintAppTokenForTrustedHost: (args: {
    appId: string;
    clientId: string;
    extensionId?: string;
    originExtensionId?: string;
    installSessionId?: string;
    fingerprint?: string;
  }) =>
    | { ok: true; token: string }
    | {
        ok: false;
        reason: string;
        status?: number;
        retryAfterMs?: number;
        direction?: 'forward' | 'reverse';
      };
}

export interface HostRoutesOptions {
  tokenStore: TokenStore;
  handlers: HostRoutesHandlers;
  pairEventBus: PairEventBus;
  errorReporter?: ErrorReporter;
  logger?: Logger;
  pairEventsKeepaliveMs?: number;
  pairEventsIdleTimeoutMs?: number;
}

const KNOWN_PATH_METHODS = new Map<string, 'GET' | 'POST'>([
  ['/host/prepare-install', 'POST'],
  ['/host/extract-extension', 'POST'],
  ['/host/reveal-extension-folder', 'POST'],
  ['/host/open-extensions-page', 'POST'],
  ['/host/start-pairing', 'POST'],
  ['/host/pair-events', 'GET'],
  ['/host/check-pair-status', 'GET'],
  ['/host/diagnose', 'POST'],
  ['/host/reset-install', 'POST'],
  ['/host/list-pending-approvals', 'GET'],
  ['/host/approve-pending', 'POST'],
  ['/host/list-paired', 'GET'],
  ['/host/end-pair-session', 'POST'],
  ['/host/mint-app-token', 'POST'],
]);

const DEFAULT_PAIR_EVENTS_KEEPALIVE_MS = 15_000;
// Idle close must be longer than the pair-code TTL (10min, see
// src/core/appBridge/server/pairingStore.ts) so a single 10-minute
// wait_pair_event SSE stream isn't torn down server-side mid-wait and
// reported to the user as `bridge-unreachable`. Small grace buffer on top.
const DEFAULT_PAIR_EVENTS_IDLE_TIMEOUT_MS = 11 * 60_000;
const PAIR_SESSION_ID_HEADER = 'x-rebel-pair-session-id';

function getUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://127.0.0.1');
}

function requireStringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createAppBridgeError(
      ErrorCode.BAD_REQUEST,
      `Request body requires non-empty string field "${key}".`,
    );
  }
  return value;
}

function requireBooleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') {
    throw createAppBridgeError(
      ErrorCode.BAD_REQUEST,
      `Request body requires boolean field "${key}".`,
    );
  }
  return value;
}

function readOptionalStringField(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createAppBridgeError(
      ErrorCode.BAD_REQUEST,
      `Request body field "${key}" must be a non-empty string when provided.`,
    );
  }
  return value;
}

function optionalStringField(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createAppBridgeError(
      ErrorCode.BAD_REQUEST,
      `Request body field "${key}" must be a non-empty string when provided.`,
    );
  }
  return value;
}

function getPairSessionId(req: IncomingMessage, url: URL): string | null {
  const fromQuery = url.searchParams.get('pairSessionId');
  if (typeof fromQuery === 'string' && fromQuery.trim().length > 0) {
    return fromQuery;
  }

  const header = req.headers[PAIR_SESSION_ID_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === 'string' && fromHeader.trim().length > 0) {
    return fromHeader;
  }

  return null;
}

function getSingleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isBrowserExtensionOrigin(value: string | string[] | undefined): boolean {
  return getBrowserExtensionOriginId(value) !== null;
}

function getBrowserExtensionOriginId(value: string | string[] | undefined): string | null {
  const origin = getSingleHeaderValue(value);
  if (typeof origin !== 'string') return null;
  const chromeMatch = /^chrome-extension:\/\/([a-p]{32})$/i.exec(origin);
  if (chromeMatch?.[1]) return chromeMatch[1].toLowerCase();
  const mozMatch = /^moz-extension:\/\/([a-f0-9-]+)$/i.exec(origin);
  if (mozMatch?.[1]) return mozMatch[1].toLowerCase();
  return null;
}

function writePairEvent(res: ServerResponse, event: PairEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function createMissingPairSessionIdError(): AppBridgeError {
  return createAppBridgeError(
    ErrorCode.BAD_REQUEST,
    'Missing required pairSessionId query parameter or x-rebel-pair-session-id header.',
  );
}

export function createHostRoutes(options: HostRoutesOptions): RouterHandler {
  return function hostRoutes(req, res): boolean {
    const url = getUrl(req);
    const pathname = url.pathname;
    if (!pathname.startsWith('/host/')) {
      return false;
    }

    const expectedMethod = KNOWN_PATH_METHODS.get(pathname);
    if (!expectedMethod) {
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.BAD_REQUEST,
          `Unknown host route: ${req.method ?? 'UNKNOWN'} ${pathname}`,
        ),
      );
      return true;
    }

    if (req.method !== expectedMethod) {
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.METHOD_NOT_ALLOWED,
          `Only ${expectedMethod} is allowed on ${pathname}; got ${req.method ?? 'UNKNOWN'}.`,
        ),
      );
      return true;
    }

    const presented = extractBearer(req);
    if (!presented) {
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.UNAUTHORIZED,
          'Missing Authorization: Bearer <router-internal-token> header.',
        ),
      );
      return true;
    }

    const kind = options.tokenStore.classifyToken(presented);
    if (kind === 'pair') {
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.security',
        level: 'warning',
        message: 'pair-token-rejected-on-host-route',
        data: { pathname, reason: 'pair-token-presented-on-host-route' },
      });
      options.logger?.warn(
        { pathname },
        'Pair token rejected on /host/* route — refusing to escalate scope',
      );
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.FORBIDDEN,
          'Pair tokens are not accepted on /host/* routes.',
        ),
      );
      return true;
    }

    if (kind !== 'router-internal') {
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.UNAUTHORIZED,
          'Presented token is not recognised.',
        ),
      );
      return true;
    }

    if (isBrowserExtensionOrigin(req.headers.origin) && pathname !== '/host/mint-app-token') {
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.security',
        level: 'warning',
        message: 'browser-extension-origin-rejected-on-host-route',
        data: { pathname },
      });
      options.logger?.warn(
        { pathname },
        'Browser-extension origin rejected on privileged /host/* route',
      );
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.FORBIDDEN,
          'Browser extension origins may only exchange boot tokens on /host/mint-app-token.',
        ),
      );
      return true;
    }

    handleHostDispatch(req, res, options).catch((err: unknown) => {
      options.logger?.error({ err, pathname }, 'Host route dispatch threw unexpectedly');
      options.errorReporter?.captureException(err, {
        area: 'app-bridge.host-routes',
        pathname,
      });
      if (!res.headersSent) {
        applyErrorResponse(res, err);
      } else {
        res.end();
      }
    });

    return true;
  };
}

async function handleHostDispatch(
  req: IncomingMessage,
  res: ServerResponse,
  options: HostRoutesOptions,
): Promise<void> {
  const url = getUrl(req);
  const pathname = url.pathname;

  switch (pathname) {
    case '/host/prepare-install': {
      const body = await readJsonBody(req);
      const browserId = optionalStringField(body, 'browserId');
      const result = await options.handlers.prepareInstall(browserId);
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.install',
        level: 'info',
        message: 'app-bridge.install.prepare',
        data: {
          browserId,
          ok: result.ok,
          reason: result.reason,
          setupStatus: result.data?.setupStatus,
          attemptId: result.data?.attemptId,
        },
      });
      sendJson(res, 200, result);
      return;
    }
    case '/host/extract-extension': {
      const body = await readJsonBody(req);
      const browserId = requireStringField(body, 'browserId');
      const result = await options.handlers.extractExtension(browserId);
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.install',
        level: 'info',
        message: 'app-bridge.install.extract',
        data: { browserId, action: result.action ?? 'failed', reason: result.reason },
      });
      sendJson(res, 200, result.ok ? result : { ok: false, reason: result.reason });
      return;
    }
    case '/host/reveal-extension-folder': {
      const body = await readJsonBody(req);
      const browserId = requireStringField(body, 'browserId');
      const result = await options.handlers.revealExtensionFolder(browserId);
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.install',
        level: 'info',
        message: 'app-bridge.install.reveal',
        data: { browserId, ok: result.ok },
      });
      sendJson(res, 200, result);
      return;
    }
    case '/host/open-extensions-page': {
      const body = await readJsonBody(req);
      const browserId = requireStringField(body, 'browserId');
      const result = await options.handlers.openBrowserExtensionsPage(browserId);
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.install',
        level: 'info',
        message: 'app-bridge.install.open-extensions-page',
        data: { browserId, ok: result.ok, reason: result.reason },
      });
      sendJson(
        res,
        200,
        result,
      );
      return;
    }
    case '/host/start-pairing': {
      const body = await readJsonBody(req);
      const browserId = optionalStringField(body, 'browserId');
      const result = options.handlers.startPairing(
        browserId ? { browserId } : {},
      );
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.install',
        level: 'info',
        message: 'app-bridge.install.pair-start',
        data: {
          browserId,
          pairSessionId: result.pairSessionId,
          expiresAt: result.expiresAt,
        },
      });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    case '/host/pair-events': {
      const pairSessionId = getPairSessionId(req, url);
      if (!pairSessionId) {
        applyErrorResponse(res, createMissingPairSessionIdError());
        return;
      }

      const keepaliveMs =
        options.pairEventsKeepaliveMs ?? DEFAULT_PAIR_EVENTS_KEEPALIVE_MS;
      const idleTimeoutMs =
        options.pairEventsIdleTimeoutMs ?? DEFAULT_PAIR_EVENTS_IDLE_TIMEOUT_MS;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.flushHeaders?.();

      let closed = false;
      let idleTimer: NodeJS.Timeout | null = null;
      let unsubscribe = (): void => {};
      const keepaliveTimer = setInterval(() => {
        if (!closed) {
          res.write(':\n\n');
        }
      }, keepaliveMs);
      keepaliveTimer.unref?.();

      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        unsubscribe();
        clearInterval(keepaliveTimer);
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const resetIdleTimer = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
          cleanup();
          res.end();
        }, idleTimeoutMs);
        idleTimer.unref?.();
      };

      const emitEvent = (event: PairEvent): void => {
        if (closed) {
          return;
        }
        writePairEvent(res, event);
        resetIdleTimer();
      };

      const replay = options.pairEventBus.getReplay(pairSessionId);
      for (const event of replay) {
        emitEvent(event);
      }

      unsubscribe = options.pairEventBus.subscribe(pairSessionId, emitEvent);
      resetIdleTimer();
      req.on('close', cleanup);
      res.on('close', cleanup);
      return;
    }
    case '/host/check-pair-status': {
      const pairSessionId = getPairSessionId(req, url);
      if (!pairSessionId) {
        sendJson(res, 200, { ok: false, reason: 'pair-session-id-required' });
        return;
      }
      const result = options.handlers.checkPairStatus(pairSessionId);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    case '/host/diagnose': {
      const body = await readJsonBody(req);
      const browserId = requireStringField(body, 'browserId');
      const pairSessionId = optionalStringField(body, 'pairSessionId');
      const result = await options.handlers.diagnose({
        browserId,
        ...(pairSessionId ? { pairSessionId } : {}),
      });
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.install',
        level: 'info',
        message: 'app-bridge.install.diagnose',
        data: { browserId, pairSessionId, ok: result.ok, reason: result.reason },
      });
      sendJson(res, 200, result);
      return;
    }
    case '/host/reset-install': {
      const body = await readJsonBody(req);
      const pairSessionId = requireStringField(body, 'pairSessionId');
      const full = typeof body.full === 'boolean' ? body.full : undefined;
      const result = await options.handlers.resetInstall({
        pairSessionId,
        ...(full === undefined ? {} : { full }),
      });
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.install',
        level: 'info',
        message: 'app-bridge.install.reset',
        data: { pairSessionId, full, ok: result.ok, reason: result.reason },
      });
      // session-ended emission owned by the manager to preserve translator-subscribe ordering
      sendJson(res, 200, result);
      return;
    }
    case '/host/list-pending-approvals': {
      const pairSessionId = getPairSessionId(req, url);
      if (!pairSessionId) {
        sendJson(res, 200, { ok: false, reason: 'pair-session-id-required' });
        return;
      }
      const pending = options.handlers.listPendingApprovals(pairSessionId);
      sendJson(res, 200, { ok: true, pending });
      return;
    }
    case '/host/approve-pending': {
      const body = await readJsonBody(req);
      const result = options.handlers.approvePending({
        pendingApprovalId: requireStringField(body, 'pendingApprovalId'),
        approved: requireBooleanField(body, 'approved'),
        fingerprint: requireStringField(body, 'fingerprint'),
        pairSessionId: requireStringField(body, 'pairSessionId'),
      });
      sendJson(
        res,
        200,
        result.ok ? { ok: true } : { ok: false, reason: result.reason },
      );
      return;
    }
    case '/host/list-paired': {
      const paired = options.handlers.listPaired();
      sendJson(res, 200, { ok: true, paired });
      return;
    }
    case '/host/end-pair-session': {
      const body = await readJsonBody(req);
      const pairSessionId = requireStringField(body, 'pairSessionId');
      // Emit BEFORE the handler call so the Stage 2 translator subscription
      // is still live when the bus sees the event. The translator suppresses
      // `session-ended`/`cause: step7-cleanup` (no user-visible broadcast),
      // so a stale post-cleanup emit wasn't user-visible — but the same
      // ordering rule applies, and keeping it consistent with
      // `manager.resetInstall()`'s internal emit-before-cleanup ordering
      // prevents future reviewers from re-introducing the
      // emit-after-unsubscribe pattern here.
      options.pairEventBus.emit({
        type: 'session-ended',
        cause: 'step7-cleanup',
        pairSessionId,
        emittedAt: Date.now(),
      });
      options.handlers.endPairSession(pairSessionId);
      sendJson(res, 200, {
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {},
      });
      return;
    }
    case '/host/mint-app-token': {
      const body = await readJsonBody(req);
      const appId = requireStringField(body, 'appId');
      const clientId = requireStringField(body, 'clientId');
      const extensionId = readOptionalStringField(body, 'extensionId');
      const installSessionId = readOptionalStringField(body, 'installSessionId');
      const fingerprint = readOptionalStringField(body, 'fingerprint');
      const originExtensionId = getBrowserExtensionOriginId(req.headers.origin);

      if (originExtensionId && appId !== 'browser-extension') {
        options.errorReporter?.addBreadcrumb({
          category: 'app-bridge.security',
          level: 'warning',
          message: 'mint-app-token-browser-origin-appid-mismatch',
          data: { appId },
        });
        options.logger?.warn(
          { appId },
          'mint-app-token rejected — browser extension origin requested non-browser appId',
        );
        sendJson(res, 403, {
          ok: false,
          reason: 'browser-extension-origin-appid-mismatch',
          code: ErrorCode.FORBIDDEN,
        });
        return;
      }

      if (
        appId !== 'browser-extension' &&
        (extensionId !== undefined ||
          installSessionId !== undefined ||
          fingerprint !== undefined)
      ) {
        sendJson(res, 400, {
          ok: false,
          reason: 'browser-extension-fields-not-allowed',
          code: ErrorCode.BAD_REQUEST,
        });
        return;
      }

      if (
        appId === 'browser-extension' &&
        originExtensionId &&
        extensionId &&
        originExtensionId !== extensionId.toLowerCase()
      ) {
        options.errorReporter?.addBreadcrumb({
          category: 'app-bridge.security',
          level: 'warning',
          message: 'mint-app-token-extension-origin-mismatch',
          data: { appId },
        });
        options.logger?.warn(
          { appId },
          'mint-app-token rejected — extension origin did not match body extensionId',
        );
        sendJson(res, 403, {
          ok: false,
          reason: 'extension-origin-mismatch',
          code: ErrorCode.FORBIDDEN,
        });
        return;
      }

      const result = options.handlers.mintAppTokenForTrustedHost({
        appId,
        clientId,
        ...(extensionId ? { extensionId } : {}),
        ...(originExtensionId ? { originExtensionId } : {}),
        ...(installSessionId ? { installSessionId } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      });
      if (!result.ok) {
        const status = result.status ?? 403;
        const code =
          status === 400
            ? ErrorCode.BAD_REQUEST
            : status === 429
              ? ErrorCode.RATE_LIMITED
              : ErrorCode.FORBIDDEN;
        options.errorReporter?.addBreadcrumb({
          category: 'app-bridge.security',
          level: 'warning',
          message: 'mint-app-token-rejected',
          data: {
            appId,
            reason: result.reason,
            ...(result.direction ? { direction: result.direction } : {}),
            ...(result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : {}),
          },
        });
        options.logger?.warn(
          {
            appId,
            reason: result.reason,
            ...(result.direction ? { direction: result.direction } : {}),
            ...(result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : {}),
          },
          'mint-app-token rejected',
        );
        if (status === 429 && typeof result.retryAfterMs === 'number' && result.retryAfterMs > 0) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
        }
        sendJson(res, status, {
          ok: false,
          reason: result.reason,
          code,
          ...(result.direction ? { direction: result.direction } : {}),
        });
        return;
      }
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.pair',
        level: 'info',
        message: 'mint-app-token-ok',
        data: { appId, clientId },
      });
      options.logger?.info(
        { appId, clientId },
        'Minted app token for trusted host',
      );
      sendJson(res, 200, { ok: true, token: result.token, appId, clientId });
      return;
    }
    default:
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.BAD_REQUEST,
          `Unknown host route: ${req.method ?? 'UNKNOWN'} ${pathname}`,
        ),
      );
  }
}
