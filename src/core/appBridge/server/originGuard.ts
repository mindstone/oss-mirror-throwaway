/**
 * originGuard — Origin + Host header enforcement (Stage 2).
 *
 * Every bridge route funnels through two checks before any token gate:
 *
 *   1. `assertAllowedOrigin(req, { chromeExtensionIds, devMode, errorReporter })`
 *      — Origin header must be either `chrome-extension://<id>` or
 *      `moz-extension://<id>` for an extension ID in the allowlist, or the
 *      literal `null` when the caller explicitly opts in (reserved for the
 *      Office sidecar's co-located task-pane HTML later on).
 *
 *   2. `assertAllowedHost(req, port)` — Host header must be `127.0.0.1:<port>`
 *      or `localhost:<port>`. Defends against DNS-rebinding where a remote
 *      webpage tricks the browser into POSTing to the bridge's loopback
 *      address via a DNS name that resolves to `127.0.0.1`.
 *
 * Both helpers throw `AppBridgeError(UNAUTHORIZED)` on failure and emit a
 * Sentry breadcrumb via the injected `ErrorReporter` so origin rejections
 * are observable without leaking sensitive headers.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Logger } from 'pino';
import type { ErrorReporter } from '@core/errorReporter';
import { createAppBridgeError, ErrorCode } from '../shared/errors';
import { installEvent } from '../shared/installEvent';

/**
 * Environment flag that loads dev extension IDs from disk so unpacked dev
 * extensions can pair during Stage 6a. Production builds stay closed.
 */
const DEV_MODE_ENV = 'REBEL_APP_BRIDGE_DEV';

/** Filename under `<stateDirectory>` holding extra dev extension IDs. */
export const DEV_EXTENSION_IDS_FILE = 'dev-extension-ids.json';
const MAX_TRUSTED_EXTENSION_IDS = 50;

/**
 * Stage 10-preview — Trust-On-First-Use (TOFU) origin approval callback.
 *
 * When `previewMode` is true, an unknown but well-formed
 * `chrome-extension://[a-p]{32}` origin will trigger this callback before
 * the origin guard rejects. If the callback resolves `true`, the extension
 * ID is persisted to `<stateDirectory>/dev-extension-ids.json` so future
 * requests from the same extension succeed without re-prompting.
 *
 * In production (`previewMode: false`), TOFU is completely disabled — the
 * origin guard behaves exactly as before, strictly gating on the compiled
 * allowlist + env overrides.
 *
 * @param extensionId — the raw 32-char extension ID the caller presented
 * @returns true to approve & persist, false to reject with 401
 */
export type OnUnknownExtensionOrigin = (extensionId: string) => Promise<boolean>;
export type AllowedOriginSource = 'allowlist' | 'tofu';
export interface AllowedOriginResult {
  source: AllowedOriginSource;
  degraded: boolean;
}

