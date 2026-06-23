/**
 * Tests for codexTokenStorage's loadCodexTokens — the fifth (cross-surface)
 * member of the safeStorage-backed token family. Covers the same matrix as
 * the other four loaders, with one critical surface-specific difference:
 *
 *  - On Electron desktop: `unavailable_encrypted` preserves the row so the
 *    next read recovers transparently when the keychain returns (matches
 *    auth/provider/openrouter/fly behavior).
 *  - On cloud / mobile: `unavailable_encrypted` clears the row because
 *    safeStorage doesn't exist on this runtime; the bytes are unrecoverable
 *    desktop-migration-archive garbage. This preserves the pre-existing
 *    260428 fix contract.
 *
 * See:
 *   docs-private/investigations/260506_safestorage_token_corruption_ufffd.md
 *   docs/plans/260428_safety_eval_unavailable_codex_token_corruption.md
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSecureTokenStore, setSecureTokenStoreFactory } from '@core/secureTokenStore';
import type { SecureTokenStore } from '@core/secureTokenStore';

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
const track = vi.fn();
const captureKnownCondition = vi.fn();

// Toggleable Electron module — flipped to `null` to simulate cloud/mobile
// surface where safeStorage doesn't exist at all.
let electronModulePresent = true;

 
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => (electronModulePresent ? { safeStorage: safeStorageMock } : null),
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

vi.mock('@core/tracking', () => ({
  getTracker: () => ({
    track,
    identify: vi.fn(),
    getAnonymousId: () => '',
    isAvailable: () => true,
  }),
}));

vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: (...args: unknown[]) => captureKnownCondition(...args),
  recordKnownConditionLedgerOnly: vi.fn(),
}));

import {
  loadCodexTokens,
  saveCodexTokens,
  clearCodexTokens,
  hasCodexTokens,
  codexTokenEvents,
  clearPendingCodexCloudClear,
  type CodexTokens,
  hasPendingCodexCloudClear,
  markPendingCodexCloudClear,
} from '../codexTokenStorage';
import { __resetDegradedLatchForTesting, decodeStringStore } from '../safeStorageDecode';
import { ElectronSecureTokenStore } from '@main/services/secureTokenStore/electronSecureTokenStore';

const STORE_KEY = 'encryptedTokens';
const SIDECAR_KEY = `${STORE_KEY}.corrupt.latest`;
const PENDING_CLOUD_CLEAR_KEY = 'pendingCloudTokenClear';

const TOKENS: CodexTokens = {
  accessToken: 'access-abc-123',
  refreshToken: 'refresh-xyz-456',
  expiresAt: 1_800_000_000_000,
  accountId: 'account-789',
  accountEmail: 'user@example.com',
};

function createCloudLikeSecureTokenStore(): SecureTokenStore {
  return {
    isEncryptionAvailable: () => false,
    read: (options) => {
      const stored = options.store.get(options.key);
      if (typeof stored !== 'string' || stored.length === 0) return null;
      const result = decodeStringStore({
        stored,
        isEncryptionAvailable: () => false,
        decryptString: () => {
          throw new Error('safeStorage unavailable on cloud surface');
        },
        validate: options.validate,
        kind: options.kind,
      });
      switch (result.kind) {
        case 'ok':
          return result.value;
        case 'unavailable_encrypted':
          options.store.delete(options.key);
          return null;
        case 'corrupt':
          options.store.delete(options.key);
          return null;
        case 'null':
          return null;
      }
    },
    write: ({ store, key, value }) => {
      store.set(key, Buffer.from(value).toString('base64'));
    },
    delete: ({ store, key }) => {
      store.delete(key);
    },
    has: ({ store, key }) => store.has(key),
  };
}

beforeEach(() => {
  setSecureTokenStoreFactory(() => new ElectronSecureTokenStore());
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  electronModulePresent = true;
  process.env.REBEL_SURFACE = 'desktop';
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
  safeStorageMock.decryptString.mockClear();
  captureMessage.mockClear();
  track.mockClear();
  captureKnownCondition.mockClear();
  __resetDegradedLatchForTesting();
  clearPendingCodexCloudClear();
  delete process.env.REBEL_E2E_TEST_MODE;
  delete process.env.REBEL_TEST_USER_DATA_DIR;
});

afterEach(() => {
  __resetDegradedLatchForTesting();
});

describe('loadCodexTokens — desktop surface', () => {
  it('returns null when no tokens are stored', () => {
    expect(loadCodexTokens()).toBeNull();
  });

  it('round-trips encrypted-write + encrypted-read (healthy)', () => {
    saveCodexTokens(TOKENS);
    expect(loadCodexTokens()).toEqual(TOKENS);
  });

  it('returns null without deleting on encrypted-write + plain-read and captures Sentry once', () => {
    saveCodexTokens(TOKENS);
    const beforeBytes = mockStore[STORE_KEY];
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    expect(loadCodexTokens()).toBeNull();
    expect(mockStore[STORE_KEY]).toBe(beforeBytes);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'safestorage_unavailable_at_read',
      expect.objectContaining({ tags: { tokenKind: 'codex-oauth-token' } }),
    );
  });

  it('repeated reads during a degraded period do not spam Sentry (dedupe)', () => {
    saveCodexTokens(TOKENS);
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);

    expect(loadCodexTokens()).toBeNull();
    expect(loadCodexTokens()).toBeNull();
    expect(loadCodexTokens()).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('clears the dedupe latch on recovery — next degraded period re-fires Sentry', () => {
    saveCodexTokens(TOKENS);
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(loadCodexTokens()).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(1);

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    expect(loadCodexTokens()).toEqual(TOKENS);

    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(loadCodexTokens()).toBeNull();
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it('plain-write + encrypted-read falls back to plain decode without clearing', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    saveCodexTokens(TOKENS);
    const beforeBytes = mockStore[STORE_KEY];

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    expect(loadCodexTokens()).toEqual(TOKENS);
    expect(mockStore[STORE_KEY]).toBe(beforeBytes);
  });

  it('clears the row on genuine corruption (decrypt throws + v10 prefix)', () => {
    saveCodexTokens(TOKENS);
    track.mockClear();
    captureKnownCondition.mockClear();
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('keychain mismatch');
    });
    expect(loadCodexTokens()).toBeNull();
    expect(mockStore[STORE_KEY]).toBeUndefined();
    expect(mockStore[SIDECAR_KEY]).toEqual(
      expect.objectContaining({
        namespace: 'codex-oauth-tokens',
        key: STORE_KEY,
        kind: 'corrupt',
      }),
    );
    expect(track).toHaveBeenCalledWith(
      'Codex Auth Disconnected',
      expect.objectContaining({
        cause: 'corrupt_read',
        source: 'secure_token_store',
        surface: 'desktop',
      }),
    );
    expect(captureKnownCondition).toHaveBeenCalledWith(
      'codex_auth_destructive_disconnect',
      expect.objectContaining({
        cause: 'corrupt_read',
        source: 'secure_token_store',
        surface: 'desktop',
      }),
      expect.any(Error),
    );
  });

  it('overwrites the corrupt sidecar with the latest unreadable payload', () => {
    saveCodexTokens(TOKENS);
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('keychain mismatch 1');
    });
    expect(loadCodexTokens()).toBeNull();
    const firstSidecar = mockStore[SIDECAR_KEY];

    const nextTokens: CodexTokens = {
      ...TOKENS,
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accountId: 'account-2',
    };
    saveCodexTokens(nextTokens);
    safeStorageMock.decryptString.mockImplementationOnce(() => {
      throw new Error('keychain mismatch 2');
    });
    expect(loadCodexTokens()).toBeNull();
    const secondSidecar = mockStore[SIDECAR_KEY];

    expect(secondSidecar).toEqual(
      expect.objectContaining({
        namespace: 'codex-oauth-tokens',
        key: STORE_KEY,
        kind: 'corrupt',
      }),
    );
    expect(secondSidecar).not.toEqual(firstSidecar);
  });

  it('returns null when decrypted JSON has invalid shape (without deleting)', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    mockStore[STORE_KEY] = Buffer.from(JSON.stringify({ accessToken: 'a' })).toString('base64');
    const beforeBytes = mockStore[STORE_KEY];

    expect(loadCodexTokens()).toBeNull();
    expect(mockStore[STORE_KEY]).toBe(beforeBytes);
  });

  it('rejects U+FFFD-poisoned accessToken even when JSON parses', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    const poisoned = JSON.stringify({
      ...TOKENS,
      accessToken: 'access-\uFFFD-bad',
    });
    mockStore[STORE_KEY] = Buffer.from(poisoned).toString('base64');
    const beforeBytes = mockStore[STORE_KEY];

    expect(loadCodexTokens()).toBeNull();
    expect(mockStore[STORE_KEY]).toBe(beforeBytes);
  });

  it('rejects U+FFFD-poisoned refreshToken even when JSON parses', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    const poisoned = JSON.stringify({
      ...TOKENS,
      refreshToken: 'refresh-\uFFFD-bad',
    });
    mockStore[STORE_KEY] = Buffer.from(poisoned).toString('base64');
    expect(loadCodexTokens()).toBeNull();
  });

  it('returns null for malformed base64', () => {
    mockStore[STORE_KEY] = '!!!not-base64!!!';
    expect(loadCodexTokens()).toBeNull();
  });

  it('accepts tokens with no accountEmail (optional field)', () => {
    const minimal: CodexTokens = { ...TOKENS };
    delete minimal.accountEmail;
    saveCodexTokens(minimal);
    expect(loadCodexTokens()).toEqual(minimal);
  });

  it('accepts internationalized accountEmail (RFC 6531 / EAI)', () => {
    // Validator must not reject non-ASCII emails — those are valid per RFC 6531
    // and the email is UI-only, never an HTTP header value. Only U+FFFD and
    // control chars indicate actual corruption.
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    const intl = JSON.stringify({ ...TOKENS, accountEmail: 'user@münchen.de' });
    mockStore[STORE_KEY] = Buffer.from(intl).toString('base64');
    expect(loadCodexTokens()).toEqual({ ...TOKENS, accountEmail: 'user@münchen.de' });
  });

  it('rejects U+FFFD-poisoned accountEmail even when JSON parses', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    const poisoned = JSON.stringify({ ...TOKENS, accountEmail: 'user\uFFFD@example.com' });
    mockStore[STORE_KEY] = Buffer.from(poisoned).toString('base64');
    expect(loadCodexTokens()).toBeNull();
  });

  it('rejects expiresAt: 0 (non-positive expiry; matches provider OAuth contract)', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    const zeroExpiry = JSON.stringify({ ...TOKENS, expiresAt: 0 });
    mockStore[STORE_KEY] = Buffer.from(zeroExpiry).toString('base64');
    expect(loadCodexTokens()).toBeNull();
  });

  it('rejects negative expiresAt', () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    const negExpiry = JSON.stringify({ ...TOKENS, expiresAt: -1 });
    mockStore[STORE_KEY] = Buffer.from(negExpiry).toString('base64');
    expect(loadCodexTokens()).toBeNull();
  });
});

describe('loadCodexTokens — cloud / mobile surface (no Electron module)', () => {
  beforeEach(() => {
    setSecureTokenStoreFactory(() => createCloudLikeSecureTokenStore());
    electronModulePresent = false;
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
  });

  it('round-trips plain-write + plain-read (cloud)', () => {
    saveCodexTokens(TOKENS);
    expect(loadCodexTokens()).toEqual(TOKENS);
  });

  it('CLEARS encrypted bytes from desktop migration archive (preserves 260428 contract)', () => {
    // Simulate a desktop user's encrypted-on-disk codex tokens being shipped
    // to cloud via the appdata migration archive. The bytes have a v10 header
    // but encryption is permanently unavailable on cloud — the only sane
    // recovery is to clear so the next desktop-driven sync lands cleanly.
    const encryptedBlob = Buffer.concat([
      Buffer.from('v10'),
      Buffer.from(JSON.stringify(TOKENS)),
    ]).toString('base64');
    mockStore[STORE_KEY] = encryptedBlob;

    expect(loadCodexTokens()).toBeNull();
    expect(mockStore[STORE_KEY]).toBeUndefined();
    expect(captureMessage).toHaveBeenCalledWith(
      'safestorage_unavailable_at_read',
      expect.objectContaining({ tags: { tokenKind: 'codex-oauth-token' } }),
    );
  });

  it('returns null for malformed plain JSON without clearing', () => {
    mockStore[STORE_KEY] = Buffer.from('{not json').toString('base64');
    const beforeBytes = mockStore[STORE_KEY];
    expect(loadCodexTokens()).toBeNull();
    expect(mockStore[STORE_KEY]).toBe(beforeBytes);
  });
});

describe('saveCodexTokens / clearCodexTokens / hasCodexTokens', () => {
  it('emits codexTokenEvents.changed with tokens on save', () => {
    const listener = vi.fn();
    codexTokenEvents.once('changed', listener);
    saveCodexTokens(TOKENS);
    expect(listener).toHaveBeenCalledWith(TOKENS);
  });

  it('emits codexTokenEvents.changed with null on clear', () => {
    const listener = vi.fn();
    codexTokenEvents.once('changed', listener);
    saveCodexTokens(TOKENS);
    listener.mockClear();
    codexTokenEvents.once('changed', listener);
    clearCodexTokens({ cause: 'manual_logout', source: 'codex_auth_core' });
    expect(listener).toHaveBeenCalledWith(null);
  });

  it('hasCodexTokens reflects presence', () => {
    expect(hasCodexTokens()).toBe(false);
    saveCodexTokens(TOKENS);
    expect(hasCodexTokens()).toBe(true);
    clearCodexTokens({ cause: 'manual_logout', source: 'codex_auth_core' });
    expect(hasCodexTokens()).toBe(false);
  });

  it('emits allowed payload only (no account identifiers) for connected telemetry', () => {
    saveCodexTokens(TOKENS, {
      cause: 'login_success',
      source: 'codex_auth_service',
    });

    const [event, payload] = track.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('Codex Auth Connected');
    expect(payload).toEqual({
      cause: 'login_success',
      source: 'codex_auth_service',
      surface: 'desktop',
    });
    expect(payload).not.toHaveProperty('accountEmail');
    expect(payload).not.toHaveProperty('accountId');
    expect(payload).not.toHaveProperty('tokens');
  });

  it('emits cause-tagged disconnect telemetry for each direct clear path', () => {
    const directClears = [
      { cause: 'manual_logout', source: 'codex_auth_core' },
      { cause: 'refresh_auth_failure', source: 'codex_auth_core', httpStatus: 401 },
      { cause: 'refresh_malformed_response', source: 'codex_auth_core' },
      { cause: 'sync_null', source: 'codex_sync_channel' },
      { cause: 'sync_null', source: 'codex_sync_route' },
    ] as const;

    for (const clearContext of directClears) {
      saveCodexTokens(TOKENS);
      track.mockClear();
      captureKnownCondition.mockClear();

      clearCodexTokens(clearContext);

      expect(track).toHaveBeenCalledWith(
        'Codex Auth Disconnected',
        expect.objectContaining({
          cause: clearContext.cause,
          source: clearContext.source,
          surface: 'desktop',
        }),
      );

      const shouldCaptureKnownCondition =
        clearContext.cause === 'refresh_auth_failure' || clearContext.cause === 'refresh_malformed_response';
      if (shouldCaptureKnownCondition) {
        expect(captureKnownCondition).toHaveBeenCalledWith(
          'codex_auth_destructive_disconnect',
          expect.objectContaining({
            cause: clearContext.cause,
            source: clearContext.source,
            surface: 'desktop',
          }),
          expect.any(Error),
        );
      } else {
        expect(captureKnownCondition).not.toHaveBeenCalled();
      }
    }
  });

  it('rejects reserved .corrupt.latest live keys at the secure token boundary (electron adapter)', () => {
    const backingStore: Record<string, unknown> = {};
    const secureStore = getSecureTokenStore();

    expect(() => {
      secureStore.write({
        store: {
          get: (key: string) => backingStore[key],
          set: (key: string, value: unknown) => { backingStore[key] = value; },
          has: (key: string) => key in backingStore,
          delete: (key: string) => { delete backingStore[key]; },
        },
        namespace: 'codex-oauth-tokens',
        key: 'encryptedTokens.corrupt.latest',
        value: 'abc',
      });
    }).toThrow(/reserved for corruption sidecars/i);

    expect(() => {
      secureStore.read({
        store: {
          get: (key: string) => backingStore[key],
          set: (key: string, value: unknown) => { backingStore[key] = value; },
          has: (key: string) => key in backingStore,
          delete: (key: string) => { delete backingStore[key]; },
        },
        namespace: 'codex-oauth-tokens',
        key: 'encryptedTokens.corrupt.latest',
        kind: 'codex-oauth-token',
        validate: () => true,
      });
    }).toThrow(/reserved for corruption sidecars/i);
  });
});

describe('pending cloud clear marker', () => {
  it('stores and clears a durable pending cloud-clear marker', () => {
    expect(hasPendingCodexCloudClear()).toBe(false);
    markPendingCodexCloudClear('mutation_post_failed');
    expect(hasPendingCodexCloudClear()).toBe(true);
    expect(mockStore[PENDING_CLOUD_CLEAR_KEY]).toEqual(
      expect.objectContaining({
        reason: 'mutation_post_failed',
      }),
    );

    clearPendingCodexCloudClear();
    expect(hasPendingCodexCloudClear()).toBe(false);
  });

  it('survives module reload (restart simulation) because marker is store-backed', async () => {
    const modBeforeReload = await import('../codexTokenStorage');
    modBeforeReload.markPendingCodexCloudClear('mutation_skipped_no_client');
    expect(modBeforeReload.hasPendingCodexCloudClear()).toBe(true);

    vi.resetModules();
    const modAfterReload = await import('../codexTokenStorage');
    expect(modAfterReload.hasPendingCodexCloudClear()).toBe(true);

    modAfterReload.clearPendingCodexCloudClear();
    expect(modAfterReload.hasPendingCodexCloudClear()).toBe(false);
  });
});
