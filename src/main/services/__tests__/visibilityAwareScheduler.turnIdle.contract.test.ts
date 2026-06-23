import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSchedulerLogger } = vi.hoisted(() => ({
  mockSchedulerLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  },
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockSchedulerLogger,
  createTurnSessionLogger: () => mockSchedulerLogger,
}));

 
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => ({
    BrowserWindow: {
      getFocusedWindow: vi.fn().mockReturnValue(null),
    },
  }),
}));

 
vi.mock('@core/services/autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import {
  waitForTurnIdle,
  _resetForTesting,
} from '../visibilityAwareScheduler';

const trackedTurnIds = new Set<string>();
let counter = 0;

function nextTurnId(): string {
  counter += 1;
  const id = `vas-contract-turn-${counter}`;
  trackedTurnIds.add(id);
  return id;
}

function registerTurn(turnId: string): AbortController {
  const controller = new AbortController();
  agentTurnRegistry.setActiveTurnController(turnId, controller);
  return controller;
}

describe('visibilityAwareScheduler waitForTurnIdle behavioral contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
    for (const turnId of trackedTurnIds) {
      try { agentTurnRegistry.cleanupTurn(turnId); } catch { /* ignore */ }
    }
    trackedTurnIds.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stays pending when a turn starts during the initial idle probe', async () => {
    const turnId = nextTurnId();
    const realHasAnyActiveTurn = agentTurnRegistry.hasAnyActiveTurn.bind(agentTurnRegistry);
    let firstProbe = true;

    vi.spyOn(agentTurnRegistry, 'hasAnyActiveTurn').mockImplementation(() => {
      if (firstProbe) {
        firstProbe = false;
        const wasActive = realHasAnyActiveTurn();
        registerTurn(turnId);
        return wasActive;
      }
      return realHasAnyActiveTurn();
    });

    const waitPromise = waitForTurnIdle(undefined, 5_000);
    let settled: 'idle' | 'timeout' | 'aborted' | undefined;
    void waitPromise.then((result) => {
      settled = result;
    });

    await Promise.resolve();
    expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(true);
    expect(settled).toBeUndefined();

    agentTurnRegistry.cleanupTurn(turnId);
    await expect(waitPromise).resolves.toBe('idle');
  });
});
