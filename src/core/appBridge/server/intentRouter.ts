/**
 * intentRouter — `/intent/*` App→Rebel routes (Stage 2 + Stage 6c + Stage 7).
 *
 * Route surface:
 *   - `GET  /intent/health` → 200 `{ ok: true, protocolVersion: '1.0', port }`
 *     — public probe used by port discovery. Origin-gated like every other
 *     route, but returns 200 without a token.
 *   - `POST /intent/conversation/create` → dispatches to
 *     `options.handlers.createConversation` (Stage 7 wires
 *     `appBridgeIntentService`). When no handler is injected the router
 *     returns 501 with a structured payload so the extension-side UX
 *     degrades gracefully. The body is validated against
 *     `IntentConversationCreateSchema` so the handler receives a clean
 *     typed payload.
 *   - `POST /intent/conversation/:id/message` → dispatches to
 *     `options.handlers.injectMessage` (Stage 7). Validates against
 *     `IntentConversationMessageSchema`, forwards the captured `:id` to
 *     the handler as `conversationId`. Same 501 fallback when unset.
 *   - `GET  /intent/conversation/:id/state` → dispatches to
 *     `options.handlers.getConversationState` (Stage 7). No body; the
 *     handler receives just the captured `:id`.
 *   - `GET  /intent/conversation/:id/messages` → dispatches to
 *     `options.handlers.getMessages` (embedded chat — Stage 1 of
 *     `260421_embedded_chat_in_extension`). No body; the handler
 *     receives just the captured `:id` and returns the filtered
 *     transcript plus turn status.
 *
 * Every route passes through the injected `originGuard` first. Non-health
 * routes require one of the following:
 *   - A paired app token (`Authorization: Bearer <token>`) PLUS
 *     `X-Rebel-App-Id` and `X-Rebel-Client-Id` headers that match the
 *     token's claims (post-review A4). Optional `X-Rebel-Client-Fingerprint`
 *     must also match when the claim has one bound (post-review B4).
 *   - `REBEL_APP_BRIDGE_DEV=1` (for local dev / test only).
 *
 * The router-internal token is **explicitly rejected** here — it's scoped
 * to internal `/apps/*` relay only, per the D4/D13 scope split.
 *
 * Error translation rules (all handlers):
 *   - Handler throws `AppBridgeError` → router maps to its `.status` and
 *     serialises `{ success: false, code, message }`.
 *   - Handler throws anything else → Sentry `captureException`, then
 *     `500 INTERNAL_ERROR` so the client never sees raw stack traces.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import type { ErrorReporter } from '@core/errorReporter';
import { installEvent } from '../shared/installEvent';
import { isAppType, PROTOCOL_VERSION, type AppType } from '../shared/protocol';
import { ErrorCode, createAppBridgeError, type AppBridgeError } from '../shared/errors';
import {
  IntentConversationCreateSchema,
  IntentConversationMessageSchema,
  type IntentConversationCreate,
  type IntentConversationCreateResult,
  type IntentConversationFocusResult,
  type IntentConversationHistoryResult,
  type IntentConversationMessage,
  type IntentConversationMessageResult,
  type IntentConversationStateResult,
} from '../shared/intentProtocol';
import type { AppTokenClaims, TokenStore } from './tokenStore';
import {
  assertAllowedHost,
  assertAllowedOrigin,
  type OriginGuardOptions,
} from './originGuard';
import {
  applyErrorResponse,
  extractBearer,
  readJsonBody,
  sendJson,
  type RouterHandler,
} from './httpUtils';

export interface IntentHandlers {
  /**
   * Stage 7 wires this to `appBridgeIntentService.createConversation`. When
   * omitted, the router returns 501 and the extension shows a "not yet
   * available" state. Errors the handler throws as `AppBridgeError` surface
   * with their canonical HTTP status; unexpected throws are mapped to 500.
   */
  createConversation?: (
    req: IntentConversationCreate,
  ) => Promise<IntentConversationCreateResult>;
  /**
   * Stage 7 — injects a follow-up message into an existing conversation.
   * `conversationId` is the `:id` captured from the URL; `req` is the
   * Zod-parsed body. When omitted, the router returns 501.
   */
  injectMessage?: (
    conversationId: string,
    req: IntentConversationMessage,
  ) => Promise<IntentConversationMessageResult>;
  /**
   * Stage 7 — reads status for an existing conversation. `conversationId`
   * is the `:id` captured from the URL. No body. When omitted, the
   * router returns 501.
   */
  getConversationState?: (
    conversationId: string,
  ) => Promise<IntentConversationStateResult>;
  /**
   * Embedded chat (Stage 1 of `260421_embedded_chat_in_extension`) — reads
   * the filtered transcript for a conversation so the side panel can
   * hydrate. `conversationId` is the `:id` captured from the URL. No
   * body. When omitted, the router returns 501.
   */
  getMessages?: (
    conversationId: string,
  ) => Promise<IntentConversationHistoryResult>;
  /**
   * Embedded chat (Stage 2 of `260421_embedded_chat_in_extension`) — opens
   * a long-lived Server-Sent Events stream that fans out agent-turn
   * events for the conversation. The handler is responsible for
   * validating the conversation, writing SSE headers (only after
   * validation succeeds), attaching to the stream coordinator, and
   * tearing down on `req.on('close')`.
   *
   * The router runs the standard auth gate first (`assertGatedAccess`)
   * and computes a SHA-256 hex `hashedToken` from the bearer so the
   * service can plumb it into the coordinator for per-token revoke
   * broadcasts. When auth ran in dev-mode the `hashedToken` is an empty
   * string — safe because `closeAllForToken` ignores empty strings.
   *
   * The handler must throw `AppBridgeError` *before* writing the SSE
   * response head when a pre-stream failure is possible (e.g. unknown
   * conversation → 404), so the router can translate it to a JSON error.
   * Once the handler has committed to streaming, it owns the response
   * lifecycle and the router's catch is a no-op (it only `res.end()`s
   * when headers were already sent).
   *
   * When omitted, the router returns 501.
   */
  streamConversation?: (
    conversationId: string,
    req: IncomingMessage,
    res: ServerResponse,
    hashedToken: string,
  ) => Promise<void>;
  /**
   * Embedded chat (Stage 3 of `260421_embedded_chat_in_extension`) —
   * powers the side panel's "Open in Rebel" button. Validates the
   * conversation and broadcasts a focus-only event so the desktop
   * window navigates to it. No body. When omitted, the router
   * returns 501.
   */
  focusConversation?: (
    conversationId: string,
  ) => Promise<IntentConversationFocusResult>;
}

