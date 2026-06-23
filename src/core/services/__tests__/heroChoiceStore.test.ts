import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HeroChoiceResult, HeroChoiceCandidate } from '@core/heroChoiceTypes';

// In-memory store mock
let storeData: Record<string, unknown> = {};

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(key: string) { return storeData[key]; },
    set(keyOrObj: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrObj === 'string') {
        storeData[keyOrObj] = value;
      } else {
        Object.assign(storeData, keyOrObj);
      }
    },
    has(key: string) { return key in storeData; },
    delete(key: string) { delete storeData[key]; },
    clear() { storeData = {}; },
    get store() { return storeData; },
    set store(val: Record<string, unknown>) { storeData = val; },
    path: '/mock/path',
  })),
}));

// Import after mocks
import {
  getCurrentHeroChoice,
  addHeroChoiceEntry,
  updateCandidateState,
  setCandidateFeedback,
  getPastCandidates,
  dismissExpiredMeetingPrep,
  _resetStore,
} from '../heroChoiceStore';

function makeCandidate(overrides?: Partial<HeroChoiceCandidate>): HeroChoiceCandidate {
  return {
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    type: 'coaching',
    headline: 'Test headline',
    body: 'Test body',
    actionLabel: 'Try this',
    actionPrompt: 'Do the thing',
    priority: 1,
    ...overrides,
  };
}

function makeResult(overrides?: Partial<HeroChoiceResult>): HeroChoiceResult {
  return {
    candidates: [makeCandidate({ id: 'c1' }), makeCandidate({ id: 'c2' })],
    weekSummary: 'Great week!',
    generatedAt: Date.now(),
    modelUsed: 'claude-sonnet-4-20250514',
    ...overrides,
  };
}

