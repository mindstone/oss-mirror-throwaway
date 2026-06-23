/**
 * Rebel App Bridge — unified ErrorCode enum and per-surface converters (R9 / D8).
 *
 * One enum, three conversion targets:
 *   - `toHttpStatus()` — HTTP status codes for /intent/* and /apps/*
 *   - `toMcpContent()` — brand-voice strings for MCP tool-call results
 *   - `toWsErrorMessage()` / `toWsCloseCode()` / `toWsCloseReason()` — WebSocket error frames & close codes
 *
 * This keeps every surface consistent: the same underlying failure produces a
 * coherent HTTP status, user-facing MCP text, and WS close code.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import type { ResponseErrorMessage } from './protocol';

// ---------------------------------------------------------------------------
// ErrorCode enum
// ---------------------------------------------------------------------------

/**
 * Canonical error codes for the bridge. String constant object + type alias so
 * callers can use `ErrorCode.APP_NOT_CONNECTED` without pulling in a TS `enum`.
 *
 * The type alias deliberately shadows the value via `typeof` — this is the
 * idiomatic zero-runtime-overhead enum pattern (matches the OSS Office
 * sidecar's `SIDECAR_ERROR_CODES`, now in
 * `@mindstone-engineering/mcp-server-office`'s `src/shared/office/errors.ts`).
 */
