/**
 * Meeting Cache Store
 *
 * Caches upcoming meetings from calendar MCPs for quick UI access.
 * Populated by hourly headless agent turn, read by The Spark and title bar.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';

// Re-export sentinel + guards from shared (usable from core consumers)
export { SKIPPED_PREP_SENTINEL, isSkippedPrep, hasRealPrepPath, makeSyncIssue } from '@shared/ipc/channels/calendar';
export type { SyncIssue } from '@shared/ipc/channels/calendar';
import { SKIPPED_PREP_SENTINEL, hasRealPrepPath, scrubSyncDetailText, type SyncIssue } from '@shared/ipc/channels/calendar';
import {
  isFailureClassSyncIssue,
  recordCalendarSyncFailure,
  recordCalendarSyncSuccess,
  shouldSurfaceCalendarSyncFailures,
  getCalendarSyncFailureStreak,
} from '@core/services/calendarSyncFailureStreak';

const log = createScopedLogger({ service: 'meetingCache' });

/**
 * Re-apply skip state to a meetings array using persisted skip settings.
 * Called after sync replaces the cache to restore skip sentinels.
 */
export function reapplySkipState(
  meetings: CachedMeeting[],
  skippedMeetingIds: string[],
  prepSkippedTitles: string[],
): CachedMeeting[] {
  if (!skippedMeetingIds.length && !prepSkippedTitles.length) return meetings;

  const idSet = new Set(skippedMeetingIds);
  const titleSet = new Set(prepSkippedTitles.map(t => t.toLowerCase()));

  return meetings.map(m => {
    if (idSet.has(m.id) || titleSet.has(m.title.toLowerCase())) {
      return { ...m, prepPath: SKIPPED_PREP_SENTINEL };
    }
    return m;
  });
}

const MEETING_CACHE_STORE_VERSION = 1;
const CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours (consider stale)

export interface CachedMeeting {
  id: string;
  calendarEventId: string;
  calendarSource: string;
  calendarId?: string;
  title: string;
  startTime: string;
  endTime: string;
  meetingUrl?: string;
  participants: string[];
  participantEmails?: string[];
  prepPath?: string;
  /** Event color ID (1-11 for Google, category colors for Microsoft). */
  colorId?: string;
}

export interface MeetingCache {
  meetings: CachedMeeting[];
  populatedAt: number;
  lastSyncError?: string;
  /**
   * Legacy display-safe warning strings, DERIVED from `syncIssues` via
   * `renderSyncIssue` at write time (kept for unupdated string readers —
   * IPC pass-through, bridge GET, demo mode). Never raw writer strings.
   */
  syncWarnings?: string[];
  /**
   * Typed sync issues — the source of truth (260611_calendar-followups
   * Stage 2). Additive optional field: NO store version bump (Design
   * Call 1); old builds drop it on write and the next sync rewrites it.
   * Written atomically with `syncWarnings` in the same whole-object write.
   */
  syncIssues?: SyncIssue[];
}

type MeetingCacheStoreShape = {
  version: number;
  cache: MeetingCache | null;
};

const createDefaultState = (): MeetingCacheStoreShape => ({
  version: MEETING_CACHE_STORE_VERSION,
  cache: null,
});

let _store: KeyValueStore<MeetingCacheStoreShape> | null = null;
const getStore = () => _store ??= createStore<MeetingCacheStoreShape>({
  name: 'meeting-cache',
  defaults: createDefaultState(),
});

/**
 * Get cached meetings. Returns null if cache doesn't exist.
 */
export function getCachedMeetings(): MeetingCache | null {
  try {
    return getStore().get('cache') ?? null;
  } catch (error) {
    log.warn({ err: error }, 'Failed to read meeting cache');
    return null;
  }
}

/**
 * Check if cache is stale (older than 4 hours).
 */
export function isCacheStale(): boolean {
  const cache = getCachedMeetings();
  if (!cache) return true;
  return Date.now() - cache.populatedAt > CACHE_MAX_AGE_MS;
}

/** Callback to reconcile meetings with history after cache update */
let onCacheUpdatedCallback: ((meetings: CachedMeeting[]) => void) | null = null;

/**
 * Register a callback to be called when the meeting cache is updated.
 * Used by meetingHistoryStore to reconcile calendar meetings with history.
 */
export function onMeetingCacheUpdated(callback: (meetings: CachedMeeting[]) => void): () => void {
  onCacheUpdatedCallback = callback;
  return () => {
    onCacheUpdatedCallback = null;
  };
}

