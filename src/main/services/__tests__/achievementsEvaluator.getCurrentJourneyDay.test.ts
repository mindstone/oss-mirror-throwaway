import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn()
}));

vi.mock('../achievementsStore', () => ({
  unlockBadge: vi.fn(),
  broadcastBadgeUnlocked: vi.fn(),
  broadcastTierUnlocked: vi.fn(),
  getBadges: vi.fn(() => ({})),
  getCounters: vi.fn(() => ({ totalSessions: 0, voiceSessions: 0, weekendSessions: 0, totalTimeSavedMinutes: 0, nightSessions: 0, totalMemoryWrites: 0, totalSkillInvocations: 0, totalAutomationsCreated: 0 })),
  incrementSessionCount: vi.fn(),
  incrementVoiceSessionCount: vi.fn(),
  incrementNightSessionCount: vi.fn(),
  incrementMemoryWriteCount: vi.fn(),
  incrementSkillInvocationCount: vi.fn(),
  incrementAutomationCreatedCount: vi.fn(),
  addTimeSaved: vi.fn(),
  markJourneyDayComplete: vi.fn(),
  getOnboardingJourney: vi.fn(() => ({ completedDays: [], journeyStartedAt: Date.now() })),
  getStreakData: vi.fn(() => ({ current: 0, longest: 0, lastActiveDate: '', freezesUsedThisWeek: 0, weekStartDate: '' })),
  getEvidenceCounts: vi.fn(() => ({})),
  getCurrentTier: vi.fn(() => ({ tier: 'explorer', unlockedAt: Date.now() })),
  advanceTier: vi.fn(),
  recordEvidence: vi.fn(),
  getLocalDateString: vi.fn(() => '2026-03-09'),
  updateStreakOnSessionComplete: vi.fn()
}));

vi.mock('../toolUsageStore', () => ({
  getAllToolUsage: vi.fn(() => []),
  recordToolUsage: vi.fn(),
  isMetaTool: vi.fn(() => false)
}));

import { getCurrentJourneyDay } from '../achievementsEvaluator';
import { getSettings } from '@core/services/settingsStore';
import { getOnboardingJourney } from '../achievementsStore';

const mockGetSettings = vi.mocked(getSettings);
const mockGetOnboardingJourney = vi.mocked(getOnboardingJourney);

const FIXED_NOW = new Date('2026-03-09T12:00:00Z').getTime();

