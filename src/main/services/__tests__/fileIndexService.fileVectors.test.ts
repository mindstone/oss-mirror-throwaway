import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testState = vi.hoisted(() => ({
  userDataPath: '/tmp/file-vectors-userdata-initial',
  generateEmbeddings: vi.fn<(texts: string[]) => Promise<Float32Array[]>>(),
  // The stable per-model dimension the embed-time guard validates against. Most
  // legacy fixtures use 3-dim vectors and leave this undefined (the guard then
  // skips the dimension check; finiteness + non-zero-norm still apply). The MA2
  // dimension-tie / 1-chunk-short-vector tests set it explicitly to prove a
  // batch-shaped vector can never define "correct".
  embeddingDimension: undefined as number | undefined,
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
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
  EMBEDDING_DIMENSION: 384,
  getEmbeddingGenerator: () => ({
    generateEmbedding: async () => Float32Array.from([1, 0, 0]),
    generateQueryEmbedding: async () => Float32Array.from([1, 0, 0]),
    generateEmbeddings: testState.generateEmbeddings,
    get embeddingDimension() {
      return testState.embeddingDimension;
    },
  }),
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
  FILE_VECTORS_TABLE_NAME,
  _getCurrentIndexForTesting,
  _optimizeIndexForTesting,
  _setCurrentIndexForTesting,
  clearIndex,
  closeIndex,
  getFileEmbeddings,
  indexFile,
  initializeIndex,
  readAllFileVectors,
  refreshReadTable,
  removeFileFromIndex,
  removeFilesFromIndex,
  updateChunkEmbedding,
} from '../fileIndexService';

const FILE_EMBEDDINGS_TABLE_NAME = 'file_embeddings';

function workspaceHash(workspacePath: string): string {
  return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
}

function getLanceDBDir(workspacePath: string): string {
  return path.join(testState.userDataPath, 'indices', workspaceHash(workspacePath), 'lancedb');
}

function getIndexStorageDir(workspacePath: string): string {
  return path.join(testState.userDataPath, 'indices', workspaceHash(workspacePath));
}

async function closeConnection(connection: unknown): Promise<void> {
  const maybeClosable = connection as { close?: () => void | Promise<void> };
  await maybeClosable.close?.();
}

async function listTableNames(workspacePath: string): Promise<string[]> {
  const lancedb = await import('@lancedb/lancedb');
  const connection = await lancedb.connect(getLanceDBDir(workspacePath));
  try {
    return await connection.tableNames();
  } finally {
    await closeConnection(connection);
  }
}

async function dropTableDirectly(workspacePath: string, tableName: string): Promise<void> {
  const lancedb = await import('@lancedb/lancedb');
  const connection = await lancedb.connect(getLanceDBDir(workspacePath));
  try {
    const tableNames = await connection.tableNames();
    if (tableNames.includes(tableName)) {
      await connection.dropTable(tableName);
    }
  } finally {
    await closeConnection(connection);
  }
}

async function replaceChunksTableWithLegacySchema(workspacePath: string, canonicalFilePath: string): Promise<void> {
  const lancedb = await import('@lancedb/lancedb');
  const connection = await lancedb.connect(getLanceDBDir(workspacePath));
  let legacyTable: Awaited<ReturnType<typeof connection.createTable>> | null = null;
  try {
    const tableNames = await connection.tableNames();
    if (tableNames.includes(FILE_EMBEDDINGS_TABLE_NAME)) {
      await connection.dropTable(FILE_EMBEDDINGS_TABLE_NAME);
    }
    const legacyRows = [{
      id: chunkIdFor(canonicalFilePath, 0),
      path: canonicalFilePath,
      relativePath: 'legacy.md',
      content: 'legacy schema row',
      extension: '.md',
      mtime: Date.now(),
      size: 17,
      chunkIndex: 0,
      totalChunks: 1,
      indexedAt: Date.now(),
      vector: [1, 0, 0],
    }];
    legacyTable = await connection.createTable(FILE_EMBEDDINGS_TABLE_NAME, legacyRows);
  } finally {
    try {
      legacyTable?.close();
    } catch {
      // Ignore close errors in test fixture cleanup.
    }
    await closeConnection(connection);
  }
}

async function replaceChunksTableWithFilenameStemMigrationSchema(
  workspacePath: string,
  canonicalFilePath: string
): Promise<void> {
  const lancedb = await import('@lancedb/lancedb');
  const connection = await lancedb.connect(getLanceDBDir(workspacePath));
  let legacyTable: Awaited<ReturnType<typeof connection.createTable>> | null = null;
  try {
    const tableNames = await connection.tableNames();
    if (tableNames.includes(FILE_EMBEDDINGS_TABLE_NAME)) {
      await connection.dropTable(FILE_EMBEDDINGS_TABLE_NAME);
    }
    const legacyRows = [{
      id: chunkIdFor(canonicalFilePath, 0),
      path: canonicalFilePath,
      relativePath: String.raw`legacy\filename-stem.md`,
      content: 'legacy filename stem migration row',
      extension: '.md',
      mtime: Date.now(),
      size: 34,
      chunkIndex: 0,
      totalChunks: 1,
      indexedAt: Date.now(),
      vector: [1, 0, 0],
      is_enhanced: 0,
      enhanced_at: 0,
    }];
    legacyTable = await connection.createTable(FILE_EMBEDDINGS_TABLE_NAME, legacyRows);
  } finally {
    try {
      legacyTable?.close();
    } catch {
      // Ignore close errors in test fixture cleanup.
    }
    await closeConnection(connection);
  }
}

async function readChunkRows(
  workspacePath: string
): Promise<Array<{ chunkIndex: number; vector: number[] }>> {
  const lancedb = await import('@lancedb/lancedb');
  const connection = await lancedb.connect(getLanceDBDir(workspacePath));
  try {
    const tableNames = await connection.tableNames();
    if (!tableNames.includes(FILE_EMBEDDINGS_TABLE_NAME)) {
      return [];
    }
    const table = await connection.openTable(FILE_EMBEDDINGS_TABLE_NAME);
    const rows = (await table.query().toArray()) as Array<{
      chunkIndex: number;
      vector: ArrayLike<number>;
    }>;
    return rows.map((row) => ({ chunkIndex: row.chunkIndex, vector: Array.from(row.vector) }));
  } finally {
    await closeConnection(connection);
  }
}

async function writeWorkspaceFile(workspacePath: string, relativePath: string, content: string): Promise<string> {
  const filePath = path.join(workspacePath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
}

function chunkIdFor(filePath: string, chunkIndex: number): string {
  return crypto.createHash('sha256').update(`${filePath}:${chunkIndex}`).digest('hex').slice(0, 32);
}

async function readVectorsAfterRefresh() {
  await refreshReadTable();
  return readAllFileVectors();
}

describe('fileIndexService file_vectors materialized table', () => {
  let workspacePath: string;

  beforeEach(async () => {
    testState.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'file-vectors-userdata-'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'file-vectors-workspace-'));
    testState.generateEmbeddings.mockReset();
    testState.generateEmbeddings.mockImplementation(async (texts) =>
      texts.map((text, index) => {
        const axis = (text.length + index) % 3;
        return Float32Array.from(axis === 0 ? [1, 0, 0] : axis === 1 ? [0, 1, 0] : [0, 0, 1]);
      })
    );
    testState.embeddingDimension = undefined;
    testState.tryConvertToWorkspacePath.mockReset();
    testState.tryConvertToWorkspacePath.mockReturnValue(null);
    testState.loggerDebug.mockClear();
    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();
    testState.loggerError.mockClear();
  });

  afterEach(async () => {
    _setCurrentIndexForTesting(null);
    await closeIndex();
    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.rm(testState.userDataPath, { recursive: true, force: true });
  });

  it('optimizes file_vectors with the same optimize lifecycle as the chunks table', async () => {
    const chunksOptimize = vi.fn(async () => ({ prune: { oldVersionsRemoved: 2, bytesRemoved: 128 } }));
    const fileVectorsOptimize = vi.fn(async () => ({ prune: { oldVersionsRemoved: 3, bytesRemoved: 256 } }));
    const fakeIndex = {
      connection: { close: vi.fn(async () => undefined) },
      table: { optimize: chunksOptimize, close: vi.fn() },
      fileVectorsTable: { optimize: fileVectorsOptimize, close: vi.fn() },
      readConnection: { close: vi.fn(async () => undefined) },
      readTable: null,
      fileVectorsReadTable: null,
      workspacePath,
      indexedMtimes: new Map<string, number>(),
      lastIndexedAt: null,
      metadata: { scanCompletedAt: null, totalFilesAtCompletion: null },
      indexedFilesCount: 0,
      ftsStatus: 'unavailable',
    };
    _setCurrentIndexForTesting(fakeIndex as unknown as Parameters<typeof _setCurrentIndexForTesting>[0]);

    await _optimizeIndexForTesting();

    expect(chunksOptimize).toHaveBeenCalledWith({ cleanupOlderThan: expect.any(Date) });
    expect(fileVectorsOptimize).toHaveBeenCalledWith({ cleanupOlderThan: expect.any(Date) });
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: FILE_VECTORS_TABLE_NAME,
        versionsRemoved: 3,
        bytesFreed: 256,
        workspace: workspacePath,
      }),
      'Optimized file vectors index'
    );
  });

  it('still optimizes file_vectors when chunks optimize fails', async () => {
    const chunksOptimize = vi.fn(async () => {
      throw new Error('simulated chunks optimize failure');
    });
    const fileVectorsOptimize = vi.fn(async () => ({ prune: { oldVersionsRemoved: 4, bytesRemoved: 512 } }));
    const fakeIndex = {
      connection: { close: vi.fn(async () => undefined) },
      table: { optimize: chunksOptimize, close: vi.fn() },
      fileVectorsTable: { optimize: fileVectorsOptimize, close: vi.fn() },
      readConnection: { close: vi.fn(async () => undefined) },
      readTable: null,
      fileVectorsReadTable: null,
      workspacePath,
      indexedMtimes: new Map<string, number>(),
      lastIndexedAt: null,
      metadata: { scanCompletedAt: null, totalFilesAtCompletion: null },
      indexedFilesCount: 0,
      ftsStatus: 'unavailable',
    };
    _setCurrentIndexForTesting(fakeIndex as unknown as Parameters<typeof _setCurrentIndexForTesting>[0]);

    await _optimizeIndexForTesting();

    expect(chunksOptimize).toHaveBeenCalledTimes(1);
    expect(fileVectorsOptimize).toHaveBeenCalledWith({ cleanupOlderThan: expect.any(Date) });
    expect(testState.loggerWarn).toHaveBeenCalledWith(
      { err: expect.any(Error), failureCount: expect.any(Number) },
      'Failed to optimize file index'
    );
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: FILE_VECTORS_TABLE_NAME,
        versionsRemoved: 4,
        bytesFreed: 512,
        workspace: workspacePath,
      }),
      'Optimized file vectors index'
    );
  });

  it('lazily creates file_vectors on the first indexed file in an empty workspace', async () => {
    await initializeIndex(workspacePath);
    expect(await readAllFileVectors()).toEqual([]);

    const filePath = await writeWorkspaceFile(workspacePath, 'first.md', 'hello file vectors');
    await expect(indexFile(filePath, workspacePath)).resolves.toBe(1);

    expect(await listTableNames(workspacePath)).toContain(FILE_VECTORS_TABLE_NAME);
    const rows = await readVectorsAfterRefresh();
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe(await fs.realpath(filePath));
    expect(rows[0].chunk_count).toBe(1);
    expect(rows[0].source_chunk_count).toBe(1);
  });

  it('upserts the row on re-index and updates fingerprint columns', async () => {
    testState.generateEmbeddings
      .mockResolvedValueOnce([Float32Array.from([1, 0, 0])])
      .mockResolvedValueOnce([Float32Array.from([0, 5, 0])]);

    const filePath = await writeWorkspaceFile(workspacePath, 'upsert.md', 'first content');
    const firstMtime = new Date('2026-01-02T00:00:00.000Z');
    await fs.utimes(filePath, firstMtime, firstMtime);
    await indexFile(filePath, workspacePath);
    const [firstRow] = await readVectorsAfterRefresh();

    await fs.writeFile(filePath, 'second content');
    const secondMtime = new Date('2026-01-03T00:00:00.000Z');
    await fs.utimes(filePath, secondMtime, secondMtime);
    await indexFile(filePath, workspacePath);

    const rows = await readVectorsAfterRefresh();
    expect(rows).toHaveLength(1);
    expect(rows[0].computed_at).toBeGreaterThanOrEqual(firstRow.computed_at);
    expect(rows[0].source_max_chunk_mtime).toBe(Math.floor(secondMtime.getTime()));
    expect(rows[0].source_max_indexed_at).toBeGreaterThanOrEqual(firstRow.source_max_indexed_at);
    expect(rows[0].source_max_enhanced_at).toBe(0);
    expect(rows[0].source_chunk_count).toBe(1);
    expect(rows[0].vector[0]).toBeCloseTo(0);
    expect(rows[0].vector[1]).toBeCloseTo(1);
  });

  it('does only one file_vectors delete and one add when re-indexing a file', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'delete-count.md', 'first content');
    await indexFile(filePath, workspacePath);

    const currentIndex = _getCurrentIndexForTesting();
    const fileVectorsTable = currentIndex?.fileVectorsTable;
    if (!fileVectorsTable) {
      throw new Error('Expected file_vectors table after initial index');
    }
    const originalDelete = fileVectorsTable.delete.bind(fileVectorsTable);
    const originalAdd = fileVectorsTable.add.bind(fileVectorsTable);
    const deleteSpy = vi.fn((predicate: Parameters<typeof fileVectorsTable.delete>[0]) => originalDelete(predicate));
    const addSpy = vi.fn((records: Parameters<typeof fileVectorsTable.add>[0]) => originalAdd(records));
    fileVectorsTable.delete = deleteSpy;
    fileVectorsTable.add = addSpy;

    await fs.writeFile(filePath, 'second content');
    await indexFile(filePath, workspacePath);

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledTimes(1);
  });

  it('deletes the file_vectors row when a single file is removed', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'delete.md', 'delete me');
    await indexFile(filePath, workspacePath);
    expect(await readVectorsAfterRefresh()).toHaveLength(1);

    const canonicalPath = await fs.realpath(filePath);
    await removeFileFromIndex(canonicalPath);

    expect(await readVectorsAfterRefresh()).toEqual([]);
    expect(testState.loggerInfo).toHaveBeenCalledWith({ path: canonicalPath }, 'file_vectors.delete');
  });

  it('deletes file_vectors by relative_path when the removal path is a symlink-relative candidate', async () => {
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-vectors-external-'));
    try {
      const externalFilePath = await writeWorkspaceFile(externalDir, 'target.md', 'external symlink target');
      const canonicalPath = await fs.realpath(externalFilePath);
      testState.tryConvertToWorkspacePath.mockImplementation((candidatePath, candidateWorkspacePath) => {
        if (candidatePath === canonicalPath && candidateWorkspacePath === workspacePath) {
          return 'linked/target.md';
        }
        return null;
      });

      await indexFile(externalFilePath, workspacePath);
      expect((await readVectorsAfterRefresh()).map((row) => row.relative_path)).toEqual(['linked/target.md']);

      await removeFileFromIndex('linked/target.md');

      expect(await readVectorsAfterRefresh()).toEqual([]);
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true });
    }
  });

  it('batch deletes file_vectors rows in batches of at most 50 paths', async () => {
    const filePaths: string[] = [];
    for (let i = 0; i < 100; i++) {
      const filePath = await writeWorkspaceFile(workspacePath, `batch-${i}.md`, `content ${i}`);
      filePaths.push(await fs.realpath(filePath));
      await indexFile(filePath, workspacePath);
    }
    expect(await readVectorsAfterRefresh()).toHaveLength(100);
    testState.loggerInfo.mockClear();

    await removeFilesFromIndex(filePaths);

    expect(await readVectorsAfterRefresh()).toEqual([]);
    const deleteLogs = testState.loggerInfo.mock.calls.filter((call) => call[1] === 'file_vectors.delete');
    expect(deleteLogs).toHaveLength(2);
    expect(deleteLogs.map((call) => (call[0] as { paths: number }).paths)).toEqual([50, 50]);
  });

  it('recomputes the file vector after an enhancement chunk update', async () => {
    testState.generateEmbeddings.mockResolvedValueOnce([Float32Array.from([1, 0, 0])]);
    const filePath = await writeWorkspaceFile(workspacePath, 'enhanced.md', 'enhance me');
    await indexFile(filePath, workspacePath);
    const canonicalPath = await fs.realpath(filePath);
    const enhancedAt = Date.now() + 10_000;

    await expect(updateChunkEmbedding(chunkIdFor(canonicalPath, 0), [0, 1, 0], enhancedAt)).resolves.toBe(true);

    const rows = await readVectorsAfterRefresh();
    expect(rows).toHaveLength(1);
    expect(rows[0].vector[0]).toBeCloseTo(0);
    expect(rows[0].vector[1]).toBeCloseTo(1);
    expect(rows[0].source_max_enhanced_at).toBe(enhancedAt);
  });

  it('creates file_vectors on first post-upgrade write when chunks exist but file_vectors is absent', async () => {
    const existingFile = await writeWorkspaceFile(workspacePath, 'existing.md', 'old install row');
    await indexFile(existingFile, workspacePath);
    await closeIndex();
    await dropTableDirectly(workspacePath, FILE_VECTORS_TABLE_NAME);

    const newFile = await writeWorkspaceFile(workspacePath, 'new.md', 'new post upgrade row');
    await indexFile(newFile, workspacePath);

    expect(await listTableNames(workspacePath)).toContain(FILE_VECTORS_TABLE_NAME);
    const rows = await readVectorsAfterRefresh();
    expect(rows.map((row) => row.path).sort()).toEqual([
      await fs.realpath(existingFile),
      await fs.realpath(newFile),
    ].sort());
  });

  it('drops stale file_vectors when an incompatible chunks schema forces rebuild', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'legacy.md', 'legacy current row');
    await indexFile(filePath, workspacePath);
    expect(await listTableNames(workspacePath)).toContain(FILE_VECTORS_TABLE_NAME);
    const canonicalPath = await fs.realpath(filePath);
    await closeIndex();

    await replaceChunksTableWithLegacySchema(workspacePath, canonicalPath);

    await initializeIndex(workspacePath);

    const tableNames = await listTableNames(workspacePath);
    expect(tableNames).not.toContain(FILE_EMBEDDINGS_TABLE_NAME);
    expect(tableNames).not.toContain(FILE_VECTORS_TABLE_NAME);
  });

  it('drops file_vectors when the filename_stem migration runs to prevent drift', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'legacy-filename-stem.md', 'legacy current row');
    await indexFile(filePath, workspacePath);
    expect(await listTableNames(workspacePath)).toContain(FILE_VECTORS_TABLE_NAME);
    const canonicalPath = await fs.realpath(filePath);
    await closeIndex();

    await replaceChunksTableWithFilenameStemMigrationSchema(workspacePath, canonicalPath);
    await initializeIndex(workspacePath);

    const tableNamesAfterMigration = await listTableNames(workspacePath);
    expect(tableNamesAfterMigration).not.toContain(FILE_VECTORS_TABLE_NAME);
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      {
        tableName: FILE_VECTORS_TABLE_NAME,
        reason: 'filename_stem_migration_drift_prevention',
      },
      'file_vectors.migration_drop'
    );

    const freshFilePath = await writeWorkspaceFile(workspacePath, 'fresh-after-migration.md', 'fresh row');
    await indexFile(freshFilePath, workspacePath);

    const rows = await readVectorsAfterRefresh();
    expect(rows.map((row) => row.path)).toEqual([await fs.realpath(freshFilePath)]);
  });

  it('drops a zero-norm chunk vector at embed time and creates no file vector', async () => {
    // Post-Stage-4: the embed-time NaN guard also rejects zero-norm vectors, so a
    // single-chunk file whose only vector is all-zero is dropped before it ever
    // reaches the file_vectors averaging path (previously it produced a
    // 'file_vectors.skipped' / invalid_vectors log). No row is written either way.
    testState.generateEmbeddings.mockResolvedValueOnce([Float32Array.from([0, 0, 0])]);
    const filePath = await writeWorkspaceFile(workspacePath, 'invalid-vector.md', 'zero vector');
    const canonicalPath = await fs.realpath(filePath);

    await expect(indexFile(filePath, workspacePath)).resolves.toBe(0);

    expect(await readChunkRows(workspacePath)).toEqual([]);
    expect(await readVectorsAfterRefresh()).toEqual([]);
    expect(testState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ path: canonicalPath, chunkIndex: 0, reason: 'zero_norm' }),
      'embedding.invalid_chunk_vector'
    );
  });

  // The embed-time NaN guard tests drive a real multi-chunk file. The chunk
  // count is content-dependent, so the embedding mock responds dynamically to
  // the actual number of enriched texts and injects NaN at chosen chunk indices,
  // keeping `embeddings.length === chunks.length` regardless of chunking.
  const NAN_VECTOR = (): Float32Array => Float32Array.from([Number.NaN, Number.NaN, Number.NaN]);
  function mockEmbeddingsWithNaNAt(nanIndices: ReadonlySet<number>): void {
    testState.generateEmbeddings.mockImplementationOnce(async (texts) =>
      texts.map((_text, index) =>
        nanIndices.has(index) ? NAN_VECTOR() : Float32Array.from(index % 2 === 0 ? [1, 0, 0] : [0, 1, 0])
      )
    );
  }
  // ~4.8k chars → splits into multiple chunks (maxSize 2000, overlap 200).
  const MULTI_CHUNK_CONTENT = `${'alpha '.repeat(400)}\n${'bravo '.repeat(400)}`;

  it('drops a NaN chunk vector at embed time so it is never written to file_embeddings', async () => {
    mockEmbeddingsWithNaNAt(new Set([1]));
    const filePath = await writeWorkspaceFile(workspacePath, 'nan-chunk.md', MULTI_CHUNK_CONTENT);
    const canonicalPath = await fs.realpath(filePath);

    const chunksIndexed = await indexFile(filePath, workspacePath);
    expect(chunksIndexed).toBeGreaterThan(0);

    // The NaN chunk (chunkIndex 1) must NOT be persisted; every written chunk is finite.
    const chunkRows = await readChunkRows(workspacePath);
    expect(chunkRows.map((row) => row.chunkIndex)).not.toContain(1);
    expect(chunkRows.length).toBeGreaterThan(0);
    expect(chunkRows.every((row) => row.vector.every((value) => Number.isFinite(value)))).toBe(true);

    // The drop is logged as a single counted warning naming the dropped chunk.
    expect(testState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ path: canonicalPath, chunkIndex: 1, reason: 'non_finite' }),
      'embedding.invalid_chunk_vector'
    );
  });

  it('still produces a VALID file vector when one chunk is NaN (one NaN no longer nukes the file)', async () => {
    // The key regression test: a file with one NaN chunk + valid chunks must be
    // FILLABLE (a real file_vectors row), not skipped as invalid_vectors.
    mockEmbeddingsWithNaNAt(new Set([1]));
    const filePath = await writeWorkspaceFile(workspacePath, 'one-nan.md', MULTI_CHUNK_CONTENT);
    const canonicalPath = await fs.realpath(filePath);

    await indexFile(filePath, workspacePath);

    const rows = await readVectorsAfterRefresh();
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe(canonicalPath);
    // A finite, usable averaged vector (over the valid chunks only).
    expect(rows[0].vector.every((value) => Number.isFinite(value))).toBe(true);
    expect(rows[0].vector.some((value) => value !== 0)).toBe(true);

    // NOT skipped: the invalid_vectors skip log must not have fired for this file.
    expect(testState.loggerWarn).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: canonicalPath, reason: 'invalid_vectors' }),
      'file_vectors.skipped'
    );
  });

  it('writes no rows and creates no file_vectors when ALL chunk vectors are NaN', async () => {
    // Mark every chunk NaN regardless of how many there are.
    testState.generateEmbeddings.mockImplementationOnce(async (texts) => texts.map(() => NAN_VECTOR()));
    const filePath = await writeWorkspaceFile(workspacePath, 'all-nan.md', MULTI_CHUNK_CONTENT);
    const canonicalPath = await fs.realpath(filePath);

    // All chunks dropped → indexFile reports 0 chunks indexed.
    await expect(indexFile(filePath, workspacePath)).resolves.toBe(0);

    expect(await readChunkRows(workspacePath)).toEqual([]);
    expect(await readVectorsAfterRefresh()).toEqual([]);
    expect(testState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ path: canonicalPath }),
      'embedding.all_chunk_vectors_invalid'
    );
  });

  it('rejects a NaN enhanced vector and leaves the prior chunk + file vector intact (MA1)', async () => {
    // Index a single-chunk file with a valid basic vector + file vector.
    testState.generateEmbeddings.mockResolvedValueOnce([Float32Array.from([1, 0, 0])]);
    const filePath = await writeWorkspaceFile(workspacePath, 'enh-reject.md', 'enhance me');
    await indexFile(filePath, workspacePath);
    const canonicalPath = await fs.realpath(filePath);

    const fileBefore = (await readVectorsAfterRefresh()).find((r) => r.path === canonicalPath);
    expect(fileBefore).toBeDefined();
    const chunkBefore = (await readChunkRows(workspacePath)).find((r) => r.chunkIndex === 0);
    expect(chunkBefore?.vector).toEqual([1, 0, 0]);
    testState.loggerWarn.mockClear();

    // Enhancement returns an all-NaN vector for this chunk.
    await expect(
      updateChunkEmbedding(chunkIdFor(canonicalPath, 0), [Number.NaN, Number.NaN, Number.NaN], Date.now() + 10_000)
    ).resolves.toBe(false);

    // The rejection is logged as a counted warning.
    expect(testState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ chunkId: chunkIdFor(canonicalPath, 0), reason: 'non_finite' }),
      'embedding.invalid_enhanced_vector'
    );

    // The stored chunk vector is UNCHANGED (basic vector preserved, not overwritten).
    const chunkAfter = (await readChunkRows(workspacePath)).find((r) => r.chunkIndex === 0);
    expect(chunkAfter?.vector).toEqual([1, 0, 0]);
    expect(chunkAfter?.vector.every((v) => Number.isFinite(v))).toBe(true);

    // The file vector is UNCHANGED.
    const fileAfter = (await readVectorsAfterRefresh()).find((r) => r.path === canonicalPath);
    expect(fileAfter?.vector).toEqual(fileBefore?.vector);
  });

  it('rejects a wrong-dimension enhanced vector against the stable model dimension (MA1/MA2)', async () => {
    testState.embeddingDimension = 3; // stable per-model dimension
    testState.generateEmbeddings.mockResolvedValueOnce([Float32Array.from([1, 0, 0])]);
    const filePath = await writeWorkspaceFile(workspacePath, 'enh-dim.md', 'dim me');
    await indexFile(filePath, workspacePath);
    const canonicalPath = await fs.realpath(filePath);
    testState.loggerWarn.mockClear();

    // A len-2 enhanced vector must be rejected as wrong_dimension and not written.
    await expect(
      updateChunkEmbedding(chunkIdFor(canonicalPath, 0), [0, 1], Date.now() + 10_000)
    ).resolves.toBe(false);
    expect(testState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ chunkId: chunkIdFor(canonicalPath, 0), reason: 'wrong_dimension' }),
      'embedding.invalid_enhanced_vector'
    );

    const chunkAfter = (await readChunkRows(workspacePath)).find((r) => r.chunkIndex === 0);
    expect(chunkAfter?.vector).toEqual([1, 0, 0]);
  });

  it('drops a 1-chunk short vector against the stable model dimension, not the batch (MA2)', async () => {
    // A 1-chunk file whose only vector is len-2 due to a backend bug. With the
    // OLD batch-modal logic, modalVectorLength([len2]) === 2 would ACCEPT it.
    // With the stable model dimension (3), it is rejected as wrong_dimension and
    // never defines the expected dim → no chunk row, no file vector.
    testState.embeddingDimension = 3;
    testState.generateEmbeddings.mockResolvedValueOnce([Float32Array.from([1, 0])]);
    const filePath = await writeWorkspaceFile(workspacePath, 'short-one-chunk.md', 'tiny');
    const canonicalPath = await fs.realpath(filePath);

    await expect(indexFile(filePath, workspacePath)).resolves.toBe(0);
    expect(await readChunkRows(workspacePath)).toEqual([]);
    expect(await readVectorsAfterRefresh()).toEqual([]);
    expect(testState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ path: canonicalPath, chunkIndex: 0, reason: 'wrong_dimension' }),
      'embedding.invalid_chunk_vector'
    );
  });

  it('rejects the wrong-dimension half of a 2-chunk tie and keeps the model-dimension vector (MA2)', async () => {
    // A 2-chunk batch with a len-2 and a len-3 vector (a 1/1 tie). The OLD
    // modal-length logic could pick len-2 by insertion order and DROP the valid
    // len-3 vector. The stable model dimension (3) means the len-3 vector is
    // kept and the len-2 vector is dropped as wrong_dimension.
    testState.embeddingDimension = 3;
    testState.generateEmbeddings.mockImplementationOnce(async (texts) =>
      texts.map((_t, i) => (i === 0 ? Float32Array.from([9, 9]) : Float32Array.from([1, 0, 0])))
    );
    // Two-chunk content (MULTI_CHUNK_CONTENT splits into ≥2 chunks).
    const filePath = await writeWorkspaceFile(workspacePath, 'tie.md', MULTI_CHUNK_CONTENT);
    const canonicalPath = await fs.realpath(filePath);

    await indexFile(filePath, workspacePath);

    const chunkRows = await readChunkRows(workspacePath);
    // The len-2 chunk (index 0) is dropped; every written vector is len-3.
    expect(chunkRows.length).toBeGreaterThan(0);
    expect(chunkRows.every((r) => r.vector.length === 3)).toBe(true);
    expect(chunkRows.map((r) => r.chunkIndex)).not.toContain(0);
    expect(testState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ path: canonicalPath, chunkIndex: 0, reason: 'wrong_dimension' }),
      'embedding.invalid_chunk_vector'
    );

    // A valid len-3 file vector is still produced.
    const rows = await readVectorsAfterRefresh();
    expect(rows).toHaveLength(1);
    expect(rows[0].vector).toHaveLength(3);
  });

  it('does not log file_vectors.partial_quality when all written chunks are valid (MA4 — no spurious fire)', async () => {
    // On the clean index path the embed-time guard removes any NaN BEFORE
    // recompute, so the writer only ever sees valid chunks → no partial_quality.
    mockEmbeddingsWithNaNAt(new Set([1]));
    const filePath = await writeWorkspaceFile(workspacePath, 'partial-quality.md', MULTI_CHUNK_CONTENT);
    const canonicalPath = await fs.realpath(filePath);
    testState.loggerWarn.mockClear();

    await indexFile(filePath, workspacePath);

    const partialLogs = testState.loggerWarn.mock.calls.filter(
      (c) => c[1] === 'file_vectors.partial_quality' && (c[0] as { path?: string }).path === canonicalPath
    );
    expect(partialLogs).toEqual([]);
  });

  it('serializes a concurrent reindex followed by delete through the write lock', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'race.md', 'initial');
    await indexFile(filePath, workspacePath);
    await fs.writeFile(filePath, 'reindexed');

    const reindexPromise = indexFile(filePath, workspacePath);
    const deletePromise = removeFileFromIndex(await fs.realpath(filePath));
    await Promise.all([reindexPromise, deletePromise]);

    expect(await readVectorsAfterRefresh()).toEqual([]);
  });

  it('retries file_vectors drop after clearIndex partial failure', async () => {
    await fs.mkdir(getIndexStorageDir(workspacePath), { recursive: true });
    const operationOrder: string[] = [];
    const dropTable = vi.fn(async (tableName: string) => {
      operationOrder.push(`drop:${tableName}`);
      if (tableName === FILE_VECTORS_TABLE_NAME && dropTable.mock.calls.filter((call) => call[0] === FILE_VECTORS_TABLE_NAME).length === 1) {
        throw new Error('simulated file_vectors drop failure');
      }
    });

    const fakeChunksTable = { close: vi.fn(() => operationOrder.push('close:file_embeddings')) };
    const fakeFileVectorsTable = { close: vi.fn(() => operationOrder.push('close:file_vectors')) };
    const fakeConnection = {
      dropTable,
      tableNames: vi.fn(async () => [FILE_VECTORS_TABLE_NAME]),
      close: vi.fn(async () => undefined),
    };
    const fakeReadConnection = {
      openTable: vi.fn(),
      close: vi.fn(async () => undefined),
    };

    const fakeIndex = {
      connection: fakeConnection,
      table: fakeChunksTable,
      fileVectorsTable: fakeFileVectorsTable,
      readConnection: fakeReadConnection,
      readTable: null,
      fileVectorsReadTable: null,
      workspacePath,
      indexedMtimes: new Map(),
      lastIndexedAt: null,
      metadata: { scanCompletedAt: null, totalFilesAtCompletion: null },
      indexedFilesCount: 0,
      ftsStatus: 'unavailable',
    };
    _setCurrentIndexForTesting(fakeIndex as unknown as Parameters<typeof _setCurrentIndexForTesting>[0]);

    await expect(clearIndex()).rejects.toThrow('simulated file_vectors drop failure');
    expect(operationOrder).toEqual([
      'close:file_embeddings',
      'close:file_vectors',
      `drop:${FILE_EMBEDDINGS_TABLE_NAME}`,
      `drop:${FILE_VECTORS_TABLE_NAME}`,
    ]);
    expect(dropTable.mock.calls.map((call) => call[0])).toEqual([
      FILE_EMBEDDINGS_TABLE_NAME,
      FILE_VECTORS_TABLE_NAME,
    ]);
    expect(testState.loggerWarn).toHaveBeenCalledWith(
      { err: expect.any(Error), workspacePath },
      'file_vectors.clear_partial_failure'
    );

    await expect(clearIndex()).resolves.toBeUndefined();
    expect(dropTable.mock.calls.map((call) => call[0])).toEqual([
      FILE_EMBEDDINGS_TABLE_NAME,
      FILE_VECTORS_TABLE_NAME,
      FILE_VECTORS_TABLE_NAME,
    ]);
  });

  it('quarantines file_vectors handles after partial clear so reindex masks orphan rows', async () => {
    const orphanFilePath = await writeWorkspaceFile(workspacePath, 'orphan.md', 'orphan row');
    await indexFile(orphanFilePath, workspacePath);
    const orphanCanonicalPath = await fs.realpath(orphanFilePath);
    expect((await readVectorsAfterRefresh()).map((row) => row.path)).toEqual([orphanCanonicalPath]);

    const currentIndex = _getCurrentIndexForTesting();
    if (!currentIndex) {
      throw new Error('Expected current index before partial clear simulation');
    }
    const originalDropTable = currentIndex.connection.dropTable.bind(currentIndex.connection);
    let failedFileVectorsDrop = false;
    currentIndex.connection.dropTable = vi.fn(async (tableName: string) => {
      if (tableName === FILE_VECTORS_TABLE_NAME && !failedFileVectorsDrop) {
        failedFileVectorsDrop = true;
        throw new Error('simulated file_vectors drop failure');
      }
      return originalDropTable(tableName);
    });

    await expect(clearIndex()).rejects.toThrow('simulated file_vectors drop failure');
    const partialIndex = _getCurrentIndexForTesting();
    expect(partialIndex?.table).toBeNull();
    expect(partialIndex?.fileVectorsTable).toBeNull();
    expect(partialIndex?.fileVectorsReadTable).toBeNull();

    const freshFilePath = await writeWorkspaceFile(workspacePath, 'fresh-after-partial-clear.md', 'fresh row');
    await indexFile(freshFilePath, workspacePath);

    const rows = await readVectorsAfterRefresh();
    expect(rows.map((row) => row.path)).toEqual([await fs.realpath(freshFilePath)]);
    expect(rows.map((row) => row.path)).not.toContain(orphanCanonicalPath);
  });

  it('readAllFileVectors returns [] when file_vectors is absent and rows when present', async () => {
    await initializeIndex(workspacePath);
    expect(await readAllFileVectors()).toEqual([]);

    const filePath = await writeWorkspaceFile(workspacePath, 'read-all.md', 'read all');
    await indexFile(filePath, workspacePath);

    const rows = await readVectorsAfterRefresh();
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe(await fs.realpath(filePath));
  });

  it('getFileEmbeddings maps file_vectors snake_case rows to the legacy camelCase shape', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'camel-case.md', 'camel case mapping');
    await indexFile(filePath, workspacePath);

    const [vectorRow] = await readVectorsAfterRefresh();
    const embeddings = await getFileEmbeddings();

    expect(embeddings).toEqual([{
      path: vectorRow.path,
      relativePath: vectorRow.relative_path,
      vector: vectorRow.vector,
      chunkCount: vectorRow.chunk_count,
      mtime: vectorRow.source_max_chunk_mtime,
    }]);
    expect(Object.keys(embeddings[0]).sort()).toEqual([
      'chunkCount',
      'mtime',
      'path',
      'relativePath',
      'vector',
    ]);
  });

  it('getFileEmbeddings returns [] when the chunks table is quarantined during partial clear', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'partial-clear-read-guard.md', 'partial clear read guard');
    await indexFile(filePath, workspacePath);
    await refreshReadTable();
    expect(await getFileEmbeddings()).toHaveLength(1);

    const currentIndex = _getCurrentIndexForTesting();
    if (!currentIndex?.table) {
      throw new Error('Expected chunks table before partial-clear read-guard simulation');
    }
    const originalTable = currentIndex.table;
    currentIndex.table = null;
    try {
      await expect(getFileEmbeddings()).resolves.toEqual([]);
    } finally {
      currentIndex.table = originalTable;
    }
  });

  it('drops orphan file_vectors during init when the chunks table is absent', async () => {
    const orphanFilePath = await writeWorkspaceFile(workspacePath, 'partial.md', 'partial guard');
    await indexFile(orphanFilePath, workspacePath);
    const orphanCanonicalPath = await fs.realpath(orphanFilePath);
    await closeIndex();
    await dropTableDirectly(workspacePath, FILE_EMBEDDINGS_TABLE_NAME);

    await initializeIndex(workspacePath);

    expect(await listTableNames(workspacePath)).not.toContain(FILE_VECTORS_TABLE_NAME);
    expect(await readAllFileVectors()).toEqual([]);
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      { tableName: FILE_VECTORS_TABLE_NAME, reason: 'no_chunks_table' },
      'file_vectors.orphan_init_drop'
    );

    const freshFilePath = await writeWorkspaceFile(workspacePath, 'fresh-after-orphan-init.md', 'fresh row');
    await indexFile(freshFilePath, workspacePath);

    const rows = await readVectorsAfterRefresh();
    expect(rows.map((row) => row.path)).toEqual([await fs.realpath(freshFilePath)]);
    expect(rows.map((row) => row.path)).not.toContain(orphanCanonicalPath);
  });
});
