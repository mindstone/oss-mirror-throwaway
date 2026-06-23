import { describe, expect, it, vi } from 'vitest';

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getTurnLogger: vi.fn(() => undefined),
    deleteContextAccumulator: vi.fn(),
    cleanupTurn: vi.fn(),
    hasUserQuestionPending: vi.fn(() => false),
      hasOutputCapRetryAttempted: vi.fn(() => false),
      markOutputCapRetryAttempted: vi.fn(),
      clearOutputCapRetryAttempted: vi.fn(),
    getTurnModel: vi.fn(),
      getTurnActiveProvider: vi.fn(() => undefined),
      setTurnActiveProvider: vi.fn(),
    getRendererSession: vi.fn(),
    getTurnAuthMethod: vi.fn(),
    hasCostRecorded: vi.fn(() => false),
  },
}));

vi.mock('../../tracking', () => ({
  cleanupTurnAggregator: vi.fn(),
}));

vi.mock('../toolSafetyService', () => ({
  cleanupPendingApprovals: vi.fn(),
}));

vi.mock('../autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

vi.mock('../localModelProxyServer', () => ({
  proxyManager: {
    getAndResetTurnStats: vi.fn(() => new Map()),
    removeRoutes: vi.fn(),
  },
}));

vi.mock('../powerSaveBlockerService', () => ({
  releaseBlock: vi.fn(),
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: vi.fn(),
}));

vi.mock('@core/services/turnCheckpointService', () => ({
  getTurnCheckpointManager: vi.fn(() => ({ stopCheckpointing: vi.fn() })),
}));

import * as cleanupModule from '../agentTurnCleanup';

type CleanupState = Set<string> | Map<string, unknown>;

function moduleStateEntries(): ReadonlyArray<[string, CleanupState]> {
  return Object.entries(cleanupModule).filter(([, value]) => (
    value instanceof Set || value instanceof Map
  )) as ReadonlyArray<[string, CleanupState]>;
}

describe('agentTurnCleanup exhaustive module-level state cleanup', () => {
  it('every exported module-level Set/Map is empty for the turnId after completeTurnCleanup', () => {
    const turnId = 'snapshot-test-turn-id';
    const stateEntries = moduleStateEntries();
    expect(stateEntries.length).toBeGreaterThan(0);

    for (const [, state] of stateEntries) {
      if (state instanceof Set) state.add(turnId);
      else state.set(turnId, {} as never);
    }

    cleanupModule.completeTurnCleanup(turnId, 'completed');

    for (const [name, state] of stateEntries) {
      if (state instanceof Set) {
        expect(state.has(turnId), `Set ${name} still contains turnId`).toBe(false);
      } else {
        expect(state.has(turnId), `Map ${name} still contains turnId`).toBe(false);
      }
    }
  });

  it('introspected Set/Map state exports are registered in the cleanup key registry', () => {
    const stateNames = moduleStateEntries().map(([name]) => name).sort();
    expect(stateNames.length).toBeGreaterThan(0);

    const cleanupKeys = new Set(cleanupModule.ALL_CLEANUP_KEYS);
    const unknown = stateNames.filter((name) => !cleanupKeys.has(name as never));
    expect(unknown).toEqual([]);
  });
});
