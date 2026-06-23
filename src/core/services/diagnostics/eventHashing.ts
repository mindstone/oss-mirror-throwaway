/**
 * Diagnostic-events hashing helpers.
 *
 * Used by emit sites that need to capture an opaque, redaction-safe identifier
 * for a tool name or account slug. We truncate SHA-256 to 16
 * hex characters (64 bits) — sufficient diagnostic correlation without retaining
 * the underlying tenant/workspace/email information.
 *
 * Collision math: 64-bit truncated hashes hit ~50% collision probability around
 * 2^32 (~5.05 billion) distinct values. For a single-installation diagnostic
 * window this is comfortably above any plausible cardinality.
 *
 * Boundary placement: lives in `@core` because all callers are core-tier
 * (`agentLoop`, `oauthRefreshFailureStore`).
 * `node:crypto` is already used elsewhere in `@core` (`safety/hashUtils.ts`,
 * `services/indexHealthService.ts`, `services/spaceMaintenanceService.ts`),
 * and none of these reach the React Native mobile bundle.
 */

import crypto from 'node:crypto';

/** SHA-256 truncated to 16 hex (64-bit). Empty/undefined → empty string. */
function hashTruncated16(input: string): string {
  if (!input) return '';
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex').slice(0, 16);
}

/** Hash a tool name for `tool_call_error.data.toolNameHash`. */
export function hashToolName(name: string): string {
  return hashTruncated16(name);
}

/** Hash an account slug for `auth_event.data.accountSlugHash`. */
export function hashAccountSlug(slug: string): string {
  return hashTruncated16(slug);
}

/** Hash a health check ID for `health_check_timing.data.checkIdHash`. */
export function hashHealthCheckId(id: string): string {
  return hashTruncated16(id);
}
