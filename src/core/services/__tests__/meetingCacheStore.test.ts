import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let storeData: Record<string, unknown> = {};

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(key: string) { return storeData[key]; },
    set(keyOrObj: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrObj === 'string') {
        storeData[keyOrObj] = value;
      } else {
        Object.assign(storeData, keyOrObj);
      }
    },
    has(key: string) { return key in storeData; },
    delete(key: string) { delete storeData[key]; },
    clear() { storeData = {}; },
    get store() { return storeData; },
    set store(val: Record<string, unknown>) { storeData = val; },
    path: '/mock/path',
  })),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  }),
}));

import { setCachedMeetings, renderSyncIssue, getMeetingCacheState, recordSyncError, updateMeetingPrepPath } from '../meetingCacheStore';
import type { CachedMeeting, MeetingCache } from '../meetingCacheStore';
import { SKIPPED_PREP_SENTINEL, SYNC_ISSUE_DETAIL_MAX_LENGTH, makeSyncIssue, type SyncIssue } from '@shared/ipc/channels/calendar';
import { FAILURE_SURFACE_THRESHOLD, resetCalendarSyncFailureStreakForTesting } from '../calendarSyncFailureStreak';

function makeMeeting(overrides: Partial<CachedMeeting> & { id: string }): CachedMeeting {
  return {
    id: overrides.id,
    calendarEventId: overrides.calendarEventId ?? `${overrides.id}-event`,
    calendarSource: overrides.calendarSource ?? 'google',
    calendarId: overrides.calendarId,
    title: overrides.title ?? 'Test Meeting',
    startTime: overrides.startTime ?? '2026-04-14T09:00:00.000Z',
    endTime: overrides.endTime ?? '2026-04-14T10:00:00.000Z',
    meetingUrl: overrides.meetingUrl,
    participants: overrides.participants ?? ['Alice', 'Bob'],
    participantEmails: overrides.participantEmails,
    prepPath: overrides.prepPath,
    colorId: overrides.colorId,
  };
}

function seedCache(meetings: CachedMeeting[]): void {
  storeData = {
    version: 1,
    cache: {
      meetings,
      populatedAt: Date.now() - 60_000,
      syncWarnings: [],
    } satisfies MeetingCache,
  };
}

function getStoredCache(): MeetingCache {
  return storeData.cache as MeetingCache;
}

