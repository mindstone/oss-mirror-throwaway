/**
 * observingSafeParse — Zod boundary validation in observe-only mode.
 *
 * Validates a runtime payload against a Zod schema, logs a structured
 * warning when validation fails, and returns the payload unchanged.
 *
 * Use this at process boundaries where the schema is the contract but
 * existing payloads might not have been audited for strict conformance.
 * Observe-only mode surfaces drift without changing user-visible
 * behavior (no fail-fast). A future stage can flip individual call
 * sites to `enforce` mode once observations confirm the schema is
 * strictly respected by all callers.
 *
 * Origin: 260523 code-health-followup Stage 7. Behavioral Safety F1 in
 * Phase 8 round 2 flagged that Zod schemas registered in the IPC
 * contract (e.g. AgentSessionSchema for sessions:save / sessions:upsert)
 * were never invoked at runtime — bad payloads from renderer or cloud
 * clients could silently corrupt session storage. Observability-first
 * because flipping to enforce mode is a Phase 3 STOP trigger
 * (user-visible behavior change) that needs user authorization.
 *
 * Usage:
 *   const validation = observingSafeParse({
 *     schema: AgentSessionSchema,
 *     payload: session,
 *     channel: 'sessions:upsert',
 *     mode: 'observe',
 *     log: scopedLogger,
 *   });
 *   if (!validation.ok && validation.mode === 'enforce') {
 *     throw new Error(...);
 *   }
 *   // proceed with payload unchanged (observe mode) or validated payload (enforce)
 */

import type { z, ZodIssue } from 'zod';

interface BaseLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ObservingSafeParseOptions<T> {
  schema: z.ZodType<T>;
  payload: unknown;
  /** Channel or boundary name for log correlation. */
  channel: string;
  /** observe = log on failure, return ok=false but caller must not throw. enforce = caller should throw on failure. */
  mode?: 'observe' | 'enforce';
  log: BaseLogger;
}

export type ObservingSafeParseResult<T> =
  | { ok: true; data: T; mode: 'observe' | 'enforce' }
  | { ok: false; issues: ZodIssue[]; mode: 'observe' | 'enforce' };

const MAX_ISSUES_LOGGED = 5;
const MAX_PATH_DEPTH = 6;

/**
 * Generic, code-derived issue messages used in place of Zod's default
 * messages. Zod's default messages for enum/literal/invalid_union
 * mismatches include the offending VALUE (e.g. "Invalid enum value.
 * Expected 'user' | 'assistant', received 'leaked-pii-here'"), which
 * defeats the redaction goal when the value is user-controlled. We
 * substitute a generic per-code message so the structured log never
 * embeds the rejected value. Round-3 closer F1, 260523 sweep.
 *
 * Callers who need the precise expected/received pair for debugging
 * should switch the offending call site to `mode: 'enforce'` and
 * inspect the thrown ZodError in a non-logging context.
 */
const GENERIC_MESSAGE_BY_CODE: Record<string, string> = {
  // Zod v4 codes
  invalid_type: 'value has the wrong type',
  invalid_value: 'value does not match the expected literal or enum member',
  invalid_union: 'value matches none of the union members',
  invalid_key: 'object key is invalid',
  invalid_element: 'collection element is invalid',
  invalid_format: 'string does not match the expected format',
  too_small: 'value is below the allowed minimum',
  too_big: 'value is above the allowed maximum',
  not_multiple_of: 'value is not a multiple of the expected step',
  unrecognized_keys: 'object contains unrecognized keys',
  custom: 'value failed a custom validation',
  // Legacy / Zod v3 codes still mapped for safety in case any dependency
  // emits the older shape; can be removed once a v3 path is impossible.
  invalid_literal: 'value does not match the expected literal',
  invalid_enum_value: 'value is not one of the allowed enum members',
  invalid_union_discriminator: 'discriminator does not match any union member',
  invalid_arguments: 'function arguments are invalid',
  invalid_return_type: 'function return value is invalid',
  invalid_date: 'value is not a valid date',
  invalid_string: 'string does not match the expected format',
  invalid_intersection_types: 'intersection types do not align',
  not_finite: 'numeric value is not finite',
};

