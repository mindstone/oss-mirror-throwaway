import { describe, it, expect, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  }),
}));

import { assembleFocusContext } from '../focusContextAssembler';
import { getCurrentWeekBounds } from '../calendarTimeUtils';
import type { CachedMeeting } from '@core/services/meetingCacheStore';
import type { Goal } from '@core/goalTypes';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMeeting(overrides: Partial<CachedMeeting> & { startTime: string }): CachedMeeting {
  return {
    id: overrides.id ?? `meeting-${Math.random().toString(36).slice(2)}`,
    calendarEventId: overrides.calendarEventId ?? 'evt-1',
    calendarSource: overrides.calendarSource ?? 'google',
    title: overrides.title ?? 'Test Meeting',
    startTime: overrides.startTime,
    endTime:
      overrides.endTime ??
      new Date(new Date(overrides.startTime).getTime() + 3600000).toISOString(),
    participants: overrides.participants ?? ['Alice', 'Bob'],
    participantEmails: overrides.participantEmails,
    prepPath: overrides.prepPath,
    meetingUrl: overrides.meetingUrl,
  };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: overrides.id ?? `goal-${Math.random().toString(36).slice(2)}`,
    text: overrides.text ?? 'Ship the feature',
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    why: overrides.why,
    outcome: overrides.outcome,
    obstacle: overrides.obstacle,
    plan: overrides.plan,
    lastReviewedAt: overrides.lastReviewedAt,
    quarterTag: overrides.quarterTag,
  };
}

/** Use UTC for deterministic tests regardless of host timezone. */
const TZ = 'UTC';

// Use a fixed "now" so tests are deterministic.
const FIXED_NOW = new Date('2026-04-08T14:00:00Z'); // Apr 8, 2026 14:00 UTC (Wednesday)

const { weekStart: WEEK_START } = getCurrentWeekBounds(FIXED_NOW, TZ);

/**
 * Create a date for a specific day of the week relative to the test week's Monday.
 * dayOffset: 0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat, 6=Sun
 *
 * Uses UTC arithmetic so the resulting instant is deterministic regardless of
 * the host process timezone. (Historically this used setHours/setDate which
 * interpret in host-local time — on hosts west of UTC that silently shifted
 * meetings into the previous week and made filterMeetingsToCurrentWeek drop
 * them, causing 8 tests to fail with "expected ... to contain '<focus-context>'".)
 */
