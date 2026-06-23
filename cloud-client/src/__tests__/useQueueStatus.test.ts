import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useQueueStatus } from '../offlineQueue/useQueueStatus';
import type { QueueStatusInputs } from '../offlineQueue/useQueueStatus';
import { initOfflineQueueStore, _resetOfflineQueueStore, useOfflineQueueStore } from '../offlineQueue/offlineQueueStore';
import type { QueueItem, QueueStorageAdapter, QueueConsumerResult } from '../offlineQueue/types';

// ---------------------------------------------------------------------------
// In-memory mock storage adapter (mirrors offlineQueue.test.ts)
// ---------------------------------------------------------------------------

class InMemoryStorage implements QueueStorageAdapter {
  items: QueueItem[] = [];
  payloads: Map<string, string> = new Map();
  jsonPayloads: Map<string, unknown> = new Map();

  async saveSnapshot(items: QueueItem[]): Promise<void> {
    this.items = JSON.parse(JSON.stringify(items));
  }
  async loadSnapshot(): Promise<QueueItem[]> {
    return JSON.parse(JSON.stringify(this.items));
  }
  async savePayloadFromUri(id: string, _sourceUri: string, ext: string): Promise<string> {
    const uri = `persisted://${id}.${ext}`;
    this.payloads.set(id, uri);
    return uri;
  }
  async getPayloadUri(id: string): Promise<string | null> {
    return this.payloads.get(id) ?? null;
  }
  async deletePayload(id: string): Promise<void> {
    this.payloads.delete(id);
  }
  async listPayloadIds(): Promise<string[]> {
    return Array.from(new Set([...this.payloads.keys(), ...this.jsonPayloads.keys()]));
  }
  async saveJsonPayload(id: string, payload: unknown): Promise<void> {
    this.jsonPayloads.set(id, JSON.parse(JSON.stringify(payload)));
  }
  async loadJsonPayload<T = unknown>(id: string): Promise<T | null> {
    const data = this.jsonPayloads.get(id);
    return data !== undefined ? (JSON.parse(JSON.stringify(data)) as T) : null;
  }
  async deleteJsonPayload(id: string): Promise<void> {
    this.jsonPayloads.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopConsumer = async (): Promise<QueueConsumerResult> => ({ success: true });

const ONLINE: QueueStatusInputs = {
  isOnline: true,
  isInternetReachable: true,
  wsReconnecting: false,
};

const OFFLINE: QueueStatusInputs = {
  isOnline: false,
  isInternetReachable: false,
  wsReconnecting: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useQueueStatus', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    _resetOfflineQueueStore();
    storage = new InMemoryStorage();
    initOfflineQueueStore(storage, noopConsumer);
  });

  afterEach(() => {
    _resetOfflineQueueStore();
  });

