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
  isAnyTurnActive,
  onTurnIdleStateChange,
  waitForTurnIdle,
  _resetForTesting,
} from '../visibilityAwareScheduler';

const trackedTurnIds = new Set<string>();
let counter = 0;
function nextTurnId(): string {
  counter += 1;
  const id = `vas-turn-${counter}`;
  trackedTurnIds.add(id);
  return id;
}

function registerTurn(turnId: string): AbortController {
  const controller = new AbortController();
  agentTurnRegistry.setActiveTurnController(turnId, controller);
  return controller;
}

describe('visibilityAwareScheduler — turn-idle primitives', () => {
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
    vi.useRealTimers();
  });

  describe('isAnyTurnActive()', () => {
    it('returns false when registry is empty', () => {
      expect(isAnyTurnActive()).toBe(false);
    });

    it('returns true while a turn is registered', () => {
      const t1 = nextTurnId();
      registerTurn(t1);
      expect(isAnyTurnActive()).toBe(true);
      agentTurnRegistry.cleanupTurn(t1);
      expect(isAnyTurnActive()).toBe(false);
    });
  });

  describe('onTurnIdleStateChange()', () => {
    it('fires on transitions through zero', () => {
      const listener = vi.fn();
      const unsub = onTurnIdleStateChange(listener);

      const t1 = nextTurnId();
      registerTurn(t1);
      expect(listener).toHaveBeenCalledTimes(1);

      agentTurnRegistry.cleanupTurn(t1);
      expect(listener).toHaveBeenCalledTimes(2);

      unsub();
    });

    it('unsubscribe stops future notifications', () => {
      const listener = vi.fn();
      const unsub = onTurnIdleStateChange(listener);
      unsub();

      const t1 = nextTurnId();
      registerTurn(t1);
      agentTurnRegistry.cleanupTurn(t1);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('waitForTurnIdle()', () => {
    it('resolves immediately when already idle', async () => {
      await expect(waitForTurnIdle()).resolves.toBe('idle');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('settles on busy → idle transition and cleans up timers', async () => {
      const t1 = nextTurnId();
      registerTurn(t1);

      const waitPromise = waitForTurnIdle(undefined, 5_000);
      expect(vi.getTimerCount()).toBe(1);

      agentTurnRegistry.cleanupTurn(t1);

      await expect(waitPromise).resolves.toBe('idle');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects with timeout when turns never go idle', async () => {
      const t1 = nextTurnId();
      registerTurn(t1);

      const waitPromise = waitForTurnIdle(undefined, 2_500);
      await vi.advanceTimersByTimeAsync(2_500);

      await expect(waitPromise).resolves.toBe('timeout');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects with aborted when the signal aborts', async () => {
      const t1 = nextTurnId();
      registerTurn(t1);

      const controller = new AbortController();
      const waitPromise = waitForTurnIdle(controller.signal, 5_000);
      controller.abort();

      await expect(waitPromise).resolves.toBe('aborted');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('resolves immediately for a pre-aborted signal while busy', async () => {
      const t1 = nextTurnId();
      registerTurn(t1);

      const controller = new AbortController();
      controller.abort();

      await expect(waitForTurnIdle(controller.signal, 5_000)).resolves.toBe('aborted');
      expect(vi.getTimerCount()).toBe(0);
    });

    // Phase 6 regression — specialist-behavioral-safety finding: a pre-aborted
    // signal must take precedence over a current idle state. Otherwise a caller
    // that already cancelled its workflow gets `'idle'` and proceeds, defeating
    // the cancellation.
    it('resolves "aborted" for a pre-aborted signal even while idle', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(waitForTurnIdle(controller.signal, 5_000)).resolves.toBe('aborted');
      expect(vi.getTimerCount()).toBe(0);
    });

    // Phase 6 regression — tester-gpt5.5 + specialist-completeness finding:
    // initial-probe race. If a turn registers between the implementation's
    // initial idleness check and the listener subscription, the function
    // must NOT settle 'idle' from the stale snapshot — it must wait for the
    // listener to observe the eventual busy → idle transition.
    it('stays pending when a turn starts during the initial idle probe', async () => {
      const turnId = nextTurnId();

      const realHasAnyActiveTurn = agentTurnRegistry.hasAnyActiveTurn.bind(agentTurnRegistry);
      let firstProbe = true;
      const probeSpy = vi
        .spyOn(agentTurnRegistry, 'hasAnyActiveTurn')
        .mockImplementation(() => {
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
      expect(realHasAnyActiveTurn()).toBe(true);
      expect(settled).toBeUndefined();

      probeSpy.mockRestore();
      agentTurnRegistry.cleanupTurn(turnId);

      await expect(waitPromise).resolves.toBe('idle');
    });

    it('does not fire after partial idle when another turn is still active', async () => {
      const t1 = nextTurnId();
      const t2 = nextTurnId();
      registerTurn(t1);
      registerTurn(t2);

      const waitPromise = waitForTurnIdle(undefined, 5_000);

      // Drop one — count goes from 2 to 1, no zero crossing.
      agentTurnRegistry.cleanupTurn(t1);

      // Should still be pending.
      let settled: 'idle' | 'timeout' | 'aborted' | undefined;
      void waitPromise.then((v) => { settled = v; });
      await Promise.resolve();
      expect(settled).toBeUndefined();

      // Drop the second — count goes 1 → 0, listener fires, settles 'idle'.
      agentTurnRegistry.cleanupTurn(t2);
      await expect(waitPromise).resolves.toBe('idle');
    });
  });
});
