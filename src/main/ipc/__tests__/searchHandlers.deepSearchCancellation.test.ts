import { describe, it, expect, beforeEach, vi } from 'vitest';

const { registeredHandlers, mockStore, mockLogger } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, request: unknown) => unknown>(),
  mockStore: {
    getSessionIds: vi.fn(),
    getSession: vi.fn(),
  },
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
  getApiKey: vi.fn(() => null),
}));

vi.mock('../../services/atlasService', () => ({
  getAtlasProjection: vi.fn(),
  getAtlasNeighbors: vi.fn(),
  getAtlasQueryEmbedding: vi.fn(),
}));

vi.mock('../../services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => mockStore),
}));

import { registerSearchHandlers } from '../searchHandlers';

type DeepSearchResult = {
  results: Array<{ sessionId: string; title: string | null; matchPreview: string; matchCount: number }>;
  requestId: string;
  truncated: boolean;
};

type DeepSearchHandler = (
  event: { sender: { id: number } } | null,
  request: { query: string; requestId: string },
) => Promise<DeepSearchResult>;

function getDeepSearchHandler(): DeepSearchHandler {
  const handler = registeredHandlers.get('search:conversations-deep');
  expect(handler).toBeDefined();
  return handler as DeepSearchHandler;
}

describe('search:conversations-deep cloud-null cancellation', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
    mockStore.getSessionIds.mockReturnValue([]);
    mockStore.getSession.mockResolvedValue(null);
    registerSearchHandlers();
  });

  it('does not throw when invoked with event=null (cloud shape)', async () => {
    const handler = getDeepSearchHandler();

    const result = await handler(null, { query: 'foo', requestId: 'req-cloud-1' });

    expect(result).toEqual({ results: [], requestId: 'req-cloud-1', truncated: false });
  });

  it('cancels the prior cloud-null deep-search when a second one starts (shared cloud-process key)', async () => {
    const sessionIds = Array.from({ length: 25 }, (_, i) => `session-${i}`);
    mockStore.getSessionIds.mockReturnValue(sessionIds);
    mockStore.getSession.mockResolvedValue(null);

    const handler = getDeepSearchHandler();
    const p1 = handler(null, { query: 'foo', requestId: 'req-cloud-1' });
    const p2 = handler(null, { query: 'foo', requestId: 'req-cloud-2' });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.requestId).toBe('req-cloud-1');
    expect(r2.requestId).toBe('req-cloud-2');

    const cancelEntry = mockLogger.debug.mock.calls
      .map((args) => args[0])
      .find(
        (entry): entry is { requestId: string; senderId: number | string } =>
          typeof entry === 'object'
          && entry !== null
          && 'senderId' in entry
          && 'requestId' in entry
          && (entry as { requestId: unknown }).requestId === 'req-cloud-1',
      );
    expect(cancelEntry).toBeDefined();
    expect(cancelEntry?.senderId).toBe('cloud-process');
  });

  it('F2/F5: honours updatedAfter and skips private/corrupted/deleted sessions', async () => {
    const mkSession = (id: string, overrides: Record<string, unknown>) => ({
      id,
      title: `Title ${id}`,
      updatedAt: 2000,
      createdAt: 2000,
      deletedAt: null,
      isCorrupted: false,
      privateMode: false,
      messages: [{ id: 'm1', turnId: 't1', role: 'user', text: 'about foo', createdAt: 1500 }],
      eventsByTurn: {},
      ...overrides,
    });
    const sessions: Record<string, unknown> = {
      recent: mkSession('recent', { updatedAt: 5000 }),       // within window → kept
      old: mkSession('old', { updatedAt: 500 }),              // before cutoff → skipped
      priv: mkSession('priv', { updatedAt: 5000, privateMode: true }),   // private → skipped
      corrupt: mkSession('corrupt', { updatedAt: 5000, isCorrupted: true }), // corrupted → skipped
      trashed: mkSession('trashed', { updatedAt: 5000, deletedAt: 9000 }),   // deleted → skipped
    };
    mockStore.getSessionIds.mockReturnValue(Object.keys(sessions));
    mockStore.getSession.mockImplementation(async (id: string) => sessions[id] ?? null);

    const handler = getDeepSearchHandler() as unknown as (
      e: null,
      r: { query: string; requestId: string; updatedAfter?: number },
    ) => Promise<DeepSearchResult>;
    const result = await handler(null, { query: 'foo', requestId: 'req-recency', updatedAfter: 1000 });

    expect(result.results.map((r) => r.sessionId)).toEqual(['recent']);
  });

  it('cancels by WebContents.id when a desktop-shaped event is supplied', async () => {
    const sessionIds = Array.from({ length: 25 }, (_, i) => `session-${i}`);
    mockStore.getSessionIds.mockReturnValue(sessionIds);
    mockStore.getSession.mockResolvedValue(null);

    const handler = getDeepSearchHandler();
    const desktopEvent = { sender: { id: 17 } };
    const p1 = handler(desktopEvent, { query: 'foo', requestId: 'req-desktop-1' });
    const p2 = handler(desktopEvent, { query: 'foo', requestId: 'req-desktop-2' });

    await Promise.all([p1, p2]);

    const cancelEntry = mockLogger.debug.mock.calls
      .map((args) => args[0])
      .find(
        (entry): entry is { requestId: string; senderId: number | string } =>
          typeof entry === 'object'
          && entry !== null
          && 'senderId' in entry
          && 'requestId' in entry
          && (entry as { requestId: unknown }).requestId === 'req-desktop-1',
      );
    expect(cancelEntry).toBeDefined();
    expect(cancelEntry?.senderId).toBe(17);
  });
});