export interface IntentRouterOptions {
  tokenStore: TokenStore;
  handlers?: IntentHandlers;
  /** Port the bridge is bound to — surfaced in /intent/health. */
  getPort: () => number;
  /** Origin + Host guard settings shared with other routers. */
  originGuardOptions: OriginGuardOptions;
  /** Optional error reporter for Sentry breadcrumbs. */
  errorReporter?: ErrorReporter;
  /**
   * Optional pino logger. When provided, auth failures on intent routes
   * are emitted as `installEvent`s with stable `event` names in addition
   * to Sentry breadcrumbs.
   */
  logger?: Logger;
}

const HEALTH_PATH = '/intent/health';
/**
 * Identity string that lets the extension distinguish our bridge from any
 * other HTTP service that may happen to reply on the candidate port range.
 * See `packages/browser-extension/src/lib/port-discovery.ts` — the extension
 * only adopts a discovered port when this exact string appears on the wire.
 */
export const HEALTH_SERVICE_ID = 'rebel-app-bridge';
/**
 * Wire-contract version. Distinct from `PROTOCOL_VERSION` (which governs
 * WS message shapes) — this is a version specifically for the HTTP health
 * identity contract with port-discovery consumers. Bump only when the
 * health schema changes in a way that breaks existing consumers.
 */
