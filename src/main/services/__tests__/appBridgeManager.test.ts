/**
 * appBridgeManager — Stage 5 unit tests.
 *
 * Covers the gate logic, idempotence, and multi-instance coexistence (D26)
 * without binding real loopback ports. We inject a fake factory so every
 * test is hermetic and fast — the core factory's own behaviour is already
 * exercised by `src/core/appBridge/__tests__/bridge.test.ts`.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import WebSocket from 'ws';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBridgeHandle, AppBridgeOptions } from '@core/appBridge';
import { createAppBridgeError, ErrorCode } from '@core/appBridge/shared/errors';
import { PairingStore } from '@core/appBridge/server/pairingStore';
import { ConnectionManager } from '@core/appBridge/server/connectionManager';
import { PairEventBus } from '@core/appBridge/server/pairEventBus';
import { TokenStore } from '@core/appBridge/server/tokenStore';
import type { BroadcastService } from '@core/broadcastService';
import type { ErrorReporter } from '@core/errorReporter';
import type { PlatformConfig, PlatformSurface } from '@core/platform';
import { defaultCapabilities } from '@core/platform';
import {
  CONNECTOR_STATUS_CHANGED,
  LEGACY_SETTINGS_SESSION_ID,
  type ConnectorStatusChangedPayload,
} from '@shared/ipc/channels/appBridge';
import {
  APP_BRIDGE_DEV_MODE_ENV,
  APP_BRIDGE_KILL_SWITCH_ENV,
  createAppBridgeManager,
} from '../appBridgeManager';
import type { AppBridgeInstallerService } from '../appBridgeInstallerService';
import { installFunnelStats } from '../installFunnelStats';

type BroadcastCall = { channel: string; args: unknown[] };

function buildBroadcastService(): BroadcastService & { calls: BroadcastCall[] } {
  const calls: BroadcastCall[] = [];
  return {
    calls,
    sendToAllWindows: (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
    },
    // Stage 2 uses `sendToAllWindows` only; the focused-window variant is
    // required by the interface but not exercised here.
    sendToFocusedWindow: (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
    },
  };
}

function findStatusBroadcasts(
  broadcastService: BroadcastService & { calls: BroadcastCall[] },
) {
  return broadcastService.calls.filter(
    (call) => call.channel === CONNECTOR_STATUS_CHANGED,
  );
}

type Breadcrumb = Parameters<ErrorReporter['addBreadcrumb']>[0];

function buildPlatformConfig(surface: PlatformSurface): PlatformConfig {
  return {
    userDataPath: '/tmp/rebel-app-bridge-manager-test',
    appPath: '/tmp/rebel-app-bridge-manager-test-app',
    tempPath: '/tmp',
    logsPath: '/tmp/rebel-app-bridge-manager-test/logs',
    homePath: '/tmp',
    documentsPath: '/tmp/Documents',
    desktopPath: '/tmp/Desktop',
    appDataPath: '/tmp/appData',
    version: '0.0.0-test',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface,
    isOss: false,
    capabilities: defaultCapabilities(surface),
  };
}

function buildPlatformConfigWithUserData(
  surface: PlatformSurface,
  userDataPath: string,
): PlatformConfig {
  return {
    ...buildPlatformConfig(surface),
    userDataPath,
    appPath: join(userDataPath, 'app'),
    logsPath: join(userDataPath, 'logs'),
    homePath: userDataPath,
    documentsPath: join(userDataPath, 'Documents'),
    desktopPath: join(userDataPath, 'Desktop'),
    appDataPath: join(userDataPath, 'appData'),
  };
}

function buildErrorReporter(): ErrorReporter & {
  breadcrumbs: Breadcrumb[];
  captured: Array<{ error: unknown; context?: Record<string, unknown> }>;
} {
  const breadcrumbs: Breadcrumb[] = [];
  const captured: Array<{ error: unknown; context?: Record<string, unknown> }> = [];
  return {
    breadcrumbs,
    captured,
    addBreadcrumb: (b) => {
      breadcrumbs.push(b);
    },
    captureException: (error, context) => {
      captured.push({ error, context });
    },
    captureMessage: () => {},
  };
}

interface FakeHandleOptions {
  port?: number;
  stateFilePath?: string;
  routerInternalToken?: string;
  stop?: () => Promise<void>;
}

/**
 * Build a typed `AppBridgeHandle` stub — only populates the fields the
 * manager actually reads. Every other field is kept as `{} as never`
 * so a bug that *does* reach for one surfaces loudly in test output
 * (instead of hiding behind a default-constructed mock).
 */
function buildFakeHandle(opts: FakeHandleOptions = {}): AppBridgeHandle {
  const stopFn = opts.stop ?? (async () => {});
  return {
    port: opts.port ?? 52320,
    stateFilePath: opts.stateFilePath ?? '/tmp/bridge/state.json',
    routerInternalToken: opts.routerInternalToken ?? 'router-internal-token-test',
    // Fields the manager doesn't touch — cast through unknown to keep
    // the type checker honest.
    connectionManager: {} as unknown as AppBridgeHandle['connectionManager'],
    commandRouter: {} as unknown as AppBridgeHandle['commandRouter'],
    capabilityRegistry: {} as unknown as AppBridgeHandle['capabilityRegistry'],
    pairingStore: {} as unknown as AppBridgeHandle['pairingStore'],
    tokenStore: {} as unknown as AppBridgeHandle['tokenStore'],
    wsServer: {} as unknown as AppBridgeHandle['wsServer'],
    permissionGrantTracker: {} as unknown as AppBridgeHandle['permissionGrantTracker'],
    stop: stopFn,
  };
}

