import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  appendRendererLocalTerminalEvent,
  appendRendererOptimisticTurnStartedEvent,
  clearCurrentSessionEvents,
  createSessionStore,
  getCurrentSessionEventsForTurn,
  isRendererLocalTerminalEvent,
  isRendererOptimisticTurnStartedEvent,
  persistTurnEventUnionForSession,
  stripRuntime,
} from '../sessionStore';
import { stripRuntimeFromSessions } from '../reducers/historyReducer';
import {
  assertNoStuckBusy,
  violatesNoStuckBusy,
} from '../../../../../shared/utils/assertNoStuckBusy';

const SYNTHETIC_TS = 1_717_171_717_171;
const SYNTHETIC_TERMINAL_TS = 1_717_171_717_272;

const turnStartedEvent = (timestamp: number): AgentEvent => ({
  type: 'turn_started',
  timestamp,
});

const resultEvent = (text: string, timestamp: number): AgentEvent => ({
  type: 'result',
  text,
  timestamp,
});

const flushMicrotasks = async (ticks = 4): Promise<void> => {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
};

const allTurnEvents = (eventsByTurn: Record<string, AgentEvent[]> | undefined): AgentEvent[] =>
  Object.values(eventsByTurn ?? {}).flat();

const expectNoOptimisticEvents = (eventsByTurn: Record<string, AgentEvent[]> | undefined): void => {
  expect(
    allTurnEvents(eventsByTurn).some(
      (event) => isRendererOptimisticTurnStartedEvent(event) || isRendererLocalTerminalEvent(event),
    ),
  ).toBe(false);
};

const expectNoSyntheticTimestampStart = (
  eventsByTurn: Record<string, AgentEvent[]> | undefined,
  timestamp: number = SYNTHETIC_TS,
): void => {
  expect(
    allTurnEvents(eventsByTurn).some(
      (event) => event.type === 'turn_started' && event.timestamp === timestamp,
    ),
  ).toBe(false);
};

const expectNoSyntheticTimestampTerminal = (
  eventsByTurn: Record<string, AgentEvent[]> | undefined,
  timestamp: number = SYNTHETIC_TERMINAL_TS,
): void => {
  expect(
    allTurnEvents(eventsByTurn).some(
      (event) => event.type === 'result' && event.timestamp === timestamp,
    ),
  ).toBe(false);
};

const captureSyntheticOptimisticEvent = (turnId: string): AgentEvent => {
  appendRendererOptimisticTurnStartedEvent(turnId, SYNTHETIC_TS);
  const event = getCurrentSessionEventsForTurn(turnId)[0];
  expect(event).toBeDefined();
  expect(isRendererOptimisticTurnStartedEvent(event!)).toBe(true);
  clearCurrentSessionEvents();
  return event!;
};

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

