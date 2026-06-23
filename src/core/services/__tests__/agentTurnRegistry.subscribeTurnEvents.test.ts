import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks – declared before imports so vi.mock hoisting works correctly
// ---------------------------------------------------------------------------

 
vi.mock('@core/logger', () => ({
  createTurnSessionLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

 
vi.mock('@core/tracking', () => ({
  getTracker: () => ({
    track: vi.fn(),
    identify: vi.fn(),
    getAnonymousId: vi.fn(() => 'anon-test-id'),
    isAvailable: vi.fn(() => true),
  }),
}));

 
vi.mock('../autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are set up)
// ---------------------------------------------------------------------------

import type { AgentEvent } from '@shared/types';
import { agentTurnRegistry } from '../agentTurnRegistry';
import { dispatchAgentEvent } from '../agentEventDispatcher';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const trackedTurnIds = new Set<string>();
const trackedSessionStartUnsubs: Array<() => void> = [];
let turnCounter = 0;

function nextTurnId(): string {
  turnCounter += 1;
  const turnId = `subscribe-turn-${turnCounter}`;
  trackedTurnIds.add(turnId);
  return turnId;
}

function makeEvent(overrides: Partial<Extract<AgentEvent, { type: 'assistant_delta' }>> = {}) {
  const delta: Extract<AgentEvent, { type: 'assistant_delta' }> = {
    type: 'assistant_delta',
    text: 'hi',
    timestamp: Date.now(),
    ...overrides,
  };
  return delta;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentTurnRegistry.subscribeTurnEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const unsub of trackedSessionStartUnsubs.splice(0)) {
      try { unsub(); } catch { /* ignore */ }
    }
    for (const turnId of trackedTurnIds) {
      try { agentTurnRegistry.cleanupTurn(turnId); } catch { /* ignore */ }
    }
    trackedTurnIds.clear();
  });

  it('fans events to multiple subscribers', () => {
    const turnId = nextTurnId();
    const sub1 = vi.fn();
    const sub2 = vi.fn();

    agentTurnRegistry.subscribeTurnEvents(turnId, sub1);
    agentTurnRegistry.subscribeTurnEvents(turnId, sub2);

    dispatchAgentEvent(null, turnId, makeEvent({ text: 'hello' }));

    expect(sub1).toHaveBeenCalledOnce();
    expect(sub2).toHaveBeenCalledOnce();
  });

  it('unsubscribe removes only the specified subscriber', () => {
    const turnId = nextTurnId();
    const sub1 = vi.fn();
    const sub2 = vi.fn();

    const unsub1 = agentTurnRegistry.subscribeTurnEvents(turnId, sub1);
    agentTurnRegistry.subscribeTurnEvents(turnId, sub2);

    unsub1();

    dispatchAgentEvent(null, turnId, makeEvent({ text: 'a' }));

    expect(sub1).not.toHaveBeenCalled();
    expect(sub2).toHaveBeenCalledOnce();
  });

  it('isolates subscriber errors — one throwing does not break others', () => {
    const turnId = nextTurnId();
    const sub1 = vi.fn(() => {
      throw new Error('sub1 boom');
    });
    const sub2 = vi.fn();

    agentTurnRegistry.subscribeTurnEvents(turnId, sub1);
    agentTurnRegistry.subscribeTurnEvents(turnId, sub2);

    expect(() =>
      dispatchAgentEvent(null, turnId, makeEvent({ text: 'x' })),
    ).not.toThrow();

    expect(sub1).toHaveBeenCalledOnce();
    expect(sub2).toHaveBeenCalledOnce();
  });

  it('does not interfere with the single-slot setEventListener path', () => {
    const turnId = nextTurnId();
    const singleSlot = vi.fn();
    const subscriber = vi.fn();

    agentTurnRegistry.setEventListener(turnId, singleSlot);
    agentTurnRegistry.subscribeTurnEvents(turnId, subscriber);

    const event = makeEvent({ text: 'delta' });
    dispatchAgentEvent(null, turnId, event);

    expect(singleSlot).toHaveBeenCalledOnce();
    expect(subscriber).toHaveBeenCalledOnce();
  });

  it('single-slot listener throw does not stop subscribers (isolation)', () => {
    const turnId = nextTurnId();
    const singleSlot = vi.fn(() => {
      throw new Error('single-slot boom');
    });
    const subscriber = vi.fn();

    agentTurnRegistry.setEventListener(turnId, singleSlot);
    agentTurnRegistry.subscribeTurnEvents(turnId, subscriber);

    expect(() =>
      dispatchAgentEvent(null, turnId, makeEvent({ text: 'x' })),
    ).not.toThrow();

    expect(subscriber).toHaveBeenCalledOnce();
  });

  it('cleanupTurn clears subscribers', () => {
    const turnId = nextTurnId();
    const sub = vi.fn();
    agentTurnRegistry.subscribeTurnEvents(turnId, sub);

    expect(agentTurnRegistry.getEventSubscribers(turnId)?.size).toBe(1);

    agentTurnRegistry.cleanupTurn(turnId);

    expect(agentTurnRegistry.getEventSubscribers(turnId)).toBeUndefined();

    // Dispatch after cleanup — should not call the old subscriber
    dispatchAgentEvent(null, turnId, makeEvent());
    expect(sub).not.toHaveBeenCalled();
  });

  it('cleanupForRetry clears subscribers', () => {
    const turnId = nextTurnId();
    const sub = vi.fn();
    agentTurnRegistry.subscribeTurnEvents(turnId, sub);

    expect(agentTurnRegistry.getEventSubscribers(turnId)?.size).toBe(1);

    agentTurnRegistry.cleanupForRetry(turnId);

    expect(agentTurnRegistry.getEventSubscribers(turnId)).toBeUndefined();
  });

  it('cleanupForRetry PRESERVES the single-slot event listener (260512 retry observer-loss fix)', () => {
    // Regression: previously cleanupForRetry deleted turnEventListeners, which
    // broke the eval harness and any other process-local consumer that
    // registers a single listener per turn and has no re-registration hook.
    // Symptom: 900s harness timeout with abort grace also expired, because the
    // listener was wiped on retry and the eventual terminal event from the
    // retry attempt had no listener to fan out to.
    const turnId = nextTurnId();
    const listener = vi.fn();
    agentTurnRegistry.setEventListener(turnId, listener);

    expect(agentTurnRegistry.getEventListener(turnId)).toBe(listener);

    agentTurnRegistry.cleanupForRetry(turnId);

    expect(agentTurnRegistry.getEventListener(turnId)).toBe(listener);

    // Dispatch after retry cleanup should reach the preserved listener.
    dispatchAgentEvent(null, turnId, makeEvent({ text: 'post-retry-delta' }));
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      type: 'assistant_delta',
      text: 'post-retry-delta',
    });
  });

  it('cleanupTurn (final teardown) DOES clear the single-slot listener', () => {
    // Sanity: confirm the listener is still cleared on terminal cleanup, so
    // we don't leak listener refs after a turn completes.
    const turnId = nextTurnId();
    const listener = vi.fn();
    agentTurnRegistry.setEventListener(turnId, listener);

    expect(agentTurnRegistry.getEventListener(turnId)).toBe(listener);

    agentTurnRegistry.cleanupTurn(turnId);

    expect(agentTurnRegistry.getEventListener(turnId)).toBeUndefined();
  });

  it('supports non-delta events too (full dispatch path)', () => {
    const turnId = nextTurnId();
    const sub = vi.fn();
    agentTurnRegistry.subscribeTurnEvents(turnId, sub);

    // Status is a non-delta event that exercises the full dispatch path.
    // Error events are intentionally excluded from dispatchAgentEvent's type
    // signature (they must go through dispatchAgentErrorEvent — see
    // docs/plans/260420_inline_error_dispatch_migration.md Stage 3).
    const statusEvent: Extract<AgentEvent, { type: 'status' }> = {
      type: 'status',
      message: 'working',
      timestamp: Date.now(),
    };

    dispatchAgentEvent(null, turnId, statusEvent);

    expect(sub).toHaveBeenCalledOnce();
    expect(sub.mock.calls[0]?.[0]).toMatchObject({ type: 'status' });
  });
});

