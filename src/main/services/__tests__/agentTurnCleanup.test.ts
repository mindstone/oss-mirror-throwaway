import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  rootLoggerMock,
  mockTurnLogger,
  getTurnLoggerMock,
  deleteTurnLoggerMock,
  deleteContextAccumulatorMock,
  cleanupTurnMock,
  getTurnModelMock,
  getRendererSessionMock,
  hasCostRecordedMock,
  cleanupTurnAggregatorMock,
  cleanupPendingApprovalsMock,
  cleanupAutoContinueCacheMock,
  getAndResetTurnStatsMock,
  removeRoutesMock,
  dispatchAgentEventMock,
  appendCostEntryMock,
  calculateModelCostMock,
  hasUserQuestionPendingMock,
} = vi.hoisted(() => {
  const rootLoggerMock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const mockTurnLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    sessionLogPath: '/tmp/test-session.log',
    flushSessionLogs: vi.fn().mockResolvedValue(undefined),
  };

  return {
    rootLoggerMock,
    mockTurnLogger,
    getTurnLoggerMock: vi.fn(),
    deleteTurnLoggerMock: vi.fn(),
    deleteContextAccumulatorMock: vi.fn(),
    cleanupTurnMock: vi.fn(),
    getTurnModelMock: vi.fn(),
    getRendererSessionMock: vi.fn(),
    hasCostRecordedMock: vi.fn(() => false),
    cleanupTurnAggregatorMock: vi.fn(),
    cleanupPendingApprovalsMock: vi.fn(),
    cleanupAutoContinueCacheMock: vi.fn(),
    getAndResetTurnStatsMock: vi.fn(() => new Map()),
    removeRoutesMock: vi.fn(),
    dispatchAgentEventMock: vi.fn(),
    appendCostEntryMock: vi.fn((_entry: unknown) => ({ costEntryId: 'test-cost-entry-id-cleanup' })),
    calculateModelCostMock: vi.fn(),
    hasUserQuestionPendingMock: vi.fn(() => false),
  };
});

vi.mock('@core/logger', () => ({
  logger: rootLoggerMock,
  createScopedLogger: vi.fn(() => rootLoggerMock),
}));

vi.mock('../powerSaveBlockerService', () => ({
  releaseBlock: vi.fn(),
  acquireBlock: vi.fn(),
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getTurnLogger: getTurnLoggerMock,
    deleteTurnLogger: deleteTurnLoggerMock,
    deleteContextAccumulator: deleteContextAccumulatorMock,
    cleanupTurn: cleanupTurnMock,
    getTurnModel: getTurnModelMock,
    getRendererSession: getRendererSessionMock,
    getTurnAuthMethod: vi.fn(() => 'api-key'),
    hasUserQuestionPending: hasUserQuestionPendingMock,
    hasCostRecorded: hasCostRecordedMock,
    recordSessionTurn: vi.fn(),
    hasSessionHadTurns: vi.fn(() => false),
  },
}));

vi.mock('../../tracking', () => ({
  cleanupTurnAggregator: cleanupTurnAggregatorMock,
  mainTracking: { chatSessionCreated: vi.fn() },
}));

vi.mock('../toolSafetyService', () => ({
  cleanupPendingApprovals: cleanupPendingApprovalsMock,
}));

vi.mock('../autoContinueCache', () => ({
  cleanupAutoContinueCache: cleanupAutoContinueCacheMock,
}));

vi.mock('../localModelProxyServer', () => ({
  proxyManager: {
    getAndResetTurnStats: getAndResetTurnStatsMock,
    removeRoutes: removeRoutesMock,
  },
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: vi.fn(),
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: appendCostEntryMock,
}));

vi.mock('@shared/utils/pricingCalculator', () => ({
  calculateCost: calculateModelCostMock,
  calculateCostOrWarn: calculateModelCostMock,
}));

import {
  adHocTurnIds,
  adHocTurnMeta,
  completeTurnCleanup,
  councilTurnIds,
  councilTurnMeta,
  finalizeTurnLogger,
  makeSyntheticResult,
} from '../agentTurnCleanup';

type TurnStat = {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  errorCount: number;
};

function makeStats(entries: Record<string, TurnStat>) {
  return new Map(Object.entries(entries));
}

