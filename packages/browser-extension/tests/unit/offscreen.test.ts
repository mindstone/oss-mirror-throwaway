import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from '../../src/transport/connectionTransport';
import { attachOffscreenMessageHandlers, ConnectionRunner } from '../../src/offscreen/offscreen';

class FakeTransport implements Transport {
  state: 'idle' | 'connecting' | 'open' | 'closing' | 'closed' = 'idle';
  onOpen: (() => void) | null = null;
  onClose: ((ev: { code: number; reason: string }) => void) | null = null;
  onMessage: ((data: string) => void) | null = null;
  onError: ((err: unknown) => void) | null = null;
  connect = vi.fn(() => {
    this.state = 'connecting';
  });
  send = vi.fn(() => true);
  close = vi.fn(() => {
    this.state = 'closed';
  });
  dispose = vi.fn(() => {
    this.state = 'closed';
  });
}

describe('offscreen ConnectionRunner', () => {
  // Offscreen docs cannot access chrome.storage; they fetch auth from
  // the SW via a `get-auth-snapshot` round-trip. The test double below
  // answers that request and ignores everything else (the SW handles
  // other message types in production).
  const runtimeSendMessage = vi.fn(async (msg: { type?: string }) => {
    if (msg?.type === 'get-auth-snapshot') {
      return {
        ok: true,
        snapshot: {
          clientId: 'browser-0123456789abcdef',
          token: 'session-token',
          installSessionId: 'inst_123456',
        },
      };
    }
    return undefined;
  });
  const addListener = vi.fn();
  const removeListener = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: runtimeSendMessage,
        onMessage: {
          addListener,
          removeListener,
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reads the session token from session storage and sends it during auth', async () => {
    const transport = new FakeTransport();
    const runner = new ConnectionRunner({
      discovery: {
        getPort: vi.fn(async () => ({
          port: 52320,
          origin: 'http://127.0.0.1:52320',
          cachedAt: 0,
        })),
        invalidate: vi.fn(),
        refresh: vi.fn(async () => null),
        peekCache: vi.fn(() => null),
      },
      transportFactory: () => transport,
    });

    await runner.start();
    transport.onOpen?.();

    expect(transport.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'auth',
        token: 'session-token',
        appId: 'browser-extension',
        clientId: 'browser-0123456789abcdef',
      }),
    );
  });

  it('treats a 4001 close as revoked-by-user and lets the service worker clear auth', async () => {
    const transport = new FakeTransport();
    const runner = new ConnectionRunner({
      discovery: {
        getPort: vi.fn(async () => ({
          port: 52320,
          origin: 'http://127.0.0.1:52320',
          cachedAt: 0,
        })),
        invalidate: vi.fn(),
        refresh: vi.fn(async () => null),
        peekCache: vi.fn(() => null),
      },
      transportFactory: () => transport,
    });

    await runner.start();
    transport.onOpen?.();
    transport.onClose?.({ code: 4001, reason: 'revoked' });
    await Promise.resolve();

    // `get-auth-snapshot` is sent first (offscreen pulls auth from SW),
    // then `auth-invalidated` when the server closes with 4001.
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      target: 'service-worker',
      type: 'auth-invalidated',
      reason: 'revoked-by-user',
    });
  });

  it('keeps opaque WebSocket error events out of warning logs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const transport = new FakeTransport();
    const runner = new ConnectionRunner({
      discovery: {
        getPort: vi.fn(async () => ({
          port: 52320,
          origin: 'http://127.0.0.1:52320',
          cachedAt: 0,
        })),
        invalidate: vi.fn(),
        refresh: vi.fn(async () => null),
        peekCache: vi.fn(() => null),
      },
      transportFactory: () => transport,
    });

    try {
      await runner.start();
      transport.onError?.(new Event('error'));

      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        '[rebel][offscreen] DEBUG',
        'ws error event',
        { eventType: 'error', targetType: null },
      );
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it('restarts the connection when the service worker sends mint-updated', async () => {
    const runner = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      isConnected: vi.fn(() => false),
      sendEvent: vi.fn(() => true),
    };

    const detach = attachOffscreenMessageHandlers(runner);
    const listener = addListener.mock.calls[0]?.[0] as
      | ((msg: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean)
      | undefined;

    expect(listener).toBeDefined();

    const sendResponse = vi.fn();
    listener?.({ target: 'offscreen', type: 'mint-updated' }, {}, sendResponse);
    await Promise.resolve();

    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });

    detach();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('re-starts a dead runner when the SW alarm sends verify-alive', async () => {
    const runner = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      isConnected: vi.fn(() => false),
      sendEvent: vi.fn(() => true),
    };

    attachOffscreenMessageHandlers(runner);
    const listener = addListener.mock.calls[0]?.[0] as
      | ((msg: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean)
      | undefined;

    const sendResponse = vi.fn();
    const handled = listener?.({ target: 'offscreen', type: 'verify-alive' }, {}, sendResponse);
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(runner.isConnected).toHaveBeenCalledTimes(1);
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, alive: false });
  });

  it('leaves a healthy runner alone on verify-alive', async () => {
    const runner = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      isConnected: vi.fn(() => true),
      sendEvent: vi.fn(() => true),
    };

    attachOffscreenMessageHandlers(runner);
    const listener = addListener.mock.calls[0]?.[0] as
      | ((msg: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean)
      | undefined;

    const sendResponse = vi.fn();
    listener?.({ target: 'offscreen', type: 'verify-alive' }, {}, sendResponse);
    await Promise.resolve();

    expect(runner.isConnected).toHaveBeenCalledTimes(1);
    expect(runner.stop).not.toHaveBeenCalled();
    expect(runner.start).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, alive: true });
  });

  it('forwards SW bridge-event messages to runner.sendEvent', () => {
    const runner = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      isConnected: vi.fn(() => true),
      sendEvent: vi.fn(() => true),
    };

    attachOffscreenMessageHandlers(runner);
    const listener = addListener.mock.calls[0]?.[0] as
      | ((msg: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean)
      | undefined;
    expect(listener).toBeDefined();

    const sendResponse = vi.fn();
    const handled = listener?.(
      {
        target: 'offscreen',
        type: 'bridge-event',
        event: 'permission-granted',
        origin: 'https://example.com',
        at: 1234,
      },
      {},
      sendResponse,
    );

    expect(handled).toBe(true);
    expect(runner.sendEvent).toHaveBeenCalledWith({
      event: 'permission-granted',
      origin: 'https://example.com',
      at: 1234,
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, sent: true });
  });

  it('reports sent:false when the runner has no live transport', () => {
    const runner = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      isConnected: vi.fn(() => false),
      sendEvent: vi.fn(() => false),
    };

    attachOffscreenMessageHandlers(runner);
    const listener = addListener.mock.calls[0]?.[0] as
      | ((msg: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean)
      | undefined;

    const sendResponse = vi.fn();
    listener?.(
      {
        target: 'offscreen',
        type: 'bridge-event',
        event: 'permission-granted',
        origin: 'https://example.com',
        at: 1,
      },
      {},
      sendResponse,
    );

    expect(sendResponse).toHaveBeenCalledWith({ ok: true, sent: false });
  });
});
