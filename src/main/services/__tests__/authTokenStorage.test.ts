/**
 * Tests for authTokenStorage's loadSessionToken — the primary site of
 * the U+FFFD-poisoned bearer-header bug. See
 * docs-private/investigations/260506_safestorage_token_corruption_ufffd.md.
 *
 * Covers the test matrix from the diagnosis doc (encrypted/plain
 * write × encrypted/plain read, recovery, dedupe, corruption clear,
 * prefix collision sanity).
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

import { loadSessionToken, saveSessionToken } from '../authTokenStorage';
import { __resetDegradedLatchForTesting } from '@core/services/safeStorageDecode';
import { ElectronSecureTokenStore } from '../secureTokenStore/electronSecureTokenStore';

const TOKEN = 'better-auth-session-1234567890abcdef';
const STORE_KEY = 'encryptedSessionToken';

beforeEach(() => {
  setSecureTokenStoreFactory(() => new ElectronSecureTokenStore());
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  safeStorageMock.encryptString.mockClear();
  safeStorageMock.decryptString.mockClear();
  captureMessage.mockClear();
  __resetDegradedLatchForTesting();
});

afterEach(() => {
  __resetDegradedLatchForTesting();
});

describe('loadSessionToken', () => {
  it('returns null when no token is stored', () => {
    expect(loadSessionToken()).toBeNull();
  });

  it('round-trips encrypted-write + encrypted-read (healthy)', () => {
    saveSessionToken(TOKEN);
    expect(loadSessionToken()).toBe(TOKEN);
  });

  it('returns null without deleting on encrypted-write + plain-read (the bug) and captures Sentry once', () => {
    saveSessionToken(TOKEN);
    const beforeBytes = mockStore[STORE_KEY];
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    expect(loadSessionToken()).toBeNull();
    expect(mockStore[STORE_KEY]).toBe(beforeBytes);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'safestorage_unavailable_at_read',
      expect.objectContaining({ tags: { tokenKind: 'auth-session-token' } }),
    );
  });

  it('does not duplicate Sentry captures across repeated plain-reads in the same degraded period', () => {
    saveSessionToken(TOKEN);
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    expect(loadSessionToken()).toBeNull();
    expect(loadSessionToken()).toBeNull();
    expect(loadSessionToken()).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('clears the dedupe latch on recovery so future degraded events still fire', () => {
    saveSessionToken(TOKEN);
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(loadSessionToken()).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(1);

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    expect(loadSessionToken()).toBe(TOKEN);

    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(loadSessionToken()).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it('round-trips plain-write + plain-read (Linux without Secret Service)', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    saveSessionToken(TOKEN);
    expect(loadSessionToken()).toBe(TOKEN);
  });

  it('plain-write + encrypted-read falls back to plain decode without clearing', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    saveSessionToken(TOKEN);
    const beforeBytes = mockStore[STORE_KEY];

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    expect(loadSessionToken()).toBe(TOKEN);
    expect(mockStore[STORE_KEY]).toBe(beforeBytes);
  });

  it('clears the row when decrypt fails on a v10-prefixed payload (April 1 regression preserved)', () => {
    saveSessionToken(TOKEN);
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('keychain mismatch');
    });
    expect(loadSessionToken()).toBeNull();
    expect(mockStore[STORE_KEY]).toBeUndefined();
  });

  it('returns null for malformed base64', () => {
    mockStore[STORE_KEY] = '!!!not-base64!!!';
    expect(loadSessionToken()).toBeNull();
  });

  it('treats a plain Better-Auth token starting with "v10" as encrypted (prefix-collision sanity)', () => {
    // Better-Auth tokens are documented to be alphanumeric session-ids, NOT
    // starting with v10/v11. This test asserts that IF a token were ever
    // shaped that way, the v10/v11 detection would still kick in — the
    // mitigation here is that real tokens don't trigger this case. The
    // helper deliberately can't tell apart "ciphertext starting with v10"
    // and "plain string starting with v10"; the safety comes from the
    // contract that real session tokens never start with v10.
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    mockStore[STORE_KEY] = Buffer.from('v10-plain-token').toString('base64');
    expect(loadSessionToken()).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });
});
