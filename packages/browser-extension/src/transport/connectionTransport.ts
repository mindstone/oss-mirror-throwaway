/**
 * Transport abstraction for App Bridge connections (D16 / R11 Plan B).
 *
 * The extension's offscreen owner talks to the bridge over a `Transport`
 * rather than a raw WebSocket so we can:
 *
 *   - Swap to Native Messaging if MV3 ever kills loopback WebSocket sockets
 *     (Plan B per R11). The popup UX stays identical; only the wire changes.
 *   - Unit-test the handshake + reconnect state machine with a fake
 *     transport that records sends and simulates server frames.
 *
 * Design notes:
 *   - `Transport` is an event-style object — `onOpen`/`onClose`/`onMessage`/
 *     `onError` are setters, not subscriptions. The offscreen owner uses a
 *     single transport at a time, so subscription is overkill.
 *   - Messages are JSON strings. Binary frames aren't part of the protocol
 *     (Stage 6a read_page returns text) so we avoid `ArrayBuffer` plumbing.
 *   - `send()` returns a boolean rather than throwing on a dead socket; the
 *     caller decides whether to enqueue or drop based on its own retry
 *     budget. D16 spec — we don't want a raw `Error` fountaining up through
 *     the service worker's console.
 */

export type TransportState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'closing'
  | 'closed';

export interface Transport {
  /** Current socket state (pure read-only view of last lifecycle event). */
  readonly state: TransportState;
  /** Begin the connection. Safe to call from `'idle'` only. */
  connect(): void;
  /** Send a framed text message. Returns false if the socket isn't open. */
  send(message: string): boolean;
  /** Gracefully close the socket. Subsequent calls are no-ops. */
  close(code?: number, reason?: string): void;
  /** Release listeners and underlying socket. */
  dispose(): void;
  /** Event setters — last assignment wins. */
  onOpen: (() => void) | null;
  onClose: ((ev: { code: number; reason: string }) => void) | null;
  onMessage: ((data: string) => void) | null;
  onError: ((err: unknown) => void) | null;
}

// ---------------------------------------------------------------------------
// WebSocketTransport (Stage 6a default)
// ---------------------------------------------------------------------------

export interface WebSocketTransportOptions {
  url: string;
  /** Constructor override (tests). Defaults to the global `WebSocket`. */
  WebSocketImpl?: typeof WebSocket;
}

/**
 * WebSocket-backed transport. Thin wrapper that normalizes the
 * `WebSocket` API to the `Transport` contract.
 */
export class WebSocketTransport implements Transport {
  private readonly url: string;
  private readonly ctor: typeof WebSocket;
  private ws: WebSocket | null = null;
  private _state: TransportState = 'idle';

  onOpen: (() => void) | null = null;
  onClose: ((ev: { code: number; reason: string }) => void) | null = null;
  onMessage: ((data: string) => void) | null = null;
  onError: ((err: unknown) => void) | null = null;

  constructor(options: WebSocketTransportOptions) {
    this.url = options.url;
    this.ctor = options.WebSocketImpl ?? WebSocket;
  }

  get state(): TransportState {
    return this._state;
  }

  connect(): void {
    if (this._state !== 'idle' && this._state !== 'closed') {
      return;
    }
    this._state = 'connecting';
    try {
      const ws = new this.ctor(this.url);
      this.ws = ws;
      ws.onopen = (): void => {
        this._state = 'open';
        this.onOpen?.();
      };
      ws.onclose = (ev: CloseEvent): void => {
        this._state = 'closed';
        this.onClose?.({ code: ev.code, reason: ev.reason });
      };
      ws.onmessage = (ev: MessageEvent): void => {
        if (typeof ev.data === 'string') {
          this.onMessage?.(ev.data);
        }
      };
      ws.onerror = (ev: Event): void => {
        this.onError?.(ev);
      };
    } catch (err) {
      this._state = 'closed';
      this.onError?.(err);
    }
  }

  send(message: string): boolean {
    const ws = this.ws;
    if (!ws || this._state !== 'open' || ws.readyState !== ws.OPEN) {
      return false;
    }
    try {
      ws.send(message);
      return true;
    } catch (err) {
      this.onError?.(err);
      return false;
    }
  }

  close(code?: number, reason?: string): void {
    if (this._state === 'closed' || this._state === 'closing') return;
    this._state = 'closing';
    try {
      this.ws?.close(code, reason);
    } catch (err) {
      this.onError?.(err);
    }
  }

