/**
 * Graceful Shutdown Service
 *
 * Handles clean application shutdown with timeout protection.
 * Ensures all services are properly stopped before exit.
 *
 * Features:
 * - Aborts all active agent turns
 * - Stops bundled inbox bridge
 * - Stops file watcher and semantic indexing
 * - Stops Super-MCP HTTP server
 * - Stops Ollama local inference process
 * - Stops workspace file watcher
 * - Disposes pre-turn worker utility process
 * - Flushes analytics queue
 * - Per-service cleanup tracking with timeout handling
 * - Timeout protection (10 seconds)
 * - Tracks clean vs unclean shutdown for crash recovery UX
 */

import { getElectronModule } from '@core/lazyElectron';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { getPlatformConfig } from '@core/platform';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { logger } from '@core/logger';
import { safeLog } from '../safeLog';
import { trackMainEvent, flushMainAnalytics, getOrGenerateAnonymousId } from '../analytics';
import { agentTurnRegistry } from './agentTurnRegistry';
import type { ConversationStreamCoordinator } from '@core/appBridge/server/conversationStreamCoordinator';
import type { AppBridgeManager } from './appBridgeManager';
import { terminateAllAtlasWorkers } from './atlasService';
import { isUpdateDownloading } from './autoUpdateState';
import { stopBundledInboxBridge } from './bundledInboxBridge';
import { bundledHttpMcpManager } from './bundledHttpMcpManager';
import { stopOfficeSidecar } from './officeSidecarManager';
import { closeConversationIndex } from './conversationIndexService';
import { disposeEmbeddingService } from './embeddingService';
import { closeIndex as closeFileIndex } from './fileIndexService';
import { dispose as disposeMoonshine } from './moonshineTranscriber';
import { stopEnhancement } from './enhancementService';
import { stopWatching as stopFileWatching } from './fileWatcherService';
import { ollamaService } from './ollamaService';
import { stopSuperMcpForAppShutdown } from './superMcpHttpManager';
import { closeToolIndex } from './toolIndexService';

import { immediateExitWithFseventsSweep } from './finalExit';
import { workspaceWatcherService } from './workspaceWatcherService';
import { cloudTokenRelay } from './cloud/cloudTokenRelay';
import { libraryBroadcaster } from './libraryBroadcaster';
import { setShuttingDown, isShuttingDown as isShuttingDownState } from './shutdownState';
import { stopTutorialPlayerServer } from './tutorialPlayerServer';
import { disposeWorker as disposePreTurnWorker } from './preTurnWorkerService';
import { stopCloudUpdateScheduler } from './cloudUpdateScheduler';

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10000;
const UPDATE_DOWNLOAD_WAIT_TIMEOUT_MS = 10 * 60 * 1000; // Max wait for update download on macOS
let isQuitting = false;
let isQuittingForUpdate = false;

/**
 * App Bridge manager reference — set by `setAppBridgeManagerForShutdown` once
 * `coreStartup` has constructed the manager. We keep it at module scope so
 * the cleanup closure in `shutdownInternal()` doesn't depend on it being
 * passed down through the shutdown call chain (which would require touching
 * every entry point — quitForUpdate, gracefulShutdownServicesOnly, etc.).
 *
 * Left `null` on cloud surfaces where no bridge was constructed.
 */
let _appBridgeManagerForShutdown: AppBridgeManager | null = null;

/**
 * Register the App Bridge manager with the graceful-shutdown runner.
 * Call this from `src/main/index.ts` after `initCoreServices` returns.
 * Calling twice overwrites the previous manager (last-wins); callers should
 * never need to — the manager is created once per process lifetime.
 */
export function setAppBridgeManagerForShutdown(manager: AppBridgeManager | null): void {
  _appBridgeManagerForShutdown = manager;
}

/**
 * Read-only accessor for the App Bridge manager — used by IPC handlers
 * (Stage 6a) that need to call the bridge's internal HTTP API without
 * taking a direct dependency on `coreStartup`'s return value.
 *
 * Returns `null` before `setAppBridgeManagerForShutdown` has been called
 * (e.g. during early startup) or on cloud surfaces where no bridge exists.
 */