/**
 * Render the display-safe legacy string for a typed sync issue. The ONLY
 * derivation point for `syncWarnings` strings: copy is keyed on `kind` +
 * closed-set `connector` (+ counts); `detail` is diagnostics-only and is
 * NEVER interpolated, so no email/slug can ride a display string by
 * construction. The `<connector>:` prefix keeps the derived strings
 * self-describing for the remaining string readers (IPC pass-through,
 * bridge GET, demo mode) and is always a closed-set base name, never a
 * slug (deep-link preservation, invariant 9).
 */
export function renderSyncIssue(issue: SyncIssue): string {
  switch (issue.kind) {
    case 'auth_transient': {
      const account = issue.accountRef ? `Google account ${issue.accountRef}` : 'Google account';
      return `${issue.connector}: ${account} token refresh is temporarily unavailable; retrying with backoff`;
    }
    case 'calendar_fetch_failed':
      return `${issue.connector}: a calendar could not be fetched during sync`;
    case 'account_sync_failed':
      return `${issue.connector}: account sync failed`;
    case 'bridge_reported':
      return 'A calendar source reported a sync problem';
    case 'validation_skipped':
      return `${issue.count} meeting(s) skipped due to validation errors`;
  }
}

/**
 * Store meetings in cache.
 *
 * `syncIssues` is the typed source of truth; the legacy `syncWarnings`
 * strings are derived from it here and written in the SAME whole-object
 * write (no skew window). `undefined → []` for BOTH representations, so a
 * fully successful sync still overwrites any previous warning set.
 *
 * Writer census note ([GPT-F2/RS-F2]): `recordSyncError` and
 * `updateMeetingPrepPath` below are additional `set('cache', …)` writers —
 * both spread-preserve `...existing`, keeping syncIssues/syncWarnings
 * coherent. Any future cache writer must either spread-preserve or come
 * through this chokepoint.
 *
 * @param source - identifies the caller for diagnostics (e.g. 'direct-sync', 'llm-bridge')
 */
export function setCachedMeetings(meetings: CachedMeeting[], syncIssues?: SyncIssue[], source?: string): void {
  try {
    const existingCache = getStore().get('cache');
    const existingPrepPaths = new Map<string, string>();

    for (const meeting of existingCache?.meetings ?? []) {
      const prepPath = meeting.prepPath;
      if (typeof prepPath === 'string' && hasRealPrepPath(prepPath)) {
        existingPrepPaths.set(meeting.id, prepPath);
      }
    }

    const mergedMeetings = meetings.map(meeting => {
      if (hasRealPrepPath(meeting.prepPath) || meeting.prepPath === SKIPPED_PREP_SENTINEL) {
        return meeting;
      }

      const preservedPrepPath = existingPrepPaths.get(meeting.id);
      return preservedPrepPath ? { ...meeting, prepPath: preservedPrepPath } : meeting;
    });

    const issues = syncIssues ?? [];

    // Debounce transient failures (260617_calendar-cache-transient-debounce):
    // a single failed sync (e.g. a momentary network/DNS blip that recovers on
    // the next ~15-min tick) must not surface a "Calendar Cache needs attention"
    // warning/toast. Track a consecutive-failure streak shared with
    // `recordSyncError` and withhold failure-class issues until the failure is
    // SUSTAINED; informational issues (validation_skipped / bridge_reported)
    // always pass through. A failure-free write resets the streak.
    const hasFailureClass = issues.some(isFailureClassSyncIssue);
    if (hasFailureClass) {
      recordCalendarSyncFailure();
    } else {
      recordCalendarSyncSuccess();
    }
    const persistedIssues = shouldSurfaceCalendarSyncFailures()
      ? issues
      : issues.filter(issue => !isFailureClassSyncIssue(issue));
    const suppressedCount = issues.length - persistedIssues.length;

    const cache: MeetingCache = {
      meetings: mergedMeetings,
      populatedAt: Date.now(),
      lastSyncError: undefined,
      syncIssues: persistedIssues,
      syncWarnings: persistedIssues.map(renderSyncIssue),
    };
    getStore().set('cache', cache);
    if (suppressedCount > 0) {
      // Observable, never silent (CODING_PRINCIPLES "silent failure is a bug"):
      // the failure happened and is being held back deliberately, logged with
      // the running streak so a wedged/sustained problem is traceable.
      log.info(
        { suppressedFailureClass: suppressedCount, streak: getCalendarSyncFailureStreak(), source: source ?? 'unknown' },
        'Calendar sync failure debounced (below surface threshold)',
      );
    }
    log.info({ count: mergedMeetings.length, warnings: persistedIssues.length, source: source ?? 'unknown' }, 'Cached meetings');

    // Notify subscribers (e.g., meeting history store for reconciliation)
    if (onCacheUpdatedCallback) {
      try {
        onCacheUpdatedCallback(mergedMeetings);
      } catch (err) {
        log.warn({ err }, 'Error in meeting cache update callback');
      }
    }
  } catch (error) {
    log.warn({ err: error }, 'Failed to cache meetings');
  }
}