beforeEach(() => {
  vi.clearAllMocks();

  councilTurnIds.clear();
  councilTurnMeta.clear();
  adHocTurnIds.clear();
  adHocTurnMeta.clear();

  getTurnLoggerMock.mockReturnValue(mockTurnLogger);
  getTurnModelMock.mockReturnValue('claude-sonnet-4-5');
  getRendererSessionMock.mockReturnValue('renderer-session-1');
  getAndResetTurnStatsMock.mockReturnValue(new Map());
  calculateModelCostMock.mockReturnValue(1.25);
  hasUserQuestionPendingMock.mockReturnValue(false);
});

describe('finalizeTurnLogger', () => {
  it('flushes session logs and cleans all turn state when a logger exists', () => {
    finalizeTurnLogger('turn-logger', 'completed');

    expect(deleteTurnLoggerMock).toHaveBeenCalledWith('turn-logger');
    expect(cleanupTurnAggregatorMock).toHaveBeenCalledWith('turn-logger');
    expect(deleteContextAccumulatorMock).toHaveBeenCalledWith('turn-logger');
    expect(cleanupPendingApprovalsMock).toHaveBeenCalledWith('turn-logger');
    expect(cleanupAutoContinueCacheMock).toHaveBeenCalledWith('turn-logger');
    expect(mockTurnLogger.flushSessionLogs).toHaveBeenCalledTimes(1);
    expect(rootLoggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'turn-logger',
        reason: 'completed',
        sessionLogPath: '/tmp/test-session.log',
      }),
      'Agent turn session log finalized'
    );
  });

  it('still cleans turn state when no turn logger exists', () => {
    getTurnLoggerMock.mockReturnValue(null);

    expect(() => finalizeTurnLogger('turn-no-logger', 'aborted')).not.toThrow();
    expect(deleteTurnLoggerMock).not.toHaveBeenCalled();
    expect(cleanupTurnAggregatorMock).toHaveBeenCalledWith('turn-no-logger');
    expect(deleteContextAccumulatorMock).toHaveBeenCalledWith('turn-no-logger');
    expect(cleanupPendingApprovalsMock).toHaveBeenCalledWith('turn-no-logger');
    expect(cleanupAutoContinueCacheMock).toHaveBeenCalledWith('turn-no-logger');
  });

  it('preserves context accumulator when user question is pending', () => {
    hasUserQuestionPendingMock.mockReturnValue(true);

    finalizeTurnLogger('turn-with-question', 'completed');

    expect(deleteContextAccumulatorMock).not.toHaveBeenCalled();
    expect(cleanupTurnAggregatorMock).toHaveBeenCalledWith('turn-with-question');
    expect(cleanupPendingApprovalsMock).toHaveBeenCalledWith('turn-with-question');
    expect(cleanupAutoContinueCacheMock).toHaveBeenCalledWith('turn-with-question');
  });

  it('preserves context accumulator when user question is pending and no logger exists', () => {
    hasUserQuestionPendingMock.mockReturnValue(true);
    getTurnLoggerMock.mockReturnValue(null);

    finalizeTurnLogger('turn-no-logger-pending', 'completed');

    expect(deleteContextAccumulatorMock).not.toHaveBeenCalled();
    expect(cleanupTurnAggregatorMock).toHaveBeenCalledWith('turn-no-logger-pending');
    expect(cleanupPendingApprovalsMock).toHaveBeenCalledWith('turn-no-logger-pending');
  });
});

describe('makeSyntheticResult', () => {
  it('returns a result event with text, model, and timestamp', () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(123_456);

    const result = makeSyntheticResult('turn-result', 'Done');

    expect(result).toEqual({
      type: 'result',
      text: 'Done',
      model: 'claude-sonnet-4-5',
      timestamp: 123_456,
      isSynthetic: true,
    });

    dateNowSpy.mockRestore();
  });

  it('uses an empty string and undefined model when not provided', () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(999);
    getTurnModelMock.mockReturnValue(undefined);

    expect(makeSyntheticResult('turn-empty')).toEqual({
      type: 'result',
      text: '',
      model: undefined,
      timestamp: 999,
      isSynthetic: true,
    });

    dateNowSpy.mockRestore();
  });
});

