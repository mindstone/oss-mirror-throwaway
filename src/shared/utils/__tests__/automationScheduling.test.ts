import { describe, expect, it } from 'vitest';
import type { AutomationDefinition } from '@shared/types';
import {
  addDays,
  calculateMostRecentScheduledTime,
  calculateNextRunAt,
  lastDayOfMonth,
  parseTime,
  setTime,
  subtractDays,
} from '../automationScheduling';

const atLocal = (year: number, month: number, day: number, hours = 0, minutes = 0): Date =>
  new Date(year, month - 1, day, hours, minutes, 0, 0);

const createDefinition = (
  schedule: unknown,
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition => ({
  id: 'automation-test',
  name: 'Automation Test',
  filePath: '/tmp/test.md',
  schedule: schedule as AutomationDefinition['schedule'],
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe('automationScheduling', () => {
  describe('parseTime', () => {
    it('parses valid HH:mm strings', () => {
      expect(parseTime('09:30')).toEqual({ hours: 9, minutes: 30 });
      expect(parseTime('00:05')).toEqual({ hours: 0, minutes: 5 });
    });

    it('clamps out-of-range values and rejects invalid strings', () => {
      expect(parseTime('30:99')).toEqual({ hours: 23, minutes: 59 });
      expect(() => parseTime('abc:def')).toThrow('Invalid schedule time: abc:def');
      expect(() => parseTime('10:xx')).toThrow('Invalid schedule time: 10:xx');
    });
  });

  describe('setTime', () => {
    it('sets hour and minute while resetting seconds/milliseconds', () => {
      const input = atLocal(2026, 1, 15, 2, 7);
      const output = setTime(input, 14, 45);

      expect(output.getFullYear()).toBe(2026);
      expect(output.getMonth()).toBe(0);
      expect(output.getDate()).toBe(15);
      expect(output.getHours()).toBe(14);
      expect(output.getMinutes()).toBe(45);
      expect(output.getSeconds()).toBe(0);
      expect(output.getMilliseconds()).toBe(0);
    });
  });

  describe('addDays / subtractDays', () => {
    it('handles arithmetic across month boundaries', () => {
      expect(addDays(atLocal(2026, 1, 31, 9, 0), 1)).toEqual(atLocal(2026, 2, 1, 9, 0));
      expect(subtractDays(atLocal(2026, 3, 1, 9, 0), 1)).toEqual(atLocal(2026, 2, 28, 9, 0));
    });
  });

  describe('lastDayOfMonth', () => {
    it('returns correct last day for leap years and month lengths', () => {
      expect(lastDayOfMonth(atLocal(2024, 2, 10))).toBe(29);
      expect(lastDayOfMonth(atLocal(2025, 4, 10))).toBe(30);
      expect(lastDayOfMonth(atLocal(2025, 1, 10))).toBe(31);
    });
  });

  describe('calculateNextRunAt', () => {
    it('calculates nearest future daily run', () => {
      const from = atLocal(2026, 4, 6, 10, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '09:30' });

      expect(calculateNextRunAt(definition, from)).toBe(atLocal(2026, 4, 7, 9, 30).getTime());
    });

    it('calculates weekly run on the correct upcoming weekday', () => {
      const fromDate = atLocal(2026, 4, 6, 10, 0);
      const from = fromDate.getTime();
      const targetWeekday = (fromDate.getDay() + 2) % 7;
      const definition = createDefinition({
        type: 'weekly',
        daysOfWeek: [targetWeekday],
        time: '09:00',
      });

      const nextRunAt = calculateNextRunAt(definition, from);
      expect(nextRunAt).not.toBeNull();
      expect(new Date(nextRunAt as number).getDay()).toBe(targetWeekday);
      expect(nextRunAt).toBe(atLocal(2026, 4, 8, 9, 0).getTime());
    });

    it('keeps weekly weekday alignment across May/July 2025 month boundaries', () => {
      // No exact May/July 2025 postmortem fixture was found; this pins the
      // historical bug class: weekly schedules must not drift to the wrong
      // weekday when date arithmetic crosses month boundaries.
      const monday = 1;
      const definition = createDefinition({
        type: 'weekly',
        daysOfWeek: [monday],
        time: '09:00',
      });
      const cases = [
        {
          now: atLocal(2025, 5, 1, 10, 0),
          next: atLocal(2025, 5, 5, 9, 0),
          mostRecent: atLocal(2025, 4, 28, 9, 0),
        },
        {
          now: atLocal(2025, 5, 31, 12, 0),
          next: atLocal(2025, 6, 2, 9, 0),
          mostRecent: atLocal(2025, 5, 26, 9, 0),
        },
        {
          now: atLocal(2025, 7, 1, 10, 0),
          next: atLocal(2025, 7, 7, 9, 0),
          mostRecent: atLocal(2025, 6, 30, 9, 0),
        },
        {
          now: atLocal(2025, 7, 31, 12, 0),
          next: atLocal(2025, 8, 4, 9, 0),
          mostRecent: atLocal(2025, 7, 28, 9, 0),
        },
      ];

      for (const { now, next, mostRecent } of cases) {
        const nextRunAt = calculateNextRunAt(definition, now.getTime());
        const mostRecentScheduledTime = calculateMostRecentScheduledTime(definition, now.getTime());

        expect(nextRunAt).toBe(next.getTime());
        expect(mostRecentScheduledTime).toBe(mostRecent.getTime());
        expect(new Date(nextRunAt as number).getDay()).toBe(monday);
        expect(new Date(mostRecentScheduledTime as number).getDay()).toBe(monday);
      }
    });

    it('handles monthly schedules that request a day beyond month length', () => {
      const from = atLocal(2026, 4, 1, 9, 0).getTime();
      const definition = createDefinition({
        type: 'monthly',
        daysOfMonth: [31],
        time: '08:00',
        runOnLastDayIfShorter: true,
      });

      expect(calculateNextRunAt(definition, from)).toBe(atLocal(2026, 4, 30, 8, 0).getTime());
    });

    it('calculates next hourly run based on minute offset', () => {
      const from = atLocal(2026, 4, 6, 10, 20).getTime();
      const definition = createDefinition({ type: 'hourly', minute: 15 });

      const next = calculateNextRunAt(definition, from);
      expect(next).toBe(atLocal(2026, 4, 6, 11, 15).getTime());
    });

    it('calculates next hourly run when minute has not yet passed in current hour', () => {
      const from = atLocal(2026, 4, 6, 10, 10).getTime();
      const definition = createDefinition({ type: 'hourly', minute: 30 });

      expect(calculateNextRunAt(definition, from)).toBe(atLocal(2026, 4, 6, 10, 30).getTime());
    });

    it('calculates every_n_days schedule from anchor date', () => {
      const from = atLocal(2026, 4, 6, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 3,
        time: '09:00',
        anchorDate: '2026-04-01',
      });

      const next = calculateNextRunAt(definition, from);
      expect(next).toBe(atLocal(2026, 4, 7, 9, 0).getTime());
    });

    it('returns null for every_n_days without anchorDate (fail-closed)', () => {
      const from = atLocal(2026, 4, 6, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 14,
        time: '09:00',
      } as any);
      delete (definition.schedule as any).anchorDate;

      expect(calculateNextRunAt(definition, from)).toBeNull();
    });

    it('returns null for event-triggered schedules', () => {
      const from = atLocal(2026, 4, 6, 10, 0).getTime();
      const definition = createDefinition({ type: 'event', eventType: 'transcript-ready' });

      expect(calculateNextRunAt(definition, from)).toBeNull();
    });

    it('returns null for disabled automations', () => {
      const from = atLocal(2026, 4, 6, 10, 0).getTime();
      const definition = createDefinition({ type: 'daily', time: '09:00' }, { enabled: false });

      expect(calculateNextRunAt(definition, from)).toBeNull();
    });

    it('handles once schedules for future and past timestamps', () => {
      const from = atLocal(2026, 4, 1, 10, 0).getTime();
      const future = createDefinition({ type: 'once', dateTime: '2026-04-02T09:00:00' });
      const pastPending = createDefinition({ type: 'once', dateTime: '2026-03-30T09:00:00' });
      const pastCompleted = createDefinition(
        { type: 'once', dateTime: '2026-03-30T09:00:00' },
        { lastRunAt: atLocal(2026, 3, 30, 9, 0).getTime(), lastRunStatus: 'success' },
      );

      expect(calculateNextRunAt(future, from)).toBe(atLocal(2026, 4, 2, 9, 0).getTime());
      expect(calculateNextRunAt(pastPending, from)).toBe(atLocal(2026, 3, 30, 9, 0).getTime());
      expect(calculateNextRunAt(pastCompleted, from)).toBeNull();
    });
  });

  describe('calculateMostRecentScheduledTime', () => {
    it('finds most recent past daily occurrence', () => {
      const from = atLocal(2026, 4, 6, 10, 30).getTime();
      const definition = createDefinition({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['10:00'],
      });

      expect(calculateMostRecentScheduledTime(definition, from)).toBe(atLocal(2026, 4, 6, 10, 0).getTime());
    });

    it('finds previous weekly occurrence when same-day run is still in the future', () => {
      const fromDate = atLocal(2026, 4, 6, 10, 0);
      const from = fromDate.getTime();
      const definition = createDefinition({
        type: 'weekly',
        daysOfWeek: [fromDate.getDay()],
        time: '11:00',
      });

      expect(calculateMostRecentScheduledTime(definition, from)).toBe(atLocal(2026, 3, 30, 11, 0).getTime());
    });

    it('finds most recent hourly occurrence', () => {
      const from = atLocal(2026, 4, 6, 10, 20).getTime();
      const definition = createDefinition({ type: 'hourly', minute: 15 });

      expect(calculateMostRecentScheduledTime(definition, from)).toBe(atLocal(2026, 4, 6, 10, 15).getTime());
    });

    it('finds most recent every_n_days occurrence from anchor', () => {
      const from = atLocal(2026, 4, 6, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 3,
        time: '09:00',
        anchorDate: '2026-04-01',
      });

      expect(calculateMostRecentScheduledTime(definition, from)).toBe(atLocal(2026, 4, 4, 9, 0).getTime());
    });

    it('returns null for every_n_days without anchorDate (fail-closed)', () => {
      const from = atLocal(2026, 4, 6, 10, 0).getTime();
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 14,
        time: '09:00',
      } as any);
      delete (definition.schedule as any).anchorDate;

      expect(calculateMostRecentScheduledTime(definition, from)).toBeNull();
    });

    it('every_n_days with valid anchorDate does NOT trigger daily (regression test)', () => {
      // Automation created April 1, configured to run every 14 days at 09:00
      const anchorDate = '2026-04-01';
      const definition = createDefinition({
        type: 'every_n_days',
        intervalDays: 14,
        time: '09:00',
        anchorDate,
      });

      // Check on April 6 at 10:00 (5 days after anchor, NOT a 14-day boundary)
      const april6 = atLocal(2026, 4, 6, 10, 0).getTime();
      const mostRecent = calculateMostRecentScheduledTime(definition, april6);

      // Most recent scheduled time should be April 1 (the anchor itself)
      expect(mostRecent).toBe(atLocal(2026, 4, 1, 9, 0).getTime());

      // Next run should be April 15 (14 days after anchor)
      const nextRun = calculateNextRunAt(definition, april6);
      expect(nextRun).toBe(atLocal(2026, 4, 15, 9, 0).getTime());

      // Simulating catch-up: if lastRunAt is April 1 at 09:05 (just after anchor run),
      // then mostRecent (April 1 09:00) should NOT be newer than lastRunAt
      const lastRunAt = atLocal(2026, 4, 1, 9, 5).getTime();
      expect(mostRecent).toBeLessThan(lastRunAt);
      // This proves catch-up would NOT fire — the bug is fixed
    });

    it('returns null for event-triggered schedules', () => {
      const from = atLocal(2026, 4, 6, 10, 0).getTime();
      const definition = createDefinition({ type: 'event', eventType: 'transcript-ready' });

      expect(calculateMostRecentScheduledTime(definition, from)).toBeNull();
    });

    it('finds most recent monthly occurrence with last-day fallback', () => {
      const from = atLocal(2026, 4, 15, 12, 0).getTime();
      const definition = createDefinition({
        type: 'monthly',
        daysOfMonth: [31],
        time: '08:00',
        runOnLastDayIfShorter: true,
      });

      expect(calculateMostRecentScheduledTime(definition, from)).toBe(atLocal(2026, 3, 31, 8, 0).getTime());
    });
  });
});
