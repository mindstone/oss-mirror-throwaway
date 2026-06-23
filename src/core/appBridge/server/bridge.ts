/**
 * createAppBridge — public factory for the App Bridge (Stage 2).
 *
 * Stage 2 delivers:
 *   - Real HTTP server bound on port 52320 with fallback through 52320–52325
 *     on `EADDRINUSE` (R30).
 *   - Intent + pair routers wired with Origin + Host enforcement on every route.
 *   - Atomic state file write (`wx` flag) at
 *     `stateDirectory/state.json`, with stale-PID detection + retry.
 *   - `shutdown()` closes the server and removes the state file.
 *
 * Stage 3 attaches the WebSocket upgrade handler. Stage 4 issues the
 * router-internal token and adds the `/apps/*` relay routes.
 *
 * The bridge accepts `PlatformConfig`, `ErrorReporter`, and optional `Logger`
 * via options — it never imports directly from `electron` or `@core/platform`
 * so cloud/server hosts can wire their own implementations.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import http from 'node:http';
import { mkdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import { writeFile as atomicWriteFile, writeFileSync as atomicWriteFileSync } from 'atomically';
import type { ErrorReporter } from '@core/errorReporter';
import type { PlatformConfig } from '@core/platform';
import { attachBenignSocketErrorGuard } from '@core/utils/socketErrorGuard';
import { CapabilityRegistry } from './capabilityRegistry';
import { CommandRouter } from './commandRouter';
import { ConnectionManager } from './connectionManager';
import { createHostRoutes, type HostRoutesHandlers } from './hostRoutes';
import { createHttpRelayRouter } from './httpRelay';
import { createIntentRouter, type IntentHandlers } from './intentRouter';
import { PermissionGrantTracker } from './permissionGrantTracker';
import { createPairRoutes, type PairRoutesHandle } from './pairRoutes';
import { PairingStore } from './pairingStore';
import {
  TokenStore,
  type ClientExtensionBindingRecord,
  type InstallSessionDenylistRecord,
  type PersistedAppTokenRecord,
} from './tokenStore';
import { APP_BRIDGE_PORT_FALLBACKS, PROTOCOL_VERSION } from '../shared/protocol';
import { applyErrorResponse, type RouterHandler } from './httpUtils';
import { createAppBridgeError, ErrorCode, isBridgeAlreadyRunningError } from '../shared/errors';
import type { OriginGuardOptions } from './originGuard';
import { createWsServer, type WsServerHandle } from './wsServer';
import { PairEventBus } from './pairEventBus';
import {
  applyCorsResponseHeaders,
  handleCorsPreflight,
  isPreflightRequest,
  requestedPrivateNetwork,
} from './corsHeaders';
import { redactExtensionIdForLog } from '../shared/fingerprint';

export interface AppBridgeOptions {
  /**
   * Directory under which the bridge writes its state file. Optional so
   * hosts can pass only `platformConfig` and have the bridge derive the
   * state directory from `userDataPath/mcp/rebel-app-bridge`. See
   * `resolveStateDirectory` below for the resolution order.
   */
  stateDirectory?: string;
  /** Candidate ports to try in order (EADDRINUSE fallback). Defaults to APP_BRIDGE_PORT_FALLBACKS. */
  portCandidates?: readonly number[];
  /** Injected handlers for `/intent/*` (Stage 7). All optional in Stage 2. */
  intentHandlers?: IntentHandlers;
  /** Chrome extension IDs permitted as Origin. */
  allowedChromeExtensionIds?: readonly string[];
  /** Moz extension IDs permitted as Origin (forward-looking; empty by default). */
  allowedMozExtensionIds?: readonly string[];
  /** Dev mode loads extra extension IDs from `stateDirectory/dev-extension-ids.json` when `REBEL_APP_BRIDGE_DEV=1`. */
  devMode?: boolean;
  /** Platform config boundary interface — used only to read `userDataPath` when callers don't pass a stateDirectory. */
  platformConfig?: PlatformConfig;
  /** Optional Sentry breadcrumb sink. */
  errorReporter?: ErrorReporter;
  /** Optional scoped logger. */
  logger?: Logger;
  /** Stage 10-preview — toggles TOFU on. */
  previewMode?: boolean;
  /** TOFU callback for unknown extension origins. */
  onUnknownExtensionOrigin?: (extensionId: string) => Promise<boolean>;
  /** Callback fired when TOFU trust persistence succeeds in-memory but fails on disk. */
  onTrustPersistenceFailure?: (details: {
    extensionId: string;
    stateDirectory: string;
  }) => void;
  /** Callback fired when TOFU persistence adds a new trusted dev extension id. */
  onPersistedExtensionId?: (extensionId: string) => void;
  /**
   * Callback invoked when `/pair/claim` succeeds against an
   * unknown-but-well-formed chrome-extension Origin. The host persists
   * the extension ID to the shared trust file and binds it to the pair
   * session so `resetInstall` can forget it later. Fire-and-forget —
   * must not throw. Only wired by the manager in preview mode.
   */
  onClaimPersistTrust?: (args: {
    pairSessionId: string;
    extensionId: string;
  }) => void;
  /** Host-only loopback handlers for `/host/*` routes. */
  hostHandlers?: HostRoutesHandlers;
  /** Test-only override for the shared pair-event bus. */
  pairEventBus?: PairEventBus;
  /** Test-only override for the pairing store. */
  pairingStore?: PairingStore;
  /** Test-only sweep cadence for code-expiry pair events. */
  pairCodeExpirySweepMs?: number;
  /** Test-only keepalive cadence for `/host/pair-events`. */
  pairEventKeepaliveMs?: number;
  /** Test-only idle timeout for `/host/pair-events`. */
  pairEventIdleTimeoutMs?: number;
  /**
   * Override for how long the http relay awaits a permission-granted event
   * after the SW reports a grantable INJECTION_REFUSED. Defaults to 60_000
   * ms in production; tests typically set this to a few hundred ms so the
   * "no grant arrives" path runs quickly.
   */
  permissionGrantWaitMs?: number;
}

