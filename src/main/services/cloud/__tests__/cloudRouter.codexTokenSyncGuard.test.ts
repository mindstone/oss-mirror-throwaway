import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecureTokenStore } from '@core/secureTokenStore';
import { setSecureTokenStoreFactory } from '@core/secureTokenStore';
import {
  clearCodexTokens,
  clearPendingCodexCloudClear,
  codexTokenEvents,
  hasPendingCodexCloudClear,
  markPendingCodexCloudClear,
} from '@core/services/codexTokenStorage';
import { CloudRouter } from '../cloudRouter';

const captureKnownCondition = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());
const logDebug = vi.hoisted(() => vi.fn());

const codexStoreData = vi.hoisted(() => ({} as Record<string, unknown>));

vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: (...args: unknown[]) => captureKnownCondition(...args),
  recordKnownConditionLedgerOnly: vi.fn(),
}));

vi.mock('@core/storeFactory', () => ({
  createStore: () => ({
    get: (key: string) => codexStoreData[key],
    set: (key: string, value: unknown) => { codexStoreData[key] = value; },
    has: (key: string) => key in codexStoreData,
    delete: (key: string) => { delete codexStoreData[key]; },
    clear: () => {
      for (const key of Object.keys(codexStoreData)) {
        delete codexStoreData[key];
      }
    },
  }),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: (...args: unknown[]) => logDebug(...args),
    info: vi.fn(),
    warn: (...args: unknown[]) => logWarn(...args),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    isLevelEnabled: vi.fn(() => false),
  }),
}));

function createPlainSecureTokenStore(): SecureTokenStore {
  return {
    isEncryptionAvailable: () => false,
    read: ({ store, key, validate }) => {
      const raw = store.get(key);
      if (typeof raw !== 'string') return null;
      return validate(raw) ? raw : null;
    },
    write: ({ store, key, value }) => {
      store.set(key, value);
    },
    delete: ({ store, key }) => {
      store.delete(key);
    },
    has: ({ store, key }) => store.has(key),
  };
}