export function getAppBridgeManager(): AppBridgeManager | null {
  return _appBridgeManagerForShutdown;
}

/**
 * Embedded-chat SSE stream coordinator (Stage 2 of
 * `260421_embedded_chat_in_extension`). Kept at module scope so the
 * shutdown closure can reach it without threading it through every
 * entry point (mirrors `_appBridgeManagerForShutdown`). `null` on
 * surfaces where the App Bridge didn't start.
 */
let _conversationStreamCoordinatorForShutdown: ConversationStreamCoordinator | null = null;

/**
 * Register the conversation stream coordinator for graceful shutdown.
 * Called by `src/main/index.ts` after `initCoreServices` returns.
 * Safe to call with `null` (cloud surfaces, tests). Last-wins; callers
 * should never need to call this more than once per process lifetime.
 */
export function setAppBridgeStreamCoordinatorForShutdown(
  coordinator: ConversationStreamCoordinator | null,
): void {
  _conversationStreamCoordinatorForShutdown = coordinator;
}

// Store handler references so they can be removed before quitAndInstall
// This is critical for macOS Squirrel.Mac updates - the before-quit handler's
// event.preventDefault() interferes with ShipIt daemon's file operations.
// See: docs/plans/finished/260131_auto_update_shipit_cache_corruption.md
let beforeQuitHandler: ((event: Electron.Event) => void) | null = null;

// Track clean exit for crash recovery UX. The store also carries a rolling
// `recentCrashes` timestamp buffer so the diagnostic bundle can answer
// "how many times has this app crashed in the last 24h / 7d?" without a
// second persistence mechanism.
type CleanExitStoreShape = { cleanExit: boolean; recentCrashes?: number[] };
let _cleanExitStore: KeyValueStore<CleanExitStoreShape> | null = null;
const getCleanExitStore = (): KeyValueStore<CleanExitStoreShape> => {
  if (!_cleanExitStore) {
    _cleanExitStore = createStore<CleanExitStoreShape>({ name: 'clean-exit-flag' });
  }
  return _cleanExitStore;
};
let wasCleanExitOnStartup = true;
const PROCESS_SUPERVISION_HISTORY_CAP = 200;

/**
 * Set flag indicating we're quitting for an update installation.
 * This allows the shutdown handler to release the single-instance lock early
 * to prevent the restart deadlock race condition.
 */
export function setQuittingForUpdate(): void {
  isQuittingForUpdate = true;
}

/**
 * Clear the quitting-for-update flag.
 * Called if quitAndInstall fails and the app continues running.
 */
export function clearQuittingForUpdate(): void {
  isQuittingForUpdate = false;
}

/**
 * Check if we're quitting for an update.
 */
export function isUpdateQuit(): boolean {
  return isQuittingForUpdate;
}

/** Per-service timeout for cleanup operations (ms) */
const SERVICE_CLEANUP_TIMEOUT_MS = 3000;

/**
 * Track cleanup status for a service with timeout.
 */
