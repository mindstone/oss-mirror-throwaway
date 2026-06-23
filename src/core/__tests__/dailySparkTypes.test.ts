import { describe, it, expect } from 'vitest';
import {
  computeWeekStartIso,
  isDailySparkBatchStale,
  isMonday,
} from '../dailySparkTypes';

describe('dailySparkTypes — time helpers', () => {
  describe('computeWeekStartIso', () => {
    it('returns the date itself for a Monday in UTC', () => {
      const monday = new Date('2026-05-11T12:00:00Z');
      expect(computeWeekStartIso(monday, 'UTC')).toBe('2026-05-11');
    });

    it('returns the previous Monday for a Sunday in UTC', () => {
      const sunday = new Date('2026-05-17T12:00:00Z');
      expect(computeWeekStartIso(sunday, 'UTC')).toBe('2026-05-11');
    });

    it('returns the previous Monday for a Wednesday in UTC', () => {
      const wednesday = new Date('2026-05-13T12:00:00Z');
      expect(computeWeekStartIso(wednesday, 'UTC')).toBe('2026-05-11');
    });

    it('respects Europe/London timezone for late-Sunday-UTC dates', () => {
      // 2026-05-17 23:30Z is 00:30 Monday in London (BST = UTC+1).
      const lateSundayUtc = new Date('2026-05-17T23:30:00Z');
      expect(computeWeekStartIso(lateSundayUtc, 'Europe/London')).toBe('2026-05-18');
    });

    it('respects America/Los_Angeles timezone for early-Monday-UTC dates', () => {
      // 2026-05-11 04:00Z is still 21:00 Sunday in LA (PDT = UTC-7).
      const earlyMondayUtc = new Date('2026-05-11T04:00:00Z');
      expect(computeWeekStartIso(earlyMondayUtc, 'America/Los_Angeles')).toBe('2026-05-04');
    });

    it('handles the spring-forward DST boundary (US/Eastern, 2026-03-08)', () => {
      // 2026-03-08 is the US "spring forward" Sunday. The Monday before it is 2026-03-02.
      const sundayDST = new Date('2026-03-08T12:00:00Z');
      expect(computeWeekStartIso(sundayDST, 'America/New_York')).toBe('2026-03-02');

      const mondayAfter = new Date('2026-03-09T12:00:00Z');
      expect(computeWeekStartIso(mondayAfter, 'America/New_York')).toBe('2026-03-09');
    });

    it('handles the fall-back DST boundary (Europe/London, 2026-10-25)', () => {
      // 2026-10-25 is when London falls back from BST to GMT. The Monday is 2026-10-19.
      const sundayDST = new Date('2026-10-25T12:00:00Z');
      expect(computeWeekStartIso(sundayDST, 'Europe/London')).toBe('2026-10-19');

      const mondayAfter = new Date('2026-10-26T12:00:00Z');
      expect(computeWeekStartIso(mondayAfter, 'Europe/London')).toBe('2026-10-26');
    });
  });

  describe('isMonday', () => {
    it('returns true for Mondays in UTC', () => {
      expect(isMonday(new Date('2026-05-11T12:00:00Z'), 'UTC')).toBe(true);
    });

    it('returns false for other days in UTC', () => {
      expect(isMonday(new Date('2026-05-12T12:00:00Z'), 'UTC')).toBe(false);
      expect(isMonday(new Date('2026-05-17T12:00:00Z'), 'UTC')).toBe(false);
    });

    it('shifts with timezone — early-Monday-UTC is Sunday in LA', () => {
      const earlyMondayUtc = new Date('2026-05-11T04:00:00Z');
      expect(isMonday(earlyMondayUtc, 'UTC')).toBe(true);
      expect(isMonday(earlyMondayUtc, 'America/Los_Angeles')).toBe(false);
    });

    it('shifts with timezone — late-Sunday-UTC is Monday in London', () => {
      const lateSundayUtc = new Date('2026-05-17T23:30:00Z');
      expect(isMonday(lateSundayUtc, 'UTC')).toBe(false);
      expect(isMonday(lateSundayUtc, 'Europe/London')).toBe(true);
    });
  });

  describe('isDailySparkBatchStale', () => {
    it('returns true when the stored anchor is null', () => {
      expect(isDailySparkBatchStale(null, new Date('2026-05-11T12:00:00Z'), 'UTC')).toBe(true);
    });

    it('returns true when the stored anchor is an empty string', () => {
      expect(isDailySparkBatchStale('', new Date('2026-05-11T12:00:00Z'), 'UTC')).toBe(true);
    });

    it('returns false when the stored anchor matches the current week', () => {
      expect(
        isDailySparkBatchStale('2026-05-11', new Date('2026-05-14T12:00:00Z'), 'UTC'),
      ).toBe(false);
    });

    it('returns true when the stored anchor is older than the current week', () => {
      expect(
        isDailySparkBatchStale('2026-05-04', new Date('2026-05-14T12:00:00Z'), 'UTC'),
      ).toBe(true);
    });

    it('treats timezones consistently — fresh anchor in LA can be stale in UTC and vice versa', () => {
      // Monday 2026-05-11 in LA == Monday 04:00–11:59 in UTC (week 2026-05-11 in UTC too)
      const lateInWeek = new Date('2026-05-18T03:00:00Z');
      // In UTC this is still Monday 2026-05-18; in LA it's Sunday 2026-05-17 → still week 2026-05-11
      expect(isDailySparkBatchStale('2026-05-11', lateInWeek, 'UTC')).toBe(true);
      expect(isDailySparkBatchStale('2026-05-11', lateInWeek, 'America/Los_Angeles')).toBe(false);
    });
  });
});