export const HEALTH_SERVICE_VERSION = '1.0';
const CREATE_PATH = '/intent/conversation/create';
const MESSAGE_RE = /^\/intent\/conversation\/([^/]+)\/message$/;
const STATE_RE = /^\/intent\/conversation\/([^/]+)\/state$/;
const MESSAGES_RE = /^\/intent\/conversation\/([^/]+)\/messages$/;
const STREAM_RE = /^\/intent\/conversation\/([^/]+)\/stream$/;
const FOCUS_RE = /^\/intent\/conversation\/([^/]+)\/focus$/;

/** True when dev-mode access to gated routes is permitted. */
function isDevAccessAllowed(): boolean {
  return process.env['REBEL_APP_BRIDGE_DEV'] === '1';
}

/**
 * Extract a single header value (case-insensitive), trimmed. `undefined`
 * when absent or an array (we never accept multi-valued auth headers).
 */
function extractHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Result of the intent-route auth gate. Either a valid app-token with
 * bound claims, or a "skip-auth" marker for the REBEL_APP_BRIDGE_DEV=1
 * dev-mode path. Never returned for the router-internal token — per
 * D4/D13, the router-internal token is for `/apps/*` relay only.
 */
type IntentAuthOutcome =
  | { mode: 'app-token'; claims: AppTokenClaims }
  | { mode: 'dev-mode' };

/**
 * Validate auth for every gated /intent/* route.
 *
 * Post-review A4: previously accepted the router-internal token here,
 * which was the reverse of the D4/D13 plan. External apps should carry
 * their paired app token plus the `X-Rebel-App-Id` header (and optional
 * `X-Rebel-Client-Id` for multi-pair setups). The router-internal token
 * is scoped to internal `/apps/*` relay only.
 *
 * Per-request requirements:
 *   1. `Authorization: Bearer <app-pair-token>` — the 32-byte token
 *      issued at `/pair/claim` time.
 *   2. `X-Rebel-App-Id: <appId>` — must match `token.appId`.
 *   3. `X-Rebel-Client-Id: <clientId>` — must match `token.clientId`.
 *
 * When `REBEL_APP_BRIDGE_DEV=1`, we bypass the scope check so tests and
 * internal tooling can exercise the routes without paying the pairing cost.
 */
function assertGatedAccess(
  req: IncomingMessage,
  options: IntentRouterOptions,
): IntentAuthOutcome {
  if (isDevAccessAllowed()) {
    return { mode: 'dev-mode' };
  }
  const presented = extractBearer(req);
  if (!presented) {
    throw createAppBridgeError(
      ErrorCode.UNAUTHORIZED,
      'Missing Authorization: Bearer <app-pair-token> header.',
    );
  }
  // Reject any attempt to use the router-internal token on /intent/* —
  // D4/D13 scope split. Emit a breadcrumb so ops can spot an infra
  // regression (e.g. a caller wiring the wrong token class).
  const kind = options.tokenStore.classifyToken(presented);
  if (kind === 'router-internal') {
    options.errorReporter?.addBreadcrumb({
      category: 'app-bridge.security',
      level: 'warning',
      message: 'router-internal-token-rejected-on-intent-route',
      data: { reason: 'router-internal-token-presented-on-intent' },
    });
    if (options.logger) {
      installEvent(
        options.logger,
        'warn',
        'app-bridge.security.router-internal-token-rejected',
        { route: 'intent', reason: 'router-internal-token-presented-on-intent' },
      );
    }
    throw createAppBridgeError(
      ErrorCode.FORBIDDEN,
      'Router-internal token cannot be used on /intent/* routes.',
    );
  }
  if (kind !== 'pair') {
    throw createAppBridgeError(ErrorCode.UNAUTHORIZED, 'Token is not recognised.');
  }

  const rawAppId = extractHeader(req, 'x-rebel-app-id');
  if (!rawAppId || !isAppType(rawAppId)) {
    throw createAppBridgeError(
      ErrorCode.BAD_REQUEST,
      'Missing or invalid X-Rebel-App-Id header.',
    );
  }
  const appId: AppType = rawAppId;
  const clientId = extractHeader(req, 'x-rebel-client-id');
  if (!clientId) {
    throw createAppBridgeError(
      ErrorCode.BAD_REQUEST,
      'Missing X-Rebel-Client-Id header.',
    );
  }
  const fingerprint = extractHeader(req, 'x-rebel-client-fingerprint') ?? null;
  const claims = options.tokenStore.verifyAppToken(presented, {
    appId,
    clientId,
    fingerprint,
  });
  if (!claims) {
    options.errorReporter?.addBreadcrumb({
      category: 'app-bridge.security',
      level: 'warning',
      message: 'intent-auth-scope-mismatch',
      data: { appId },
    });
    if (options.logger) {
      installEvent(options.logger, 'warn', 'app-bridge.intent.auth.scope-mismatch', {
        appId,
      });
    }
    throw createAppBridgeError(
      ErrorCode.UNAUTHORIZED,
      'Token does not match the provided app / client / fingerprint.',
    );
  }
  return { mode: 'app-token', claims };
}

