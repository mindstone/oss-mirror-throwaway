/**
 * Sentry Redaction Utilities
 *
 * Unified redaction logic for Sentry events in both main and renderer processes.
 * Ensures consistent privacy protection across the app.
 *
 * Design decisions:
 * - Uses WeakSet for cycle detection (handles circular references safely)
 * - Applies "cheap" string redactions (emails, paths, API keys) to ALL strings
 * - Uses heuristic check before expensive URL param regex loop
 * - Comprehensive key patterns from main process logRedaction.ts
 */

import {
  ANTHROPIC_API_KEY_REGEX,
  EMAIL_ADDRESS_REGEX,
  ELEVENLABS_API_KEY_JSON_REGEX,
  JSON_STRING_KEY_VALUE_REGEX,
  LINUX_HOME_DIRECTORY_REGEX,
  MACOS_HOME_DIRECTORY_REGEX,
  OPENAI_API_KEY_REGEX,
  SENSITIVE_KEY_NAME_PATTERNS,
  SENSITIVE_URL_PARAM_PATTERNS,
  WINDOWS_HOME_DIRECTORY_REGEX,
  isSensitiveKeyName,
} from './redactionPatterns';
import { ensureWellFormedDeep, summarizeWellFormedReplacementPaths } from './wellFormedUnicode';

/** Standardized redaction placeholder */
export const REDACTED_TEXT = '***REDACTED***';
export const REDACTED_EMAIL = '***@***.***';

/** Maximum recursion depth to prevent stack overflow */
const MAX_REDACTION_DEPTH = 20;

/** Sentry user fields preserved for reporter identification (see 93b8a58fc). */
const SENTRY_USER_IDENTITY_FIELDS: ReadonlySet<string> = new Set(['id', 'email']);

const OAUTH_CODE_KEY_REGEX = /^(?:oauth_)?code$/i;
const OAUTH_CODE_VALUE_REGEX = /^[A-Za-z0-9.-]{20,}$/;

/**
 * Patterns that match sensitive key names for deep redaction.
 * Derived from the shared key-name SSOT for compatibility with existing code
 * that uses the array form.
 */
export const SENSITIVE_KEY_PATTERNS: RegExp[] = [...SENSITIVE_KEY_NAME_PATTERNS];

export interface SentryWellFormedFixSummary {
  replacementCount: number;
  replacementPaths: string[];
  omittedPathCount: number;
}

interface RedactSentryEventOptions {
  onWellFormedFix?: (summary: SentryWellFormedFixSummary) => void;
}

function shouldRedactKeyValue(key: string, value: unknown): boolean {
  if (isSensitiveKeyName(key)) {
    return true;
  }

  if (OAUTH_CODE_KEY_REGEX.test(key) && typeof value === 'string') {
    return OAUTH_CODE_VALUE_REGEX.test(value);
  }

  return false;
}

/**
 * Quick heuristic to check if a string might contain URL parameters.
 * Avoids running expensive regex loop on every string.
 * Uses case-insensitive checks to catch OAuth flows with mixed-case params.
 */
function mayContainUrlParams(value: string): boolean {
  // Basic auth in URLs (e.g., https://user:pass@domain)
  if (value.includes('://') && value.includes('@')) {
    return true;
  }
  // Check for URL parameter indicators (case-insensitive)
  if (!value.includes('=')) {
    return false;
  }
  const lower = value.toLowerCase();
  return (
    lower.includes('bearer') ||
    lower.includes('access_token') ||
    lower.includes('refresh_token') ||
    lower.includes('oauth_code') ||
    lower.includes('oauth_state') ||
    lower.includes('api_key') ||
    lower.includes('apikey') ||
    lower.includes('bot_token') ||
    lower.includes('signing_secret') ||
    lower.includes('slack_signing_secret') ||
    lower.includes('client_secret') ||
    lower.includes('code=') ||
    lower.includes('state=') ||
    lower.includes('token=') ||
    lower.includes('secret=') ||
    lower.includes('strata_id') ||
    value.includes('?') ||
    value.includes('&')
  );
}

/**
 * Redact URL parameters from a string.
 */
