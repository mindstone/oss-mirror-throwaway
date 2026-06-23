// cloud-client/src/stores/inboxStore.ts

import { create } from 'zustand';
import * as cloudClient from '../cloudClient';
import type { InboxItem, InboxHistoryEntry, InboxState, InboxItemStatus, InboxDismissReasonCategory } from '../types';
import { buildCacheKey, hydrateStore, persistStore } from '../persistence/persistenceHelpers';

function isValidInboxItem(data: unknown): data is InboxItem {
  if (!data || typeof data !== 'object') return false;
  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.text === 'string' &&
    typeof candidate.addedAt === 'number' &&
    Number.isFinite(candidate.addedAt) &&
    Array.isArray(candidate.references)
  );
}

function isValidInboxHistoryEntry(data: unknown): data is InboxHistoryEntry {
  if (!isValidInboxItem(data)) return false;
  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate.executedAt === 'number' &&
    Number.isFinite(candidate.executedAt) &&
    typeof candidate.sessionId === 'string' &&
    (candidate.mode === 'execute' || candidate.mode === 'execute_with_context')
  );
}

function validateCachedInbox(data: unknown): { items: InboxItem[]; history: InboxHistoryEntry[] } | null {
  if (!data || typeof data !== 'object') return null;

  const candidate = data as Record<string, unknown>;
  if (!Array.isArray(candidate.items) || !Array.isArray(candidate.history)) {
    return null;
  }

  if (!candidate.items.every(isValidInboxItem)) {
    return null;
  }

  if (!candidate.history.every(isValidInboxHistoryEntry)) {
    return null;
  }

  return {
    items: candidate.items as InboxItem[],
    history: candidate.history as InboxHistoryEntry[],
  };
}

interface InboxStoreState {
  items: InboxItem[];
  history: InboxHistoryEntry[];
  isLoading: boolean;
  error: string | null;
  _cacheKey: string | null;