export interface AppBridgeHandle {
  /** Bound port once the server listens. */
  port: number;
  /** Absolute path to the state file. */
  stateFilePath: string;
  /**
   * Router-internal token (R5 / D13). Populated at Stage 3 construction time
   * by TokenStore; written into the state file in Stage 4.
   */
  routerInternalToken: string;
  connectionManager: ConnectionManager;
  commandRouter: CommandRouter;
  capabilityRegistry: CapabilityRegistry;
  pairingStore: PairingStore;
  tokenStore: TokenStore;
  /** Stage 3: WS endpoint handle attached to the bridge HTTP server. */
  wsServer: WsServerHandle;
  /**
   * Tracker for `permission-granted` events the SW posts via the WS
   * `event` channel. Exposed so that bridge hosts can probe it (and tests
   * can drive it) without reaching into router internals.
   */
  permissionGrantTracker: PermissionGrantTracker;
  /** Graceful shutdown. Closes the server and removes the state file. */
  stop(): Promise<void>;
}

interface StateFileShape {
  port: number;
  pid: number;
  protocolVersion: '1.0';
  startedAt: string;
  /**
   * Router-internal token (R5 / D13). Read by the RebelAppBridge stdio MCP
   * server at startup and used as the `Authorization: Bearer …` for
   * `POST /apps/:appId/:capabilityId` relays. Only processes with read
   * access to `userData/mcp/rebel-app-bridge/state.json` (mode 0o600) can
   * acquire it.
   */
  routerToken: string;
  appTokens?: PersistedAppTokenRecord[];
  browserExtensionBootTokenMigrationCompleted?: boolean;
  installSessionDenylist?: InstallSessionDenylistRecord[];
  clientExtensionBindings?: ClientExtensionBindingRecord[];
}

const STATE_FILE_NAME = 'state.json';

/** True iff the process with `pid` is still alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH means no such process; EPERM means it's alive but we can't signal it.
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * Read a previously-written state file. Returns `null` if anything looks off
 * so callers can treat the result as "fresh directory".
 */
