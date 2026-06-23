import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from '../transport/connectionTransport';
import { attachOffscreenMessageHandlers, ConnectionRunner } from './offscreen';

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

describe('ConnectionRunner', () => {
  const localGet = vi.fn();
  const sessionGet = vi.fn();
  const runtimeSendMessage = vi.fn(async () => undefined);
  const addListener = vi.fn();
  const removeListener = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: localGet,
        },
        session: {
          get: sessionGet,
        },
      },
      runtime: {
        sendMessage: runtimeSendMessage,
        onMessage: {
          addListener,
          removeListener,
        },
      },
    });
    localGet.mockResolvedValue({
      'rebel.pairing.v1': {
        clientId: 'browser-0123456789abcdef',
      },
    });
    sessionGet.mockResolvedValue({
      'rebel.session.v1': {
        token: 'session-token',
        installSessionId: 'inst_123456',
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

    expect(runtimeSendMessage).toHaveBeenCalledWith({
      target: 'service-worker',
      type: 'auth-invalidated',
      reason: 'revoked-by-user',
    });
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
});