/**
 * Record a sync error without clearing the cache.
 *
 * Write chokepoint scrub (Phase 7, DA-F4): the persisted `lastSyncError`
 * feeds display copy downstream (health-check fail message → toast, IPC
 * pass-through) and raw sync errors can embed emails (e.g. tool-arg
 * validation errors echoing attendee addresses), so the string is scrubbed
 * + capped BEFORE it touches the store or the log.
 */
export function recordSyncError(error: string): void {
  try {
    // Debounce transient failures (260617_calendar-cache-transient-debounce):
    // a hard sync failure (all LLM-bridge retries exhausted) is the SECOND
    // surfacing channel — gate it on the SAME streak as setCachedMeetings so a
    // single transient blip does not flip health to "fail". Below threshold,
    // leave the existing (healthy) cache untouched; the failure is logged, not
    // hidden silently.
    recordCalendarSyncFailure();
    const scrubbedError = scrubSyncDetailText(error);
    if (!shouldSurfaceCalendarSyncFailures()) {
      log.info(
        { streak: getCalendarSyncFailureStreak() },
        'Calendar sync error debounced (below surface threshold); cache left unchanged',
      );
      return;
    }
    const existing = getStore().get('cache');
    if (existing) {
      getStore().set('cache', { ...existing, lastSyncError: scrubbedError });
    } else {
      getStore().set('cache', {
        meetings: [],
        populatedAt: Date.now(),
        lastSyncError: scrubbedError,
      });
    }
    log.warn({ error: scrubbedError }, 'Recorded meeting sync error');
  } catch (err) {
    log.warn({ err }, 'Failed to record sync error');
  }
}

/**
 * Update a specific meeting's prepPath.
 */
export function updateMeetingPrepPath(meetingId: string, prepPath: string): void {
  try {
    const cache = getStore().get('cache');
    if (!cache) {
      log.warn({ meetingId }, 'Cannot update prepPath: no cache exists');
      return;
    }

    const updated = cache.meetings.map(m =>
      m.id === meetingId ? { ...m, prepPath } : m
    );

    getStore().set('cache', { ...cache, meetings: updated });
    log.info({ meetingId, prepPath }, 'Updated meeting prepPath');
  } catch (error) {
    log.warn({ err: error, meetingId }, 'Failed to update meeting prepPath');
  }
}

/**
 * Get today's meetings (for The Spark).
 *
 * @param timeZone - IANA timezone string (e.g. 'Europe/London') for determining
 *                   today's date boundaries in the user's local time.
 */
export function getTodaysMeetings(timeZone: string): CachedMeeting[] {
  const cache = getCachedMeetings();
  if (!cache) return [];

  const now = new Date();
  // Get today's date string in the user's timezone (YYYY-MM-DD format)
  const todayStr = now.toLocaleDateString('en-CA', { timeZone }); // en-CA gives YYYY-MM-DD
  const todayStart = new Date(todayStr + 'T00:00:00').getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;

  return cache.meetings.filter(m => {
    const start = new Date(m.startTime).getTime();
    return start >= todayStart && start < todayEnd;
  }).sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

/**
 * Get meetings within a date range.
 * Used for meeting history reconciliation and range queries.
 */
export function getMeetingsInRange(start: Date, end: Date): CachedMeeting[] {
  const cache = getCachedMeetings();
  if (!cache) return [];

  const startMs = start.getTime();
  const endMs = end.getTime();

  return cache.meetings.filter(m => {
    const meetingStart = new Date(m.startTime).getTime();
    return meetingStart >= startMs && meetingStart <= endMs;
  }).sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

/**
 * Get the cache state for IPC responses.
 */
export function getMeetingCacheState(): {
  populatedAt: number | null;
  lastSyncError?: string;
  syncWarnings?: string[];
  syncIssues?: SyncIssue[];
  isStale: boolean;
} {
  const cache = getCachedMeetings();
  return {
    populatedAt: cache?.populatedAt ?? null,
    lastSyncError: cache?.lastSyncError,
    syncWarnings: cache?.syncWarnings,
    syncIssues: cache?.syncIssues,
    isStale: isCacheStale(),
  };
}
