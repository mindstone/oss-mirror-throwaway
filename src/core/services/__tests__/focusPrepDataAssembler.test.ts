import { describe, it, expect } from 'vitest';
import {
  assembleWeeklyPrepData,
  assembleMonthlyReviewData,
  formatWeeklyPrepDataForPrompt,
  formatMonthlyReviewDataForPrompt,
} from '../focusPrepDataAssembler';
import type { Goal } from '../../goalTypes';

/** Use UTC for deterministic tests regardless of host timezone. */
const TZ = 'UTC';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function makeMeeting(overrides: Partial<{
  title: string;
  startTime: string;
  endTime: string;
  participants: string[];
  participantEmails: string[];
  calendarSource: string;
}> = {}) {
  return {
    title: overrides.title ?? 'Test Meeting',
    startTime: overrides.startTime ?? '2026-04-06T10:00:00Z',
    endTime: overrides.endTime ?? '2026-04-06T11:00:00Z',
    participants: overrides.participants ?? ['Alice'],
    participantEmails: overrides.participantEmails,
    calendarSource: overrides.calendarSource,
  };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: overrides.id ?? 'goal-1',
    text: overrides.text ?? 'Ship the product',
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? Date.now() - 7 * 24 * 60 * 60 * 1000,
    updatedAt: overrides.updatedAt ?? Date.now(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// assembleWeeklyPrepData
// ─────────────────────────────────────────────────────────────

describe('assembleWeeklyPrepData', () => {
  it('returns empty counts when no meetings', () => {
    const data = assembleWeeklyPrepData([], [], [], undefined, TZ);
    expect(data.weekComparison.thisWeek.total).toBe(0);
    expect(data.weekComparison.lastWeek.total).toBe(0);
    expect(data.weekComparison.deltas.totalMeetings).toBe(0);
    expect(data.dayBreakdowns).toHaveLength(0);
  });

  it('classifies meetings as external when participantEmails have different domains', () => {
    const meetings = [
      makeMeeting({
        participantEmails: ['[external-email]'],
        calendarSource: 'google:[external-email]',
      }),
    ];
    const data = assembleWeeklyPrepData(meetings, [], [], 'mycompany.com', TZ);
    expect(data.weekComparison.thisWeek.external).toBe(1);
    expect(data.weekComparison.thisWeek.internal).toBe(0);
  });

  it('classifies meetings as internal when all participants share domain', () => {
    const meetings = [
      makeMeeting({
        participantEmails: ['[external-email]', '[external-email]'],
      }),
    ];
    const data = assembleWeeklyPrepData(meetings, [], [], 'mycompany.com', TZ);
    expect(data.weekComparison.thisWeek.internal).toBe(1);
  });

  it('classifies meetings as solo when no participant emails', () => {
    const meetings = [makeMeeting({ participantEmails: [] })];
    const data = assembleWeeklyPrepData(meetings, [], [], undefined, TZ);
    expect(data.weekComparison.thisWeek.solo).toBe(1);
  });

  it('computes week-over-week deltas', () => {
    const thisWeek = [makeMeeting(), makeMeeting(), makeMeeting()];
    const lastWeek = [makeMeeting()];
    const data = assembleWeeklyPrepData(thisWeek, lastWeek, [], undefined, TZ);
    expect(data.weekComparison.deltas.totalMeetings).toBe(2);
  });

  it('computes meeting hours', () => {
    const meetings = [
      makeMeeting({
        startTime: '2026-04-06T09:00:00Z',
        endTime: '2026-04-06T10:30:00Z',
      }),
    ];
    const data = assembleWeeklyPrepData(meetings, [], [], undefined, TZ);
    expect(data.weekComparison.thisWeek.totalHours).toBe(1.5);
  });

  it('detects goal-meeting alignment via keyword matching', () => {
    const meetings = [makeMeeting({ title: 'Series A investor call' })];
    const goals = [makeGoal({ text: 'Close Series A financing' })];
    const data = assembleWeeklyPrepData(meetings, [], goals, undefined, TZ);
    expect(data.goalAlignmentHints).toHaveLength(1);
    expect(data.goalAlignmentHints[0].hasCalendarTime).toBe(true);
    expect(data.goalAlignmentHints[0].potentialMeetings).toContain('Series A investor call');
  });

  it('flags goals with no calendar time', () => {
    const meetings = [makeMeeting({ title: 'Team standup' })];
    const goals = [makeGoal({ text: 'Close Series A financing' })];
    const data = assembleWeeklyPrepData(meetings, [], goals, undefined, TZ);
    expect(data.goalAlignmentHints[0].hasCalendarTime).toBe(false);
  });

  it('detects recurring meetings across both weeks', () => {
    const thisWeek = [makeMeeting({ title: 'Weekly Sync' })];
    const lastWeek = [makeMeeting({ title: 'Weekly Sync' })];
    const data = assembleWeeklyPrepData(thisWeek, lastWeek, [], undefined, TZ);
    expect(data.recurringMeetings).toContain('weekly sync');
  });

  it('identifies busiest and lightest days', () => {
    const meetings = [
      makeMeeting({ startTime: '2026-04-06T09:00:00Z', endTime: '2026-04-06T10:00:00Z' }),
      makeMeeting({ startTime: '2026-04-06T11:00:00Z', endTime: '2026-04-06T12:00:00Z' }),
      makeMeeting({ startTime: '2026-04-06T13:00:00Z', endTime: '2026-04-06T14:00:00Z' }),
      makeMeeting({ startTime: '2026-04-07T09:00:00Z', endTime: '2026-04-07T10:00:00Z' }),
    ];
    const data = assembleWeeklyPrepData(meetings, [], [], undefined, TZ);
    expect(data.busiestDay?.count).toBe(3);
    expect(data.lightestDay?.count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// assembleMonthlyReviewData
// ─────────────────────────────────────────────────────────────

describe('assembleMonthlyReviewData', () => {
  const now = new Date('2026-04-06T12:00:00Z');

  it('returns empty data when no meetings', () => {
    const data = assembleMonthlyReviewData([], [], undefined, now, TZ);
    expect(data.monthTotals.total).toBe(0);
    expect(data.weekByWeekBreakdown).toHaveLength(0);
  });

  it('buckets meetings into weeks', () => {
    const meetings = [
      makeMeeting({ startTime: '2026-03-09T10:00:00Z', endTime: '2026-03-09T11:00:00Z' }),
      makeMeeting({ startTime: '2026-03-16T10:00:00Z', endTime: '2026-03-16T11:00:00Z' }),
      makeMeeting({ startTime: '2026-03-16T14:00:00Z', endTime: '2026-03-16T15:00:00Z' }),
    ];
    const data = assembleMonthlyReviewData(meetings, [], undefined, now, TZ);
    expect(data.weekByWeekBreakdown.length).toBeGreaterThanOrEqual(2);
    expect(data.monthTotals.total).toBe(3);
  });

  it('identifies stalled goals (no update in 14+ days)', () => {
    const goals = [
      makeGoal({
        text: 'Stale goal',
        status: 'active',
        updatedAt: now.getTime() - 20 * 24 * 60 * 60 * 1000,
      }),
      makeGoal({
        text: 'Fresh goal',
        status: 'active',
        updatedAt: now.getTime() - 1 * 24 * 60 * 60 * 1000,
      }),
    ];
    const data = assembleMonthlyReviewData([], goals, undefined, now, TZ);
    expect(data.goalProgress.stalled).toContain('Stale goal');
    expect(data.goalProgress.stalled).not.toContain('Fresh goal');
  });

  it('counts goal progress over past 30 days', () => {
    const goals = [
      makeGoal({ status: 'active' }),
      makeGoal({
        status: 'completed',
        updatedAt: now.getTime() - 5 * 24 * 60 * 60 * 1000,
      }),
      makeGoal({
        status: 'dropped',
        updatedAt: now.getTime() - 3 * 24 * 60 * 60 * 1000,
      }),
    ];
    const data = assembleMonthlyReviewData([], goals, undefined, now, TZ);
    expect(data.goalProgress.active).toBe(1);
    expect(data.goalProgress.completed).toBe(1);
    expect(data.goalProgress.dropped).toBe(1);
  });

  it('detects meeting volume trend', () => {
    // Increasing: fewer meetings early, more later
    const meetings = [
      makeMeeting({ startTime: '2026-03-09T10:00:00Z', endTime: '2026-03-09T11:00:00Z' }),
      makeMeeting({ startTime: '2026-03-30T10:00:00Z', endTime: '2026-03-30T11:00:00Z' }),
      makeMeeting({ startTime: '2026-03-30T14:00:00Z', endTime: '2026-03-30T15:00:00Z' }),
      makeMeeting({ startTime: '2026-03-31T10:00:00Z', endTime: '2026-03-31T11:00:00Z' }),
    ];
    const data = assembleMonthlyReviewData(meetings, [], undefined, now, TZ);
    expect(data.trends.meetingVolumeDirection).toBe('increasing');
  });
});

// ─────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────

describe('formatWeeklyPrepDataForPrompt', () => {
  it('produces structured text with all sections', () => {
    const data = assembleWeeklyPrepData(
      [makeMeeting({ participantEmails: ['[external-email]'] })],
      [makeMeeting()],
      [makeGoal({ text: 'Launch feature' })],
      'mycompany.com',
      TZ,
    );
    const formatted = formatWeeklyPrepDataForPrompt(data);
    expect(formatted).toContain('This Week Overview');
    expect(formatted).toContain('Last Week');
    expect(formatted).toContain('Week-over-Week Changes');
    expect(formatted).toContain('Goal-Calendar Alignment');
  });
});

describe('formatMonthlyReviewDataForPrompt', () => {
  it('produces structured text with all sections', () => {
    const data = assembleMonthlyReviewData(
      [makeMeeting()],
      [makeGoal()],
      undefined,
      new Date('2026-04-06T12:00:00Z'),
      TZ,
    );
    const formatted = formatMonthlyReviewDataForPrompt(data);
    expect(formatted).toContain('Month Overview');
    expect(formatted).toContain('Week-by-Week Breakdown');
    expect(formatted).toContain('Goal Progress');
    expect(formatted).toContain('Trends');
  });
});
