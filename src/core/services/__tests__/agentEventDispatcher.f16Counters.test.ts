/**
 * F16 dispatcher counter tests — Stage 2 close (260508 plan).
 *
 * Validates the per-event-type runtime regression guard that complements
 * the compile-time type-wall:
 *   * Counters increment only when enabled (REBEL_PERF_MODE=1 or test-only
 *     toggle); production hot path is zero-overhead by default.
 *   * `eventsDispatchedTotal` increments on every dispatch past `stampSeq`.
 *   * `eventsWithActiveSubscriberTotal` increments when ≥1 observable
 *     consumer existed at dispatch time (alive window OR CLI listener OR
 *     non-empty cloud-SSE/mobile-WS subscriber set).
 *   * `getDeadEventTypes()` excludes the R2-8 exemption set
 *     (`RENDERER_ONLY_LIFECYCLE_EVENTS` ∪ `KNOWN_NO_RENDERER_SUBSCRIBER`)
 *     so intentionally-asymmetric paths don't false-positive.
 *   * `assistant_delta` doesn't count window-presence as a subscriber (its
 *     contract is "no renderer consumer post-Stage-2"), but listener +
 *     subscriber paths still register.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLogger,
  mockTracker,
  getTurnCheckpointManagerMock,
} = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  mockTracker: {
    track: vi.fn(),
    identify: vi.fn(),
    getAnonymousId: vi.fn(() => 'anon-test-id'),
    isAvailable: vi.fn(() => true),
  },
  getTurnCheckpointManagerMock: vi.fn(() => null),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

 
vi.mock('@core/tracking', () => ({
  getTracker: () => mockTracker,
}));

 
vi.mock('@core/services/turnCheckpointService', () => ({
  getTurnCheckpointManager: getTurnCheckpointManagerMock,
}));

import type { AgentEvent } from '@shared/types';
import {
  dispatchAgentEvent,
  getDispatcherCounters,
  resetDispatcherCounters,
  setDispatcherCountersEnabledForTests,
  getDeadEventTypes,
  startF16PeriodicLogger,
  stopF16PeriodicLogger,
  KNOWN_NO_RENDERER_SUBSCRIBER,
  RENDERER_ONLY_LIFECYCLE_EVENTS,
} from '../agentEventDispatcher';
import { agentTurnRegistry } from '../agentTurnRegistry';
import { resetSessionSeqIndexForTests } from '../sessionSeqIndex';

const trackedTurnIds = new Set<string>();
let turnCounter = 0;

function nextTurnId(): string {
  turnCounter += 1;
  const turnId = `f16-counter-test-${turnCounter}`;
  trackedTurnIds.add(turnId);
  return turnId;
}

function createWindow() {
  const send = vi.fn();
  return {
    send,
    win: {
      id: 1,
      isDestroyed: () => false,
      webContents: {
        send,
        isDestroyed: () => false,
      },
    },
  };
}

function createDestroyedWindow() {
  const send = vi.fn();
  return {
    send,
    win: {
      id: 1,
      isDestroyed: () => true,
      webContents: {
        send,
        isDestroyed: () => true,
      },
    },
  };
}

const statusEvent: Extract<AgentEvent, { type: 'status' }> = {
  type: 'status',
  message: 'starting',
  timestamp: 1_000,
};

const assistantDeltaEvent: Extract<AgentEvent, { type: 'assistant_delta' }> = {
  type: 'assistant_delta',
  text: 'hi',
  timestamp: 2_000,
};

const thinkingDeltaEvent: Extract<AgentEvent, { type: 'thinking_delta' }> = {
  type: 'thinking_delta',
  text: 'thinking',
  timestamp: 3_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  getTurnCheckpointManagerMock.mockReturnValue(null);
  resetSessionSeqIndexForTests();
  resetDispatcherCounters();
  setDispatcherCountersEnabledForTests(true);
});

afterEach(() => {
  for (const turnId of trackedTurnIds) {
    agentTurnRegistry.cleanupTurn(turnId);
  }
  trackedTurnIds.clear();
  resetDispatcherCounters();
  setDispatcherCountersEnabledForTests(false);
  resetSessionSeqIndexForTests();
});

describe('F16 dispatcher counter — counters disabled by default', () => {
  it('does not increment when dispatcherCountersEnabled is false', () => {
    setDispatcherCountersEnabledForTests(false);
    const turnId = nextTurnId();
    const { win } = createWindow();
    dispatchAgentEvent(win, turnId, statusEvent);
    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal).toEqual({});
    expect(counters.eventsWithActiveSubscriberTotal).toEqual({});
  });
});

describe('F16 dispatcher counter — generic event path', () => {
  it('counts dispatched + with-subscriber when window is alive', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();
    dispatchAgentEvent(win, turnId, statusEvent);
    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal.status).toBe(1);
    expect(counters.eventsWithActiveSubscriberTotal.status).toBe(1);
  });

  it('counts dispatched but NOT with-subscriber when window is destroyed and no listener/subscriber exists', () => {
    const turnId = nextTurnId();
    const { win } = createDestroyedWindow();
    dispatchAgentEvent(win, turnId, statusEvent);
    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal.status).toBe(1);
    expect(counters.eventsWithActiveSubscriberTotal.status).toBeUndefined();
  });

  it('counts dispatched but NOT with-subscriber when win is null and no listener/subscriber exists', () => {
    const turnId = nextTurnId();
    dispatchAgentEvent(null, turnId, statusEvent);
    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal.status).toBe(1);
    expect(counters.eventsWithActiveSubscriberTotal.status).toBeUndefined();
  });

  it('counts with-subscriber when only a CLI listener is set (null window)', () => {
    const turnId = nextTurnId();
    agentTurnRegistry.setEventListener(turnId, vi.fn());
    dispatchAgentEvent(null, turnId, statusEvent);
    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal.status).toBe(1);
    expect(counters.eventsWithActiveSubscriberTotal.status).toBe(1);
  });

  it('counts with-subscriber when only a cloud subscriber is set (null window)', () => {
    const turnId = nextTurnId();
    agentTurnRegistry.subscribeTurnEvents(turnId, vi.fn());
    dispatchAgentEvent(null, turnId, statusEvent);
    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal.status).toBe(1);
    expect(counters.eventsWithActiveSubscriberTotal.status).toBe(1);
  });
});

describe('F16 dispatcher counter — assistant_delta path', () => {
  it('does NOT count window presence as a subscriber for assistant_delta (Stage 2 contract)', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();
    dispatchAgentEvent(win, turnId, assistantDeltaEvent);
    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal.assistant_delta).toBe(1);
    // assistant_delta has no renderer consumer by design — window-alive must NOT
    // count as "had subscriber" (the R2-8 exemption set excludes it from
    // dead-channel detection regardless, but the counter should still reflect
    // reality for observability).
    expect(counters.eventsWithActiveSubscriberTotal.assistant_delta).toBeUndefined();
  });

  it('counts with-subscriber when a CLI listener consumes assistant_delta (TTFT path)', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();
    agentTurnRegistry.setEventListener(turnId, vi.fn());
    dispatchAgentEvent(win, turnId, assistantDeltaEvent);
    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal.assistant_delta).toBe(1);
    expect(counters.eventsWithActiveSubscriberTotal.assistant_delta).toBe(1);
  });

  it('counts with-subscriber when a cloud subscriber consumes assistant_delta', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();
    agentTurnRegistry.subscribeTurnEvents(turnId, vi.fn());
    dispatchAgentEvent(win, turnId, assistantDeltaEvent);
    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal.assistant_delta).toBe(1);
    expect(counters.eventsWithActiveSubscriberTotal.assistant_delta).toBe(1);
  });
});

describe('F16 dispatcher counter — getDeadEventTypes()', () => {
  it('excludes RENDERER_ONLY_LIFECYCLE_EVENTS from dead-channel detection', () => {
    expect(RENDERER_ONLY_LIFECYCLE_EVENTS).toContain('answer_phase_started');
    // answer_phase_started never reaches dispatchAgentEventInternal directly
    // (it routes through dispatchRendererOnlyAgentEvent which intentionally
    // bypasses counters). This is the per-design contract — no counter rows
    // appear for it, and getDeadEventTypes() never flags it.
    const dead = getDeadEventTypes();
    expect(dead).not.toContain('answer_phase_started');
  });

  it('excludes KNOWN_NO_RENDERER_SUBSCRIBER from dead-channel detection even when no consumer fires', () => {
    expect(KNOWN_NO_RENDERER_SUBSCRIBER).toContain('assistant_delta');
    expect(KNOWN_NO_RENDERER_SUBSCRIBER).toContain('thinking_delta');

    const turnId = nextTurnId();
    // Use null win + no listener + no subscriber — fully orphan dispatch.
    dispatchAgentEvent(null, turnId, assistantDeltaEvent);
    dispatchAgentEvent(null, turnId, thinkingDeltaEvent);

    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal.assistant_delta).toBe(1);
    expect(counters.eventsDispatchedTotal.thinking_delta).toBe(1);
    expect(counters.eventsWithActiveSubscriberTotal.assistant_delta).toBeUndefined();
    expect(counters.eventsWithActiveSubscriberTotal.thinking_delta).toBeUndefined();

    const dead = getDeadEventTypes();
    expect(dead).not.toContain('assistant_delta');
    expect(dead).not.toContain('thinking_delta');
  });

  it('flags non-exempt event types dispatched without any consumer', () => {
    const turnId = nextTurnId();
    // Fully orphan status dispatch — null win, no listener, no subscriber.
    dispatchAgentEvent(null, turnId, statusEvent);

    const dead = getDeadEventTypes();
    expect(dead).toContain('status');
  });

  it('does NOT flag non-exempt event types when at least one dispatch had a consumer', () => {
    const turnId = nextTurnId();
    // First dispatch: orphan.
    dispatchAgentEvent(null, turnId, statusEvent);
    // Second dispatch: has a listener.
    agentTurnRegistry.setEventListener(turnId, vi.fn());
    dispatchAgentEvent(null, turnId, statusEvent);

    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal.status).toBe(2);
    expect(counters.eventsWithActiveSubscriberTotal.status).toBe(1);

    // status had >=1 subscriber across the window — not dead.
    const dead = getDeadEventTypes();
    expect(dead).not.toContain('status');
  });

  it('reset clears all counter state', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();
    dispatchAgentEvent(win, turnId, statusEvent);
    expect(getDispatcherCounters().eventsDispatchedTotal.status).toBe(1);

    resetDispatcherCounters();
    expect(getDispatcherCounters().eventsDispatchedTotal).toEqual({});
    expect(getDispatcherCounters().eventsWithActiveSubscriberTotal).toEqual({});
    expect(getDeadEventTypes()).toEqual([]);
  });
});

describe('F16 periodic logger — closes the plan\'s ">1 min sustained" warning contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopF16PeriodicLogger();
    vi.useRealTimers();
  });

  it('emits no warn when no events are dispatched (clean run)', () => {
    startF16PeriodicLogger(60_000);
    vi.advanceTimersByTime(120_000);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('emits info on a single-tick dead event without escalating to warn', () => {
    startF16PeriodicLogger(60_000);
    const turnId = nextTurnId();
    dispatchAgentEvent(null, turnId, statusEvent);

    vi.advanceTimersByTime(60_000);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        deadEventTypes: ['status'],
        regressionGuard: 'F16',
      }),
      expect.stringContaining('single-tick observation'),
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('escalates to warn when the same dead event persists across two ticks (≥1 min)', () => {
    startF16PeriodicLogger(60_000);
    const turnId = nextTurnId();
    dispatchAgentEvent(null, turnId, statusEvent);

    vi.advanceTimersByTime(60_000);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();

    // Re-dispatch in the second window so the dead-event set persists.
    dispatchAgentEvent(null, turnId, statusEvent);
    vi.advanceTimersByTime(60_000);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sustainedDeadEventTypes: ['status'],
        regressionGuard: 'F16',
      }),
      expect.stringContaining('regression candidate'),
    );
  });

  it('clears the sustained set when dead events drop to zero', () => {
    startF16PeriodicLogger(60_000);
    const turnId = nextTurnId();
    dispatchAgentEvent(null, turnId, statusEvent);
    vi.advanceTimersByTime(60_000);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);

    // Reset counters → next tick sees no dead events → previous set clears.
    resetDispatcherCounters();
    vi.advanceTimersByTime(60_000);

    // A new dead event in tick 3 should be info-only (single-tick),
    // because tick 2 cleared the previous sustained set.
    const turnId2 = nextTurnId();
    dispatchAgentEvent(null, turnId2, statusEvent);
    vi.advanceTimersByTime(60_000);
    expect(mockLogger.info).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('resetDispatcherCounters clears sustained-set tracking — fresh dead events register as single-tick (not sustained)', () => {
    startF16PeriodicLogger(60_000);
    const turnId = nextTurnId();
    dispatchAgentEvent(null, turnId, statusEvent);
    vi.advanceTimersByTime(60_000);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();

    resetDispatcherCounters();
    const turnId2 = nextTurnId();
    dispatchAgentEvent(null, turnId2, statusEvent);
    vi.advanceTimersByTime(60_000);

    expect(mockLogger.info).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('startF16PeriodicLogger is idempotent (no double-start)', () => {
    startF16PeriodicLogger(60_000);
    startF16PeriodicLogger(60_000);
    const turnId = nextTurnId();
    dispatchAgentEvent(null, turnId, statusEvent);
    vi.advanceTimersByTime(60_000);
    // Only one interval scheduled — info called exactly once per tick.
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
  });

  it('stopF16PeriodicLogger halts subsequent ticks and resets sustained-set tracking', () => {
    startF16PeriodicLogger(60_000);
    const turnId = nextTurnId();
    dispatchAgentEvent(null, turnId, statusEvent);
    vi.advanceTimersByTime(60_000);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);

    stopF16PeriodicLogger();
    vi.advanceTimersByTime(120_000);
    // No additional ticks fired.
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe('F16 exemption-set invariants (R2-8)', () => {
  it('RENDERER_ONLY_LIFECYCLE_EVENTS and KNOWN_NO_RENDERER_SUBSCRIBER are disjoint', () => {
    const rendererOnly = new Set<string>(RENDERER_ONLY_LIFECYCLE_EVENTS);
    const noSub = new Set<string>(KNOWN_NO_RENDERER_SUBSCRIBER);
    for (const t of rendererOnly) {
      expect(noSub.has(t)).toBe(false);
    }
    for (const t of noSub) {
      expect(rendererOnly.has(t)).toBe(false);
    }
  });

  it('exemption arrays are non-empty (the type-wall + counter pair both rely on these)', () => {
    expect(RENDERER_ONLY_LIFECYCLE_EVENTS.length).toBeGreaterThan(0);
    expect(KNOWN_NO_RENDERER_SUBSCRIBER.length).toBeGreaterThan(0);
  });
});
