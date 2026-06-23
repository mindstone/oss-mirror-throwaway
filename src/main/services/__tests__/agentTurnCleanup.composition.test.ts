import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loggerMock,
  turnLoggerMock,
  getTurnLoggerMock,
  deleteTurnLoggerMock,
  deleteContextAccumulatorMock,
  cleanupTurnMock,
  hasUserQuestionPendingMock,
  getRendererSessionMock,
  getTurnAuthMethodMock,
  hasCostRecordedMock,
  getAndResetTurnStatsMock,
  removeRoutesMock,
  releaseBlockMock,
  appendCostEntryMock,
  calculateCostOrWarnMock,
  stopCheckpointingMock,
  cleanupTurnAggregatorMock,
  cleanupPendingApprovalsMock,
  cleanupAutoContinueCacheMock,
} = vi.hoisted(() => {
  const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const turnLoggerMock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    sessionLogPath: '/tmp/turn.log',
    flushSessionLogs: vi.fn().mockResolvedValue(undefined),
  };
  return {
    loggerMock,
    turnLoggerMock,
    getTurnLoggerMock: vi.fn(),
    deleteTurnLoggerMock: vi.fn(),
    deleteContextAccumulatorMock: vi.fn(),
    cleanupTurnMock: vi.fn(),
    hasUserQuestionPendingMock: vi.fn(),
    getRendererSessionMock: vi.fn(),
    getTurnAuthMethodMock: vi.fn(),
    hasCostRecordedMock: vi.fn(),
    getAndResetTurnStatsMock: vi.fn(),
    removeRoutesMock: vi.fn(),
    releaseBlockMock: vi.fn(),
    appendCostEntryMock: vi.fn((_entry: unknown) => ({ costEntryId: 'test-cost-entry-id-cleanup-composition' })),
    calculateCostOrWarnMock: vi.fn(),
    stopCheckpointingMock: vi.fn(),
    cleanupTurnAggregatorMock: vi.fn(),
    cleanupPendingApprovalsMock: vi.fn(),
    cleanupAutoContinueCacheMock: vi.fn(),
  };
});

vi.mock('@core/logger', () => ({
  logger: loggerMock,
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getTurnLogger: getTurnLoggerMock,
    deleteTurnLogger: deleteTurnLoggerMock,
    deleteContextAccumulator: deleteContextAccumulatorMock,
    cleanupTurn: cleanupTurnMock,
    getRendererSession: getRendererSessionMock,
    getTurnAuthMethod: getTurnAuthMethodMock,
    hasCostRecorded: hasCostRecordedMock,
    hasUserQuestionPending: hasUserQuestionPendingMock,
    getTurnModel: vi.fn(),
      getTurnActiveProvider: vi.fn(() => undefined),
      setTurnActiveProvider: vi.fn(),
  },
}));

vi.mock('../../tracking', () => ({
  cleanupTurnAggregator: cleanupTurnAggregatorMock,
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
  dispatchAgentEvent: vi.fn(),
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: appendCostEntryMock,
}));

vi.mock('@shared/utils/pricingCalculator', () => ({
  calculateCostOrWarn: calculateCostOrWarnMock,
}));

vi.mock('../powerSaveBlockerService', () => ({
  releaseBlock: releaseBlockMock,
}));

vi.mock('../safety/memoryWriteHook', () => ({
  clearCheckpointLockedState: vi.fn(),
}));

vi.mock('@core/services/turnCheckpointService', () => ({
  getTurnCheckpointManager: vi.fn(() => ({ stopCheckpointing: stopCheckpointingMock })),
}));

import {
  ALL_CLEANUP_KEYS,
  ATTEMPT_CLEANUP_FNS,
  TERMINAL_CLEANUP_FNS,
  adHocTurnIds,
  adHocTurnMeta,
  cleanupTurnAttempt,
  completeTurnCleanup,
  councilTurnIds,
  councilTurnMeta,
  beginTurnAttempt,
  registerPreDispatchGuardDisarm,
  __resetCompletedTurnGuardForTests,
} from '../agentTurnCleanup';

