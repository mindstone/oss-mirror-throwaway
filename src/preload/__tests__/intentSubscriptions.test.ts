import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preloadHarness = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  listeners: new Map<string, Array<(event: unknown, data: unknown) => void>>(),
  invoke: vi.fn(),
  sendSync: vi.fn(),
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((name: string, value: unknown) => {
      preloadHarness.exposed.set(name, value);
      (globalThis as Record<string, unknown>)[name] = value;
    }),
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => preloadHarness.invoke(...args),
    sendSync: (...args: unknown[]) => preloadHarness.sendSync(...args),
    send: (...args: unknown[]) => preloadHarness.send(...args),
    on: vi.fn((channel: string, listener: (event: unknown, data: unknown) => void) => {
      const current = preloadHarness.listeners.get(channel) ?? [];
      current.push(listener);
      preloadHarness.listeners.set(channel, current);
    }),
    removeListener: vi.fn((channel: string, listener: (event: unknown, data: unknown) => void) => {
      const current = preloadHarness.listeners.get(channel) ?? [];
      preloadHarness.listeners.set(
        channel,
        current.filter((entry) => entry !== listener),
      );
    }),
  },
  webUtils: {
    getPathForFile: (file: string) => file,
  },
}));

interface PreloadIntentApi {
  onIntentExternalContextArrived(
    callback: (payload: Record<string, unknown>) => void,
  ): () => void;
  onIntentBufferedMessage(
    callback: (payload: Record<string, unknown>) => void,
  ): () => void;
}

function installFakeWindow(): void {
  const fakeWindow = new EventTarget() as EventTarget & Record<string, unknown>;
  fakeWindow.addEventListener = fakeWindow.addEventListener.bind(fakeWindow);
  fakeWindow.removeEventListener = fakeWindow.removeEventListener.bind(fakeWindow);
  fakeWindow.dispatchEvent = fakeWindow.dispatchEvent.bind(fakeWindow);
  (globalThis as unknown as { window?: typeof fakeWindow }).window = fakeWindow;
}

async function loadIntentApi(): Promise<PreloadIntentApi> {
  preloadHarness.exposed.clear();
  preloadHarness.listeners.clear();
  installFakeWindow();
  vi.resetModules();
  await import('../index');
  return preloadHarness.exposed.get('api') as PreloadIntentApi;
}

function emit(channel: string, payload: unknown): void {
  for (const listener of preloadHarness.listeners.get(channel) ?? []) {
    listener({}, payload);
  }
}

describe('preload intent subscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('accepts Office documentContext payloads without requiring tabContext', async () => {
    const api = await loadIntentApi();
    const received: Array<Record<string, unknown>> = [];

    const unsubscribe = api.onIntentExternalContextArrived((payload) => {
      received.push(payload);
    });

    emit('intent:external-context-arrived', {
      sessionId: 'session-1',
      appId: 'office-addin',
      intent: 'chat',
      initialText: 'Summarise this draft',
      externalContext: {
        schemaVersion: '1.0',
        kind: 'office',
        appId: 'office-addin',
        documentContext: {
          host: 'word',
          title: 'Quarterly Plan.docx',
        },
      },
      documentContext: {
        host: 'word',
        title: 'Quarterly Plan.docx',
      },
      focus: true,
      receivedAt: 123,
    });

    expect(received).toEqual([
      {
        sessionId: 'session-1',
        appId: 'office-addin',
        intent: 'chat',
        initialText: 'Summarise this draft',
        externalContext: {
          schemaVersion: '1.0',
          kind: 'office',
          appId: 'office-addin',
          documentContext: {
            host: 'word',
            title: 'Quarterly Plan.docx',
          },
        },
        documentContext: {
          host: 'word',
          title: 'Quarterly Plan.docx',
        },
        focus: true,
        receivedAt: 123,
      },
    ]);
    expect(received[0]).not.toHaveProperty('tabContext');

    unsubscribe();
  });

  it('rejects buffered Office payloads when nested documentContext validation fails', async () => {
    const api = await loadIntentApi();
    const received: Array<Record<string, unknown>> = [];

    const unsubscribe = api.onIntentBufferedMessage((payload) => {
      received.push(payload);
    });

    emit('intent:buffered-message', {
      sessionId: 'session-1',
      appId: 'office-addin',
      messageId: 'message-1',
      text: 'Summarise this draft',
      queueSize: 1,
      documentContext: {
        host: 'word',
        title: { nested: true },
      },
      receivedAt: 124,
    });

    expect(received).toHaveLength(0);

    unsubscribe();
  });
});
