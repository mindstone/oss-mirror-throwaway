import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentSession, AgentTurnRequest } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';
import { TRANSCRIPT_UNAVAILABLE_DISCLAIMER_LEAD } from '@shared/constants/meetingTranscriptDisclaimer';
import {
  cleanupTranscriptionState,
  ensureRollingTranscriptState,
} from '../services/meetingTranscriptionEngine';

const { mockMarkSessionAsCloudActive } = vi.hoisted(() => ({
  mockMarkSessionAsCloudActive: vi.fn(async () => undefined),
}));

vi.mock('@core/services/cloudContinuityStateService', () => ({
  markSessionAsCloudActive: mockMarkSessionAsCloudActive,
}));

vi.mock('../services/pushNotificationService', () => ({
  sendPushNotification: vi.fn(async () => undefined),
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
  _resetTranscriptUnavailableRateLimitForTesting,
  handleAgentTurnWs,
} from '../routes/agent';

const DISCLAIMER_SENTENCE = TRANSCRIPT_UNAVAILABLE_DISCLAIMER_LEAD;

class MockAgentWs {
  readyState: number = WebSocket.OPEN;
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
    id: 'session-stage-d',
    title: 'Stage D test session',
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

function createDeps(): {
  deps: CloudServiceDeps;
  startAgentTurn: ReturnType<typeof vi.fn>;
} {
  const startAgentTurn = vi.fn((_deps, request: AgentTurnRequest) => {
    return { turnId: `turn-${request.sessionId}` };
  });

  const deps = {
    startAgentTurn,
    getActiveTurnController: vi.fn(),
    getTurnCloseCallback: vi.fn(),
    setEventListener: vi.fn(),
    subscribeTurnEvents: vi.fn((_turnId: string, _listener: () => void) => () => {}),
    agentTurnServiceDeps: {},
    loadSessions: vi.fn(),
    listSessions: vi.fn(),
    getSession: vi.fn(async () => makeSession()),
    upsertSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(),
    getSettings: vi.fn(() => ({})),
    updateSettings: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  } as unknown as CloudServiceDeps;

  return { deps, startAgentTurn };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('handleAgentTurnWs transcript context injection', () => {
  const meetingSessionIds = new Set<string>();

  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionSeqIndexForTests();
    _resetTranscriptUnavailableRateLimitForTesting();
  });

  afterEach(() => {
    for (const sessionId of meetingSessionIds) {
      cleanupTranscriptionState(sessionId);
    }
    meetingSessionIds.clear();
    cloudEventBroadcaster.closeAll();
    resetSessionSeqIndexForTests();
  });

  it('injects transcript context when transcript exists', async () => {
    const meetingSessionId = 'meeting-populated';
    meetingSessionIds.add(meetingSessionId);
    const state = ensureRollingTranscriptState(meetingSessionId);
    state.rollingTranscript = 'Alice: The launch date is June 12.';

    const { deps, startAgentTurn } = createDeps();
    const ws = new MockAgentWs();
    handleAgentTurnWs(ws as unknown as WebSocket, deps);

    await ws.emitMessage({
      sessionId: 'session-populated',
      prompt: 'When is the launch date?',
      meetingSessionId,
      recordingActive: true,
    });
    await flushAsyncWork();

    const request = startAgentTurn.mock.calls[0]?.[1] as AgentTurnRequest;
    expect(request.prompt).toContain('[MEETING TRANSCRIPT SO FAR]');
    expect(request.prompt).toContain('Alice: The launch date is June 12.');
    expect(request.prompt).not.toContain(DISCLAIMER_SENTENCE);
    ws.close();
  });

  it('injects disclaimer instruction for empty transcript with known meeting session id', async () => {
    const meetingSessionId = 'meeting-empty';
    meetingSessionIds.add(meetingSessionId);
    const state = ensureRollingTranscriptState(meetingSessionId);
    state.rollingTranscript = '';

    const { deps, startAgentTurn } = createDeps();
    const ws = new MockAgentWs();
    handleAgentTurnWs(ws as unknown as WebSocket, deps);

    await ws.emitMessage({
      sessionId: 'session-empty',
      prompt: 'What is 2 + 2?',
      meetingSessionId,
      recordingActive: true,
    });
    await flushAsyncWork();

    const request = startAgentTurn.mock.calls[0]?.[1] as AgentTurnRequest;
    expect(request.prompt).toContain(DISCLAIMER_SENTENCE);
    expect(request.prompt).not.toContain('[MEETING TRANSCRIPT SO FAR]');
    ws.close();
  });

  it('injects disclaimer instruction when recording is active but meeting session id is missing', async () => {
    const { deps, startAgentTurn } = createDeps();
    const ws = new MockAgentWs();
    handleAgentTurnWs(ws as unknown as WebSocket, deps);

    await ws.emitMessage({
      sessionId: 'session-no-meeting-id',
      prompt: 'What is 3 + 3?',
      recordingActive: true,
    });
    await flushAsyncWork();

    const request = startAgentTurn.mock.calls[0]?.[1] as AgentTurnRequest;
    expect(request.prompt).toContain(DISCLAIMER_SENTENCE);
    ws.close();
  });

  it('injects disclaimer instruction when meeting session id has no transcription state', async () => {
    const { deps, startAgentTurn } = createDeps();
    const ws = new MockAgentWs();
    handleAgentTurnWs(ws as unknown as WebSocket, deps);

    await ws.emitMessage({
      sessionId: 'session-no-engine-state',
      prompt: 'Did we decide anything?',
      meetingSessionId: 'missing-engine-session',
      recordingActive: true,
    });
    await flushAsyncWork();

    const request = startAgentTurn.mock.calls[0]?.[1] as AgentTurnRequest;
    expect(request.prompt).toContain(DISCLAIMER_SENTENCE);
    ws.close();
  });

  it('does not inject transcript markers when there is no recording context', async () => {
    const { deps, startAgentTurn } = createDeps();
    const ws = new MockAgentWs();
    handleAgentTurnWs(ws as unknown as WebSocket, deps);

    await ws.emitMessage({
      sessionId: 'session-no-recording-context',
      prompt: 'Ping',
      recordingActive: false,
    });
    await flushAsyncWork();

    const request = startAgentTurn.mock.calls[0]?.[1] as AgentTurnRequest;
    expect(request.prompt).toBe('Ping');
    expect(request.prompt).not.toContain(DISCLAIMER_SENTENCE);
    expect(request.prompt).not.toContain('[MEETING TRANSCRIPT SO FAR]');
    ws.close();
  });

  it('rejects non-boolean recordingActive string values', async () => {
    const { deps, startAgentTurn } = createDeps();
    const ws = new MockAgentWs();
    handleAgentTurnWs(ws as unknown as WebSocket, deps);

    await ws.emitMessage({
      sessionId: 'session-invalid-recording-active-string',
      prompt: 'What is 2 + 2?',
      recordingActive: 'true',
    });
    await flushAsyncWork();

    expect(startAgentTurn).not.toHaveBeenCalled();
    expect(ws.sent.some((message) => message.includes('Invalid request body'))).toBe(true);
    ws.close();
  });

  it('rejects non-boolean recordingActive number values', async () => {
    const { deps, startAgentTurn } = createDeps();
    const ws = new MockAgentWs();
    handleAgentTurnWs(ws as unknown as WebSocket, deps);

    await ws.emitMessage({
      sessionId: 'session-invalid-recording-active-number',
      prompt: 'What is 2 + 2?',
      recordingActive: 1,
    });
    await flushAsyncWork();

    expect(startAgentTurn).not.toHaveBeenCalled();
    expect(ws.sent.some((message) => message.includes('Invalid request body'))).toBe(true);
    ws.close();
  });
});
