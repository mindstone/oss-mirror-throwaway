import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession, AgentTurnRequest } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import { AgentSessionSchema } from '@shared/ipc/schemas/agent';
import {
  cleanupTranscriptionState,
  ensureRollingTranscriptState,
} from '../services/meetingTranscriptionEngine';

const {
  mockMarkSessionAsCloudActive,
  mockSendPushNotification,
} = vi.hoisted(() => ({
  mockMarkSessionAsCloudActive: vi.fn<(sessionId: string) => Promise<void>>(async () => undefined),
  mockSendPushNotification: vi.fn<(payload: unknown) => Promise<void>>(async () => undefined),
}));

vi.mock('@core/services/cloudContinuityStateService', () => ({
  markSessionAsCloudActive: (sessionId: string) => mockMarkSessionAsCloudActive(sessionId),
}));

vi.mock('../services/pushNotificationService', () => ({
  sendPushNotification: (payload: unknown) => mockSendPushNotification(payload),
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

import { submitAgentTurnInternal } from '../services/agentTurnSubmissionService';
import { submitAgentTurnInternal as submitAgentTurnInternalCore } from '@core/services/agentTurnSubmissionService';

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
      Object.entries(session.eventsByTurn).map(([turnKey, events]) => [turnKey, events.map((event) => ({ ...event }))]),
    ),
  };
}

function createDeps(options: {
  session?: AgentSession;
  upsertSession?: ReturnType<typeof vi.fn>;
} = {}): {
  deps: CloudServiceDeps;
  startAgentTurn: ReturnType<typeof vi.fn>;
  upsertSession: ReturnType<typeof vi.fn>;
  getEventListener: () => ((event: AgentEvent) => Promise<void>) | null;
} {
  let eventListener: ((event: AgentEvent) => Promise<void>) | null = null;
  const session = options.session ?? makeSession();
  const startAgentTurn = vi.fn((_serviceDeps: unknown, request: AgentTurnRequest) => ({
    turnId: request.clientTurnId?.trim() || `turn-${request.sessionId}`,
  }));

  const upsertSession = options.upsertSession ?? vi.fn(async () => undefined);

  const deps = {
    startAgentTurn,
    getActiveTurnController: vi.fn(),
    getTurnCloseCallback: vi.fn(),
    setEventListener: vi.fn(),
    subscribeTurnEvents: vi.fn((_turnId: string, listener: (event: AgentEvent) => Promise<void>) => {
      eventListener = listener;
      return () => {
        if (eventListener === listener) {
          eventListener = null;
        }
      };
    }),
    agentTurnServiceDeps: {},
    loadSessions: vi.fn(),
    listSessions: vi.fn(),
    getSession: vi.fn(async () => cloneSession(session)),
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
    startAgentTurn,
    upsertSession,
    getEventListener: () => eventListener,
  };
}

