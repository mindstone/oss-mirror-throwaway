import { describe, it, expect } from 'vitest';
import {
  createRuntimeState,
  applyEventToRuntime,
  primeRuntimeForTurn,
  isTurnStale,
  STALE_TURN_THRESHOLD_MS,
  type SessionRuntimeState
} from '../runtimeState';

describe('isTurnStale', () => {
  const NOW = 1_700_000_000_000;

  it('returns false for idle runtime (startedAt is null)', () => {
    const runtime = createRuntimeState();
    expect(isTurnStale(runtime, NOW)).toBe(false);
  });

  it('returns false for a recently active turn', () => {
    const runtime: SessionRuntimeState = {
      startedAt: NOW - 10_000,
      lastActivityAt: NOW - 2_000,
      activeTurnId: 'turn-1',
      terminated: false
    };
    expect(isTurnStale(runtime, NOW)).toBe(false);
  });

  it('returns true when last activity exceeds the threshold', () => {
    const runtime: SessionRuntimeState = {
      startedAt: NOW - 600_000,
      lastActivityAt: NOW - STALE_TURN_THRESHOLD_MS - 1,
      activeTurnId: 'turn-1',
      terminated: false
    };
    expect(isTurnStale(runtime, NOW)).toBe(true);
  });

  it('returns false at exactly the threshold boundary', () => {
    const runtime: SessionRuntimeState = {
      startedAt: NOW - 600_000,
      lastActivityAt: NOW - STALE_TURN_THRESHOLD_MS,
      activeTurnId: 'turn-1',
      terminated: false
    };
    expect(isTurnStale(runtime, NOW)).toBe(false);
  });

  it('falls back to startedAt when lastActivityAt is null', () => {
    const runtime: SessionRuntimeState = {
      startedAt: NOW - STALE_TURN_THRESHOLD_MS - 1,
      lastActivityAt: null,
      activeTurnId: 'turn-1',
      terminated: false
    };
    expect(isTurnStale(runtime, NOW)).toBe(true);
  });

  it('returns false when startedAt is old but lastActivityAt is recent', () => {
    const runtime: SessionRuntimeState = {
      startedAt: NOW - 500_000_000,
      lastActivityAt: NOW - 1_000,
      activeTurnId: 'turn-1',
      terminated: false
    };
    expect(isTurnStale(runtime, NOW)).toBe(false);
  });
});

describe('post-terminal event guard', () => {
  it('error → status: startedAt stays null, terminated stays true', () => {
    let runtime = createRuntimeState({
      startedAt: 1000,
      lastActivityAt: 1000,
      activeTurnId: 'turn-1',
      terminated: false
    });

    // Terminal event: error
    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'error',
      error: 'Connection failed',
      timestamp: 2000
    });
    expect(runtime.startedAt).toBeNull();
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.terminated).toBe(true);

    // Post-terminal status — must NOT re-prime
    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'status',
      message: 'Cleanup...',
      timestamp: 2030
    });
    expect(runtime.startedAt).toBeNull();
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.terminated).toBe(true);
    expect(runtime.lastActivityAt).toBe(2030);
  });

  it('result → status: startedAt stays null, terminated stays true', () => {
    let runtime = createRuntimeState({
      startedAt: 1000,
      lastActivityAt: 1000,
      activeTurnId: 'turn-1',
      terminated: false
    });

    // Terminal event: result
    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'result',
      text: 'Done.',
      timestamp: 2000
    });
    expect(runtime.startedAt).toBeNull();
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.terminated).toBe(true);

    // Post-terminal status — must NOT re-prime
    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'status',
      message: 'Processing...',
      timestamp: 2030
    });
    expect(runtime.startedAt).toBeNull();
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.terminated).toBe(true);
    expect(runtime.lastActivityAt).toBe(2030);
  });

  it('error → assistant: startedAt stays null, terminated stays true', () => {
    let runtime = createRuntimeState({
      startedAt: 1000,
      lastActivityAt: 1000,
      activeTurnId: 'turn-1',
      terminated: false
    });

    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'error',
      error: 'test error',
      timestamp: 2000
    });

    // Post-terminal assistant — must NOT re-prime
    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'assistant',
      text: 'Late chunk',
      timestamp: 2050
    });
    expect(runtime.startedAt).toBeNull();
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.terminated).toBe(true);
    expect(runtime.lastActivityAt).toBe(2050);
  });

  it('error → tool: startedAt stays null, terminated stays true', () => {
    let runtime = createRuntimeState({
      startedAt: 1000,
      lastActivityAt: 1000,
      activeTurnId: 'turn-1',
      terminated: false
    });

    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'error',
      error: 'test error',
      timestamp: 2000
    });

    // Post-terminal tool — must NOT re-prime
    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'tool',
      toolName: 'Bash',
      detail: '',
      stage: 'start',
      timestamp: 2050
    });
    expect(runtime.startedAt).toBeNull();
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.terminated).toBe(true);
    expect(runtime.lastActivityAt).toBe(2050);
  });

  it('primeRuntimeForTurn resets terminated flag', () => {
    const runtime = primeRuntimeForTurn('turn-2', 3000);
    expect(runtime.terminated).toBe(false);
    expect(runtime.startedAt).toBe(3000);
    expect(runtime.activeTurnId).toBe('turn-2');
  });

  it('createRuntimeState defaults terminated to false', () => {
    const runtime = createRuntimeState();
    expect(runtime.terminated).toBe(false);
  });

  it('replay [tool, error, status] ends with idle runtime', () => {
    let runtime = createRuntimeState();

    // Tool start primes runtime
    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'tool',
      toolName: 'Bash',
      detail: '',
      stage: 'start',
      timestamp: 1000
    });
    expect(runtime.startedAt).toBe(1000);
    expect(runtime.activeTurnId).toBe('turn-1');
    expect(runtime.terminated).toBe(false);

    // Error terminates
    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'error',
      error: 'crash',
      timestamp: 2000
    });
    expect(runtime.startedAt).toBeNull();
    expect(runtime.terminated).toBe(true);

    // Post-terminal status — stays idle
    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'status',
      message: 'Cleanup...',
      timestamp: 2030
    });
    expect(runtime.startedAt).toBeNull();
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.terminated).toBe(true);
  });
});

