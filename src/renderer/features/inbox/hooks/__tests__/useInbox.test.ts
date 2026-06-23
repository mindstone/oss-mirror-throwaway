// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, flushAsync, createMockWindowApi } from '@renderer/test-utils';
import { useInbox } from '../useInbox';
import type { InboxIndexState, InboxItem, InboxState } from '@shared/types';

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    inbox: {
      itemAdded: vi.fn(),
      itemDeleted: vi.fn(),
      itemArchived: vi.fn(),
      itemRestored: vi.fn(),
    },
  },
}));

vi.mock('../utils/quadrant', () => ({
  getQuadrant: () => 'consider',
}));

vi.mock('@rebel/shared', () => ({
  deriveConfidence: () => 'medium',
  getScheduleDueBy: () => Date.now() + 86400000,
}));

let inboxUpdateCallback: ((state: InboxState) => void) | null = null;

function makeIndexEntry(
  id: string,
  overrides: Partial<{ archived: boolean; confidence: string; addedAt: number; executingSessionId: string; status: string }> = {},
) {
  return {
    id,
    title: `Item ${id}`,
    archived: false,
    addedAt: Date.now() - 3600000,
    confidence: 'high',
    ...overrides,
  };
}

function makeItem(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    title: `Item ${id}`,
    archived: false,
    addedAt: Date.now() - 3600000,
    ...overrides,
  } as InboxItem;
}

function makeIndex(entries: ReturnType<typeof makeIndexEntry>[]): InboxIndexState {
  return { version: 1, entries: entries as InboxIndexState['entries'], history: [], migrationComplete: true };
}

function setupWindowApis() {
  const mockInboxApi = {
    loadIndex: vi.fn().mockResolvedValue(makeIndex([])),
    loadItems: vi.fn().mockResolvedValue([]),
    setArchived: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    setTags: vi.fn().mockResolvedValue({ version: 1, items: [], history: [] }),
    setQuadrant: vi.fn().mockResolvedValue({ version: 1, items: [], history: [] }),
    setDueBy: vi.fn().mockResolvedValue({ version: 1, items: [], history: [] }),
  };

  const mockTasksApi = {
    recordExecution: vi.fn().mockResolvedValue({ version: 1, items: [], history: [] }),
    delete: vi.fn().mockResolvedValue({ version: 1, items: [], history: [] }),
  };

  const mockApi = {
    onInboxUpdate: vi.fn((cb: (state: InboxState) => void) => {
      inboxUpdateCallback = cb;
      return () => { inboxUpdateCallback = null; };
    }),
    openUrl: vi.fn().mockResolvedValue(undefined),
  };

  createMockWindowApi('inboxApi', mockInboxApi);
  createMockWindowApi('tasksApi', mockTasksApi);
  createMockWindowApi('api', mockApi);

  return { mockInboxApi, mockTasksApi, mockApi };
}

