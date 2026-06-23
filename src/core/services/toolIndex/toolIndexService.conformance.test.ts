import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUPER_MCP_REST_ENDPOINTS,
  SUPER_MCP_TOOL_INDEX_QUERY_PARAMS,
  SuperMcpToolConfigHashResponseSchema,
  SuperMcpToolManifestResponseSchema,
} from '@core/rebelCore/superMcpContract';

const superMcpState = vi.hoisted(() => ({
  isRunning: true,
  url: 'https://super-mcp.example/mcp',
}));

describe('toolIndexService Super-MCP REST conformance', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    superMcpState.isRunning = true;
    superMcpState.url = 'https://super-mcp.example/mcp';

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
      getDataPath: () => '/tmp/rebel-tool-index-test',
      isPackaged: () => false,
    }));
    vi.doMock('@core/platform', () => ({
      getPlatformConfig: () => ({ version: 'test-version' }),
    }));
    vi.doMock('@core/embeddingGenerator', () => ({
      getEmbeddingGenerator: () => ({
        generateEmbeddings: vi.fn(),
        generateQueryEmbedding: vi.fn(),
      }),
    }));
    vi.doMock('@shared/utils/mcpInstanceUtils', () => ({
      parseMultiInstanceServer: () => ({ isInstance: false, baseName: null }),
    }));
    vi.doMock('@core/services/superMcpHttpManager', () => ({
      superMcpHttpManager: {
        getState: () => superMcpState,
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips /api/tools/config-hash through the consumer fetcher and contract schema', async () => {
    const responseBody = {
      config_hash: 'config-hash',
      security_hash: 'user-admin',
      package_ids: ['google-workspace'],
      package_count: 1,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchConfigHashFromSuperMcp } = await import('./toolIndexService');
    const result = await fetchConfigHashFromSuperMcp();

    expect(result).toEqual(responseBody);
    expect(SuperMcpToolConfigHashResponseSchema.safeParse(result).success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://super-mcp.example${SUPER_MCP_REST_ENDPOINTS.TOOLS_CONFIG_HASH}`,
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('round-trips /api/tools/manifest through the consumer fetcher and contract schema', async () => {
    const responseBody = {
      packages: [{
        package_id: 'google-workspace',
        package_name: 'Google Workspace',
        tool_count: 4,
        embedding_hash: 'package-hash',
        status: 'loaded',
      }],
      security_hash: 'user-admin',
      package_count: 1,
      generated_at: '2026-05-31T00:00:00.000Z',
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchManifestFromSuperMcp } = await import('./toolIndexService');
    const result = await fetchManifestFromSuperMcp();

    expect(result).toEqual(responseBody);
    expect(SuperMcpToolManifestResponseSchema.safeParse(result).success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://super-mcp.example${SUPER_MCP_REST_ENDPOINTS.TOOLS_MANIFEST}`,
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('keeps selected-package tool fetch represented as /api/tools plus packages query parameter', () => {
    const source = readFileSync('src/core/services/toolIndex/toolIndexService.ts', 'utf8');
    expect(SUPER_MCP_REST_ENDPOINTS.TOOLS_SELECTED_PACKAGES).toBe('/api/tools?packages=');
    expect(SUPER_MCP_TOOL_INDEX_QUERY_PARAMS.PACKAGES).toBe('packages');
    expect(`${SUPER_MCP_REST_ENDPOINTS.TOOLS}?${SUPER_MCP_TOOL_INDEX_QUERY_PARAMS.PACKAGES}=google-workspace`)
      .toBe('/api/tools?packages=google-workspace');
    expect(source).toContain('params.set(SUPER_MCP_TOOL_INDEX_QUERY_PARAMS.PACKAGES, packageIds.join(\',\'))');
    expect(source).toContain('state.url.replace(\'/mcp\', SUPER_MCP_REST_ENDPOINTS.TOOLS)');
  });
});
