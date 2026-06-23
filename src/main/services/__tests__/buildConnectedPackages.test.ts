import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectedPackage } from '../promptTemplateService';

// Mock node:fs module
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  default: {
    promises: {
      readFile: mockReadFile,
    },
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  promises: {
    readFile: mockReadFile,
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
    readdir: vi.fn(() => []),
  },
}));

// Mock node:fs/promises module
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: mockReadFile,
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
    readdir: vi.fn(() => []),
  },
  readFile: mockReadFile,
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
  readdir: vi.fn(() => []),
}));

// Mock getSettings to return a config path
const mockGetSettings = vi.hoisted(() => vi.fn());
const mockFindCatalogEntry = vi.hoisted(() => vi.fn(() => null));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: mockGetSettings,
}));

// Mock toolUsageStore to avoid electron-store initialization issues
vi.mock('../toolUsageStore', () => ({
  getFrequentTools: vi.fn(() => []),
  recordToolUsage: vi.fn(),
  getFrequentToolsWithCounts: vi.fn(() => []),
}));

// Mock connectorCatalogService for descriptions
vi.mock('../connectorCatalogService', () => ({
  getServerDescription: vi.fn((name: string) => `${name} integration`),
  getServerDescriptionWithEmail: vi.fn(
    (name: string, opts?: { catalogId?: string; email?: string; workspace?: string; serverDescription?: string }) => {
      if (opts?.serverDescription) return opts.serverDescription;
      if (opts?.email) return `${name} (${opts.email})`;
      if (opts?.workspace) return `${name} for ${opts.workspace}`;
      return `${name} integration`;
    }
  ),
  findCatalogEntry: mockFindCatalogEntry,
}));

// Mock superMcpHttpManager (not used in new implementation but may be imported)
vi.mock('../superMcpHttpManager', () => ({
  superMcpHttpManager: {
    getState: vi.fn(() => ({ isRunning: false, url: null })),
    reconfigure: vi.fn(),
  },
}));

vi.mock('@core/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
  createScopedLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
  createTurnSessionLogger: vi.fn(),
  logAtLevel: vi.fn(),
  runWithTurnContext: vi.fn(),
  getTurnContext: vi.fn(),
  getLogDirectory: vi.fn(() => '/tmp/test-logs'),
  getLogFilePath: vi.fn(() => '/tmp/test-logs/mindstone-rebel.log'),
  cleanupSessionLogs: vi.fn(),
  getRecentLogs: vi.fn(() => []),
  clearLogBuffer: vi.fn(),
}));

// Import after mocks are set up
import { buildConnectedPackages, invalidateConnectedPackagesCache } from '../mcpService';

