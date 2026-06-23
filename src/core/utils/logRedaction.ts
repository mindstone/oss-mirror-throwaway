/**
 * Log Redaction Utilities
 *
 * Provides functions for redacting sensitive data from logs before sending to Sentry
 * or exporting for diagnostics. Used by both logExportService and Sentry hooks.
 */

import { SENSITIVE_ENV_VAR_PATTERNS } from '../services/diagnostics/manifest';
import {
  ANTHROPIC_API_KEY_REGEX,
  BEARER_TOKEN_REGEX,
  EMAIL_ADDRESS_REGEX,
  ELEVENLABS_API_KEY_JSON_REGEX,
  GENERIC_JSON_SECRET_REGEX,
  LINUX_HOME_DIRECTORY_REGEX,
  MACOS_HOME_DIRECTORY_REGEX,
  OPENAI_API_KEY_REGEX,
  SENSITIVE_KEY_NAME_PATTERNS,
  SENSITIVE_URL_PARAM_PATTERNS,
  WINDOWS_HOME_DIRECTORY_REGEX,
  isSensitiveKeyName,
} from '@shared/utils/redactionPatterns';

/**
 * Patterns that match sensitive key names for deep redaction.
 * Derived from the shared key-name SSOT; add new secret key names in
 * @shared/utils/redactionPatterns.ts so logs, Sentry, and cloud settings stay
 * aligned.
 */
export const SENSITIVE_KEY_PATTERNS: RegExp[] = [...SENSITIVE_KEY_NAME_PATTERNS];

const MAX_REDACTION_DEPTH = 20;

/**
 * Check if a string contains sensitive URL parameters and redact them inline.
 */
function redactUrlParamsInString(value: string): string {
  let result = value;
  for (const { pattern, replacement } of SENSITIVE_URL_PARAM_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Check if a string looks like it may contain URL parameters or basic auth worth checking.
 * This is a quick check to avoid running all regexes on every string.
 */
function mayContainUrlParams(value: string): boolean {
  // Check for basic auth in URLs (e.g., https://user:pass@domain)
  if (value.includes('://') && value.includes('@')) {
    return true;
  }
  // Check for common URL parameter indicators
  return (
    value.includes('=') &&
    (value.includes('strata_id') || // Legacy: Klavis removed in v1.x
      value.includes('bearer') ||
      value.includes('access_token') ||
      value.includes('refresh_token') ||
      value.includes('api_key') ||
      value.includes('apikey') ||
      value.includes('token=') ||
      value.includes('secret=') ||
      value.includes('?') ||
      value.includes('&'))
  );
}

/**
 * Deeply redact sensitive fields from an object by key pattern.
 * Also redacts sensitive URL parameters found within string values.
 * Creates a deep copy to avoid mutating the original.
 *
 * @param obj - The object to redact (will not be mutated)
 * @returns A deep copy with sensitive fields redacted
 */
export function redactObjectDeep(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  // Create deep copy to avoid mutating original
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(obj));
  } catch {
    // If JSON serialization fails, return as-is (likely circular reference)
    return obj;
  }

  const redactRecursive = (current: unknown, depth: number): unknown => {
    // Prevent infinite recursion
    if (depth > MAX_REDACTION_DEPTH) return current;

    if (current === null || current === undefined) return current;

    // Handle string values - check for URL params
    if (typeof current === 'string') {
      if (mayContainUrlParams(current)) {
        return redactUrlParamsInString(current);
      }
      return current;
    }

    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        current[i] = redactRecursive(current[i], depth + 1);
      }
      return current;
    }

    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const value = record[key];

        const isSensitive = isSensitiveKeyName(key);

        if (isSensitive && value !== null && value !== undefined && value !== '') {
          record[key] = '***REDACTED***';
        } else {
          // Recursively process the value (handles objects, arrays, and strings)
          record[key] = redactRecursive(value, depth + 1);
        }
      }
    }

    return current;
  };

  redactRecursive(copy, 0);
  return copy;
}

/**
 * Apply URL parameter redaction to a string.
 */