  hydrate: (cloudUrl: string) => Promise<void>;
  fetchInbox: () => Promise<void>;
  addItem: (title: string, text?: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  archiveItem: (id: string, archived: boolean) => Promise<void>;
  snoozeItem: (itemId: string, newDueBy: number | null) => Promise<void>;
  setQuadrant: (itemId: string, urgent: boolean, important: boolean) => Promise<void>;
  setStatus: (
    itemId: string,
    status: InboxItemStatus,
    completedBy?: 'user' | 'rebel',
    reason?: { category?: InboxDismissReasonCategory; text?: string },
  ) => Promise<void>;
  setTags: (itemId: string, tags: string[]) => Promise<void>;
  executeItem: (itemId: string, context?: string) => Promise<{ sessionId: string; prompt: string }>;
  handleInboxEvent: (args: unknown[]) => void;
  resetStore: () => void;
}

function getInitialInboxStoreState(): Pick<InboxStoreState, 'items' | 'history' | 'isLoading' | 'error' | '_cacheKey'> {
  return {
    items: [],
    history: [],
    isLoading: false,
    error: null,
    _cacheKey: null,
  };
}

export const useInboxStore = create<InboxStoreState>((set, get) => ({
  ...getInitialInboxStoreState(),

  hydrate: async (cloudUrl: string) => {
    const cacheKey = buildCacheKey(cloudUrl, 'inbox');
    set({ _cacheKey: cacheKey });

    const cachedInbox = await hydrateStore(cacheKey, validateCachedInbox);
    if (cachedInbox !== null) {
      set({ items: cachedInbox.items, history: cachedInbox.history });
    }
  },

  fetchInbox: async () => {
    set({ isLoading: true, error: null });
    try {
      const state = await cloudClient.ipcCall<InboxState>('inbox:load');
      const items = state?.items ?? [];
      const history = state?.history ?? [];
      set({
        items,
        history,
        isLoading: false,
      });
      const cacheKey = get()._cacheKey;
      if (cacheKey) {
        persistStore(cacheKey, { items, history });
      }
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load actions',
      });
    }
  },

  addItem: async (title: string, text?: string) => {
    try {
      const state = await cloudClient.ipcCall<InboxState>('inbox:add', { title, text });
      const items = state?.items ?? [];
      const history = state?.history ?? [];
      set({
        items,
        history,
        error: null,
      });
      const cacheKey = get()._cacheKey;
      if (cacheKey) {
        persistStore(cacheKey, { items, history });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to add item' });
    }
  },

  deleteItem: async (id: string) => {
    try {
      const state = await cloudClient.ipcCall<InboxState>('inbox:delete', id);
      const items = state?.items ?? [];
      const history = state?.history ?? [];
      set({
        items,
        history,
        error: null,
      });
      const cacheKey = get()._cacheKey;
      if (cacheKey) {
        persistStore(cacheKey, { items, history });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete item' });
    }
  },

  archiveItem: async (id: string, archived: boolean) => {
    try {
      const state = await cloudClient.ipcCall<InboxState>('inbox:set-archived', { itemId: id, archived });
      const items = state?.items ?? [];
      const history = state?.history ?? [];
      set({
        items,
        history,
        error: null,
      });
      const cacheKey = get()._cacheKey;
      if (cacheKey) {
        persistStore(cacheKey, { items, history });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to archive item' });
    }
  },

  snoozeItem: async (itemId: string, newDueBy: number | null) => {
    try {
      const state = await cloudClient.ipcCall<InboxState>('inbox:set-dueBy', { itemId, dueBy: newDueBy });
      const items = state?.items ?? [];
      const history = state?.history ?? [];
      set({
        items,
        history,
        error: null,
      });
      const cacheKey = get()._cacheKey;
      if (cacheKey) {
        persistStore(cacheKey, { items, history });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to snooze item' });
    }
  },

  setQuadrant: async (itemId: string, urgent: boolean, important: boolean) => {
    try {
      const state = await cloudClient.ipcCall<InboxState>('inbox:set-quadrant', { itemId, urgent, important });
      const items = state?.items ?? [];
      const history = state?.history ?? [];
      set({
        items,
        history,
        error: null,
      });
      const cacheKey = get()._cacheKey;
      if (cacheKey) {
        persistStore(cacheKey, { items, history });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to set priority' });
    }
  },

  setStatus: async (
    itemId: string,
    status: InboxItemStatus,
    completedBy?: 'user' | 'rebel',
    reason?: { category?: InboxDismissReasonCategory; text?: string },
  ) => {
    try {
      const dismissedReason = reason?.text?.trim();
      const state = await cloudClient.ipcCall<InboxState>('inbox:set-status', {
        itemId,
        status,
        ...(completedBy ? { completedBy } : {}),
        ...(reason?.category ? { dismissedReasonCategory: reason.category } : {}),
        ...(dismissedReason ? { dismissedReason } : {}),
      });
      const items = state?.items ?? [];
      const history = state?.history ?? [];
      set({
        items,
        history,
        error: null,
      });
      const cacheKey = get()._cacheKey;
      if (cacheKey) {
        persistStore(cacheKey, { items, history });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to set status' });
    }
  },

  setTags: async (itemId: string, tags: string[]) => {
    try {
      const state = await cloudClient.ipcCall<InboxState>('inbox:set-tags', { itemId, tags });
      const items = state?.items ?? [];
      const history = state?.history ?? [];
      set({
        items,
        history,
        error: null,
      });
      const cacheKey = get()._cacheKey;
      if (cacheKey) {
        persistStore(cacheKey, { items, history });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to set tags' });
    }
  },

  executeItem: async (itemId: string, context?: string) => {
    try {
      const result = await cloudClient.ipcCall<{ sessionId: string; prompt: string; success: boolean }>(
        'inbox:execute',
        { itemId, ...(context ? { context } : {}) },
      );
      return { sessionId: result.sessionId, prompt: result.prompt };
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to execute item' });
      throw err;
    }
  },

  handleInboxEvent: (args: unknown[]) => {
    const payload = args[0] as InboxState | undefined;
    if (payload && Array.isArray(payload.items)) {
      const items = payload.items;
      const history = payload.history ?? [];
      set({
        items,
        history,
      });
      const cacheKey = get()._cacheKey;
      if (cacheKey) {
        persistStore(cacheKey, { items, history });
      }
    }
  },

  resetStore: () => set(getInitialInboxStoreState()),
}));
