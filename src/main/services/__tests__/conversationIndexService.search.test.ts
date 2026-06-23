/**
 * Tests for conversation search in conversationIndexService.
 *
 * Covers:
 * - searchConversations / findSimilarConversations guard behavior (null index, empty query)
 * - Arrow Vector handling regression: cosineDistance must produce valid scores when
 *   LanceDB hybrid queries return Arrow Vector objects (no bracket indexing)
 * - Dedup-by-sessionId + threshold filtering with Arrow Vectors
 *
 * NOTE: Service-level tests that exercise the full hybrid/vector-only search paths
 * with a mocked LanceDB table are not yet implemented. These tests exercise the
 * guard clauses and the cosineDistance integration that was the root cause of
 * conversation search always returning zero results in hybrid mode.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from '@shared/types';
import { setEmbeddingGeneratorFactory } from '@core/embeddingGenerator';

// --- Mocks (must be before imports) ---

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({ isPackaged: false, userDataPath: '/tmp/test', version: '0.0.0' }),
}));
vi.mock('@core/lazyElectron', () => ({
  onElectronAppEvent: vi.fn(),
}));
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: vi.fn(() => '/tmp/test'),
  isPackaged: vi.fn(() => false),
}));
const mockIsEmbeddingServiceReady = vi.fn(() => true);
// Safety-net mock: the real embeddingService statically imports electron (via
// gpuEmbeddingBackend), which can't load in the test env. conversationIndexService
// itself deliberately does NOT import embeddingService — it uses the detached
// getEmbeddingGenerator() factory and classifies embedding-backend failures from the
// embedding call throwing (keeping the agentTurnExecutor entrypoint electron-detached;
// see validate:transitive-electron-deps). This mock guards any transitive load.
vi.mock('../embeddingService', () => ({
  generateEmbedding: vi.fn(),
  generateQueryEmbedding: vi.fn(),
  _generateEmbedding: vi.fn(),
  _getEmbeddingDimensions: vi.fn(() => 384),
  isEmbeddingServiceReady: () => mockIsEmbeddingServiceReady(),
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
  createPausableInterval: vi.fn(() => ({ pause: vi.fn(), resume: vi.fn(), destroy: vi.fn() })),
  waitForTurnIdle: vi.fn(async () => 'idle' as const),
  isAnyTurnActive: vi.fn(() => false),
}));

// --- Helpers ---

function makeQueryEmbedding(seed = 1): Float32Array {
  // Deterministic 384-dim embedding for testing
  const values = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    values[i] = Math.sin(seed * (i + 1) * 0.1);
  }
  return normalize(values);
}

/** Create a slightly perturbed copy (high cosine similarity to original). */
function perturbEmbedding(base: Float32Array, noise = 0.05): Float32Array {
  const perturbed = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    perturbed[i] = base[i] + noise * Math.sin(i * 7.3);
  }
  return normalize(perturbed);
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/** Create an Arrow-like Vector that mimics LanceDB hybrid query results. */
function makeArrowVector(values: Float32Array) {
  return {
    length: values.length,
    [Symbol.iterator]: function* () { yield* values; },
    get: (i: number) => values[i],
    // Arrow Vectors do NOT support bracket indexing — v[0] returns undefined
  } as unknown as number[];
}

function makeConversationRow(opts: {
  sessionId: string;
  title: string;
  vector: Float32Array | number[];
  searchText?: string;
  distance?: number;
  relevanceScore?: number;
  createdAt?: number;
  messageCount?: number;
}) {
  return {
    sessionId: opts.sessionId,
    title: opts.title,
    search_text: opts.searchText ?? 'test message',
    createdAt: opts.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    origin: 'manual',
    messageCount: opts.messageCount ?? 5,
    userMessageCount: 3,
    embeddedAt: Date.now(),
    embeddingModel: 'test-model',
    vector: opts.vector,
    _distance: opts.distance,
    _relevance_score: opts.relevanceScore,
  };
}

/** Build a 384-dim unit vector orthogonal-ish to makeQueryEmbedding(1) → low cosine (<0.3). */
function makeLowCosineVector(): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = i % 2 === 0 ? 1 : -1;
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return v;
}

// --- Tests ---

