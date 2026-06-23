import { describe, expect, it, afterEach } from 'vitest';
import type { KeyValueStore } from '@core/store';
import {
  createSessionTombstoneStore,
  resetSessionTombstoneStoreForTests,
} from '../sessionTombstoneStore';

type StoreShape = {
  tombstones: Array<{
    sessionId: string;
    deletedAt: number;
    deletedBy: 'desktop' | 'mobile' | 'cloud';
    ttlExpiresAt: number;
  }>;
};

function createMemoryStore(initial?: Partial<StoreShape>): KeyValueStore<StoreShape> {
  const data: StoreShape = {
    tombstones: initial?.tombstones ?? [],
  };

  return {
    get(key: string, defaultValue?: unknown) {
      const typedKey = key as keyof StoreShape;
      const value = data[typedKey];
      return value === undefined ? defaultValue as StoreShape[keyof StoreShape] : value;
    },
    set(keyOrValues: string | Partial<StoreShape>, value?: unknown) {
      if (typeof keyOrValues === 'string') {
        const typedKey = keyOrValues as keyof StoreShape;
        data[typedKey] = value as StoreShape[keyof StoreShape];
        return;
      }
      Object.assign(data, keyOrValues);
    },
    has(key: string) {
      return key in data;
    },
    delete(key: string) {
      delete (data as Record<string, unknown>)[key];
    },
    clear() {
      data.tombstones = [];
    },
    get store() {
      return data;
    },
    path: '/tmp/session-tombstone-store.test.json',
  } as KeyValueStore<StoreShape>;
}

describe('SessionTombstoneStore', () => {
  afterEach(() => {
    resetSessionTombstoneStoreForTests();
  });

  it('adds and retrieves tombstones', () => {
    const store = createSessionTombstoneStore({
      store: createMemoryStore(),
      ttlMs: 30_000,
      cleanupIntervalMs: 60_000,
      now: () => 1_000,
    });

    const tombstone = store.addTombstone('session-1', 'mobile');
    expect(tombstone).toEqual({
      sessionId: 'session-1',
      deletedAt: 1_000,
      deletedBy: 'mobile',
      ttlExpiresAt: 31_000,
    });
    expect(store.getTombstone('session-1')).toEqual(tombstone);
    expect(store.hasTombstone('session-1')).toBe(true);

    store.dispose();
  });

  it('returns only tombstones newer than "since"', () => {
    let now = 10_000;
    const store = createSessionTombstoneStore({
      store: createMemoryStore(),
      ttlMs: 60_000,
      cleanupIntervalMs: 60_000,
      now: () => now,
    });

    store.addTombstone('session-a', 'desktop'); // 10_000
    now = 15_000;
    store.addTombstone('session-b', 'cloud'); // 15_000
    now = 20_000;
    store.addTombstone('session-c', 'mobile'); // 20_000

    const result = store.listTombstones(12_000);
    expect(result.map((entry) => entry.sessionId)).toEqual(['session-b', 'session-c']);

    store.dispose();
  });

  it('expires tombstones by ttl', () => {
    let now = 5_000;
    const store = createSessionTombstoneStore({
      store: createMemoryStore(),
      ttlMs: 1_000,
      cleanupIntervalMs: 60_000,
      now: () => now,
    });

    store.addTombstone('session-expire', 'cloud');
    expect(store.hasTombstone('session-expire')).toBe(true);

    now = 6_500;
    const removed = store.removeExpiredTombstones();
    expect(removed).toBe(1);
    expect(store.hasTombstone('session-expire')).toBe(false);

    store.dispose();
  });

  it('keeps the newest tombstone when older data is re-added', () => {
    const store = createSessionTombstoneStore({
      store: createMemoryStore(),
      ttlMs: 60_000,
      cleanupIntervalMs: 60_000,
      now: () => 20_000,
    });

    store.addTombstone('session-1', 'desktop', 20_000);
    store.addTombstone('session-1', 'mobile', 19_000); // older tombstone ignored

    expect(store.getTombstone('session-1')).toEqual({
      sessionId: 'session-1',
      deletedAt: 20_000,
      deletedBy: 'desktop',
      ttlExpiresAt: 80_000,
    });

    store.dispose();
  });
});
