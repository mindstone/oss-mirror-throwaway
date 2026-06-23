import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { DailySparkWeeklyBatch } from '@core/dailySparkTypes';

const MockCodexDisconnectedBtsError = vi.hoisted(() =>
  class CodexDisconnectedBtsError extends Error {
    constructor() {
      super('Codex disconnected');
      this.name = 'CodexDisconnectedBtsError';
    }
  }
);

const testState = vi.hoisted(() => ({
  generateDailySparkBatch: vi.fn(),
  currentBatch: null as DailySparkWeeklyBatch | null,
  broadcastDailySparkUpdated: vi.fn(),
  addBatch: vi.fn((batch: DailySparkWeeklyBatch) => {
    testState.currentBatch = batch;
  }),
}));

vi.mock('../visibilityAwareScheduler', () => ({
  createPausableInterval: vi.fn(() => () => {}),
}));

vi.mock('@core/services/dailySparkService', () => ({
  generateDailySparkBatch: (...args: unknown[]) => testState.generateDailySparkBatch(...args),
}));

vi.mock('@core/services/dailySparkStore', () => ({
  addBatch: (batch: DailySparkWeeklyBatch) => testState.addBatch(batch),
  getCurrentBatch: () => testState.currentBatch,
}));

vi.mock('@core/services/behindTheScenesClient', () => ({
  CodexDisconnectedBtsError: MockCodexDisconnectedBtsError,
}));

import {
  generateDailySparkNow,
  initializeDailySparkScheduler,
  shouldRegenerate,
  shutdownDailySparkScheduler,
} from '../dailySparkScheduler';

function makeDeps(settings: Partial<AppSettings> = {}) {
  return {
    listSessionSummaries: () => [],
    loadSession: async () => null,
    getPersonalGoals: async () => null,
    getSkillSummaries: async () => [],
    getUseCases: () => [],
    getUpcomingEvents: () => [],
    getPastCandidates: () => [],
    timeZone: 'UTC',
    getFormatFeedback: () => ({}),
    getSettings: () => ({ dailySparkMode: 'on', ...settings } as AppSettings),
    broadcastDailySparkUpdated: testState.broadcastDailySparkUpdated,
  };
}

function makeBatch(weekStartIso: string): DailySparkWeeklyBatch {
  return {
    weekStartIso,
    generatedAt: Date.now(),
    toneGauge: 'normal',
    sparks: [],
    sourceModel: 'claude-haiku-4-5',
    promptVersion: 'v1.0',
    isFirstAppearanceWeek: false,
  };
}

describe('dailySparkScheduler', () => {
  afterEach(() => {
    shutdownDailySparkScheduler();
    testState.currentBatch = null;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('shouldRegenerate', () => {
    it('returns false when mode is off', () => {
      const monday9am = new Date('2026-05-11T09:00:00Z');
      expect(shouldRegenerate(monday9am, 'UTC', 'off', null)).toBe(false);
    });

    it('returns false on a non-Monday', () => {
      const tuesday9am = new Date('2026-05-12T09:00:00Z');
      expect(shouldRegenerate(tuesday9am, 'UTC', 'on', null)).toBe(false);
    });

    it('returns false on Monday before 08:00 local', () => {
      const mondayPreDawn = new Date('2026-05-11T05:00:00Z');
      expect(shouldRegenerate(mondayPreDawn, 'UTC', 'on', null)).toBe(false);
    });

    it('returns true on Monday after 08:00 local with no batch', () => {
      const monday9am = new Date('2026-05-11T09:00:00Z');
      expect(shouldRegenerate(monday9am, 'UTC', 'on', null)).toBe(true);
    });

    it('returns false when the current batch matches the current week', () => {
      const monday9am = new Date('2026-05-11T09:00:00Z');
      expect(
        shouldRegenerate(monday9am, 'UTC', 'on', makeBatch('2026-05-11')),
      ).toBe(false);
    });

    it('returns true when the current batch is from a previous week', () => {
      const monday9am = new Date('2026-05-11T09:00:00Z');
      expect(
        shouldRegenerate(monday9am, 'UTC', 'on', makeBatch('2026-05-04')),
      ).toBe(true);
    });

    it('respects subtle mode for week-boundary regeneration', () => {
      const monday9am = new Date('2026-05-11T09:00:00Z');
      expect(
        shouldRegenerate(monday9am, 'UTC', 'subtle', makeBatch('2026-05-04')),
      ).toBe(true);
    });
  });

  describe('generateDailySparkNow', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      testState.currentBatch = null;
    });

    it('returns null when scheduler not initialized', async () => {
      shutdownDailySparkScheduler();
      const result = await generateDailySparkNow();
      expect(result).toBeNull();
    });

    it('returns null when mode is off', async () => {
      initializeDailySparkScheduler(makeDeps({ dailySparkMode: 'off' }));
      const result = await generateDailySparkNow();
      expect(result).toBeNull();
      expect(testState.generateDailySparkBatch).not.toHaveBeenCalled();
    });

    it('stores and broadcasts a successful batch', async () => {
      initializeDailySparkScheduler(makeDeps());
      const batch = makeBatch('2026-05-11');
      testState.generateDailySparkBatch.mockResolvedValueOnce(batch);

      const result = await generateDailySparkNow();
      expect(result).toEqual(batch);
      expect(testState.addBatch).toHaveBeenCalledWith(batch);
      expect(testState.broadcastDailySparkUpdated).toHaveBeenCalledOnce();
    });

    it('returns null on service failure without throwing', async () => {
      initializeDailySparkScheduler(makeDeps());
      testState.generateDailySparkBatch.mockRejectedValueOnce(new Error('boom'));
      const result = await generateDailySparkNow();
      expect(result).toBeNull();
    });

    it('propagates CodexDisconnectedBtsError', async () => {
      initializeDailySparkScheduler(makeDeps());
      testState.generateDailySparkBatch.mockRejectedValueOnce(new MockCodexDisconnectedBtsError());

      await expect(generateDailySparkNow()).rejects.toBeInstanceOf(MockCodexDisconnectedBtsError);
    });

    it('marks first appearance when no batch exists yet', async () => {
      initializeDailySparkScheduler(makeDeps());
      testState.generateDailySparkBatch.mockImplementationOnce(async (_deps, _settings, inputs) => {
        expect((inputs as { isFirstAppearance: boolean }).isFirstAppearance).toBe(true);
        return makeBatch('2026-05-11');
      });
      await generateDailySparkNow();
      expect(testState.generateDailySparkBatch).toHaveBeenCalledOnce();
    });
  });
});
