import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentEvent, AgentSession } from '@shared/types';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { dispatchAgentEvent } from '@core/services/agentEventDispatcher';
import type { CloudServiceDeps } from '../bootstrap';
import type { PushNotificationOptions } from '../services/pushNotificationService';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';
import {
  getSessionTombstoneStore,
  resetSessionTombstoneStoreForTests,
} from '@core/services/continuity/sessionTombstoneStore';

const mockMarkSessionAsCloudActive = vi.fn<(sessionId: string) => Promise<void>>(async () => {});
const mockSendPushNotification = vi.fn<(options: PushNotificationOptions) => Promise<void>>(async () => {});

vi.mock('@core/services/cloudContinuityStateService', () => ({
  markSessionAsCloudActive: (sessionId: string) => mockMarkSessionAsCloudActive(sessionId),
}));

vi.mock('../services/pushNotificationService', () => ({
  sendPushNotification: (options: PushNotificationOptions) => mockSendPushNotification(options),
}));

vi.mock('@core/services/conversationTitleService', () => ({
  maybeGenerateSessionTitle: vi.fn(async () => null),
  isDefaultOrFallbackTitle: vi.fn(() => false),
  processAutoTitle: vi.fn(async () => null),
  resolveAutoTitleMetadata: vi.fn(
    (
      winning: { title?: string; autoTitleGeneratedAt?: number; autoTitleTurnCount?: number },
      losing: { title?: string; autoTitleGeneratedAt?: number; autoTitleTurnCount?: number },
    ) =>
      winning.autoTitleGeneratedAt == null &&
      losing.autoTitleGeneratedAt != null &&
      winning.title === losing.title
        ? { autoTitleGeneratedAt: losing.autoTitleGeneratedAt, autoTitleTurnCount: losing.autoTitleTurnCount }
        : { autoTitleGeneratedAt: winning.autoTitleGeneratedAt, autoTitleTurnCount: winning.autoTitleTurnCount },
  ),
}));

import { handleAgentTurnWs } from '../routes/agent';

class MockAgentWs {
  readyState: WebSocket['readyState'] = WebSocket.OPEN;
  sent: string[] = [];
  terminated = false;

  private onHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  private onceHandlers = new Map<string, (...args: unknown[]) => void>();

  on(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.onHandlers.get(event) ?? [];
    handlers.push(handler);
    this.onHandlers.set(event, handlers);
    return this;
  }

  once(event: string, handler: (...args: unknown[]) => void): this {
    this.onceHandlers.set(event, handler);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    const handlers = this.onHandlers.get('close') ?? [];
    for (const handler of handlers) handler();
  }

  ping(): void {}

  terminate(): void {
    this.terminated = true;
    this.close();
  }

  async emitMessage(payload: unknown): Promise<void> {
    const handler = this.onceHandlers.get('message');
    if (!handler) throw new Error('No message handler registered');
    this.onceHandlers.delete('message');
    await handler(Buffer.from(JSON.stringify(payload), 'utf-8'));
  }
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  const now = Date.now();
  return {
    id: 'session-1',
    title: 'Test Session',
    createdAt: now - 1_000,
    updatedAt: now,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    doneAt: null,
    origin: 'manual',
    ...overrides,
  };
}

function cloneSession(session: AgentSession): AgentSession {
  return {
    ...session,
    messages: session.messages.map((message) => ({ ...message })),
    eventsByTurn: Object.fromEntries(
      Object.entries(session.eventsByTurn).map(([turnKey, events]) => [
        turnKey,
        events.map((event) => ({ ...event })),
      ]),
    ),
  };
}

