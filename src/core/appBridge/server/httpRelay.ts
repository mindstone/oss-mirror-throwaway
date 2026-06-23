/**
 * httpRelay — `/apps/:appId/:capabilityId` relay (Stage 4).
 *
 * Turns the router-internal token (R5 / D13) into real WS dispatch:
 *
 *   - `Authorization: Bearer <token>` required. Missing → 401.
 *   - Pair tokens are **rejected with 403** (plus a Sentry breadcrumb) so a
 *     leaked extension token can never exercise the router-internal surface.
 *   - Only the router-internal token is accepted — anything else → 401.
 *   - `X-Rebel-App-Id` required and must equal `:appId`. Missing / mismatch
 *     → 400 BAD_REQUEST.
 *   - Wrong HTTP verb on `/apps/…` → 405 METHOD_NOT_ALLOWED with the
 *     structured error envelope.
 *   - Unknown capability (app not registered, or app registered but didn't
 *     advertise that capability) → 404 CAPABILITY_NOT_SUPPORTED.
 *   - App not connected → 503 APP_NOT_CONNECTED.
 *   - Dispatch timeout → 504 COMMAND_TIMEOUT.
 *   - Idempotent retry drop → 409 IDEMPOTENT_DROP.
 *   - Happy path → 200 OK with `{ success: true, data, commandId }`.
 *   - Any unexpected throw → 500 INTERNAL_ERROR (structured body).
 *
 * Origin check is intentionally skipped for `/apps/*`: the relay is invoked
 * only by the bundled RebelAppBridge stdio MCP server, which runs as a
 * Node-hosted subprocess with no Origin header to supply. The router-internal
 * token is the only admission check (R5 / D13).
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import type { ErrorReporter } from '@core/errorReporter';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { redactOrigin } from '@shared/utils/sentryRedaction';
import { createAppBridgeError, ErrorCode, type AppBridgeError } from '../shared/errors';
import type { CapabilityRegistry } from './capabilityRegistry';
import type { CommandRouter, DispatchArgs } from './commandRouter';
import {
  applyErrorResponse,
  extractBearer,
  readJsonBody,
  sendJson,
  type RouterHandler,
} from './httpUtils';
import type { TokenStore } from './tokenStore';
import type { TabContext } from '../shared/protocol';
import {
  browserConversationScopeRegistry,
  tabContextsMateriallyMatch,
} from './browserConversationScopeRegistry';

export interface HttpRelayOptions {
  commandRouter: CommandRouter;
  capabilityRegistry: CapabilityRegistry;
  tokenStore: TokenStore;
  errorReporter?: ErrorReporter;
  logger?: Logger;
  /**
   * Optional permission-grant tracker. When present, INJECTION_REFUSED
   * responses with `details.reason === 'no-host-permission'` and
   * `details.retryable === true` will await a grant for `details.origin`
   * (default 60 s) before either retrying the dispatch or surfacing the
   * original error. Without this option, INJECTION_REFUSED is forwarded
   * immediately as before — preserving the prior behavior for any test
   * that doesn't wire one up.
   */
  permissionGrantTracker?: {
    awaitGrant: (opts: {
      origin: string;
      timeoutMs: number;
      signal?: AbortSignal;
    }) => Promise<boolean>;
  };
  /**
   * Maximum time the relay will await a grant before giving up. Default
   * 60_000 ms — chosen to match a "user clicked Allow within attention
   * span" budget without holding HTTP connections open indefinitely.
   */
  permissionGrantWaitMs?: number;
}

const APPS_PATH_RE = /^\/apps\/([^/]+)\/([^/]+)$/;
const INTERNAL_CONVERSATION_ID_KEY = '__rebel_conversation_id';
const BROWSER_APP_ID = 'browser-extension';
const BROWSER_STATUS_CAPABILITY = 'status';

/** Type guard — AppBridgeError shape from `shared/errors.ts`. */
function isAppBridgeError(value: unknown): value is AppBridgeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AppBridgeError).code === 'string' &&
    typeof (value as AppBridgeError).status === 'number'
  );
}

function extractRebelAppIdHeader(req: IncomingMessage): string | null {
  const raw = req.headers['x-rebel-app-id'];
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  return null;
}

/**
 * Extract the optional body shape the relay understands:
 *   { payload?: object, prevCommandId?: string, timeoutMs?: number }
 *
 * Everything else is treated as the payload if it isn't one of the three
 * reserved keys, so clients can POST a bare object for convenience.
 */
