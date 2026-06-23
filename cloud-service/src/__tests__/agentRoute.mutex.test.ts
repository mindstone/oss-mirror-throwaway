import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { AgentSession, AgentEvent } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import type { PushNotificationOptions } from '../services/pushNotificationService';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';

const mockMarkSessionAsCloudActive = vi.fn<(sessionId: string) => Promise<void>>(async () => {});

vi.mock('@core/services/cloudContinuityStateService', () => ({
  markSessionAsCloudActive: (sessionId: string) => mockMarkSessionAsCloudActive(sessionId),
  readContinuityStateMap: vi.fn(async () => null),
}));

const mockSendPushNotification = vi.fn<(options: PushNotificationOptions) => Promise<void>>(async () => {});

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
import { handleSessions } from '../routes/sessions';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class MockAgentWs {
  readyState: WebSocket['readyState'] = WebSocket.OPEN;
  sent: string[] = [];

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
  terminate(): void { this.close(); }

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
    id: 'session-mutex',
    title: 'Original title',
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
      Object.entries(session.eventsByTurn ?? {}).map(([turnId, events]) => [
        turnId,
        events.map((event) => ({ ...event })),
      ]),
    ),
  };
}

function createPutReq(url: string, body: unknown): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = 'PUT';
  req.url = url;
  req.headers = { host: 'localhost' };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function createMockRes(): {
  res: http.ServerResponse;
  statusCode: () => number;
  body: () => unknown;
} {
  let capturedStatus = 200;
  let capturedBody = '';

  const res = {
    writeHead: vi.fn((status: number) => {
      capturedStatus = status;
    }),
    end: vi.fn((body?: string) => {
      capturedBody = body || '';
    }),
  } as unknown as http.ServerResponse;

  return {
    res,
    statusCode: () => capturedStatus,
    body: () => JSON.parse(capturedBody),
  };
}

describe('agent/session mutex integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionSeqIndexForTests();
    resetSessionMutexForTests();
  });

  afterEach(() => {
    cloudEventBroadcaster.closeAll();
    resetSessionSeqIndexForTests();
    resetSessionMutexForTests();
  });

  it('serializes concurrent turn-start and rename writes for the same session', async () => {
    let currentSession = makeSession();

    const firstWriteStarted = createDeferred<void>();
    const releaseFirstWrite = createDeferred<void>();
    let writeCount = 0;
    let activeWrites = 0;
    let maxConcurrentWrites = 0;

    const upsertSession = vi.fn(async (nextSession: AgentSession) => {
      writeCount += 1;
      activeWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);

      if (writeCount === 1) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }

      currentSession = cloneSession(nextSession);
      activeWrites -= 1;
    });

    const activeTurnController = new AbortController();
    const deps = {
      startAgentTurn: vi.fn(() => ({ turnId: 'turn-1' })),
      getActiveTurnController: vi.fn((turnId: string) => (turnId === 'turn-1' ? activeTurnController : undefined)),
      getTurnCloseCallback: vi.fn(),
      setEventListener: vi.fn((_turnId: string, _listener: (event: AgentEvent) => void) => {}),
      subscribeTurnEvents: vi.fn((_turnId: string, _listener: (event: AgentEvent) => void) => () => {}),
      agentTurnServiceDeps: {},
      loadSessions: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(async () => cloneSession(currentSession)),
      upsertSession,
      deleteSession: vi.fn(),
      getSettings: vi.fn(() => ({})),
      updateSettings: vi.fn(),
      listFiles: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
    } as unknown as CloudServiceDeps;

    const ws = new MockAgentWs();
    handleAgentTurnWs(ws as unknown as WebSocket, deps);

    const turnStartPromise = ws.emitMessage({
      sessionId: currentSession.id,
      prompt: 'Run turn',
      resetConversation: false,
    });

    await firstWriteStarted.promise;

    const renamePayload = makeSession({
      id: currentSession.id,
      title: 'Renamed from desktop',
      updatedAt: Date.now() + 500,
      activeTurnId: null,
      isBusy: false,
      messages: [],
      eventsByTurn: {},
    });

    const renameRes = createMockRes();
    const renamePromise = handleSessions(
      createPutReq(`/api/sessions/${currentSession.id}`, renamePayload),
      renameRes.res,
      ['api', 'sessions', currentSession.id],
      deps,
    );

    await Promise.resolve();
    expect(upsertSession).toHaveBeenCalledTimes(1);
    expect(maxConcurrentWrites).toBe(1);

    releaseFirstWrite.resolve();
    await Promise.all([turnStartPromise, renamePromise]);

    expect(renameRes.statusCode()).toBe(200);
    expect(renameRes.body()).toMatchObject({ success: true, tombstoned: false });
    expect(upsertSession).toHaveBeenCalledTimes(2);
    expect(maxConcurrentWrites).toBe(1);
    expect(currentSession.title).toBe('Renamed from desktop');
    // A live turn controller is ground-truth liveness (turn-liveness projection): a
    // concurrent stale rename carrying an advisory isBusy:false must not clobber a
    // genuinely running turn. turn-1's controller is still active with no terminal
    // event, so the merge correctly keeps the session busy on the live turn while the
    // rename still wins for the title (asserted above). Reverting a stale rename's
    // liveness onto a live turn would reintroduce the lost-turn bug class.
    expect(currentSession.isBusy).toBe(true);
    expect(currentSession.activeTurnId).toBe('turn-1');
  });
});