describe('meetingCacheStore setCachedMeetings', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T12:00:00.000Z'));
    storeData = {
      version: 1,
      cache: null,
    };
    resetCalendarSyncFailureStreakForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves a real prepPath when replacing the cache with the same meeting id', () => {
    seedCache([makeMeeting({ id: 'meeting-a', prepPath: '/prep/meeting-a.md' })]);

    setCachedMeetings([makeMeeting({ id: 'meeting-a', prepPath: undefined })]);

    expect(getStoredCache().meetings[0].prepPath).toBe('/prep/meeting-a.md');
  });

  it('does not preserve skip sentinels when replacing the cache', () => {
    seedCache([makeMeeting({ id: 'meeting-a', prepPath: SKIPPED_PREP_SENTINEL })]);

    setCachedMeetings([makeMeeting({ id: 'meeting-a', prepPath: undefined })]);

    expect(getStoredCache().meetings[0].prepPath).toBeUndefined();
    expect(getStoredCache().meetings[0].prepPath).not.toBe(SKIPPED_PREP_SENTINEL);
  });

  it('keeps a new meeting real prepPath instead of overwriting it with old cache data', () => {
    seedCache([makeMeeting({ id: 'meeting-a', prepPath: '/prep/old.md' })]);

    setCachedMeetings([makeMeeting({ id: 'meeting-a', prepPath: '/prep/new.md' })]);

    expect(getStoredCache().meetings[0].prepPath).toBe('/prep/new.md');
  });

  it('handles a missing prior cache without errors', () => {
    storeData = {
      version: 1,
      cache: null,
    };

    expect(() => {
      setCachedMeetings([makeMeeting({ id: 'meeting-a', prepPath: undefined })]);
    }).not.toThrow();

    expect(getStoredCache().meetings).toHaveLength(1);
    expect(getStoredCache().meetings[0].prepPath).toBeUndefined();
  });

  it('does not carry prepPath across meetings with different ids', () => {
    seedCache([makeMeeting({ id: 'meeting-a', prepPath: '/prep/meeting-a.md' })]);

    setCachedMeetings([makeMeeting({ id: 'meeting-b', prepPath: undefined })]);

    expect(getStoredCache().meetings[0].id).toBe('meeting-b');
    expect(getStoredCache().meetings[0].prepPath).toBeUndefined();
  });

  it('incoming skip sentinel beats old real prepPath', () => {
    seedCache([makeMeeting({ id: 'meeting-a', prepPath: '/prep/meeting-a.md' })]);

    setCachedMeetings([makeMeeting({ id: 'meeting-a', prepPath: SKIPPED_PREP_SENTINEL })]);

    expect(getStoredCache().meetings[0].prepPath).toBe(SKIPPED_PREP_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Stage 2 (260611_calendar-followups): typed syncIssues at the chokepoint —
// written atomically with derived display-safe legacy strings in the same
// whole-object write; `detail` never reaches a derived string.
// ---------------------------------------------------------------------------

describe('meetingCacheStore typed syncIssues chokepoint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));
    storeData = { version: 1, cache: null };
    // These tests cover the atomic syncIssues+syncWarnings write contract, not
    // the debounce — pre-arm the streak to the surface threshold so a single
    // failure-class write persists immediately (debounce is covered separately).
    resetCalendarSyncFailureStreakForTesting(FAILURE_SURFACE_THRESHOLD);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes syncIssues AND derived syncWarnings in one cache object (no skew window)', () => {
    const issues: SyncIssue[] = [
      makeSyncIssue({
        kind: 'calendar_fetch_failed' as const,
        provider: 'google' as const,
        connector: 'GoogleWorkspace' as const,
        detail: 'Google Calendar API error: 500 boom',
      }),
    ];

    setCachedMeetings([], issues, 'direct-sync');

    const cache = getStoredCache();
    expect(cache.syncIssues).toEqual(issues);
    expect(cache.syncWarnings).toEqual(['GoogleWorkspace: a calendar could not be fetched during sync']);
  });

  it('maps undefined → [] for BOTH representations (invariant 3 — recovery overwrite)', () => {
    storeData = {
      version: 1,
      cache: {
        meetings: [],
        populatedAt: Date.now() - 60_000,
        syncWarnings: ['GoogleWorkspace: stale'],
        syncIssues: [{ kind: 'bridge_reported' }],
      } satisfies MeetingCache,
    };

    setCachedMeetings([]);

    expect(getStoredCache().syncWarnings).toEqual([]);
    expect(getStoredCache().syncIssues).toEqual([]);
  });

  it('getMeetingCacheState exposes both representations', () => {
    const issues: SyncIssue[] = [makeSyncIssue({ kind: 'validation_skipped' as const, count: 2 })];
    setCachedMeetings([], issues, 'llm-bridge');

    const state = getMeetingCacheState();
    expect(state.syncIssues).toEqual(issues);
    expect(state.syncWarnings).toEqual(['2 meeting(s) skipped due to validation errors']);
  });

  it('updateMeetingPrepPath (third cache writer) spread-preserves both fields [GPT-F2/RS-F2]', () => {
    const issues: SyncIssue[] = [
      makeSyncIssue({ kind: 'account_sync_failed' as const, provider: 'google' as const, connector: 'GoogleWorkspace' as const, detail: 'boom' }),
    ];
    setCachedMeetings([makeMeeting({ id: 'meeting-a' })], issues, 'direct-sync');

    updateMeetingPrepPath('meeting-a', '/prep/meeting-a.md');

    const cache = getStoredCache();
    expect(cache.meetings[0].prepPath).toBe('/prep/meeting-a.md');
    expect(cache.syncIssues).toEqual(issues);
    expect(cache.syncWarnings).toEqual(['GoogleWorkspace: account sync failed']);
  });
});

