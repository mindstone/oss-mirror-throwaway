import {
  getEndOfWeekDueBy,
  getNextMondayDueBy,
  getSnoozeDueBy,
} from '../utils/dateHelpers';

type DayCase = {
  label: string;
  now: Date;
  expectedDaysUntilSunday: number;
  expectedDaysUntilNextMonday: number;
};

const dayCases: DayCase[] = [
  {
    label: 'Monday',
    now: new Date(2026, 2, 9, 12, 0, 0, 0),
    expectedDaysUntilSunday: 6,
    expectedDaysUntilNextMonday: 7,
  },
  {
    label: 'Tuesday',
    now: new Date(2026, 2, 10, 12, 0, 0, 0),
    expectedDaysUntilSunday: 5,
    expectedDaysUntilNextMonday: 6,
  },
  {
    label: 'Wednesday',
    now: new Date(2026, 2, 11, 12, 0, 0, 0),
    expectedDaysUntilSunday: 4,
    expectedDaysUntilNextMonday: 5,
  },
  {
    label: 'Thursday',
    now: new Date(2026, 2, 12, 12, 0, 0, 0),
    expectedDaysUntilSunday: 3,
    expectedDaysUntilNextMonday: 4,
  },
  {
    label: 'Friday',
    now: new Date(2026, 2, 13, 12, 0, 0, 0),
    expectedDaysUntilSunday: 2,
    expectedDaysUntilNextMonday: 3,
  },
  {
    label: 'Saturday',
    now: new Date(2026, 2, 14, 12, 0, 0, 0),
    expectedDaysUntilSunday: 1,
    expectedDaysUntilNextMonday: 2,
  },
  {
    label: 'Sunday',
    now: new Date(2026, 2, 15, 12, 0, 0, 0),
    expectedDaysUntilSunday: 7,
    expectedDaysUntilNextMonday: 1,
  },
];

function dayDiff(from: Date, to: Date): number {
  const fromUtc = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const toUtc = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return (toUtc - fromUtc) / (24 * 60 * 60 * 1000);
}

describe('dateHelpers', () => {
  describe('getEndOfWeekDueBy', () => {
    it.each(dayCases)('returns end-of-week due date for $label', ({ now, expectedDaysUntilSunday }) => {
      const dueBy = new Date(getEndOfWeekDueBy(now));

      expect(dayDiff(now, dueBy)).toBe(expectedDaysUntilSunday);
      expect(dueBy.getDay()).toBe(0);
      expect(dueBy.getHours()).toBe(23);
      expect(dueBy.getMinutes()).toBe(59);
      expect(dueBy.getSeconds()).toBe(59);
      expect(dueBy.getMilliseconds()).toBe(999);
    });
  });

  describe('getNextMondayDueBy', () => {
    it.each(dayCases)('returns next Monday due date for $label', ({ now, expectedDaysUntilNextMonday }) => {
      const dueBy = new Date(getNextMondayDueBy(now));

      expect(dayDiff(now, dueBy)).toBe(expectedDaysUntilNextMonday);
      expect(dueBy.getDay()).toBe(1);
      expect(dueBy.getHours()).toBe(0);
      expect(dueBy.getMinutes()).toBe(0);
      expect(dueBy.getSeconds()).toBe(0);
      expect(dueBy.getMilliseconds()).toBe(0);
    });
  });

  describe('getSnoozeDueBy', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns end-of-week due date for due-today', () => {
      const now = new Date(2026, 2, 10, 9, 30, 0, 0);
      jest.setSystemTime(now);

      expect(getSnoozeDueBy('due-today')).toBe(getEndOfWeekDueBy(now));
    });

    it('returns next Monday due date for due-this-week', () => {
      const now = new Date(2026, 2, 12, 9, 30, 0, 0);
      jest.setSystemTime(now);

      expect(getSnoozeDueBy('due-this-week')).toBe(getNextMondayDueBy(now));
    });

    it('returns null for upcoming', () => {
      expect(getSnoozeDueBy('upcoming')).toBeNull();
    });
  });
});
