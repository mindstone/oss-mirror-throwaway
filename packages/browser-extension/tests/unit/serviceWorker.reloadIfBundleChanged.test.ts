import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bootToken = {
  schemaVersion: 1 as const,
  routerToken: 'router-token',
  bridgeOrigin: 'http://127.0.0.1:52320',
  port: 52320,
  startedAt: '2026-04-23T12:00:00.000Z',
  installSessionId: 'inst_new_id',
};

function createStorageArea(initialState: Record<string, unknown> = {}) {
  const state = { ...initialState };
  return {
    state,
    get: vi.fn(async (key?: string | string[]) => {
      if (!key) return { ...state };
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map((entry) => [entry, state[entry]]));
      }
      return { [key]: state[key] };
    }),
    set: vi.fn(async (next: Record<string, unknown>) => {
      Object.assign(state, next);
    }),
    remove: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const entry of keys) {
        delete state[entry];
      }
    }),
  };
}

describe('reloadIfBundleChanged', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function loadSW(options: {
    localState?: Record<string, unknown>;
    bootTokenOverride?: Partial<typeof bootToken> | null;
  }) {
    vi.resetModules();
    const local = createStorageArea(options.localState);
    const session = createStorageArea({});
    const runtimeReload = vi.fn();
    const fetchMock =
      options.bootTokenOverride === null
        ? vi.fn(async () => ({ ok: false, status: 404 }))
        : vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ ...bootToken, ...(options.bootTokenOverride ?? {}) }),
          }));
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getURL: vi.fn((relativePath: string) => `chrome-extension://test/${relativePath}`),
        sendMessage: vi.fn(async () => undefined),
        reload: runtimeReload,
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
        getContexts: vi.fn().mockResolvedValue([]),
      },
      action: {
        setBadgeText: vi.fn(async () => undefined),
        setBadgeBackgroundColor: vi.fn(async () => undefined),
        openPopup: vi.fn(async () => undefined),
      },
      alarms: {
        create: vi.fn(),
        onAlarm: { addListener: vi.fn() },
      },
      offscreen: {
        createDocument: vi.fn(async () => undefined),
      },
      storage: { local, session },
      tabs: { get: vi.fn(), query: vi.fn(), sendMessage: vi.fn() },
      scripting: { executeScript: vi.fn() },
      windows: { getCurrent: vi.fn() },
      sidePanel: { open: vi.fn(async () => undefined) },
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const mod = await import('../../src/background/serviceWorker');
    return { reloadIfBundleChanged: mod.reloadIfBundleChanged, local, runtimeReload };
  }

  it('stores the installSessionId on first load without reloading', async () => {
    const { reloadIfBundleChanged, local, runtimeReload } = await loadSW({});
    await reloadIfBundleChanged();
    expect(local.state['rebel.lastInstallSessionId']).toBe('inst_new_id');
    expect(runtimeReload).not.toHaveBeenCalled();
  });

  it('does not reload when the installSessionId is unchanged', async () => {
    const { reloadIfBundleChanged, local, runtimeReload } = await loadSW({
      localState: { 'rebel.lastInstallSessionId': 'inst_new_id' },
    });
    await reloadIfBundleChanged();
    expect(local.state['rebel.lastInstallSessionId']).toBe('inst_new_id');
    expect(runtimeReload).not.toHaveBeenCalled();
  });

  it('updates storage then reloads when the installSessionId changes', async () => {
    const { reloadIfBundleChanged, local, runtimeReload } = await loadSW({
      localState: { 'rebel.lastInstallSessionId': 'inst_old_id' },
    });
    await reloadIfBundleChanged();
    // Storage is updated BEFORE reload — guarantees no reload loop after
    // the SW comes back up reading the same on-disk id.
    expect(local.state['rebel.lastInstallSessionId']).toBe('inst_new_id');
    expect(runtimeReload).toHaveBeenCalledTimes(1);
  });

  it('is a silent no-op when the boot token file is missing', async () => {
    const { reloadIfBundleChanged, local, runtimeReload } = await loadSW({
      bootTokenOverride: null,
    });
    await reloadIfBundleChanged();
    expect(local.state['rebel.lastInstallSessionId']).toBeUndefined();
    expect(runtimeReload).not.toHaveBeenCalled();
  });
});
