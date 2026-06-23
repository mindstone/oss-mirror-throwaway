/**
 * Tests for the timestamp-preserving backfill write path on `timeSavedStore`.
 *
 * Covers:
 *  - `addTimeSavedEntryAt` stamps the entry with the original turn timestamp
 *    (not Date.now()) and routes the raw midpoint into the correct daily-totals
 *    bucket for that timestamp.
 *  - Aggregates respect the original timestamp so recovered entries land in
 *    the correct weekly/monthly buckets — including the case where "today"
 *    differs from the entry's day.
 *  - Duplicate turn writes are rejected. The first writer wins; subsequent
 *    writes — whether live or backfill — return `{added:false,reason:'duplicate'}`.
 *  - `hasTimeSavedEntryForTurn` and `getLatestEntryTimestamp` reflect store
 *    contents.
 *  - Existing `addTimeSavedEntry` (live path) behaviour is unchanged.
 *
 * Each test isolates the store module via `vi.resetModules()` + a fresh
 * dynamic import so module-level singletons (notably the cached store
 * handle in `getTimeSavedStore`) don't leak between cases.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimeSavedEstimate } from '@shared/types';
import { initTestPlatformConfig } from '../../__tests__/testHelpers';

const buildEstimate = (overrides: Partial<TimeSavedEstimate> = {}): TimeSavedEstimate => ({
  lowMinutes: 10,
  highMinutes: 20,
  confidence: 'medium',
  taskType: 'writing',
  reasoning: 'Drafted a customer update.',
  reasoningDetail: 'Manual drafting + edits.',
  impact: 'medium',
  ...overrides,
});

const isoToMs = (iso: string) => new Date(iso).getTime();

// Build a Monday timestamp for a given ISO date so weekly bucketing is
// deterministic regardless of when the test runs.
const monday = (yyyyMmDd: string): number => {
  const ts = isoToMs(`${yyyyMmDd}T10:00:00.000Z`);
  return ts;
};

describe('timeSavedStore — addTimeSavedEntryAt (timestamp-preserving recovery)', () => {
  beforeEach(async () => {
    vi.resetModules();
    // resetModules() clears the in-memory boundary singletons set by
    // vitest.setup.ts; re-init them for each case so the freshly imported
    // store module can find the store factory.
    await initTestPlatformConfig();
  });

  it('writes the entry with the original timestamp and buckets daily totals on that day', async () => {
    const store = await import('../timeSavedStore');
    const target = isoToMs('2026-04-21T14:00:00.000Z'); // Tuesday last month
    const result = store.addTimeSavedEntryAt('turn-old', 'session-old', buildEstimate(), target);

    expect(result).toEqual({ added: true, timestamp: target });

    const state = store.getTimeSavedState();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({
      turnId: 'turn-old',
      sessionId: 'session-old',
      timestamp: target,
    });

    // Daily-totals key must be the entry's local date, not today's.
    const entryDate = new Date(target);
    const entryDateStr = `${entryDate.getFullYear()}-${String(entryDate.getMonth() + 1).padStart(2, '0')}-${String(entryDate.getDate()).padStart(2, '0')}`;
    const todayStr = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    expect(state.dailyTotals[entryDateStr]).toBeGreaterThan(0);
    if (entryDateStr !== todayStr) {
      expect(state.dailyTotals[todayStr]).toBeUndefined();
    }
  });

  it('rejects a duplicate write for the same turnId regardless of which path arrives first', async () => {
    const store = await import('../timeSavedStore');
    const firstTs = monday('2026-05-04');

    const first = store.addTimeSavedEntryAt('turn-dup', 'session-dup', buildEstimate(), firstTs);
    expect(first.added).toBe(true);

    const liveResult = store.addTimeSavedEntry('turn-dup', 'session-dup', buildEstimate({ lowMinutes: 30, highMinutes: 40 }));
    // Live path now propagates the store result so the analytics emit can gate
    // on persisted acceptance: a same-turn write is rejected as a duplicate.
    expect(liveResult).toEqual({ added: false, reason: 'duplicate' });
    expect(store.getTimeSavedState().entries).toHaveLength(1);
    expect(store.getTimeSavedState().entries[0].timestamp).toBe(firstTs);

    const second = store.addTimeSavedEntryAt('turn-dup', 'session-dup', buildEstimate(), firstTs + 1_000_000);
    expect(second).toEqual({ added: false, reason: 'duplicate' });
    expect(store.getTimeSavedState().entries).toHaveLength(1);
    expect(store.hasTimeSavedEntryForTurn('turn-dup')).toBe(true);
    expect(store.hasTimeSavedEntryForTurn('turn-other')).toBe(false);
  });

  it('refuses non-finite or non-positive timestamps without writing', async () => {
    const store = await import('../timeSavedStore');
    expect(store.addTimeSavedEntryAt('turn-bad', 'session-bad', buildEstimate(), 0)).toEqual({ added: false, reason: 'duplicate' });
    expect(store.addTimeSavedEntryAt('turn-bad', 'session-bad', buildEstimate(), Number.NaN)).toEqual({ added: false, reason: 'duplicate' });
    expect(store.getTimeSavedState().entries).toHaveLength(0);
  });

  it('aggregates a recovered prior-month entry into the correct allTime + currentMonth bucket', async () => {
    const store = await import('../timeSavedStore');
    // Pin "now" two months after the entry so the recovered entry should land
    // in allTime but NOT in currentMonth / currentWeek.
    const entryTs = monday('2026-03-09');
    const fakeNow = isoToMs('2026-05-13T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);
    try {
      const result = store.addTimeSavedEntryAt('turn-march', 'session-march', buildEstimate({ lowMinutes: 20, highMinutes: 40, impact: 'medium' }), entryTs);
      expect(result.added).toBe(true);

      // Trigger an aggregate read which recalculates against the current week.
      const aggregates = store.getTimeSavedAggregates();
      expect(aggregates.allTime.sessionCount).toBe(1);
      expect(aggregates.allTime.totalMinutes).toBeGreaterThan(0);
      expect(aggregates.currentMonth.sessionCount).toBe(0);
      expect(aggregates.currentWeek.sessionCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the latest-entry helpers in sync as new entries are persisted', async () => {
    const store = await import('../timeSavedStore');
    expect(store.getLatestEntryTimestamp()).toBeNull();

    const tsOld = monday('2026-04-13');
    const tsNew = monday('2026-05-18');
    store.addTimeSavedEntryAt('turn-old', 'session-a', buildEstimate(), tsOld);
    expect(store.getLatestEntryTimestamp()).toBe(tsOld);
    store.addTimeSavedEntryAt('turn-new', 'session-b', buildEstimate(), tsNew);
    expect(store.getLatestEntryTimestamp()).toBe(tsNew);

    // Even when inserting an *older* entry afterwards, the helper still reports
    // the actual max timestamp seen — which the backfill scanner relies on
    // when defaulting the cutoff so re-runs naturally narrow.
    store.addTimeSavedEntryAt('turn-middle', 'session-c', buildEstimate(), monday('2026-04-27'));
    expect(store.getLatestEntryTimestamp()).toBe(tsNew);
  });

  it('preserves existing live-path behaviour: addTimeSavedEntry uses Date.now() for timestamp + today bucket', async () => {
    const store = await import('../timeSavedStore');
    const fakeNow = isoToMs('2026-05-20T16:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(fakeNow);
    try {
      store.addTimeSavedEntry('turn-live', 'session-live', buildEstimate());
      const state = store.getTimeSavedState();
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0].timestamp).toBe(fakeNow);
      const todayKey = '2026-05-20';
      expect(state.dailyTotals[todayKey]).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
