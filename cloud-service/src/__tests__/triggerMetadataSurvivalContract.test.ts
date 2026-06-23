import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession, AgentTurnRequest } from '@shared/types';
import type { CloudSessionMessage } from '@rebel/shared';
import type { CloudServiceDeps } from '../bootstrap';
import { AgentSessionSchema } from '@shared/ipc/schemas/agent';
import { resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';

const { mockMarkSessionAsCloudActive } = vi.hoisted(() => ({
  mockMarkSessionAsCloudActive: vi.fn<(sessionId: string) => Promise<void>>(async () => undefined),
}));

vi.mock('@core/services/cloudContinuityStateService', () => ({
  markSessionAsCloudActive: (sessionId: string) => mockMarkSessionAsCloudActive(sessionId),
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

import { submitAgentTurnInternal } from '../services/agentTurnSubmissionService';

function makeSession(id: string): AgentSession {
  const now = Date.now();
  return {
    id,
    title: 'Trigger Metadata Contract',
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

function createDeps(sessionId: string): {
  deps: CloudServiceDeps;
  upsertSession: ReturnType<typeof vi.fn>;
  getEventListener: () => ((event: AgentEvent) => Promise<void>) | null;
} {
  let eventListener: ((event: AgentEvent) => Promise<void>) | null = null;
  const session = makeSession(sessionId);
  const upsertSession = vi.fn(async () => undefined);

  const deps = {
    startAgentTurn: vi.fn((_serviceDeps: unknown, request: AgentTurnRequest) => ({
      turnId: `turn-${request.sessionId}`,
    })),
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
    upsertSession,
    getEventListener: () => eventListener,
  };
}

function toCloudSessionMessage(message: AgentSession['messages'][number]): CloudSessionMessage {
  return {
    id: message.id,
    turnId: message.turnId,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    isHidden: message.isHidden,
    triggerSource: message.triggerSource,
    triggerSourceSpeaker: message.triggerSourceSpeaker,
    triggeredAt: message.triggeredAt,
    triggerExtracted: message.triggerExtracted,
  };
}

describe('trigger metadata survival contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionSeqIndexForTests();
    resetSessionMutexForTests();
  });

  it('preserves all canonical trigger fields through submission, persistence, schema parse, and DTO mapping', async () => {
    const { deps, upsertSession, getEventListener } = createDeps('session-trigger-survival');

    const submission = await submitAgentTurnInternal({
      deps,
      request: {
        sessionId: 'session-trigger-survival',
        prompt: 'What is the elephant in the room?',
        triggerMeta: {
          triggerSource: 'voice-trigger',
          triggerSourceSpeaker: 'unknown',
          triggeredAt: 1_778_617_200_000,
          triggerExtracted: 'What is the elephant in the room?',
        },
      },
    });

    await submission.startup;
    const listener = getEventListener();
    if (!listener) throw new Error('Expected turn listener');
    await listener({
      type: 'result',
      text: 'The timeline risk is the elephant in the room.',
      timestamp: Date.now(),
    });
    await submission.completion;

    const finalPersist = upsertSession.mock.calls.at(-1)?.[0] as AgentSession;
    const parsed = AgentSessionSchema.parse(JSON.parse(JSON.stringify(finalPersist)));
    const persistedUserMessage = parsed.messages.find((message) => message.role === 'user');
    expect(persistedUserMessage).toMatchObject({
      triggerSource: 'voice-trigger',
      triggerSourceSpeaker: 'unknown',
      triggeredAt: 1_778_617_200_000,
      triggerExtracted: 'What is the elephant in the room?',
    });

    if (!persistedUserMessage) throw new Error('Expected persisted user message');
    const dtoMessage = toCloudSessionMessage(persistedUserMessage);
    expect(dtoMessage).toMatchObject({
      triggerSource: 'voice-trigger',
      triggerSourceSpeaker: 'unknown',
      triggeredAt: 1_778_617_200_000,
      triggerExtracted: 'What is the elephant in the room?',
    });
  });
});