describe('heroChoiceStore', () => {
  beforeEach(() => {
    storeData = { entries: [] };
    _resetStore();
  });

  describe('getCurrentHeroChoice', () => {
    it('returns null when no entries exist', () => {
      expect(getCurrentHeroChoice()).toBeNull();
    });

    it('returns the newest entry when it has pending candidates', () => {
      const result = makeResult();
      addHeroChoiceEntry(result);
      const current = getCurrentHeroChoice();
      expect(current).not.toBeNull();
      expect(current!.result.weekSummary).toBe('Great week!');
    });

    it('falls through to older entry when newest is exhausted', () => {
      const older = makeResult({ weekSummary: 'Older week', candidates: [makeCandidate({ id: 'old1' })] });
      addHeroChoiceEntry(older);
      const newer = makeResult({ weekSummary: 'Newer week', candidates: [makeCandidate({ id: 'new1' })] });
      addHeroChoiceEntry(newer);

      // Dismiss the only candidate in the newer entry
      updateCandidateState('new1', 'dismissed');

      const current = getCurrentHeroChoice();
      expect(current).not.toBeNull();
      expect(current!.result.weekSummary).toBe('Older week');
    });

    it('skips entries with only expired meeting_prep candidates', () => {
      const older = makeResult({ weekSummary: 'Good stuff', candidates: [makeCandidate({ id: 'old1', type: 'coaching' })] });
      addHeroChoiceEntry(older);
      const newer = makeResult({
        weekSummary: 'Only meetings',
        candidates: [makeCandidate({ id: 'mp1', type: 'meeting_prep', meetingStartTime: Date.now() - 60_000 })],
      });
      addHeroChoiceEntry(newer);

      const current = getCurrentHeroChoice();
      expect(current!.result.weekSummary).toBe('Good stuff');
    });

    it('returns newest entry for "all caught up" when all entries exhausted', () => {
      const older = makeResult({ weekSummary: 'Older', candidates: [makeCandidate({ id: 'o1' })] });
      addHeroChoiceEntry(older);
      const newer = makeResult({ weekSummary: 'Newer', candidates: [makeCandidate({ id: 'n1' })] });
      addHeroChoiceEntry(newer);

      updateCandidateState('n1', 'acted');
      updateCandidateState('o1', 'acted');

      // Should return newest for "all caught up" display
      const current = getCurrentHeroChoice();
      expect(current).not.toBeNull();
      expect(current!.result.weekSummary).toBe('Newer');
    });
  });

  describe('addHeroChoiceEntry', () => {
    it('adds an entry with pending candidate states', () => {
      const result = makeResult();
      addHeroChoiceEntry(result);
      const current = getCurrentHeroChoice()!;
      expect(current.candidateStates['c1']).toBe('pending');
      expect(current.candidateStates['c2']).toBe('pending');
      expect(current.feedback).toEqual({});
    });

    it('prepends newer entries', () => {
      const first = makeResult({ weekSummary: 'First' });
      const second = makeResult({ weekSummary: 'Second' });
      addHeroChoiceEntry(first);
      addHeroChoiceEntry(second);
      expect(getCurrentHeroChoice()!.result.weekSummary).toBe('Second');
    });

    it('caps at 10 entries', () => {
      for (let i = 0; i < 12; i++) {
        addHeroChoiceEntry(makeResult({ weekSummary: `Week ${i}` }));
      }
      const entries = storeData.entries as unknown[];
      expect(entries.length).toBe(10);
      // Newest should be week 11
      expect(getCurrentHeroChoice()!.result.weekSummary).toBe('Week 11');
    });
  });

  describe('updateCandidateState', () => {
    it('updates state of a known candidate', () => {
      addHeroChoiceEntry(makeResult());
      const success = updateCandidateState('c1', 'acted');
      expect(success).toBe(true);
      expect(getCurrentHeroChoice()!.candidateStates['c1']).toBe('acted');
    });

    it('returns false for unknown candidate', () => {
      addHeroChoiceEntry(makeResult());
      expect(updateCandidateState('nonexistent', 'acted')).toBe(false);
    });

    it('returns false when no entries exist', () => {
      expect(updateCandidateState('c1', 'acted')).toBe(false);
    });
  });

  describe('setCandidateFeedback', () => {
    it('sets feedback on a known candidate', () => {
      addHeroChoiceEntry(makeResult());
      const success = setCandidateFeedback('c1', 'helpful');
      expect(success).toBe(true);
      expect(getCurrentHeroChoice()!.feedback['c1']).toBe('helpful');
    });

    it('returns false for unknown candidate', () => {
      addHeroChoiceEntry(makeResult());
      expect(setCandidateFeedback('nonexistent', 'helpful')).toBe(false);
    });

    it('returns false when no entries exist', () => {
      expect(setCandidateFeedback('c1', 'helpful')).toBe(false);
    });
  });

  describe('getPastCandidates', () => {
    it('returns candidates across all entries', () => {
      addHeroChoiceEntry(makeResult({ candidates: [makeCandidate({ id: 'a1' })] }));
      addHeroChoiceEntry(makeResult({ candidates: [makeCandidate({ id: 'b1' }), makeCandidate({ id: 'b2' })] }));
      const past = getPastCandidates();
      // Newest entry first, so b1,b2 then a1
      expect(past.length).toBe(3);
      expect(past[0].id).toBe('b1');
      expect(past[2].id).toBe('a1');
    });

    it('respects limit parameter', () => {
      addHeroChoiceEntry(makeResult({ candidates: [makeCandidate({ id: 'a1' }), makeCandidate({ id: 'a2' })] }));
      addHeroChoiceEntry(makeResult({ candidates: [makeCandidate({ id: 'b1' }), makeCandidate({ id: 'b2' })] }));
      const past = getPastCandidates(2);
      expect(past.length).toBe(2);
    });

    it('returns empty array when no entries', () => {
      expect(getPastCandidates()).toEqual([]);
    });
  });

  describe('dismissExpiredMeetingPrep', () => {
    it('returns 0 when no entries exist', () => {
      expect(dismissExpiredMeetingPrep()).toBe(0);
    });

    it('dismisses meeting_prep candidates whose meeting has started', () => {
      const pastMeeting = makeCandidate({
        id: 'mp1',
        type: 'meeting_prep',
        meetingStartTime: Date.now() - 60_000,
      });
      const coaching = makeCandidate({ id: 'co1', type: 'coaching' });
      addHeroChoiceEntry(makeResult({ candidates: [pastMeeting, coaching] }));

      const dismissed = dismissExpiredMeetingPrep();
      expect(dismissed).toBe(1);
      expect(getCurrentHeroChoice()!.candidateStates['mp1']).toBe('dismissed');
      expect(getCurrentHeroChoice()!.candidateStates['co1']).toBe('pending');
    });

    it('does not dismiss future meeting_prep candidates', () => {
      const futureMeeting = makeCandidate({
        id: 'mp1',
        type: 'meeting_prep',
        meetingStartTime: Date.now() + 3_600_000,
      });
      addHeroChoiceEntry(makeResult({ candidates: [futureMeeting] }));

      expect(dismissExpiredMeetingPrep()).toBe(0);
      expect(getCurrentHeroChoice()!.candidateStates['mp1']).toBe('pending');
    });

    it('does not dismiss meeting_prep without meetingStartTime (legacy)', () => {
      const legacy = makeCandidate({ id: 'mp1', type: 'meeting_prep' });
      addHeroChoiceEntry(makeResult({ candidates: [legacy] }));

      expect(dismissExpiredMeetingPrep()).toBe(0);
      expect(getCurrentHeroChoice()!.candidateStates['mp1']).toBe('pending');
    });

    it('does not dismiss already-acted meeting_prep', () => {
      const pastMeeting = makeCandidate({
        id: 'mp1',
        type: 'meeting_prep',
        meetingStartTime: Date.now() - 60_000,
      });
      addHeroChoiceEntry(makeResult({ candidates: [pastMeeting] }));
      updateCandidateState('mp1', 'acted');

      expect(dismissExpiredMeetingPrep()).toBe(0);
    });
  });
});