// ---------------------------------------------------------------------------
// Phase 7 refinement (DA-F4): recordSyncError is the write chokepoint for the
// persisted `lastSyncError` string. Raw sync errors can embed emails (e.g.
// tool-arg validation errors echoing attendee addresses) and the persisted
// value feeds display copy downstream (health-check message → toast, IPC
// pass-through), so it must be scrubbed BEFORE it touches the store.
// ---------------------------------------------------------------------------

describe('recordSyncError scrubbing chokepoint (DA-F4)', () => {
  beforeEach(() => {
    storeData = { version: 1, cache: null };
    // Scrubbing is orthogonal to the debounce — pre-arm to the surface
    // threshold so a single recordSyncError persists (and is scrubbed).
    resetCalendarSyncFailureStreakForTesting(FAILURE_SURFACE_THRESHOLD);
  });

  it('never persists an email-shaped substring (existing cache spread-preserved)', () => {
    seedCache([makeMeeting({ id: 'meeting-a' })]);

    recordSyncError('save_meetings rejected attendee [Mindstone-email]: invalid value');

    expect(JSON.stringify(storeData)).not.toContain('[Mindstone-email]');
    const cache = getStoredCache();
    expect(cache.lastSyncError).toContain('[email]');
    expect(cache.lastSyncError).toContain('save_meetings rejected attendee');
    expect(cache.meetings).toHaveLength(1);
  });

  it('never persists an email or connector-instance slug when no cache exists yet', () => {
    recordSyncError('GoogleWorkspace-teammember-mindstone-com sync failed for [Mindstone-email]');

    expect(JSON.stringify(storeData)).not.toContain('[Mindstone-email]');
    expect(JSON.stringify(storeData)).not.toContain('GoogleWorkspace-teammember-mindstone-com');
    expect(getStoredCache().lastSyncError).toContain('[email]');
    expect(getStoredCache().lastSyncError).toContain('[connector-instance]');
  });

  it('caps the persisted error length (same cap as makeSyncIssue free text)', () => {
    recordSyncError('x'.repeat(SYNC_ISSUE_DETAIL_MAX_LENGTH * 4));

    expect(getStoredCache().lastSyncError?.length).toBeLessThanOrEqual(SYNC_ISSUE_DETAIL_MAX_LENGTH);
  });
});

describe('renderSyncIssue display derivation', () => {
  it('never interpolates detail into the derived string (diagnostics-only contract)', () => {
    const rendered = renderSyncIssue({
      kind: 'calendar_fetch_failed',
      provider: 'google',
      connector: 'GoogleWorkspace',
      detail: 'SECRET-DIAGNOSTIC-PAYLOAD',
    });
    expect(rendered).not.toContain('SECRET-DIAGNOSTIC-PAYLOAD');
    expect(rendered.startsWith('GoogleWorkspace:')).toBe(true);
  });

  it('keeps the string-reader contract: connector-prefixed copy per kind', () => {
    // The `<connector>:` prefix keeps derived strings self-describing for the
    // remaining string readers (IPC pass-through, bridge GET, demo mode) —
    // always a closed-set base name, never a slug (deep-link preservation,
    // invariant 9).
    expect(renderSyncIssue({
      kind: 'auth_transient', provider: 'google', connector: 'GoogleWorkspace', accountRef: 'mindstone.com',
    })).toBe('GoogleWorkspace: Google account mindstone.com token refresh is temporarily unavailable; retrying with backoff');
    expect(renderSyncIssue({
      kind: 'auth_transient', provider: 'google', connector: 'GoogleWorkspace',
    })).toBe('GoogleWorkspace: Google account token refresh is temporarily unavailable; retrying with backoff');
    expect(renderSyncIssue({
      kind: 'account_sync_failed', provider: 'microsoft', connector: 'Microsoft365Calendar', detail: 'x',
    })).toBe('Microsoft365Calendar: account sync failed');
    expect(renderSyncIssue({ kind: 'bridge_reported', detail: 'model says hi' }))
      .toBe('A calendar source reported a sync problem');
    expect(renderSyncIssue({ kind: 'validation_skipped', count: 1 }))
      .toBe('1 meeting(s) skipped due to validation errors');
  });
});