export const ErrorCode = {
  APP_NOT_CONNECTED: 'APP_NOT_CONNECTED',
  PAIRING_EXPIRED: 'PAIRING_EXPIRED',
  PAIRING_CONSUMED: 'PAIRING_CONSUMED',
  RATE_LIMITED: 'RATE_LIMITED',
  PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  BAD_REQUEST: 'BAD_REQUEST',
  /**
   * Stage 8 — preserved for Office sidecar wire-format compatibility. Semantically
   * equivalent to `BAD_REQUEST` (both map to HTTP 400); Office's HTTPS API emits
   * `INVALID_REQUEST` and the MCP / add-in consumers may branch on that string,
   * so we keep it distinct rather than silently collapse to `BAD_REQUEST`.
   */
  INVALID_REQUEST: 'INVALID_REQUEST',
  COMMAND_TIMEOUT: 'COMMAND_TIMEOUT',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  ADDIN_DISCONNECTED: 'ADDIN_DISCONNECTED',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  VERSION_TOO_OLD: 'VERSION_TOO_OLD',
  /**
   * Retry detected — the previous command eventually arrived (late response)
   * so the retry would be a duplicate. R19 / D22 idempotency guard.
   */
  IDEMPOTENT_DROP: 'IDEMPOTENT_DROP',
  /**
   * A live App Bridge in another process already owns the on-disk state file.
   * This is an EXPECTED startup precondition — a previous instance is still
   * alive, or a relaunch raced the old process's shutdown — and the bridge
   * correctly refuses to clobber the live owner (see `writeStateFileAtomically`).
   * Kept distinct from `INTERNAL_ERROR` so this expected ownership conflict is
   * not reported to Sentry as an unexpected 500 (REBEL-5EB). Startup-internal:
   * thrown before the server is serving, so it is never sent to a connected
   * client over the wire.
   */
  BRIDGE_ALREADY_RUNNING: 'BRIDGE_ALREADY_RUNNING',
  /**
   * The requested capability is not advertised by the connected app (or is
   * unknown to the bridge). Stage 4's `/apps/*` relay uses this when a tool
   * is called for an action that the extension never registered.
   */
  CAPABILITY_NOT_SUPPORTED: 'CAPABILITY_NOT_SUPPORTED',
  /**
   * The browser extension is connected, but the browser refused to run
   * content-script execution on the current page (no host permission, denied
   * prompt, unsupported page, policy block, transient browser failure).
   */
  INJECTION_REFUSED: 'INJECTION_REFUSED',
  /**
   * The target surface exists but the browser refuses code injection there
   * (chrome://, extension pages, native PDFs, ...). Distinct from capability
   * absence so user copy can explain "this page can't be automated".
   */
  UNSUPPORTED_SURFACE: 'UNSUPPORTED_SURFACE',
  /**
   * Wrong HTTP verb on an otherwise-valid route (e.g. GET /apps/browser-
   * extension/read_page). Reported by the relay router so MCP clients get a
   * 405 instead of a misleading 400.
   */
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  /**
   * The browser tab a command targeted has closed, navigated, or otherwise
   * disappeared between the moment the agent approved the command and the
   * moment the extension tried to execute it. R18 / D21: the bridge never
   * silently retargets a new tab — closing one tab and opening another must
   * surface as a distinct failure so the user can re-confirm the intent.
   */
  TAB_CONTEXT_GONE: 'TAB_CONTEXT_GONE',
  /**
   * The originally-approved tab still exists, but its location changed
   * (origin+pathname mismatch) before execution. Caller must re-check.
   */
  TAB_CONTEXT_DIVERGED: 'TAB_CONTEXT_DIVERGED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

export interface AppBridgeError {
  code: ErrorCode;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

/** Default user-facing-ish messages; surfaces override via their own converter. */
export const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  APP_NOT_CONNECTED: 'App is not connected.',
  PAIRING_EXPIRED: 'Pairing code expired.',
  PAIRING_CONSUMED: 'Pairing code already used.',
  RATE_LIMITED: 'Too many attempts. Slow down.',
  PROTOCOL_VERSION_MISMATCH: 'Protocol version mismatch.',
  UNAUTHORIZED: 'Unauthorized.',
  FORBIDDEN: 'Forbidden.',
  BAD_REQUEST: 'Bad request.',
  INVALID_REQUEST: 'Invalid request.',
  COMMAND_TIMEOUT: 'The operation timed out.',
  NOT_IMPLEMENTED: 'Not implemented.',
  INTERNAL_ERROR: 'Internal error.',
  ADDIN_DISCONNECTED: 'Add-in disconnected while executing the command.',
  INVALID_MESSAGE: 'Invalid message.',
  VERSION_TOO_OLD: 'Client version is too old.',
  IDEMPOTENT_DROP:
    'Retry dropped — the original command already completed after a late response.',
  BRIDGE_ALREADY_RUNNING: 'Another Rebel App Bridge is already running.',
  CAPABILITY_NOT_SUPPORTED:
    'The connected app does not advertise that capability.',
  INJECTION_REFUSED:
    "Rebel couldn't get browser access for that page. Open the Rebel browser extension, allow access, then ask me again.",
  UNSUPPORTED_SURFACE:
    'This browser surface does not allow Rebel to run that action.',
  METHOD_NOT_ALLOWED: 'HTTP method not allowed on this route.',
  TAB_CONTEXT_GONE:
    'The browser tab this command targeted has closed or navigated before it could run.',
  TAB_CONTEXT_DIVERGED:
    'The page changed before this browser action could run.',
};

export function createAppBridgeError(
  code: ErrorCode,
  message?: string,
  details?: Record<string, unknown>,
): AppBridgeError {
  return {
    code,
    message: message ?? DEFAULT_MESSAGES[code],
    status: toHttpStatus(code),
    ...(details ? { details } : {}),
  };
}

/**
 * True iff `value` is the expected "another live App Bridge already owns the
 * state file" ownership conflict (REBEL-5EB). Callers use this to log-and-rethrow
 * without reporting an unexpected error to Sentry — the bridge intentionally
 * refuses to clobber a live owner, so this is a handled precondition, not a defect.
 */
export function isBridgeAlreadyRunningError(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { code?: unknown }).code === ErrorCode.BRIDGE_ALREADY_RUNNING
  );
}

// ---------------------------------------------------------------------------
// HTTP status converter
// ---------------------------------------------------------------------------

