import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from '../../utils/lancedbPredicates';

const testState = vi.hoisted(() => ({
  userDataPath: '/tmp/file-vectors-reconcile-userdata-initial',
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
  _drainBackgroundFillsForTesting,
  _getCurrentIndexForTesting,
  closeIndex,
  indexFile,
  reconcileFileVectorsIfNeeded,
} from '../fileIndexService';

type DirectFileVectorRow = {
  path: string;
  vector: number[] | Float32Array;
  source_max_enhanced_at: number;
  computed_at: number;
};

function chunkIdFor(filePath: string, chunkIndex: number): string {
  return crypto.createHash('sha256').update(`${filePath}:${chunkIndex}`).digest('hex').slice(0, 32);
}

async function writeWorkspaceFile(workspacePath: string, relativePath: string, content: string): Promise<string> {
  const filePath = path.join(workspacePath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
}

function toNumberVector(vector: number[] | Float32Array): number[] {
  return Array.isArray(vector) ? vector : Array.from(vector);
}

async function readDirectFileVectorRows(): Promise<DirectFileVectorRow[]> {
  const currentIndex = _getCurrentIndexForTesting();
  if (!currentIndex?.fileVectorsTable) {
    return [];
  }
  return (await currentIndex.fileVectorsTable.query().toArray()) as DirectFileVectorRow[];
}

async function mutateChunkOnly(canonicalPath: string, vector: number[], enhancedAt: number): Promise<void> {
  const currentIndex = _getCurrentIndexForTesting();
  if (!currentIndex?.table) {
    throw new Error('Expected chunks table');
  }
  await currentIndex.table.update({
    where: eq('id', chunkIdFor(canonicalPath, 0)),
    values: {
      vector,
      is_enhanced: 1,
      enhanced_at: enhancedAt,
    },
  });
}

async function deleteChunksOnly(canonicalPath: string): Promise<void> {
  const currentIndex = _getCurrentIndexForTesting();
  if (!currentIndex?.table) {
    throw new Error('Expected chunks table');
  }
  await currentIndex.table.delete(eq('path', canonicalPath));
}

async function deleteFileVectorOnly(canonicalPath: string): Promise<void> {
  const currentIndex = _getCurrentIndexForTesting();
  if (!currentIndex?.fileVectorsTable) {
    throw new Error('Expected file_vectors table');
  }
  await currentIndex.fileVectorsTable.delete(eq('path', canonicalPath));
}

describe('fileIndexService file_vectors reconcile', () => {
  let workspacePath: string;

  beforeEach(async () => {
    testState.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'file-vectors-reconcile-userdata-'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'file-vectors-reconcile-workspace-'));
    testState.generateEmbeddings.mockReset();
    testState.generateEmbeddings.mockImplementation(async (texts) =>
      texts.map(() => Float32Array.from([1, 0, 0]))
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
    const currentIndex = _getCurrentIndexForTesting();
    if (currentIndex && currentIndex.workspacePath !== workspacePath) {
      currentIndex.workspacePath = workspacePath;
    }
    await closeIndex();
    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.rm(testState.userDataPath, { recursive: true, force: true });
  });

  it('recomputes an existing file_vectors row when its fingerprint mismatches chunks', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'mismatch.md', 'mismatch row');
    await indexFile(filePath, workspacePath);
    const canonicalPath = await fs.realpath(filePath);
    const [beforeRow] = await readDirectFileVectorRows();
    const enhancedAt = Date.now() + 10_000;
    await mutateChunkOnly(canonicalPath, [0, 1, 0], enhancedAt);
    testState.loggerInfo.mockClear();

    await expect(reconcileFileVectorsIfNeeded()).resolves.toMatchObject({
      recomputed: 1,
      deleted: 0,
      skipped: 0,
    });

    const [afterRow] = await readDirectFileVectorRows();
    expect(afterRow.path).toBe(canonicalPath);
    expect(toNumberVector(afterRow.vector)[1]).toBeCloseTo(1);
    expect(afterRow.source_max_enhanced_at).toBe(enhancedAt);
    expect(afterRow.computed_at).toBeGreaterThanOrEqual(beforeRow.computed_at);
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ recomputed: 1, deleted: 0, skipped: 0 }),
      'file_vectors.reconcile_complete'
    );
  });

  it('deletes file_vectors rows whose path no longer exists in chunks', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'orphan.md', 'orphan row');
    await indexFile(filePath, workspacePath);
    const canonicalPath = await fs.realpath(filePath);
    await deleteChunksOnly(canonicalPath);

    await expect(reconcileFileVectorsIfNeeded()).resolves.toMatchObject({
      recomputed: 0,
      deleted: 1,
      skipped: 0,
    });

    expect(await readDirectFileVectorRows()).toEqual([]);
  });

  it('skips missing file_vectors rows without recomputing them', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'missing.md', 'missing row');
    await indexFile(filePath, workspacePath);
    const canonicalPath = await fs.realpath(filePath);
    // `indexFile` queues a fire-and-forget file_neighbors fill that transitively
    // re-creates missing file_vectors rows (neighbors fill → findSimilarFiles →
    // prepareFileVectorsRead → lazyFillFileVectorsIfNeeded). Drain it before the
    // out-of-band delete below, or under CPU load that background writer can land
    // after the delete and resurrect the row we expect to stay gone.
    await _drainBackgroundFillsForTesting();
    await deleteFileVectorOnly(canonicalPath);
    testState.loggerInfo.mockClear();

    await expect(reconcileFileVectorsIfNeeded()).resolves.toMatchObject({
      recomputed: 0,
      deleted: 0,
      skipped: 1,
    });

    expect(await readDirectFileVectorRows()).toEqual([]);
    expect(testState.loggerInfo.mock.calls.filter((call) => call[1] === 'file_vectors.write')).toHaveLength(0);
  });

  it('is a no-op when file_vectors fingerprints match chunks', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'consistent.md', 'consistent row');
    await indexFile(filePath, workspacePath);
    // Drain indexFile's fire-and-forget neighbors→vectors fill before clearing the
    // logger spy, so it cannot log a stray file_vectors.write after mockClear under
    // load (same race as "skips missing file_vectors rows", kept latent here).
    await _drainBackgroundFillsForTesting();
    testState.loggerInfo.mockClear();

    await expect(reconcileFileVectorsIfNeeded()).resolves.toMatchObject({
      recomputed: 0,
      deleted: 0,
      skipped: 0,
    });

    expect((await readDirectFileVectorRows()).map((row) => row.path)).toEqual([await fs.realpath(filePath)]);
    expect(testState.loggerInfo.mock.calls.filter((call) => call[1] === 'file_vectors.write')).toHaveLength(0);
  });

  it('is idempotent on re-run after repairing a mismatch', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'idempotent.md', 'idempotent row');
    await indexFile(filePath, workspacePath);
    const canonicalPath = await fs.realpath(filePath);
    await mutateChunkOnly(canonicalPath, [0, 1, 0], Date.now() + 10_000);

    await expect(reconcileFileVectorsIfNeeded()).resolves.toMatchObject({ recomputed: 1, deleted: 0, skipped: 0 });
    await expect(reconcileFileVectorsIfNeeded()).resolves.toMatchObject({ recomputed: 0, deleted: 0, skipped: 0 });
  });

  it('single-flights concurrent reconcile calls per workspace', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'single-flight.md', 'single flight row');
    await indexFile(filePath, workspacePath);
    const canonicalPath = await fs.realpath(filePath);
    await mutateChunkOnly(canonicalPath, [0, 1, 0], Date.now() + 10_000);

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
    testState.loggerInfo.mockClear();

    const firstReconcile = reconcileFileVectorsIfNeeded();
    await projectionStarted;
    const secondReconcile = reconcileFileVectorsIfNeeded();
    releaseProjection();

    const [firstResult, secondResult] = await Promise.all([firstReconcile, secondReconcile]);
    expect(firstResult).toMatchObject({ recomputed: 1, deleted: 0, skipped: 0 });
    expect(secondResult).toMatchObject({ recomputed: 1, deleted: 0, skipped: 0 });
    expect(testState.loggerInfo.mock.calls.filter((call) => call[1] === 'file_vectors.reconcile_start')).toHaveLength(1);
  });

  it('aborts without writing when the workspace switches during reconcile projection', async () => {
    const filePath = await writeWorkspaceFile(workspacePath, 'workspace-switch.md', 'workspace switch row');
    await indexFile(filePath, workspacePath);
    // Drain indexFile's fire-and-forget background fill before mutating/clearing, so
    // it cannot log a stray file_vectors.write after the mockClear below (same race
    // as "skips missing file_vectors rows"; here mutateChunkOnly would even let the
    // fill recompute, so the drain is load-bearing for the write-count assertion).
    await _drainBackgroundFillsForTesting();
    const canonicalPath = await fs.realpath(filePath);
    await mutateChunkOnly(canonicalPath, [0, 1, 0], Date.now() + 10_000);

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
    testState.loggerInfo.mockClear();

    const reconcilePromise = reconcileFileVectorsIfNeeded();
    await projectionStarted;
    currentIndex!.workspacePath = `${workspacePath}-switched`;
    releaseProjection();

    await expect(reconcilePromise).resolves.toMatchObject({ recomputed: 0, deleted: 0, skipped: 0 });
    currentIndex!.workspacePath = workspacePath;
    const [row] = await readDirectFileVectorRows();
    expect(toNumberVector(row.vector)[0]).toBeCloseTo(1);
    expect(row.source_max_enhanced_at).toBe(0);
    expect(testState.loggerInfo.mock.calls.filter((call) => call[1] === 'file_vectors.write')).toHaveLength(0);
  });
});