describe('appBridgeManager', () => {
  const originalKillSwitch = process.env[APP_BRIDGE_KILL_SWITCH_ENV];

  beforeEach(() => {
    delete process.env[APP_BRIDGE_KILL_SWITCH_ENV];
  });

  afterEach(() => {
    installFunnelStats.resetForTesting();
    if (originalKillSwitch === undefined) {
      delete process.env[APP_BRIDGE_KILL_SWITCH_ENV];
    } else {
      process.env[APP_BRIDGE_KILL_SWITCH_ENV] = originalKillSwitch;
    }
  });

  it('starts the bridge and reports runtime state on desktop without the kill switch', async () => {
    const stopSpy = vi.fn(async () => {});
    const factory = vi.fn(async () =>
      buildFakeHandle({ port: 52320, routerInternalToken: 'abc', stop: stopSpy }),
    );
    const errorReporter = buildErrorReporter();
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter,
      createBridge: factory,
    });

    const state = await manager.start();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(state).toEqual({
      port: 52320,
      stateFilePath: '/tmp/bridge/state.json',
      routerToken: 'abc',
    });
    expect(manager.isRunning()).toBe(true);
    expect(manager.getSkipReason()).toBeNull();
    // The factory emits `bridge-start` itself — the manager stays silent
    // on success to avoid double-breadcrumbing the same event.
    expect(errorReporter.breadcrumbs).toEqual([]);
  });

  it('does not capture the expected BRIDGE_ALREADY_RUNNING ownership conflict to Sentry (REBEL-5EB)', async () => {
    const ownershipError = createAppBridgeError(
      ErrorCode.BRIDGE_ALREADY_RUNNING,
      'A live App Bridge already owns /tmp/bridge/state.json (pid 912).',
      { path: '/tmp/bridge/state.json', pid: 912 },
    );
    const factory = vi.fn(async () => {
      throw ownershipError;
    });
    const errorReporter = buildErrorReporter();
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter,
      createBridge: factory,
    });

    await expect(manager.start()).rejects.toMatchObject({
      code: ErrorCode.BRIDGE_ALREADY_RUNNING,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    // REBEL-5EB: the manager catch must NOT report this expected, caller-handled
    // ownership conflict to Sentry (the non-ownership branch would capture it).
    expect(errorReporter.captured).toEqual([]);
  });

  it('skips the factory when the kill switch env var is set (D19)', async () => {
    const factory = vi.fn();
    const errorReporter = buildErrorReporter();
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter,
      createBridge: factory as never,
      readKillSwitch: () => '1',
    });

    const state = await manager.start();

    expect(state).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(manager.isRunning()).toBe(false);
    expect(manager.getSkipReason()).toBe('kill-switch');
    const disabled = errorReporter.breadcrumbs.find((b) => b.message === 'bridge-disabled');
    expect(disabled?.data).toMatchObject({ reason: 'kill-switch', env: APP_BRIDGE_KILL_SWITCH_ENV });
  });

  it.each<[string, boolean]>([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['0', false],
    ['false', false],
    ['', false],
  ])('kill switch parses "%s" as enabled=%s', async (raw, shouldSkip) => {
    const factory = vi.fn(async () => buildFakeHandle());
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      readKillSwitch: () => raw,
    });

    const state = await manager.start();

    if (shouldSkip) {
      expect(state).toBeNull();
      expect(factory).not.toHaveBeenCalled();
    } else {
      expect(state).not.toBeNull();
      expect(factory).toHaveBeenCalledTimes(1);
    }
  });

  it('skips the factory on non-desktop surfaces (R34 — cloud)', async () => {
    const factory = vi.fn();
    const errorReporter = buildErrorReporter();
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('cloud'),
      errorReporter,
      createBridge: factory as never,
    });

    const state = await manager.start();

    expect(state).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(manager.getSkipReason()).toBe('surface-not-desktop');
    const skipped = errorReporter.breadcrumbs.find((b) => b.message === 'bridge-skipped');
    expect(skipped?.data).toMatchObject({ reason: 'surface-not-desktop', surface: 'cloud' });
  });

  it('skips the factory on non-desktop surfaces (R34 — mobile)', async () => {
    const factory = vi.fn();
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('mobile'),
      errorReporter: buildErrorReporter(),
      createBridge: factory as never,
    });

    await expect(manager.start()).resolves.toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(manager.getSkipReason()).toBe('surface-not-desktop');
  });

  it('skips the factory when capabilities.appBridgeServer is false on desktop surface', async () => {
    const factory = vi.fn();
    const desktopConfig = buildPlatformConfig('desktop');
    const manager = createAppBridgeManager({
      platformConfig: {
        ...desktopConfig,
        capabilities: { ...desktopConfig.capabilities, appBridgeServer: false },
      },
      errorReporter: buildErrorReporter(),
      createBridge: factory as never,
    });

    await expect(manager.start()).resolves.toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(manager.getSkipReason()).toBe('surface-not-desktop');
  });

  it('skips restartWithDynamicPort when capabilities.appBridgeServer is false', async () => {
    const factory = vi.fn(async () => buildFakeHandle({ port: 52323 }));
    const desktopConfig = buildPlatformConfig('desktop');
    const manager = createAppBridgeManager({
      platformConfig: {
        ...desktopConfig,
        capabilities: { ...desktopConfig.capabilities, appBridgeServer: false },
      },
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });

    await expect(manager.restartWithDynamicPort()).resolves.toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(manager.getSkipReason()).toBe('surface-not-desktop');
  });

  it('is idempotent — a second start() returns the same state and does not re-invoke the factory', async () => {
    const factory = vi.fn(async () => buildFakeHandle({ port: 52321 }));
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });

    const first = await manager.start();
    const second = await manager.start();

    expect(first).toEqual(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent start() calls into a single factory invocation', async () => {
    let resolveFactory!: (h: AppBridgeHandle) => void;
    const factory = vi.fn(
      () =>
        new Promise<AppBridgeHandle>((resolve) => {
          resolveFactory = resolve;
        }),
    );
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });

    const p1 = manager.start();
    const p2 = manager.start();
    // Race: release the factory promise now, after both calls are awaiting.
    resolveFactory(buildFakeHandle({ port: 52322 }));

    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).toEqual(s2);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('stop() cleanly tears down and is safe before start / after start', async () => {
    const stopSpy = vi.fn(async () => {});
    const factory = vi.fn(async () => buildFakeHandle({ stop: stopSpy }));
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });

    // Safe to stop before start — never calls the factory, never throws.
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(manager.isRunning()).toBe(false);
  });

  it('stop() calls handle.stop() exactly once and is safe to repeat', async () => {
    const stopSpy = vi.fn(async () => {});
    const factory = vi.fn(async () => buildFakeHandle({ stop: stopSpy }));
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });

    await manager.start();
    await manager.stop();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(manager.isRunning()).toBe(false);
    expect(manager.getState()).toBeNull();

    // Second stop() is a no-op (no double-close of the same handle).
    await manager.stop();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('start() after stop() stays terminal — never re-runs the factory', async () => {
    const factory = vi.fn(async () => buildFakeHandle());
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });

    await manager.start();
    await manager.stop();
    const afterStop = await manager.start();

    expect(afterStop).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('surfaces factory failures: captures, logs, rethrows, and leaves isRunning=false', async () => {
    const bridgeFailure = new Error('EADDRINUSE across all candidates');
    const factory = vi.fn(async () => {
      throw bridgeFailure;
    });
    const errorReporter = buildErrorReporter();
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter,
      createBridge: factory,
    });

    await expect(manager.start()).rejects.toBe(bridgeFailure);
    expect(manager.isRunning()).toBe(false);
    expect(manager.getState()).toBeNull();
    expect(errorReporter.captured.some((c) => c.error === bridgeFailure)).toBe(true);
  });

  it('two managers coexist on the same host (D26 multi-instance)', async () => {
    // The core factory handles real port fallback; this test verifies that
    // two *manager instances* (as would exist in two Rebel installs on the
    // same machine) can both be constructed and stopped independently.
    const factoryA = vi.fn(async () =>
      buildFakeHandle({
        port: 52320,
        stateFilePath: '/tmp/rebel-a/state.json',
        routerInternalToken: 'token-a',
      }),
    );
    const factoryB = vi.fn(async () =>
      buildFakeHandle({
        port: 52321,
        stateFilePath: '/tmp/rebel-b/state.json',
        routerInternalToken: 'token-b',
      }),
    );

    const managerA = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factoryA,
    });
    const managerB = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factoryB,
    });

    const [a, b] = await Promise.all([managerA.start(), managerB.start()]);

    expect(a?.port).toBe(52320);
    expect(b?.port).toBe(52321);
    expect(a?.routerToken).not.toBe(b?.routerToken);
    expect(a?.stateFilePath).not.toBe(b?.stateFilePath);
    expect(managerA.isRunning()).toBe(true);
    expect(managerB.isRunning()).toBe(true);

    // Each manager manages its own handle — stopping A leaves B running.
    await managerA.stop();
    expect(managerA.isRunning()).toBe(false);
    expect(managerB.isRunning()).toBe(true);
    await managerB.stop();
    expect(managerB.isRunning()).toBe(false);
  });

  it('stop() swallows factory.stop() throws so graceful shutdown keeps draining', async () => {
    const stopErr = new Error('state file vanished');
    const factory = vi.fn(async () =>
      buildFakeHandle({
        stop: async () => {
          throw stopErr;
        },
      }),
    );
    const errorReporter = buildErrorReporter();
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter,
      createBridge: factory,
    });

    await manager.start();
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(errorReporter.captured.some((c) => c.error === stopErr)).toBe(true);
  });

  // --- A2 — allowlist + devMode wiring ------------------------------------

  it('passes resolved extension IDs and devMode flag into the factory (A2)', async () => {
    const factoryArgs: Array<Record<string, unknown>> = [];
    const factory = vi.fn(async (args) => {
      factoryArgs.push(args);
      return buildFakeHandle();
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      resolveAllowedExtensionIds: () => ['aaaabbbbccccddddeeeeffffgggghhhh'],
      readDevMode: () => true,
    });
    await manager.start();
    expect(factoryArgs[0]).toMatchObject({
      allowedChromeExtensionIds: ['aaaabbbbccccddddeeeeffffgggghhhh'],
      devMode: true,
    });
  });

  it('reads APP_BRIDGE_DEV_MODE_ENV when readDevMode is not injected', async () => {
    const factoryArgs: Array<Record<string, unknown>> = [];
    const factory = vi.fn(async (args) => {
      factoryArgs.push(args);
      return buildFakeHandle();
    });
    const originalDev = process.env[APP_BRIDGE_DEV_MODE_ENV];
    process.env[APP_BRIDGE_DEV_MODE_ENV] = 'true';
    try {
      const manager = createAppBridgeManager({
        platformConfig: buildPlatformConfig('desktop'),
        errorReporter: buildErrorReporter(),
        createBridge: factory,
      });
      await manager.start();
      expect(factoryArgs[0]?.devMode).toBe(true);
    } finally {
      if (originalDev === undefined) delete process.env[APP_BRIDGE_DEV_MODE_ENV];
      else process.env[APP_BRIDGE_DEV_MODE_ENV] = originalDev;
    }
  });

  it('warns (but still starts) when the allowlist is empty AND devMode is off', async () => {
    const factory = vi.fn(async () => buildFakeHandle());
    const errorReporter = buildErrorReporter();
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter,
      createBridge: factory,
      resolveAllowedExtensionIds: () => [],
      readDevMode: () => false,
    });
    await manager.start();
    expect(manager.isRunning()).toBe(true);
  });

  // --- A3 — startPairing direct call --------------------------------------

  it('startPairing mints a code via the in-process PairingStore (A3)', async () => {
    const pairingStore = new PairingStore();
    const connectionManager = new ConnectionManager();
    const factory = vi.fn(async () => {
      const handle = buildFakeHandle();
      return {
        ...handle,
        pairingStore,
        connectionManager,
      } as unknown as AppBridgeHandle;
    });
    const errorReporter = buildErrorReporter();
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter,
      createBridge: factory,
    });
    await manager.start();

    const session = manager.startPairing('browser-extension');
    expect(session.code).toMatch(/^\d{6}$/);
    expect(session.expiresInSeconds).toBeGreaterThan(0);
    // Breadcrumb must fire so Sentry sees the pair-start path.
    const breadcrumb = errorReporter.breadcrumbs.find((b) => b.message === 'pair-start');
    expect(breadcrumb?.data).toMatchObject({ appId: 'browser-extension' });
  });

  it('startPairing throws when the bridge is not running', () => {
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: vi.fn(),
    });
    expect(() => manager.startPairing('browser-extension')).toThrow();
  });

  it('startPairing rejects an invalid appId', async () => {
    const pairingStore = new PairingStore();
    const connectionManager = new ConnectionManager();
    const factory = vi.fn(async () =>
      ({
        ...buildFakeHandle(),
        pairingStore,
        connectionManager,
      }) as unknown as AppBridgeHandle,
    );
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });
    await manager.start();
    expect(() => manager.startPairing('')).toThrow(/valid appId/);
  });

  it('startPairing with browser metadata returns a pairSessionId and tracks the active session', async () => {
    const pairingStore = new PairingStore();
    const factory = vi.fn(async () =>
      ({
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      }) as unknown as AppBridgeHandle,
    );
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });
    await manager.start();

    const session = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'chrome',
    });

    expect(session.code).toMatch(/^\d{6}$/);
    expect(session.pairSessionId).toBeTruthy();
    expect(manager.getActivePairSessions()).toEqual([
      { pairSessionId: session.pairSessionId, browserId: 'chrome' },
    ]);
  });

  it('startPairing legacy string form stays backward-compatible and omits pairSessionId', async () => {
    const pairingStore = new PairingStore();
    const factory = vi.fn(async () =>
      ({
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      }) as unknown as AppBridgeHandle,
    );
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });
    await manager.start();

    const session = manager.startPairing('browser-extension');

    expect(session.code).toMatch(/^\d{6}$/);
    expect('pairSessionId' in session).toBe(false);
    expect(manager.getActivePairSessions()).toEqual([]);
  });

  it('endPairSession clears pending approvals bound to that install session', async () => {
    let capturedOptions: AppBridgeOptions | undefined;
    const pairingStore = new PairingStore();
    const factory = vi.fn(async (options: AppBridgeOptions) => {
      capturedOptions = options;
      return ({
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      }) as unknown as AppBridgeHandle;
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      previewMode: true,
    });
    await manager.start();

    const session = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'chrome',
    });
    const pendingApproval = capturedOptions?.onUnknownExtensionOrigin?.(
      'abcdefghijklmnopabcdefghijklmnop',
    );
    expect(manager.listPendingApprovals(session.pairSessionId)).toHaveLength(1);

    manager.endPairSession(session.pairSessionId, {
      stage: 'test',
      reason: 'cleanup',
    });

    await expect(pendingApproval).resolves.toBe(false);
    expect(manager.listPendingApprovals(session.pairSessionId)).toEqual([]);
    expect(manager.getActivePairSessions()).toEqual([]);
  });

  it('resetInstall revokes only the requested pair session and closes matching live connections', async () => {
    const pairingStore = new PairingStore();
    const tokenStore = pairingStore.getTokenStore();
    const connectionManager = new ConnectionManager();
    const socket = {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      send: vi.fn((_data: string, callback?: () => void) => {
        callback?.();
      }),
    } as unknown as WebSocket;
    const factory = vi.fn(async () =>
      ({
        ...buildFakeHandle(),
        pairingStore,
        tokenStore,
        connectionManager,
      }) as unknown as AppBridgeHandle,
    );
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });
    await manager.start();

    const chromeSession = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'chrome',
    });
    const edgeSession = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'edge',
    });

    tokenStore.issueAppToken(
      'browser-extension',
      'client-a',
      null,
      'abcdefghijklmnopabcdefghijklmnop',
      chromeSession.pairSessionId,
    );
    tokenStore.issueAppToken(
      'browser-extension',
      'client-b',
      null,
      'ponmlkjihgfedcbaponmlkjihgfedcba',
      edgeSession.pairSessionId,
    );
    connectionManager.register({
      socket,
      appId: 'browser-extension',
      clientId: 'client-a',
      protocolVersion: '1.0',
      capabilities: [],
    });

    await expect(
      manager.resetInstall({ pairSessionId: chromeSession.pairSessionId }),
    ).resolves.toEqual({
      ok: true,
      reason: 'ok',
      retryable: false,
      data: { revoked: 1, idsRemoved: 0 },
    });
    expect(manager.listPairedClients()).toEqual([
      expect.objectContaining({
        clientId: 'client-b',
        pairSessionId: edgeSession.pairSessionId,
      }),
    ]);
    expect(manager.checkPairStatus(chromeSession.pairSessionId)).toEqual({
      paired: [],
      hasPending: false,
      pairSessionExpired: true,
      pairSessionNotFound: false,
    });
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'session-ended',
        pairSessionId: chromeSession.pairSessionId,
      }),
      expect.any(Function),
    );
    expect(socket.close).toHaveBeenCalledWith(4001, 'session-ended');
  });

  it('resetInstall succeeds for an expired session and still cleans up tokens and trust ids', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00.000Z'));
    const userDataPath = mkdtempSync(join(tmpdir(), 'rebel-app-bridge-manager-test-'));
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    try {
      let capturedOptions: AppBridgeOptions | undefined;
      const pairingStore = new PairingStore();
      const tokenStore = pairingStore.getTokenStore();
      const factory = vi.fn(async (options: AppBridgeOptions) => {
        capturedOptions = options;
        return ({
          ...buildFakeHandle(),
          pairingStore,
          tokenStore,
          connectionManager: new ConnectionManager(),
        }) as unknown as AppBridgeHandle;
      });
      const manager = createAppBridgeManager({
        platformConfig: buildPlatformConfigWithUserData('desktop', userDataPath),
        errorReporter: buildErrorReporter(),
        createBridge: factory,
        previewMode: true,
      });
      await manager.start();

      const session = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });
      const pendingPromise = capturedOptions?.onUnknownExtensionOrigin?.(extensionId);
      const [pending] = manager.listPendingApprovals(session.pairSessionId);
      expect(
        manager.approvePendingApproval({
          pendingApprovalId: pending.pendingApprovalId,
          approved: true,
          fingerprint: pending.fingerprint,
          pairSessionId: session.pairSessionId,
        }),
      ).toEqual({ ok: true });
      await expect(pendingPromise).resolves.toBe(true);
      mkdirSync(join(userDataPath, 'mcp', 'rebel-app-bridge'), { recursive: true });
      writeFileSync(
        join(userDataPath, 'mcp', 'rebel-app-bridge', 'dev-extension-ids.json'),
        JSON.stringify([extensionId], null, 2),
      );

      tokenStore.issueAppToken(
        'browser-extension',
        'client-a',
        null,
        extensionId,
        session.pairSessionId,
      );

      // Jump past the pair-code TTL (10min) so the session is fully expired
      // by the time resetInstall runs — this is the scenario the test name
      // encodes.
      vi.setSystemTime(new Date('2026-04-20T12:10:31.000Z'));

      await expect(
        manager.resetInstall({ pairSessionId: session.pairSessionId }),
      ).resolves.toEqual({
        ok: true,
        reason: 'ok',
        retryable: false,
        data: { revoked: 1, idsRemoved: 1 },
      });
      expect(
        tokenStore
          .listPersistedAppTokens()
          .filter((entry) => entry.pairSessionId === session.pairSessionId),
      ).toEqual([]);
      expect(
        JSON.parse(
          readFileSync(
            join(userDataPath, 'mcp', 'rebel-app-bridge', 'dev-extension-ids.json'),
            'utf8',
          ),
        ),
      ).toEqual([]);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('resetInstall preserves shared extension ids until the last referencing session is reset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00.000Z'));
    const userDataPath = mkdtempSync(join(tmpdir(), 'rebel-app-bridge-manager-test-'));
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    try {
      let capturedOptions: AppBridgeOptions | undefined;
      const pairingStore = new PairingStore();
      const factory = vi.fn(async (options: AppBridgeOptions) => {
        capturedOptions = options;
        return ({
          ...buildFakeHandle(),
          pairingStore,
          tokenStore: pairingStore.getTokenStore(),
          connectionManager: new ConnectionManager(),
        }) as unknown as AppBridgeHandle;
      });
      const manager = createAppBridgeManager({
        platformConfig: buildPlatformConfigWithUserData('desktop', userDataPath),
        errorReporter: buildErrorReporter(),
        createBridge: factory,
        previewMode: true,
      });
      await manager.start();

      const sessionA = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });
      const pendingPromiseA = capturedOptions?.onUnknownExtensionOrigin?.(extensionId);
      const [pendingA] = manager.listPendingApprovals(sessionA.pairSessionId);
      expect(
        manager.approvePendingApproval({
          pendingApprovalId: pendingA.pendingApprovalId,
          approved: true,
          fingerprint: pendingA.fingerprint,
          pairSessionId: sessionA.pairSessionId,
        }),
      ).toEqual({ ok: true });
      await expect(pendingPromiseA).resolves.toBe(true);
      mkdirSync(join(userDataPath, 'mcp', 'rebel-app-bridge'), { recursive: true });
      writeFileSync(
        join(userDataPath, 'mcp', 'rebel-app-bridge', 'dev-extension-ids.json'),
        JSON.stringify([extensionId], null, 2),
      );

      // Jump past the pair-code TTL (10min) so sessionA's pair session is no
      // longer "live" when sessionB starts — this keeps the test focused on
      // shared extension-id handoff rather than multi-session TOFU inference.
      vi.setSystemTime(new Date('2026-04-20T12:10:31.000Z'));

      const sessionB = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });
      const pendingPromiseB = capturedOptions?.onUnknownExtensionOrigin?.(extensionId);
      const [pendingB] = manager.listPendingApprovals(sessionB.pairSessionId);
      expect(
        manager.approvePendingApproval({
          pendingApprovalId: pendingB.pendingApprovalId,
          approved: true,
          fingerprint: pendingB.fingerprint,
          pairSessionId: sessionB.pairSessionId,
        }),
      ).toEqual({ ok: true });
      await expect(pendingPromiseB).resolves.toBe(true);

      await expect(
        manager.resetInstall({ pairSessionId: sessionA.pairSessionId }),
      ).resolves.toMatchObject({
        ok: true,
        data: { idsRemoved: 0 },
      });
      expect(
        JSON.parse(
          readFileSync(
            join(userDataPath, 'mcp', 'rebel-app-bridge', 'dev-extension-ids.json'),
            'utf8',
          ),
        ),
      ).toEqual([extensionId]);

      await expect(
        manager.resetInstall({ pairSessionId: sessionB.pairSessionId }),
      ).resolves.toMatchObject({
        ok: true,
        data: { idsRemoved: 1 },
      });
      expect(
        JSON.parse(
          readFileSync(
            join(userDataPath, 'mcp', 'rebel-app-bridge', 'dev-extension-ids.json'),
            'utf8',
          ),
        ),
      ).toEqual([]);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('resetInstall returns reset-partial-failure when trust-id cleanup cannot be written', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'rebel-app-bridge-manager-test-'));
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    try {
      let capturedOptions: AppBridgeOptions | undefined;
      const pairingStore = new PairingStore();
      const factory = vi.fn(async (options: AppBridgeOptions) => {
        capturedOptions = options;
        return ({
          ...buildFakeHandle(),
          pairingStore,
          tokenStore: pairingStore.getTokenStore(),
          connectionManager: new ConnectionManager(),
        }) as unknown as AppBridgeHandle;
      });
      const manager = createAppBridgeManager({
        platformConfig: buildPlatformConfigWithUserData('desktop', userDataPath),
        errorReporter: buildErrorReporter(),
        createBridge: factory,
        previewMode: true,
      });
      await manager.start();

      const session = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });
      const pendingPromise = capturedOptions?.onUnknownExtensionOrigin?.(extensionId);
      const [pending] = manager.listPendingApprovals(session.pairSessionId);
      expect(
        manager.approvePendingApproval({
          pendingApprovalId: pending.pendingApprovalId,
          approved: true,
          fingerprint: pending.fingerprint,
          pairSessionId: session.pairSessionId,
        }),
      ).toEqual({ ok: true });
      await expect(pendingPromise).resolves.toBe(true);

      const stateDirectory = join(userDataPath, 'mcp', 'rebel-app-bridge');
      rmSync(stateDirectory, { recursive: true, force: true });
      mkdirSync(join(userDataPath, 'mcp'), { recursive: true });
      writeFileSync(stateDirectory, 'blocked');

      await expect(
        manager.resetInstall({ pairSessionId: session.pairSessionId }),
      ).resolves.toEqual({
        ok: false,
        reason: 'reset-partial-failure',
        retryable: true,
        data: {
          revoked: 0,
          idsRemoved: 0,
          degraded: true,
        },
      });
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it(
    'resetInstall forgets extension ids persisted via onClaimPersistTrust ' +
      '(new claim-path trust persistence — S2 coverage)',
    async () => {
      // Regression guard for the reviewer-flagged S2 gap: the
      // `rememberTrustedExtensionIdForPairSession` path is how first
      // installs now establish trust (replaces the TOFU-approved path
      // for the install flow). We must prove `resetInstall` actually
      // removes the extension id from `dev-extension-ids.json` when it
      // was added via this code path — without this, a user-initiated
      // "Reset install" would silently keep the extension trusted.
      const userDataPath = mkdtempSync(join(tmpdir(), 'rebel-app-bridge-manager-test-'));
      const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
      try {
        let capturedOptions: AppBridgeOptions | undefined;
        const pairingStore = new PairingStore();
        const factory = vi.fn(async (options: AppBridgeOptions) => {
          capturedOptions = options;
          return ({
            ...buildFakeHandle(),
            pairingStore,
            tokenStore: pairingStore.getTokenStore(),
            connectionManager: new ConnectionManager(),
          }) as unknown as AppBridgeHandle;
        });
        const manager = createAppBridgeManager({
          platformConfig: buildPlatformConfigWithUserData('desktop', userDataPath),
          errorReporter: buildErrorReporter(),
          createBridge: factory,
          previewMode: true,
        });
        await manager.start();

        const session = manager.startPairing({
          appId: 'browser-extension',
          browserId: 'chrome',
        });

        // Simulate a successful `/pair/claim` from an unknown chrome
        // extension in preview mode — the bridge calls
        // `onClaimPersistTrust` fire-and-forget. The manager wires that
        // to `rememberTrustedExtensionIdForPairSession`, which writes
        // the ID into `dev-extension-ids.json` and binds it to the
        // pair session.
        capturedOptions?.onClaimPersistTrust?.({
          pairSessionId: session.pairSessionId,
          extensionId,
        });

        // Sanity: the trust file contains the ID after the claim-path
        // callback runs.
        expect(
          JSON.parse(
            readFileSync(
              join(userDataPath, 'mcp', 'rebel-app-bridge', 'dev-extension-ids.json'),
              'utf8',
            ),
          ),
        ).toEqual([extensionId]);

        const result = await manager.resetInstall({
          pairSessionId: session.pairSessionId,
        });

        expect(result).toMatchObject({
          ok: true,
          reason: 'ok',
          data: { idsRemoved: 1 },
        });
        // The trust file must no longer contain the ID — that's the
        // invariant reviewer 2 asked us to pin. `resetInstall` routes
        // through `forgetTrustedExtensionIds` under the hood; this test
        // proves the session-scoped binding from the claim path is
        // discoverable by the reset path.
        expect(
          JSON.parse(
            readFileSync(
              join(userDataPath, 'mcp', 'rebel-app-bridge', 'dev-extension-ids.json'),
              'utf8',
            ),
          ),
        ).toEqual([]);
      } finally {
        rmSync(userDataPath, { recursive: true, force: true });
      }
    },
  );

  it(
    'rememberTrustedExtensionIdForPairSession flips trustPersistenceDegraded ' +
      'when the disk write fails (M1 — mirrors TOFU-approved path semantics)',
    async () => {
      // Regression guard for the reviewer-flagged M1 issue: the
      // original TOFU-approved path flipped `trustPersistenceDegraded`
      // via `onTrustPersistenceFailure` when the trust-file write
      // failed, which surfaces in `getGlobalPairStatus().degraded`
      // and drives the renderer's "saved for this session only"
      // banner. The new claim-path callback must preserve the same
      // user-visible degraded signal — silently logging the failure
      // would be a "silent failure is a bug" regression.
      const userDataPath = mkdtempSync(join(tmpdir(), 'rebel-app-bridge-manager-test-'));
      const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
      try {
        let capturedOptions: AppBridgeOptions | undefined;
        const pairingStore = new PairingStore();
        const factory = vi.fn(async (options: AppBridgeOptions) => {
          capturedOptions = options;
          return ({
            ...buildFakeHandle(),
            pairingStore,
            tokenStore: pairingStore.getTokenStore(),
            connectionManager: new ConnectionManager(),
          }) as unknown as AppBridgeHandle;
        });
        const manager = createAppBridgeManager({
          platformConfig: buildPlatformConfigWithUserData('desktop', userDataPath),
          errorReporter: buildErrorReporter(),
          createBridge: factory,
          previewMode: true,
        });
        await manager.start();

        const session = manager.startPairing({
          appId: 'browser-extension',
          browserId: 'chrome',
        });

        // Force the state directory into a state where both mkdir and
        // writeFile must fail — place a regular file at the directory
        // path so `mkdirSync` / `writeFileSync` reject. This mirrors
        // the "disk is full / permissions revoked / path stomped"
        // failure mode the TOFU path already handles.
        const stateDirectory = join(userDataPath, 'mcp', 'rebel-app-bridge');
        mkdirSync(join(userDataPath, 'mcp'), { recursive: true });
        writeFileSync(stateDirectory, 'blocked');

        // Sanity: degraded flag starts clear.
        expect(manager.getGlobalPairStatus().degraded).toBeUndefined();

        capturedOptions?.onClaimPersistTrust?.({
          pairSessionId: session.pairSessionId,
          extensionId,
        });

        // The M1 invariant: the claim-path write failure MUST surface
        // through `getGlobalPairStatus()` so the renderer's banner
        // fires, exactly like the TOFU path already did.
        expect(manager.getGlobalPairStatus().degraded).toBe('trust-persist-failed');
      } finally {
        rmSync(userDataPath, { recursive: true, force: true });
      }
    },
  );

  it('surfaces trust-persist degradation in the global pair status', async () => {
    let capturedOptions: AppBridgeOptions | undefined;
    const pairingStore = new PairingStore();
    const factory = vi.fn(async (options: AppBridgeOptions) => {
      capturedOptions = options;
      return ({
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      }) as unknown as AppBridgeHandle;
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      previewMode: true,
    });
    await manager.start();

    expect(manager.getGlobalPairStatus()).toEqual({
      paired: [],
      hasPending: false,
      activeSessionCount: 0,
    });

    capturedOptions?.onTrustPersistenceFailure?.({
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      stateDirectory: '/tmp/rebel-app-bridge-manager-test',
    });

    expect(manager.getGlobalPairStatus()).toEqual({
      paired: [],
      hasPending: false,
      activeSessionCount: 0,
      degraded: 'trust-persist-failed',
    });
  });

  it('keys diagnose cooldowns by browserId instead of pairSessionId', async () => {
    let hostDiagnose:
      | ((args: { browserId: string; pairSessionId?: string }) => Promise<unknown>)
      | undefined;
    const installerService = {
      setDiagnoseContext: vi.fn(),
      detectBrowsers: vi.fn(),
      extractExtensionFolder: vi.fn(),
      revealExtensionFolder: vi.fn(),
      openBrowserExtensionsPage: vi.fn(),
      diagnose: vi.fn().mockResolvedValue({
        browserRunning: true,
        extensionExtracted: false,
        recentInstallBreadcrumbCount: 0,
        recentInstallFailureCount: 0,
        lastFailureReason: null,
        bridgeReachable: true,
        pairSessionActive: true,
      }),
    } as const;
    const factory = vi.fn(async (args: AppBridgeOptions) => {
      hostDiagnose = args.hostHandlers?.diagnose;
      return buildFakeHandle();
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      installerService: installerService as unknown as AppBridgeInstallerService,
    });
    await manager.start();

    expect(hostDiagnose).toBeTypeOf('function');

    const first = await hostDiagnose!({ browserId: 'chrome', pairSessionId: 'pair-1' });
    const second = await hostDiagnose!({ browserId: 'chrome', pairSessionId: 'pair-2' });

    expect(first).toMatchObject({ ok: true, reason: 'ok' });
    expect(second).toMatchObject({
      ok: false,
      reason: 'cooldown-active',
      retryable: true,
    });
    expect(installerService.diagnose).toHaveBeenCalledTimes(1);
  });

  it('registers prepare-install sessions for reopen/status reconciliation', async () => {
    let hostPrepareInstall:
      | ((browserId?: string) => Promise<unknown>)
      | undefined;
    const installerService = {
      setDiagnoseContext: vi.fn(),
      prepareInstall: vi.fn().mockResolvedValue({
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {
          attemptId: 'install-attempt-1',
          setupStatus: 'awaiting_user_handoff',
          selectedBrowser: { id: 'chrome', displayName: 'Google Chrome' },
          pairSessionId: 'inst_prepare_1',
          nextStep: 'Load the revealed extension folder.',
          steps: [],
        },
      }),
      extractExtensionFolder: vi.fn(),
      revealExtensionFolder: vi.fn(),
      openBrowserExtensionsPage: vi.fn(),
      diagnose: vi.fn(),
    } as const;
    const pairingStore = new PairingStore();
    const factory = vi.fn(async (args: AppBridgeOptions) => {
      hostPrepareInstall = args.hostHandlers?.prepareInstall;
      return {
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      } as unknown as AppBridgeHandle;
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      installerService: installerService as unknown as AppBridgeInstallerService,
    });
    await manager.start();

    expect(hostPrepareInstall).toBeTypeOf('function');
    const prepareResult = await hostPrepareInstall!('chrome') as {
      ok: boolean;
      data?: { pairSessionId?: string };
    };
    expect(prepareResult).toMatchObject({
      ok: true,
      data: { pairSessionId: expect.stringMatching(/^install_alias_/) },
    });
    const installSessionAlias = prepareResult.data?.pairSessionId ?? '';
    expect(installSessionAlias).not.toBe('inst_prepare_1');

    expect(manager.checkPairStatus(installSessionAlias)).toEqual({
      paired: [],
      hasPending: false,
      pairSessionExpired: false,
      pairSessionNotFound: false,
    });
    expect(manager.getActivePairSessions()).toEqual([
      {
        browserId: 'chrome',
        pairSessionId: 'inst_prepare_1',
      },
    ]);
    const diagnoseContext = vi.mocked(installerService.setDiagnoseContext).mock.calls[0]?.[0];
    expect(diagnoseContext?.hasActiveInstallSession?.('inst_prepare_1')).toBe(true);
  });

  it('listPendingApprovals(pairSessionId) scopes results to the stamped browser session', async () => {
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const pairingStore = new PairingStore();
    let onUnknownExtensionOrigin!: (extensionId: string) => Promise<boolean>;
    const factory = vi.fn(async (args: AppBridgeOptions) => {
      onUnknownExtensionOrigin = args.onUnknownExtensionOrigin as (
        extensionId: string,
      ) => Promise<boolean>;
      return {
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      } as unknown as AppBridgeHandle;
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      previewMode: true,
    });
    await manager.start();

    const chromeSession = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'chrome',
    });
    const pendingPromise = onUnknownExtensionOrigin(extensionId);

    const pendingForChrome = manager.listPendingApprovals(chromeSession.pairSessionId);
    expect(pendingForChrome).toHaveLength(1);
    expect(pendingForChrome[0]).toMatchObject({
      extensionId: 'abcdefgh-ijklmnop-abcdefgh-ijklmnop',
      inferredBrowserId: 'chrome',
    });

    const braveSession = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'brave',
    });
    expect(manager.listPendingApprovals(braveSession.pairSessionId)).toEqual([]);

    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pendingForChrome[0].pendingApprovalId,
        approved: false,
        fingerprint: 'abcdefgh-ijklmnop-abcdefgh-ijklmnop',
        pairSessionId: chromeSession.pairSessionId,
      }),
    ).toEqual({ ok: true });
    await expect(pendingPromise).resolves.toBe(false);
  });

  it('does not leak unstamped pending approvals into a later scoped session', async () => {
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const pairingStore = new PairingStore();
    let onUnknownExtensionOrigin!: (extensionId: string) => Promise<boolean>;
    const factory = vi.fn(async (args: AppBridgeOptions) => {
      onUnknownExtensionOrigin = args.onUnknownExtensionOrigin as (
        extensionId: string,
      ) => Promise<boolean>;
      return {
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      } as unknown as AppBridgeHandle;
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      previewMode: true,
    });
    await manager.start();

    const pendingPromise = onUnknownExtensionOrigin(extensionId);
    expect(manager.listPendingApprovals()).toHaveLength(1);

    const session = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'chrome',
    });
    expect(manager.listPendingApprovals(session.pairSessionId)).toEqual([]);

    const [pending] = manager.listPendingApprovals();
    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pending.pendingApprovalId,
        approved: false,
        fingerprint: pending.fingerprint,
        pairSessionId: LEGACY_SETTINGS_SESSION_ID,
      }),
    ).toEqual({ ok: false, reason: 'session-unbound' });

    void pendingPromise;
  });

  it('checkPairStatus(pairSessionId) only returns tokens stamped to that session when installs overlap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00.000Z'));
    try {
      const pairingStore = new PairingStore();
      const connectionManager = new ConnectionManager();

      const factory = vi.fn(async () =>
        ({
          ...buildFakeHandle(),
          pairingStore,
          tokenStore: pairingStore.getTokenStore(),
          connectionManager,
        }) as unknown as AppBridgeHandle,
      );
      const manager = createAppBridgeManager({
        platformConfig: buildPlatformConfig('desktop'),
        errorReporter: buildErrorReporter(),
        createBridge: factory,
      });
      await manager.start();

      const chromeSession = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const edgeSession = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'edge',
      });

      expect(pairingStore.claim(chromeSession.code, { clientId: 'client-chrome' }).ok).toBe(true);

      expect(manager.checkPairStatus(chromeSession.pairSessionId)).toEqual({
        paired: [{ appId: 'browser-extension', clientId: 'client-chrome' }],
        hasPending: false,
        pairSessionExpired: false,
        pairSessionNotFound: false,
      });
      expect(manager.checkPairStatus(edgeSession.pairSessionId)).toEqual({
        paired: [],
        hasPending: false,
        pairSessionExpired: false,
        pairSessionNotFound: false,
      });
      expect(
        manager.listPairedClients().find((entry) => entry.clientId === 'client-chrome')
          ?.pairSessionId,
      ).toBe(chromeSession.pairSessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkPairStatus(pairSessionId) reports expiry after the 10.5min session TTL sweep', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00.000Z'));
    try {
      const pairingStore = new PairingStore();
      const factory = vi.fn(async () =>
        ({
          ...buildFakeHandle(),
          pairingStore,
          tokenStore: pairingStore.getTokenStore(),
          connectionManager: new ConnectionManager(),
        }) as unknown as AppBridgeHandle,
      );
      const manager = createAppBridgeManager({
        platformConfig: buildPlatformConfig('desktop'),
        errorReporter: buildErrorReporter(),
        createBridge: factory,
      });
      await manager.start();

      const session = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });
      expect(manager.getActivePairSessions()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10 * 60_000 + 30_000);

      expect(manager.getActivePairSessions()).toEqual([]);
      expect(manager.checkPairStatus(session.pairSessionId)).toEqual({
        paired: [],
        hasPending: false,
        pairSessionExpired: true,
        pairSessionNotFound: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkPairStatus(unknownId) returns pairSessionNotFound: true, distinct from expired', async () => {
    const pairingStore = new PairingStore();
    const factory = vi.fn(async () =>
      ({
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      }) as unknown as AppBridgeHandle,
    );
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });
    await manager.start();

    // Never issued by this bridge → not-found
    const hallucinated = 'ps-hallucinated-never-existed';
    expect(manager.checkPairStatus(hallucinated)).toEqual({
      paired: [],
      hasPending: false,
      pairSessionExpired: false,
      pairSessionNotFound: true,
    });

    // After an explicit end, the same ID becomes "expired"-class
    const session = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'chrome',
    });
    manager.endPairSession(session.pairSessionId);
    expect(manager.checkPairStatus(session.pairSessionId)).toEqual({
      paired: [],
      hasPending: false,
      pairSessionExpired: true,
      pairSessionNotFound: false,
    });
  });

  it('getExtensionVersionStatus reads live extension versions and ignores protocol-only registrations', async () => {
    const connectionManager = new ConnectionManager();
    const pairingStore = new PairingStore();
    const socket = {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      terminate: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;
    const factory = vi.fn(async () =>
      ({
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager,
      }) as unknown as AppBridgeHandle,
    );
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });
    await manager.start();

    connectionManager.register({
      socket,
      appId: 'browser-extension',
      clientId: 'client-abc',
      protocolVersion: '1.0',
      version: '1.0',
      capabilities: [],
    });
    expect(manager.getExtensionVersionStatus('0.1.0')).toEqual({
      currentVersion: null,
      latestVersion: '0.1.0',
    });

    connectionManager.register({
      socket,
      appId: 'browser-extension',
      clientId: 'client-abc',
      protocolVersion: '1.0',
      version: '0.0.9',
      capabilities: [],
    });
    expect(manager.getExtensionVersionStatus('0.1.0')).toEqual({
      currentVersion: '0.0.9',
      latestVersion: '0.1.0',
    });
  });

  it('expires pending approvals after the 120s TTL sweep', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00.000Z'));
    try {
      const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
      const pairingStore = new PairingStore();
      let onUnknownExtensionOrigin!: (extensionId: string) => Promise<boolean>;
      const errorReporter = buildErrorReporter();
      const factory = vi.fn(async (args: AppBridgeOptions) => {
        onUnknownExtensionOrigin = args.onUnknownExtensionOrigin as (
          extensionId: string,
        ) => Promise<boolean>;
        return {
          ...buildFakeHandle(),
          pairingStore,
          tokenStore: pairingStore.getTokenStore(),
          connectionManager: new ConnectionManager(),
        } as unknown as AppBridgeHandle;
      });
      const manager = createAppBridgeManager({
        platformConfig: buildPlatformConfig('desktop'),
        errorReporter,
        createBridge: factory,
        previewMode: true,
      });
      await manager.start();

      const pendingPromise = onUnknownExtensionOrigin(extensionId);
      expect(manager.listPendingApprovals()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(120_000);

      await expect(pendingPromise).resolves.toBe(false);
      expect(manager.listPendingApprovals()).toEqual([]);
      expect(errorReporter.breadcrumbs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: 'app-bridge.tofu.expired' }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('approvePendingApproval rejects the connection without pairing a client when approved=false', async () => {
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const pairingStore = new PairingStore();
    let onUnknownExtensionOrigin!: (extensionId: string) => Promise<boolean>;
    const factory = vi.fn(async (args: AppBridgeOptions) => {
      onUnknownExtensionOrigin = args.onUnknownExtensionOrigin as (
        extensionId: string,
      ) => Promise<boolean>;
      return {
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      } as unknown as AppBridgeHandle;
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      previewMode: true,
    });
    await manager.start();

    const session = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'chrome',
    });
    const pendingPromise = onUnknownExtensionOrigin(extensionId);
    const [pending] = manager.listPendingApprovals(session.pairSessionId);

    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pending.pendingApprovalId,
        approved: false,
        fingerprint: 'abcdefgh-ijklmnop-abcdefgh-ijklmnop',
        pairSessionId: session.pairSessionId,
      }),
    ).toEqual({ ok: true });

    await expect(pendingPromise).resolves.toBe(false);
    expect(manager.listPendingApprovals()).toEqual([]);
    expect(manager.listPairedClients()).toEqual([]);
  });

  it('approvePendingApproval rejects mismatched fingerprints', async () => {
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const pairingStore = new PairingStore();
    let onUnknownExtensionOrigin!: (extensionId: string) => Promise<boolean>;
    const factory = vi.fn(async (args: AppBridgeOptions) => {
      onUnknownExtensionOrigin = args.onUnknownExtensionOrigin as (
        extensionId: string,
      ) => Promise<boolean>;
      return {
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      } as unknown as AppBridgeHandle;
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      previewMode: true,
    });
    await manager.start();

    const session = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'chrome',
    });
    const pendingPromise = onUnknownExtensionOrigin(extensionId);
    const [pending] = manager.listPendingApprovals(session.pairSessionId);

    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pending.pendingApprovalId,
        approved: true,
        fingerprint: 'deadbeef-deadbeef-deadbeef-deadbeef',
        pairSessionId: session.pairSessionId,
      }),
    ).toEqual({ ok: false, reason: 'fingerprint-mismatch' });

    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pending.pendingApprovalId,
        approved: false,
        fingerprint: pending.fingerprint,
        pairSessionId: session.pairSessionId,
      }),
    ).toEqual({ ok: true });
    await expect(pendingPromise).resolves.toBe(false);
  });

  it('approvePendingApproval rejects requests that omit the fingerprint', async () => {
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const pairingStore = new PairingStore();
    let onUnknownExtensionOrigin!: (extensionId: string) => Promise<boolean>;
    const factory = vi.fn(async (args: AppBridgeOptions) => {
      onUnknownExtensionOrigin = args.onUnknownExtensionOrigin as (
        extensionId: string,
      ) => Promise<boolean>;
      return {
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      } as unknown as AppBridgeHandle;
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      previewMode: true,
    });
    await manager.start();

    const session = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'chrome',
    });
    const pendingPromise = onUnknownExtensionOrigin(extensionId);
    const [pending] = manager.listPendingApprovals(session.pairSessionId);

    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pending.pendingApprovalId,
        approved: true,
        fingerprint: undefined as unknown as string,
        pairSessionId: session.pairSessionId,
      }),
    ).toEqual({ ok: false, reason: 'fingerprint-mismatch' });

    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pending.pendingApprovalId,
        approved: false,
        fingerprint: pending.fingerprint,
        pairSessionId: session.pairSessionId,
      }),
    ).toEqual({ ok: true });
    await expect(pendingPromise).resolves.toBe(false);
  });

  it('approvePendingApproval rejects mismatched pair sessions', async () => {
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const pairingStore = new PairingStore();
    let onUnknownExtensionOrigin!: (extensionId: string) => Promise<boolean>;
    const factory = vi.fn(async (args: AppBridgeOptions) => {
      onUnknownExtensionOrigin = args.onUnknownExtensionOrigin as (
        extensionId: string,
      ) => Promise<boolean>;
      return {
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      } as unknown as AppBridgeHandle;
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      previewMode: true,
    });
    await manager.start();

    const chromeSession = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'chrome',
    });
    const pendingPromise = onUnknownExtensionOrigin(extensionId);
    const [pending] = manager.listPendingApprovals(chromeSession.pairSessionId);
    const braveSession = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'brave',
    });

    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pending.pendingApprovalId,
        approved: true,
        fingerprint: 'abcdefgh-ijklmnop-abcdefgh-ijklmnop',
        pairSessionId: braveSession.pairSessionId,
      }),
    ).toEqual({ ok: false, reason: 'session-mismatch' });

    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pending.pendingApprovalId,
        approved: false,
        fingerprint: pending.fingerprint,
        pairSessionId: chromeSession.pairSessionId,
      }),
    ).toEqual({ ok: true });
    await expect(pendingPromise).resolves.toBe(false);
  });

  it('approvePendingApproval accepts the legacy settings sentinel while still enforcing fingerprints', async () => {
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const pairingStore = new PairingStore();
    let onUnknownExtensionOrigin!: (extensionId: string) => Promise<boolean>;
    const factory = vi.fn(async (args: AppBridgeOptions) => {
      onUnknownExtensionOrigin = args.onUnknownExtensionOrigin as (
        extensionId: string,
      ) => Promise<boolean>;
      return {
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      } as unknown as AppBridgeHandle;
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      previewMode: true,
    });
    await manager.start();

    const chromeSession = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'chrome',
    });
    const pendingPromise = onUnknownExtensionOrigin(extensionId);
    const [pending] = manager.listPendingApprovals(chromeSession.pairSessionId);

    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pending.pendingApprovalId,
        approved: true,
        fingerprint: 'deadbeef-deadbeef-deadbeef-deadbeef',
        pairSessionId: LEGACY_SETTINGS_SESSION_ID,
      }),
    ).toEqual({ ok: false, reason: 'fingerprint-mismatch' });

    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pending.pendingApprovalId,
        approved: false,
        fingerprint: pending.fingerprint,
        pairSessionId: LEGACY_SETTINGS_SESSION_ID,
      }),
    ).toEqual({ ok: true });
    await expect(pendingPromise).resolves.toBe(false);
  });

  it('approvePendingApproval rejects expired or missing pair sessions', async () => {
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const pairingStore = new PairingStore();
    let onUnknownExtensionOrigin!: (extensionId: string) => Promise<boolean>;
    const factory = vi.fn(async (args: AppBridgeOptions) => {
      onUnknownExtensionOrigin = args.onUnknownExtensionOrigin as (
        extensionId: string,
      ) => Promise<boolean>;
      return {
        ...buildFakeHandle(),
        pairingStore,
        tokenStore: pairingStore.getTokenStore(),
        connectionManager: new ConnectionManager(),
      } as unknown as AppBridgeHandle;
    });
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
      previewMode: true,
    });
    await manager.start();

    const session = manager.startPairing({
      appId: 'browser-extension',
      browserId: 'chrome',
    });
    const pendingPromise = onUnknownExtensionOrigin(extensionId);
    const [pending] = manager.listPendingApprovals(session.pairSessionId);

    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pending.pendingApprovalId,
        approved: true,
        fingerprint: 'abcdefgh-ijklmnop-abcdefgh-ijklmnop',
        pairSessionId: 'expired-session-id',
      }),
    ).toEqual({ ok: false, reason: 'session-expired' });

    expect(
      manager.approvePendingApproval({
        pendingApprovalId: pending.pendingApprovalId,
        approved: false,
        fingerprint: pending.fingerprint,
        pairSessionId: session.pairSessionId,
      }),
    ).toEqual({ ok: true });
    await expect(pendingPromise).resolves.toBe(false);
  });

  // --- B1 — revokePairedClient closes live WS ------------------------------

  it('revokePairedClient closes matching live WS with code 4001 (B1)', async () => {
    const pairingStore = new PairingStore();
    const connectionManager = new ConnectionManager();
    // Build a paired client + register a live WS.
    const session = pairingStore.createPendingSession('browser-extension');
    const claim = pairingStore.claim(session.code, { clientId: 'client-abc' });
    if (!claim.ok) throw new Error('pair-claim failed');
    const closeSpy = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      close: closeSpy,
      terminate: () => {},
      send: () => {},
    } as unknown as WebSocket;
    connectionManager.register({
      socket,
      appId: 'browser-extension',
      clientId: 'client-abc',
      protocolVersion: '1.0',
      capabilities: [],
    });

    // Build a fake handle that exposes our prewired pairingStore + CM +
    // a token store that forwards to pairingStore's tokenStore.
    const tokenStore = pairingStore.getTokenStore();
    const factory = vi.fn(async () =>
      ({
        ...buildFakeHandle(),
        pairingStore,
        connectionManager,
        tokenStore,
      }) as unknown as AppBridgeHandle,
    );
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });
    await manager.start();

    const revoked = await manager.revokePairedClient('client-abc');
    expect(revoked).toBe(1);
    expect(closeSpy).toHaveBeenCalledWith(4001, 'revoked');
  });

  it('revokeAllPairedClients closes every live WS (B1)', async () => {
    const pairingStore = new PairingStore();
    const connectionManager = new ConnectionManager();
    const sessionA = pairingStore.createPendingSession('browser-extension');
    pairingStore.claim(sessionA.code, { clientId: 'client-a' });
    const closeA = vi.fn();
    const socketA = {
      readyState: WebSocket.OPEN,
      close: closeA,
      terminate: () => {},
      send: () => {},
    } as unknown as WebSocket;
    connectionManager.register({
      socket: socketA,
      appId: 'browser-extension',
      clientId: 'client-a',
      protocolVersion: '1.0',
      capabilities: [],
    });
    const tokenStore = pairingStore.getTokenStore();
    const factory = vi.fn(async () =>
      ({
        ...buildFakeHandle(),
        pairingStore,
        connectionManager,
        tokenStore,
      }) as unknown as AppBridgeHandle,
    );
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });
    await manager.start();

    await manager.revokeAllPairedClients();
    expect(closeA).toHaveBeenCalledWith(4001, 'revoked');
  });

  describe('trusted host browser-extension mint + revoke helpers', () => {
    async function buildTrustedHostHarness() {
      const userDataPath = mkdtempSync(join(tmpdir(), 'rebel-app-bridge-manager-test-'));
      let mintHandler:
        | ((
            args: {
              appId: string;
              clientId: string;
              extensionId?: string;
              originExtensionId?: string;
              installSessionId?: string;
              fingerprint?: string;
            },
          ) =>
            | { ok: true; token: string }
            | {
                ok: false;
                reason: string;
                status?: number;
                retryAfterMs?: number;
                direction?: 'forward' | 'reverse';
              })
        | undefined;
      const tokenStore = new TokenStore();
      const installerService = {
        setDiagnoseContext: vi.fn(),
        extractExtensionFolder: vi.fn(),
        revealExtensionFolder: vi.fn(),
        openBrowserExtensionsPage: vi.fn(),
        diagnose: vi.fn(),
        regenerateBootTokenFiles: vi.fn().mockResolvedValue({
          ok: true,
          rewritten: 1,
          skipped: 0,
        }),
      };
      const broadcastService = buildBroadcastService();
      const errorReporter = buildErrorReporter();
      const factory = vi.fn(async (options: AppBridgeOptions) => {
        mintHandler = options.hostHandlers?.mintAppTokenForTrustedHost;
        return ({
          ...buildFakeHandle(),
          pairingStore: new PairingStore({ tokenStore }),
          tokenStore,
          connectionManager: new ConnectionManager(),
        }) as unknown as AppBridgeHandle;
      });
      const manager = createAppBridgeManager({
        platformConfig: buildPlatformConfigWithUserData('desktop', userDataPath),
        errorReporter,
        createBridge: factory,
        installerService: installerService as unknown as AppBridgeInstallerService,
        broadcastService,
      });
      await manager.start();
      if (!mintHandler) {
        throw new Error('Expected trusted-host mint handler to be wired.');
      }

      return {
        userDataPath,
        mintHandler,
        tokenStore,
        installerService,
        broadcastService,
        errorReporter,
        manager,
      };
    }

    it('mints browser-extension tokens, persists trust, and broadcasts connected', async () => {
      const harness = await buildTrustedHostHarness();
      try {
        const result = harness.mintHandler({
          appId: 'browser-extension',
          clientId: 'browser-0123456789abcdef',
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          originExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
          installSessionId: 'inst_123456',
          fingerprint: 'fp-1',
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error('Expected trusted-host browser mint to succeed.');
        }
        expect(
          harness.tokenStore.verifyAppToken(result.token, {
            appId: 'browser-extension',
            clientId: 'browser-0123456789abcdef',
            fingerprint: 'fp-1',
          }),
        ).toMatchObject({
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          pairSessionId: 'inst_123456',
        });
        expect(
          harness.tokenStore.lookupExtensionByClientId('browser-0123456789abcdef'),
        ).toBe('abcdefghijklmnopabcdefghijklmnop');
        expect(
          JSON.parse(
            readFileSync(
              join(
                harness.userDataPath,
                'mcp',
                'rebel-app-bridge',
                'dev-extension-ids.json',
              ),
              'utf8',
            ),
          ),
        ).toEqual(['abcdefghijklmnopabcdefghijklmnop']);
        expect(findStatusBroadcasts(harness.broadcastService)).toContainEqual({
          channel: CONNECTOR_STATUS_CHANGED,
          args: [
            expect.objectContaining({
              status: 'connected',
              pairSessionId: 'inst_123456',
            }),
          ],
        });
      } finally {
        rmSync(harness.userDataPath, { recursive: true, force: true });
      }
    });

    it('rejects reverse binding conflicts with direction reverse', async () => {
      const harness = await buildTrustedHostHarness();
      try {
        const first = harness.mintHandler({
          appId: 'browser-extension',
          clientId: 'browser-0123456789abcdef',
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          originExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
          installSessionId: 'inst_123456',
        });
        expect(first.ok).toBe(true);

        const second = harness.mintHandler({
          appId: 'browser-extension',
          clientId: 'browser-fedcba9876543210',
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          originExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
          installSessionId: 'inst_654321',
        });

        expect(second).toEqual({
          ok: false,
          reason: 'clientId-extensionId-binding-conflict',
          status: 403,
          direction: 'reverse',
        });
      } finally {
        rmSync(harness.userDataPath, { recursive: true, force: true });
      }
    });

    it('rotates a browser client binding when the same extension remints for the same install session', async () => {
      const harness = await buildTrustedHostHarness();
      try {
        const first = harness.mintHandler({
          appId: 'browser-extension',
          clientId: 'browser-0123456789abcdef',
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          originExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
          installSessionId: 'inst_123456',
        });
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error('Expected first mint to succeed.');

        const second = harness.mintHandler({
          appId: 'browser-extension',
          clientId: 'browser-fedcba9876543210',
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          originExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
          installSessionId: 'inst_123456',
        });

        expect(second.ok).toBe(true);
        if (!second.ok) throw new Error('Expected same-session remint to rotate.');
        expect(
          harness.tokenStore.verifyAppToken(first.token, {
            appId: 'browser-extension',
            clientId: 'browser-0123456789abcdef',
          }),
        ).toBeNull();
        expect(
          harness.tokenStore.verifyAppToken(second.token, {
            appId: 'browser-extension',
            clientId: 'browser-fedcba9876543210',
          }),
        ).toMatchObject({
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          pairSessionId: 'inst_123456',
        });
        expect(
          harness.tokenStore.lookupExtensionByClientId('browser-0123456789abcdef'),
        ).toBeNull();
        expect(
          harness.tokenStore.lookupExtensionByClientId('browser-fedcba9876543210'),
        ).toBe('abcdefghijklmnopabcdefghijklmnop');
      } finally {
        rmSync(harness.userDataPath, { recursive: true, force: true });
      }
    });

    it('does not rotate same-session reverse conflicts without a matching extension origin', async () => {
      const harness = await buildTrustedHostHarness();
      try {
        const first = harness.mintHandler({
          appId: 'browser-extension',
          clientId: 'browser-0123456789abcdef',
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          originExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
          installSessionId: 'inst_123456',
        });
        expect(first.ok).toBe(true);

        const second = harness.mintHandler({
          appId: 'browser-extension',
          clientId: 'browser-fedcba9876543210',
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          installSessionId: 'inst_123456',
        });

        expect(second).toEqual({
          ok: false,
          reason: 'clientId-extensionId-binding-conflict',
          status: 403,
          direction: 'reverse',
        });
      } finally {
        rmSync(harness.userDataPath, { recursive: true, force: true });
      }
    });

    it('rate limits repeated browser-extension mint attempts per clientId', async () => {
      const harness = await buildTrustedHostHarness();
      try {
        for (let index = 0; index < 10; index += 1) {
          expect(
            harness.mintHandler({
              appId: 'browser-extension',
              clientId: 'browser-0123456789abcdef',
              extensionId: 'abcdefghijklmnopabcdefghijklmnop',
              installSessionId: `inst_${index}`,
            }).ok,
          ).toBe(true);
        }

        expect(
          harness.mintHandler({
            appId: 'browser-extension',
            clientId: 'browser-0123456789abcdef',
            extensionId: 'abcdefghijklmnopabcdefghijklmnop',
            installSessionId: 'inst_limit',
          }),
        ).toMatchObject({
          ok: false,
          reason: 'rate-limited',
          status: 429,
        });
      } finally {
        rmSync(harness.userDataPath, { recursive: true, force: true });
      }
    });

    it('revokePairedClient denylists install sessions and regenerates boot tokens', async () => {
      const harness = await buildTrustedHostHarness();
      try {
        mkdirSync(join(harness.userDataPath, 'mcp', 'rebel-app-bridge'), { recursive: true });
        writeFileSync(
          join(harness.userDataPath, 'mcp', 'rebel-app-bridge', 'dev-extension-ids.json'),
          JSON.stringify(['abcdefghijklmnopabcdefghijklmnop']),
        );
        harness.tokenStore.upsertClientExtensionBinding(
          'browser-0123456789abcdef',
          'abcdefghijklmnopabcdefghijklmnop',
        );
        harness.tokenStore.issueAppToken(
          'browser-extension',
          'browser-0123456789abcdef',
          null,
          'abcdefghijklmnopabcdefghijklmnop',
          'inst_123456',
        );

        const revoked = await harness.manager.revokePairedClient('browser-0123456789abcdef');

        expect(revoked).toBe(1);
        expect(harness.tokenStore.isInstallSessionRevoked('inst_123456')).toBe(true);
        expect(
          harness.tokenStore.lookupExtensionByClientId('browser-0123456789abcdef'),
        ).toBeNull();
        expect(harness.installerService.regenerateBootTokenFiles).toHaveBeenCalledWith(
          'all',
          harness.errorReporter,
        );
      } finally {
        rmSync(harness.userDataPath, { recursive: true, force: true });
      }
    });

    it('revokeAllPairedClients denylists all install sessions and regenerates all boot tokens', async () => {
      const harness = await buildTrustedHostHarness();
      try {
        mkdirSync(join(harness.userDataPath, 'mcp', 'rebel-app-bridge'), { recursive: true });
        writeFileSync(
          join(harness.userDataPath, 'mcp', 'rebel-app-bridge', 'dev-extension-ids.json'),
          JSON.stringify([
            'abcdefghijklmnopabcdefghijklmnop',
            'ponmlkjihgfedcbaponmlkjihgfedcba',
          ]),
        );
        harness.tokenStore.upsertClientExtensionBinding(
          'browser-0123456789abcdef',
          'abcdefghijklmnopabcdefghijklmnop',
        );
        harness.tokenStore.upsertClientExtensionBinding(
          'browser-fedcba9876543210',
          'ponmlkjihgfedcbaponmlkjihgfedcba',
        );
        harness.tokenStore.issueAppToken(
          'browser-extension',
          'browser-0123456789abcdef',
          null,
          'abcdefghijklmnopabcdefghijklmnop',
          'inst_123456',
        );
        harness.tokenStore.issueAppToken(
          'browser-extension',
          'browser-fedcba9876543210',
          null,
          'ponmlkjihgfedcbaponmlkjihgfedcba',
          'inst_654321',
        );

        const revoked = await harness.manager.revokeAllPairedClients();

        expect(revoked).toBe(2);
        expect(harness.tokenStore.isInstallSessionRevoked('inst_123456')).toBe(true);
        expect(harness.tokenStore.isInstallSessionRevoked('inst_654321')).toBe(true);
        expect(harness.installerService.regenerateBootTokenFiles).toHaveBeenCalledWith(
          'all',
          harness.errorReporter,
        );
      } finally {
        rmSync(harness.userDataPath, { recursive: true, force: true });
      }
    });

    it('resetInstall denylists the scoped install session and rotates the affected browser boot token', async () => {
      const harness = await buildTrustedHostHarness();
      try {
        const session = harness.manager.startPairing({
          appId: 'browser-extension',
          browserId: 'chrome',
        });
        harness.tokenStore.issueAppToken(
          'browser-extension',
          'browser-0123456789abcdef',
          null,
          'abcdefghijklmnopabcdefghijklmnop',
          session.pairSessionId,
        );

        const result = await harness.manager.resetInstall({
          pairSessionId: session.pairSessionId,
        });

        expect(result).toMatchObject({
          ok: true,
          reason: 'ok',
          data: { revoked: 1 },
        });
        expect(harness.tokenStore.isInstallSessionRevoked(session.pairSessionId)).toBe(true);
        expect(harness.installerService.regenerateBootTokenFiles).toHaveBeenCalledWith(
          ['chrome'],
          harness.errorReporter,
        );
      } finally {
        rmSync(harness.userDataPath, { recursive: true, force: true });
      }
    });
  });

  it('stop() awaits an in-flight start() before tearing it down', async () => {
    let resolveFactory!: (h: AppBridgeHandle) => void;
    const stopSpy = vi.fn(async () => {});
    const factory = vi.fn(
      () =>
        new Promise<AppBridgeHandle>((resolve) => {
          resolveFactory = resolve;
        }),
    );
    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig('desktop'),
      errorReporter: buildErrorReporter(),
      createBridge: factory,
    });

    const startPromise = manager.start();
    const stopPromise = manager.stop();

    // Release the factory now that stop() is parked on the in-flight start.
    resolveFactory(buildFakeHandle({ stop: stopSpy }));

    await startPromise.catch(() => {
      /* start() may throw after stop() marks the manager terminal — irrelevant to the race. */
    });
    await expect(stopPromise).resolves.toBeUndefined();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  // --- Stage 2 (260422) — connector:status-changed translator -------------
  //
  // Subscribes at `activePairSessions.set()` inside `startPairing()`. Bus
  // events fan out through the manager-owned `PairEventBus` (injected into
  // the factory via `options.pairEventBus`) — tests emit directly on the
  // captured bus so they exercise the translator regardless of whether
  // pair routes/host routes are running.

  describe('connector:status-changed translator', () => {
    async function buildManagerHarness() {
      let capturedOptions: AppBridgeOptions | undefined;
      const pairingStore = new PairingStore();
      const factory = vi.fn(async (opts: AppBridgeOptions) => {
        capturedOptions = opts;
        return {
          ...buildFakeHandle(),
          pairingStore,
          tokenStore: pairingStore.getTokenStore(),
          connectionManager: new ConnectionManager(),
        } as unknown as AppBridgeHandle;
      });
      const broadcastService = buildBroadcastService();
      const manager = createAppBridgeManager({
        platformConfig: buildPlatformConfig('desktop'),
        errorReporter: buildErrorReporter(),
        createBridge: factory,
        broadcastService,
      });
      await manager.start();
      expect(capturedOptions?.pairEventBus).toBeInstanceOf(PairEventBus);
      const bus = capturedOptions!.pairEventBus as PairEventBus;
      return { manager, broadcastService, bus };
    }

    it('translates `paired` → `connected` broadcast with a stable eventId', async () => {
      const { manager, broadcastService, bus } = await buildManagerHarness();
      const session = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });

      bus.emit({
        type: 'paired',
        cause: 'paired',
        pairSessionId: session.pairSessionId,
        emittedAt: 1_700_000_000_000,
      });

      const statusBroadcasts = findStatusBroadcasts(broadcastService);
      expect(statusBroadcasts).toHaveLength(1);
      expect(statusBroadcasts[0].channel).toBe('connector:status-changed');
      expect(statusBroadcasts[0].args[0]).toEqual({
        connectorId: 'bundled-app-bridge',
        status: 'connected',
        pairSessionId: session.pairSessionId,
        emittedAt: 1_700_000_000_000,
        eventId: `${session.pairSessionId}:1700000000000:connected`,
      });
    });

    it('translates `code-expired` → `expired`', async () => {
      const { manager, broadcastService, bus } = await buildManagerHarness();
      const session = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });

      bus.emit({
        type: 'code-expired',
        cause: 'ttl-expired',
        pairSessionId: session.pairSessionId,
        emittedAt: 1_700_000_001_000,
      });

      const statusBroadcasts = findStatusBroadcasts(broadcastService);
      expect(statusBroadcasts).toHaveLength(1);
      expect(statusBroadcasts[0].args[0]).toEqual({
        connectorId: 'bundled-app-bridge',
        status: 'expired',
        pairSessionId: session.pairSessionId,
        emittedAt: 1_700_000_001_000,
        eventId: `${session.pairSessionId}:1700000001000:expired`,
      });
    });

    it('translates `session-ended` + `cause: user-reset` → `cancelled`', async () => {
      const { manager, broadcastService, bus } = await buildManagerHarness();
      const session = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });

      bus.emit({
        type: 'session-ended',
        cause: 'user-reset',
        pairSessionId: session.pairSessionId,
        emittedAt: 1_700_000_002_000,
      });

      const statusBroadcasts = findStatusBroadcasts(broadcastService);
      expect(statusBroadcasts).toHaveLength(1);
      expect(statusBroadcasts[0].args[0]).toEqual({
        connectorId: 'bundled-app-bridge',
        status: 'cancelled',
        pairSessionId: session.pairSessionId,
        emittedAt: 1_700_000_002_000,
        eventId: `${session.pairSessionId}:1700000002000:cancelled`,
      });
    });

    it('suppresses `session-ended` + `cause: step7-cleanup` — no broadcast', async () => {
      const { manager, broadcastService, bus } = await buildManagerHarness();
      const session = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });

      bus.emit({
        type: 'session-ended',
        cause: 'step7-cleanup',
        pairSessionId: session.pairSessionId,
        emittedAt: 1_700_000_003_000,
      });

      expect(findStatusBroadcasts(broadcastService)).toEqual([]);
    });

    it('falls back to `expired` for `session-ended` events with no `cause` (back-compat)', async () => {
      const { manager, broadcastService, bus } = await buildManagerHarness();
      const session = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });

      bus.emit({
        type: 'session-ended',
        pairSessionId: session.pairSessionId,
        emittedAt: 1_700_000_004_000,
      });

      const statusBroadcasts = findStatusBroadcasts(broadcastService);
      expect(statusBroadcasts).toHaveLength(1);
      expect(statusBroadcasts[0].args[0]).toMatchObject({
        status: 'expired',
        pairSessionId: session.pairSessionId,
      });
    });

    it('unsubscribes the translator on `endPairSession` so later emits do not broadcast', async () => {
      const { manager, broadcastService, bus } = await buildManagerHarness();
      const session = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });

      // Sanity: initial subscriber is live.
      bus.emit({
        type: 'paired',
        cause: 'paired',
        pairSessionId: session.pairSessionId,
        emittedAt: 1_700_000_005_000,
      });
      expect(findStatusBroadcasts(broadcastService)).toHaveLength(1);

      // End the session → the translator must unsubscribe.
      manager.endPairSession(session.pairSessionId);

      // Further emits on the same pair session must not produce broadcasts.
      bus.emit({
        type: 'code-expired',
        cause: 'ttl-expired',
        pairSessionId: session.pairSessionId,
        emittedAt: 1_700_000_006_000,
      });
      expect(findStatusBroadcasts(broadcastService)).toHaveLength(1);
    });

    it('scrubs `tokenFingerprint` — payload never carries PairEvent-only fields', async () => {
      const { manager, broadcastService, bus } = await buildManagerHarness();
      const session = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });

      bus.emit({
        type: 'paired',
        cause: 'paired',
        pairSessionId: session.pairSessionId,
        emittedAt: 1_700_000_007_000,
        // This field MUST NOT be forwarded to the renderer.
        tokenFingerprint: 'abc123-never-broadcast-me',
      });

      const statusBroadcasts = findStatusBroadcasts(broadcastService);
      expect(statusBroadcasts).toHaveLength(1);
      const payload = statusBroadcasts[0].args[0] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('tokenFingerprint');
      expect(payload).toEqual(
        expect.not.objectContaining({ tokenFingerprint: expect.anything() }),
      );
      // And the positive assertion: only the six expected fields are present.
      expect(Object.keys(payload).sort()).toEqual(
        ['connectorId', 'emittedAt', 'eventId', 'pairSessionId', 'status'].sort(),
      );
    });

    it('routes events to the correct pairSessionId when multiple installs are in flight', async () => {
      const { manager, broadcastService, bus } = await buildManagerHarness();
      const chrome = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });
      const edge = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'edge',
      });

      bus.emit({
        type: 'paired',
        cause: 'paired',
        pairSessionId: chrome.pairSessionId,
        emittedAt: 1_700_000_010_000,
      });
      bus.emit({
        type: 'code-expired',
        cause: 'ttl-expired',
        pairSessionId: edge.pairSessionId,
        emittedAt: 1_700_000_011_000,
      });

      const statusBroadcasts = findStatusBroadcasts(broadcastService);
      expect(statusBroadcasts).toHaveLength(2);

      const chromeBroadcast = statusBroadcasts.find(
        (b) => (b.args[0] as { pairSessionId: string }).pairSessionId === chrome.pairSessionId,
      );
      const edgeBroadcast = statusBroadcasts.find(
        (b) => (b.args[0] as { pairSessionId: string }).pairSessionId === edge.pairSessionId,
      );
      expect(chromeBroadcast?.args[0]).toMatchObject({
        pairSessionId: chrome.pairSessionId,
        status: 'connected',
      });
      expect(edgeBroadcast?.args[0]).toMatchObject({
        pairSessionId: edge.pairSessionId,
        status: 'expired',
      });
    });

    // Regression — Stage 2 M1 reviewer finding.
    //
    // Before the fix, `/host/reset-install` emitted `session-ended` AFTER
    // the manager's `cleanupPairSession()` ran, which unsubscribes the
    // Stage 2 translator. Because the emit happened after the unsubscribe,
    // the translator never saw the event and the renderer never received
    // the `cancelled` broadcast. The translator unit tests above masked
    // this because they call `bus.emit()` directly rather than driving
    // `manager.resetInstall()` — the code path that actually runs in
    // production when a user clicks Settings → Reset install.
    //
    // This test pins the real path: it calls `manager.resetInstall()`
    // directly (which is what the `/host/reset-install` handler does)
    // and asserts the `cancelled` broadcast fires. It fails against the
    // buggy emit-after-unsubscribe ordering and passes once the emit
    // moves into `manager.resetInstall()` above the cleanup call.
    //
    // See docs/plans/260422_renderer_driven_connector_status.md — Stage 2 M1.
    it('resetInstall emits cancelled broadcast before cleanupPairSession unsubscribes (M1 regression)', async () => {
      const { manager, broadcastService, bus } = await buildManagerHarness();
      const session = manager.startPairing({
        appId: 'browser-extension',
        browserId: 'chrome',
      });

      const before = Date.now();
      const result = await manager.resetInstall({ pairSessionId: session.pairSessionId });
      const after = Date.now();

      expect(result).toMatchObject({ ok: true, reason: 'ok' });

      const statusBroadcasts = findStatusBroadcasts(broadcastService);
      expect(statusBroadcasts).toHaveLength(1);
      const payload = statusBroadcasts[0].args[0] as ConnectorStatusChangedPayload;
      expect(payload).toMatchObject({
        connectorId: 'bundled-app-bridge',
        status: 'cancelled',
        pairSessionId: session.pairSessionId,
      });
      // The manager stamps `emittedAt: Date.now()` at the emit site; the
      // translator composes `eventId` from `${pairSessionId}:${emittedAt}:${status}`.
      expect(payload.emittedAt).toBeGreaterThanOrEqual(before);
      expect(payload.emittedAt).toBeLessThanOrEqual(after);
      expect(payload.eventId).toBe(
        `${session.pairSessionId}:${payload.emittedAt}:cancelled`,
      );

      // Sanity: after resetInstall, the translator is unsubscribed.
      // Subsequent emits for the same pair session must not broadcast.
      bus.emit({
        type: 'code-expired',
        cause: 'ttl-expired',
        pairSessionId: session.pairSessionId,
        emittedAt: Date.now(),
      });
      expect(findStatusBroadcasts(broadcastService)).toHaveLength(1);
    });

    // Hardening — Chief-mandated companion assertion for M1.
    //
    // `resetInstall` may return `pair-session-not-found` before doing any
    // work (early return). In that case we did NOT emit in the old route
    // (`result.ok || result.reason === 'reset-partial-failure'` gate), and
    // we must continue to not emit now that the emit lives in the manager.
    // Otherwise future tests would see a bogus broadcast for an unknown
    // pairSessionId, and the renderer would materialise a `cancelled`
    // toast for something that was never started.
    it('resetInstall does NOT emit cancelled broadcast when pairSession is not found', async () => {
      const { manager, broadcastService } = await buildManagerHarness();

      const result = await manager.resetInstall({
        pairSessionId: 'ps-hallucinated-never-existed',
      });

      expect(result).toMatchObject({
        ok: false,
        reason: 'pair-session-not-found',
      });
      expect(findStatusBroadcasts(broadcastService)).toEqual([]);
    });
  });

  describe('boot-token regeneration on start()', () => {
    it('regenerates boot-token files on successful start()', async () => {
      // After a bridge start the routerToken is freshly-minted in memory,
      // so the per-extension boot-token files must be refreshed. This
      // regression guard makes sure the manager invokes the installer's
      // regenerate helper exactly once with `('all', errorReporter)`.
      const installerService = {
        setDiagnoseContext: vi.fn(),
        detectBrowsers: vi.fn(),
        extractExtensionFolder: vi.fn(),
        revealExtensionFolder: vi.fn(),
        openBrowserExtensionsPage: vi.fn(),
        diagnose: vi.fn(),
        regenerateBootTokenFiles: vi.fn().mockResolvedValue({
          ok: true,
          rewritten: 2,
          skipped: 0,
          preserved: 2,
        }),
      };
      const errorReporter = buildErrorReporter();
      const manager = createAppBridgeManager({
        platformConfig: buildPlatformConfig('desktop'),
        errorReporter,
        createBridge: vi.fn(async () => buildFakeHandle()),
        installerService: installerService as unknown as AppBridgeInstallerService,
      });

      await manager.start();

      expect(installerService.regenerateBootTokenFiles).toHaveBeenCalledTimes(1);
      expect(installerService.regenerateBootTokenFiles).toHaveBeenCalledWith(
        'all',
        errorReporter,
      );
      const breadcrumb = errorReporter.breadcrumbs.find(
        (b) => b.message === 'boot-token-regen-startup',
      );
      expect(breadcrumb).toBeDefined();
      expect(breadcrumb?.data).toMatchObject({
        rewritten: 2,
        skipped: 0,
        ok: true,
      });
    });

    it('does not rethrow when boot-token regeneration fails on start()', async () => {
      // A failure to refresh the boot-token files is ugly but not worth
      // aborting the bridge over. The start path must resolve normally,
      // the error must be captured via errorReporter, and the bridge
      // must still report running state.
      const regenError = new Error('disk full');
      const installerService = {
        setDiagnoseContext: vi.fn(),
        detectBrowsers: vi.fn(),
        extractExtensionFolder: vi.fn(),
        revealExtensionFolder: vi.fn(),
        openBrowserExtensionsPage: vi.fn(),
        diagnose: vi.fn(),
        regenerateBootTokenFiles: vi.fn().mockRejectedValue(regenError),
      };
      const errorReporter = buildErrorReporter();
      const manager = createAppBridgeManager({
        platformConfig: buildPlatformConfig('desktop'),
        errorReporter,
        createBridge: vi.fn(async () => buildFakeHandle()),
        installerService: installerService as unknown as AppBridgeInstallerService,
      });

      await expect(manager.start()).resolves.not.toBeNull();

      expect(installerService.regenerateBootTokenFiles).toHaveBeenCalledTimes(1);
      expect(manager.isRunning()).toBe(true);
      const captured = errorReporter.captured.find(
        (entry) => entry.error === regenError,
      );
      expect(captured).toBeDefined();
      expect(captured?.context).toMatchObject({
        area: 'app-bridge',
        phase: 'manager-start-boot-token-regen',
      });
    });
  });
});
