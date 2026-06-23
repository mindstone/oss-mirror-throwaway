import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Black-box characterization tests for `semanticSearch` (CHIEF_ENGINEER2 Stage A1).
//
// These pin the OBSERVABLE behavior of the product's core search feature against a
// real temp LanceDB so a coming decomposition has a safety net. They assert returned
// values (paths, ordering, scores, result shape, metrics) — NOT internal
// `currentIndex` / `WorkspaceIndex` fields. The harness (mkdtemp temp DB +
// deterministic embeddings keyed off the `Path:` enrichment line) is copied from
// `fileIndexService.findSimilarFiles.test.ts`.
//
// Embedding geometry: the mocked `generateQueryEmbedding` always returns [1, 0]
// regardless of the query string, so a file's relevance is driven entirely by how
// aligned its assigned vector is with [1, 0] (i.e. its first component). Tests choose
// vectors so that vector-only ordering is fully deterministic. The hybrid (FTS) path
// is exercised separately with content keywords; for the hybrid path we assert the
// reliable invariants (correct shape, dedup, filtering, threshold, no-throw) rather
// than a brittle exact RRF ordering — see the per-test notes.

const testState = vi.hoisted(() => ({
  userDataPath: '/tmp/semantic-search-userdata-initial',
  generateEmbeddings: vi.fn<(texts: string[]) => Promise<Float32Array[]>>(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  isAnyTurnActive: vi.fn(() => false),
  waitForTurnIdle: vi.fn(async () => 'idle' as const),
  tryConvertToWorkspacePath: vi.fn((_filePath: string, _workspacePath: string) => null as string | null),
  // Runtime-fallback failure injection (FTS-degraded observability, Phase 6 of
  // docs/plans/260618_semantic-index-error-surfacing/PLAN.md). The native-module
  // mock below delegates to the REAL `@lancedb/lancedb` so the existing
  // real-LanceDB tests are unaffected; when `rerankerCreateError` is set it
  // overrides ONLY `rerankers.RRFReranker.create` to throw (drives the
  // reranker-site catch in search.ts). The `'query'`-site catch is driven by a
  // table proxy (see the runtime-fallback describe block), not via this mock.
  rerankerCreateError: null as Error | null,
  generateQueryEmbeddingError: null as Error | null,
  isTooManyOpenFilesError: vi.fn(() => false),
  markEnfileDetected: vi.fn((_error?: unknown) => ({ isFirstDetection: false })),
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({
    isPackaged: false,
    userDataPath: testState.userDataPath,
    version: '0.0.0',
  }),
}));

vi.mock('@core/lazyElectron', () => ({
  onElectronAppEvent: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  logger: {
    debug: testState.loggerDebug,
    info: testState.loggerInfo,
    warn: testState.loggerWarn,
    error: testState.loggerError,
  },
  createScopedLogger: () => ({
    debug: testState.loggerDebug,
    info: testState.loggerInfo,
    warn: testState.loggerWarn,
    error: testState.loggerError,
  }),
}));

vi.mock('@core/embeddingGenerator', () => ({
  getEmbeddingGenerator: () => ({
    generateEmbedding: async () => Float32Array.from([1, 0]),
    generateQueryEmbedding: async () => {
      if (testState.generateQueryEmbeddingError) {
        throw testState.generateQueryEmbeddingError;
      }
      return Float32Array.from([1, 0]);
    },
    generateEmbeddings: testState.generateEmbeddings,
  }),
}));

vi.mock('./visibilityAwareScheduler', () => ({
  isAnyTurnActive: testState.isAnyTurnActive,
  waitForTurnIdle: testState.waitForTurnIdle,
}));

vi.mock('../sourceMetadataStore', () => ({
  isSourcePath: vi.fn(() => false),
  indexSource: vi.fn(),
}));

vi.mock('../entityMetadataStore', () => ({
  isEntityFile: vi.fn(() => false),
  indexEntity: vi.fn(),
  removeEntity: vi.fn(),
}));

vi.mock('../../utils/systemUtils', () => ({
  tryConvertToWorkspacePath: testState.tryConvertToWorkspacePath,
}));

vi.mock('../../utils/emfileRetry', () => ({
  isTooManyOpenFilesError: testState.isTooManyOpenFilesError,
}));

vi.mock('../../utils/enfileState', () => ({
  isEnfileActive: vi.fn(() => false),
  markEnfileDetected: testState.markEnfileDetected,
}));

vi.mock('../behindTheScenesClient', () => ({
  callWithModelAuthAware: vi.fn(),
}));

vi.mock('../../utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn(() => true),
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

// Wrap `loadNativeModule` so it returns the REAL `@lancedb/lancedb` by default
// (the existing real-DB tests rely on a genuine native module), but lets the
// runtime-fallback tests override `rerankers.RRFReranker.create` to throw. We
// only intercept the reranker factory; every other native symbol passes through
// untouched, so indexing, the FTS index build, and the vector/hybrid query
// chains all keep using the real implementation.
vi.mock('@core/utils/loadNativeModule', async () => {
  const realLancedb = await import('@lancedb/lancedb');
  return {
    loadNativeModule: (moduleName: string) => {
      if (moduleName !== '@lancedb/lancedb') {
        throw new Error(`unexpected native module in test: ${moduleName}`);
      }
      return {
        ...realLancedb,
        rerankers: {
          ...realLancedb.rerankers,
          RRFReranker: {
            ...realLancedb.rerankers.RRFReranker,
            create: async (...args: unknown[]) => {
              if (testState.rerankerCreateError) {
                throw testState.rerankerCreateError;
              }
              return realLancedb.rerankers.RRFReranker.create(
                ...(args as Parameters<typeof realLancedb.rerankers.RRFReranker.create>)
              );
            },
          },
        },
      };
    },
  };
});

import { setErrorReporter } from '@core/errorReporter';
import {
  _getCurrentIndexForTesting,
  closeIndex,
  getSearchMetrics,
  indexFile,
  initializeIndex,
  refreshReadTable,
  resetSearchMetrics,
  semanticSearch,
  semanticSearchWithStatus,
} from '../fileIndexService';
import {
  _resetFtsRuntimeDegradedLatchForTesting,
  _resetSemanticSearchFailureLatchForTesting,
} from '../fileIndexService/search';

async function writeWorkspaceFile(workspacePath: string, relativePath: string, content: string): Promise<string> {
  const filePath = path.join(workspacePath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
}

// A workspace-shaped path that doubles as the PII canary: if a raw LanceDB
// error string leaked into the Sentry payload, this substring would show up.
// The home-prefix is what `redactAndTruncateRawError` normalizes away.
const RUNTIME_PII_CANARY = '/Users/jane/Library/Mobile Documents/com~apple~CloudDocs/Acme/file_embeddings.lance';

describe('fileIndexService semanticSearch', () => {
  let workspacePath: string;
  let canonicalWorkspacePath: string;
  // Per-relativePath: the deterministic vector assigned, plus the raw text content
  // written to disk (so we can drive the FTS branch with real keywords).
  const vectorsByRelativePath = new Map<string, number[]>();

  async function writeIndexedFile(relativePath: string, vector: number[], content?: string): Promise<string> {
    vectorsByRelativePath.set(relativePath, vector);
    const fileContent = content ?? `content for ${relativePath}`;
    const filePath = await writeWorkspaceFile(workspacePath, relativePath, fileContent);
    await indexFile(filePath, workspacePath);
    return fs.realpath(filePath);
  }

  /** Force the search to take the vector-only fallback path by marking FTS as failed. */
  function forceVectorOnlyFallback(): void {
    const currentIndex = _getCurrentIndexForTesting();
    if (currentIndex) {
      currentIndex.ftsStatus = 'failed';
    }
  }

  async function semanticSearchWithThrowingVectorSearch(error: Error) {
    const currentIndex = _getCurrentIndexForTesting();
    if (!currentIndex?.readTable) throw new Error('expected a read-table handle');
    const realHandle = currentIndex.readTable;
    const realTable = realHandle.acquire();
    await realHandle.release();

    const throwingVectorBuilder: Record<string, unknown> = {};
    for (const method of ['distanceType', 'limit', 'where']) {
      throwingVectorBuilder[method] = () => throwingVectorBuilder;
    }
    throwingVectorBuilder.toArray = async () => {
      throw error;
    };

    const tableProxy = new Proxy(realTable as object, {
      get(target, prop, receiver) {
        if (prop === 'vectorSearch') {
          return () => throwingVectorBuilder;
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    currentIndex.readTable = {
      acquire: () => tableProxy as never,
      release: async () => {},
    } as never;

    try {
      return await semanticSearchWithStatus('anything', { limit: 5 });
    } finally {
      currentIndex.readTable = realHandle;
    }
  }

  beforeEach(async () => {
    testState.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-search-userdata-'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-search-workspace-'));
    canonicalWorkspacePath = await fs.realpath(workspacePath);
    vectorsByRelativePath.clear();
    testState.generateEmbeddings.mockReset();
    // Deterministic embeddings: key off the `Path:` line that buildEmbeddingText emits
    // into the enriched text, so each file gets exactly the vector the test assigned.
    testState.generateEmbeddings.mockImplementation(async (texts) =>
      texts.map((text) => {
        const relativePath = /^Path: (.+)$/m.exec(text)?.[1];
        const vector = relativePath ? vectorsByRelativePath.get(relativePath) : undefined;
        return Float32Array.from(vector ?? [1, 0]);
      })
    );
    testState.tryConvertToWorkspacePath.mockReset();
    testState.tryConvertToWorkspacePath.mockImplementation((filePath) => {
      const relativePath = path.relative(canonicalWorkspacePath, filePath);
      return relativePath.startsWith('..') || path.isAbsolute(relativePath) ? null : relativePath;
    });
    testState.isAnyTurnActive.mockReset();
    testState.isAnyTurnActive.mockReturnValue(false);
    testState.waitForTurnIdle.mockClear();
    testState.loggerDebug.mockClear();
    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();
    testState.loggerError.mockClear();
    testState.rerankerCreateError = null;
    testState.generateQueryEmbeddingError = null;
    testState.isTooManyOpenFilesError.mockReset();
    testState.isTooManyOpenFilesError.mockReturnValue(false);
    testState.markEnfileDetected.mockClear();
    resetSearchMetrics();
    _resetSemanticSearchFailureLatchForTesting();
  });

  afterEach(async () => {
    const currentIndex = _getCurrentIndexForTesting();
    if (currentIndex && currentIndex.workspacePath !== workspacePath) {
      currentIndex.workspacePath = workspacePath;
    }
    await closeIndex();
    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.rm(testState.userDataPath, { recursive: true, force: true });
  });

  // 1. Top-k ordering (vector-only path) — query embedding is [1, 0], so files rank
  //    by alignment of their assigned vector with [1, 0] (descending cosine similarity).
  it('returns the most-similar files ranked by descending similarity (vector-only)', async () => {
    await writeIndexedFile('aligned.md', [1, 0]); // score 1.0
    await writeIndexedFile('close.md', [0.8, 0.6]); // score 0.8
    await writeIndexedFile('mid.md', [0.6, 0.8]); // score 0.6
    await refreshReadTable();
    forceVectorOnlyFallback();

    const results = await semanticSearch('anything', { limit: 10 });

    expect(results.map((r) => r.relativePath)).toEqual(['aligned.md', 'close.md', 'mid.md']);
    // Scores are the raw cosine similarity (0-1), monotonically non-increasing.
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  // 1b. Top-k limit — `limit` caps the number of returned results.
  it('caps the result count at the requested limit (vector-only)', async () => {
    await writeIndexedFile('a.md', [1, 0]);
    await writeIndexedFile('b.md', [0.9, Math.sqrt(1 - 0.81)]);
    await writeIndexedFile('c.md', [0.8, 0.6]);
    await writeIndexedFile('d.md', [0.7, Math.sqrt(1 - 0.49)]);
    await refreshReadTable();
    forceVectorOnlyFallback();

    const results = await semanticSearch('anything', { limit: 2 });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.relativePath)).toEqual(['a.md', 'b.md']);
  });

  // 2. Threshold cutoff — results whose cosine similarity is below `threshold` are excluded.
  it('excludes results below the score threshold (vector-only)', async () => {
    await writeIndexedFile('high.md', [1, 0]); // score 1.0
    await writeIndexedFile('low.md', [0.2, Math.sqrt(1 - 0.04)]); // score 0.2 < 0.5
    await refreshReadTable();
    forceVectorOnlyFallback();

    const results = await semanticSearch('anything', { limit: 10, threshold: 0.5 });

    expect(results.map((r) => r.relativePath)).toEqual(['high.md']);
    expect(results.every((r) => r.score >= 0.5)).toBe(true);
  });

  // 3. fileTypes filter — only files whose extension matches one of fileTypes are returned.
  it('returns only files matching the fileTypes filter (vector-only)', async () => {
    await writeIndexedFile('note.md', [1, 0]);
    await writeIndexedFile('script.ts', [0.95, Math.sqrt(1 - 0.9025)]);
    await writeIndexedFile('readme.txt', [0.9, Math.sqrt(1 - 0.81)]);
    await refreshReadTable();
    forceVectorOnlyFallback();

    const results = await semanticSearch('anything', { limit: 10, fileTypes: ['md'] });

    expect(results.map((r) => r.relativePath)).toEqual(['note.md']);
    expect(results.every((r) => r.extension === '.md')).toBe(true);
  });

  // 4. pathPrefix filter — only files whose relativePath is under the prefix are returned.
  it('returns only files under the pathPrefix (vector-only)', async () => {
    await writeIndexedFile('docs/guide.md', [1, 0]);
    await writeIndexedFile('docs/intro.md', [0.95, Math.sqrt(1 - 0.9025)]);
    await writeIndexedFile('src/main.md', [0.9, Math.sqrt(1 - 0.81)]);
    await refreshReadTable();
    forceVectorOnlyFallback();

    const results = await semanticSearch('anything', { limit: 10, pathPrefix: 'docs/' });

    expect(results.map((r) => r.relativePath).sort()).toEqual(['docs/guide.md', 'docs/intro.md']);
    expect(results.every((r) => r.relativePath.startsWith('docs/'))).toBe(true);
  });

  // 5. Hybrid path — with FTS ready (the default after a fresh-workspace index), the
  //    keyword+vector branch runs and RRF-combines results. We assert the reliable
  //    invariants: results come back, are correctly shaped, deduped, and a keyword-and-
  //    vector match is present. Exact RRF ordering is NOT asserted (it depends on
  //    LanceDB's native reranker internals and the always-[1,0] mocked query vector,
  //    which would make an exact-order assertion brittle) — documented limitation.
  it('runs the hybrid FTS+vector path and returns correctly-shaped deduped results when FTS is ready', async () => {
    const alphaPath = await writeIndexedFile('alpha.md', [1, 0], 'alpha lighthouse beacon notes');
    await writeIndexedFile('beta.md', [0.6, 0.8], 'beta unrelated grocery list');
    await refreshReadTable();

    // FTS is 'ready' by default after the fresh-workspace bootstrap index — do NOT
    // force the fallback here, so the hybrid branch executes. (Setting up the gate via
    // the internal struct is fine; we do not *assert* on the struct field.)
    const results = await semanticSearch('lighthouse', { limit: 10, threshold: 0 });

    // BRANCH-SELECTION INVARIANT (behavioral, non-struct): the 'Search completed' info
    // log carries the chosen search mode. With FTS ready, the HYBRID branch must run.
    // This is the only signal that survives a `WorkspaceIndex` reshape and that goes RED
    // if the `useHybrid` gate is decoupled from `ftsStatus` (forced false → vector-only).
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'hybrid' }),
      'Search completed'
    );
    expect(testState.loggerInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'vector-only' }),
      'Search completed'
    );

    // Hybrid path returned results without throwing, the keyword+vector match is present.
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.map((r) => r.path)).toContain(alphaPath);
    // No duplicate paths.
    const paths = results.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    // Documented result shape on the hybrid path.
    for (const r of results) {
      expect(r).toEqual(
        expect.objectContaining({
          path: expect.any(String),
          relativePath: expect.any(String),
          snippet: expect.any(String),
          score: expect.any(Number),
          extension: expect.any(String),
          chunkIndex: expect.any(Number),
        })
      );
    }
  });

  // 6. Fallback — forcing ftsStatus to a non-ready/failed state makes semanticSearch
  //    take the vector-only branch and still return correct-shape results (no throw).
  it('falls back to vector-only and returns correct-shape results when FTS is failed', async () => {
    const alignedPath = await writeIndexedFile('fallback-aligned.md', [1, 0], 'lighthouse beacon');
    await writeIndexedFile('fallback-other.md', [0.5, Math.sqrt(1 - 0.25)], 'unrelated content');
    await refreshReadTable();
    // Force the gate to the fallback via the internal struct (setup, not asserted).
    forceVectorOnlyFallback();

    const results = await semanticSearch('lighthouse', { limit: 10, threshold: 0 });

    // BRANCH-SELECTION INVARIANT (behavioral, non-struct): with FTS forced 'failed' the
    // VECTOR-ONLY branch must run. Goes RED if the `useHybrid` gate is forced true
    // (decoupled from ftsStatus), which is the inversion the characterization net missed.
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'vector-only' }),
      'Search completed'
    );
    expect(testState.loggerInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'hybrid' }),
      'Search completed'
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    // Vector-only ranks purely by similarity to [1, 0], so the aligned file is first.
    expect(results[0].path).toBe(alignedPath);
    expect(results[0].relativePath).toBe('fallback-aligned.md');
    for (const r of results) {
      expect(r).toEqual(
        expect.objectContaining({
          path: expect.any(String),
          relativePath: expect.any(String),
          snippet: expect.any(String),
          score: expect.any(Number),
          extension: expect.any(String),
          chunkIndex: expect.any(Number),
        })
      );
    }
  });

  // 6b. Fallback when index uninitialized / no table — returns [] (no throw).
  it('returns [] when the index has no searchable table', async () => {
    await initializeIndex(workspacePath); // no files indexed -> no chunks table

    await expect(semanticSearch('anything', { limit: 5 })).resolves.toEqual([]);
  });

  // 7. Result shape / dedup — a multi-chunk file (two chunks) must appear exactly once,
  //    keyed by path, with the documented SemanticSearchResult fields.
  it('dedups by path so a multi-chunk file appears once with documented fields (vector-only)', async () => {
    // ~2500 chars of single-token-rich text forces chunkText (maxSize 2000, overlap 200)
    // to emit two chunks for this file; both chunks share the same path/vector.
    const longContent = `Path-marker line\n${'word '.repeat(600)}`;
    const multiPath = await writeIndexedFile('multi.md', [1, 0], longContent);
    await writeIndexedFile('single.md', [0.8, 0.6]);
    await refreshReadTable();
    forceVectorOnlyFallback();

    const results = await semanticSearch('anything', { limit: 10 });

    const multiResults = results.filter((r) => r.path === multiPath);
    expect(multiResults).toHaveLength(1); // deduped despite multiple chunks
    expect(new Set(results.map((r) => r.path)).size).toBe(results.length);
    expect(multiResults[0]).toEqual(
      expect.objectContaining({
        path: multiPath,
        relativePath: 'multi.md',
        snippet: expect.any(String),
        score: expect.any(Number),
        extension: '.md',
        chunkIndex: expect.any(Number),
      })
    );
  });

  // 8. getSearchMetrics accounting — searchCount increments per call, avgSearchTimeMs is
  //    derived, and a search over an uninitialized index counts but does not mark a failure
  //    (the empty-index early-return is a graceful [] , not a failure).
  it('updates getSearchMetrics across searches (vector-only)', async () => {
    await writeIndexedFile('metrics.md', [1, 0]);
    await refreshReadTable();
    forceVectorOnlyFallback();

    const before = getSearchMetrics();
    expect(before.searchCount).toBe(0);
    expect(before.searchFailures).toBe(0);
    expect(before.avgSearchTimeMs).toBe(0);

    await semanticSearch('anything', { limit: 5 });
    await semanticSearch('anything else', { limit: 5 });

    const after = getSearchMetrics();
    expect(after.searchCount).toBe(2);
    expect(after.searchFailures).toBe(0);
    // avgSearchTimeMs = round(totalSearchTimeMs / searchCount); non-negative integer.
    expect(after.avgSearchTimeMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(after.avgSearchTimeMs)).toBe(true);
  });

  // 8b. Metrics: an empty-index search still increments searchCount but records no failure.
  it('counts an empty-index search without recording a failure', async () => {
    await initializeIndex(workspacePath);

    await semanticSearch('anything', { limit: 5 });

    const metrics = getSearchMetrics();
    expect(metrics.searchCount).toBe(1);
    expect(metrics.searchFailures).toBe(0);
  });

  it('semanticSearchWithStatus returns index_not_ready when the index has no searchable table', async () => {
    await initializeIndex(workspacePath);

    const result = await semanticSearchWithStatus('anything', { limit: 5 });

    expect(result).toEqual({ status: 'index_not_ready', results: [] });
    await expect(semanticSearch('anything', { limit: 5 })).resolves.toEqual([]);
  });

  it('semanticSearchWithStatus returns embedding_unavailable when query embedding fails', async () => {
    await writeIndexedFile('ready.md', [1, 0]);
    await refreshReadTable();
    testState.generateQueryEmbeddingError = new Error('embedding service unavailable');

    const result = await semanticSearchWithStatus('anything', { limit: 5 });

    expect(result).toEqual({ status: 'embedding_unavailable', results: [] });
  });

  it('semanticSearchWithStatus returns embedding_unavailable for ENFILE after embedding generation', async () => {
    await writeIndexedFile('ready.md', [1, 0]);
    await refreshReadTable();
    forceVectorOnlyFallback();
    testState.isTooManyOpenFilesError.mockReturnValue(true);

    const result = await semanticSearchWithThrowingVectorSearch(
      Object.assign(new Error('too many files open'), { code: 'ENFILE' }),
    );

    expect(result).toEqual({ status: 'embedding_unavailable', results: [] });
    expect(testState.markEnfileDetected).toHaveBeenCalledTimes(1);
  });

  it('semanticSearchWithStatus captures unexpected post-embedding failures once with redacted payload', async () => {
    const captured = installCaptureRecorder();
    try {
      await writeIndexedFile('ready.md', [1, 0]);
      await refreshReadTable();
      forceVectorOnlyFallback();

      const failure = new Error(`vector query failed at ${RUNTIME_PII_CANARY}`);
      const first = await semanticSearchWithThrowingVectorSearch(failure);
      const second = await semanticSearchWithThrowingVectorSearch(failure);

      expect(first.status).toBe('error');
      expect(first.results).toEqual([]);
      expect(first.message).not.toContain(RUNTIME_PII_CANARY);
      expect(second.status).toBe('error');

      expect(captured).toHaveLength(1);
      expect(captured[0].context).toMatchObject({
        level: 'warning',
        fingerprint: ['file-index-semantic-search-failed'],
        _knownConditionWrapped: true,
      });
      const err = captured[0].error as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toContain(RUNTIME_PII_CANARY);
      const serialized = JSON.stringify({
        message: err.message,
        stack: err.stack,
        context: captured[0].context,
      });
      expect(serialized).not.toContain(RUNTIME_PII_CANARY);
    } finally {
      setErrorReporter({
        captureException: () => {},
        captureMessage: () => {},
        addBreadcrumb: () => {},
      });
    }
  });

  it('semanticSearchWithStatus returns ok with results and ok with empty results', async () => {
    await writeIndexedFile('aligned.md', [1, 0]);
    await writeIndexedFile('below-threshold.md', [0.2, Math.sqrt(1 - 0.04)]);
    await refreshReadTable();
    forceVectorOnlyFallback();

    const withResults = await semanticSearchWithStatus('anything', { limit: 10, threshold: 0.5 });
    const empty = await semanticSearchWithStatus('anything', { limit: 10, threshold: 1.1 });

    expect(withResults.status).toBe('ok');
    expect(withResults.results.map((r) => r.relativePath)).toEqual(['aligned.md']);
    expect(empty).toEqual({ status: 'ok', results: [] });
  });
});

