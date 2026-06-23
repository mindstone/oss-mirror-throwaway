import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from '../../utils/lancedbPredicates';

const testState = vi.hoisted(() => ({
  userDataPath: '/tmp/file-neighbors-userdata-initial',
  generateEmbeddings: vi.fn<(texts: string[]) => Promise<Float32Array[]>>(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  waitForTurnIdle: vi.fn(async () => 'idle' as const),
  tryConvertToWorkspacePath:
    vi.fn<(filePath: string, workspacePath: string, symlinkMap?: unknown) => string | null>(
      (_filePath: string, _workspacePath: string) => null
    ),
  broadcasts: [] as Array<{ channel: string; payload: unknown }>,
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

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({
    sendToAllWindows: (channel: string, payload: unknown) => testState.broadcasts.push({ channel, payload }),
    sendToFocusedWindow: vi.fn(),
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
  isAnyTurnActive: vi.fn(() => false),
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
  FILE_NEIGHBORS_TABLE_NAME,
  FILE_VECTORS_TABLE_NAME,
  _getCurrentIndexForTesting,
  _drainBackgroundFillsForTesting,
  _setCurrentIndexForTesting,
  _waitForFileNeighborsLazyFillForTesting,
  clearIndex,
  closeIndex,
  indexFile,
  initializeIndex,
  lazyFillFileVectorsIfNeeded,
  readFileNeighbors,
  reconcileFileVectorsIfNeeded,
  reconcileFileNeighborsIfNeeded,
  refreshReadTable,
  removeFileFromIndex,
  removeFilesFromIndex,
  startLazyFillFileNeighborsAsync,
} from '../fileIndexService';
import { _scheduleFileNeighborWriteTriggerForTesting } from '../fileIndexService/fileVectorsWriter';
import {
  getDeterministicFileNeighborFailures,
  markFileNeighborsEpochMutated,
} from '../fileIndexService/state';

const FILE_EMBEDDINGS_TABLE_NAME = 'file_embeddings';

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
    legacyTable = await connection.createTable(FILE_EMBEDDINGS_TABLE_NAME, [{
      id: crypto.createHash('sha256').update(`${canonicalFilePath}:0`).digest('hex').slice(0, 32),
      path: canonicalFilePath,
      relativePath: 'legacy.md',
      content: 'legacy schema row',
      extension: '.md',
      mtime: Date.now(),
      size: 17,
      chunkIndex: 0,
      totalChunks: 1,
      indexedAt: Date.now(),
      vector: [1, 0],
    }]);
  } finally {
    try {
      legacyTable?.close();
    } catch {
      // Ignore fixture cleanup close failures.
    }
    await closeConnection(connection);
  }
}

async function replaceNeighborsTableWithLegacySchema(
  workspacePath: string,
  sourcePath: string,
  neighborPath: string
): Promise<void> {
  const lancedb = await import('@lancedb/lancedb');
  const connection = await lancedb.connect(getLanceDBDir(workspacePath));
  let legacyTable: Awaited<ReturnType<typeof connection.createTable>> | null = null;
  try {
    const tableNames = await connection.tableNames();
    if (tableNames.includes(FILE_NEIGHBORS_TABLE_NAME)) {
      await connection.dropTable(FILE_NEIGHBORS_TABLE_NAME);
    }
    legacyTable = await connection.createTable(FILE_NEIGHBORS_TABLE_NAME, [{
      path: sourcePath,
      relative_path: 'legacy-source.md',
      neighbor_paths: [neighborPath],
      neighbor_scores: [0.5],
      source_vector_fingerprint: 'legacy-fingerprint',
      k: 5,
      computed_at: Date.now(),
    }]);
  } finally {
    try {
      legacyTable?.close();
    } catch {
      // Ignore fixture cleanup close failures.
    }
    await closeConnection(connection);
  }
}

async function deleteAllChunkRowsDirectly(workspacePath: string): Promise<void> {
  const lancedb = await import('@lancedb/lancedb');
  const connection = await lancedb.connect(getLanceDBDir(workspacePath));
  let table: Awaited<ReturnType<typeof connection.openTable>> | null = null;
  try {
    table = await connection.openTable(FILE_EMBEDDINGS_TABLE_NAME);
    await table.delete('path IS NOT NULL');
  } finally {
    try {
      table?.close();
    } catch {
      // Ignore fixture cleanup close failures.
    }
    await closeConnection(connection);
  }
}

async function writeWorkspaceFile(workspacePath: string, relativePath: string, content: string): Promise<string> {
  const filePath = path.join(workspacePath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
}

async function waitForNeighborsFill(workspacePath: string): Promise<void> {
  await _drainBackgroundFillsForTesting(workspacePath);
  for (let i = 0; i < 5; i++) {
    const promise = _waitForFileNeighborsLazyFillForTesting(workspacePath);
    if (!promise) {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (!_waitForFileNeighborsLazyFillForTesting(workspacePath)) {
        return;
      }
      continue;
    }
    await promise;
  }
}

async function resetNeighborsForUpgradeSimulation(workspacePath: string): Promise<void> {
  await closeIndex();
  await dropTableDirectly(workspacePath, FILE_NEIGHBORS_TABLE_NAME);
  await initializeIndex(workspacePath);
  testState.loggerInfo.mockClear();
  testState.loggerWarn.mockClear();
  testState.broadcasts.length = 0;
}

async function readDirectNeighborRows(): Promise<Array<{
  path: string;
  relative_path: string;
  source_vector_fingerprint: string;
  neighbor_paths: string[];
  neighbor_fingerprints: string[];
}>> {
  const currentIndex = _getCurrentIndexForTesting();
  if (!currentIndex?.fileNeighborsTable) {
    return [];
  }
  return (await currentIndex.fileNeighborsTable.query().toArray()) as Array<{
    path: string;
    relative_path: string;
    source_vector_fingerprint: string;
    neighbor_paths: string[];
    neighbor_fingerprints: string[];
  }>;
}

async function waitForNeighborRowCount(
  workspacePath: string,
  expectedCount: number
): Promise<Array<{
  path: string;
  source_vector_fingerprint: string;
  neighbor_paths: string[];
  neighbor_fingerprints: string[];
}>> {
  let rows = await readDirectNeighborRows();
  for (let attempt = 0; attempt < 20 && rows.length !== expectedCount; attempt++) {
    await waitForNeighborsFill(workspacePath);
    rows = await readDirectNeighborRows();
    if (rows.length === expectedCount) {
      return rows;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return rows;
}

describe('fileIndexService file_neighbors materialized table', () => {
  let workspacePath: string;
  let canonicalWorkspacePath: string;
  const vectorsByRelativePath = new Map<string, number[]>();

  async function writeIndexedFile(relativePath: string, vector: number[]): Promise<string> {
    vectorsByRelativePath.set(relativePath, vector);
    const filePath = await writeWorkspaceFile(workspacePath, relativePath, `content for ${relativePath}`);
    await indexFile(filePath, workspacePath);
    return fs.realpath(filePath);
  }

  beforeEach(async () => {
    testState.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'file-neighbors-userdata-'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'file-neighbors-workspace-'));
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
    testState.tryConvertToWorkspacePath.mockImplementation((filePath, _workspacePath, symlinkMap) => {
      const mappings = Array.isArray(symlinkMap)
        ? symlinkMap as Array<{ realPath?: string; workspacePath?: string }>
        : [];
      for (const mapping of mappings) {
        if (!mapping.realPath || !mapping.workspacePath) {
          continue;
        }
        const relativeToSymlinkTarget = path.relative(mapping.realPath, filePath);
        if (relativeToSymlinkTarget === '' || (!relativeToSymlinkTarget.startsWith('..') && !path.isAbsolute(relativeToSymlinkTarget))) {
          return path.join(mapping.workspacePath, relativeToSymlinkTarget);
        }
      }
      const relativePath = path.relative(canonicalWorkspacePath, filePath);
      return relativePath.startsWith('..') || path.isAbsolute(relativePath) ? null : relativePath;
    });
    testState.waitForTurnIdle.mockReset();
    testState.waitForTurnIdle.mockResolvedValue('idle');
    testState.loggerDebug.mockClear();
    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();
    testState.loggerError.mockClear();
    testState.broadcasts.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    const currentIndex = _getCurrentIndexForTesting();
    if (currentIndex && currentIndex.workspacePath !== workspacePath) {
      currentIndex.workspacePath = workspacePath;
    }
    await closeIndex();
    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.rm(testState.userDataPath, { recursive: true, force: true });
  });

  it('coalesces per-write file_neighbors triggers with a max-wait cap', () => {
    vi.useFakeTimers();
    const start = vi.fn();
    const restore = _scheduleFileNeighborWriteTriggerForTesting(start);
    try {
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(900);
        _scheduleFileNeighborWriteTriggerForTesting(start);
      }

      vi.advanceTimersByTime(499);
      expect(start).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('creates file_neighbors lazily and fills it asynchronously after first vector write', async () => {
    const filePath = await writeIndexedFile('first.md', [1, 0]);

    await waitForNeighborsFill(workspacePath);

    expect(await listTableNames(workspacePath)).toEqual(expect.arrayContaining([FILE_NEIGHBORS_TABLE_NAME]));
    expect(await readFileNeighbors([filePath])).toHaveProperty(filePath);
    expect(testState.broadcasts.map(event => event.channel)).toContain('file_neighbors:complete');
  });

  it('eagerly invalidates file_neighbors for a reindexed file', async () => {
    const filePath = await writeIndexedFile('source.md', [1, 0]);
    await writeIndexedFile('neighbor.md', [0.95, 0.05]);
    await waitForNeighborsFill(workspacePath);
    const currentIndex = _getCurrentIndexForTesting();
    const fileNeighborsTable = currentIndex?.fileNeighborsTable;
    if (!fileNeighborsTable) {
      throw new Error('Expected file_neighbors table');
    }
    const originalDelete = fileNeighborsTable.delete.bind(fileNeighborsTable);
    const deleteSpy = vi.fn((predicate: Parameters<typeof fileNeighborsTable.delete>[0]) => originalDelete(predicate));
    fileNeighborsTable.delete = deleteSpy;

    vectorsByRelativePath.set('source.md', [0, 1]);
    await fs.writeFile(filePath, 'updated source');
    await indexFile(filePath, workspacePath);

    expect(deleteSpy).toHaveBeenCalled();
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ path: filePath }),
      'file_neighbors.invalidate'
    );
  });

  it('delete paths remove file_neighbors rows for single and batch deletes', async () => {
    const firstPath = await writeIndexedFile('delete-a.md', [1, 0]);
    const secondPath = await writeIndexedFile('delete-b.md', [0, 1]);
    const referencingPath = await writeIndexedFile('delete-c.md', [0.9, 0.1]);
    await waitForNeighborsFill(workspacePath);
    await refreshReadTable();
    const rowsBeforeDelete = await readDirectNeighborRows();
    expect(rowsBeforeDelete.some(row => row.path === referencingPath && row.neighbor_paths.includes(firstPath))).toBe(true);

    await removeFileFromIndex(firstPath);
    expect((await readDirectNeighborRows()).some(row => row.path === referencingPath)).toBe(false);

    await removeFilesFromIndex([secondPath]);
    await refreshReadTable();

    expect(await readFileNeighbors([firstPath, secondPath])).toEqual({});
    expect(testState.loggerInfo).toHaveBeenCalledWith(expect.objectContaining({ path: firstPath }), 'file_neighbors.delete');
    expect(testState.loggerInfo).toHaveBeenCalledWith(expect.objectContaining({ paths: 1 }), 'file_neighbors.delete');
  });

  it('drops file_vectors and file_neighbors when chunk schema is incompatible', async () => {
    const filePath = await writeIndexedFile('legacy.md', [1, 0]);
    await waitForNeighborsFill(workspacePath);
    expect(await listTableNames(workspacePath)).toEqual(expect.arrayContaining([
      FILE_VECTORS_TABLE_NAME,
      FILE_NEIGHBORS_TABLE_NAME,
    ]));

    await closeIndex();
    await replaceChunksTableWithLegacySchema(workspacePath, filePath);
    await initializeIndex(workspacePath);

    const tableNames = await listTableNames(workspacePath);
    expect(tableNames).not.toContain(FILE_VECTORS_TABLE_NAME);
    expect(tableNames).not.toContain(FILE_NEIGHBORS_TABLE_NAME);
  });

  it('drops orphan file_vectors and file_neighbors when the chunks table is absent', async () => {
    await writeIndexedFile('orphan-base.md', [1, 0]);
    await waitForNeighborsFill(workspacePath);
    await closeIndex();
    await dropTableDirectly(workspacePath, FILE_EMBEDDINGS_TABLE_NAME);

    await initializeIndex(workspacePath);

    const tableNames = await listTableNames(workspacePath);
    expect(tableNames).not.toContain(FILE_VECTORS_TABLE_NAME);
    expect(tableNames).not.toContain(FILE_NEIGHBORS_TABLE_NAME);
  });

  it('drops file_neighbors when chunks exist but are empty', async () => {
    await writeIndexedFile('empty-chunks.md', [1, 0]);
    await waitForNeighborsFill(workspacePath);
    await closeIndex();
    await deleteAllChunkRowsDirectly(workspacePath);

    await initializeIndex(workspacePath);

    expect(await listTableNames(workspacePath)).not.toContain(FILE_NEIGHBORS_TABLE_NAME);
  });

  it('drops neighbor-only orphans when file_vectors is absent', async () => {
    await writeIndexedFile('neighbor-only-a.md', [1, 0]);
    await writeIndexedFile('neighbor-only-b.md', [0.9, 0.1]);
    await waitForNeighborsFill(workspacePath);
    await closeIndex();
    await dropTableDirectly(workspacePath, FILE_VECTORS_TABLE_NAME);

    await initializeIndex(workspacePath);

    expect(await listTableNames(workspacePath)).not.toContain(FILE_NEIGHBORS_TABLE_NAME);
  });

  it('drops legacy file_neighbors tables missing neighbor_fingerprints during init', async () => {
    const sourcePath = await writeIndexedFile('legacy-neighbors-a.md', [1, 0]);
    const neighborPath = await writeIndexedFile('legacy-neighbors-b.md', [0.9, 0.1]);
    await waitForNeighborsFill(workspacePath);
    await closeIndex();
    await replaceNeighborsTableWithLegacySchema(workspacePath, sourcePath, neighborPath);

    await initializeIndex(workspacePath);

    expect(await listTableNames(workspacePath)).not.toContain(FILE_NEIGHBORS_TABLE_NAME);
  });

  it('logs file_neighbors clear partial failures and retries the neighbor drop', async () => {
    await fs.mkdir(path.dirname(getLanceDBDir(workspacePath)), { recursive: true });
    const operationOrder: string[] = [];
    const dropTable = vi.fn(async (tableName: string) => {
      operationOrder.push(`drop:${tableName}`);
      if (tableName === FILE_NEIGHBORS_TABLE_NAME && dropTable.mock.calls.filter((call) => call[0] === FILE_NEIGHBORS_TABLE_NAME).length === 1) {
        throw new Error('simulated file_neighbors drop failure');
      }
    });
    const fakeIndex = {
      connection: {
        dropTable,
        tableNames: vi.fn(async () => [FILE_NEIGHBORS_TABLE_NAME]),
        close: vi.fn(async () => undefined),
      },
      table: { close: vi.fn(() => operationOrder.push('close:file_embeddings')) },
      fileVectorsTable: { close: vi.fn(() => operationOrder.push('close:file_vectors')) },
      fileNeighborsTable: { close: vi.fn(() => operationOrder.push('close:file_neighbors')) },
      readConnection: { openTable: vi.fn(), close: vi.fn(async () => undefined) },
      readTable: null,
      fileVectorsReadTable: null,
      fileNeighborsReadTable: null,
      workspacePath,
      indexedMtimes: new Map(),
      lastIndexedAt: null,
      metadata: { scanCompletedAt: null, totalFilesAtCompletion: null },
      indexedFilesCount: 0,
      ftsStatus: 'unavailable',
    };
    _setCurrentIndexForTesting(fakeIndex as unknown as Parameters<typeof _setCurrentIndexForTesting>[0]);

    await expect(clearIndex()).rejects.toThrow('simulated file_neighbors drop failure');
    expect(operationOrder).toEqual([
      'close:file_embeddings',
      'close:file_vectors',
      'close:file_neighbors',
      `drop:${FILE_EMBEDDINGS_TABLE_NAME}`,
      `drop:${FILE_VECTORS_TABLE_NAME}`,
      `drop:${FILE_NEIGHBORS_TABLE_NAME}`,
    ]);
    expect(testState.loggerWarn).toHaveBeenCalledWith(
      { err: expect.any(Error), workspacePath },
      'file_neighbors.clear_partial_failure'
    );

    await expect(clearIndex()).resolves.toBeUndefined();
    expect(dropTable.mock.calls.map((call) => call[0])).toEqual([
      FILE_EMBEDDINGS_TABLE_NAME,
      FILE_VECTORS_TABLE_NAME,
      FILE_NEIGHBORS_TABLE_NAME,
      FILE_NEIGHBORS_TABLE_NAME,
    ]);
  });

  it('populates file_neighbors asynchronously and single-flights concurrent starts', async () => {
    const firstPath = await writeIndexedFile('async-a.md', [1, 0]);
    const secondPath = await writeIndexedFile('async-b.md', [0.9, 0.1]);
    await resetNeighborsForUpgradeSimulation(workspacePath);

    startLazyFillFileNeighborsAsync();
    startLazyFillFileNeighborsAsync();
    await waitForNeighborsFill(workspacePath);

    const rows = await readDirectNeighborRows();
    expect(rows.map(row => row.path).sort()).toEqual([firstPath, secondPath].sort());
    expect(testState.loggerInfo.mock.calls.filter(call => call[1] === 'file_neighbors.lazy_fill_start')).toHaveLength(1);
  });

  it('does not re-trigger file_neighbors from checkpoint-hit file_vectors lazy-fill completions', async () => {
    await writeIndexedFile('noop-a.md', [1, 0]);
    await writeIndexedFile('noop-b.md', [0.9, 0.1]);
    await waitForNeighborsFill(workspacePath);

    testState.loggerInfo.mockClear();
    await lazyFillFileVectorsIfNeeded();
    await _drainBackgroundFillsForTesting(workspacePath);

    expect(testState.loggerInfo.mock.calls.filter(call => call[1] === 'file_neighbors.lazy_fill_start')).toHaveLength(0);
  });

  it('invalidates the file_neighbors checkpoint when lazy-fill writes file_vectors without a chunks bump', async () => {
    const firstPath = await writeIndexedFile('epoch-a.md', [1, 0]);
    const secondPath = await writeIndexedFile('epoch-b.md', [0.9, 0.1]);
    await waitForNeighborsFill(workspacePath);

    await closeIndex();
    await dropTableDirectly(workspacePath, FILE_VECTORS_TABLE_NAME);
    await dropTableDirectly(workspacePath, FILE_NEIGHBORS_TABLE_NAME);
    await initializeIndex(workspacePath);

    testState.loggerInfo.mockClear();
    await lazyFillFileVectorsIfNeeded();
    await _drainBackgroundFillsForTesting(workspacePath);

    expect((await readDirectNeighborRows()).map(row => row.path).sort()).toEqual([firstPath, secondPath].sort());
    expect(testState.loggerInfo.mock.calls.filter(call => call[1] === 'file_neighbors.lazy_fill_start').length).toBeGreaterThan(0);
  });

  it('records, prunes, and clears deterministic file_neighbors failures by file-vector fingerprint', async () => {
    const invalidPath = await writeIndexedFile('deterministic-neighbor.md', [1, 0]);
    const validPath = await writeIndexedFile('deterministic-neighbor-ok.md', [0.9, 0.1]);
    await resetNeighborsForUpgradeSimulation(workspacePath);
    const currentIndex = _getCurrentIndexForTesting();
    if (!currentIndex?.fileVectorsTable) {
      throw new Error('Expected file_vectors table');
    }
    const originalQuery = currentIndex.fileVectorsTable.query.bind(currentIndex.fileVectorsTable);
    const realRows = (await currentIndex.fileVectorsTable.query().toArray()) as Array<Record<string, unknown>>;
    const invalidRow = realRows.find(row => row.path === invalidPath);
    const validRow = realRows.find(row => row.path === validPath);
    if (!invalidRow || !validRow) {
      throw new Error('Expected seeded file_vectors rows');
    }
    const mockProjectionRows = (rows: Array<Record<string, unknown>>): void => {
      currentIndex.fileVectorsTable!.query = vi.fn(() => ({
        select: vi.fn(() => ({
          toArray: vi.fn(async () => rows),
        })),
      })) as unknown as typeof currentIndex.fileVectorsTable.query;
    };

    try {
      mockProjectionRows([{ ...invalidRow, vector: [] }, validRow]);
      startLazyFillFileNeighborsAsync();
      await waitForNeighborsFill(workspacePath);

      const workspaceMemo = getDeterministicFileNeighborFailures().get(workspacePath);
      expect(workspaceMemo?.has(invalidPath)).toBe(true);
      expect((await readDirectNeighborRows()).map(row => row.path)).toEqual([validPath]);
      expect(testState.loggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({ deterministicSkip: 1 }),
        'file_neighbors.lazy_fill_complete'
      );

      markFileNeighborsEpochMutated();
      mockProjectionRows([{
        ...invalidRow,
        source_max_indexed_at: Number(invalidRow.source_max_indexed_at) + 1,
        vector: [0, 1],
      }, validRow]);
      startLazyFillFileNeighborsAsync();
      await waitForNeighborsFill(workspacePath);
      expect(workspaceMemo?.has(invalidPath)).toBe(false);
      expect((await readDirectNeighborRows()).map(row => row.path).sort()).toEqual([invalidPath, validPath].sort());

      workspaceMemo?.set(invalidPath, 'stale-fingerprint');
      markFileNeighborsEpochMutated();
      mockProjectionRows([validRow]);
      startLazyFillFileNeighborsAsync();
      await waitForNeighborsFill(workspacePath);
      expect(workspaceMemo?.has(invalidPath)).toBe(false);
    } finally {
      currentIndex.fileVectorsTable.query = originalQuery;
    }
  });

  it('keeps symlink-retarget staleness bounded even when the neighbors checkpoint hits', async () => {
    const targetA = await fs.mkdtemp(path.join(os.tmpdir(), 'file-neighbors-target-a-'));
    const targetB = await fs.mkdtemp(path.join(os.tmpdir(), 'file-neighbors-target-b-'));
    const linkPath = path.join(workspacePath, 'drive-link');
    try {
      await fs.writeFile(path.join(targetA, 'linked.md'), 'linked content v1');
      await fs.writeFile(path.join(targetB, 'linked.md'), 'linked content v2');
      await fs.symlink(targetA, linkPath, 'dir');

      vectorsByRelativePath.set(path.join('drive-link', 'linked.md'), [1, 0]);
      const indexedPath = await fs.realpath(path.join(linkPath, 'linked.md'));
      await indexFile(path.join(linkPath, 'linked.md'), workspacePath);
      await waitForNeighborsFill(workspacePath);

      startLazyFillFileNeighborsAsync();
      await waitForNeighborsFill(workspacePath);
      testState.loggerInfo.mockClear();

      await fs.rm(linkPath, { force: true });
      await fs.symlink(targetB, linkPath, 'dir');

      startLazyFillFileNeighborsAsync();
      await waitForNeighborsFill(workspacePath);

      const retargetedPath = await fs.realpath(path.join(linkPath, 'linked.md'));
      await removeFileFromIndex(retargetedPath);

      expect(retargetedPath).not.toBe(indexedPath);
      expect((await readDirectNeighborRows()).some(row => row.relative_path === path.join('drive-link', 'linked.md'))).toBe(false);
      expect(testState.loggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({ total: 0 }),
        'file_neighbors.lazy_fill_complete'
      );
    } finally {
      await fs.rm(linkPath, { force: true }).catch(() => undefined);
      await fs.rm(targetA, { recursive: true, force: true });
      await fs.rm(targetB, { recursive: true, force: true });
    }
  });

  it('reruns lazy-fill when file_vectors mutate after target capture', async () => {
    const firstPath = await writeIndexedFile('race-a.md', [1, 0]);
    const secondPath = await writeIndexedFile('race-b.md', [0.9, 0.1]);
    await resetNeighborsForUpgradeSimulation(workspacePath);
    const currentIndex = _getCurrentIndexForTesting();
    const readHandle = currentIndex?.fileVectorsReadTable as unknown as {
      acquire: () => { vectorSearch: (vector: number[]) => unknown };
    } | null;
    if (!readHandle) {
      throw new Error('Expected file vectors read handle');
    }
    const originalAcquire = readHandle.acquire.bind(readHandle);
    let resolveSearchStarted!: () => void;
    let resumeSearch!: () => void;
    const searchStarted = new Promise<void>(resolve => {
      resolveSearchStarted = resolve;
    });
    const searchCanContinue = new Promise<void>(resolve => {
      resumeSearch = resolve;
    });
    let didPauseSearch = false;
    const wrapQuery = (query: Record<PropertyKey, unknown>): Record<PropertyKey, unknown> => new Proxy(query, {
      get(target, property, receiver) {
        if (property === 'toArray') {
          const originalToArray = Reflect.get(target, property, receiver);
          if (typeof originalToArray !== 'function') {
            return originalToArray;
          }
          return async (...args: unknown[]) => {
            if (!didPauseSearch) {
              didPauseSearch = true;
              resolveSearchStarted();
              await searchCanContinue;
            }
            return originalToArray.apply(target, args);
          };
        }

        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          return result && typeof result === 'object'
            ? wrapQuery(result as Record<PropertyKey, unknown>)
            : result;
        };
      },
    });
    readHandle.acquire = vi.fn(() => {
      const table = originalAcquire() as { vectorSearch: (vector: number[]) => unknown };
      const originalVectorSearch = table.vectorSearch.bind(table);
      table.vectorSearch = vi.fn((vector: number[]) =>
        wrapQuery(originalVectorSearch(vector) as Record<PropertyKey, unknown>)
      );
      return table;
    });

    let latePath: string | null = null;

    startLazyFillFileNeighborsAsync();
    await Promise.race([
      searchStarted,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Timed out waiting for paused neighbor search')), 1000)),
    ]);
    readHandle.acquire = originalAcquire;
    latePath = await writeIndexedFile('race-late.md', [0, 1]);
    resumeSearch();
    const rows = await waitForNeighborRowCount(workspacePath, 3);

    expect(latePath).toBeTruthy();
    expect(rows.map(row => row.path).sort()).toEqual([firstPath, secondPath, latePath!].sort());
    expect(testState.loggerInfo.mock.calls.filter(call => call[1] === 'file_neighbors.lazy_fill_start')).toHaveLength(2);
  });

  it('aborts lazy-fill cleanly when the workspace changes between batches', async () => {
    for (let i = 0; i < 5; i++) {
      await writeIndexedFile(`switch-${i}.md`, [1, i / 100]);
    }
    await resetNeighborsForUpgradeSimulation(workspacePath);
    const currentIndex = _getCurrentIndexForTesting();

    startLazyFillFileNeighborsAsync();
    currentIndex!.workspacePath = `${workspacePath}-switched`;
    await waitForNeighborsFill(workspacePath);

    expect(testState.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'workspace_changed' }),
      'file_neighbors.lazy_fill_aborted'
    );
    expect(testState.broadcasts.at(-1)).toEqual({
      channel: 'file_neighbors:complete',
      payload: expect.objectContaining({ aborted: true, failed: expect.any(Number) }),
    });
    currentIndex!.workspacePath = workspacePath;
  });

  it('readFileNeighbors returns only requested paths with materialized coverage', async () => {
    const firstPath = await writeIndexedFile('covered.md', [1, 0]);
    await writeIndexedFile('other.md', [0.9, 0.1]);
    await waitForNeighborsFill(workspacePath);
    await refreshReadTable();

    const result = await readFileNeighbors([firstPath, path.join(workspacePath, 'missing.md')]);

    expect(Object.keys(result)).toEqual([firstPath]);
    expect(Array.isArray(result[firstPath])).toBe(true);
  });

  it('readFileNeighbors returns empty when chunks are quarantined', async () => {
    const firstPath = await writeIndexedFile('quarantined.md', [1, 0]);
    await writeIndexedFile('quarantined-neighbor.md', [0.9, 0.1]);
    await waitForNeighborsFill(workspacePath);
    await refreshReadTable();
    expect(await readFileNeighbors([firstPath])).toHaveProperty(firstPath);
    const currentIndex = _getCurrentIndexForTesting();
    const originalTable = currentIndex?.table ?? null;
    if (!currentIndex || !originalTable) {
      throw new Error('Expected active chunks table');
    }

    currentIndex.table = null;
    try {
      expect(await readFileNeighbors([firstPath])).toEqual({});
    } finally {
      currentIndex.table = originalTable;
    }
  });

  it('reconcile deletes stale, orphan, and cross-reference-orphan file_neighbors rows', async () => {
    const stalePath = await writeIndexedFile('stale.md', [1, 0]);
    const orphanPath = await writeIndexedFile('orphan.md', [0.8, 0.2]);
    const crossReferencePath = await writeIndexedFile('cross-reference.md', [0.7, 0.3]);
    await waitForNeighborsFill(workspacePath);
    const currentIndex = _getCurrentIndexForTesting();
    if (!currentIndex?.fileNeighborsTable || !currentIndex.fileVectorsTable) {
      throw new Error('Expected file_vectors and file_neighbors tables');
    }

    await currentIndex.fileNeighborsTable.update({
      where: eq('path', stalePath),
      values: { source_vector_fingerprint: 'stale-fingerprint' },
    });
    await currentIndex.fileVectorsTable.delete(eq('path', orphanPath));
    const [crossReferenceRow] = (await currentIndex.fileNeighborsTable
      .query()
      .where(eq('path', crossReferencePath))
      .limit(1)
      .toArray()) as Array<Record<string, unknown>>;
    await currentIndex.fileNeighborsTable.delete(eq('path', crossReferencePath));
    await currentIndex.fileNeighborsTable.add([{
      ...crossReferenceRow,
      neighbor_paths: [orphanPath],
      neighbor_scores: [0.5],
      neighbor_fingerprints: ['orphan-fingerprint'],
    }]);

    await expect(reconcileFileNeighborsIfNeeded()).resolves.toMatchObject({
      deleted: 3,
      stale: 1,
      orphaned: 1,
      crossReferenceOrphans: 1,
    });
  });

  it('reconcile invalidates rows when a referenced neighbor fingerprint changes', async () => {
    const sourcePath = await writeIndexedFile('referenced-source.md', [1, 0]);
    const neighborPath = await writeIndexedFile('referenced-neighbor.md', [0.9, 0.1]);
    await waitForNeighborsFill(workspacePath);
    const currentIndex = _getCurrentIndexForTesting();
    if (!currentIndex?.fileNeighborsTable || !currentIndex.fileVectorsTable) {
      throw new Error('Expected file_vectors and file_neighbors tables');
    }
    const [sourceRow] = (await currentIndex.fileNeighborsTable
      .query()
      .where(eq('path', sourcePath))
      .limit(1)
      .toArray()) as Array<Record<string, unknown>>;
    await currentIndex.fileNeighborsTable.delete(eq('path', sourcePath));
    await currentIndex.fileNeighborsTable.add([{
      ...sourceRow,
      neighbor_paths: [neighborPath],
      neighbor_scores: [0.5],
      neighbor_fingerprints: ['stale-neighbor-fingerprint'],
    }]);

    await expect(reconcileFileNeighborsIfNeeded()).resolves.toMatchObject({
      deleted: 1,
      stale: 1,
    });
    expect((await readDirectNeighborRows()).some(row => row.path === sourcePath)).toBe(false);
  });

  it('skips writing a neighbor row when vector search fails and retries successfully later', async () => {
    const firstPath = await writeIndexedFile('search-failure-a.md', [1, 0]);
    const secondPath = await writeIndexedFile('search-failure-b.md', [0.9, 0.1]);
    await resetNeighborsForUpgradeSimulation(workspacePath);
    const currentIndex = _getCurrentIndexForTesting();
    const readHandle = currentIndex?.fileVectorsReadTable as unknown as {
      acquire: () => { vectorSearch: (vector: number[]) => unknown };
    } | null;
    if (!readHandle) {
      throw new Error('Expected file vectors read handle');
    }
    const originalAcquire = readHandle.acquire.bind(readHandle);
    let shouldFail = true;
    readHandle.acquire = vi.fn(() => {
      const table = originalAcquire() as { vectorSearch: (vector: number[]) => unknown };
      const originalVectorSearch = table.vectorSearch.bind(table);
      table.vectorSearch = vi.fn((vector: number[]) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('simulated vector search failure');
        }
        return originalVectorSearch(vector);
      });
      return table;
    });

    startLazyFillFileNeighborsAsync();
    await waitForNeighborsFill(workspacePath);

    const rowsAfterFailure = await readDirectNeighborRows();
    const failureCall = testState.loggerWarn.mock.calls.find(call => call[1] === 'file_neighbors.lazy_fill_search_failure');
    const failedPath = (failureCall?.[0] as { path?: string } | undefined)?.path;
    expect(rowsAfterFailure).toHaveLength(1);
    expect(failedPath).toBeTruthy();
    expect(rowsAfterFailure.map(row => row.path)).not.toContain(failedPath);
    expect(testState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ path: failedPath }),
      'file_neighbors.lazy_fill_search_failure'
    );
    expect(testState.broadcasts.at(-1)).toEqual({
      channel: 'file_neighbors:complete',
      payload: expect.objectContaining({ filled: 1, total: 2, failed: 1, aborted: false }),
    });

    readHandle.acquire = originalAcquire;
    startLazyFillFileNeighborsAsync();
    await waitForNeighborsFill(workspacePath);

    expect((await readDirectNeighborRows()).map(row => row.path).sort()).toEqual([firstPath, secondPath].sort());
  });

  it('startup reconcile kicks off lazy-fill when file_vectors coverage exceeds file_neighbors coverage', async () => {
    const firstPath = await writeIndexedFile('startup-a.md', [1, 0]);
    const secondPath = await writeIndexedFile('startup-b.md', [0.9, 0.1]);
    await resetNeighborsForUpgradeSimulation(workspacePath);

    await reconcileFileVectorsIfNeeded();
    await waitForNeighborsFill(workspacePath);

    expect((await readDirectNeighborRows()).map(row => row.path).sort()).toEqual([firstPath, secondPath].sort());
  });
});
