import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { createSessionStore } from '../sessionStore';

/**
 * Regression coverage for the post-C-lite truncate semantics.
 *
 * Under C-lite (see docs/plans/260430_isbusy_stale_active_turn_id_root_cause_fix.md),
 * `state.activeTurnId` carries PROCESSING semantics and `state.focusedTurnId`
 * carries FOCUS semantics. Truncate is part of an edit-and-resubmit flow, so
 * the contract is:
 *
 *   1. BOTH `activeTurnId` and `focusedTurnId` are reset to null,
 *      regardless of whether focus has diverged from processing.
 *   2. `runtime` is reset (`runtime.activeTurnId` cleared).
 *   3. `isBusy` stays `true` because the caller is about to re-submit.
 *
 * The risk this test guards against: a future refactor that splits
 * processing-only and focus-only handlers (e.g. as part of I1 — runtime shadow
 * removal) could miss the symmetric reset of `focusedTurnId` if it only thinks
 * about the processing side. The reducer contract at
 * `conversationReducer.truncateToMessage` is the source of truth; this test
 * pins it at the store-integration layer where the bug would surface in
 * production.
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
  return messageId;
};

describe('truncateToMessage during in-flight turn (C-lite contract)', () => {
  it('clears BOTH activeTurnId and focusedTurnId even when focus has diverged from processing', () => {
    const store = createSessionStore();
    const turnAId = 'turn-a';
    const turnBId = 'turn-b';

    // Turn A completes normally; user clicks A's user-message; turn B starts.
    const turnAMessageId = startVanillaUserTurn(store, 'First question', turnAId, 1000);
    store.getState().processEvent(turnAId, { type: 'result', text: 'First answer', timestamp: 1010 });

    startVanillaUserTurn(store, 'Follow-up question', turnBId, 1100);
    expect(store.getState().activeTurnId).toBe(turnBId);
    expect(store.getState().focusedTurnId).toBe(turnBId);
    expect(store.getState().isBusy).toBe(true);

    // User clicks A while B is in-flight: focus diverges from processing.
    store.getState().setFocusedTurnId(turnAId);
    expect(store.getState().focusedTurnId).toBe(turnAId);
    expect(store.getState().activeTurnId).toBe(turnBId);

    // User edits Turn A's message and re-runs (triggers truncateToMessage).
    store.getState().truncateToMessage(turnAMessageId, 'Edited first question');

    // Both IDs must reset, regardless of where focus was, so the next
    // assignTurnToMessage call lands cleanly on a fresh turn.
    expect(store.getState().activeTurnId).toBeNull();
    expect(store.getState().focusedTurnId).toBeNull();
    // Runtime shadow is reset alongside (transitional shadow under C-lite).
    expect(store.getState().runtime.activeTurnId).toBeNull();
    // isBusy stays true — caller is mid edit-and-resubmit; new turn re-primes.
    expect(store.getState().isBusy).toBe(true);
    // Truncated past Turn A's message — only Turn A's user message remains.
    expect(store.getState().messages.length).toBe(1);
    expect(store.getState().messages[0].id).toBe(turnAMessageId);
    expect(store.getState().messages[0].text).toBe('Edited first question');
  });

  it('clears both IDs even when focus equals processing (single-turn case)', () => {
    const store = createSessionStore();
    const turnId = 'turn-only';

    const messageId = startVanillaUserTurn(store, 'Original question', turnId, 5000);
    expect(store.getState().activeTurnId).toBe(turnId);
    expect(store.getState().focusedTurnId).toBe(turnId);

    store.getState().truncateToMessage(messageId, 'Edited question');

    expect(store.getState().activeTurnId).toBeNull();
    expect(store.getState().focusedTurnId).toBeNull();
    expect(store.getState().runtime.activeTurnId).toBeNull();
    expect(store.getState().isBusy).toBe(true);
  });
});
