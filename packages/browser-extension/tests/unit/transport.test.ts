import { describe, expect, it, vi } from 'vitest';
import {
  NativeMessagingTransport,
  WebSocketTransport,
  type NativeMessagingPort,
} from '../../src/transport/connectionTransport';

class FakeWebSocket {
  static OPEN = 1 as const;
  static CONNECTING = 0 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;

  readyState: number = FakeWebSocket.CONNECTING;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readonly CLOSING = FakeWebSocket.CLOSING;
  readonly CLOSED = FakeWebSocket.CLOSED;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(public url: string) {}

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
  triggerMessage(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
  triggerClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
  triggerError(err?: unknown): void {
    this.onerror?.((err as Event) ?? new Event('error'));
  }
  send(msg: string): void {
    this.sent.push(msg);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

describe('WebSocketTransport', () => {
  it('transitions connecting → open and fires onOpen', () => {
    const instances: FakeWebSocket[] = [];
    const ctor = function (this: FakeWebSocket, url: string) {
      const ws = new FakeWebSocket(url);
      instances.push(ws);
      return ws;
    } as unknown as typeof WebSocket;
    const t = new WebSocketTransport({
      url: 'ws://127.0.0.1:52320/ws',
      WebSocketImpl: ctor,
    });
    const opened = vi.fn();
    t.onOpen = opened;
    t.connect();
    expect(t.state).toBe('connecting');
    const ws0 = instances[0];
    if (!ws0) throw new Error('expected an instance');
    ws0.triggerOpen();
    expect(t.state).toBe('open');
    expect(opened).toHaveBeenCalledOnce();
  });

  it('relays messages and ignores binary frames', () => {
    const instances: FakeWebSocket[] = [];
    const ctor = function (this: FakeWebSocket, url: string) {
      const ws = new FakeWebSocket(url);
      instances.push(ws);
      return ws;
    } as unknown as typeof WebSocket;
    const t = new WebSocketTransport({
      url: 'ws://127.0.0.1:52320/ws',
      WebSocketImpl: ctor,
    });
    const seen: string[] = [];
    t.onMessage = (data) => seen.push(data);
    t.connect();
    const ws0 = instances[0];
    if (!ws0) throw new Error('expected an instance');
    ws0.triggerOpen();
    ws0.triggerMessage('hello');
    // Binary arrivals should be dropped without throwing
    ws0.onmessage?.(new MessageEvent('message', { data: new ArrayBuffer(8) }));
    expect(seen).toEqual(['hello']);
  });

  it('send() returns false when socket is not open', () => {
    const instances: FakeWebSocket[] = [];
    const ctor = function (this: FakeWebSocket, url: string) {
      const ws = new FakeWebSocket(url);
      instances.push(ws);
      return ws;
    } as unknown as typeof WebSocket;
    const t = new WebSocketTransport({
      url: 'ws://127.0.0.1:52320/ws',
      WebSocketImpl: ctor,
    });
    t.connect();
    expect(t.send('nope')).toBe(false);
    const ws0 = instances[0];
    if (!ws0) throw new Error('expected an instance');
    ws0.triggerOpen();
    expect(t.send('ok')).toBe(true);
    expect(ws0.sent).toEqual(['ok']);
    ws0.triggerClose(1000);
    expect(t.send('post-close')).toBe(false);
  });

  it('close() moves state through closing → closed', () => {
    const instances: FakeWebSocket[] = [];
    const ctor = function (this: FakeWebSocket, url: string) {
      const ws = new FakeWebSocket(url);
      instances.push(ws);
      return ws;
    } as unknown as typeof WebSocket;
    const t = new WebSocketTransport({
      url: 'ws://127.0.0.1:52320/ws',
      WebSocketImpl: ctor,
    });
    t.connect();
    const ws0 = instances[0];
    if (!ws0) throw new Error('expected an instance');
    ws0.triggerOpen();
    const closed = vi.fn();
    t.onClose = closed;
    t.close(4003, 'test');
    expect(t.state).toBe('closing');
    ws0.triggerClose(4003, 'test');
    expect(t.state).toBe('closed');
    expect(closed).toHaveBeenCalledWith({ code: 4003, reason: 'test' });
  });

  it('dispose() clears listeners and closes socket', () => {
    const instances: FakeWebSocket[] = [];
    const ctor = function (this: FakeWebSocket, url: string) {
      const ws = new FakeWebSocket(url);
      instances.push(ws);
      return ws;
    } as unknown as typeof WebSocket;
    const t = new WebSocketTransport({
      url: 'ws://127.0.0.1:52320/ws',
      WebSocketImpl: ctor,
    });
    t.connect();
    const ws0 = instances[0];
    if (!ws0) throw new Error('expected an instance');
    ws0.triggerOpen();
    t.dispose();
    expect(t.state).toBe('closed');
    expect(t.onOpen).toBeNull();
    expect(ws0.readyState).toBe(FakeWebSocket.CLOSED);
  });
});

describe('NativeMessagingTransport (stub)', () => {
  function makeFakePort(): {
    port: NativeMessagingPort;
    emit: (msg: unknown) => void;
    disconnect: () => void;
    sent: unknown[];
  } {
    const sent: unknown[] = [];
    let onMsg: ((msg: unknown) => void) | null = null;
    let onDisc: (() => void) | null = null;
    const port: NativeMessagingPort = {
      onMessage: {
        addListener(cb: (msg: unknown) => void): void {
          onMsg = cb;
        },
      },
      onDisconnect: {
        addListener(cb: () => void): void {
          onDisc = cb;
        },
      },
      postMessage(msg: unknown): void {
        sent.push(msg);
      },
      disconnect(): void {
        onDisc?.();
      },
    };
    return {
      port,
      emit: (msg) => onMsg?.(msg),
      disconnect: () => onDisc?.(),
      sent,
    };
  }

  it('connect() flips state to open and fires onOpen on microtask', async () => {
    const fake = makeFakePort();
    const t = new NativeMessagingTransport({
      hostName: 'com.rebel.native',
      connect: () => fake.port,
    });
    const opened = vi.fn();
    t.onOpen = opened;
    t.connect();
    expect(t.state).toBe('open');
    await Promise.resolve();
    expect(opened).toHaveBeenCalledOnce();
  });

  it('receives JSON-stringified messages from the native port', async () => {
    const fake = makeFakePort();
    const t = new NativeMessagingTransport({
      hostName: 'com.rebel.native',
      connect: () => fake.port,
    });
    const msgs: string[] = [];
    t.onMessage = (raw) => msgs.push(raw);
    t.connect();
    await Promise.resolve();
    fake.emit({ type: 'ping' });
    expect(msgs).toEqual([JSON.stringify({ type: 'ping' })]);
  });

  it('send() parses JSON string and forwards as object, returns false when closed', () => {
    const fake = makeFakePort();
    const t = new NativeMessagingTransport({
      hostName: 'com.rebel.native',
      connect: () => fake.port,
    });
    t.connect();
    expect(t.send(JSON.stringify({ hello: 'world' }))).toBe(true);
    expect(fake.sent).toEqual([{ hello: 'world' }]);
    t.close();
    expect(t.send('{"x":1}')).toBe(false);
  });
});
