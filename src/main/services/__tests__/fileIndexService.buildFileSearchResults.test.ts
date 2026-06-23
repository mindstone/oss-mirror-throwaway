/**
 * Tests for `buildFileSearchResults` (F9 — the file-search sibling of F1's
 * `conversationIndexService.buildConversationResults`).
 *
 * The bug: hybrid (FTS + vector + RRF) file search gated every row by a
 * recomputed *vector-only* cosine floor, silently dropping exact keyword/filename
 * matches that FTS surfaced but whose vector cosine fell below the threshold.
 *
 * The fix mirrors F1: an opt-in `lexicalExemption` (default OFF) lets a genuine
 * lexical hit (query present in relativePath/content) survive the cosine floor —
 * enabled ONLY for explicit user search, so silent auto-context paths stay
 * semantic-strict. These are red→green: they fail on the pre-fix code (lexical
 * hits dropped) and pass after.
 *
 * `buildFileSearchResults` is pure (rows + query + embedding in, ranked results
 * out), so these exercise the real scoring/dedup with hand-built rows — no real
 * LanceDB or embedding model.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

// --- Mocks (electron-transitive deps of search.ts; the pure scoring helpers in
//     ./documentParsing + @core/utils/vectorMath are used for real) ---
vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({ isPackaged: false, userDataPath: '/tmp/test', version: '0.0.0' }),
}));
vi.mock('@core/lazyElectron', () => ({ onElectronAppEvent: vi.fn() }));
vi.mock('@core/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createScopedLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@core/embeddingGenerator', () => ({
  getEmbeddingGenerator: () => ({
    generateQueryEmbedding: async () => Float32Array.from([1, 0]),
    generateEmbedding: async () => Float32Array.from([1, 0]),
    generateEmbeddings: async (texts: string[]) => texts.map(() => Float32Array.from([1, 0])),
  }),
}));
vi.mock('@core/utils/loadNativeModule', () => ({ loadNativeModule: vi.fn() }));
vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: vi.fn(),
  recordKnownConditionLedgerOnly: vi.fn(),
}));
vi.mock('../../utils/emfileRetry', () => ({ isTooManyOpenFilesError: vi.fn(() => false) }));
vi.mock('../../utils/enfileState', () => ({
  isEnfileActive: vi.fn(() => false),
  markEnfileDetected: vi.fn(() => ({ isFirstDetection: false })),
}));
vi.mock('../fileIndexService/state', () => ({ getCurrentIndex: vi.fn(() => null) }));
vi.mock('../fileIndexService/contextualRetrieval', () => ({
  recordSearchFailure: vi.fn(),
  recordSearchStart: vi.fn(),
  recordSearchTime: vi.fn(),
}));

type Row = {
  path: string;
  relativePath: string;
  content: string;
  extension: string;
  mtime: number;
  chunkIndex: number;
  vector: number[];
  _relevance_score?: number;
};

// Unit vectors so cosine similarity (= 1 - cosineDistance) is exact:
//   ALIGNED  → score 1   (clears the 0.3 floor)
//   ORTHOGONAL → score 0 (below the floor; only a lexical hit can keep it)
const QUERY_EMBEDDING = Float32Array.from([1, 0]);
const ALIGNED = [1, 0];
const ORTHOGONAL = [0, 1];

/** Build a row with recency/skill boosts neutralized (mtime non-finite, non-skill path). */
function row(overrides: Partial<Row> & Pick<Row, 'path' | 'content' | 'vector'>): Row {
  return {
    relativePath: overrides.path,
    extension: '.md',
    mtime: NaN, // non-finite → no recency boost → rrfScore === _relevance_score
    chunkIndex: 0,
    _relevance_score: 0.5,
    ...overrides,
  };
}