export function toHttpStatus(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'INJECTION_REFUSED':
      return 403;
    case 'RATE_LIMITED':
      return 429;
    case 'BAD_REQUEST':
    case 'INVALID_REQUEST':
      return 400;
    case 'NOT_IMPLEMENTED':
      return 501;
    case 'APP_NOT_CONNECTED':
    case 'ADDIN_DISCONNECTED':
      return 503;
    case 'PAIRING_EXPIRED':
    case 'PAIRING_CONSUMED':
      return 410;
    case 'COMMAND_TIMEOUT':
      return 504;
    case 'PROTOCOL_VERSION_MISMATCH':
    case 'VERSION_TOO_OLD':
      return 426;
    case 'INVALID_MESSAGE':
      return 400;
    case 'BRIDGE_ALREADY_RUNNING':
    case 'IDEMPOTENT_DROP':
      // 409 Conflict — the retry conflicts with the already-completed original,
      // or another live process already owns the App Bridge state file.
      return 409;
    case 'CAPABILITY_NOT_SUPPORTED':
      return 404;
    case 'UNSUPPORTED_SURFACE':
      return 410;
    case 'METHOD_NOT_ALLOWED':
      return 405;
    case 'TAB_CONTEXT_GONE':
    case 'TAB_CONTEXT_DIVERGED':
      // 410 Gone — the resource (tab) used to exist but is gone. The caller
      // cannot retry safely without re-checking the tab.
      return 410;
    case 'INTERNAL_ERROR':
      return 500;
  }
}

// ---------------------------------------------------------------------------
// MCP content converter
// ---------------------------------------------------------------------------

/**
 * Build an MCP tool-call error result for a given ErrorCode.
 *
 * Voice is Rebel-style: dry, calm, useful. Copy favours clear-over-clever
 * and never shames the user. Labels (`appLabel`) flow through so the same
 * code can say "Browser extension isn't connected" or "Word isn't connected".
 */
