import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { AchievementsStoreState, BadgeRecord } from '../achievementsStore';

// In-memory store mock — mimics KeyValueStore with top-level-key-only set()
let storeData: AchievementsStoreState;

const mockSet = vi.fn((key: string, value: unknown) => {
  (storeData as Record<string, unknown>)[key] = value;
});

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get store() { return storeData; },
    set store(val: AchievementsStoreState) { storeData = val; },
    set: mockSet,
    get: (key: string) => (storeData as Record<string, unknown>)[key],
    has: (key: string) => key in storeData,
    delete: (key: string) => { delete (storeData as Record<string, unknown>)[key]; },
    clear: () => { storeData = makeDefaultState(); },
    path: '/tmp/test-achievements.json',
  })),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() }),
}));

function makeDefaultState(): AchievementsStoreState {
  return {
    // Use the CURRENT store version (3): these tests exercise store WRITES, not
    // migration, so the data must be at-version (status 'current', writable).
    // Seeding an old version would route through migrateStore — and the
    // achievements registry is missing the v1->v2 step (its first migration is
    // keyed `2`, not `1`), so a v1 fixture would now throw → 'corrupted' →
    // read-only (the new non-destructive behavior), blocking the writes under
    // test. See subagent report (Discovered Improvements) re: the off-by-one
    // achievements migration-key bug surfaced by this change.
    version: 3,
    streaks: { current: 0, longest: 0, lastActiveDate: '', freezesUsedThisWeek: 0, weekStartDate: '' },
    badges: {},
    evidence: { collected: [], bySignal: {} },
    tier: { current: 'explorer', unlockedAt: 0, progressEvidence: [] },
    onboarding: { completedDays: [], journeyStartedAt: undefined, graduationModalShown: undefined },
    counters: {
      totalSessions: 0,
      voiceSessions: 0,
      weekendSessions: 0,
      totalTimeSavedMinutes: 0,
      nightSessions: 0,
      totalMemoryWrites: 0,
      totalSkillInvocations: 0,
      totalAutomationsCreated: 0,
    },
  };
}

// Must import AFTER mocks are set up
const {
  unlockBadge,
  markBadgeNotified,
  incrementSessionCount,
  incrementVoiceSessionCount,
  addTimeSaved,
  incrementNightSessionCount,
  incrementMemoryWriteCount,
  incrementSkillInvocationCount,
  incrementAutomationCreatedCount,
  startOnboardingJourney,
  markJourneyDayComplete,
  markGraduationShown,
  shouldShowGraduation,
  isJourneyDayComplete,
  getOnboardingJourney,
} = await import('../achievementsStore');

beforeEach(() => {
  storeData = makeDefaultState();
  mockSet.mockClear();
});