function parseRelayBody(body: Record<string, unknown>): {
  payload: Record<string, unknown>;
  prevCommandId?: string;
  timeoutMs?: number;
  tabContext?: TabContext;
  conversationId?: string;
} {
  const hasOnlyKnownKeys =
    'payload' in body ||
    'prevCommandId' in body ||
    'timeoutMs' in body;

  if (hasOnlyKnownKeys) {
    const payload =
      body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};
    const prevCommandId =
      typeof body.prevCommandId === 'string' && body.prevCommandId.length > 0
        ? body.prevCommandId
        : undefined;
    const timeoutMs =
      typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs) && body.timeoutMs > 0
        ? body.timeoutMs
        : undefined;
    return {
      payload,
      ...(prevCommandId !== undefined ? { prevCommandId } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...parseConversationId(payload[INTERNAL_CONVERSATION_ID_KEY]),
      ...parseTabContext(payload.tabContext),
    };
  }

  // Bare object → treat the whole body as the payload.
  return {
    payload: body,
    ...parseConversationId(body[INTERNAL_CONVERSATION_ID_KEY]),
    ...parseTabContext(body.tabContext),
  };
}

function parseConversationId(value: unknown): { conversationId?: string } {
  if (typeof value === 'string' && value.trim().length > 0) {
    return { conversationId: value.trim() };
  }
  return {};
}

function parseTabContext(value: unknown): { tabContext?: TabContext } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const tabContext: TabContext = {};
  if (typeof raw.tabId === 'number' && Number.isFinite(raw.tabId)) {
    tabContext.tabId = raw.tabId;
  }
  if (typeof raw.windowId === 'number' && Number.isFinite(raw.windowId)) {
    tabContext.windowId = raw.windowId;
  }
  if (typeof raw.url === 'string' && raw.url.length > 0) {
    tabContext.url = raw.url;
  }
  if (typeof raw.title === 'string' && raw.title.length > 0) {
    tabContext.title = raw.title;
  }
  return Object.keys(tabContext).length > 0 ? { tabContext } : {};
}

function stripInternalRelayFields(payload: Record<string, unknown>): Record<string, unknown> {
  if (!(INTERNAL_CONVERSATION_ID_KEY in payload)) return payload;
  const sanitized = { ...payload };
  delete sanitized[INTERNAL_CONVERSATION_ID_KEY];
  return sanitized;
}

function resolveBrowserTabContext(
  appId: string,
  capabilityId: string,
  payloadTabContext: TabContext | undefined,
  conversationId: string | undefined,
): TabContext | undefined {
  if (appId !== BROWSER_APP_ID) return payloadTabContext;

  const binding = browserConversationScopeRegistry.get(conversationId);
  if (binding) {
    if (
      payloadTabContext &&
      !tabContextsMateriallyMatch(binding.tabContext, payloadTabContext)
    ) {
      throw createAppBridgeError(
        ErrorCode.TAB_CONTEXT_DIVERGED,
        'The requested browser tab no longer matches this conversation.',
      );
    }
    return binding.tabContext;
  }

  if (conversationId) {
    throw createAppBridgeError(
      ErrorCode.TAB_CONTEXT_GONE,
      'The browser tab bound to this conversation is no longer available.',
    );
  }

  if (capabilityId !== BROWSER_STATUS_CAPABILITY && !payloadTabContext) {
    throw createAppBridgeError(
      ErrorCode.TAB_CONTEXT_GONE,
      'Browser DOM actions require a scoped tab context.',
    );
  }

  return payloadTabContext;
}

export function createHttpRelayRouter(options: HttpRelayOptions): RouterHandler {
  return function httpRelay(req, res): boolean {
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.split('?')[0] ?? '/';
    if (!pathname.startsWith('/apps/')) {
      return false;
    }

    const match = APPS_PATH_RE.exec(pathname);
    if (!match) {
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.BAD_REQUEST,
          `Unknown relay route: ${req.method ?? 'UNKNOWN'} ${pathname}`,
        ),
      );
      return true;
    }

    if (req.method !== 'POST') {
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.METHOD_NOT_ALLOWED,
          `Only POST is allowed on ${pathname}; got ${req.method ?? 'UNKNOWN'}.`,
        ),
      );
      return true;
    }

    const [, pathAppId, capabilityId] = match;
    if (!pathAppId || !capabilityId) {
      applyErrorResponse(
        res,
        createAppBridgeError(ErrorCode.BAD_REQUEST, 'Missing appId or capabilityId.'),
      );
      return true;
    }

    const headerAppId = extractRebelAppIdHeader(req);
    if (!headerAppId) {
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.BAD_REQUEST,
          'Missing required X-Rebel-App-Id header.',
        ),
      );
      return true;
    }

    if (headerAppId !== pathAppId) {
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.BAD_REQUEST,
          'X-Rebel-App-Id header does not match :appId in path.',
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
        message: 'pair-token-rejected-on-relay',
        data: { pathAppId, capabilityId, reason: 'pair-token-presented-on-apps-route' },
      });
      options.logger?.warn(
        { pathAppId, capabilityId },
        'Pair token rejected on /apps/* relay — refusing to escalate scope',
      );
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.FORBIDDEN,
          'Pair tokens are not accepted on /apps/* routes.',
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

    // Auth + shape checks passed. Hand off to the async dispatch pipeline.
    // We deliberately don't `return` the promise — Node's http server uses
    // the synchronous `res.end()` → connection drain model.
    handleRelayDispatch(req, res, options, pathAppId, capabilityId).catch((err: unknown) => {
      options.logger?.error({ err, pathAppId, capabilityId }, 'Relay dispatch threw unexpectedly');
      options.errorReporter?.captureException(err, {
        area: 'app-bridge.relay',
        pathAppId,
        capabilityId,
      });
      // If the response has already been sent, we can't send another one —
      // just destroy the socket.
      if (!res.headersSent) {
        applyErrorResponse(res, err);
      } else {
        res.end();
      }
    });

    return true;
  };
}

