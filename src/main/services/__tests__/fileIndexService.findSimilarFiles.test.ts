import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cosineDistance } from '@core/utils/vectorMath';

const testState = vi.hoisted(() => ({
  userDataPath: '/tmp/find-similar-files-userdata-initial',
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
  FILE_VECTORS_TABLE_NAME,
  _getCurrentIndexForTesting,
  closeIndex,
  findSimilarFiles,
  findSimilarFilesByVector,
  indexFile,
  initializeIndex,
  refreshReadTable,
} from '../fileIndexService';

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

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

describe('fileIndexService findSimilarFiles', () => {
  let workspacePath: string;
  let canonicalWorkspacePath: string;
  const vectorsByRelativePath = new Map<string, number[]>();

  async function writeIndexedFile(relativePath: string, vector: number[]): Promise<string> {
    vectorsByRelativePath.set(relativePath, vector);
    const filePath = await writeWorkspaceFile(workspacePath, relativePath, `content for ${relativePath}`);
    await indexFile(filePath, workspacePath);
    return fs.realpath(filePath);
  }

  async function resetFileVectorsForUpgradeSimulation(): Promise<void> {
    await closeIndex();
    await dropTableDirectly(workspacePath, FILE_VECTORS_TABLE_NAME);
    await initializeIndex(workspacePath);
    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();
  }

  beforeEach(async () => {
    testState.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'find-similar-files-userdata-'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'find-similar-files-workspace-'));
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

  it('excludes the source path from findSimilarFiles results', async () => {
    const sourcePath = await writeIndexedFile('source.md', [1, 0]);
    await writeIndexedFile('neighbor.md', [0.9, 0.1]);
    await refreshReadTable();

    const results = await findSimilarFiles(sourcePath, 5);

    expect(results).toHaveLength(1);
    expect(results.map((result) => result.path)).not.toContain(sourcePath);
    expect(results[0].relativePath).toBe('neighbor.md');
  });

  it('returns [] when the workspace has no chunks or file_vectors table', async () => {
    await initializeIndex(workspacePath);

    await expect(findSimilarFiles(path.join(workspacePath, 'missing.md'), 5)).resolves.toEqual([]);
    await expect(findSimilarFilesByVector([1, 0], 5)).resolves.toEqual([]);
  });

  it('returns [] when the query path has no file_vectors row', async () => {
    await writeIndexedFile('indexed.md', [1, 0]);
    await refreshReadTable();

    await expect(findSimilarFiles(path.join(workspacePath, 'absent.md'), 5)).resolves.toEqual([]);
  });

  it('matches brute-force top-5 recall for the Stage 0 regression seed', async () => {
    const random = createSeededRandom(2491684);
    const fixtures: Array<{ path: string; vector: number[] }> = [];
    for (let i = 0; i < 50; i++) {
      const vector = normalize(Array.from({ length: 16 }, () => random() * 2 - 1));
      const filePath = await writeIndexedFile(`file-${i.toString().padStart(2, '0')}.md`, vector);
      fixtures.push({ path: filePath, vector });
    }
    await refreshReadTable();

    let overlap = 0;
    const queryCount = 20;
    for (let i = 0; i < queryCount; i++) {
      const sourceIndex = Math.floor(random() * fixtures.length);
      const source = fixtures[sourceIndex];
      const expected = fixtures
        .filter((fixture) => fixture.path !== source.path)
        .map((fixture) => ({
          path: fixture.path,
          score: 1 - cosineDistance(source.vector, fixture.vector),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((fixture) => fixture.path);

      const actual = (await findSimilarFiles(source.path, 5)).map((result) => result.path);
      overlap += actual.filter((resultPath) => expected.includes(resultPath)).length / 5;
    }

    expect(overlap / queryCount).toBeGreaterThanOrEqual(0.95);
  });

  it('returns [] when the workspace switches during source-vector lookup', async () => {
    const sourcePath = await writeIndexedFile('switch-source.md', [1, 0]);
    await writeIndexedFile('switch-neighbor.md', [0.9, 0.1]);
    await refreshReadTable();

    // Warmup: trigger any lazy fill / read-table refresh that prepareFileVectorsRead
    // would otherwise perform on first call. Without this, lazyFillFileVectorsIfNeeded
    // may swap currentIndex.fileVectorsReadTable to a new handle mid-call, leaving the
    // spy below attached to a stale readTable instance — causing the intercept to never
    // fire under CI load.
    await findSimilarFiles(sourcePath, 5);
    await refreshReadTable();

    const currentIndex = _getCurrentIndexForTesting();
    const readHandle = currentIndex!.fileVectorsReadTable!;
    const readTable = readHandle.acquire();
    try {
      const originalQuery = readTable.query.bind(readTable);
      let releaseLookup: (() => void) | null = null;
      let lookupStartedResolve!: () => void;
      const lookupStarted = new Promise<void>((resolve) => {
        lookupStartedResolve = resolve;
      });
      // Persistent spy keyed on the source-vector predicate, so unrelated
      // concurrent queries on the same readTable (background indexer, parallel
      // tests in the same worker) don't consume the interception before our call.
      vi.spyOn(readTable, 'query').mockImplementation(() => {
        const query = originalQuery();
        return {
          where: (predicate: string) => {
            const filtered = query.where(predicate);
            const isSourceLookup =
              releaseLookup === null && predicate.includes(sourcePath);
            return {
              limit: (limit: number) => {
                const limited = filtered.limit(limit);
                if (!isSourceLookup) {
                  return limited;
                }
                return {
                  toArray: async () => {
                    const waitForRelease = new Promise<void>((innerResolve) => {
                      releaseLookup = innerResolve;
                    });
                    lookupStartedResolve();
                    await waitForRelease;
                    return limited.toArray();
                  },
                };
              },
            };
          },
        } as unknown as ReturnType<typeof readTable.query>;
      });

      const staleLookupPromise = findSimilarFiles(sourcePath, 5);
      await lookupStarted;

      currentIndex!.workspacePath = `${workspacePath}-switched`;
      releaseLookup!();

      await expect(staleLookupPromise).resolves.toEqual([]);
    } finally {
      await readHandle.release();
    }
  });

  it('returns scores in [0, 1] ranked descending', async () => {
    const sourcePath = await writeIndexedFile('score-source.md', [1, 0]);
    await writeIndexedFile('score-close.md', [0.8, 0.6]);
    await writeIndexedFile('score-orthogonal.md', [0, 1]);
    await writeIndexedFile('score-opposite.md', [-1, 0]);
    await refreshReadTable();

    const results = await findSimilarFilesByVector([1, 0], 3, { excludePath: sourcePath });

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('excludes excludePath in findSimilarFilesByVector results', async () => {
    const sourcePath = await writeIndexedFile('by-vector-source.md', [1, 0]);
    await writeIndexedFile('by-vector-neighbor.md', [0.95, 0.05]);
    await refreshReadTable();

    const results = await findSimilarFilesByVector([1, 0], 5, { excludePath: sourcePath });

    expect(results.map((result) => result.path)).not.toContain(sourcePath);
    expect(results[0].relativePath).toBe('by-vector-neighbor.md');
  });

  it('allows the source path in findSimilarFilesByVector results when excludePath is omitted', async () => {
    const sourcePath = await writeIndexedFile('by-vector-no-exclude-source.md', [1, 0]);
    await writeIndexedFile('by-vector-no-exclude-neighbor.md', [0.95, 0.05]);
    await refreshReadTable();

    const results = await findSimilarFilesByVector([1, 0], 5);

    expect(results[0].path).toBe(sourcePath);
  });

  it('lazy-fills missing file_vectors before finding similar files', async () => {
    const sourcePath = await writeIndexedFile('lazy-source.md', [1, 0]);
    await writeIndexedFile('lazy-neighbor.md', [0.95, 0.05]);
    await resetFileVectorsForUpgradeSimulation();

    const results = await findSimilarFiles(sourcePath, 1);

    expect(results).toMatchObject([{ relativePath: 'lazy-neighbor.md' }]);
    expect(testState.loggerInfo.mock.calls.filter((call) => call[1] === 'file_vectors.write')).toHaveLength(2);
  });
});