async function readStateFile(filePath: string): Promise<StateFileShape | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StateFileShape>;
    const appTokens =
      Array.isArray(parsed.appTokens)
        ? parsed.appTokens.filter(
            (entry): entry is PersistedAppTokenRecord =>
              !!entry &&
              typeof entry === 'object' &&
              typeof entry.appId === 'string' &&
              typeof entry.clientId === 'string' &&
              typeof entry.hashedToken === 'string' &&
              typeof entry.issuedAt === 'number' &&
              (typeof entry.fingerprint === 'string' || entry.fingerprint === null) &&
              (typeof entry.extensionId === 'string' ||
                entry.extensionId === null ||
                typeof entry.extensionId === 'undefined') &&
              (typeof entry.pairSessionId === 'string' ||
                typeof entry.pairSessionId === 'undefined'),
          )
        : undefined;
    const installSessionDenylist =
      Array.isArray(parsed.installSessionDenylist)
        ? parsed.installSessionDenylist.filter(
            (entry): entry is InstallSessionDenylistRecord =>
              !!entry &&
              typeof entry === 'object' &&
              typeof entry.installSessionId === 'string' &&
              typeof entry.revokedAt === 'number',
          )
        : undefined;
    const clientExtensionBindings =
      Array.isArray(parsed.clientExtensionBindings)
        ? parsed.clientExtensionBindings.filter(
            (entry): entry is ClientExtensionBindingRecord =>
              !!entry &&
              typeof entry === 'object' &&
              typeof entry.clientId === 'string' &&
              typeof entry.extensionId === 'string' &&
              typeof entry.createdAt === 'number',
          )
        : undefined;
    if (
      typeof parsed.port === 'number' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.protocolVersion === 'string' &&
      typeof parsed.startedAt === 'string' &&
      // `routerToken` is required in Stage 4+; state files written by
      // earlier stages that never received it are treated as stale and
      // fall through to the unlink+retry path below.
      typeof parsed.routerToken === 'string' &&
      parsed.routerToken.length > 0
    ) {
      return {
        port: parsed.port,
        pid: parsed.pid,
        protocolVersion: '1.0',
        startedAt: parsed.startedAt,
        routerToken: parsed.routerToken,
        ...(appTokens ? { appTokens } : {}),
        ...(typeof parsed.browserExtensionBootTokenMigrationCompleted === 'boolean'
          ? {
              browserExtensionBootTokenMigrationCompleted:
                parsed.browserExtensionBootTokenMigrationCompleted,
            }
          : {}),
        ...(installSessionDenylist ? { installSessionDenylist } : {}),
        ...(clientExtensionBindings ? { clientExtensionBindings } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomic state-file write per R30:
 *   - Use `{ flag: 'wx' }` to fail if the file exists.
 *   - If EEXIST, check whether the owning PID is still alive.
 *     - Alive → propagate the error (caller handles: pick another port or abort).
 *     - Dead → unlink, retry once.
 *   - On all other errors: propagate.
 */
async function writeStateFileAtomically(
  filePath: string,
  payload: StateFileShape,
): Promise<void> {
  const serialized = JSON.stringify(payload);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const existing = await readStateFile(filePath);
  if (existing && isPidAlive(existing.pid) && existing.pid !== process.pid) {
    throw createAppBridgeError(
      ErrorCode.BRIDGE_ALREADY_RUNNING,
      `A live App Bridge already owns ${filePath} (pid ${existing.pid}).`,
      { path: filePath, pid: existing.pid },
    );
  }

  await atomicWriteFile(filePath, serialized, { encoding: 'utf8', mode: 0o600 });
}

function writeStateFileAtomicallySync(
  filePath: string,
  payload: StateFileShape,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, JSON.stringify(payload), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function tryBindPort(
  server: http.Server,
  candidate: number,
  host: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const cleanup = { onListening: (): void => {}, onError: (_e: unknown): void => {} };
    cleanup.onListening = (): void => {
      server.removeListener('error', cleanup.onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to resolve bound bridge port.'));
        return;
      }
      resolve(address.port);
    };
    cleanup.onError = (err: unknown): void => {
      server.removeListener('listening', cleanup.onListening);
      reject(err as NodeJS.ErrnoException);
    };
    server.once('error', cleanup.onError);
    server.once('listening', cleanup.onListening);
    server.listen(candidate, host);
  });
}

/**
 * Try each candidate port in order. Returns the bound port on first success.
 * Rethrows non-EADDRINUSE errors immediately.
 */
async function listenOnFirstFreePort(
  server: http.Server,
  candidates: readonly number[],
  host: string,
): Promise<number> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const port = await tryBindPort(server, candidate, host);
      return port;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' || code === 'EACCES') {
        errors.push(`port ${candidate}: ${code}`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `App Bridge could not bind to any port (tried: ${candidates.join(', ')}). ` +
      `Details: ${errors.join('; ')}.`,
  );
}

function resolveStateDirectory(options: AppBridgeOptions): string {
  if (options.stateDirectory && options.stateDirectory.trim().length > 0) {
    return options.stateDirectory;
  }
  if (options.platformConfig) {
    return path.join(options.platformConfig.userDataPath, 'mcp', 'rebel-app-bridge');
  }
  throw new Error(
    'createAppBridge requires either `stateDirectory` or `platformConfig` to locate the state file.',
  );
}

/**
 * Build the bridge. Binds on the first free port in `portCandidates`, writes
 * the state file atomically, and returns a handle the host can stop cleanly.
 */
export async function createAppBridge(options: AppBridgeOptions): Promise<AppBridgeHandle> {
  const portCandidates = options.portCandidates ?? APP_BRIDGE_PORT_FALLBACKS;
  const stateDirectory = resolveStateDirectory(options);
  const stateFilePath = path.join(stateDirectory, STATE_FILE_NAME);
  const host = '127.0.0.1';
  const existingState = await readStateFile(stateFilePath);

  const tokenStore = options.pairingStore?.getTokenStore() ?? new TokenStore();
  if (existingState?.appTokens) {
    for (const entry of existingState.appTokens) {
      tokenStore.restoreAppToken(entry.hashedToken, {
        appId: entry.appId,
        clientId: entry.clientId,
        issuedAt: entry.issuedAt,
        fingerprint: entry.fingerprint,
        extensionId: entry.extensionId ?? null,
        pairSessionId: entry.pairSessionId,
      });
    }
  } else if (existingState) {
    options.logger?.info(
      { stateFilePath },
      'App Bridge state file had no appTokens; starting with empty paired-token cache',
    );
  }
  if (existingState?.installSessionDenylist) {
    for (const entry of existingState.installSessionDenylist) {
      tokenStore.restoreRevokedInstallSession(entry);
    }
  }
  if (existingState?.clientExtensionBindings) {
    for (const entry of existingState.clientExtensionBindings) {
      tokenStore.restoreClientExtensionBinding(entry);
    }
  }
  let browserExtensionBootTokenMigrationCompleted =
    existingState?.browserExtensionBootTokenMigrationCompleted ?? false;
  if (!browserExtensionBootTokenMigrationCompleted) {
    const startedAtMs = Date.now();
    const revokedCount = tokenStore.revokeAppTokensByAppId('browser-extension');
    browserExtensionBootTokenMigrationCompleted = true;
    options.logger?.info(
      {
        event: 'app-bridge.browser-migration',
        revokedCount,
        durationMs: Date.now() - startedAtMs,
      },
      'App Bridge browser-extension boot-token migration complete',
    );
  }
  const pairingStore = options.pairingStore ?? new PairingStore({ tokenStore });
  const pairEventBus = options.pairEventBus ?? new PairEventBus();
  const connectionManager = new ConnectionManager();
  const commandRouter = new CommandRouter(connectionManager, {
    logger: options.logger,
    errorReporter: options.errorReporter,
  });
  const capabilityRegistry = new CapabilityRegistry();
  // Tracks `permission-granted` events from the extension SW so the relay
  // can unblock an in-flight INJECTION_REFUSED retry. See
  // `src/core/appBridge/server/permissionGrantTracker.ts` for full rationale.
  const permissionGrantTracker = new PermissionGrantTracker(
    options.logger ? { logger: options.logger } : {},
  );

  let boundPort = 0;
  const startedAt = new Date().toISOString();

  const originGuardOptions: OriginGuardOptions = {
    chromeExtensionIds: options.allowedChromeExtensionIds ?? [],
    mozExtensionIds: options.allowedMozExtensionIds ?? [],
    devMode: options.devMode ?? false,
    stateDirectory,
    errorReporter: options.errorReporter,
    previewMode: options.previewMode,
    onUnknownExtensionOrigin: options.onUnknownExtensionOrigin,
    onTrustPersistenceFailure: options.onTrustPersistenceFailure,
    onPersistedExtensionId: options.onPersistedExtensionId,
    ...(options.logger ? { logger: options.logger } : {}),
  };

  const pairRoutes = createPairRoutes({
    pairingStore,
    tokenStore,
    pairEventBus,
    getPort: () => boundPort,
    originGuardOptions,
    errorReporter: options.errorReporter,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.pairCodeExpirySweepMs
      ? { expirySweepMs: options.pairCodeExpirySweepMs }
      : {}),
    ...(options.onClaimPersistTrust
      ? { onClaimPersistTrust: options.onClaimPersistTrust }
      : {}),
  }) as PairRoutesHandle;

  const routers: RouterHandler[] = [
    createIntentRouter({
      tokenStore,
      handlers: options.intentHandlers,
      getPort: () => boundPort,
      originGuardOptions,
      errorReporter: options.errorReporter,
      ...(options.logger ? { logger: options.logger } : {}),
    }),
    pairRoutes,
    ...(options.hostHandlers
      ? [
          createHostRoutes({
            tokenStore,
            handlers: options.hostHandlers,
            pairEventBus,
            errorReporter: options.errorReporter,
            logger: options.logger,
            ...(options.pairEventKeepaliveMs
              ? { pairEventsKeepaliveMs: options.pairEventKeepaliveMs }
              : {}),
            ...(options.pairEventIdleTimeoutMs
              ? { pairEventsIdleTimeoutMs: options.pairEventIdleTimeoutMs }
              : {}),
          }),
        ]
      : []),
    createHttpRelayRouter({
      commandRouter,
      capabilityRegistry,
      tokenStore,
      errorReporter: options.errorReporter,
      logger: options.logger,
      permissionGrantTracker,
      ...(options.permissionGrantWaitMs !== undefined
        ? { permissionGrantWaitMs: options.permissionGrantWaitMs }
        : {}),
    }),
  ];

  const server = http.createServer((req, res) => {
    // Structured request log — fires once per request regardless of how
    // the response ends (clean finish, client disconnect mid-SSE,
    // early abort, error). Gives ops a single line per inbound HTTP
    // request (including preflights) with redacted origin so diagnosing
    // "did the extension talk to the bridge?" doesn't require Sentry
    // breadcrumb access. Level = debug so normal operation stays quiet;
    // bump via pino level config if needed.
    //
    // Why `close` instead of `finish`: SSE responses never call finish
    // until the socket closes, and aborted requests skip finish entirely.
    // `close` fires in both cases. A `logged` flag guards against the
    // rare case where both fire on the same response (finish → close).
    const originRaw = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const originForLog = originRaw ? redactExtensionIdForLog(originRaw) : undefined;
    let logged = false;
    const emitLog = (): void => {
      if (logged) return;
      logged = true;
      options.logger?.debug(
        {
          method: req.method,
          path: (req.url ?? '').split('?')[0],
          status: res.statusCode,
          origin: originForLog,
          isPreflight: isPreflightRequest(req),
          pna: requestedPrivateNetwork(req),
          aborted: req.aborted === true,
        },
        'app-bridge-http-request',
      );
    };
    res.once('close', emitLog);
    res.once('finish', emitLog);

    try {
      // CORS response headers for every real request. MUST run BEFORE the
      // router chain so both success (200) and failure (401/403/404)
      // responses carry Access-Control-Allow-Origin + Vary: Origin. Without
      // this the extension sees opaque CORS errors instead of readable
      // status codes. See corsHeaders.ts for the full rationale.
      applyCorsResponseHeaders(req, res);

      // Short-circuit preflight before the router chain. This must cover
      // ALL paths (including /ws if a browser ever probes it with OPTIONS,
      // and any future extension-facing endpoint), so the handler is
      // global — not path-scoped. Host validation runs inside.
      if (isPreflightRequest(req)) {
        handleCorsPreflight(req, res, () => boundPort, options.errorReporter, options.logger);
        return;
      }

      for (const router of routers) {
        if (router(req, res)) {
          return;
        }
      }
      applyErrorResponse(
        res,
        createAppBridgeError(
          ErrorCode.BAD_REQUEST,
          `No route matched ${req.method ?? 'UNKNOWN'} ${req.url ?? ''}`,
        ),
      );
    } catch (err) {
      options.logger?.error({ err }, 'App Bridge request handler threw');
      options.errorReporter?.captureException(err, { area: 'app-bridge', phase: 'request' });
      applyErrorResponse(res, err);
    }
  });

  // REBEL-5J5: swallow benign per-connection socket errors (EPIPE/ECONNRESET/
  // ECONNABORTED from a client disconnecting mid-write) at the connection layer
  // — covers both HTTP response sockets and the WS-upgrade sockets attached
  // below — so they don't escalate to process 'uncaughtException' (level=fatal).
  attachBenignSocketErrorGuard(server);

  try {
    boundPort = await listenOnFirstFreePort(server, portCandidates, host);
  } catch (err) {
    options.errorReporter?.captureException(err, { area: 'app-bridge', phase: 'listen' });
    throw err;
  }

  // Stage 3: attach the WS upgrade handler now that the HTTP server is live.
  const wsServer = createWsServer({
    httpServer: server,
    originGuardOptions,
    connectionManager,
    capabilityRegistry,
    commandRouter,
    tokenStore,
    protocolVersion: PROTOCOL_VERSION,
    getPort: () => boundPort,
    errorReporter: options.errorReporter,
    logger: options.logger,
    permissionGrantTracker,
  });

  const routerInternalToken = tokenStore.getRouterInternalToken();
  const buildStatePayload = (): StateFileShape => ({
    port: boundPort,
    pid: process.pid,
    protocolVersion: '1.0',
    startedAt,
    routerToken: routerInternalToken,
    browserExtensionBootTokenMigrationCompleted,
    appTokens: [...tokenStore.listPersistedAppTokens()],
    installSessionDenylist: [...tokenStore.listRevokedInstallSessions()],
    clientExtensionBindings: [...tokenStore.listClientExtensionBindings()],
  });

  try {
    await writeStateFileAtomically(stateFilePath, buildStatePayload());
  } catch (err) {
    await wsServer.close().catch(() => undefined);
    await closeServer(server);
    if (isBridgeAlreadyRunningError(err)) {
      // Expected condition (REBEL-5EB): another live App Bridge process already
      // owns the state file (a previous instance is still alive, or a relaunch
      // raced its shutdown). The bridge correctly refuses to clobber the live
      // owner and the caller aborts this start — so log it, but do NOT report an
      // unexpected error to Sentry.
      options.logger?.warn(
        { err, stateFilePath },
        'App Bridge state file is owned by another live process; aborting this start',
      );
    } else {
      options.errorReporter?.captureException(err, { area: 'app-bridge', phase: 'state-write' });
    }
    throw err;
  }

  const persistTokenState = (): void => {
    try {
      writeStateFileAtomicallySync(stateFilePath, buildStatePayload());
    } catch (err) {
      options.logger?.error({ err, stateFilePath }, 'Failed to persist App Bridge token state');
      options.errorReporter?.captureException(err, {
        area: 'app-bridge',
        phase: 'state-rewrite',
        stateFilePath,
      });
      throw err;
    }
  };

  const wrappedTokenStore = tokenStore as TokenStore & {
    issueAppToken: TokenStore['issueAppToken'];
    revokePairingToken: TokenStore['revokePairingToken'];
    revokeAppToken: TokenStore['revokeAppToken'];
    revokeAppTokensByClientId: TokenStore['revokeAppTokensByClientId'];
    revokeAppTokensByAppId: TokenStore['revokeAppTokensByAppId'];
    revokeAppTokensByPairSessionId: TokenStore['revokeAppTokensByPairSessionId'];
    revokeAllAppTokens: TokenStore['revokeAllAppTokens'];
    revokeInstallSessionId: TokenStore['revokeInstallSessionId'];
    upsertClientExtensionBinding: TokenStore['upsertClientExtensionBinding'];
    removeClientExtensionBinding: TokenStore['removeClientExtensionBinding'];
  };
  const issueAppToken = tokenStore.issueAppToken.bind(tokenStore);
  wrappedTokenStore.issueAppToken = ((...args) => {
    const token = issueAppToken(...args);
    persistTokenState();
    return token;
  }) as TokenStore['issueAppToken'];
  const revokePairingToken = tokenStore.revokePairingToken.bind(tokenStore);
  wrappedTokenStore.revokePairingToken = ((token: string) => {
    revokePairingToken(token);
    persistTokenState();
  }) as TokenStore['revokePairingToken'];
  wrappedTokenStore.revokeAppToken = ((token: string) => {
    revokePairingToken(token);
    persistTokenState();
  }) as TokenStore['revokeAppToken'];
  const revokeAppTokensByClientId = tokenStore.revokeAppTokensByClientId.bind(tokenStore);
  wrappedTokenStore.revokeAppTokensByClientId = ((clientId: string) => {
    const revoked = revokeAppTokensByClientId(clientId);
    if (revoked > 0) {
      persistTokenState();
    }
    return revoked;
  }) as TokenStore['revokeAppTokensByClientId'];
  const revokeAppTokensByAppId = tokenStore.revokeAppTokensByAppId.bind(tokenStore);
  wrappedTokenStore.revokeAppTokensByAppId = ((appId) => {
    const revoked = revokeAppTokensByAppId(appId);
    if (revoked > 0) {
      persistTokenState();
    }
    return revoked;
  }) as TokenStore['revokeAppTokensByAppId'];
  const revokeAppTokensByPairSessionId = tokenStore.revokeAppTokensByPairSessionId.bind(tokenStore);
  wrappedTokenStore.revokeAppTokensByPairSessionId = ((pairSessionId: string) => {
    const revoked = revokeAppTokensByPairSessionId(pairSessionId);
    if (revoked > 0) {
      persistTokenState();
    }
    return revoked;
  }) as TokenStore['revokeAppTokensByPairSessionId'];
  const revokeAllAppTokens = tokenStore.revokeAllAppTokens.bind(tokenStore);
  wrappedTokenStore.revokeAllAppTokens = (() => {
    const revoked = revokeAllAppTokens();
    if (revoked > 0) {
      persistTokenState();
    }
    return revoked;
  }) as TokenStore['revokeAllAppTokens'];
  const revokeInstallSessionId = tokenStore.revokeInstallSessionId.bind(tokenStore);
  wrappedTokenStore.revokeInstallSessionId = ((installSessionId: string) => {
    revokeInstallSessionId(installSessionId);
    persistTokenState();
  }) as TokenStore['revokeInstallSessionId'];
  const upsertClientExtensionBinding =
    tokenStore.upsertClientExtensionBinding.bind(tokenStore);
  wrappedTokenStore.upsertClientExtensionBinding = ((clientId, extensionId) => {
    const result = upsertClientExtensionBinding(clientId, extensionId);
    if (result.ok && result.kind === 'new') {
      persistTokenState();
    }
    return result;
  }) as TokenStore['upsertClientExtensionBinding'];
  const removeClientExtensionBinding =
    tokenStore.removeClientExtensionBinding.bind(tokenStore);
  wrappedTokenStore.removeClientExtensionBinding = ((clientId) => {
    const removed = removeClientExtensionBinding(clientId);
    if (removed) {
      persistTokenState();
    }
    return removed;
  }) as TokenStore['removeClientExtensionBinding'];

  connectionManager.on('disconnect', (appId: string) => {
    commandRouter.rejectPending(appId, ErrorCode.ADDIN_DISCONNECTED);
  });

  options.logger?.info(
    {
      port: boundPort,
      stateFilePath,
      pid: process.pid,
      // Never log the router token itself — only its length, so ops can spot
      // a zero-length regression without leaking the secret into log files.
      routerTokenLen: routerInternalToken.length,
    },
    'App Bridge listening',
  );
  options.errorReporter?.addBreadcrumb({
    category: 'app-bridge',
    level: 'info',
    message: 'bridge-start',
    data: { port: boundPort },
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    pairRoutes.dispose?.();

    // Close every WS connection with 1001 Going Away before disposing the
    // command router so pending requests see ADDIN_DISCONNECTED (via the
    // WS-close → unregister chain) not INTERNAL_ERROR (via dispose).
    await wsServer.close();
    commandRouter.dispose();
    permissionGrantTracker.dispose();
    connectionManager.stopHeartbeat();
    server.closeAllConnections?.();
    await closeServer(server);
    if (tokenStore.listAppTokens().length === 0) {
      try {
        await fs.unlink(stateFilePath);
      } catch {
        // Best effort — file may already be gone.
      }
    }

    options.errorReporter?.addBreadcrumb({
      category: 'app-bridge',
      level: 'info',
      message: 'bridge-stop',
      data: { port: boundPort },
    });
    options.logger?.info({ port: boundPort }, 'App Bridge stopped');
  };

  return {
    port: boundPort,
    stateFilePath,
    routerInternalToken,
    connectionManager,
    commandRouter,
    capabilityRegistry,
    pairingStore,
    tokenStore,
    wsServer,
    permissionGrantTracker,
    stop,
  };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
