/**
 * Tests for flyTokenStorage's loadFlyApiToken — sibling token store of
 * authTokenStorage. Same U+FFFD vulnerability shape; same fix shape.
 * See docs-private/investigations/260506_safestorage_token_corruption_ufffd.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setSecureTokenStoreFactory } from '@core/secureTokenStore';

const mockStore: Record<string, unknown> = {};

const safeStorageMock = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(s)])),
  decryptString: vi.fn((buf: Buffer) => {
    if (!buf.subarray(0, 3).equals(Buffer.from('v10'))) throw new Error('not encrypted');
    return buf.subarray(3).toString('utf-8');
  }),
};

const captureMessage = vi.fn();

 
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => ({ safeStorage: safeStorageMock }),
}));
 
vi.mock('@core/storeFactory', () => ({
  createStore: () => ({
    get(key: string) { return mockStore[key]; },
    set(key: string, value: unknown) { mockStore[key] = value; },
    has(key: string) { return key in mockStore; },
    delete(key: string) { delete mockStore[key]; },
    clear() { for (const k of Object.keys(mockStore)) delete mockStore[k]; },
  }),
}));
 
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureMessage,
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureExceptionWithScope: vi.fn(),
  }),
}));
 
vi.mock('../../utils/testIsolation', () => ({
  isE2eTestMode: () => false,
}));

import { loadFlyApiToken, saveFlyApiToken } from '../flyTokenStorage';
import { __resetDegradedLatchForTesting } from '@core/services/safeStorageDecode';
import { ElectronSecureTokenStore } from '../secureTokenStore/electronSecureTokenStore';

const FLY_TOKEN = 'fly-pat-token-1234abcd';
const STORE_KEY = 'encryptedFlyApiToken';

beforeEach(() => {
  setSecureTokenStoreFactory(() => new ElectronSecureTokenStore());
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  safeStorageMock.decryptString.mockClear();
  captureMessage.mockClear();
  __resetDegradedLatchForTesting();
});

afterEach(() => {
  __resetDegradedLatchForTesting();
});

describe('loadFlyApiToken', () => {
  it('returns null when no token is stored', () => {
    expect(loadFlyApiToken()).toBeNull();
  });

  it('round-trips encrypted-write + encrypted-read (healthy)', () => {
    saveFlyApiToken(FLY_TOKEN);
    expect(loadFlyApiToken()).toBe(FLY_TOKEN);
  });

  it('returns null without deleting on encrypted-write + plain-read and captures Sentry once', () => {
    saveFlyApiToken(FLY_TOKEN);
    const beforeBytes = mockStore[STORE_KEY];
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    expect(loadFlyApiToken()).toBeNull();
    expect(mockStore[STORE_KEY]).toBe(beforeBytes);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'safestorage_unavailable_at_read',
      expect.objectContaining({ tags: { tokenKind: 'fly-api-token' } }),
    );
  });

  it('dedupes Sentry captures across repeated plain-reads', () => {
    saveFlyApiToken(FLY_TOKEN);
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(loadFlyApiToken()).toBeNull();
    expect(loadFlyApiToken()).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('clears the latch on recovery and re-fires on next regression', () => {
    saveFlyApiToken(FLY_TOKEN);
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(loadFlyApiToken()).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(1);

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    expect(loadFlyApiToken()).toBe(FLY_TOKEN);

    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(loadFlyApiToken()).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it('round-trips plain-write + plain-read (Linux path)', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    saveFlyApiToken(FLY_TOKEN);
    expect(loadFlyApiToken()).toBe(FLY_TOKEN);
  });

  it('plain-write + encrypted-read falls back to plain decode without clearing', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    saveFlyApiToken(FLY_TOKEN);
    const beforeBytes = mockStore[STORE_KEY];

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    expect(loadFlyApiToken()).toBe(FLY_TOKEN);
    expect(mockStore[STORE_KEY]).toBe(beforeBytes);
  });

  it('clears the row on genuine corruption (decrypt throws + v10 prefix)', () => {
    saveFlyApiToken(FLY_TOKEN);
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('keychain mismatch');
    });
    expect(loadFlyApiToken()).toBeNull();
    expect(mockStore[STORE_KEY]).toBeUndefined();
  });

  it('returns null for malformed base64', () => {
    mockStore[STORE_KEY] = '!!!not-base64!!!';
    expect(loadFlyApiToken()).toBeNull();
  });
});
