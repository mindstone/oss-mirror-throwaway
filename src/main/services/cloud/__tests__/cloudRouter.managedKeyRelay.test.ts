import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearManagedOpenRouterKey,
  clearPendingManagedKeyCloudClear,
  hasPendingManagedKeyCloudClear,
  markPendingManagedKeyCloudClear,
  saveManagedOpenRouterKey,
} from '@main/services/openRouterTokenStorage';
import { CloudRouter } from '../cloudRouter';

const logWarn = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());
const logDebug = vi.hoisted(() => vi.fn());

// Shared in-memory store backing both the managed-key slot and the
// managed pending-clear marker (mirrors the codex sync-guard test harness).
const storeData = vi.hoisted(() => ({} as Record<string, unknown>));

vi.mock('@core/storeFactory', () => ({
  createStore: () => ({
    get: (key: string) => storeData[key],
    set: (key: string, value: unknown) => { storeData[key] = value; },
    has: (key: string) => key in storeData,
    delete: (key: string) => { delete storeData[key]; },
    clear: () => {
      for (const key of Object.keys(storeData)) {
        delete storeData[key];
      }
    },
  }),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: (...args: unknown[]) => logDebug(...args),
    info: (...args: unknown[]) => logInfo(...args),
    warn: (...args: unknown[]) => logWarn(...args),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    isLevelEnabled: vi.fn(() => false),
  }),
}));

const SECRET_KEY = 'sk-or-managed-secret-do-not-log';

type RelayFn = (apiKey: string | null, options: { source: string }) => Promise<void>;

function relay(router: CloudRouter): RelayFn {
  return (router as unknown as { pushManagedOpenRouterKey: RelayFn }).pushManagedOpenRouterKey.bind(router);
}