describe('getCurrentJourneyDay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when neither timestamp field is set', () => {
    mockGetSettings.mockReturnValue({
      onboardingFirstCompletedAt: null,
      onboardingCompletedAt: undefined
    } as any);

    expect(getCurrentJourneyDay()).toBeNull();
  });

  it('uses onboardingFirstCompletedAt (permanent field)', () => {
    const today = new Date(FIXED_NOW);
    today.setHours(0, 0, 0, 0);

    mockGetSettings.mockReturnValue({
      onboardingFirstCompletedAt: today.getTime(),
      onboardingCompletedAt: undefined
    } as any);

    expect(getCurrentJourneyDay()).toBe(1);
  });

  it('falls back to onboardingCompletedAt when onboardingFirstCompletedAt is null', () => {
    const today = new Date(FIXED_NOW);
    today.setHours(0, 0, 0, 0);

    mockGetSettings.mockReturnValue({
      onboardingFirstCompletedAt: null,
      onboardingCompletedAt: today.getTime()
    } as any);

    expect(getCurrentJourneyDay()).toBe(1);
  });

  it('prefers onboardingFirstCompletedAt over onboardingCompletedAt', () => {
    const threeDaysAgo = new Date(FIXED_NOW);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 2);
    threeDaysAgo.setHours(0, 0, 0, 0);

    const today = new Date(FIXED_NOW);
    today.setHours(0, 0, 0, 0);

    mockGetSettings.mockReturnValue({
      onboardingFirstCompletedAt: threeDaysAgo.getTime(),
      onboardingCompletedAt: today.getTime()
    } as any);

    expect(getCurrentJourneyDay()).toBe(3);
  });

  it('falls back to first incomplete day when past 14-day window', () => {
    const twentyDaysAgo = new Date(FIXED_NOW);
    twentyDaysAgo.setDate(twentyDaysAgo.getDate() - 20);
    twentyDaysAgo.setHours(0, 0, 0, 0);

    mockGetSettings.mockReturnValue({
      onboardingFirstCompletedAt: twentyDaysAgo.getTime(),
      onboardingCompletedAt: undefined
    } as any);
    mockGetOnboardingJourney.mockReturnValue({
      completedDays: [1],
      journeyStartedAt: twentyDaysAgo.getTime()
    });

    expect(getCurrentJourneyDay()).toBe(2);
  });

  it('returns null when past 14-day window and all days complete', () => {
    const twentyDaysAgo = new Date(FIXED_NOW);
    twentyDaysAgo.setDate(twentyDaysAgo.getDate() - 20);
    twentyDaysAgo.setHours(0, 0, 0, 0);

    mockGetSettings.mockReturnValue({
      onboardingFirstCompletedAt: twentyDaysAgo.getTime(),
      onboardingCompletedAt: undefined
    } as any);
    mockGetOnboardingJourney.mockReturnValue({
      completedDays: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      journeyStartedAt: twentyDaysAgo.getTime()
    });

    expect(getCurrentJourneyDay()).toBeNull();
  });

  it('works after migration drops onboardingCompletedAt (the bug scenario)', () => {
    const yesterday = new Date(FIXED_NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    mockGetSettings.mockReturnValue({
      onboardingFirstCompletedAt: yesterday.getTime(),
      onboardingCompletedAt: undefined
    } as any);

    expect(getCurrentJourneyDay()).toBe(2);
  });

  it('returns day 1 when system clock is behind onboarding timestamp (clock skew)', () => {
    const tomorrow = new Date(FIXED_NOW);
    tomorrow.setDate(tomorrow.getDate() + 1);

    mockGetSettings.mockReturnValue({
      onboardingFirstCompletedAt: tomorrow.getTime(),
      onboardingCompletedAt: undefined
    } as any);

    expect(getCurrentJourneyDay()).toBe(1);
  });

  it('handles duplicate entries in completedDays via Set dedup', () => {
    const twentyDaysAgo = new Date(FIXED_NOW);
    twentyDaysAgo.setDate(twentyDaysAgo.getDate() - 20);
    twentyDaysAgo.setHours(0, 0, 0, 0);

    mockGetSettings.mockReturnValue({
      onboardingFirstCompletedAt: twentyDaysAgo.getTime(),
      onboardingCompletedAt: undefined
    } as any);
    mockGetOnboardingJourney.mockReturnValue({
      completedDays: [1, 1, 2, 2, 3, 3],
      journeyStartedAt: twentyDaysAgo.getTime()
    });

    expect(getCurrentJourneyDay()).toBe(4);
  });

  it('returns exact day 14 on the boundary', () => {
    const thirteenDaysAgo = new Date(FIXED_NOW);
    thirteenDaysAgo.setDate(thirteenDaysAgo.getDate() - 13);
    thirteenDaysAgo.setHours(0, 0, 0, 0);

    mockGetSettings.mockReturnValue({
      onboardingFirstCompletedAt: thirteenDaysAgo.getTime(),
      onboardingCompletedAt: undefined
    } as any);

    expect(getCurrentJourneyDay()).toBe(14);
  });

  it('falls back on day 15 (first day past window)', () => {
    const fourteenDaysAgo = new Date(FIXED_NOW);
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    fourteenDaysAgo.setHours(0, 0, 0, 0);

    mockGetSettings.mockReturnValue({
      onboardingFirstCompletedAt: fourteenDaysAgo.getTime(),
      onboardingCompletedAt: undefined
    } as any);
    mockGetOnboardingJourney.mockReturnValue({
      completedDays: [],
      journeyStartedAt: fourteenDaysAgo.getTime()
    });

    expect(getCurrentJourneyDay()).toBe(1);
  });
});
