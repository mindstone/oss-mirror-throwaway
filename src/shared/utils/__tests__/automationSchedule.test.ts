import { describe, expect, it } from 'vitest';
import type { AutomationDefinition } from '@shared/types';

import { AutomationSchedule, type AutomationScheduleError } from '../automationSchedule';
import { calculateMostRecentScheduledTime, calculateNextRunAt } from '../automationScheduling';

/**
 * Postmortem-shape regression corpus for `AutomationSchedule.fromUntrusted`.
 *
 * Cases C1a-C11 follow the planning doc
 * `docs/plans/260427_refactor_schedule_algebra.md` §Investigation §7. Each
 * case anchors the structural fix to a specific historical bug shape so a
 * future agent reviewing this file sees the bug class the constructors
 * close.
 */

// April 24, 2024 ~22:13 UTC → ISO date '2024-04-24'.
const FIXED_NOW = 1714000000000;
const FIXED_NOW_ISO_DATE = '2024-04-24';

// Sept 16, 2024 ~16:53 UTC → ISO date '2024-09-16'.
const OLDER_CREATED_AT = 1726500000000;
const OLDER_CREATED_AT_ISO_DATE = '2024-09-16';

const expectErr = <T>(
  result: { ok: true; value: T } | { ok: false; error: AutomationScheduleError },
): AutomationScheduleError => {
  if (result.ok) {
    throw new Error(`Expected error, got ok with value ${JSON.stringify(result.value)}`);
  }
  return result.error;
};

