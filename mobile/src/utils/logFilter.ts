// SECURITY: Keep in sync with src/core/utils/logFieldFilter.ts — this is the mobile counterpart of the desktop privacy gate
//
// This file is a mobile-local copy of the desktop log filtering logic.
// We deliberately copy rather than share via packages/shared to avoid adding
// blast radius to the desktop's security-critical code path.
//
// Allowlist-based filtering of NDJSON log entries for privacy-safe diagnostic
// submission. Only structural/operational fields pass through; free-text fields
// (msg, err) are sanitized to strip embedded user content. Everything else is dropped.

import {
  ANTHROPIC_API_KEY_REGEX,
  EMAIL_ADDRESS_REGEX,
  ELEVENLABS_API_KEY_JSON_REGEX,
  GENERIC_JSON_SECRET_REGEX,
  LINUX_HOME_DIRECTORY_REGEX,
  MACOS_HOME_DIRECTORY_REGEX,
  OPENAI_API_KEY_REGEX,
  SENSITIVE_URL_PARAM_PATTERNS,
  WINDOWS_HOME_DIRECTORY_REGEX,
} from '@shared/utils/redactionPatterns';
import type { SafeTelemetryBreadcrumbData } from '@shared/types/safeTelemetryBreadcrumbData';
import { brandSanitizedLogBreadcrumbData } from '@shared/utils/safeTelemetryBreadcrumbData';

// =============================================================================
// Field Allowlists
// =============================================================================

/**
 * Fields from NDJSON log entries that are safe to include as-is in diagnostics.
 * ALL other fields are stripped before submission.
 */
export const SAFE_LOG_FIELDS: ReadonlySet<string> = new Set([
  // Structural / temporal
  'level',
  'time',
  'ts',  // mobile log format uses `ts` instead of `time`
  'pid',
  'hostname',
  'v',

  // Source identification
  'service',
  'component',
  'source',
  'name',
  'tag',  // mobile log format uses `tag` instead of `source`/`component`
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
  // Hand-extracted error siblings some call sites emit alongside `err`. Sanitized
  // exactly like errMsg/errStack. Kept in sync with the desktop allowlist.
  'errorMessage',
  'errorStack',
]);

// =============================================================================
// Redaction (subset of src/core/utils/logRedaction.ts — only redactSensitiveData)
// =============================================================================

/**
 * Redact sensitive data from log content string.
 * Removes API keys, email addresses, URL params, and normalizes user paths.
 *
 * Patterns are imported from @shared/utils/redactionPatterns to stay in sync
 * with the desktop/core redaction logic and prevent security drift.
 */
function redactSensitiveData(content: string): string {
  return redactUrlParams(
    content
      // Redact Anthropic API keys
      .replace(ANTHROPIC_API_KEY_REGEX, 'sk-ant-***REDACTED***')
      // Redact OpenAI-style keys
      .replace(OPENAI_API_KEY_REGEX, 'sk-***REDACTED***')
      // Redact ElevenLabs keys (typically hex strings)
      .replace(ELEVENLABS_API_KEY_JSON_REGEX, '"elevenlabsApiKey": "***REDACTED***"')
      // Redact generic API key patterns in JSON
      .replace(GENERIC_JSON_SECRET_REGEX, '"$1": "***REDACTED***"')
      // Normalize user home directory paths (macOS, Linux, Windows)
      .replace(MACOS_HOME_DIRECTORY_REGEX, '~')
      .replace(LINUX_HOME_DIRECTORY_REGEX, '~')
      .replace(WINDOWS_HOME_DIRECTORY_REGEX, '~')
      // Redact email addresses
      .replace(EMAIL_ADDRESS_REGEX, '***@***.***'),
  );
}

function redactUrlParams(content: string): string {
  let result = content;
  for (const { pattern, replacement } of SENSITIVE_URL_PARAM_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

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
 * Then applies `redactSensitiveData()` as a final pass for API keys,
 * emails, and path normalization.
 */
export function sanitizeLogMessage(value: string): string {
  let result = value;

  // 1. Apply existing redaction FIRST (API keys, emails, path normalization)
  result = redactSensitiveData(result);

  // 2. Strip quoted content >10 chars (likely user data)
  result = result.replace(/"[^"]{11,}"/g, '"[content-redacted]"');
  result = result.replace(/'[^']{11,}'/g, "'[content-redacted]'");

  // 3. Strip file paths after ~/ (workspace structure beyond home dir)
  result = result.replace(/~\/[^\s"',;)}\]]+/g, '~/[path-redacted]');
  result = result.replace(/~\\[^\s"',;)}\]]+/g, '~\\[path-redacted]');

  // 4. Strip content after common content-introducing keywords
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
 * Filter a single parsed log entry to only allowlisted fields.
 * Safe fields pass through unchanged; sanitized fields get content-stripped;
 * everything else is dropped.
 */
/**
 * Canonical operational keys of a serialized `Error`. When sanitizing a nested
 * error OBJECT we preserve ONLY these keys; any other (content-bearing) custom
 * property is DROPPED. Kept in sync with src/core/utils/logFieldFilter.ts
 * (`CANONICAL_ERROR_KEYS`). See that file for the security rationale.
 */
const CANONICAL_ERROR_KEYS: ReadonlySet<string> = new Set([
  'type', 'name', 'message', 'stack', 'code', 'errno', 'syscall',
  'status', 'statusCode', 'cause', 'errors',
]);

const MAX_NESTED_DEPTH = 6;
const MAX_NESTED_ARRAY_ITEMS = 50;
const MAX_NESTED_STRING_CHARS = 8192;

/**
 * Structure-preserving, key-aware sanitizer for non-string SANITIZED_LOG_FIELDS
 * values — most importantly the nested `err` object (`{type,message,stack,code}`).
 * The previous `String(value)` collapse turned every real error into the literal
 * `"[object Object]"`, destroying the signal. Recurse, keeping only
 * CANONICAL_ERROR_KEYS on objects and running `sanitizeLogMessage` over each
 * preserved STRING LEAF. Mirrors src/core/utils/logFieldFilter.ts
 * (`sanitizeNestedFieldValue`) with one known divergence: core truncates via
 * `truncateWellFormed` (never splits a surrogate pair) while this copy still
 * uses a raw `.slice` — acceptable because mobile's Sentry `beforeSend` now
 * runs shared `redactSentryEvent` and therefore still sweeps the final event
 * to well-formed UTF-16 (`mobile/src/utils/sentry.ts`).
 */
export function sanitizeNestedFieldValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const capped = value.length > MAX_NESTED_STRING_CHARS ? value.slice(0, MAX_NESTED_STRING_CHARS) : value;
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
      if (!CANONICAL_ERROR_KEYS.has(key)) continue;
      const child = (value as Record<string, unknown>)[key];
      // SECURITY (Reviewer F5): cause/errors are typed `unknown` — drop non-object
      // elements so bare primitive PII can't ride a canonical key. Kept in sync
      // with src/core/utils/logFieldFilter.ts.
      if (key === 'cause') {
        if (child && typeof child === 'object') out[key] = sanitizeNestedFieldValue(child, depth + 1);
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

export function filterLogEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};

  for (const key of Object.keys(entry)) {
    if (SAFE_LOG_FIELDS.has(key)) {
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
 * Redact the `data` bindings of a Sentry log breadcrumb.
 *
 * Keep this semantically aligned with src/core/utils/logFieldFilter.ts:
 * log breadcrumb data is logger-binding data, so it must use the same
 * deny-by-default allowlist as filtered diagnostic logs.
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