function dayInWeek(dayOffset: number, hour = 10, minute = 0): Date {
  const d = new Date(WEEK_START);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// assembleFocusContext
// ---------------------------------------------------------------------------

describe('assembleFocusContext', () => {
  describe('empty state', () => {
    it('returns simplified preamble when no meetings, goals, or narrative', () => {
      const result = assembleFocusContext([], [], undefined, FIXED_NOW, TZ);
      expect(result).toContain('[FOCUS CONVERSATION]');
      expect(result).toContain('No calendar data, goals, or week narrative are available yet');
      expect(result).not.toContain('<focus-context>');
      expect(result).not.toContain('<calendar-this-week>');
      expect(result).not.toContain('<goals>');
      expect(result).not.toContain('<week-narrative>');
    });

    it('returns simplified preamble with empty narrative string', () => {
      const result = assembleFocusContext([], [], '', FIXED_NOW, TZ);
      expect(result).toContain('No calendar data, goals, or week narrative are available yet');
    });

    it('returns simplified preamble with whitespace-only narrative', () => {
      const result = assembleFocusContext([], [], '   ', FIXED_NOW, TZ);
      expect(result).toContain('No calendar data, goals, or week narrative are available yet');
    });
  });

  describe('meetings only', () => {
    it('includes calendar section and omits goals/narrative sections', () => {
      const meetings = [
        makeMeeting({
          startTime: dayInWeek(0, 9).toISOString(),
          title: 'Team standup',
          participants: ['Alice', 'Bob', 'Charlie'],
        }),
      ];

      const result = assembleFocusContext(meetings, [], undefined, FIXED_NOW, TZ);

      expect(result).toContain('[FOCUS CONVERSATION]');
      expect(result).toContain('<focus-context>');
      expect(result).toContain('<calendar-this-week>');
      expect(result).toContain('1 meeting this week');
      expect(result).toContain('"Team standup"');
      expect(result).toContain('3 participants');
      expect(result).toContain('</calendar-this-week>');
      expect(result).toContain('</focus-context>');
      expect(result).not.toContain('<goals>');
      expect(result).not.toContain('<week-narrative>');
      expect(result).toContain('Respond conversationally');
    });

    it('groups meetings by day and sorts by start time', () => {
      const meetings = [
        makeMeeting({
          startTime: dayInWeek(0, 14).toISOString(),
          title: 'Afternoon meeting',
        }),
        makeMeeting({
          startTime: dayInWeek(0, 9).toISOString(),
          title: 'Morning meeting',
        }),
        makeMeeting({
          startTime: dayInWeek(2, 11).toISOString(),
          title: 'Wednesday sync',
        }),
      ];

      const result = assembleFocusContext(meetings, [], undefined, FIXED_NOW, TZ);

      expect(result).toContain('3 meetings this week');
      expect(result).toContain('Monday');
      expect(result).toContain('Wednesday');
      // Morning should come before afternoon within the day block
      const morningIdx = result.indexOf('Morning meeting');
      const afternoonIdx = result.indexOf('Afternoon meeting');
      expect(morningIdx).toBeLessThan(afternoonIdx);
    });

    it('shows prep document indicator when present', () => {
      const meetings = [
        makeMeeting({
          startTime: dayInWeek(1, 10).toISOString(),
          title: 'With prep',
          prepPath: '/path/to/doc.md',
        }),
        makeMeeting({
          startTime: dayInWeek(1, 14).toISOString(),
          title: 'Without prep',
        }),
      ];

      const result = assembleFocusContext(meetings, [], undefined, FIXED_NOW, TZ);

      expect(result).toContain('has prep document');
      // The meeting without prep should NOT have the prep mention
      const lines = result.split('\n');
      const withoutPrepLine = lines.find((l) => l.includes('Without prep'));
      expect(withoutPrepLine).toBeDefined();
      expect(withoutPrepLine).not.toContain('prep document');
    });

    it('shows singular participant count', () => {
      const meetings = [
        makeMeeting({
          startTime: dayInWeek(0, 10).toISOString(),
          title: 'Solo meeting',
          participants: ['Just Me'],
        }),
      ];

      const result = assembleFocusContext(meetings, [], undefined, FIXED_NOW, TZ);
      expect(result).toContain('1 participant');
      expect(result).not.toContain('1 participants');
    });
  });

  describe('goals only', () => {
    it('includes goals section and omits calendar/narrative sections', () => {
      const goals = [makeGoal({ text: 'Finish Q2 strategy' })];

      const result = assembleFocusContext([], goals, undefined, FIXED_NOW, TZ);

      expect(result).toContain('[FOCUS CONVERSATION]');
      expect(result).toContain('<focus-context>');
      expect(result).toContain('<goals>');
      expect(result).toContain('1 active goal');
      expect(result).toContain('"Finish Q2 strategy"');
      expect(result).toContain('</goals>');
      expect(result).not.toContain('<calendar-this-week>');
      expect(result).not.toContain('<week-narrative>');
    });

    it('includes WOOP fields when populated', () => {
      const goals = [
        makeGoal({
          text: 'Finish Q2 strategy document',
          why: "Unblocks exec team's budget decisions",
          outcome: 'Full strategy doc reviewed and approved',
          obstacle: 'Getting pulled into tactical fires',
          plan: 'Block 2-hour focus sessions on Tuesday and Thursday mornings',
        }),
      ];

      const result = assembleFocusContext([], goals, undefined, FIXED_NOW, TZ);

      expect(result).toContain('"Finish Q2 strategy document"');
      expect(result).toContain("Why: Unblocks exec team's budget decisions");
      expect(result).toContain('Desired outcome: Full strategy doc reviewed and approved');
      expect(result).toContain('Main obstacle: Getting pulled into tactical fires');
      expect(result).toContain(
        'Plan: Block 2-hour focus sessions on Tuesday and Thursday mornings'
      );
    });

    it('excludes inactive goals', () => {
      const goals = [
        makeGoal({ text: 'Active one', status: 'active' }),
        makeGoal({ text: 'Completed one', status: 'completed' }),
        makeGoal({ text: 'Dropped one', status: 'dropped' }),
      ];

      const result = assembleFocusContext([], goals, undefined, FIXED_NOW, TZ);

      expect(result).toContain('1 active goal');
      expect(result).toContain('"Active one"');
      expect(result).not.toContain('Completed one');
      expect(result).not.toContain('Dropped one');
    });

    it('shows plural goals count', () => {
      const goals = [
        makeGoal({ text: 'Goal one' }),
        makeGoal({ text: 'Goal two' }),
      ];

      const result = assembleFocusContext([], goals, undefined, FIXED_NOW, TZ);
      expect(result).toContain('2 active goals');
    });

    it('omits absent WOOP fields', () => {
      const goals = [makeGoal({ text: 'Simple goal' })];

      const result = assembleFocusContext([], goals, undefined, FIXED_NOW, TZ);

      expect(result).toContain('"Simple goal"');
      expect(result).not.toContain('Why:');
      expect(result).not.toContain('Desired outcome:');
      expect(result).not.toContain('Main obstacle:');
      expect(result).not.toContain('Plan:');
    });
  });

  describe('all three sections', () => {
    it('includes calendar, goals, and narrative sections', () => {
      const meetings = [
        makeMeeting({
          startTime: dayInWeek(0, 9).toISOString(),
          title: 'Monday standup',
        }),
      ];
      const goals = [makeGoal({ text: 'Launch feature' })];
      const narrative = 'Your week is front-loaded with meetings Mon-Tue.';

      const result = assembleFocusContext(meetings, goals, narrative, FIXED_NOW, TZ);

      expect(result).toContain('[FOCUS CONVERSATION]');
      expect(result).toContain('<focus-context>');
      expect(result).toContain('<calendar-this-week>');
      expect(result).toContain('"Monday standup"');
      expect(result).toContain('</calendar-this-week>');
      expect(result).toContain('<goals>');
      expect(result).toContain('"Launch feature"');
      expect(result).toContain('</goals>');
      expect(result).toContain('<week-narrative>');
      expect(result).toContain('Your week is front-loaded with meetings Mon-Tue.');
      expect(result).toContain('</week-narrative>');
      expect(result).toContain('</focus-context>');
      expect(result).toContain('Respond conversationally');
    });
  });

  describe('meeting filtering', () => {
    it('filters out meetings outside current week', () => {
      const prevWeekDate = new Date(WEEK_START);
      prevWeekDate.setDate(prevWeekDate.getDate() - 7);
      prevWeekDate.setHours(10, 0, 0, 0);

      const nextWeekDate = new Date(WEEK_START);
      nextWeekDate.setDate(nextWeekDate.getDate() + 8);
      nextWeekDate.setHours(10, 0, 0, 0);

      const meetings = [
        makeMeeting({ startTime: prevWeekDate.toISOString(), title: 'Last week' }),
        makeMeeting({
          startTime: dayInWeek(2, 10).toISOString(),
          title: 'This week',
        }),
        makeMeeting({ startTime: nextWeekDate.toISOString(), title: 'Next week' }),
      ];

      const result = assembleFocusContext(meetings, [], undefined, FIXED_NOW, TZ);

      expect(result).toContain('1 meeting this week');
      expect(result).toContain('"This week"');
      expect(result).not.toContain('Last week');
      expect(result).not.toContain('Next week');
    });

    it('returns empty preamble when all meetings are outside current week', () => {
      const prevWeekDate = new Date(WEEK_START);
      prevWeekDate.setDate(prevWeekDate.getDate() - 7);
      prevWeekDate.setHours(10, 0, 0, 0);

      const meetings = [
        makeMeeting({ startTime: prevWeekDate.toISOString(), title: 'Last week only' }),
      ];

      const result = assembleFocusContext(meetings, [], undefined, FIXED_NOW, TZ);

      expect(result).toContain('No calendar data, goals, or week narrative are available yet');
    });
  });

  describe('meeting truncation', () => {
    it('truncates meetings beyond 30 with a note', () => {
      const meetings: CachedMeeting[] = [];
      // Create 35 meetings across the week (7 per day Mon-Fri)
      for (let day = 0; day < 5; day++) {
        for (let slot = 0; slot < 7; slot++) {
          meetings.push(
            makeMeeting({
              startTime: dayInWeek(day, 8 + slot).toISOString(),
              title: `Meeting D${day}S${slot}`,
            })
          );
        }
      }

      const result = assembleFocusContext(meetings, [], undefined, FIXED_NOW, TZ);

      expect(result).toContain('35 meetings this week');
      expect(result).toContain('... and 5 more meetings');
      // Should still show meetings (the first 30 by start time)
      expect(result).toContain('Meeting D0S0');
    });

    it('does not show truncation note at exactly 30 meetings', () => {
      const meetings: CachedMeeting[] = [];
      for (let day = 0; day < 5; day++) {
        for (let slot = 0; slot < 6; slot++) {
          meetings.push(
            makeMeeting({
              startTime: dayInWeek(day, 8 + slot).toISOString(),
              title: `Meeting D${day}S${slot}`,
            })
          );
        }
      }

      const result = assembleFocusContext(meetings, [], undefined, FIXED_NOW, TZ);

      expect(result).toContain('30 meetings this week');
      expect(result).not.toContain('... and');
    });

    it('shows singular note for exactly 1 extra meeting', () => {
      const meetings: CachedMeeting[] = [];
      // 31 meetings: 6 per day for 5 days = 30, plus 1 more
      for (let day = 0; day < 5; day++) {
        for (let slot = 0; slot < 6; slot++) {
          meetings.push(
            makeMeeting({
              startTime: dayInWeek(day, 8 + slot).toISOString(),
              title: `Meeting D${day}S${slot}`,
            })
          );
        }
      }
      meetings.push(
        makeMeeting({
          startTime: dayInWeek(4, 16).toISOString(),
          title: 'Extra meeting',
        })
      );

      const result = assembleFocusContext(meetings, [], undefined, FIXED_NOW, TZ);

      expect(result).toContain('31 meetings this week');
      expect(result).toContain('... and 1 more meeting');
      expect(result).not.toContain('1 more meetings');
    });
  });

  describe('narrative section', () => {
    it('includes narrative when provided', () => {
      const narrative =
        'Your week is front-loaded — 14 hours of meetings Mon-Wed, then mostly clear.';

      const result = assembleFocusContext([], [makeGoal()], narrative, FIXED_NOW, TZ);

      expect(result).toContain('<week-narrative>');
      expect(result).toContain(narrative);
      expect(result).toContain('</week-narrative>');
    });

    it('omits narrative section for empty string', () => {
      const result = assembleFocusContext([], [makeGoal()], '', FIXED_NOW, TZ);

      expect(result).not.toContain('<week-narrative>');
    });

    it('omits narrative section for undefined', () => {
      const result = assembleFocusContext([], [makeGoal()], undefined, FIXED_NOW, TZ);

      expect(result).not.toContain('<week-narrative>');
    });

    it('trims whitespace from narrative', () => {
      const result = assembleFocusContext(
        [],
        [makeGoal()],
        '  Trimmed narrative  ',
        FIXED_NOW,
        TZ,
      );

      expect(result).toContain('<week-narrative>\nTrimmed narrative\n</week-narrative>');
    });
  });

  describe('preamble structure', () => {
    it('includes the focus conversation header', () => {
      const result = assembleFocusContext(
        [makeMeeting({ startTime: dayInWeek(0, 9).toISOString() })],
        [],
        undefined,
        FIXED_NOW,
        TZ,
      );

      expect(result).toContain('[FOCUS CONVERSATION]');
      expect(result).toContain('strategic planning view');
    });

    it('includes the closing instruction', () => {
      const result = assembleFocusContext(
        [makeMeeting({ startTime: dayInWeek(0, 9).toISOString() })],
        [],
        undefined,
        FIXED_NOW,
        TZ,
      );

      expect(result).toContain(
        'Respond conversationally. Help with planning, meeting audit, time allocation, or goal progress'
      );
    });
  });
});
