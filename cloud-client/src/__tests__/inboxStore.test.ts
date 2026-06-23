/**
 * inboxStore tests — fetchInbox, addItem, deleteItem, archiveItem, executeItem, event handling.
 */

import { useInboxStore } from '../stores/inboxStore';
import type { InboxItem, InboxHistoryEntry, InboxState } from '../types';

vi.mock('../cloudClient', async () => {
  const actual = await vi.importActual<typeof import('../cloudClient')>('../cloudClient');
  return {
    ...actual,
    ipcCall: vi.fn(),
  };
});

vi.mock('../persistence/persistenceHelpers', async () => {
  const actual = await vi.importActual<typeof import('../persistence/persistenceHelpers')>('../persistence/persistenceHelpers');
  return {
    ...actual,
    buildCacheKey: vi.fn((_cloudUrl: string, storeName: string) => `cache:${storeName}`),
    hydrateStore: vi.fn(),
    persistStore: vi.fn(),
  };
});

import * as cloudClient from '../cloudClient';
import * as persistenceHelpers from '../persistence/persistenceHelpers';
const mockedIpcCall = vi.mocked(cloudClient.ipcCall);
const mockedBuildCacheKey = vi.mocked(persistenceHelpers.buildCacheKey);
const mockedHydrateStore = vi.mocked(persistenceHelpers.hydrateStore);
const mockedPersistStore = vi.mocked(persistenceHelpers.persistStore);

function mockItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: 'Test item',
    text: 'Some text',
    addedAt: Date.now(),
    references: [],
    ...overrides,
  };
}

function mockHistoryEntry(overrides: Partial<InboxHistoryEntry> = {}): InboxHistoryEntry {
  return {
    ...mockItem(),
    archived: true,
    archivedAt: Date.now(),
    executedAt: Date.now(),
    sessionId: 'session-1',
    mode: 'execute',
    ...overrides,
  };
}

function mockState(overrides: Partial<InboxState> = {}): InboxState {
  return {
    version: 1,
    items: [],
    history: [],
    ...overrides,
  };
}

beforeEach(() => {
  useInboxStore.getState().resetStore();
  mockedIpcCall.mockClear();
  mockedBuildCacheKey.mockClear();
  mockedBuildCacheKey.mockImplementation((_cloudUrl: string, storeName: string) => `cache:${storeName}`);
  mockedHydrateStore.mockClear();
  mockedHydrateStore.mockResolvedValue(null);
  mockedPersistStore.mockClear();
});

