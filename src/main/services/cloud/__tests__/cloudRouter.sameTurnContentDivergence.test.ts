/**
 * Branch-level routing test for the REBEL-6C0 / REBEL-6BZ same-turn-content
 * divergence fix (Stage 1).
 *
 * The unit tests in cloudSessionMerge.test.ts verify the `localHasContentCloudLacks`
 * predicate and `mergeSessionTurns` in isolation. This test drives the ACTUAL
 * `syncSessionFromCloud` routing end-to-end (testing-reviewer F1) and asserts
 * which branch fired — additive merge (preserves the local final answer) vs the
 * destructive full-replace (drops it) — by inspecting what got written to the
 * local store. So the wiring isn't only TS-verified.
 *
 * Harness pattern mirrors cloudRouter.pullCursorAdvancement.test.ts: `currentSession`
 * is the local on-disk session; the pulled cloud snapshot is injected via the
 * router's httpClient.get; after syncSessionFromCloud, `currentSession` reflects
 * what was persisted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setErrorReporter } from '@core/errorReporter';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import { resetSessionSeqIndexForTests } from '@core/services/sessionSeqIndex';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import type { AgentEvent, AgentSession, AppSettings } from '@shared/types';

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-router-same-turn-divergence',
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

const DATA_DIR = '/tmp/test-cloud-router-same-turn-divergence';
const OUTBOX_DIR = path.join(DATA_DIR, 'sessions');

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

function msg(id: string, turnId: string, role: 'user' | 'assistant' | 'result', text: string, createdAt: number) {
  return { id, turnId, role, text, createdAt };
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

describe('CloudRouter syncSessionFromCloud — same-turn content divergence routing (REBEL-6C0)', () => {
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

  it('routes the additive merge (NOT the destructive full-replace) when cloud is same-turn-poorer, preserving the local final answer on disk', async () => {
    // Local on disk: turn-T has [user, preamble, finalAnswer(result)] plus a
    // higher-seq terminal result event.
    const localResultEvent: AgentEvent = { type: 'result', text: 'big final answer', timestamp: 5, seq: 5 } as AgentEvent;
    currentSession = session({
      updatedAt: 1000,
      maxSeq: 5,
      messages: [
        msg('m-user', 'turn-T', 'user', 'question', 100),
        msg('m-preamble', 'turn-T', 'assistant', 'Let me look…', 200),
        msg('m-answer', 'turn-T', 'result', 'big final answer', 300),
      ],
      eventsByTurn: { 'turn-T': [localResultEvent] },
    });

    // Cloud snapshot: SAME turn-T but only [user, preamble], a stale lower-seq
    // event, and updatedAt newer (the chronologically-newer-but-semantically-older
    // shape that defeats skipUpsert). This is the exact REBEL-6C0 scenario.
    const pulled = session({
      updatedAt: 1001,
      maxSeq: 2,
      cloudUpdatedAt: 90,
      messages: [
        msg('m-user', 'turn-T', 'user', 'question', 100),
        msg('m-preamble', 'turn-T', 'assistant', 'Let me look…', 200),
      ],
      eventsByTurn: { 'turn-T': [{ type: 'status', message: 'stale', timestamp: 2, seq: 2 } as AgentEvent] },
    });

    await routerWithPulledSession(pulled).syncSessionFromCloud('session-1');

    // ASSERT: the additive-merge branch fired (NOT the destructive full-replace).
    // The local final answer + result event must survive on disk.
    expect(currentSession).not.toBeNull();
    const persistedAnswer = currentSession!.messages.find((m) => m.id === 'm-answer');
    expect(persistedAnswer).toBeDefined();
    expect(persistedAnswer?.text).toBe('big final answer');
    expect(persistedAnswer?.role).toBe('result');

    // Local events win wholesale for the shared terminal turn — the high-seq
    // result event is retained, the stale cloud status event did NOT replace it.
    expect(currentSession!.eventsByTurn['turn-T']).toContainEqual(localResultEvent);
    expect(currentSession!.eventsByTurn['turn-T'].some((e) => e.type === 'status' && (e as { message?: string }).message === 'stale')).toBe(false);
  });

  it('count-stable case: equal message + equal event-array length but higher local max seq still routes the additive merge (final answer survives on disk)', async () => {
    // The count-stable shape: local has the same NUMBER of non-user messages and
    // the same event-array LENGTH as cloud, but a higher per-turn max seq because
    // mergeResultMessage promoted in-place + appended a higher-seq terminal event.
    const localResultEvent: AgentEvent = { type: 'result', text: 'final', timestamp: 5, seq: 5 } as AgentEvent;
    currentSession = session({
      updatedAt: 1000,
      maxSeq: 5,
      messages: [
        msg('m-user', 'turn-T', 'user', 'question', 100),
        msg('m-answer', 'turn-T', 'result', 'promoted-in-place final answer', 200),
      ],
      eventsByTurn: { 'turn-T': [localResultEvent] },
    });

    const pulled = session({
      updatedAt: 1001,
      maxSeq: 2,
      cloudUpdatedAt: 90,
      messages: [
        msg('m-user', 'turn-T', 'user', 'question', 100),
        msg('m-answer', 'turn-T', 'assistant', 'stale preamble', 200),
      ],
      eventsByTurn: { 'turn-T': [{ type: 'assistant', text: 'stale', timestamp: 2, seq: 2 } as AgentEvent] },
    });

    await routerWithPulledSession(pulled).syncSessionFromCloud('session-1');

    expect(currentSession).not.toBeNull();
    // Local wins on the shared message id (m-answer) — the promoted final answer survives.
    const persistedAnswer = currentSession!.messages.find((m) => m.id === 'm-answer');
    expect(persistedAnswer?.text).toBe('promoted-in-place final answer');
    expect(persistedAnswer?.role).toBe('result');
    // The local high-seq result event survives; the stale cloud event did not replace it.
    expect(currentSession!.eventsByTurn['turn-T']).toContainEqual(localResultEvent);
  });

  it('genuine first-pull (local has nothing for the session) still full-accepts the cloud snapshot', async () => {
    // Sanity check the reserved full-replace path: when local is empty, the cloud
    // snapshot is accepted wholesale (not blocked by the broadened predicate).
    currentSession = null; // no local session on disk

    const pulled = session({
      updatedAt: 1001,
      maxSeq: 3,
      cloudUpdatedAt: 90,
      messages: [
        msg('m-user', 'turn-A', 'user', 'question', 100),
        msg('m-answer', 'turn-A', 'result', 'cloud answer', 200),
      ],
      eventsByTurn: { 'turn-A': [{ type: 'result', text: 'cloud answer', timestamp: 3, seq: 3 } as AgentEvent] },
    });

    await routerWithPulledSession(pulled).syncSessionFromCloud('session-1');

    expect(currentSession).not.toBeNull();
    expect(currentSession!.messages.find((m) => m.id === 'm-answer')?.text).toBe('cloud answer');
  });
});
