import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { AgentEvent, AgentSession } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import type { PushNotificationOptions } from '../services/pushNotificationService';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    subscribeTurnCleanup: vi.fn(() => () => {}),
  },
}));

const mockMarkSessionAsCloudActive = vi.fn<(sessionId: string) => Promise<void>>(async () => {});

vi.mock('@core/services/cloudContinuityStateService', () => ({
  markSessionAsCloudActive: (sessionId: string) => mockMarkSessionAsCloudActive(sessionId),
}));

const mockSendPushNotification = vi.fn<(options: PushNotificationOptions) => Promise<void>>(async () => {});

vi.mock('../services/pushNotificationService', () => ({
  sendPushNotification: (options: PushNotificationOptions) => mockSendPushNotification(options),
}));

import { handleAgentTurnWs } from '../routes/agent';

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

  terminate(): void {
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
    origin: 'manual',
    ...overrides,
  };
}

function createDeps(session: AgentSession): {
  deps: CloudServiceDeps;
  upsertSession: ReturnType<typeof vi.fn>;
  getEventListener: () => ((event: AgentEvent) => Promise<void>) | null;
} {
  let eventListener: ((event: AgentEvent) => Promise<void>) | null = null;

  const upsertSession = vi.fn<(session: AgentSession) => Promise<void>>(async () => {});

  const deps = {
    startAgentTurn: vi.fn(() => ({ turnId: 'turn-1' })),
    getActiveTurnController: vi.fn(),
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
    getSession: vi.fn(async () => session),
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
    upsertSession,
    getEventListener: () => eventListener,
  };
}

describe('handleAgentTurnWs session continuity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionSeqIndexForTests();
  });

  afterEach(() => {
    resetSessionSeqIndexForTests();
    cloudEventBroadcaster.closeAll();
  });

  it('continues an existing session via stored Rebel history', async () => {
    const session = makeSession();
    const { deps } = createDeps(session);
    const ws = new MockAgentWs();

    handleAgentTurnWs(ws as unknown as WebSocket, deps);

    await ws.emitMessage({
      sessionId: session.id,
      prompt: 'Continue the conversation',
      resetConversation: false,
    });
  });
});