// ---------------------------------------------------------------------------
// Stage 1 (260617_calendar-cache-transient-debounce): a single transient sync
// failure must NOT surface a "Calendar Cache needs attention" warning/toast;
// only a SUSTAINED failure (>= FAILURE_SURFACE_THRESHOLD consecutive failed
// syncs) surfaces. Failure-class issues are withheld below the threshold;
// informational issues (validation_skipped/bridge_reported) always pass
// through, and the hard `recordSyncError` path is gated on the SAME streak.
// ---------------------------------------------------------------------------

describe('meetingCacheStore transient-failure debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T12:00:00.000Z'));
    storeData = { version: 1, cache: null };
    resetCalendarSyncFailureStreakForTesting(); // start clean (streak 0)
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const failureIssue = (): SyncIssue =>
    makeSyncIssue({
      kind: 'account_sync_failed' as const,
      provider: 'google' as const,
      connector: 'GoogleWorkspace' as const,
      detail: 'network blip',
    });

  it('withholds a single (first) failure-class write — a transient blip reads as healthy', () => {
    setCachedMeetings([], [failureIssue()], 'direct-sync');

    const cache = getStoredCache();
    expect(cache.syncIssues).toEqual([]); // suppressed — nothing for the toast to fire on
    expect(cache.syncWarnings).toEqual([]);
  });

  it('surfaces failures once SUSTAINED (second consecutive failed sync)', () => {
    setCachedMeetings([], [failureIssue()], 'direct-sync'); // 1st — suppressed
    setCachedMeetings([], [failureIssue()], 'direct-sync'); // 2nd — surfaces

    const cache = getStoredCache();
    expect(cache.syncIssues).toEqual([failureIssue()]);
    expect(cache.syncWarnings).toEqual(['GoogleWorkspace: account sync failed']);
  });

  it('a successful sync between failures resets the streak (re-arms suppression)', () => {
    setCachedMeetings([], [failureIssue()], 'direct-sync'); // streak 1 — suppressed
    setCachedMeetings([makeMeeting({ id: 'm1' })], undefined, 'direct-sync'); // success → reset
    setCachedMeetings([], [failureIssue()], 'direct-sync'); // streak 1 again — suppressed

    expect(getStoredCache().syncIssues).toEqual([]);
  });

  it('never suppresses informational issues (validation_skipped passes through immediately)', () => {
    const info = makeSyncIssue({ kind: 'validation_skipped' as const, count: 3 });
    setCachedMeetings([], [info], 'llm-bridge');

    expect(getStoredCache().syncIssues).toEqual([info]);
  });

  it('a mixed set drops only the failure-class issue while suppressed, keeps informational', () => {
    const info = makeSyncIssue({ kind: 'validation_skipped' as const, count: 1 });
    setCachedMeetings([], [failureIssue(), info], 'direct-sync'); // 1st — failure suppressed, info kept

    expect(getStoredCache().syncIssues).toEqual([info]);
  });

  it('recordSyncError (hard-fail path) is gated on the SAME streak', () => {
    recordSyncError('calendar sync failed'); // streak 1 — suppressed, cache left untouched
    expect(getStoredCache()).toBeNull(); // no fail-state cache created for a transient blip

    recordSyncError('calendar sync failed'); // streak 2 — surfaces
    expect(getStoredCache().lastSyncError).toContain('calendar sync failed');
  });

  it('shares one streak across both writers (setCachedMeetings then recordSyncError surfaces)', () => {
    setCachedMeetings([], [failureIssue()], 'direct-sync'); // streak 1 — suppressed
    recordSyncError('calendar sync failed'); // streak 2 — surfaces via lastSyncError

    expect(getStoredCache().lastSyncError).toContain('calendar sync failed');
  });
});
