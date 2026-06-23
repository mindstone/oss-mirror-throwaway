/**
 * Calendar sync failure-debounce streak (260617_calendar-cache-transient-debounce).
 *
 * In-memory, session-scoped consecutive-failure counter shared by the two
 * calendar-cache write paths (`setCachedMeetings` + `recordSyncError` in
 * `meetingCacheStore.ts`). Mirrors the `calendarSyncAttempt.ts` idiom
 * (in-memory, reset-on-restart, test seam).
 *
 * WHY: a single transient calendar-sync failure — e.g. a momentary network /
 * DNS blip that recovers on the next ~15-min tick — must NOT surface a
 * "Calendar Cache needs attention" health warning or toast. Before this gate,
 * one failed sync persisted its issues immediately and the renderer toasted on
 * the pass→warn transition (cold-start suppression only covers the FIRST report
 * of a session, never mid-session transitions). Only a SUSTAINED failure
 * (>= `FAILURE_SURFACE_THRESHOLD` consecutive failed syncs) should surface.
 * See postmortem 260611_calendar_cache_attention_every_launch_toast (residual
 * DA-F2, promoted to a fix here) and docs/plans/260617_calendar-cache-transient-debounce/.
 *
 * RESET-ON-RESTART is intentional: a fresh launch starts the user clean, which
 * also kills the toast-immediately-after-launch case. A genuinely sustained
 * problem re-accrues a streak and surfaces within one extra sync interval.
 *
 * Only the *failure* sync-issue classes drive the streak — `validation_skipped`
 * and `bridge_reported` are informational, not transient network failures, and
 * are never suppressed (`isFailureClassSyncIssue`).
 */

import type { SyncIssue } from '@shared/ipc/channels/calendar';

/** Consecutive failed syncs required before failures surface to health/toast. */
export const FAILURE_SURFACE_THRESHOLD = 2;

/**
 * Sync-issue kinds that represent a (potentially transient) sync FAILURE and
 * are therefore subject to the debounce. `validation_skipped` (meetings
 * dropped for validation) and `bridge_reported` (model-authored warning via
 * the LLM bridge) are informational and excluded.
 */
const FAILURE_CLASS_KINDS: ReadonlySet<SyncIssue['kind']> = new Set([
  'auth_transient',
  'account_sync_failed',
  'calendar_fetch_failed',
]);

/** True if this issue is a debounce-eligible sync failure (not informational). */
export function isFailureClassSyncIssue(issue: SyncIssue): boolean {
  return FAILURE_CLASS_KINDS.has(issue.kind);
}

let consecutiveFailures = 0;

/**
 * Record a failed sync (a cache write that carried a failure-class issue, or a
 * hard `recordSyncError`); returns the new streak count.
 */
export function recordCalendarSyncFailure(): number {
  consecutiveFailures += 1;
  return consecutiveFailures;
}

/** Record a failure-free sync; resets the streak to zero. */
export function recordCalendarSyncSuccess(): void {
  consecutiveFailures = 0;
}

/** Current consecutive-failure count (diagnostics / tests). */
export function getCalendarSyncFailureStreak(): number {
  return consecutiveFailures;
}

/**
 * Whether sync failures should be surfaced to health/toast yet. True once the
 * streak has reached the threshold (sustained failure); false for a single
 * transient blip below it. Call AFTER `recordCalendarSyncFailure()`.
 */
export function shouldSurfaceCalendarSyncFailures(): boolean {
  return consecutiveFailures >= FAILURE_SURFACE_THRESHOLD;
}

/**
 * Test seam: reset the streak between cases. Pass `startAt` to pre-arm the
 * streak (e.g. to `FAILURE_SURFACE_THRESHOLD` so a single failing write
 * surfaces immediately — for tests whose concern is orthogonal to the
 * debounce, like the atomic write / scrub contracts).
 */
export function resetCalendarSyncFailureStreakForTesting(startAt = 0): void {
  consecutiveFailures = startAt;
}
