/**
 * Calendar sync attempt tracker (Stage 3, 260611_calendar-followups).
 *
 * Session-scoped, in-memory (research option B1): `populatedAt` persists
 * across restarts, so the health check's populatedAt-null branch only ever
 * fires on a fresh profile or a wiped cache — exactly where "has this
 * session attempted a sync yet?" is the right disambiguator. A persisted
 * timestamp (B2) would add nothing over `populatedAt` itself.
 *
 * The flag is set at attempt START (not completion), so an attempted sync
 * that throws before the cache write still reads as attempted → the health
 * check's warn is preserved for that true-positive shape (a thrown direct
 * sync never calls `recordSyncError`; attempted-but-null is the only signal
 * for it).
 *
 * TIME BOUND (binding amendment [RS]): the fresh-profile suppression is
 * honoured only within `FRESH_PROFILE_SUPPRESSION_WINDOW_MS` of this
 * module's load (≈ main-process boot: the tracker is imported by the sync
 * writers and the health check, all loaded at startup). Why 5 minutes:
 * direct sync is scheduled at boot+30s and marks at attempt start, so any
 * working scheduler marks well inside the bound even on a slow boot; the
 * renderer health poll fires at +10s then every 180s, so with a 300s bound
 * a wedged never-attempting scheduler surfaces at the +370s poll (~6 min) —
 * exactly one steady-state poll cycle past the bound. A sub-cadence bound
 * (<190s) could false-warn while racing a slow first sync; an unbounded
 * suppression would let a wedged scheduler read as healthy forever.
 */

export const FRESH_PROFILE_SUPPRESSION_WINDOW_MS = 5 * 60 * 1000;

let trackerStartedAt = Date.now();
let attempted = false;

/** Mark that a calendar sync (direct or LLM-bridge) has been attempted this session. */
export function markCalendarSyncAttempted(): void {
  attempted = true;
}

export function hasCalendarSyncBeenAttempted(): boolean {
  return attempted;
}

/**
 * True while the fresh-profile suppression window is still open (bounded —
 * see module doc). Past the bound, a never-attempted sync must surface.
 */
export function isWithinFreshProfileSuppressionWindow(now: number = Date.now()): boolean {
  return now - trackerStartedAt < FRESH_PROFILE_SUPPRESSION_WINDOW_MS;
}

/** Test seam: reset the session flag and (optionally) backdate the tracker start. */
export function resetCalendarSyncAttemptTrackerForTesting(startedAt: number = Date.now()): void {
  trackerStartedAt = startedAt;
  attempted = false;
}
