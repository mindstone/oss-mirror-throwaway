import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  findSimilarFiles: vi.fn(),
  getFileEmbeddings: vi.fn(),
  generateQueryEmbedding: vi.fn(),
  scanSpaces: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
}));

// atlasService production code does fs.existsSync(workerPath) before instantiating
// the Worker (atlasService.ts:652 inside getWorkerPath, then again at :824 inside
// computeProjection). Mocking worker_threads alone is not enough — the existence
// check fires first and short-circuits with an "Atlas worker not found" throw on
// any environment that has not run `npm run build:worker`.
//
// We mock node:fs.existsSync to report the worker artifact as present (regardless
// of which fallback path getWorkerPath decides on) and delegate every other path
// to the real fs so the rest of atlasService — and any incidentally-imported
// module — keeps real disk semantics.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const existsSync: typeof actual.existsSync = (p) => {
    if (typeof p === 'string' && p.endsWith('atlasWorker.js')) return true;
    return actual.existsSync(p);
  };
  return {
    ...actual,
    default: { ...actual, existsSync },
    existsSync,
  };
});

vi.mock('worker_threads', () => {
  class MockWorker {
    private readonly listeners = new Map<string, Array<(payload: unknown) => void>>();

    on(event: string, listener: (payload: unknown) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    postMessage(message: { type?: string; id?: string; filePaths?: string[] }): void {
      if (message.type !== 'project') return;
      const filePaths = message.filePaths ?? [];
      queueMicrotask(() => {
        this.emit('message', {
          type: 'result',
          id: message.id,
          projected: filePaths.map((filePath, index) => ({
            path: filePath,
            x: index,
            y: index + 1,
            z: index + 2,
          })),
        });
      });
    }

    terminate = vi.fn();

    private emit(event: string, payload: unknown): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(payload);
      }
    }
  }

  return { Worker: MockWorker };
});

vi.mock('@core/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: testState.loggerInfo,
    warn: vi.fn(),
    error: testState.loggerError,
  },
}));

vi.mock('@core/utils/dataPaths', () => ({
  isPackaged: vi.fn(() => false),
  getAppRoot: vi.fn(() => '/test/app-root'),
}));

vi.mock('../embeddingService', () => ({
  generateQueryEmbedding: testState.generateQueryEmbedding,
}));

vi.mock('../fileIndexService', () => ({
  findSimilarFiles: testState.findSimilarFiles,
  getFileEmbeddings: testState.getFileEmbeddings,
}));

vi.mock('../shutdownState', () => ({
  isShuttingDown: vi.fn(() => false),
}));

vi.mock('../spaceService', () => ({
  scanSpaces: testState.scanSpaces,
}));

describe('atlasService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.generateQueryEmbedding.mockResolvedValue([1, 0, 0]);
    testState.scanSpaces.mockResolvedValue([]);
  });

  it('returns projection embeddings while leaving neighbors undefined after Stage 5', async () => {
    testState.getFileEmbeddings.mockResolvedValueOnce([
      {
        path: '/workspace/a.md',
        relativePath: 'a.md',
        vector: [1, 0, 0],
        chunkCount: 2,
        mtime: 100,
      },
      {
        path: '/workspace/b.md',
        relativePath: 'b.md',
        vector: [0, 1, 0],
        chunkCount: 1,
        mtime: 200,
      },
    ]);

    const {
      clearAtlasCache,
      clearTopicEmbeddingsCache,
      getAtlasProjection,
      setAtlasWorkspace,
    } = await import('../atlasService');

    clearAtlasCache();
    clearTopicEmbeddingsCache();
    setAtlasWorkspace('/workspace');

    const result = await getAtlasProjection(true, true);

    expect(testState.getFileEmbeddings).toHaveBeenCalledOnce();
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((node) => node.embedding)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(result.nodes.every((node) => node.neighbors === undefined)).toBe(true);
  });

  it('delegates getAtlasNeighbors to findSimilarFiles and preserves the legacy score shape', async () => {
    testState.findSimilarFiles.mockResolvedValueOnce([
      { path: '/workspace/a.md', relativePath: 'a.md', score: 0.92 },
      { path: '/workspace/b.md', relativePath: 'b.md', score: 0.81 },
    ]);

    const { getAtlasNeighbors } = await import('../atlasService');
    const results = await getAtlasNeighbors('/workspace/source.md', 2);

    expect(testState.findSimilarFiles).toHaveBeenCalledWith('/workspace/source.md', 2);
    expect(results).toEqual([
      { path: '/workspace/a.md', relativePath: 'a.md', score: 0.92 },
      { path: '/workspace/b.md', relativePath: 'b.md', score: 0.81 },
    ]);
    expect(Object.keys(results[0]).sort()).toEqual(['path', 'relativePath', 'score']);
  });

  it('drops projection results when the workspace switches after clustering starts', async () => {
    testState.getFileEmbeddings.mockResolvedValueOnce([
      {
        path: '/workspace-a/a.md',
        relativePath: 'a.md',
        vector: [1, 0, 0],
        chunkCount: 2,
        mtime: 100,
      },
      {
        path: '/workspace-a/b.md',
        relativePath: 'b.md',
        vector: [0, 1, 0],
        chunkCount: 1,
        mtime: 200,
      },
    ]);

    const {
      clearAtlasCache,
      clearTopicEmbeddingsCache,
      getAtlasProjection,
      setAtlasWorkspace,
    } = await import('../atlasService');

    testState.scanSpaces.mockImplementationOnce(async () => {
      setAtlasWorkspace('/workspace-b');
      return [];
    });

    clearAtlasCache();
    clearTopicEmbeddingsCache();
    setAtlasWorkspace('/workspace-a');

    const result = await getAtlasProjection(true, true);

    expect(result).toMatchObject({
      nodes: [],
      clusters: [],
      count: 0,
      totalFileCount: 0,
      cached: false,
    });
    expect(testState.loggerInfo).toHaveBeenCalledWith(
      { workspacePathAtStart: '/workspace-a', currentWorkspacePath: '/workspace-b' },
      'projection.workspace_switch_drop',
    );
  });
});
