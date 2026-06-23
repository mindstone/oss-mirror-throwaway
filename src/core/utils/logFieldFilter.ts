/**
 * Log Field Filter for Bug Report Diagnostics
 *
 * Allowlist-based filtering of NDJSON log entries for privacy-safe Sentry submission.
 * Only structural/operational fields pass through; free-text fields (msg, err) are
 * sanitized to strip embedded user content. Everything else is dropped.
 *
 * This is the ONLY privacy gate for log data in bug reports — treat allowlist
 * additions as security-sensitive changes.
 *
 * @see docs/plans/260324_enriched_bug_report_diagnostics.md
 * @see docs/plans/260324_privacy_safe_diagnostic_enrichment.md
 */

import { redactSensitiveData } from '@core/utils/logRedaction';
import type { SafeTelemetryBreadcrumbData } from '@shared/types/safeTelemetryBreadcrumbData';
import { brandSanitizedLogBreadcrumbData } from '@shared/utils/safeTelemetryBreadcrumbData';
import { truncateWellFormed } from '@shared/utils/wellFormedUnicode';

// =============================================================================
// Field Allowlists
// =============================================================================

/**
 * Fields from NDJSON log entries that are safe to include as-is in bug reports.
 * ALL other fields are stripped before Sentry submission.
 */
export const SAFE_LOG_FIELDS: ReadonlySet<string> = new Set([
  // Structural / temporal
  'level',
  'time',
  'ts',   // SECURITY: Keep in sync with mobile/src/utils/logFilter.ts — mobile log format uses `ts`
  'pid',
  'hostname',
  'v',

  // Source identification
  'service',
  'component',
  'source',
  'name',
  'tag',  // SECURITY: Keep in sync with mobile/src/utils/logFilter.ts — mobile log format uses `tag`
  'ipc',
  'channel',
  'handler',

  // Status / codes
  'status',
  'statusCode',
  'code',

  // MCP tool execution outcomes (privacy-safe — bare names / shape / booleans only, NEVER values).
  // SECURITY: Package IDs in this repo carry PII-derived account slugs (e.g.
  // `GoogleWorkspace-teammember-mindstone-com` — see src/shared/utils/mcpInstanceUtils.ts and
  // src/shared/trackingTypes.ts). The compound `${packageId}__${toolName}` form
  // (see src/core/services/safety/toolSafetyService.ts) inherits that PII. We deliberately
  // do NOT allowlist `packageId` or any compound tool identifier here. Producers MUST emit only
  // the bare tool name into `toolName`; if a normalized non-PII package bucket is needed later
  // (e.g. `packageFamily` returning `'googleworkspace'`), define it alongside the producer wiring
  // follow-up rather than pre-allowlisting it here.
  'toolName',  // Bare MCP tool name only (e.g. `compose_workspace_email`), NEVER the `${packageId}__${tool}` form
  'isError',  // Boolean tool-result failure indicator for triage
  'toolArgKeys',  // Top-level argument key names only (never argument values)
  'toolEmptyArgKeys',  // Subset of toolArgKeys whose values were empty (REBEL-5MF-class signal)

  // Operational metrics
  'duration',
  'durationMs',
  'count',
  'size',
  'sizeBytes',
  'lineCount',
  'upstreamStatus',  // Upstream HTTP status code (int) from proxied provider calls — operational, not PII

  // Correlation IDs (opaque UUIDs)
  'turnId',
  'sessionId',
  'requestId',
  'traceId',
]);

/**
 * Fields that are included but must be sanitized first to strip embedded
 * user content (file paths, quoted strings, keyword-prefixed content).
 */
export const SANITIZED_LOG_FIELDS: ReadonlySet<string> = new Set([
  'msg',
  'err',
  'errMsg',
  'errCode',
  'errStack',
  // Hand-extracted error siblings some call sites emit alongside `err` (e.g.
  // localModelProxyServer's Codex passthrough path). Sanitized exactly like
  // `errMsg`/`errStack`; previously dropped by the allowlist, discarding signal
  // the call site went out of its way to capture. See
  // docs/plans/260606_bug-report-data-quality/subagent_reports/260606_researcher-object-object-rootcause.md
  'errorMessage',
  'errorStack',
]);

