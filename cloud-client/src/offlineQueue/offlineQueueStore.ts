// cloud-client/src/offlineQueue/offlineQueueStore.ts

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import { OfflineQueue } from './OfflineQueue';
import type { OfflineQueueConfig } from './OfflineQueue';
import type { QueueItem, QueueStorageAdapter, QueueConsumer, QueueItemType, QueueFullRejection, DrainOptions, DrainSummary } from './types';
import { QueueFullError } from './errors';
import { createLogger } from '../utils/logger';

const log = createLogger('offlineQueueStore');

export interface OfflineQueueState {
  items: QueueItem[];
  isDraining: boolean;
  isInitialized: boolean;
  queueFullAt: number | null;
  limitedConnectivityAt: number | null;
  authExpiredAt: number | null;
  boundCloudUrl: string | null;
  init: () => Promise<void>;
  enqueue: (
    type: QueueItemType,
    sourceUri: string | null,
    ext: string | null,
    metadata: Record<string, unknown>,
    boundCloudUrl?: string,
  ) => Promise<QueueItem | QueueFullRejection>;
  /** Like `enqueue`, but throws `QueueFullError` instead of returning a rejection object. */
  enqueueOrThrow: (
    type: QueueItemType,
    sourceUri: string | null,
    ext: string | null,
    metadata: Record<string, unknown>,
    boundCloudUrl?: string,
  ) => Promise<QueueItem>;
  /** Enqueue an item with a JSON payload (e.g., text-with-attachments). */
  enqueueWithJsonPayload: (
    type: QueueItemType,
    jsonPayload: unknown,
    metadata: Record<string, unknown>,
    boundCloudUrl?: string,
  ) => Promise<QueueItem | QueueFullRejection>;
  /** Like `enqueueWithJsonPayload`, but throws `QueueFullError` on rejection. */
  enqueueWithJsonPayloadOrThrow: (
    type: QueueItemType,
    jsonPayload: unknown,
    metadata: Record<string, unknown>,
    boundCloudUrl?: string,
  ) => Promise<QueueItem>;
  /** Load a JSON payload for a queue item. */
  loadJsonPayload: <T = unknown>(id: string) => Promise<T | null>;
  /**
   * Drain the queue. Pass optional `DrainOptions` to limit the drain to
   * a time budget, specific item types, or a shorter per-item timeout —
   * used by iOS/Android background drain tasks.
   * Returns a `DrainSummary` describing the outcome.
   */
  drain: (isOnline: boolean, options?: DrainOptions) => Promise<DrainSummary>;
  retryItem: (id: string) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  bindAuthIdentity: (cloudUrl: string | null) => void;
}

type OfflineQueueStore = UseBoundStore<StoreApi<OfflineQueueState>>;

let _store: OfflineQueueStore | null = null;
let _queue: OfflineQueue | null = null;

function getStore(): OfflineQueueStore {
  if (!_store) {
    throw new Error(
      'Offline queue store not initialised. Call initOfflineQueueStore() at app startup.',
    );
  }
  return _store;
}

/**
 * Initialise the offline queue store with a platform-specific storage adapter
 * and a consumer callback. Must be called once at app startup before any
 * component subscribes.
 *
 * The queue class manages all business logic (enqueue, drain, backoff, lifecycle).
 * The store syncs state from the queue for React subscribers.
 */
