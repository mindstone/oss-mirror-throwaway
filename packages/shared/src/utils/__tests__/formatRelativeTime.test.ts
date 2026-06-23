/**
 * Comprehensive tests for the unified formatRelativeTime utility.
 * Covers all 9 behavioral variants across the codebase.
 */

import { formatRelativeTime } from '../formatRelativeTime';

// Helpers
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Pin Date.now() to prevent flaky boundary tests where ms drift between
// test setup and function execution could cross a threshold.
const FIXED_NOW = 1_700_000_000_000; // arbitrary fixed timestamp
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW); });
afterEach(() => { vi.restoreAllMocks(); });

/** Create a past timestamp relative to pinned "now". */
const ago = (ms: number): number => FIXED_NOW - ms;
/** Create a future timestamp relative to pinned "now". */
const ahead = (ms: number): number => FIXED_NOW + ms;

describe('formatRelativeTime', () => {
  // ─── Default behaviour (legacy memory panel pattern) ──────────────────────

  describe('defaults (legacy memory panel)', () => {
    it('returns "Just now" for < 1 minute ago', () => {
      expect(formatRelativeTime(Date.now())).toBe('Just now');
      expect(formatRelativeTime(ago(30_000))).toBe('Just now');
      expect(formatRelativeTime(ago(59_000))).toBe('Just now');
    });

    it('returns "Xm ago" for 1–59 minutes', () => {
      expect(formatRelativeTime(ago(MINUTE))).toBe('1m ago');
      expect(formatRelativeTime(ago(5 * MINUTE))).toBe('5m ago');
      expect(formatRelativeTime(ago(59 * MINUTE))).toBe('59m ago');
    });

    it('returns "Xh ago" for 1–23 hours', () => {
      expect(formatRelativeTime(ago(HOUR))).toBe('1h ago');
      expect(formatRelativeTime(ago(3 * HOUR))).toBe('3h ago');
      expect(formatRelativeTime(ago(23 * HOUR))).toBe('23h ago');
    });

    it('returns "Yesterday" for exactly 1 day', () => {
      expect(formatRelativeTime(ago(DAY))).toBe('Yesterday');
    });

    it('returns "Xd ago" for 2–6 days', () => {
      expect(formatRelativeTime(ago(2 * DAY))).toBe('2d ago');
      expect(formatRelativeTime(ago(3 * DAY))).toBe('3d ago');
      expect(formatRelativeTime(ago(6 * DAY))).toBe('6d ago');
    });

    it('returns locale date for 7+ days', () => {
      const result = formatRelativeTime(ago(7 * DAY));
      expect(result).not.toContain('ago');
      expect(result).not.toBe('Just now');
    });

    it('treats future timestamps as "Just now" (direction: past)', () => {
      expect(formatRelativeTime(ahead(5 * MINUTE))).toBe('Just now');
      expect(formatRelativeTime(ahead(DAY))).toBe('Just now');
    });
  });

  // ─── direction: 'both' ────────────────────────────────────────────────────

  describe('direction: "both"', () => {
    const opts = { direction: 'both' as const };

    it('returns "Any moment" for < 1 minute in the future', () => {
      expect(formatRelativeTime(ahead(10_000), opts)).toBe('Any moment');
      expect(formatRelativeTime(ahead(30_000), opts)).toBe('Any moment');
    });

    it('returns "in Xm" for 1–59 minutes in the future', () => {
      expect(formatRelativeTime(ahead(MINUTE), opts)).toBe('in 1m');
      expect(formatRelativeTime(ahead(5 * MINUTE), opts)).toBe('in 5m');
    });

    it('returns "in Xh" for 1–23 hours in the future', () => {
      expect(formatRelativeTime(ahead(HOUR), opts)).toBe('in 1h');
      expect(formatRelativeTime(ahead(12 * HOUR), opts)).toBe('in 12h');
    });

    it('returns "Tomorrow" for exactly 1 day in the future', () => {
      expect(formatRelativeTime(ahead(DAY), opts)).toBe('Tomorrow');
    });

    it('returns "in Xd" for 2–6 days in the future', () => {
      expect(formatRelativeTime(ahead(2 * DAY), opts)).toBe('in 2d');
      expect(formatRelativeTime(ahead(5 * DAY), opts)).toBe('in 5d');
    });

    it('returns locale date for 7+ days in the future', () => {
      const result = formatRelativeTime(ahead(10 * DAY), opts);
      expect(result).not.toContain('in ');
      expect(result).not.toBe('Tomorrow');
    });

    it('still handles past timestamps correctly', () => {
      expect(formatRelativeTime(ago(5 * MINUTE), opts)).toBe('5m ago');
      expect(formatRelativeTime(ago(DAY), opts)).toBe('Yesterday');
    });
  });

  // ─── capitalize: false ────────────────────────────────────────────────────

  describe('capitalize: false', () => {
    const opts = { capitalize: false };

    it('returns "just now" (lowercase)', () => {
      expect(formatRelativeTime(ago(10_000), opts)).toBe('just now');
    });

    it('returns "yesterday" (lowercase)', () => {
      expect(formatRelativeTime(ago(DAY), opts)).toBe('yesterday');
    });

    it('future with direction: both returns lowercase "any moment"', () => {
      expect(formatRelativeTime(ahead(10_000), { capitalize: false, direction: 'both' })).toBe('any moment');
    });

    it('future with direction: both returns lowercase "tomorrow"', () => {
      expect(formatRelativeTime(ahead(DAY), { capitalize: false, direction: 'both' })).toBe('tomorrow');
    });

    it('future with direction: past returns lowercase "just now"', () => {
      expect(formatRelativeTime(ahead(5 * MINUTE), opts)).toBe('just now');
    });
  });

  // ─── includeMinutes: false ────────────────────────────────────────────────

  describe('includeMinutes: false (SpacesActivityPanel / PendingAudioPopover)', () => {
    const opts = { includeMinutes: false };

    it('returns "Just now" for anything < 1 hour', () => {
      expect(formatRelativeTime(ago(10_000), opts)).toBe('Just now');
      expect(formatRelativeTime(ago(30 * MINUTE), opts)).toBe('Just now');
      expect(formatRelativeTime(ago(59 * MINUTE), opts)).toBe('Just now');
    });

    it('still shows hours normally', () => {
      expect(formatRelativeTime(ago(HOUR), opts)).toBe('1h ago');
      expect(formatRelativeTime(ago(3 * HOUR), opts)).toBe('3h ago');
    });

    it('still shows Yesterday and days', () => {
      expect(formatRelativeTime(ago(DAY), opts)).toBe('Yesterday');
      expect(formatRelativeTime(ago(3 * DAY), opts)).toBe('3d ago');
    });

    it('future with includeMinutes: false and direction: both shows "Any moment"', () => {
      expect(formatRelativeTime(ahead(30 * MINUTE), {
        includeMinutes: false,
        direction: 'both',
      })).toBe('Any moment');
    });
  });

  // ─── includeYesterday: false ──────────────────────────────────────────────

  describe('includeYesterday: false', () => {
    it('shows "1d ago" instead of "Yesterday"', () => {
      expect(formatRelativeTime(ago(DAY), { includeYesterday: false })).toBe('1d ago');
    });

    it('shows "in 1d" instead of "Tomorrow" (with direction: both)', () => {
      expect(formatRelativeTime(ahead(DAY), {
        includeYesterday: false,
        direction: 'both',
      })).toBe('in 1d');
    });
  });

  // ─── abbreviateDays: false (AutomationsPanel) ────────────────────────────

  describe('abbreviateDays: false', () => {
    const opts = { abbreviateDays: false };

    it('shows "3 days ago" instead of "3d ago"', () => {
      expect(formatRelativeTime(ago(3 * DAY), opts)).toBe('3 days ago');
    });

    it('shows "1 day ago" (singular) when includeYesterday is false', () => {
      expect(formatRelativeTime(ago(DAY), {
        abbreviateDays: false,
        includeYesterday: false,
      })).toBe('1 day ago');
    });

    it('shows "in 3 days" for future (with direction: both)', () => {
      expect(formatRelativeTime(ahead(3 * DAY), {
        abbreviateDays: false,
        direction: 'both',
      })).toBe('in 3 days');
    });

    it('shows "in 1 day" (singular) for future when includeYesterday is false', () => {
      expect(formatRelativeTime(ahead(DAY), {
        abbreviateDays: false,
        includeYesterday: false,
        direction: 'both',
      })).toBe('in 1 day');
    });
  });

  // ─── includeWeeks: true (UnifiedSearchResults) ───────────────────────────

  describe('includeWeeks: true', () => {
    const opts = { includeWeeks: true, absoluteDateAfterDays: false as const };

    it('shows "1w ago" for 7 days', () => {
      expect(formatRelativeTime(ago(7 * DAY), opts)).toBe('1w ago');
    });

    it('shows "2w ago" for 14 days', () => {
      expect(formatRelativeTime(ago(14 * DAY), opts)).toBe('2w ago');
    });

    it('shows "4w ago" for 29 days', () => {
      expect(formatRelativeTime(ago(29 * DAY), opts)).toBe('4w ago');
    });

    it('still shows days for < 7 days', () => {
      expect(formatRelativeTime(ago(5 * DAY), opts)).toBe('5d ago');
    });

    it('shows weeks for 30+ days when includeMonths is false', () => {
      // 35 days with no months → weeks
      expect(formatRelativeTime(ago(35 * DAY), opts)).toBe('5w ago');
    });
  });

  // ─── includeMonths: true (MentionPopover) ─────────────────────────────────

  describe('includeMonths: true', () => {
    const opts = {
      includeWeeks: true,
      includeMonths: true,
      absoluteDateAfterDays: false as const,
    };

    it('shows "1mo ago" for 30 days', () => {
      expect(formatRelativeTime(ago(30 * DAY), opts)).toBe('1mo ago');
    });

    it('shows "3mo ago" for 90 days', () => {
      expect(formatRelativeTime(ago(90 * DAY), opts)).toBe('3mo ago');
    });

    it('shows weeks for 14 days (not months)', () => {
      expect(formatRelativeTime(ago(14 * DAY), opts)).toBe('2w ago');
    });

    it('shows months at 30-day boundary', () => {
      expect(formatRelativeTime(ago(31 * DAY), opts)).toBe('1mo ago');
    });
  });

  // ─── absoluteDateAfterDays: false ─────────────────────────────────────────

  describe('absoluteDateAfterDays: false (never show locale date)', () => {
    it('shows "Xd ago" indefinitely', () => {
      const opts = { absoluteDateAfterDays: false as const };
      expect(formatRelativeTime(ago(10 * DAY), opts)).toBe('10d ago');
      expect(formatRelativeTime(ago(100 * DAY), opts)).toBe('100d ago');
      expect(formatRelativeTime(ago(365 * DAY), opts)).toBe('365d ago');
    });
  });

  // ─── absoluteDateAfterDays: 1 (PendingMemorySection) ─────────────────────

  describe('absoluteDateAfterDays: 1', () => {
    const opts = { includeYesterday: false, absoluteDateAfterDays: 1 };

    it('shows hours for < 24 hours', () => {
      expect(formatRelativeTime(ago(3 * HOUR), opts)).toBe('3h ago');
    });

    it('shows locale date for 1+ days', () => {
      const result = formatRelativeTime(ago(DAY), opts);
      expect(result).not.toContain('ago');
      expect(result).not.toBe('Yesterday');
    });

    it('shows locale date for 3 days', () => {
      const result = formatRelativeTime(ago(3 * DAY), opts);
      expect(result).not.toContain('ago');
    });
  });

  // ─── Compound options (exact call-site configs) ───────────────────────────

  describe('SendToRebelDialog config', () => {
    const opts = { capitalize: false, includeYesterday: false, absoluteDateAfterDays: false as const };

    it('returns "just now" (lowercase, no locale date)', () => {
      expect(formatRelativeTime(ago(10_000), opts)).toBe('just now');
    });

    it('shows "1d ago" (no yesterday)', () => {
      expect(formatRelativeTime(ago(DAY), opts)).toBe('1d ago');
    });

    it('never shows locale date', () => {
      expect(formatRelativeTime(ago(100 * DAY), opts)).toBe('100d ago');
    });
  });

  describe('UnifiedSearchResults config', () => {
    const opts = { capitalize: false, includeWeeks: true, absoluteDateAfterDays: false as const };

    it('returns "just now" (lowercase)', () => {
      expect(formatRelativeTime(ago(10_000), opts)).toBe('just now');
    });

    it('returns "yesterday" (lowercase)', () => {
      expect(formatRelativeTime(ago(DAY), opts)).toBe('yesterday');
    });

    it('shows weeks', () => {
      expect(formatRelativeTime(ago(14 * DAY), opts)).toBe('2w ago');
    });

    it('shows weeks beyond 30 days (no months)', () => {
      expect(formatRelativeTime(ago(35 * DAY), opts)).toBe('5w ago');
    });
  });

  describe('MentionPopover config', () => {
    const opts = {
      capitalize: false,
      includeWeeks: true,
      includeMonths: true,
      absoluteDateAfterDays: false as const,
    };

    it('returns "just now" (lowercase)', () => {
      expect(formatRelativeTime(ago(10_000), opts)).toBe('just now');
    });

    it('returns "yesterday" (lowercase)', () => {
      expect(formatRelativeTime(ago(DAY), opts)).toBe('yesterday');
    });

    it('shows weeks for 14 days', () => {
      expect(formatRelativeTime(ago(14 * DAY), opts)).toBe('2w ago');
    });

    it('shows months for 60 days', () => {
      expect(formatRelativeTime(ago(60 * DAY), opts)).toBe('2mo ago');
    });

    it('never shows locale date', () => {
      expect(formatRelativeTime(ago(365 * DAY), opts)).toBe('12mo ago');
    });
  });

  describe('AutomationsPanel config', () => {
    const opts = { direction: 'both' as const, abbreviateDays: false };

    it('past: shows "Yesterday"', () => {
      expect(formatRelativeTime(ago(DAY), opts)).toBe('Yesterday');
    });

    it('past: shows unabbreviated "3 days ago"', () => {
      expect(formatRelativeTime(ago(3 * DAY), opts)).toBe('3 days ago');
    });

    it('future: shows "Tomorrow"', () => {
      expect(formatRelativeTime(ahead(DAY), opts)).toBe('Tomorrow');
    });

    it('future: shows unabbreviated "in 3 days"', () => {
      expect(formatRelativeTime(ahead(3 * DAY), opts)).toBe('in 3 days');
    });

    it('future: shows "Any moment"', () => {
      expect(formatRelativeTime(ahead(10_000), opts)).toBe('Any moment');
    });
  });

  describe('cloud-client config', () => {
    const opts = { direction: 'both' as const };

    it('past: "Just now" for < 1 minute', () => {
      expect(formatRelativeTime(ago(30_000), opts)).toBe('Just now');
    });

    it('past: minutes', () => {
      expect(formatRelativeTime(ago(5 * MINUTE), opts)).toBe('5m ago');
    });

    it('past: hours', () => {
      expect(formatRelativeTime(ago(3 * HOUR), opts)).toBe('3h ago');
    });

    it('past: "Yesterday" for 1 day', () => {
      expect(formatRelativeTime(ago(DAY), opts)).toBe('Yesterday');
    });

    it('past: locale date for 7+ days', () => {
      const result = formatRelativeTime(ago(7 * DAY), opts);
      expect(result).not.toContain('ago');
    });

    it('future: "Any moment" for < 1 minute', () => {
      expect(formatRelativeTime(ahead(10_000), opts)).toBe('Any moment');
    });

    it('future: "Tomorrow" for 1 day', () => {
      expect(formatRelativeTime(ahead(DAY), opts)).toBe('Tomorrow');
    });

    it('future: locale date for 7+ days', () => {
      const result = formatRelativeTime(ahead(10 * DAY), opts);
      expect(result).not.toContain('in ');
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles exactly 0 diff', () => {
      expect(formatRelativeTime(FIXED_NOW)).toBe('Just now');
    });

    it('handles 60-minute boundary (becomes 1h)', () => {
      expect(formatRelativeTime(ago(60 * MINUTE))).toBe('1h ago');
    });

    it('handles 24-hour boundary (becomes Yesterday)', () => {
      expect(formatRelativeTime(ago(24 * HOUR))).toBe('Yesterday');
    });

    it('handles very large past values', () => {
      const result = formatRelativeTime(ago(1000 * DAY));
      // Should return a locale date (default absoluteDateAfterDays: 7)
      expect(result).not.toContain('ago');
    });

    it('handles very large past values with absoluteDateAfterDays: false', () => {
      const result = formatRelativeTime(ago(1000 * DAY), { absoluteDateAfterDays: false });
      expect(result).toBe('1000d ago');
    });

    it('handles negative timestamps gracefully', () => {
      // A timestamp of 0 (epoch) should work — it's a very old date
      const result = formatRelativeTime(0);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles epoch 0 with absoluteDateAfterDays: false', () => {
      const result = formatRelativeTime(0, { absoluteDateAfterDays: false });
      expect(result).toMatch(/^\d+d ago$/);
    });

    it('handles NaN timestamp gracefully', () => {
      expect(formatRelativeTime(NaN)).toBe('Just now');
      expect(formatRelativeTime(NaN, { capitalize: false })).toBe('just now');
    });

    it('handles Infinity timestamp gracefully', () => {
      expect(formatRelativeTime(Infinity)).toBe('Just now');
      expect(formatRelativeTime(-Infinity)).toBe('Just now');
    });
  });
});
