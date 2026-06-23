import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stage D of docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
//
// We mock the store factory so we never touch a real electron-store on disk
// during unit tests. The cache is a thin wrapper, so the assertions focus on
// the integration contract: reads return what was written, defaults are
// returned on empty store, and write errors are swallowed (the cache is
// best-effort).

const storeMap = new Map<string, unknown>();
const mockGet = vi.fn((key: string) => storeMap.get(key));
const mockSet = vi.fn((key: string, value: unknown) => {
  storeMap.set(key, value);
});

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get: mockGet,
    set: mockSet,
  })),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  readDesktopLkgCache,
  writeDesktopLkgCache,
  clearDesktopLkgCache,
  __resetDesktopLkgCacheForTests,
  type DesktopLkgRecord,
} from '../desktopLkgCache';

describe('desktopLkgCache', () => {
  beforeEach(() => {
    storeMap.clear();
    mockGet.mockClear();
    mockSet.mockClear();
    __resetDesktopLkgCacheForTests();
  });

  it('returns defaults when the store is empty', () => {
    const payload = readDesktopLkgCache();
    expect(payload.record).toBeNull();
    expect(payload.refreshedAt).toBe(0);
    expect(payload.fetchedFromCloudUrl).toBeNull();
  });

  it('round-trips a full record through write/read', () => {
    const record: DesktopLkgRecord = {
      imageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
      buildCommit: 'abc1234',
      schemaFingerprint: 'a'.repeat(64),
      recordedAt: 1700000000000,
      previousLastKnownGood: {
        imageTag: 'ghcr.io/mindstone/rebel-cloud:prod-older',
        schemaFingerprint: 'b'.repeat(64),
        recordedAt: 1690000000000,
      },
    };

    writeDesktopLkgCache({
      record,
      refreshedAt: 1700000123456,
      fetchedFromCloudUrl: 'https://example.fly.dev',
    });

    const out = readDesktopLkgCache();
    expect(out.record).toEqual(record);
    expect(out.refreshedAt).toBe(1700000123456);
    expect(out.fetchedFromCloudUrl).toBe('https://example.fly.dev');
  });

  it('persists a null record (e.g. cloud has no LKG yet)', () => {
    writeDesktopLkgCache({
      record: null,
      refreshedAt: 1700000123456,
      fetchedFromCloudUrl: 'https://example.fly.dev',
    });
    const out = readDesktopLkgCache();
    expect(out.record).toBeNull();
    expect(out.refreshedAt).toBe(1700000123456);
  });

  it('clearDesktopLkgCache resets to default-looking values', () => {
    writeDesktopLkgCache({
      record: {
        imageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
        buildCommit: 'abc1234',
        schemaFingerprint: 'a'.repeat(64),
        recordedAt: 1700000000000,
        previousLastKnownGood: null,
      },
      refreshedAt: 1700000123456,
      fetchedFromCloudUrl: 'https://example.fly.dev',
    });
    clearDesktopLkgCache();

    const out = readDesktopLkgCache();
    expect(out.record).toBeNull();
    expect(out.refreshedAt).toBe(0);
    expect(out.fetchedFromCloudUrl).toBeNull();
  });

  it('swallows store-write failures (best-effort cache)', () => {
    mockSet.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    // Should not throw — the cache is best-effort.
    expect(() =>
      writeDesktopLkgCache({
        record: null,
        refreshedAt: 0,
        fetchedFromCloudUrl: null,
      }),
    ).not.toThrow();
  });

  it('swallows store-read failures (best-effort cache)', () => {
    mockGet.mockImplementationOnce(() => {
      throw new Error('disk read error');
    });
    const out = readDesktopLkgCache();
    expect(out.record).toBeNull();
    expect(out.refreshedAt).toBe(0);
  });
});
