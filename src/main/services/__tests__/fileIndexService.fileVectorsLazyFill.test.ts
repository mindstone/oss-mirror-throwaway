import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testState = vi.hoisted(() => ({
  userDataPath: '/tmp/file-vectors-lazy-fill-userdata-initial',
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
    generateEmbedding: async () => Float32Array.from([1, 0, 0]),
    generateQueryEmbedding: async () => Float32Array.from([1, 0, 0]),
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
  FILE_VECTORS_TABLE_NAME,
  _drainBackgroundFillsForTesting,
  _getCurrentIndexForTesting,
  _getDeterministicFileVectorFailuresForTesting,
  _getMutationVersionForTesting,
  _getNanRepairAttemptsForTesting,
  _getNanRepairFailuresForTesting,
  _getNanRepairPendingForTesting,
  _runNanRepairSweepTickForTesting,
  _scheduleAndCheckNanRepairSweepForTesting,
  closeIndex,
  indexFile,
  initializeIndex,
  lazyFillFileVectorsIfNeeded,
  readAllFileVectors,
  refreshReadTable,
} from '../fileIndexService';

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

async function writeWorkspaceFile(workspacePath: string, relativePath: string, content: string): Promise<string> {
  const filePath = path.join(workspacePath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
}

function chunkIdFor(filePath: string, chunkIndex: number): string {
  return crypto.createHash('sha256').update(`${filePath}:${chunkIndex}`).digest('hex').slice(0, 32);
}

/**
 * Insert a corrupt chunk row DIRECTLY into the file_embeddings table, bypassing
 * indexFile()'s embed-time NaN guard. Post-Stage-4 the guard makes it
 * structurally impossible to write such a chunk through indexFile, so tests that
 * exercise the lazy-fill deterministic-skip / FU-4 repair paths over LEGACY
 * on-disk corruption (rows written before the guard existed) must seed that
 * state directly.
 *
 * `vector` selects the corruption kind:
 *  - default (non-finite, e.g. Inf/NaN) → the FU-4 REPAIR target.
 *  - a finite zero-norm vector ([0,0,0]) → a deterministic skip that FU-4
 *    classifies `not_repairable` (so it exercises the pure deterministic-skip
 *    machinery without triggering a re-embed).
 *
 * Returns the canonical (realpath) of the file the row points at.
 */
async function insertCorruptChunkRowDirectly(
  workspacePath: string,
  relativePath: string,
  content: string,
  vector: number[] = [Number.POSITIVE_INFINITY, 0, 0]
): Promise<string> {
  const filePath = await writeWorkspaceFile(workspacePath, relativePath, content);
  const canonicalPath = await fs.realpath(filePath);
  const lancedb = await import('@lancedb/lancedb');
  const connection = await lancedb.connect(getLanceDBDir(workspacePath));
  let table: Awaited<ReturnType<typeof connection.createTable>> | null = null;
  try {
    const row = {
      id: chunkIdFor(canonicalPath, 0),
      path: canonicalPath,
      relativePath,
      content,
      extension: path.extname(canonicalPath).toLowerCase(),
      mtime: Math.floor((await fs.stat(canonicalPath)).mtimeMs),
      size: content.length,
      chunkIndex: 0,
      totalChunks: 1,
      indexedAt: Date.now(),
      vector,
      filename_stem: path.basename(canonicalPath, path.extname(canonicalPath)),
      is_enhanced: 0,
      enhanced_at: 0,
    };
    const tableNames = await connection.tableNames();
    if (tableNames.includes(FILE_EMBEDDINGS_TABLE_NAME)) {
      table = await connection.openTable(FILE_EMBEDDINGS_TABLE_NAME);
      await table.add([row]);
    } else {
      table = await connection.createTable(FILE_EMBEDDINGS_TABLE_NAME, [row]);
    }
  } finally {
    try {
      table?.close();
    } catch {
      // Ignore close errors in test fixture setup.
    }
    await closeConnection(connection);
  }
  return canonicalPath;
}

/**
 * Seed a legacy on-disk file with MIXED chunk validity: one valid finite chunk
 * and one non-finite chunk (totalChunks=2). Used to exercise the Layer-2 healing
 * path (MA4): recomputeFileVectorRow averages over the valid chunk only and must
 * emit a counted `file_vectors.partial_quality` warning. Returns the canonical path.
 */
async function insertMixedValidityChunkRowsDirectly(
  workspacePath: string,
  relativePath: string,
  content: string
): Promise<string> {
  const filePath = await writeWorkspaceFile(workspacePath, relativePath, content);
  const canonicalPath = await fs.realpath(filePath);
  const mtime = Math.floor((await fs.stat(canonicalPath)).mtimeMs);
  const ext = path.extname(canonicalPath).toLowerCase();
  const stem = path.basename(canonicalPath, ext);
  const baseRow = (chunkIndex: number, vector: number[]) => ({
    id: chunkIdFor(canonicalPath, chunkIndex),
    path: canonicalPath,
    relativePath,
    content,
    extension: ext,
    mtime,
    size: content.length,
    chunkIndex,
    totalChunks: 2,
    indexedAt: Date.now(),
    vector,
    filename_stem: stem,
    is_enhanced: 0,
    enhanced_at: 0,
  });
  const lancedb = await import('@lancedb/lancedb');
  const connection = await lancedb.connect(getLanceDBDir(workspacePath));
  let table: Awaited<ReturnType<typeof connection.createTable>> | null = null;
  try {
    const rows = [baseRow(0, [1, 0, 0]), baseRow(1, [Number.NaN, 0, 0])];
    const tableNames = await connection.tableNames();
    if (tableNames.includes(FILE_EMBEDDINGS_TABLE_NAME)) {
      table = await connection.openTable(FILE_EMBEDDINGS_TABLE_NAME);
      await table.add(rows);
    } else {
      table = await connection.createTable(FILE_EMBEDDINGS_TABLE_NAME, rows);
    }
  } finally {
    try {
      table?.close();
    } catch {
      // Ignore close errors in test fixture setup.
    }
    await closeConnection(connection);
  }
  return canonicalPath;
}

async function resetFileVectorsForUpgradeSimulation(workspacePath: string): Promise<void> {
  await closeIndex();
  await dropTableDirectly(workspacePath, FILE_VECTORS_TABLE_NAME);
  await initializeIndex(workspacePath);
  testState.loggerInfo.mockClear();
  testState.loggerWarn.mockClear();
}

/**
 * Seed a legacy on-disk corrupt-chunk state and (re)initialize the index so a
 * subsequent lazy-fill pass exercises the deterministic-skip path over it — the
 * post-Stage-4 replacement for "mock a NaN embedding + indexFile", which the
 * embed-time guard now (correctly) refuses to persist. Leaves file_vectors
 * absent (the row was inserted into file_embeddings only). Returns the canonical
 * path. Clears the logger spies so callers can assert on the lazy-fill output.
 */
async function seedLegacyCorruptFile(
  workspacePath: string,
  relativePath: string,
  content: string,
  vector?: number[]
): Promise<string> {
  await closeIndex();
  const canonicalPath = await insertCorruptChunkRowDirectly(workspacePath, relativePath, content, vector);
  await initializeIndex(workspacePath);
  testState.loggerInfo.mockClear();
  testState.loggerWarn.mockClear();
  return canonicalPath;
}

async function readVectorsAfterRefresh() {
  await refreshReadTable();
  return readAllFileVectors();
}

/** Read the raw chunk rows for a path directly from file_embeddings (FU-4 repair assertions). */
async function readChunkRowsForPath(workspacePath: string, canonicalPath: string): Promise<
  Array<{ vector: number[] }>
> {
  const lancedb = await import('@lancedb/lancedb');
  const connection = await lancedb.connect(getLanceDBDir(workspacePath));
  try {
    const tableNames = await connection.tableNames();
    if (!tableNames.includes(FILE_EMBEDDINGS_TABLE_NAME)) {
      return [];
    }
    const table = await connection.openTable(FILE_EMBEDDINGS_TABLE_NAME);
    try {
      const rows = await table
        .query()
        .where(`path = '${canonicalPath.replace(/'/g, "''")}'`)
        .select(['vector'])
        .toArray();
      return rows.map((r) => ({ vector: Array.from((r as { vector: Iterable<number> }).vector) }));
    } finally {
      try {
        table.close();
      } catch {
        // ignore close errors in test
      }
    }
  } finally {
    await closeConnection(connection);
  }
}

function hasNonFinite(vector: number[]): boolean {
  return vector.some((v) => !Number.isFinite(v));
}

describe('fileIndexService file_vectors lazy-fill', () => {
  let workspacePath: string;
  let extraWorkspacePaths: string[];

  beforeEach(async () => {
    testState.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'file-vectors-lazy-fill-userdata-'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'file-vectors-lazy-fill-workspace-'));
    extraWorkspacePaths = [];
    testState.generateEmbeddings.mockReset();
    testState.generateEmbeddings.mockImplementation(async (texts) =>
      texts.map((text, index) => {
        const axis = (text.length + index) % 3;
        return Float32Array.from(axis === 0 ? [1, 0, 0] : axis === 1 ? [0, 1, 0] : [0, 0, 1]);
      })
    );
    testState.tryConvertToWorkspacePath.mockReset();
    testState.tryConvertToWorkspacePath.mockReturnValue(null);
    testState.isAnyTurnActive.mockReset();
    testState.isAnyTurnActive.mockReturnValue(false);
    testState.waitForTurnIdle.mockClear();
    testState.loggerDebug.mockClear();
    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();
    testState.loggerError.mockClear();
  });

  afterEach(async () => {
    // Quiesce fire-and-forget neighbor/vector fills (+ their setTimeout(0) restarts) before closing,
    // so leaked background work can't cross into the next test in the same worker (flake prevention).
    // Defensive: a test may have already closed the index, so never let the drain fail teardown.
    await _drainBackgroundFillsForTesting().catch(() => {});
    await closeIndex();
    await fs.rm(workspacePath, { recursive: true, force: true });
    await Promise.all(extraWorkspacePaths.map((extraWorkspacePath) =>
      fs.rm(extraWorkspacePath, { recursive: true, force: true })
    ));
    await fs.rm(testState.userDataPath, { recursive: true, force: true });
  });

  it('lazy-fills missing file_vectors on the first read and does not re-fill on the second read', async () => {
    const firstPath = await writeWorkspaceFile(workspacePath, 'first.md', 'first old install row');
    const secondPath = await writeWorkspaceFile(workspacePath, 'second.md', 'second old install row');
    await indexFile(firstPath, workspacePath);
    await indexFile(secondPath, workspacePath);
    await resetFileVectorsForUpgradeSimulation(workspacePath);

    const rows = await readAllFileVectors();

    expect(rows.map((row) => row.path).sort()).toEqual([
      await fs.realpath(firstPath),
      await fs.realpath(secondPath),
    ].sort());
    expect(await listTableNames(workspacePath)).toEqual(
      expect.arrayContaining([FILE_EMBEDDINGS_TABLE_NAME, FILE_VECTORS_TABLE_NAME])
    );
    expect(testState.loggerInfo.mock.calls.filter((call) => call[1] === 'file_vectors.write')).toHaveLength(2);

    testState.loggerInfo.mockClear();
    const secondReadRows = await readAllFileVectors();

    expect(secondReadRows).toHaveLength(2);
    expect(testState.loggerInfo.mock.calls.filter((call) => call[1] === 'file_vectors.write')).toHaveLength(0);
  });

  it('is idempotent when run twice in a row', async () => {
    const firstPath = await writeWorkspaceFile(workspacePath, 'idempotent-a.md', 'idempotent a');
    const secondPath = await writeWorkspaceFile(workspacePath, 'idempotent-b.md', 'idempotent b');
    await indexFile(firstPath, workspacePath);
    await indexFile(secondPath, workspacePath);
    await resetFileVectorsForUpgradeSimulation(workspacePath);

    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 2, skipped: 0, failed: 0 });
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, skipped: 2, failed: 0 });
  });

  it('skips already-filled rows after close and re-initialize', async () => {
    const firstPath = await writeWorkspaceFile(workspacePath, 'restart-a.md', 'restart a');
    const secondPath = await writeWorkspaceFile(workspacePath, 'restart-b.md', 'restart b');
    await indexFile(firstPath, workspacePath);
    await indexFile(secondPath, workspacePath);
    await resetFileVectorsForUpgradeSimulation(workspacePath);
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 2, skipped: 0, failed: 0 });

    await closeIndex();
    await initializeIndex(workspacePath);
    testState.loggerInfo.mockClear();

    const rows = await readAllFileVectors();

    expect(rows).toHaveLength(2);
    expect(testState.loggerInfo.mock.calls.filter((call) => call[1] === 'file_vectors.write')).toHaveLength(0);
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, skipped: 2, failed: 0 });
  });

  it('coexists with a concurrent live index write', async () => {
    const oldPath = await writeWorkspaceFile(workspacePath, 'old.md', 'old install row');
    await indexFile(oldPath, workspacePath);
    await resetFileVectorsForUpgradeSimulation(workspacePath);

    const lazyFillPromise = lazyFillFileVectorsIfNeeded();
    const livePath = await writeWorkspaceFile(workspacePath, 'live.md', 'live concurrent row');
    const liveWritePromise = indexFile(livePath, workspacePath);

    await Promise.all([lazyFillPromise, liveWritePromise]);

    const rows = await readVectorsAfterRefresh();
    expect(rows.map((row) => row.path).sort()).toEqual([
      await fs.realpath(oldPath),
      await fs.realpath(livePath),
    ].sort());
  });

  it('returns empty instead of reading the new workspace when the workspace switches during lazy-fill', async () => {
    const oldPath = await writeWorkspaceFile(workspacePath, 'old-workspace.md', 'old workspace row');
    await indexFile(oldPath, workspacePath);
    await resetFileVectorsForUpgradeSimulation(workspacePath);

    const currentIndex = _getCurrentIndexForTesting();
    const table = currentIndex!.table!;
    const originalQuery = table.query.bind(table);
    let releaseProjection!: () => void;
    const projectionStarted = new Promise<void>((resolve) => {
      vi.spyOn(table, 'query').mockImplementationOnce(() => {
        const query = originalQuery();
        return {
          select: (columns: string[]) => {
            const selected = query.select(columns);
            return {
              toArray: async () => {
                resolve();
                await new Promise<void>((innerResolve) => {
                  releaseProjection = innerResolve;
                });
                return selected.toArray();
              },
            };
          },
        } as unknown as ReturnType<typeof table.query>;
      });
    });

    const staleReadPromise = readAllFileVectors();
    await projectionStarted;

    currentIndex!.workspacePath = `${workspacePath}-switched`;
    releaseProjection();

    await expect(staleReadPromise).resolves.toEqual([]);
    currentIndex!.workspacePath = workspacePath;
    await expect(readAllFileVectors()).resolves.toMatchObject([{ path: await fs.realpath(oldPath) }]);
  });

  it('single-flights concurrent first-read lazy-fill work per workspace', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'single-flight.md', 'single flight row');
    await indexFile(filePath, workspacePath);
    await resetFileVectorsForUpgradeSimulation(workspacePath);

    const currentIndex = _getCurrentIndexForTesting();
    const table = currentIndex!.table!;
    const originalQuery = table.query.bind(table);
    let releaseProjection!: () => void;
    const projectionStarted = new Promise<void>((resolve) => {
      vi.spyOn(table, 'query').mockImplementationOnce(() => {
        const query = originalQuery();
        return {
          select: (columns: string[]) => {
            const selected = query.select(columns);
            return {
              toArray: async () => {
                resolve();
                await new Promise<void>((innerResolve) => {
                  releaseProjection = innerResolve;
                });
                return selected.toArray();
              },
            };
          },
        } as unknown as ReturnType<typeof table.query>;
      });
    });

    const firstReadPromise = readAllFileVectors();
    await projectionStarted;
    const secondReadPromise = readAllFileVectors();

    releaseProjection();

    const [firstRows, secondRows] = await Promise.all([firstReadPromise, secondReadPromise]);
    expect(firstRows).toHaveLength(1);
    expect(secondRows).toHaveLength(1);
    expect(testState.loggerInfo.mock.calls.filter((call) => call[1] === 'file_vectors.lazy_fill_start')).toHaveLength(1);
  });

  it('returns zeros for an empty workspace', async () => {
    await initializeIndex(workspacePath);

    await expect(lazyFillFileVectorsIfNeeded()).resolves.toEqual({
      filled: 0,
      skipped: 0,
      failed: 0,
      durationMs: 0,
    });
  });

  it('uses the canonical file_vectors.skipped path for a deterministically-unfillable (zero-norm) chunk vector and treats it as a deterministic (non-failing) skip', async () => {
    // Legacy on-disk corruption that FU-4 classifies `not_repairable` (a finite
    // zero-norm vector — not the non-finite NaN repair target), so it exercises
    // the pure deterministic-skip path: lazy-fill classifies it invalid_vectors
    // and skips it WITHOUT a re-embed.
    const canonicalPath = await seedLegacyCorruptFile(workspacePath, 'zero-norm.md', 'zero norm vector', [0, 0, 0]);

    const seeded = await readChunkRowsForPath(workspacePath, canonicalPath);
    expect(seeded).toEqual([{ vector: [0, 0, 0] }]);

    testState.loggerWarn.mockClear();
    await expect(readAllFileVectors()).resolves.toEqual([]);

    expect(await readVectorsAfterRefresh()).toEqual([]);
    expect(testState.loggerWarn).toHaveBeenCalledWith(
      { path: canonicalPath, reason: 'invalid_vectors', chunkCount: 1 },
      'file_vectors.skipped'
    );
    // Stage 3: a deterministic skip is NOT a failure — the pass converges
    // (failed:0) instead of emitting the partial-failure spam the old loop did.
    expect(testState.loggerWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      'file_vectors.lazy_fill_partial_failure'
    );
  });

  it('logs file_vectors.partial_quality when Layer-2 heals a legacy file from a SUBSET of chunks (MA4)', async () => {
    // A legacy 2-chunk file: one valid finite chunk + one NaN chunk. lazy-fill
    // heals it (writes a usable file vector from the 1 valid chunk) but must make
    // the partial quality observable so the on-disk corrupt rows aren't silent.
    await closeIndex();
    const canonicalPath = await insertMixedValidityChunkRowsDirectly(
      workspacePath,
      'mixed-validity.md',
      'mixed validity content'
    );
    await initializeIndex(workspacePath);
    testState.loggerWarn.mockClear();
    testState.loggerInfo.mockClear();

    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 1, failed: 0 });

    // The file vector WAS written (healed from the valid chunk).
    const rows = await readVectorsAfterRefresh();
    expect(rows.map((r) => r.path)).toContain(canonicalPath);

    // ...and the partial-quality healing is observable with skip accounting.
    const partialLogs = testState.loggerWarn.mock.calls.filter(
      (c) => c[1] === 'file_vectors.partial_quality' && (c[0] as { path?: string }).path === canonicalPath
    );
    expect(partialLogs).toHaveLength(1);
    expect(partialLogs[0][0]).toMatchObject({
      path: canonicalPath,
      validCount: 1,
      skippedCount: 1,
      totalChunks: 2,
    });
  });

  // --------------------------------------------------------------------------
  // Stage 3 — deterministic-failure short-circuit + loop convergence (Layer B)
  // --------------------------------------------------------------------------

  function countSkippedWarns(): number {
    return testState.loggerWarn.mock.calls.filter((call) => call[1] === 'file_vectors.skipped').length;
  }

  function lastDeterministicSkipCount(): number | undefined {
    const calls = testState.loggerInfo.mock.calls.filter((call) => call[1] === 'file_vectors.deterministic_skip');
    const last = calls.at(-1);
    return last ? (last[0] as { count: number }).count : undefined;
  }

  it('attempts an invalid_vectors file once, then short-circuits it on later passes (no re-derive)', async () => {
    // A legacy on-disk non-finite chunk row → recomputeFileVectorRow returns
    // 'skipped' (reason: invalid_vectors) and never persists a row.
    const filePath = await seedLegacyCorruptFile(workspacePath, 'permanently-invalid.md', 'permanently invalid', [0, 0, 0]);

    testState.loggerWarn.mockClear();
    testState.loggerInfo.mockClear();

    // First pass: the file is attempted exactly once → one file_vectors.skipped,
    // and it is reported as a single deterministic_skip summary line (NOT the
    // 242-lines/min per-file spam).
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });
    expect(countSkippedWarns()).toBe(1);
    expect(lastDeterministicSkipCount()).toBe(1);

    // It is now recorded in the per-workspace deterministic-failure memo.
    const memo = _getDeterministicFileVectorFailuresForTesting().get(
      _getCurrentIndexForTesting()!.workspacePath
    );
    expect(memo?.has(await fs.realpath(filePath))).toBe(true);

    // Subsequent passes: recompute is NOT called again for the same identity.
    // (The pass converges via the checkpoint short-circuit, so it does zero work
    // — no further file_vectors.skipped warns.)
    testState.loggerWarn.mockClear();
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });

    expect(countSkippedWarns()).toBe(0);
  });

  it('converges: a second pass over an all-deterministically-failing set does no work and does not bump the mutation version', async () => {
    // Two legacy on-disk invalid (NaN/Inf) chunk rows.
    await seedLegacyCorruptFile(workspacePath, 'converge-a.md', 'converge a', [0, 0, 0]);
    await seedLegacyCorruptFile(workspacePath, 'converge-b.md', 'converge b', [0, 0, 0]);

    // First pass records both as deterministic failures and CHECKPOINTS
    // (failed:0 even though nothing was filled).
    testState.loggerWarn.mockClear();
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });
    expect(countSkippedWarns()).toBe(2);

    const versionAfterFirstPass = _getMutationVersionForTesting();
    testState.loggerWarn.mockClear();
    testState.loggerInfo.mockClear();

    // Second pass: no chunk-table re-derive at all (checkpoint short-circuit),
    // so no recompute → no file_vectors.skipped, and the mutation version is
    // unchanged ⇒ the file_neighbors master loop's mutation-gated self-restart
    // cannot fire.
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });

    expect(countSkippedWarns()).toBe(0);
    expect(_getMutationVersionForTesting()).toBe(versionAfterFirstPass);
  });

  it('re-attempts a deterministically-failed file once its content identity (mtime/size) changes', async () => {
    // First version is a legacy on-disk invalid (NaN/Inf) chunk row.
    const realPath = await seedLegacyCorruptFile(workspacePath, 'recover.md', 'recover v1 invalid', [0, 0, 0]);
    const filePath = path.join(workspacePath, 'recover.md');

    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });
    expect(
      _getDeterministicFileVectorFailuresForTesting()
        .get(_getCurrentIndexForTesting()!.workspacePath)
        ?.has(realPath)
    ).toBe(true);

    // The file changes (new content → new mtime + new chunk fingerprint) and is
    // re-indexed with a VALID embedding.
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([0, 1, 0])]);
    await writeWorkspaceFile(workspacePath, 'recover.md', 'recover v2 now valid and longer content here');
    await indexFile(filePath, workspacePath);

    testState.loggerWarn.mockClear();
    // The fingerprint no longer matches the memo → the file is re-attempted and
    // now fills successfully; the memo entry is cleared.
    await refreshReadTable();
    const rows = await readAllFileVectors();
    expect(rows.map((row) => row.path)).toContain(realPath);
    expect(
      _getDeterministicFileVectorFailuresForTesting()
        .get(_getCurrentIndexForTesting()!.workspacePath)
        ?.has(realPath)
    ).toBe(false);
  });

  // --------------------------------------------------------------------------
  // MA4 (260529 GPT-5.5 review): the deterministic-skip memo key is the chunk
  // FINGERPRINT, which does not encode vector validity. A future repair (Stage 4)
  // that rewrites bad chunk vectors in place — preserving mtime/count — would
  // leave the file skipped + the checkpoint short-circuited forever (until
  // restart). The fix gives a repair path two explicit levers to force a
  // re-attempt: `clearDeterministicVectorSkip(ws, paths?)`, and bumping the
  // mutation version (markChunksTableMutated, which any chunk write already does).
  // --------------------------------------------------------------------------
  it('re-attempts a deterministic-skip file after clearDeterministicVectorSkip() (the Stage 4 repair contract)', async () => {
    // A legacy on-disk deterministically-invalid file → recorded as a
    // deterministic skip + checkpointed. Its chunk fingerprint stays FIXED, so
    // the memo/checkpoint would otherwise keep it skipped until restart (the MA4
    // regression).
    const realPath = await seedLegacyCorruptFile(workspacePath, 'repairable.md', 'repairable invalid forever', [0, 0, 0]);
    const ws = _getCurrentIndexForTesting()!.workspacePath;

    // Pass 1: attempted once (one skipped warn) → memoed.
    testState.loggerWarn.mockClear();
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });
    expect(_getDeterministicFileVectorFailuresForTesting().get(ws)?.has(realPath)).toBe(true);
    expect(countSkippedWarns()).toBe(1);

    // Pass 2 (no repair): short-circuits via the memo + checkpoint → recompute is
    // NOT called again (no new skipped warn). This is the stuck-until-restart state.
    testState.loggerWarn.mockClear();
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });
    expect(countSkippedWarns()).toBe(0);

    // SIMULATE the Stage 4 repair contract: the repair path explicitly invalidates
    // the skip memo for the repaired file (its fingerprint is unchanged, so this is
    // the ONLY thing that can un-stick it without a restart).
    const { clearDeterministicVectorSkip } = await import('../fileIndexService');
    clearDeterministicVectorSkip(ws, [realPath]);

    // The memo entry is gone immediately…
    expect(_getDeterministicFileVectorFailuresForTesting().get(ws)?.has(realPath)).toBe(false);

    // …and the next pass RE-ATTEMPTS the file (checkpoint was dropped too):
    // recompute runs again, proving the file is no longer suppressed. (Vectors are
    // still invalid in this unit, so it re-skips — but the re-attempt is the
    // contract: a real repair that fixed the vectors would now fill it.)
    testState.loggerWarn.mockClear();
    await lazyFillFileVectorsIfNeeded();
    expect(countSkippedWarns()).toBe(1);
  });

  it('re-attempts a deterministic-skip file after a mutation-version bump (chunk write invalidates the checkpoint)', async () => {
    // A legacy on-disk deterministically-invalid file, recorded + checkpointed.
    // Keep its content (and therefore its chunk fingerprint) FIXED for the whole
    // test so the only thing that can un-stick it is the checkpoint invalidation,
    // not a fingerprint change.
    const realBad = await seedLegacyCorruptFile(workspacePath, 'mutbump-bad.md', 'mutbump bad invalid forever', [0, 0, 0]);
    const ws = _getCurrentIndexForTesting()!.workspacePath;

    // Pass 1: attempted once (one skipped warn) → memoed + checkpointed.
    testState.loggerWarn.mockClear();
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });
    expect(_getDeterministicFileVectorFailuresForTesting().get(ws)?.has(realBad)).toBe(true);
    expect(countSkippedWarns()).toBe(1);
    const versionAfterMemo = _getMutationVersionForTesting();

    // Pass 2 (no mutation): checkpoint short-circuits → NOT re-attempted.
    testState.loggerWarn.mockClear();
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });
    expect(countSkippedWarns()).toBe(0);

    // A chunk write (indexing an UNRELATED valid file) bumps the mutation version,
    // which invalidates the lazy-fill checkpoint. The still-bad file's fingerprint
    // is unchanged, so the memo would still short-circuit it on the fingerprint
    // check — but the bumped version proves the checkpoint no longer suppresses the
    // whole pass: it re-reads the projection. (If a repair had made the vectors
    // valid, this is the pass that would now fill it.)
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([0, 1, 0])]);
    const okPath = await writeWorkspaceFile(workspacePath, 'mutbump-ok.md', 'mutbump ok valid neighbor');
    await indexFile(okPath, workspacePath);
    expect(_getMutationVersionForTesting()).toBeGreaterThan(versionAfterMemo);

    // The pass re-reads the projection (checkpoint invalidated) and fills the
    // newly-valid neighbor; the bad file stays a deterministic skip (its
    // fingerprint is unchanged), proving the version bump — not a fingerprint
    // change — drove the re-read.
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ failed: 0 });
    await refreshReadTable();
    const realOk = await fs.realpath(okPath);
    expect((await readAllFileVectors()).map((row) => row.path)).toContain(realOk);
  });

  it('keeps retrying a transient (non-deterministic) failure — it is NOT memoized', async () => {
    // A VALID embedding (so this is NOT a deterministic skip).
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([0, 1, 0])]);
    const okPath = await writeWorkspaceFile(workspacePath, 'transient.md', 'transient row');
    await indexFile(okPath, workspacePath);
    await resetFileVectorsForUpgradeSimulation(workspacePath);

    const currentIndex = _getCurrentIndexForTesting();
    const realPath = await fs.realpath(okPath);

    // The file_vectors table was dropped by the upgrade simulation, so the row is
    // genuinely MISSING (it lands in pathsToFill). Force recomputeFileVectorRow
    // down its 'failed' (persist-threw) branch by making the table create throw
    // once — a transient persist error, NOT a deterministic input failure.
    const createSpy = vi
      .spyOn(currentIndex!.connection, 'createTable')
      .mockRejectedValueOnce(new Error('transient lance createTable failure'));

    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 1 });
    // A transient failure is NOT memoized (must be retried).
    expect(
      _getDeterministicFileVectorFailuresForTesting()
        .get(_getCurrentIndexForTesting()!.workspacePath)
        ?.has(realPath)
    ).toBeFalsy();

    createSpy.mockRestore();

    // With the transient cleared, the next pass retries and succeeds — proving the
    // file was never short-circuited.
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 1, failed: 0 });
    await refreshReadTable();
    expect((await readAllFileVectors()).map((row) => row.path)).toContain(realPath);
  });

  it('surfaces file_vectors projection failures without treating the table as empty', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'projection-failure.md', 'projection failure row');
    await indexFile(filePath, workspacePath);

    const currentIndex = _getCurrentIndexForTesting();
    expect(currentIndex?.fileVectorsTable).toBeTruthy();
    const projectionError = new Error('projection failure');
    const querySpy = vi.spyOn(currentIndex!.fileVectorsTable!, 'query').mockImplementation(() => {
      throw projectionError;
    });

    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({
      filled: 0,
      skipped: 0,
      failed: 1,
    });
    expect(testState.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: projectionError, workspacePath }),
      'file_vectors.projection_failure'
    );
    expect(testState.loggerInfo.mock.calls.filter((call) => call[1] === 'file_vectors.lazy_fill_start')).toHaveLength(0);

    querySpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // FU-4 / FU-4b — proactive one-time repair of legacy on-disk NaN chunk rows.
  //
  // FU-4b (MA1) DECOUPLES the repair from the read/lazy-fill path: lazy-fill only
  // DETECTS a non-finite file and ENQUEUES its path (no inline re-embed); an
  // explicit, wall-clock-rate-limited background sweep owns the actual re-embed.
  // The unit tests drive that sweep deterministically via
  // `_runNanRepairSweepTickForTesting()` (one tick = at most one budget's worth).
  // --------------------------------------------------------------------------

  function countLog(level: 'info' | 'warn', event: string): number {
    const spy = level === 'info' ? testState.loggerInfo : testState.loggerWarn;
    return spy.mock.calls.filter((call) => call[1] === event).length;
  }

  /** Drain the decoupled repair sweep to quiescence (bounded ticks). */
  async function drainRepairSweep(maxTicks = 50): Promise<number> {
    let ticks = 0;
    for (let i = 0; i < maxTicks; i++) {
      const pending = _getNanRepairPendingForTesting();
      if (!pending || pending.size === 0) {
        return ticks;
      }
      await _runNanRepairSweepTickForTesting();
      ticks++;
    }
    return ticks;
  }

  it('detect-and-enqueue: a lazy-fill pass over a legacy NaN file ENQUEUES it (no inline re-embed); the decoupled sweep heals it', async () => {
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([1, 0, 0])]);
    const canonicalPath = await seedLegacyCorruptFile(workspacePath, 'repair-me.md', 'repair me content');
    const ws = _getCurrentIndexForTesting()!.workspacePath;

    // Sanity: the seeded chunk row is non-finite before the repair.
    const before = await readChunkRowsForPath(workspacePath, canonicalPath);
    expect(before).toHaveLength(1);
    expect(hasNonFinite(before[0].vector)).toBe(true);

    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();

    // The READ pass does NOT re-embed inline: it only enqueues the path. No
    // repair_start / repaired is logged from the read path (MA1).
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });
    expect(countLog('info', 'file_vectors.repair_start')).toBe(0);
    expect(_getNanRepairPendingForTesting()?.has(canonicalPath)).toBe(true);

    // The decoupled sweep performs the actual repair.
    await drainRepairSweep();
    expect(countLog('info', 'file_vectors.repair_start')).toBe(1);
    expect(countLog('info', 'file_vectors.repaired')).toBe(1);

    // The corrupt chunk rows were purged and replaced with finite ones.
    const after = await readChunkRowsForPath(workspacePath, canonicalPath);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((row) => !hasNonFinite(row.vector))).toBe(true);

    // A valid file_vectors row now exists; no lingering deterministic skip; queue drained.
    const rows = await readVectorsAfterRefresh();
    expect(rows.map((r) => r.path)).toContain(canonicalPath);
    expect(_getDeterministicFileVectorFailuresForTesting().get(ws)?.has(canonicalPath)).toBeFalsy();
    expect(_getNanRepairPendingForTesting()?.has(canonicalPath)).toBe(false);
  });

  it('is idempotent after a repair: re-running lazy-fill + sweep does no further work and does not loop', async () => {
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([1, 0, 0])]);
    const canonicalPath = await seedLegacyCorruptFile(workspacePath, 'idempotent-repair.md', 'idempotent repair');

    await lazyFillFileVectorsIfNeeded();
    await drainRepairSweep();
    // Quiesce the fire-and-forget neighbors-fill (+ its setTimeout(0) self-restart) before
    // measuring idempotency. Otherwise, under full-suite load, a leaked background lazy-fill pass
    // can interleave with the measured calls and return filled:1 — either via single-flight
    // promise sharing or a stale write-handle projection race — making this test flaky (it passes
    // in isolation but failed in CI and blocked a release). Mirrors the MA1 test's drain pattern.
    await _drainBackgroundFillsForTesting();
    const versionAfterRepair = _getMutationVersionForTesting();

    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();

    // Second round: the file now has a valid file_vectors row → plain existing-row
    // skip; NO enqueue, NO repair, and the mutation version is stable. Drain between/after the
    // measured calls so the fill each one spawns can't leak into the next assertion.
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });
    await _drainBackgroundFillsForTesting();
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 0, failed: 0 });
    await drainRepairSweep();
    await _drainBackgroundFillsForTesting();

    expect(countLog('info', 'file_vectors.repair_start')).toBe(0);
    expect(countLog('info', 'file_vectors.repaired')).toBe(0);
    // No NEW file_vectors write either: the repaired row already exists, so neither the measured
    // calls nor any drained background refill should re-persist it. This preserves the "no further
    // work" intent even for the reentrant background fills the drains above await (whose return
    // values would otherwise be swallowed).
    expect(countLog('info', 'file_vectors.write')).toBe(0);
    expect(_getMutationVersionForTesting()).toBe(versionAfterRepair);
    void canonicalPath;
  });

  it('repair-once: a file that STILL yields all-invalid after re-embed is repaired at most once, then converges (no loop)', async () => {
    // The embedder re-emits NaN even on re-embed, so the repair cannot heal it.
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([Number.NaN, 0, 0])]);
    const canonicalPath = await seedLegacyCorruptFile(workspacePath, 'unfixable.md', 'unfixable nan forever');
    const ws = _getCurrentIndexForTesting()!.workspacePath;

    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();

    // Detect + enqueue, then ONE sweep tick attempts a repair exactly once. The
    // embed-time guard drops the NaN chunk → the file ends with no chunk rows.
    await lazyFillFileVectorsIfNeeded();
    await _runNanRepairSweepTickForTesting();
    expect(countLog('info', 'file_vectors.repair_start')).toBe(1);
    // Recorded in the repair-once memo so it is never re-embedded again.
    expect(_getNanRepairAttemptsForTesting().get(ws)?.has(canonicalPath)).toBe(true);

    // Convergence: drain everything, then further passes + ticks do NO further
    // repair work and the mutation version stabilizes.
    await lazyFillFileVectorsIfNeeded();
    await drainRepairSweep();
    const stableVersion = _getMutationVersionForTesting();
    testState.loggerInfo.mockClear();

    await lazyFillFileVectorsIfNeeded();
    await drainRepairSweep();
    await lazyFillFileVectorsIfNeeded();
    await drainRepairSweep();

    expect(countLog('info', 'file_vectors.repair_start')).toBe(0);
    expect(_getMutationVersionForTesting()).toBe(stableVersion);
  });

  it('bounds the number of re-embeds per SWEEP TICK (a single tick repairs at most the budget)', async () => {
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([1, 0, 0])]);

    // Seed more corrupt files than the per-tick repair cap (25).
    await closeIndex();
    const count = 30;
    const canonicalPaths: string[] = [];
    for (let i = 0; i < count; i++) {
      canonicalPaths.push(
        await insertCorruptChunkRowDirectly(workspacePath, `bulk-${i}.md`, `bulk corrupt ${i}`)
      );
    }
    await initializeIndex(workspacePath);

    // A read pass enqueues ALL of them (cheap, no re-embed).
    await lazyFillFileVectorsIfNeeded();
    expect(_getNanRepairPendingForTesting()?.size).toBe(count);

    testState.loggerInfo.mockClear();
    // ONE tick repairs at most the cap (25) — never the whole backlog.
    await _runNanRepairSweepTickForTesting();
    const oneTickRepairs = countLog('info', 'file_vectors.repaired');
    expect(oneTickRepairs).toBeLessThanOrEqual(25);
    expect(oneTickRepairs).toBeGreaterThan(0);
    expect(_getNanRepairPendingForTesting()!.size).toBe(count - oneTickRepairs);

    // Further ticks drain the rest; ALL files heal — converging without a loop.
    await drainRepairSweep();
    const rows = await readVectorsAfterRefresh();
    const healed = new Set(rows.map((r) => r.path));
    for (const p of canonicalPaths) {
      expect(healed.has(p)).toBe(true);
    }
    expect(_getNanRepairPendingForTesting()!.size).toBe(0);
  });

  it('never touches a file whose chunks are all valid (no enqueue / no repair on a clean file)', async () => {
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([1, 0, 0])]);
    const cleanPath = await writeWorkspaceFile(workspacePath, 'clean.md', 'clean valid content');
    await indexFile(cleanPath, workspacePath);
    await resetFileVectorsForUpgradeSimulation(workspacePath);

    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();

    // The file is missing its file_vectors row (upgrade sim dropped the table) but
    // its chunks are valid → it lazy-fills normally with NO enqueue / repair path.
    await expect(lazyFillFileVectorsIfNeeded()).resolves.toMatchObject({ filled: 1, failed: 0 });
    expect(_getNanRepairPendingForTesting()?.size ?? 0).toBe(0);
    expect(countLog('info', 'file_vectors.repair_start')).toBe(0);
    expect(countLog('info', 'file_vectors.repaired')).toBe(0);

    const ws = _getCurrentIndexForTesting()!.workspacePath;
    const realPath = await fs.realpath(cleanPath);
    expect(_getNanRepairAttemptsForTesting().get(ws)?.has(realPath)).toBeFalsy();
  });

  // --------------------------------------------------------------------------
  // FU-4b MA1 — the neighbors-orchestration cannot bypass the repair bound.
  // --------------------------------------------------------------------------
  it('MA1: a background neighbors fill with many corrupt targets cannot exceed the per-tick budget before an explicit scheduled tick', async () => {
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([1, 0, 0])]);

    await closeIndex();
    // Seed a non-empty neighbors target set: a handful of VALID indexed files so
    // file_vectors has rows and the neighbors fill has targets to iterate. Then a
    // large backlog of corrupt files that, pre-FU-4b, the reentrant neighbors loop
    // could have drained back-to-back (the bypass bug).
    const validPaths: string[] = [];
    for (let i = 0; i < 3; i++) {
      validPaths.push(await writeWorkspaceFile(workspacePath, `valid-${i}.md`, `valid neighbor ${i}`));
    }
    const corruptCount = 30;
    for (let i = 0; i < corruptCount; i++) {
      await insertCorruptChunkRowDirectly(workspacePath, `corrupt-${i}.md`, `corrupt target ${i}`);
    }
    await initializeIndex(workspacePath);
    for (const p of validPaths) {
      await indexFile(p, workspacePath);
    }

    testState.loggerInfo.mockClear();

    // Drive the FULL idle background orchestration: a read triggers lazy-fill,
    // which kicks the fire-and-forget neighbors fill; that fill reenters
    // findSimilarFilesByVector → prepareFileVectorsRead → lazyFillFileVectorsIfNeeded
    // for EACH of its many targets. Drain all of it to quiescence.
    await readAllFileVectors();
    await _drainBackgroundFillsForTesting();

    // MA1: NO repair re-embed happened on the read/neighbors path at all — the
    // reentrant lazy-fill calls could only ENQUEUE. The budget is un-bypassable
    // because the sweep (the only re-embed site) has not ticked yet.
    expect(countLog('info', 'file_vectors.repaired')).toBe(0);
    expect(countLog('info', 'file_vectors.repair_start')).toBe(0);
    expect(_getNanRepairPendingForTesting()!.size).toBe(corruptCount);

    // The explicit scheduled tick is what bounds the re-embeds: a single tick does
    // at most the budget, no matter how many neighbors targets reentered above.
    await _runNanRepairSweepTickForTesting();
    const tickRepairs = countLog('info', 'file_vectors.repaired');
    expect(tickRepairs).toBeGreaterThan(0);
    expect(tickRepairs).toBeLessThanOrEqual(25);
  });

  // --------------------------------------------------------------------------
  // FU-4b MA2 — a post-purge re-add failure is RECOVERABLE, never lost.
  // --------------------------------------------------------------------------
  it('MA2: table.add throwing AFTER the delete leaves the file recoverable / re-enqueued, not silently lost', async () => {
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([1, 0, 0])]);
    const canonicalPath = await seedLegacyCorruptFile(workspacePath, 'fault-inject.md', 'fault injection content');

    // Enqueue via a read pass.
    await lazyFillFileVectorsIfNeeded();
    expect(_getNanRepairPendingForTesting()?.has(canonicalPath)).toBe(true);

    // Fault-inject: the re-index's table.add() throws AFTER removeFileFromIndex
    // deleted the corrupt rows (transient IO/FD pressure). The file is now
    // chunk-less but its source is intact on disk.
    const index = _getCurrentIndexForTesting()!;
    const addSpy = vi
      .spyOn(index.table!, 'add')
      .mockRejectedValueOnce(new Error('transient lance add failure after purge'));

    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();
    await _runNanRepairSweepTickForTesting();
    addSpy.mockRestore();

    // The repair was observed as a failure, NOT as convergence: the file is still
    // queued for retry (MA2 — recoverable, never lost).
    expect(countLog('warn', 'file_vectors.repair_failed')).toBeGreaterThanOrEqual(1);
    expect(_getNanRepairPendingForTesting()?.has(canonicalPath)).toBe(true);
    // And it is NOT recorded as a deterministic skip (which would converge it).
    const ws = index.workspacePath;
    expect(_getDeterministicFileVectorFailuresForTesting().get(ws)?.has(canonicalPath)).toBeFalsy();

    // With the fault cleared, the next tick recovers the file: it heals from disk.
    await drainRepairSweep();
    const rows = await readVectorsAfterRefresh();
    expect(rows.map((r) => r.path)).toContain(canonicalPath);
    expect(_getNanRepairPendingForTesting()?.has(canonicalPath)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // FU-4b MA3 — at-most-once survives a guarded re-index that leaves fresh-but-
  // still-invalid rows with a NEW fingerprint (indexedAt / mutation-version bump).
  // --------------------------------------------------------------------------
  it('MA3: a file is not re-repaired even after the repair re-index changes its indexedAt / fingerprint (persistently-NaN backend)', async () => {
    // The backend re-emits NaN on EVERY embed, so each repair re-index writes a new
    // fingerprint but never heals. The PRE-repair-fingerprint-only memo would miss
    // on the new fingerprint and re-repair forever; recording the POST fingerprint
    // closes that (MA3).
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([Number.NaN, 0, 0])]);

    // Seed a file whose post-re-embed rows are NOT all-dropped: a mixed file would
    // keep one valid chunk, but we want the "fresh-but-still-invalid rows persist"
    // shape. The embed guard drops all-NaN, so to force fresh-invalid-rows-with-a-
    // new-fingerprint we keep the file all-NaN and assert the at-most-once memo
    // holds across repeated detect/sweep cycles + an explicit mutation bump.
    const canonicalPath = await seedLegacyCorruptFile(workspacePath, 'persist-nan.md', 'persistently nan content');
    const ws = _getCurrentIndexForTesting()!.workspacePath;

    testState.loggerInfo.mockClear();

    // Cycle 1: detect → tick → repair attempted exactly once.
    await lazyFillFileVectorsIfNeeded();
    await drainRepairSweep();
    expect(countLog('info', 'file_vectors.repair_start')).toBe(1);
    const memoAfter = _getNanRepairAttemptsForTesting().get(ws)?.get(canonicalPath);
    // The memo recorded the identity (pre and, if rows remained, post fingerprint).
    expect((memoAfter?.size ?? 0)).toBeGreaterThanOrEqual(1);

    testState.loggerInfo.mockClear();

    // Force the projection to be re-read on subsequent passes and run many cycles.
    // Even though each (attempted) re-index bumps indexedAt, the file must NOT be
    // re-repaired — the at-most-once gate matches on either recorded fingerprint.
    for (let i = 0; i < 4; i++) {
      await lazyFillFileVectorsIfNeeded();
      await drainRepairSweep();
    }
    expect(countLog('info', 'file_vectors.repair_start')).toBe(0);
  });

  it('MA3: convergence — once a corrupt backlog is drained, the mutation version is stable across further passes (no re-churn loop)', async () => {
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([1, 0, 0])]);
    await closeIndex();
    const canonicalPaths: string[] = [];
    for (let i = 0; i < 8; i++) {
      canonicalPaths.push(await insertCorruptChunkRowDirectly(workspacePath, `drain-${i}.md`, `drain corrupt ${i}`));
    }
    await initializeIndex(workspacePath);

    // Drain fully (read → enqueue → sweep → heal), repeatedly until quiescent.
    for (let i = 0; i < 10; i++) {
      await lazyFillFileVectorsIfNeeded();
      await drainRepairSweep();
    }
    const rows = await readVectorsAfterRefresh();
    const healed = new Set(rows.map((r) => r.path));
    for (const p of canonicalPaths) {
      expect(healed.has(p)).toBe(true);
    }

    // Now stable: further passes + ticks do zero work and the mutation version
    // does not move (so the neighbors mutation-gated self-restart can't fire).
    const stableVersion = _getMutationVersionForTesting();
    await lazyFillFileVectorsIfNeeded();
    await drainRepairSweep();
    await lazyFillFileVectorsIfNeeded();
    await drainRepairSweep();
    expect(_getMutationVersionForTesting()).toBe(stableVersion);
    expect(_getNanRepairPendingForTesting()?.size ?? 0).toBe(0);
  });

  // --------------------------------------------------------------------------
  // FU-4c — bounded retry + quarantine for a PERSISTENTLY-failing repair.
  // A file whose repair re-index fails `failed_after_purge` on EVERY tick must not
  // be re-embedded forever (≤25/tick) — the throttled-but-perpetual loop. After a
  // small cap the sweep quarantines it: drops it from the queue, emits one ERROR,
  // and arms no further sweep work.
  // --------------------------------------------------------------------------
  it('FU-4c: a persistently failing (failed_after_purge every tick) repair is retried a bounded number of times, then quarantined — the sweep goes quiet', async () => {
    const MAX_ATTEMPTS = 3; // mirrors FILE_VECTOR_NAN_REPAIR_MAX_ATTEMPTS
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([1, 0, 0])]);
    const canonicalPath = await seedLegacyCorruptFile(workspacePath, 'poisoned.md', 'poisoned path content');
    const ws = _getCurrentIndexForTesting()!.workspacePath;

    // Enqueue via a read pass.
    await lazyFillFileVectorsIfNeeded();
    expect(_getNanRepairPendingForTesting()?.has(canonicalPath)).toBe(true);

    // Fault-inject PERMANENTLY: the re-index's table.add() throws AFTER the purge on
    // EVERY tick (e.g. disk full / poisoned path / deterministic add failure).
    const index = _getCurrentIndexForTesting()!;
    const addSpy = vi
      .spyOn(index.table!, 'add')
      .mockRejectedValue(new Error('persistent lance add failure after purge'));

    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();
    testState.loggerError.mockClear();

    // Run MANY more ticks than the cap. Each of the first MAX_ATTEMPTS ticks
    // attempts the repair (one repair_start each); after the cap the path is
    // quarantined and later ticks find an empty queue and do nothing.
    for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
      await _runNanRepairSweepTickForTesting();
    }
    addSpy.mockRestore();

    // repair_start is CAPPED at the retry limit — NOT emitted every tick forever.
    expect(countLog('info', 'file_vectors.repair_start')).toBe(MAX_ATTEMPTS);

    // The path was QUARANTINED: dropped from the automatic queue so the sweep can
    // go quiet, and a single observable ERROR fired with context.
    expect(_getNanRepairPendingForTesting()?.has(canonicalPath)).toBe(false);
    expect(_getNanRepairPendingForTesting()?.size ?? 0).toBe(0);
    const quarantineLogs = testState.loggerError.mock.calls.filter(
      (c) => c[1] === 'file_vectors.repair_quarantined'
    );
    expect(quarantineLogs).toHaveLength(1);
    expect(quarantineLogs[0][0]).toMatchObject({
      path: canonicalPath,
      failureKind: 'failed_after_purge',
      attempts: MAX_ATTEMPTS,
    });

    // The failure record marks it quarantined (separate from deterministic skip).
    expect(_getNanRepairFailuresForTesting().get(ws)?.get(canonicalPath)?.quarantined).toBe(true);

    // NO further scheduled sweep work remains: the production scheduler entry point
    // does NOT arm a timer (the queue is empty), so the sweep is truly quiet.
    expect(_scheduleAndCheckNanRepairSweepForTesting(ws)).toBe(false);

    // And a fresh lazy-fill pass does NOT re-enqueue the quarantined path (it would
    // otherwise re-arm the loop). After failed_after_purge the chunks are purged, so
    // it also leaves the projection — assert the queue stays empty regardless.
    await lazyFillFileVectorsIfNeeded();
    expect(_getNanRepairPendingForTesting()?.size ?? 0).toBe(0);
  });

  it('FU-4c: a persistently failing failed_BEFORE_purge repair (corrupt rows survive) is quarantined and NOT re-enqueued by later lazy-fill passes', async () => {
    const MAX_ATTEMPTS = 3;
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([1, 0, 0])]);
    const canonicalPath = await seedLegacyCorruptFile(workspacePath, 'before-purge.md', 'before purge content');
    const ws = _getCurrentIndexForTesting()!.workspacePath;

    await lazyFillFileVectorsIfNeeded();
    expect(_getNanRepairPendingForTesting()?.has(canonicalPath)).toBe(true);

    // Force a pre-purge failure on EVERY tick: the re-index's readFile throws before
    // any delete, so the CORRUPT chunk rows survive (the path stays in the chunk
    // projection — the case where a naive quarantine could be re-enqueued forever).
    const realReadFile = fs.readFile.bind(fs);
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(((...args: unknown[]) => {
      const target = String(args[0]);
      if (target === canonicalPath) {
        return Promise.reject(new Error('persistent read failure before purge'));
      }
      return (realReadFile as unknown as (...a: unknown[]) => unknown)(...args) as Promise<string>;
    }) as typeof fs.readFile);

    testState.loggerInfo.mockClear();
    testState.loggerError.mockClear();

    for (let i = 0; i < MAX_ATTEMPTS + 5; i++) {
      await _runNanRepairSweepTickForTesting();
    }
    readSpy.mockRestore();

    // Quarantined after the cap; queue drained.
    expect(_getNanRepairPendingForTesting()?.has(canonicalPath)).toBe(false);
    const quarantineLogs = testState.loggerError.mock.calls.filter(
      (c) => c[1] === 'file_vectors.repair_quarantined'
    );
    expect(quarantineLogs).toHaveLength(1);
    expect(quarantineLogs[0][0]).toMatchObject({ failureKind: 'failed_before_purge', attempts: MAX_ATTEMPTS });

    // The corrupt rows SURVIVED (pre-purge failure), so the path is still in the
    // chunk projection. A fresh lazy-fill pass must NOT re-enqueue it (quarantine
    // guard) — otherwise the perpetual loop is re-armed.
    expect(_getNanRepairFailuresForTesting().get(ws)?.get(canonicalPath)?.quarantined).toBe(true);
    await lazyFillFileVectorsIfNeeded();
    expect(_getNanRepairPendingForTesting()?.has(canonicalPath)).toBe(false);
    expect(_scheduleAndCheckNanRepairSweepForTesting(ws)).toBe(false);
  });

  it('FU-4c: clearDeterministicVectorSkip re-opens a quarantined (before-purge) path for recovery', async () => {
    const MAX_ATTEMPTS = 3;
    testState.generateEmbeddings.mockResolvedValue([Float32Array.from([1, 0, 0])]);
    const canonicalPath = await seedLegacyCorruptFile(workspacePath, 'recoverable.md', 'recoverable content');
    const ws = _getCurrentIndexForTesting()!.workspacePath;

    await lazyFillFileVectorsIfNeeded();

    // Quarantine via a persistent PRE-purge failure so the corrupt chunk rows
    // SURVIVE (the file stays in the chunk projection — required so that, once the
    // quarantine is cleared, a fresh lazy-fill can re-detect + re-enqueue it). A
    // post-purge loss can only be recovered by an explicit re-index of the source.
    const realReadFile = fs.readFile.bind(fs);
    let failReads = true;
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(((...args: unknown[]) => {
      const target = String(args[0]);
      if (failReads && target === canonicalPath) {
        return Promise.reject(new Error('persistent read failure before purge'));
      }
      return (realReadFile as unknown as (...a: unknown[]) => unknown)(...args) as Promise<string>;
    }) as typeof fs.readFile);
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      await _runNanRepairSweepTickForTesting();
    }
    expect(_getNanRepairFailuresForTesting().get(ws)?.get(canonicalPath)?.quarantined).toBe(true);

    // Manual / user-triggered recovery: clearing the skip ALSO clears the
    // quarantine + failure record (and the pending/repair memos).
    const { clearDeterministicVectorSkip } = await import('../fileIndexService');
    clearDeterministicVectorSkip(ws, [canonicalPath]);
    expect(_getNanRepairFailuresForTesting().get(ws)?.has(canonicalPath)).toBeFalsy();

    // With the fault gone and the quarantine cleared, the file heals on a fresh
    // detect → enqueue → sweep cycle (the corrupt rows are still in the projection).
    failReads = false;
    await lazyFillFileVectorsIfNeeded();
    await drainRepairSweep();
    readSpy.mockRestore();
    const rows = await readVectorsAfterRefresh();
    expect(rows.map((r) => r.path)).toContain(canonicalPath);
  });
});
