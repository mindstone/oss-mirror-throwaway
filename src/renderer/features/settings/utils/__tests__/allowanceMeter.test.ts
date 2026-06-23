import { describe, expect, it } from 'vitest';
import {
  formatOrdinalDayOfMonth,
  formatUsdAmount,
  getBillingAnchorDay,
  isAllowanceAvailable,
  meterStateForRatio,
} from '../allowanceMeter';

describe('meterStateForRatio (Stage H1)', () => {
  it('returns neutral below 75%', () => {
    expect(meterStateForRatio(0)).toBe('neutral');
    expect(meterStateForRatio(0.5)).toBe('neutral');
    expect(meterStateForRatio(0.7499)).toBe('neutral');
  });

  it('returns warning at exactly 75% and through 90%', () => {
    expect(meterStateForRatio(0.75)).toBe('warning');
    expect(meterStateForRatio(0.8)).toBe('warning');
    expect(meterStateForRatio(0.9)).toBe('warning');
  });

  it('returns critical above 90%', () => {
    expect(meterStateForRatio(0.9001)).toBe('critical');
    expect(meterStateForRatio(1)).toBe('critical');
    expect(meterStateForRatio(2)).toBe('critical');
  });

  it('defaults to neutral on non-finite input', () => {
    expect(meterStateForRatio(Number.NaN)).toBe('neutral');
    expect(meterStateForRatio(Number.POSITIVE_INFINITY)).toBe('neutral');
  });
});

describe('isAllowanceAvailable (Stage H1)', () => {
  it('treats zero or negative limit as unavailable', () => {
    expect(isAllowanceAvailable({ creditLimitMonthly: 0, creditUsedMonthly: 0 })).toBe(false);
    expect(isAllowanceAvailable({ creditLimitMonthly: -1, creditUsedMonthly: 0 })).toBe(false);
  });

  it('treats missing fields as unavailable', () => {
    expect(isAllowanceAvailable({ creditLimitMonthly: undefined, creditUsedMonthly: 0 })).toBe(false);
    expect(isAllowanceAvailable({ creditLimitMonthly: 100, creditUsedMonthly: undefined })).toBe(false);
    expect(isAllowanceAvailable({ creditLimitMonthly: undefined, creditUsedMonthly: undefined })).toBe(false);
  });

  it('treats negative used as unavailable', () => {
    expect(isAllowanceAvailable({ creditLimitMonthly: 100, creditUsedMonthly: -1 })).toBe(false);
  });

  it('treats positive limit + zero+ used as available', () => {
    expect(isAllowanceAvailable({ creditLimitMonthly: 20000, creditUsedMonthly: 0 })).toBe(true);
    expect(isAllowanceAvailable({ creditLimitMonthly: 20000, creditUsedMonthly: 5000 })).toBe(true);
  });
});

describe('formatUsdAmount (Stage H1)', () => {
  it('formats whole-dollar amounts with two decimals', () => {
    // Locale-dependent currency placement; assert it contains the right number.
    const out = formatUsdAmount(20000, 'USD');
    expect(out).toMatch(/200\.00/);
  });

  it('formats fractional cents correctly', () => {
    const out = formatUsdAmount(12345, 'USD');
    expect(out).toMatch(/123\.45/);
  });

  it('falls back to plain $X.XX on invalid currency code', () => {
    const out = formatUsdAmount(20000, 'NOT-A-CODE');
    expect(out).toBe('$200.00');
  });
});

describe('formatOrdinalDayOfMonth (Stage H6)', () => {
  it('returns 1st for days ending in 1 (non-11)', () => {
    expect(formatOrdinalDayOfMonth('2026-06-01T12:00:00.000Z')).toBe('1st');
  });

  it('returns 2nd for days ending in 2 (non-12)', () => {
    expect(formatOrdinalDayOfMonth('2026-06-02T12:00:00.000Z')).toBe('2nd');
  });

  it('returns 3rd for days ending in 3 (non-13)', () => {
    expect(formatOrdinalDayOfMonth('2026-06-03T12:00:00.000Z')).toBe('3rd');
  });

  it('returns th for days ending in 4', () => {
    expect(formatOrdinalDayOfMonth('2026-06-04T12:00:00.000Z')).toBe('4th');
  });

  it('special-cases 11 as 11th', () => {
    expect(formatOrdinalDayOfMonth('2026-06-11T12:00:00.000Z')).toBe('11th');
  });

  it('special-cases 12 as 12th', () => {
    expect(formatOrdinalDayOfMonth('2026-06-12T12:00:00.000Z')).toBe('12th');
  });

  it('special-cases 13 as 13th', () => {
    expect(formatOrdinalDayOfMonth('2026-06-13T12:00:00.000Z')).toBe('13th');
  });

  it('returns th for 14', () => {
    expect(formatOrdinalDayOfMonth('2026-06-14T12:00:00.000Z')).toBe('14th');
  });

  it('returns 21st for 21', () => {
    expect(formatOrdinalDayOfMonth('2026-06-21T12:00:00.000Z')).toBe('21st');
  });

  it('returns 22nd for 22', () => {
    expect(formatOrdinalDayOfMonth('2026-06-22T12:00:00.000Z')).toBe('22nd');
  });

  it('returns 23rd for 23', () => {
    expect(formatOrdinalDayOfMonth('2026-06-23T12:00:00.000Z')).toBe('23rd');
  });

  it('returns 31st for 31', () => {
    expect(formatOrdinalDayOfMonth('2026-07-31T12:00:00.000Z')).toBe('31st');
  });

  it('reads day-of-month in UTC, not local timezone', () => {
    // 2026-06-15T00:00:00Z is 15th in UTC. In any timezone west of UTC this
    // ISO would parse to 14th locally. The formatter MUST return the UTC day
    // so it stays consistent with getBillingAnchorDay (which keys H7
    // dismissal) and with the Stripe-shipped renewal day-of-month.
    expect(formatOrdinalDayOfMonth('2026-06-15T00:00:00.000Z')).toBe('15th');
  });

  it('returns null for null', () => {
    expect(formatOrdinalDayOfMonth(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(formatOrdinalDayOfMonth(undefined)).toBeNull();
  });

  it('returns null for invalid date strings', () => {
    expect(formatOrdinalDayOfMonth('not-a-date')).toBeNull();
  });
});

describe('getBillingAnchorDay', () => {
  it('returns the day-of-month for a valid ISO timestamp', () => {
    expect(getBillingAnchorDay('2026-06-14T12:00:00.000Z')).toBe(14);
  });

  it('returns the day-of-month for the 1st', () => {
    expect(getBillingAnchorDay('2026-07-01T12:00:00.000Z')).toBe(1);
  });

  it('returns null for null/undefined inputs', () => {
    expect(getBillingAnchorDay(null)).toBeNull();
    expect(getBillingAnchorDay(undefined)).toBeNull();
  });

  it('returns null for unparseable strings', () => {
    expect(getBillingAnchorDay('not-a-date')).toBeNull();
  });

  it('reads day-of-month in UTC, not local timezone', () => {
    // The anchor day is keyed by Stripe's UTC ISO renewal. Reading local day
    // would silently shift the anchor for users east of UTC and re-show H7
    // dismissed callouts on travel/DST boundaries.
    expect(getBillingAnchorDay('2026-06-15T00:00:00.000Z')).toBe(15);
  });
});
