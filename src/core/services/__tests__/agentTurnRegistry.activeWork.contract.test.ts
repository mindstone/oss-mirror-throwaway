import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

 
vi.mock('@core/logger', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
  return {
    createTurnSessionLogger: () => mockLogger,
    createScopedLogger: () => mockLogger,
  };
});

 
vi.mock('../autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

import { agentTurnRegistry } from '../agentTurnRegistry';

const trackedTurnIds = new Set<string>();
let counter = 0;

function nextTurnId(): string {
  counter += 1;
  const id = `aw-contract-turn-${counter}`;
  trackedTurnIds.add(id);
  return id;
}

function registerTurn(turnId: string): AbortController {
  const controller = new AbortController();
  agentTurnRegistry.setActiveTurnController(turnId, controller);
  return controller;
}

describe('agentTurnRegistry active-work behavioral contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const turnId of trackedTurnIds) {
      try { agentTurnRegistry.cleanupTurn(turnId); } catch { /* ignore */ }
    }
    trackedTurnIds.clear();
    vi.restoreAllMocks();
  });

  it('emits only on zero crossings when concurrent turns are removed through mixed cleanup paths', () => {
    const observedBusyStates: boolean[] = [];
    const listener = vi.fn(() => {
      observedBusyStates.push(agentTurnRegistry.hasAnyActiveTurn());
    });
    const unsubscribe = agentTurnRegistry.subscribeTurnIdleStateChange(listener);

    const firstTurnId = nextTurnId();
    const secondTurnId = nextTurnId();

    registerTurn(firstTurnId);
    registerTurn(secondTurnId);
    agentTurnRegistry.cleanupForRetry(firstTurnId);
    agentTurnRegistry.deleteActiveTurnController(secondTurnId);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(observedBusyStates).toEqual([true, false]);

    unsubscribe();
  });
});