describe('buildFileSearchResults — F9 lexical keep-rule + order-independent dedup', () => {
  let buildFileSearchResults: typeof import('../fileIndexService/search').buildFileSearchResults;

  beforeAll(async () => {
    const mod = await import('../fileIndexService/search');
    buildFileSearchResults = mod.buildFileSearchResults;
  });

  it('RETAINS a strong lexical hit whose cosine is below the floor (hybrid, exemption ON)', () => {
    const rows = [
      row({ path: 'notes/budget.md', content: 'quarterly budget planning', vector: ORTHOGONAL }),
    ];
    const results = buildFileSearchResults(rows, 'budget', QUERY_EMBEDDING, 0.3, 10, /* lexicalExemption */ true, 0);
    expect(results.map((r) => r.path)).toEqual(['notes/budget.md']);
    // Display score stays the (low) cosine, not a fabricated value.
    expect(results[0].score).toBeLessThan(0.3);
  });

  it('NEGATIVE CONTROL: no lexical hit AND cosine below floor ⇒ [] (preserves genuine-zero)', () => {
    const rows = [
      row({ path: 'notes/random.md', content: 'totally unrelated text', vector: ORTHOGONAL }),
    ];
    expect(buildFileSearchResults(rows, 'budget', QUERY_EMBEDDING, 0.3, 10, true, 0)).toEqual([]);
  });

  it('RETAINS a semantic match (high cosine) even without a lexical hit', () => {
    const rows = [
      row({ path: 'notes/agenda.md', content: 'meeting agenda items', vector: ALIGNED }),
    ];
    const results = buildFileSearchResults(rows, 'budget', QUERY_EMBEDDING, 0.3, 10, true, 0);
    expect(results.map((r) => r.path)).toEqual(['notes/agenda.md']);
  });

  it('STRICT by default (exemption OFF): a low-cosine lexical hit is DROPPED', () => {
    const rows = [
      row({ path: 'notes/budget.md', content: 'quarterly budget planning', vector: ORTHOGONAL }),
    ];
    // Both the explicit-false and the defaulted form must stay strict — this is
    // what keeps silent auto-context (semanticContextService, pre-turn worker)
    // from being flooded with low-relevance keyword coincidences.
    expect(buildFileSearchResults(rows, 'budget', QUERY_EMBEDDING, 0.3, 10, false, 0)).toEqual([]);
  });

  it('matches the FILENAME via relativePath even when the content does not contain the query', () => {
    const rows = [
      row({ path: 'reports/Q2-budget-forecast.md', content: 'figures and tables', vector: ORTHOGONAL }),
    ];
    const results = buildFileSearchResults(rows, 'forecast', QUERY_EMBEDDING, 0.3, 10, true, 0);
    expect(results.map((r) => r.path)).toEqual(['reports/Q2-budget-forecast.md']);
  });

  it('dedups by path order-independently (keeps the highest-RRF chunk regardless of order)', () => {
    const low = row({ path: 'a.md', content: 'first chunk', vector: ALIGNED, _relevance_score: 0.1, chunkIndex: 0 });
    const high = row({ path: 'a.md', content: 'second chunk', vector: ALIGNED, _relevance_score: 0.9, chunkIndex: 1 });

    const lowFirst = buildFileSearchResults([low, high], 'chunk', QUERY_EMBEDDING, 0.3, 10, true, 0);
    expect(lowFirst).toHaveLength(1);
    expect(lowFirst[0].snippet).toBe('second chunk');

    const highFirst = buildFileSearchResults([high, low], 'chunk', QUERY_EMBEDDING, 0.3, 10, true, 0);
    expect(highFirst).toHaveLength(1);
    expect(highFirst[0].snippet).toBe('second chunk');
  });

  it('RETAINS a lexical hit even when _relevance_score is missing (rrfScore 0 — dedup must not drop the first row)', () => {
    // Pre-fix the file-search dedup was `rrfScore > existingRrf` with existingRrf
    // defaulting to 0, so a first row with rrfScore 0 was dropped. The F6-style
    // order-independent dedup (first row always registers) closes that.
    const rows = [
      { ...row({ path: 'notes/budget.md', content: 'budget notes', vector: ORTHOGONAL }), _relevance_score: undefined },
    ];
    const results = buildFileSearchResults(rows, 'budget', QUERY_EMBEDDING, 0.3, 10, true, 0);
    expect(results.map((r) => r.path)).toEqual(['notes/budget.md']);
  });

  it('punctuation-bearing query still matches a lexical hit; AND-of-tokens still required', () => {
    const rows = [
      row({ path: 'notes/penny.md', content: 'penny dinner plans', vector: ORTHOGONAL }),
    ];
    // "penny?" → tokens ['penny'] → matches.
    expect(buildFileSearchResults(rows, 'penny?', QUERY_EMBEDDING, 0.3, 10, true, 0).map((r) => r.path)).toEqual(['notes/penny.md']);
    // "budget, penny" → tokens ['budget','penny']; 'budget' absent ⇒ AND fails ⇒ dropped.
    expect(buildFileSearchResults(rows, 'budget, penny', QUERY_EMBEDDING, 0.3, 10, true, 0)).toEqual([]);
  });

  it('CLAMPS the display score for a lexical hit with a negative cosine (opposing vector) — never returns negative/NaN', () => {
    // Opposing vector → cosine similarity -1 → raw score -1 (below floor, negative).
    // Without exemption it would be dropped; with the lexical hit it is kept, but the
    // display score must be clamped — file score is serialized over IPC and rendered
    // as a percentage, so a negative/NaN value would surface as "-100%" / "NaN%".
    const rows = [row({ path: 'notes/budget.md', content: 'budget figures', vector: [-1, 0] })];
    const results = buildFileSearchResults(rows, 'budget', QUERY_EMBEDDING, 0.3, 10, true, 0);
    expect(results.map((r) => r.path)).toEqual(['notes/budget.md']);
    expect(results[0].score).toBe(0);
    expect(Number.isFinite(results[0].score)).toBe(true);
  });
});
