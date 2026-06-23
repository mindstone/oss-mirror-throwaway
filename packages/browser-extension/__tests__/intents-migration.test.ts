import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOCAL_AUTH_STORAGE_KEY,
  SESSION_AUTH_STORAGE_KEY,
} from '../src/lib/browserAuth';
import type { PortDiscovery } from '../src/lib/port-discovery';

interface StorageHarness {
  emitStorageChange: (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: chrome.storage.AreaName,
  ) => void;
  setSessionAuth: (next: { token: string; installSessionId?: string } | null) => void;
  readSessionAuth: () => { token: string; installSessionId?: string } | null;
}

function pickStorageValues(
  source: Record<string, unknown>,
  key?: string | string[] | Record<string, unknown> | null,
): Record<string, unknown> {
  if (key === null || key === undefined) {
    return { ...source };
  }
  if (typeof key === 'string') {
    return { [key]: source[key] };
  }
  if (Array.isArray(key)) {
    return Object.fromEntries(key.map((entry) => [entry, source[entry]]));
  }
  if (typeof key === 'object') {
    const out: Record<string, unknown> = {};
    for (const [entry, fallback] of Object.entries(key)) {
      out[entry] = entry in source ? source[entry] : fallback;
    }
    return out;
  }
  return {};
}

function setupChromeStorage(initial: {
  clientId: string;
  token: string;
  fingerprint?: string;
}): StorageHarness {
  const localState: Record<string, unknown> = {
    [LOCAL_AUTH_STORAGE_KEY]: {
      clientId: initial.clientId,
      ...(initial.fingerprint ? { fingerprint: initial.fingerprint } : {}),
    },
  };
  const sessionState: Record<string, unknown> = {
    [SESSION_AUTH_STORAGE_KEY]: {
      token: initial.token,
      installSessionId: 'inst_1',
    },
  };
  const listeners: Array<
    (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: chrome.storage.AreaName,
    ) => void
  > = [];

  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => []),
    },
    storage: {
      local: {
        get: vi.fn(async (key?: string | string[] | Record<string, unknown> | null) =>
          pickStorageValues(localState, key)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localState, items);
        }),
      },
      session: {
        get: vi.fn(async (key?: string | string[] | Record<string, unknown> | null) =>
          pickStorageValues(sessionState, key)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionState, items);
        }),
        remove: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const entry of keys) {
            delete sessionState[entry];
          }
        }),
      },
      onChanged: {
        addListener: vi.fn((listener) => {
          listeners.push(listener);
        }),
        removeListener: vi.fn((listener) => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        }),
      },
    },
  });

  return {
    emitStorageChange(changes, areaName) {
      for (const listener of listeners.slice()) {
        listener(changes, areaName);
      }
    },
    setSessionAuth(next) {
      if (!next) {
        delete sessionState[SESSION_AUTH_STORAGE_KEY];
        return;
      }
      sessionState[SESSION_AUTH_STORAGE_KEY] = {
        token: next.token,
        ...(next.installSessionId ? { installSessionId: next.installSessionId } : {}),
      };
    },
    readSessionAuth() {
      const raw = sessionState[SESSION_AUTH_STORAGE_KEY];
      if (!raw || typeof raw !== 'object') return null;
      const record = raw as Record<string, unknown>;
      const token = typeof record.token === 'string' ? record.token : null;
      if (!token) return null;
      return {
        token,
        ...(typeof record.installSessionId === 'string'
          ? { installSessionId: record.installSessionId }
          : {}),
      };
    },
  };
}

function makeDiscovery(args: {
  getPort: () => Promise<ReturnType<PortDiscovery['peekCache']>>;
  refresh?: () => Promise<ReturnType<PortDiscovery['peekCache']>>;
}): PortDiscovery {
  return {
    getPort: args.getPort,
    refresh: args.refresh ?? args.getPort,
    invalidate: () => undefined,
    peekCache: () => null,
  };
}

