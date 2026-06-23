import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';

// Mock window.searchApi - used by conversationSearch for semantic search IPC
beforeAll(() => {
  (globalThis as any).window = {
    searchApi: {
      conversationsSemantic: vi.fn().mockResolvedValue([]),
      similarConversations: vi.fn().mockResolvedValue({
        results: [
          { sessionId: 'similar-1', title: 'Similar A', score: 0.9, createdAt: 1000, messageCount: 3 },
          { sessionId: 'similar-2', title: 'Similar B', score: 0.8, createdAt: 2000, messageCount: 5 },
        ],
        status: 'ok',
      }),
    },
  };
});

import {
  searchSessionTitles,
  clearTitleFuseCache,
  findSimilarConversations,
  semanticSearchConversations,
  type FindSimilarResult,
  type FindSimilarStatus,
  type SemanticConversationResult,
} from '../conversationSearch';
import type { AgentSession, AgentTurnMessage } from '@shared/types';

/**
 * Tests for conversationSearch utilities.
 *
 * Focus on pure function logic that doesn't require Electron/LanceDB.
 * IPC-based semantic search is tested separately via integration tests.
 *
 * Note: Fuse.js-based searchConversations and flattenConversations were removed
 * as part of the LanceDB search consolidation (sidebar search now uses IPC hybrid search).
 * Tests for those functions were removed alongside the code.
 * See docs/plans/260329_lancedb_search_consolidation.md for details.
 */

// Helper to create minimal AgentSession
const createSession = (
  overrides: Partial<AgentSession> & { id: string; title: string }
): AgentSession => ({
  createdAt: Date.now(),
  updatedAt: Date.now(),
  resolvedAt: null,
  messages: [],
  eventsByTurn: {},
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  doneAt: null,
  origin: 'manual',
  isCorrupted: false,
  ...overrides
});

// Helper to create minimal AgentTurnMessage
const createMessage = (
  overrides: Partial<AgentTurnMessage> & { id: string; text: string }
): AgentTurnMessage => ({
  turnId: `${overrides.id}-turn`,
  role: 'user',
  createdAt: Date.now(),
  ...overrides
});

describe('searchSessionTitles', () => {
  beforeEach(() => {
    clearTitleFuseCache();
  });

  it('finds sessions matching tokenized query with hyphen separators', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'Christmas Movies',
        messages: [createMessage({ id: 'm1', text: 'Hello' })]
      }),
      createSession({
        id: 's2',
        title: 'Project Roadmap',
        messages: [createMessage({ id: 'm2', text: 'World' })]
      })
    ];

    const results = searchSessionTitles('chr-mov', sessions);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('s1');
    expect(results[0].title).toBe('Christmas Movies');
  });

  it('returns empty array for delimiter-only query', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'Test Session',
        messages: [createMessage({ id: 'm1', text: 'Hello' })]
      })
    ];

    const results = searchSessionTitles('-', sessions);
    expect(results).toEqual([]);
  });

  it('excludes corrupted sessions from results', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'Valid Session',
        messages: [createMessage({ id: 'm1', text: 'Hello' })],
        isCorrupted: false
      }),
      createSession({
        id: 's2',
        title: 'Corrupted Session',
        messages: [createMessage({ id: 'm2', text: 'World' })],
        isCorrupted: true
      })
    ];

    const results = searchSessionTitles('session', sessions);

    expect(results.length).toBe(1);
    expect(results[0].id).toBe('s1');
  });

  it('excludes sessions with no messages', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'Valid Session',
        messages: [createMessage({ id: 'm1', text: 'Hello' })]
      }),
      createSession({
        id: 's2',
        title: 'Empty Session',
        messages: []
      })
    ];

    const results = searchSessionTitles('session', sessions);

    expect(results.length).toBe(1);
    expect(results[0].id).toBe('s1');
  });
});

