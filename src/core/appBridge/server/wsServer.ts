/**
 * wsServer — WebSocket upgrade + auth/register state machine (Stage 3).
 *
 * Wires the bridge's HTTP server `upgrade` event to a `ws` `WebSocketServer`
 * in `noServer` mode and drives each socket through the spec's three-state
 * lifecycle:
 *
 *   awaiting-auth → awaiting-register → registered
 *
 * Stage 3 invariants:
 *
 *   - **Upgrade path gate**: only `WS_PATH` ('/ws') is upgraded; anything
 *     else replies with raw HTTP 404 and destroys the socket.
 *   - **Origin + Host guard**: Stage 2's `assertAllowedOrigin` /
 *     `assertAllowedHost` run pre-upgrade. Failures write a raw 401 + destroy.
 *   - **Auth message (`awaiting-auth`)**:
 *       - Must be `{ type: 'auth', token, appId, clientId }`
 *       - `tokenStore.verifyAppToken(token, { appId, clientId })` must succeed
 *         (R6). Failure closes 4001.
 *       - Any non-auth message pre-auth closes 4001.
 *   - **Register message (`awaiting-register`)**:
 *       - Must be `{ type: 'register', protocolVersion, appId, clientId, capabilities }`
 *       - `protocolVersion` must equal `PROTOCOL_VERSION` ('1.0') — mismatch
 *         or missing closes 4010.
 *       - `appId` / `clientId` must equal the token claims captured at
 *         auth (R6). Mismatch closes 4001.
 *       - Any other message type post-auth/pre-register sends a BAD_REQUEST
 *         `error` frame (no close).
 *   - **Registered**: subsequent `response`, `ping`, `pong` messages route
 *     through `commandRouter.handleResponse` / pong accounting; unknown
 *     messages send BAD_REQUEST error frames.
 *   - **Heartbeat**: `connectionManager.startHeartbeat()` drives 15 s JSON
 *     pings; 2 missed pongs → terminate (1006 abnormal).
 *   - **Close**: `connectionManager.unregister(appId)` +
 *     `capabilityRegistry.unregister(appId)` +
 *     `commandRouter.rejectPending(appId, ADDIN_DISCONNECTED)`.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import WebSocket, { type RawData, WebSocketServer } from 'ws';
import type { ErrorReporter } from '@core/errorReporter';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { installEvent } from '../shared/installEvent';
import {
  ErrorCode,
  toWsCloseCode,
  toWsCloseReason,
} from '../shared/errors';
import {
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_PROTOCOL_VERSION_MISMATCH,
  WS_CLOSE_UNAUTHORIZED,
  WS_PATH,
  type AppType,
  type AuthMessage,
  type CapabilityDescriptor,
  type ErrorMessage,
  type RegisterMessage,
  type RegisteredAck,
  type ResponseMessage,
} from '../shared/protocol';
import type { CapabilityRegistry } from './capabilityRegistry';
import type { CommandRouter } from './commandRouter';
import type { ConnectionManager } from './connectionManager';
import {
  assertAllowedHost,
  assertAllowedOriginAsync,
  type OriginGuardOptions,
} from './originGuard';
import type { TokenStore } from './tokenStore';

export interface WsServerOptions<TApp extends string = AppType> {
  httpServer: HttpServer;
  /** Origin + Host check config. */
  originGuardOptions: OriginGuardOptions;
  connectionManager: ConnectionManager<TApp>;
  capabilityRegistry: CapabilityRegistry<TApp>;
  commandRouter: CommandRouter<TApp>;
  tokenStore: TokenStore;
  /** Protocol version the bridge advertises. Fixed to '1.0' in Stage 3. */
  protocolVersion: string;
  /** Returns the bridge's currently-bound port; used by the Host guard. */
  getPort: () => number;
  errorReporter?: ErrorReporter | undefined;
  logger?: Logger | undefined;
  /** Auth-step timeout. Default 5 s. */
  authTimeoutMs?: number;
  /** Heartbeat interval override (for tests). Default: ConnectionManager's. */
  heartbeatIntervalMs?: number;
  /**
   * Optional sink for `event` frames the app pushes asynchronously
   * (currently `permission-granted`). When omitted, event frames are
   * acknowledged silently — keeps existing tests that don't care about
   * the new flow from needing to construct one.
   */
  permissionGrantTracker?: {
    recordGrant: (grant: { origin: string; at: number }) => void;
  };
}

