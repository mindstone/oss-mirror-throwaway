/**
 * Regression tests for coaching insight TTL enforcement.
 *
 * Verifies that getAllPendingCoaching() correctly handles:
 * - Valid evaluatedAt within 2-day TTL → kept
 * - Valid evaluatedAt beyond 2-day TTL → dismissed
 * - Missing/undefined evaluatedAt → dismissed (NaN guard)
 * - NaN evaluatedAt → dismissed
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { SessionCoachingEvaluation } from '@shared/types';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

type CoachingStoreState = {
  evaluations: Record<string, SessionCoachingEvaluation>;
  evaluatedSessionIds: string[];
  evidenceEvaluatedSessionIds: string[];
  dailyCount: number;
  dailyCountDate: string;
  evidenceDailyCount: number;
  evidenceDailyCountDate: string;
  lastWeeklyAssessmentDate: string;
};

let storeData: CoachingStoreState;

const makePendingEvaluation = (
  sessionId: string,
  evaluatedAt: number | undefined,
): SessionCoachingEvaluation =>
  ({
    sessionId,
    evaluatedAt,
    state: 'pending',
    primaryInsight: {
      id: `insight-${sessionId}`,
      insight: 'Test insight',
      continuationPrompt: 'Test prompt',
      category: 'follow_up_action',
    },
  }) as unknown as SessionCoachingEvaluation;

const setupModule = async () => {
  vi.resetModules();
  await initTestPlatformConfig();

  storeData = {
    evaluations: {},
    evaluatedSessionIds: [],
    evidenceEvaluatedSessionIds: [],
    dailyCount: 0,
    dailyCountDate: '',
    evidenceDailyCount: 0,
    evidenceDailyCountDate: '',
    lastWeeklyAssessmentDate: '',
  };

  const { setStoreFactory } = await import('@core/storeFactory');
  setStoreFactory(() => ({
    get: (key: string) => storeData[key as keyof CoachingStoreState],
    set: (key: string, value: unknown) => {
      (storeData as Record<string, unknown>)[key] = value;
    },
    delete: vi.fn(),
    clear: vi.fn(),
    has: vi.fn(),
    store: storeData,
  }) as any);

  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
  }));

  vi.doMock('../visibilityAwareScheduler', () => ({
    createPausableInterval: () => vi.fn(),
  }));

  vi.doMock('../sessionCoachingService', () => ({
    evaluateSessionForCoaching: vi.fn(),
  }));

  vi.doMock('../skillsService', () => ({
    scanSkills: vi.fn().mockResolvedValue([]),
  }));

  vi.doMock('../skillUsageStore', () => ({
    recordSkillUsage: vi.fn(),
  }));

  vi.doMock('../weeklyAssessmentService', () => ({
    runWeeklyAssessment: vi.fn(),
  }));

  vi.doMock('../evidenceCollectionService', () => ({
    collectEvidenceFromSession: vi.fn(),
  }));

  const mod = await import('../sessionCoachingScheduler');
  return mod.sessionCoachingScheduler;
};

describe('sessionCoachingScheduler TTL enforcement', () => {
  let scheduler: Awaited<ReturnType<typeof setupModule>>;

  beforeEach(async () => {
    scheduler = await setupModule();
    scheduler.initialize({
      getSettings: () => ({ coachEnabled: true }) as never,
      listSessionSummaries: () => [],
      getSessionAsync: async () => null,
      broadcastCoachingReflection: vi.fn(),
      getWorkspacePath: () => '/tmp/test',
    });
  });

  it('keeps pending evaluation within 2-day TTL', () => {
    const recentMs = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
    storeData.evaluations = {
      'session-recent': makePendingEvaluation('session-recent', recentMs),
    };

    const pending = scheduler.getAllPendingCoaching();
    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe('session-recent');
  });

  it('dismisses pending evaluation older than 2-day TTL', () => {
    const oldMs = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days ago
    storeData.evaluations = {
      'session-old': makePendingEvaluation('session-old', oldMs),
    };

    const pending = scheduler.getAllPendingCoaching();
    expect(pending).toHaveLength(0);
    expect(storeData.evaluations['session-old'].state).toBe('dismissed');
  });

  it('dismisses evaluation with undefined evaluatedAt (NaN guard)', () => {
    storeData.evaluations = {
      'session-no-timestamp': makePendingEvaluation('session-no-timestamp', undefined),
    };

    const pending = scheduler.getAllPendingCoaching();
    expect(pending).toHaveLength(0);
    expect(storeData.evaluations['session-no-timestamp'].state).toBe('dismissed');
  });

  it('dismisses evaluation with NaN evaluatedAt', () => {
    storeData.evaluations = {
      'session-nan': makePendingEvaluation('session-nan', NaN),
    };

    const pending = scheduler.getAllPendingCoaching();
    expect(pending).toHaveLength(0);
    expect(storeData.evaluations['session-nan'].state).toBe('dismissed');
  });

  it('mixed: keeps fresh, dismisses stale and missing timestamps', () => {
    const fresh = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
    const stale = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days ago

    storeData.evaluations = {
      'session-fresh': makePendingEvaluation('session-fresh', fresh),
      'session-stale': makePendingEvaluation('session-stale', stale),
      'session-missing': makePendingEvaluation('session-missing', undefined),
    };

    const pending = scheduler.getAllPendingCoaching();
    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe('session-fresh');
    expect(storeData.evaluations['session-stale'].state).toBe('dismissed');
    expect(storeData.evaluations['session-missing'].state).toBe('dismissed');
  });
});