describe('agentTurnRegistry.onTurnStartedForSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const unsub of trackedSessionStartUnsubs.splice(0)) {
      try { unsub(); } catch { /* ignore */ }
    }
    for (const turnId of trackedTurnIds) {
      try { agentTurnRegistry.cleanupTurn(turnId); } catch { /* ignore */ }
    }
    trackedTurnIds.clear();
  });

  it('fires when setRendererSession maps a new turn to the session', () => {
    const sessionId = 'session-A';
    const listener = vi.fn();
    trackedSessionStartUnsubs.push(
      agentTurnRegistry.onTurnStartedForSession(sessionId, listener),
    );

    const turnId = nextTurnId();
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(turnId);
  });

  it('fires each time a new turnId is mapped to the same session', () => {
    const sessionId = 'session-B';
    const listener = vi.fn();
    trackedSessionStartUnsubs.push(
      agentTurnRegistry.onTurnStartedForSession(sessionId, listener),
    );

    const t1 = nextTurnId();
    const t2 = nextTurnId();
    agentTurnRegistry.setRendererSession(t1, sessionId);
    agentTurnRegistry.setRendererSession(t2, sessionId);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, t1);
    expect(listener).toHaveBeenNthCalledWith(2, t2);
  });

  it('does not fire when the same turn-to-session mapping is re-applied', () => {
    const sessionId = 'session-C';
    const listener = vi.fn();
    trackedSessionStartUnsubs.push(
      agentTurnRegistry.onTurnStartedForSession(sessionId, listener),
    );

    const turnId = nextTurnId();
    agentTurnRegistry.setRendererSession(turnId, sessionId);
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    expect(listener).toHaveBeenCalledOnce();
  });

  it('only notifies listeners for the matching session', () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    trackedSessionStartUnsubs.push(
      agentTurnRegistry.onTurnStartedForSession('session-A', listenerA),
    );
    trackedSessionStartUnsubs.push(
      agentTurnRegistry.onTurnStartedForSession('session-B', listenerB),
    );

    const turnId = nextTurnId();
    agentTurnRegistry.setRendererSession(turnId, 'session-A');

    expect(listenerA).toHaveBeenCalledOnce();
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('unsubscribe stops future notifications', () => {
    const sessionId = 'session-D';
    const listener = vi.fn();
    const unsub = agentTurnRegistry.onTurnStartedForSession(sessionId, listener);

    unsub();

    const turnId = nextTurnId();
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    expect(listener).not.toHaveBeenCalled();
  });

  it('supports multiple listeners per session and isolates throwing listeners', () => {
    const sessionId = 'session-E';
    const listener1 = vi.fn(() => {
      throw new Error('listener1 boom');
    });
    const listener2 = vi.fn();
    trackedSessionStartUnsubs.push(
      agentTurnRegistry.onTurnStartedForSession(sessionId, listener1),
    );
    trackedSessionStartUnsubs.push(
      agentTurnRegistry.onTurnStartedForSession(sessionId, listener2),
    );

    const turnId = nextTurnId();
    expect(() => agentTurnRegistry.setRendererSession(turnId, sessionId)).not.toThrow();

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });

  it('persists across turn cleanup (session-scoped, not turn-scoped)', () => {
    const sessionId = 'session-F';
    const listener = vi.fn();
    trackedSessionStartUnsubs.push(
      agentTurnRegistry.onTurnStartedForSession(sessionId, listener),
    );

    const t1 = nextTurnId();
    agentTurnRegistry.setRendererSession(t1, sessionId);
    agentTurnRegistry.cleanupTurn(t1);

    // Session listener should still be active for a subsequent turn
    const t2 = nextTurnId();
    agentTurnRegistry.setRendererSession(t2, sessionId);

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
