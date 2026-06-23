/**
 * Tests for the exhaustive-within-window recency scope (260620): verifies that
 * `searchConversationsWithStatus` threads the recency predicate into the actual LanceDB
 * query (`.where()`) and uses the in-window effective limit — locking down the wiring that
 * `buildRecencyScope`'s pure-policy tests can't see.
 *
 * Exercises the VECTOR-ONLY path (ftsReady:false) so we don't have to mock LanceDB natives;
 * the recency `.where()` is applied identically on both branches (see conversationIndexService).
 * The session store is fully mocked here so the test stays isolated from the real index.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionSummary } from '@shared/types';
import { setEmbeddingGeneratorFactory } from '@core/embeddingGenerator';

// --- Mocks (must be before imports) ---
vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({ isPackaged: false, userDataPath: '/tmp/test', version: '0.0.0' }),
}));
vi.mock('@core/lazyElectron', () => ({ onElectronAppEvent: vi.fn() }));
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: vi.fn(() => '/tmp/test'),
  isPackaged: vi.fn(() => false),
}));
vi.mock('../embeddingService', () => ({
  generateEmbedding: vi.fn(),
  generateQueryEmbedding: vi.fn(),
  _generateEmbedding: vi.fn(),
  _getEmbeddingDimensions: vi.fn(() => 384),
  isEmbeddingServiceReady: () => true,
}));
vi.mock('../utils/emfileRetry', () => ({ isTooManyOpenFilesError: vi.fn(() => false) }));
vi.mock('../utils/enfileState', () => ({
  isEnfileActive: vi.fn(() => false),
  markEnfileDetected: vi.fn(() => ({ isFirstDetection: false })),
}));
vi.mock('./visibilityAwareScheduler', () => ({
  createPausableInterval: vi.fn(() => ({ pause: vi.fn(), resume: vi.fn(), destroy: vi.fn() })),
  waitForTurnIdle: vi.fn(async () => 'idle' as const),
  isAnyTurnActive: vi.fn(() => false),
}));
// Stub the LanceDB native module so the HYBRID path (ftsReady:true) can run without natives:
// MultiMatchQuery (FTS query ctor) + rerankers.RRFReranker.create (RRF reranker factory).
vi.mock('@core/utils/loadNativeModule', () => ({
  loadNativeModule: () => ({
    MultiMatchQuery: class { constructor(..._args: unknown[]) {} },
    rerankers: { RRFReranker: { create: async () => ({}) } },
  }),
}));

// Controllable session-store summaries (the fresh-truth source for the recency allowlist).
let mockSummaries: AgentSessionSummary[] = [];
let listSessionsImpl: () => AgentSessionSummary[] = () => mockSummaries;
vi.mock('../incrementalSessionStore', () => ({
  countUserMessages: vi.fn(() => 0),
  getIncrementalSessionStore: vi.fn(() => ({ listSessions: () => listSessionsImpl() })),
}));

function makeSummary(id: string, updatedAt: number, overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    origin: 'manual',
    deletedAt: null,
    isCorrupted: false,
    ...overrides,
  } as AgentSessionSummary;
}

function makeQueryEmbedding(): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = Math.sin((i + 1) * 0.1);
  return v;
}

/**
 * Chainable builder that RECORDS the `.where()` predicate(s) and `.limit()`, covering BOTH
 * the vector-only chain (`vectorSearch().distanceType().select().where().limit()`) and the
 * hybrid chain (`query().nearestTo().distanceType().fullTextSearch().select().rerank().where().limit()`).
 */
function makeRecordingTable(rows: Array<Record<string, unknown>> = []) {
  const wheres: string[] = [];
  const limits: number[] = [];
  const chain = {
    nearestTo: () => chain,
    distanceType: () => chain,
    fullTextSearch: () => chain,
    select: () => chain,
    rerank: () => chain,
    where: (predicate: string) => { wheres.push(predicate); return chain; },
    limit: (n: number) => { limits.push(n); return chain; },
    toArray: async () => rows,
  };
  return { table: { vectorSearch: () => chain, query: () => chain }, wheres, limits };
}