// ---------------------------------------------------------------------------
// FTS runtime-fallback observability (Phase 6 of
// docs/plans/260618_semantic-index-error-surfacing/PLAN.md).
//
// Companion to fileIndexService.ftsDegradedObservability.test.ts, which covers
// the BUILD path (`ensureFTSIndexes`). This block covers the QUERY-TIME runtime
// fallback in search.ts: the two catch sites (reranker-create / hybrid-query)
// behind their own module-level latch (`ftsRuntimeDegradedLatch`, keyed
// `${workspacePath}:runtime:${site}`). Both fall back to vector-only WITHOUT
// mutating `ftsStatus`, and emit `file_index_fts_degraded` (phase: 'runtime')
// at most once per process per site — PII-safe (redacted synthetic Error).
//
// Harness: the real-LanceDB index from above (so the vector-only fallback
// returns genuine rows), with FTS forced 'ready' so the hybrid branch runs.
// Case A drives the reranker catch via the `loadNativeModule` mock's
// `rerankerCreateError` lever; Case B drives the query catch by proxying the
// read-table handle so the hybrid `.query()...toArray()` rejects while the
// vector-only `.vectorSearch()` path delegates to the real table.
// ---------------------------------------------------------------------------

type RuntimeCaptured = Array<{ error: unknown; context?: Record<string, unknown> }>;