const expectOk = <T>(
  result: { ok: true; value: T } | { ok: false; error: AutomationScheduleError },
): T => {
  if (!result.ok) {
    throw new Error(`Expected ok, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

const atLocal = (year: number, month: number, day: number, hours = 0, minutes = 0): Date =>
  new Date(year, month - 1, day, hours, minutes, 0, 0);

const createDefinition = (
  schedule: AutomationDefinition['schedule'],
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition => ({
  id: 'automation-schedule-test',
  name: 'Automation Schedule Test',
  filePath: '/tmp/automation-schedule-test.md',
  schedule,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe('AutomationSchedule.fromUntrusted', () => {
  describe('C1: every_n_days anchor repair (260422 postmortem)', () => {
    it('C1a: MCP create with `now` only — repairs anchor to today (ISO date of now)', () => {
      const result = AutomationSchedule.fromUntrusted(
        { type: 'every_n_days', intervalDays: 14, time: '09:30' },
        { source: 'mcp', now: FIXED_NOW },
      );

      expect(expectOk(result)).toEqual({
        type: 'every_n_days',
        intervalDays: 14,
        time: '09:30',
        anchorDate: FIXED_NOW_ISO_DATE,
      });
    });

    it('C1b: IPC update — repairs anchor to existingCreatedAt (preserves cadence)', () => {
      const result = AutomationSchedule.fromUntrusted(
        { type: 'every_n_days', intervalDays: 14, time: '09:30' },
        { source: 'ipc', existingCreatedAt: OLDER_CREATED_AT, now: FIXED_NOW },
      );

      expect(expectOk(result)).toEqual({
        type: 'every_n_days',
        intervalDays: 14,
        time: '09:30',
        anchorDate: OLDER_CREATED_AT_ISO_DATE,
      });
    });

    it('C1c: store-load — repairs anchor to existingCreatedAt', () => {
      const result = AutomationSchedule.fromUntrusted(
        { type: 'every_n_days', intervalDays: 14, time: '09:30' },
        { source: 'store-load', existingCreatedAt: OLDER_CREATED_AT, now: FIXED_NOW },
      );

      expect(expectOk(result)).toEqual({
        type: 'every_n_days',
        intervalDays: 14,
        time: '09:30',
        anchorDate: OLDER_CREATED_AT_ISO_DATE,
      });
    });

    it('C1d: no context provided — rejects with `missing-anchor-no-context`', () => {
      const result = AutomationSchedule.fromUntrusted({
        type: 'every_n_days',
        intervalDays: 14,
        time: '09:30',
      });

      const error = expectErr(result);
      expect(error.kind).toBe('missing-anchor-no-context');
      expect(error.field).toBe('anchorDate');
    });

    it('rejects explicit null anchorDate as wrong-type instead of repairing', () => {
      const result = AutomationSchedule.fromUntrusted(
        { type: 'every_n_days', intervalDays: 14, time: '09:30', anchorDate: null },
        { source: 'ipc', existingCreatedAt: OLDER_CREATED_AT, now: FIXED_NOW },
      );

      const error = expectErr(result);
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('anchorDate');
    });

    it('rejects explicit numeric anchorDate as wrong-type instead of repairing', () => {
      const result = AutomationSchedule.fromUntrusted(
        { type: 'every_n_days', intervalDays: 14, time: '09:30', anchorDate: 123 },
        { source: 'ipc', existingCreatedAt: OLDER_CREATED_AT, now: FIXED_NOW },
      );

      const error = expectErr(result);
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('anchorDate');
    });

    it('rejects explicit empty-string anchorDate as wrong-type instead of repairing', () => {
      const result = AutomationSchedule.fromUntrusted(
        { type: 'every_n_days', intervalDays: 14, time: '09:30', anchorDate: '' },
        { source: 'ipc', existingCreatedAt: OLDER_CREATED_AT, now: FIXED_NOW },
      );

      const error = expectErr(result);
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('anchorDate');
    });
  });

  describe('C2: event branch missing eventType (260411 postmortem)', () => {
    it('rejects {type:"event"} with missing-field', () => {
      const result = AutomationSchedule.fromUntrusted({ type: 'event' });
      const error = expectErr(result);
      expect(error.kind).toBe('missing-field');
      expect(error.field).toBe('eventType');
    });
  });

  describe('C3: event branch with eventType: undefined (260412 postmortem variant)', () => {
    it('rejects when eventType is explicitly undefined', () => {
      const result = AutomationSchedule.fromUntrusted({ type: 'event', eventType: undefined });
      const error = expectErr(result);
      expect(error.kind).toBe('missing-field');
      expect(error.field).toBe('eventType');
    });
  });

  describe('C4: event-branch legacy alias repair', () => {
    it('C4a: `trigger` alias renames to `eventType`', () => {
      const result = AutomationSchedule.fromUntrusted({ type: 'event', trigger: 'transcript-ready' });
      expect(expectOk(result)).toEqual({ type: 'event', eventType: 'transcript-ready' });
    });

    it('C4b: snake_case `event_type` alias renames to `eventType`', () => {
      const result = AutomationSchedule.fromUntrusted({
        type: 'event',
        event_type: 'transcript-ready',
      });
      expect(expectOk(result)).toEqual({ type: 'event', eventType: 'transcript-ready' });
    });

    it('C4c: precedence event_type > eventType > trigger when multiple supplied', () => {
      const result = AutomationSchedule.fromUntrusted({
        type: 'event',
        event_type: 'transcript-ready',
        eventType: 'transcript-ready:rebel',
        trigger: 'transcript-ready:external',
      });
      // snake_case wins per MCP_SERVER_STANDARD invariant 6
      expect(expectOk(result)).toEqual({ type: 'event', eventType: 'transcript-ready' });
    });

    it('C4d: present empty-string event_type wins precedence, then rejects as wrong-type', () => {
      const result = AutomationSchedule.fromUntrusted({
        type: 'event',
        event_type: '',
      });

      const error = expectErr(result);
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('eventType');
    });
  });

  describe('C5: non-object inputs (260404 shape class)', () => {
    it('rejects null with wrong-type', () => {
      const error = expectErr(AutomationSchedule.fromUntrusted(null));
      expect(error.kind).toBe('wrong-type');
    });

    it('rejects undefined with wrong-type', () => {
      const error = expectErr(AutomationSchedule.fromUntrusted(undefined));
      expect(error.kind).toBe('wrong-type');
    });

    it('rejects string with wrong-type', () => {
      const error = expectErr(AutomationSchedule.fromUntrusted('daily'));
      expect(error.kind).toBe('wrong-type');
    });

    it('rejects empty array with wrong-type', () => {
      const error = expectErr(AutomationSchedule.fromUntrusted([]));
      expect(error.kind).toBe('wrong-type');
    });
  });

  describe('C6: unknown discriminator', () => {
    it('rejects {type:"unknown_type"} with unknown-type', () => {
      const error = expectErr(AutomationSchedule.fromUntrusted({ type: 'unknown_type' }));
      expect(error.kind).toBe('unknown-type');
      expect(error.field).toBe('type');
    });
  });

  describe('C7: monthly with daysOfMonth beyond month length', () => {
    it('accepts daysOfMonth: [29,30,31] without runOnLastDayIfShorter', () => {
      const result = AutomationSchedule.fromUntrusted({
        type: 'monthly',
        daysOfMonth: [29, 30, 31],
        time: '09:00',
      });
      expect(expectOk(result)).toEqual({
        type: 'monthly',
        daysOfMonth: [29, 30, 31],
        time: '09:00',
      });
    });
  });

  describe('C8: monthly with runOnLastDayIfShorter', () => {
    it('accepts {daysOfMonth:[31], runOnLastDayIfShorter:true}', () => {
      const result = AutomationSchedule.fromUntrusted({
        type: 'monthly',
        daysOfMonth: [31],
        time: '09:00',
        runOnLastDayIfShorter: true,
      });
      expect(expectOk(result)).toEqual({
        type: 'monthly',
        daysOfMonth: [31],
        time: '09:00',
        runOnLastDayIfShorter: true,
      });
    });
  });

  describe('C9: daily with malformed additionalTimes — reject loudly', () => {
    it("rejects additionalTimes containing 'bogus' with invalid-additional-times (no silent filter)", () => {
      const error = expectErr(
        AutomationSchedule.fromUntrusted({
          type: 'daily',
          time: '09:00',
          additionalTimes: ['12:30', 'bogus'],
        }),
      );
      expect(error.kind).toBe('invalid-additional-times');
      expect(error.field).toBe('additionalTimes');
    });

    it('accepts additionalTimes with all-valid HH:mm entries', () => {
      const result = AutomationSchedule.fromUntrusted({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['12:30', '15:45'],
      });
      expect(expectOk(result)).toEqual({
        type: 'daily',
        time: '09:00',
        additionalTimes: ['12:30', '15:45'],
      });
    });
  });

  describe('C10: once with future dateTime', () => {
    it('accepts ISO 8601 dateTime with seconds', () => {
      const result = AutomationSchedule.fromUntrusted({
        type: 'once',
        dateTime: '2026-03-26T15:00:00',
      });
      expect(expectOk(result)).toEqual({ type: 'once', dateTime: '2026-03-26T15:00:00' });
    });

    it('accepts ISO 8601 dateTime without seconds', () => {
      const result = AutomationSchedule.fromUntrusted({
        type: 'once',
        dateTime: '2026-03-26T15:00',
      });
      expect(expectOk(result)).toEqual({ type: 'once', dateTime: '2026-03-26T15:00' });
    });

    it('rejects JS-parseable non-ISO dateTime as wrong-type', () => {
      const result = AutomationSchedule.fromUntrusted({
        type: 'once',
        dateTime: 'March 26, 2026',
      });

      const error = expectErr(result);
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('dateTime');
    });

    it('rejects impossible ISO-shaped dateTime as wrong-type', () => {
      const result = AutomationSchedule.fromUntrusted({
        type: 'once',
        dateTime: '2026-99-99T99:99',
      });

      const error = expectErr(result);
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('dateTime');
    });

    it('rejects non-ISO dateTime as wrong-type', () => {
      const result = AutomationSchedule.fromUntrusted({
        type: 'once',
        dateTime: 'not-iso-at-all',
      });

      const error = expectErr(result);
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('dateTime');
    });
  });

  describe('Zod issue classification', () => {
    it('classifies present invalid_type fields as wrong-type', () => {
      const error = expectErr(AutomationSchedule.fromUntrusted({ type: 'daily', time: 12345 }));
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('time');
    });

    it('classifies invalid enum values as wrong-type', () => {
      const error = expectErr(AutomationSchedule.fromUntrusted({ type: 'event', eventType: 'unknown-event' }));
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('eventType');
    });

    it('classifies invalid dateTime refinements as wrong-type', () => {
      const error = expectErr(AutomationSchedule.fromUntrusted({ type: 'once', dateTime: 'not-iso' }));
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('dateTime');
    });

    it('classifies numeric range failures as wrong-type', () => {
      const error = expectErr(AutomationSchedule.fromUntrusted({ type: 'hourly', minute: 99 }));
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('minute');
    });

    it('classifies absent invalid_type fields as missing-field', () => {
      const error = expectErr(AutomationSchedule.fromUntrusted({ type: 'daily' }));
      expect(error.kind).toBe('missing-field');
      expect(error.field).toBe('time');
    });

    it('classifies missing type before Zod as missing-field', () => {
      const error = expectErr(AutomationSchedule.fromUntrusted({ time: '09:00' }));
      expect(error.kind).toBe('missing-field');
      expect(error.field).toBe('type');
    });

    it('classifies non-string type before Zod as wrong-type', () => {
      const error = expectErr(AutomationSchedule.fromUntrusted({ type: 123 }));
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('type');
    });

    it('rejects non-array additionalTimes with invalid-additional-times', () => {
      const error = expectErr(
        AutomationSchedule.fromUntrusted({
          type: 'daily',
          time: '09:00',
          additionalTimes: '12:30',
        }),
      );
      expect(error.kind).toBe('invalid-additional-times');
      expect(error.field).toBe('additionalTimes');
    });

    it('fails closed when snake_case event_type is null even if eventType is valid', () => {
      const error = expectErr(
        AutomationSchedule.fromUntrusted({
          type: 'event',
          event_type: null,
          eventType: 'transcript-ready',
        }),
      );
      expect(error.kind).toBe('wrong-type');
      expect(error.field).toBe('eventType');
    });
  });
});

describe('Scheduler integration after fromUntrusted', () => {
  it('C1a repaired every_n_days schedule produces a valid future next run', () => {
    const schedule = expectOk(
      AutomationSchedule.fromUntrusted(
        { type: 'every_n_days', intervalDays: 14, time: '09:30' },
        { source: 'mcp', now: FIXED_NOW },
      ),
    );

    const nextRunAt = calculateNextRunAt(createDefinition(schedule), FIXED_NOW);
    expect(nextRunAt).not.toBeNull();
    expect(nextRunAt as number).toBeGreaterThan(FIXED_NOW);
  });

  it('C1a repaired every_n_days schedule produces a valid past most recent run', () => {
    const schedule = expectOk(
      AutomationSchedule.fromUntrusted(
        { type: 'every_n_days', intervalDays: 14, time: '09:30' },
        { source: 'mcp', now: FIXED_NOW },
      ),
    );

    const mostRecentRunAt = calculateMostRecentScheduledTime(createDefinition(schedule), FIXED_NOW);
    expect(mostRecentRunAt).not.toBeNull();
    expect(mostRecentRunAt as number).toBeLessThanOrEqual(FIXED_NOW);
  });

  it('C1d unrepaired every_n_days schedule without anchorDate returns null defense-in-depth', () => {
    const schedule = {
      type: 'every_n_days',
      intervalDays: 14,
      time: '09:30',
    } as never;

    expect(calculateNextRunAt(createDefinition(schedule), FIXED_NOW)).toBeNull();
  });

  it('C1d unrepaired every_n_days schedule without anchorDate returns null for most recent defense-in-depth', () => {
    const schedule = {
      type: 'every_n_days',
      intervalDays: 14,
      time: '09:30',
    } as never;

    expect(calculateMostRecentScheduledTime(createDefinition(schedule), FIXED_NOW)).toBeNull();
  });

  it('C2 malformed event schedule missing eventType returns null defense-in-depth', () => {
    const schedule = { type: 'event' } as never;
    expect(calculateNextRunAt(createDefinition(schedule), FIXED_NOW)).toBeNull();
  });

  it('preserves weekly empty-days current-day scheduler fallback', () => {
    const from = atLocal(2026, 4, 6, 10, 0).getTime();
    const schedule = expectOk(
      AutomationSchedule.fromUntrusted({
        type: 'weekly',
        daysOfWeek: [],
        time: '11:00',
      }),
    );

    expect(calculateNextRunAt(createDefinition(schedule), from)).toBe(atLocal(2026, 4, 6, 11, 0).getTime());
  });

  it('preserves monthly empty-days current-day scheduler fallback', () => {
    const from = atLocal(2026, 4, 6, 10, 0).getTime();
    const schedule = expectOk(
      AutomationSchedule.fromUntrusted({
        type: 'monthly',
        daysOfMonth: [],
        time: '11:00',
      }),
    );

    expect(calculateNextRunAt(createDefinition(schedule), from)).toBe(atLocal(2026, 4, 6, 11, 0).getTime());
  });
});

describe('AutomationSchedule constructors (C11 — round-trip positive coverage)', () => {
  it('hourly round-trips through fromUntrusted', () => {
    const built = AutomationSchedule.hourly({ minute: 30 });
    expect(built).toEqual({ type: 'hourly', minute: 30 });
    expect(expectOk(AutomationSchedule.fromUntrusted(built))).toEqual(built);
  });

  it('daily round-trips (no additionalTimes)', () => {
    const built = AutomationSchedule.daily({ time: '09:00' });
    expect(built).toEqual({ type: 'daily', time: '09:00' });
    expect(expectOk(AutomationSchedule.fromUntrusted(built))).toEqual(built);
  });

  it('daily round-trips (with additionalTimes)', () => {
    const built = AutomationSchedule.daily({ time: '09:00', additionalTimes: ['12:30'] });
    expect(built).toEqual({ type: 'daily', time: '09:00', additionalTimes: ['12:30'] });
    expect(expectOk(AutomationSchedule.fromUntrusted(built))).toEqual(built);
  });

  it('everyNDays round-trips', () => {
    const built = AutomationSchedule.everyNDays({
      intervalDays: 14,
      time: '09:30',
      anchorDate: '2026-04-01',
    });
    expect(built).toEqual({
      type: 'every_n_days',
      intervalDays: 14,
      time: '09:30',
      anchorDate: '2026-04-01',
    });
    expect(expectOk(AutomationSchedule.fromUntrusted(built))).toEqual(built);
  });

  it('weekly round-trips', () => {
    const built = AutomationSchedule.weekly({ daysOfWeek: [1, 3, 5], time: '08:15' });
    expect(built).toEqual({ type: 'weekly', daysOfWeek: [1, 3, 5], time: '08:15' });
    expect(expectOk(AutomationSchedule.fromUntrusted(built))).toEqual(built);
  });

  it('monthly round-trips (no runOnLastDayIfShorter)', () => {
    const built = AutomationSchedule.monthly({ daysOfMonth: [1, 15], time: '08:00' });
    expect(built).toEqual({ type: 'monthly', daysOfMonth: [1, 15], time: '08:00' });
    expect(expectOk(AutomationSchedule.fromUntrusted(built))).toEqual(built);
  });

  it('monthly round-trips (with runOnLastDayIfShorter)', () => {
    const built = AutomationSchedule.monthly({
      daysOfMonth: [31],
      time: '08:00',
      runOnLastDayIfShorter: true,
    });
    expect(built).toEqual({
      type: 'monthly',
      daysOfMonth: [31],
      time: '08:00',
      runOnLastDayIfShorter: true,
    });
    expect(expectOk(AutomationSchedule.fromUntrusted(built))).toEqual(built);
  });

  it('event round-trips', () => {
    const built = AutomationSchedule.event({ eventType: 'transcript-ready' });
    expect(built).toEqual({ type: 'event', eventType: 'transcript-ready' });
    expect(expectOk(AutomationSchedule.fromUntrusted(built))).toEqual(built);
  });

  it('once round-trips', () => {
    const built = AutomationSchedule.once({ dateTime: '2026-03-26T15:00:00' });
    expect(built).toEqual({ type: 'once', dateTime: '2026-03-26T15:00:00' });
    expect(expectOk(AutomationSchedule.fromUntrusted(built))).toEqual(built);
  });

  it('throws on invalid args (caller-side error)', () => {
    expect(() => AutomationSchedule.hourly({ minute: 99 })).toThrow(/minute|59|too_big|too big/i);
  });
});
