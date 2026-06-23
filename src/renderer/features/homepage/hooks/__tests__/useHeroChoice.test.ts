import { describe, it, expect } from 'vitest';
import { findPendingCandidate, isAllCaughtUp } from '../useHeroChoice';

type HeroChoiceEntry = NonNullable<Parameters<typeof findPendingCandidate>[0]>;
type HeroChoiceCandidate = NonNullable<ReturnType<typeof findPendingCandidate>>;

// ── Helpers ──────────────────────────────────────────────

function makeCandidate(overrides: Partial<HeroChoiceCandidate> = {}): HeroChoiceCandidate {
  return {
    id: 'cand-1',
    type: 'coaching',
    headline: 'Test headline',
    body: 'Test body text',
    actionLabel: 'Try this',
    actionPrompt: 'Do something useful',
    priority: 1,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<HeroChoiceEntry> = {}): HeroChoiceEntry {
  const candidates = overrides.result?.candidates ?? [
    makeCandidate({ id: 'cand-1', priority: 1 }),
    makeCandidate({ id: 'cand-2', priority: 2, type: 'meeting_prep', headline: 'Meeting prep' }),
    makeCandidate({ id: 'cand-3', priority: 3, type: 'insight', headline: 'Insight' }),
  ];
  return {
    result: {
      candidates,
      weekSummary: 'A productive week.',
      generatedAt: Date.now(),
      modelUsed: 'claude-sonnet',
      ...overrides.result,
    },
    candidateStates: overrides.candidateStates ?? {
      'cand-1': 'pending',
      'cand-2': 'pending',
      'cand-3': 'pending',
    },
    feedback: overrides.feedback ?? {},
  };
}

// ── Tests ────────────────────────────────────────────────

describe('findPendingCandidate', () => {
  it('returns null when entry is null', () => {
    expect(findPendingCandidate(null)).toBeNull();
  });

  it('returns the first pending candidate by priority order', () => {
    const entry = makeEntry();
    const result = findPendingCandidate(entry);
    expect(result?.id).toBe('cand-1');
    expect(result?.priority).toBe(1);
  });

  it('skips acted candidates and returns next pending', () => {
    const entry = makeEntry({
      candidateStates: {
        'cand-1': 'acted',
        'cand-2': 'pending',
        'cand-3': 'pending',
      },
    });
    const result = findPendingCandidate(entry);
    expect(result?.id).toBe('cand-2');
  });

  it('skips dismissed candidates and returns next pending', () => {
    const entry = makeEntry({
      candidateStates: {
        'cand-1': 'dismissed',
        'cand-2': 'dismissed',
        'cand-3': 'pending',
      },
    });
    const result = findPendingCandidate(entry);
    expect(result?.id).toBe('cand-3');
  });

  it('returns null when all candidates are acted or dismissed', () => {
    const entry = makeEntry({
      candidateStates: {
        'cand-1': 'acted',
        'cand-2': 'dismissed',
        'cand-3': 'acted',
      },
    });
    expect(findPendingCandidate(entry)).toBeNull();
  });

  it('returns null when candidates array is empty', () => {
    const entry = makeEntry({
      result: {
        candidates: [],
        weekSummary: '',
        generatedAt: Date.now(),
        modelUsed: 'claude-sonnet',
      },
      candidateStates: {},
    });
    expect(findPendingCandidate(entry)).toBeNull();
  });

  it('skips meeting_prep candidates whose meeting has started', () => {
    const pastMeeting = makeCandidate({
      id: 'meet-1',
      type: 'meeting_prep',
      headline: 'Prep for standup',
      meetingStartTime: Date.now() - 60_000,
    });
    const coaching = makeCandidate({ id: 'coach-1', type: 'coaching', priority: 2 });
    const entry = makeEntry({
      result: {
        candidates: [pastMeeting, coaching],
        weekSummary: '',
        generatedAt: Date.now(),
        modelUsed: 'claude-sonnet',
      },
      candidateStates: { 'meet-1': 'pending', 'coach-1': 'pending' },
    });
    const result = findPendingCandidate(entry);
    expect(result?.id).toBe('coach-1');
  });

  it('returns meeting_prep candidates whose meeting has not started', () => {
    const futureMeeting = makeCandidate({
      id: 'meet-1',
      type: 'meeting_prep',
      headline: 'Prep for standup',
      meetingStartTime: Date.now() + 3_600_000,
    });
    const entry = makeEntry({
      result: {
        candidates: [futureMeeting],
        weekSummary: '',
        generatedAt: Date.now(),
        modelUsed: 'claude-sonnet',
      },
      candidateStates: { 'meet-1': 'pending' },
    });
    expect(findPendingCandidate(entry)?.id).toBe('meet-1');
  });

  it('treats meeting_prep without meetingStartTime as valid (legacy data)', () => {
    const legacyMeetingPrep = makeCandidate({
      id: 'meet-1',
      type: 'meeting_prep',
      headline: 'Prep for standup',
    });
    const entry = makeEntry({
      result: {
        candidates: [legacyMeetingPrep],
        weekSummary: '',
        generatedAt: Date.now(),
        modelUsed: 'claude-sonnet',
      },
      candidateStates: { 'meet-1': 'pending' },
    });
    expect(findPendingCandidate(entry)?.id).toBe('meet-1');
  });

  it('advances through candidates in array order (priority)', () => {
    // Simulate sequential dismiss: each call should return the next candidate
    const entry = makeEntry();

    const first = findPendingCandidate(entry);
    expect(first?.id).toBe('cand-1');

    // Dismiss first
    const afterFirst: HeroChoiceEntry = {
      ...entry,
      candidateStates: { ...entry.candidateStates, 'cand-1': 'dismissed' },
    };
    const second = findPendingCandidate(afterFirst);
    expect(second?.id).toBe('cand-2');

    // Dismiss second
    const afterSecond: HeroChoiceEntry = {
      ...afterFirst,
      candidateStates: { ...afterFirst.candidateStates, 'cand-2': 'dismissed' },
    };
    const third = findPendingCandidate(afterSecond);
    expect(third?.id).toBe('cand-3');

    // Dismiss third
    const afterThird: HeroChoiceEntry = {
      ...afterSecond,
      candidateStates: { ...afterSecond.candidateStates, 'cand-3': 'dismissed' },
    };
    expect(findPendingCandidate(afterThird)).toBeNull();
  });
});

describe('isAllCaughtUp', () => {
  it('returns false when entry is null', () => {
    expect(isAllCaughtUp(null)).toBe(false);
  });

  it('returns false when some candidates are pending', () => {
    const entry = makeEntry({
      candidateStates: {
        'cand-1': 'acted',
        'cand-2': 'pending',
        'cand-3': 'dismissed',
      },
    });
    expect(isAllCaughtUp(entry)).toBe(false);
  });

  it('returns true when all candidates are acted', () => {
    const entry = makeEntry({
      candidateStates: {
        'cand-1': 'acted',
        'cand-2': 'acted',
        'cand-3': 'acted',
      },
    });
    expect(isAllCaughtUp(entry)).toBe(true);
  });

  it('returns true when all candidates are dismissed', () => {
    const entry = makeEntry({
      candidateStates: {
        'cand-1': 'dismissed',
        'cand-2': 'dismissed',
        'cand-3': 'dismissed',
      },
    });
    expect(isAllCaughtUp(entry)).toBe(true);
  });

  it('returns true when candidates are a mix of acted and dismissed', () => {
    const entry = makeEntry({
      candidateStates: {
        'cand-1': 'acted',
        'cand-2': 'dismissed',
        'cand-3': 'acted',
      },
    });
    expect(isAllCaughtUp(entry)).toBe(true);
  });

  it('returns true when candidates array is empty', () => {
    const entry = makeEntry({
      result: {
        candidates: [],
        weekSummary: '',
        generatedAt: Date.now(),
        modelUsed: 'claude-sonnet',
      },
      candidateStates: {},
    });
    expect(isAllCaughtUp(entry)).toBe(true);
  });

  it('returns true when only pending candidate is an expired meeting_prep', () => {
    const pastMeeting = makeCandidate({
      id: 'meet-1',
      type: 'meeting_prep',
      meetingStartTime: Date.now() - 60_000,
    });
    const entry = makeEntry({
      result: {
        candidates: [pastMeeting],
        weekSummary: '',
        generatedAt: Date.now(),
        modelUsed: 'claude-sonnet',
      },
      candidateStates: { 'meet-1': 'pending' },
    });
    expect(isAllCaughtUp(entry)).toBe(true);
  });

  it('returns false when a non-expired meeting_prep is still pending', () => {
    const futureMeeting = makeCandidate({
      id: 'meet-1',
      type: 'meeting_prep',
      meetingStartTime: Date.now() + 3_600_000,
    });
    const entry = makeEntry({
      result: {
        candidates: [futureMeeting],
        weekSummary: '',
        generatedAt: Date.now(),
        modelUsed: 'claude-sonnet',
      },
      candidateStates: { 'meet-1': 'pending' },
    });
    expect(isAllCaughtUp(entry)).toBe(false);
  });
});
