import { describe, it, expect } from 'vitest';
import { computeGoalAlignment } from '../goalAlignmentService';
import type { AlignmentMeetingLike } from '../goalAlignmentService';
import type { PrepEnrichment } from '../prepAlignmentTypes';
import type { SpaceGoals } from '../spaceGoalsTypes';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function makeSpace(overrides: Partial<SpaceGoals> = {}): SpaceGoals {
  return {
    spaceName: overrides.spaceName ?? 'Chief-of-Staff',
    spacePath: overrides.spacePath ?? 'Chief-of-Staff',
    spaceType: overrides.spaceType ?? 'chief-of-staff',
    isPersonal: overrides.isPersonal ?? true,
    goals: overrides.goals ?? [{ goal: 'Ship the product' }],
    lastReviewed: overrides.lastReviewed ?? null,
  };
}

function makeMeeting(overrides: Partial<AlignmentMeetingLike> = {}): AlignmentMeetingLike {
  return {
    title: overrides.title ?? 'Test Meeting',
    startTime: overrides.startTime ?? '2026-04-06T10:00:00Z',
    endTime: overrides.endTime ?? '2026-04-06T11:00:00Z',
  };
}

function makePrepEnrichment(overrides: Partial<PrepEnrichment> = {}): PrepEnrichment {
  return {
    goalAlignment: overrides.goalAlignment ?? [],
    meetingUtility: overrides.meetingUtility ?? 'productive',
    enrichedAt: overrides.enrichedAt ?? '2026-04-09T09:00:00.000Z',
    enrichedBy: overrides.enrichedBy ?? 'focus-weekly-prep',
  };
}

// ─────────────────────────────────────────────────────────────
// computeGoalAlignment
// ─────────────────────────────────────────────────────────────

