import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FindSimilarResult } from '../../services/conversationIndexService';

const { registeredHandlers, mockFindSimilarConversations, mockGetAtlasNeighbors, mockStore, mockLogger } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, request: unknown) => unknown>(),
  mockFindSimilarConversations: vi.fn(),
  mockGetAtlasNeighbors: vi.fn(),
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
  findSimilarConversations: (...args: unknown[]) => mockFindSimilarConversations(...args),
}));

vi.mock('../../services/costLedgerService', () => ({
  getCategorizedCostSummary: vi.fn(),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(),
  settingsStore: {},
}));

vi.mock('../../services/atlasService', () => ({
  getAtlasProjection: vi.fn(),
  getAtlasNeighbors: (...args: unknown[]) => mockGetAtlasNeighbors(...args),
  getAtlasQueryEmbedding: vi.fn(),
}));

vi.mock('../../services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => mockStore),
}));

import { registerSearchHandlers } from '../searchHandlers';

function getFindSimilarHandler(): (
  event: unknown,
  request: { sessionId: string; limit?: number }
) => Promise<FindSimilarResult> {
  const handler = registeredHandlers.get('search:similar-conversations');
  expect(handler).toBeDefined();
  return handler as (
    event: unknown,
    request: { sessionId: string; limit?: number }
  ) => Promise<FindSimilarResult>;
}

function getDeepSearchHandler(): (
  event: { sender: { id: number } },
  request: { query: string; requestId: string }
) => Promise<{
  results: Array<{ sessionId: string; title: string | null; matchPreview: string; matchCount: number }>;
  requestId: string;
  truncated: boolean;
}> {
  const handler = registeredHandlers.get('search:conversations-deep');
  expect(handler).toBeDefined();
  return handler as (
    event: { sender: { id: number } },
    request: { query: string; requestId: string }
  ) => Promise<{
    results: Array<{ sessionId: string; title: string | null; matchPreview: string; matchCount: number }>;
    requestId: string;
    truncated: boolean;
  }>;
}

function getAtlasNeighborsHandler(): (
  event: unknown,
  request: { path: string; limit?: number }
) => Promise<{ neighbors: Array<{ path: string; relativePath: string; score: number }> }> {
  const handler = registeredHandlers.get('search:atlas-neighbors');
  expect(handler).toBeDefined();
  return handler as (
    event: unknown,
    request: { path: string; limit?: number }
  ) => Promise<{ neighbors: Array<{ path: string; relativePath: string; score: number }> }>;
}

