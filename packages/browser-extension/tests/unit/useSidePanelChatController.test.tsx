// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOCAL_AUTH_STORAGE_KEY = 'rebel.auth.v1';
const SESSION_AUTH_STORAGE_KEY = 'rebel.session-auth.v1';

interface PairingSnapshotStub {
  clientId: string | null;
  token: string | null;
  fingerprint: string | null;
}

type RuntimeSendMessageResponse =
  | {
      ok: boolean;
      tabContext: {
        tabId: number;
        windowId: number;
        url: string;
        title: string;
      };
    }
  | { status: { kind: string } };

type StorageListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: chrome.storage.AreaName,
) => void;

function createStorageArea(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys == null) {
        return Object.fromEntries(store.entries());
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, store.get(key)]));
      }
      return { [keys]: store.get(keys) };
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        store.delete(key);
      }
    }),
  };
}

function createChromeMock() {
  const storageListeners = new Set<StorageListener>();
  const messageListeners = new Set<(message: unknown) => void>();
  const tabA = {
    tabId: 11,
    windowId: 1,
    url: 'https://example.com/a',
    title: 'A',
  };
  return {
    local: createStorageArea(),
    session: createStorageArea(),
    storageListeners,
    messageListeners,
    chrome: {
      runtime: {
        sendMessage: vi.fn(async (message: { type?: string } | undefined) => {
          if (message?.type === 'get-active-scope') {
            return { ok: true, tabContext: tabA };
          }
          return { status: { kind: 'connected' } };
        }),
        onMessage: {
          addListener: vi.fn((listener: (message: unknown) => void) => {
            messageListeners.add(listener);
          }),
          removeListener: vi.fn((listener: (message: unknown) => void) => {
            messageListeners.delete(listener);
          }),
        },
      },
      windows: {
        getCurrent: vi.fn(async () => ({ id: 1 })),
      },
      storage: {
        local: createStorageArea(),
        session: createStorageArea(),
        onChanged: {
          addListener: vi.fn((listener: StorageListener) => {
            storageListeners.add(listener);
          }),
          removeListener: vi.fn((listener: StorageListener) => {
            storageListeners.delete(listener);
          }),
        },
      },
    },
  };
}

