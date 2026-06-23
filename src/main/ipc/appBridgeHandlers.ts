/**
 * App Bridge IPC handlers (Stage 6a).
 *
 * Wires four renderer → main channels to the running App Bridge:
 *
 *   - `app-bridge:pair-start`  — calls `manager.startPairing(appId)` directly
 *     on the in-process `PairingStore`. Post-review A3: previously issued an
 *     HTTP POST to `/pair/start` which the originGuard (correctly) refused
 *     because the desktop caller doesn't present an extension origin.
 *   - `app-bridge:list-paired` — delegates to `tokenStore.listAppTokens()`
 *     via the manager so the settings UI can render paired clients.
 *   - `app-bridge:revoke`      — revokes either one clientId or every
 *     client via `tokenStore.revokeAppTokens*()`. Also closes live WS
 *     connections for any revoked clientId so the browser extension sees
 *     the disconnect immediately (post-review B1).
 *   - `app-bridge:restart-dynamic-port` — used by the "Let Rebel pick
 *     another port" CTA in Settings.
 *
 * The bridge is desktop-only (see `appBridgeManager` surface gating). If
 * the manager isn't running, we surface a structured error rather than a
 * cryptic HTTP/socket failure: `code: 'bridge-not-running'`.
 *
 * The router-internal token never crosses the contextBridge — it stays
 * inside the manager; we don't even need an HTTP loopback here.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6a §ipc)
 */

import { registerHandler } from './utils/registerHandler';
import { appBridgeChannels } from '@shared/ipc/channels/appBridge';
import { createScopedLogger } from '@core/logger';
import { sharedManifest as browserExtensionManifest } from '../../../packages/browser-extension/src/manifest.shared';
import {
  getAppBridgeManager as defaultGetManager,
} from '../services/gracefulShutdown';
import type { AppBridgeManager } from '../services/appBridgeManager';
import { getAppBridgeInstallerService } from '../services/appBridgeInstallerService';

const log = createScopedLogger({ service: 'appBridgeHandlers' });

export interface AppBridgeHandlersDeps {
  /** Injected so tests can substitute a fake manager. */
  getManager?: () => AppBridgeManager | null;
}

/**
 * Error thrown when the caller attempts to use the bridge while it isn't
 * running (kill-switch active, cloud surface, startup failure, …). The
 * renderer surfaces a friendly copy; we preserve the structured code so
 * analytics can slice on it.
 */
class BridgeNotRunningError extends Error {
  override readonly name = 'BridgeNotRunningError';
  readonly code = 'bridge-not-running' as const;

  constructor(reason: string) {
    super(`App Bridge is not running: ${reason}`);
  }
}

