import { describe, it, expect, vi } from 'vitest';
import { getOrCreateClientId, generateClientId } from '../auth/createAuthStore';
import type { TokenStorage } from '../auth/types';

/**
 * F1 — `getOrCreateClientId` must be GENUINELY single-flight per storage
 * instance: two concurrent first-launch callers (mobile has exactly these — the
 * auth store's loadCredentials + launch analytics) must converge on ONE id, and
 * the id must be generated at most once. The earlier "write then re-read and
 * adopt" approach could mint two different ids under a simultaneous double-miss.
 */

interface ControllableStorage extends TokenStorage {
  storedClientId: string | null;
  getCalls: number;
  setCalls: number;
}

function createMockStorage(): ControllableStorage {
  const storage: ControllableStorage = {
    storedClientId: null,
    getCalls: 0,
    setCalls: 0,
    getToken: vi.fn(async () => null),
    setToken: vi.fn(async () => {}),
    clearToken: vi.fn(async () => {}),
    getClientId: vi.fn(async () => {
      storage.getCalls += 1;
      // Yield a microtask so concurrent callers genuinely interleave around the
      // empty read (the double-miss window the single-flight fix must close).
      await Promise.resolve();
      return storage.storedClientId;
    }),
    setClientId: vi.fn(async (id: string) => {
      storage.setCalls += 1;
      await Promise.resolve();
      storage.storedClientId = id;
    }),
  };
  return storage;
}

describe('getOrCreateClientId — single-flight', () => {
  it('two simultaneous calls on a fresh storage return the IDENTICAL id and generate once', async () => {
    const storage = createMockStorage();

    // Fire both BEFORE awaiting either — the realistic double-miss interleaving.
    const [a, b] = await Promise.all([
      getOrCreateClientId(storage),
      getOrCreateClientId(storage),
    ]);

    expect(a).toBeTruthy();
    expect(a).toBe(b);
    // Generated (persisted) exactly once despite two concurrent callers.
    expect(storage.setCalls).toBe(1);
    // The single read happened once (shared promise), not once per caller.
    expect(storage.getCalls).toBe(1);
    // The persisted id is the one both callers received.
    expect(storage.storedClientId).toBe(a);
  });

  it('returns the existing id without generating when one is already persisted', async () => {
    const storage = createMockStorage();
    storage.storedClientId = 'existing-install-id';

    const id = await getOrCreateClientId(storage);
    expect(id).toBe('existing-install-id');
    expect(storage.setCalls).toBe(0);
  });

  it('clears the in-flight entry after settling so later calls read storage afresh', async () => {
    const storage = createMockStorage();

    const first = await getOrCreateClientId(storage);
    expect(storage.setCalls).toBe(1);

    // A later (non-concurrent) call reads through to storage and returns the
    // persisted id — no re-generation.
    const second = await getOrCreateClientId(storage);
    expect(second).toBe(first);
    expect(storage.setCalls).toBe(1);
    // Two separate (non-overlapping) reads occurred across the two calls.
    expect(storage.getCalls).toBe(2);
  });

  it('returns undefined when the storage adapter cannot read ids (no getClientId)', async () => {
    const storage = createMockStorage();
    // Simulate web storage which has no getClientId.
    delete (storage as Partial<ControllableStorage>).getClientId;

    const id = await getOrCreateClientId(storage);
    expect(id).toBeUndefined();
  });

  it('degrades to an in-memory id (never throws) when the read fails', async () => {
    const storage = createMockStorage();
    storage.getClientId = vi.fn(async () => {
      throw new Error('keychain unavailable');
    });

    const id = await getOrCreateClientId(storage);
    expect(typeof id).toBe('string');
    expect((id as string).length).toBeGreaterThan(0);
  });

  it('generateClientId produces a non-empty string', () => {
    expect(generateClientId().length).toBeGreaterThan(0);
  });
});