async function cleanupService(
  serviceName: string,
  cleanupFn: () => Promise<void> | void,
  cleanupStatus: Record<string, 'pending' | 'completed' | 'failed' | 'timeout'>
): Promise<void> {
  cleanupStatus[serviceName] = 'pending';
  const startTime = Date.now();

  try {
    const result = cleanupFn();
    if (result instanceof Promise) {
      // Apply per-service timeout
      await Promise.race([
        result,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${serviceName} cleanup timed out`)), SERVICE_CLEANUP_TIMEOUT_MS)
        )
      ]);
    }
    cleanupStatus[serviceName] = 'completed';
    logger.debug({ service: serviceName, durationMs: Date.now() - startTime }, 'Service cleanup completed');
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes('timed out');
    cleanupStatus[serviceName] = isTimeout ? 'timeout' : 'failed';
    logger.warn(
      { err: error, service: serviceName, durationMs: Date.now() - startTime },
      `Service cleanup ${isTimeout ? 'timed out' : 'failed'}`
    );
  }
}

/**
 * Perform internal shutdown cleanup.
 */
async function shutdownInternal(): Promise<void> {
  logger.info('App quitting - cleaning up resources');

  // Track cleanup status for all services
  const cleanupStatus: Record<string, 'pending' | 'completed' | 'failed' | 'timeout'> = {};

  trackMainEvent({
    anonymousId: getOrGenerateAnonymousId(),
    event: 'Application Shutdown Started',
    properties: { version: getPlatformConfig().version }
  });

  try {
    await flushMainAnalytics();
  } catch (error) {
    logger.warn({ err: error }, 'Failed to flush analytics queue on quit');
  }

  // Flush any queued diagnostic-events ledger writes before exit so the last
  // few cooldown/advisory/known-condition events are not lost on shutdown.
  try {
    const { flushDiagnosticEventsLedger } = await import('./diagnosticEventsLedgerWriter');
    await flushDiagnosticEventsLedger();
  } catch (error) {
    logger.warn({ err: error }, 'Failed to flush diagnostic-events ledger on quit');
  }

  // Flush any pending session writes before aborting turns.
  await cleanupService('sessionFlush', async () => {
    const { getIncrementalSessionStore } = await import('@core/services/incrementalSessionStore');
    const store = getIncrementalSessionStore();
    await store.flushPendingWrites();
  }, cleanupStatus);

  // Abort all active agent turns
  agentTurnRegistry.abortAllTurns();

  // Wait briefly for active turns to drain (process AbortError, dispatch terminal events)
  const TURN_DRAIN_TIMEOUT_MS = 2000;
  const TURN_DRAIN_POLL_MS = 100;
  const activeTurns = agentTurnRegistry.getActiveTurnCount();
  if (activeTurns > 0) {
    logger.info({ activeTurns }, 'Waiting for active turns to drain before shutdown');
    const drainStart = Date.now();
    while (agentTurnRegistry.getActiveTurnCount() > 0 && Date.now() - drainStart < TURN_DRAIN_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, TURN_DRAIN_POLL_MS));
    }
    const remaining = agentTurnRegistry.getActiveTurnCount();
    if (remaining > 0) {
      logger.warn({ remaining, drainMs: Date.now() - drainStart }, 'Active turns did not drain in time, proceeding with shutdown');
    } else {
      logger.info({ drainMs: Date.now() - drainStart }, 'All active turns drained successfully');
    }
  }

  // Finalize sessions with stale activeTurnId before exit.
  // During orderly shutdown, clear busy state WITHOUT marking as interrupted.
  // The renderer's async IPC upserts (terminal events from abort) may not have
  // landed — this directly fixes session files so startup doesn't show a false
  // "Pick Up Where You Left Off" modal. Also locks the session store read-only
  // to prevent late-arriving renderer writes from overwriting corrections.
  //
  // Only runs during real app quit (isQuitting), NOT during gracefulShutdownServicesOnly()
  // which is used for workspace rename and pre-update cleanup where the app continues running.
  // See: docs/plans/260426_fix_shutdown_persistence_race.md
  if (isQuitting) {
    await cleanupService('shutdownSessionFinalization', async () => {
      const { getIncrementalSessionStore } = await import('@core/services/incrementalSessionStore');
      const store = getIncrementalSessionStore();
      store.finalizeActiveSessionsOnShutdown();
    }, cleanupStatus);
  }

  // Cleanup services with tracking
  await cleanupService('bundledInboxBridge', stopBundledInboxBridge, cleanupStatus);
  await cleanupService('officeSidecar', stopOfficeSidecar, cleanupStatus);
  await cleanupService('appBridgePairSessions', async () => {
    const manager = _appBridgeManagerForShutdown;
    if (!manager || !manager.isRunning()) {
      return;
    }
    for (const session of manager.getActivePairSessions()) {
      manager.endPairSession(session.pairSessionId, {
        stage: 'before-quit',
        reason: 'app-quit',
      });
    }
  }, cleanupStatus);
  await cleanupService('appBridgeStreamCoordinator', () => {
    // Embedded-chat SSE coordinator (Stage 2 of the embedded-chat
    // plan). Closes all writers + clears keepalive/idle timers before
    // the underlying HTTP server is torn down by `appBridge.stop()`
    // below. Safe to call multiple times (coordinator.closeAll is
    // idempotent); no-op when never constructed (cloud surfaces).
    _conversationStreamCoordinatorForShutdown?.closeAll();
  }, cleanupStatus);
  await cleanupService('appBridge', async () => {
    // The manager is `null` on cloud surfaces and when coreStartup didn't
    // register one (tests, early-boot failures). Stopping a manager is
    // already idempotent and swallows its own errors — we just need to
    // await it so open sockets and the state file are released before
    // Super-MCP tries to tear down its own listeners.
    await _appBridgeManagerForShutdown?.stop();
  }, cleanupStatus);
  await cleanupService('bundledHttpMcps', () => bundledHttpMcpManager.stopAll(), cleanupStatus);
  await cleanupService('fileWatcher', stopFileWatching, cleanupStatus);
  await cleanupService('superMcpHttp', stopSuperMcpForAppShutdown, cleanupStatus);
  await cleanupService('ollamaService', () => ollamaService.stop(), cleanupStatus);
  await cleanupService('tutorialPlayer', stopTutorialPlayerServer, cleanupStatus);
  await cleanupService('cloudUpdateScheduler', stopCloudUpdateScheduler, cleanupStatus);

  // Stop workspace file watchers (await close to ensure fsevents native cleanup completes)
  try {
    libraryBroadcaster.stop(); // Stop broadcaster first (clears timers, logs stats)
    await workspaceWatcherService.stop();
    cleanupStatus['workspaceWatcher'] = 'completed';
  } catch (error) {
    cleanupStatus['workspaceWatcher'] = 'failed';
    logger.warn({ err: error }, 'Failed to stop workspace watchers during quit');
  }

  // Stop cloud token relay file watcher
  await cleanupService('cloudTokenRelay', () => cloudTokenRelay.stop(), cleanupStatus);

  // Close LanceDB connections to prevent thread join crash
  await cleanupService('conversationIndex', closeConversationIndex, cleanupStatus);
  await cleanupService('toolIndex', closeToolIndex, cleanupStatus);
  // File-index LanceDB connections (read + write). closeIndex() is itself
  // bounded (write-lock + <=3s optimize-drain + read-drain); the per-service
  // budget (Promise.race in cleanupService) is the hard ceiling on top of that.
  // Previously wired only on headless/cloud quit — closing it on desktop quit
  // too removes a native-owner from what env teardown has to join (PLAN.md
  // Stage 4, REBEL-6AM quit-deadlock class).
  await cleanupService('fileIndex', () => closeFileIndex(), cleanupStatus);

  // Release the 2 in-MAIN Moonshine ORT InferenceSessions. dispose() joins each
  // session's native threadpool early (the Worker::JoinThread that otherwise
  // hangs env teardown) and is bounded + fail-open (PLAN.md Stage 4).
  await cleanupService('moonshine', () => disposeMoonshine(), cleanupStatus);

  // Flush enhancement costs (synchronous, also bypassed by app.exit)
  try {
    stopEnhancement();
    cleanupStatus['enhancement'] = 'completed';
  } catch (error) {
    cleanupStatus['enhancement'] = 'failed';
    logger.warn({ err: error }, 'Failed to stop enhancement service during quit');
  }

  // REBEL-4X: Terminate atlas workers before embedding service (atlas may use embeddings)
  await cleanupService('atlasWorkers', terminateAllAtlasWorkers, cleanupStatus);

  // Dispose pre-turn worker utility process to release file locks
  await cleanupService('preTurnWorker', disposePreTurnWorker, cleanupStatus);

  // Dispose embedding service LAST (after all indexing is stopped)
  await cleanupService('embeddingService', disposeEmbeddingService, cleanupStatus);

  // Stage 1.5 (A9): final flush AFTER all cleanup. The early flush above
  // catches everything queued at the moment shutdown began; this catches
  // disconnect / restart / abort / final-emit events emitted *during* cleanup
  // (Super-MCP stop, agent-turn abort, file-watcher teardown). Without this
  // pass, the most diagnostically interesting "what was happening when we
  // shut down" events would be lost on app exit.
  try {
    const { flushDiagnosticEventsLedger } = await import('./diagnosticEventsLedgerWriter');
    await flushDiagnosticEventsLedger();
  } catch (error) {
    logger.warn({ err: error }, 'Failed to perform final diagnostic-events flush at end of shutdown');
  }

  // Log final cleanup status summary
  const completed = Object.entries(cleanupStatus).filter(([, s]) => s === 'completed').length;
  const failed = Object.entries(cleanupStatus).filter(([, s]) => s === 'failed').length;
  const timeout = Object.entries(cleanupStatus).filter(([, s]) => s === 'timeout').length;
  logger.info(
    { cleanupStatus, summary: { completed, failed, timeout, total: Object.keys(cleanupStatus).length } },
    'Shutdown cleanup summary'
  );
}

/**
 * Perform graceful shutdown with timeout protection.
 */
async function gracefulShutdownWithStatus(): Promise<boolean> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Graceful shutdown timed out after ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms`));
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  });

  try {
    await Promise.race([shutdownInternal(), timeoutPromise]);
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'Graceful shutdown did not complete in time, forcing exit');
    // Stage 3b: the graceful-shutdown 10s race losing is a quit-deadlock
    // symptom (cleanup hung past its budget). Emit FIRST (ledger-first +
    // bounded ≤2s flush) so the signal is durable before the caller proceeds
    // to force-exit; the bounded flush can never extend the hang unboundedly.
    try {
      const { emitQuitDeadlockDetected } = await import('./quitDeadlockTelemetry');
      await emitQuitDeadlockDetected('graceful_10s');
    } catch (emitErr) {
      logger.warn({ err: emitErr }, 'Failed to emit quit_deadlock_detected on graceful-shutdown timeout');
    }
    return false;
  }
}

