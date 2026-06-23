import {
  type AuthSnapshot,
  type InstallStatus,
} from '../lib/browserAuth';
import { createPortDiscovery, type PortDiscovery } from '../lib/port-discovery';
import { getCapabilities } from '../lib/capabilities';
import { createLogger } from '../lib/logger';
import { sharedManifest } from '../manifest.shared';
import { WebSocketTransport, type Transport } from '../transport/connectionTransport';

interface ContentSuccessResponse {
  ok: true;
  data: unknown;
}

interface ContentErrorResponse {
  ok: false;
  code?: string;
  reason?: string;
  error?: string;
  details?: Record<string, unknown>;
}

type ContentResponse = ContentSuccessResponse | ContentErrorResponse;

const log = createLogger({ prefix: '[offscreen]' });
const HEARTBEAT_MS = 25_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

interface StoredAuth {
  clientId: string;
  token: string;
}

let status: InstallStatus = { kind: 'idle' };

function isOpaqueBrowserEvent(value: unknown): value is Event {
  return typeof Event !== 'undefined' && value instanceof Event;
}

function describeTransportError(err: unknown): unknown {
  if (isOpaqueBrowserEvent(err)) {
    return {
      eventType: err.type || 'error',
      targetType:
        err.target && typeof err.target === 'object'
          ? err.target.constructor?.name ?? 'EventTarget'
          : null,
    };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return err;
}

function setStatus(next: InstallStatus): void {
  status = next;
  chrome.runtime
    .sendMessage({ target: 'service-worker', type: 'offscreen-status', status })
    .catch(() => {
      // service worker may be asleep for a moment; ignore
    });
}

// Offscreen documents in Chromium have access to `chrome.runtime` but
// NOT `chrome.storage` — the SW is the only context that can read auth
// state. We keep a module-level cache that the SW primes proactively
// (via `auth-snapshot` messages after mint/revoke) and fall back to a
// on-demand request when the cache is empty (fresh offscreen spin-up).
let cachedAuth: StoredAuth | null = null;

function setCachedAuthFromSnapshot(snapshot: unknown): void {
  if (!snapshot || typeof snapshot !== 'object') {
    cachedAuth = null;
    return;
  }
  const snap = snapshot as Partial<AuthSnapshot>;
  if (typeof snap.clientId !== 'string' || typeof snap.token !== 'string') {
    cachedAuth = null;
    return;
  }
  cachedAuth = { clientId: snap.clientId, token: snap.token };
}

async function requestAuthSnapshotFromSW(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({
      target: 'service-worker',
      type: 'get-auth-snapshot',
    })) as { ok?: boolean; snapshot?: AuthSnapshot } | undefined;
    if (response && response.ok !== false) {
      setCachedAuthFromSnapshot(response.snapshot);
    }
  } catch (err) {
    log.debug('get-auth-snapshot request failed', err);
    // SW may be asleep briefly; connectLoop will exit and the SW will
    // re-prime us via `auth-snapshot` once it wakes.
  }
}

async function readStoredAuth(): Promise<StoredAuth | null> {
  if (cachedAuth) return cachedAuth;
  await requestAuthSnapshotFromSW();
  return cachedAuth;
}

function jitter(baseMs: number): number {
  return Math.round(baseMs / 2 + Math.random() * (baseMs / 2));
}

function shouldInvalidateDiscovery(reason: string): boolean {
  return (
    reason === 'port_discovery_failed' ||
    reason === 'connect_failed' ||
    reason.startsWith('ws_closed_1006')
  );
}