function createController() {
  const snapshot = {
    phase: 'idle',
    conversationId: null,
    conversationContext: {},
    messages: [],
    turnStatus: 'idle',
    error: null,
    retryableSend: null,
    creatingConversation: false,
    reconnectAttempt: 0,
  };
  return {
    subscribe: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => snapshot),
    subscribeStreamingText: vi.fn(() => () => undefined),
    getStreamingText: vi.fn(() => ''),
    send: vi.fn(async () => undefined),
    startFresh: vi.fn(async () => undefined),
    openInRebel: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useSidePanelChatController', () => {
  let root: Root | null = null;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('disposes the previous scoped controller and creates an isolated persistence adapter when scope changes', async () => {
    const chromeMock = createChromeMock();
    vi.stubGlobal('chrome', chromeMock.chrome);

    const readAuthSnapshot = vi.fn(async (): Promise<PairingSnapshotStub> => ({
      clientId: 'client-1',
      token: 'token-1',
      fingerprint: 'fingerprint-1',
    }));
    const captureTabContext = vi.fn(async () => ({
      tabId: 11,
      windowId: 1,
      url: 'https://example.com/a',
      title: 'A',
    }));
    const controllers = [createController(), createController()];
    const createChatController = vi.fn((options: unknown) => ({
      ...controllers.shift(),
      options,
    }));

    vi.doMock('../../src/lib/browserAuth', () => ({
      LOCAL_AUTH_STORAGE_KEY,
      SESSION_AUTH_STORAGE_KEY,
      readAuthSnapshot,
    }));
    vi.doMock('../../src/lib/intents', () => ({
      captureTabContext,
      createExtensionIntentRuntime: vi.fn(() => ({
        client: {},
        diagnostics: undefined,
        transport: {
          setAuthHints: vi.fn(),
          primeBaseUrl: vi.fn(async () => true),
        },
      })),
    }));
    vi.doMock('@rebel/shared/chatController', () => ({
      createChatController,
    }));

    const { useSidePanelChatController } = await import('../../src/hooks/useSidePanelChatController');
    function Probe(): null {
      useSidePanelChatController();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<Probe />);
    });
    await flushEffects();
    await flushEffects();

    expect(createChatController).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of chromeMock.messageListeners) {
        listener({
          target: 'sidepanel',
          type: 'scope-changed',
          tabContext: {
            tabId: 22,
            windowId: 1,
            url: 'https://example.com/b',
            title: 'B',
          },
        });
      }
      await Promise.resolve();
    });
    await flushEffects();
    await flushEffects();

    expect(createChatController).toHaveBeenCalledTimes(2);
    expect((createChatController.mock.results[0]?.value as { dispose: ReturnType<typeof vi.fn> }).dispose)
      .toHaveBeenCalledTimes(1);

    const firstOptions = createChatController.mock.calls[0]?.[0] as {
      persistence: { set(state: { conversationId: string; pageUrl?: string }): Promise<void> };
    };
    const secondOptions = createChatController.mock.calls[1]?.[0] as {
      persistence: { set(state: { conversationId: string; pageUrl?: string }): Promise<void> };
    };
    await firstOptions.persistence.set({
      conversationId: 'conv-a',
      pageUrl: 'https://example.com/a',
    });
    await secondOptions.persistence.set({
      conversationId: 'conv-b',
      pageUrl: 'https://example.com/b',
    });

    const scopedKeys = Array.from(chromeMock.chrome.storage.local.store.keys()).filter((key) =>
      key.startsWith('rebel.chat.scope.v1.'),
    );
    expect(scopedKeys).toHaveLength(2);
    expect(scopedKeys.some((key) => key.includes('browser-tab%3A11'))).toBe(true);
    expect(scopedKeys.some((key) => key.includes('browser-tab%3A22'))).toBe(true);
  });

  it('does not let stale initial active-scope resolution overwrite a newer scope-change message', async () => {
    const chromeMock = createChromeMock();
    let resolveInitialScope: ((value: RuntimeSendMessageResponse) => void) | null = null;
    const initialScopePromise = new Promise<RuntimeSendMessageResponse>((resolve) => {
      resolveInitialScope = resolve;
    });
    chromeMock.chrome.runtime.sendMessage.mockImplementation(async (message: { type?: string } | undefined) => {
      if (message?.type === 'get-active-scope') {
        return await initialScopePromise;
      }
      return { status: { kind: 'connected' } };
    });
    vi.stubGlobal('chrome', chromeMock.chrome);

    const readAuthSnapshot = vi.fn(async (): Promise<PairingSnapshotStub> => ({
      clientId: 'client-1',
      token: 'token-1',
      fingerprint: 'fingerprint-1',
    }));
    const controllers = [createController(), createController()];
    const createChatController = vi.fn((options: unknown) => ({
      ...controllers.shift(),
      options,
    }));

    vi.doMock('../../src/lib/browserAuth', () => ({
      LOCAL_AUTH_STORAGE_KEY,
      SESSION_AUTH_STORAGE_KEY,
      readAuthSnapshot,
    }));
    vi.doMock('../../src/lib/intents', () => ({
      createExtensionIntentRuntime: vi.fn(() => ({
        client: {},
        diagnostics: undefined,
        transport: {
          setAuthHints: vi.fn(),
          primeBaseUrl: vi.fn(async () => true),
        },
      })),
    }));
    vi.doMock('@rebel/shared/chatController', () => ({
      createChatController,
    }));

    const { useSidePanelChatController } = await import('../../src/hooks/useSidePanelChatController');
    function Probe(): null {
      useSidePanelChatController();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<Probe />);
    });
    await flushEffects();

    await act(async () => {
      for (const listener of chromeMock.messageListeners) {
        listener({
          target: 'sidepanel',
          type: 'scope-changed',
          tabContext: {
            tabId: 22,
            windowId: 1,
            url: 'https://example.com/b',
            title: 'B',
          },
        });
      }
      await Promise.resolve();
    });
    await flushEffects();
    expect(createChatController).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitialScope?.({
        ok: true,
        tabContext: {
          tabId: 11,
          windowId: 1,
          url: 'https://example.com/a',
          title: 'A',
        },
      });
      await initialScopePromise;
    });
    await flushEffects();

    expect(createChatController).toHaveBeenCalledTimes(1);
    const options = createChatController.mock.calls[0]?.[0] as {
      persistence: { set(state: { conversationId: string; pageUrl?: string }): Promise<void> };
    };
    await options.persistence.set({
      conversationId: 'conv-b',
      pageUrl: 'https://example.com/b',
    });
    const scopedKeys = Array.from(chromeMock.chrome.storage.local.store.keys()).filter((key) =>
      key.startsWith('rebel.chat.scope.v1.'),
    );
    expect(scopedKeys).toHaveLength(1);
    expect(scopedKeys[0]).toContain('browser-tab%3A22');
  });

  it('ignores no-tab scope-change messages from other windows', async () => {
    const chromeMock = createChromeMock();
    vi.stubGlobal('chrome', chromeMock.chrome);

    const readAuthSnapshot = vi.fn(async (): Promise<PairingSnapshotStub> => ({
      clientId: 'client-1',
      token: 'token-1',
      fingerprint: 'fingerprint-1',
    }));
    const controllers = [createController(), createController()];
    const createChatController = vi.fn((options: unknown) => ({
      ...controllers.shift(),
      options,
    }));

    vi.doMock('../../src/lib/browserAuth', () => ({
      LOCAL_AUTH_STORAGE_KEY,
      SESSION_AUTH_STORAGE_KEY,
      readAuthSnapshot,
    }));
    vi.doMock('../../src/lib/intents', () => ({
      createExtensionIntentRuntime: vi.fn(() => ({
        client: {},
        diagnostics: undefined,
        transport: {
          setAuthHints: vi.fn(),
          primeBaseUrl: vi.fn(async () => true),
        },
      })),
    }));
    vi.doMock('@rebel/shared/chatController', () => ({
      createChatController,
    }));

    const { useSidePanelChatController } = await import('../../src/hooks/useSidePanelChatController');
    function Probe(): null {
      useSidePanelChatController();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<Probe />);
    });
    await flushEffects();
    await flushEffects();
    expect(createChatController).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of chromeMock.messageListeners) {
        listener({
          target: 'sidepanel',
          type: 'scope-changed',
          windowId: 2,
        });
      }
      await Promise.resolve();
    });
    await flushEffects();

    expect(createChatController).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh scoped persistence key when the same tab navigates to a new URL', async () => {
    const chromeMock = createChromeMock();
    vi.stubGlobal('chrome', chromeMock.chrome);

    const readAuthSnapshot = vi.fn(async (): Promise<PairingSnapshotStub> => ({
      clientId: 'client-1',
      token: 'token-1',
      fingerprint: 'fingerprint-1',
    }));
    const controllers = [createController(), createController()];
    const createChatController = vi.fn((options: unknown) => ({
      ...controllers.shift(),
      options,
    }));

    vi.doMock('../../src/lib/browserAuth', () => ({
      LOCAL_AUTH_STORAGE_KEY,
      SESSION_AUTH_STORAGE_KEY,
      readAuthSnapshot,
    }));
    vi.doMock('../../src/lib/intents', () => ({
      createExtensionIntentRuntime: vi.fn(() => ({
        client: {},
        diagnostics: undefined,
        transport: {
          setAuthHints: vi.fn(),
          primeBaseUrl: vi.fn(async () => true),
        },
      })),
    }));
    vi.doMock('@rebel/shared/chatController', () => ({
      createChatController,
    }));

    const { useSidePanelChatController } = await import('../../src/hooks/useSidePanelChatController');
    function Probe(): null {
      useSidePanelChatController();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<Probe />);
    });
    await flushEffects();
    await flushEffects();
    expect(createChatController).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const listener of chromeMock.messageListeners) {
        listener({
          target: 'sidepanel',
          type: 'scope-changed',
          tabContext: {
            tabId: 11,
            windowId: 1,
            url: 'https://example.com/c',
            title: 'C',
          },
        });
      }
      await Promise.resolve();
    });
    await flushEffects();
    await flushEffects();

    expect(createChatController).toHaveBeenCalledTimes(2);
    const firstOptions = createChatController.mock.calls[0]?.[0] as {
      persistence: { set(state: { conversationId: string; pageUrl?: string }): Promise<void> };
    };
    const secondOptions = createChatController.mock.calls[1]?.[0] as {
      persistence: { set(state: { conversationId: string; pageUrl?: string }): Promise<void> };
    };
    await firstOptions.persistence.set({ conversationId: 'conv-a', pageUrl: 'https://example.com/a' });
    await secondOptions.persistence.set({ conversationId: 'conv-c', pageUrl: 'https://example.com/c' });

    const scopedKeys = Array.from(chromeMock.chrome.storage.local.store.keys()).filter((key) =>
      key.startsWith('rebel.chat.scope.v1.'),
    );
    expect(scopedKeys).toHaveLength(2);
    expect(new Set(scopedKeys).size).toBe(2);
  });

  it('ignores wrong-window tab scope messages while initial scope is still resolving', async () => {
    const chromeMock = createChromeMock();
    let resolveInitialScope: ((value: RuntimeSendMessageResponse) => void) | null = null;
    const initialScopePromise = new Promise<RuntimeSendMessageResponse>((resolve) => {
      resolveInitialScope = resolve;
    });
    chromeMock.chrome.runtime.sendMessage.mockImplementation(async (message: { type?: string } | undefined) => {
      if (message?.type === 'get-active-scope') {
        return await initialScopePromise;
      }
      return { status: { kind: 'connected' } };
    });
    vi.stubGlobal('chrome', chromeMock.chrome);

    const readAuthSnapshot = vi.fn(async (): Promise<PairingSnapshotStub> => ({
      clientId: 'client-1',
      token: 'token-1',
      fingerprint: 'fingerprint-1',
    }));
    const controllers = [createController(), createController()];
    const createChatController = vi.fn((options: unknown) => ({
      ...controllers.shift(),
      options,
    }));

    vi.doMock('../../src/lib/browserAuth', () => ({
      LOCAL_AUTH_STORAGE_KEY,
      SESSION_AUTH_STORAGE_KEY,
      readAuthSnapshot,
    }));
    vi.doMock('../../src/lib/intents', () => ({
      createExtensionIntentRuntime: vi.fn(() => ({
        client: {},
        diagnostics: undefined,
        transport: {
          setAuthHints: vi.fn(),
          primeBaseUrl: vi.fn(async () => true),
        },
      })),
    }));
    vi.doMock('@rebel/shared/chatController', () => ({
      createChatController,
    }));

    const { useSidePanelChatController } = await import('../../src/hooks/useSidePanelChatController');
    function Probe(): null {
      useSidePanelChatController();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<Probe />);
    });
    await flushEffects();

    await act(async () => {
      for (const listener of chromeMock.messageListeners) {
        listener({
          target: 'sidepanel',
          type: 'scope-changed',
          tabContext: {
            tabId: 22,
            windowId: 2,
            url: 'https://example.com/b',
            title: 'B',
          },
        });
      }
      await Promise.resolve();
    });
    await flushEffects();
    expect(createChatController).not.toHaveBeenCalled();

    await act(async () => {
      resolveInitialScope?.({
        ok: true,
        tabContext: {
          tabId: 11,
          windowId: 1,
          url: 'https://example.com/a',
          title: 'A',
        },
      });
      await initialScopePromise;
    });
    await flushEffects();

    expect(createChatController).toHaveBeenCalledTimes(1);
    const options = createChatController.mock.calls[0]?.[0] as {
      persistence: { set(state: { conversationId: string; pageUrl?: string }): Promise<void> };
    };
    await options.persistence.set({
      conversationId: 'conv-a',
      pageUrl: 'https://example.com/a',
    });
    const scopedKeys = Array.from(chromeMock.chrome.storage.local.store.keys()).filter((key) =>
      key.startsWith('rebel.chat.scope.v1.'),
    );
    expect(scopedKeys).toHaveLength(1);
    expect(scopedKeys[0]).toContain('browser-tab%3A11');
  });
});
