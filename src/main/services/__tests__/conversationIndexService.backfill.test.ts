/**
 * Tests for the summary-driven backfill helpers in conversationIndexService.
 *
 * Covers:
 * - shouldEmbedSummary() — summary-level eligibility filtering
 * - shouldEmbedSession() — full session eligibility (existing, verified here for completeness)
 * - backfillConversationEmbeddings() ghost-pruning behavior
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionSummary, AgentSession } from '@shared/types';
import { setEmbeddingGeneratorFactory } from '@core/embeddingGenerator';

const testState = vi.hoisted(() => ({
  dataPath: '/tmp/conversation-index-backfill-test',
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  store: {
    listSessions: vi.fn(),
    getSession: vi.fn(),
    sessionFileExists: vi.fn(),
    deleteSession: vi.fn(),
    refreshSessionIndexSummaries: vi.fn(),
  },
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({ isPackaged: false, userDataPath: '/tmp/test', version: '0.0.0' }),
}));
vi.mock('@core/lazyElectron', () => ({
  onElectronAppEvent: vi.fn(),
}));
vi.mock('@core/logger', () => ({
  logger: testState.log,
  createScopedLogger: () => testState.log,
}));
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: vi.fn(() => testState.dataPath),
  isPackaged: vi.fn(() => false),
}));
vi.mock('./embeddingService', () => ({
  generateEmbedding: vi.fn(async () => new Float32Array(384).fill(0.01)),
  generateQueryEmbedding: vi.fn(async () => new Float32Array(384).fill(0.01)),
  _generateEmbedding: vi.fn(),
  _getEmbeddingDimensions: vi.fn(() => 384),
}));
vi.mock('./fileIndexService', () => ({
  cosineDistance: vi.fn(() => 0),
}));
vi.mock('../utils/emfileRetry', () => ({
  isTooManyOpenFilesError: vi.fn(() => false),
}));
vi.mock('../utils/enfileState', () => ({
  isEnfileActive: vi.fn(() => false),
  markEnfileDetected: vi.fn((_error?: unknown) => ({ isFirstDetection: false })),
}));
// Stage 6 Phase 6 (260508): conversationIndexService now imports
// `waitForTurnIdle` and `isAnyTurnActive`; stub as no-ops because this
// test never exercises the active-turn idle-gating path.
vi.mock('./visibilityAwareScheduler', () => ({
  createPausableInterval: vi.fn(() => () => {}),
  waitForTurnIdle: vi.fn(async () => 'idle' as const),
  isAnyTurnActive: vi.fn(() => false),
}));
vi.mock('./incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => testState.store,
  countUserMessages: (session: { messages: Array<{ role: string }> }) =>
    session.messages.filter((message) => message.role === 'user').length,
}));
vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => testState.store,
  countUserMessages: (session: { messages: Array<{ role: string }> }) =>
    session.messages.filter((message) => message.role === 'user').length,
}));
vi.mock('@core/services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => testState.store,
  countUserMessages: (session: { messages: Array<{ role: string }> }) =>
    session.messages.filter((message) => message.role === 'user').length,
}));

import {
  backfillConversationEmbeddings,
  _checkStaleEmbeddingsForTesting,
  closeConversationIndex,
  embedConversation,
  isSessionEmbedded,
  shouldEmbedSummary,
  shouldEmbedSession
} from '../conversationIndexService';

function makeSummary(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    id: 'test-id',
    title: 'Test Session',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    isCorrupted: false,
    preview: 'test preview',
    messageCount: 2,
    hasUserMessages: true,
    hasDraft: false,
    draftPreview: null,
    draftUpdatedAt: null,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    ...overrides,
  };
}

function makeIdleSummary(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return makeSummary({
    id: 'stale-session',
    updatedAt: Date.now() - 10 * 60 * 1000,
    messageCount: 1,
    hasUserMessages: true,
    userMessageCount: 1,
    ...overrides,
  });
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'test-id',
    title: 'Test Session',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: null,
    messages: [{ id: 'm1', role: 'user', text: 'hello', turnId: 't1', createdAt: Date.now() }],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    ...overrides,
  };
}

function makeUserMessage(id: string, text: string) {
  return {
    id,
    role: 'user' as const,
    text,
    turnId: `${id}-turn`,
    createdAt: Date.now(),
  };
}

function getBackfillCompletionStats(): {
  embeddedCount: number;
  loadFailures: number;
  skippedIneligible: number;
  totalCandidates: number;
} {
  const completionCall = testState.log.info.mock.calls.find(
    call => call[1] === 'Conversation embedding backfill complete'
  );
  expect(completionCall).toBeDefined();
  return completionCall![0] as {
    embeddedCount: number;
    loadFailures: number;
    skippedIneligible: number;
    totalCandidates: number;
  };
}

beforeEach(async () => {
  await closeConversationIndex();
  vi.clearAllMocks();

  testState.dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-index-backfill-'));

  testState.store.listSessions.mockReturnValue([]);
  testState.store.getSession.mockResolvedValue(null);
  testState.store.sessionFileExists.mockResolvedValue(false);
  testState.store.deleteSession.mockResolvedValue(undefined);
  testState.store.refreshSessionIndexSummaries.mockResolvedValue(0);
  setEmbeddingGeneratorFactory(() => ({
    generateEmbedding: vi.fn(async () => new Float32Array(384).fill(0.01)),
    generateQueryEmbedding: vi.fn(async () => new Float32Array(384).fill(0.01)),
    generateEmbeddings: vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array(384).fill(0.01))),
  }));
});

afterEach(async () => {
  await closeConversationIndex();
  await fs.rm(testState.dataPath, { recursive: true, force: true });
});

describe('shouldEmbedSummary', () => {
  it('returns true for eligible summary', () => {
    expect(shouldEmbedSummary(makeSummary())).toBe(true);
  });

  it('returns false for corrupted sessions', () => {
    expect(shouldEmbedSummary(makeSummary({ isCorrupted: true }))).toBe(false);
  });

  it('returns false for private mode sessions', () => {
    expect(shouldEmbedSummary(makeSummary({ privateMode: true }))).toBe(false);
  });

  it('returns true for automation-kind sessions (F7: automations are searchable)', () => {
    expect(shouldEmbedSummary(makeSummary({
      id: 'automation-source-capture--abc123',
      origin: 'manual',
    }))).toBe(true);
  });

  it('does not treat stale automation origin alone as automation', () => {
    expect(shouldEmbedSummary(makeSummary({
      id: 'conversation-origin-drift',
      origin: 'automation',
    }))).toBe(true);
  });

  it('returns false for deleted sessions', () => {
    expect(shouldEmbedSummary(makeSummary({ deletedAt: Date.now() }))).toBe(false);
  });

  it('returns false when hasUserMessages is explicitly false', () => {
    expect(shouldEmbedSummary(makeSummary({ hasUserMessages: false }))).toBe(false);
  });

  it('returns true when hasUserMessages is undefined (older index entries)', () => {
    expect(shouldEmbedSummary(makeSummary({ hasUserMessages: undefined }))).toBe(true);
  });

  it('returns true for non-manual origins that are not automation', () => {
    expect(shouldEmbedSummary(makeSummary({ origin: 'mcp-tool' }))).toBe(true);
    expect(shouldEmbedSummary(makeSummary({ origin: 'inbound-trigger' }))).toBe(true);
    expect(shouldEmbedSummary(makeSummary({ origin: 'plugin' }))).toBe(true);
  });
});

describe('shouldEmbedSession', () => {
  it('returns true for eligible session with user messages', () => {
    expect(shouldEmbedSession(makeSession())).toBe(true);
  });

  it('returns false for session with no user messages', () => {
    const session = makeSession({
      messages: [{ id: 'm1', role: 'assistant', text: 'hi', turnId: 't1', createdAt: Date.now() }],
    });
    expect(shouldEmbedSession(session)).toBe(false);
  });

  it('returns false for corrupted session', () => {
    expect(shouldEmbedSession(makeSession({ isCorrupted: true }))).toBe(false);
  });

  it('returns false for deleted session', () => {
    expect(shouldEmbedSession(makeSession({ deletedAt: Date.now() }))).toBe(false);
  });

  it('returns true for automation-kind sessions (F7: automations are searchable)', () => {
    expect(shouldEmbedSession(makeSession({
      id: 'automation-source-capture--abc123',
      origin: 'manual',
    }))).toBe(true);
  });

  it('does not treat stale automation origin alone as automation', () => {
    expect(shouldEmbedSession(makeSession({
      id: 'conversation-origin-drift',
      origin: 'automation',
    }))).toBe(true);
  });
});

describe('backfillConversationEmbeddings ghost pruning', () => {
  it('prunes true ghost sessions and removes conversation embeddings when present', async () => {
    const summary = makeSummary({ id: 'ghost-embedded' });
    testState.store.listSessions.mockReturnValue([summary]);
    testState.store.sessionFileExists.mockResolvedValue(false);
    testState.store.getSession.mockImplementation(async (sessionId: string) => {
      await embedConversation(makeSession({ id: sessionId, title: 'Embedded During Backfill' }));
      return null;
    });

    const embeddedCount = await backfillConversationEmbeddings({ batchSize: 100, delayMs: 0 });

    expect(embeddedCount).toBe(0);
    expect(testState.store.deleteSession).toHaveBeenCalledWith(summary.id, { intent: 'hygiene' });
    expect(isSessionEmbedded(summary.id)).toBe(false);
    expect(testState.log.warn).toHaveBeenCalledWith(
      { sessionId: summary.id },
      'Backfill: ghost session detected (file confirmed missing) — pruning'
    );
  });

  it('prunes true ghost sessions but skips removeConversation when not embedded', async () => {
    const seedSession = makeSession({ id: 'seed-session' });
    await embedConversation(seedSession); // Ensure table exists to detect accidental removeConversation calls

    const summary = makeSummary({ id: 'ghost-not-embedded' });
    testState.store.listSessions.mockReturnValue([summary]);
    testState.store.getSession.mockResolvedValue(null);
    testState.store.sessionFileExists.mockResolvedValue(false);

    await backfillConversationEmbeddings({ batchSize: 100, delayMs: 0 });

    expect(testState.store.deleteSession).toHaveBeenCalledWith(summary.id, { intent: 'hygiene' });
    expect(testState.log.debug).not.toHaveBeenCalledWith(
      { sessionId: summary.id },
      'Removed conversation from index'
    );
  });

  it('skips pruning when session file exists but is unreadable', async () => {
    const summary = makeSummary({ id: 'unreadable-session' });
    testState.store.listSessions.mockReturnValue([summary]);
    testState.store.getSession.mockResolvedValue(null);
    testState.store.sessionFileExists.mockResolvedValue(true);

    await backfillConversationEmbeddings({ batchSize: 100, delayMs: 0 });

    expect(testState.store.deleteSession).not.toHaveBeenCalled();
    expect(testState.log.debug).toHaveBeenCalledWith(
      { sessionId: summary.id },
      'Backfill: session file exists but unreadable, skipping'
    );
    expect(getBackfillCompletionStats().loadFailures).toBe(1);
  });

  it('isolates pruning failures so backfill continues', async () => {
    const summaryA = makeSummary({ id: 'ghost-prune-fail' });
    const summaryB = makeSummary({ id: 'ghost-prune-succeeds' });

    testState.store.listSessions.mockReturnValue([summaryA, summaryB]);
    testState.store.getSession.mockResolvedValue(null);
    testState.store.sessionFileExists.mockResolvedValue(false);
    testState.store.deleteSession
      .mockRejectedValueOnce(new Error('delete failed'))
      .mockResolvedValue(undefined);

    const embeddedCount = await backfillConversationEmbeddings({ batchSize: 100, delayMs: 0 });

    expect(embeddedCount).toBe(0);
    expect(testState.store.deleteSession).toHaveBeenNthCalledWith(1, summaryA.id, { intent: 'hygiene' });
    expect(testState.store.deleteSession).toHaveBeenNthCalledWith(2, summaryB.id, { intent: 'hygiene' });
    expect(testState.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: summaryA.id, err: expect.any(Error) }),
      'Failed to prune ghost session — will retry next backfill'
    );
  });

  it('increments loadFailures for every null-session case', async () => {
    const missingSummary = makeSummary({ id: 'ghost-missing' });
    const unreadableSummary = makeSummary({ id: 'ghost-unreadable' });
    const pruneErrorSummary = makeSummary({ id: 'ghost-prune-error' });

    testState.store.listSessions.mockReturnValue([missingSummary, unreadableSummary, pruneErrorSummary]);
    testState.store.getSession.mockResolvedValue(null);
    testState.store.sessionFileExists.mockImplementation(async (sessionId: string) => {
      return sessionId === unreadableSummary.id;
    });
    testState.store.deleteSession.mockImplementation(async (sessionId: string) => {
      if (sessionId === pruneErrorSummary.id) {
        throw new Error('prune failed');
      }
    });

    await backfillConversationEmbeddings({ batchSize: 100, delayMs: 0 });

    const stats = getBackfillCompletionStats();
    expect(stats.loadFailures).toBe(3);
    expect(testState.store.deleteSession).toHaveBeenCalledTimes(2);
  });
});

describe('checkStaleEmbeddings summary count gate', () => {
  it('forces one full verification pass, then skips unchanged summaries by user message count', async () => {
    const session = makeSession({
      id: 'stale-session',
      updatedAt: Date.now() - 10 * 60 * 1000,
      messages: [makeUserMessage('u1', 'original')],
    });
    const summary = makeIdleSummary({ id: session.id, userMessageCount: 1 });

    await embedConversation(session);
    testState.store.listSessions.mockReturnValue([summary]);
    testState.store.getSession.mockResolvedValue(session);

    await _checkStaleEmbeddingsForTesting();
    expect(testState.store.getSession).toHaveBeenCalledWith(session.id);

    testState.store.getSession.mockClear();
    await _checkStaleEmbeddingsForTesting();

    expect(testState.store.getSession).not.toHaveBeenCalled();
    expect(testState.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        summaries: 1,
        gateSkipped: 1,
        loaded: 0,
        reembedded: 0,
      }),
      'Stale embedding check complete',
    );
  });

  it('admits sessions whose summary count crosses the re-embed delta threshold', async () => {
    const originalSession = makeSession({
      id: 'stale-session',
      updatedAt: Date.now() - 10 * 60 * 1000,
      messages: [makeUserMessage('u1', 'original')],
    });
    const grownSession = makeSession({
      id: originalSession.id,
      updatedAt: Date.now() - 10 * 60 * 1000,
      messages: [
        makeUserMessage('u1', 'original'),
        makeUserMessage('u2', 'second'),
        makeUserMessage('u3', 'third'),
      ],
    });

    await embedConversation(originalSession);
    testState.store.listSessions.mockReturnValue([
      makeIdleSummary({
        id: originalSession.id,
        messageCount: grownSession.messages.length,
        userMessageCount: 3,
      }),
    ]);
    testState.store.getSession.mockResolvedValue(grownSession);

    await _checkStaleEmbeddingsForTesting();

    expect(testState.store.getSession).toHaveBeenCalledWith(originalSession.id);
    expect(testState.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        summaries: 1,
        gateSkipped: 0,
        loaded: 1,
        reembedded: 1,
      }),
      'Stale embedding check complete',
    );
  });

  it('loads missing userMessageCount summaries once and refreshes the index entry for later skips', async () => {
    const session = makeSession({
      id: 'legacy-summary-session',
      updatedAt: Date.now() - 10 * 60 * 1000,
      messages: [makeUserMessage('u1', 'legacy summary')],
    });
    const summary = makeIdleSummary({
      id: session.id,
      userMessageCount: undefined,
    });

    await embedConversation(session);
    testState.store.listSessions.mockReturnValue([summary]);
    testState.store.getSession.mockResolvedValue(session);
    testState.store.refreshSessionIndexSummaries.mockImplementation(async (sessions: AgentSession[]) => {
      summary.userMessageCount = sessions[0]?.messages.filter((message) => message.role === 'user').length;
      return sessions.length;
    });

    await _checkStaleEmbeddingsForTesting();

    expect(testState.store.getSession).toHaveBeenCalledWith(session.id);
    expect(testState.store.refreshSessionIndexSummaries).toHaveBeenCalledWith([session]);

    testState.store.getSession.mockClear();
    testState.store.refreshSessionIndexSummaries.mockClear();

    await _checkStaleEmbeddingsForTesting();

    expect(testState.store.getSession).not.toHaveBeenCalled();
    expect(testState.store.refreshSessionIndexSummaries).not.toHaveBeenCalled();
    expect(testState.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        summaries: 1,
        gateSkipped: 1,
        loaded: 0,
        reembedded: 0,
      }),
      'Stale embedding check complete',
    );
  });
});