type TurnStat = {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  errorCount: number;
};

const stats = (entries: Record<string, TurnStat>) => new Map(Object.entries(entries));

beforeEach(() => {
  vi.clearAllMocks();
  councilTurnIds.clear();
  councilTurnMeta.clear();
  adHocTurnIds.clear();
  adHocTurnMeta.clear();
  __resetCompletedTurnGuardForTests();
  getTurnLoggerMock.mockReturnValue(turnLoggerMock);
  hasUserQuestionPendingMock.mockReturnValue(false);
  getRendererSessionMock.mockReturnValue('session-1');
  getTurnAuthMethodMock.mockReturnValue('api-key');
  hasCostRecordedMock.mockReturnValue(false);
  getAndResetTurnStatsMock.mockReturnValue(new Map());
  calculateCostOrWarnMock.mockReturnValue(0.25);
});

describe('agentTurnCleanup composition registry', () => {
  it('subset invariant: every attempt key delegates through cleanupTurnAttempt in terminal cleanup', () => {
    for (const key of ALL_CLEANUP_KEYS) {
      if (ATTEMPT_CLEANUP_FNS[key] !== null) {
        expect(TERMINAL_CLEANUP_FNS[key], key).toBeNull();
      }
    }
  });

  it('every terminal key is either terminal-only or explicitly attempt-delegated', () => {
    for (const key of ALL_CLEANUP_KEYS) {
      const attemptFn = ATTEMPT_CLEANUP_FNS[key];
      const terminalFn = TERMINAL_CLEANUP_FNS[key];
      expect(attemptFn !== null || terminalFn !== null, key).toBe(true);
    }
  });

  it('completeTurnCleanup invokes attempt and terminal cleanup functions', () => {
    councilTurnIds.add('turn-1');

    completeTurnCleanup('turn-1', 'completed');

    expect(stopCheckpointingMock).toHaveBeenCalledWith('turn-1');
    expect(removeRoutesMock).toHaveBeenCalledWith('turn-1');
    expect(deleteTurnLoggerMock).toHaveBeenCalledWith('turn-1');
    expect(releaseBlockMock).toHaveBeenCalledWith('turn:turn-1');
    expect(cleanupTurnMock).toHaveBeenCalledWith('turn-1');
  });

  it('cleanupTurnAttempt invokes only attempt-scope cleanup functions', () => {
    councilTurnIds.add('turn-1');
    cleanupTurnAttempt('turn-1');

    expect(removeRoutesMock).toHaveBeenCalledWith('turn-1');
    expect(stopCheckpointingMock).toHaveBeenCalledWith('turn-1');
    expect(releaseBlockMock).not.toHaveBeenCalled();
    expect(cleanupTurnMock).not.toHaveBeenCalled();
    expect(deleteTurnLoggerMock).not.toHaveBeenCalled();
  });

  it('Round 4 ordering: getAndResetTurnStats runs before per-attempt route cleanup', () => {
    councilTurnIds.add('turn-1');
    councilTurnMeta.set('turn-1', { modelDisplayNames: new Map(), win: null });
    getAndResetTurnStatsMock.mockReturnValue(stats({
      'openai/gpt-4o': { inputTokens: 1, outputTokens: 2, requestCount: 1, errorCount: 0 },
    }));

    completeTurnCleanup('turn-1', 'completed');

    expect(getAndResetTurnStatsMock.mock.invocationCallOrder[0]).toBeLessThan(
      removeRoutesMock.mock.invocationCallOrder[0],
    );
  });

  it('Round 4 ordering: appendCostEntry runs before per-attempt route cleanup', () => {
    councilTurnIds.add('turn-1');
    councilTurnMeta.set('turn-1', { modelDisplayNames: new Map(), win: null });
    getAndResetTurnStatsMock.mockReturnValue(stats({
      'openai/gpt-4o': { inputTokens: 1, outputTokens: 2, requestCount: 1, errorCount: 0 },
    }));

    completeTurnCleanup('turn-1', 'completed');

    expect(appendCostEntryMock.mock.invocationCallOrder[0]).toBeLessThan(
      removeRoutesMock.mock.invocationCallOrder[0],
    );
  });

  it('cost-ledger entries survive reorder for council mode', () => {
    councilTurnIds.add('turn-council');
    councilTurnMeta.set('turn-council', { modelDisplayNames: new Map(), win: null });
    getAndResetTurnStatsMock.mockReturnValue(stats({
      'openai/gpt-4o': { inputTokens: 10, outputTokens: 5, requestCount: 1, errorCount: 0 },
    }));

    completeTurnCleanup('turn-council', 'completed');

    expect(appendCostEntryMock).toHaveBeenCalledWith(expect.objectContaining({
      tid: 'turn-council',
      cat: 'council',
      m: 'openai/gpt-4o',
      cost: 0.25,
    }));
  });

  it('cost-ledger entries survive reorder for ad-hoc mode', () => {
    adHocTurnIds.add('turn-adhoc');
    adHocTurnMeta.set('turn-adhoc', { modelDisplayNames: new Map(), win: null });
    getAndResetTurnStatsMock.mockReturnValue(stats({
      'openai/gpt-4o': { inputTokens: 10, outputTokens: 5, requestCount: 1, errorCount: 0 },
    }));

    completeTurnCleanup('turn-adhoc', 'completed');

    expect(appendCostEntryMock).toHaveBeenCalledWith(expect.objectContaining({
      tid: 'turn-adhoc',
      cat: 'adhoc-model',
      m: 'openai/gpt-4o',
      cost: 0.25,
    }));
  });

  it('cost-ledger is not emitted when reason is not completed', () => {
    councilTurnIds.add('turn-aborted');
    councilTurnMeta.set('turn-aborted', { modelDisplayNames: new Map(), win: null });
    getAndResetTurnStatsMock.mockReturnValue(stats({
      'openai/gpt-4o': { inputTokens: 10, outputTokens: 5, requestCount: 1, errorCount: 0 },
    }));

    completeTurnCleanup('turn-aborted', 'aborted');

    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });

  it('cost-ledger is not emitted when main turn cost was already recorded', () => {
    hasCostRecordedMock.mockReturnValue(true);
    councilTurnIds.add('turn-recorded');
    councilTurnMeta.set('turn-recorded', { modelDisplayNames: new Map(), win: null });
    getAndResetTurnStatsMock.mockReturnValue(stats({
      'openai/gpt-4o': { inputTokens: 10, outputTokens: 5, requestCount: 1, errorCount: 0 },
    }));

    completeTurnCleanup('turn-recorded', 'completed');

    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });

  it('idempotent: calling completeTurnCleanup twice is safe', () => {
    councilTurnIds.add('turn-repeat');
    councilTurnMeta.set('turn-repeat', { modelDisplayNames: new Map(), win: null });
    getAndResetTurnStatsMock.mockReturnValueOnce(stats({
      'openai/gpt-4o': { inputTokens: 10, outputTokens: 5, requestCount: 1, errorCount: 0 },
    }));

    completeTurnCleanup('turn-repeat', 'completed');
    completeTurnCleanup('turn-repeat', 'completed');

    expect(appendCostEntryMock).toHaveBeenCalledTimes(1);
    expect(councilTurnIds.has('turn-repeat')).toBe(false);
    expect(councilTurnMeta.has('turn-repeat')).toBe(false);
  });

  it('live-epoch gate: same-turnId retry runs cleanup; a stale old attempt cannot run cleanup, disarm, or clobber the retry (rework-final-F3)', () => {
    const turnId = 'turn-retry-epoch';

    // Attempt A (epoch 1) is the live attempt, with its own guard disarm.
    const disarmA = vi.fn();
    beginTurnAttempt(turnId, 1);
    registerPreDispatchGuardDisarm(turnId, 1, disarmA);
    completeTurnCleanup(turnId, 'completed', 1);
    expect(cleanupTurnMock).toHaveBeenCalledTimes(1);
    expect(disarmA).toHaveBeenCalledTimes(1); // attempt A's own guard disarmed once

    // Retry: a NEW attempt B (epoch 2) begins as the live attempt with a NEW
    // disarm. (beginTurnAttempt overwrites the live epoch — exactly the executor
    // re-entry path.)
    const disarmB = vi.fn();
    beginTurnAttempt(turnId, 2);
    registerPreDispatchGuardDisarm(turnId, 2, disarmB);

    // A STALE old-attempt-A continuation (epoch 1) resumes NOW. It must be a TOTAL
    // no-op: no cleanup, and crucially it must NOT invoke attempt B's disarm
    // (which would strip the live retry's 120s guard) — the F3 invariant.
    completeTurnCleanup(turnId, 'stale-old-attempt', 1);
    expect(cleanupTurnMock).toHaveBeenCalledTimes(1); // unchanged — A did not re-run
    expect(disarmB).not.toHaveBeenCalled();           // retry B's guard untouched

    // Attempt B (epoch 2) completes normally — runs cleanup + disarms ITS guard.
    completeTurnCleanup(turnId, 'completed', 2);
    expect(cleanupTurnMock).toHaveBeenCalledTimes(2);
    expect(disarmB).toHaveBeenCalledTimes(1);

    // A re-entrant call for the live attempt B is idempotent.
    completeTurnCleanup(turnId, 'completed', 2);
    expect(cleanupTurnMock).toHaveBeenCalledTimes(2);
  });

  it('arbitrary-delay stale continuation: after MANY later completions, an old-epoch cleanup still no-ops (no eviction window) (rework-final-F3)', () => {
    const turnId = 'turn-long-delayed';
    const disarmLive = vi.fn();

    // The live attempt (epoch 1) completes, then a same-turnId retry (epoch 2)
    // begins and is the current live attempt with its own guard.
    beginTurnAttempt(turnId, 1);
    completeTurnCleanup(turnId, 'completed', 1);
    beginTurnAttempt(turnId, 2);
    registerPreDispatchGuardDisarm(turnId, 2, disarmLive);

    // Thousands of unrelated turns complete (the old FIFO would have evicted the
    // epoch-1 marker by now — proving the by-construction registry has no window).
    for (let i = 0; i < 5000; i++) {
      beginTurnAttempt(`other-${i}`, 10_000 + i);
      completeTurnCleanup(`other-${i}`, 'completed', 10_000 + i);
    }
    const callsBeforeStale = cleanupTurnMock.mock.calls.length;

    // The dead-mount continuation for epoch 1 finally resumes — far past any
    // eviction count. It MUST still no-op and MUST NOT touch the live retry.
    completeTurnCleanup(turnId, 'stale-old-attempt-very-late', 1);
    expect(cleanupTurnMock.mock.calls.length).toBe(callsBeforeStale); // no re-run
    expect(disarmLive).not.toHaveBeenCalled();                        // retry guard intact
  });

  it('per-key throw does not starve subsequent keys', () => {
    const original = ATTEMPT_CLEANUP_FNS.councilTurnIds;
    ATTEMPT_CLEANUP_FNS.councilTurnIds = () => {
      throw new Error('cleanup failed');
    };
    adHocTurnIds.add('turn-throw');
    adHocTurnMeta.set('turn-throw', { modelDisplayNames: new Map(), win: null });
    try {
      cleanupTurnAttempt('turn-throw');
    } finally {
      ATTEMPT_CLEANUP_FNS.councilTurnIds = original;
    }

    expect(adHocTurnIds.has('turn-throw')).toBe(false);
    expect(adHocTurnMeta.has('turn-throw')).toBe(false);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'councilTurnIds', turnId: 'turn-throw' }),
      'cleanupTurnAttempt: per-key cleanup threw — continuing',
    );
  });

  it('completeTurnCleanup invokes per-attempt route cleanup once per turn', () => {
    councilTurnIds.add('turn-once');
    completeTurnCleanup('turn-once', 'completed');

    expect(removeRoutesMock).toHaveBeenCalledTimes(1);
    expect(removeRoutesMock).toHaveBeenCalledWith('turn-once');
  });
});
