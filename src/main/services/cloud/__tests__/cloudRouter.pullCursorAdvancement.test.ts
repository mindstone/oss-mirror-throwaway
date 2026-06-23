import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setErrorReporter } from '@core/errorReporter';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import { resetSessionSeqIndexForTests } from '@core/services/sessionSeqIndex';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import type { SlackThreadContext } from '@core/services/externalConversation/externalContext';
import type { AgentEvent, AgentSession, AppSettings } from '@shared/types';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-router-pull-cursor',
}));

 
vi.mock('@core/logger', () => {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createScopedLogger: vi.fn(() => logger),
    logger,
  };
});

let currentSession: AgentSession | null = null;
const mockGetSession = vi.fn(async () => currentSession);
const mockUpsertSession = vi.fn(async (session: AgentSession) => {
  currentSession = session;
});
 
vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    getSession: mockGetSession,
    upsertSession: mockUpsertSession,
    listSessions: vi.fn(() => []),
    deleteSession: vi.fn(),
  }),
}));

 
vi.mock('../cloudContinuityMetadata', () => ({
  getContinuityEntry: vi.fn(() => null),
  markCloudActive: vi.fn(),
  touchCloudActivity: vi.fn(),
  restoreContinuityEntrySnapshot: vi.fn(),
  flushContinuityMetadata: vi.fn(async () => ({ success: true })),
}));

 
vi.mock('../cloudSyncMetadata', () => ({
  markCloudSynced: vi.fn(),
}));

 
vi.mock('../../conversationIndexService', () => ({
  onSessionsSaved: vi.fn(async () => undefined),
}));

import { CloudRouter } from '../cloudRouter';
import { cloudOutbox } from '../cloudOutbox';

const OUTBOX_DIR = path.join('/tmp/test-cloud-router-pull-cursor', 'sessions');

function settings(): AppSettings {
  return {
    coreDirectory: '/tmp/core',
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {} as AppSettings['voice'],
    claude: {} as AppSettings['claude'],
    diagnostics: {} as AppSettings['diagnostics'],
    cloudInstance: {
      mode: 'cloud',
      cloudUrl: 'https://rebel-test.fly.dev',
      cloudToken: 'placeholder',
    },
  } as AppSettings;
}

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Test',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    eventsByTurn: {},
    maxSeq: 0,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

function statusEvent(seq: number, turnLabel = 'event', timestamp = seq): AgentEvent {
  return { type: 'status', message: `${turnLabel}-${seq}`, timestamp, seq };
}

function seqs(turnId: string): number[] {
  return (currentSession?.eventsByTurn?.[turnId] ?? [])
    .map((event) => event.seq)
    .filter((seq): seq is number => typeof seq === 'number');
}

function routerWithPulledSession(pulled: AgentSession): CloudRouter {
  const router = new CloudRouter();
  router.init({ getSettings: settings });
  (router as unknown as { httpClient: { get: ReturnType<typeof vi.fn>; disconnect: () => void } }).httpClient = {
    get: vi.fn().mockResolvedValue(pulled),
    disconnect: vi.fn(),
  };
  return router;
}

function deltaClient() {
  return {
    getServerCapabilities: vi.fn().mockResolvedValue({
      supportsDeltaPush: true,
      supportsMetadataPatch: true,
      raw: ['session-event-delta-push', 'session-metadata-patch'],
    }),
    post: vi.fn().mockResolvedValue({ appliedSeq: [10, 11, 12, 13], serverSeq: 13, cloudUpdatedAt: 130 }),
    put: vi.fn().mockResolvedValue({ serverSeq: 13, cloudUpdatedAt: 130 }),
    patch: vi.fn().mockResolvedValue({ cloudUpdatedAt: 130 }),
    delete: vi.fn(),
  };
}