export interface WsServerHandle {
  /** Snapshot of how many live sockets the server owns. */
  getSocketCount(): number;
  /**
   * Close every connected socket and detach from the HTTP upgrade event.
   * Defaults to `WS_CLOSE_GOING_AWAY` with reason "bridge shutdown".
   */
  close(code?: number, reason?: string): Promise<void>;
}

type ConnectionPhase = 'awaiting-auth' | 'awaiting-register' | 'registered';

interface SocketState<TApp extends string> {
  phase: ConnectionPhase;
  authTimer: NodeJS.Timeout | null;
  appId?: TApp;
  clientId?: string;
  protocolVersion?: string;
  capabilities?: CapabilityDescriptor[];
  sessionId?: string;
}

/**
 * Reject an unauthenticated HTTP upgrade with a plain 401 + destroy, without
 * leaking headers or body hints. Called from the `upgrade` pre-check.
 */
function writeHttpAndDestroy(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  } catch {
    // best effort
  }
  try {
    socket.destroy();
  } catch {
    // best effort
  }
}

function parseWsMessage(
  raw: RawData,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const value = parsed as Record<string, unknown>;
    if (typeof value['type'] !== 'string') {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function sendError(
  socket: WebSocket,
  code: ErrorCode,
  message: string,
  extras: Partial<Pick<ErrorMessage, 'commandId' | 'prevCommandId'>> = {},
): void {
  const frame: ErrorMessage = {
    type: 'error',
    code,
    message,
    ...extras,
  };
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // best effort — socket may be closing.
  }
}

export function createWsServer<TApp extends string = AppType>(
  options: WsServerOptions<TApp>,
): WsServerHandle {
  const {
    httpServer,
    connectionManager,
    capabilityRegistry,
    commandRouter,
    tokenStore,
    protocolVersion,
    getPort,
    errorReporter,
    logger,
    originGuardOptions,
  } = options;
  const authTimeoutMs = options.authTimeoutMs ?? 5_000;

  const wss = new WebSocketServer({ noServer: true });
  const socketStates = new WeakMap<WebSocket, SocketState<TApp>>();
  const liveSockets = new Set<WebSocket>();

  const handleUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    let parsedPath: string;
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${getPort()}`);
      parsedPath = url.pathname;
    } catch {
      writeHttpAndDestroy(socket, 400, 'Bad Request');
      return;
    }

    if (parsedPath !== WS_PATH) {
      writeHttpAndDestroy(socket, 404, 'Not Found');
      return;
    }

    // Host guard is sync; run it immediately to reject obvious off-origin
    // attempts before doing any async work.
    try {
      assertAllowedHost(req, getPort(), { errorReporter });
    } catch (err) {
      logger?.warn(
        { err, host: req.headers['host'] },
        'WS upgrade rejected by host guard',
      );
      writeHttpAndDestroy(socket, 401, 'Unauthorized');
      return;
    }

    // Origin check runs async so that Stage 10-preview TOFU can fire for
    // unknown-but-well-formed chrome-extension origins. `previewMode: false`
    // + no callback wired → the async helper delegates straight to the sync
    // guard internally and the behaviour matches production.
    fireAndForget((async () => {
      try {
        await assertAllowedOriginAsync(req, {
          ...originGuardOptions,
          errorReporter,
          persistOnApproval: true,
        });
      } catch (err) {
        logger?.warn(
          { err, origin: req.headers['origin'] },
          'WS upgrade rejected by origin guard',
        );
        writeHttpAndDestroy(socket, 401, 'Unauthorized');
        return;
      }

      // Guard against the socket being torn down while we awaited the
      // approval — `writeHead` on a destroyed socket would throw.
      if (socket.destroyed) {
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    })(), 'appBridge.wsServer.handleUpgradeOriginCheck');
  };

  httpServer.on('upgrade', handleUpgrade);

  wss.on('connection', (ws: WebSocket) => {
    liveSockets.add(ws);

    const authTimer = setTimeout(() => {
      const state = socketStates.get(ws);
      if (state && state.phase === 'awaiting-auth') {
        logger?.warn({}, 'WS auth timed out');
        closeWs(ws, ErrorCode.UNAUTHORIZED);
      }
    }, authTimeoutMs);
    if (typeof authTimer.unref === 'function') {
      authTimer.unref();
    }

    socketStates.set(ws, { phase: 'awaiting-auth', authTimer });

    ws.on('message', (raw) => onMessage(ws, raw));

    ws.on('close', () => onClose(ws));

    ws.on('error', (err) => {
      logger?.warn({ err }, 'WS error event');
    });
  });

  connectionManager.startHeartbeat();

  // ---------------------------------------------------------------------------
  // Lifecycle callbacks
  // ---------------------------------------------------------------------------

  function onMessage(ws: WebSocket, raw: RawData): void {
    const state = socketStates.get(ws);
    if (!state) {
      closeWs(ws, ErrorCode.INTERNAL_ERROR);
      return;
    }

    const msg = parseWsMessage(raw);
    if (!msg) {
      if (state.phase === 'awaiting-auth') {
        closeWs(ws, ErrorCode.UNAUTHORIZED);
      } else {
        closeWs(ws, ErrorCode.INVALID_MESSAGE);
      }
      return;
    }

    const type = msg['type'];

    if (state.phase === 'awaiting-auth') {
      if (type !== 'auth') {
        logger?.warn({ type }, 'Non-auth message before auth; closing');
        closeWs(ws, ErrorCode.UNAUTHORIZED);
        return;
      }
      handleAuth(ws, state, msg as unknown as AuthMessage);
      return;
    }

    if (state.phase === 'awaiting-register') {
      if (type !== 'register') {
        sendError(
          ws,
          ErrorCode.BAD_REQUEST,
          'Expected register message before commands.',
        );
        return;
      }
      handleRegister(ws, state, msg as unknown as RegisterMessage);
      return;
    }

    // Registered phase.
    switch (type) {
      case 'response': {
        const responseMsg = msg as unknown as ResponseMessage;
        if (typeof responseMsg.id !== 'string' || responseMsg.id.length === 0) {
          sendError(ws, ErrorCode.INVALID_MESSAGE, 'Response message missing id.');
          return;
        }
        commandRouter.handleResponse(responseMsg);
        return;
      }
      case 'ping':
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
          // ignore
        }
        return;
      case 'pong':
        connectionManager.markPong(ws);
        return;
      case 'event': {
        const eventMsg = msg as Record<string, unknown>;
        const eventName = eventMsg.event;
        if (eventName !== 'permission-granted') {
          sendError(
            ws,
            ErrorCode.INVALID_MESSAGE,
            `Unknown event: ${String(eventName)}`,
          );
          return;
        }
        const origin = typeof eventMsg.origin === 'string' ? eventMsg.origin : null;
        const at = typeof eventMsg.at === 'number' ? eventMsg.at : null;
        if (!origin || at === null) {
          sendError(
            ws,
            ErrorCode.INVALID_MESSAGE,
            'permission-granted event missing origin or at',
          );
          return;
        }
        // Defensive: surface URL for matching, but reject malformed origins
        // so a typo can't accidentally satisfy a waiter.
        try {
          const u = new URL(origin);
          // Canonicalize to scheme://host (strip path/query/hash) — matches
          // the canonicalization the SW uses when building INJECTION_REFUSED
          // details and when calling chrome.permissions.request.
          const canonical = `${u.protocol}//${u.host}`;
          options.permissionGrantTracker?.recordGrant({ origin: canonical, at });
        } catch {
          sendError(
            ws,
            ErrorCode.INVALID_MESSAGE,
            'permission-granted event has malformed origin',
          );
        }
        return;
      }
      case 'auth':
      case 'register':
        sendError(
          ws,
          ErrorCode.BAD_REQUEST,
          `${type} message is not accepted after registration.`,
        );
        return;
      default:
        sendError(ws, ErrorCode.INVALID_MESSAGE, `Unknown message type: ${String(type)}`);
    }
  }

  function handleAuth(
    ws: WebSocket,
    state: SocketState<TApp>,
    msg: AuthMessage,
  ): void {
    const token = typeof msg.token === 'string' ? msg.token : '';
    const appId = typeof msg.appId === 'string' ? (msg.appId as TApp) : undefined;
    const clientId = typeof msg.clientId === 'string' ? msg.clientId : undefined;
    // Post-review B4 — optional fingerprint. verifyAppToken rejects when
    // the stored claim has one and the presented one differs.
    const fingerprint =
      typeof msg.fingerprint === 'string' && msg.fingerprint.length > 0
        ? msg.fingerprint
        : null;

    if (!token || !appId || !clientId) {
      logger?.warn(
        { hasToken: !!token, hasAppId: !!appId, hasClientId: !!clientId },
        'Auth message missing required fields',
      );
      closeWs(ws, ErrorCode.UNAUTHORIZED);
      return;
    }

    const claims = tokenStore.verifyAppToken(token, {
      appId,
      clientId,
      fingerprint,
    });
    if (!claims) {
      errorReporter?.addBreadcrumb({
        category: 'app-bridge.ws',
        level: 'warning',
        message: 'ws-auth-rejected',
        data: { reason: 'scope-or-token-mismatch', appId },
      });
      logger?.warn({ appId }, 'WS auth rejected — token/scope mismatch');
      if (logger) {
        installEvent(logger, 'warn', 'app-bridge.ws.auth.rejected', {
          reason: 'scope-or-token-mismatch',
          appId,
        });
      }
      closeWs(ws, ErrorCode.UNAUTHORIZED);
      return;
    }

    state.phase = 'awaiting-register';
    state.appId = appId;
    state.clientId = clientId;
    if (state.authTimer) {
      clearTimeout(state.authTimer);
      state.authTimer = null;
    }

    errorReporter?.addBreadcrumb({
      category: 'app-bridge.ws',
      level: 'info',
      message: 'ws-auth-ok',
      data: { appId },
    });
    if (logger) {
      installEvent(logger, 'info', 'app-bridge.ws.auth.ok', { appId });
    }
  }

  function handleRegister(
    ws: WebSocket,
    state: SocketState<TApp>,
    msg: RegisterMessage,
  ): void {
    if (msg.protocolVersion !== protocolVersion) {
      logger?.warn(
        {
          expected: protocolVersion,
          actual: msg.protocolVersion ?? null,
          appId: state.appId,
        },
        'WS register rejected — protocol version mismatch',
      );
      errorReporter?.addBreadcrumb({
        category: 'app-bridge.ws',
        level: 'warning',
        message: 'ws-register-protocol-version-mismatch',
        data: {
          expected: protocolVersion,
          actual: msg.protocolVersion ?? null,
        },
      });
      closeWs(ws, ErrorCode.PROTOCOL_VERSION_MISMATCH);
      return;
    }

    if (msg.appId !== state.appId) {
      errorReporter?.addBreadcrumb({
        category: 'app-bridge.ws',
        level: 'warning',
        message: 'ws-register-appid-mismatch',
        data: { authAppId: state.appId, registerAppId: msg.appId },
      });
      if (logger) {
        installEvent(logger, 'warn', 'app-bridge.ws.register.appid-mismatch', {
          authAppId: state.appId,
          registerAppId: msg.appId,
        });
      }
      closeWs(ws, ErrorCode.UNAUTHORIZED);
      return;
    }

    if (msg.clientId !== state.clientId) {
      errorReporter?.addBreadcrumb({
        category: 'app-bridge.ws',
        level: 'warning',
        message: 'ws-register-clientid-mismatch',
        data: { appId: state.appId },
      });
      if (logger) {
        installEvent(logger, 'warn', 'app-bridge.ws.register.clientid-mismatch', {
          appId: state.appId,
        });
      }
      closeWs(ws, ErrorCode.UNAUTHORIZED);
      return;
    }

    const capabilities: CapabilityDescriptor[] = Array.isArray(msg.capabilities)
      ? msg.capabilities.filter(
          (c): c is CapabilityDescriptor =>
            !!c && typeof c === 'object' && typeof (c as CapabilityDescriptor).id === 'string',
        )
      : [];

    connectionManager.register({
      socket: ws,
      appId: state.appId as TApp,
      clientId: state.clientId as string,
      protocolVersion,
      capabilities,
      version: msg.appVersion ?? protocolVersion,
    });
    capabilityRegistry.register(state.appId as TApp, capabilities);

    const sessionId = randomUUID();
    state.phase = 'registered';
    state.protocolVersion = protocolVersion;
    state.capabilities = capabilities;
    state.sessionId = sessionId;

    const ack: RegisteredAck = {
      type: 'registered',
      sessionId,
      acceptedCapabilities: capabilities.map((c) => c.id),
      serverProtocolVersion: '1.0',
      minClientProtocolVersion: '1.0',
    };
    try {
      ws.send(JSON.stringify(ack));
    } catch (err) {
      logger?.warn({ err }, 'Failed to send registered ack');
    }

    logger?.info(
      {
        appId: state.appId,
        clientId: state.clientId,
        capabilitiesCount: capabilities.length,
      },
      'WS registered',
    );
    errorReporter?.addBreadcrumb({
      category: 'app-bridge.ws',
      level: 'info',
      message: 'ws-registered',
      data: {
        appId: state.appId,
        capabilities: capabilities.map((c) => c.id),
      },
    });
    if (logger) {
      installEvent(logger, 'info', 'app-bridge.ws.registered', {
        appId: state.appId,
        capabilitiesCount: capabilities.length,
      });
    }
  }

  function onClose(ws: WebSocket): void {
    liveSockets.delete(ws);
    const state = socketStates.get(ws);
    if (state?.authTimer) {
      clearTimeout(state.authTimer);
    }
    if (state?.appId) {
      // Pass the socket (not the appId) so the ConnectionManager only
      // unregisters this specific connection — avoids stomping on a
      // supersede-replacement socket that raced in ahead of this close.
      const removed = connectionManager.unregister(ws);
      if (removed) {
        capabilityRegistry.unregister(state.appId as TApp);
        commandRouter.rejectPending(state.appId as TApp, ErrorCode.ADDIN_DISCONNECTED);
        logger?.info({ appId: state.appId }, 'App disconnected');
      }
    }
    socketStates.delete(ws);
  }

  /** Close helper that translates an ErrorCode → (close code, reason). */
  function closeWs(ws: WebSocket, code: ErrorCode): void {
    const wsCode = code === ErrorCode.UNAUTHORIZED
      ? WS_CLOSE_UNAUTHORIZED
      : code === ErrorCode.PROTOCOL_VERSION_MISMATCH
        ? WS_CLOSE_PROTOCOL_VERSION_MISMATCH
        : toWsCloseCode(code);
    try {
      ws.close(wsCode, toWsCloseReason(code));
    } catch {
      try {
        ws.terminate();
      } catch {
        // best effort
      }
    }
  }

  const handle: WsServerHandle = {
    getSocketCount: (): number => liveSockets.size,
    close: async (
      code: number = WS_CLOSE_GOING_AWAY,
      reason: string = 'bridge shutdown',
    ): Promise<void> => {
      httpServer.off('upgrade', handleUpgrade);
      connectionManager.stopHeartbeat();
      for (const ws of Array.from(liveSockets)) {
        try {
          ws.close(code, reason);
        } catch {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
        }
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };

  return handle;
}