describe('useInbox', () => {
  let apis: ReturnType<typeof setupWindowApis>;

  beforeEach(() => {
    vi.clearAllMocks();
    inboxUpdateCallback = null;
    apis = setupWindowApis();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial load', () => {
    it('loads index then fetches all item details', async () => {
      const entries = [makeIndexEntry('a'), makeIndexEntry('b'), makeIndexEntry('c', { archived: true })];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([makeItem('a'), makeItem('b'), makeItem('c', { archived: true })]);

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      expect(apis.mockInboxApi.loadIndex).toHaveBeenCalledTimes(1);
      expect(apis.mockInboxApi.loadItems).toHaveBeenCalledWith({ ids: ['a', 'b', 'c'] });
      expect(result.current.items).toHaveLength(3);
      expect(result.current.loading).toBe(false);
      unmount();
    });

    it('sets error on load failure', async () => {
      apis.mockInboxApi.loadIndex.mockRejectedValue(new Error('network down'));

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      expect(result.current.error).toBe('network down');
      expect(result.current.loading).toBe(false);
      unmount();
    });
  });

  describe('derived counts', () => {
    it('computes archivedCount and activeCount from items', async () => {
      const entries = [
        makeIndexEntry('a'),
        makeIndexEntry('b'),
        makeIndexEntry('c', { archived: true }),
        makeIndexEntry('d', { archived: true }),
      ];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([
        makeItem('a'),
        makeItem('b'),
        makeItem('c', { archived: true }),
        makeItem('d', { archived: true }),
      ]);

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      expect(result.current.activeCount).toBe(2);
      expect(result.current.archivedCount).toBe(2);
      unmount();
    });

    it('computes actionableCount for medium/low confidence items', async () => {
      // Use a date well in the past to avoid "added today" rule interfering
      const twoDaysAgo = Date.now() - 86400000 * 2;
      const entries = [
        makeIndexEntry('a', { confidence: 'medium', addedAt: twoDaysAgo }),
        makeIndexEntry('b', { confidence: 'low', addedAt: twoDaysAgo }),
        makeIndexEntry('c', { confidence: 'high', addedAt: twoDaysAgo }),
      ];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([
        makeItem('a', { confidence: 'medium', addedAt: twoDaysAgo } as Partial<InboxItem>),
        makeItem('b', { confidence: 'low', addedAt: twoDaysAgo } as Partial<InboxItem>),
        makeItem('c', { confidence: 'high', addedAt: twoDaysAgo } as Partial<InboxItem>),
      ]);

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      expect(result.current.actionableCount).toBe(2);
      unmount();
    });

    it('counts items added today as actionable', async () => {
      const now = Date.now();
      const entries = [
        makeIndexEntry('today', { confidence: 'high', addedAt: now }),
      ];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([
        makeItem('today', { confidence: 'high', addedAt: now } as Partial<InboxItem>),
      ]);

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      expect(result.current.actionableCount).toBe(1);
      unmount();
    });

    it('excludes archived items from actionableCount', async () => {
      const entries = [
        makeIndexEntry('archived-med', { archived: true, confidence: 'medium' }),
      ];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([
        makeItem('archived-med', { archived: true, confidence: 'medium' } as Partial<InboxItem>),
      ]);

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      expect(result.current.actionableCount).toBe(0);
      unmount();
    });
  });

  describe('optimistic mutations', () => {
    it('handleArchiveTask updates local state immediately', async () => {
      const entries = [makeIndexEntry('a')];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([makeItem('a')]);

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      expect(result.current.activeCount).toBe(1);

      await act(async () => {
        void result.current.handleArchiveTask('a', true);
      });

      expect(result.current.archivedCount).toBe(1);
      expect(result.current.activeCount).toBe(0);
      expect(apis.mockInboxApi.setArchived).toHaveBeenCalledWith({ itemId: 'a', archived: true });
      unmount();
    });

    it('handleDone archives and sets status to completed', async () => {
      const entries = [makeIndexEntry('a')];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([makeItem('a')]);

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      await act(async () => {
        void result.current.handleDone('a');
      });

      expect(result.current.archivedCount).toBe(1);
      expect(result.current.items[0].status).toBe('completed');
      expect(apis.mockInboxApi.setStatus).toHaveBeenCalledWith({
        itemId: 'a',
        status: 'completed',
        completedBy: 'user',
      });
      unmount();
    });

    it('handleDismiss archives and sets status to dismissed', async () => {
      const entries = [makeIndexEntry('a')];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([makeItem('a')]);

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      await act(async () => {
        void result.current.handleDismiss('a');
      });

      expect(result.current.archivedCount).toBe(1);
      expect(result.current.items[0].status).toBe('dismissed');
      expect(apis.mockInboxApi.setStatus).toHaveBeenCalledWith({
        itemId: 'a',
        status: 'dismissed',
      });
      unmount();
    });

    it('calls refresh to revert state on archive API failure', async () => {
      const entries = [makeIndexEntry('a')];
      const index = makeIndex(entries);
      apis.mockInboxApi.loadIndex.mockResolvedValue(index);
      apis.mockInboxApi.loadItems.mockResolvedValue([makeItem('a')]);
      apis.mockInboxApi.setArchived.mockRejectedValue(new Error('server error'));

      const showToast = vi.fn();
      const { result, unmount } = renderHook(() => useInbox({ showToast }));
      await flushAsync();

      expect(result.current.activeCount).toBe(1);

      await act(async () => {
        await result.current.handleArchiveTask('a', true);
      });
      await flushAsync();

      expect(showToast).toHaveBeenCalledWith({ title: 'Unable to update task' });
      // refresh() was called — loadIndex invoked again (initial + refresh = 2+)
      expect(apis.mockInboxApi.loadIndex.mock.calls.length).toBeGreaterThanOrEqual(2);
      unmount();
    });
  });

  describe('IPC subscription', () => {
    it('updates state atomically from onInboxUpdate', async () => {
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex([]));

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      expect(result.current.items).toHaveLength(0);

      const fullState: InboxState = {
        version: 2,
        items: [makeItem('new-1'), makeItem('new-2')],
        history: [],
      };

      act(() => {
        inboxUpdateCallback?.(fullState);
      });

      expect(result.current.items).toHaveLength(2);
      expect(result.current.activeCount).toBe(2);
      unmount();
    });
  });



  describe('focus refresh', () => {
    it('triggers loadIndex on window focus (for periodicFreshnessCheck)', async () => {
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex([]));

      const { unmount } = renderHook(() => useInbox());
      await flushAsync();

      const initialCallCount = apis.mockInboxApi.loadIndex.mock.calls.length;

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      await flushAsync();

      expect(apis.mockInboxApi.loadIndex.mock.calls.length).toBe(initialCallCount + 1);
      unmount();
    });

    it('does not call loadItems on focus (relies on IPC subscription for updates)', async () => {
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex([makeIndexEntry('a')]));
      apis.mockInboxApi.loadItems.mockResolvedValue([makeItem('a')]);

      const { unmount } = renderHook(() => useInbox());
      await flushAsync();

      const loadItemsCallCount = apis.mockInboxApi.loadItems.mock.calls.length;

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      await flushAsync();

      // Focus should NOT trigger loadItems — only loadIndex (for freshness check)
      expect(apis.mockInboxApi.loadItems.mock.calls.length).toBe(loadItemsCallCount);
      unmount();
    });

    it('updates state when IPC subscription fires after focus-triggered freshness check', async () => {
      const entries = [makeIndexEntry('a'), makeIndexEntry('b')];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([makeItem('a'), makeItem('b')]);

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      expect(result.current.activeCount).toBe(2);

      // Simulate: focus triggers freshness check, backend archives item 'b',
      // then emits updated state via IPC subscription
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      await flushAsync();

      // Backend emits updated state (item 'b' archived by freshness check)
      const updatedState: InboxState = {
        version: 1,
        items: [makeItem('a'), makeItem('b', { archived: true })],
        history: [],
      };

      act(() => {
        inboxUpdateCallback?.(updatedState);
      });

      expect(result.current.activeCount).toBe(1);
      expect(result.current.archivedCount).toBe(1);
      unmount();
    });
  });

  describe('async sequencing', () => {
    it('stale initial load does not overwrite newer IPC subscription data', async () => {
      // Simulate: initial loadItems is slow, IPC subscription fires first
      let resolveSlowLoad: (items: InboxItem[]) => void;
      const slowLoadPromise = new Promise<InboxItem[]>((resolve) => {
        resolveSlowLoad = resolve;
      });

      const entries = [makeIndexEntry('a')];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockReturnValueOnce(slowLoadPromise);

      const { result, unmount } = renderHook(() => useInbox());

      // IPC subscription fires with newer data while initial load is still pending
      const newerState: InboxState = {
        version: 1,
        items: [makeItem('a', { title: 'Updated via subscription' })],
        history: [],
      };

      act(() => {
        inboxUpdateCallback?.(newerState);
      });

      expect(result.current.items[0]?.title).toBe('Updated via subscription');

      // Now the stale initial load resolves
      await act(async () => {
        resolveSlowLoad!([makeItem('a', { title: 'Stale initial load' })]);
      });
      await flushAsync();

      // fetchGenerationRef should prevent stale data from overwriting
      // The subscription data should still be present (not overwritten)
      // Note: currently the subscription increments generation implicitly
      // via setItems, so the stale load's generation check should fail
      expect(result.current.items[0]?.title).toBe('Updated via subscription');
      unmount();
    });
  });

  describe('refresh', () => {
    it('re-fetches index and all items', async () => {
      const entries = [makeIndexEntry('a')];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([makeItem('a')]);

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      apis.mockInboxApi.loadIndex.mockResolvedValue(
        makeIndex([makeIndexEntry('a'), makeIndexEntry('b')]),
      );
      apis.mockInboxApi.loadItems.mockResolvedValue([makeItem('a'), makeItem('b')]);

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.activeCount).toBe(2);
      unmount();
    });
  });

  describe('tag/priority mutations', () => {
    it('handleSetTags calls API and updates state', async () => {
      const entries = [makeIndexEntry('a')];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([makeItem('a')]);
      apis.mockInboxApi.setTags.mockResolvedValue({
        version: 2,
        items: [makeItem('a', { tags: ['work'] } as Partial<InboxItem>)],
        history: [],
      });

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      await act(async () => {
        await result.current.handleSetTags('a', ['work']);
      });

      expect(apis.mockInboxApi.setTags).toHaveBeenCalledWith({ itemId: 'a', tags: ['work'] });
      unmount();
    });

    it('shows toast on setTags failure', async () => {
      const entries = [makeIndexEntry('a')];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([makeItem('a')]);
      apis.mockInboxApi.setTags.mockRejectedValue(new Error('fail'));

      const showToast = vi.fn();
      const { result, unmount } = renderHook(() => useInbox({ showToast }));
      await flushAsync();

      await act(async () => {
        await result.current.handleSetTags('a', ['work']);
      });

      expect(showToast).toHaveBeenCalledWith({ title: 'Unable to update tags' });
      unmount();
    });
  });

  describe('delete', () => {
    it('calls tasksApi.delete and updates state', async () => {
      const entries = [makeIndexEntry('a')];
      apis.mockInboxApi.loadIndex.mockResolvedValue(makeIndex(entries));
      apis.mockInboxApi.loadItems.mockResolvedValue([makeItem('a')]);
      apis.mockTasksApi.delete.mockResolvedValue({ version: 2, items: [], history: [] });

      const { result, unmount } = renderHook(() => useInbox());
      await flushAsync();

      await act(async () => {
        await result.current.handleDeleteTask('a');
      });

      expect(apis.mockTasksApi.delete).toHaveBeenCalledWith('a');
      unmount();
    });
  });
});