export function initOfflineQueueStore(
  storage: QueueStorageAdapter,
  consumer: QueueConsumer,
  config?: OfflineQueueConfig,
): OfflineQueueStore {
  const queue = new OfflineQueue(storage, consumer, config);
  _queue = queue;

  _store = create<OfflineQueueState>((set) => {
    // Subscribe to queue state changes so Zustand subscribers get updates.
    queue.subscribe((_items, stateSnapshot) => {
      set({
        items: stateSnapshot?.items ?? [..._items],
        isDraining: queue.getIsDraining(),
        queueFullAt: stateSnapshot?.queueFullAt ?? null,
        limitedConnectivityAt: stateSnapshot?.limitedConnectivityAt ?? null,
        authExpiredAt: stateSnapshot?.authExpiredAt ?? null,
        boundCloudUrl: stateSnapshot?.boundCloudUrl ?? null,
      });
    });

    return {
      items: [],
      isDraining: false,
      isInitialized: false,
      queueFullAt: null,
      limitedConnectivityAt: null,
      authExpiredAt: null,
      boundCloudUrl: null,

      init: async () => {
        try {
          await queue.init();
          set({ isInitialized: true, items: queue.getItems() });
          log.info('Queue store initialized');
        } catch (err) {
          log.error('Queue init failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          // Mark initialized so the rest of the store is usable (e.g. can still
          // enqueue into the in-memory list), but rethrow so callers that need
          // to escalate — like the background drain task — can see the failure.
          // Foreground callers (see `mobile/app/_layout.tsx`) already wrap this
          // call in a try/catch and treat init failure as non-fatal.
          set({ isInitialized: true });
          throw err;
        }
      },

      enqueue: async (type, sourceUri, ext, metadata, boundCloudUrl) => {
        return queue.enqueue(type, sourceUri, ext, metadata, boundCloudUrl);
      },

      enqueueOrThrow: async (type, sourceUri, ext, metadata, boundCloudUrl) => {
        const result = await queue.enqueue(type, sourceUri, ext, metadata, boundCloudUrl);
        if ('accepted' in result && (result as QueueFullRejection).accepted === false) {
          throw new QueueFullError((result as QueueFullRejection).maxSize);
        }
        return result as QueueItem;
      },

      enqueueWithJsonPayload: async (type, jsonPayload, metadata, boundCloudUrl) => {
        return queue.enqueueWithJsonPayload(type, jsonPayload, metadata, boundCloudUrl);
      },

      enqueueWithJsonPayloadOrThrow: async (type, jsonPayload, metadata, boundCloudUrl) => {
        const result = await queue.enqueueWithJsonPayload(type, jsonPayload, metadata, boundCloudUrl);
        if ('accepted' in result && (result as QueueFullRejection).accepted === false) {
          throw new QueueFullError((result as QueueFullRejection).maxSize);
        }
        return result as QueueItem;
      },

      loadJsonPayload: async <T = unknown>(id: string) => {
        return queue.loadJsonPayload<T>(id);
      },

      drain: async (isOnline, options) => {
        return queue.drain(isOnline, options);
      },

      retryItem: async (id) => {
        await queue.retryItem(id);
      },

      removeItem: async (id) => {
        await queue.removeItem(id);
      },

      clearAll: async () => {
        await queue.clearAll();
      },

      bindAuthIdentity: (cloudUrl) => {
        queue.bindAuthIdentity(cloudUrl);
      },
    };
  });

  return _store;
}

/**
 * Access the offline queue store. Throws if `initOfflineQueueStore()` has not been called.
 *
 * Usage:
 *   As a React hook:   `const items = useOfflineQueueStore(s => s.items)`
 *   Static access:     `useOfflineQueueStore.getState().drain(true)`
 *   Subscribe:         `useOfflineQueueStore.subscribe(listener)`
 */
export const useOfflineQueueStore: {
  (): OfflineQueueState;
  <T>(selector: (state: OfflineQueueState) => T): T;
  getState: () => OfflineQueueState;
  setState: (
    partial:
      | Partial<OfflineQueueState>
      | ((state: OfflineQueueState) => Partial<OfflineQueueState>),
  ) => void;
  subscribe: (
    listener: (state: OfflineQueueState, prevState: OfflineQueueState) => void,
  ) => () => void;
} = Object.assign(
  function useOfflineQueueStore<T>(
    selector?: (state: OfflineQueueState) => T,
  ): T | OfflineQueueState {
    const store = getStore();
    if (selector) return store(selector);
    return store();
  },
  {
    getState: (): OfflineQueueState => getStore().getState(),
    setState: (
      partial:
        | Partial<OfflineQueueState>
        | ((state: OfflineQueueState) => Partial<OfflineQueueState>),
    ) => getStore().setState(partial),
    subscribe: (
      listener: (state: OfflineQueueState, prevState: OfflineQueueState) => void,
    ) => getStore().subscribe(listener),
  },
) as never;

/**
 * Reset the offline queue store and underlying queue instance.
 * **Test-only** — do not call in production code.
 */
export function _resetOfflineQueueStore(): void {
  _store = null;
  _queue = null;
}
