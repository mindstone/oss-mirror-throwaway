import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentEvent, AgentSession } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import type { PushNotificationOptions } from '../services/pushNotificationService';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';

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

import {
  handleAgentTurnWs,
  TURN_CHECKPOINT_INTERVAL_MS,
  TURN_CHECKPOINT_TOOL_RESULT_THRESHOLD,
} from '../routes/agent';

class MockAgentWs {
  readyState: WebSocket['readyState'] = WebSocket.OPEN;
  sent: string[] = [];
  pingCount = 0;
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

  ping(): void {
    this.pingCount += 1;
  }

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

function createDeps(options: {
  getSession?: ReturnType<typeof vi.fn>;
  upsertSession?: ReturnType<typeof vi.fn>;
} = {}): {
  deps: CloudServiceDeps;
  getSession: ReturnType<typeof vi.fn>;
  upsertSession: ReturnType<typeof vi.fn>;
  getEventListener: () => ((event: AgentEvent) => Promise<void>) | null;
} {
  let eventListener: ((event: AgentEvent) => Promise<void>) | null = null;

  const getSession = options.getSession ?? vi.fn(async () => makeSession());
  const upsertSession = options.upsertSession ?? vi.fn<(session: AgentSession) => Promise<void>>(async () => {});

  const deps = {
    startAgentTurn: vi.fn(() => ({ turnId: 'turn-1' })),
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

function createToolEndEvent(index: number): AgentEvent {
  return {
    type: 'tool',
    toolName: `Tool-${index}`,
    detail: `detail-${index}`,
    stage: 'end',
    timestamp: Date.now() + index,
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
} = {}) {
  const session = options.session ?? makeSession();
  const getSession = options.getSession ?? vi.fn(async () => session);
  const { deps, upsertSession, getEventListener } = createDeps({
    getSession,
    upsertSession: options.upsertSession,
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

async function finishTurn(listener: (event: AgentEvent) => Promise<void>): Promise<void> {
  await listener({
    type: 'error',
    error: 'cleanup',
    timestamp: Date.now(),
  });
  await flushAsyncWork();
}

describe('handleAgentTurnWs checkpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionSeqIndexForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSessionSeqIndexForTests();
    cloudEventBroadcaster.closeAll();
  });

  it('fires a checkpoint after 20 tool result events', async () => {
    const { listener, upsertSession } = await startTurn();

    expect(upsertSession).toHaveBeenCalledTimes(1);

    for (let index = 0; index < TURN_CHECKPOINT_TOOL_RESULT_THRESHOLD; index += 1) {
      await listener(createToolEndEvent(index));
    }
    await flushAsyncWork();

    expect(upsertSession).toHaveBeenCalledTimes(2);
    const checkpointSession = upsertSession.mock.calls[1]?.[0] as AgentSession;
    expect(checkpointSession.isBusy).toBe(true);
    expect(checkpointSession.activeTurnId).toBe('turn-1');
    expect(checkpointSession.eventsByTurn['turn-1']).toHaveLength(TURN_CHECKPOINT_TOOL_RESULT_THRESHOLD);

    await finishTurn(listener);
  });

  it('fires a checkpoint after 30 seconds', async () => {
    vi.useFakeTimers();

    const { listener, upsertSession } = await startTurn();

    expect(upsertSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TURN_CHECKPOINT_INTERVAL_MS);
    await flushAsyncWork();

    expect(upsertSession).toHaveBeenCalledTimes(2);

    await finishTurn(listener);
  });

  it('does not checkpoint before either threshold', async () => {
    vi.useFakeTimers();

    const { listener, upsertSession } = await startTurn();

    for (let index = 0; index < TURN_CHECKPOINT_TOOL_RESULT_THRESHOLD - 1; index += 1) {
      await listener(createToolEndEvent(index));
    }

    await vi.advanceTimersByTimeAsync(TURN_CHECKPOINT_INTERVAL_MS - 1_000);
    await flushAsyncWork();

    expect(upsertSession).toHaveBeenCalledTimes(1);

    await finishTurn(listener);
  });

  it('treats checkpoint failure as non-fatal', async () => {
    const upsertSession = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('checkpoint failed'))
      .mockResolvedValue(undefined);

    const { listener } = await startTurn({ upsertSession });

    for (let index = 0; index < TURN_CHECKPOINT_TOOL_RESULT_THRESHOLD; index += 1) {
      await listener(createToolEndEvent(index));
    }
    await flushAsyncWork();

    expect(upsertSession).toHaveBeenCalledTimes(2);

    await listener({
      type: 'result',
      text: 'Done',
      timestamp: Date.now(),
    });
    await flushAsyncWork();

    expect(upsertSession).toHaveBeenCalledTimes(3);
    const finalSession = upsertSession.mock.calls[2]?.[0] as AgentSession;
    expect(finalSession.isBusy).toBe(false);
    expect(finalSession.activeTurnId).toBeNull();
  });

  it('does not checkpoint after a terminal event', async () => {
    vi.useFakeTimers();

    const { listener, upsertSession } = await startTurn();

    await listener({
      type: 'result',
      text: 'Done',
      timestamp: Date.now(),
    });
    await flushAsyncWork();

    expect(upsertSession).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(TURN_CHECKPOINT_INTERVAL_MS);
    await flushAsyncWork();

    expect(upsertSession).toHaveBeenCalledTimes(2);
  });

  it('fresh-reads metadata before writing a checkpoint merge', async () => {
    const initialSession = makeSession({
      id: 'session-merge',
      title: 'Initial title',
      doneAt: 10,
    });
    const busyFreshSession = makeSession({
      id: initialSession.id,
      title: 'Busy title',
      doneAt: 20,
    });
    const checkpointFreshSession = makeSession({
      id: initialSession.id,
      title: 'Fresh title',
      doneAt: 30,
      messages: [{
        id: 'fresh-message',
        turnId: 'other-turn',
        role: 'assistant',
        text: 'fresh metadata only',
        createdAt: Date.now() - 500,
      }],
      eventsByTurn: {
        'other-turn': [createToolEndEvent(999)],
      },
    });
    const getSession = vi.fn()
      .mockResolvedValueOnce(initialSession)
      .mockResolvedValueOnce(busyFreshSession)
      .mockResolvedValue(checkpointFreshSession);

    const { listener, upsertSession } = await startTurn({
      session: initialSession,
      getSession,
    });

    for (let index = 0; index < TURN_CHECKPOINT_TOOL_RESULT_THRESHOLD; index += 1) {
      await listener(createToolEndEvent(index));
    }
    await flushAsyncWork();

    const checkpointSession = upsertSession.mock.calls[1]?.[0] as AgentSession;
    expect(getSession.mock.invocationCallOrder[2]).toBeLessThan(upsertSession.mock.invocationCallOrder[1]);
    expect(checkpointSession.title).toBe('Fresh title');
    expect(checkpointSession.doneAt).toBe(30);
    expect(checkpointSession.messages).toHaveLength(1);
    expect(checkpointSession.messages[0]?.role).toBe('user');
    expect(Object.keys(checkpointSession.eventsByTurn)).toEqual(['turn-1']);
    expect(checkpointSession.eventsByTurn['turn-1']).toHaveLength(TURN_CHECKPOINT_TOOL_RESULT_THRESHOLD);

    await finishTurn(listener);
  });
});