describe('computeGoalAlignment', () => {
  // ── Empty / edge cases ─────────────────────────────────────

  it('returns empty results when no goals and no meetings', () => {
    const result = computeGoalAlignment([], [], 'week');
    expect(result.goals).toHaveLength(0);
    expect(result.totalMeetingHours).toBe(0);
    expect(result.totalMeetingCount).toBe(0);
    expect(result.unalignedHours).toBe(0);
    expect(result.unalignedCount).toBe(0);
    expect(result.granularity).toBe('week');
  });

  it('returns empty goals with meeting totals when goals are empty but meetings exist', () => {
    const meetings = [makeMeeting({ title: 'Team standup' })];
    const result = computeGoalAlignment([], meetings, 'week');
    expect(result.goals).toHaveLength(0);
    expect(result.totalMeetingHours).toBe(1);
    expect(result.totalMeetingCount).toBe(1);
    expect(result.unalignedHours).toBe(1);
    expect(result.unalignedCount).toBe(1);
  });

  it('returns goals with zero alignment when no meetings exist', () => {
    const spaces = [makeSpace({ goals: [{ goal: 'Launch Q2 strategy' }] })];
    const result = computeGoalAlignment(spaces, [], 'week');
    expect(result.goals).toHaveLength(1);
    expect(result.goals[0].status).toBe('no_matches');
    expect(result.goals[0].alignedHours).toBe(0);
    expect(result.goals[0].alignedMeetingCount).toBe(0);
    expect(result.totalMeetingHours).toBe(0);
  });

  // ── Keyword matching ───────────────────────────────────────

  it('matches goals to meetings via keyword intersection', () => {
    const spaces = [makeSpace({ goals: [{ goal: 'Close Series A financing' }] })];
    const meetings = [
      makeMeeting({ title: 'Series A investor call', startTime: '2026-04-06T10:00:00Z', endTime: '2026-04-06T11:00:00Z' }),
      makeMeeting({ title: 'Team standup', startTime: '2026-04-06T14:00:00Z', endTime: '2026-04-06T14:30:00Z' }),
    ];
    const result = computeGoalAlignment(spaces, meetings, 'week');
    expect(result.goals[0].status).toBe('matched');
    expect(result.goals[0].alignedHours).toBe(1);
    expect(result.goals[0].alignedMeetingCount).toBe(1);
    expect(result.goals[0].alignedMeetingTitles).toContain('Series A investor call');
  });

  it('extracts keywords from both goal and why fields', () => {
    const spaces = [makeSpace({
      goals: [{ goal: 'Improve retention', why: 'Churn is increasing in enterprise accounts' }],
    })];
    const meetings = [
      makeMeeting({ title: 'Enterprise churn review' }),
    ];
    const result = computeGoalAlignment(spaces, meetings, 'week');
    // "churn" from the why field should match "churn" in the meeting title
    expect(result.goals[0].status).toBe('matched');
    expect(result.goals[0].alignedMeetingCount).toBe(1);
  });

  // ── Unmatchable goals ──────────────────────────────────────

  it('marks goals with only stop words as no_usable_keywords', () => {
    const spaces = [makeSpace({
      goals: [{ goal: 'Do it' }], // "do" is stop word, "it" is stop word
    })];
    const result = computeGoalAlignment(spaces, [makeMeeting()], 'week');
    expect(result.goals[0].status).toBe('no_usable_keywords');
    expect(result.goals[0].alignedHours).toBe(0);
  });

  it('marks goals with short words as no_usable_keywords', () => {
    const spaces = [makeSpace({
      goals: [{ goal: 'Go up' }], // "go" is 2 chars (too short), "up" is stop word
    })];
    const result = computeGoalAlignment(spaces, [makeMeeting()], 'week');
    expect(result.goals[0].status).toBe('no_usable_keywords');
  });

  // ── Duration computation ───────────────────────────────────

  it('computes hours from meeting start/end times, not just counts', () => {
    const spaces = [makeSpace({ goals: [{ goal: 'Product launch planning' }] })];
    const meetings = [
      makeMeeting({
        title: 'Product launch sync',
        startTime: '2026-04-06T09:00:00Z',
        endTime: '2026-04-06T11:30:00Z', // 2.5 hours
      }),
    ];
    const result = computeGoalAlignment(spaces, meetings, 'week');
    expect(result.goals[0].alignedHours).toBe(2.5);
    expect(result.totalMeetingHours).toBe(2.5);
  });

  it('rounds hours to 1 decimal place', () => {
    const spaces = [makeSpace({ goals: [{ goal: 'Strategy review session' }] })];
    const meetings = [
      makeMeeting({
        title: 'Strategy planning',
        startTime: '2026-04-06T09:00:00Z',
        endTime: '2026-04-06T09:20:00Z', // 20 minutes = 0.333... hours
      }),
    ];
    const result = computeGoalAlignment(spaces, meetings, 'week');
    expect(result.goals[0].alignedHours).toBe(0.3);
    expect(result.totalMeetingHours).toBe(0.3);
  });

  // ── All-day event exclusion ────────────────────────────────

  it('excludes all-day events from alignment computation', () => {
    const spaces = [makeSpace({ goals: [{ goal: 'Conference attendance' }] })];
    const meetings = [
      // All-day event (24+ hours)
      makeMeeting({
        title: 'Conference Day 1',
        startTime: '2026-04-06T00:00:00Z',
        endTime: '2026-04-07T00:00:00Z', // exactly 24 hours
      }),
      // Regular meeting
      makeMeeting({
        title: 'Conference prep call',
        startTime: '2026-04-05T10:00:00Z',
        endTime: '2026-04-05T11:00:00Z',
      }),
    ];
    const result = computeGoalAlignment(spaces, meetings, 'week');
    // The all-day event should be excluded
    expect(result.totalMeetingHours).toBe(1); // Only the 1-hour prep call
    expect(result.goals[0].alignedMeetingCount).toBe(1); // Only prep call matches
    expect(result.goals[0].alignedMeetingTitles).toContain('Conference prep call');
    expect(result.goals[0].alignedMeetingTitles).not.toContain('Conference Day 1');
  });

  it('excludes multi-day events spanning more than 24 hours', () => {
    const meetings = [
      makeMeeting({
        title: 'Offsite retreat',
        startTime: '2026-04-06T00:00:00Z',
        endTime: '2026-04-08T00:00:00Z', // 48 hours
      }),
    ];
    const result = computeGoalAlignment([], meetings, 'week');
    expect(result.totalMeetingHours).toBe(0);
    expect(result.totalMeetingCount).toBe(0);
    expect(result.unalignedCount).toBe(0);
  });

  it('totalMeetingCount excludes all-day events but includes normal meetings', () => {
    const meetings = [
      makeMeeting({ title: 'All day', startTime: '2026-04-06T00:00:00Z', endTime: '2026-04-07T00:00:00Z' }),
      makeMeeting({ title: 'Normal 1', startTime: '2026-04-06T10:00:00Z', endTime: '2026-04-06T11:00:00Z' }),
      makeMeeting({ title: 'Normal 2', startTime: '2026-04-06T14:00:00Z', endTime: '2026-04-06T15:00:00Z' }),
    ];
    const result = computeGoalAlignment([], meetings, 'week');
    expect(result.totalMeetingCount).toBe(2);
  });

  // ── Coverage model: one meeting matches multiple goals ─────

  it('allows one meeting to match multiple goals (coverage model)', () => {
    const spaces = [makeSpace({
      goals: [
        { goal: 'Close Series A financing' },
        { goal: 'Build investor relations' },
      ],
    })];
    const meetings = [
      makeMeeting({
        title: 'Series A investor relations call',
        startTime: '2026-04-06T10:00:00Z',
        endTime: '2026-04-06T11:00:00Z',
      }),
    ];
    const result = computeGoalAlignment(spaces, meetings, 'week');
    // Both goals should match the same meeting
    expect(result.goals[0].status).toBe('matched');
    expect(result.goals[0].alignedHours).toBe(1);
    expect(result.goals[1].status).toBe('matched');
    expect(result.goals[1].alignedHours).toBe(1);
    // Meeting matched at least one goal, so unaligned = 0
    expect(result.unalignedCount).toBe(0);
    expect(result.unalignedHours).toBe(0);
  });

  // ── Unaligned meetings ─────────────────────────────────────

  it('counts meetings matching zero goals as unaligned', () => {
    const spaces = [makeSpace({ goals: [{ goal: 'Close Series A financing' }] })];
    const meetings = [
      makeMeeting({ title: 'Series A investor call', startTime: '2026-04-06T10:00:00Z', endTime: '2026-04-06T11:00:00Z' }),
      makeMeeting({ title: 'Team standup', startTime: '2026-04-06T14:00:00Z', endTime: '2026-04-06T14:30:00Z' }),
      makeMeeting({ title: 'All hands meeting', startTime: '2026-04-06T15:00:00Z', endTime: '2026-04-06T16:00:00Z' }),
    ];
    const result = computeGoalAlignment(spaces, meetings, 'week');
    expect(result.unalignedCount).toBe(2); // standup + all hands
    expect(result.unalignedHours).toBe(1.5); // 0.5h + 1h
  });

  // ── Multiple spaces ────────────────────────────────────────

  it('handles goals from multiple spaces', () => {
    const spaces = [
      makeSpace({
        spaceName: 'Chief-of-Staff',
        isPersonal: true,
        goals: [{ goal: 'Personal development training' }],
      }),
      makeSpace({
        spaceName: 'Acme Corp',
        spacePath: 'work/Acme',
        spaceType: 'company',
        isPersonal: false,
        goals: [{ goal: 'Acme partnership review' }],
      }),
    ];
    const meetings = [
      makeMeeting({ title: 'Training workshop', startTime: '2026-04-06T09:00:00Z', endTime: '2026-04-06T10:00:00Z' }),
      makeMeeting({ title: 'Acme partnership sync', startTime: '2026-04-06T14:00:00Z', endTime: '2026-04-06T15:00:00Z' }),
    ];
    const result = computeGoalAlignment(spaces, meetings, 'week');
    expect(result.goals).toHaveLength(2);
    expect(result.goals[0].spaceName).toBe('Chief-of-Staff');
    expect(result.goals[0].isPersonal).toBe(true);
    expect(result.goals[0].status).toBe('matched');
    expect(result.goals[1].spaceName).toBe('Acme Corp');
    expect(result.goals[1].isPersonal).toBe(false);
    expect(result.goals[1].status).toBe('matched');
  });

  // ── Meeting title cap ──────────────────────────────────────

  it('caps aligned meeting titles at 5 per goal', () => {
    const spaces = [makeSpace({ goals: [{ goal: 'Product planning sessions' }] })];
    const meetings = Array.from({ length: 8 }, (_, i) =>
      makeMeeting({
        title: `Product planning ${i + 1}`,
        startTime: `2026-04-0${(i % 5) + 1}T10:00:00Z`,
        endTime: `2026-04-0${(i % 5) + 1}T11:00:00Z`,
      }),
    );
    const result = computeGoalAlignment(spaces, meetings, 'week');
    expect(result.goals[0].alignedMeetingCount).toBe(8);
    expect(result.goals[0].alignedMeetingTitles).toHaveLength(5);
  });

  // ── Granularity pass-through ───────────────────────────────

  it('passes through granularity to result', () => {
    expect(computeGoalAlignment([], [], 'week').granularity).toBe('week');
    expect(computeGoalAlignment([], [], 'month').granularity).toBe('month');
  });

  // ── Mixed statuses across goals ────────────────────────────

  it('produces correct mixed statuses across goals', () => {
    const spaces = [makeSpace({
      goals: [
        { goal: 'Close Series A financing' },    // will match
        { goal: 'Meditate daily' },               // won't match any meeting
        { goal: 'Do it' },                        // unmatchable (all stop words)
      ],
    })];
    const meetings = [
      makeMeeting({ title: 'Series A investor call' }),
    ];
    const result = computeGoalAlignment(spaces, meetings, 'month');
    expect(result.goals[0].status).toBe('matched');
    expect(result.goals[1].status).toBe('no_matches');
    expect(result.goals[2].status).toBe('no_usable_keywords');
  });

  // ── Prep-enriched alignment ─────────────────────────────────

  it('matches prep-enriched productive meetings by (goal, space)', () => {
    const spaces = [makeSpace({
      spaceName: 'Personal',
      goals: [{ goal: 'Launch Q2 strategy' }],
    })];
    const meeting = makeMeeting({
      title: 'Calendar event with vague title',
      startTime: '2026-04-09T10:00:00.000Z',
      endTime: '2026-04-09T11:00:00.000Z',
    });

    const prepEnrichments = new Map<string, PrepEnrichment>([
      [meeting.startTime, makePrepEnrichment({
        meetingUtility: 'productive',
        goalAlignment: [{ goal: 'Launch Q2 strategy', space: 'Personal' }],
      })],
    ]);

    const result = computeGoalAlignment(spaces, [meeting], 'week', prepEnrichments);
    expect(result.goals[0].status).toBe('matched');
    expect(result.goals[0].alignedHours).toBe(1);
    expect(result.goals[0].alignedMeetingCount).toBe(1);
    expect(result.totalMeetingHours).toBe(1);
    expect(result.preppedMeetingCount).toBe(1);
  });

  it('excludes prep-enriched blocker meetings from totals and alignment', () => {
    const spaces = [makeSpace({
      spaceName: 'Personal',
      goals: [{ goal: 'Launch Q2 strategy' }],
    })];
    const meeting = makeMeeting({
      title: 'USA timezone holder',
      startTime: '2026-04-10T10:00:00.000Z',
      endTime: '2026-04-10T11:00:00.000Z',
    });

    const prepEnrichments = new Map<string, PrepEnrichment>([
      [meeting.startTime, makePrepEnrichment({
        meetingUtility: 'blocker',
        goalAlignment: [{ goal: 'Launch Q2 strategy', space: 'Personal' }],
      })],
    ]);

    const result = computeGoalAlignment(spaces, [meeting], 'week', prepEnrichments);
    expect(result.totalMeetingHours).toBe(0);
    expect(result.unalignedHours).toBe(0);
    expect(result.unalignedCount).toBe(0);
    expect(result.goals[0].alignedMeetingCount).toBe(0);
    expect(result.preppedMeetingCount).toBe(1);
    expect(result.excludedAsNoiseCount).toBe(1);
  });

  it('excludes prep-enriched noise meetings from totals and alignment', () => {
    const spaces = [makeSpace({
      spaceName: 'Personal',
      goals: [{ goal: 'Launch Q2 strategy' }],
    })];
    const meeting = makeMeeting({
      title: 'Low-value recurring sync',
      startTime: '2026-04-11T10:00:00.000Z',
      endTime: '2026-04-11T11:00:00.000Z',
    });

    const prepEnrichments = new Map<string, PrepEnrichment>([
      [meeting.startTime, makePrepEnrichment({
        meetingUtility: 'noise',
        goalAlignment: [{ goal: 'Launch Q2 strategy', space: 'Personal' }],
      })],
    ]);

    const result = computeGoalAlignment(spaces, [meeting], 'week', prepEnrichments);
    expect(result.totalMeetingHours).toBe(0);
    expect(result.unalignedCount).toBe(0);
    expect(result.goals[0].alignedMeetingCount).toBe(0);
    expect(result.preppedMeetingCount).toBe(1);
    expect(result.excludedAsNoiseCount).toBe(1);
  });

  it('includes prep-enriched travel meetings when goal alignment is present', () => {
    const spaces = [makeSpace({
      spaceName: 'Mindstone',
      isPersonal: false,
      goals: [{ goal: 'Ship mobile app v1' }],
    })];
    const meeting = makeMeeting({
      title: 'Travel to customer offsite',
      startTime: '2026-04-12T08:00:00.000Z',
      endTime: '2026-04-12T10:00:00.000Z',
    });

    const prepEnrichments = new Map<string, PrepEnrichment>([
      [meeting.startTime, makePrepEnrichment({
        meetingUtility: 'travel',
        goalAlignment: [{ goal: 'Ship mobile app v1', space: 'Mindstone' }],
      })],
    ]);

    const result = computeGoalAlignment(spaces, [meeting], 'week', prepEnrichments);
    expect(result.totalMeetingHours).toBe(2);
    expect(result.unalignedCount).toBe(0);
    expect(result.goals[0].alignedHours).toBe(2);
    expect(result.goals[0].alignedMeetingCount).toBe(1);
  });

  it('excludes prep-enriched travel meetings when goal alignment is empty', () => {
    const spaces = [makeSpace({
      spaceName: 'Mindstone',
      isPersonal: false,
      goals: [{ goal: 'Ship mobile app v1' }],
    })];
    const meeting = makeMeeting({
      title: 'Travel block',
      startTime: '2026-04-12T12:00:00.000Z',
      endTime: '2026-04-12T13:30:00.000Z',
    });

    const prepEnrichments = new Map<string, PrepEnrichment>([
      [meeting.startTime, makePrepEnrichment({
        meetingUtility: 'travel',
        goalAlignment: [],
      })],
    ]);

    const result = computeGoalAlignment(spaces, [meeting], 'week', prepEnrichments);
    expect(result.totalMeetingHours).toBe(0);
    expect(result.unalignedHours).toBe(0);
    expect(result.unalignedCount).toBe(0);
    expect(result.goals[0].alignedMeetingCount).toBe(0);
  });

  it('supports mixed prep + keyword alignment in one run', () => {
    const spaces = [makeSpace({
      spaceName: 'Personal',
      goals: [
        { goal: 'Launch Q2 strategy' },
        { goal: 'Series A fundraising' },
      ],
    })];
    const preppedMeeting = makeMeeting({
      title: 'Unhelpful calendar title',
      startTime: '2026-04-13T10:00:00.000Z',
      endTime: '2026-04-13T11:00:00.000Z',
    });
    const keywordMeeting = makeMeeting({
      title: 'Series A investor call',
      startTime: '2026-04-13T12:00:00.000Z',
      endTime: '2026-04-13T13:00:00.000Z',
    });

    const prepEnrichments = new Map<string, PrepEnrichment>([
      [preppedMeeting.startTime, makePrepEnrichment({
        meetingUtility: 'productive',
        goalAlignment: [{ goal: 'Launch Q2 strategy', space: 'Personal' }],
      })],
    ]);

    const result = computeGoalAlignment(
      spaces,
      [preppedMeeting, keywordMeeting],
      'week',
      prepEnrichments,
    );

    expect(result.totalMeetingHours).toBe(2);
    expect(result.preppedMeetingCount).toBe(1);
    expect(result.excludedAsNoiseCount).toBe(0);
    expect(result.goals[0].alignedMeetingCount).toBe(1); // prep path
    expect(result.goals[1].alignedMeetingCount).toBe(1); // keyword path
  });

  it('reports accurate preppedMeetingCount and excludedAsNoiseCount', () => {
    const spaces = [makeSpace({
      spaceName: 'Personal',
      goals: [{ goal: 'Launch Q2 strategy' }],
    })];
    const meetings = [
      makeMeeting({ startTime: '2026-04-14T09:00:00.000Z', endTime: '2026-04-14T10:00:00.000Z', title: 'Strategy prep' }),
      makeMeeting({ startTime: '2026-04-14T10:30:00.000Z', endTime: '2026-04-14T11:30:00.000Z', title: 'Timezone block' }),
      makeMeeting({ startTime: '2026-04-14T12:00:00.000Z', endTime: '2026-04-14T13:00:00.000Z', title: 'Low-value sync' }),
      makeMeeting({ startTime: '2026-04-14T14:00:00.000Z', endTime: '2026-04-14T15:00:00.000Z', title: 'Series A investor call' }),
    ];

    const prepEnrichments = new Map<string, PrepEnrichment>([
      [meetings[0].startTime, makePrepEnrichment({
        meetingUtility: 'productive',
        goalAlignment: [{ goal: 'Launch Q2 strategy', space: 'Personal' }],
      })],
      [meetings[1].startTime, makePrepEnrichment({ meetingUtility: 'blocker' })],
      [meetings[2].startTime, makePrepEnrichment({ meetingUtility: 'noise' })],
    ]);

    const result = computeGoalAlignment(spaces, meetings, 'week', prepEnrichments);
    expect(result.preppedMeetingCount).toBe(3);
    expect(result.excludedAsNoiseCount).toBe(2);
  });

  it('matches prep-enriched goals by (goal, space) when goal text is duplicated across spaces', () => {
    const spaces = [
      makeSpace({
        spaceName: 'Personal',
        goals: [{ goal: 'Launch roadmap' }],
      }),
      makeSpace({
        spaceName: 'Mindstone',
        isPersonal: false,
        spacePath: 'work/Mindstone',
        spaceType: 'company',
        goals: [{ goal: 'Launch roadmap' }],
      }),
    ];
    const meeting = makeMeeting({
      title: 'Q2 roadmap strategy',
      startTime: '2026-04-15T09:00:00.000Z',
      endTime: '2026-04-15T10:00:00.000Z',
    });

    const prepEnrichments = new Map<string, PrepEnrichment>([
      [meeting.startTime, makePrepEnrichment({
        meetingUtility: 'productive',
        goalAlignment: [{ goal: 'Launch roadmap', space: 'Mindstone' }],
      })],
    ]);

    const result = computeGoalAlignment(spaces, [meeting], 'week', prepEnrichments);
    const personalGoal = result.goals.find(goal => goal.spaceName === 'Personal');
    const workGoal = result.goals.find(goal => goal.spaceName === 'Mindstone');

    expect(personalGoal?.alignedMeetingCount).toBe(0);
    expect(workGoal?.alignedMeetingCount).toBe(1);
    expect(workGoal?.alignedHours).toBe(1);
  });

  it('preserves backward compatibility when prep enrichments are not provided', () => {
    const spaces = [makeSpace({
      goals: [{ goal: 'Close Series A financing' }],
    })];
    const meetings = [
      makeMeeting({ title: 'Series A investor call', startTime: '2026-04-16T10:00:00.000Z', endTime: '2026-04-16T11:00:00.000Z' }),
      makeMeeting({ title: 'Team standup', startTime: '2026-04-16T13:00:00.000Z', endTime: '2026-04-16T13:30:00.000Z' }),
    ];

    const withoutPrep = computeGoalAlignment(spaces, meetings, 'week');
    const withEmptyPrepMap = computeGoalAlignment(spaces, meetings, 'week', new Map());

    expect(withoutPrep).toEqual(withEmptyPrepMap);
  });
});