function shouldReturnLimitedHealthResponse(req: IncomingMessage): boolean {
  const origin = extractHeader(req, 'origin');
  return typeof origin === 'string'
    ? /^chrome-extension:\/\/[a-p]{32}(?:\/.*)?$/.test(origin)
    : false;
}

function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  options: IntentRouterOptions,
): void {
  // MV3 extension service workers probe this route to discover which
  // loopback port we bound (port-discovery in packages/browser-extension
  // scans a small range). Chromium strips the `Origin` header on a
  // same-origin / localhost `fetch()` issued with `credentials: 'omit'`
  // from a service worker, so we can never require Origin here — doing
  // so turns every install into "Couldn't find Rebel on this computer."
  //
  // Security model for this one route: the response when Origin is
  // missing MUST be the same limited identity payload we already ship
  // for an unknown extension ID (`{ ok, service }`). Port and
  // protocolVersion are still only returned when the Origin is an
  // allowlisted extension. Any *present* Origin continues to go through
  // the full guard, so a page at evil.com still gets 401.
  const origin = extractHeader(req, 'origin');
  if (origin === undefined) {
    sendJson(res, 200, {
      ok: true,
      service: HEALTH_SERVICE_ID,
    });
    return;
  }

  try {
    assertAllowedOrigin(req, {
      ...options.originGuardOptions,
      errorReporter: options.errorReporter,
    });

    sendJson(res, 200, {
      ok: true,
      service: HEALTH_SERVICE_ID,
      version: HEALTH_SERVICE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      port: options.getPort(),
    });
  } catch (err) {
    if (shouldReturnLimitedHealthResponse(req)) {
      sendJson(res, 200, {
        ok: true,
        service: HEALTH_SERVICE_ID,
      });
      return;
    }
    applyErrorResponse(res, err);
  }
}

/**
 * Build a router suitable for the bridge's request dispatch. Returns `true`
 * when it served the request, `false` when it did not recognise the path so
 * the caller can fall through to other routers.
 */