/**
 * On INJECTION_REFUSED with a grantable reason, await a permission-granted
 * event from the SW and retry the dispatch once. Returns the retry result if
 * a grant arrived, or `null` if the original error should stand (no tracker
 * configured, non-grantable reason, missing origin, or grant timed out).
 *
 * Returning `null` (instead of returning the original result) makes the call
 * site explicit: caller checks for null and falls through to the normal
 * INJECTION_REFUSED forwarding branch.
 */
async function maybeRetryAfterPermissionGrant(args: {
  req: IncomingMessage;
  res: ServerResponse;
  result: import('./commandRouter').CommandResult;
  dispatchArgs: DispatchArgs;
  options: HttpRelayOptions;
  appId: string;
  capabilityId: string;
}): Promise<(import('./commandRouter').CommandResult) | null> {
  const { req, res, result, dispatchArgs, options, appId, capabilityId } = args;
  if (result.success) return null;
  const tracker = options.permissionGrantTracker;
  if (!tracker) return null;

  const details = (result.details ?? {}) as Record<string, unknown>;
  const reason = typeof details.reason === 'string' ? details.reason : null;
  const retryable = details.retryable === true;
  const origin = typeof details.origin === 'string' ? details.origin : null;

  // Only wait when the SW says this refusal is grantable. unsupported-scheme,
  // chrome-blocked, etc. cannot be unstuck by a permissions grant — waiting
  // 60s for an event that can never arrive would just delay the agent's error.
  if (reason !== 'no-host-permission' || !retryable || !origin) {
    return null;
  }

  // Canonicalize the dispatch's origin to the same scheme://host shape the
  // wsServer event handler stores. Without this, "https://example.com/" and
  // "https://example.com" wouldn't match.
  let canonical: string;
  try {
    const u = new URL(origin);
    canonical = `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }

  const waitMs = options.permissionGrantWaitMs ?? 60_000;
  options.logger?.info(
    { appId, capabilityId, origin: redactOrigin(canonical), waitMs },
    'INJECTION_REFUSED with no-host-permission — awaiting grant before retry',
  );

  const lifecycleController = new AbortController();
  const abortGrantWait = (): void => lifecycleController.abort();
  req.on('close', abortGrantWait);
  res.on('close', abortGrantWait);

  let granted: boolean;
  try {
    granted = await tracker.awaitGrant({
      origin: canonical,
      timeoutMs: waitMs,
      signal: lifecycleController.signal,
    });
  } finally {
    req.off('close', abortGrantWait);
    res.off('close', abortGrantWait);
  }
  if (!granted) {
    options.logger?.info(
      { appId, capabilityId, origin: redactOrigin(canonical) },
      'Permission grant did not arrive within timeout — surfacing original INJECTION_REFUSED',
    );
    return null;
  }

  options.logger?.info(
    { appId, capabilityId, origin: redactOrigin(canonical), commandId: result.commandId },
    'Permission grant arrived — retrying original dispatch',
  );

  // Retry once with prevCommandId set so the recent-history cache treats
  // this as a deliberate retry rather than a stray duplicate. The original
  // dispatch settled synchronously with INJECTION_REFUSED, so wasLateResponse
  // is false — IDEMPOTENT_DROP will not fire.
  const retryArgs: DispatchArgs = {
    ...dispatchArgs,
    prevCommandId: result.commandId,
  };

  try {
    return await options.commandRouter.dispatch(retryArgs);
  } catch (err) {
    options.logger?.warn(
      { appId, capabilityId, err },
      'Permission-grant retry dispatch threw — surfacing original INJECTION_REFUSED',
    );
    return null;
  }
}

/**
 * Full dispatch pipeline after auth passes. Split from `createHttpRelayRouter`
 * for readability — every branch maps to a specific (status, errorCode) pair
 * so the behavior is easy to audit.
 */
async function handleRelayDispatch(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpRelayOptions,
  appId: string,
  capabilityId: string,
): Promise<void> {
  // 1. Read body — `readJsonBody` returns `{}` on empty bodies and rejects
  //    with `BAD_REQUEST` on oversize or malformed JSON.
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    applyErrorResponse(res, err);
    return;
  }

  const { payload, prevCommandId, timeoutMs, tabContext, conversationId } = parseRelayBody(body);
  const dispatchPayload = stripInternalRelayFields(payload);

  // 2. Capability pre-flight — app not connected (no entry in the registry)
  //    OR connected but didn't advertise this capability.
  //
  //    We distinguish the two so the MCP server can show the user a more
  //    specific error: APP_NOT_CONNECTED (503) vs CAPABILITY_NOT_SUPPORTED (404).
  const registeredCaps = options.capabilityRegistry.getCapabilities(appId);
  if (!registeredCaps) {
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.APP_NOT_CONNECTED,
        `App "${appId}" is not connected.`,
      ),
    );
    return;
  }

  const hasCapability = registeredCaps.some((cap) => cap.id === capabilityId);
  if (!hasCapability && capabilityId !== 'status') {
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.CAPABILITY_NOT_SUPPORTED,
        `App "${appId}" does not advertise capability "${capabilityId}".`,
      ),
    );
    return;
  }

  let dispatchTabContext: TabContext | undefined;
  try {
    dispatchTabContext = resolveBrowserTabContext(
      appId,
      capabilityId,
      tabContext,
      conversationId,
    );
  } catch (err) {
    applyErrorResponse(res, err);
    return;
  }

  // 3. Dispatch — `commandRouter.dispatch` throws synchronously for
  //    APP_NOT_CONNECTED / IDEMPOTENT_DROP and rejects asynchronously for
  //    COMMAND_TIMEOUT / ADDIN_DISCONNECTED / INTERNAL_ERROR.
  const dispatchArgs: DispatchArgs = {
    appId,
    capability: capabilityId,
    payload: dispatchPayload,
    ...(prevCommandId !== undefined ? { prevCommandId } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(dispatchTabContext !== undefined ? { tabContext: dispatchTabContext } : {}),
  };

  try {
    let result = await options.commandRouter.dispatch(dispatchArgs);

    if (!result.success && result.code === ErrorCode.INJECTION_REFUSED) {
      // Permission auto-replay: when the SW reports a grantable refusal
      // (no-host-permission + retryable), await a permission-granted event
      // from the extension SW and re-dispatch once if it arrives. The
      // agent's MCP tool call sees a single longer-running call; no agent
      // runtime hooks needed.
      const retried = await maybeRetryAfterPermissionGrant({
        req,
        res,
        result,
        dispatchArgs,
        options,
        appId,
        capabilityId,
      });
      if (retried) {
        result = retried;
      }
    }

    if (result.success) {
      sendJson(res, 200, {
        success: true,
        commandId: result.commandId,
        data: result.data,
      });
      return;
    }

    if (result.code === ErrorCode.INJECTION_REFUSED) {
      const details = (result.details ?? {}) as Record<string, unknown>;
      const rawOrigin = typeof details.origin === 'string' ? details.origin : undefined;
      const reason = typeof details.reason === 'string' ? details.reason : 'unknown';
      const redacted = rawOrigin ? redactOrigin(rawOrigin) : '<unknown-origin>';

      options.logger?.warn(
        { appId, capabilityId, reason, origin: redacted },
        'Permission gap detected on dispatch — forwarding INJECTION_REFUSED',
      );
      options.errorReporter?.addBreadcrumb({
        category: 'app-bridge.command',
        level: 'warning',
        message: 'injection-refused',
        data: { appId, capabilityId, reason, origin: redacted },
      });

      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.INJECTION_REFUSED,
          result.error,
          result.details,
        ),
      );
      return;
    }

    // The extension replied with a structured failure — forward it as a 502
    // Bad Gateway so callers can distinguish "bridge couldn't dispatch" from
    // "app executed the command and reported an error". Body is structured.
    sendJson(res, 502, {
      success: false,
      code: result.code ?? 'BAD_REQUEST',
      message: result.error,
      ...(result.details ? { details: result.details } : {}),
      commandId: result.commandId,
    });
  } catch (err) {
    if (isAppBridgeError(err)) {
      // The shared errors.ts already maps every code → status via
      // `toHttpStatus()`, so this renders APP_NOT_CONNECTED (503),
      // COMMAND_TIMEOUT (504), IDEMPOTENT_DROP (409), etc. consistently.
      applyErrorResponse(res, err);
      return;
    }

    options.logger?.error({ err, appId, capabilityId }, 'Relay dispatch unknown failure');
    options.errorReporter?.captureException(err, {
      area: 'app-bridge.relay',
      appId,
      capabilityId,
    });
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'Unexpected error while dispatching to the app.',
      ),
    );
  }
}