function redactUrlParams(value: string): string {
  let result = value;
  for (const { pattern, replacement } of SENSITIVE_URL_PARAM_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Redact sensitive data from a string value.
 * Applies to ALL strings - these are relatively cheap regex operations.
 */
export function redactSensitiveString(content: string): string {
  let result = content;

  // API keys - Anthropic
  result = result.replace(ANTHROPIC_API_KEY_REGEX, `sk-ant-${REDACTED_TEXT}`);

  // API keys - OpenAI style
  result = result.replace(OPENAI_API_KEY_REGEX, `sk-${REDACTED_TEXT}`);

  // API keys - Groq
  result = result.replace(/gsk_[a-zA-Z0-9]+/g, `gsk_${REDACTED_TEXT}`);

  // API keys - Google
  result = result.replace(/AIza[a-zA-Z0-9_-]{35}/g, `AIza${REDACTED_TEXT}`);

  // API keys - ElevenLabs (xi-* format)
  result = result.replace(/xi-[a-zA-Z0-9_-]{20,}/gi, `xi-${REDACTED_TEXT}`);

  // ElevenLabs keys in JSON
  result = result.replace(ELEVENLABS_API_KEY_JSON_REGEX, `"elevenlabsApiKey": "${REDACTED_TEXT}"`);

  // Generic API key patterns in JSON
  result = result.replace(JSON_STRING_KEY_VALUE_REGEX, (match, key: string, value: string) => {
    if (!shouldRedactKeyValue(key, value)) {
      return match;
    }
    return `"${key}": "${REDACTED_TEXT}"`;
  });

  // Normalize user home directory paths
  result = result.replace(MACOS_HOME_DIRECTORY_REGEX, '~');
  result = result.replace(LINUX_HOME_DIRECTORY_REGEX, '~');
  result = result.replace(WINDOWS_HOME_DIRECTORY_REGEX, '~');

  // Email addresses
  result = result.replace(EMAIL_ADDRESS_REGEX, REDACTED_EMAIL);

  // Bearer tokens (including JWTs with dots)
  result = result.replace(/bearer\s+[a-zA-Z0-9_.\-]+/gi, `bearer ${REDACTED_TEXT}`);

  // Slack tokens and request signatures
  result = result.replace(/\b(xox(?:[baprs]|a|e(?:\.xoxp)?))-[a-zA-Z0-9-]+/g, `$1-${REDACTED_TEXT}`);
  result = result.replace(/\bv0=[a-f0-9]{16,}\b/gi, `v0=${REDACTED_TEXT}`);

  // URL parameters (gated by heuristic for performance)
  if (mayContainUrlParams(result)) {
    result = redactUrlParams(result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Origin redaction — permission-flow Sentry breadcrumbs (plan §M)
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Heuristic: IPv4 private ranges (RFC 1918) + link-local (169.254/16).
 * We treat link-local as "private" for redaction purposes since a Sentry
 * breadcrumb with a user's intranet IP is still PII.
 */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map((segment) => Number.parseInt(segment, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Heuristic: private / unique-local IPv6 (fc00::/7) and link-local (fe80::/10).
 * Works against the lower-cased hostname (bracketless — WHATWG form).
 */
function isPrivateIPv6(host: string): boolean {
  if (host === '::1') return true;
  const lower = host.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    // fc00::/7 — unique local addresses
    return lower.length >= 3 && lower[2] !== undefined && /[0-9a-f]/.test(lower[2]);
  }
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    // fe80::/10 — link-local
    return true;
  }
  return false;
}

/**
 * Redact an origin for Sentry breadcrumbs. Keeps scheme + TLD when public
 * (`https://portal.pitchbook.com` → `https://***.com`), collapses loopback
 * and private-IP hosts to sentinels so the breadcrumb never carries intranet
 * or local-dev context. Local Pino `trace`/`debug` logs keep plaintext —
 * this helper is explicitly for the Sentry channel.
 *
 * See docs/plans/260424_browser_extension_bundling_and_permissions_fix.md §M.
 */
export function redactOrigin(origin: unknown): string {
  if (typeof origin !== 'string' || origin.length === 0) {
    return '<redacted>';
  }
  const trimmed = origin.trim();
  if (trimmed.length === 0) return '<redacted>';

  // Strip a trailing `/*` match-pattern suffix and parse.
  const withoutSuffix = trimmed.replace(/\/\*$/, '');
  let parsed: URL;
  try {
    parsed = new URL(withoutSuffix);
  } catch {
    return '<redacted>';
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return '<redacted>';
  }

  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) {
    return '<redacted>';
  }

  // IPv6 hostnames from `new URL()` may arrive with brackets preserved
  // (Node runtimes) or stripped (some browser implementations). Normalise.
  const hostWithoutBrackets =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  if (LOOPBACK_HOSTS.has(hostWithoutBrackets)) {
    return '<loopback>';
  }

  // IPv4 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostWithoutBrackets)) {
    if (isPrivateIPv4(hostWithoutBrackets)) return '<private-ip>';
    // Public IPv4 — keep scheme + sentinel, we don't expose the raw IP.
    return `${protocol}//***.***`;
  }

  // IPv6 literal — `::` and `:` colons indicate an IPv6 host.
  if (hostWithoutBrackets.includes(':')) {
    if (isPrivateIPv6(hostWithoutBrackets)) return '<private-ip>';
    return `${protocol}//***.***`;
  }

  // DNS hostname — keep scheme + TLD only.
  const segments = hostWithoutBrackets.split('.');
  const tld = segments.at(-1);
  if (!tld || tld.length === 0) {
    return '<redacted>';
  }
  return `${protocol}//***.${tld}`;
}

/**
 * Deeply redact sensitive fields from an object.
 * Uses WeakSet for cycle detection to handle circular references safely.
 *
 * @param obj - The object to redact
 * @returns A redacted copy of the object
 */
export function redactObjectDeep(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  // Track visited objects to handle circular references
  const visited = new WeakSet<object>();

  const redactRecursive = (current: unknown, depth: number): unknown => {
    // At max depth, return placeholder instead of raw data to prevent leaks
    if (depth > MAX_REDACTION_DEPTH) {
      return '[MaxDepth]';
    }
    if (current === null || current === undefined) return current;

    // Handle strings - apply redaction
    if (typeof current === 'string') {
      return redactSensitiveString(current);
    }

    // Handle non-objects (numbers, booleans, etc.)
    if (typeof current !== 'object') {
      return current;
    }

    // Skip Buffer instances (common in main process)
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(current)) {
      return '[Buffer]';
    }

    // Circular reference check
    if (visited.has(current)) {
      return '[Circular]';
    }
    visited.add(current);

    // Handle arrays
    if (Array.isArray(current)) {
      return current.map((item) => redactRecursive(item, depth + 1));
    }

    // Handle objects
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      // Use optimized single regex instead of array loop for O(1) matching
      const isSensitive = shouldRedactKeyValue(key, value);

      if (isSensitive && value !== null && value !== undefined && value !== '') {
        result[key] = REDACTED_TEXT;
      } else {
        result[key] = redactRecursive(value, depth + 1);
      }
    }

    return result;
  };

  return redactRecursive(obj, 0);
}

export function redactSentryEvent<T extends Record<string, unknown>>(
  event: T,
  options: RedactSentryEventOptions = {},
): T {
  const redacted: Record<string, unknown> = { ...event };
  const exception = redacted.exception as { values?: Array<Record<string, unknown>> } | undefined;

  // PRIVACY (MF-1): the Node/Electron Sentry SDK defaults `server_name` to
  // os.hostname(), which on personal machines is typically the user's real name
  // (e.g. "Ada-MacBook-Pro"). It is attached BEFORE beforeSend and is gated on
  // `includeServerName`, NOT `sendDefaultPii` — so disabling default PII does not
  // remove it. We set `includeServerName:false` at init; this unconditional
  // delete is the belt-and-suspenders backstop on the redaction path (covers any
  // event whose server_name was set explicitly elsewhere). See
  // docs/plans/260606_bug-report-data-quality/subagent_reports/260606_arbitrator-privacy-synthesis.md
  delete redacted.server_name;

  if (typeof redacted.message === 'string') {
    redacted.message = redactSensitiveString(redacted.message);
  }
  if (redacted.extra) {
    redacted.extra = redactObjectDeep(redacted.extra);
  }
  if (redacted.request) {
    const request = redactObjectDeep(redacted.request) as Record<string, unknown>;
    if (request.cookies && typeof request.cookies === 'object') {
      request.cookies = Object.fromEntries(
        Object.keys(request.cookies as Record<string, unknown>).map((key) => [key, REDACTED_TEXT]),
      );
    }
    redacted.request = request;
  }
  if (redacted.contexts) {
    redacted.contexts = redactObjectDeep(redacted.contexts);
  }
  if (redacted.user) {
    const user = redacted.user as Record<string, unknown>;
    // Preserve standard Sentry identity fields for reporter identification (see 93b8a58fc).
    // These bypass redactObjectDeep to avoid the blanket EMAIL_ADDRESS_REGEX destroying the value.
    redacted.user = Object.fromEntries(
      Object.entries(user).map(([key, value]) =>
        SENTRY_USER_IDENTITY_FIELDS.has(key) ? [key, value] : [key, REDACTED_TEXT]
      ),
    );
  }
  if (redacted.breadcrumbs) {
    redacted.breadcrumbs = redactObjectDeep(redacted.breadcrumbs);
  }
  if (exception?.values) {
    redacted.exception = {
      ...exception,
      values: exception.values.map((value) => ({
        ...value,
        value: typeof value.value === 'string' ? redactSensitiveString(value.value) : value.value,
        stacktrace: value.stacktrace ? redactObjectDeep(value.stacktrace) : value.stacktrace,
      })),
    };
  }

  const wellFormed = ensureWellFormedDeep(redacted);
  if (wellFormed.replacementCount > 0) {
    const replacementSummary = summarizeWellFormedReplacementPaths(wellFormed.replacementPaths);
    options.onWellFormedFix?.({
      replacementCount: wellFormed.replacementCount,
      replacementPaths: replacementSummary.replacementPaths,
      omittedPathCount: replacementSummary.omittedPathCount,
    });
  }

  return wellFormed.value as T;
}
