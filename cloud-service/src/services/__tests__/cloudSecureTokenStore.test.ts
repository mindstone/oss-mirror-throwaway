import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDegradedLatchForTesting } from '@core/services/safeStorageDecode';
import { CloudSecureTokenStore } from '../cloudSecureTokenStore';

const { addBreadcrumb, captureMessage, warn } = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureMessage: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    addBreadcrumb,
    captureException: vi.fn(),
    captureMessage,
    captureExceptionWithScope: vi.fn(),
  }),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    isLevelEnabled: vi.fn(() => false),
  }),
}));

type MemoryStore = Record<string, unknown>;

function createStore(): {
  raw: MemoryStore;
  store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
    delete: (key: string) => void;
    has: (key: string) => boolean;
  };
} {
  const raw: MemoryStore = {};
  return {
    raw,
    store: {
      get: (key) => raw[key],
      set: (key, value) => { raw[key] = value; },
      delete: (key) => { delete raw[key]; },
      has: (key) => key in raw,
    },
  };
}

describe('CloudSecureTokenStore', () => {
  beforeEach(() => {
    addBreadcrumb.mockClear();
    captureMessage.mockClear();
    warn.mockClear();
    __resetDegradedLatchForTesting();
  });

  it('emits plaintext fallback observability once per process', () => {
    const secureStore = new CloudSecureTokenStore();
    const { store } = createStore();

    secureStore.write({ store, namespace: 'fly-tokens', key: 'encryptedFlyApiToken', value: 'token-1' });
    secureStore.write({ store, namespace: 'fly-tokens', key: 'encryptedFlyApiToken', value: 'token-2' });

    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'fly-tokens', key: 'encryptedFlyApiToken' }),
      'secure-token-store.fallback-plaintext',
    );
  });

  it('quarantines unrecoverable encrypted rows on read and lets plaintext writes replace them', () => {
    const secureStore = new CloudSecureTokenStore();
    const { raw, store } = createStore();
    const key = 'encryptedTokens';
    const sidecarKey = `${key}.corrupt.latest`;
    const encryptedBlob = Buffer.from('v10ciphertext').toString('base64');
    raw[key] = encryptedBlob;

    const value = secureStore.read({
      store,
      namespace: 'codex-oauth-tokens',
      key,
      kind: 'codex-oauth-token',
      validate: () => true,
    });

    expect(value).toBeNull();
    expect(raw[key]).toBeUndefined();
    expect(raw[sidecarKey]).toEqual(
      expect.objectContaining({
        namespace: 'codex-oauth-tokens',
        key,
        kind: 'unavailable_encrypted',
        stored: encryptedBlob,
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'codex-oauth-tokens', key }),
      'secure-token-store.quarantine',
    );
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'secure-token-store.quarantine',
        level: 'warning',
        data: expect.objectContaining({ namespace: 'codex-oauth-tokens', key }),
      }),
    );

    secureStore.write({
      store,
      namespace: 'codex-oauth-tokens',
      key,
      value: 'replacement-token',
    });

    expect(Buffer.from(String(raw[key]), 'base64').toString('utf-8')).toBe('replacement-token');
  });

  it('self-heals stranded encrypted rows on first read and stays silent on subsequent reads', () => {
    const secureStore = new CloudSecureTokenStore();
    const { raw, store } = createStore();
    const key = 'encryptedTokens';
    const sidecarKey = `${key}.corrupt.latest`;
    const encryptedBlob = Buffer.concat([
      Buffer.from('v10'),
      Buffer.from('ciphertext-bytes'),
    ]).toString('base64');
    raw[key] = encryptedBlob;

    const first = secureStore.read({
      store,
      namespace: 'openrouter-oauth-tokens',
      key,
      kind: 'openrouter-oauth-token',
      validate: () => true,
    });

    expect(first).toBeNull();
    expect(raw[key]).toBeUndefined();
    expect(raw[sidecarKey]).toEqual(
      expect.objectContaining({
        namespace: 'openrouter-oauth-tokens',
        key,
        kind: 'unavailable_encrypted',
        stored: encryptedBlob,
      }),
    );
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'safestorage_unavailable_at_read',
      expect.objectContaining({ tags: { tokenKind: 'openrouter-oauth-token' } }),
    );
    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'secure-token-store.quarantine',
        data: expect.objectContaining({
          namespace: 'openrouter-oauth-tokens',
          key,
        }),
      }),
    );

    captureMessage.mockClear();
    addBreadcrumb.mockClear();

    const second = secureStore.read({
      store,
      namespace: 'openrouter-oauth-tokens',
      key,
      kind: 'openrouter-oauth-token',
      validate: () => true,
    });

    expect(second).toBeNull();
    expect(captureMessage).not.toHaveBeenCalled();
    expect(addBreadcrumb).not.toHaveBeenCalled();
  });

  it('rejects reserved .corrupt.latest live keys', () => {
    const secureStore = new CloudSecureTokenStore();
    const { store } = createStore();

    expect(() => {
      secureStore.write({
        store,
        namespace: 'codex-oauth-tokens',
        key: 'encryptedTokens.corrupt.latest',
        value: 'token',
      });
    }).toThrow(/reserved for corruption sidecars/i);

    expect(() => {
      secureStore.read({
        store,
        namespace: 'codex-oauth-tokens',
        key: 'encryptedTokens.corrupt.latest',
        kind: 'codex-oauth-token',
        validate: () => true,
      });
    }).toThrow(/reserved for corruption sidecars/i);
  });
});