describe('CloudRouter managed-key relay', () => {
  let router: CloudRouter;
  let post: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = new CloudRouter();
    post = vi.fn().mockResolvedValue({ ok: true });
    logWarn.mockClear();
    logInfo.mockClear();
    logDebug.mockClear();
    for (const key of Object.keys(storeData)) {
      delete storeData[key];
    }
    clearPendingManagedKeyCloudClear();

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

  it('relays the key to /api/openrouter/managed-key on a mutation save', async () => {
    await relay(router)(SECRET_KEY, { source: 'mutation' });

    expect(post).toHaveBeenCalledWith('/api/openrouter/managed-key', { apiKey: SECRET_KEY });
    expect(hasPendingManagedKeyCloudClear()).toBe(false);
  });

  it('relays a clear (null) on a mutation clear/revoke', async () => {
    await relay(router)(null, { source: 'mutation' });

    expect(post).toHaveBeenCalledWith('/api/openrouter/managed-key', { apiKey: null });
    expect(hasPendingManagedKeyCloudClear()).toBe(false);
  });

  it('never logs the key bytes (presence-only logging)', async () => {
    await relay(router)(SECRET_KEY, { source: 'mutation' });

    const allLogArgs = JSON.stringify([
      ...logInfo.mock.calls,
      ...logWarn.mock.calls,
      ...logDebug.mock.calls,
    ]);
    expect(allLogArgs).not.toContain(SECRET_KEY);
    // The POST body carries the key (that is the relay) but logs must not.
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ hasKey: true, source: 'mutation' }),
      'Managed OpenRouter key relayed to cloud',
    );
  });

  // --- Destructive-null guard ------------------------------------------------

  it('does NOT relay a clear on a transient sync read-null when no key was seen before', async () => {
    await relay(router)(null, { source: 'sync' });

    expect(post).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('does NOT relay a clear on a sync read-null after a key was present (transient read protection)', async () => {
    await relay(router)(SECRET_KEY, { source: 'sync' });
    post.mockClear();
    logWarn.mockClear();

    await relay(router)(null, { source: 'sync' });

    expect(post).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'sync' }),
      expect.stringContaining('Skipping sync-source null managed key relay to avoid unintended cloud key deletion'),
    );
  });

  it('eager-marks pending clear BEFORE a mutation-null POST resolves (app-exit-in-flight durability)', async () => {
    let observedDuringFlight: boolean | null = null;
    let releasePost: (() => void) | undefined;
    post.mockImplementationOnce(async () => {
      observedDuringFlight = hasPendingManagedKeyCloudClear();
      await new Promise<void>((resolve) => { releasePost = resolve; });
      return { ok: true };
    });

    const p = relay(router)(null, { source: 'mutation' });
    await vi.waitFor(() => { expect(observedDuringFlight).not.toBeNull(); });
    expect(observedDuringFlight).toBe(true);

    releasePost?.();
    await p;
    expect(hasPendingManagedKeyCloudClear()).toBe(false);
  });

  it('persists pending clear on a failed mutation-null relay and replays it on sync null', async () => {
    post.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true });

    await relay(router)(null, { source: 'mutation' });
    expect(hasPendingManagedKeyCloudClear()).toBe(true);

    await relay(router)(null, { source: 'sync' });

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(2, '/api/openrouter/managed-key', { apiKey: null });
    expect(hasPendingManagedKeyCloudClear()).toBe(false);
  });

  it('replays a pending clear that survived a process restart on the next sync null', async () => {
    markPendingManagedKeyCloudClear('mutation_skipped_no_client');

    await relay(router)(null, { source: 'sync' });

    expect(post).toHaveBeenCalledWith('/api/openrouter/managed-key', { apiKey: null });
    expect(hasPendingManagedKeyCloudClear()).toBe(false);
  });

  it('does not let a stale pending clear delete a freshly relayed key', async () => {
    post.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true });

    await relay(router)(null, { source: 'mutation' });
    expect(hasPendingManagedKeyCloudClear()).toBe(true);

    await relay(router)(SECRET_KEY, { source: 'mutation' });
    expect(hasPendingManagedKeyCloudClear()).toBe(false);

    post.mockClear();
    await relay(router)(null, { source: 'sync' });
    expect(post).not.toHaveBeenCalled();
  });

  // --- Cloud-instance precondition (no POST to nowhere) ----------------------

  it('does NOT relay when no cloud instance is configured (no client)', async () => {
    (router as unknown as { getOrCreateClient: () => Promise<null> }).getOrCreateClient = async () => null;

    await relay(router)(SECRET_KEY, { source: 'mutation' });

    expect(post).not.toHaveBeenCalled();
  });

  it('marks pending clear when a mutation-null relay is skipped due to missing cloud client', async () => {
    (router as unknown as { getOrCreateClient: () => Promise<null> }).getOrCreateClient = async () => null;

    await relay(router)(null, { source: 'mutation' });

    expect(post).not.toHaveBeenCalled();
    expect(hasPendingManagedKeyCloudClear()).toBe(true);
  });

  // --- F1: replay current key on initial connect + manual/full sync ----------
  //
  // The relay previously fired only on save/clear mutations and WS reconnect,
  // NOT on the initial cloud connect or `syncNow()`. So an already-provisioned
  // desktop key (the common case) stayed missing on cloud until an incidental
  // reconnect. `pushCurrentManagedKey()` is the shared helper both paths invoke.

  describe('pushCurrentManagedKey (initial-connect / syncNow replay)', () => {
    type CurrentFn = () => Promise<void>;
    function pushCurrent(r: CloudRouter): CurrentFn {
      return (r as unknown as { pushCurrentManagedKey: CurrentFn }).pushCurrentManagedKey.bind(r);
    }

    afterEach(() => {
      clearManagedOpenRouterKey();
    });

    it('(a) relays the CURRENTLY-STORED managed key with source:"sync" (existing-key initial sync)', async () => {
      // Desktop already has a managed key BEFORE cloud pairing (the common case).
      saveManagedOpenRouterKey(SECRET_KEY);

      await pushCurrent(router)();

      expect(post).toHaveBeenCalledWith('/api/openrouter/managed-key', { apiKey: SECRET_KEY });
      expect(logInfo).toHaveBeenCalledWith(
        expect.objectContaining({ hasKey: true, source: 'sync' }),
        'Managed OpenRouter key relayed to cloud',
      );
    });

    it('(c) replays a durable pending-clear (revoke) on sync even though the store has no key', async () => {
      // No stored key, but a pending revoke-clear survived (e.g. app exited
      // mid-clear). Sync must replay the clear.
      markPendingManagedKeyCloudClear('mutation_skipped_no_client');

      await pushCurrent(router)();

      expect(post).toHaveBeenCalledWith('/api/openrouter/managed-key', { apiKey: null });
      expect(hasPendingManagedKeyCloudClear()).toBe(false);
    });

    it('(d) does NOT relay a clear on a transient read-null (no key, no pending clear)', async () => {
      // Store has no key and there is no genuine clear intent — a sync replay
      // must not wipe a possibly-valid cloud key.
      await pushCurrent(router)();

      expect(post).not.toHaveBeenCalled();
    });
  });

  // --- F1 (b): syncNow re-pushes the current managed key beside codex --------

  it('(b) syncNow() re-pushes the current managed key beside the codex push', async () => {
    saveManagedOpenRouterKey(SECRET_KEY);

    // Stub the heavy sync phases so we can drive the real syncNow() to the
    // codex/managed relay block without standing up the whole sync surface.
    const stub = router as unknown as Record<string, unknown>;
    stub.shouldRouteToCloud = () => true;
    stub.pullChangedSessions = async () => {};
    stub.pushSessionsToCloud = async () => {};
    stub.pullInboxChanges = async () => {};
    stub.pushInboxToCloud = async () => {};
    stub.forceWorkspaceSync = async () => ({ success: true, pushed: 0, skipped: 0, failed: 0 });
    stub.forwardSettingsUpdate = async () => {};
    stub.pushContinuityStateMap = async () => {};
    const pushCodex = vi.fn(async () => {});
    stub.pushCodexTokens = pushCodex;
    stub.drainOutbox = async () => {};
    stub.triggerStagingBridgeSync = () => {};

    const result = await router.syncNow();

    expect(result.success).toBe(true);
    // Codex pushed (precedent) AND managed key relayed beside it.
    expect(pushCodex).toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith('/api/openrouter/managed-key', { apiKey: SECRET_KEY });

    clearManagedOpenRouterKey();
  });
});
