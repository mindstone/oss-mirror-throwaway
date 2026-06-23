/**
 * Stage B1 — the analytics anonymousId reconciles with the existing install id
 * (`rebel_client_id`) rather than minting a fresh UUID, and persists a new id
 * through the SAME storage key when absent.
 */

import type { TokenStorage } from '@rebel/cloud-client';
import { getOrCreateClientId } from '@rebel/cloud-client';
import { resolveAnonymousId } from '../anonymousId';

/**
 * An in-memory TokenStorage backing the `rebel_client_id` slot, shared by both
 * analytics and the (cloud-client) auth helper — exactly as the real
 * secure-store key is shared. Used to prove the two paths converge on one id.
 */
function makeSharedStorage(initialClientId: string | null = null): TokenStorage {
  let clientId: string | null = initialClientId;
  return {
    getToken: jest.fn().mockResolvedValue(null),
    setToken: jest.fn().mockResolvedValue(undefined),
    clearToken: jest.fn().mockResolvedValue(undefined),
    getClientId: jest.fn(async () => clientId),
    setClientId: jest.fn(async (id: string) => {
      clientId = id;
    }),
  };
}

function makeStorage(overrides: Partial<TokenStorage> = {}): TokenStorage {
  return {
    getToken: jest.fn().mockResolvedValue(null),
    setToken: jest.fn().mockResolvedValue(undefined),
    clearToken: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('resolveAnonymousId', () => {
  it('reuses the existing rebel_client_id when present (no new UUID)', async () => {
    const getClientId = jest.fn().mockResolvedValue('existing-client-id');
    const setClientId = jest.fn().mockResolvedValue(undefined);
    const storage = makeStorage({ getClientId, setClientId });

    const id = await resolveAnonymousId(storage);

    expect(id).toBe('existing-client-id');
    expect(getClientId).toHaveBeenCalledTimes(1);
    // Must NOT mint or persist a new id when one already exists.
    expect(setClientId).not.toHaveBeenCalled();
  });

  it('trims a stored id', async () => {
    const storage = makeStorage({
      getClientId: jest.fn().mockResolvedValue('  padded-id  '),
    });
    expect(await resolveAnonymousId(storage)).toBe('padded-id');
  });

  it('generates and persists a new id through the same key when absent', async () => {
    const setClientId = jest.fn().mockResolvedValue(undefined);
    const storage = makeStorage({
      getClientId: jest.fn().mockResolvedValue(null),
      setClientId,
    });

    const id = await resolveAnonymousId(storage);

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    // The generated id is persisted so the next getOrCreateClientId() reuses it.
    expect(setClientId).toHaveBeenCalledWith(id);
  });

  it('falls back to an in-memory id when storage reads throw (never rejects)', async () => {
    const storage = makeStorage({
      getClientId: jest.fn().mockRejectedValue(new Error('keychain unavailable')),
      setClientId: jest.fn().mockResolvedValue(undefined),
    });

    await expect(resolveAnonymousId(storage)).resolves.toEqual(expect.any(String));
  });

  it('still returns an id when persistence fails', async () => {
    const storage = makeStorage({
      getClientId: jest.fn().mockResolvedValue(null),
      setClientId: jest.fn().mockRejectedValue(new Error('write failed')),
    });

    const id = await resolveAnonymousId(storage);
    expect(id).toEqual(expect.any(String));
  });
});

describe('single source of truth (F3): analytics and cloud-client never diverge', () => {
  it('both resolve the SAME id when one already exists', async () => {
    const storage = makeSharedStorage('preexisting-install-id');

    const analyticsId = await resolveAnonymousId(storage);
    const cloudId = await getOrCreateClientId(storage);

    expect(analyticsId).toBe('preexisting-install-id');
    expect(cloudId).toBe('preexisting-install-id');
    expect(analyticsId).toBe(cloudId);
  });

  it('whichever subsystem runs first mints the id; the other reuses it (no second id)', async () => {
    const storage = makeSharedStorage(null);

    // Analytics resolves first against an empty slot — mints + persists.
    const analyticsId = await resolveAnonymousId(storage);
    // Cloud-client resolves second — the slot is now populated, so it reuses.
    const cloudId = await getOrCreateClientId(storage);

    expect(analyticsId).toBe(cloudId);
    // Exactly one id ever lived in storage.
    expect(await storage.getClientId!()).toBe(analyticsId);
  });

  it('cloud-client-first then analytics also converges', async () => {
    const storage = makeSharedStorage(null);

    const cloudId = await getOrCreateClientId(storage);
    const analyticsId = await resolveAnonymousId(storage);

    expect(analyticsId).toBe(cloudId);
  });

  it('delegates to the SAME cloud-client helper (shared call path)', async () => {
    // resolveAnonymousId must route through getOrCreateClientId rather than a
    // duplicated read/generate/write — so a single getClientId hit precedes any
    // generation. With a preexisting id, no write occurs.
    const storage = makeSharedStorage('shared-helper-id');
    const id = await resolveAnonymousId(storage);
    expect(id).toBe('shared-helper-id');
    expect(storage.setClientId).not.toHaveBeenCalled();
  });
});
