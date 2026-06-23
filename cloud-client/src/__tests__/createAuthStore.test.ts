import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initAuthStore } from '../auth/createAuthStore';
import type { TokenStorage } from '../auth/types';
import * as cloudClient from '../cloudClient';

vi.mock('../cloudClient', () => ({
  configure: vi.fn(),
  clearConfig: vi.fn(),
  checkHealth: vi.fn(),
  getSettings: vi.fn(),
}));

function createMockStorage(): TokenStorage & {
  stored: { cloudUrl: string; token: string } | null;
  storedClientId: string | null;
} {
  const storage = {
    stored: null as { cloudUrl: string; token: string } | null,
    storedClientId: null as string | null,
    getToken: vi.fn(async () => storage.stored),
    setToken: vi.fn(async (cloudUrl: string, token: string) => { storage.stored = { cloudUrl, token }; }),
    clearToken: vi.fn(async () => { storage.stored = null; }),
    getClientId: vi.fn(async () => storage.storedClientId),
    setClientId: vi.fn(async (clientId: string) => { storage.storedClientId = clientId; }),
  };
  return storage;
}

describe('createAuthStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts unpaired and unresolved', () => {
    const storage = createMockStorage();
    const store = initAuthStore(storage);
    const state = store.getState();
    expect(state.isPaired).toBe(false);
    expect(state.cloudUrl).toBeNull();
    expect(state.token).toBeNull();
    expect(state.credentialsResolved).toBe(false);
  });

  describe('loadCredentials', () => {
    it('loads stored credentials and configures client', async () => {
      const storage = createMockStorage();
      storage.stored = { cloudUrl: 'https://test.example.com', token: 'tok-123' };
      storage.storedClientId = 'mobile-device-1';
      const store = initAuthStore(storage);

      await store.getState().loadCredentials();

      expect(cloudClient.configure).toHaveBeenCalledWith({
        cloudUrl: 'https://test.example.com',
        token: 'tok-123',
        clientId: 'mobile-device-1',
      });
      expect(store.getState().isPaired).toBe(true);
      expect(store.getState().cloudUrl).toBe('https://test.example.com');
      expect(store.getState().credentialsResolved).toBe(true);
    });

    it('stays unpaired but resolves when no stored credentials', async () => {
      const storage = createMockStorage();
      const store = initAuthStore(storage);

      await store.getState().loadCredentials();
      expect(store.getState().isPaired).toBe(false);
      // Storage answered definitively (no creds) — resolved is true so the
      // UI can transition from splash to pair screen.
      expect(store.getState().credentialsResolved).toBe(true);
    });

    it('stays unresolved (and unpaired) if storage throws', async () => {
      const storage = createMockStorage();
      storage.getToken = vi.fn(async () => { throw new Error('storage error'); });
      const store = initAuthStore(storage);

      await store.getState().loadCredentials();
      expect(store.getState().isPaired).toBe(false);
      // Critical: a transient storage error must NOT flip credentialsResolved
      // to true, otherwise the UI would surface the pairing flow to an
      // already-paired user (the bug this guard prevents on iOS Keychain
      // unavailability immediately after an app update).
      expect(store.getState().credentialsResolved).toBe(false);
    });

    it('resolves on a subsequent successful retry after a transient failure', async () => {
      const storage = createMockStorage();
      let shouldThrow = true;
      storage.getToken = vi.fn(async () => {
        if (shouldThrow) throw new Error('keychain transient');
        return { cloudUrl: 'https://retry.example.com', token: 'late-tok' };
      });
      const store = initAuthStore(storage);

      await store.getState().loadCredentials();
      expect(store.getState().credentialsResolved).toBe(false);
      expect(store.getState().isPaired).toBe(false);

      shouldThrow = false;
      await store.getState().loadCredentials();
      expect(store.getState().credentialsResolved).toBe(true);
      expect(store.getState().isPaired).toBe(true);
      expect(store.getState().cloudUrl).toBe('https://retry.example.com');
    });
  });

  describe('pair', () => {
    it('validates server, stores credentials, and marks paired', async () => {
      vi.mocked(cloudClient.checkHealth).mockResolvedValue({ status: 'ok', version: '1.0' });
      vi.mocked(cloudClient.getSettings).mockResolvedValue({ claude: {} });

      const storage = createMockStorage();
      const store = initAuthStore(storage);

      await store.getState().pair('https://my-cloud.fly.dev/', 'my-token ');

      expect(cloudClient.configure).toHaveBeenCalledWith(expect.objectContaining({
        cloudUrl: 'https://my-cloud.fly.dev',
        token: 'my-token',
      }));
      expect(storage.setToken).toHaveBeenCalledWith('https://my-cloud.fly.dev', 'my-token');
      expect(store.getState().isPaired).toBe(true);
      expect(store.getState().isValidating).toBe(false);
      expect(store.getState().error).toBeNull();
    });

    it('generates and persists a clientId when storage has none', async () => {
      vi.mocked(cloudClient.checkHealth).mockResolvedValue({ status: 'ok', version: '1.0' });
      vi.mocked(cloudClient.getSettings).mockResolvedValue({});

      const storage = createMockStorage();
      storage.storedClientId = null;
      const store = initAuthStore(storage);

      await store.getState().pair('https://device-scope.fly.dev', 'scope-token');

      expect(storage.setClientId).toHaveBeenCalledTimes(1);
      const configuredArg = vi.mocked(cloudClient.configure).mock.calls[0]?.[0];
      expect(configuredArg).toMatchObject({
        cloudUrl: 'https://device-scope.fly.dev',
        token: 'scope-token',
      });
      expect(typeof configuredArg?.clientId).toBe('string');
      expect(configuredArg?.clientId).toBe(storage.storedClientId);
    });

    it('trims URL and token', async () => {
      vi.mocked(cloudClient.checkHealth).mockResolvedValue({ status: 'ok', version: '1.0' });
      vi.mocked(cloudClient.getSettings).mockResolvedValue({});

      const storage = createMockStorage();
      const store = initAuthStore(storage);
      await store.getState().pair('  https://example.com/  ', '  tok  ');

      expect(store.getState().cloudUrl).toBe('https://example.com');
      expect(store.getState().token).toBe('tok');
    });

    it('sets error and clears config on health check failure', async () => {
      vi.mocked(cloudClient.checkHealth).mockResolvedValue({ status: 'unhealthy', version: '' });

      const storage = createMockStorage();
      const store = initAuthStore(storage);
      await store.getState().pair(TEST_URL, 'tok');

      expect(store.getState().isPaired).toBe(false);
      expect(store.getState().error).toBeTruthy();
      expect(cloudClient.clearConfig).toHaveBeenCalled();
    });

    it('sets network error message on timeout', async () => {
      vi.mocked(cloudClient.checkHealth).mockRejectedValue(new Error('abort'));

      const storage = createMockStorage();
      const store = initAuthStore(storage);
      await store.getState().pair(TEST_URL, 'tok');

      expect(store.getState().error).toContain('waking up');
      expect(store.getState().isPaired).toBe(false);
    });

    it('still marks paired if storage.setToken fails', async () => {
      vi.mocked(cloudClient.checkHealth).mockResolvedValue({ status: 'ok', version: '1.0' });
      vi.mocked(cloudClient.getSettings).mockResolvedValue({});

      const storage = createMockStorage();
      storage.setToken = vi.fn(async () => { throw new Error('storage write fail'); });
      const store = initAuthStore(storage);
      await store.getState().pair(TEST_URL, 'tok');

      expect(store.getState().isPaired).toBe(true);
    });
  });

  describe('unpair', () => {
    it('clears config, storage, and state', async () => {
      vi.mocked(cloudClient.checkHealth).mockResolvedValue({ status: 'ok', version: '1.0' });
      vi.mocked(cloudClient.getSettings).mockResolvedValue({});

      const storage = createMockStorage();
      const store = initAuthStore(storage);
      await store.getState().pair(TEST_URL, 'tok');
      expect(store.getState().isPaired).toBe(true);

      await store.getState().unpair();

      expect(cloudClient.clearConfig).toHaveBeenCalled();
      expect(storage.clearToken).toHaveBeenCalled();
      expect(store.getState().isPaired).toBe(false);
      expect(store.getState().cloudUrl).toBeNull();
      expect(store.getState().token).toBeNull();
    });

    it('still unpairs if storage.clearToken fails', async () => {
      const storage = createMockStorage();
      storage.clearToken = vi.fn(async () => { throw new Error('clear fail'); });
      const store = initAuthStore(storage);

      await store.getState().unpair();
      expect(store.getState().isPaired).toBe(false);
    });
  });

  describe('clearError', () => {
    it('clears the error state', async () => {
      vi.mocked(cloudClient.checkHealth).mockRejectedValue(new Error('fail'));

      const storage = createMockStorage();
      const store = initAuthStore(storage);
      await store.getState().pair(TEST_URL, 'tok');
      expect(store.getState().error).toBeTruthy();

      store.getState().clearError();
      expect(store.getState().error).toBeNull();
    });
  });
});

const TEST_URL = 'https://test.example.com';