describe('achievementsStore store writes', () => {
  describe('badge writes use top-level key', () => {
    it('unlockBadge writes entire badges object', () => {
      unlockBadge('first_session');
      expect(mockSet).toHaveBeenCalledWith('badges', expect.objectContaining({
        first_session: { unlockedAt: expect.any(Number), notified: false },
      }));
    });

    it('unlockBadge preserves existing badges', () => {
      storeData.badges = { existing: { unlockedAt: 100, notified: true } };
      unlockBadge('new_badge');
      const written = mockSet.mock.calls[0][1] as Record<string, BadgeRecord>;
      expect(written.existing).toEqual({ unlockedAt: 100, notified: true });
      expect(written.new_badge).toBeDefined();
    });

    it('markBadgeNotified updates only notified field', () => {
      storeData.badges = { test: { unlockedAt: 100, notified: false } };
      markBadgeNotified('test');
      const written = mockSet.mock.calls[0][1] as Record<string, BadgeRecord>;
      expect(written.test.notified).toBe(true);
      expect(written.test.unlockedAt).toBe(100);
    });
  });

  describe('counter writes use top-level key', () => {
    it('incrementSessionCount writes entire counters object', () => {
      storeData.counters.totalSessions = 5;
      incrementSessionCount(false);
      expect(mockSet).toHaveBeenCalledWith('counters', expect.objectContaining({
        totalSessions: 6,
        weekendSessions: 0,
      }));
    });

    it('incrementSessionCount includes weekend when flagged', () => {
      storeData.counters.weekendSessions = 2;
      incrementSessionCount(true);
      const written = mockSet.mock.calls[0][1] as AchievementsStoreState['counters'];
      expect(written.weekendSessions).toBe(3);
      expect(written.totalSessions).toBe(1);
    });

    it('incrementVoiceSessionCount preserves other counters', () => {
      storeData.counters = { ...storeData.counters, totalSessions: 10, nightSessions: 3 };
      incrementVoiceSessionCount();
      const written = mockSet.mock.calls[0][1] as AchievementsStoreState['counters'];
      expect(written.voiceSessions).toBe(1);
      expect(written.totalSessions).toBe(10);
      expect(written.nightSessions).toBe(3);
    });

    it('addTimeSaved accumulates correctly', () => {
      storeData.counters.totalTimeSavedMinutes = 30;
      addTimeSaved(15);
      const written = mockSet.mock.calls[0][1] as AchievementsStoreState['counters'];
      expect(written.totalTimeSavedMinutes).toBe(45);
    });

    it('incrementNightSessionCount increments correctly', () => {
      storeData.counters.nightSessions = 7;
      incrementNightSessionCount();
      const written = mockSet.mock.calls[0][1] as AchievementsStoreState['counters'];
      expect(written.nightSessions).toBe(8);
    });

    it('incrementMemoryWriteCount increments correctly', () => {
      incrementMemoryWriteCount();
      const written = mockSet.mock.calls[0][1] as AchievementsStoreState['counters'];
      expect(written.totalMemoryWrites).toBe(1);
    });

    it('incrementSkillInvocationCount increments correctly', () => {
      incrementSkillInvocationCount();
      const written = mockSet.mock.calls[0][1] as AchievementsStoreState['counters'];
      expect(written.totalSkillInvocations).toBe(1);
    });

    it('incrementAutomationCreatedCount increments correctly', () => {
      incrementAutomationCreatedCount();
      const written = mockSet.mock.calls[0][1] as AchievementsStoreState['counters'];
      expect(written.totalAutomationsCreated).toBe(1);
    });
  });

  describe('onboarding writes use top-level key', () => {
    it('startOnboardingJourney writes entire onboarding object', () => {
      startOnboardingJourney();
      expect(mockSet).toHaveBeenCalledWith('onboarding', expect.objectContaining({
        journeyStartedAt: expect.any(Number),
        completedDays: [],
      }));
    });

    it('startOnboardingJourney is idempotent', () => {
      storeData.onboarding.journeyStartedAt = 100;
      startOnboardingJourney();
      expect(mockSet).not.toHaveBeenCalled();
    });

    it('markJourneyDayComplete adds day and preserves existing', () => {
      storeData.onboarding.completedDays = [1, 3];
      markJourneyDayComplete(5);
      const written = mockSet.mock.calls[0][1] as { completedDays: number[] };
      expect(written.completedDays).toEqual([1, 3, 5]);
    });

    it('markGraduationShown sets flag via top-level write', () => {
      markGraduationShown();
      expect(mockSet).toHaveBeenCalledWith('onboarding', expect.objectContaining({
        graduationModalShown: true,
      }));
    });
  });

  describe('malformed onboarding state does not crash', () => {
    it('shouldShowGraduation returns false when onboarding is undefined', () => {
      (storeData as Record<string, unknown>).onboarding = undefined;
      expect(shouldShowGraduation()).toBe(false);
    });

    it('isJourneyDayComplete returns false when onboarding is undefined', () => {
      (storeData as Record<string, unknown>).onboarding = undefined;
      expect(isJourneyDayComplete(1)).toBe(false);
    });

    it('getOnboardingJourney returns default when onboarding is undefined', () => {
      (storeData as Record<string, unknown>).onboarding = undefined;
      const result = getOnboardingJourney();
      expect(result).toEqual({ completedDays: [], journeyStartedAt: undefined });
    });

    it('startOnboardingJourney works when onboarding is undefined', () => {
      (storeData as Record<string, unknown>).onboarding = undefined;
      startOnboardingJourney();
      expect(mockSet).toHaveBeenCalledWith('onboarding', expect.objectContaining({
        journeyStartedAt: expect.any(Number),
      }));
    });

    it('markJourneyDayComplete works when onboarding is undefined', () => {
      (storeData as Record<string, unknown>).onboarding = undefined;
      const result = markJourneyDayComplete(1);
      expect(result).toBe(true);
    });

    it('shouldShowGraduation returns false when completedDays is not an array', () => {
      storeData.onboarding = { completedDays: 'bad' as unknown as number[] };
      expect(shouldShowGraduation()).toBe(false);
    });

    it('markGraduationShown does not crash when onboarding is undefined', () => {
      (storeData as Record<string, unknown>).onboarding = undefined;
      expect(() => markGraduationShown()).not.toThrow();
    });
  });

  describe('all set() calls use only top-level keys', () => {
    it('never writes dot-path keys', () => {
      unlockBadge('test');
      markBadgeNotified('test');
      incrementSessionCount(true);
      incrementVoiceSessionCount();
      addTimeSaved(10);
      incrementNightSessionCount();
      incrementMemoryWriteCount();
      incrementSkillInvocationCount();
      incrementAutomationCreatedCount();
      startOnboardingJourney();
      markJourneyDayComplete(1);
      markGraduationShown();

      for (const call of mockSet.mock.calls) {
        const key = call[0] as string;
        expect(key).not.toContain('.');
      }
    });
  });
});
