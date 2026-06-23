import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bootToken = {
  schemaVersion: 1 as const,
  routerToken: 'router-token',
  bridgeOrigin: 'http://127.0.0.1:52320',
  port: 52320,
  startedAt: '2026-04-23T12:00:00.000Z',
  installSessionId: 'inst_123456',
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

describe('BrowserInstallController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function importController(options?: {
    localState?: Record<string, unknown>;
    sessionState?: Record<string, unknown>;
    fetchImpl?: typeof fetch;
  }) {
    vi.resetModules();
    const local = createStorageArea(options?.localState);
    const session = createStorageArea(options?.sessionState);
    const runtimeSendMessage = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getURL: vi.fn((relativePath: string) => `chrome-extension://test/${relativePath}`),
        sendMessage: runtimeSendMessage,
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
      storage: {
        local,
        session,
      },
      tabs: {
        get: vi.fn(),
        query: vi.fn(),
        sendMessage: vi.fn(),
      },
      scripting: {
        executeScript: vi.fn(),
      },
      windows: {
        getCurrent: vi.fn(),
      },
      sidePanel: {
        open: vi.fn(async () => undefined),
      },
    });
    if (options?.fetchImpl) {
      vi.stubGlobal('fetch', options.fetchImpl);
    }
    const mod = await import('../../src/background/serviceWorker');
    return {
      BrowserInstallController: mod.BrowserInstallController,
      runtimeSendMessage,
      local,
      session,
    };
  }

  it('surfaces boot-token-missing when the bundled file is absent', async () => {
    const { BrowserInstallController, session } = await importController({
      fetchImpl: vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
    });

    const controller = new BrowserInstallController(async () => undefined);
    await controller.handleWake();

    await expect(controller.getStatus()).resolves.toEqual({ kind: 'boot-token-missing' });
    expect(session.state['rebel.session.v1']).toBeUndefined();
  });

  it('retries transient mint failures with backoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => bootToken,
      })
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => bootToken,
      })
      .mockRejectedValueOnce(new Error('still down'));
    const { BrowserInstallController } = await importController({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const controller = new BrowserInstallController(async () => undefined);
    await controller.handleWake();

    await expect(controller.getStatus()).resolves.toEqual({
      kind: 'mint-failed-transient',
      attempt: 1,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('surfaces mint-forbidden without retrying', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => bootToken,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers(),
        json: async () => ({ reason: 'install-session-revoked' }),
      });
    const { BrowserInstallController } = await importController({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const controller = new BrowserInstallController(async () => undefined);
    await controller.handleWake();

    await expect(controller.getStatus()).resolves.toEqual({
      kind: 'mint-forbidden',
      reason: 'install-session-revoked',
    });

    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stores the minted session token and nudges the offscreen document to reconnect', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => bootToken,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ ok: true, token: 'minted-token' }),
      });
    const { BrowserInstallController, runtimeSendMessage, session } = await importController({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const controller = new BrowserInstallController(async () => undefined);
    await controller.handleWake();

    expect(session.state['rebel.session.v1']).toEqual({
      token: 'minted-token',
      installSessionId: 'inst_123456',
    });
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      type: 'mint-updated',
    });
    await expect(controller.getStatus()).resolves.toEqual({ kind: 'connecting', port: 52320 });
  });

  it('clears the session token when the user revokes the install', async () => {
    const { BrowserInstallController, session } = await importController({
      sessionState: {
        'rebel.session.v1': {
          token: 'minted-token',
          installSessionId: 'inst_123456',
        },
      },
    });

    const controller = new BrowserInstallController(async () => undefined);
    await controller.handleAuthInvalidated();

    expect(session.state['rebel.session.v1']).toBeUndefined();
    await expect(controller.getStatus()).resolves.toEqual({ kind: 'revoked-by-user' });
  });
});