async function gracefulShutdown(): Promise<void> {
  await gracefulShutdownWithStatus();
}

/**
 * Initialize graceful shutdown handlers.
 * Should be called once during app initialization.
 */
export function initGracefulShutdown(): void {
  // Check if last exit was clean (for crash recovery UX)
  wasCleanExitOnStartup = getCleanExitStore().get('cleanExit', true);
  // Mark as unclean until we exit cleanly
  getCleanExitStore().set('cleanExit', false);

  if (!wasCleanExitOnStartup) {
    logger.info('Previous shutdown was unclean (crash or force-quit detected)');
    try {
      const existing = getCleanExitStore().get('recentCrashes', []) ?? [];
      const buffer = Array.isArray(existing) ? [Date.now(), ...existing] : [Date.now()];
      const trimmed = buffer.filter((ts): ts is number => typeof ts === 'number' && Number.isFinite(ts) && ts > 0).slice(0, PROCESS_SUPERVISION_HISTORY_CAP);
      getCleanExitStore().set('recentCrashes', trimmed);
    } catch (error) {
      logger.warn({ err: error }, 'Failed to record crash timestamp in clean-exit-flag store');
    }
  }

  // Store handler reference so it can be removed before quitAndInstall
  beforeQuitHandler = (event: Electron.Event) => {
    logger.debug({ isQuitting, isUpdateDownloading: isUpdateDownloading() }, '[before-quit] Event fired');

    if (isQuitting) {
      // Already shutting down, let the quit proceed
      return;
    }

    // Prevent default quit to allow async cleanup
    event.preventDefault();
    isQuitting = true;
    logger.info('[before-quit] Starting graceful shutdown');
    // REBEL-4X: Set global shutdown state for services that use cycle-free import
    setShuttingDown();

    // DEFENSIVE FALLBACK: The lock should already be released by safeQuitAndInstall() in
    // autoUpdateService.ts BEFORE quitAndInstall() is called. This is a belt-and-suspenders
    // fallback in case the pre-release fails. releaseSingleInstanceLock() is idempotent.
    // See: docs/plans/partway/260116_fix-update-hang-single-instance-lock.md
    if (isQuittingForUpdate) {
      logger.info('Releasing single-instance lock for update restart (fallback)');
      try {
        getElectronModule()?.app?.releaseSingleInstanceLock();
      } catch (error) {
        logger.warn({ err: error }, 'Failed to release single-instance lock');
      }
    }

    let shutdownSucceeded = false;
    gracefulShutdownWithStatus()
      .then((succeeded) => {
        shutdownSucceeded = succeeded;
      })
      .catch((error) => {
        // REBEL-5RT FU-4: wrap logger.error — this catch fires when graceful
        // shutdown has thrown, which is exactly when the pino transport worker
        // is most likely to have already died (FU-1 H2 — pino auto-ends on
        // process exit; late .catch() handlers can land after autoEnd).
        // safeLog falls back to console.error rather than re-throw the
        // "the worker has exited" error.
        safeLog(logger, 'error', { err: error }, 'Error during graceful shutdown');
      })
      .finally(() => {
        // Mark as clean exit only on successful shutdown.
        // Update installs are an expected special-case and should always be marked clean.
        getCleanExitStore().set('cleanExit', shutdownSucceeded || isUpdateQuit());

        // macOS: Special handling for Squirrel.Mac updates
        // Squirrel.Mac uses Electron's built-in autoUpdater which may be downloading in the background.
        // We wait for the download to complete before exiting to avoid corrupting the update.
        // Windows uses electron-updater (NSIS) - downloads are cancelled on quit (by design);
        // update installation is handled via quitAndInstall() which manages the process internally.
        const electron = getElectronModule();
        if (process.platform === 'darwin' && isUpdateDownloading() && electron) {
          logger.info('[gracefulShutdown] macOS update downloading, waiting for completion (max 10m)');

          let downloadComplete = false;

          const onCompleteDownloaded = () => cleanupAndQuit('update-downloaded');
          const onCompleteError = () => cleanupAndQuit('error');
          const onCompleteNotAvailable = () => cleanupAndQuit('update-not-available');

          const downloadTimeout = setTimeout(() => {
            cleanupAndQuit('timeout-10m');
          }, UPDATE_DOWNLOAD_WAIT_TIMEOUT_MS);

          function cleanupAndQuit(source: string) {
            if (downloadComplete) return;
            downloadComplete = true;
            logger.info(`[gracefulShutdown] Download wait ended (${source}), proceeding with quit`);
            clearTimeout(downloadTimeout);
            electron?.autoUpdater.removeListener('update-downloaded', onCompleteDownloaded);
            electron?.autoUpdater.removeListener('error', onCompleteError);
            electron?.autoUpdater.removeListener('update-not-available', onCompleteNotAvailable);
            // Point of no return: sweep leaked fsevents instances, then exit
            // (quit-time SIGABRT fix — see finalExit.ts). cleanExit flag was
            // already written at the top of this .finally(), preserving the
            // flag-before-sweep-before-exit ordering.
            fireAndForget(
              immediateExitWithFseventsSweep(`update-download-wait:${source}`, 0),
              'gracefulShutdown.updateDownloadWaitExit',
            );
          }

          // In dev mode, autoUpdater isn't active
          if (!electron.app.isPackaged) {
            logger.info('[gracefulShutdown] Dev mode: autoUpdater not active');
            fireAndForget(
              immediateExitWithFseventsSweep('update-download-wait:dev-mode', 0),
              'gracefulShutdown.devModeExit',
            );
            return;
          }

          electron.autoUpdater.once('update-downloaded', onCompleteDownloaded);
          electron.autoUpdater.once('error', onCompleteError);
          electron.autoUpdater.once('update-not-available', onCompleteNotAvailable);

          return; // Don't exit yet, wait for download
        }

        // Default: point of no return — sweep leaked fsevents instances, then
        // force exit (quit-time SIGABRT fix — see finalExit.ts). The primitive
        // handles the desktop/cloud split itself (app.exit vs process.exit).
        // cleanExit flag ordering preserved: written above, before the sweep.
        fireAndForget(
          immediateExitWithFseventsSweep('graceful-shutdown-complete', 0),
          'gracefulShutdown.finalExit',
        );
      });
  };

  const electron = getElectronModule();
  if (electron) {
    electron.app.on('before-quit', beforeQuitHandler);
  }
}