describe('findSimilarConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the mock after clearAllMocks resets it
    vi.mocked(window.searchApi.similarConversations).mockResolvedValue({
      results: [
        { sessionId: 'similar-1', title: 'Similar A', score: 0.9, createdAt: 1000, messageCount: 3 },
        { sessionId: 'similar-2', title: 'Similar B', score: 0.8, createdAt: 2000, messageCount: 5 },
      ],
      status: 'ok',
    });
  });

  it('returns results from IPC', async () => {
    const result = await findSimilarConversations('session-1');
    expect(result.status).toBe('ok');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].sessionId).toBe('similar-1');
  });

  it('passes options through to IPC', async () => {
    await findSimilarConversations('session-1', { limit: 5 });
    expect(window.searchApi.similarConversations).toHaveBeenCalledWith({
      sessionId: 'session-1',
      limit: 5,
    });
  });

  it('returns empty results for empty sessionId', async () => {
    const result = await findSimilarConversations('');
    expect(result.results).toEqual([]);
    expect(result.status).toBe('ok');
    expect(window.searchApi.similarConversations).not.toHaveBeenCalled();
  });

  it('returns status: error on IPC failure', async () => {
    vi.mocked(window.searchApi.similarConversations).mockRejectedValueOnce(new Error('IPC failed'));
    const result = await findSimilarConversations('session-1');
    expect(result.results).toEqual([]);
    expect(result.status).toBe('error');
  });

  it('passes through source_not_indexed status from IPC', async () => {
    vi.mocked(window.searchApi.similarConversations).mockResolvedValueOnce({
      results: [],
      status: 'source_not_indexed',
    });

    const result = await findSimilarConversations('session-1');

    expect(result).toEqual({
      results: [],
      status: 'source_not_indexed',
    });
  });

  it('passes through index_not_ready status from IPC', async () => {
    vi.mocked(window.searchApi.similarConversations).mockResolvedValueOnce({
      results: [],
      status: 'index_not_ready',
    });

    const result = await findSimilarConversations('session-1');

    expect(result).toEqual({
      results: [],
      status: 'index_not_ready',
    });
  });

  it('passes through demo_mode status from IPC', async () => {
    vi.mocked(window.searchApi.similarConversations).mockResolvedValueOnce({
      results: [],
      status: 'demo_mode',
    });

    const result = await findSimilarConversations('session-1');

    expect(result).toEqual({
      results: [],
      status: 'demo_mode',
    });
  });

  it('passes through error status with empty results from IPC', async () => {
    vi.mocked(window.searchApi.similarConversations).mockResolvedValueOnce({
      results: [],
      status: 'error',
    });

    const result = await findSimilarConversations('session-1');

    expect(result).toEqual({
      results: [],
      status: 'error',
    });
  });

  it('result type matches FindSimilarResult', async () => {
    const result: FindSimilarResult = await findSimilarConversations('session-1');
    const status: FindSimilarStatus = result.status;
    const items: SemanticConversationResult[] = result.results;
    expect(status).toBeDefined();
    expect(items).toBeDefined();
  });

  it('uses default limit of 5 when no options provided', async () => {
    await findSimilarConversations('session-1');
    expect(window.searchApi.similarConversations).toHaveBeenCalledWith({
      sessionId: 'session-1',
      limit: 5,
    });
  });
});

// =============================================================================
// BEHAVIORAL CONTRACT TESTS — @-mention autocomplete (searchSessionTitles)
// =============================================================================
// These tests capture the exact Fuse.js behavior for title-only search.
// searchSessionTitles is preserved (not consolidated to LanceDB) because
// @-mention autocomplete requires low-latency fuzzy matching on titles.
// =============================================================================