describe('CloudRouter Codex token sync null-guard', () => {
  let router: CloudRouter;
  let post: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = new CloudRouter();
    post = vi.fn().mockResolvedValue({ ok: true });
    captureKnownCondition.mockClear();
    logWarn.mockClear();
    logDebug.mockClear();
    for (const key of Object.keys(codexStoreData)) {
      delete codexStoreData[key];
    }
    setSecureTokenStoreFactory(() => createPlainSecureTokenStore());
    clearPendingCodexCloudClear();
    codexTokenEvents.removeAllListeners('changed');

    (router as unknown as { config: unknown }).config = {
      getSettings: () => ({
        cloudInstance: {
          mode: 'cloud',
          cloudUrl: 'https://example-cloud.invalid',
          cloudToken: 'token',
        },
      }),
    };
    (router as unknown as { getOrCreateClient: () => Promise<{ post: typeof post }> }).getOrCreateClient = async () => ({
      post,
    });
  });

  it('keeps mutation-source null pushes (logout propagation)', async () => {
    await (router as unknown as {
      pushCodexTokens: (tokens: unknown, options: { source: string }) => Promise<void>;
    }).pushCodexTokens(null, { source: 'mutation' });

    expect(post).toHaveBeenCalledWith('/api/codex/tokens', { tokens: null });
    expect(captureKnownCondition).not.toHaveBeenCalled();
    expect(hasPendingCodexCloudClear()).toBe(false);
  });

  it('eager-marks pending clear BEFORE the mutation-null POST resolves (app-exit-in-flight durability)', async () => {
    // If the process dies while the POST is in flight, the durable marker must
    // already exist — otherwise a logout-then-quit with cloud unreachable loses
    // the clear intent across restart (confirming-review F1).
    let observedDuringFlight: boolean | null = null;
    let releasePost: (() => void) | undefined;
    post.mockImplementationOnce(async () => {
      observedDuringFlight = hasPendingCodexCloudClear();
      await new Promise<void>((resolve) => { releasePost = resolve; });
      return { ok: true };
    });

    const pushPromise = (router as unknown as {
      pushCodexTokens: (tokens: unknown, options: { source: string }) => Promise<void>;
    }).pushCodexTokens(null, { source: 'mutation' });

    await vi.waitFor(() => { expect(observedDuringFlight).not.toBeNull(); });
    expect(observedDuringFlight).toBe(true);

    releasePost?.();
    await pushPromise;
    // Confirmed delivery clears the marker.
    expect(hasPendingCodexCloudClear()).toBe(false);
  });

  it('persists pending clear on failed mutation null push and replays it on sync null', async () => {
    post.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true });

    await (router as unknown as {
      pushCodexTokens: (tokens: unknown, options: { source: string }) => Promise<void>;
    }).pushCodexTokens(null, { source: 'mutation' });

    expect(hasPendingCodexCloudClear()).toBe(true);

    await (router as unknown as {
      pushCodexTokens: (tokens: unknown, options: { source: string }) => Promise<void>;
    }).pushCodexTokens(null, { source: 'sync' });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(1, '/api/codex/tokens', { tokens: null });
    expect(post).toHaveBeenNthCalledWith(2, '/api/codex/tokens', { tokens: null });
    expect(hasPendingCodexCloudClear()).toBe(false);
  });

  it('marks pending clear when mutation null push is skipped due to missing cloud client', async () => {
    (router as unknown as { getOrCreateClient: () => Promise<null> }).getOrCreateClient = async () => null;

    await (router as unknown as {
      pushCodexTokens: (tokens: unknown, options: { source: string }) => Promise<void>;
    }).pushCodexTokens(null, { source: 'mutation' });

    expect(hasPendingCodexCloudClear()).toBe(true);
  });

  it('does not emit warn/known-condition for routine codex-less sync null reads', async () => {
    await (router as unknown as {
      pushCodexTokens: (tokens: unknown, options: { source: string }) => Promise<void>;
    }).pushCodexTokens(null, { source: 'sync' });

    expect(post).not.toHaveBeenCalled();
    expect(captureKnownCondition).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalled();
  });

  it('emits warn+known-condition for transition from present tokens to sync null', async () => {
    await (router as unknown as {
      pushCodexTokens: (tokens: unknown, options: { source: string }) => Promise<void>;
    }).pushCodexTokens({ accessToken: 'new-token' }, { source: 'sync' });

    post.mockClear();
    captureKnownCondition.mockClear();
    logWarn.mockClear();

    await (router as unknown as {
      pushCodexTokens: (tokens: unknown, options: { source: string }) => Promise<void>;
    }).pushCodexTokens(null, { source: 'sync' });

    expect(post).not.toHaveBeenCalled();
    expect(captureKnownCondition).toHaveBeenCalledWith(
      'codex_auth_destructive_disconnect',
      expect.objectContaining({
        cause: 'sync_null_deletion_attempted',
        source: 'cloud_router_sync_guard',
      }),
      expect.any(Error),
    );
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: 'sync_null_deletion_attempted',
        source: 'cloud_router_sync_guard',
      }),
      expect.stringContaining('Skipping sync-source null Codex token push'),
    );
  });

  it('does not let a stale pending clear delete freshly pushed tokens', async () => {
    post.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true });

    await (router as unknown as {
      pushCodexTokens: (tokens: unknown, options: { source: string }) => Promise<void>;
    }).pushCodexTokens(null, { source: 'mutation' });
    expect(hasPendingCodexCloudClear()).toBe(true);

    await (router as unknown as {
      pushCodexTokens: (tokens: unknown, options: { source: string }) => Promise<void>;
    }).pushCodexTokens({ accessToken: 'new-token' }, { source: 'mutation' });
    expect(hasPendingCodexCloudClear()).toBe(false);

    post.mockClear();

    await (router as unknown as {
      pushCodexTokens: (tokens: unknown, options: { source: string }) => Promise<void>;
    }).pushCodexTokens(null, { source: 'sync' });

    expect(post).not.toHaveBeenCalled();
  });

  it('covers real clearCodexTokens -> event -> push wiring for mutation-source null', async () => {
    const listener = (tokens: unknown) => {
      void (router as unknown as {
        pushCodexTokens: (pushTokens: unknown, options: { source: string }) => Promise<void>;
      }).pushCodexTokens(tokens, { source: 'mutation' });
    };
    codexTokenEvents.on('changed', listener);
    try {
      clearCodexTokens({ cause: 'manual_logout', source: 'codex_auth_core' });
      await vi.waitFor(() => {
        expect(post).toHaveBeenCalledWith('/api/codex/tokens', { tokens: null });
      });
    } finally {
      codexTokenEvents.off('changed', listener);
    }
  });

  it('replays pending clear intent on sync null when marker survives process restart', async () => {
    markPendingCodexCloudClear('mutation_skipped_no_client');

    await (router as unknown as {
      pushCodexTokens: (tokens: unknown, options: { source: string }) => Promise<void>;
    }).pushCodexTokens(null, { source: 'sync' });

    expect(post).toHaveBeenCalledWith('/api/codex/tokens', { tokens: null });
    expect(hasPendingCodexCloudClear()).toBe(false);
  });
});
