import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Black-box characterization tests for `indexFile` / `chunkText` + the FTS lifecycle
// (CHIEF_ENGINEER2 Stage A2). These pin the OBSERVABLE indexing behavior — chunk
// count + overlap, skip rules (empty / oversize / shouldIndexFile), the persisted
// chunk-table row shape (`totalChunks`, `filename_stem`, `is_enhanced`, `enhanced_at`),
// and the FTS gate that decides hybrid-vs-vector-only search — so the coming
// decomposition has a safety net.
//
// Assertions are on observable outputs: the integer return of `indexFile` (chunk
// count), the exported `shouldIndexFile` predicate, rows read back from the real
// LanceDB chunk table via an independent second connection (the established
// fileVectors-test harness), and the public `semanticSearch` branch selection. No
// new `currentIndex` / `WorkspaceIndex` struct coupling is introduced beyond the
// pre-existing `_getCurrentIndexForTesting` seam (used only for the minimal
// `ftsStatus` field assertion in the FTS-lifecycle test, mirroring Stage A1).
//
// The harness (mkdtemp temp DB + deterministic embeddings keyed off the `Path:`
// enrichment line) is copied from `fileIndexService.semanticSearch.test.ts` /
// `fileIndexService.fileVectors.test.ts`.

const testState = vi.hoisted(() => ({
  userDataPath: '/tmp/index-file-userdata-initial',
  generateEmbeddings: vi.fn<(texts: string[]) => Promise<Float32Array[]>>(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  isAnyTurnActive: vi.fn(() => false),
  waitForTurnIdle: vi.fn(async () => 'idle' as const),
  tryConvertToWorkspacePath: vi.fn((_filePath: string, _workspacePath: string) => null as string | null),
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
    generateQueryEmbedding: async () => Float32Array.from([1, 0]),
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
  isTooManyOpenFilesError: vi.fn(() => false),
}));

vi.mock('../../utils/enfileState', () => ({
  isEnfileActive: vi.fn(() => false),
  markEnfileDetected: vi.fn((_error?: unknown) => ({ isFirstDetection: false })),
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

import {
  _getCurrentIndexForTesting,
  closeIndex,
  indexFile,
  initializeIndex,
  needsReindexing,
  refreshReadTable,
  semanticSearch,
  shouldIndexFile,
} from '../fileIndexService';

const FILE_EMBEDDINGS_TABLE_NAME = 'file_embeddings';
// Mirror the source constants (MAX_CHUNK_SIZE / CHUNK_OVERLAP / MAX_FILE_SIZE) so the
// chunk-count + overlap expectations are derived from the same numbers the source uses.
const MAX_CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;
const MAX_FILE_SIZE = 1024 * 1024;

function workspaceHash(workspacePath: string): string {
  return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
}

function getLanceDBDir(workspacePath: string): string {
  return path.join(testState.userDataPath, 'indices', workspaceHash(workspacePath), 'lancedb');
}

async function closeConnection(connection: unknown): Promise<void> {
  const maybeClosable = connection as { close?: () => void | Promise<void> };
  await maybeClosable.close?.();
}

interface ChunkRow {
  path: string;
  relativePath: string;
  content: string;
  extension: string;
  chunkIndex: number;
  totalChunks: number;
  filename_stem: string;
  is_enhanced: number;
  enhanced_at: number;
}

/**
 * Read the persisted chunk rows for a path from the real LanceDB chunk table via an
 * independent second connection (the established out-of-band inspection pattern). Only
 * scalar columns are selected (the vector column is omitted to avoid Arrow plumbing).
 */
async function readChunkRows(workspacePath: string): Promise<ChunkRow[]> {
  const lancedb = await import('@lancedb/lancedb');
  const connection = await lancedb.connect(getLanceDBDir(workspacePath));
  try {
    const table = await connection.openTable(FILE_EMBEDDINGS_TABLE_NAME);
    const rows = await table
      .query()
      .select([
        'path',
        'relativePath',
        'content',
        'extension',
        'chunkIndex',
        'totalChunks',
        'filename_stem',
        'is_enhanced',
        'enhanced_at',
      ])
      .toArray();
    return (rows as ChunkRow[]).map((r) => ({ ...r }));
  } finally {
    await closeConnection(connection);
  }
}

describe('fileIndexService indexFile / chunkText + FTS lifecycle', () => {
  let workspacePath: string;
  let canonicalWorkspacePath: string;
  const vectorsByRelativePath = new Map<string, number[]>();

  async function writeWorkspaceFile(relativePath: string, content: string): Promise<string> {
    const filePath = path.join(workspacePath, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    return filePath;
  }

  async function writeIndexedFile(
    relativePath: string,
    content: string,
    vector: number[] = [1, 0]
  ): Promise<{ filePath: string; chunkCount: number }> {
    vectorsByRelativePath.set(relativePath, vector);
    const filePath = await writeWorkspaceFile(relativePath, content);
    const chunkCount = await indexFile(filePath, workspacePath);
    return { filePath, chunkCount };
  }

  beforeEach(async () => {
    testState.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'index-file-userdata-'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'index-file-workspace-'));
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
    testState.waitForTurnIdle.mockClear();
    testState.loggerDebug.mockClear();
    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();
    testState.loggerError.mockClear();
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

  // 1. chunkText multi-chunk count + overlap. A single-token-rich body longer than
  //    MAX_CHUNK_SIZE is split into multiple chunks. We characterize: (a) the chunk
  //    count matches indexFile's return AND the persisted rows, (b) totalChunks on
  //    every row equals that count, and (c) consecutive chunks overlap — the tail of
  //    chunk N reappears at the head of chunk N+1 (the CHUNK_OVERLAP back-step).
  it('splits a long file into multiple overlapping chunks', async () => {
    // POSITIONALLY-DISTINCT filler: each token (`w000000 `, 8 chars) is unique, so the
    // overlap region between adjacent chunks is content we can detect (uniform filler
    // would make overlap invisible and the injected-regression check toothless).
    // ~1000 tokens ~= 8000 chars, comfortably > 3x MAX_CHUNK_SIZE.
    const tokens = Array.from({ length: 1000 }, (_, i) => `w${String(i).padStart(6, '0')}`);
    const longContent = `Path-marker top line ${tokens.join(' ')}`;
    expect(longContent.length).toBeGreaterThan(MAX_CHUNK_SIZE * 2);

    const { chunkCount } = await writeIndexedFile('long.md', longContent);

    // Multi-chunk: more than one chunk for a > MAX_CHUNK_SIZE body.
    expect(chunkCount).toBeGreaterThan(1);

    const rows = (await readChunkRows(workspacePath)).sort((a, b) => a.chunkIndex - b.chunkIndex);
    expect(rows).toHaveLength(chunkCount);
    // totalChunks recorded on every row equals the actual chunk count.
    expect(rows.every((r) => r.totalChunks === chunkCount)).toBe(true);
    // chunkIndex is a dense 0..n-1 sequence.
    expect(rows.map((r) => r.chunkIndex)).toEqual(rows.map((_, i) => i));

    // Each chunk is at most MAX_CHUNK_SIZE + 1 characters. Characterize-as-is: the
    // split lands on a word/newline boundary via `end = lastSpace + 1`, so a chunk can
    // be one character longer than MAX_CHUNK_SIZE when the boundary sits at the bound.
    for (const r of rows) {
      expect(r.content.length).toBeLessThanOrEqual(MAX_CHUNK_SIZE + 1);
    }

    // Overlap: the source steps `start = end - overlap`, so adjacent chunks share a
    // run of content at the boundary. With positionally-distinct tokens, the first
    // unique token of chunk N+1 must also appear in chunk N's tail (it is within the
    // last `overlap` characters of chunk N). This goes RED if overlap is removed.
    for (let i = 1; i < rows.length; i++) {
      const nextHeadToken = rows[i].content.trim().split(/\s+/)[0];
      expect(nextHeadToken.length).toBeGreaterThan(0);
      // The leading token of the next chunk lives inside the previous chunk's overlap
      // tail (the back-step region), proving the chunks are not disjoint.
      const prevTail = rows[i - 1].content.slice(-(CHUNK_OVERLAP + nextHeadToken.length));
      expect(prevTail.includes(nextHeadToken)).toBe(true);
    }
  });

  // 1b. A short file (<= MAX_CHUNK_SIZE) produces exactly one chunk.
  it('produces a single chunk for a short file', async () => {
    const { chunkCount } = await writeIndexedFile('short.md', 'just a short note');
    expect(chunkCount).toBe(1);

    const rows = await readChunkRows(workspacePath);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalChunks).toBe(1);
    expect(rows[0].chunkIndex).toBe(0);
  });

  // 2. Empty file — skipped, produces no chunks (stat.size === 0 early-return).
  it('skips an empty file and indexes no chunks', async () => {
    const { chunkCount } = await writeIndexedFile('empty.md', '');
    expect(chunkCount).toBe(0);

    // Empty file is the first/only file -> no chunk table was ever created.
    const lancedb = await import('@lancedb/lancedb');
    const connection = await lancedb.connect(getLanceDBDir(workspacePath));
    try {
      const tableNames = await connection.tableNames();
      expect(tableNames).not.toContain(FILE_EMBEDDINGS_TABLE_NAME);
    } finally {
      await closeConnection(connection);
    }
  });

  // 2b. Empty file alongside a real file — only the non-empty file's chunks persist.
  it('skips an empty file but still indexes a populated sibling', async () => {
    const { chunkCount: realCount } = await writeIndexedFile('real.md', 'real content here');
    const { chunkCount: emptyCount } = await writeIndexedFile('blank.md', '');

    expect(realCount).toBe(1);
    expect(emptyCount).toBe(0);

    const rows = await readChunkRows(workspacePath);
    expect(rows.map((r) => r.relativePath)).toEqual(['real.md']);
  });

  // 3. Oversize file (> MAX_FILE_SIZE) — skipped.
  it('skips a file larger than MAX_FILE_SIZE', async () => {
    const oversized = 'a'.repeat(MAX_FILE_SIZE + 1);
    const { chunkCount } = await writeIndexedFile('huge.md', oversized);
    expect(chunkCount).toBe(0);

    const lancedb = await import('@lancedb/lancedb');
    const connection = await lancedb.connect(getLanceDBDir(workspacePath));
    try {
      const tableNames = await connection.tableNames();
      expect(tableNames).not.toContain(FILE_EMBEDDINGS_TABLE_NAME);
    } finally {
      await closeConnection(connection);
    }
  });

  // 4. shouldIndexFile include/exclude rules for representative paths/extensions.
  it('classifies representative paths via shouldIndexFile', () => {
    // Included extensions / well-known names.
    expect(shouldIndexFile('/ws/notes.md')).toBe(true);
    expect(shouldIndexFile('/ws/src/app.ts')).toBe(true);
    expect(shouldIndexFile('/ws/readme.txt')).toBe(true);
    expect(shouldIndexFile('/ws/Dockerfile')).toBe(true);
    expect(shouldIndexFile('/ws/README')).toBe(true);
    expect(shouldIndexFile('/ws/Makefile')).toBe(true);

    // Excluded: unknown / non-indexable extensions.
    expect(shouldIndexFile('/ws/image.png')).toBe(false);
    expect(shouldIndexFile('/ws/archive.zip')).toBe(false);

    // Excluded: secret/credential patterns even with an otherwise-indexable shape.
    expect(shouldIndexFile('/ws/.env')).toBe(false);
    expect(shouldIndexFile('/ws/server.key')).toBe(false);
    expect(shouldIndexFile('/ws/tls.pem')).toBe(false);
    expect(shouldIndexFile('/ws/my-credentials.md')).toBe(false);

    // Excluded: explicitly NOT-indexed config types that may hold secrets.
    expect(shouldIndexFile('/ws/app.ini')).toBe(false);
    expect(shouldIndexFile('/ws/app.conf')).toBe(false);
  });

  // 4b. indexFile honours shouldIndexFile — a non-indexable extension returns 0 chunks.
  it('returns 0 chunks for a path rejected by shouldIndexFile', async () => {
    // Seed a real indexable file first so the chunk table exists, isolating the skip.
    await writeIndexedFile('seed.md', 'seed content');
    const { chunkCount } = await writeIndexedFile('photo.png', 'binary-ish content');
    expect(chunkCount).toBe(0);

    const rows = await readChunkRows(workspacePath);
    expect(rows.map((r) => r.relativePath)).toEqual(['seed.md']);
  });

  // 5. Chunk row shape — persisted rows carry the documented columns with sane values:
  //    filename_stem = basename sans extension, is_enhanced = 0 and enhanced_at = 0
  //    initially, extension = lowercased ext, totalChunks consistent.
  it('persists chunk rows with the documented column shape and initial enhancement flags', async () => {
    await writeIndexedFile('docs/Guide.MD', 'guidance content for the row-shape test');

    const rows = await readChunkRows(workspacePath);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];

    expect(row).toEqual(
      expect.objectContaining({
        relativePath: 'docs/Guide.MD',
        content: expect.any(String),
        chunkIndex: 0,
        totalChunks: rows.length,
        // filename_stem is the basename without its extension.
        filename_stem: 'Guide',
        // Extension is lowercased at index time.
        extension: '.md',
        // Freshly indexed chunks are NOT enhanced.
        is_enhanced: 0,
        enhanced_at: 0,
      })
    );
    // path is the absolute (canonical) on-disk path.
    expect(path.isAbsolute(row.path)).toBe(true);
    expect(row.path.endsWith(path.join('docs', 'Guide.MD'))).toBe(true);
  });

  // 6. FTS lifecycle — after indexing a populated workspace, FTS indexes are created on
  //    the fresh table and ftsStatus becomes 'ready'. We assert the FTS-lifecycle
  //    signal directly (ftsStatus === 'ready', minimal struct-field read as in Stage
  //    A1) AND a behavioral consequence: with FTS ready the hybrid branch runs and
  //    returns correctly-shaped, deduped results that include the keyword match,
  //    without throwing.
  //
  //    Characterize-as-is surprise: the threshold is applied to the manually-computed
  //    COSINE similarity score even on the hybrid path (source ~L3048-3053), NOT to the
  //    RRF score — so a keyword-only file whose vector is orthogonal to the query is
  //    still dropped by a positive threshold despite an FTS match. We therefore use
  //    threshold 0 here so the FTS-matched file survives, and do not claim an
  //    orthogonal-vector file is uniquely surfaced by hybrid (it is not, under any
  //    positive threshold). Exact RRF ordering is not asserted (brittle, per A1).
  it('marks FTS ready after indexing and runs the hybrid branch (correct shape, includes keyword match)', async () => {
    const { filePath: keywordPath } = await writeIndexedFile(
      'keyword-match.md',
      'unmistakable lighthouse beacon keyword',
      [0, 1]
    );
    await writeIndexedFile('vector-aligned.md', 'totally unrelated grocery list', [1, 0]);
    await refreshReadTable();

    const canonicalKeywordPath = await fs.realpath(keywordPath);
    const results = await semanticSearch('lighthouse', { limit: 10, threshold: 0 });

    // FTS-lifecycle signal (behavioral, non-struct): the fresh-workspace bootstrap
    // created FTS indexes and marked status ready, so the HYBRID branch must run. The
    // 'Search completed' info log carries the chosen mode; asserting on it (rather than
    // reading currentIndex.ftsStatus) survives a WorkspaceIndex reshape and goes RED if
    // the useHybrid gate is decoupled from ftsStatus.
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'hybrid' }),
      'Search completed'
    );
    expect(testState.loggerInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'vector-only' }),
      'Search completed'
    );

    // Hybrid branch ran without throwing and surfaced the FTS keyword match.
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.map((r) => r.path)).toContain(canonicalKeywordPath);
    // Deduped by path.
    const paths = results.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    // Documented result shape.
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

  // 6b. FTS lifecycle gate — forcing ftsStatus to 'failed' selects the vector-only
  //     fallback. With an orthogonal-vector keyword file (cosine 0) and a positive
  //     threshold, vector-only excludes it. This confirms ftsStatus is the branch gate
  //     AND that the threshold-on-cosine filter applies (contrast with test 6's
  //     threshold-0 hybrid run, which kept it).
  it('selects vector-only fallback when ftsStatus is failed (orthogonal file dropped by threshold)', async () => {
    await writeIndexedFile('keyword-match.md', 'unmistakable lighthouse beacon keyword', [0, 1]);
    await writeIndexedFile('vector-aligned.md', 'totally unrelated grocery list', [1, 0]);
    await refreshReadTable();

    // Force the gate via the internal struct (setup, not asserted).
    const currentIndex = _getCurrentIndexForTesting();
    if (currentIndex) currentIndex.ftsStatus = 'failed';

    const results = await semanticSearch('lighthouse', { limit: 10, threshold: 0.1 });

    // BRANCH-SELECTION INVARIANT (behavioral, non-struct): FTS forced 'failed' selects
    // the VECTOR-ONLY branch. Goes RED if the useHybrid gate is forced true.
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'vector-only' }),
      'Search completed'
    );
    expect(testState.loggerInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'hybrid' }),
      'Search completed'
    );

    // Vector-only: the orthogonal file (cosine 0 < threshold 0.1) is excluded.
    expect(results.map((r) => r.relativePath)).not.toContain('keyword-match.md');
  });

  // 7. Re-indexing a changed file updates its chunks rather than duplicating them.
  it('re-indexes a changed file by replacing its chunks (no duplicates)', async () => {
    const filePath = path.join(workspacePath, 'mutable.md');
    vectorsByRelativePath.set('mutable.md', [1, 0]);
    await fs.writeFile(filePath, 'original short content');
    const firstCount = await indexFile(filePath, workspacePath);
    expect(firstCount).toBe(1);

    // Grow the file enough to split into multiple chunks, then re-index.
    const longContent = `Path-marker line\n${'word '.repeat(1200)}`;
    // Bump mtime so the on-disk state is unambiguously newer.
    await fs.writeFile(filePath, longContent);
    const secondCount = await indexFile(filePath, workspacePath);
    expect(secondCount).toBeGreaterThan(1);

    const rows = (await readChunkRows(workspacePath)).filter((r) => r.relativePath === 'mutable.md');
    // Exactly the second indexing's chunks remain — the original single chunk is gone.
    expect(rows).toHaveLength(secondCount);
    expect(rows.every((r) => r.totalChunks === secondCount)).toBe(true);
  });

  // 8. needsReindexing — characterize the mtime-based staleness check.
  it('reports needsReindexing true for unknown files and false for a freshly indexed file', async () => {
    // Before any index exists, every file needs (re)indexing.
    const filePath = path.join(workspacePath, 'tracked.md');
    await fs.writeFile(filePath, 'tracked content');
    expect(await needsReindexing(filePath)).toBe(true);

    await indexFile(filePath, workspacePath);
    // Freshly indexed, unchanged on disk -> no reindex needed.
    expect(await needsReindexing(filePath)).toBe(false);

    // A path that was never indexed needs indexing.
    const otherPath = path.join(workspacePath, 'never-indexed.md');
    await fs.writeFile(otherPath, 'other');
    expect(await needsReindexing(otherPath)).toBe(true);
  });

  // 8b. needsReindexing after initializeIndex with no files — an unknown path needs indexing.
  it('reports needsReindexing true on an initialized-but-empty index', async () => {
    await initializeIndex(workspacePath);
    const filePath = path.join(workspacePath, 'fresh.md');
    await fs.writeFile(filePath, 'fresh');
    expect(await needsReindexing(filePath)).toBe(true);
  });
});
