import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registeredHandlers, mockReadFileNeighbors, mockLogger } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, request: unknown) => unknown>(),
  mockReadFileNeighbors: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('@core/logger', () => ({
  logger: mockLogger,
  createScopedLogger: vi.fn(() => mockLogger),
  createTurnSessionLogger: vi.fn(() => mockLogger),
}));

vi.mock('../../services/behindTheScenesClient', () => ({
  callBehindTheScenes: vi.fn(),
}));

vi.mock('../../services/fileIndexService', () => ({
  semanticSearch: vi.fn(),
  clearIndex: vi.fn(),
  readFileNeighbors: (...args: unknown[]) => mockReadFileNeighbors(...args),
}));

vi.mock('../../services/toolIndexService', () => ({
  searchTools: vi.fn(),
}));

vi.mock('../../services/fileWatcherService', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  pauseWatching: vi.fn(),
  reindexWorkspace: vi.fn(),
  getWatcherStatus: vi.fn(),
  isWatching: vi.fn(),
  getWatchedWorkspace: vi.fn(() => '/workspace'),
}));

vi.mock('../../services/enhancementService', () => ({
  pauseEnhancement: vi.fn(),
  resumeEnhancement: vi.fn(),
  startEnhancement: vi.fn(),
}));

vi.mock('../../services/conversationIndexService', () => ({
  searchConversations: vi.fn(),
  getConversationIndexStatus: vi.fn(),
  findSimilarConversations: vi.fn(),
}));

vi.mock('../../services/costLedgerService', () => ({
  getCategorizedCostSummary: vi.fn(),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(() => ({ coreDirectory: '/workspace' })),
  settingsStore: {},
}));

vi.mock('../../services/atlasService', () => ({
  getAtlasProjection: vi.fn(),
  getAtlasNeighbors: vi.fn(),
  getAtlasQueryEmbedding: vi.fn(),
}));

vi.mock('../../services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({
    getSessionIds: vi.fn(() => []),
    getSession: vi.fn(async () => null),
  })),
}));

import {
  _resetAtlasNeighborhoodGenerationForTesting,
  bumpAtlasNeighborhoodGeneration,
  registerSearchHandlers,
} from '../searchHandlers';
import {
  ATLAS_NEIGHBORHOOD_RESPONSE_SCHEMA,
  type AtlasNeighborhoodRequest,
  type AtlasNeighborhoodResponse,
} from '@shared/ipc/channels/search';

type AtlasNeighborhoodHandler = (
  event: unknown,
  request: AtlasNeighborhoodRequest
) => Promise<AtlasNeighborhoodResponse | null>;

function getAtlasNeighborhoodHandler(): AtlasNeighborhoodHandler {
  const handler = registeredHandlers.get('search:atlas-neighborhood');
  expect(handler).toBeDefined();
  return handler as AtlasNeighborhoodHandler;
}

function makePaths(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `/workspace/source-${index}.md`);
}

function makeNeighborRows(paths: string[]): Record<string, Array<{ path: string; score: number }>> {
  return Object.fromEntries(paths.map((sourcePath, index) => [
    sourcePath,
    [{ path: `/workspace/neighbor-${index}.md`, score: 0.9 - index * 0.01 }],
  ]));
}

describe('search:atlas-neighborhood handler', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
    _resetAtlasNeighborhoodGenerationForTesting();
    registerSearchHandlers();
  });

  it('returns a neighbor map for all requested paths on the happy path', async () => {
    const paths = makePaths(5);
    mockReadFileNeighbors.mockResolvedValueOnce(makeNeighborRows(paths));

    const result = await getAtlasNeighborhoodHandler()({}, { paths, limit: 5, generation: 1 });

    expect(mockReadFileNeighbors).toHaveBeenCalledWith(paths);
    expect(result?.generation).toBe(1);
    expect(Object.keys(result?.neighbors ?? {})).toHaveLength(5);
    expect(result?.neighborsCoverage).toEqual({ requested: 5, covered: 5, missing: 0 });
    expect(result?.neighbors[paths[0]][0]).toEqual({
      path: '/workspace/neighbor-0.md',
      relativePath: 'neighbor-0.md',
      score: 0.9,
    });
  });

  it('reports partial coverage when only some paths have materialized rows', async () => {
    const paths = makePaths(5);
    mockReadFileNeighbors.mockResolvedValueOnce(makeNeighborRows(paths.slice(0, 3)));

    const result = await getAtlasNeighborhoodHandler()({}, { paths, limit: 5, generation: 2 });

    expect(Object.keys(result?.neighbors ?? {})).toHaveLength(3);
    expect(result?.neighborsCoverage).toEqual({ requested: 5, covered: 3, missing: 2 });
  });

  it('returns null for an older request when a newer one wins the generation', async () => {
    const paths = makePaths(2);
    let resolveFirst: (value: Record<string, Array<{ path: string; score: number }>>) => void = () => {};
    const firstRead = new Promise<Record<string, Array<{ path: string; score: number }>>>((resolve) => {
      resolveFirst = resolve;
    });
    mockReadFileNeighbors
      .mockReturnValueOnce(firstRead)
      .mockResolvedValueOnce(makeNeighborRows(paths));

    const older = getAtlasNeighborhoodHandler()({}, { paths, limit: 5, generation: 1 });
    const latest = getAtlasNeighborhoodHandler()({}, { paths, limit: 5, generation: 2 });

    await expect(latest).resolves.toMatchObject({ generation: 2 });
    resolveFirst(makeNeighborRows(paths));
    await expect(older).resolves.toBeNull();
  });

  it('returns null when a workspace switch bumps generation mid-request', async () => {
    const paths = makePaths(1);
    let resolveRead: (value: Record<string, Array<{ path: string; score: number }>>) => void = () => {};
    mockReadFileNeighbors.mockReturnValueOnce(new Promise((resolve) => {
      resolveRead = resolve;
    }));

    const pending = getAtlasNeighborhoodHandler()({}, { paths, limit: 5, generation: 3 });
    bumpAtlasNeighborhoodGeneration();
    resolveRead(makeNeighborRows(paths));

    await expect(pending).resolves.toBeNull();
  });

  it('accepts stale-generation null responses in the IPC contract', () => {
    expect(ATLAS_NEIGHBORHOOD_RESPONSE_SCHEMA.parse(null)).toBeNull();
  });
});
