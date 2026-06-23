import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('toolIndexService refresh serialization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serializes refreshToolIndexFromCatalogData with refreshToolIndex', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-index-serializer-'));
    const toolData = {
      tools: [
        {
          package_id: 'stub-catalog',
          package_name: 'Stub Catalog',
          tool_id: 'stub__tool',
          name: 'Stub Tool',
          description: 'Stub tool description',
        },
      ],
      etag: 'stub-etag',
      package_hashes: { 'stub-catalog': 'stub-hash' },
    };

    const indexColumns: Array<{ columns: string[] }> = [];
    const table = {
      listIndices: vi.fn(async () => indexColumns),
      createIndex: vi.fn(async () => {
        indexColumns.push({ columns: ['search_text'] });
      }),
      add: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      optimize: vi.fn(async () => undefined),
    };
    const connection = {
      tableNames: vi.fn(async () => [] as string[]),
      openTable: vi.fn(async () => table),
      createTable: vi.fn(async () => table),
      dropTable: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const lancedbMock = {
      connect: vi.fn(async () => connection),
      Index: {
        fts: vi.fn(() => ({ kind: 'fts' })),
      },
    };

    let activeEmbeddingCalls = 0;
    let maxConcurrentEmbeddingCalls = 0;
    const generateEmbeddingsMock = vi.fn(async (texts: string[]) => {
      activeEmbeddingCalls += 1;
      maxConcurrentEmbeddingCalls = Math.max(maxConcurrentEmbeddingCalls, activeEmbeddingCalls);
      await new Promise(resolve => setTimeout(resolve, 30));
      activeEmbeddingCalls -= 1;
      return texts.map(() => Float32Array.from([0.1, 0.2]));
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/tools/config-hash')) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        } as Response;
      }
      if (url.endsWith('/api/tools/manifest')) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        } as Response;
      }
      if (url.endsWith('/api/tools')) {
        return {
          ok: true,
          status: 200,
          json: async () => toolData,
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    vi.doMock('node:module', () => ({
      createRequire: () => ((moduleName: string) => {
        if (moduleName === '@lancedb/lancedb') {
          return lancedbMock;
        }
        throw new Error(`Unexpected native module require: ${moduleName}`);
      }),
    }));
    vi.doMock('@core/logger', () => ({
      createScopedLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
      }),
    }));
    vi.doMock('@core/utils/dataPaths', () => ({
      getDataPath: () => userDataDir,
      isPackaged: () => false,
    }));
    vi.doMock('@core/platform', () => ({
      getPlatformConfig: () => ({ version: 'test-version' }),
    }));
    vi.doMock('@core/embeddingGenerator', () => ({
      getEmbeddingGenerator: () => ({
        generateEmbeddings: generateEmbeddingsMock,
        generateQueryEmbedding: vi.fn(async () => Float32Array.from([0.1, 0.2])),
      }),
    }));
    vi.doMock('@shared/utils/mcpInstanceUtils', () => ({
      parseMultiInstanceServer: () => ({ isInstance: false, baseName: null }),
    }));
    vi.doMock('@core/services/superMcpHttpManager', () => ({
      superMcpHttpManager: {
        getState: () => ({
          isRunning: true,
          url: 'https://super-mcp.example/mcp',
        }),
      },
    }));
    vi.doMock('@core/utils/emfileRetry', () => ({
      isTooManyOpenFilesError: () => false,
    }));
    vi.doMock('@core/utils/enfileState', () => ({
      isEnfileActive: () => false,
      markEnfileDetected: vi.fn(() => ({ isFirstDetection: false })),
    }));
    vi.doMock('@core/services/toolAliasCache', () => ({
      updateAliases: vi.fn(),
      clearAliases: vi.fn(),
    }));
    vi.doMock('@core/services/toolDescriptionCache', () => ({
      replaceDescriptions: vi.fn(),
    }));

    const toolIndexService = await import('./toolIndexService');

    const [catalogRefresh, fullRefresh] = await Promise.all([
      toolIndexService.refreshToolIndexFromCatalogData(toolData, {
        packageHashes: new Map(Object.entries(toolData.package_hashes)),
        updateAliasesFromCatalog: true,
        etag: toolData.etag,
      }),
      toolIndexService.refreshToolIndex(),
    ]);

    expect(catalogRefresh.success).toBe(true);
    expect(fullRefresh.success).toBe(true);
    expect(generateEmbeddingsMock).toHaveBeenCalledTimes(1);
    expect(maxConcurrentEmbeddingCalls).toBe(1);

    await toolIndexService.closeToolIndex();
  });
});
