/**
 * Pure derivation functions for contribution notifications.
 *
 * Extracts the banner/drawer status sets and helper functions from
 * useContributionNotifications so they can be shared across renderer hooks
 * and cross-integration tests without importing from @renderer/.
 *
 * Platform-agnostic — no React or Electron imports.
 *
 * @see src/renderer/features/homepage/hooks/useContributionNotifications.ts
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P6)
 */

// ─── Notification Types ─────────────────────────────────────────────

/**
 * MCPNotificationCard visual state.
 * Mirrors the type from MCPNotificationCard.tsx without React dependency.
 */
export type MCPNotificationState =
  | 'ci-pass'
  | 'ci-fail'
  | 'approved'
  | 'changes-requested'
  | 'rejected';

/** Minimal contribution record shape for derivation functions. */
export interface NotificationContributionRecord {
  acknowledgedEvents: Array<{
    status: string;
    surface: string;
    at: string;
  }>;
}

// ─── Status Sets ────────────────────────────────────────────────────

/** Statuses that should trigger a notification in the drawer. */
export const DRAWER_NOTIFICATION_STATUSES = new Set([
  'ci_pass',
  'ci_fail',
  'approved',
  'changes_requested',
  'rejected',
]);

/** Statuses that should trigger the banner on the homepage. */
export const BANNER_STATUSES = new Set(['approved', 'published']);

// ─── Derivation Functions ───────────────────────────────────────────

/** Maps contribution status to MCPNotificationCard state. */
export function toNotificationState(status: string): MCPNotificationState | null {
  switch (status) {
    case 'ci_pass':
      return 'ci-pass';
    case 'ci_fail':
      return 'ci-fail';
    case 'approved':
      return 'approved';
    case 'changes_requested':
      return 'changes-requested';
    case 'rejected':
      return 'rejected';
    default:
      return null;
  }
}

/** Check if a specific event has been acknowledged on a specific surface. */
export function isAcknowledged(
  contribution: NotificationContributionRecord,
  status: string,
  surface: 'banner' | 'drawer',
): boolean {
  return contribution.acknowledgedEvents.some(
    (e) => e.status === status && e.surface === surface,
  );
}