describe('searchHandlers find similar conversations', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
    mockFindSimilarConversations.mockResolvedValue({
      results: [{ sessionId: 'similar-1', title: 'Similar A', score: 0.91, createdAt: 1000, messageCount: 3 }],
      status: 'ok',
    });
    mockStore.getSessionIds.mockReturnValue([]);
    mockStore.getSession.mockResolvedValue(null);

    registerSearchHandlers();
  });

  it('returns ok with empty results for an empty sessionId', async () => {
    const handler = getFindSimilarHandler();

    const result = await handler({}, { sessionId: '' });

    expect(result).toEqual({ results: [], status: 'ok' });
    expect(mockFindSimilarConversations).not.toHaveBeenCalled();
  });

  it('passes sessionId and limit through to the service', async () => {
    const handler = getFindSimilarHandler();

    await handler({}, { sessionId: 'session-1', limit: 3 });

    expect(mockFindSimilarConversations).toHaveBeenCalledWith('session-1', { limit: 3 });
  });

  it('passes atlas neighbor requests through and preserves the path/relativePath/score shape', async () => {
    mockGetAtlasNeighbors.mockResolvedValueOnce([
      { path: '/workspace/a.md', relativePath: 'a.md', score: 0.92 },
      { path: '/workspace/b.md', relativePath: 'b.md', score: 0.81 },
    ]);

    const handler = getAtlasNeighborsHandler();
    const result = await handler({}, { path: '/workspace/source.md', limit: 2 });

    expect(mockGetAtlasNeighbors).toHaveBeenCalledWith('/workspace/source.md', 2);
    expect(result).toEqual({
      neighbors: [
        { path: '/workspace/a.md', relativePath: 'a.md', score: 0.92 },
        { path: '/workspace/b.md', relativePath: 'b.md', score: 0.81 },
      ],
    });
    expect(Object.keys(result.neighbors[0]).sort()).toEqual(['path', 'relativePath', 'score']);
  });

  it('returns the service result directly on success', async () => {
    const serviceResult: FindSimilarResult = {
      results: [{ sessionId: 'similar-2', title: 'Similar B', score: 0.82, createdAt: 2000, messageCount: 5 }],
      status: 'ok',
    };
    mockFindSimilarConversations.mockResolvedValueOnce(serviceResult);

    const handler = getFindSimilarHandler();
    const result = await handler({}, { sessionId: 'session-1', limit: 4 });

    expect(result).toEqual(serviceResult);
  });

  it('returns error when the service throws', async () => {
    mockFindSimilarConversations.mockRejectedValueOnce(new Error('service failed'));

    const handler = getFindSimilarHandler();
    const result = await handler({}, { sessionId: 'session-1', limit: 4 });

    expect(result).toEqual({ results: [], status: 'error' });
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('uses the default limit when one is not provided', async () => {
    const handler = getFindSimilarHandler();

    await handler({}, { sessionId: 'session-1' });

    expect(mockFindSimilarConversations).toHaveBeenCalledWith('session-1', { limit: 5 });
  });

  it('builds deep-search previews from primary MCP App fallback text', async () => {
    mockStore.getSessionIds.mockReturnValue(['session-primary']);
    mockStore.getSession.mockResolvedValue({
      id: 'session-primary',
      title: 'Primary email draft',
      messages: [
        {
          id: 'msg-1',
          turnId: 'turn-1',
          role: 'assistant',
          text: 'Drafted the note.',
          createdAt: Date.now(),
        },
      ],
      eventsByTurn: {
        'turn-1': [
          {
            type: 'tool',
            toolName: 'compose_workspace_email',
            detail: 'draft created',
            stage: 'end',
            timestamp: Date.now(),
            mcpAppUiMeta: {
              resourceUri: 'ui://google-workspace/compose-email',
              presentation: 'primary',
              viewSummary: 'Email draft ready.',
              structuredFallback: {
                kind: 'email-draft',
                payload: {
                  to: ['recipient-preview@example.com'],
                  subject: 'Preview fallback',
                  body: 'Only the structured fallback contains this address.',
                },
              },
            },
          },
        ],
      },
    });
    const handler = getDeepSearchHandler();

    const result = await handler({ sender: { id: 1 } }, {
      query: 'recipient-preview@example.com',
      requestId: 'req-1',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].matchPreview).toContain('recipient-preview@example.com');
    expect(result.results[0].matchPreview).toMatch(/…|To:/);
  });

  it('builds deep-search previews from viewSummary-only primary MCP App fallback text', async () => {
    mockStore.getSessionIds.mockReturnValue(['session-summary-only']);
    mockStore.getSession.mockResolvedValue({
      id: 'session-summary-only',
      title: 'Summary-only primary view',
      messages: [
        {
          id: 'msg-1',
          turnId: 'turn-1',
          role: 'assistant',
          text: 'Prepared the workspace view.',
          createdAt: Date.now(),
        },
      ],
      eventsByTurn: {
        'turn-1': [
          {
            type: 'tool',
            toolName: 'compose_workspace_email',
            detail: 'draft created',
            stage: 'end',
            timestamp: Date.now(),
            mcpAppUiMeta: {
              resourceUri: 'ui://google-workspace/compose-email',
              presentation: 'primary',
              viewSummary: 'Summary-only needle for the sidebar preview.',
            },
          },
        ],
      },
    });
    const handler = getDeepSearchHandler();

    const result = await handler({ sender: { id: 1 } }, {
      query: 'Summary-only needle',
      requestId: 'req-summary',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].matchPreview).toContain('Summary-only needle');
  });

  it('matches queries spanning assistant prose and primary viewSummary boundaries', async () => {
    mockStore.getSessionIds.mockReturnValue(['session-prose-summary-boundary']);
    mockStore.getSession.mockResolvedValue({
      id: 'session-prose-summary-boundary',
      title: 'Boundary primary view',
      messages: [
        {
          id: 'msg-1',
          turnId: 'turn-1',
          role: 'assistant',
          text: 'Drafted the note.',
          createdAt: Date.now(),
        },
      ],
      eventsByTurn: {
        'turn-1': [
          {
            type: 'tool',
            toolName: 'compose_workspace_email',
            detail: 'draft created',
            stage: 'end',
            timestamp: Date.now(),
            mcpAppUiMeta: {
              resourceUri: 'ui://google-workspace/compose-email',
              presentation: 'primary',
              viewSummary: 'Email draft ready.',
            },
          },
        ],
      },
    });
    const handler = getDeepSearchHandler();

    const result = await handler({ sender: { id: 1 } }, {
      query: 'note. Email draft',
      requestId: 'req-boundary-prose',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].matchPreview).toContain('Drafted the note.');
    expect(result.results[0].matchPreview).toContain('Email draft ready.');
  });

  it('matches queries spanning primary viewSummary and structuredFallback boundaries', async () => {
    mockStore.getSessionIds.mockReturnValue(['session-summary-fallback-boundary']);
    mockStore.getSession.mockResolvedValue({
      id: 'session-summary-fallback-boundary',
      title: 'Fallback boundary primary view',
      messages: [
        {
          id: 'msg-1',
          turnId: 'turn-1',
          role: 'assistant',
          text: 'Drafted the note.',
          createdAt: Date.now(),
        },
      ],
      eventsByTurn: {
        'turn-1': [
          {
            type: 'tool',
            toolName: 'compose_workspace_email',
            detail: 'draft created',
            stage: 'end',
            timestamp: Date.now(),
            mcpAppUiMeta: {
              resourceUri: 'ui://google-workspace/compose-email',
              presentation: 'primary',
              viewSummary: 'Email draft ready.',
              structuredFallback: {
                kind: 'email-draft',
                payload: {
                  to: ['boundary-recipient@example.com'],
                  subject: 'Boundary fallback',
                  body: 'Boundary body.',
                },
              },
            },
          },
        ],
      },
    });
    const handler = getDeepSearchHandler();

    const result = await handler({ sender: { id: 1 } }, {
      query: 'ready. [Interactive view]',
      requestId: 'req-boundary-fallback',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].matchPreview).toContain('Email draft ready.');
    expect(result.results[0].matchPreview).toContain('[Interactive view]');
  });
});