export interface OriginGuardOptions {
  /** Allowed chrome-extension:// extension IDs (production). */
  chromeExtensionIds?: readonly string[];
  /**
   * Allowed moz-extension:// extension IDs. Stage 2 accepts these for
   * parity — the real Firefox rollout is Stage 10+ / future work.
   */
  mozExtensionIds?: readonly string[];
  /**
   * If true, `userData/mcp/rebel-app-bridge/dev-extension-ids.json` augments
   * the allowlist. Ignored unless `REBEL_APP_BRIDGE_DEV=1` is set.
   */
  devMode?: boolean;
  /** Directory containing the dev-extension-ids.json file when `devMode` is true. */
  stateDirectory?: string;
  /**
   * Permit the literal string `null` as an Origin. Reserved for the Office
   * sidecar's co-located HTML pages (Stage 8). Default: false.
   */
  allowNullOrigin?: boolean;
  /**
   * Permit requests that arrive with NO Origin header at all. Required for
   * /intent/* GET routes consumed by MV3 extension contexts (sidepanel,
   * content-script-triggered SSE): Chromium does NOT attach the Origin
   * header on fetch() calls from an extension to a URL that the extension
   * holds host_permissions for (simple / same-origin-privileged fetches),
   * so rejecting missing-Origin would break `getHistory` and
   * `connectStream` even though the follow-up `assertGatedAccess` still
   * requires a valid paired app token. The app-token gate is the real
   * security boundary; Origin is a second factor that can only be relied
   * upon when the browser attaches it. Default: false.
   */
  allowMissingOrigin?: boolean;
  /**
   * Optional Sentry breadcrumb sink. Injected via the bridge's options so
   * tests can capture origin-reject events.
   */
  errorReporter?: ErrorReporter;
  /**
   * Stage 10-preview — Trust-On-First-Use approval callback. When set
   * (i.e. the host is running in preview mode), unknown chrome-extension
   * origins of a valid 32-char `[a-p]` shape will trigger the callback.
   * If it resolves true, the extension ID is persisted to
   * `<stateDirectory>/dev-extension-ids.json` and the request proceeds.
   * Otherwise the request is rejected exactly as before.
   *
   * Leave undefined in production so the origin guard stays strict.
   */
  onUnknownExtensionOrigin?: OnUnknownExtensionOrigin;
  /**
   * Stage 10-preview — toggles TOFU on. Must be explicitly set by the
   * host (`AppBridgeManager` with `previewMode: true`). Decoupled from
   * `devMode` so the distinction is observable in code review: `devMode`
   * loads a pre-existing trust file; `previewMode` *extends* it at
   * runtime through user approval.
   */
  previewMode?: boolean;
  /**
   * Async-only: when false, a TOFU-approved origin is allowed for the
   * current request but is NOT persisted to disk.
   *
   * Default: true.
   */
  persistOnApproval?: boolean;
  /**
   * Async-only: invoked when a TOFU approval succeeds in-memory but the
   * trust-file persistence step fails.
   */
  onTrustPersistenceFailure?: (details: {
    extensionId: string;
    stateDirectory: string;
  }) => void;
  /**
   * Async-only: invoked when a TOFU-approved origin was newly persisted to
   * disk. Used by the host to track which dev extension ids were learned
   * during a specific install session.
   */
  onPersistedExtensionId?: (extensionId: string) => void;
  /**
   * Optional pino logger for structured install-flow events. When
   * provided, origin-guard rejects are emitted as `installEvent`s with
   * redacted payloads (extensionIdSuffix only) so install-flow
   * diagnostics land in the log file and not just Sentry. The existing
   * `errorReporter` breadcrumb channel is preserved in parallel.
   */
  logger?: Logger;
}

/**
 * Append an extension ID to `<stateDirectory>/dev-extension-ids.json` in
 * an idempotent, crash-safe way. Reads the file (best-effort), dedupes,
 * and writes with mode 0o600 so only the user who owns `userData` can
 * read it.
 *
 * Best-effort: any IO error is reported via the error reporter and the
 * function resolves without throwing. TOFU approval is a preview feature,
 * not a security boundary — a disk failure here should not crash the
 * bridge or cascade into pair/claim errors.
 */