describe('conversationIndexService search', () => {
  let searchConversations: typeof import('../conversationIndexService').searchConversations;
  let searchConversationsWithStatus: typeof import('../conversationIndexService').searchConversationsWithStatus;
  let findSimilarConversations: typeof import('../conversationIndexService').findSimilarConversations;
  let buildSearchText: typeof import('../conversationIndexService').buildSearchText;
  let _setConversationIndexForTesting: typeof import('../conversationIndexService')._setConversationIndexForTesting;

  beforeAll(async () => {
    const mod = await import('../conversationIndexService');
    searchConversations = mod.searchConversations;
    searchConversationsWithStatus = mod.searchConversationsWithStatus;
    findSimilarConversations = mod.findSimilarConversations;
    buildSearchText = mod.buildSearchText;
    _setConversationIndexForTesting = mod._setConversationIndexForTesting;
  });

  describe('searchConversations (null index guards)', () => {
    // These tests verify guard clauses when currentIndex is null (default state).
    // The null-index guard fires before the empty-query guard, so these all
    // exit via the "index not initialized" path.

    it('returns empty array when index is not initialized', async () => {
      const results = await searchConversations('test query');
      expect(results).toEqual([]);
    });

    it('returns empty array for empty query (null index path)', async () => {
      const results = await searchConversations('');
      expect(results).toEqual([]);
    });

    it('returns empty array for whitespace-only query (null index path)', async () => {
      const results = await searchConversations('   ');
      expect(results).toEqual([]);
    });
  });

  describe('findSimilarConversations (null index guards)', () => {
    it('returns index_not_ready when index is not initialized', async () => {
      const result = await findSimilarConversations('session-123');
      expect(result).toEqual({
        results: [],
        status: 'index_not_ready',
      });
    });
  });

  describe('searchConversationsWithStatus (FOX-3003 discriminated status)', () => {
    afterEach(() => {
      _setConversationIndexForTesting(null);
      mockIsEmbeddingServiceReady.mockReturnValue(true);
      setEmbeddingGeneratorFactory(() => ({
        generateEmbedding: vi.fn(async () => makeQueryEmbedding()),
        generateQueryEmbedding: vi.fn(async () => makeQueryEmbedding()),
        generateEmbeddings: vi.fn(async () => [makeQueryEmbedding()]),
      }));
    });

    it('returns ok + empty for empty query (not a backend failure)', async () => {
      const result = await searchConversationsWithStatus('');
      expect(result).toEqual({ status: 'ok', results: [] });
    });

    it('returns index_not_ready (NOT empty success) when the index is null', async () => {
      _setConversationIndexForTesting(null);
      const result = await searchConversationsWithStatus('test query');
      expect(result.status).toBe('index_not_ready');
      expect(result.results).toEqual([]);
    });

    it('returns embedding_unavailable when query embedding generation fails (backend down)', async () => {
      // The query is embedded first; if the embedding backend is down that call throws
      // BEFORE any search runs → surfaced as embedding_unavailable, not a no-match.
      _setConversationIndexForTesting({ table: {} as never, ftsReady: false });
      setEmbeddingGeneratorFactory(() => ({
        generateEmbedding: vi.fn(async () => makeQueryEmbedding()),
        generateQueryEmbedding: vi.fn(async () => {
          throw new Error('embedding worker not initialized');
        }),
        generateEmbeddings: vi.fn(async () => [makeQueryEmbedding()]),
      }));
      const result = await searchConversationsWithStatus('test query');
      expect(result.status).toBe('embedding_unavailable');
      expect(result.results).toEqual([]);
    });

    it('returns error (NOT empty success) when the search step throws after embedding succeeds', async () => {
      // Embedding succeeds, then the table query throws → a real error, distinct from
      // both a no-match (ok+[]) and a backend-unavailable embedding failure.
      _setConversationIndexForTesting({
        table: {
          vectorSearch: () => {
            throw new Error('lancedb table query failed');
          },
        } as never,
        ftsReady: false,
      });
      const result = await searchConversationsWithStatus('test query');
      expect(result.status).toBe('error');
      expect(result.results).toEqual([]);
    });

    it('returns ok + empty for a genuine no-match on a healthy index', async () => {
      mockIsEmbeddingServiceReady.mockReturnValue(true);
      // Vector-only path (ftsReady false): table.vectorSearch(...).toArray() => []
      const emptyChain = {
        distanceType: () => emptyChain,
        select: () => emptyChain,
        limit: () => emptyChain,
        toArray: async () => [],
      };
      _setConversationIndexForTesting({
        table: { vectorSearch: () => emptyChain } as never,
        ftsReady: false,
      });
      const result = await searchConversationsWithStatus('test query');
      expect(result.status).toBe('ok');
      expect(result.results).toEqual([]);
    });
  });

  it('stores primary email-draft fallback text so FTS can match recipient-only queries', () => {
    const toolEvent: Extract<AgentEvent, { type: 'tool' }> = {
      type: 'tool',
      toolName: 'compose_workspace_email',
      detail: 'draft created',
      stage: 'end',
      timestamp: Date.now(),
      mcpAppUiMeta: {
        resourceUri: 'ui://google-workspace/compose-email',
        presentation: 'primary',
        viewSummary: 'Email draft ready.',
        structuredFallback: {
          kind: 'email-draft',
          payload: {
            to: ['recipient-only@example.com'],
            subject: 'Recipient-only search',
            body: 'This body is only present in the structured fallback.',
          },
        },
      },
    };
    const session = {
      id: 'primary-email-search',
      title: 'Email draft',
      messages: [
        { id: 'msg-1', turnId: 'turn-1', role: 'assistant', text: 'Drafted.', createdAt: Date.now() },
      ],
      eventsByTurn: { 'turn-1': [toolEvent] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      origin: 'manual',
    } as unknown as AgentSession;

    const indexedText = buildSearchText(session);

    expect(indexedText.toLowerCase()).toContain('recipient-only@example.com');
  });
});

/**
 * Tests for buildConversationResults behavior (exercised via cosineDistance).
 * This tests the same Arrow Vector issue that affected file search.
 */
describe('conversationIndexService cosineDistance integration', () => {
  let cosineDistance: typeof import('../fileIndexService').cosineDistance;

  beforeAll(async () => {
    const mod = await import('../fileIndexService');
    cosineDistance = mod.cosineDistance;
  });

  it('produces valid scores when b is an Arrow Vector (hybrid mode)', () => {
    const queryEmbedding = makeQueryEmbedding(1);
    const docVector = perturbEmbedding(queryEmbedding, 0.05); // Small perturbation → high similarity

    // Simulate what buildConversationResults does in hybrid mode
    const arrowVector = makeArrowVector(docVector);
    const score = 1 - cosineDistance(queryEmbedding, arrowVector);

    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns NaN-free scores for same vector as Arrow type', () => {
    const v = makeQueryEmbedding(42);
    const arrowV = makeArrowVector(v);
    const score = 1 - cosineDistance(v, arrowV);

    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeCloseTo(1, 5);
  });

  it('correctly handles mixed dedup scenario with Arrow Vectors', () => {
    // Simulate what happens in buildConversationResults:
    // Multiple rows for same sessionId, some with Arrow vectors
    const queryEmbedding = makeQueryEmbedding(1);
    const rows = [
      makeConversationRow({
        sessionId: 'sess-1',
        title: 'First match',
        vector: makeArrowVector(perturbEmbedding(queryEmbedding, 0.03)),
        relevanceScore: 0.016,
      }),
      makeConversationRow({
        sessionId: 'sess-1', // duplicate
        title: 'First match (chunk 2)',
        vector: makeArrowVector(perturbEmbedding(queryEmbedding, 0.06)),
        relevanceScore: 0.015,
      }),
      makeConversationRow({
        sessionId: 'sess-2',
        title: 'Second match',
        vector: makeArrowVector(perturbEmbedding(queryEmbedding, 0.08)),
        relevanceScore: 0.014,
      }),
    ];

    // Process like buildConversationResults does
    const results = [];
    const seenSessionIds = new Set<string>();

    for (const row of rows) {
      if (seenSessionIds.has(row.sessionId)) continue;
      seenSessionIds.add(row.sessionId);

      const score = 1 - cosineDistance(queryEmbedding, row.vector as unknown as Float32Array);
      if (!Number.isFinite(score) || score < 0.3) continue;

      results.push({ sessionId: row.sessionId, title: row.title, score });
    }

    // Should get exactly 2 unique sessions, both with valid scores
    expect(results).toHaveLength(2);
    expect(results[0].sessionId).toBe('sess-1');
    expect(results[1].sessionId).toBe('sess-2');
    expect(results.every(r => Number.isFinite(r.score) && r.score > 0.3)).toBe(true);
  });

  it('filters out low-scoring results from Arrow Vectors', () => {
    const queryEmbedding = makeQueryEmbedding(1);
    // Orthogonal vector → score ~0
    const orthogonal = new Float32Array(384);
    for (let i = 0; i < 384; i++) orthogonal[i] = (i % 2 === 0) ? 1 : -1;
    // Normalize
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += orthogonal[i] * orthogonal[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < 384; i++) orthogonal[i] /= norm;

    const arrowOrthogonal = makeArrowVector(orthogonal);
    const score = 1 - cosineDistance(queryEmbedding, arrowOrthogonal);

    expect(Number.isFinite(score)).toBe(true);
    // Orthogonal-ish vector should be near 0, below 0.3 threshold
    expect(score).toBeLessThan(0.3);
  });
});

/**
 * F1 (260619): the hybrid keep-rule. A genuine lexical/keyword hit (query appears in
 * title/search_text) must survive even when its embedding cosine is below the semantic
 * floor — the previous code re-applied a vector-only cosine cutoff to ALL hybrid rows
 * and silently dropped exact keyword/title matches the FTS half had surfaced. A genuine
 * no-match (no lexical hit AND nothing clears the floor) must still return []. Dedup must
 * be order-independent (best rankScore per session). Tested against the REAL
 * buildConversationResults, not a hand simulation.
 */
describe('buildConversationResults — F1 lexical keep-rule + rankScore + dedup', () => {
  let buildConversationResults: typeof import('../conversationIndexService').buildConversationResults;

  beforeAll(async () => {
    const mod = await import('../conversationIndexService');
    buildConversationResults = mod.buildConversationResults;
  });

  it('RETAINS a strong lexical/title hit whose cosine is below the floor (hybrid)', () => {
    const queryEmbedding = makeQueryEmbedding(1);
    const rows = [
      makeConversationRow({
        sessionId: 'penny-1',
        title: 'Quarterly review with Penny',
        searchText: 'notes about the Penny account and next steps',
        vector: makeArrowVector(makeLowCosineVector()), // cosine < 0.3
        relevanceScore: 0.016, // FTS+RRF ranked it
      }),
    ];
    const results = buildConversationResults(rows, 'Penny', queryEmbedding, 0.3, 20, true, /* lexicalExemption */ true);
    // OLD behavior: dropped (cosine < 0.3). NEW: kept because it's a lexical hit.
    expect(results.map((r) => r.sessionId)).toEqual(['penny-1']);
    // rankScore comes from RRF, not the low cosine; score stays cosine for display.
    expect(results[0].rankScore).toBe(0.016);
    expect(results[0].score).toBeLessThan(0.3);
  });

  it('NEGATIVE CONTROL: no lexical hit AND cosine below floor ⇒ [] (preserves genuine-zero)', () => {
    const queryEmbedding = makeQueryEmbedding(1);
    const rows = [
      makeConversationRow({
        sessionId: 'unrelated-1',
        title: 'Budget spreadsheet',
        searchText: 'columns rows totals figures',
        vector: makeArrowVector(makeLowCosineVector()), // cosine < 0.3
        relevanceScore: 0.01,
      }),
    ];
    const results = buildConversationResults(rows, 'Penny', queryEmbedding, 0.3, 20, true, /* lexicalExemption */ true);
    expect(results).toEqual([]);
  });

  it('RETAINS a semantic match (high cosine) even without a lexical hit', () => {
    const queryEmbedding = makeQueryEmbedding(1);
    const rows = [
      makeConversationRow({
        sessionId: 'semantic-1',
        title: 'Evening meal options',
        searchText: 'where should we eat tonight',
        vector: makeArrowVector(perturbEmbedding(queryEmbedding, 0.03)), // cosine > 0.3
        relevanceScore: 0.02,
      }),
    ];
    const results = buildConversationResults(rows, 'dinner', queryEmbedding, 0.3, 20, true, /* lexicalExemption */ true);
    expect(results.map((r) => r.sessionId)).toEqual(['semantic-1']);
  });

  it('dedups by sessionId order-independently (keeps highest rankScore even when it appears last)', () => {
    const queryEmbedding = makeQueryEmbedding(1);
    const rows = [
      makeConversationRow({
        sessionId: 'dup',
        title: 'Penny — chunk A',
        searchText: 'Penny',
        vector: makeArrowVector(makeLowCosineVector()),
        relevanceScore: 0.010, // lower rank, appears FIRST
      }),
      makeConversationRow({
        sessionId: 'dup',
        title: 'Penny — chunk B',
        searchText: 'Penny',
        vector: makeArrowVector(makeLowCosineVector()),
        relevanceScore: 0.030, // higher rank, appears SECOND
      }),
    ];
    const results = buildConversationResults(rows, 'Penny', queryEmbedding, 0.3, 20, true, /* lexicalExemption */ true);
    expect(results).toHaveLength(1);
    expect(results[0].rankScore).toBe(0.030); // old first-seen-wins would have kept 0.010
    expect(results[0].title).toBe('Penny — chunk B');
  });

  it('orders a low-cosine lexical hit ABOVE a lower-RRF semantic hit (rankScore ordering)', () => {
    const queryEmbedding = makeQueryEmbedding(1);
    const rows = [
      makeConversationRow({
        sessionId: 'semantic',
        title: 'Evening meal options',
        searchText: 'tonight',
        vector: makeArrowVector(perturbEmbedding(queryEmbedding, 0.03)), // high cosine
        relevanceScore: 0.012,
      }),
      makeConversationRow({
        sessionId: 'lexical',
        title: 'Dinner with Penny',
        searchText: 'Penny dinner plans',
        vector: makeArrowVector(makeLowCosineVector()), // low cosine but lexical hit
        relevanceScore: 0.030,
      }),
    ];
    const results = buildConversationResults(rows, 'dinner', queryEmbedding, 0.3, 20, true, /* lexicalExemption */ true);
    // Both kept; lexical hit has higher RRF → ranks first despite lower cosine.
    expect(results.map((r) => r.sessionId)).toEqual(['lexical', 'semantic']);
  });

  it('STRICT by default (lexicalExemption off): a low-cosine lexical hit is DROPPED', () => {
    // Guards the auto-context-injection path: a mere keyword coincidence must NOT inject a
    // low-semantic conversation into every turn. Same row as the "RETAINS lexical hit" test,
    // but without the exemption flag → must be dropped by the cosine floor.
    const queryEmbedding = makeQueryEmbedding(1);
    const rows = [
      makeConversationRow({
        sessionId: 'penny-1',
        title: 'Quarterly review with Penny',
        searchText: 'notes about the Penny account',
        vector: makeArrowVector(makeLowCosineVector()),
        relevanceScore: 0.016,
      }),
    ];
    // default (no 7th arg) and explicit-false both stay strict.
    expect(buildConversationResults(rows, 'Penny', queryEmbedding, 0.3, 20, true)).toEqual([]);
    expect(buildConversationResults(rows, 'Penny', queryEmbedding, 0.3, 20, true, false)).toEqual([]);
  });

  it('hybrid row missing _relevance_score gets rankScore 0 (does NOT borrow cosine scale)', () => {
    const queryEmbedding = makeQueryEmbedding(1);
    const rows = [
      makeConversationRow({
        sessionId: 'no-rrf',
        title: 'Penny notes',
        searchText: 'Penny',
        vector: makeArrowVector(perturbEmbedding(queryEmbedding, 0.03)), // high cosine ~1
        relevanceScore: undefined, // hybrid row missing RRF
      }),
    ];
    const results = buildConversationResults(rows, 'Penny', queryEmbedding, 0.3, 20, true, true);
    expect(results).toHaveLength(1);
    // Must be 0, not the (high) cosine — otherwise it would dwarf real RRF scores elsewhere.
    expect(results[0].rankScore).toBe(0);
  });

  it('vector-only mode (isHybrid false) retains a low-cosine lexical hit when exemption on', () => {
    const queryEmbedding = makeQueryEmbedding(1);
    const rows = [
      makeConversationRow({
        sessionId: 'vec-lex',
        title: 'Dinner with Penny',
        searchText: 'Penny',
        vector: makeArrowVector(makeLowCosineVector()),
        distance: 0.9, // 1 - 0.9 = 0.1 cosine, below floor
      }),
    ];
    const kept = buildConversationResults(rows, 'Penny', queryEmbedding, 0.3, 20, false, true);
    expect(kept.map((r) => r.sessionId)).toEqual(['vec-lex']);
    // strict (default) drops it
    expect(buildConversationResults(rows, 'Penny', queryEmbedding, 0.3, 20, false)).toEqual([]);
  });

  it('punctuation-bearing query (e.g. "Penny?") still matches a lexical hit', () => {
    const queryEmbedding = makeQueryEmbedding(1);
    const rows = [
      makeConversationRow({
        sessionId: 'punct',
        title: 'Notes on Penny',
        searchText: 'Penny account',
        vector: makeArrowVector(makeLowCosineVector()),
        relevanceScore: 0.02,
      }),
    ];
    expect(buildConversationResults(rows, 'Penny?', queryEmbedding, 0.3, 20, true, true).map((r) => r.sessionId)).toEqual(['punct']);
    expect(buildConversationResults(rows, 'budget, Penny', queryEmbedding, 0.3, 20, true, true).map((r) => r.sessionId)).toEqual([]); // 'budget' absent → AND fails
  });
});

/**
 * F3 (260619): a rename (title change with no new messages) leaves the indexed title/
 * search_text stale, so the conversation can't be found by its new title — the 2-msg/
 * 5-min stale gate misses it. onSessionsSaved must re-embed an already-indexed eligible
 * session whose title differs from the indexed title.
 */
describe('onSessionsSaved — F3 re-embeds renamed conversations', () => {
  let onSessionsSaved: typeof import('../conversationIndexService').onSessionsSaved;
  let _setConversationIndexForTesting: typeof import('../conversationIndexService')._setConversationIndexForTesting;

  beforeAll(async () => {
    const mod = await import('../conversationIndexService');
    onSessionsSaved = mod.onSessionsSaved;
    _setConversationIndexForTesting = mod._setConversationIndexForTesting;
  });

  beforeEach(() => {
    setEmbeddingGeneratorFactory(() => ({
      generateEmbedding: vi.fn(async () => makeQueryEmbedding()),
      generateQueryEmbedding: vi.fn(async () => makeQueryEmbedding()),
      generateEmbeddings: vi.fn(async () => [makeQueryEmbedding()]),
    }));
  });

  afterEach(() => {
    _setConversationIndexForTesting(null);
  });

  const makeEligibleSession = (id: string, title: string): AgentSession => ({
    id,
    title,
    isCorrupted: false,
    deletedAt: null,
    createdAt: 1000,
    updatedAt: 2000,
    origin: 'manual',
    messages: [{ id: 'm1', turnId: 't1', role: 'user', text: 'hello there', createdAt: 1500 }],
  } as unknown as AgentSession);

  function makeMockIndex(indexedTitle: string) {
    const table = { add: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    _setConversationIndexForTesting({
      table: table as never,
      ftsReady: true,
      embeddedSessionIds: new Set(['sess-x']),
      embeddedTitles: new Map([['sess-x', indexedTitle]]),
      embeddedUserMessageCounts: new Map([['sess-x', 1]]),
      metadata: { lastIndexedAt: 0 } as never,
    });
    return table;
  }

  it('re-embeds (delete+add) when the title changed since indexing', async () => {
    const table = makeMockIndex('Old title');
    await onSessionsSaved([makeEligibleSession('sess-x', 'Brand new title')]);
    expect(table.delete).toHaveBeenCalledTimes(1); // reembed = delete old…
    expect(table.add).toHaveBeenCalledTimes(1);     // …then add fresh record
  });

  it('does NOT re-embed when the title is unchanged', async () => {
    const table = makeMockIndex('Same title');
    await onSessionsSaved([makeEligibleSession('sess-x', 'Same title')]);
    expect(table.delete).not.toHaveBeenCalled();
    expect(table.add).not.toHaveBeenCalled();
  });
});

/**
 * F7 (260619): automation conversations are now indexed so the sidebar "Automations"
 * filter + search box works. The automation-ID exclusion is removed from BOTH eligibility
 * helpers; privacy/corrupted/deleted/no-user-message exclusions still apply.
 */
describe('shouldEmbedSession/shouldEmbedSummary — F7 automations are searchable', () => {
  let shouldEmbedSession: typeof import('../conversationIndexService').shouldEmbedSession;
  let shouldEmbedSummary: typeof import('../conversationIndexService').shouldEmbedSummary;

  beforeAll(async () => {
    const mod = await import('../conversationIndexService');
    shouldEmbedSession = mod.shouldEmbedSession;
    shouldEmbedSummary = mod.shouldEmbedSummary;
  });

  it('shouldEmbedSession now allows an automation session with user messages', () => {
    const automation = {
      id: 'automation-123',
      title: 'Daily digest',
      isCorrupted: false,
      privateMode: false,
      deletedAt: null,
      messages: [{ id: 'm1', turnId: 't1', role: 'user', text: 'run digest', createdAt: 1 }],
      createdAt: 1, updatedAt: 2, origin: 'automation',
    } as unknown as AgentSession;
    expect(shouldEmbedSession(automation)).toBe(true);
  });

  it('still excludes private / corrupted / deleted automations', () => {
    const base = {
      id: 'automation-123', title: 'X',
      messages: [{ id: 'm1', turnId: 't1', role: 'user', text: 'hi', createdAt: 1 }],
      createdAt: 1, updatedAt: 2, origin: 'automation', isCorrupted: false, privateMode: false, deletedAt: null,
    };
    expect(shouldEmbedSession({ ...base, privateMode: true } as unknown as AgentSession)).toBe(false);
    expect(shouldEmbedSession({ ...base, isCorrupted: true } as unknown as AgentSession)).toBe(false);
    expect(shouldEmbedSession({ ...base, deletedAt: 123 } as unknown as AgentSession)).toBe(false);
  });

  it('shouldEmbedSummary now allows an automation summary', () => {
    const summary = {
      id: 'automation-123', title: 'Daily digest', isCorrupted: false, privateMode: false,
      deletedAt: null, hasUserMessages: true, createdAt: 1, updatedAt: 2, origin: 'automation', messageCount: 2,
    } as never;
    expect(shouldEmbedSummary(summary)).toBe(true);
    expect(shouldEmbedSummary({ ...(summary as object), privateMode: true } as never)).toBe(false);
  });
});

describe('buildRecencyScope — exhaustive-within-window quick search (260620)', () => {
  let buildRecencyScope: typeof import('../conversationIndexService').buildRecencyScope;

  beforeAll(async () => {
    const mod = await import('../conversationIndexService');
    buildRecencyScope = mod.buildRecencyScope;
  });

  it('no cutoff → no scope (default "All time" path is unchanged)', () => {
    expect(buildRecencyScope(undefined, ['a', 'b'])).toEqual({ kind: 'none' });
  });

  it('cutoff set but zero in-window conversations → empty (genuine no-match, skip the query)', () => {
    expect(buildRecencyScope(1750000000000, [])).toEqual({ kind: 'empty' });
  });

  it('small in-window set → exact sessionId allowlist + limit = in-window count', () => {
    const scope = buildRecencyScope(1750000000000, ['s1', 's2', 's3']);
    expect(scope).toEqual({
      kind: 'allowlist',
      predicate: "`sessionId` IN ('s1', 's2', 's3')",
      // limit is the in-window count → the search returns the WHOLE windowed set ranked.
      limit: 3,
    });
  });

  it('single in-window conversation → eq-form allowlist (inAny collapses to one)', () => {
    const scope = buildRecencyScope(1750000000000, ['only-one']);
    expect(scope).toEqual({ kind: 'allowlist', predicate: "`sessionId` = 'only-one'", limit: 1 });
  });

  it('exactly 500 in-window conversations (the cap) → still an exact allowlist, not grace', () => {
    const exactlyMax = Array.from({ length: 500 }, (_unused, i) => `s${i}`);
    const scope = buildRecencyScope(1_750_000_000_000, exactlyMax);
    expect(scope.kind).toBe('allowlist');
    expect((scope as { limit: number }).limit).toBe(500);
  });

  it('>500 in-window conversations → grace-buffered index prefilter fallback (no giant IN clause)', () => {
    const cutoff = 1_750_000_000_000;
    const manyIds = Array.from({ length: 501 }, (_unused, i) => `s${i}`);
    const scope = buildRecencyScope(cutoff, manyIds);
    // Grace fallback: index `updatedAt` >= (cutoff - 24h) OR IS NULL. 24h = 86_400_000ms.
    expect(scope).toEqual({
      kind: 'grace',
      predicate: `(\`updatedAt\` >= ${cutoff - 86_400_000} OR \`updatedAt\` IS NULL)`,
    });
  });
});