describe('turn_started event', () => {
  it('turn_started primes runtime', () => {
    let runtime = createRuntimeState();

    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'turn_started',
      timestamp: 1000
    });

    expect(runtime.startedAt).toBe(1000);
    expect(runtime.lastActivityAt).toBe(1000);
    expect(runtime.activeTurnId).toBe('turn-1');
    expect(runtime.terminated).toBe(false);
  });

  it('turn_started primes runtime for new turn after previous completed', () => {
    let runtime = createRuntimeState({
      startedAt: 1000,
      lastActivityAt: 1000,
      activeTurnId: 'turn-1',
      terminated: false
    });

    // Terminate turn-1
    runtime = applyEventToRuntime(runtime, 'turn-1', {
      type: 'error',
      error: 'test error',
      timestamp: 2000
    });
    expect(runtime.terminated).toBe(true);
    expect(runtime.activeTurnId).toBeNull();

    // turn_started for NEW turn-2 must prime despite terminated=true
    // (turn_started is only emitted at the start of executeAgentTurn,
    // so it's always a legitimate new turn, never a late/stale event)
    runtime = applyEventToRuntime(runtime, 'turn-2', {
      type: 'turn_started',
      timestamp: 3000
    });
    expect(runtime.startedAt).toBe(3000);
    expect(runtime.activeTurnId).toBe('turn-2');
    expect(runtime.terminated).toBe(false);
    expect(runtime.lastActivityAt).toBe(3000);
  });

  it('turn_started after turn_superseded resets activeTurnId', () => {
    // Start with runtime primed for turn-A
    let runtime = createRuntimeState({
      startedAt: 1000,
      lastActivityAt: 1500,
      activeTurnId: 'turn-A',
      terminated: false
    });

    // turn_started for a new turn-B (e.g., after supersession)
    // This should unconditionally reset activeTurnId to turn-B
    runtime = applyEventToRuntime(runtime, 'turn-B', {
      type: 'turn_started',
      timestamp: 2000
    });
    expect(runtime.activeTurnId).toBe('turn-B');
    expect(runtime.startedAt).toBe(2000);
    expect(runtime.lastActivityAt).toBe(2000);
    expect(runtime.terminated).toBe(false);
  });
});

/**
 * Regression tests for AskUserQuestion continuation race condition in runtimeState.
 *
 * Mirrors the conversationState tests: a late result/error from an old turn
 * (e.g., deny-and-retry AskUserQuestion) must NOT corrupt the runtime state
 * for a newer continuation turn.
 *
 * See: docs/plans/260414_user_question_continuation_stall_fix.md
 */
describe('AskUserQuestion continuation race condition', () => {
  it('late result from old turn does NOT reset runtime for newer turn', () => {
    let runtime = createRuntimeState();

    // Step 1: Turn A starts
    runtime = applyEventToRuntime(runtime, 'turn-A', {
      type: 'turn_started',
      timestamp: 1000
    });
    expect(runtime.activeTurnId).toBe('turn-A');
    expect(runtime.startedAt).toBe(1000);

    // Step 2: Turn B (continuation) starts
    runtime = applyEventToRuntime(runtime, 'turn-B', {
      type: 'turn_started',
      timestamp: 2000
    });
    expect(runtime.activeTurnId).toBe('turn-B');
    expect(runtime.startedAt).toBe(2000);
    expect(runtime.terminated).toBe(false);

    // Step 3: Late result from Turn A — must NOT clear Turn B's state
    runtime = applyEventToRuntime(runtime, 'turn-A', {
      type: 'result',
      text: '',
      timestamp: 2500
    });
    expect(runtime.activeTurnId).toBe('turn-B');
    expect(runtime.startedAt).toBe(2000);
    expect(runtime.terminated).toBe(false);
    // Only lastActivityAt should update
    expect(runtime.lastActivityAt).toBe(2500);

    // Step 4: Turn B completes normally
    runtime = applyEventToRuntime(runtime, 'turn-B', {
      type: 'result',
      text: 'Done.',
      timestamp: 3000
    });
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.startedAt).toBeNull();
    expect(runtime.terminated).toBe(true);
  });

  it('late error from old turn does NOT reset runtime for newer turn', () => {
    let runtime = createRuntimeState();

    // Turn A starts
    runtime = applyEventToRuntime(runtime, 'turn-A', {
      type: 'turn_started',
      timestamp: 1000
    });

    // Turn B (continuation) starts
    runtime = applyEventToRuntime(runtime, 'turn-B', {
      type: 'turn_started',
      timestamp: 2000
    });
    expect(runtime.activeTurnId).toBe('turn-B');

    // Late error from Turn A — must NOT corrupt Turn B's state
    runtime = applyEventToRuntime(runtime, 'turn-A', {
      type: 'error',
      error: 'Turn A failed after question deny-and-retry',
      timestamp: 2500
    });
    expect(runtime.activeTurnId).toBe('turn-B');
    expect(runtime.startedAt).toBe(2000);
    expect(runtime.terminated).toBe(false);
    expect(runtime.lastActivityAt).toBe(2500);
  });
});