function installCaptureRecorder(): RuntimeCaptured {
  const captured: RuntimeCaptured = [];
  setErrorReporter({
    captureException: (error, context) => {
      captured.push({ error, context });
    },
    captureMessage: () => {},
    addBreadcrumb: () => {},
  });
  return captured;
}

describe('fileIndexService semanticSearch — FTS runtime-fallback observability', () => {
  let workspacePath: string;
  let canonicalWorkspacePath: string;
  let captured: RuntimeCaptured;
  const vectorsByRelativePath = new Map<string, number[]>();

  async function writeIndexedFile(relativePath: string, vector: number[], content?: string): Promise<string> {
    vectorsByRelativePath.set(relativePath, vector);
    const filePath = path.join(workspacePath, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content ?? `content for ${relativePath}`);
    await indexFile(filePath, workspacePath);
    return fs.realpath(filePath);
  }

  function ensureFtsReady(): void {
    const currentIndex = _getCurrentIndexForTesting();
    if (!currentIndex) throw new Error('expected a current index in runtime-fallback test');
    currentIndex.ftsStatus = 'ready';
  }

  beforeEach(async () => {
    testState.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-search-runtime-userdata-'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-search-runtime-workspace-'));
    canonicalWorkspacePath = await fs.realpath(workspacePath);
    vectorsByRelativePath.clear();
    testState.generateEmbeddings.mockReset();
    testState.generateEmbeddings.mockImplementation(async (texts) =>
      texts.map((text) => {
        const relativePath = /^Path: (.+)$/m.exec(text)?.[1];
        const vector = relativePath ? vectorsByRelativePath.get(relativePath) : undefined;
        return Float32Array.from(vector ?? [1, 0]);
      })
    );
    testState.tryConvertToWorkspacePath.mockReset();
    testState.tryConvertToWorkspacePath.mockImplementation((filePath) => {
      const relativePath = path.relative(canonicalWorkspacePath, filePath);
      return relativePath.startsWith('..') || path.isAbsolute(relativePath) ? null : relativePath;
    });
    testState.isAnyTurnActive.mockReset();
    testState.isAnyTurnActive.mockReturnValue(false);
    testState.loggerDebug.mockClear();
    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();
    testState.loggerError.mockClear();
    testState.rerankerCreateError = null;
    resetSearchMetrics();
    // Consumes the (otherwise-dead) reset seam exported from search.ts.
    _resetFtsRuntimeDegradedLatchForTesting();
    _resetSemanticSearchFailureLatchForTesting();
    captured = installCaptureRecorder();
  });

  afterEach(async () => {
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
    const currentIndex = _getCurrentIndexForTesting();
    if (currentIndex && currentIndex.workspacePath !== workspacePath) {
      currentIndex.workspacePath = workspacePath;
    }
    await closeIndex();
    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.rm(testState.userDataPath, { recursive: true, force: true });
  });

  // Case A: RRFReranker.create() throws → exactly ONE 'runtime' capture, PII-safe,
  // and a SECOND failing query at the same site does NOT re-capture (latch proof).
  it('captures file_index_fts_degraded once when the reranker fails at runtime, and latches', async () => {
    await writeIndexedFile('alpha.md', [1, 0], 'lighthouse beacon notes');
    await refreshReadTable();
    ensureFtsReady();

    // Raw error carries the PII canary; the redacted synthetic Error must not.
    testState.rerankerCreateError = new Error(`RRFReranker.create failed reading ${RUNTIME_PII_CANARY}`);

    const results = await semanticSearch('lighthouse', { limit: 10, threshold: 0 });

    // Behaviour-preserving fallback: degrades to vector-only, still returns results.
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'vector-only' }),
      'Search completed'
    );

    // Exactly ONE capture, routed through captureKnownCondition with the runtime
    // fingerprint + phase. (Would be 0 if the capture call were absent.)
    expect(captured).toHaveLength(1);
    const ctx = captured[0].context ?? {};
    expect(ctx).toMatchObject({
      level: 'warning',
      fingerprint: ['file-index-fts-degraded', 'runtime'],
      _knownConditionWrapped: true,
      phase: 'runtime',
    });

    // PII proof: the synthetic Error (and serialized payload) carries NO canary.
    const err = captured[0].error as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(RUNTIME_PII_CANARY);
    const serialized = JSON.stringify({ message: err.message, stack: err.stack, context: ctx });
    expect(serialized).not.toContain(RUNTIME_PII_CANARY);

    // Latch proof: a SECOND failing query at the same site does NOT re-capture.
    await semanticSearch('lighthouse again', { limit: 10, threshold: 0 });
    expect(captured).toHaveLength(1);
  });

  // Case B: reranker OK, but the hybrid query's toArray() throws → exactly ONE
  // 'query'-site capture, and the search still returns vector-only results.
  it('captures once and falls back to vector-only when the hybrid query fails at runtime', async () => {
    const alignedPath = await writeIndexedFile('aligned.md', [1, 0], 'lighthouse beacon');
    await writeIndexedFile('other.md', [0.5, Math.sqrt(1 - 0.25)], 'unrelated content');
    await refreshReadTable();
    ensureFtsReady();

    // Proxy the read-table handle so the hybrid query chain rejects at toArray()
    // (driving the 'query'-site catch) while the vector-only fallback's
    // `.vectorSearch()` delegates to the REAL table and returns genuine rows.
    const currentIndex = _getCurrentIndexForTesting();
    if (!currentIndex?.readTable) throw new Error('expected a read-table handle in Case B');
    const realHandle = currentIndex.readTable;
    const realTable = realHandle.acquire();
    await realHandle.release();

    const throwingHybridBuilder: Record<string, unknown> = {};
    for (const method of ['nearestTo', 'distanceType', 'fullTextSearch', 'rerank', 'limit', 'where']) {
      throwingHybridBuilder[method] = () => throwingHybridBuilder;
    }
    throwingHybridBuilder.toArray = async () => {
      throw new Error(`hybrid query failed reading ${RUNTIME_PII_CANARY}`);
    };

    const tableProxy = new Proxy(realTable as object, {
      get(target, prop, receiver) {
        // The hybrid path enters via `.query()`; force its toArray() to reject.
        if (prop === 'query') {
          return () => throwingHybridBuilder;
        }
        // Everything else (notably `.vectorSearch()` for the fallback) is real.
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    currentIndex.readTable = {
      acquire: () => tableProxy as never,
      release: async () => {},
    } as never;

    let results: Awaited<ReturnType<typeof semanticSearch>>;
    try {
      results = await semanticSearch('lighthouse', { limit: 10, threshold: 0 });
    } finally {
      // Restore the real handle so afterEach's closeIndex() retire/drain works.
      currentIndex.readTable = realHandle;
    }

    // Behaviour-preserving fallback: vector-only results returned (not a throw).
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toBe(alignedPath);
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'vector-only' }),
      'Search completed'
    );

    // Exactly ONE capture for the runtime ('query') site.
    expect(captured).toHaveLength(1);
    expect(captured[0].context).toMatchObject({
      level: 'warning',
      fingerprint: ['file-index-fts-degraded', 'runtime'],
      phase: 'runtime',
    });
    const err = captured[0].error as Error;
    expect(err.message).not.toContain(RUNTIME_PII_CANARY);
  });
});