export function persistTrustedExtensionId(
  stateDirectory: string,
  extensionId: string,
  errorReporter: ErrorReporter | undefined,
): { added: boolean; alreadyPresent: boolean } {
  try {
    mkdirSync(stateDirectory, { recursive: true });
  } catch (err) {
    errorReporter?.addBreadcrumb({
      category: 'app-bridge.origin-guard',
      level: 'warning',
      message: 'tofu-persist-mkdir-failed',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
    return { added: false, alreadyPresent: false };
  }
  const filePath = path.join(stateDirectory, DEV_EXTENSION_IDS_FILE);
  const existing = loadDevExtensionIds(stateDirectory);
  if (existing.includes(extensionId)) {
    return { added: false, alreadyPresent: true };
  }
  const next = [...existing, extensionId].slice(-MAX_TRUSTED_EXTENSION_IDS);
  try {
    writeFileSync(filePath, JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return { added: true, alreadyPresent: false };
  } catch (err) {
    errorReporter?.addBreadcrumb({
      category: 'app-bridge.install',
      level: 'warning',
      message: 'install.trust-persist-failed',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
    return { added: false, alreadyPresent: false };
  }
}

export function forgetTrustedExtensionIds(
  stateDirectory: string,
  extensionIds: readonly string[],
  errorReporter: ErrorReporter | undefined,
): { removed: number; degraded: boolean } {
  if (!stateDirectory || extensionIds.length === 0) {
    return { removed: 0, degraded: false };
  }

  const idsToForget = new Set(
    extensionIds.filter((id) => typeof id === 'string' && id.length > 0),
  );
  if (idsToForget.size === 0) {
    return { removed: 0, degraded: false };
  }

  try {
    mkdirSync(stateDirectory, { recursive: true });
  } catch (err) {
    errorReporter?.addBreadcrumb({
      category: 'app-bridge.origin-guard',
      level: 'warning',
      message: 'tofu-forget-mkdir-failed',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
    return { removed: 0, degraded: true };
  }

  const filePath = path.join(stateDirectory, DEV_EXTENSION_IDS_FILE);
  const existing = loadDevExtensionIds(stateDirectory);
  const next = existing.filter((id) => !idsToForget.has(id));
  const removed = existing.length - next.length;
  if (removed === 0) {
    return { removed: 0, degraded: false };
  }

  try {
    writeFileSync(filePath, JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return { removed, degraded: false };
  } catch (err) {
    errorReporter?.addBreadcrumb({
      category: 'app-bridge.origin-guard',
      level: 'warning',
      message: 'tofu-forget-write-failed',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
    return { removed: 0, degraded: true };
  }
}

export const CHROME_EXTENSION_ID_REGEX = /^[a-p]{32}$/;

/**
 * Canonical regex for a well-formed `chrome-extension://[a-p]{32}` origin.
 * Exported so other modules (notably `pairRoutes.ts`) don't copy-paste the
 * same pattern and drift out of sync with this file's semantics.
 *
 * Capture group 1 is the 32-char extension ID. moz-extension, null,
 * wrong-scheme, and malformed IDs are intentionally excluded — callers
 * that want to accept those must fall back to the full
 * `chrome-extension|moz-extension` regex defined inside `assertAllowedOrigin`.
 */
export const CHROME_EXTENSION_ORIGIN_REGEX = /^chrome-extension:\/\/([a-p]{32})$/;

/** Runtime check for a valid Chrome extension ID (32 chars, a–p). */
function isValidExtensionId(id: string): boolean {
  return CHROME_EXTENSION_ID_REGEX.test(id);
}

/**
 * Load extra dev extension IDs from disk. Best-effort: parse errors and
 * missing files resolve to an empty array so the dev path never throws.
 */
function loadDevExtensionIds(stateDirectory: string | undefined): string[] {
  if (!stateDirectory) {
    return [];
  }
  try {
    const filePath = path.join(stateDirectory, DEV_EXTENSION_IDS_FILE);
    const raw = readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (v): v is string => typeof v === 'string' && CHROME_EXTENSION_ID_REGEX.test(v),
    );
  } catch {
    return [];
  }
}

function extractHeader(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }
  if (typeof raw === 'string') {
    return raw;
  }
  return null;
}

/**
 * Sanitize breadcrumb/log data before emission. Prevents raw
 * `chrome-extension://abc...` origins and opaque `host` headers from
 * leaking into Sentry or the log file. Only the last 4 chars of an
 * extension ID are preserved as `extensionIdSuffix`.
 */
function redactOriginGuardData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  if (typeof out.origin === 'string') {
    const m = /^(chrome-extension|moz-extension):\/\/([a-zA-Z0-9]{32})(?:\/.*)?$/.exec(out.origin);
    if (m) {
      // Keep scheme for forensic value, hash-suffix the extension ID.
      out.originScheme = m[1];
      out.extensionIdSuffix = m[2].slice(-4);
    }
    delete out.origin;
  }
  // Host headers are typically `127.0.0.1:<port>` or `localhost:<port>`
  // — not sensitive — but a rebinding attack may include an arbitrary
  // hostname. Safer to always sanitize to the loopback/port pair vs raw.
  if (typeof out.host === 'string') {
    const hostMatch = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(out.host);
    if (hostMatch) {
      out.hostFamily = 'loopback';
      out.hostPort = hostMatch[2];
    } else {
      out.hostFamily = 'other';
    }
    delete out.host;
  }
  return out;
}

function reject(
  code: ErrorCode,
  message: string,
  errorReporter: ErrorReporter | undefined,
  breadcrumbData: Record<string, unknown>,
  logger?: Logger,
): never {
  const sanitized = redactOriginGuardData(breadcrumbData);
  errorReporter?.addBreadcrumb({
    category: 'app-bridge.origin-guard',
    level: 'warning',
    message,
    data: sanitized,
  });
  if (logger) {
    installEvent(logger, 'warn', 'app-bridge.origin-guard.reject', {
      message,
      ...sanitized,
    });
  }
  throw createAppBridgeError(code, message);
}

/**
 * Stage 10-preview — async variant of `assertAllowedOrigin` that supports
 * Trust-On-First-Use approval. When `options.previewMode` is true and the
 * origin is a well-formed chrome-extension URL that isn't already in the
 * allowlist, this function calls `options.onUnknownExtensionOrigin` to
 * ask the host whether to trust the new ID. On approval the ID is
 * persisted to `dev-extension-ids.json` and the caller returns normally;
 * on rejection we throw `AppBridgeError(UNAUTHORIZED)` as before.
 *
 * Keep the synchronous `assertAllowedOrigin` as-is so existing sync
 * code paths (e.g. pre-Stage-10 tests, routes that run inside a single
 * tick) don't have to become async. Callers who want TOFU (the /pair/claim
 * route in preview mode) use this async form instead.
 */
export async function assertAllowedOriginAsync(
  req: IncomingMessage,
  options: OriginGuardOptions = {},
): Promise<AllowedOriginResult> {
  // Fast path — try the sync guard first. It'll succeed when the origin
  // is already in the static allowlist or the dev file. Only the
  // "unknown-but-well-formed" branch needs async behaviour.
  try {
    assertAllowedOrigin(req, options);
    return { source: 'allowlist', degraded: false };
  } catch (err) {
    // If TOFU isn't enabled or no callback was wired, bubble the original
    // rejection up unchanged.
    if (
      !options.previewMode ||
      typeof options.onUnknownExtensionOrigin !== 'function'
    ) {
      throw err;
    }
  }

  // Re-extract origin for the TOFU path. If the previous rejection was
  // anything other than "not-allowlisted for a valid chrome-extension
  // ID", keep the original posture — we never want TOFU to widen the
  // guard for null-origin, wrong-scheme, malformed-ID rejections.
  const origin = extractHeader(req, 'origin');
  const errorReporter = options.errorReporter;
  const onUnknownExtensionOrigin = options.onUnknownExtensionOrigin;
  const onTrustPersistenceFailure = options.onTrustPersistenceFailure;
  const onPersistedExtensionId = options.onPersistedExtensionId;

  if (!origin || origin === 'null') {
    reject(
      ErrorCode.UNAUTHORIZED,
      origin ? 'Origin "null" is not allowed here.' : 'Missing Origin header.',
      errorReporter,
      { reason: origin ? 'null-origin' : 'missing-origin' },
      options.logger,
    );
  }

  const extensionMatch = CHROME_EXTENSION_ORIGIN_REGEX.exec(origin);
  if (!extensionMatch) {
    // moz-extension://, wrong scheme, or malformed ID. TOFU only covers
    // Chrome/Chromium extensions in preview mode; Firefox parity is
    // future work.
    reject(
      ErrorCode.UNAUTHORIZED,
      `Origin "${origin}" is not TOFU-eligible.`,
      errorReporter,
      { reason: 'tofu-not-eligible', origin },
      options.logger,
    );
  }

  const extensionId = extensionMatch[1];
  let approved = false;
  try {
    approved = await onUnknownExtensionOrigin(extensionId);
  } catch (err) {
    errorReporter?.addBreadcrumb({
      category: 'app-bridge.origin-guard',
      level: 'warning',
      message: 'tofu-callback-threw',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
    approved = false;
  }

  if (!approved) {
    reject(
      ErrorCode.UNAUTHORIZED,
      `Origin "${origin}" was not approved by the host.`,
      errorReporter,
      { reason: 'tofu-rejected', origin },
      options.logger,
    );
  }

  let added = false;
  let alreadyPresent = false;
  let degraded = false;
  const shouldPersist = options.persistOnApproval !== false;

  // Approved — persist so subsequent requests from this extension use the
  // fast path unless the caller explicitly requested a non-persistent
  // approval (used by `/intent/health`).
  if (shouldPersist && options.stateDirectory) {
    const result = persistTrustedExtensionId(
      options.stateDirectory,
      extensionId,
      errorReporter,
    );
    added = result.added;
    alreadyPresent = result.alreadyPresent;
    if (added) {
      try {
        onPersistedExtensionId?.(extensionId);
      } catch (err) {
        errorReporter?.addBreadcrumb({
          category: 'app-bridge.origin-guard',
          level: 'warning',
          message: 'tofu-persist-callback-threw',
          data: { err: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    degraded = !result.added && !result.alreadyPresent;
    if (degraded && onTrustPersistenceFailure) {
      try {
        onTrustPersistenceFailure({
          extensionId,
          stateDirectory: options.stateDirectory,
        });
      } catch (err) {
        errorReporter?.addBreadcrumb({
          category: 'app-bridge.origin-guard',
          level: 'warning',
          message: 'tofu-persist-failure-handler-threw',
          data: { err: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  const approvalData = {
    extensionIdSuffix: extensionId.slice(-4),
    persistOnApproval: shouldPersist,
    added,
    alreadyPresent,
    degraded,
  };
  errorReporter?.addBreadcrumb({
    category: 'app-bridge.origin-guard',
    level: 'info',
    message: 'tofu-extension-approved',
    // Redact to last 4 chars so Sentry never carries a full ID at info.
    data: approvalData,
  });
  if (options.logger) {
    installEvent(options.logger, 'info', 'app-bridge.tofu.approved', approvalData);
  }

  return { source: 'tofu', degraded };
}

/**
 * Assert that the request's Origin header is in the allowlist. Throws
 * `AppBridgeError(UNAUTHORIZED)` otherwise.
 */
export function assertAllowedOrigin(
  req: IncomingMessage,
  options: OriginGuardOptions = {},
): void {
  const origin = extractHeader(req, 'origin');
  const errorReporter = options.errorReporter;

  if (origin === null) {
    if (options.allowMissingOrigin === true) {
      return;
    }
    reject(
      ErrorCode.UNAUTHORIZED,
      'Missing Origin header.',
      errorReporter,
      { reason: 'missing-origin' },
      options.logger,
    );
  }

  if (origin === 'null') {
    if (options.allowNullOrigin === true) {
      return;
    }
    reject(
      ErrorCode.UNAUTHORIZED,
      'Origin "null" is not allowed here.',
      errorReporter,
      { reason: 'null-origin' },
      options.logger,
    );
  }

  // Extract scheme + extension ID for chrome-/moz-extension origins.
  const extensionMatch = /^(chrome-extension|moz-extension):\/\/([^/]+)$/.exec(origin);
  if (!extensionMatch) {
    reject(
      ErrorCode.UNAUTHORIZED,
      `Origin "${origin}" is not in the allowlist.`,
      errorReporter,
      { reason: 'origin-scheme', origin },
      options.logger,
    );
  }

  const scheme = extensionMatch[1];
  const extensionId = extensionMatch[2];
  if (!isValidExtensionId(extensionId)) {
    reject(
      ErrorCode.UNAUTHORIZED,
      `Origin "${origin}" has an invalid extension ID.`,
      errorReporter,
      { reason: 'origin-id-shape', origin },
      options.logger,
    );
  }

  let allowedIds: readonly string[];
  if (scheme === 'chrome-extension') {
    // Preview-mode TOFU approvals intentionally rehydrate from the same
    // on-disk trust file as dev-mode IDs. Both are explicit, local user-granted
    // trust and keeping one file avoids a split-brain "approved once, prompts
    // again after restart" failure mode.
    const persistedTrustedIds =
      options.previewMode || (options.devMode && process.env[DEV_MODE_ENV] === '1')
        ? loadDevExtensionIds(options.stateDirectory)
        : [];
    allowedIds = [...(options.chromeExtensionIds ?? []), ...persistedTrustedIds];
  } else {
    // moz-extension:// — Stage 2 mirrors the chrome-extension allowlist but
    // keeps a separate configured list. Dev-mode IDs are Chrome-only for now.
    allowedIds = options.mozExtensionIds ?? [];
  }

  if (!allowedIds.includes(extensionId)) {
    reject(
      ErrorCode.UNAUTHORIZED,
      `Origin "${origin}" is not in the allowlist.`,
      errorReporter,
      { reason: 'origin-not-allowlisted', origin },
      options.logger,
    );
  }
}

/**
 * Assert that the request's Host header refers to the loopback address on
 * the bound port. Throws `AppBridgeError(UNAUTHORIZED)` otherwise.
 */
export function assertAllowedHost(
  req: IncomingMessage,
  port: number,
  options: Pick<OriginGuardOptions, 'errorReporter' | 'logger'> = {},
): void {
  const host = extractHeader(req, 'host');
  const errorReporter = options.errorReporter;

  if (!host) {
    reject(
      ErrorCode.UNAUTHORIZED,
      'Missing Host header.',
      errorReporter,
      { reason: 'missing-host' },
      options.logger,
    );
  }

  const expected = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!expected.has(host)) {
    reject(
      ErrorCode.UNAUTHORIZED,
      `Host "${host}" is not permitted.`,
      errorReporter,
      { reason: 'host-mismatch', host },
      options.logger,
    );
  }
}
