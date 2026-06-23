import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { createSessionStore } from '../sessionStore';

/**
 * Regression coverage for the stale-spinner bug class documented in:
 * docs-private/postmortems/260414_user_question_continuation_stall_recurring_postmortem.md
 *
 * Historical bug (pre-C-lite): focus and processing both wrote to
 * `state.activeTurnId`. Clicking an older message could overwrite the
 * processing turn ID, then the reducer's strict terminal guard
 * (`state.activeTurnId === turnId`) would reject the real processing turn's
 * result/error, leaving `isBusy: true` stuck indefinitely.
 *
 * Under C-lite, focus writes `focusedTurnId` and processing writes
 * `activeTurnId`, so vanilla user-message turns cannot hit this stale-ID
 * deadlock pattern.
 */

beforeEach(() => {
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });
});

const turnStartedEvent = (timestamp: number): AgentEvent => ({
  type: 'turn_started',
  timestamp,
});

const resultEvent = (text: string, timestamp: number): AgentEvent => ({
  type: 'result',
  text,
  timestamp,
});

const startVanillaUserTurn = (
  store: ReturnType<typeof createSessionStore>,
  text: string,
  turnId: string,
  timestamp: number,
) => {
  store.getState().addUserMessage(text);
  const message = store.getState().messages.at(-1);
  expect(message).toBeDefined();
  const messageId = message?.id ?? '';
  store.getState().assignTurnToMessage(messageId, turnId, timestamp);
  store.getState().processEvent(turnId, turnStartedEvent(timestamp + 1));
};

const finishTurnWithResult = (
  store: ReturnType<typeof createSessionStore>,
  turnId: string,
  text: string,
  timestamp: number,
) => {
  store.getState().processEvent(turnId, resultEvent(text, timestamp));
};

const focusTurnViaProducer = (
  store: ReturnType<typeof createSessionStore>,
  turnId: string,
) => {
  // Use the same store action that useAgentSessionEngine.focusTurn delegates to.
  store.getState().setFocusedTurnId(turnId);
};

describe('C-lite stale activeTurnId regression', () => {
  it('still terminates correctly when user focuses an older message during turn B processing', () => {
    const store = createSessionStore();
    const turnAId = 'turn-a';
    const turnBId = 'turn-b';

    startVanillaUserTurn(store, 'First question', turnAId, 1000);
    finishTurnWithResult(store, turnAId, 'First answer', 1020);

    startVanillaUserTurn(store, 'Follow-up question', turnBId, 1100);
    expect(store.getState().activeTurnId).toBe(turnBId);
    expect(store.getState().focusedTurnId).toBe(turnBId);
    expect(store.getState().isBusy).toBe(true);

    // Simulate clicking an older transcript message while turn B is in-flight.
    focusTurnViaProducer(store, turnAId);
    expect(store.getState().focusedTurnId).toBe(turnAId);
    expect(store.getState().activeTurnId).toBe(turnBId);
    expect(store.getState().isBusy).toBe(true);

    finishTurnWithResult(store, turnBId, 'Follow-up answer', 1120);

    expect(store.getState().isBusy).toBe(false);
    expect(store.getState().activeTurnId).toBeNull();
    expect(store.getState().focusedTurnId).toBe(turnAId);
  });

  it('keeps turn-B completion correct when user focuses turn A between turns A and B', () => {
    const store = createSessionStore();
    const turnAId = 'turn-a';
    const turnBId = 'turn-b';

    startVanillaUserTurn(store, 'First question', turnAId, 2000);
    finishTurnWithResult(store, turnAId, 'First answer', 2020);

    expect(store.getState().isBusy).toBe(false);
    expect(store.getState().activeTurnId).toBeNull();

    // Simulate clicking an older transcript message between turns.
    focusTurnViaProducer(store, turnAId);
    expect(store.getState().focusedTurnId).toBe(turnAId);
    expect(store.getState().activeTurnId).toBeNull();

    startVanillaUserTurn(store, 'Follow-up question', turnBId, 2100);
    expect(store.getState().activeTurnId).toBe(turnBId);
    expect(store.getState().focusedTurnId).toBe(turnBId);
    expect(store.getState().isBusy).toBe(true);

    finishTurnWithResult(store, turnBId, 'Follow-up answer', 2120);

    expect(store.getState().isBusy).toBe(false);
    expect(store.getState().activeTurnId).toBeNull();
    expect(store.getState().focusedTurnId).toBe(turnBId);
  });
});