describe('submitAgentTurnInternal', () => {
  const meetingSessionIds = new Set<string>();

  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionSeqIndexForTests();
    resetSessionMutexForTests();
  });

  afterEach(() => {
    for (const meetingSessionId of meetingSessionIds) {
      cleanupTranscriptionState(meetingSessionId);
    }
    meetingSessionIds.clear();
    cloudEventBroadcaster.closeAll();
    resetSessionSeqIndexForTests();
    resetSessionMutexForTests();
  });

  it('injects transcript context for execution but persists the original user prompt', async () => {
    const meetingSessionId = 'meeting-turn-submission-context';
    meetingSessionIds.add(meetingSessionId);
    const state = ensureRollingTranscriptState(meetingSessionId);
    state.rollingTranscript = 'Alice: We agreed to launch on June 12.';

    const { deps, startAgentTurn, upsertSession, getEventListener } = createDeps({
      session: makeSession({ id: 'session-context' }),
    });

    const submission = await submitAgentTurnInternal({
      deps,
      request: {
        sessionId: 'session-context',
        prompt: 'When is the launch date?',
        meetingSessionId,
        recordingActive: true,
      },
    });

    expect(submission.turnId).toBe('turn-session-context');
    const executedRequest = startAgentTurn.mock.calls[0]?.[1] as AgentTurnRequest;
    expect(executedRequest.prompt).toContain('[MEETING TRANSCRIPT SO FAR]');
    expect(executedRequest.prompt).toContain('Alice: We agreed to launch on June 12.');
    expect(executedRequest.prompt).toContain('When is the launch date?');

    await submission.startup;

    const busyPersistSession = upsertSession.mock.calls[0]?.[0] as AgentSession;
    const persistedUserMessage = busyPersistSession.messages.find((message) => message.role === 'user');
    expect(persistedUserMessage?.text).toBe('When is the launch date?');

    const listener = getEventListener();
    if (!listener) throw new Error('Expected event listener to be registered');

    await listener({
      type: 'result',
      text: 'June 12',
      timestamp: Date.now(),
    });

    await expect(submission.completion).resolves.toMatchObject({
      outcome: 'result',
      persisted: true,
    });
    expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    expect(mockSendPushNotification).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Test Session',
      data: expect.objectContaining({
        kind: 'turn-complete',
        sessionId: 'session-context',
      }),
    }));
  });

  it('promotes clientTurnId to canonical turnId and never persists __pending__', async () => {
    const { deps, upsertSession, getEventListener } = createDeps({
      session: makeSession({ id: 'session-turn-id-promotion' }),
    });

    const submission = await submitAgentTurnInternal({
      deps,
      request: {
        sessionId: 'session-turn-id-promotion',
        prompt: 'Promote id',
        clientTurnId: 'client-turn-promoted',
      },
    });

    expect(submission.turnId).toBe('client-turn-promoted');
    await submission.startup;

    const busyPersistSession = upsertSession.mock.calls[0]?.[0] as AgentSession;
    const busyUserMessage = busyPersistSession.messages.find((message) => message.role === 'user');
    expect(busyUserMessage?.turnId).toBe('client-turn-promoted');
    expect(busyPersistSession.messages.every((message) => message.turnId !== '__pending__')).toBe(true);

    const listener = getEventListener();
    if (!listener) throw new Error('Expected event listener to be registered');

    await listener({
      type: 'result',
      text: 'done',
      timestamp: Date.now(),
    });
    await expect(submission.completion).resolves.toMatchObject({
      outcome: 'result',
      persisted: true,
    });
  });

  it('replays buffered events to late subscribers and streams future events', async () => {
    const { deps, getEventListener } = createDeps({
      session: makeSession({ id: 'session-stream' }),
    });

    const submission = await submitAgentTurnInternal({
      deps,
      request: {
        sessionId: 'session-stream',
        prompt: 'Stream test prompt',
      },
    });

    await submission.startup;

    const listener = getEventListener();
    if (!listener) throw new Error('Expected event listener to be registered');

    await listener({
      type: 'assistant',
      text: 'Buffered event',
      timestamp: Date.now(),
    });

    const streamedTypes: string[] = [];
    submission.subscribe((event) => {
      streamedTypes.push(event.type);
    });

    await listener({
      type: 'result',
      text: 'Final answer',
      timestamp: Date.now() + 1,
    });

    await expect(submission.completion).resolves.toMatchObject({
      outcome: 'result',
      persisted: true,
    });
    expect(streamedTypes).toEqual(['assistant', 'result']);
  });

  it('persists companion-trigger metadata on the user message through session schema round-trip', async () => {
    const { deps, upsertSession, getEventListener } = createDeps({
      session: makeSession({ id: 'session-trigger-meta' }),
    });

    const submission = await submitAgentTurnInternal({
      deps,
      request: {
        sessionId: 'session-trigger-meta',
        prompt: 'What changed?',
        triggerMeta: {
          triggerSource: 'voice-trigger',
          triggerSourceSpeaker: 'unknown',
          triggeredAt: 42_000,
          triggerExtracted: 'What changed?',
        },
      },
    });

    await submission.startup;

    const busyPersistSession = upsertSession.mock.calls[0]?.[0] as AgentSession;
    const busyUserMessage = busyPersistSession.messages.find((message) => message.role === 'user');
    expect(busyUserMessage).toMatchObject({
      text: 'What changed?',
      triggerSource: 'voice-trigger',
      triggerSourceSpeaker: 'unknown',
      triggeredAt: 42_000,
      triggerExtracted: 'What changed?',
    });

    const listener = getEventListener();
    if (!listener) throw new Error('Expected event listener to be registered');

    await listener({
      type: 'result',
      text: 'The timeline changed.',
      timestamp: Date.now(),
    });

    await expect(submission.completion).resolves.toMatchObject({
      outcome: 'result',
      persisted: true,
    });

    const finalPersistSession = upsertSession.mock.calls.at(-1)?.[0] as AgentSession;
    const roundTripped = AgentSessionSchema.parse(JSON.parse(JSON.stringify(finalPersistSession)));
    const persistedUserMessage = roundTripped.messages.find((message) => message.role === 'user');
    expect(persistedUserMessage).toMatchObject({
      text: 'What changed?',
      triggerSource: 'voice-trigger',
      triggerSourceSpeaker: 'unknown',
      triggeredAt: 42_000,
      triggerExtracted: 'What changed?',
    });
  });

  it('reports persistence failure in completion without throwing from submit', async () => {
    const upsertSession = vi.fn(async (session: AgentSession) => {
      if (!session.isBusy) {
        throw new Error('persist failed');
      }
    });
    const { deps, getEventListener } = createDeps({
      session: makeSession({ id: 'session-persist-failure' }),
      upsertSession,
    });

    const submission = await submitAgentTurnInternal({
      deps,
      request: {
        sessionId: 'session-persist-failure',
        prompt: 'Persist failure prompt',
      },
    });

    await submission.startup;

    const listener = getEventListener();
    if (!listener) throw new Error('Expected event listener to be registered');

    await listener({
      type: 'result',
      text: 'Will fail to persist',
      timestamp: Date.now(),
    });

    await expect(submission.completion).resolves.toMatchObject({
      outcome: 'result',
      persisted: false,
      persistenceError: 'persist failed',
    });
  });

  it('re-exports the canonical core submitAgentTurnInternal reference', () => {
    expect(submitAgentTurnInternal).toBe(submitAgentTurnInternalCore);
  });
});
