import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<
  string,
  (event: unknown, request?: unknown) => Promise<unknown>
>();

const semanticSearchWithStatusMock = vi.hoisted(() => vi.fn());
const isFileIndexReadyMock = vi.hoisted(() => vi.fn(() => true));
const getScanCompletedAtMock = vi.hoisted(() => vi.fn(() => Date.now()));
const isEmbeddingServiceReadyMock = vi.hoisted(() => vi.fn(() => true));
const hasPluginPermissionMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('../../utils/registerHandler', () => ({
  registerHandler: vi.fn(
    (channel: string, handler: (event: unknown, request?: unknown) => Promise<unknown>) => {
      registeredHandlers.set(channel, handler);
    },
  ),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => ({ coreDirectory: '/tmp/workspace' }),
}));

vi.mock('../../../services/fileIndexService', () => ({
  semanticSearch: vi.fn(),
  semanticSearchWithStatus: semanticSearchWithStatusMock,
  isFileIndexReady: isFileIndexReadyMock,
  getScanCompletedAt: getScanCompletedAtMock,
}));

vi.mock('../../../services/embeddingService', () => ({
  isEmbeddingServiceReady: isEmbeddingServiceReadyMock,
}));

vi.mock('../shared', () => ({
  hasPluginPermission: hasPluginPermissionMock,
  normalizeRelativePath: (value: string) => value.replace(/\\/g, '/'),
  isTopicRelativePath: vi.fn(() => true),
  isSkillRelativePath: vi.fn(() => true),
  isPathWithin: vi.fn(() => true),
  resolveConfiguredPluginSpacePaths: vi.fn(async () => ['Personal']),
  listMarkdownFilesRecursively: vi.fn(async () => []),
  extractTopicTitle: vi.fn(() => 'Topic'),
  stripFrontmatter: vi.fn((value: string) => value),
  buildTopicListCacheKey: vi.fn(() => 'cache-key'),
  getTopicListFromCache: vi.fn(() => null),
  setTopicListCache: vi.fn(),
  normalizeConfiguredSpacePath: vi.fn((value: string) => value),
  TOPICS_SUBPATH_PREFIX: 'memory/topics/',
  SKILLS_SUBPATH: 'skills',
  SKILLS_SUBPATH_PREFIX: 'skills/',
}));

import { registerPluginMemoryHandlers } from '../pluginMemoryHandlers';

describe('pluginMemoryHandlers plugins:memory-search', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    semanticSearchWithStatusMock.mockReset();
    isFileIndexReadyMock.mockReset();
    isFileIndexReadyMock.mockReturnValue(true);
    getScanCompletedAtMock.mockReset();
    getScanCompletedAtMock.mockReturnValue(Date.now());
    isEmbeddingServiceReadyMock.mockReset();
    isEmbeddingServiceReadyMock.mockReturnValue(true);
    hasPluginPermissionMock.mockReset();
    hasPluginPermissionMock.mockResolvedValue(true);
    registerPluginMemoryHandlers();
  });

  it('maps a post-preflight semantic-search runtime error to status error', async () => {
    semanticSearchWithStatusMock.mockResolvedValue({
      status: 'error',
      results: [],
      message: 'semantic search failed',
    });

    const handler = registeredHandlers.get('plugins:memory-search');
    const result = await handler?.({}, {
      pluginId: 'plugin-1',
      query: 'roadmap',
      limit: 5,
    });

    expect(semanticSearchWithStatusMock).toHaveBeenCalledWith('roadmap', { limit: 5, lexicalExemption: true });
    expect(result).toEqual({
      status: 'error',
      results: [],
      message: 'semantic search failed',
    });
  });

  it('maps a post-preflight embedding_unavailable status to embedding_not_ready', async () => {
    semanticSearchWithStatusMock.mockResolvedValue({
      status: 'embedding_unavailable',
      results: [],
    });

    const handler = registeredHandlers.get('plugins:memory-search');
    const result = await handler?.({}, {
      pluginId: 'plugin-1',
      query: 'roadmap',
      limit: 5,
    });

    expect(semanticSearchWithStatusMock).toHaveBeenCalledWith('roadmap', { limit: 5, lexicalExemption: true });
    expect(result).toEqual({
      status: 'embedding_not_ready',
      results: [],
    });
  });

  it('passes through a post-preflight index_not_ready status', async () => {
    semanticSearchWithStatusMock.mockResolvedValue({
      status: 'index_not_ready',
      results: [],
    });

    const handler = registeredHandlers.get('plugins:memory-search');
    const result = await handler?.({}, {
      pluginId: 'plugin-1',
      query: 'roadmap',
      limit: 5,
    });

    expect(semanticSearchWithStatusMock).toHaveBeenCalledWith('roadmap', { limit: 5, lexicalExemption: true });
    expect(result).toEqual({
      status: 'index_not_ready',
      results: [],
    });
  });
});
