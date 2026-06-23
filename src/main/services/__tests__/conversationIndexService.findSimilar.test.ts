import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@shared/types';

const { BASE_EMBEDDING, SIMILAR_1, SIMILAR_2, SIMILAR_3, SIMILAR_4, SIMILAR_5, DIFFERENT, testState } = vi.hoisted(() => {
  function normalize(v: Float32Array): Float32Array {
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (norm === 0) return v;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
    return out;
  }

  function perturbEmbedding(base: Float32Array, noise = 0.05): Float32Array {
    const perturbed = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) {
      perturbed[i] = base[i] + noise * Math.sin(i * 7.3);
    }
    return normalize(perturbed);
  }

  const BASE = normalize(Float32Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.1)));
  const SIM1 = perturbEmbedding(BASE, 0.05);
  const SIM2 = perturbEmbedding(BASE, 0.10);
  const SIM3 = perturbEmbedding(BASE, 0.03);
  const SIM4 = perturbEmbedding(BASE, 0.07);
  const SIM5 = perturbEmbedding(BASE, 0.12);
  const DIFF = normalize(Float32Array.from({ length: 384 }, (_, i) => Math.cos(i * 0.7)));

  return {
    BASE_EMBEDDING: BASE,
    SIMILAR_1: SIM1,
    SIMILAR_2: SIM2,
    SIMILAR_3: SIM3,
    SIMILAR_4: SIM4,
    SIMILAR_5: SIM5,
    DIFFERENT: DIFF,
    testState: {
      dataPath: '/tmp/conversation-index-find-similar-test',
      embeddingSequence: [BASE] as Float32Array[],
      embeddingCallCount: 0,
      generateEmbedding: vi.fn(),
      isTooManyOpenFilesError: vi.fn(() => false),
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
    },
  };
});

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({ isPackaged: false, userDataPath: '/tmp/test', version: '0.0.0' }),
}));
vi.mock('@core/lazyElectron', () => ({
  onElectronAppEvent: vi.fn(),
}));
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: vi.fn(() => testState.dataPath),
  isPackaged: vi.fn(() => false),
}));
vi.mock('../embeddingService', () => ({
  generateEmbedding: testState.generateEmbedding,
  generateQueryEmbedding: vi.fn(async () => new Float32Array(BASE_EMBEDDING)),
  _generateEmbedding: vi.fn(),
  _getEmbeddingDimensions: vi.fn(() => 384),
}));
vi.mock('../fileIndexService', () => ({
  cosineDistance: vi.fn((a: ArrayLike<number> | Iterable<number>, b: ArrayLike<number> | Iterable<number>) => {
    const toArr = (v: ArrayLike<number> | Iterable<number>): number[] =>
      v instanceof Float32Array || Array.isArray(v)
        ? (v as unknown as number[])
        : Array.from(v as Iterable<number>);
    const aArr = toArr(a);
    const bArr = toArr(b);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const length = Math.min(aArr.length, bArr.length);
    for (let i = 0; i < length; i++) {
      const av = aArr[i];
      const bv = bArr[i];
      dot += av * bv;
      normA += av * av;
      normB += bv * bv;
    }

    if (normA === 0 || normB === 0) {
      return 1;
    }

    return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }),
}));
vi.mock('../../utils/emfileRetry', () => ({
  isTooManyOpenFilesError: testState.isTooManyOpenFilesError,
}));
vi.mock('../../utils/enfileState', () => ({
  isEnfileActive: vi.fn(() => false),
  markEnfileDetected: vi.fn((_error?: unknown) => ({ isFirstDetection: false })),
}));
// Stage 6 Phase 6 (260508): conversationIndexService now imports
// `waitForTurnIdle` and `isAnyTurnActive` from visibilityAwareScheduler;
// stub them as no-ops here because this test never exercises the
// active-turn idle-gating path.
vi.mock('../visibilityAwareScheduler', () => ({
  createPausableInterval: vi.fn(() => () => {}),
  waitForTurnIdle: vi.fn(async () => 'idle' as const),
  isAnyTurnActive: vi.fn(() => false),
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

import * as lancedb from '@lancedb/lancedb';
import { setEmbeddingGeneratorFactory } from '@core/embeddingGenerator';
import {
  closeConversationIndex,
  embedConversation,
  findSimilarConversations,
} from '../conversationIndexService';

setEmbeddingGeneratorFactory(() => ({
  generateEmbedding: (text: string) => testState.generateEmbedding(text),
  generateQueryEmbedding: async () => new Float32Array(BASE_EMBEDDING),
  generateEmbeddings: async (texts: string[]) =>
    Promise.all(texts.map(t => testState.generateEmbedding(t))),
}));

function makeSession(id: string, title: string, messages: string[] = ['Hello']): AgentSession {
  return {
    id,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: null,
    doneAt: null,
    origin: 'manual',
    isCorrupted: false,
    messages: messages.map((text, i) => ({
      id: `${id}-msg-${i}`,
      turnId: `${id}-turn-${i}`,
      role: 'user' as const,
      text,
      createdAt: Date.now(),
    })),
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
  };
}

function setEmbeddingSequence(embeddings: Float32Array[]): void {
  testState.embeddingSequence = embeddings;
  testState.embeddingCallCount = 0;
  testState.generateEmbedding.mockImplementation(async () => {
    const embedding =
      testState.embeddingSequence[testState.embeddingCallCount] ??
      testState.embeddingSequence[testState.embeddingSequence.length - 1] ??
      BASE_EMBEDDING;
    testState.embeddingCallCount += 1;
    return new Float32Array(embedding);
  });
}

async function embedSessions(sessions: AgentSession[]): Promise<void> {
  for (const session of sessions) {
    const embedded = await embedConversation(session);
    expect({
      embedded,
      warnCalls: testState.log.warn.mock.calls,
      errorCalls: testState.log.error.mock.calls,
    }).toEqual({
      embedded: true,
      warnCalls: [],
      errorCalls: [],
    });
  }
}

beforeEach(async () => {
  await closeConversationIndex();
  vi.clearAllMocks();

  testState.dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-index-find-similar-'));
  testState.store.listSessions.mockReturnValue([]);
  testState.store.getSession.mockResolvedValue(null);
  testState.store.sessionFileExists.mockResolvedValue(false);
  testState.store.deleteSession.mockResolvedValue(undefined);
  testState.store.refreshSessionIndexSummaries.mockResolvedValue(0);
  testState.isTooManyOpenFilesError.mockReturnValue(false);
  setEmbeddingSequence([BASE_EMBEDDING]);
});

afterEach(async () => {
  await closeConversationIndex();
  await fs.rm(testState.dataPath, { recursive: true, force: true });
});

describe('conversationIndexService.findSimilarConversations', () => {
  it('returns index_not_ready when the index is not initialized', async () => {
    await closeConversationIndex();

    const result = await findSimilarConversations('any-id');

    expect(result).toEqual({
      results: [],
      status: 'index_not_ready',
    });
  });

  it('returns source_not_indexed when the source session is not embedded', async () => {
    setEmbeddingSequence([SIMILAR_1]);
    await embedSessions([makeSession('session-b-id', 'Indexed session', ['Indexed content'])]);

    const result = await findSimilarConversations('session-a-id');

    expect(result).toEqual({
      results: [],
      status: 'source_not_indexed',
    });
  });

  it('returns similar sessions sorted by descending score', async () => {
    setEmbeddingSequence([BASE_EMBEDDING, SIMILAR_1, SIMILAR_2, DIFFERENT]);
    await embedSessions([
      makeSession('source-id', 'Source session', ['Planning notes']),
      makeSession('similar-1-id', 'Nearest match', ['Planning follow-up']),
      makeSession('similar-2-id', 'Second nearest match', ['Another planning follow-up']),
      makeSession('different-id', 'Unrelated session', ['Totally different topic']),
    ]);

    const result = await findSimilarConversations('source-id');

    expect(result.status).toBe('ok');
    expect(result.results.map(item => item.sessionId)).toEqual(['similar-1-id', 'similar-2-id']);
    expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
  });

  it('excludes the source session from the returned results', async () => {
    setEmbeddingSequence([BASE_EMBEDDING, SIMILAR_1, SIMILAR_2]);
    await embedSessions([
      makeSession('source-id', 'Source session', ['Project kickoff']),
      makeSession('similar-1-id', 'Similar session A', ['Project kickoff follow-up']),
      makeSession('similar-2-id', 'Similar session B', ['Project kickoff recap']),
    ]);

    const result = await findSimilarConversations('source-id');

    expect(result.status).toBe('ok');
    expect(result.results.some(item => item.sessionId === 'source-id')).toBe(false);
  });

  it('filters out low-scoring results below the threshold', async () => {
    setEmbeddingSequence([BASE_EMBEDDING, DIFFERENT]);
    await embedSessions([
      makeSession('source-id', 'Source session', ['Quarterly planning']),
      makeSession('different-id', 'Different session', ['Garden notes']),
    ]);

    const result = await findSimilarConversations('source-id');

    expect(result).toEqual({
      results: [],
      status: 'ok',
    });
  });

  it('respects the requested limit', async () => {
    setEmbeddingSequence([BASE_EMBEDDING, SIMILAR_3, SIMILAR_1, SIMILAR_4, SIMILAR_2, SIMILAR_5]);
    await embedSessions([
      makeSession('source-id', 'Source session', ['Go-to-market planning']),
      makeSession('similar-1-id', 'Similar session 1', ['Go-to-market planning notes']),
      makeSession('similar-2-id', 'Similar session 2', ['Go-to-market planning follow-up']),
      makeSession('similar-3-id', 'Similar session 3', ['Go-to-market planning recap']),
      makeSession('similar-4-id', 'Similar session 4', ['Go-to-market planning draft']),
      makeSession('similar-5-id', 'Similar session 5', ['Go-to-market planning summary']),
    ]);

    const result = await findSimilarConversations('source-id', { limit: 2 });

    expect(result.status).toBe('ok');
    expect(result.results).toHaveLength(2);
    expect(result.results.map(item => item.sessionId)).toEqual(['similar-1-id', 'similar-2-id']);
  });

  it('returns ok with empty results when the source is indexed but has no qualifying neighbors', async () => {
    setEmbeddingSequence([BASE_EMBEDDING]);
    await embedSessions([makeSession('source-id', 'Source session', ['Standalone conversation'])]);

    const result = await findSimilarConversations('source-id');

    expect(result).toEqual({
      results: [],
      status: 'ok',
    });
  });

  it('returns error when LanceDB throws an ENFILE-class error', async () => {
    setEmbeddingSequence([BASE_EMBEDDING]);
    await embedSessions([makeSession('source-id', 'Source session', ['Needs lookup'])]);

    testState.isTooManyOpenFilesError.mockReturnValue(true);

    const connection = await lancedb.connect(
      path.join(testState.dataPath, 'indices', 'global', 'conversations', 'lancedb')
    );
    const table = await connection.openTable('conversation_embeddings');
    const querySpy = vi.spyOn(Object.getPrototypeOf(table), 'query').mockImplementation(() => {
      throw new Error('simulated ENFILE failure');
    });

    try {
      const result = await findSimilarConversations('source-id');
      expect(result).toEqual({
        results: [],
        status: 'error',
      });
    } finally {
      querySpy.mockRestore();
      await connection.close();
    }
  });
});
