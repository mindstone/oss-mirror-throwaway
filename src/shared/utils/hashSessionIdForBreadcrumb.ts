/**
 * Short, deterministic hash for telemetry breadcrumbs.
 *
 * Non-cryptographic by design: this is used only to avoid logging raw IDs in
 * breadcrumbs/analytics while preserving rough joinability across events.
 */
export function hashSessionIdForBreadcrumb(sessionId: string): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < sessionId.length; i += 1) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}