export function createIntentRouter(options: IntentRouterOptions): RouterHandler {
  return function intentRouter(req, res): boolean {
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.split('?')[0] ?? '/';
    if (!pathname.startsWith('/intent/')) {
      return false;
    }

    try {
      assertAllowedHost(req, options.getPort(), {
        errorReporter: options.errorReporter,
      });
    } catch (err) {
      applyErrorResponse(res, err);
      return true;
    }

    if (req.method === 'GET' && pathname === HEALTH_PATH) {
      handleHealth(req, res, options);
      return true;
    }

    try {
      // Chromium does NOT attach the Origin header on fetch() calls from
      // an extension context (sidepanel / popup / content script) to a
      // URL that the extension holds host_permissions for, especially for
      // simple GET requests (SSE stream open, /messages rehydrate). The
      // paired-app-token gate below is the real security boundary; Origin
      // is a second factor we only rely on when the browser attaches it.
      // Web pages at evil.com cannot suppress the Origin header on
      // cross-origin fetches, so allowing missing-Origin does not open a
      // new attack vector.
      assertAllowedOrigin(req, {
        ...options.originGuardOptions,
        allowMissingOrigin: true,
        errorReporter: options.errorReporter,
      });
    } catch (err) {
      applyErrorResponse(res, err);
      return true;
    }

    try {
      assertGatedAccess(req, options);
    } catch (err) {
      applyErrorResponse(res, err);
      return true;
    }

    if (req.method === 'POST' && pathname === CREATE_PATH) {
      // Async pipeline — kick it off and return true so the http.server's
      // sync dispatch loop considers the request handled.
      void handleCreateConversation(req, res, options).catch((err: unknown) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        options.errorReporter?.captureException(err, {
          area: 'app-bridge.intent',
          route: CREATE_PATH,
        });
        applyErrorResponse(res, err);
      });
      return true;
    }

    const messageMatch = MESSAGE_RE.exec(pathname);
    if (req.method === 'POST' && messageMatch) {
      const conversationId = decodeURIComponent(messageMatch[1] ?? '');
      void handleInjectMessage(req, res, options, conversationId).catch((err: unknown) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        options.errorReporter?.captureException(err, {
          area: 'app-bridge.intent',
          route: 'inject-message',
          conversationId,
        });
        applyErrorResponse(res, err);
      });
      return true;
    }

    const stateMatch = STATE_RE.exec(pathname);
    if (req.method === 'GET' && stateMatch) {
      const conversationId = decodeURIComponent(stateMatch[1] ?? '');
      void handleGetState(res, options, conversationId).catch((err: unknown) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        options.errorReporter?.captureException(err, {
          area: 'app-bridge.intent',
          route: 'get-state',
          conversationId,
        });
        applyErrorResponse(res, err);
      });
      return true;
    }

    const messagesMatch = MESSAGES_RE.exec(pathname);
    if (req.method === 'GET' && messagesMatch) {
      const conversationId = decodeURIComponent(messagesMatch[1] ?? '');
      void handleGetMessages(res, options, conversationId).catch((err: unknown) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        options.errorReporter?.captureException(err, {
          area: 'app-bridge.intent',
          route: 'get-messages',
          conversationId,
        });
        applyErrorResponse(res, err);
      });
      return true;
    }

    const focusMatch = FOCUS_RE.exec(pathname);
    if (req.method === 'POST' && focusMatch) {
      const conversationId = decodeURIComponent(focusMatch[1] ?? '');
      void handleFocusConversation(res, options, conversationId).catch((err: unknown) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        options.errorReporter?.captureException(err, {
          area: 'app-bridge.intent',
          route: 'focus',
          conversationId,
        });
        applyErrorResponse(res, err);
      });
      return true;
    }

    const streamMatch = STREAM_RE.exec(pathname);
    if (req.method === 'GET' && streamMatch) {
      const conversationId = decodeURIComponent(streamMatch[1] ?? '');
      // Pre-hash the bearer so the service can plumb it into the
      // coordinator. Empty when running in dev-mode (no bearer sent) —
      // coordinator.closeAllForToken ignores empty strings so this is
      // safe.
      const bearer = extractBearer(req);
      const hashedToken =
        bearer.length > 0 ? createHash('sha256').update(bearer, 'utf8').digest('hex') : '';
      void handleStreamConversation(req, res, options, conversationId, hashedToken).catch(
        (err: unknown) => {
          if (res.headersSent) {
            // We've already committed to streaming. Best we can do is
            // close the socket so the client sees the drop.
            try {
              res.end();
            } catch {
              // Socket may already be dead.
            }
            return;
          }
          options.errorReporter?.captureException(err, {
            area: 'app-bridge.intent',
            route: 'stream',
            conversationId,
          });
          applyErrorResponse(res, err);
        },
      );
      return true;
    }

    // Path starts with /intent/ but no handler matched — 404.
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.BAD_REQUEST,
        `Unknown intent route: ${req.method} ${pathname}`,
      ),
    );
    return true;
  };
}

