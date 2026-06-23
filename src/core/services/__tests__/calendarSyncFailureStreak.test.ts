import { afterEach, describe, expect, it } from 'vitest';
import { makeSyncIssue } from '@shared/ipc/channels/calendar';
import {
  FAILURE_SURFACE_THRESHOLD,
  getCalendarSyncFailureStreak,
  isFailureClassSyncIssue,
  recordCalendarSyncFailure,
  recordCalendarSyncSuccess,
  resetCalendarSyncFailureStreakForTesting,
  shouldSurfaceCalendarSyncFailures,
} from '../calendarSyncFailureStreak';

describe('calendarSyncFailureStreak', () => {
  afterEach(() => resetCalendarSyncFailureStreakForTesting());

  it('does not surface a single (first) failure — only sustained ones', () => {
    resetCalendarSyncFailureStreakForTesting();
    recordCalendarSyncFailure();
    expect(getCalendarSyncFailureStreak()).toBe(1);
    expect(shouldSurfaceCalendarSyncFailures()).toBe(false);
  });

  it('surfaces once the streak reaches the threshold', () => {
    resetCalendarSyncFailureStreakForTesting();
    for (let i = 0; i < FAILURE_SURFACE_THRESHOLD; i++) recordCalendarSyncFailure();
    expect(shouldSurfaceCalendarSyncFailures()).toBe(true);
  });

  it('a success resets the streak (re-arms suppression)', () => {
    resetCalendarSyncFailureStreakForTesting();
    recordCalendarSyncFailure();
    recordCalendarSyncFailure();
    expect(shouldSurfaceCalendarSyncFailures()).toBe(true);
    recordCalendarSyncSuccess();
    expect(getCalendarSyncFailureStreak()).toBe(0);
    expect(shouldSurfaceCalendarSyncFailures()).toBe(false);
  });

  it('classifies the transient sync-failure kinds as failure-class (subject to debounce)', () => {
    expect(isFailureClassSyncIssue(makeSyncIssue({ kind: 'auth_transient', provider: 'google', connector: 'GoogleWorkspace' }))).toBe(true);
    expect(isFailureClassSyncIssue(makeSyncIssue({ kind: 'account_sync_failed', provider: 'google', connector: 'GoogleWorkspace', detail: 'x' }))).toBe(true);
    expect(isFailureClassSyncIssue(makeSyncIssue({ kind: 'calendar_fetch_failed', provider: 'google', connector: 'GoogleWorkspace', detail: 'x' }))).toBe(true);
  });

  it('treats informational issues as NOT failure-class (never suppressed)', () => {
    expect(isFailureClassSyncIssue(makeSyncIssue({ kind: 'validation_skipped', count: 1 }))).toBe(false);
    expect(isFailureClassSyncIssue(makeSyncIssue({ kind: 'bridge_reported', detail: 'x' }))).toBe(false);
  });
});
