---
description: "Calendar cache sync failure debounce — consecutive-failure streak before health/toast surfaces, plus honest network-blip copy"
last_updated: "2026-06-18"
---

# Calendar sync failure debounce

## Intent

A single transient calendar-sync failure (momentary network/DNS blip that recovers on the next ~15‑minute tick) must **not** flip the user into "Calendar Cache needs attention" with connection-blame copy. Only **sustained** failure should surface. Network-shaped failures get honest retrying copy instead of implying the user must fix a connection.

## Mechanism (overview)

An in-memory, session-scoped **consecutive-failure streak** is shared by the two calendar-cache write paths. Failure-class sync issues and hard sync errors are withheld until the streak reaches **`FAILURE_SURFACE_THRESHOLD` (2)** — i.e. two consecutive failed syncs. A failure-free write resets the streak to zero. Informational issue kinds (`validation_skipped`, `bridge_reported`) are never suppressed.

Reset-on-restart is intentional: a fresh launch starts clean; a genuinely sustained problem re-accrues within one extra sync interval.

## Code signposts

| Area | Location |
|------|----------|
| Streak counter + threshold | `src/core/services/calendarSyncFailureStreak.ts` — `recordCalendarSyncFailure()`, `recordCalendarSyncSuccess()`, `shouldSurfaceCalendarSyncFailures()`, `isFailureClassSyncIssue()` |
| Cache write chokepoints | `src/core/services/meetingCacheStore.ts` — `setCachedMeetings()`, `recordSyncError()` |
| Direct sync caller | `src/main/services/directCalendarSync.ts` |
| LLM-bridge sync caller | `src/core/services/inbox/inboxBridgeStateMachine.ts` |
| Auxiliary hard-fail path | `src/core/services/calendarSyncService.ts` |
| Health check + user copy | `src/main/services/health/checks/calendar.ts` — classifies `cause: 'network'` and uses "couldn't reach your calendar… retrying" copy instead of connection-blame for transient network failures |

## Related docs

- [UI_CONVERSATIONS.md](UI_CONVERSATIONS.md) — conversation UI hub (signposts here)
- Calendar IPC / sync-issue shapes: `src/shared/ipc/channels/calendar.ts` (`SyncIssue`, `makeSyncIssue`)