async function isLikelyUnauthorizedUpgrade(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/intent/health`, {
      method: 'GET',
      cache: 'no-store',
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as {
      protocolVersion?: string;
      port?: number;
    };
    return (
      typeof body.protocolVersion !== 'string' ||
      typeof body.port !== 'number'
    );
  } catch {
    return false;
  }
}

interface ConnectionRunnerOptions {
  discovery: PortDiscovery;
  transportFactory?: (url: string) => Transport;
  readAuth?: () => Promise<StoredAuth | null>;
}

export class ConnectionRunner {
  private transport: Transport | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private attempts = 0;
  private openedCurrentAttempt = false;
  private unauthorizedUpgradeCount = 0;
  private resetSuppressedReconnect = false;
  private readonly discovery: PortDiscovery;
  private readonly transportFactory: (url: string) => Transport;
  private readonly readAuth: () => Promise<StoredAuth | null>;

  constructor(options: ConnectionRunnerOptions) {
    this.discovery = options.discovery;
    this.transportFactory =
      options.transportFactory ??
      ((url) => new WebSocketTransport({ url }));
    this.readAuth = options.readAuth ?? readStoredAuth;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.resetSuppressedReconnect = false;
    await this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    this.openedCurrentAttempt = false;
    this.unauthorizedUpgradeCount = 0;
    this.resetSuppressedReconnect = false;
    this.clearTimers();
    this.transport?.close(1000, 'client_stop');
    this.transport?.dispose();
    this.transport = null;
  }

  /**
   * True only when a live, registered WebSocket is in place.
   *
   * Used by the service-worker alarm's `verify-alive` liveness probe to
   * detect a silently dead socket (Chrome evicts MV3 offscreen docs on
   * unpredictable idle thresholds; the close event can be dropped) and
   * kick off a fresh connect without waiting for the user's next action.
   */
  isConnected(): boolean {
    return (
      this.transport !== null &&
      this.transport.state === 'open' &&
      status.kind === 'connected'
    );
  }

  /**
   * Currently-visible offscreen status. Lets the SW distinguish a benign
   * in-flight `reconnecting`/`connecting` state from a truly-dead WS.
   */
  getCurrentStatus(): InstallStatus {
    return status;
  }

  /**
   * Push a bridge `event` frame on the current transport. Returns whether
   * the frame was sent — drops silently if no live connection exists, since
   * the SW will re-emit on reconnect via the recency window in
   * PermissionGrantTracker.
   *
   * Used by the SW `permission-granted` flow so the bridge can unblock an
   * in-flight INJECTION_REFUSED retry. See
   * `src/core/appBridge/server/permissionGrantTracker.ts`.
   */
  sendEvent(payload: { event: string; origin?: string; at?: number }): boolean {
    if (!this.transport || this.transport.state !== 'open') return false;
    this.transport.send(
      JSON.stringify({
        type: 'event',
        event: payload.event,
        ...(payload.origin !== undefined ? { origin: payload.origin } : {}),
        ...(payload.at !== undefined ? { at: payload.at } : {}),
      }),
    );
    return true;
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  private async connectLoop(): Promise<void> {
    if (this.stopped) return;
    const auth = await this.readAuth();
    if (!auth) {
      return;
    }
    let discovered: Awaited<ReturnType<PortDiscovery['getPort']>>;
    try {
      discovered = await this.discovery.getPort();
    } catch (err) {
      log.warn('port discovery failed', err);
      this.discovery.invalidate();
      this.scheduleReconnect('port_discovery_failed');
      return;
    }
    if (!discovered) {
      this.scheduleReconnect('bridge_not_found');
      return;
    }
    setStatus({ kind: 'connecting', port: discovered.port });
    const wsUrl = `${discovered.origin.replace(/^http/, 'ws')}/ws`;
    const transport = this.transportFactory(wsUrl);
    this.transport = transport;
    this.openedCurrentAttempt = false;

    transport.onOpen = (): void => {
      this.attempts = 0;
      this.openedCurrentAttempt = true;
      this.unauthorizedUpgradeCount = 0;
      setStatus({ kind: 'registering', port: discovered.port });
      this.sendAuthRegister(transport, auth);
    };
    transport.onMessage = (raw): void => {
      this.handleMessage(raw, discovered.port);
    };
    transport.onClose = ({ code, reason }): void => {
      log.info('ws closed', { closeCode: code, reason });
      this.clearHeartbeat();
      if (code === 4001) {
        void this.handleRevokedByUser();
        return;
      }
      if (code === 4010) {
        this.discovery.invalidate();
        return;
      }
      if (!this.openedCurrentAttempt && code === 1006) {
        void this.handleRejectedUpgrade(discovered.origin);
        return;
      }
      this.scheduleReconnect(`ws_closed_${code}`);
    };
    transport.onError = (err): void => {
      const details = describeTransportError(err);
      if (isOpaqueBrowserEvent(err)) {
        log.debug('ws error event', details);
        return;
      }
      log.warn('ws error', details);
    };

    transport.connect();
  }

  private sendAuthRegister(transport: Transport, auth: StoredAuth): void {
    transport.send(
      JSON.stringify({
        type: 'auth',
        token: auth.token,
        appId: 'browser-extension',
        clientId: auth.clientId,
      }),
    );
    transport.send(
      JSON.stringify({
        type: 'register',
        appId: 'browser-extension',
        protocolVersion: '1.0',
        appVersion: sharedManifest.version,
        clientId: auth.clientId,
        capabilities: getCapabilities(),
      }),
    );
  }

  private handleMessage(raw: string, port: number): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      log.warn('dropping malformed ws frame');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; sessionId?: string };
    switch (m.type) {
      case 'registered':
        setStatus({
          kind: 'connected',
          port,
          sessionId: typeof m.sessionId === 'string' ? m.sessionId : 'unknown',
        });
        this.startHeartbeat();
        break;
      case 'ping':
        this.transport?.send(JSON.stringify({ type: 'pong' }));
        break;
      case 'pong':
        break;
      case 'error':
        log.warn('server error frame', m);
        break;
      case 'session-ended':
        void this.handleRevokedByUser();
        break;
      case 'command':
        void this.handleCommand(m);
        break;
      default:
        log.debug('unhandled frame', m);
    }
  }

  private async handleCommand(raw: Record<string, unknown>): Promise<void> {
    const id = typeof raw.id === 'string' ? raw.id : null;
    const action = typeof raw.action === 'string' ? raw.action : null;
    if (!id || !action) return;
    const params =
      raw.params && typeof raw.params === 'object'
        ? (raw.params as Record<string, unknown>)
        : {};
    const tabContext =
      raw.tabContext && typeof raw.tabContext === 'object'
        ? (raw.tabContext as Record<string, unknown>)
        : undefined;

    const resp = await chrome.runtime
      .sendMessage({
        target: 'service-worker',
        type: 'dispatch-capability',
        action,
        params,
        ...(tabContext ? { tabContext } : {}),
      })
      .catch((err: unknown) => {
        log.warn('dispatch failed', err);
        return {
          ok: false,
          code: 'INTERNAL_ERROR',
          error: err instanceof Error ? err.message : String(err),
        } satisfies ContentResponse;
      });

    this.sendCommandResult(id, resp as ContentResponse);
  }

  private sendCommandResult(id: string, resp: ContentResponse): void {
    if (resp.ok) {
      this.transport?.send(
        JSON.stringify({
          type: 'response',
          id,
          success: true,
          data: resp.data,
        }),
      );
    } else {
      this.transport?.send(
        JSON.stringify({
          type: 'response',
          id,
          success: false,
          error: resp.error ?? resp.reason ?? 'capability_error',
          code: resp.code ?? 'INTERNAL_ERROR',
          ...(resp.details ? { details: resp.details } : {}),
        }),
      );
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.transport?.send(JSON.stringify({ type: 'ping' }));
    }, HEARTBEAT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async handleRejectedUpgrade(origin: string): Promise<void> {
    const unauthorized = await isLikelyUnauthorizedUpgrade(origin);
    if (!unauthorized) {
      this.unauthorizedUpgradeCount = 0;
      this.scheduleReconnect('ws_closed_1006');
      return;
    }

    this.unauthorizedUpgradeCount += 1;
    if (this.unauthorizedUpgradeCount >= 2) {
      await this.handleRevokedByUser();
      return;
    }
    this.scheduleReconnect('ws_closed_1006');
  }

  private async handleRevokedByUser(): Promise<void> {
    this.resetSuppressedReconnect = true;
    this.unauthorizedUpgradeCount = 0;
    this.clearTimers();
    this.transport?.dispose();
    this.transport = null;
    await chrome.runtime
      .sendMessage({
        target: 'service-worker',
        type: 'auth-invalidated',
        reason: 'revoked-by-user',
      })
      .catch(() => undefined);
  }

  private scheduleReconnect(reason: string): void {
    this.clearTimers();
    this.transport?.dispose();
    this.transport = null;
    if (this.stopped || this.resetSuppressedReconnect) return;
    if (shouldInvalidateDiscovery(reason)) {
      this.discovery.invalidate();
    }
    this.attempts += 1;
    const base = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_MIN_MS * 2 ** Math.min(this.attempts - 1, 5),
    );
    const delay = jitter(base);
    setStatus({ kind: 'reconnecting', attempt: this.attempts });
    log.info('reconnect scheduled', { reason, attempt: this.attempts, delay });
    this.reconnectTimer = setTimeout(() => {
      void this.connectLoop();
    }, delay);
  }
}

export function attachOffscreenMessageHandlers(
  runner: Pick<ConnectionRunner, 'start' | 'stop' | 'isConnected' | 'sendEvent'>,
): () => void {
  const listener = (msg: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
    if (!msg || typeof msg !== 'object') return false;
    const envelope = msg as {
      target?: string;
      type?: string;
      snapshot?: unknown;
      event?: string;
      origin?: string;
      at?: number;
    };
    if (envelope.target !== 'offscreen') return false;
    if (envelope.type === 'bridge-event' && typeof envelope.event === 'string') {
      // Forwarded from the SW (e.g. `permission-granted`). The runner owns
      // the WS; we just hand it the frame to push when a transport exists.
      const sent = runner.sendEvent({
        event: envelope.event,
        ...(envelope.origin !== undefined ? { origin: envelope.origin } : {}),
        ...(envelope.at !== undefined ? { at: envelope.at } : {}),
      });
      sendResponse({ ok: true, sent });
      return true;
    }
    if (envelope.type === 'auth-snapshot') {
      // SW pushes fresh auth state here after mint success or revoke.
      // Updating the cache is all we need — the runner will consume it
      // on its next connectLoop iteration.
      setCachedAuthFromSnapshot(envelope.snapshot);
      sendResponse({ ok: true });
      return true;
    }
    if (envelope.type === 'reconnect-now' || envelope.type === 'mint-updated') {
      // Force a fresh pull on the next connectLoop — the SW will also
      // have sent an `auth-snapshot` just before this, but clearing
      // guarantees correctness if messages arrive out of order.
      cachedAuth = null;
      runner.stop();
      void runner.start();
      sendResponse({ ok: true });
      return true;
    }
    if (envelope.type === 'verify-alive') {
      // Liveness probe fired by the service-worker keepalive alarm. When
      // the WS has silently dropped (MV3 offscreen eviction, stale TCP
      // connection the `onClose` event never reported, etc.) the runner
      // will still look "stopped" to its own state machine. Kicking
      // start() here is idempotent — if we're already connected this is
      // a no-op via `isConnected()`; if not, it kicks off connect-loop.
      const alive = runner.isConnected();
      if (!alive) {
        runner.stop();
        void runner.start();
      }
      sendResponse({ ok: true, alive });
      return true;
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(listener);
  return () => {
    chrome.runtime.onMessage.removeListener(listener);
  };
}

const isVitest =
  Boolean((import.meta as ImportMeta & { vitest?: unknown }).vitest) ||
  '__vitest_worker__' in globalThis;

if (!isVitest) {
  const discovery = createPortDiscovery();
  const runner = new ConnectionRunner({ discovery });

  // Attach the message listener FIRST so any `auth-snapshot` the SW
  // pushes between module load and our first `readStoredAuth` is not
  // dropped on the floor.
  attachOffscreenMessageHandlers(runner);
  void requestAuthSnapshotFromSW().finally(() => {
    void runner.start();
  });
}