function createDeps(options: {
  getSession?: ReturnType<typeof vi.fn>;
  upsertSession?: ReturnType<typeof vi.fn>;
  startAgentTurn?: ReturnType<typeof vi.fn>;
  setEventListener?: ReturnType<typeof vi.fn>;
  subscribeTurnEvents?: ReturnType<typeof vi.fn>;
} = {}): {
  deps: CloudServiceDeps;
  getSession: ReturnType<typeof vi.fn>;
  upsertSession: ReturnType<typeof vi.fn>;
  getEventListener: () => ((event: AgentEvent) => Promise<void>) | null;
} {
  let eventListener: ((event: AgentEvent) => Promise<void>) | null = null;

  const getSession = options.getSession ?? vi.fn(async () => makeSession());
  const upsertSession = options.upsertSession ?? vi.fn<(session: AgentSession) => Promise<void>>(async () => {});
  const startAgentTurn = options.startAgentTurn ?? vi.fn(() => ({ turnId: 'turn-1' }));
  const setEventListener = options.setEventListener ?? vi.fn((_turnId: string, listener: (event: AgentEvent) => Promise<void>) => {
    eventListener = listener;
  });
  const subscribeTurnEvents = options.subscribeTurnEvents ?? vi.fn((_turnId: string, listener: (event: AgentEvent) => Promise<void>) => {
    eventListener = listener;
    return () => {
      if (eventListener === listener) eventListener = null;
    };
  });

  const deps = {
    startAgentTurn,
    getActiveTurnController: vi.fn(),
    getTurnCloseCallback: vi.fn(),
    setEventListener,
    subscribeTurnEvents,
    agentTurnServiceDeps: {},
    loadSessions: vi.fn(),
    listSessions: vi.fn(),
    getSession,
    upsertSession,
    deleteSession: vi.fn(),
    getSettings: vi.fn(() => ({})),
    updateSettings: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  } as unknown as CloudServiceDeps;

  return {
    deps,
    getSession,
    upsertSession,
    getEventListener: () => eventListener,
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function startTurn(options: {
  session?: AgentSession;
  getSession?: ReturnType<typeof vi.fn>;
  upsertSession?: ReturnType<typeof vi.fn>;
  startAgentTurn?: ReturnType<typeof vi.fn>;
  setEventListener?: ReturnType<typeof vi.fn>;
  subscribeTurnEvents?: ReturnType<typeof vi.fn>;
} = {}) {
  const session = options.session ?? makeSession();
  const getSession = options.getSession ?? vi.fn(async () => session);
  const { deps, upsertSession, getEventListener } = createDeps({
    getSession,
    upsertSession: options.upsertSession,
    startAgentTurn: options.startAgentTurn,
    setEventListener: options.setEventListener,
    subscribeTurnEvents: options.subscribeTurnEvents,
  });
  const ws = new MockAgentWs();

  handleAgentTurnWs(ws as unknown as WebSocket, deps);

  await ws.emitMessage({
    sessionId: session.id,
    prompt: 'Do work',
    resetConversation: false,
  });
  await flushAsyncWork();

  const listener = getEventListener();
  if (!listener) throw new Error('Expected event listener to be registered');

  return {
    ws,
    session,
    getSession,
    upsertSession,
    listener,
  };
}

const registryTurnIdsForCleanup = new Set<string>();

describe('handleAgentTurnWs continuity regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionSeqIndexForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const turnId of registryTurnIdsForCleanup) {
      agentTurnRegistry.cleanupTurn(turnId);
    }
    registryTurnIdsForCleanup.clear();
    cloudEventBroadcaster.closeAll();
    resetSessionTombstoneStoreForTests();
  });

  it('gates a turn to a tombstoned session: signals session_tombstoned and never persists', async () => {
    // A turn submitted to a server-deleted (tombstoned) session must NOT
    // silently create-and-persist a session: session reads/lists filter
    // tombstoned ids, so the turn would burn a model call and vanish from every
    // client (silent loss). The server must signal the client to recreate.
    const tombstonedId = 'tombstoned-session';
    getSessionTombstoneStore().addTombstone(tombstonedId, 'mobile');

    const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => {});
    const startAgentTurn = vi.fn(() => ({ turnId: 'turn-should-not-start' }));
    const { deps } = createDeps({
      getSession: vi.fn(async () => undefined),
      upsertSession,
      startAgentTurn,
    });
    const ws = new MockAgentWs();

    handleAgentTurnWs(ws as unknown as WebSocket, deps);
    await ws.emitMessage({
      sessionId: tombstonedId,
      prompt: 'Do work',
      clientTurnId: 'client-turn-tombstoned',
      resetConversation: false,
    });
    await flushAsyncWork();

    // The turn never ran, so nothing was persisted (no silent loss).
    expect(startAgentTurn).not.toHaveBeenCalled();
    expect(upsertSession).not.toHaveBeenCalled();

    // The client receives a distinct tombstone signal (not a generic error)
    // and the socket closes.
    const messages = ws.sent.map((raw) => JSON.parse(raw) as { type?: string; sessionId?: string });
    const tombstoneSignal = messages.find((message) => message.type === 'session_tombstoned');
    expect(tombstoneSignal).toBeDefined();
    expect(tombstoneSignal?.sessionId).toBe(tombstonedId);
    expect(messages.some((message) => message.type === 'turn_persisted')).toBe(false);
    expect(messages.some((message) => message.type === 'turn_started')).toBe(false);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('turn completes and session persists after WS client disconnects mid-turn', async () => {
    const { ws, listener, upsertSession } = await startTurn();

    await listener({
      type: 'assistant',
      text: 'Persisted assistant response',
      timestamp: Date.now(),
    });
    await flushAsyncWork();

    const sentCountBeforeClose = ws.sent.length;
    ws.close();

    await listener({
      type: 'result',
      text: 'Persisted assistant response',
      timestamp: Date.now() + 1,
    });
    await flushAsyncWork();

    expect(upsertSession).toHaveBeenCalledTimes(2);
    const finalSession = upsertSession.mock.calls[1]?.[0] as AgentSession;
    expect(finalSession.isBusy).toBe(false);
    expect(finalSession.activeTurnId).toBeNull();
    expect(finalSession.messages.some((message) =>
      message.role !== 'user' && message.text.includes('Persisted assistant response'))).toBe(true);
    expect(ws.sent).toHaveLength(sentCountBeforeClose);
  });

  it('pre-existing messages from earlier turns are preserved', async () => {
    const now = Date.now();
    const previousTurnId = 'previous-turn-1';
    const existingSession = makeSession({
      id: 'session-with-history',
      messages: [
        {
          id: 'existing-user',
          turnId: previousTurnId,
          role: 'user',
          text: 'Earlier user message',
          createdAt: now - 2_000,
        },
        {
          id: 'existing-result',
          turnId: previousTurnId,
          role: 'result',
          text: 'Earlier assistant response',
          createdAt: now - 1_900,
        },
      ],
      eventsByTurn: {
        [previousTurnId]: [{
          type: 'result',
          text: 'Earlier assistant response',
          timestamp: now - 1_900,
        }],
      },
    });
    const getSession = vi.fn(async () => cloneSession(existingSession));

    const { listener, upsertSession } = await startTurn({
      session: cloneSession(existingSession),
      getSession,
    });

    await listener({
      type: 'assistant',
      text: 'New turn response',
      timestamp: now + 1,
    });
    await listener({
      type: 'result',
      text: 'New turn response',
      timestamp: now + 2,
    });
    await flushAsyncWork();

    expect(upsertSession).toHaveBeenCalledTimes(2);
    const finalSession = upsertSession.mock.calls[1]?.[0] as AgentSession;

    expect(finalSession.messages.map((message) => message.id)).toEqual(
      expect.arrayContaining(['existing-user', 'existing-result']),
    );
    expect(finalSession.messages.some((message) => message.turnId === 'turn-1' && message.role === 'user')).toBe(true);
    expect(finalSession.messages.some((message) =>
      message.turnId === 'turn-1' && (message.role === 'assistant' || message.role === 'result'))).toBe(true);
    expect(Object.keys(finalSession.eventsByTurn)).toEqual(
      expect.arrayContaining([previousTurnId, 'turn-1']),
    );
  });

  it('overrides inherited updatedAt/cloudUpdatedAt with server-stamped values on persist', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-01-01T12:00:00.000Z').getTime();
    vi.setSystemTime(now);

    const existingSession = makeSession({
      updatedAt: 9_999_999_999_999,
      cloudUpdatedAt: 9_999_999_999_999,
    });

    const { upsertSession } = await startTurn({
      session: cloneSession(existingSession),
      getSession: vi.fn(async () => cloneSession(existingSession)),
    });

    expect(upsertSession).toHaveBeenCalled();
    const persistedBusySession = upsertSession.mock.calls[0]?.[0] as AgentSession;
    expect(persistedBusySession.updatedAt).toBe(now);
    expect((persistedBusySession.cloudUpdatedAt ?? 0)).toBeLessThan(9_999_999_999_999);
  });

  it('stamps server seq on streamed events and persists maxSeq', async () => {
    const { listener, upsertSession, ws } = await startTurn();

    await listener({
      type: 'status',
      message: 'Working',
      timestamp: Date.now(),
    });
    await listener({
      type: 'assistant',
      text: 'Partial response',
      timestamp: Date.now() + 1,
    });
    await listener({
      type: 'result',
      text: 'Done',
      timestamp: Date.now() + 2,
    });
    await flushAsyncWork();

    const streamedEvents = ws.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .filter((event) => event.type === 'status' || event.type === 'assistant' || event.type === 'result');
    expect(streamedEvents.map((event) => event.seq)).toEqual([1, 2, 3]);

    const finalSession = upsertSession.mock.calls[1]?.[0] as AgentSession;
    expect(finalSession.maxSeq).toBe(3);
    expect(finalSession.eventsByTurn['turn-1']?.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('listener receives events dispatched immediately after turn start', async () => {
    const turnId = 'turn-immediate';
    const session = makeSession({ id: 'session-immediate' });

    const getSession = vi.fn(async () => cloneSession(session));
    const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => {});

    const subscribeTurnEvents = vi.fn((registeredTurnId: string, listener: (event: AgentEvent) => void) => {
      registryTurnIdsForCleanup.add(registeredTurnId);
      return agentTurnRegistry.subscribeTurnEvents(registeredTurnId, listener);
    });

    const startAgentTurn = vi.fn(() => {
      agentTurnRegistry.setActiveTurnController(turnId, new AbortController());
      registryTurnIdsForCleanup.add(turnId);

      queueMicrotask(() => {
        dispatchAgentEvent(null, turnId, {
          type: 'result',
          text: 'Immediate completion',
          timestamp: Date.now(),
        });
      });

      return { turnId };
    });

    const { deps } = createDeps({
      getSession,
      upsertSession,
      startAgentTurn,
      subscribeTurnEvents,
    });
    const ws = new MockAgentWs();

    handleAgentTurnWs(ws as unknown as WebSocket, deps);

    await ws.emitMessage({
      sessionId: session.id,
      prompt: 'Run immediately',
      resetConversation: false,
    });
    await flushAsyncWork();

    const persistedSessions = upsertSession.mock.calls.map((call) => call[0] as AgentSession);
    expect(persistedSessions.some((persistedSession) =>
      persistedSession.isBusy === false && persistedSession.activeTurnId === null)).toBe(true);
  });

  it("route subscriber survives recovery adapter's setEventListener overwrite", async () => {
    // REGRESSION: docs/plans/260504_fix_ci_failures.md — the cloud route must
    // stream through subscribeTurnEvents because recovery setup owns the
    // single-slot setEventListener gate.
    const turnId = 'turn-route-subscriber-survival';
    const session = makeSession({ id: 'session-route-subscriber-survival' });
    const routeSubscriberEvents: AgentEvent[] = [];

    const getSession = vi.fn(async () => cloneSession(session));
    const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => {});
    const subscribeTurnEvents = vi.fn((registeredTurnId: string, listener: (event: AgentEvent) => void) => {
      registryTurnIdsForCleanup.add(registeredTurnId);
      return agentTurnRegistry.subscribeTurnEvents(registeredTurnId, (event) => {
        routeSubscriberEvents.push(event);
        listener(event);
      });
    });

    const startAgentTurn = vi.fn(() => {
      agentTurnRegistry.setActiveTurnController(turnId, new AbortController());
      registryTurnIdsForCleanup.add(turnId);
      return { turnId };
    });

    const { deps } = createDeps({
      getSession,
      upsertSession,
      startAgentTurn,
      subscribeTurnEvents,
    });
    const ws = new MockAgentWs();

    handleAgentTurnWs(ws as unknown as WebSocket, deps);

    await ws.emitMessage({
      sessionId: session.id,
      prompt: 'Run with recovery listener overwrite',
      resetConversation: false,
    });
    await flushAsyncWork();

    dispatchAgentEvent(null, turnId, {
      type: 'assistant',
      text: 'First streamed response',
      timestamp: Date.now(),
    });

    const recoverySingleSlotListener = vi.fn();
    agentTurnRegistry.setEventListener(turnId, recoverySingleSlotListener);

    dispatchAgentEvent(null, turnId, {
      type: 'result',
      text: 'Final streamed response',
      timestamp: Date.now() + 1,
    });
    await flushAsyncWork();

    expect(subscribeTurnEvents).toHaveBeenCalledOnce();
    expect(routeSubscriberEvents.map((event) => event.type)).toEqual(['assistant', 'result']);
    expect(recoverySingleSlotListener).toHaveBeenCalledOnce();
    const streamedTexts = ws.sent
      .map((payload) => JSON.parse(payload) as Record<string, unknown>)
      .filter((event) => event.type === 'assistant' || event.type === 'result')
      .map((event) => event.text);
    expect(streamedTexts).toEqual(['First streamed response', 'Final streamed response']);
  });
});
