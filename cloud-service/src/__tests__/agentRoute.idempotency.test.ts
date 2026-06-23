import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentEvent, AgentSession } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import type { PushNotificationOptions } from '../services/pushNotificationService';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import {
  getTurnIdempotencyIndex,
  resetTurnIdempotencyIndexForTests,
} from '@core/services/continuity/turnIdempotencyIndex';
import { resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';

const mockMarkSessionAsCloudActive = vi.fn<(sessionId: string) => Promise<void>>(async () => {});
const mockSendPushNotification = vi.fn<(options: PushNotificationOptions) => Promise<void>>(async () => {});

const { mockProcessAutoTitle } = vi.hoisted(() => ({
  mockProcessAutoTitle: vi.fn<(...args: unknown[]) => Promise<null>>(async () => null),
}));

vi.mock('@core/services/cloudContinuityStateService', () => ({
  markSessionAsCloudActive: (sessionId: string) => mockMarkSessionAsCloudActive(sessionId),
}));

vi.mock('../services/pushNotificationService', () => ({
  sendPushNotification: (options: PushNotificationOptions) => mockSendPushNotification(options),
}));

vi.mock('@core/services/conversationTitleService', () => ({
  maybeGenerateSessionTitle: vi.fn(async () => null),
  isDefaultOrFallbackTitle: vi.fn(() => false),
  processAutoTitle: mockProcessAutoTitle,
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
  closeCalls: Array<{ code?: number; reason?: string }> = [];

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

  close(code?: number, reason?: string): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
    const handlers = this.onHandlers.get('close') ?? [];
    for (const handler of handlers) handler();
  }

  ping(): void {}

  terminate(): void {
    this.close(1006, 'terminated');
  }

  async emitMessage(payload: unknown): Promise<void> {
    const handler = this.onceHandlers.get('message');
    if (!handler) throw new Error('No message handler registered');
    this.onceHandlers.delete('message');
    await handler(Buffer.from(JSON.stringify(payload), 'utf-8'));
  }
}

function cloneSession(session: AgentSession): AgentSession {
  return {
    ...session,
    messages: session.messages.map((message) => ({ ...message })),
    eventsByTurn: Object.fromEntries(
      Object.entries(session.eventsByTurn).map(([turnKey, events]) => [turnKey, events.map((event) => ({ ...event }))]),
    ),
  };
}

function createDeps(options: {
  failFinalPersistence?: boolean;
  failStartAttempts?: number;
} = {}): {
  deps: CloudServiceDeps;
  startAgentTurn: ReturnType<typeof vi.fn>;
  getEventListener: () => ((event: AgentEvent) => Promise<void>) | null;
} {
  let eventListener: ((event: AgentEvent) => Promise<void>) | null = null;
  let turnCounter = 0;
  let persistedSession: AgentSession | null = null;
  let upsertCount = 0;
  let remainingStartFailures = options.failStartAttempts ?? 0;

  const startAgentTurn = vi.fn(() => {
    if (remainingStartFailures > 0) {
      remainingStartFailures -= 1;
      throw new Error('start failed');
    }
    turnCounter += 1;
    return { turnId: `turn-${turnCounter}` };
  });

  const deps = {
    startAgentTurn,
    getActiveTurnController: vi.fn(),
    getTurnCloseCallback: vi.fn(),
    setEventListener: vi.fn(),
    subscribeTurnEvents: vi.fn((_turnId: string, listener: (event: AgentEvent) => Promise<void>) => {
      eventListener = listener;
      return () => {
        if (eventListener === listener) eventListener = null;
      };
    }),
    agentTurnServiceDeps: {},
    loadSessions: vi.fn(),
    listSessions: vi.fn(),
    getSession: vi.fn(async () => (persistedSession ? cloneSession(persistedSession) : null)),
    upsertSession: vi.fn(async (session: AgentSession) => {
      upsertCount += 1;
      const isFinalPersist = !session.isBusy;
      if (options.failFinalPersistence && isFinalPersist && upsertCount >= 2) {
        throw new Error('persist failed');
      }
      persistedSession = cloneSession(session);
    }),
    deleteSession: vi.fn(),
    getSettings: vi.fn(() => ({})),
    updateSettings: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  } as unknown as CloudServiceDeps;

  return {
    deps,
    startAgentTurn,
    getEventListener: () => eventListener,
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function parseSent(ws: MockAgentWs): Array<Record<string, unknown>> {
  return ws.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

describe('handleAgentTurnWs idempotency keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetTurnIdempotencyIndexForTests();
    resetSessionSeqIndexForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTurnIdempotencyIndexForTests();
    resetSessionSeqIndexForTests();
    cloudEventBroadcaster.closeAll();
  });

  it('replays persisted turns for the same clientTurnId without starting a duplicate turn', async () => {
    const { deps, startAgentTurn, getEventListener } = createDeps();
    const ws1 = new MockAgentWs();

    handleAgentTurnWs(ws1 as unknown as WebSocket, deps);
    await ws1.emitMessage({
      sessionId: 'session-1',
      prompt: 'hello',
      clientTurnId: 'client-turn-1',
    });
    await flushAsyncWork();
    const started = parseSent(ws1).find((event) => event.type === 'turn_started');
    expect(started).toMatchObject({
      type: 'turn_started',
      turnId: 'turn-1',
      clientTurnId: 'client-turn-1',
      supportsPersistedAck: true,
    });

    const listener = getEventListener();
    if (!listener) throw new Error('Expected event listener to be registered');

    await listener({
      type: 'result',
      text: 'done',
      timestamp: Date.now(),
    });
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(150);

    const ws2 = new MockAgentWs();
    handleAgentTurnWs(ws2 as unknown as WebSocket, deps);
    await ws2.emitMessage({
      sessionId: 'session-1',
      prompt: 'hello retry',
      clientTurnId: 'client-turn-1',
    });
    await flushAsyncWork();

    expect(startAgentTurn).toHaveBeenCalledTimes(1);
    const replayEvents = parseSent(ws2);
    expect(replayEvents[0]).toMatchObject({
      type: 'turn_persisted',
      clientTurnId: 'client-turn-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      status: 'persisted',
      outcome: 'result',
      idempotentReplay: true,
    });
    expect(ws2.closeCalls[0]).toEqual({
      code: 1000,
      reason: 'Turn already persisted (idempotent replay)',
    });
  });

  it('marks failed persistence as errored and retries the same clientTurnId on next attempt', async () => {
    const { deps, startAgentTurn, getEventListener } = createDeps({ failFinalPersistence: true });
    const ws1 = new MockAgentWs();

    handleAgentTurnWs(ws1 as unknown as WebSocket, deps);
    await ws1.emitMessage({
      sessionId: 'session-2',
      prompt: 'first attempt',
      clientTurnId: 'client-turn-2',
    });
    await flushAsyncWork();

    const listener = getEventListener();
    if (!listener) throw new Error('Expected event listener to be registered');

    await listener({
      type: 'result',
      text: 'first done',
      timestamp: Date.now(),
    });
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(150);

    const ws2 = new MockAgentWs();
    handleAgentTurnWs(ws2 as unknown as WebSocket, deps);
    await ws2.emitMessage({
      sessionId: 'session-2',
      prompt: 'retry after persist failure',
      clientTurnId: 'client-turn-2',
    });
    await flushAsyncWork();

    expect(startAgentTurn).toHaveBeenCalledTimes(2);
    const secondTurnEvents = parseSent(ws2).map((event) => event.type);
    expect(secondTurnEvents).toContain('turn_started');
    expect(secondTurnEvents).not.toContain('turn_persisted');
    expect(secondTurnEvents).not.toContain('turn_in_flight');
  });

  it('rejects clientTurnId reuse across different sessions', async () => {
    const { deps, startAgentTurn } = createDeps();
    const ws1 = new MockAgentWs();

    handleAgentTurnWs(ws1 as unknown as WebSocket, deps);
    await ws1.emitMessage({
      sessionId: 'session-A',
      prompt: 'first owner',
      clientTurnId: 'client-turn-collision',
    });
    await flushAsyncWork();

    const ws2 = new MockAgentWs();
    handleAgentTurnWs(ws2 as unknown as WebSocket, deps);
    await ws2.emitMessage({
      sessionId: 'session-B',
      prompt: 'cross-session reuse',
      clientTurnId: 'client-turn-collision',
    });
    await flushAsyncWork();

    expect(startAgentTurn).toHaveBeenCalledTimes(1);
    expect(parseSent(ws2)[0]).toMatchObject({
      type: 'error',
      error: 'clientTurnId belongs to a different session',
    });
    expect(ws2.closeCalls[0]).toEqual({
      code: 1008,
      reason: 'Cross-session clientTurnId collision',
    });
  });

  it('post-startAgentTurn failure does NOT mark idempotency entry as errored', async () => {
    mockMarkSessionAsCloudActive.mockRejectedValueOnce(new Error('cloud-active failed'));
    const { deps, startAgentTurn } = createDeps();
    const ws1 = new MockAgentWs();

    handleAgentTurnWs(ws1 as unknown as WebSocket, deps);
    await ws1.emitMessage({
      sessionId: 'session-post-start',
      prompt: 'first attempt',
      clientTurnId: 'client-turn-post-start',
    });
    await flushAsyncWork();

    const entryAfterFailure = getTurnIdempotencyIndex().get('client-turn-post-start');
    expect(entryAfterFailure).toMatchObject({
      status: 'in_flight',
      turnId: 'turn-1',
      sessionId: 'session-post-start',
    });

    const ws2 = new MockAgentWs();
    handleAgentTurnWs(ws2 as unknown as WebSocket, deps);
    await ws2.emitMessage({
      sessionId: 'session-post-start',
      prompt: 'retry after post-start failure',
      clientTurnId: 'client-turn-post-start',
    });
    await flushAsyncWork();

    expect(startAgentTurn).toHaveBeenCalledTimes(1);
    const replayEvents = parseSent(ws2);
    expect(replayEvents[0]).toMatchObject({
      type: 'turn_in_flight',
      clientTurnId: 'client-turn-post-start',
      turnId: 'turn-1',
      sessionId: 'session-post-start',
      status: 'in_flight',
    });
  });

  it('pre-startAgentTurn failure marks errored and allows a retry to start a new turn', async () => {
    const { deps, startAgentTurn } = createDeps({ failStartAttempts: 1 });
    const ws1 = new MockAgentWs();

    handleAgentTurnWs(ws1 as unknown as WebSocket, deps);
    await ws1.emitMessage({
      sessionId: 'session-pre-start',
      prompt: 'first attempt',
      clientTurnId: 'client-turn-pre-start',
    });
    await flushAsyncWork();

    const entryAfterFailure = getTurnIdempotencyIndex().get('client-turn-pre-start');
    expect(entryAfterFailure?.status).toBe('errored');

    const ws2 = new MockAgentWs();
    handleAgentTurnWs(ws2 as unknown as WebSocket, deps);
    await ws2.emitMessage({
      sessionId: 'session-pre-start',
      prompt: 'retry after start failure',
      clientTurnId: 'client-turn-pre-start',
    });
    await flushAsyncWork();

    expect(startAgentTurn).toHaveBeenCalledTimes(2);
    const startEvent = parseSent(ws2).find((event) => event.type === 'turn_started');
    expect(startEvent).toMatchObject({
      type: 'turn_started',
      supportsPersistedAck: true,
    });
  });

  it('passes a getCurrentSession callback to processAutoTitle so the retry path can re-read session state (wiring contract)', async () => {
    mockProcessAutoTitle.mockClear();

    const { deps, getEventListener } = createDeps();
    const ws = new MockAgentWs();

    handleAgentTurnWs(ws as unknown as WebSocket, deps);
    await ws.emitMessage({
      sessionId: 'session-title-wiring',
      prompt: 'hello',
      clientTurnId: 'client-turn-title-wiring',
    });
    await flushAsyncWork();

    const listener = getEventListener();
    if (!listener) throw new Error('Expected event listener to be registered');

    await listener({
      type: 'result',
      text: 'done',
      timestamp: Date.now(),
    });
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(150);
    await flushAsyncWork();

    expect(mockProcessAutoTitle).toHaveBeenCalled();
    const optionsArg = mockProcessAutoTitle.mock.calls.at(-1)?.[1] as {
      getSettings?: unknown;
      getCurrentSession?: unknown;
    } | undefined;
    expect(typeof optionsArg?.getSettings).toBe('function');
    expect(typeof optionsArg?.getCurrentSession).toBe('function');
  });
});
