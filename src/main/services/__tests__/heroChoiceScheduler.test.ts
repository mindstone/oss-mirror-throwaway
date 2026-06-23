import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeroChoiceResult } from '@core/heroChoiceTypes';
import type { AppSettings } from '@shared/types';

const MockCodexDisconnectedBtsError = vi.hoisted(() =>
  class CodexDisconnectedBtsError extends Error {
    constructor() {
      super(
        'Background task cannot use the selected ChatGPT Pro model because ChatGPT Pro is not connected. ' +
        'Reconnect ChatGPT Pro in Settings or choose a different model for this task.'
      );
      this.name = 'CodexDisconnectedBtsError';
    }
  }
);

const testState = vi.hoisted(() => ({
  generateHeroChoice: vi.fn(),
  currentEntry: null as { result: HeroChoiceResult } | null,
  dismissExpiredMeetingPrep: vi.fn(() => 0),
  broadcastHeroChoiceUpdated: vi.fn(),
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../visibilityAwareScheduler', () => ({
  createPausableInterval: vi.fn(() => () => {}),
}));

vi.mock('@core/services/heroChoiceService', () => ({
  generateHeroChoice: (...args: unknown[]) => testState.generateHeroChoice(...args),
}));

vi.mock('@core/services/heroChoiceStore', () => ({
  addHeroChoiceEntry: (result: HeroChoiceResult) => {
    testState.currentEntry = { result };
  },
  getCurrentHeroChoice: () => testState.currentEntry,
  dismissExpiredMeetingPrep: () => testState.dismissExpiredMeetingPrep(),
}));

vi.mock('@core/services/behindTheScenesClient', () => ({
  CodexDisconnectedBtsError: MockCodexDisconnectedBtsError,
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => testState.log,
}));

import {
  generateHeroChoiceNow,
  initializeHeroChoiceScheduler,
  isStale,
  shutdownHeroChoiceScheduler,
} from '../heroChoiceScheduler';
import { CodexDisconnectedBtsError } from '@core/services/behindTheScenesClient';

function makeDeps() {
  return {
    listSessionSummaries: () => [],
    loadSession: async () => null,
    getPersonalGoals: async () => null,
    getSkillSummaries: async () => [],
    getUseCases: () => [],
    getUpcomingEvents: () => [],
    getPastCandidates: () => [],
    timeZone: 'UTC',
    getSettings: () => ({ heroChoiceRunMode: 'ask' } as AppSettings),
    broadcastHeroChoiceUpdated: testState.broadcastHeroChoiceUpdated,
  };
}

function makeHeroChoiceResult(): HeroChoiceResult {
  return {
    candidates: [
      {
        id: 'candidate-1',
        type: 'insight',
        headline: 'Focus on revenue follow-up',
        body: 'Body',
        actionLabel: 'Explore',
        actionPrompt: 'Help me follow up',
        priority: 1,
      },
    ],
    weekSummary: 'Busy week.',
    generatedAt: Date.now(),
    modelUsed: 'claude-opus-4-7',
  };
}

describe('heroChoiceScheduler', () => {
  afterEach(() => {
    shutdownHeroChoiceScheduler();
    testState.currentEntry = null;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('isStale', () => {
    // Pin to a fixed time so tests are deterministic regardless of real wall-clock.
    // Wednesday 2026-03-25 at 14:00:00 (2PM) — well past 8AM, within 12h of 9AM.
    const FIXED_NOW = new Date('2026-03-25T14:00:00');

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });
    it('returns true when no previous result (null)', () => {
      expect(isStale(null)).toBe(true);
    });

    it('returns true when last result is before 8AM today and it is past 8AM', () => {
      // Clock is at 2PM — past 8AM, so pre-8AM timestamps are stale
      const todayAt3AM = new Date(FIXED_NOW);
      todayAt3AM.setHours(3, 0, 0, 0);
      expect(isStale(todayAt3AM.getTime())).toBe(true);

      const todayAt759AM = new Date(FIXED_NOW);
      todayAt759AM.setHours(7, 59, 59, 0);
      expect(isStale(todayAt759AM.getTime())).toBe(true);
    });

    it('returns true when last result is older than 12 hours', () => {
      const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
      expect(isStale(thirteenHoursAgo)).toBe(true);
    });

    it('returns false when result is fresh (generated recently)', () => {
      // Clock is at 2PM — a 9AM timestamp is 5h old (within 12h, past 8AM)
      const todayAt9AM = new Date(FIXED_NOW);
      todayAt9AM.setHours(9, 0, 0, 0);
      expect(isStale(todayAt9AM.getTime())).toBe(false);

      // A result from 1 minute ago is always fresh
      const oneMinuteAgo = Date.now() - 60 * 1000;
      expect(isStale(oneMinuteAgo)).toBe(false);
    });

    it('returns false when it is before 8AM and result was generated yesterday afternoon', () => {
      // Override to 2AM — before 8AM, so the "past 8AM" staleness check doesn't apply
      vi.setSystemTime(new Date('2026-03-25T02:00:00'));
      // Yesterday at 3PM — 11h ago at 2AM, within the 12h window
      const yesterdayAt3PM = new Date('2026-03-24T15:00:00');
      expect(isStale(yesterdayAt3PM.getTime())).toBe(false);
    });

    it('returns true at exactly 12 hours boundary', () => {
      // 12h + 1ms to be clearly over the 12-hour boundary
      const justOverTwelveHours = Date.now() - 12 * 60 * 60 * 1000 - 1;
      expect(isStale(justOverTwelveHours)).toBe(true);
    });

    it('handles future timestamps gracefully (not stale)', () => {
      // Clock skew: timestamp 1h in the future — never >12h old, past 8AM today
      const futureTimestamp = Date.now() + 60 * 60 * 1000;
      expect(isStale(futureTimestamp)).toBe(false);
    });
  });

  describe('generateHeroChoiceNow', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      testState.currentEntry = null;
      initializeHeroChoiceScheduler(makeDeps());
    });

    it('propagates Codex-disconnected BTS errors instead of returning null', async () => {
      const blockedError = new CodexDisconnectedBtsError();
      testState.generateHeroChoice.mockRejectedValue(blockedError);

      await expect(generateHeroChoiceNow()).rejects.toBe(blockedError);
    });

    it('still returns null for generic hero choice failures', async () => {
      testState.generateHeroChoice.mockRejectedValue(new Error('boom'));

      await expect(generateHeroChoiceNow()).resolves.toBeNull();
    });

    it('stores and returns the generated hero choice on success', async () => {
      const result = makeHeroChoiceResult();
      testState.generateHeroChoice.mockResolvedValue(result);

      const entry = await generateHeroChoiceNow();

      expect(entry).toEqual({ result });
      expect(testState.broadcastHeroChoiceUpdated).toHaveBeenCalledOnce();
    });

    // Efficiency Mode parity: when the user has explicitly turned Hero Choice
    // off, an on-demand call must be a no-op rather than running the LLM call
    // anyway. See `docs/plans/260524_performance_mode.md`.
    it('skips the LLM call when heroChoiceRunMode is off', async () => {
      shutdownHeroChoiceScheduler();
      const deps = makeDeps();
      deps.getSettings = () => ({ heroChoiceRunMode: 'off' } as AppSettings);
      initializeHeroChoiceScheduler(deps);

      const entry = await generateHeroChoiceNow();

      expect(entry).toBeNull();
      expect(testState.generateHeroChoice).not.toHaveBeenCalled();
      expect(testState.broadcastHeroChoiceUpdated).not.toHaveBeenCalled();
    });
  });
});