describe('searchSessionTitles — behavioral contract (migration safety)', () => {
  beforeEach(() => {
    clearTitleFuseCache();
  });

  it('extended search does NOT fuzzy-match typos: "christms" misses "Christmas Movies"', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'Christmas Movies',
        messages: [createMessage({ id: 'm1', text: 'Holiday list' })]
      }),
      createSession({
        id: 's2',
        title: 'Budget Review',
        messages: [createMessage({ id: 'm2', text: 'Q4 numbers' })]
      })
    ];

    const results = searchSessionTitles('christms', sessions);

    // Extended search mode does NOT support typo tolerance — this is a known limitation
    expect(results.length).toBe(0);
  });

  it('near-complete prefix "christma" matches "Christmas Movies"', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'Christmas Movies',
        messages: [createMessage({ id: 'm1', text: 'Holiday list' })]
      })
    ];

    const results = searchSessionTitles('christma', sessions);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('s1');
  });

  it('single-char query: "c" matches titles starting with c', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'Christmas Movies',
        messages: [createMessage({ id: 'm1', text: 'Hello' })]
      }),
      createSession({
        id: 's2',
        title: 'Budget Review',
        messages: [createMessage({ id: 'm2', text: 'World' })]
      }),
      createSession({
        id: 's3',
        title: 'Cooking Tips',
        messages: [createMessage({ id: 'm3', text: 'Food' })]
      })
    ];

    const results = searchSessionTitles('c', sessions);

    expect(results.length).toBeGreaterThan(0);
    const resultIds = results.map((r) => r.id);
    expect(resultIds).toContain('s1');
    expect(resultIds).toContain('s3');
  });

  it('empty query returns empty array', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'Test Session',
        messages: [createMessage({ id: 'm1', text: 'Hello' })]
      })
    ];

    expect(searchSessionTitles('', sessions)).toEqual([]);
    expect(searchSessionTitles('  ', sessions)).toEqual([]);
  });

  it('prefix boosting: "sou" ranks "source-capture" above "unrelated-source"', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'unrelated-source',
        messages: [createMessage({ id: 'm1', text: 'Hello' })]
      }),
      createSession({
        id: 's2',
        title: 'source-capture',
        messages: [createMessage({ id: 'm2', text: 'World' })]
      })
    ];

    const results = searchSessionTitles('sou', sessions);

    expect(results.length).toBe(2);
    expect(results[0].id).toBe('s2');
  });

  it('match indices contain correct [start, end) position data', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'Budget Review',
        messages: [createMessage({ id: 'm1', text: 'Hello' })]
      })
    ];

    const results = searchSessionTitles('budget', sessions);

    expect(results.length).toBe(1);
    expect(results[0].matches.length).toBeGreaterThan(0);

    for (const [start, end] of results[0].matches) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(results[0].title.length);
    }

    const coversBudget = results[0].matches.some(
      ([start, end]) => start <= 0 && end >= 6
    );
    expect(coversBudget).toBe(true);
  });

  it('case insensitive: "CHRISTMAS" finds "christmas movies"', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'christmas movies',
        messages: [createMessage({ id: 'm1', text: 'Holiday' })]
      })
    ];

    const results = searchSessionTitles('CHRISTMAS', sessions);

    expect(results.length).toBe(1);
    expect(results[0].id).toBe('s1');
  });

  it('result limit is respected', () => {
    const sessions = Array.from({ length: 20 }, (_, i) =>
      createSession({
        id: `s${i}`,
        title: `Project Alpha ${i}`,
        messages: [createMessage({ id: `m${i}`, text: 'Content' })]
      })
    );

    const results = searchSessionTitles('alpha', sessions, { limit: 3 });

    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('results sorted by score ascending (lower is better)', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'Alpha',
        messages: [createMessage({ id: 'm1', text: 'Hello' })]
      }),
      createSession({
        id: 's2',
        title: 'Alpha Beta Gamma',
        messages: [createMessage({ id: 'm2', text: 'World' })]
      }),
      createSession({
        id: 's3',
        title: 'Something with Alpha in it somewhere buried deep',
        messages: [createMessage({ id: 'm3', text: 'Test' })]
      })
    ];

    const results = searchSessionTitles('alpha', sessions);

    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i - 1].score);
    }
  });

  it('returns multiple results for ambiguous queries', () => {
    const sessions = [
      createSession({
        id: 's1',
        title: 'Meeting Notes Monday',
        messages: [createMessage({ id: 'm1', text: 'Hello' })]
      }),
      createSession({
        id: 's2',
        title: 'Meeting Prep Wednesday',
        messages: [createMessage({ id: 'm2', text: 'World' })]
      }),
      createSession({
        id: 's3',
        title: 'Meeting Summary Friday',
        messages: [createMessage({ id: 'm3', text: 'Recap' })]
      })
    ];

    const results = searchSessionTitles('meeting', sessions);

    expect(results.length).toBe(3);
  });
});

describe('semanticSearchConversations — F4 status contract', () => {
  beforeEach(() => {
    vi.mocked(window.searchApi.conversationsSemantic).mockReset();
  });

  it('passes through a status-bearing { status, results } response', async () => {
    vi.mocked(window.searchApi.conversationsSemantic).mockResolvedValueOnce({
      status: 'index_not_ready',
      results: [],
    } as never);
    const res = await semanticSearchConversations('quarterly');
    expect(res).toEqual({ status: 'index_not_ready', results: [] });
  });

  it('unwraps a legacy bare-array response to { status: "ok", results }', async () => {
    const legacy = [{ sessionId: 's1', title: 'A', score: 0.7, createdAt: 1, messageCount: 2 }];
    vi.mocked(window.searchApi.conversationsSemantic).mockResolvedValueOnce(legacy as never);
    const res = await semanticSearchConversations('report');
    expect(res).toEqual({ status: 'ok', results: legacy });
  });

  it('maps an IPC rejection to { status: "error", results: [] } (not a silent no-match)', async () => {
    vi.mocked(window.searchApi.conversationsSemantic).mockRejectedValueOnce(new Error('IPC failed'));
    const res = await semanticSearchConversations('anything');
    expect(res).toEqual({ status: 'error', results: [] });
  });

  it('returns ok+[] for an empty query without calling IPC', async () => {
    const res = await semanticSearchConversations('   ');
    expect(res).toEqual({ status: 'ok', results: [] });
    expect(window.searchApi.conversationsSemantic).not.toHaveBeenCalled();
  });

  it('threads updatedAfter to the IPC call (exhaustive-within-window scope)', async () => {
    vi.mocked(window.searchApi.conversationsSemantic).mockResolvedValueOnce({ status: 'ok', results: [] } as never);
    await semanticSearchConversations('budget', { limit: 100, updatedAfter: 1_750_000_000_000 });
    expect(window.searchApi.conversationsSemantic).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'budget', limit: 100, updatedAfter: 1_750_000_000_000 })
    );
  });

  it('omits updatedAfter when no recency window is active', async () => {
    vi.mocked(window.searchApi.conversationsSemantic).mockResolvedValueOnce({ status: 'ok', results: [] } as never);
    await semanticSearchConversations('budget', { limit: 20 });
    const callArg = vi.mocked(window.searchApi.conversationsSemantic).mock.calls[0][0];
    expect(callArg.updatedAfter).toBeUndefined();
  });
});
