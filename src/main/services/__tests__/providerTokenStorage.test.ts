/**
 * Tests for providerTokenStorage covering both the API-token branch and
 * the OAuth-JSON branch. Same U+FFFD vulnerability shape; same fix
 * shape; per-provider Sentry tag.
 * See docs-private/investigations/260506_safestorage_token_corruption_ufffd.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setSecureTokenStoreFactory } from '@core/secureTokenStore';

const stores = new Map<string, Record<string, unknown>>();
function getStoreFor(name: string): Record<string, unknown> {
  let s = stores.get(name);
  if (!s) {
    s = {};
    stores.set(name, s);
  }
  return s;
}

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
  createStore: ({ name }: { name: string }) => {
    const store = getStoreFor(name);
    return {
      get(key: string) { return store[key]; },
      set(key: string, value: unknown) { store[key] = value; },
      has(key: string) { return key in store; },
      delete(key: string) { delete store[key]; },
      clear() { for (const k of Object.keys(store)) delete store[k]; },
    };
  },
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

import {
  loadProviderToken,
  saveProviderToken,
  loadProviderOAuthTokens,
  saveProviderOAuthTokens,
  type ProviderOAuthTokens,
} from '../providerTokenStorage';
import { __resetDegradedLatchForTesting } from '@core/services/safeStorageDecode';
import { ElectronSecureTokenStore } from '../secureTokenStore/electronSecureTokenStore';

const PROVIDER = 'fly' as const;
const API_TOKEN = 'fly-pat-token-abc';
const API_STORE_KEY = 'encryptedApiToken';
const OAUTH_STORE_KEY = 'encryptedOAuthTokens';

const OAUTH_TOKENS: ProviderOAuthTokens = {
  accessToken: 'access-abc',
  refreshToken: 'refresh-xyz',
  expiresAt: Date.now() + 3600_000,
};

function flyStore(): Record<string, unknown> {
  return getStoreFor(`${PROVIDER}-tokens`);
}

beforeEach(() => {
  setSecureTokenStoreFactory(() => new ElectronSecureTokenStore());
  stores.clear();
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  safeStorageMock.decryptString.mockClear();
  captureMessage.mockClear();
  __resetDegradedLatchForTesting();
});

afterEach(() => {
  __resetDegradedLatchForTesting();
});

describe('loadProviderToken (API-token branch)', () => {
  it('returns null when no token is stored', () => {
    expect(loadProviderToken(PROVIDER)).toBeNull();
  });

  it('round-trips encrypted-write + encrypted-read (healthy)', () => {
    saveProviderToken(PROVIDER, API_TOKEN);
    expect(loadProviderToken(PROVIDER)).toBe(API_TOKEN);
  });

  it('returns null without deleting on encrypted-write + plain-read and captures Sentry once with provider tag', () => {
    saveProviderToken(PROVIDER, API_TOKEN);
    const beforeBytes = flyStore()[API_STORE_KEY];
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    expect(loadProviderToken(PROVIDER)).toBeNull();
    expect(flyStore()[API_STORE_KEY]).toBe(beforeBytes);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'safestorage_unavailable_at_read',
      expect.objectContaining({ tags: { tokenKind: `provider-api-token:${PROVIDER}` } }),
    );
  });

  it('dedupes Sentry across repeated plain-reads', () => {
    saveProviderToken(PROVIDER, API_TOKEN);
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    loadProviderToken(PROVIDER);
    loadProviderToken(PROVIDER);
    loadProviderToken(PROVIDER);
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('clears latch on recovery so future degraded events still fire', () => {
    saveProviderToken(PROVIDER, API_TOKEN);
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(loadProviderToken(PROVIDER)).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(1);

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    expect(loadProviderToken(PROVIDER)).toBe(API_TOKEN);

    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(loadProviderToken(PROVIDER)).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it('round-trips plain-write + plain-read (Linux path)', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    saveProviderToken(PROVIDER, API_TOKEN);
    expect(loadProviderToken(PROVIDER)).toBe(API_TOKEN);
  });

  it('plain-write + encrypted-read falls back to plain decode without clearing', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    saveProviderToken(PROVIDER, API_TOKEN);
    const beforeBytes = flyStore()[API_STORE_KEY];

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    expect(loadProviderToken(PROVIDER)).toBe(API_TOKEN);
    expect(flyStore()[API_STORE_KEY]).toBe(beforeBytes);
  });

  it('clears the row on genuine corruption (decrypt throws + v10 prefix)', () => {
    saveProviderToken(PROVIDER, API_TOKEN);
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('keychain mismatch');
    });
    expect(loadProviderToken(PROVIDER)).toBeNull();
    expect(flyStore()[API_STORE_KEY]).toBeUndefined();
  });

  it('returns null for malformed base64', () => {
    flyStore()[API_STORE_KEY] = '!!!not-base64!!!';
    expect(loadProviderToken(PROVIDER)).toBeNull();
  });
});

describe('loadProviderOAuthTokens (OAuth JSON branch)', () => {
  it('returns null when no tokens are stored', () => {
    expect(loadProviderOAuthTokens(PROVIDER)).toBeNull();
  });

  it('round-trips encrypted-write + encrypted-read (healthy)', () => {
    saveProviderOAuthTokens(PROVIDER, OAUTH_TOKENS);
    expect(loadProviderOAuthTokens(PROVIDER)).toEqual(OAUTH_TOKENS);
  });

  it('returns null without deleting on encrypted-write + plain-read and captures Sentry once', () => {
    saveProviderOAuthTokens(PROVIDER, OAUTH_TOKENS);
    const beforeBytes = flyStore()[OAUTH_STORE_KEY];
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    expect(loadProviderOAuthTokens(PROVIDER)).toBeNull();
    expect(flyStore()[OAUTH_STORE_KEY]).toBe(beforeBytes);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'safestorage_unavailable_at_read',
      expect.objectContaining({ tags: { tokenKind: `provider-oauth-token:${PROVIDER}` } }),
    );
  });

  it('round-trips plain-write + plain-read (Linux path)', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    saveProviderOAuthTokens(PROVIDER, OAUTH_TOKENS);
    expect(loadProviderOAuthTokens(PROVIDER)).toEqual(OAUTH_TOKENS);
  });

  it('plain-write + encrypted-read falls back to plain decode without clearing', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    saveProviderOAuthTokens(PROVIDER, OAUTH_TOKENS);
    const beforeBytes = flyStore()[OAUTH_STORE_KEY];

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    expect(loadProviderOAuthTokens(PROVIDER)).toEqual(OAUTH_TOKENS);
    expect(flyStore()[OAUTH_STORE_KEY]).toBe(beforeBytes);
  });

  it('clears the row on genuine corruption (decrypt throws + v10 prefix)', () => {
    saveProviderOAuthTokens(PROVIDER, OAUTH_TOKENS);
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('keychain mismatch');
    });
    expect(loadProviderOAuthTokens(PROVIDER)).toBeNull();
    expect(flyStore()[OAUTH_STORE_KEY]).toBeUndefined();
  });

  it('returns null when decrypted JSON has invalid shape (without deleting)', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    flyStore()[OAUTH_STORE_KEY] = Buffer.from(JSON.stringify({ accessToken: 'a' })).toString('base64');
    const beforeBytes = flyStore()[OAUTH_STORE_KEY];

    expect(loadProviderOAuthTokens(PROVIDER)).toBeNull();
    expect(flyStore()[OAUTH_STORE_KEY]).toBe(beforeBytes);
  });

  it('rejects U+FFFD-poisoned accessToken/refreshToken even when JSON parses', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    const poisoned = JSON.stringify({
      accessToken: 'access-\uFFFD-bad',
      refreshToken: 'refresh-xyz',
      expiresAt: Date.now() + 3600_000,
    });
    flyStore()[OAUTH_STORE_KEY] = Buffer.from(poisoned).toString('base64');
    const beforeBytes = flyStore()[OAUTH_STORE_KEY];

    expect(loadProviderOAuthTokens(PROVIDER)).toBeNull();
    expect(flyStore()[OAUTH_STORE_KEY]).toBe(beforeBytes);
  });

  it('returns null for malformed base64', () => {
    flyStore()[OAUTH_STORE_KEY] = '!!!not-base64!!!';
    expect(loadProviderOAuthTokens(PROVIDER)).toBeNull();
  });
});
