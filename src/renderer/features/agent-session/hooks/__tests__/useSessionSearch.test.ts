// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import type { SemanticConversationResult } from '@renderer/utils/conversationSearch';

// ── Mock heavy transitive deps to keep happy-dom fast ──────────────────

const mockSemanticSearch = vi.fn().mockResolvedValue([]);
const mockCalculateRecencyBoost = vi.fn().mockReturnValue(1);

vi.mock('@renderer/utils/conversationSearch', () => ({
  // F4: semanticSearchConversations now returns { status, results }. Auto-wrap a bare-array
  // mock value so existing `mockSemanticSearch.mockResolvedValue([...])` sites keep working;
  // a test that needs a specific status can resolve the object shape directly.
  semanticSearchConversations: async (...args: unknown[]) => {
    const r = await mockSemanticSearch(...args);
    return Array.isArray(r) ? { status: 'ok', results: r } : r;
  },
  calculateConversationRecencyBoost: (...args: unknown[]) => mockCalculateRecencyBoost(...args),
  RECENCY_FILTER_MS: { '1d': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000, all: null },
}));

vi.mock('@shared/navigation/urlParser', () => ({
  parseNavigationUrl: vi.fn().mockReturnValue(null),
}));

vi.mock('@renderer/src/tracking', () => ({
  tracking: { navigation: { conversationSearchPerformed: vi.fn() } },
}));

vi.mock('@renderer/contexts', () => ({}));

// Mock window.searchApi for deep search — add to existing happy-dom window
const mockConversationsDeep = vi.fn().mockResolvedValue({ results: [], requestId: '1', truncated: false });
(window as any).searchApi = {
  conversationsSemantic: vi.fn().mockResolvedValue([]),
  conversationsDeep: mockConversationsDeep,
  similarConversations: vi.fn().mockResolvedValue({ results: [], status: 'ok' }),
};

// Enable React act() environment
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

import { useSessionSearch, type DeepSearchResult } from '../useSessionSearch';

// ── Minimal renderHook ─────────────────────────────────────────────────
// Uses require() to bypass Vite's import analysis which can't resolve
// @testing-library/react. This is intentional — see AGENTS.md note on
// testing infrastructure limitations with electron-vite.

function renderHook<T>(
  hookFn: (props: any) => T,
  options?: { initialProps?: any },
): { result: { current: T }; rerender: (props: any) => void; unmount: () => void } {
  const result = { current: undefined as unknown as T };
  let renderError: Error | null = null;

  // Error boundary component to catch hook initialization failures
  class ErrorBoundary extends React.Component<
    { children: React.ReactNode },
    { hasError: boolean }
  > {
    state = { hasError: false };
    static getDerivedStateFromError() { return { hasError: true }; }
    componentDidCatch(error: Error) { renderError = error; }
    render() { return this.state.hasError ? null : this.props.children; }
  }

  const TestComponent = (props: any) => {
    result.current = hookFn(props);
    return null;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(
      React.createElement(ErrorBoundary, null,
        React.createElement(TestComponent, options?.initialProps ?? {})
      )
    );
  });

  if (renderError) {
    const error = renderError as Error;
    container.remove();
    throw new Error(`Hook threw during render: ${error.message}`, { cause: error });
  }

  return {
    result,
    rerender: (props: any) => {
      reactAct(() => {
        root.render(
          React.createElement(ErrorBoundary, null,
            React.createElement(TestComponent, props)
          )
        );
      });
      if (renderError) {
        const error = renderError as Error;
        throw new Error(`Hook threw during rerender: ${error.message}`, { cause: error });
      }
    },
    unmount: () => {
      reactAct(() => { root.unmount(); });
      container.remove();
    },
  };
}

function act(fn: () => void | Promise<void>) {
  reactAct(fn);
}

