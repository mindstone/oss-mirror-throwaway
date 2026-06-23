import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks – declared before imports so vi.mock hoisting works correctly
// ---------------------------------------------------------------------------

vi.mock('@core/logger', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    createTurnSessionLogger: () => mockLogger,
    createScopedLogger: () => mockLogger,
  };
});

vi.mock('../autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { agentTurnRegistry } from '../agentTurnRegistry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Register a mock turn with an AbortController */
function registerTurn(turnId: string): AbortController {
  const controller = new AbortController();
  agentTurnRegistry.setActiveTurnController(turnId, controller);
  return controller;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentTurnRegistry.onDrained', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Ensure all registered turns are cleaned up
    // (agentTurnRegistry is a singleton, state persists across tests)
    for (const turnId of ['turn-1', 'turn-2', 'turn-3']) {
      try { agentTurnRegistry.cleanupTurn(turnId); } catch { /* ignore */ }
    }
  });

  it('fires callback when the last active turn is cleaned up', async () => {
    const cb = vi.fn();

    registerTurn('turn-1');
    agentTurnRegistry.onDrained(cb);

    // Cleanup the only active turn — should trigger drain
    agentTurnRegistry.cleanupTurn('turn-1');

    // Callback fires via queueMicrotask — await a microtask tick
    await Promise.resolve();

    expect(cb).toHaveBeenCalledOnce();
  });

  it('does NOT fire callback when non-last turn is cleaned up', async () => {
    const cb = vi.fn();

    registerTurn('turn-1');
    registerTurn('turn-2');
    agentTurnRegistry.onDrained(cb);

    // Cleanup first turn — still one active
    agentTurnRegistry.cleanupTurn('turn-1');
    await Promise.resolve();

    expect(cb).not.toHaveBeenCalled();

    // Cleanup second turn — now drained
    agentTurnRegistry.cleanupTurn('turn-2');
    await Promise.resolve();

    expect(cb).toHaveBeenCalledOnce();
  });

  it('supports multiple listeners', async () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    registerTurn('turn-1');
    agentTurnRegistry.onDrained(cb1);
    agentTurnRegistry.onDrained(cb2);

    agentTurnRegistry.cleanupTurn('turn-1');
    await Promise.resolve();

    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it('clears callbacks after firing (one-shot)', async () => {
    const cb = vi.fn();

    registerTurn('turn-1');
    agentTurnRegistry.onDrained(cb);
    agentTurnRegistry.cleanupTurn('turn-1');
    await Promise.resolve();

    expect(cb).toHaveBeenCalledOnce();

    // Register and cleanup another turn — cb should NOT fire again
    registerTurn('turn-2');
    agentTurnRegistry.cleanupTurn('turn-2');
    await Promise.resolve();

    expect(cb).toHaveBeenCalledOnce(); // Still 1, not 2
  });

  it('does not fire callback when no active turns existed', async () => {
    const cb = vi.fn();

    // No turns registered, just register callback
    agentTurnRegistry.onDrained(cb);

    // Cleaning up a non-existent turn should not trigger
    agentTurnRegistry.cleanupTurn('turn-nonexistent');
    await Promise.resolve();

    expect(cb).not.toHaveBeenCalled();
  });
});