/**
 * Check if the last app shutdown was clean.
 * Returns false if the app crashed or was force-quit.
 */
export function wasCleanExit(): boolean {
  return wasCleanExitOnStartup;
}

/**
 * Check if the app is currently in the quit sequence.
 * Used by auto-update fallback to determine if quit was triggered.
 * REBEL-4X: Also delegates to shutdownState for services that need cycle-free import.
 */
export function isShuttingDown(): boolean {
  return isQuitting || isShuttingDownState();
}

/**
 * Mark the current exit as clean.
 * Used by auto-update fallback to prevent false positive crash recovery prompts
 * when forcing exit after timeout.
 */
export function markCleanExit(): void {
  getCleanExitStore().set('cleanExit', true);
}

/**
 * Re-arm clean-exit tracking when an update handoff fails and the app keeps running.
 */
export function rearmCleanExitFlagAfterFailedUpdate(): void {
  getCleanExitStore().set('cleanExit', false);
}

export interface NativeWatcherUpdateCleanupResult {
  completed: boolean;
  restore: () => void;
}

/**
 * Close native-backed watchers before macOS ShipIt takes over update installation.
 *
 * This intentionally runs before removeBeforeQuitHandlerForUpdate(); after that point
 * the normal before-quit shutdown path is disarmed for ShipIt compatibility.
 * See docs-private/investigations/260610_auto_update_error_and_unclean_shutdown.md.
 */
