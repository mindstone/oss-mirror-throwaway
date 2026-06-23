/**
 * Tests for openRouterTokenStorage's loadOpenRouterTokens — OAuth-JSON
 * branch with apiKey-shaped payloads. Covers the same matrix as the
 * other three loaders plus the OpenRouter-specific settings-fallback
 * resolution at resolveOpenRouterApiKey.
 *
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

import { loadOpenRouterTokens, saveOpenRouterTokens } from '../openRouterTokenStorage';
import { __resetDegradedLatchForTesting } from '@core/services/safeStorageDecode';
import { ElectronSecureTokenStore } from '../secureTokenStore/electronSecureTokenStore';

const OR_TOKENS = { apiKey: 'fake-openrouter-key-abcdef1234' };
const STORE_KEY = 'encryptedTokens';

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

describe('loadOpenRouterTokens', () => {
  it('returns null when no tokens are stored', () => {
    expect(loadOpenRouterTokens()).toBeNull();
  });

  it('round-trips encrypted-write + encrypted-read (healthy)', () => {
    saveOpenRouterTokens(OR_TOKENS);
    expect(loadOpenRouterTokens()).toEqual(OR_TOKENS);
  });

  it('returns null without deleting on encrypted-write + plain-read and captures Sentry once', () => {
    saveOpenRouterTokens(OR_TOKENS);
    const beforeBytes = mockStore[STORE_KEY];
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    expect(loadOpenRouterTokens()).toBeNull();
    expect(mockStore[STORE_KEY]).toBe(beforeBytes);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'safestorage_unavailable_at_read',
      expect.objectContaining({ tags: { tokenKind: 'openrouter-oauth-token' } }),
    );
  });

  it('dedupes Sentry across repeated plain-reads', () => {
    saveOpenRouterTokens(OR_TOKENS);
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    loadOpenRouterTokens();
    loadOpenRouterTokens();
    loadOpenRouterTokens();
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('clears the latch on recovery so future degraded events still fire', () => {
    saveOpenRouterTokens(OR_TOKENS);
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(loadOpenRouterTokens()).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(1);

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    expect(loadOpenRouterTokens()).toEqual(OR_TOKENS);

    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(loadOpenRouterTokens()).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it('round-trips plain-write + plain-read (Linux path)', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    saveOpenRouterTokens(OR_TOKENS);
    expect(loadOpenRouterTokens()).toEqual(OR_TOKENS);
  });

  it('plain-write + encrypted-read falls back to plain decode without clearing', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    saveOpenRouterTokens(OR_TOKENS);
    const beforeBytes = mockStore[STORE_KEY];

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    expect(loadOpenRouterTokens()).toEqual(OR_TOKENS);
    expect(mockStore[STORE_KEY]).toBe(beforeBytes);
  });

  it('clears the row on genuine corruption (decrypt throws + v10 prefix)', () => {
    saveOpenRouterTokens(OR_TOKENS);
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('keychain mismatch');
    });
    expect(loadOpenRouterTokens()).toBeNull();
    expect(mockStore[STORE_KEY]).toBeUndefined();
  });

  it('returns null when decrypted JSON has empty apiKey (without deleting)', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    mockStore[STORE_KEY] = Buffer.from(JSON.stringify({ apiKey: '' })).toString('base64');
    const beforeBytes = mockStore[STORE_KEY];

    expect(loadOpenRouterTokens()).toBeNull();
    expect(mockStore[STORE_KEY]).toBe(beforeBytes);
  });

  it('returns null when decrypted JSON has non-ASCII apiKey (U+FFFD class)', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    mockStore[STORE_KEY] = Buffer.from(JSON.stringify({ apiKey: 'sk\uFFFDor' })).toString('base64');
    expect(loadOpenRouterTokens()).toBeNull();
  });

  it('returns null for malformed base64', () => {
    mockStore[STORE_KEY] = '!!!not-base64!!!';
    expect(loadOpenRouterTokens()).toBeNull();
  });
});

describe('OpenRouter resolveOpenRouterApiKey settings fallback (regression)', () => {
  it('falls back to settings when loadOpenRouterTokens returns null', async () => {
    // Reset modules so resolveOpenRouterApiKey gets a fresh mock chain.
    vi.resetModules();

    const settingsToken = 'fake-openrouter-key-from-settings';

     
    vi.doMock('../openRouterTokenStorage', () => ({
      loadOpenRouterTokens: () => null,
    }));
     
    vi.doMock('@core/services/settingsStore', () => ({
      setSettingsStoreAdapter: vi.fn(),
      getSettings: () => ({
        providerKeys: {},
        openRouter: { enabled: true, oauthToken: settingsToken, selectedModel: 'openai/gpt-5.5' },
      }),
    }));

    const { resolveOpenRouterApiKey } = await import('../localModelProxyServer');
    expect(resolveOpenRouterApiKey()).toBe(settingsToken);
  });
});