export function toMcpContent(
  code: ErrorCode,
  appLabelOrDetails?: string | Record<string, unknown>,
  maybeDetails?: Record<string, unknown>,
): { isError: true; content: [{ type: 'text'; text: string }] } {
  const appLabel =
    typeof appLabelOrDetails === 'string' ? appLabelOrDetails : undefined;
  const details =
    typeof appLabelOrDetails === 'string' ? maybeDetails : appLabelOrDetails;
  const text = buildMcpText(code, appLabel, details);
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

type InjectionRefusedReason =
  | 'no-host-permission'
  | 'denied-by-user'
  | 'unsupported-scheme'
  | 'chrome-blocked'
  | 'request-failed'
  | 'transient';

function parseInjectionRefusedReason(
  details?: Record<string, unknown>,
): InjectionRefusedReason | null {
  const reason = details?.['reason'];
  if (typeof reason !== 'string') {
    return null;
  }
  switch (reason) {
    case 'no-host-permission':
    case 'denied-by-user':
    case 'unsupported-scheme':
    case 'chrome-blocked':
    case 'request-failed':
    case 'transient':
      return reason;
    default:
      return null;
  }
}

function getDisplayOrigin(details?: Record<string, unknown>): string {
  const displayOrigin = details?.['displayOrigin'];
  if (typeof displayOrigin === 'string' && displayOrigin.trim().length > 0) {
    return displayOrigin.trim();
  }

  const origin = details?.['origin'];
  if (typeof origin !== 'string' || origin.trim().length === 0) {
    return 'this page';
  }

  const trimmedOrigin = origin.trim();
  try {
    const parsed = new URL(trimmedOrigin);
    if (parsed.protocol === 'https:') {
      return parsed.host;
    }
    if (parsed.protocol === 'http:') {
      return `${parsed.host} (http)`;
    }
    return parsed.origin;
  } catch {
    return trimmedOrigin;
  }
}

function buildMcpText(
  code: ErrorCode,
  appLabel?: string,
  details?: Record<string, unknown>,
): string {
  const label = appLabel ?? 'The app';
  switch (code) {
    case 'APP_NOT_CONNECTED':
      if (appLabel === 'Browser extension') {
        return `Browser extension isn't connected. Pair it in Settings → Connectors → Rebel App Bridge, then open the tab you want me to see.`;
      }
      return `${label} isn't connected. Pair it in Settings → Connectors, then try again.`;
    case 'ADDIN_DISCONNECTED':
      return `${label} disconnected mid-task. Reopen it and I'll try again.`;
    case 'PAIRING_EXPIRED':
      return `That pairing code expired. Ask for a fresh one in Settings → Connectors.`;
    case 'PAIRING_CONSUMED':
      return `That pairing code has already been used. Generate a new one in Settings → Connectors.`;
    case 'RATE_LIMITED':
      return `Too many attempts in a row. Give it a moment, then try again.`;
    case 'PROTOCOL_VERSION_MISMATCH':
      return `${label} is speaking a protocol I don't understand yet. Update the extension or the desktop app, then reconnect.`;
    case 'VERSION_TOO_OLD':
      return `${label} is an older version that I can't talk to. Update it, then reconnect.`;
    case 'UNAUTHORIZED':
      return `I couldn't authorise that request. Re-pair the app in Settings → Connectors.`;
    case 'FORBIDDEN':
      return `That request isn't allowed from this surface.`;
    case 'BAD_REQUEST':
    case 'INVALID_REQUEST':
      return `Something about that request didn't look right. Please try again.`;
    case 'COMMAND_TIMEOUT':
      return `That took longer than I'll wait. The app may be busy — try a smaller scope or try again.`;
    case 'NOT_IMPLEMENTED':
      return `That capability isn't wired up yet.`;
    case 'INVALID_MESSAGE':
      return `${label} sent a message I couldn't parse. This is usually a version mismatch — try reconnecting.`;
    case 'IDEMPOTENT_DROP':
      return `That retry was a duplicate — the original action already completed.`;
    case 'BRIDGE_ALREADY_RUNNING':
      // Startup-internal; not normally surfaced as MCP text, but cased for exhaustiveness.
      return `Another Rebel App Bridge is already running. This is usually transient during a restart — try again in a moment.`;
    case 'CAPABILITY_NOT_SUPPORTED':
      return `${label} doesn't support that action right now. Update or reconnect it, then try again.`;
    case 'INJECTION_REFUSED': {
      const displayOrigin = getDisplayOrigin(details);
      const reason = parseInjectionRefusedReason(details);
      switch (reason) {
        case 'no-host-permission':
          return `Rebel doesn't have permission to act on ${displayOrigin} yet — open the Rebel browser extension and tap Allow, then ask me again.`;
        case 'denied-by-user':
          return `Rebel doesn't have access to ${displayOrigin} right now. If you'd like to enable it, you can turn on site access in your browser's extension settings.`;
        case 'unsupported-scheme':
          return `${displayOrigin} isn't a page I can act on (it's a special browser surface). Open a normal web page and try again.`;
        case 'chrome-blocked':
          return `The browser refused to let me run on ${displayOrigin}. This page may be restricted by browser policy.`;
        case 'request-failed':
        case 'transient':
          return `I tried to ask for access to ${displayOrigin} but the browser rejected the request. If you're on a managed device, check with your admin; otherwise try reloading the extension.`;
        case null:
        default:
          // All known reasons are cased above (switch-exhaustiveness-check, now
          // `error`, flags any new InjectionRefusedReason member here). The default
          // gracefully falls back rather than throwing — no `assertNever` so this
          // file stays free of the @shared import (it's cross-compiled by
          // packages/shared, which has no @shared path alias).
          return DEFAULT_MESSAGES.INJECTION_REFUSED;
      }
    }
    case 'UNSUPPORTED_SURFACE':
      return `That page doesn't allow browser automation. Open a normal web page and try again.`;
    case 'METHOD_NOT_ALLOWED':
      return `That request used the wrong HTTP method. This is an internal bug — please report it.`;
    case 'TAB_CONTEXT_GONE':
      return `The browser tab this tool targeted has closed or navigated. Ask me to re-check the tab and try again.`;
    case 'TAB_CONTEXT_DIVERGED':
      return `The page changed before I could act. Ask me to re-check the tab and try again.`;
    case 'INTERNAL_ERROR':
      return `Something went wrong on my end. Try again; if it keeps happening, let the Rebel team know.`;
  }
}

// ---------------------------------------------------------------------------
// WebSocket converters
// ---------------------------------------------------------------------------

export function toWsErrorMessage(
  code: ErrorCode,
  message?: string,
  details?: Record<string, unknown>,
): ResponseErrorMessage {
  return {
    type: 'response',
    // Non-correlated errors (e.g. auth failures) use an empty id sentinel;
    // per-command error responses land through CommandRouter with the real id.
    id: '',
    success: false,
    error: message ?? DEFAULT_MESSAGES[code],
    code,
    ...(details ? { details } : {}),
  };
}

/**
 * WebSocket close code for a given error code.
 *
 * 4000–4999 is the application-defined range. Reserved mappings:
 *   4001 UNAUTHORIZED
 *   4002 INVALID_MESSAGE
 *   4010 PROTOCOL_VERSION_MISMATCH
 *   4020 VERSION_TOO_OLD
 *   1011 INTERNAL_ERROR (standard "server error")
 *   1000 normal closure (not reached via this map, but kept as default)
 */
export function toWsCloseCode(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 4001;
    case 'INVALID_MESSAGE':
      return 4002;
    case 'PROTOCOL_VERSION_MISMATCH':
      return 4010;
    case 'VERSION_TOO_OLD':
      return 4020;
    case 'INTERNAL_ERROR':
      return 1011;
    case 'APP_NOT_CONNECTED':
    case 'PAIRING_EXPIRED':
    case 'PAIRING_CONSUMED':
    case 'RATE_LIMITED':
    case 'FORBIDDEN':
    case 'BAD_REQUEST':
    case 'INVALID_REQUEST':
    case 'COMMAND_TIMEOUT':
    case 'NOT_IMPLEMENTED':
    case 'ADDIN_DISCONNECTED':
    case 'IDEMPOTENT_DROP':
    // BRIDGE_ALREADY_RUNNING is startup-internal and never reaches a WS close, but
    // it is listed explicitly (rather than left to `default`) to stay consistent
    // with the other per-code mappers and keep this switch genuinely exhaustive.
    case 'BRIDGE_ALREADY_RUNNING':
    case 'CAPABILITY_NOT_SUPPORTED':
    case 'INJECTION_REFUSED':
    case 'UNSUPPORTED_SURFACE':
    case 'METHOD_NOT_ALLOWED':
    case 'TAB_CONTEXT_GONE':
    case 'TAB_CONTEXT_DIVERGED':
    default:
      // All ErrorCodes are cased above (switch-exhaustiveness-check, now `error`,
      // flags any new member here). The default gracefully returns the normal
      // close code rather than throwing — no `assertNever` (this file is
      // cross-compiled by packages/shared, which has no @shared path alias).
      return 1000;
  }
}