  it('returns online-live when online and queue is empty', () => {
    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.state).toBe('online-live');
    expect(result.current.shouldShowBanner).toBe(false);
    expect(result.current.totalPending).toBe(0);
    expect(result.current.totalFailed).toBe(0);
    expect(result.current.oldestEnqueuedAt).toBeNull();
    expect(result.current.lastErrorCategory).toBeNull();
    expect(result.current.hasPermanentFailures).toBe(false);
  });

  it('returns offline-empty when offline and queue is empty', () => {
    const { result } = renderHook(() => useQueueStatus(OFFLINE));

    expect(result.current.state).toBe('offline-empty');
    expect(result.current.shouldShowBanner).toBe(true);
    expect(result.current.totalPending).toBe(0);
  });

  it('returns offline-queued when offline and queue has items', async () => {
    const store = initOfflineQueueStore(storage, noopConsumer);
    _resetOfflineQueueStore();
    // Re-init to get a clean store
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'item-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 1000,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      },
    ];
    const store2 = initOfflineQueueStore(freshStorage, noopConsumer);
    await store2.getState().init();

    const { result } = renderHook(() => useQueueStatus(OFFLINE));

    expect(result.current.state).toBe('offline-queued');
    expect(result.current.shouldShowBanner).toBe(true);
    expect(result.current.totalPending).toBe(1);
    expect(result.current.oldestEnqueuedAt).toBe(1000);
  });

  it('returns online-draining when online and queue has items', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'item-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 2000,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.state).toBe('online-draining');
    expect(result.current.shouldShowBanner).toBe(true);
    expect(result.current.totalPending).toBe(1);
  });

  it('returns reconnecting when wsReconnecting is true', () => {
    const inputs: QueueStatusInputs = {
      isOnline: true,
      isInternetReachable: true,
      wsReconnecting: true,
    };

    const { result } = renderHook(() => useQueueStatus(inputs));

    expect(result.current.state).toBe('reconnecting');
    expect(result.current.shouldShowBanner).toBe(true);
  });

  it('returns offline-queued when isInternetReachable is false even if isOnline', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'item-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 3000,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    const inputs: QueueStatusInputs = {
      isOnline: true,
      isInternetReachable: false,
    };

    const { result } = renderHook(() => useQueueStatus(inputs));

    expect(result.current.state).toBe('offline-queued');
    expect(result.current.shouldShowBanner).toBe(true);
  });

  it('returns limited when limitedConnectivityAt is set', () => {
    // Simulate limited connectivity by setting store state directly
    useOfflineQueueStore.setState({ limitedConnectivityAt: Date.now() });

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.state).toBe('limited');
    expect(result.current.shouldShowBanner).toBe(true);
  });

  it('returns auth-expired when authExpiredAt is set', () => {
    useOfflineQueueStore.setState({ authExpiredAt: Date.now() });

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.state).toBe('auth-expired');
    expect(result.current.shouldShowBanner).toBe(true);
  });

  it('returns queue-full when queueFullAt is set', () => {
    useOfflineQueueStore.setState({ queueFullAt: Date.now() });

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.state).toBe('queue-full');
    expect(result.current.shouldShowBanner).toBe(true);
  });

  it('prioritizes auth-expired over offline', () => {
    useOfflineQueueStore.setState({ authExpiredAt: Date.now() });

    const { result } = renderHook(() => useQueueStatus(OFFLINE));

    expect(result.current.state).toBe('auth-expired');
  });

  it('prioritizes auth-expired over reconnecting', () => {
    useOfflineQueueStore.setState({ authExpiredAt: Date.now() });

    const inputs: QueueStatusInputs = {
      isOnline: true,
      isInternetReachable: true,
      wsReconnecting: true,
    };

    const { result } = renderHook(() => useQueueStatus(inputs));

    expect(result.current.state).toBe('auth-expired');
  });

  it('prioritizes reconnecting over limited', () => {
    useOfflineQueueStore.setState({ limitedConnectivityAt: Date.now() });

    const inputs: QueueStatusInputs = {
      isOnline: true,
      isInternetReachable: true,
      wsReconnecting: true,
    };

    const { result } = renderHook(() => useQueueStatus(inputs));

    expect(result.current.state).toBe('reconnecting');
  });

  it('prioritizes queue-full over reconnecting', () => {
    useOfflineQueueStore.setState({ queueFullAt: Date.now() });

    const inputs: QueueStatusInputs = {
      isOnline: true,
      isInternetReachable: true,
      wsReconnecting: true,
    };

    const { result } = renderHook(() => useQueueStatus(inputs));

    expect(result.current.state).toBe('queue-full');
  });

  it('hasPermanentFailures is true when any item is permanent-failed', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'ok-item',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 1000,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      },
      {
        id: 'fail-item',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 2000,
        attempts: 10,
        nextRetryAt: 0,
        isPermanentFailure: true,
        errorCategory: 'permanent',
        metadata: {},
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.hasPermanentFailures).toBe(true);
    expect(result.current.totalPending).toBe(1);
    expect(result.current.totalFailed).toBe(1);
  });

  it('totalPending excludes permanent failures; totalFailed counts them', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'p1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 100,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      },
      {
        id: 'p2',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 200,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      },
      {
        id: 'f1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 300,
        attempts: 10,
        nextRetryAt: 0,
        isPermanentFailure: true,
        errorCategory: 'permanent',
        metadata: {},
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.totalPending).toBe(2);
    expect(result.current.totalFailed).toBe(1);
  });

  it('lastErrorCategory returns the most recent item with an error', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'old-err',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 100,
        attempts: 1,
        nextRetryAt: 0,
        isPermanentFailure: false,
        errorCategory: 'network',
        metadata: {},
      },
      {
        id: 'new-err',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 500,
        attempts: 1,
        nextRetryAt: 0,
        isPermanentFailure: false,
        errorCategory: 'auth',
        metadata: {},
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.lastErrorCategory).toBe('auth');
  });

  // ---- Must Fix 3: identity-filtered counts ----

  it('filters counts by boundCloudUrl — dormant items from other identity excluded', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'cloud-a-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 100,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
        boundCloudUrl: 'https://cloud-a.fly.dev',
      },
      {
        id: 'cloud-a-2',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 200,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
        boundCloudUrl: 'https://cloud-a.fly.dev',
      },
      {
        id: 'cloud-b-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 300,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
        boundCloudUrl: 'https://cloud-b.fly.dev',
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    // Bind to cloud-b — only cloud-b items should count
    useOfflineQueueStore.setState({ boundCloudUrl: 'https://cloud-b.fly.dev' });

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.totalPending).toBe(1);
    expect(result.current.state).toBe('online-draining');
  });

  it('returns online-live when all items belong to a different identity', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'cloud-a-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 100,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
        boundCloudUrl: 'https://cloud-a.fly.dev',
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    // Bind to cloud-b — cloud-a items are dormant
    useOfflineQueueStore.setState({ boundCloudUrl: 'https://cloud-b.fly.dev' });

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.totalPending).toBe(0);
    expect(result.current.state).toBe('online-live');
  });

  it('includes legacy items with no boundCloudUrl in counts', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'legacy-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 100,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
        // no boundCloudUrl — legacy item
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    useOfflineQueueStore.setState({ boundCloudUrl: 'https://cloud-b.fly.dev' });

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.totalPending).toBe(1);
    expect(result.current.state).toBe('online-draining');
  });

  // ---- Must Fix 4: has-failures state ----

  it('returns has-failures when online, no pending, but has permanent failures', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'fail-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 100,
        attempts: 10,
        nextRetryAt: 0,
        isPermanentFailure: true,
        errorCategory: 'permanent',
        metadata: {},
      },
      {
        id: 'fail-2',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 200,
        attempts: 10,
        nextRetryAt: 0,
        isPermanentFailure: true,
        errorCategory: 'permanent',
        metadata: {},
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.state).toBe('has-failures');
    expect(result.current.shouldShowBanner).toBe(true);
    expect(result.current.totalPending).toBe(0);
    expect(result.current.totalFailed).toBe(2);
    expect(result.current.hasPermanentFailures).toBe(true);
  });

  it('returns online-draining (not has-failures) when both pending and failed items exist', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'pending-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 100,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      },
      {
        id: 'fail-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 200,
        attempts: 10,
        nextRetryAt: 0,
        isPermanentFailure: true,
        errorCategory: 'permanent',
        metadata: {},
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    // online-draining has priority over has-failures
    expect(result.current.state).toBe('online-draining');
    expect(result.current.totalPending).toBe(1);
    expect(result.current.totalFailed).toBe(1);
  });

  // ---- Must Fix 5: online-draining banner stays visible between drain cycles ----

  it('shows online-draining banner even when isDraining is false (between cycles)', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'item-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 1000,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    // Explicitly set isDraining to false (simulates between drain cycles)
    useOfflineQueueStore.setState({ isDraining: false });

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    expect(result.current.state).toBe('online-draining');
    expect(result.current.shouldShowBanner).toBe(true);
  });

  // ---- Must Fix 6: wsConnected removed ----

  it('does not require wsConnected in inputs (Option A)', () => {
    const inputs: QueueStatusInputs = {
      isOnline: true,
      isInternetReachable: true,
      wsReconnecting: false,
    };

    const { result } = renderHook(() => useQueueStatus(inputs));

    expect(result.current.state).toBe('online-live');
    expect(result.current.shouldShowBanner).toBe(false);
  });

  // ---- Must Fix 7: isInternetReachable === null and cross-account tests ----

  it('treats isInternetReachable === null as online (queue empty → online-live)', () => {
    const inputs: QueueStatusInputs = {
      isOnline: true,
      isInternetReachable: null,
      wsReconnecting: false,
    };

    const { result } = renderHook(() => useQueueStatus(inputs));

    expect(result.current.state).toBe('online-live');
    expect(result.current.shouldShowBanner).toBe(false);
  });

  it('treats isInternetReachable === null as online (queue with items → online-draining)', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'item-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 1000,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    const inputs: QueueStatusInputs = {
      isOnline: true,
      isInternetReachable: null,
      wsReconnecting: false,
    };

    const { result } = renderHook(() => useQueueStatus(inputs));

    expect(result.current.state).toBe('online-draining');
    expect(result.current.shouldShowBanner).toBe(true);
  });

  it('identity rebind makes dormant items invisible to banner count', async () => {
    const freshStorage = new InMemoryStorage();
    freshStorage.items = [
      {
        id: 'old-1',
        type: 'text-message',
        status: 'pending',
        enqueuedAt: 100,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
        boundCloudUrl: 'https://old-cloud.fly.dev',
      },
      {
        id: 'old-2',
        type: 'voice-transcription',
        status: 'pending',
        enqueuedAt: 200,
        attempts: 0,
        nextRetryAt: 0,
        isPermanentFailure: false,
        metadata: {},
        boundCloudUrl: 'https://old-cloud.fly.dev',
      },
    ];
    _resetOfflineQueueStore();
    const store = initOfflineQueueStore(freshStorage, noopConsumer);
    await store.getState().init();

    // Rebind to new identity
    useOfflineQueueStore.setState({ boundCloudUrl: 'https://new-cloud.fly.dev' });

    const { result } = renderHook(() => useQueueStatus(ONLINE));

    // All items belong to old identity → dormant → counts are 0
    expect(result.current.totalPending).toBe(0);
    expect(result.current.totalFailed).toBe(0);
    expect(result.current.state).toBe('online-live');
    expect(result.current.shouldShowBanner).toBe(false);
  });
});
