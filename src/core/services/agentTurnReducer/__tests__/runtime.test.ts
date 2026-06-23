import { describe, expect, it } from 'vitest';
import { applyEventToRuntime, createRuntimeState, isTurnStale, primeRuntimeForTurn } from '../runtime';

describe('agentTurnReducer runtime', () => {
  it('primes runtime on turn_started', () => {
    expect(applyEventToRuntime(createRuntimeState(), 'turn-1', { type: 'turn_started', timestamp: 10 })).toEqual({
      startedAt: 10,
      lastActivityAt: 10,
      activeTurnId: 'turn-1',
      terminated: false,
    });
  });

  it('keeps duplicate turn_started idempotent for one turn', () => {
    const first = applyEventToRuntime(createRuntimeState(), 'turn-dup', {
      type: 'turn_started',
      timestamp: 10,
    });
    const second = applyEventToRuntime(first, 'turn-dup', {
      type: 'turn_started',
      timestamp: 20,
    });
    expect(second).toMatchObject({
      activeTurnId: 'turn-dup',
      terminated: false,
      lastActivityAt: 20,
    });
  });

  it('updates activity for status/tool/assistant events', () => {
    const runtime = primeRuntimeForTurn('turn-1', 10);
    expect(applyEventToRuntime(runtime, 'turn-1', { type: 'status', message: 'Working', timestamp: 20 }).lastActivityAt).toBe(20);
    expect(applyEventToRuntime(runtime, 'turn-1', { type: 'tool', stage: 'start', toolName: 'Read', detail: '', timestamp: 30 }).lastActivityAt).toBe(30);
    expect(applyEventToRuntime(runtime, 'turn-1', { type: 'assistant', text: 'Hi', timestamp: 40 }).lastActivityAt).toBe(40);
  });

  it('terminates the active turn on result', () => {
    const runtime = primeRuntimeForTurn('turn-1', 10);
    expect(applyEventToRuntime(runtime, 'turn-1', { type: 'result', text: 'Done', timestamp: 20 })).toMatchObject({ activeTurnId: null, terminated: true });
  });

  it('does not clear a newer active turn for an old result', () => {
    const runtime = primeRuntimeForTurn('turn-2', 10);
    expect(applyEventToRuntime(runtime, 'turn-1', { type: 'result', text: 'Done', timestamp: 20 }).activeTurnId).toBe('turn-2');
  });

  it('detects stale turns', () => {
    expect(isTurnStale(primeRuntimeForTurn('turn-1', 0), 5 * 60 * 1000 + 1)).toBe(true);
    expect(isTurnStale(createRuntimeState(), 5 * 60 * 1000 + 1)).toBe(false);
  });
});