/**
 * Short, human-readable WS close reason. RFC 6455 caps the reason at 123 bytes;
 * keep every string well under that so we never truncate a UTF-8 sequence.
 */
export function toWsCloseReason(code: ErrorCode): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'unauthorized';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'INVALID_MESSAGE':
      return 'invalid message';
    case 'PROTOCOL_VERSION_MISMATCH':
      return 'protocol version mismatch';
    case 'VERSION_TOO_OLD':
      return 'client version too old';
    case 'APP_NOT_CONNECTED':
      return 'app not connected';
    case 'ADDIN_DISCONNECTED':
      return 'app disconnected';
    case 'PAIRING_EXPIRED':
      return 'pairing expired';
    case 'PAIRING_CONSUMED':
      return 'pairing consumed';
    case 'RATE_LIMITED':
      return 'rate limited';
    case 'BAD_REQUEST':
      return 'bad request';
    case 'INVALID_REQUEST':
      return 'invalid request';
    case 'COMMAND_TIMEOUT':
      return 'command timeout';
    case 'NOT_IMPLEMENTED':
      return 'not implemented';
    case 'IDEMPOTENT_DROP':
      return 'idempotent drop';
    case 'BRIDGE_ALREADY_RUNNING':
      return 'bridge already running';
    case 'CAPABILITY_NOT_SUPPORTED':
      return 'capability not supported';
    case 'INJECTION_REFUSED':
      return 'injection refused';
    case 'UNSUPPORTED_SURFACE':
      return 'unsupported surface';
    case 'METHOD_NOT_ALLOWED':
      return 'method not allowed';
    case 'TAB_CONTEXT_GONE':
      return 'tab context gone';
    case 'TAB_CONTEXT_DIVERGED':
      return 'tab context diverged';
    case 'INTERNAL_ERROR':
      return 'internal error';
  }
}