export function registerAppBridgeHandlers(
  deps: AppBridgeHandlersDeps = {},
): void {
  const getManager = deps.getManager ?? defaultGetManager;

  // --- app-bridge:pair-start ------------------------------------------------
  // Post-review A3: bypass HTTP entirely. Calling the HTTP route from the
  // same process required presenting an Origin header that the origin
  // guard then (correctly) rejected, which made pair-start unusable.
  const pairStartChannel = appBridgeChannels['app-bridge:pair-start'];
  registerHandler(pairStartChannel.channel, async (_event, ...args) => {
    const req = pairStartChannel.request.parse(args[0] ?? {});
    const manager = getManager();
    if (!manager || !manager.isRunning()) {
      const reason = manager?.getSkipReason() ?? 'not-initialized';
      throw new BridgeNotRunningError(reason);
    }
    try {
      const session = manager.startPairing({
        appId: req.appId,
      });
      return pairStartChannel.response.parse({
        code: session.code,
        expiresAt: session.expiresAt,
        expiresInSeconds: session.expiresInSeconds,
        pairSessionId: session.pairSessionId,
        appId: req.appId,
      });
    } catch (err) {
      log.warn(
        { err, appId: req.appId },
        'startPairing failed inside IPC handler',
      );
      throw err;
    }
  });

  // --- app-bridge:list-paired ----------------------------------------------
  const listPairedChannel = appBridgeChannels['app-bridge:list-paired'];
  registerHandler(listPairedChannel.channel, async () => {
    const manager = getManager();
    if (!manager || !manager.isRunning()) {
      return listPairedChannel.response.parse({ clients: [] });
    }
    const snapshot = manager.listPairedClients();
    return listPairedChannel.response.parse({
      clients: snapshot.map((c) => ({
        clientId: c.clientId,
        appId: c.appId,
        createdAt: c.issuedAt,
      })),
    });
  });

  // --- app-bridge:check-extension-version -----------------------------------
  const checkExtensionVersionChannel = appBridgeChannels['app-bridge:check-extension-version'];
  registerHandler(checkExtensionVersionChannel.channel, async () => {
    const manager = getManager();
    const latestVersion = browserExtensionManifest.version;
    const status =
      manager && manager.isRunning()
        ? manager.getExtensionVersionStatus(latestVersion)
        : { currentVersion: null, latestVersion };
    return checkExtensionVersionChannel.response.parse(status);
  });

  // --- app-bridge:revoke ---------------------------------------------------
  const revokeChannel = appBridgeChannels['app-bridge:revoke'];
  registerHandler(revokeChannel.channel, async (_event, ...args) => {
    const req = revokeChannel.request.parse(args[0] ?? {});
    const manager = getManager();
    if (!manager || !manager.isRunning()) {
      // Bridge was never running or was stopped — there's nothing to
      // revoke. Return `revoked: 0` so the UI can still reconcile state.
      return revokeChannel.response.parse({ revoked: 0 });
    }
    const revoked = req.clientId
      ? await manager.revokePairedClient(req.clientId)
      : await manager.revokeAllPairedClients();
    return revokeChannel.response.parse({ revoked });
  });

  // --- app-bridge:restart-dynamic-port -------------------------------------
  // Stage 9 — "Let Rebel pick another port" CTA. Stops the bridge and
  // re-runs the factory so it walks the fallback list. Paired tokens
  // persist because the TokenStore is re-hydrated from disk inside
  // `createAppBridge()`.
  const restartChannel = appBridgeChannels['app-bridge:restart-dynamic-port'];
  registerHandler(restartChannel.channel, async (_event, ...args) => {
    restartChannel.request.parse(args[0] ?? {});
    const manager = getManager();
    if (!manager) {
      return restartChannel.response.parse({
        restarted: false,
        port: null,
        skipReason: 'not-running',
      });
    }

    // If the manager is up but the bridge isn't, surface whichever skip
    // reason it already decided on so the UI can explain why.
    if (!manager.isRunning()) {
      const reason = manager.getSkipReason();
      if (reason === 'kill-switch' || reason === 'surface-not-desktop') {
        return restartChannel.response.parse({
          restarted: false,
          port: null,
          skipReason: reason,
        });
      }
    }

    const state = await manager.restartWithDynamicPort();
    if (!state) {
      const reason = manager.getSkipReason();
      return restartChannel.response.parse({
        restarted: false,
        port: null,
        skipReason:
          reason === 'kill-switch' || reason === 'surface-not-desktop'
            ? reason
            : 'not-running',
      });
    }
    log.info(
      { port: state.port },
      'App Bridge restarted on dynamic port via IPC',
    );
    return restartChannel.response.parse({
      restarted: true,
      port: state.port,
      skipReason: null,
    });
  });

  // --- app-bridge:detect-browsers -------------------------------------------
  const detectChannel = appBridgeChannels['app-bridge:detect-browsers'];
  registerHandler(detectChannel.channel, async () => {
    const service = getAppBridgeInstallerService();
    try {
      const browsers = await service.detectBrowsers();
      return detectChannel.response.parse({ browsers });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Browser detection failed in IPC handler');
      return detectChannel.response.parse({ browsers: [] });
    }
  });

  // --- app-bridge:extract-extension -----------------------------------------
  const extractChannel = appBridgeChannels['app-bridge:extract-extension'];
  registerHandler(extractChannel.channel, async (_event, ...args) => {
    const req = extractChannel.request.parse(args[0] ?? {});
    const service = getAppBridgeInstallerService();
    const result = await service.extractExtensionFolder(req.browserId);
    return extractChannel.response.parse(result);
  });

  // --- app-bridge:reveal-extension-folder -----------------------------------
  const revealChannel = appBridgeChannels['app-bridge:reveal-extension-folder'];
  registerHandler(revealChannel.channel, async (_event, ...args) => {
    const req = revealChannel.request.parse(args[0] ?? {});
    const service = getAppBridgeInstallerService();
    const result = await service.revealExtensionFolder(req.browserId);
    return revealChannel.response.parse(result);
  });

  // --- app-bridge:open-browser-extensions-page ------------------------------
  const openExtPageChannel = appBridgeChannels['app-bridge:open-browser-extensions-page'];
  registerHandler(openExtPageChannel.channel, async (_event, ...args) => {
    const req = openExtPageChannel.request.parse(args[0] ?? {});
    const service = getAppBridgeInstallerService();
    const result = await service.openBrowserExtensionsPage(req.browserId);
    return openExtPageChannel.response.parse(result);
  });

  // --- app-bridge:check-pair-status -----------------------------------------
  const checkPairStatusChannel = appBridgeChannels['app-bridge:check-pair-status'];
  registerHandler(checkPairStatusChannel.channel, async (_event, ...args) => {
    const req = checkPairStatusChannel.request.parse(args[0] ?? {});
    const manager = getManager();
    if (!manager || !manager.isRunning()) {
      return checkPairStatusChannel.response.parse({
        paired: [],
        hasPending: false,
        ...(req.pairSessionId
          ? { pairSessionExpired: true }
          : { activeSessionCount: 0 }),
      });
    }
    return checkPairStatusChannel.response.parse(
      req.pairSessionId
        ? manager.checkPairStatus(req.pairSessionId)
        : manager.getGlobalPairStatus(),
    );
  });

  // --- app-bridge:list-pending-approvals ------------------------------------
  const listPendingChannel = appBridgeChannels['app-bridge:list-pending-approvals'];
  registerHandler(listPendingChannel.channel, async () => {
    const manager = getManager();
    if (!manager || !manager.isRunning()) {
      return listPendingChannel.response.parse({ pending: [] });
    }
    return listPendingChannel.response.parse({ pending: manager.listPendingApprovals() });
  });

  // --- app-bridge:resolve-pending-approval ----------------------------------
  const resolvePendingChannel = appBridgeChannels['app-bridge:resolve-pending-approval'];
  registerHandler(resolvePendingChannel.channel, async (_event, ...args) => {
    const req = resolvePendingChannel.request.parse(args[0] ?? {});
    const manager = getManager();
    if (!manager || !manager.isRunning()) {
      return resolvePendingChannel.response.parse({ ok: false, reason: 'not-found' });
    }
    return resolvePendingChannel.response.parse(
      manager.approvePendingApproval(req)
    );
  });

  // --- app-bridge:end-pair-session -----------------------------------------
  const endPairSessionChannel = appBridgeChannels['app-bridge:end-pair-session'];
  registerHandler(endPairSessionChannel.channel, async (_event, ...args) => {
    const req = endPairSessionChannel.request.parse(args[0] ?? {});
    const manager = getManager();
    if (!manager || !manager.isRunning()) {
      return endPairSessionChannel.response.parse({
        ok: true,
        reason: 'ok',
        retryable: false,
        data: {},
      });
    }
    manager.endPairSession(req.pairSessionId, {
      stage: 'renderer-cleanup',
      reason: 'session-ended',
    });
    return endPairSessionChannel.response.parse({
      ok: true,
      reason: 'ok',
      retryable: false,
      data: {},
    });
  });

  // --- app-bridge:reset-install --------------------------------------------
  const resetInstallChannel = appBridgeChannels['app-bridge:reset-install'];
  registerHandler(resetInstallChannel.channel, async (_event, ...args) => {
    const req = resetInstallChannel.request.parse(args[0] ?? {});
    const manager = getManager();
    if (!manager || !manager.isRunning()) {
      return resetInstallChannel.response.parse({
        ok: false,
        reason: 'pair-session-not-found',
        retryable: false,
      });
    }
    return resetInstallChannel.response.parse(await manager.resetInstall(req));
  });

  // --- app-bridge:register-nmh (Chunk C — latent) ---------------------------
  const registerNmhChannel = appBridgeChannels['app-bridge:register-nmh'];
  registerHandler(registerNmhChannel.channel, async (_event, ...args) => {
    registerNmhChannel.request.parse(args[0] ?? {});
    const manager = getManager();
    if (!manager || !manager.isRunning()) {
      return registerNmhChannel.response.parse([]);
    }
    const service = getAppBridgeInstallerService();
    const detectedBrowsers = await service.detectBrowsers();
    const result = await service.registerNmhManifests({
      detectedBrowsers,
      allowedExtensionIds: [...manager.listPairedExtensionIds()],
    });
    return registerNmhChannel.response.parse(result);
  });

  // --- app-bridge:unregister-nmh (Chunk C — latent) -------------------------
  const unregisterNmhChannel = appBridgeChannels['app-bridge:unregister-nmh'];
  registerHandler(unregisterNmhChannel.channel, async (_event, ...args) => {
    const req = unregisterNmhChannel.request.parse(args[0] ?? {});
    const service = getAppBridgeInstallerService();
    const result = await service.unregisterNmhManifests({ browserIds: req.browserIds });
    return unregisterNmhChannel.response.parse(result);
  });

  log.info('App Bridge IPC handlers registered');
}

// Exported for tests to reach the structured error.
export { BridgeNotRunningError };