  dispose(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      if (
        this.ws.readyState === this.ws.OPEN ||
        this.ws.readyState === this.ws.CONNECTING
      ) {
        try {
          this.ws.close();
        } catch {
          // ignore — best-effort cleanup
        }
      }
    }
    this.ws = null;
    this._state = 'closed';
    this.onOpen = null;
    this.onClose = null;
    this.onMessage = null;
    this.onError = null;
  }
}

// ---------------------------------------------------------------------------
// NativeMessagingTransport (Stage 6a stub — R11 Plan B)
// ---------------------------------------------------------------------------

export interface NativeMessagingTransportOptions {
  /** Native-host identifier as registered with Chrome. */
  hostName: string;
  /** Connector override (tests). Defaults to `chrome.runtime.connectNative`. */
  connect?: (name: string) => NativeMessagingPort;
}

/**
 * Minimal subset of `chrome.runtime.Port` we depend on. Keeps the transport
 * testable without pulling in the full `@types/chrome` `Port` surface.
 */
export interface NativeMessagingPort {
  onMessage: { addListener(cb: (msg: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
  postMessage(msg: unknown): void;
  disconnect(): void;
}

/**
 * Stub transport over `chrome.runtime.connectNative`.
 *
 * Stage 6a wires the class but never instantiates it — the offscreen owner
 * always picks `WebSocketTransport`. We land the stub so Plan B is a one-line
 * swap, not a cross-cutting rewrite. Tests cover the send/receive plumbing
 * via a fake `NativeMessagingPort`.
 */
export class NativeMessagingTransport implements Transport {
  private readonly hostName: string;
  private readonly connectFn: (name: string) => NativeMessagingPort;
  private port: NativeMessagingPort | null = null;
  private _state: TransportState = 'idle';

  onOpen: (() => void) | null = null;
  onClose: ((ev: { code: number; reason: string }) => void) | null = null;
  onMessage: ((data: string) => void) | null = null;
  onError: ((err: unknown) => void) | null = null;

  constructor(options: NativeMessagingTransportOptions) {
    this.hostName = options.hostName;
    this.connectFn =
      options.connect ??
      ((name) => {
        const runtime = (
          globalThis as unknown as {
            chrome?: { runtime?: { connectNative?: typeof connectNative } };
          }
        ).chrome?.runtime;
        if (!runtime?.connectNative) {
          throw new Error(
            'chrome.runtime.connectNative is not available in this context',
          );
        }
        return runtime.connectNative(name) as unknown as NativeMessagingPort;
      });
  }

  get state(): TransportState {
    return this._state;
  }

  connect(): void {
    if (this._state !== 'idle' && this._state !== 'closed') return;
    this._state = 'connecting';
    try {
      const port = this.connectFn(this.hostName);
      this.port = port;
      port.onMessage.addListener((msg: unknown): void => {
        if (typeof msg === 'string') {
          this.onMessage?.(msg);
          return;
        }
        try {
          this.onMessage?.(JSON.stringify(msg));
        } catch (err) {
          this.onError?.(err);
        }
      });
      port.onDisconnect.addListener((): void => {
        this._state = 'closed';
        this.onClose?.({ code: 1000, reason: 'native_disconnect' });
      });
      this._state = 'open';
      // Native Messaging has no explicit open event — once connectNative
      // returns, the channel is usable. Surface that to the owner.
      queueMicrotask(() => this.onOpen?.());
    } catch (err) {
      this._state = 'closed';
      this.onError?.(err);
    }
  }

  send(message: string): boolean {
    if (!this.port || this._state !== 'open') return false;
    try {
      this.port.postMessage(JSON.parse(message));
      return true;
    } catch (err) {
      this.onError?.(err);
      return false;
    }
  }

  close(_code?: number, _reason?: string): void {
    if (this._state === 'closed' || this._state === 'closing') return;
    this._state = 'closing';
    try {
      this.port?.disconnect();
    } catch (err) {
      this.onError?.(err);
    }
    this._state = 'closed';
    this.onClose?.({ code: 1000, reason: 'client_close' });
  }

  dispose(): void {
    this.close();
    this.port = null;
    this.onOpen = null;
    this.onClose = null;
    this.onMessage = null;
    this.onError = null;
  }
}

// Re-export for downstream type consumers.
declare function connectNative(name: string): NativeMessagingPort;