/** Type guard for AppBridgeError — used when catching throws from handlers. */
function isAppBridgeError(value: unknown): value is AppBridgeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AppBridgeError).code === 'string' &&
    typeof (value as AppBridgeError).status === 'number' &&
    typeof (value as AppBridgeError).message === 'string'
  );
}

/**
 * Full request pipeline for `POST /intent/conversation/create`:
 *   1. Read + parse JSON body (`readJsonBody` handles size/shape guards).
 *   2. Validate against `IntentConversationCreateSchema`. Malformed → 400.
 *   3. If a handler is injected (Stage 7), call it and render the result.
 *   4. Otherwise return a structured 501 — the extension degrades gracefully.
 */
async function handleCreateConversation(
  req: IncomingMessage,
  res: ServerResponse,
  options: IntentRouterOptions,
): Promise<void> {
  let rawBody: Record<string, unknown>;
  try {
    rawBody = await readJsonBody(req);
  } catch (err) {
    applyErrorResponse(res, err);
    return;
  }

  const parsed = IntentConversationCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.BAD_REQUEST,
        `Malformed /intent/conversation/create payload: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      ),
    );
    return;
  }

  const handler = options.handlers?.createConversation;
  if (!handler) {
    // Stage 6c ships the client-side plumbing; Stage 7 provides the handler.
    // Emit a structured 501 so the extension can render a "Rebel can't do
    // this yet" hint rather than a mystery error.
    sendJson(res, 501, {
      success: false,
      code: 'NOT_IMPLEMENTED',
      message:
        'App Bridge create conversation not yet implemented (Stage 7). Client-side plumbing is complete.',
    });
    return;
  }

  try {
    const result = await handler(parsed.data);
    if (!result || typeof result.conversationId !== 'string' || result.conversationId.length === 0) {
      throw createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'createConversation handler returned an invalid result (missing conversationId).',
      );
    }
    sendJson(res, 200, {
      success: true,
      conversationId: result.conversationId,
      state: result.state ?? 'new',
    });
  } catch (err) {
    if (isAppBridgeError(err)) {
      applyErrorResponse(res, err);
      return;
    }
    options.errorReporter?.captureException(err, {
      area: 'app-bridge.intent',
      route: CREATE_PATH,
    });
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'createConversation handler threw an unexpected error.',
      ),
    );
  }
}

function sendNotImplemented(res: ServerResponse, operation: string): void {
  sendJson(res, 501, {
    success: false,
    code: 'NOT_IMPLEMENTED',
    message: `App Bridge ${operation} not yet implemented.`,
  });
}

/**
 * Full request pipeline for `POST /intent/conversation/:id/message` (Stage 7):
 *   1. Read + parse JSON body.
 *   2. Validate against `IntentConversationMessageSchema`. Malformed → 400.
 *   3. If a handler is injected, call it with the captured conversationId
 *      and the Zod-parsed body; render `{ success: true, ...result }`.
 *   4. Otherwise return 501 — the extension already handles this state.
 */
async function handleInjectMessage(
  req: IncomingMessage,
  res: ServerResponse,
  options: IntentRouterOptions,
  conversationId: string,
): Promise<void> {
  if (!conversationId) {
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.BAD_REQUEST,
        'Missing conversation id in /intent/conversation/:id/message.',
      ),
    );
    return;
  }

  let rawBody: Record<string, unknown>;
  try {
    rawBody = await readJsonBody(req);
  } catch (err) {
    applyErrorResponse(res, err);
    return;
  }

  const parsed = IntentConversationMessageSchema.safeParse(rawBody);
  if (!parsed.success) {
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.BAD_REQUEST,
        `Malformed /intent/conversation/:id/message payload: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      ),
    );
    return;
  }

  const handler = options.handlers?.injectMessage;
  if (!handler) {
    sendNotImplemented(res, 'inject message');
    return;
  }

  try {
    const result = await handler(conversationId, parsed.data);
    if (
      !result ||
      typeof result.messageId !== 'string' ||
      typeof result.state !== 'string'
    ) {
      throw createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'injectMessage handler returned an invalid result.',
      );
    }
    sendJson(res, 200, {
      success: true,
      conversationId: result.conversationId ?? conversationId,
      messageId: result.messageId,
      state: result.state,
      queueSize: result.queueSize,
    });
  } catch (err) {
    if (isAppBridgeError(err)) {
      applyErrorResponse(res, err);
      return;
    }
    options.errorReporter?.captureException(err, {
      area: 'app-bridge.intent',
      route: 'inject-message',
      conversationId,
    });
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'injectMessage handler threw an unexpected error.',
      ),
    );
  }
}

