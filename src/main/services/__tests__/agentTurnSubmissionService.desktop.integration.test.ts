import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession, AgentTurnRequest, AppSettings } from '@shared/types';
import { resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import { setPushNotificationSinkFactory } from '@core/pushNotificationSink';
import {
  submitAgentTurnInternal,
  setAgentTurnSubmissionEnvironment,
  resetAgentTurnSubmissionEnvironmentForTesting,
  type AgentTurnSubmissionDeps,
} from '@core/services/agentTurnSubmissionService';
import { NoOpPushNotificationSink } from '../pushNotificationSink/noOpPushNotificationSink';

const { mockMarkSessionAsCloudActive } = vi.hoisted(() => ({
  mockMarkSessionAsCloudActive: vi.fn<(sessionId: string) => Promise<void>>(async () => undefined),
}));

 
vi.mock('@core/services/cloudContinuityStateService', () => ({
  markSessionAsCloudActive: (sessionId: string) => mockMarkSessionAsCloudActive(sessionId),
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

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  const now = Date.now();
  return {
    id: 'desktop-session',
    title: 'Desktop Session',
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
  upsertSession?: (session: AgentSession) => Promise<void>;
} = {}): {
  deps: AgentTurnSubmissionDeps;
  getEventListener: () => ((event: AgentEvent) => void) | null;
} {
  let eventListener: ((event: AgentEvent) => void) | null = null;
  const session = options.session ?? makeSession();

  const upsertSession = options.upsertSession ?? (async () => undefined);

  const deps = {
    startAgentTurn: vi.fn((_serviceDeps: unknown, request: AgentTurnRequest) => ({
      turnId: `turn-${request.sessionId}`,
    })),
    subscribeTurnEvents: vi.fn((_turnId: string, listener: (event: AgentEvent) => void) => {
      eventListener = listener;
      return () => {
        if (eventListener === listener) {
          eventListener = null;
        }
      };
    }),
    agentTurnServiceDeps: {} as AgentTurnSubmissionDeps['agentTurnServiceDeps'],
    getSession: vi.fn(async () => cloneSession(session)),
    upsertSession,
    getSettings: vi.fn(() => ({} as AppSettings)),
  } satisfies AgentTurnSubmissionDeps;

  return {
    deps,
    getEventListener: () => eventListener,
  };
}

describe('desktop push notification sink integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionSeqIndexForTests();
    resetSessionMutexForTests();
    resetAgentTurnSubmissionEnvironmentForTesting();
  });

  it('does not invoke push notifications during desktop turn completion with NoOpPushNotificationSink', async () => {
    const sink = new NoOpPushNotificationSink();
    const pushSpy = vi.spyOn(sink, 'sendPushNotification');

    setPushNotificationSinkFactory(() => sink);
    setAgentTurnSubmissionEnvironment({
      eventWindow: null,
      getConnectedClientCount: () => 0,
      buildMeetingTranscriptContext: () => null,
    });

    const { deps, getEventListener } = createDeps({
      session: makeSession({ id: 'desktop-noop' }),
    });

    const submission = await submitAgentTurnInternal({
      deps,
      request: {
        sessionId: 'desktop-noop',
        prompt: 'Desktop turn completion',
      },
    });

    await submission.startup;

    const listener = getEventListener();
    if (!listener) throw new Error('Expected event listener to be registered');

    await listener({
      type: 'result',
      text: 'Desktop done',
      timestamp: Date.now(),
    });

    await expect(submission.completion).resolves.toMatchObject({
      outcome: 'result',
      persisted: true,
    });
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('streams thinking_delta live but does not persist it in eventsByTurn', async () => {
    const sink = new NoOpPushNotificationSink();
    setPushNotificationSinkFactory(() => sink);
    setAgentTurnSubmissionEnvironment({
      eventWindow: null,
      getConnectedClientCount: () => 0,
      buildMeetingTranscriptContext: () => null,
    });

    const persistedWrites: AgentSession[] = [];
    const { deps, getEventListener } = createDeps({
      session: makeSession({ id: 'desktop-thinking-transient' }),
      upsertSession: async (nextSession) => {
        persistedWrites.push(cloneSession(nextSession));
      },
    });

    const submission = await submitAgentTurnInternal({
      deps,
      request: {
        sessionId: 'desktop-thinking-transient',
        prompt: 'Test transient thinking delta persistence',
      },
    });

    const streamedEvents: AgentEvent[] = [];
    const unsubscribe = submission.subscribe((event) => {
      streamedEvents.push(event);
    }, { replayBuffered: false });

    await submission.startup;

    const listener = getEventListener();
    if (!listener) throw new Error('Expected event listener to be registered');

    await listener({
      type: 'thinking_delta',
      text: 'live thought',
      timestamp: Date.now(),
    });
    await listener({
      type: 'result',
      text: 'done',
      timestamp: Date.now() + 1,
    });

    await expect(submission.completion).resolves.toMatchObject({
      outcome: 'result',
      persisted: true,
    });
    unsubscribe();

    expect(streamedEvents.map((event) => event.type)).toEqual(['thinking_delta', 'result']);
    expect(streamedEvents[0]?.seq).toBe(1);
    expect(streamedEvents[1]?.seq).toBe(2);

    const finalPersisted = persistedWrites.at(-1);
    expect(finalPersisted).toBeDefined();
    const persistedTurnEvents = finalPersisted?.eventsByTurn[submission.turnId] ?? [];
    expect(persistedTurnEvents.some((event) => event.type === 'thinking_delta')).toBe(false);
    expect(persistedTurnEvents.some((event) => event.type === 'result')).toBe(true);
    const persistedResult = persistedTurnEvents.find((event) => event.type === 'result');
    expect(persistedResult?.seq).toBe(2);
  });
});