export function redactUrlParams(content: string): string {
  let result = content;
  for (const { pattern, replacement } of SENSITIVE_URL_PARAM_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Redact sensitive data from log content string.
 * Removes API keys, email addresses, URL params, and normalizes user paths.
 */
export function redactSensitiveData(content: string): string {
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
      .replace(EMAIL_ADDRESS_REGEX, '***@***.***')
      // Redact Bearer tokens (JWTs, OAuth tokens) — defense-in-depth for header leaks
      .replace(BEARER_TOKEN_REGEX, 'Bearer ***REDACTED***')
  );
}

// =============================================================================
// Enhanced Redaction Functions for Diagnostic Bundle
// =============================================================================

/**
 * Normalize user home directory paths in a string.
 * Converts platform-specific user paths to `~`.
 */
export function normalizeUserPaths(content: string): string {
  return (
    content
      // macOS: /Users/username/...
      .replace(MACOS_HOME_DIRECTORY_REGEX, '~')
      // Linux: /home/username/...
      .replace(LINUX_HOME_DIRECTORY_REGEX, '~')
      // Windows: C:\Users\username\... (handles spaces in username)
      .replace(WINDOWS_HOME_DIRECTORY_REGEX, '~')
  );
}

/**
 * Redact Chief of Staff README content (system prompt).
 * Removes user-specific personal information while keeping the structure intact.
 *
 * @param content - The raw Chief of Staff README content
 * @returns Sanitized content with personal info removed
 */
export function redactChiefOfStaffReadme(content: string): string {
  return (
    content
      // Redact email addresses
      .replace(EMAIL_ADDRESS_REGEX, '***@***.***')
      // Normalize user paths
      .replace(MACOS_HOME_DIRECTORY_REGEX, '~')
      .replace(LINUX_HOME_DIRECTORY_REGEX, '~')
      .replace(WINDOWS_HOME_DIRECTORY_REGEX, '~')
      // Redact potential user names that might appear after "Name:" or similar patterns
      // This catches patterns like "Name: John Doe" or "User: alice"
      .replace(/(Name|User|Owner|Author):\s*([^\n,;]+)/gi, '$1: [REDACTED]')
      // Redact phone numbers (various formats)
      .replace(/\+?[\d\s\-().]{10,}/g, (match) => {
        // Only redact if it looks like a phone number (has enough digits)
        const digits = match.replace(/\D/g, '');
        if (digits.length >= 7) {
          return '[PHONE REDACTED]';
        }
        return match;
      })
  );
}

/**
 * Redact Sentry scope data for diagnostic export.
 * Removes user email and PII while keeping breadcrumbs and error context.
 *
 * @param scope - The raw Sentry scope object (typically from scope_v3.json)
 * @returns Sanitized scope with PII removed
 */
export function redactSentryScope(scope: unknown): unknown {
  if (scope === null || scope === undefined) return scope;
  if (typeof scope !== 'object') return scope;

  // Create deep copy to avoid mutating original
  let copy: Record<string, unknown>;
  try {
    copy = JSON.parse(JSON.stringify(scope));
  } catch {
    return scope;
  }

  // Remove user email and other user PII
  if (copy.user && typeof copy.user === 'object') {
    const user = copy.user as Record<string, unknown>;
    if (user.email) {
      user.email = '***@***.***';
    }
    if (user.username) {
      user.username = '[REDACTED]';
    }
    if (user.name) {
      user.name = '[REDACTED]';
    }
  }

  // Redact breadcrumb data that might contain secrets
  if (Array.isArray(copy.breadcrumbs)) {
    copy.breadcrumbs = copy.breadcrumbs.map((breadcrumb: unknown) => {
      if (typeof breadcrumb !== 'object' || breadcrumb === null) return breadcrumb;
      const bc = breadcrumb as Record<string, unknown>;

      // Redact message content
      if (typeof bc.message === 'string') {
        bc.message = redactSensitiveData(bc.message);
      }

      // Redact data object
      if (bc.data && typeof bc.data === 'object') {
        bc.data = redactObjectDeep(bc.data);
      }

      return bc;
    });
  }

  // Redact any extra context that might contain sensitive data
  if (copy.extra && typeof copy.extra === 'object') {
    copy.extra = redactObjectDeep(copy.extra);
  }

  // Redact contexts
  if (copy.contexts && typeof copy.contexts === 'object') {
    copy.contexts = redactObjectDeep(copy.contexts);
  }

  // Redact tags that might contain sensitive info
  if (copy.tags && typeof copy.tags === 'object') {
    const tags = copy.tags as Record<string, unknown>;
    for (const key of Object.keys(tags)) {
      if (typeof tags[key] === 'string') {
        // Normalize paths in tag values
        tags[key] = normalizeUserPaths(tags[key] as string);
      }
    }
  }

  return copy;
}

/**
 * Redact environment variables in MCP configuration.
 * Uses SENSITIVE_ENV_VAR_PATTERNS to identify and redact sensitive values.
 *
 * @param config - The raw MCP configuration object
 * @returns Sanitized config with sensitive env vars redacted
 */
export function redactMcpEnvVars(config: unknown): unknown {
  if (config === null || config === undefined) return config;
  if (typeof config !== 'object') return config;

  // Create deep copy
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(config));
  } catch {
    return config;
  }

  /**
   * Recursively process objects to find and redact env vars
   */
  function processEnvVars(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;

    if (Array.isArray(obj)) {
      return obj.map(processEnvVars);
    }

    if (typeof obj === 'object') {
      const record = obj as Record<string, unknown>;

      // Check if this is an env object (common MCP pattern)
      if (record.env && typeof record.env === 'object') {
        const envObj = record.env as Record<string, unknown>;
        for (const key of Object.keys(envObj)) {
          // Check if the key matches any sensitive pattern
          const isSensitive = SENSITIVE_ENV_VAR_PATTERNS.some((pattern) => pattern.test(key));
          if (isSensitive && typeof envObj[key] === 'string' && envObj[key] !== '') {
            envObj[key] = '***REDACTED***';
          }
        }
      }

      // Recursively process all values
      for (const key of Object.keys(record)) {
        if (key !== 'env') {
          record[key] = processEnvVars(record[key]);
        }
      }
    }

    return obj;
  }

  // Also apply general redaction for API keys etc.
  return redactObjectDeep(processEnvVars(copy));
}

