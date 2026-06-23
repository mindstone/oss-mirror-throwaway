/**
 * Stage 8 (260619_cloud-symlink-indexing) — `search:spaces-with-index`, the
 * per-space "has a prior index" probe that drives the SpaceCard reconnecting
 * banner's State A ("showing your last-known files") vs State B ("this space is
 * empty for now"). The load-bearing property: State B is REACHABLE only when we can
 * PROVE a degraded space has no prior indexed entries; otherwise we fail toward A
 * (never claim emptiness we can't prove). Real `isWithinRoot` containment is used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registeredHandlers, mockGetIndexedPaths, mockHasIndex, mockLogger } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, request: unknown) => unknown>(),
  mockGetIndexedPaths: vi.fn<() => string[]>(),
  mockHasIndex: vi.fn<() => boolean>(),
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

// NOTE: `isWithinRoot` is intentionally NOT mocked — we want the real separator-safe
// containment to back the probe (a sibling like `/a/bc` must not count as inside `/a/b`).
vi.mock('../../services/fileIndexService', () => ({
  semanticSearch: vi.fn(),
  clearIndex: vi.fn(),
  readFileNeighbors: vi.fn(),
  getIndexedPaths: (...args: unknown[]) => mockGetIndexedPaths(...(args as [])),
  hasIndex: (...args: unknown[]) => mockHasIndex(...(args as [])),
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
  getWatchedWorkspace: vi.fn(),
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
  EMPTY_CATEGORIZED_COST_SUMMARY: {},
}));

vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(),
  settingsStore: {},
}));

vi.mock('@core/rebelCore/settingsAccessors', () => ({
  getApiKey: vi.fn(),
}));

vi.mock('../../services/atlasService', () => ({
  getAtlasProjection: vi.fn(),
  getAtlasNeighbors: vi.fn(),
  getAtlasQueryEmbedding: vi.fn(),
}));

vi.mock('../../services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(),
}));

vi.mock('@shared/utils/mcpAppFallbackText', () => ({
  buildMcpAppAwareMessageText: vi.fn(),
}));

import { registerSearchHandlers } from '../searchHandlers';

type ProbeResponse = { ready: boolean; pathsWithIndex: string[] };

function getProbeHandler(): (
  event: unknown,
  request: { spacePaths: string[] },
) => Promise<ProbeResponse> {
  registeredHandlers.clear();
  registerSearchHandlers();
  const handler = registeredHandlers.get('search:spaces-with-index');
  expect(handler).toBeDefined();
  return handler as (event: unknown, request: { spacePaths: string[] }) => Promise<ProbeResponse>;
}

// Absolute paths (the helper requires absolute args). POSIX-style; on Windows CI the
// real isWithinRoot still works because these are normalised the same way.
const SPACE_WITH_FILES = '/workspace/work/Mindstone/Company Memories';
const SPACE_EMPTY = '/workspace/work/Acme/Empty Space';
const SIBLING_DECOY = '/workspace/work/Mindstone/Company Memories Archive'; // must NOT match SPACE_WITH_FILES

describe('search:spaces-with-index — State A vs B reachability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a degraded space WITH indexed entries as having a prior index (drives State A)', async () => {
    mockHasIndex.mockReturnValue(true);
    mockGetIndexedPaths.mockReturnValue([
      `${SPACE_WITH_FILES}/README.md`,
      `${SPACE_WITH_FILES}/notes/strategy.md`,
    ]);
    const handler = getProbeHandler();
    const res = await handler(null, { spacePaths: [SPACE_WITH_FILES, SPACE_EMPTY] });
    expect(res.ready).toBe(true);
    expect(res.pathsWithIndex).toContain(SPACE_WITH_FILES);
    // SPACE_EMPTY has no entries beneath it ⇒ State B is reachable for it.
    expect(res.pathsWithIndex).not.toContain(SPACE_EMPTY);
  });

  it('STATE B IS REACHABLE: a hydrated index with no entries under a space ⇒ not in pathsWithIndex', async () => {
    mockHasIndex.mockReturnValue(true);
    mockGetIndexedPaths.mockReturnValue([`${SPACE_WITH_FILES}/README.md`]);
    const handler = getProbeHandler();
    const res = await handler(null, { spacePaths: [SPACE_EMPTY] });
    expect(res.ready).toBe(true);
    expect(res.pathsWithIndex).toEqual([]); // ⇒ renderer passes hasPriorIndex=false ⇒ State B copy
  });

  it('does NOT count a sibling directory as inside the space (separator-safe containment)', async () => {
    mockHasIndex.mockReturnValue(true);
    mockGetIndexedPaths.mockReturnValue([`${SIBLING_DECOY}/README.md`]);
    const handler = getProbeHandler();
    const res = await handler(null, { spacePaths: [SPACE_WITH_FILES] });
    expect(res.ready).toBe(true);
    // The sibling "Company Memories Archive" must not satisfy containment for
    // "Company Memories" — a bare startsWith would wrongly match.
    expect(res.pathsWithIndex).not.toContain(SPACE_WITH_FILES);
  });

  it('matches case-insensitively so a case-folding filesystem does not false-negative', async () => {
    mockHasIndex.mockReturnValue(true);
    mockGetIndexedPaths.mockReturnValue([`${SPACE_WITH_FILES.toUpperCase()}/README.MD`]);
    const handler = getProbeHandler();
    const res = await handler(null, { spacePaths: [SPACE_WITH_FILES] });
    expect(res.ready).toBe(true);
    expect(res.pathsWithIndex).toContain(SPACE_WITH_FILES);
  });

  it('fails toward State A when the index is not hydrated (ready=false ⇒ default to last-known)', async () => {
    mockHasIndex.mockReturnValue(false);
    const handler = getProbeHandler();
    const res = await handler(null, { spacePaths: [SPACE_EMPTY] });
    expect(res.ready).toBe(false);
    expect(res.pathsWithIndex).toEqual([]);
    // getIndexedPaths must not even be consulted when the index isn't ready.
    expect(mockGetIndexedPaths).not.toHaveBeenCalled();
  });

  it('hydrated-but-empty index is an honest answer (ready=true, none have entries)', async () => {
    mockHasIndex.mockReturnValue(true);
    mockGetIndexedPaths.mockReturnValue([]);
    const handler = getProbeHandler();
    const res = await handler(null, { spacePaths: [SPACE_WITH_FILES, SPACE_EMPTY] });
    expect(res.ready).toBe(true);
    expect(res.pathsWithIndex).toEqual([]); // both spaces ⇒ State B reachable
  });

  it('fails toward State A on an unexpected error (ready=false, logged)', async () => {
    mockHasIndex.mockReturnValue(true);
    mockGetIndexedPaths.mockImplementation(() => {
      throw new Error('boom');
    });
    const handler = getProbeHandler();
    const res = await handler(null, { spacePaths: [SPACE_WITH_FILES] });
    expect(res.ready).toBe(false);
    expect(res.pathsWithIndex).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
