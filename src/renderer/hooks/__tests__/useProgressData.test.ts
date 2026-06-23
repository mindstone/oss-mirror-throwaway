import { describe, expect, it } from 'vitest';
import { formatTimeSavedCompact, selectTimeSavedData, shouldDisplayTimeSavedData } from '../useProgressData';

describe('useProgressData helpers', () => {
  it('keeps current-week progress visible even below five minutes', () => {
    expect(shouldDisplayTimeSavedData(1, 1)).toBe(true);
    expect(formatTimeSavedCompact(1)).toBe('1m');
  });

  it('hides time-saved data only when there is no current-week activity', () => {
    expect(shouldDisplayTimeSavedData(0, 0)).toBe(false);
    expect(shouldDisplayTimeSavedData(0, 1)).toBe(true);
    expect(formatTimeSavedCompact(0)).toBe('0m');
  });

  it('uses current-week data when available', () => {
    expect(selectTimeSavedData({
      currentWeek: { totalMinutes: 45, sessionCount: 3, weekStartDate: '2026-05-18' },
    }, null)).toEqual({
      totalMinutes: 45,
      sessionCount: 3,
      trend: null,
      weekStartDate: '2026-05-18',
    });
  });

  it('hides when current week is empty rather than substituting all-time data', () => {
    expect(selectTimeSavedData({
      currentWeek: { totalMinutes: 0, sessionCount: 0, weekStartDate: '2026-05-18' },
    }, null)).toBeNull();
  });
});
