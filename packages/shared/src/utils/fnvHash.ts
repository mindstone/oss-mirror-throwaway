/**
 * FNV-1a 32-bit hash helpers for short breadcrumb identifiers.
 *
 * Deterministic. **Not cryptographic.** Used to obscure raw session/turn IDs
 * in Sentry breadcrumbs while preserving groupability within a session.
 *
 * **Output format is intent-critical.** Sentry breadcrumbs are cross-referenced
 * by these short hashes across releases — changing the format silently breaks
 * cross-release correlation. Both formatters preserve their original bodies
 * verbatim, including the no-op `.slice(0, 8)` in `fnvHashBase36` (a 32-bit
 * unsigned value's base-36 representation is at most 7 characters, so the
 * slice is redundant but kept as bit-identity insurance against future
 * "tidy-ups").
 *
 * Single source of truth — replaces previously-duplicated implementations in:
 *   - cloud-client/src/observability/continuityEvents.ts (exported)
 *   - src/core/services/sessionMutex.ts (file-private)
 *   - src/main/services/cloud/cloudOutbox.ts (file-private)
 *   - src/main/services/cloud/cloudContinuityMetadata.ts (file-private)
 *   - cloud-service/src/routes/diagnostics.ts (file-private, hex variant)
 *   - src/main/services/logExportService.ts (file-private, hex variant)
 *   - src/main/services/bugReportDiagnosticService.ts (file-private, hex)
 *   - packages/browser-extension/src/lib/chatScope.ts (file-private, hex)
 *
 * See planning doc: docs/plans/260501_fnv_hash_centralization.md
 */

function fnvHash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * FNV-1a 32-bit hash, formatted as base-36 with `padStart(7, '0').slice(0, 8)`.
 *
 * Output is **always exactly 7 characters** for a 32-bit unsigned hash:
 * `(2^32 - 1).toString(36) === '1z141z3'` (length 7). The trailing `.slice(0, 8)`
 * is preserved verbatim from the original implementation as bit-identity
 * insurance — do not remove it.
 */
export function fnvHashBase36(input: string): string {
  return fnvHash32(input).toString(36).padStart(7, '0').slice(0, 8);
}

/**
 * FNV-1a 32-bit hash, formatted as zero-padded hex.
 *
 * Output is **always exactly 8 characters** for a 32-bit unsigned hash.
 */
export function fnvHashHex(input: string): string {
  return fnvHash32(input).toString(16).padStart(8, '0');
}
