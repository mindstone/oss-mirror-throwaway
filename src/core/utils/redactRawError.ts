/**
 * Redact + truncate a raw upstream error body before it lands on a persisted
 * `AgentEvent.error.rawError` field.
 *
 * Layered on the shared `redactSensitiveData()` helper from
 * `@core/utils/logRedaction` (which already handles `sk-…` / `sk-ant-…`
 * tokens, generic `"api_key": "…"` JSON secrets, ElevenLabs keys, and
 * common URL-param token names) plus four extra patterns we observed in
 * upstream provider 400/401/429 bodies that the existing log redaction
 * does not fully cover:
 *
 *   - `Bearer <token>` (Authorization header form)
 *   - `Authorization: <value>` (entire header line)
 *   - `AIzaSy<...>` (Google API keys, not OpenAI-prefixed)
 *   - JWT-shaped strings `eyJ…\.…\.…`
 *
 * After redaction we truncate to {@link RAW_ERROR_TRUNCATE_BYTES} so the
 * persisted JSON cannot blow up on an oversized provider body.
 *
 * See docs/plans/260429_eval_reliability_judge_panel.md § S2 (review-corrected).
 */

import { redactSensitiveData } from './logRedaction';

/** Hard cap on persisted `rawError` size (bytes ≈ chars for ASCII). */
export const RAW_ERROR_TRUNCATE_BYTES = 4096;

/**
 * Patterns that strip credential-shaped substrings from a raw error body.
 * Order matters: more specific first (Authorization header before bare
 * Bearer token) so the broader pattern doesn't fire inside the redacted
 * span twice.
 *
 * Exported for the dispatcher unit test (`agentEventDispatcherRawError.test.ts`)
 * to assert exactly which patterns fire.
 */
export const RAW_ERROR_REDACTION_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  replacement: string;
}> = [
  // Full `Authorization: <value>` header line — wins over bare-Bearer below.
  // `\S+` rather than `[^\s\n]+` to keep the match tight; case-insensitive.
  { pattern: /Authorization:\s*\S+/gi, replacement: 'Authorization: ***REDACTED***' },
  // Bare `Bearer <token>` (case-insensitive) outside an Authorization header.
  { pattern: /\bBearer\s+[A-Za-z0-9_.\-=+/]+/gi, replacement: 'Bearer ***REDACTED***' },
  // Google API keys (start with AIzaSy + 30+ chars).
  { pattern: /AIzaSy[A-Za-z0-9_\-]{30,}/g, replacement: 'AIza***REDACTED***' },
  // JWT-shaped tokens (header.payload.signature, all base64url-ish).
  {
    pattern: /eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
    replacement: 'eyJ***REDACTED***',
  },
  // `api_key=<value>` outside URL-encoded params (e.g. raw env-style strings).
  // The shared helper handles the URL-param form; this catches the bare form.
  { pattern: /api_key=[A-Za-z0-9_\-]+/gi, replacement: 'api_key=***REDACTED***' },
];

/**
 * Redact secrets and truncate a raw upstream error body for persistence on
 * `AgentEvent.error.rawError`. Returns `undefined` for empty input so callers
 * can spread the result conditionally without an extra branch.
 *
 * Truncation marker uses a newline-prefixed format identical in shape to the
 * eval adapter's truncation marker, so log scrapers see a single recognizable
 * marker pattern across the codebase:
 *
 *   `\n[truncated; original length=<N> bytes]`
 */
export function redactAndTruncateRawError(input: string | undefined): string | undefined {
  if (!input) return undefined;
  // First pass: apply the shared log redactor (sk-/sk-ant-/api_key= URL/email/path).
  // It does additional path normalization, but that's harmless inside an upstream
  // body — provider errors should never contain user paths anyway.
  let redacted = redactSensitiveData(input);
  for (const { pattern, replacement } of RAW_ERROR_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  if (redacted.length <= RAW_ERROR_TRUNCATE_BYTES) {
    return redacted;
  }
  const head = redacted.slice(0, RAW_ERROR_TRUNCATE_BYTES);
  return `${head}\n[truncated; original length=${redacted.length} bytes]`;
}