/**
 * Full request pipeline for `GET /intent/conversation/:id/messages`
 * (embedded chat — Stage 1 of `260421_embedded_chat_in_extension`).
 * No body; the handler receives the captured conversationId.
 *
 * The response includes `success: true` to stay consistent with the
 * router's envelope convention for gated routes. Handlers that throw
 * `AppBridgeError` surface with their canonical HTTP status (e.g. 404
 * when the conversation is unknown); unexpected throws are mapped to
 * 500 INTERNAL_ERROR and captured via the injected `errorReporter`.
 */
async function handleGetMessages(
  res: ServerResponse,
  options: IntentRouterOptions,
  conversationId: string,
): Promise<void> {
  if (!conversationId) {
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.BAD_REQUEST,
        'Missing conversation id in /intent/conversation/:id/messages.',
      ),
    );
    return;
  }

  const handler = options.handlers?.getMessages;
  if (!handler) {
    sendNotImplemented(res, 'read conversation messages');
    return;
  }

  try {
    const result = await handler(conversationId);
    if (
      !result ||
      typeof result.conversationId !== 'string' ||
      !Array.isArray(result.messages)
    ) {
      throw createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'getMessages handler returned an invalid result.',
      );
    }
    sendJson(res, 200, {
      success: true,
      conversationId: result.conversationId,
      messages: result.messages,
      turnStatus: result.turnStatus,
      ...(result.conversationTitle
        ? { conversationTitle: result.conversationTitle }
        : {}),
    });
  } catch (err) {
    if (isAppBridgeError(err)) {
      applyErrorResponse(res, err);
      return;
    }
    options.errorReporter?.captureException(err, {
      area: 'app-bridge.intent',
      route: 'get-messages',
      conversationId,
    });
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'getMessages handler threw an unexpected error.',
      ),
    );
  }
}

/**
 * Full request pipeline for `GET /intent/conversation/:id/stream`
 * (embedded chat — Stage 2 of `260421_embedded_chat_in_extension`).
 *
 * Delegates to the injected `streamConversation` handler which owns the
 * SSE lifecycle: validating the conversation, writing SSE headers,
 * attaching to the stream coordinator, and detaching on close. The
 * router only renders `AppBridgeError`s that are thrown *before* the
 * handler commits to streaming (e.g. 404 for unknown conversation).
 * Generic throws after headers are sent fall through to the caller's
 * catch, which closes the socket without re-emitting JSON.
 */
