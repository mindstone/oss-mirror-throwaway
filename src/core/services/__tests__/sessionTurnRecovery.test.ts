import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@shared/types';
import { applyInterruptedTurnCorrection } from '../sessionTurnRecovery';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    title: 'Test session',
    createdAt: 1000,
    updatedAt: 2000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    doneAt: null,
    origin: 'manual',
    ...overrides,
  } as AgentSession;
}

describe('applyInterruptedTurnCorrection', () => {
  it('sets interruptedTurnId when stale turn has no terminal event', () => {
    const session = makeSession({
      activeTurnId: 'turn-1',
      isBusy: true,
      eventsByTurn: { 'turn-1': [{ type: 'tool', toolName: 'test', detail: '', stage: 'start', timestamp: 1000 }] },
    });

    const corrected = applyInterruptedTurnCorrection(session, 'turn-1');

    expect(corrected.interruptedTurnId).toBe('turn-1');
    expect(corrected.activeTurnId).toBeNull();
    expect(corrected.isBusy).toBe(false);
  });

  it('does NOT set interruptedTurnId when terminal event (result) exists', () => {
    const session = makeSession({
      activeTurnId: 'turn-1',
      isBusy: true,
      eventsByTurn: { 'turn-1': [{ type: 'result', text: 'done', timestamp: 1000 }] },
    });

    const corrected = applyInterruptedTurnCorrection(session, 'turn-1');

    expect(corrected.interruptedTurnId).toBeUndefined();
    expect(corrected.activeTurnId).toBeNull();
    expect(corrected.isBusy).toBe(false);
  });

  it('does NOT set interruptedTurnId when terminal event (error) exists', () => {
    const session = makeSession({
      activeTurnId: 'turn-1',
      isBusy: true,
      eventsByTurn: { 'turn-1': [{ type: 'error', error: 'failed', timestamp: 1000 }] },
    });

    const corrected = applyInterruptedTurnCorrection(session, 'turn-1');

    expect(corrected.interruptedTurnId).toBeUndefined();
    expect(corrected.activeTurnId).toBeNull();
    expect(corrected.isBusy).toBe(false);
  });

  it('clears activeTurnId and isBusy', () => {
    const session = makeSession({
      activeTurnId: 'turn-1',
      isBusy: true,
      eventsByTurn: { 'turn-1': [] },
    });

    const corrected = applyInterruptedTurnCorrection(session, 'turn-1');

    expect(corrected.activeTurnId).toBeNull();
    expect(corrected.isBusy).toBe(false);
  });

  it('does NOT modify updatedAt', () => {
    const session = makeSession({
      activeTurnId: 'turn-1',
      isBusy: true,
      updatedAt: 2000,
      eventsByTurn: { 'turn-1': [] },
    });

    const corrected = applyInterruptedTurnCorrection(session, 'turn-1');

    expect(corrected.updatedAt).toBe(2000);
  });

  it('uses staleTurnId parameter, not session.activeTurnId', () => {
    const session = makeSession({
      activeTurnId: 'turn-2',
      isBusy: true,
      eventsByTurn: {
        'turn-1': [],
        'turn-2': [{ type: 'result', text: 'done', timestamp: 1000 }],
      },
    });

    const corrected = applyInterruptedTurnCorrection(session, 'turn-1');

    expect(corrected.interruptedTurnId).toBe('turn-1');
  });

  it('handles undefined eventsByTurn gracefully', () => {
    const session = makeSession({
      activeTurnId: 'turn-1',
      isBusy: true,
      eventsByTurn: undefined,
    });

    const corrected = applyInterruptedTurnCorrection(session, 'turn-1');

    expect(corrected.interruptedTurnId).toBe('turn-1');
    expect(corrected.activeTurnId).toBeNull();
    expect(corrected.isBusy).toBe(false);
  });

  it('is idempotent', () => {
    const session = makeSession({
      activeTurnId: 'turn-1',
      isBusy: true,
      eventsByTurn: { 'turn-1': [] },
    });

    const first = applyInterruptedTurnCorrection(session, 'turn-1');
    const second = applyInterruptedTurnCorrection(first, 'turn-1');

    expect(second.interruptedTurnId).toBe('turn-1');
    expect(second.activeTurnId).toBeNull();
    expect(second.isBusy).toBe(false);
  });
});