// =============================================================================
// Message Sanitization
// =============================================================================

/**
 * Sanitize a log message string to remove embedded user content.
 * Preserves the structural/operational part of the message while stripping:
 * - Quoted strings longer than 10 characters (likely user content)
 * - File paths after ~/ (workspace structure)
 * - Content after common content-introducing keywords
 *
 * Then applies existing `redactSensitiveData()` as a final pass for API keys,
 * emails, and path normalization.
 */
export function sanitizeLogMessage(value: string): string {
  let result = value;

  // 1. Apply existing redaction FIRST (API keys, emails, path normalization)
  //    This normalizes /Users/alice/... → ~/... and /home/bob/... → ~/...
  //    so that step 2 can reliably strip workspace paths.
  result = redactSensitiveData(result);

  // 2. Strip quoted content >10 chars (likely user data)
  //    e.g., 'Auto-title failed for "My secret project meeting"'
  //    → 'Auto-title failed for "[content-redacted]"'
  result = result.replace(/"[^"]{11,}"/g, '"[content-redacted]"');
  result = result.replace(/'[^']{11,}'/g, "'[content-redacted]'");

  // 3. Strip file paths after ~/ (workspace structure beyond home dir)
  //    After step 1, /Users/alice/Documents/secret.txt → ~/Documents/secret.txt
  //    This step strips the remainder: ~/Documents/secret.txt → ~/[path-redacted]
  result = result.replace(/~\/[^\s"',;)}\]]+/g, '~/[path-redacted]');
  // Also catch Windows-style paths: ~\Documents\secret.txt → ~\[path-redacted]
  result = result.replace(/~\\[^\s"',;)}\]]+/g, '~\\[path-redacted]');

  // 4. Strip content after common content-introducing keywords
  //    e.g., 'Failed to process title: My Secret Meeting Notes'
  //    → 'Failed to process title: [content-redacted]'
  result = result.replace(
    /(title|content|description|message|text|subject|body|prompt|argument|input):\s*.{11,}/gi,
    '$1: [content-redacted]',
  );

  return result;
}

// =============================================================================
// Log Entry Filtering
// =============================================================================

/**
 * Canonical operational keys of a serialized `Error` (pino's `stdSerializers.err`
 * shape, plus the common Node error fields). When sanitizing a nested error
 * OBJECT we preserve ONLY these keys; ANY other enumerable property is DROPPED.
 *
 * SECURITY: a custom Error subclass can carry arbitrary user data as enumerable
 * properties (`err.projectName`, `err.customerId`, `err.payload` Buffer, Node's
 * `err.path`/`err.dest` file paths). Preserving the whole object — even with each
 * string leaf sanitized — would leak classes of data `sanitizeLogMessage` cannot
 * catch (bare company/person/project names, numeric IDs, byte arrays, non-home
 * absolute paths). The old `String(value)` collapse leaked none of this, so a
 * naive recursion would be a privacy REGRESSION. The key allowlist closes that:
 * we recover the diagnostic signal (message/code/stack/cause) without preserving
 * attacker- or content-bearing custom properties. (Reviewer F1, GPT-5.5.)
 */
const CANONICAL_ERROR_KEYS: ReadonlySet<string> = new Set([
  'type',
  'name',
  'message',
  'stack',
  'code',
  'errno',
  'syscall',
  'status',
  'statusCode',
  'cause',  // nested error → recursed with the same allowlist
  'errors', // AggregateError → array of nested errors
]);

// Resilience caps for the recursion (Reviewer F4). On-disk NDJSON cannot be
// circular, but it can be deeply nested / huge, and direct callers could pass
// hostile objects. The old `String(value)` was constant-size.
const MAX_NESTED_DEPTH = 6;
const MAX_NESTED_ARRAY_ITEMS = 50;
const MAX_NESTED_STRING_CHARS = 8192;

/**
 * Structure-preserving sanitizer for SANITIZED_LOG_FIELDS values that are not
 * plain strings — most importantly the nested `err` object pino writes by
 * default (`{type, message, stack, code, ...}`).
 *
 * The previous implementation collapsed any non-string value with
 * `String(value)`, which for the canonical `{ err: <Error> }` log shape (~all
 * error logging in the app) produced the literal `"[object Object]"` — silently
 * destroying message/code/stack for every Sentry bug report (see
 * docs/plans/260606_bug-report-data-quality/subagent_reports/260606_researcher-object-object-rootcause.md).
 *
 * We recurse, but on OBJECTS we keep only {@link CANONICAL_ERROR_KEYS} (dropping
 * content-bearing custom properties — see that constant) and run
 * `sanitizeLogMessage` over each preserved STRING LEAF (including home-dir path
 * scrubbing of stack frames). Numbers/booleans/null pass through (operational,
 * not PII — consistent with the allowlisted `code`/`errno`); functions, symbols,
 * bigint and other exotic leaves are dropped.
 *
 * NOTE: `sanitizeLogMessage(JSON.stringify(value))` was rejected — the quoted-
 * string rule swallows the whole serialized envelope into one redaction blob.
 * Per-leaf recursion applies the rules to each field's value text instead.
 */
export function sanitizeNestedFieldValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const capped = value.length > MAX_NESTED_STRING_CHARS
      ? truncateWellFormed(value, MAX_NESTED_STRING_CHARS)
      : value;
    return sanitizeLogMessage(capped);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (depth >= MAX_NESTED_DEPTH) {
    return '[redacted-depth]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_NESTED_ARRAY_ITEMS).map((item) => sanitizeNestedFieldValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      // Drop any non-canonical (potentially content-bearing) error property.
      if (!CANONICAL_ERROR_KEYS.has(key)) continue;
      const child = (value as Record<string, unknown>)[key];
      // SECURITY (Reviewer F5): `Error.cause` and `AggregateError.errors` are
      // typed `unknown` — JS allows ANY value there, not just nested Error
      // objects (e.g. `cause: "Confidential Target Corp"`, `errors: [123456789]`).
      // The generic recursion would preserve such bare primitives (numbers pass
      // through; strings survive `sanitizeLogMessage`, which by design does not
      // catch bare company/person names) — reopening the F1 leak class through a
      // canonical key. Contract: cause/errors carry only Error-SHAPED OBJECTS;
      // non-object elements are dropped.
      if (key === 'cause') {
        if (child && typeof child === 'object') {
          out[key] = sanitizeNestedFieldValue(child, depth + 1);
        }
        continue;
      }
      if (key === 'errors') {
        if (Array.isArray(child)) {
          out[key] = child
            .slice(0, MAX_NESTED_ARRAY_ITEMS)
            .filter((item): item is object => !!item && typeof item === 'object')
            .map((item) => sanitizeNestedFieldValue(item, depth + 1));
        }
        continue;
      }
      out[key] = sanitizeNestedFieldValue(child, depth + 1);
    }
    return out;
  }
  return undefined; // functions / symbols / bigint / undefined → drop
}

/**
 * Filter a single parsed log entry to only allowlisted fields.
 * Safe fields pass through unchanged; sanitized fields get content-stripped
 * (structure-preserving for nested objects like `err`); everything else dropped.
 */
export function filterLogEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};

  for (const key of Object.keys(entry)) {
    if (SAFE_LOG_FIELDS.has(key)) {
      // `upstreamStatus` is allowlisted as an HTTP status INT. Pass it through
      // only when it is actually a number — a future producer assigning a string
      // or object must not ride the unsanitized SAFE path. (Reviewer F3.)
      if (key === 'upstreamStatus' && typeof entry[key] !== 'number') continue;
      filtered[key] = entry[key];
    } else if (SANITIZED_LOG_FIELDS.has(key)) {
      const value = entry[key];
      filtered[key] = typeof value === 'string'
        ? sanitizeLogMessage(value)
        : sanitizeNestedFieldValue(value);
    }
    // All other fields are dropped
  }

  return filtered;
}