export async function closeNativeWatchersForUpdate(
  timeoutMs = 5000,
): Promise<NativeWatcherUpdateCleanupResult> {
  const workspaceDirectory = workspaceWatcherService.getCurrentDirectory();
  const tokenRelayConnection = cloudTokenRelay.getConnection();
  let restored = false;

  // Safe even when a timed-out stop() is still in flight: the watcher services'
  // start()/stop() teardown guards (DI-23 F1/F2) preserve a superseding start().
  const restore = (): void => {
    if (restored) return;
    restored = true;

    if (workspaceDirectory) {
      try {
        workspaceWatcherService.start(workspaceDirectory);
      } catch (error) {
        logger.warn({ err: error, workspaceDirectory }, 'Failed to restore workspace watcher after update failure');
      }

      try {
        libraryBroadcaster.start();
      } catch (error) {
        logger.warn({ err: error }, 'Failed to restore library broadcaster after update failure');
      }
    }

    if (tokenRelayConnection) {
      try {
        cloudTokenRelay.start(tokenRelayConnection.cloudUrl, tokenRelayConnection.cloudToken);
      } catch (error) {
        logger.warn({ err: error }, 'Failed to restore cloud token relay after update failure');
      }
    }
  };

  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  const cleanupPromise = (async (): Promise<'completed'> => {
    try {
      libraryBroadcaster.stop();
    } catch (error) {
      logger.warn({ err: error }, 'Native watcher cleanup for update failed to stop library broadcaster');
    }

    const results = await Promise.allSettled([
      workspaceWatcherService.stop(),
      cloudTokenRelay.stop(),
    ]);

    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        logger.warn(
          { err: result.reason, service: index === 0 ? 'workspaceWatcher' : 'cloudTokenRelay' },
          'Native watcher cleanup for update failed',
        );
      }
    }

    return 'completed';
  })();

  const outcome = await Promise.race([cleanupPromise, timeoutPromise]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  if (outcome === 'timeout') {
    logger.error(
      { timeoutMs },
      'native watcher cleanup timed out before update quit; crash risk remains',
    );
    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: {
        transition: 'native_watcher_cleanup_timeout',
        platform: process.platform as 'darwin' | 'win32' | 'linux',
        timeoutMs,
      },
    });
    return { completed: false, restore };
  }

  return { completed: true, restore };
}