async function handleStreamConversation(
  req: IncomingMessage,
  res: ServerResponse,
  options: IntentRouterOptions,
  conversationId: string,
  hashedToken: string,
): Promise<void> {
  if (!conversationId) {
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.BAD_REQUEST,
        'Missing conversation id in /intent/conversation/:id/stream.',
      ),
    );
    return;
  }

  const handler = options.handlers?.streamConversation;
  if (!handler) {
    sendNotImplemented(res, 'stream conversation');
    return;
  }

  try {
    await handler(conversationId, req, res, hashedToken);
  } catch (err) {
    if (res.headersSent) {
      // The handler has already written the SSE head — we can't emit a
      // JSON error now. Close the socket and log.
      options.errorReporter?.captureException(err, {
        area: 'app-bridge.intent',
        route: 'stream',
        phase: 'post-headers',
        conversationId,
      });
      try {
        res.end();
      } catch {
        // Already dead.
      }
      return;
    }
    if (isAppBridgeError(err)) {
      applyErrorResponse(res, err);
      return;
    }
    options.errorReporter?.captureException(err, {
      area: 'app-bridge.intent',
      route: 'stream',
      conversationId,
    });
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'streamConversation handler threw an unexpected error.',
      ),
    );
  }
}

/**
 * Full request pipeline for `POST /intent/conversation/:id/focus`
 * (embedded chat — Stage 3 of `260421_embedded_chat_in_extension`).
 * No body; the handler receives the captured conversationId. Powers the
 * side panel's "Open in Rebel" button by asking the renderer to navigate
 * to (and focus) the existing conversation.
 *
 * Same auth/error envelope as the sibling `/messages` and `/state`
 * routes: `AppBridgeError` from the handler propagates with its
 * canonical HTTP status (e.g. 404 when the conversation is unknown);
 * unexpected throws are funnelled through Sentry into 500.
 */
async function handleFocusConversation(
  res: ServerResponse,
  options: IntentRouterOptions,
  conversationId: string,
): Promise<void> {
  if (!conversationId) {
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.BAD_REQUEST,
        'Missing conversation id in /intent/conversation/:id/focus.',
      ),
    );
    return;
  }

  const handler = options.handlers?.focusConversation;
  if (!handler) {
    sendNotImplemented(res, 'focus conversation');
    return;
  }

  try {
    const result = await handler(conversationId);
    if (!result || typeof result.conversationId !== 'string') {
      throw createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'focusConversation handler returned an invalid result.',
      );
    }
    sendJson(res, 200, {
      success: true,
      conversationId: result.conversationId,
      focused: result.focused,
    });
  } catch (err) {
    if (isAppBridgeError(err)) {
      applyErrorResponse(res, err);
      return;
    }
    options.errorReporter?.captureException(err, {
      area: 'app-bridge.intent',
      route: 'focus',
      conversationId,
    });
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'focusConversation handler threw an unexpected error.',
      ),
    );
  }
}

/**
 * Full request pipeline for `GET /intent/conversation/:id/state` (Stage 7).
 * No body; the handler receives the captured conversationId.
 */
async function handleGetState(
  res: ServerResponse,
  options: IntentRouterOptions,
  conversationId: string,
): Promise<void> {
  if (!conversationId) {
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.BAD_REQUEST,
        'Missing conversation id in /intent/conversation/:id/state.',
      ),
    );
    return;
  }

  const handler = options.handlers?.getConversationState;
  if (!handler) {
    sendNotImplemented(res, 'read conversation state');
    return;
  }

  try {
    const result = await handler(conversationId);
    if (!result || typeof result.conversationId !== 'string') {
      throw createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'getConversationState handler returned an invalid result.',
      );
    }
    sendJson(res, 200, {
      success: true,
      conversationId: result.conversationId,
      turnStatus: result.turnStatus,
      pendingMessages: result.pendingMessages,
      lastAssistantAt: result.lastAssistantAt,
    });
  } catch (err) {
    if (isAppBridgeError(err)) {
      applyErrorResponse(res, err);
      return;
    }
    options.errorReporter?.captureException(err, {
      area: 'app-bridge.intent',
      route: 'get-state',
      conversationId,
    });
    applyErrorResponse(
      res,
      createAppBridgeError(
        ErrorCode.INTERNAL_ERROR,
        'getConversationState handler threw an unexpected error.',
      ),
    );
  }
}