describe('inboxStore', () => {
  describe('initial state', () => {
    it('has empty items and history, isLoading false, error null', () => {
      const state = useInboxStore.getState();
      expect(state.items).toEqual([]);
      expect(state.history).toEqual([]);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe('persistence', () => {
    it('hydrates cached inbox data and sets cache key', async () => {
      const cachedItems = [mockItem({ id: 'cached-item' })];
      const cachedHistory = [mockHistoryEntry({ id: 'cached-history' })];
      mockedBuildCacheKey.mockReturnValueOnce('cache:inbox');
      mockedHydrateStore.mockResolvedValueOnce({ items: cachedItems, history: cachedHistory });

      await useInboxStore.getState().hydrate('https://cloud.example.com');

      expect(mockedBuildCacheKey).toHaveBeenCalledWith('https://cloud.example.com', 'inbox');
      expect(mockedHydrateStore).toHaveBeenCalledWith('cache:inbox', expect.any(Function));
      expect(useInboxStore.getState()._cacheKey).toBe('cache:inbox');
      expect(useInboxStore.getState().items).toEqual(cachedItems);
      expect(useInboxStore.getState().history).toEqual(cachedHistory);
    });

    it('persists fetch results when cache key is available', async () => {
      const items = [mockItem({ id: 'persist-item' })];
      const history = [mockHistoryEntry({ id: 'persist-history' })];
      useInboxStore.setState({ _cacheKey: 'cache:inbox' });
      mockedIpcCall.mockResolvedValueOnce(mockState({ items, history }));

      await useInboxStore.getState().fetchInbox();

      expect(mockedPersistStore).toHaveBeenCalledWith('cache:inbox', { items, history });
    });

    it('does not persist fetch results when cache key is missing', async () => {
      mockedIpcCall.mockResolvedValueOnce(mockState({ items: [mockItem({ id: 'item-1' })], history: [] }));

      await useInboxStore.getState().fetchInbox();

      expect(mockedPersistStore).not.toHaveBeenCalled();
    });

    it('persists event payload updates when cache key is available', () => {
      const items = [mockItem({ id: 'event-item' })];
      const history = [mockHistoryEntry({ id: 'event-history' })];
      useInboxStore.setState({ _cacheKey: 'cache:inbox' });

      useInboxStore.getState().handleInboxEvent([{ items, history }]);

      expect(mockedPersistStore).toHaveBeenCalledWith('cache:inbox', { items, history });
    });

    it('resets store state to initial values', () => {
      useInboxStore.setState({
        items: [mockItem({ id: 'reset-me' })],
        history: [mockHistoryEntry({ id: 'history-reset' })],
        isLoading: true,
        error: 'bad',
        _cacheKey: 'cache:inbox',
      });

      useInboxStore.getState().resetStore();

      const state = useInboxStore.getState();
      expect(state.items).toEqual([]);
      expect(state.history).toEqual([]);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
      expect(state._cacheKey).toBeNull();
    });
  });

  describe('fetchInbox', () => {
    it('calls ipcCall with inbox:load and sets items and history on success', async () => {
      const items = [mockItem({ id: 'i1' }), mockItem({ id: 'i2' })];
      const history = [mockHistoryEntry({ id: 'h1' })];
      mockedIpcCall.mockResolvedValueOnce(mockState({ items, history }));

      await useInboxStore.getState().fetchInbox();

      expect(mockedIpcCall).toHaveBeenCalledWith('inbox:load');
      const state = useInboxStore.getState();
      expect(state.items).toHaveLength(2);
      expect(state.items[0].id).toBe('i1');
      expect(state.history).toHaveLength(1);
      expect(state.history[0].id).toBe('h1');
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('sets error on failure', async () => {
      mockedIpcCall.mockRejectedValueOnce(new Error('Network error'));

      await useInboxStore.getState().fetchInbox();

      const state = useInboxStore.getState();
      expect(state.error).toBe('Network error');
      expect(state.isLoading).toBe(false);
    });

    it('uses fallback error message for non-Error rejections', async () => {
      mockedIpcCall.mockRejectedValueOnce('something broke');

      await useInboxStore.getState().fetchInbox();

      expect(useInboxStore.getState().error).toBe('Failed to load actions');
    });

    it('sets isLoading during fetch', async () => {
      let resolvePromise: (v: unknown) => void;
      const pending = new Promise((r) => { resolvePromise = r; });
      mockedIpcCall.mockReturnValue(pending as Promise<unknown>);

      const fetchPromise = useInboxStore.getState().fetchInbox();
      expect(useInboxStore.getState().isLoading).toBe(true);

      resolvePromise!(mockState());
      await fetchPromise;
      expect(useInboxStore.getState().isLoading).toBe(false);
    });

    it('handles null response gracefully', async () => {
      mockedIpcCall.mockResolvedValueOnce(null);

      await useInboxStore.getState().fetchInbox();

      const state = useInboxStore.getState();
      expect(state.items).toEqual([]);
      expect(state.history).toEqual([]);
      expect(state.isLoading).toBe(false);
    });
  });

  describe('addItem', () => {
    it('calls ipcCall with inbox:add and updates state from response', async () => {
      const newItem = mockItem({ id: 'new-1', title: 'New task' });
      mockedIpcCall.mockResolvedValueOnce(mockState({ items: [newItem] }));

      await useInboxStore.getState().addItem('New task', 'Some description');

      expect(mockedIpcCall).toHaveBeenCalledWith('inbox:add', { title: 'New task', text: 'Some description' });
      const state = useInboxStore.getState();
      expect(state.items).toHaveLength(1);
      expect(state.items[0].title).toBe('New task');
      expect(state.error).toBeNull();
    });

    it('calls ipcCall with inbox:add with only title (no text)', async () => {
      mockedIpcCall.mockResolvedValueOnce(mockState({ items: [mockItem({ id: 'new-1' })] }));

      await useInboxStore.getState().addItem('Title only');

      expect(mockedIpcCall).toHaveBeenCalledWith('inbox:add', { title: 'Title only', text: undefined });
    });

    it('sets error on failure', async () => {
      mockedIpcCall.mockRejectedValueOnce(new Error('Add failed'));

      await useInboxStore.getState().addItem('Test', 'desc');

      expect(useInboxStore.getState().error).toBe('Add failed');
    });

    it('uses fallback error message for non-Error rejections', async () => {
      mockedIpcCall.mockRejectedValueOnce(42);

      await useInboxStore.getState().addItem('Test');

      expect(useInboxStore.getState().error).toBe('Failed to add item');
    });

    it('clears previous error on success', async () => {
      useInboxStore.setState({ error: 'old error' });
      mockedIpcCall.mockResolvedValueOnce(mockState());

      await useInboxStore.getState().addItem('Test');

      expect(useInboxStore.getState().error).toBeNull();
    });
  });

  describe('deleteItem', () => {
    it('calls ipcCall with inbox:delete and updates state from response', async () => {
      useInboxStore.setState({ items: [mockItem({ id: 'del-1' }), mockItem({ id: 'del-2' })] });
      mockedIpcCall.mockResolvedValueOnce(mockState({ items: [mockItem({ id: 'del-2' })] }));

      await useInboxStore.getState().deleteItem('del-1');

      expect(mockedIpcCall).toHaveBeenCalledWith('inbox:delete', 'del-1');
      expect(useInboxStore.getState().items).toHaveLength(1);
      expect(useInboxStore.getState().items[0].id).toBe('del-2');
    });

    it('sets error on failure', async () => {
      mockedIpcCall.mockRejectedValueOnce(new Error('Delete failed'));

      await useInboxStore.getState().deleteItem('del-1');

      expect(useInboxStore.getState().error).toBe('Delete failed');
    });

    it('uses fallback error message for non-Error rejections', async () => {
      mockedIpcCall.mockRejectedValueOnce(undefined);

      await useInboxStore.getState().deleteItem('del-1');

      expect(useInboxStore.getState().error).toBe('Failed to delete item');
    });
  });

  describe('archiveItem', () => {
    it('calls ipcCall with inbox:set-archived and updates state', async () => {
      const item = mockItem({ id: 'arc-1' });
      useInboxStore.setState({ items: [item] });
      mockedIpcCall.mockResolvedValueOnce(mockState({ items: [{ ...item, archived: true }] }));

      await useInboxStore.getState().archiveItem('arc-1', true);

      expect(mockedIpcCall).toHaveBeenCalledWith('inbox:set-archived', { itemId: 'arc-1', archived: true });
      expect(useInboxStore.getState().items[0].archived).toBe(true);
    });

    it('can unarchive an item', async () => {
      const item = mockItem({ id: 'arc-1', archived: true });
      useInboxStore.setState({ items: [item] });
      mockedIpcCall.mockResolvedValueOnce(mockState({ items: [{ ...item, archived: false }] }));

      await useInboxStore.getState().archiveItem('arc-1', false);

      expect(mockedIpcCall).toHaveBeenCalledWith('inbox:set-archived', { itemId: 'arc-1', archived: false });
    });

    it('sets error on failure', async () => {
      mockedIpcCall.mockRejectedValueOnce(new Error('Archive failed'));

      await useInboxStore.getState().archiveItem('arc-1', true);

      expect(useInboxStore.getState().error).toBe('Archive failed');
    });

    it('uses fallback error message for non-Error rejections', async () => {
      mockedIpcCall.mockRejectedValueOnce(null);

      await useInboxStore.getState().archiveItem('arc-1', true);

      expect(useInboxStore.getState().error).toBe('Failed to archive item');
    });
  });

  describe('executeItem', () => {
    it('calls ipcCall with inbox:execute and returns sessionId + prompt', async () => {
      mockedIpcCall.mockResolvedValueOnce({ sessionId: 'sess-123', prompt: 'Do the thing', success: true });

      const result = await useInboxStore.getState().executeItem('exec-1');

      expect(mockedIpcCall).toHaveBeenCalledWith('inbox:execute', { itemId: 'exec-1' });
      expect(result).toEqual({ sessionId: 'sess-123', prompt: 'Do the thing' });
    });

    it('passes context to ipcCall when provided', async () => {
      mockedIpcCall.mockResolvedValueOnce({ sessionId: 'sess-456', prompt: 'Task\n\n**Additional instructions from user:**\nBe concise', success: true });

      const result = await useInboxStore.getState().executeItem('exec-2', 'Be concise');

      expect(mockedIpcCall).toHaveBeenCalledWith('inbox:execute', { itemId: 'exec-2', context: 'Be concise' });
      expect(result).toEqual({ sessionId: 'sess-456', prompt: 'Task\n\n**Additional instructions from user:**\nBe concise' });
    });

    it('omits context from payload when not provided', async () => {
      mockedIpcCall.mockResolvedValueOnce({ sessionId: 'sess-789', prompt: 'Plain task', success: true });

      await useInboxStore.getState().executeItem('exec-3');

      expect(mockedIpcCall).toHaveBeenCalledWith('inbox:execute', { itemId: 'exec-3' });
    });

    it('throws on failure and sets error', async () => {
      mockedIpcCall.mockRejectedValueOnce(new Error('Execution failed'));

      await expect(useInboxStore.getState().executeItem('exec-1')).rejects.toThrow('Execution failed');
      expect(useInboxStore.getState().error).toBe('Execution failed');
    });

    it('uses fallback error message for non-Error rejections', async () => {
      mockedIpcCall.mockRejectedValueOnce('oops');

      await expect(useInboxStore.getState().executeItem('exec-1')).rejects.toBe('oops');
      expect(useInboxStore.getState().error).toBe('Failed to execute item');
    });
  });

  describe('handleInboxEvent', () => {
    it('replaces state with broadcast payload', () => {
      const items = [mockItem({ id: 'e1' }), mockItem({ id: 'e2' })];
      const history = [mockHistoryEntry({ id: 'eh1' })];

      useInboxStore.getState().handleInboxEvent([{ items, history }]);

      const state = useInboxStore.getState();
      expect(state.items).toHaveLength(2);
      expect(state.items[0].id).toBe('e1');
      expect(state.history).toHaveLength(1);
      expect(state.history[0].id).toBe('eh1');
    });

    it('handles payload with items but no history', () => {
      const items = [mockItem({ id: 'e1' })];

      useInboxStore.getState().handleInboxEvent([{ items }]);

      const state = useInboxStore.getState();
      expect(state.items).toHaveLength(1);
      expect(state.history).toEqual([]);
    });

    it('ignores empty args array', () => {
      useInboxStore.setState({ items: [mockItem({ id: 'existing' })] });

      useInboxStore.getState().handleInboxEvent([]);

      expect(useInboxStore.getState().items).toHaveLength(1);
      expect(useInboxStore.getState().items[0].id).toBe('existing');
    });

    it('ignores undefined payload', () => {
      useInboxStore.setState({ items: [mockItem({ id: 'existing' })] });

      useInboxStore.getState().handleInboxEvent([undefined]);

      expect(useInboxStore.getState().items).toHaveLength(1);
    });

    it('ignores payload without items array', () => {
      useInboxStore.setState({ items: [mockItem({ id: 'existing' })] });

      useInboxStore.getState().handleInboxEvent([{ notItems: 'bad' }]);

      expect(useInboxStore.getState().items).toHaveLength(1);
    });

    it('ignores payload where items is not an array', () => {
      useInboxStore.setState({ items: [mockItem({ id: 'existing' })] });

      useInboxStore.getState().handleInboxEvent([{ items: 'not-array' }]);

      expect(useInboxStore.getState().items).toHaveLength(1);
    });

    it('replaces full state, not merging', () => {
      useInboxStore.setState({ items: [mockItem({ id: 'old-1' }), mockItem({ id: 'old-2' })] });

      const newItems = [mockItem({ id: 'new-1' })];
      useInboxStore.getState().handleInboxEvent([{ items: newItems, history: [] }]);

      expect(useInboxStore.getState().items).toHaveLength(1);
      expect(useInboxStore.getState().items[0].id).toBe('new-1');
    });
  });
});