/**
 * Perform graceful shutdown of services only (no app.exit).
 * Used for operations that need all file handles released before continuing,
 * such as workspace rename.
 */
export async function gracefulShutdownServicesOnly(): Promise<void> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Graceful shutdown timed out after ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms`));
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  });

  try {
    await Promise.race([shutdownInternal(), timeoutPromise]);
  } catch (error) {
    logger.warn({ err: error }, 'Graceful shutdown services did not complete in time');
  }
}

/**
 * Remove the before-quit handler to allow Squirrel.Mac to proceed with update installation.
 *
 * CRITICAL FOR MACOS UPDATES: The before-quit handler's event.preventDefault() interferes
 * with Squirrel.Mac's ShipIt daemon. ShipIt runs as a separate process and needs the app
 * to quit cleanly without async interference.
 *
 * This function should be called BEFORE autoUpdater.quitAndInstall() on macOS.
 * After calling this, use autoUpdater.on('before-quit-for-update') for any cleanup,
 * then call app.exit() to ensure the app quits.
 *
 * See: docs/plans/finished/260131_auto_update_shipit_cache_corruption.md
 * See: https://github.com/electron-userland/electron-builder/issues/8997
 */
export function removeBeforeQuitHandlerForUpdate(): void {
  if (beforeQuitHandler) {
    getElectronModule()?.app?.removeListener('before-quit', beforeQuitHandler);
    logger.info('[UPDATE] Removed before-quit handler for Squirrel.Mac update');
  }

  // Also set the flags so any remaining handlers know we're quitting for update
  isQuittingForUpdate = true;
  isQuitting = true;
  setShuttingDown();
}

/**
 * Perform graceful shutdown cleanup for updates (without app.exit).
 * Used by autoUpdateService before quitAndInstall to clean up services.
 */
export async function gracefulShutdownForUpdate(): Promise<void> {
  logger.info('[UPDATE] Starting graceful shutdown for update');
  markCleanExit();

  try {
    // Release single-instance lock early
    getElectronModule()?.app?.releaseSingleInstanceLock();
    logger.info('[UPDATE] Released single-instance lock');
  } catch (error) {
    logger.warn({ err: error }, '[UPDATE] Failed to release single-instance lock');
  }

  // Perform service cleanup with timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Graceful shutdown for update timed out after ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms`));
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  });

  try {
    await Promise.race([shutdownInternal(), timeoutPromise]);
    logger.info('[UPDATE] Graceful shutdown for update completed');
  } catch (error) {
    logger.warn({ err: error }, '[UPDATE] Graceful shutdown for update did not complete in time');
  }
}