describe('searchConversationsWithStatus — recency scope wiring (260620)', () => {
  let searchConversationsWithStatus: typeof import('../conversationIndexService').searchConversationsWithStatus;
  let _setConversationIndexForTesting: typeof import('../conversationIndexService')._setConversationIndexForTesting;
  const OVERFETCH = 3;

  beforeAll(async () => {
    const mod = await import('../conversationIndexService');
    searchConversationsWithStatus = mod.searchConversationsWithStatus;
    _setConversationIndexForTesting = mod._setConversationIndexForTesting;
  });

  beforeEach(() => {
    mockSummaries = [];
    listSessionsImpl = () => mockSummaries;
    setEmbeddingGeneratorFactory(() => ({
      generateEmbedding: vi.fn(async () => makeQueryEmbedding()),
      generateQueryEmbedding: vi.fn(async () => makeQueryEmbedding()),
      generateEmbeddings: vi.fn(async () => [makeQueryEmbedding()]),
    }));
  });

  afterEach(() => { _setConversationIndexForTesting(null); });

  it('no updatedAfter → applies NO recency .where() (default "All time" path unchanged)', async () => {
    const { table, wheres, limits } = makeRecordingTable();
    _setConversationIndexForTesting({ table: table as never, ftsReady: false });
    await searchConversationsWithStatus('budget', { limit: 20, lexicalExemption: true });
    expect(wheres).toEqual([]); // no recency predicate
    expect(limits).toEqual([20 * OVERFETCH]); // caller's display limit
  });

  it('small in-window set → exact sessionId IN(...) allowlist + effective limit = in-window count', async () => {
    const cutoff = 1_750_000_000_000;
    mockSummaries = [
      makeSummary('in-1', cutoff + 1000),
      makeSummary('in-2', cutoff + 2000),
      makeSummary('old', cutoff - 99_999_999), // out of window → not in the allowlist
    ];
    const { table, wheres, limits } = makeRecordingTable();
    _setConversationIndexForTesting({ table: table as never, ftsReady: false });
    await searchConversationsWithStatus('budget', { limit: 100, lexicalExemption: true, updatedAfter: cutoff });
    expect(wheres).toEqual(["`sessionId` IN ('in-1', 'in-2')"]);
    // effectiveLimit is the in-window count (2), NOT the caller's 100 → returns the whole window.
    expect(limits).toEqual([2 * OVERFETCH]);
  });

  it('HYBRID path (ftsReady:true, the default production path) also threads the recency .where() + effectiveLimit', async () => {
    const cutoff = 1_750_000_000_000;
    mockSummaries = [makeSummary('in-1', cutoff + 1000), makeSummary('in-2', cutoff + 2000)];
    const { table, wheres, limits } = makeRecordingTable();
    // ftsReady:true → the hybrid query().nearestTo()...rerank().where().limit() chain runs.
    _setConversationIndexForTesting({ table: table as never, ftsReady: true });
    await searchConversationsWithStatus('budget', { limit: 100, lexicalExemption: true, updatedAfter: cutoff });
    // Same allowlist predicate + effectiveLimit must reach the hybrid branch (the one most
    // searches actually hit). Guards against a future edit that drops the hybrid `.where()`.
    expect(wheres).toEqual(["`sessionId` IN ('in-1', 'in-2')"]);
    expect(limits).toEqual([2 * OVERFETCH]);
  });

  it('excludes deleted/private/corrupted summaries from the allowlist (mirrors index eligibility)', async () => {
    const cutoff = 1_750_000_000_000;
    mockSummaries = [
      makeSummary('keep', cutoff + 1000),
      makeSummary('del', cutoff + 1000, { deletedAt: cutoff + 1 }),
      makeSummary('priv', cutoff + 1000, { privateMode: true }),
      makeSummary('corrupt', cutoff + 1000, { isCorrupted: true }),
    ];
    const { table, wheres } = makeRecordingTable();
    _setConversationIndexForTesting({ table: table as never, ftsReady: false });
    await searchConversationsWithStatus('budget', { lexicalExemption: true, updatedAfter: cutoff });
    expect(wheres).toEqual(["`sessionId` = 'keep'"]);
  });

  it('cutoff set but zero in-window (non-empty store) → ok+[] without querying the table', async () => {
    const cutoff = 1_750_000_000_000;
    mockSummaries = [makeSummary('old', cutoff - 1)]; // store has sessions, none in window
    const { table, wheres } = makeRecordingTable([{ sessionId: 'should-not-be-read' }] as never);
    _setConversationIndexForTesting({ table: table as never, ftsReady: false });
    const result = await searchConversationsWithStatus('budget', { lexicalExemption: true, updatedAfter: cutoff });
    expect(result).toEqual({ status: 'ok', results: [] });
    expect(wheres).toEqual([]); // short-circuited; never built a query
  });

  it('empty session list → grace prefilter (NOT a false no-match — covers the transient-degrade [] return)', async () => {
    const cutoff = 1_750_000_000_000;
    mockSummaries = []; // listSessions() returned [] (genuinely empty OR transient degrade)
    const { table, wheres } = makeRecordingTable();
    _setConversationIndexForTesting({ table: table as never, ftsReady: false });
    await searchConversationsWithStatus('budget', { lexicalExemption: true, updatedAfter: cutoff });
    // Degrades to grace (still queries) rather than returning ok+[] which would hide everything.
    expect(wheres).toEqual([`(\`updatedAt\` >= ${cutoff - 86_400_000} OR \`updatedAt\` IS NULL)`]);
  });

  it('listSessions() throwing → grace prefilter (observable degradation, not un-windowed search)', async () => {
    const cutoff = 1_750_000_000_000;
    listSessionsImpl = () => { throw new Error('transient index read'); };
    const { table, wheres } = makeRecordingTable();
    _setConversationIndexForTesting({ table: table as never, ftsReady: false });
    await searchConversationsWithStatus('budget', { lexicalExemption: true, updatedAfter: cutoff });
    expect(wheres).toEqual([`(\`updatedAt\` >= ${cutoff - 86_400_000} OR \`updatedAt\` IS NULL)`]);
  });
});