beforeEach(() => {
  clearCurrentSessionEvents();
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      applyTurnEventUnion: vi.fn().mockResolvedValue({ success: true }),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe('sessionStore persisted busy-state invariant', () => {
  it('strips renderer-only optimistic events from snapshot and stripRuntime egress', () => {
    const store = createSessionStore();
    const optimisticTurnId = 'optimistic-egress-turn';

    appendRendererOptimisticTurnStartedEvent(optimisticTurnId, SYNTHETIC_TS);
    store.setState({ activeTurnId: optimisticTurnId, isBusy: true });

    expect(
      getCurrentSessionEventsForTurn(optimisticTurnId).some(isRendererOptimisticTurnStartedEvent),
    ).toBe(true);

    const snapshot = store.getState().snapshotCurrentSession();
    expect(snapshot).not.toBeNull();
    expect(
      (snapshot?.eventsByTurn?.[optimisticTurnId] ?? []).some(isRendererOptimisticTurnStartedEvent),
    ).toBe(false);
    expectNoSyntheticTimestampStart(snapshot?.eventsByTurn);

    const persisted = stripRuntime(snapshot!);
    expect(
      (persisted.eventsByTurn?.[optimisticTurnId] ?? []).some(isRendererOptimisticTurnStartedEvent),
    ).toBe(false);
    expectNoSyntheticTimestampStart(persisted.eventsByTurn);
  });

  it('strips renderer-local terminal markers from snapshot + stripRuntime + stripRuntimeFromSessions egress', () => {
    const store = createSessionStore();
    const terminalTurnId = 'renderer-local-terminal-egress-turn';

    startVanillaUserTurn(store, 'Trigger renderer-local terminal', terminalTurnId, SYNTHETIC_TS - 100);
    appendRendererLocalTerminalEvent(
      terminalTurnId,
      SYNTHETIC_TERMINAL_TS,
      'Synthetic terminal for adversarial egress test',
    );

    expect(
      getCurrentSessionEventsForTurn(terminalTurnId).some(isRendererLocalTerminalEvent),
    ).toBe(true);

    const snapshot = store.getState().snapshotCurrentSession();
    expect(snapshot).not.toBeNull();
    expect(
      (snapshot?.eventsByTurn?.[terminalTurnId] ?? []).some(isRendererLocalTerminalEvent),
    ).toBe(false);
    expectNoSyntheticTimestampTerminal(snapshot?.eventsByTurn, SYNTHETIC_TERMINAL_TS);

    const persisted = stripRuntime(snapshot!);
    expect(
      (persisted.eventsByTurn?.[terminalTurnId] ?? []).some(isRendererLocalTerminalEvent),
    ).toBe(false);
    expectNoSyntheticTimestampTerminal(persisted.eventsByTurn, SYNTHETIC_TERMINAL_TS);

    const persistedBatch = stripRuntimeFromSessions([snapshot!]);
    expect(persistedBatch).toHaveLength(1);
    expect(
      (persistedBatch[0]?.eventsByTurn?.[terminalTurnId] ?? []).some(isRendererLocalTerminalEvent),
    ).toBe(false);
    expectNoSyntheticTimestampTerminal(
      persistedBatch[0]?.eventsByTurn,
      SYNTHETIC_TERMINAL_TS,
    );
  });

  it('strips renderer-only optimistic events before applyTurnEventUnion IPC', () => {
    const optimisticTurnId = 'optimistic-persist-turn';
    appendRendererOptimisticTurnStartedEvent(optimisticTurnId, SYNTHETIC_TS);
    const optimisticEvent = getCurrentSessionEventsForTurn(optimisticTurnId)[0];
    expect(optimisticEvent).toBeDefined();

    const statusEvent: AgentEvent = {
      type: 'status',
      message: 'server status',
      timestamp: Date.now(),
    };

    persistTurnEventUnionForSession('session-egress', 'real-turn', [
      optimisticEvent!,
      statusEvent,
    ]);

    const applyTurnEventUnionMock = vi.mocked(window.sessionsApi.applyTurnEventUnion);
    expect(applyTurnEventUnionMock).toHaveBeenCalledTimes(1);
    expect(applyTurnEventUnionMock).toHaveBeenCalledWith({
      sessionId: 'session-egress',
      turnId: 'real-turn',
      events: [statusEvent],
    });
    const sentEvents = applyTurnEventUnionMock.mock.calls[0]?.[0]?.events ?? [];
    expect(
      sentEvents.some((event) => isRendererOptimisticTurnStartedEvent(event as AgentEvent)),
    ).toBe(false);
    expectNoSyntheticTimestampStart({ realTurn: sentEvents as AgentEvent[] }, SYNTHETIC_TS);

    persistTurnEventUnionForSession('session-egress', 'real-turn', [optimisticEvent!]);
    expect(applyTurnEventUnionMock).toHaveBeenCalledTimes(1);
  });

  it('keeps renderer synthetic brand non-enumerable across JSON round-trip', () => {
    const optimisticTurnId = 'optimistic-json-roundtrip';
    appendRendererOptimisticTurnStartedEvent(optimisticTurnId, SYNTHETIC_TS);
    const optimistic = getCurrentSessionEventsForTurn(optimisticTurnId)[0];
    expect(optimistic).toBeDefined();
    expect(isRendererOptimisticTurnStartedEvent(optimistic!)).toBe(true);

    const symbolKeys = Object.getOwnPropertySymbols(optimistic!);
    expect(symbolKeys.length).toBeGreaterThan(0);
    for (const symbolKey of symbolKeys) {
      expect(Object.prototype.propertyIsEnumerable.call(optimistic, symbolKey)).toBe(false);
    }

    const roundTripped = JSON.parse(JSON.stringify(optimistic)) as AgentEvent;
    expect(roundTripped).toMatchObject({ type: 'turn_started', timestamp: SYNTHETIC_TS });
    expect(Object.getOwnPropertySymbols(roundTripped)).toHaveLength(0);
    expect(isRendererOptimisticTurnStartedEvent(roundTripped)).toBe(false);
  });

  it('strips synthetic events from upsert payload before cloud-facing persistence', async () => {
    const store = createSessionStore();
    const optimisticTurnId = 'optimistic-upsert-turn';
    const terminalTurnId = 'terminal-upsert-turn';
    const upsertMock = vi.mocked(window.sessionsApi.upsert);
    upsertMock.mockClear();

    appendRendererOptimisticTurnStartedEvent(optimisticTurnId, SYNTHETIC_TS);
    appendRendererLocalTerminalEvent(
      terminalTurnId,
      SYNTHETIC_TERMINAL_TS,
      'Renderer-only terminal marker in upsert path',
    );
    store.setState({ activeTurnId: optimisticTurnId, isBusy: true });
    store.getState().togglePinSession(store.getState().currentSessionId);
    await flushMicrotasks();

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const payload = upsertMock.mock.calls[0]?.[0] as {
      eventsByTurn?: Record<string, AgentEvent[]>;
    };
    expect(payload).toBeDefined();
    expectNoOptimisticEvents(payload.eventsByTurn);
    expectNoSyntheticTimestampStart(payload.eventsByTurn);
    expectNoSyntheticTimestampTerminal(payload.eventsByTurn);

    const serialized = JSON.parse(JSON.stringify(payload)) as {
      eventsByTurn?: Record<string, AgentEvent[]>;
    };
    expectNoSyntheticTimestampStart(serialized.eventsByTurn);
    expectNoSyntheticTimestampTerminal(serialized.eventsByTurn);
  });

  it('strips renderer-local terminal markers from union egress', () => {
    const terminalTurnId = 'renderer-local-terminal-turn';
    appendRendererLocalTerminalEvent(
      terminalTurnId,
      SYNTHETIC_TERMINAL_TS,
      'Renderer stop terminal',
    );
    const syntheticTerminal = getCurrentSessionEventsForTurn(terminalTurnId)[0];
    expect(syntheticTerminal).toBeDefined();
    expect(isRendererLocalTerminalEvent(syntheticTerminal!)).toBe(true);

    const applyTurnEventUnionMock = vi.mocked(window.sessionsApi.applyTurnEventUnion);
    applyTurnEventUnionMock.mockClear();
    persistTurnEventUnionForSession('session-egress', 'real-turn', [syntheticTerminal!]);
    expect(applyTurnEventUnionMock).toHaveBeenCalledTimes(0);
  });

  it('keeps truncateToMessage egress free of synthetic optimistic starts', async () => {
    const store = createSessionStore();
    const truncateTurnId = 'truncate-leak-turn';
    const upsertMock = vi.mocked(window.sessionsApi.upsert);
    upsertMock.mockClear();

    store.getState().addUserMessage('Original prompt');
    const messageId = store.getState().messages.at(-1)?.id;
    expect(messageId).toBeTruthy();
    store.getState().assignTurnToMessage(messageId!, truncateTurnId, SYNTHETIC_TS - 10);
    appendRendererOptimisticTurnStartedEvent(truncateTurnId, SYNTHETIC_TS);
    expect(
      getCurrentSessionEventsForTurn(truncateTurnId).some(isRendererOptimisticTurnStartedEvent),
    ).toBe(true);

    store.getState().truncateToMessage(messageId!, 'Rewritten prompt');
    const snapshot = store.getState().snapshotCurrentSession();
    expect(snapshot).not.toBeNull();
    expectNoOptimisticEvents(snapshot?.eventsByTurn);
    expectNoSyntheticTimestampStart(snapshot?.eventsByTurn);

    store.getState().togglePinSession(store.getState().currentSessionId);
    await flushMicrotasks();
    const payload = upsertMock.mock.calls.at(-1)?.[0] as {
      eventsByTurn?: Record<string, AgentEvent[]>;
    };
    expect(payload).toBeDefined();
    expectNoOptimisticEvents(payload.eventsByTurn);
    expectNoSyntheticTimestampStart(payload.eventsByTurn);
  });

  it('strips synthetic events from background pre-compaction upsert', async () => {
    const store = createSessionStore();
    const backgroundSessionId = 'bg-compaction-optimistic';
    const upsertMock = vi.mocked(window.sessionsApi.upsert);
    upsertMock.mockClear();

    store.getState().createBackgroundSession(backgroundSessionId, 'manual');
    const baseSession = store.getState().loadedSessions.get(backgroundSessionId);
    expect(baseSession).toBeDefined();

    const syntheticEvent = captureSyntheticOptimisticEvent('compaction-capture-source');
    const nextLoadedSessions = new Map(store.getState().loadedSessions);
    nextLoadedSessions.set(backgroundSessionId, {
      ...baseSession!,
      activeTurnId: 'bg-compaction-turn',
      isBusy: true,
      eventsByTurn: {
        'bg-compaction-turn': [syntheticEvent],
      },
    });
    store.setState({ loadedSessions: nextLoadedSessions });

    upsertMock.mockClear();
    store.getState().performCompaction('compact-summary', 1, backgroundSessionId);
    await flushMicrotasks();

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const payload = upsertMock.mock.calls[0]?.[0] as {
      eventsByTurn?: Record<string, AgentEvent[]>;
    };
    expectNoOptimisticEvents(payload.eventsByTurn);
    expectNoSyntheticTimestampStart(payload.eventsByTurn);
  });

  it('strips synthetic events when persisting LRU-cached sessions under eviction pressure', async () => {
    const store = createSessionStore();
    const protectedSessionId = 'cache-protected-session';
    const upsertMock = vi.mocked(window.sessionsApi.upsert);
    upsertMock.mockClear();

    store.getState().createBackgroundSession(protectedSessionId, 'manual');
    const baseSession = store.getState().loadedSessions.get(protectedSessionId);
    expect(baseSession).toBeDefined();

    const syntheticEvent = captureSyntheticOptimisticEvent('cache-capture-source');
    store.getState().cacheSession({
      ...baseSession!,
      activeTurnId: 'cache-protected-turn',
      isBusy: true,
      eventsByTurn: {
        'cache-protected-turn': [syntheticEvent],
      },
    });

    for (let i = 0; i < 48; i += 1) {
      store.getState().createBackgroundSession(`cache-eviction-${i}`, 'manual');
    }
    expect(store.getState().loadedSessions.has(protectedSessionId)).toBe(true);

    upsertMock.mockClear();
    store.getState().persistLoadedSession(protectedSessionId);
    await flushMicrotasks();

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const payload = upsertMock.mock.calls[0]?.[0] as {
      eventsByTurn?: Record<string, AgentEvent[]>;
    };
    expectNoOptimisticEvents(payload.eventsByTurn);
    expectNoSyntheticTimestampStart(payload.eventsByTurn);
  });

  it('strips synthetic events from background-buffer union persistence flushes', async () => {
    const store = createSessionStore();
    const backgroundSessionId = 'bg-buffer-persist';
    const backgroundTurnId = 'bg-buffer-turn';
    const applyUnionMock = vi.mocked(window.sessionsApi.applyTurnEventUnion);
    applyUnionMock.mockClear();

    store.getState().createBackgroundSession(backgroundSessionId, 'manual');

    const syntheticEvent = captureSyntheticOptimisticEvent('buffer-capture-source');
    store.getState().processHistoryEvent(
      backgroundSessionId,
      backgroundTurnId,
      syntheticEvent,
      backgroundSessionId,
    );
    expect(applyUnionMock).toHaveBeenCalledTimes(0);

    const terminal = resultEvent('background done', SYNTHETIC_TS + 1);
    store.getState().processHistoryEvent(
      backgroundSessionId,
      backgroundTurnId,
      terminal,
      backgroundSessionId,
    );
    await flushMicrotasks(8);

    expect(applyUnionMock).toHaveBeenCalledTimes(1);
    const payload = applyUnionMock.mock.calls[0]?.[0];
    expect(payload?.sessionId).toBe(backgroundSessionId);
    expect(payload?.turnId).toBe(backgroundTurnId);
    expectNoOptimisticEvents({ [backgroundTurnId]: (payload?.events ?? []) as AgentEvent[] });
    expectNoSyntheticTimestampStart({ [backgroundTurnId]: (payload?.events ?? []) as AgentEvent[] });
    expect(payload?.events).toEqual([terminal]);
  });

  it('validates representative persisted snapshots for the busy-turn contract', () => {
    const validBusyWithLiveActiveTurn = {
      isBusy: true,
      activeTurnId: 'turn-1',
      eventsByTurn: {
        'turn-1': [turnStartedEvent(1000)],
      },
    };

    const validIdleSnapshot = {
      isBusy: false,
      activeTurnId: null,
      eventsByTurn: {},
    };

    const validLegacyGarbageWhenIdle = {
      isBusy: false,
      activeTurnId: 'turn-1',
      eventsByTurn: {
        'turn-1': [turnStartedEvent(1000), resultEvent('done', 1010)],
      },
    };

    const invalidBusyWithoutActiveTurn = {
      isBusy: true,
      activeTurnId: null,
      eventsByTurn: {},
    };

    const invalidBusyWithTerminalActiveTurn = {
      isBusy: true,
      activeTurnId: 'turn-1',
      eventsByTurn: {
        'turn-1': [turnStartedEvent(1000), resultEvent('done', 1010)],
      },
    };

    expect(violatesNoStuckBusy(validBusyWithLiveActiveTurn)).toBe(false);
    expect(violatesNoStuckBusy(validIdleSnapshot)).toBe(false);
    expect(violatesNoStuckBusy(validLegacyGarbageWhenIdle)).toBe(false);
    expect(violatesNoStuckBusy(invalidBusyWithoutActiveTurn)).toBe(true);
    expect(violatesNoStuckBusy(invalidBusyWithTerminalActiveTurn)).toBe(true);

    assertNoStuckBusy(validBusyWithLiveActiveTurn);
    assertNoStuckBusy(validIdleSnapshot);
    assertNoStuckBusy(validLegacyGarbageWhenIdle);
  });

  it('persisted isBusy implies live processing turn', () => {
    const store = createSessionStore();
    const turnAId = 'turn-a';
    const turnBId = 'turn-b';

    startVanillaUserTurn(store, 'First question', turnAId, 2000);
    finishTurnWithResult(store, turnAId, 'First answer', 2020);

    startVanillaUserTurn(store, 'Follow-up question', turnBId, 2100);

    // Focus diverges while turn B is actively processing.
    focusTurnViaProducer(store, turnAId);
    finishTurnWithResult(store, turnBId, 'Follow-up answer', 2120);

    const snapshot = store.getState().snapshotCurrentSession();
    expect(snapshot).not.toBeNull();
    const persisted = stripRuntime(snapshot!);

    assertNoStuckBusy(persisted);
    expect(persisted.isBusy).toBe(false);
    expect(persisted.activeTurnId).toBeNull();
  });
});