/** Flush microtasks (promise resolution) within act boundaries */
async function flushAsync() {
  await reactAct(async () => {
    // Flush the microtask queue by awaiting resolved promises
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

const makeOptions = (overrides: Partial<Parameters<typeof useSessionSearch>[0]> = {}) => ({
  sessionSummaries: [
    { id: 's1', title: 'First', messageCount: 3, createdAt: 1000, updatedAt: 2000, origin: 'manual' as const, isBusy: false, resolvedAt: null, deletedAt: null, doneAt: null, starredAt: null },
    { id: 's2', title: 'Second', messageCount: 5, createdAt: 3000, updatedAt: 4000, origin: 'manual' as const, isBusy: false, resolvedAt: null, deletedAt: null, doneAt: null, starredAt: null },
  ],
  currentSessionId: 'current',
  currentSessionTitle: 'Current Session',
  currentSessionResolvedAt: null,
  currentSessionOrigin: 'manual' as const,
  messages: [],
  emitLog: vi.fn(),
  onSelectResult: vi.fn(),
  sessionTypeFilter: 'all' as const,
  ...overrides,
});

const makeSimilarResults = (): SemanticConversationResult[] => [
  { sessionId: 'sim-1', title: 'Similar A', score: 0.9, createdAt: 1000, messageCount: 3 },
  { sessionId: 'sim-2', title: 'Similar B', score: 0.8, createdAt: 2000, messageCount: 5 },
];

const makeFindSimilarSource = () => ({ sessionId: 'source-1', title: 'Source Conversation' });

// ── Tests ──────────────────────────────────────────────────────────────

describe('useSessionSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockSemanticSearch.mockResolvedValue([]);
    mockCalculateRecencyBoost.mockReturnValue(1);
    // The recency filter persists to localStorage; reset to 'all' so a test that sets it
    // (e.g. the F2 tests) doesn't bleed a time-window into later tests whose mock results
    // have ancient timestamps and would be recency-filtered out.
    try { localStorage.removeItem('session-search-recency-filter'); } catch { /* noop */ }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('exports', () => {
    it('exports useSessionSearch function', () => {
      expect(typeof useSessionSearch).toBe('function');
    });
  });

  describe('DeepSearchResult type', () => {
    it('allows null title', () => {
      const r: DeepSearchResult = { sessionId: 's1', title: null, matchPreview: 'p', matchCount: 1 };
      expect(r.title).toBeNull();
    });
  });

  describe('return type contract', () => {
    it('exposes setFindSimilarResults (not setSemanticResults)', () => {
      type R = ReturnType<typeof useSessionSearch>;
      type HasFind = 'setFindSimilarResults' extends keyof R ? true : false;
      const hasFind: HasFind = true;
      expect(hasFind).toBe(true);
    });

    it('exposes isSearching (not isSearchingSemantic)', () => {
      type R = ReturnType<typeof useSessionSearch>;
      type HasSearching = R extends { isSearching: boolean } ? true : false;
      const hasSearching: HasSearching = true;
      expect(hasSearching).toBe(true);
    });

    it('returns unified results as ConversationSearchResult[]', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      expect(Array.isArray(result.current.results)).toBe(true);
      unmount();
    });
  });

  describe('initial state', () => {
    it('starts with empty results and no loading', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      expect(result.current.results).toEqual([]);
      expect(result.current.isSearching).toBe(false);
      expect(result.current.query).toBe('');
      expect(result.current.selectedIndex).toBe(0);
      unmount();
    });
  });

  describe('IPC search flow', () => {
    it('calls semanticSearchConversations after debounce when query is long enough', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });

      act(() => { result.current.handleQueryChange('meeting notes'); });
      // Before debounce fires
      expect(mockSemanticSearch).not.toHaveBeenCalled();

      // Advance past 300ms debounce
      act(() => { vi.advanceTimersByTime(350); });
      expect(mockSemanticSearch).toHaveBeenCalledWith('meeting notes', { limit: 20 });

      unmount();
    });

    it('does not call search for short queries (< 3 chars)', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });

      act(() => { result.current.handleQueryChange('ab'); });
      act(() => { vi.advanceTimersByTime(500); });

      expect(mockSemanticSearch).not.toHaveBeenCalled();
      unmount();
    });

    it('sets isSearching while IPC is in flight', async () => {
      // Use a promise that we can control
      let resolveSearch: (value: SemanticConversationResult[]) => void;
      mockSemanticSearch.mockReturnValue(new Promise<SemanticConversationResult[]>((resolve) => {
        resolveSearch = resolve;
      }));

      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });

      act(() => { result.current.handleQueryChange('meeting notes'); });
      act(() => { vi.advanceTimersByTime(350); });

      // isSearching should be true after query change (even before debounce resolves)
      expect(result.current.isSearching).toBe(true);

      // Resolve the search and flush microtasks
      resolveSearch!([]);
      await flushAsync();

      expect(result.current.isSearching).toBe(false);
      unmount();
    });

    it('maps IPC results to ConversationSearchResult[]', async () => {
      const ipcResults: SemanticConversationResult[] = [
        { sessionId: 's1', title: 'First', score: 0.9, createdAt: 1000, messageCount: 3 },
      ];
      mockSemanticSearch.mockResolvedValue(ipcResults);

      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });

      act(() => { result.current.handleQueryChange('test query'); });
      act(() => { vi.advanceTimersByTime(350); });

      // Flush async IPC promise resolution
      await flushAsync();

      expect(result.current.results.length).toBe(1);
      expect(result.current.results[0].sessionId).toBe('s1');
      expect(result.current.results[0].sessionTitle).toBe('First');
      expect(result.current.results[0].isHistory).toBe(true);
      expect(result.current.results[0].isTitle).toBe(true);
      unmount();
    });

    it('clears results for empty query', () => {
      mockSemanticSearch.mockResolvedValue([
        { sessionId: 's1', title: 'Match', score: 0.9, createdAt: 1000, messageCount: 3 },
      ]);

      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });

      // Search
      act(() => { result.current.handleQueryChange('test'); });
      act(() => { vi.advanceTimersByTime(350); });
      act(() => { vi.advanceTimersByTime(0); });

      // Clear
      act(() => { result.current.handleQueryChange(''); });
      act(() => { vi.advanceTimersByTime(0); });

      expect(result.current.results).toEqual([]);
      unmount();
    });

    it('F4: exposes backend availability status distinctly from a no-match', async () => {
      // Backend warming up → status surfaced (NOT a silent empty "no match").
      mockSemanticSearch.mockResolvedValue({ status: 'index_not_ready', results: [] });

      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.handleQueryChange('quarterly report'); });
      act(() => { vi.advanceTimersByTime(350); });
      await flushAsync();

      expect(result.current.searchStatus).toBe('index_not_ready');
      expect(result.current.results).toEqual([]);

      // A subsequent successful search resets status to ok.
      mockSemanticSearch.mockResolvedValue({
        status: 'ok',
        results: [{ sessionId: 's1', title: 'Quarterly report', score: 0.8, rankScore: 0.03, createdAt: 1, messageCount: 2 }],
      });
      act(() => { result.current.handleQueryChange('quarterly report!'); });
      act(() => { vi.advanceTimersByTime(350); });
      await flushAsync();
      expect(result.current.searchStatus).toBe('ok');
      expect(result.current.results.length).toBe(1);
      unmount();
    });

    it('F4: retrySearch re-runs the current query', async () => {
      mockSemanticSearch.mockResolvedValue({ status: 'error', results: [] });
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.handleQueryChange('budget'); });
      act(() => { vi.advanceTimersByTime(350); });
      await flushAsync();
      expect(result.current.searchStatus).toBe('error');

      mockSemanticSearch.mockClear();
      mockSemanticSearch.mockResolvedValue({ status: 'ok', results: [] });
      act(() => { result.current.retrySearch(); });
      act(() => { vi.advanceTimersByTime(350); });
      await flushAsync();
      expect(mockSemanticSearch).toHaveBeenCalled(); // query re-fired without retyping
      expect(result.current.searchStatus).toBe('ok');
      unmount();
    });

    it('F4: a short query after an error does NOT keep the stale error status', async () => {
      mockSemanticSearch.mockResolvedValue({ status: 'error', results: [] });
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.handleQueryChange('budget review'); });
      act(() => { vi.advanceTimersByTime(350); });
      await flushAsync();
      expect(result.current.searchStatus).toBe('error');

      // Type a sub-threshold query — this bypasses the backend entirely; status must reset
      // to 'ok' so the sidebar doesn't render "Search is taking a breather" for it.
      act(() => { result.current.handleQueryChange('ab'); });
      act(() => { vi.advanceTimersByTime(50); });
      expect(result.current.searchStatus).toBe('ok');
      unmount();
    });

    it('F2/260620: sends the window cutoff (updatedAfter) + deeper pool when a recency filter is active', async () => {
      mockSemanticSearch.mockResolvedValue({ status: 'ok', results: [] });
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });

      // Default 'all' → small pool (20), NO recency scope (updatedAfter omitted).
      act(() => { result.current.handleQueryChange('budget'); });
      act(() => { vi.advanceTimersByTime(350); });
      await flushAsync();
      expect(mockSemanticSearch).toHaveBeenLastCalledWith('budget', { limit: 20, updatedAfter: undefined });

      // Time filter active → deeper pool (100, the >500-in-window grace-fallback bound) AND the
      // precise window cutoff pushed to the backend so quick search is exhaustive within it.
      // Date.now() is frozen under fake timers, so the cutoff is deterministic.
      act(() => { result.current.setRecencyFilter('7d'); });
      act(() => { result.current.handleQueryChange('budget review'); });
      act(() => { vi.advanceTimersByTime(350); });
      await flushAsync();
      const lastCall = mockSemanticSearch.mock.calls.at(-1)!;
      expect(lastCall[0]).toBe('budget review');
      expect(lastCall[1].limit).toBe(100);
      // updatedAfter ≈ now − 7d (tolerance absorbs sub-second fake-timer drift between the
      // captured call time and assertion time); the point is it's the 7d window cutoff, not 0.
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(lastCall[1].updatedAfter).toBeGreaterThan(0);
      expect(Math.abs(lastCall[1].updatedAfter - (Date.now() - sevenDaysMs))).toBeLessThan(2000);
      unmount();
    });

    it('F5: a sub-threshold query (1-2 chars) returns instant title matches, not nothing', () => {
      // makeOptions seeds summaries titled "First" and "Second".
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.handleQueryChange('fi'); }); // matches "First"
      act(() => { vi.advanceTimersByTime(50); });
      expect(result.current.results.map((r) => r.sessionId)).toEqual(['s1']);
      expect(result.current.results[0].isTitle).toBe(true);
      expect(mockSemanticSearch).not.toHaveBeenCalled(); // below semantic threshold — no backend call
      unmount();
    });

    it('F5: title floor shows immediately, then semantic results merge in (title-first, deduped)', async () => {
      mockSemanticSearch.mockResolvedValue({
        status: 'ok',
        results: [
          { sessionId: 's1', title: 'First', score: 0.9, rankScore: 0.04, createdAt: 1000, messageCount: 3 }, // dup of title hit
          { sessionId: 's2', title: 'Second', score: 0.6, rankScore: 0.02, createdAt: 3000, messageCount: 5 }, // semantic-only
        ],
      });
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.handleQueryChange('first'); }); // title hit s1 (instant floor)
      // Instant floor present before debounce/IPC.
      expect(result.current.results.map((r) => r.sessionId)).toEqual(['s1']);
      act(() => { vi.advanceTimersByTime(350); });
      await flushAsync();
      // Merged: title hit s1 stays first (deduped), semantic-only s2 appended.
      expect(result.current.results.map((r) => r.sessionId)).toEqual(['s1', 's2']);
      unmount();
    });

    it('F2: deep search passes updatedAfter that honours the active recency window', async () => {
      mockSemanticSearch.mockResolvedValue({ status: 'ok', results: [] });
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.setRecencyFilter('1d'); });
      act(() => { result.current.handleQueryChange('quarterly'); });
      act(() => { vi.advanceTimersByTime(350); });
      await flushAsync();

      act(() => { void result.current.triggerDeepSearch(); });
      await flushAsync();
      expect(mockConversationsDeep).toHaveBeenCalled();
      const arg = mockConversationsDeep.mock.calls.at(-1)?.[0];
      expect(typeof arg.updatedAfter).toBe('number'); // 1d cutoff present
      unmount();
    });
  });

  describe('Find Similar guard (behavioral)', () => {
    it('starts with empty results', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      expect(result.current.results).toEqual([]);
      unmount();
    });

    it('setFindSimilarResults populates results', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.setFindSimilarResults(makeSimilarResults(), makeFindSimilarSource()); });
      expect(result.current.results).toHaveLength(2);
      expect(result.current.results[0].sessionId).toBe('sim-1');
      expect(result.current.findSimilarSource).toEqual(makeFindSimilarSource());
      expect(result.current.query).toBe('');
      expect(result.current.lastSearchQuery).toBe('');
      expect(result.current.deepSearchResults).toEqual([]);
      unmount();
    });

    it('setFindSimilarResults exits active query and deep-search state', async () => {
      mockSemanticSearch.mockResolvedValue([
        { sessionId: 's1', title: 'First', score: 0.9, createdAt: 1000, messageCount: 3 },
      ]);
      mockConversationsDeep.mockResolvedValueOnce({
        results: [{ sessionId: 's2', title: 'Second', matchPreview: 'deep match', matchCount: 1 }],
        requestId: '1',
        truncated: false,
      });

      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });

      act(() => { result.current.handleQueryChange('test'); });
      act(() => { vi.advanceTimersByTime(350); });
      await flushAsync();
      await reactAct(async () => {
        await result.current.triggerDeepSearch();
      });

      expect(result.current.query).toBe('test');
      expect(result.current.deepSearchResults).toHaveLength(1);

      act(() => { result.current.setFindSimilarResults(makeSimilarResults(), makeFindSimilarSource()); });

      expect(result.current.findSimilarSource).toEqual(makeFindSimilarSource());
      expect(result.current.query).toBe('');
      expect(result.current.lastSearchQuery).toBe('');
      expect(result.current.deepSearchResults).toEqual([]);
      expect(result.current.isDeepSearching).toBe(false);
      expect(result.current.isSearching).toBe(false);
      expect(result.current.selectedIndex).toBe(0);
      expect(result.current.results).toHaveLength(2);
      unmount();
    });

    it('setFindSimilarResults clears Back to search state', async () => {
      mockSemanticSearch.mockResolvedValue([
        { sessionId: 's1', title: 'First', score: 0.9, createdAt: 1000, messageCount: 3 },
      ]);

      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });

      act(() => { result.current.handleQueryChange('test'); });
      act(() => { vi.advanceTimersByTime(350); });
      await flushAsync();
      act(() => {
        result.current.handleKeyDown({
          key: 'Enter',
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent<HTMLInputElement>);
      });

      expect(result.current.lastSearchQuery).toBe('test');

      act(() => { result.current.setFindSimilarResults(makeSimilarResults(), makeFindSimilarSource()); });

      expect(result.current.lastSearchQuery).toBe('');
      expect(result.current.findSimilarSource).toEqual(makeFindSimilarSource());
      unmount();
    });

    it('Find Similar results survive re-render with changed sessionSummaries', () => {
      const opts = makeOptions();
      const { result, rerender, unmount } = renderHook(useSessionSearch, { initialProps: opts });

      act(() => { result.current.setFindSimilarResults(makeSimilarResults(), makeFindSimilarSource()); });
      expect(result.current.results).toHaveLength(2);

      // Simulate background session update
      act(() => { vi.advanceTimersByTime(200); });
      rerender({
        ...opts,
        sessionSummaries: opts.sessionSummaries.map((s) => ({
          ...s, updatedAt: 99999, isBusy: !s.isBusy,
        })),
      });
      act(() => { vi.advanceTimersByTime(200); });

      // THE ORIGINAL BUG: results were cleared here. Now they must survive.
      expect(result.current.results).toHaveLength(2);
      unmount();
    });

    it('multiple rapid sessionSummary updates do not clear Find Similar results', () => {
      const opts = makeOptions();
      const { result, rerender, unmount } = renderHook(useSessionSearch, { initialProps: opts });

      act(() => { result.current.setFindSimilarResults(makeSimilarResults(), makeFindSimilarSource()); });

      for (let i = 1; i <= 3; i++) {
        rerender({
          ...opts,
          sessionSummaries: opts.sessionSummaries.map((s) => ({
            ...s, updatedAt: 10000 + i,
          })),
        });
        act(() => { vi.advanceTimersByTime(200); });
      }

      expect(result.current.results).toHaveLength(2);
      unmount();
    });

    it('clearSearch clears Find Similar results', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.setFindSimilarResults(makeSimilarResults(), makeFindSimilarSource()); });
      expect(result.current.results).toHaveLength(2);
      expect(result.current.findSimilarSource).toEqual(makeFindSimilarSource());

      act(() => { result.current.clearSearch(); });
      expect(result.current.results).toEqual([]);
      expect(result.current.findSimilarSource).toBeNull();
      unmount();
    });

    it('handleQueryChange exits Find Similar mode so effect clears results', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.setFindSimilarResults(makeSimilarResults(), makeFindSimilarSource()); });
      expect(result.current.results).toHaveLength(2);
      expect(result.current.findSimilarSource).toEqual(makeFindSimilarSource());

      // Short query (below MIN_QUERY_LENGTH_FOR_SEMANTIC) triggers the early-return
      // path in the effect, which clears results now that findSimilarModeRef is false
      act(() => {
        result.current.handleQueryChange('x');
        vi.advanceTimersByTime(200);
      });

      expect(result.current.results).toEqual([]);
      expect(result.current.findSimilarSource).toBeNull();
      unmount();
    });

    it('Escape key clears Find Similar results', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.setFindSimilarResults(makeSimilarResults(), makeFindSimilarSource()); });
      expect(result.current.results).toHaveLength(2);
      expect(result.current.findSimilarSource).toEqual(makeFindSimilarSource());

      act(() => {
        result.current.handleKeyDown({
          key: 'Escape',
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent<HTMLInputElement>);
      });

      expect(result.current.results).toEqual([]);
      expect(result.current.findSimilarSource).toBeNull();
      unmount();
    });

    it('document Escape clears Find Similar results without focusing the input', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.setFindSimilarResults(makeSimilarResults(), makeFindSimilarSource()); });
      expect(result.current.results).toHaveLength(2);
      expect(result.current.findSimilarSource).toEqual(makeFindSimilarSource());

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });

      expect(result.current.findSimilarSource).toBeNull();
      expect(result.current.results).toEqual([]);
      unmount();
    });

    it('Find Similar → type → clear returns to idle', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.setFindSimilarResults(makeSimilarResults(), makeFindSimilarSource()); });
      act(() => {
        result.current.handleQueryChange('x');
        vi.advanceTimersByTime(200);
      });
      act(() => { result.current.clearSearch(); });

      expect(result.current.results).toEqual([]);
      expect(result.current.query).toBe('');
      expect(result.current.findSimilarSource).toBeNull();
      unmount();
    });

    it('safety timeout auto-clears Find Similar results after 5 minutes', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });
      act(() => { result.current.setFindSimilarResults(makeSimilarResults(), makeFindSimilarSource()); });
      expect(result.current.results).toHaveLength(2);
      expect(result.current.findSimilarSource).toEqual(makeFindSimilarSource());

      // Advance to just before timeout -- results should persist
      act(() => { vi.advanceTimersByTime(4 * 60 * 1000); });
      expect(result.current.results).toHaveLength(2);
      expect(result.current.findSimilarSource).toEqual(makeFindSimilarSource());

      // Advance past the 5-minute timeout -- results should be cleared
      act(() => { vi.advanceTimersByTime(60 * 1000 + 1); });
      expect(result.current.results).toEqual([]);
      expect(result.current.findSimilarSource).toBeNull();
      unmount();
    });
  });

  describe('keyboard navigation', () => {
    it('ArrowDown increments selectedIndex', async () => {
      mockSemanticSearch.mockResolvedValue([
        { sessionId: 's1', title: 'First', score: 0.9, createdAt: 1000, messageCount: 3 },
        { sessionId: 's2', title: 'Second', score: 0.8, createdAt: 2000, messageCount: 5 },
      ]);

      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });

      act(() => { result.current.handleQueryChange('test'); });
      act(() => { vi.advanceTimersByTime(350); });
      await flushAsync();

      expect(result.current.results.length).toBe(2);
      expect(result.current.selectedIndex).toBe(0);

      act(() => {
        result.current.handleKeyDown({
          key: 'ArrowDown',
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent<HTMLInputElement>);
      });

      expect(result.current.selectedIndex).toBe(1);
      unmount();
    });

    it('Escape clears search state', () => {
      const { result, unmount } = renderHook(useSessionSearch, { initialProps: makeOptions() });

      act(() => { result.current.handleQueryChange('test'); });

      act(() => {
        result.current.handleKeyDown({
          key: 'Escape',
          preventDefault: vi.fn(),
        } as unknown as React.KeyboardEvent<HTMLInputElement>);
      });

      expect(result.current.query).toBe('');
      expect(result.current.results).toEqual([]);
      unmount();
    });
  });
});