/**
 * Sanitize any JSON object for export in diagnostic bundle.
 * This is the "final pass" that applies path normalization and
 * sensitive data redaction recursively to any object.
 *
 * @param obj - Any object to sanitize
 * @returns Sanitized object safe for diagnostic export
 */
export function sanitizeJsonForExport(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  // Create deep copy
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(obj));
  } catch {
    return obj;
  }

  /**
   * Recursively process all string values
   */
  function sanitizeRecursive(current: unknown, depth: number): unknown {
    // Prevent infinite recursion
    if (depth > MAX_REDACTION_DEPTH) return current;

    if (current === null || current === undefined) return current;

    // Handle string values - apply all string-based redactions
    if (typeof current === 'string') {
      let result = current;
      // Normalize paths
      result = normalizeUserPaths(result);
      // Redact emails
      result = result.replace(EMAIL_ADDRESS_REGEX, '***@***.***');
      // Redact API keys (Anthropic, OpenAI, Groq, Google)
      result = result.replace(ANTHROPIC_API_KEY_REGEX, 'sk-ant-***REDACTED***');
      result = result.replace(OPENAI_API_KEY_REGEX, 'sk-***REDACTED***');
      result = result.replace(/gsk_[a-zA-Z0-9]+/g, 'gsk_***REDACTED***');
      result = result.replace(/AIza[a-zA-Z0-9_-]{35}/g, 'AIza***REDACTED***');
      // Redact URL params if applicable
      if (mayContainUrlParams(result)) {
        result = redactUrlParamsInString(result);
      }
      return result;
    }

    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        current[i] = sanitizeRecursive(current[i], depth + 1);
      }
      return current;
    }

    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const value = record[key];

        const isSensitive = isSensitiveKeyName(key);

        if (isSensitive && value !== null && value !== undefined && value !== '') {
          record[key] = '***REDACTED***';
        } else {
          record[key] = sanitizeRecursive(value, depth + 1);
        }
      }
    }

    return current;
  }

  return sanitizeRecursive(copy, 0);
}

// =============================================================================
// Credential Detection for Secret Gate
// =============================================================================

/**
 * Result of credential pattern detection.
 * `reasons` contains category labels only — never matched content.
 */
export interface CredentialDetectionResult {
  detected: boolean;
  reasons: string[];
}

/**
 * Pre-compiled credential value patterns.
 * Each checks for actual credential VALUES (not key names) — distinct from
 * SENSITIVE_KEY_PATTERNS which match object key names during redaction.
 * Order matters: more-specific patterns (e.g. Anthropic) before general (e.g. OpenAI).
 */