async function importIntentsModule() {
  vi.resetModules();
  return import('../src/lib/intents');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Stage 3 intents migration regression', () => {
  it('keeps legacy URL/header/body contract while adding X-Rebel-Diag-Id', async () => {
    setupChromeStorage({
      clientId: 'client-from-storage',
      token: 'token-from-storage',
      fingerprint: 'fingerprint-from-storage',
    });
    const intents = await importIntentsModule();
    const discovery = makeDiscovery({
      getPort: async () => ({
        port: 52320,
        origin: 'http://127.0.0.1:52320',
        cachedAt: Date.now(),
      }),
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          conversationId: 'conv-1',
          messageId: 'msg-1',
          state: 'submitted',
          queueSize: 0,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const result = await intents.sendMessage({
      conversationId: 'conv-1',
      clientId: 'legacy-client-id',
      token: 'legacy-token',
      fingerprint: 'legacy-fingerprint',
      text: 'hello world',
      fetchImpl: fetchMock as unknown as typeof fetch,
      portDiscovery: discovery,
    });

    expect(result).toEqual({
      ok: true,
      messageId: 'msg-1',
      state: 'submitted',
      queueSize: 0,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:52320/intent/conversation/conv-1/message');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer token-from-storage');
    expect(headers.get('x-rebel-app-id')).toBe('browser-extension');
    expect(headers.get('x-rebel-client-id')).toBe('client-from-storage');
    expect(headers.get('x-rebel-client-fingerprint')).toBe('fingerprint-from-storage');
    expect(headers.get('x-rebel-diag-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      appId: 'browser-extension',
      clientId: 'legacy-client-id',
      text: 'hello world',
    });
  });

  it('clears cached auth on chrome.storage.onChanged auth reset and uses fresh headers', async () => {
    const storage = setupChromeStorage({
      clientId: 'client-1',
      token: 'token-old',
      fingerprint: 'fp-1',
    });
    const intents = await importIntentsModule();
    const discovery = makeDiscovery({
      getPort: async () => ({
        port: 52320,
        origin: 'http://127.0.0.1:52320',
        cachedAt: Date.now(),
      }),
    });
    const authHeaders: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authHeaders.push(headers.get('authorization') ?? '');
      return new Response(
        JSON.stringify({
          conversationId: 'conv-1',
          messageId: 'msg-1',
          state: 'submitted',
          queueSize: 0,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    await intents.sendMessage({
      conversationId: 'conv-1',
      clientId: 'legacy-client-id',
      token: 'legacy-token',
      text: 'before reset',
      fetchImpl: fetchMock as unknown as typeof fetch,
      portDiscovery: discovery,
    });

    const oldSession = storage.readSessionAuth();
    storage.setSessionAuth(null);
    storage.emitStorageChange(
      {
        [SESSION_AUTH_STORAGE_KEY]: {
          oldValue: oldSession,
          newValue: undefined,
        },
      },
      'session',
    );
    storage.setSessionAuth({ token: 'token-new', installSessionId: 'inst_2' });
    storage.emitStorageChange(
      {
        [SESSION_AUTH_STORAGE_KEY]: {
          oldValue: undefined,
          newValue: storage.readSessionAuth(),
        },
      },
      'session',
    );

    await intents.sendMessage({
      conversationId: 'conv-1',
      clientId: 'legacy-client-id',
      token: 'legacy-token',
      text: 'after reset',
      fetchImpl: fetchMock as unknown as typeof fetch,
      portDiscovery: discovery,
    });

    expect(authHeaders[0]).toBe('Bearer token-old');
    expect(authHeaders[1]).toBe('Bearer token-new');
  });

  it('reports reachability through the transport adapter', async () => {
    setupChromeStorage({
      clientId: 'client-1',
      token: 'token-1',
    });
    const intents = await importIntentsModule();
    let reachable = false;
    const discovery = makeDiscovery({
      getPort: async () => (
        reachable
          ? {
              port: 52320,
              origin: 'http://127.0.0.1:52320',
              cachedAt: Date.now(),
            }
          : null
      ),
      refresh: async () => (
        reachable
          ? {
              port: 52320,
              origin: 'http://127.0.0.1:52320',
              cachedAt: Date.now(),
            }
          : null
      ),
    });

    const adapter = intents.createExtensionTransportAdapter({
      portDiscovery: discovery,
      authSnapshotReader: async () => ({
        clientId: 'client-1',
        token: 'token-1',
        fingerprint: null,
      }),
    });

    expect(await adapter.isReachable()).toBe(false);
    reachable = true;
    expect(await adapter.isReachable()).toBe(true);
  });
});