describe('CloudRouter pull-side cursor advancement gating', () => {
  beforeEach(() => {
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
    cloudOutbox._resetForTesting();
    resetSessionSeqIndexForTests();
    conversationScopeResolver.clearAll();
    currentSession = null;
    mockGetSession.mockClear();
    mockUpsertSession.mockClear();
    setErrorReporter({ captureException: () => {}, captureMessage: () => {}, addBreadcrumb: () => {} });
  });

  afterEach(() => {
    cloudOutbox._resetForTesting();
    resetSessionMutexForTests();
    resetSessionSeqIndexForTests();
    conversationScopeResolver.clearAll();
    setErrorReporter({ captureException: () => {}, captureMessage: () => {}, addBreadcrumb: () => {} });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  it('restamps offline local-only events above pulled cloud-native seqs before advancing the cursor', async () => {
    currentSession = session({
      updatedAt: 20,
      maxSeq: 9,
      eventsByTurn: {
        'turn-local': [6, 7, 8, 9].map((seq) => statusEvent(seq, 'local')),
      },
    });
    cloudOutbox.recordLastPushedSeq('session-1', 5);
    const pulled = session({
      updatedAt: 30,
      maxSeq: 9,
      cloudUpdatedAt: 90,
      eventsByTurn: {
        'turn-cloud': [6, 7, 8, 9].map((seq) => statusEvent(seq, 'cloud')),
      },
    });

    await routerWithPulledSession(pulled).syncSessionFromCloud('session-1');

    expect(seqs('turn-local')).toEqual([10, 11, 12, 13]);
    expect(seqs('turn-cloud')).toEqual([6, 7, 8, 9]);
    expect(cloudOutbox.getLastPushedSeq('session-1')).toBe(9);

    cloudOutbox.enqueue('session-1', 'upsert');
    const client = deltaClient();
    await cloudOutbox.drain(client);

    const body = client.post.mock.calls[0][1] as { baseSeq: number; events: Array<{ turnId: string }> };
    expect(body.baseSeq).toBe(9);
    expect(body.events).toHaveLength(4);
    expect(body.events.every((event) => event.turnId === 'turn-local')).toBe(true);
  });

  it('advances the cursor cleanly when there are no local unpushed events to restamp', async () => {
    currentSession = session({
      updatedAt: 20,
      maxSeq: 5,
      eventsByTurn: {
        'turn-old': [1, 2, 3, 4, 5].map((seq) => statusEvent(seq, 'old')),
      },
    });
    cloudOutbox.recordLastPushedSeq('session-1', 5);
    const pulled = session({
      updatedAt: 30,
      maxSeq: 9,
      cloudUpdatedAt: 90,
      eventsByTurn: {
        'turn-old': [1, 2, 3, 4, 5].map((seq) => statusEvent(seq, 'old')),
        'turn-cloud': [6, 7, 8, 9].map((seq) => statusEvent(seq, 'cloud')),
      },
    });

    await routerWithPulledSession(pulled).syncSessionFromCloud('session-1');

    expect(seqs('turn-old')).toEqual([1, 2, 3, 4, 5]);
    expect(seqs('turn-cloud')).toEqual([6, 7, 8, 9]);
    expect(cloudOutbox.getLastPushedSeq('session-1')).toBe(9);
  });

  it('does not restamp local events that are echoed back by pulled identities', async () => {
    const echoedEvents = [6, 7, 8, 9].map((seq) => statusEvent(seq, 'echo'));
    currentSession = session({
      updatedAt: 20,
      maxSeq: 9,
      eventsByTurn: { 'turn-echo': echoedEvents },
    });
    cloudOutbox.recordLastPushedSeq('session-1', 5);
    const pulled = session({
      updatedAt: 30,
      maxSeq: 9,
      cloudUpdatedAt: 90,
      eventsByTurn: { 'turn-echo': echoedEvents },
    });

    await routerWithPulledSession(pulled).syncSessionFromCloud('session-1');

    expect(seqs('turn-echo')).toEqual([6, 7, 8, 9]);
    expect(cloudOutbox.getLastPushedSeq('session-1')).toBe(9);
  });

  it('hydrates conversationScopeResolver with synced slack-thread sessions', async () => {
    const slackThreadContext: SlackThreadContext = {
      kind: 'slack-thread',
      identity: {
        teamId: 'T1',
        channelId: 'C1',
        threadTs: '123.456',
      },
      metadata: {
        userId: 'U1',
      },
    };

    const pulled = session({
      id: 'session-thread-1',
      updatedAt: 30,
      externalContext: slackThreadContext,
    });

    await routerWithPulledSession(pulled).syncSessionFromCloud('session-thread-1');

    expect(conversationScopeResolver.lookup(slackThreadContext)).toEqual({
      conversationId: 'session-thread-1',
    });
  });
});
