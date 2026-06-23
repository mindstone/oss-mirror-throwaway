/**
 * Shared, non-reversible telemetry hash (mobile).
 *
 * ONE hash helper for both telemetry streams — Sentry (`mobile/src/utils/sentry.ts`)
 * and analytics (`mobile/src/analytics/redaction.ts`). Previously each stream had
 * its own djb2 copy with a DIFFERENT prefix (`cloud_` vs `h_`), so the same cloud
 * URL produced two different tokens — defeating the stated goal that the same
 * input yields the SAME token across Sentry + analytics (DA #2). This module is
 * the single source of truth: both streams call it, so a given input always maps
 * to one token regardless of which stream emits it.
 *
 * The hash is a cheap djb2 variant. It is deliberately NOT cryptographic — its
 * only job is to turn an identifier (cloud URL, session id) into a stable,
 * low-cardinality, non-reversible correlation token so telemetry can group
 * events without ever carrying the raw identifier.
 */

const TELEMETRY_HASH_PREFIX = 'h_';

/**
 * Stable, non-reversible token for telemetry identifiers (cloud URLs, session
 * ids). The SAME input always yields the SAME token across every telemetry
 * stream, because every stream routes through this one function.
 */
export function telemetryHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `${TELEMETRY_HASH_PREFIX}${Math.abs(hash).toString(36)}`;
}