const CREDENTIAL_VALUE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bsk-ant-[a-zA-Z0-9_-]+/, label: 'anthropic_api_key' },
  { pattern: /\bsk_(live|test)_[a-zA-Z0-9]{20,}/, label: 'stripe_api_key' },
  { pattern: /\bsk-[a-zA-Z0-9_-]{20,}/, label: 'openai_api_key' },
  { pattern: /\bgsk_[a-zA-Z0-9]+/, label: 'groq_api_key' },
  { pattern: /\bAIza[a-zA-Z0-9_-]{35}/, label: 'google_api_key' },
  { pattern: /\bxi-[a-zA-Z0-9_-]{20,}/, label: 'elevenlabs_api_key' },
  { pattern: /\bghp_[a-zA-Z0-9]{36}/, label: 'github_pat' },
  { pattern: /\bglpat-[a-zA-Z0-9_-]{20,}/, label: 'gitlab_pat' },
  { pattern: /\bAKIA[A-Z0-9]{16}/, label: 'aws_access_key' },
  { pattern: /\bAC[a-f0-9]{32}/, label: 'twilio_credentials' },
  { pattern: /\bxox[bpsar]-[a-zA-Z0-9-]{10,}/, label: 'slack_token' },
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, label: 'pem_private_key' },
  { pattern: /\bbearer\s+[a-zA-Z0-9_.\-]{20,}/i, label: 'bearer_token' },
];

/**
 * Structural key=value patterns that require dummy-value filtering.
 * Defined with the `g` flag so `exec()` can iterate over all occurrences
 * (avoids missing a real credential when the first match is a placeholder).
 * `valueGroup` is the capture group index for the extractable value,
 * or 0 when mere presence is sufficient (e.g. connection strings).
 */
const STRUCTURAL_CREDENTIAL_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  valueGroup: number;
  label: string;
}> = [
  {
    pattern: /"(password|secret|api_key|token)"\s*:\s*"([^"]*)"/gi,
    valueGroup: 2,
    label: 'json_credential',
  },
  {
    pattern: /\b(API_KEY|SECRET_KEY|PASSWORD|TOKEN)=(\S+)/g,
    valueGroup: 2,
    label: 'env_credential',
  },
  {
    pattern: /(postgres|mysql|mongodb):\/\/[^:]+:[^@]+@/gi,
    valueGroup: 0,
    label: 'connection_string_credential',
  },
];

/** Values that look like placeholders rather than real credentials. */
const DUMMY_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /^your[_-]?api[_-]?key$/i,
  /^x{3,}$/i,
  /^placeholder$/i,
  /^INSERT[_-]?KEY[_-]?HERE$/i,
  /^TODO$/i,
  /^example$/i,
  /^test$/i,
  /^<[^>]+>$/,
  /^\$\{[^}]+\}$/,
  /^\.\.\./,
];

/** Check if a value is a dummy/placeholder rather than a real credential. */
function isDummyValue(value: string): boolean {
  if (value.length < 8) return true;
  return DUMMY_VALUE_PATTERNS.some((p) => p.test(value));
}

/**
 * Detect credential patterns in content for the memory write secret gate.
 *
 * Checks ONLY credential patterns — NOT emails, NOT path normalization.
 * Short-circuits on first match for performance.
 *
 * @param content - The text content to scan for credentials
 * @returns Detection result with category label (never the matched content itself)
 */
export function containsCredentialPatterns(content: string): CredentialDetectionResult {
  const noMatch: CredentialDetectionResult = { detected: false, reasons: [] };

  if (!content) return noMatch;

  // Phase 1: Value-based patterns — high-confidence, no filtering needed
  for (const { pattern, label } of CREDENTIAL_VALUE_PATTERNS) {
    if (pattern.test(content)) {
      return { detected: true, reasons: [label] };
    }
  }

  // Phase 2: Structural key=value patterns — require dummy-value filtering.
  // Uses exec() loop to scan all occurrences (a leading dummy match must not
  // shadow a later real credential in the same content).
  for (const { pattern, valueGroup, label } of STRUCTURAL_CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      // Connection strings: presence alone is sufficient
      if (valueGroup === 0) {
        return { detected: true, reasons: [label] };
      }
      const value = match[valueGroup] ?? '';
      if (!isDummyValue(value)) {
        return { detected: true, reasons: [label] };
      }
    }
  }

  return noMatch;
}