/**
 * Redact the `data` bindings of a `category: 'log'` Sentry breadcrumb.
 *
 * PRIVACY (MF-2): log breadcrumbs are auto-recorded from every info+ log call and
 * ride the Sentry event (incl. bug reports). Their `data` is the same bindings
 * shape as an on-disk log entry, but it was previously scrubbed only by
 * pattern/key redaction — so user content under benign keys (`title`, `query`,
 * `filename`, `projectName`, …) survived and was shipped. Run it through the SAME
 * deny-by-default allowlist as the filtered-logs attachment so only operational
 * fields (sanitized) leave the machine. NON-log breadcrumbs (http/navigation/etc.)
 * keep their own redaction — this is for log breadcrumbs only. See
 * docs/plans/260606_bug-report-data-quality/subagent_reports/260606_arbitrator-privacy-synthesis.md
 */
export function redactLogBreadcrumbData(data: Record<string, unknown>): SafeTelemetryBreadcrumbData {
  return brandSanitizedLogBreadcrumbData(filterLogEntry(data));
}

/**
 * Process NDJSON content line by line, filtering each entry through the allowlist.
 * Returns filtered NDJSON string.
 */
export function filterLogEntries(ndjsonContent: string): string {
  const lines = ndjsonContent.split('\n');
  const filtered: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      const filteredEntry = filterLogEntry(entry);
      filtered.push(JSON.stringify(filteredEntry));
    } catch {
      // Skip unparseable lines (non-JSON log lines)
    }
  }

  return filtered.join('\n');
}

