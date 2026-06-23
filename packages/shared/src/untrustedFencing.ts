/**
 * Shared security primitives for fencing untrusted content inside LLM
 * prompts.
 *
 * Both {@link conversationalResolutionPrompt} (the mobile "Resolve with
 * Rebel" conflict-resolution seed) and
 * {@link conversationalPublishMessage} (the desktop instruction-driven
 * publish flow) take user / file content that MAY contain adversarial
 * text — `<!-- IGNORE PREVIOUS INSTRUCTIONS -->`, injected fence
 * markers, multi-line injection payloads, etc. — and have to splice it
 * into a prompt that the agent will execute.
 *
 * Rather than duplicate the hardening logic in both builders (and risk
 * one drifting from the other), the four primitives used by both modules
 * live here:
 *
 * 1. {@link generateFenceNonce} — 32-char hex nonce (128 bits) so the
 *    fence sentinel the builder chooses is unpredictable to an attacker
 *    who only sees the delivered prompt.
 * 2. {@link truncateUtf8Safe} — byte-accurate UTF-8 truncation that never
 *    splits a surrogate pair. The truncation marker is included in the
 *    cap so the final body never exceeds the configured byte limit.
 * 3. {@link sanitizeMetadata} — strips control characters / line
 *    separators and length-caps identity metadata (file paths, space
 *    names, user instructions) so a newline-based injection payload
 *    cannot escape the single-line metadata channel.
 * 4. {@link FenceCollisionError} — fail-loud error thrown when
 *    untrusted content literally contains the generated fence end-marker
 *    (astronomically unlikely at 128 bits, but we refuse to silently
 *    emit a prompt where the attacker controls what closes the fence).
 *
 * These helpers are stateless, runtime-agnostic, and heavily tested in
 * `__tests__/untrustedFencing.test.ts` — every downstream builder gets
 * the security properties for free.
 */

// ---------------------------------------------------------------------------
// Nonce generation — cryptographically-random when available
// ---------------------------------------------------------------------------

/**
 * Generate a 32-character hex nonce (16 random bytes) so fence sentinels
 * like `<<<UNTRUSTED_STAGED_${nonce}>>>` are infeasible for an attacker
 * to predict. Prefers `crypto.getRandomValues` (available in Node ≥19,
 * modern browsers, and React Native 0.76+); falls back to a
 * `Math.random`-chained hex string so `@rebel/shared` remains
 * runtime-agnostic. Even the fallback gives >128 bits of uncertainty to
 * an attacker who can't observe generation — vastly more than the
 * practical collision threshold.
 */
export function generateFenceNonce(): string {
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }
  // Fallback: concatenate multiple Math.random() draws. 32 hex chars => 128 bits.
  let out = '';
  while (out.length < 32) {
    out += Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  }
  return out.slice(0, 32);
}

// ---------------------------------------------------------------------------
// UTF-8 byte-accurate truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a string so that (truncated body + `marker`) is at most
 * `limit` UTF-8 bytes. Returns the unchanged input when the entire
 * string already fits within the cap. Uses `TextEncoder` so
 * multi-byte code points (non-ASCII) count correctly — a naive
 * `value.length <= limit` comparison would MISS non-ASCII strings whose
 * UTF-16 code-unit count is below the cap but whose UTF-8 byte length
 * exceeds it. The slow path binary-searches the longest code-point
 * prefix whose encoded length plus the marker's bytes fits under the
 * cap, so surrogate pairs never split.
 *
 * @param value   Untrusted string to truncate.
 * @param limit   Maximum total UTF-8 byte length for the returned
 *                string (body + marker, when truncated). Values that are
 *                not finite or ≤ 0 short-circuit and return the input
 *                verbatim.
 * @param marker  String appended at the end of a truncated body so the
 *                agent can see content was clipped. Typically something
 *                like `"\n[…truncated by approval UI…]"`.
 */
export function truncateUtf8Safe(value: string, limit: number, marker: string): string {
  if (!Number.isFinite(limit) || limit <= 0) return value;

  const encoder = new TextEncoder();

  // Byte-accurate fast path. `value.length` counts UTF-16 code units so
  // we cannot use it as a cheap proxy for byte length.
  const fullByteLength = encoder.encode(value).byteLength;
  if (fullByteLength <= limit) return value;

  const markerByteLength = encoder.encode(marker).byteLength;

  // If the limit is smaller than the truncation marker itself, emit the
  // marker clipped to fit. This should never happen in production (e.g.
  // limit < ~35) but keeps the invariant "final output bytes ≤ limit"
  // honest for pathological tests / misconfiguration.
  if (markerByteLength >= limit) {
    const encoded = encoder.encode(marker);
    return new TextDecoder().decode(encoded.slice(0, Math.max(0, limit)));
  }

  // Binary-search the longest code-point prefix whose encoded bytes +
  // the marker's bytes fit within the cap. Operating on
  // `Array.from(value)` yields an iterator view over code points, so we
  // never slice through a surrogate pair.
  const budget = limit - markerByteLength;
  const codepoints = Array.from(value);
  let lo = 0;
  let hi = codepoints.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = codepoints.slice(0, mid).join('');
    const size = encoder.encode(candidate).byteLength;
    if (size <= budget) lo = mid;
    else hi = mid - 1;
  }

  const truncatedBody = codepoints.slice(0, lo).join('');
  return `${truncatedBody}${marker}`;
}

// ---------------------------------------------------------------------------
// Metadata sanitization
// ---------------------------------------------------------------------------

/** Default cap for sanitized metadata (paths / space names). */
export const DEFAULT_METADATA_MAX_LENGTH = 256;

/**
 * Strip control characters, replace any newline / tab sequence with a
 * single space, collapse runs of whitespace, and cap at `maxLength`
 * code points. The IPC schema only guarantees `z.string()`, so builders
 * must treat identity metadata (space names, paths, user instructions)
 * as untrusted — a multi-line injection payload would otherwise escape
 * the single-line metadata channel and appear as plain prompt text.
 *
 * @param value     The untrusted metadata string.
 * @param maxLength Maximum number of code points in the returned string
 *                  (before the ellipsis suffix). Defaults to
 *                  {@link DEFAULT_METADATA_MAX_LENGTH}.
 */
export function sanitizeMetadata(value: string, maxLength: number = DEFAULT_METADATA_MAX_LENGTH): string {
  const normalized = value
    // Strip C0 + C1 controls AND the Unicode line-separator code points.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the randomly-generated nonce fence sentinel happens to
 * collide with literal content inside an untrusted body. The caller
 * should retry the builder (which will generate a fresh nonce); a
 * retried collision is astronomically unlikely at 128 bits of nonce
 * entropy.
 */
export class FenceCollisionError extends Error {
  constructor(public readonly marker: string) {
    super(`Fence collision: untrusted content contains the generated fence marker "${marker}".`);
    this.name = 'FenceCollisionError';
  }
}
