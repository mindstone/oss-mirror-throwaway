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
  const id = `aw-turn-${counter}`;
  trackedTurnIds.add(id);
  return id;
}

function registerTurn(turnId: string): AbortController {
  const controller = new AbortController();
  agentTurnRegistry.setActiveTurnController(turnId, controller);
  return controller;
}

describe('agentTurnRegistry.hasAnyActiveTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const turnId of trackedTurnIds) {
      try { agentTurnRegistry.cleanupTurn(turnId); } catch { /* ignore */ }
    }
    trackedTurnIds.clear();
  });

  it('returns false when there are no active turns', () => {
    expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(false);
  });

  it('returns true while there are active turns and false after all are cleaned up', () => {
    const t1 = nextTurnId();
    const t2 = nextTurnId();

    registerTurn(t1);
    expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(true);

    registerTurn(t2);
    expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(true);

    agentTurnRegistry.cleanupTurn(t1);
    expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(true);

    agentTurnRegistry.cleanupTurn(t2);
    expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(false);
  });
});

describe('agentTurnRegistry.subscribeTurnIdleStateChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const turnId of trackedTurnIds) {
      try { agentTurnRegistry.cleanupTurn(turnId); } catch { /* ignore */ }
    }
    trackedTurnIds.clear();
  });

  it('fires on idle → busy and busy → idle transitions only', () => {
    const listener = vi.fn();
    const unsub = agentTurnRegistry.subscribeTurnIdleStateChange(listener);

    const t1 = nextTurnId();
    const t2 = nextTurnId();

    // 0 → 1: fires
    registerTurn(t1);
    expect(listener).toHaveBeenCalledTimes(1);

    // 1 → 2: does NOT fire (no zero crossing)
    registerTurn(t2);
    expect(listener).toHaveBeenCalledTimes(1);

    // 2 → 1: does NOT fire
    agentTurnRegistry.cleanupTurn(t1);
    expect(listener).toHaveBeenCalledTimes(1);

    // 1 → 0: fires
    agentTurnRegistry.cleanupTurn(t2);
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
  });

  it('cleanupForRetry that drops the count to zero fires the listener', () => {
    const listener = vi.fn();
    const unsub = agentTurnRegistry.subscribeTurnIdleStateChange(listener);

    const t1 = nextTurnId();
    registerTurn(t1);
    expect(listener).toHaveBeenCalledTimes(1);

    agentTurnRegistry.cleanupForRetry(t1);
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
  });

  it('deleteActiveTurnController firing the count to zero fires the listener', () => {
    const listener = vi.fn();
    const unsub = agentTurnRegistry.subscribeTurnIdleStateChange(listener);

    const t1 = nextTurnId();
    registerTurn(t1);
    expect(listener).toHaveBeenCalledTimes(1);

    agentTurnRegistry.deleteActiveTurnController(t1);
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
  });

  it('unsubscribe stops future notifications', () => {
    const listener = vi.fn();
    const unsub = agentTurnRegistry.subscribeTurnIdleStateChange(listener);

    unsub();

    const t1 = nextTurnId();
    registerTurn(t1);
    agentTurnRegistry.cleanupTurn(t1);

    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates listener errors so other listeners and lifecycle continue', () => {
    const goodListener = vi.fn();
    const badListener = vi.fn(() => { throw new Error('listener boom'); });

    const unsubBad = agentTurnRegistry.subscribeTurnIdleStateChange(badListener);
    const unsubGood = agentTurnRegistry.subscribeTurnIdleStateChange(goodListener);

    const t1 = nextTurnId();
    expect(() => registerTurn(t1)).not.toThrow();

    expect(badListener).toHaveBeenCalledTimes(1);
    expect(goodListener).toHaveBeenCalledTimes(1);

    expect(() => agentTurnRegistry.cleanupTurn(t1)).not.toThrow();

    unsubBad();
    unsubGood();
  });
});