describe('completeTurnCleanup', () => {
  it('finalizes first, then cleans registry state even when the turn is untracked', () => {
    completeTurnCleanup('turn-untracked', 'completed');

    expect(deleteTurnLoggerMock).toHaveBeenCalledWith('turn-untracked');
    expect(cleanupTurnAggregatorMock).toHaveBeenCalledWith('turn-untracked');
    expect(cleanupTurnMock).toHaveBeenCalledWith('turn-untracked');
    expect(cleanupTurnMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      deleteContextAccumulatorMock.mock.invocationCallOrder[0]
    );
    expect(getAndResetTurnStatsMock).not.toHaveBeenCalled();
    expect(removeRoutesMock).not.toHaveBeenCalled();
  });

  it('logs council proxy stats, writes completed costs, and clears council state', () => {
    const turnId = 'turn-council';
    councilTurnIds.add(turnId);
    councilTurnMeta.set(turnId, { modelDisplayNames: new Map(), win: null });
    getAndResetTurnStatsMock.mockReturnValue(
      makeStats({
        'openai/gpt-4o': { inputTokens: 10, outputTokens: 5, requestCount: 1, errorCount: 0 },
      })
    );

    completeTurnCleanup(turnId, 'completed-successfully');

    expect(mockTurnLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        councilStats: {
          'openai/gpt-4o': { inputTokens: 10, outputTokens: 5, requests: 1, errors: 0 },
        },
        totalTokens: 15,
        totalErrors: 0,
      }),
      'Council proxy usage summary'
    );
    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cost: 1.25,
        sid: 'renderer-session-1',
        tid: turnId,
        cat: 'council',
        m: 'openai/gpt-4o',
      })
    );
    expect(councilTurnIds.has(turnId)).toBe(false);
    expect(councilTurnMeta.has(turnId)).toBe(false);
    expect(removeRoutesMock).toHaveBeenCalledWith(turnId);
  });

  it('skips council proxy cost entries when main turn already recorded cost (double-count prevention)', () => {
    const turnId = 'turn-council-dup';
    councilTurnIds.add(turnId);
    councilTurnMeta.set(turnId, { modelDisplayNames: new Map(), win: null });
    hasCostRecordedMock.mockReturnValue(true);
    getAndResetTurnStatsMock.mockReturnValue(
      makeStats({
        'openai/gpt-4o': { inputTokens: 10, outputTokens: 5, requestCount: 1, errorCount: 0 },
      })
    );

    completeTurnCleanup(turnId, 'completed-successfully');

    // Stats should still be logged for observability
    expect(mockTurnLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ councilStats: expect.any(Object) }),
      'Council proxy usage summary'
    );
    // But cost should NOT be written to ledger (already in main turn entry)
    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });

  it('skips ad-hoc proxy cost entries when main turn already recorded cost (double-count prevention)', () => {
    const turnId = 'turn-adhoc-dup';
    adHocTurnIds.add(turnId);
    adHocTurnMeta.set(turnId, { modelDisplayNames: new Map(), win: null });
    hasCostRecordedMock.mockReturnValue(true);
    getAndResetTurnStatsMock.mockReturnValue(
      makeStats({
        'gpt-5.5': { inputTokens: 100, outputTokens: 50, requestCount: 1, errorCount: 0 },
      })
    );

    completeTurnCleanup(turnId, 'completed-successfully');

    // Stats should still be logged
    expect(mockTurnLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ adHocStats: expect.any(Object) }),
      'Ad-hoc model proxy usage summary'
    );
    // But cost should NOT be written to ledger
    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });

  it('logs ad-hoc proxy stats, skips cost entries for non-completed reasons, and clears state', () => {
    const turnId = 'turn-adhoc';
    adHocTurnIds.add(turnId);
    adHocTurnMeta.set(turnId, { modelDisplayNames: new Map(), win: null });
    getAndResetTurnStatsMock.mockReturnValue(
      makeStats({
        'google/gemini-2.5-pro': { inputTokens: 7, outputTokens: 3, requestCount: 2, errorCount: 0 },
      })
    );

    completeTurnCleanup(turnId, 'aborted-by-user');

    expect(mockTurnLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        adHocStats: {
          'google/gemini-2.5-pro': { inputTokens: 7, outputTokens: 3, requests: 2, errors: 0 },
        },
        totalTokens: 10,
        totalErrors: 0,
      }),
      'Ad-hoc model proxy usage summary'
    );
    expect(appendCostEntryMock).not.toHaveBeenCalled();
    expect(adHocTurnIds.has(turnId)).toBe(false);
    expect(adHocTurnMeta.has(turnId)).toBe(false);
    expect(removeRoutesMock).toHaveBeenCalledWith(turnId);
  });

});