describe('buildConnectedPackages', () => {
  const configPath = '/test/config/mcp.json';

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindCatalogEntry.mockReset();
    mockFindCatalogEntry.mockReturnValue(null);
    // Invalidate cache before each test to ensure clean state
    invalidateConnectedPackagesCache();
    // Default settings with config path
    mockGetSettings.mockReturnValue({
      mcpConfigFile: configPath,
      coreDirectory: '/test',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('when no config path is set', () => {
    it('returns empty array when mcpConfigFile is not set', async () => {
      mockGetSettings.mockReturnValue({
        mcpConfigFile: undefined,
        coreDirectory: '/test',
      });

      const result = await buildConnectedPackages();
      expect(result).toEqual([]);
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('returns empty array when mcpConfigFile is empty string', async () => {
      mockGetSettings.mockReturnValue({
        mcpConfigFile: '  ',
        coreDirectory: '/test',
      });

      const result = await buildConnectedPackages();
      expect(result).toEqual([]);
    });
  });

  describe('when config file cannot be read', () => {
    it('returns empty array when config file does not exist', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

      const result = await buildConnectedPackages();
      expect(result).toEqual([]);
    });

    it('returns empty array when config file contains invalid JSON', async () => {
      mockReadFile.mockResolvedValue('{ invalid json }');

      const result = await buildConnectedPackages();
      expect(result).toEqual([]);
    });
  });

  describe('when config file is valid', () => {
    it('handles mcpServers shape (camelCase)', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            Slack: { command: 'node', args: ['slack.js'] },
            GitHub: { command: 'node', args: ['github.js'] },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.name)).toEqual(['GitHub', 'Slack']); // Sorted alphabetically
    });

    it('handles mcp_servers shape (snake_case)', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcp_servers: {
            Notion: { command: 'node', args: ['notion.js'] },
            Asana: { command: 'node', args: ['asana.js'] },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.name)).toEqual(['Asana', 'Notion']); // Sorted alphabetically
    });

    it('handles servers shape', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          servers: {
            Linear: { command: 'node', args: ['linear.js'] },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Linear');
    });

    it('handles top-level object with server entries (no wrapper)', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          Figma: { command: 'node', args: ['figma.js'] },
          Miro: { type: 'http', url: 'http://localhost:3000' },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.name)).toEqual(['Figma', 'Miro']);
    });

    it('returns packages sorted alphabetically by name', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            Zebra: { command: 'node', args: ['zebra.js'] },
            Apple: { command: 'node', args: ['apple.js'] },
            Mango: { command: 'node', args: ['mango.js'] },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result.map((p) => p.name)).toEqual(['Apple', 'Mango', 'Zebra']);
    });

    it('maps packages to ConnectedPackage format with descriptions', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            Slack: { command: 'node', args: ['slack.js'] },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'Slack',
        description: expect.any(String),
      } satisfies Partial<ConnectedPackage>);
      expect(result[0].description.length).toBeGreaterThan(0);
    });

    it('uses serverDescription from config if provided', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            CustomMcp: {
              command: 'node',
              args: ['custom.js'],
              description: 'My custom MCP server',
            },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(1);
      expect(result[0].description).toBe('My custom MCP server');
    });

    it('uses email in description for multi-account servers', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            Gmail: {
              command: 'node',
              args: ['gmail.js'],
              email: 'user@example.com',
            },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(1);
      expect(result[0].description).toContain('user@example.com');
    });
  });

  describe('disabled servers filtering', () => {
    it('filters out servers listed in disabledServers array', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            Slack: { command: 'node', args: ['slack.js'] },
            GitHub: { command: 'node', args: ['github.js'] },
            Notion: { command: 'node', args: ['notion.js'] },
          },
          disabledServers: ['GitHub'],
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.name)).toEqual(['Notion', 'Slack']);
      expect(result.find((p) => p.name === 'GitHub')).toBeUndefined();
    });

    it('handles multiple disabled servers', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            Slack: { command: 'node', args: ['slack.js'] },
            GitHub: { command: 'node', args: ['github.js'] },
            Notion: { command: 'node', args: ['notion.js'] },
            Linear: { command: 'node', args: ['linear.js'] },
          },
          disabledServers: ['GitHub', 'Linear'],
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.name)).toEqual(['Notion', 'Slack']);
    });

    it('handles empty disabledServers array', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            Slack: { command: 'node', args: ['slack.js'] },
          },
          disabledServers: [],
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Slack');
    });

    it('handles missing disabledServers (undefined)', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            Slack: { command: 'node', args: ['slack.js'] },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Slack');
    });
  });

  describe('caching behavior', () => {
    it('caches result and skips re-read on second call', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            GitHub: { command: 'node', args: ['github.js'] },
          },
        })
      );

      // First call - should read config
      const result1 = await buildConnectedPackages();
      expect(result1).toHaveLength(1);
      expect(result1[0].name).toBe('GitHub');
      expect(mockReadFile).toHaveBeenCalledTimes(1);

      // Second call - should return cached result without reading config again
      const result2 = await buildConnectedPackages();
      expect(result2).toEqual(result1);
      expect(mockReadFile).toHaveBeenCalledTimes(1); // Still only 1 call
    });

    it('fetches fresh data after cache invalidation', async () => {
      // First call with initial data
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          mcpServers: {
            GitHub: { command: 'node', args: ['github.js'] },
          },
        })
      );
      const result1 = await buildConnectedPackages();
      expect(result1).toHaveLength(1);
      expect(result1[0].name).toBe('GitHub');
      expect(mockReadFile).toHaveBeenCalledTimes(1);

      // Invalidate cache (simulating config change)
      invalidateConnectedPackagesCache();

      // Second call with different data
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          mcpServers: {
            Slack: { command: 'node', args: ['slack.js'] },
            Notion: { command: 'node', args: ['notion.js'] },
          },
        })
      );
      const result2 = await buildConnectedPackages();
      expect(result2).toHaveLength(2);
      expect(result2.map((p) => p.name)).toEqual(['Notion', 'Slack']); // Sorted
      expect(mockReadFile).toHaveBeenCalledTimes(2); // Fresh read
    });

    it('maintains consistent ordering for cache stability', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            Zebra: { command: 'node', args: ['zebra.js'] },
            Apple: { command: 'node', args: ['apple.js'] },
            Mango: { command: 'node', args: ['mango.js'] },
          },
        })
      );

      // Run multiple times
      const results = await Promise.all([
        buildConnectedPackages(),
        buildConnectedPackages(),
        buildConnectedPackages(),
      ]);

      // All results should be identical (same cached reference)
      const firstResult = results[0].map((p) => p.name);
      expect(results[1].map((p) => p.name)).toEqual(firstResult);
      expect(results[2].map((p) => p.name)).toEqual(firstResult);

      // And they should be sorted
      expect(firstResult).toEqual(['Apple', 'Mango', 'Zebra']);
    });

    it('deduplicates concurrent calls with same in-flight promise', async () => {
      // Use a slower mock to simulate concurrent reads
      let resolvePromise: (value: string) => void;
      const slowPromise = new Promise<string>((resolve) => {
        resolvePromise = resolve;
      });
      mockReadFile.mockReturnValue(slowPromise);

      // Start multiple concurrent calls
      const promise1 = buildConnectedPackages();
      const promise2 = buildConnectedPackages();
      const promise3 = buildConnectedPackages();

      // Resolve the file read
      resolvePromise!(
        JSON.stringify({
          mcpServers: {
            Slack: { command: 'node', args: ['slack.js'] },
          },
        })
      );

      const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3]);

      // All should return the same result
      expect(result1).toEqual(result2);
      expect(result2).toEqual(result3);

      // File should only be read once
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('edge cases', () => {
    it('returns empty array when config has empty mcpServers', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {},
        })
      );

      const result = await buildConnectedPackages();
      expect(result).toEqual([]);
    });

    it('returns empty array when config is an empty object', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({}));

      const result = await buildConnectedPackages();
      expect(result).toEqual([]);
    });

    it('handles HTTP server entries', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            RemoteApi: {
              type: 'http',
              url: 'https://api.example.com/mcp',
            },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('RemoteApi');
    });

    it('handles SSE server entries', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            SseServer: {
              type: 'sse',
              url: 'https://stream.example.com/events',
            },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('SseServer');
    });
  });

  describe('capabilities enrichment', () => {
    it('includes capabilities when catalog entry provides them', async () => {
      (mockFindCatalogEntry as any).mockImplementation((name: string) => {
        if (name === 'Perplexity') {
          return {
            capabilities: [{ id: 'web-search', promptGuidance: 'Use perplexity_search for web search' }],
          } as never;
        }
        return null;
      });

      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            Perplexity: { command: 'node', args: ['perplexity.js'], catalogId: 'perplexity' },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'Perplexity',
        capabilities: [{ id: 'web-search', promptGuidance: 'Use perplexity_search for web search' }],
      } satisfies Partial<ConnectedPackage>);
    });

    it('sets capabilities to empty array when no catalog entry is found', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            CustomSearch: { command: 'node', args: ['custom-search.js'] },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'CustomSearch',
        capabilities: [],
      } satisfies Partial<ConnectedPackage>);
    });

    it('sets capabilities to empty array when catalog entry has no capabilities field', async () => {
      (mockFindCatalogEntry as any).mockImplementation((name: string) => {
        if (name === 'InternalKnowledge') {
          return {
            id: 'internal-knowledge',
            name: 'Internal Knowledge',
          } as never;
        }
        return null;
      });

      mockReadFile.mockResolvedValue(
        JSON.stringify({
          mcpServers: {
            InternalKnowledge: { command: 'node', args: ['internal-knowledge.js'] },
          },
        })
      );

      const result = await buildConnectedPackages();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'InternalKnowledge',
        capabilities: [],
      } satisfies Partial<ConnectedPackage>);
    });
  });
});
