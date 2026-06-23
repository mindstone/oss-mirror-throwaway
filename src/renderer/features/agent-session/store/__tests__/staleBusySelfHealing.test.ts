import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  appendRendererOptimisticTurnStartedEvent,
  clearCurrentSessionEvents,
  createSessionStore,
  appendEventToCurrentSession,
  getCurrentSessionProjectedLiveness,
  getCurrentSessionEventsForTurn,
} from '../sessionStore';

/**
 * Tests for the stale isBusy self-healing mechanism.
 *
 * When a turn completes (result/error event dispatched by main process),
 * the renderer's processEvent should clear isBusy. But if the Zustand state
 * transition is lost (event-loop congestion, concurrent persistence write),
 * the external events Map still has the terminal event while isBusy stays true.
 *
 * The self-healing interval (useAgentSessionEngine) detects this by checking
 * getCurrentSessionEventsForTurn for terminal events. This test verifies the
 * store-level primitives that make the healing possible.
 *
 * See: docs/plans/partway/260307_cloud_turn_sync_data_loss.md (Bug 4)
 */

beforeEach(() => {
  clearCurrentSessionEvents();
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

const errorEvent = (error: string, timestamp: number): AgentEvent => ({
  type: 'error',
  error,
  timestamp,
});

describe('stale isBusy self-healing primitives', () => {
  it('clearBusy clears renderer-local optimistic starts without writing raw busy scalars', () => {
    const store = createSessionStore();
    const turnId = 'optimistic-stuck-turn';

    appendRendererOptimisticTurnStartedEvent(turnId, Date.now());
    store.setState({ activeTurnId: turnId, isBusy: true });

    expect(getCurrentSessionProjectedLiveness(turnId).status).toBe('running');

    store.getState().clearBusy();

    expect(getCurrentSessionProjectedLiveness(turnId).status).toBe('idle');
    // The legacy scalar is intentionally untouched; read-side consumers must
    // use projection-derived liveness.
    expect(store.getState().isBusy).toBe(true);
  });

  it('clearBusy preserves existing messages when recovering from stuck state', () => {
    const store = createSessionStore();
    const turnId = 'preserve-turn';

    store.getState().addUserMessage('User question');
    const msgId = store.getState().messages[0].id;
    store.getState().assignTurnToMessage(msgId, turnId, 3000);
    store.getState().processEvent(turnId, turnStartedEvent(3001));

    // Process a result normally (this adds the result message)
    store.getState().processEvent(turnId, resultEvent('Agent answer', 3050));
    expect(store.getState().isBusy).toBe(false);
    expect(store.getState().messages).toHaveLength(2);
    expect(store.getState().messages[1].role).toBe('result');
    expect(store.getState().messages[1].text).toBe('Agent answer');
  });

  it('events Map check detects terminal result event', () => {
    const store = createSessionStore();
    const turnId = 'detect-result';

    store.getState().addUserMessage('Question');
    const msgId = store.getState().messages[0].id;
    store.getState().assignTurnToMessage(msgId, turnId, 4000);
    store.getState().processEvent(turnId, turnStartedEvent(4001));

    // Append result to events Map (simulates main-process dispatch)
    appendEventToCurrentSession(turnId, resultEvent('Done', 4050));

    const events = getCurrentSessionEventsForTurn(turnId);
    expect(events.some((e) => e.type === 'result')).toBe(true);
  });

  it('events Map check detects terminal error event', () => {
    const store = createSessionStore();
    const turnId = 'detect-error';

    store.getState().addUserMessage('Question');
    const msgId = store.getState().messages[0].id;
    store.getState().assignTurnToMessage(msgId, turnId, 5000);
    store.getState().processEvent(turnId, turnStartedEvent(5001));

    appendEventToCurrentSession(turnId, errorEvent('Something failed', 5050));

    const events = getCurrentSessionEventsForTurn(turnId);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('events Map check returns false when no terminal event', () => {
    const store = createSessionStore();
    const turnId = 'no-terminal';

    store.getState().addUserMessage('Question');
    const msgId = store.getState().messages[0].id;
    store.getState().assignTurnToMessage(msgId, turnId, 6000);
    store.getState().processEvent(turnId, turnStartedEvent(6001));

    // Only non-terminal events
    appendEventToCurrentSession(turnId, {
      type: 'status',
      message: 'Working...',
      timestamp: 6010,
    } as AgentEvent);

    const events = getCurrentSessionEventsForTurn(turnId);
    expect(events.some((e) => e.type === 'result' || e.type === 'error')).toBe(false);
  });
});
