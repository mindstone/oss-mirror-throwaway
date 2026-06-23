/**
 * `installEvent` — the single conventional way to emit structured pino
 * logs for install-flow decisions in the app-bridge subsystem.
 *
 * Why this exists: prior to this module, most install-flow decision
 * points were reported only as Sentry breadcrumbs. That meant a user
 * hitting "install failed" needed Sentry access to see what actually
 * happened. This helper mirrors every breadcrumb as a pino log with a
 * stable machine-grep-able `event` field, and also provides a
 * consistent shape for NEW log sites added going forward.
 *
 * Naming convention for `event`:
 *   app-bridge.<concern>.<action>[.<outcome>]
 *   all lowercase, dot-separated, stable.
 *
 *   - app-bridge.cors.preflight.accepted
 *   - app-bridge.cors.preflight.reject.host
 *   - app-bridge.cors.preflight.reject.origin
 *   - app-bridge.pair.start
 *   - app-bridge.pair.claim.ok
 *   - app-bridge.pair.claim.fail
 *   - app-bridge.pair.revoke
 *   - app-bridge.install.extract.start
 *   - app-bridge.install.extract.written
 *   - app-bridge.install.extract.skipped
 *   - app-bridge.install.extract.failed
 *   - app-bridge.tofu.approved
 *   - app-bridge.tofu.rejected
 *   - app-bridge.ws.auth.ok
 *   - app-bridge.ws.auth.rejected
 *
 * Grep pattern for ops:
 *   grep '"event":"app-bridge\.' ~/Library/Application\ Support/mindstone-rebel/logs/*.log
 *
 * Lint compliance: uses the pino-safe argument order (object first,
 * message second) enforced by eslint's `no-restricted-syntax` rule.
 *
 * Privacy note: callers must redact sensitive fields BEFORE calling
 * this helper. Do not log raw extension IDs, plaintext tokens, client
 * fingerprints, or origin strings. Use `redactExtensionIdForLog()`,
 * `extensionIdSuffix`, `tokenTag`, etc. from `fingerprint.ts` first.
 * This helper will not redact for you — garbage in, garbage logged.
 */

import type { Logger } from 'pino';

export type InstallEventLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Emit a structured install-flow log.
 *
 * @param log   A pino logger (or scoped logger). Pass the same one you
 *              use elsewhere in the module so bindings (service, turnId,
 *              etc.) carry through.
 * @param level The log level. Use `warn` for recoverable rejections,
 *              `error` only for actual crashes, `info` for normal flow,
 *              `debug` for high-volume events like individual requests.
 * @param event The stable event name (see naming convention above).
 * @param data  Structured fields. Keep keys stable across versions —
 *              they're part of the operational contract. Do not include
 *              secrets; do not include raw PII.
 */
export function installEvent(
  log: Logger,
  level: InstallEventLevel,
  event: string,
  data: Record<string, unknown> = {},
): void {
  // Pino's per-level methods all share the same signature: (obj, msg).
  // We put `event` into the object so it's both machine-searchable AND
  // the human-readable message. That means a single grep on the `event`
  // field finds logs regardless of whether the log is consumed as raw
  // JSON or as flattened text.
  //
  // Spread order puts the authoritative `event` AFTER the caller's
  // data, so an accidental `data.event` from a callsite can't shadow
  // our canonical name. This makes the helper footgun-resistant.
  log[level]({ ...data, event }, event);
}