// =============================================================================
// Session Metadata Extraction
// =============================================================================

/**
 * Anonymized session metadata safe for bug report inclusion.
 * Contains only aggregate stats — never titles, messages, or content.
 */
export interface AnonymizedSessionMeta {
  /** Session ID (opaque UUID) */
  id: string;
  /** Number of turns in the session */
  turnCount: number;
  /** Total number of messages */
  totalMessageCount: number;
  /** Count of error-type events across all turns */
  errorEventCount: number;
  /** Count of tool failure events across all turns */
  toolFailureCount: number;
  /** Total cost in USD (if available) */
  costUsd: number | undefined;
  /** Session creation timestamp */
  createdAt: number;
  /** Session last-updated timestamp */
  updatedAt: number;
  /** Session origin type */
  origin: string;
}

/**
 * Extract anonymized metadata from a session object.
 * Returns safe aggregate stats — NEVER includes title, messages content,
 * or upstream session ID beyond the opaque UUID.
 */
export function extractAnonymizedSessionMeta(
  session: {
    id: string;
    createdAt: number;
    updatedAt: number;
    messages?: Array<unknown>;
    eventsByTurn?: Record<string, Array<{ type: string; costUsd?: number; error?: unknown }>>;
    origin?: string;
  },
): AnonymizedSessionMeta {
  const eventsByTurn = session.eventsByTurn ?? {};
  const turnCount = Object.keys(eventsByTurn).length;
  const totalMessageCount = Array.isArray(session.messages) ? session.messages.length : 0;

  let errorEventCount = 0;
  let toolFailureCount = 0;
  let costUsd = 0;

  for (const events of Object.values(eventsByTurn)) {
    for (const event of events) {
      if (event.type === 'error') {
        errorEventCount++;
      }
      if (event.type === 'tool_error' || (event.type === 'tool_result' && event.error)) {
        toolFailureCount++;
      }
      if (event.type === 'usage' && typeof event.costUsd === 'number') {
        costUsd += event.costUsd;
      }
    }
  }

  return {
    id: session.id,
    turnCount,
    totalMessageCount,
    errorEventCount,
    toolFailureCount,
    costUsd: costUsd > 0 ? costUsd : undefined,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    origin: session.origin ?? 'manual',
  };
}