function genericMessageFor(code: string): string {
  return GENERIC_MESSAGE_BY_CODE[code] ?? `value failed validation (code=${code})`;
}

/**
 * Matches a "safe" path segment: a numeric array index, or a simple
 * JavaScript identifier (starts with letter or underscore, followed by
 * letters/digits/underscores). Anything else — filenames with dots, paths
 * with slashes, UUIDs with hyphens, arbitrary user-supplied keys — is
 * treated as potentially-PII and redacted by `redactPathSegment`.
 */
const SAFE_PATH_SEGMENT_RE = /^(?:\d+|[a-zA-Z_][a-zA-Z0-9_]*)$/;

/**
 * Redact a single `ZodIssue.path` segment for safe structured logging.
 *
 * Numeric array indices and plain JavaScript identifiers (which is what
 * static schema field names look like) pass through unchanged so logs
 * still tell SREs which FIELD failed validation. Anything else is
 * replaced with `<redacted-key>` because it's most likely a dynamic
 * record key that originated from the caller's payload — e.g. an
 * attachment filename indexing `attachmentTexts: z.record(z.string(),
 * z.string())`, or a turn ID indexing `eventsByTurn`.
 *
 * Tradeoff: redacting UUID-shaped IDs (turn IDs, message IDs) loses
 * some debugging context, but those IDs are derived from user activity
 * and correlate to specific sessions, so erring on the side of redaction
 * is the safer default for production log surfaces.
 */
function redactPathSegment(seg: unknown): string {
  const s = String(seg);
  return SAFE_PATH_SEGMENT_RE.test(s) ? s : '<redacted-key>';
}

/**
 * Compact a ZodIssue list for structured logging. Keeps the first
 * `MAX_ISSUES_LOGGED` issues, redacts `received` (which can contain
 * user data), replaces `message` with a generic per-code message (Zod's
 * default messages embed the received value for several issue codes —
 * see GENERIC_MESSAGE_BY_CODE above), and truncates very deep paths.
 *
 * **`issue.path` PII redaction.** Zod populates each issue's `path` with
 * the property names walked into, INCLUDING dynamic record keys. Several
 * fields in `AgentSessionSchema` are user-keyed records — e.g.
 * `attachmentTexts: z.record(z.string(), z.string())` keyed by
 * attachment filename, `eventsByTurn: z.record(z.string(), …)` keyed by
 * turn ID, and similar for `_deletedMessages`, `modelUsage`,
 * `memoryUpdateStatusByTurn`, `timeSavedStatusByTurn`,
 * `toolDetailArchive`, and `metadata`. Without redaction, a single
 * malformed value under `attachmentTexts["sensitive-document.pdf"]`
 * would leak the filename into structured logs on both desktop (Stage 7)
 * and cloud (Stage 12). `redactPathSegment` above replaces any path
 * segment that isn't a numeric index or a plain JavaScript identifier
 * with `<redacted-key>`, so schema field names survive (useful for
 * debugging) while user-controlled keys do not.
 */
function compactIssues(issues: ZodIssue[]): Array<{ path: string; code: string; message: string }> {
  return issues.slice(0, MAX_ISSUES_LOGGED).map((issue) => {
    const pathSegments = issue.path.slice(0, MAX_PATH_DEPTH).map(redactPathSegment);
    if (issue.path.length > MAX_PATH_DEPTH) pathSegments.push('…');
    return {
      path: pathSegments.join('.') || '(root)',
      code: issue.code,
      message: genericMessageFor(issue.code),
    };
  });
}

export function observingSafeParse<T>(
  options: ObservingSafeParseOptions<T>,
): ObservingSafeParseResult<T> {
  const mode = options.mode ?? 'observe';
  const result = options.schema.safeParse(options.payload);

  if (result.success) {
    return { ok: true, data: result.data, mode };
  }

  options.log.warn(
    {
      channel: options.channel,
      mode,
      issueCount: result.error.issues.length,
      issues: compactIssues(result.error.issues),
    },
    `IPC boundary validation ${mode === 'observe' ? 'observed' : 'rejected'} mismatch`,
  );

  return { ok: false, issues: result.error.issues, mode };
}