/**
 * Export graceful shutdown for programmatic use (e.g., in tests or IPC handlers).
 */
export { gracefulShutdown };

/**
 * Snapshot of main-process supervision counters for the diagnostic bundle.
 * Reads the existing clean-exit-flag store — no second persistence layer.
 * Returns `undefined` when the store is unreadable.
 *
 * Crash counts in the 24h / 7d windows are recomputed at call time from
 * the rolling `recentCrashes` buffer so they always reflect "now", not
 * "the count when the last crash happened".
 */
export function getProcessSupervisionSnapshot(now: () => number = Date.now): import('@core/services/diagnostics/manifest').ProcessSupervisionSnapshot | undefined {
  try {
    const recent = getCleanExitStore().get('recentCrashes', []) ?? [];
    const timestamps = Array.isArray(recent)
      ? recent.filter((ts): ts is number => typeof ts === 'number' && Number.isFinite(ts) && ts > 0)
      : [];
    const nowMs = now();
    const dayAgo = nowMs - 24 * 60 * 60 * 1000;
    const weekAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
    const crashesInLast24h = timestamps.filter((ts) => ts >= dayAgo).length;
    const crashesInLast7Days = timestamps.filter((ts) => ts >= weekAgo).length;
    const lastCrashAt = timestamps.length > 0 ? Math.max(...timestamps) : undefined;
    return {
      lastShutdownClean: wasCleanExitOnStartup,
      totalCrashesAllTime: timestamps.length,
      crashesInLast24h,
      crashesInLast7Days,
      ...(lastCrashAt !== undefined && { lastCrashAt }),
    };
  } catch (error) {
    logger.warn({ err: error }, 'Failed to read process supervision snapshot');
    return undefined;
  }
}
