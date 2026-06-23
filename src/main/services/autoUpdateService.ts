/**
 * Auto-Update Service
 *
 * Platform-split auto-update implementation:
 * - macOS: Uses `update-electron-app` with Squirrel.Mac (unchanged)
 * - Windows: Uses `electron-updater` with NSIS for improved reliability
 *
 * Features:
 * - State machine for update lifecycle (Windows)
 * - Comprehensive error categorization
 * - Enterprise SSL inspection support via win-ca (Windows)
 * - Graceful shutdown integration with cleanup coordinator
 * - Download progress events (Windows)
 *
 * @see docs/plans/partway/260127_Auto_Update_Migration.md
 */

import { app, autoUpdater, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { fireAndForget } from '@shared/utils/fireAndForget';
import * as path from 'path';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger, logger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { getDataPath } from '@core/utils/dataPaths';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { trackMainEvent, getOrGenerateAnonymousId } from '../analytics';
import {
  setQuittingForUpdate,
  clearQuittingForUpdate,
  closeNativeWatchersForUpdate,
  markCleanExit,
  rearmCleanExitFlagAfterFailedUpdate,
  removeBeforeQuitHandlerForUpdate,
  gracefulShutdownForUpdate as _gracefulShutdownForUpdate,
  gracefulShutdownServicesOnly,
  isShuttingDown as _isShuttingDown,
} from './gracefulShutdown';
import { immediateExitWithFseventsSweep } from './finalExit';
import { captureNativeLivenessSnapshot } from './nativeLivenessSnapshot';
import {
  emitQuitDeadlockDetected,
  scheduleWindowsForceExitFallback,
} from './quitDeadlockTelemetry';
import { isUpdateDownloading, setUpdateDownloading } from './autoUpdateState';
import { getBuildChannel } from '@main/utils/buildChannel';
import { getNativeArch } from '@main/utils/nativeArch';
import {
  acknowledgeDownloadedUpdate,
  clearPendingDownloadedUpdate,
  getPendingDownloadedUpdate,
  getPendingDownloadedUpdateForRenderer,
  getUpdatePrimaryWindow,
  setPendingDownloadedUpdate,
} from './updateNotificationState';
import {
  updateAutoUpdateState,
  updateAutoUpdateStateChecked,
  getAutoUpdateState,
  type AutoUpdateState,
} from './autoUpdateStateStore';
import { markUpdateInstallRequested } from './updateInstallMarker';
import { createPausableInterval } from './visibilityAwareScheduler';
import { isRebelTestMode, isHeadlessCli } from '../utils/testIsolation';
import os from 'node:os';

// ============================================================================
// Types & State
// ============================================================================

/**
 * Update lifecycle states for Windows electron-updater.
 * Provides visibility into the current state of the update process.
 */
export type UpdateState =
  | 'IDLE'
  | 'CHECKING'
  | 'AVAILABLE'
  | 'DOWNLOADING'
  | 'DOWNLOADED'
  | 'INSTALLING'
  | 'ERROR';

/**
 * Error categories for comprehensive error handling and logging.
 */
export type UpdateErrorCategory =
  | 'network' // Connection failures, DNS issues, timeouts
  | 'signature' // Code signing verification failures
  | 'permission' // File access denied, UAC issues
  | 'lock' // File in use, another installer running
  | 'disk' // Disk full, write errors
  | 'parse' // Malformed update metadata
  | 'ssl' // Certificate validation errors (enterprise proxies)
  | 'no-update' // Benign: no newer version available (e.g. quit-and-install raced a no-update result)
  | 'unknown';

export interface UpdateError {
  category: UpdateErrorCategory;
  message: string;
  originalError?: Error;
  retryable: boolean;
}

let inFlightManualUpdateCheck: Promise<{ available: boolean; version?: string; error?: string }> | null = null;

// Track update state (primarily for Windows electron-updater)
let currentUpdateState: UpdateState = 'IDLE';

const sentryReportedUpdateErrorCategories = new Set<UpdateErrorCategory>();

let updatePromptIpcRegistered = false;

// Windows retry configuration for lock errors (EBUSY, file in use, etc.)
const WINDOWS_LOCK_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000, // 1s, 2s, 4s with exponential backoff
} as const;

/**
 * Retry configuration for post-update file verification.
 * Handles transient AV-induced file access delays on Windows.
 * Total max wait: 1s + 2s + 4s = 7 seconds
 */
const POST_UPDATE_VERIFY_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
} as const;

export { isUpdateDownloading };

/**
 * Get the current update state (Windows only, for debugging/UI).
 */
export function getUpdateState(): UpdateState {
  return currentUpdateState;
}

// ============================================================================
// Error Categorization
// ============================================================================

/**
 * Categorize update errors for logging and retry decisions.
 */
export function categorizeError(error: Error | unknown): UpdateError {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  // Network errors
  if (
    lowerMessage.includes('enotfound') ||
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('etimedout') ||
    lowerMessage.includes('network') ||
    lowerMessage.includes('getaddrinfo') ||
    lowerMessage.includes('offline') ||
    lowerMessage.includes('internet connection appears to be offline')
  ) {
    return {
      category: 'network',
      message,
      originalError: error instanceof Error ? error : undefined,
      retryable: true,
    };
  }

  // SSL/Certificate errors (common in enterprise environments)
  if (
    lowerMessage.includes('unable_to_get_issuer_cert') ||
    lowerMessage.includes('self_signed_cert') ||
    lowerMessage.includes('certificate') ||
    lowerMessage.includes('ssl') ||
    lowerMessage.includes('tls')
  ) {
    return {
      category: 'ssl',
      message,
      originalError: error instanceof Error ? error : undefined,
      retryable: false, // Requires system CA loading or IT intervention
    };
  }

  // Signature/verification errors
  if (
    lowerMessage.includes('signature') ||
    lowerMessage.includes('sha512') ||
    lowerMessage.includes('checksum') ||
    lowerMessage.includes('verification failed')
  ) {
    return {
      category: 'signature',
      message,
      originalError: error instanceof Error ? error : undefined,
      retryable: false, // Security issue, don't retry
    };
  }

  const hasAppleAuthorizationFailure =
    /(?:^|[^\d])-6000[68](?:[^\d]|$)/.test(message) ||
    /\berrauthorization[a-z]*\b/i.test(message) ||
    /\bauthorization\b[\s\S]{0,120}\bosstatus\b/i.test(message) ||
    /\bosstatus\b[\s\S]{0,120}\bauthorization\b/i.test(message) ||
    /\bcommand is disabled and cannot be executed\b/i.test(message);

  // Permission errors
  if (
    lowerMessage.includes('eperm') ||
    lowerMessage.includes('eacces') ||
    lowerMessage.includes('access denied') ||
    lowerMessage.includes('permission') ||
    lowerMessage.includes('read-only volume') ||
    lowerMessage.includes('read-only') ||
    lowerMessage.includes('move the application') ||
    hasAppleAuthorizationFailure
  ) {
    return {
      category: 'permission',
      message,
      originalError: error instanceof Error ? error : undefined,
      retryable: false, // Requires user/admin intervention
    };
  }

  // Lock/in-use errors (common on Windows)
  if (
    lowerMessage.includes('ebusy') ||
    lowerMessage.includes('lock') ||
    lowerMessage.includes('in use') ||
    lowerMessage.includes('another instance')
  ) {
    return {
      category: 'lock',
      message,
      originalError: error instanceof Error ? error : undefined,
      retryable: true, // May resolve on next attempt
    };
  }

  // Disk errors
  if (
    lowerMessage.includes('enospc') ||
    lowerMessage.includes('disk full') ||
    lowerMessage.includes('no space')
  ) {
    return {
      category: 'disk',
      message,
      originalError: error instanceof Error ? error : undefined,
      retryable: false, // Requires user to free space
    };
  }

  // Parse errors (malformed metadata)
  if (
    lowerMessage.includes('parse') ||
    lowerMessage.includes('json') ||
    lowerMessage.includes('yaml') ||
    lowerMessage.includes('malformed')
  ) {
    return {
      category: 'parse',
      message,
      originalError: error instanceof Error ? error : undefined,
      retryable: false, // Server-side issue
    };
  }

  // No-update race (benign): a quit-and-install path fired when there is
  // genuinely no newer version. Non-retryable — retrying cannot conjure an
  // update — but explicitly benign so it stops polluting the `unknown` bucket
  // (REBEL-681). Kept after every failure-shaped matcher so a real error that
  // happens to mention "no update available" still wins its specific category.
  if (lowerMessage.includes('no update available')) {
    return {
      category: 'no-update',
      message,
      originalError: error instanceof Error ? error : undefined,
      retryable: false,
    };
  }

  // Default: unknown
  return {
    category: 'unknown',
    message,
    originalError: error instanceof Error ? error : undefined,
    retryable: true,
  };
}

const NON_RETRYABLE_UPDATE_ERROR_CATEGORIES = new Set<UpdateErrorCategory>([
  'ssl',
  'signature',
  'permission',
  'disk',
  'parse',
  'no-update',
]);

export function shouldNotifyRendererForUpdateError(category: UpdateErrorCategory): boolean {
  return category === 'permission';
}

export function shouldCaptureUpdateFailureForSentry(category: UpdateErrorCategory): boolean {
  // 'no-update' is a benign install-race ("No update available, can't quit and
  // install") — non-retryable (retrying a no-op cannot help) but NOT worth a
  // Sentry event. Categorising it (vs the old 'unknown') is precisely so it
  // stops minting misleading update-failure issues (REBEL-681), so exclude it
  // from capture explicitly rather than let the non-retryable coupling re-capture it.
  if (category === 'no-update') return false;
  return category === 'unknown' || NON_RETRYABLE_UPDATE_ERROR_CATEGORIES.has(category);
}

export function _resetUpdateFailureSentryRateLimitForTesting(): void {
  sentryReportedUpdateErrorCategories.clear();
}

function captureAutoUpdateFailureForSentry(
  categorized: UpdateError,
  platform: NodeJS.Platform,
  appVersion: string,
): void {
  if (!shouldCaptureUpdateFailureForSentry(categorized.category)) {
    return;
  }
  if (sentryReportedUpdateErrorCategories.has(categorized.category)) {
    return;
  }
  sentryReportedUpdateErrorCategories.add(categorized.category);

  try {
    getErrorReporter().captureMessage('auto-update failure', {
      level: 'warning',
      tags: {
        'update.errorCategory': categorized.category,
        'update.platform': platform,
        'update.appVersion': appVersion,
      },
      fingerprint: ['auto-update-failure', platform, categorized.category],
      extra: {
        errorMessage: categorized.message,
        retryable: categorized.retryable,
      },
    });
  } catch (error) {
    logger.warn({
      platform,
      category: categorized.category,
      error: error instanceof Error ? error.message : String(error),
    }, '[UPDATE] Failed to capture auto-update failure');
  }
}

export function _captureAutoUpdateFailureForSentryForTesting(
  categorized: UpdateError,
  platform: NodeJS.Platform,
  appVersion: string,
): void {
  captureAutoUpdateFailureForSentry(categorized, platform, appVersion);
}

const UPDATE_FAILURE_NOTIFIED_FILENAME = 'app-update-failure-notified.json';

/**
 * Pure decision: surface a user-facing "couldn't install the update" message
 * only for the non-retryable permission/authorization failure class — the
 * duplicate-copy / running-outside-Applications root cause (Apple Authorization
 * Services "command is disabled", REBEL-68D) — and only once per app version so
 * we don't nag on every hourly check. Other categories stay silent here.
 */
export function shouldSurfaceUpdateFailureToUser(
  category: UpdateError['category'],
  retryable: boolean,
  alreadyNotifiedThisVersion: boolean,
): boolean {
  return category === 'permission' && retryable === false && !alreadyNotifiedThisVersion;
}

async function readUpdateFailureNotifiedVersion(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(getDataPath(), UPDATE_FAILURE_NOTIFIED_FILENAME), 'utf-8');
    const v = (JSON.parse(raw) as { version?: string }).version;
    return typeof v === 'string' ? v : null;
  } catch (err) {
    ignoreBestEffortCleanup(err, {
      operation: 'autoUpdate.readFailureNotified',
      reason: 'No prior update-failure-notified marker; treat as not-yet-notified',
    });
    return null;
  }
}

async function markUpdateFailureNotified(version: string): Promise<void> {
  try {
    const filePath = path.join(getDataPath(), UPDATE_FAILURE_NOTIFIED_FILENAME);
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version, at: Date.now() }, null, 2), 'utf-8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    logger.warn({ err }, '[UPDATE] Failed to persist update-failure-notified marker');
  }
}

/**
 * One-time-per-version native message for a non-retryable permission/authz
 * install failure: names the likely cause (more than one copy of Rebel, or
 * running from outside Applications) and the fix, instead of failing silently.
 * Never throws.
 */
export async function maybeSurfaceUpdateFailureToUser(categorized: UpdateError): Promise<boolean> {
  try {
    const version = app.getVersion();
    const notifiedVersion = await readUpdateFailureNotifiedVersion();
    if (
      !shouldSurfaceUpdateFailureToUser(categorized.category, categorized.retryable, notifiedVersion === version)
    ) {
      return false;
    }
    await app.whenReady();
    const choice = await dialog.showMessageBox({
      type: 'warning',
      title: "Rebel couldn't install the update",
      message: 'The update downloaded but could not be installed.',
      detail:
        "This usually means there's more than one copy of Rebel on your Mac, or it's running from " +
        'outside the Applications folder. Keep one copy in Applications, move any others to the Trash, ' +
        'then reopen Rebel.',
      buttons: ['Open Applications Folder', 'Close'],
      defaultId: 0,
      cancelId: 1,
    });
    // Mark only after we've actually shown the dialog, so a failed/throwing
    // dialog doesn't silently suppress the next version's notification.
    await markUpdateFailureNotified(version);
    if (choice.response === 0) {
      await shell.openPath('/Applications');
    }
    return true;
  } catch (err) {
    ignoreBestEffortCleanup(err, {
      operation: 'autoUpdate.surfaceFailureToUser',
      reason: 'User-facing update-failure notice is best-effort; never throw from the failure path',
      severity: 'warn',
    });
    return false;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Register prompt-side IPC handlers (get-pending-downloaded / acknowledge).
 * Exported so tests can register the handlers in isolation without spinning
 * up the full `initAutoUpdater()` machinery.
 */
export function registerUpdatePromptIpcHandlers(): void {
  if (updatePromptIpcRegistered) {
    return;
  }
  updatePromptIpcRegistered = true;

  ipcMain.handle('update:get-pending-downloaded', async (_event, request?: { ignoreAck?: boolean }) => {
    const pending = request?.ignoreAck
      ? getPendingDownloadedUpdate()
      : getPendingDownloadedUpdateForRenderer();
    // REBEL-53B: surface the silent auto-heal counter for the current
    // pending updateKey so `UpdateAvailableToast` can adapt its copy
    // ("Previous install didn't take") + show a "Download directly"
    // affordance after one silent retry has already fired. The persisted
    // `stuckInstall` field is intentionally NOT exposed here — the bespoke
    // recovery dialog is gone; the toast is the single update-related
    // surface.
    let recoveryAttempts = 0;
    if (pending?.updateKey) {
      try {
        const map = getAutoUpdateState().recoveryAttempts ?? {};
        recoveryAttempts = map[pending.updateKey] ?? 0;
      } catch {
        // Defensive: getAutoUpdateState wraps reads in try/catch but in
        // case a future refactor changes that, fail-closed to "no
        // recovery attempts".
        recoveryAttempts = 0;
      }
    }
    return { pending, recoveryAttempts };
  });

  ipcMain.handle('update:acknowledge', async (_event, request: { updateKey: string }) => {
    if (request?.updateKey) {
      acknowledgeDownloadedUpdate(request.updateKey);
      return { acknowledged: true };
    }
    return { acknowledged: false };
  });
}

// ============================================================================
// REBEL-53B: silent auto-heal for stuck installs
// ============================================================================
//
// See docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md.
//
// Replaces the bespoke recovery dialog (deleted; commit `f9adb3848`
// introduced it, the user redirected to the toast surface). The reconciler
// calls `silentAutoHealStuckInstall(updateKey)` once per `updateKey` when it
// detects a stuck install. The function:
//   1. Reads `recoveryAttempts[updateKey]` from the auto-update state store.
//   2. If the counter is `>= 1` → no-op (don't loop silently).
//   3. macOS only: clears `~/Library/Caches/<bundleId>.ShipIt/` (best-effort).
//   4. Resets `pendingDownloadedUpdate` so the new download isn't conflated
//      with the failed one.
//   5. Triggers `autoUpdater.checkForUpdates()` (Windows uses the
//      electron-updater ref). Fire-and-forget — the existing init-time
//      `update-downloaded` listener surfaces `UpdateAvailableToast` when
//      ready.
//   6. Bumps `recoveryAttempts[updateKey]` via `updateAutoUpdateStateChecked`.
//      Persistence failures are logged at warn but do NOT block the recovery.
//   7. Schedules a 60-second deferred check; if `getPendingDownloadedUpdate()`
//      still returns null, emits `'Auto-Update Recovery Stranded'` analytics
//      so canary triage can spot the H2/H5 edge case (genuinely-stuck user
//      whose fresh `checkForUpdates()` returned no replacement download).
// ============================================================================

const recoveryLog = createScopedLogger({ service: 'autoUpdateRecovery' });

/**
 * Module-level reference to the electron-updater singleton, set by
 * `initWindowsAutoUpdater()`. Used by `silentAutoHealStuckInstall()` so the
 * Windows recovery path can call `checkForUpdates()` on the same instance
 * the rest of the auto-updater pipeline uses.
 *
 * Stays `null` on macOS/Linux and in dev/test contexts where Windows init
 * never runs.
 */
let electronUpdaterRef: typeof import('electron-updater').autoUpdater | null = null;

/**
 * Test-only injector for `electronUpdaterRef`.
 * Exported so unit tests can exercise the Windows auto-heal path without
 * spinning up the real Windows init. Not for production use.
 */
export function _setElectronUpdaterForTesting(
  ref: typeof import('electron-updater').autoUpdater | null,
): void {
  electronUpdaterRef = ref;
}

/**
 * Read the silent auto-heal counter for a given updateKey from the
 * persistent state store. Defensive — returns 0 if the read throws (corrupt
 * JSON, unexpected schema), so push payloads never break a download
 * notification.
 *
 * Used by the `update:downloaded` push sites (Windows + macOS) so the
 * renderer's `UpdateAvailableToast` adapts its copy ("Previous install
 * didn't take") regardless of whether the renderer first hears about the
 * pending update via the push event or the mount-time pull
 * (`update:get-pending-downloaded`). Without this, the push payload would
 * default to `recoveryAttempts: 0` and the dedup ref in
 * `useIpcListeners` would block the later (correct) pull payload.
 *
 * Exported (with underscore prefix) only for unit testing — the helper is
 * an internal implementation detail of the push-payload assembly.
 */
export function _readRecoveryAttemptsForTesting(updateKey: string): number {
  return readRecoveryAttempts(updateKey);
}

function readRecoveryAttempts(updateKey: string): number {
  try {
    const map = getAutoUpdateState().recoveryAttempts ?? {};
    return map[updateKey] ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Resolve the bundle ID for ShipIt cache lookup.
 * Falls back to the package.json `build.appId` constant if `app.getBundleId`
 * is unavailable (dev / unpackaged / non-darwin contexts).
 */
function resolveBundleIdForRecovery(): string {
  try {
    const fn = (app as unknown as { getBundleId?: () => string }).getBundleId;
    if (typeof fn === 'function') {
      const bundleId = fn.call(app);
      if (typeof bundleId === 'string' && bundleId.length > 0) return bundleId;
    }
  } catch {
    // fall through
  }
  return 'com.mindstone.rebel';
}

export interface SilentAutoHealResult {
  attempted: boolean;
  reason?: 'exhausted' | 'completed' | 'no-update-key';
}

/**
 * Best-effort silent recovery for a stuck install. Called from the
 * reconciler at startup; safe to call from anywhere on the main process.
 *
 * Bounded once per `updateKey` via `recoveryAttempts`. Re-entrant calls for
 * the same key short-circuit with `{ attempted: false, reason: 'exhausted' }`.
 *
 * Errors at any step are logged structured + swallowed — auto-heal is
 * supposed to be silent. If the silent attempt doesn't produce a fresh
 * download, the user still sees the existing `UpdateAvailableToast` (which
 * adapts its copy when `recoveryAttempts[updateKey] >= 1`).
 */
export async function silentAutoHealStuckInstall(updateKey: string): Promise<SilentAutoHealResult> {
  if (!updateKey || updateKey.length === 0) {
    recoveryLog.warn({}, '[UPDATE-RECOVERY] silentAutoHealStuckInstall called without updateKey');
    return { attempted: false, reason: 'no-update-key' };
  }

  // 1. Counter check — never loop silently.
  let priorAttempts = 0;
  let priorMap: Record<string, number> = {};
  try {
    const state = getAutoUpdateState();
    priorMap = state.recoveryAttempts ?? {};
    priorAttempts = priorMap[updateKey] ?? 0;
  } catch (err) {
    // Defensive: if the read throws (corrupt JSON), proceed conservatively
    // as if no prior attempts had been recorded. The bump below will fail
    // identically and we won't re-attempt.
    recoveryLog.warn({ err }, '[UPDATE-RECOVERY] silentAutoHeal: state read threw; assuming 0');
  }

  if (priorAttempts >= 1) {
    recoveryLog.info(
      { updateKey, priorAttempts },
      '[UPDATE-RECOVERY] silentAutoHeal: counter exhausted, no second silent retry',
    );
    return { attempted: false, reason: 'exhausted' };
  }

  // 2. macOS: clear ShipIt cache. Best-effort.
  if (process.platform === 'darwin') {
    try {
      const bundleId = resolveBundleIdForRecovery();
      const cachePath = path.join(os.homedir(), 'Library', 'Caches', `${bundleId}.ShipIt`);
      await fs.rm(cachePath, { recursive: true, force: true });
      recoveryLog.info(
        { cachePath, updateKey },
        '[UPDATE-RECOVERY] silentAutoHeal: cleared ShipIt cache',
      );
    } catch (err) {
      // Don't throw — auto-heal is best-effort.
      recoveryLog.warn(
        { err, updateKey },
        '[UPDATE-RECOVERY] silentAutoHeal: failed to clear ShipIt cache (continuing)',
      );
    }
  }
  // Windows / Linux: no ShipIt cache. Skip step 2.

  // 3. Reset pending download so the fresh check is unambiguous.
  try {
    clearPendingDownloadedUpdate();
  } catch (err) {
    recoveryLog.warn(
      { err, updateKey },
      '[UPDATE-RECOVERY] silentAutoHeal: failed to reset pendingDownloadedUpdate (continuing)',
    );
  }

  // 4. Trigger a fresh update check. Fire-and-forget — the init-time
  // update-downloaded listener will broadcast to the renderer when ready.
  try {
    if (process.platform === 'win32' && electronUpdaterRef) {
      void electronUpdaterRef.checkForUpdates().catch((err: unknown) => {
        recoveryLog.warn(
          { err, updateKey },
          '[UPDATE-RECOVERY] silentAutoHeal: electronUpdater.checkForUpdates rejected (continuing)',
        );
      });
    } else if (process.platform === 'win32') {
      recoveryLog.warn(
        { updateKey },
        '[UPDATE-RECOVERY] silentAutoHeal: Windows electronUpdaterRef is null; skipping checkForUpdates',
      );
    } else {
      autoUpdater.checkForUpdates();
    }
  } catch (err) {
    recoveryLog.warn(
      { err, updateKey },
      '[UPDATE-RECOVERY] silentAutoHeal: checkForUpdates threw (continuing)',
    );
  }

  // 5. Bump the counter. If persistence fails, log + continue — the next
  // startup will read the unchanged counter and may attempt again, which
  // is acceptable degraded behaviour for a best-effort path.
  const writeResult = updateAutoUpdateStateChecked({
    recoveryAttempts: { ...priorMap, [updateKey]: priorAttempts + 1 },
  });
  if (!writeResult.ok) {
    recoveryLog.warn(
      { err: writeResult.error, updateKey },
      '[UPDATE-RECOVERY] silentAutoHeal: failed to persist recoveryAttempts (continuing)',
    );
  }

  // Analytics best-effort.
  try {
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'Auto-Update Silent Auto-Heal Triggered',
      properties: {
        platform: process.platform as 'darwin' | 'win32' | 'linux',
        arch: process.arch,
        updateKey,
        priorAttempts,
      },
    });
  } catch (err) {
    recoveryLog.warn({ err, updateKey }, '[UPDATE-RECOVERY] silentAutoHeal: analytics emit failed');
  }

  // 6. Stranded-path canary. We cleared the pending download (step 3) and
  // triggered a fresh check (step 4); if 60s later there's still nothing
  // pending, the user has no UI surface — the genuinely-stuck-but-server-
  // returned-no-update edge case (REBEL-53B/C follow-up H2/H5). Emit a
  // dedicated analytics event so canary triage can spot this without
  // waiting for user complaints. Skipped under tests/CI to avoid leaking
  // timers across vitest runs.
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
    setTimeout(() => {
      try {
        if (getPendingDownloadedUpdate() != null) return;
        trackMainEvent({
          anonymousId: getOrGenerateAnonymousId(),
          event: 'Auto-Update Recovery Stranded',
          properties: {
            platform: process.platform as 'darwin' | 'win32' | 'linux',
            arch: process.arch,
            updateKey,
            priorAttempts,
          },
        });
        recoveryLog.warn(
          { updateKey, priorAttempts },
          '[UPDATE-RECOVERY] silentAutoHeal: stranded — no fresh download surfaced within 60s',
        );
      } catch (err) {
        recoveryLog.warn(
          { err, updateKey },
          '[UPDATE-RECOVERY] silentAutoHeal: stranded-path emit failed',
        );
      }
    }, 60_000).unref?.();
  }

  return { attempted: true, reason: 'completed' };
}

/**
 * Reset the prompt-handler registration flag so tests can re-register
 * `update:get-pending-downloaded` / `update:acknowledge` handlers across
 * test cases. NOT for production use.
 */
export function _resetUpdatePromptIpcRegistrationForTesting(): void {
  updatePromptIpcRegistered = false;
}

function describeUpdateRuntime(updateUrl: string, channel: 'beta' | 'stable', nativeArch: string) {
  return {
    channel,
    updateUrl,
    nativeArch,
    platform: process.platform as 'darwin' | 'win32' | 'linux',
    runningArch: process.arch,
    appVersion: app.getVersion(),
    appName: app.getName(),
    exeName: path.basename(process.execPath),
  };
}

function describeWindowForUpdateLog(window: BrowserWindow | null) {
  if (!window) {
    return { hasWindow: false };
  }

  const isDestroyed = window.isDestroyed();
  const wcDestroyed = isDestroyed ? true : window.webContents.isDestroyed();

  return {
    hasWindow: true,
    windowId: window.id,
    isDestroyed,
    isVisible: isDestroyed ? false : window.isVisible(),
    isFocused: isDestroyed ? false : window.isFocused(),
    webContentsId: wcDestroyed ? undefined : window.webContents.id,
    isWebContentsDestroyed: wcDestroyed,
  };
}

/**
 * Pino-backed logger adapter for the auto-update system.
 * - `.log()` is required by the `update-electron-app` library (variadic legacy style).
 * - `.info()`, `.warn()`, `.error()`, `.debug()` are used by our own update code.
 */
interface UpdateLogger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

/**
 * Create a pino-backed logger adapter for the auto-update system.
 * The `.log()` method tags messages with `{ source: 'update-electron-app' }` to
 * distinguish library-originated logs from our own.
 */
function createUpdateLogger(): UpdateLogger {
  const scoped = createScopedLogger({ service: 'auto-update' });

  const makeLogMethod = (level: 'info' | 'warn' | 'error' | 'debug') =>
    (...args: unknown[]): void => {
      try {
        const [first, ...rest] = args;
        if (typeof first === 'string') {
          const second = rest[0];
          if (second instanceof Error) {
            scoped[level]({ err: second }, first);
          } else if (rest.length === 1 && typeof second === 'object' && second !== null) {
            scoped[level](second as Record<string, unknown>, first);
          } else {
            scoped[level]({}, first);
          }
        } else {
          scoped[level](
            typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {},
            rest.map(String).join(' ')
          );
        }
      } catch {
        // Never let logging crash the updater.
        try { console.error('[auto-update] Logger error in', level, ...args); } catch { /* ignore */ }
      }
    };

  return {
    log: (...args: unknown[]): void => {
      try {
        // The library calls logger.log() with variadic args (first arg can be string or object)
        const message = args.map((a) => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        scoped.info({ source: 'update-electron-app' }, `[updater-lib] ${message}`);
      } catch {
        // Never let logging crash the updater.
        try { console.error('[auto-update] Logger error in log', ...args); } catch { /* ignore */ }
      }
    },
    info: makeLogMethod('info'),
    warn: makeLogMethod('warn'),
    error: makeLogMethod('error'),
    debug: makeLogMethod('debug'),
  };
}

function parseSemverFromReleaseName(releaseName: string | null | undefined): string | undefined {
  if (!releaseName) {
    return undefined;
  }
  // Preserve prerelease/build metadata (e.g. 1.2.3-beta.4+12) to avoid updateKey collisions.
  const match = releaseName.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/);
  return match?.[1];
}

const safeSendToWindow = (window: BrowserWindow, channel: string, payload: unknown): boolean => {
  if (window.isDestroyed()) {
    return false;
  }
  if (window.webContents.isDestroyed()) {
    return false;
  }
  try {
    window.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
};

/**
 * Sleep for a specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is a transient file access error that may resolve with retry.
 * Used during post-update verification when AV may be scanning newly extracted files.
 * 
 * NOTE: We intentionally do NOT include ENOENT here. While AV scanning can delay
 * file visibility, ENOENT is more commonly "file genuinely doesn't exist" which
 * won't resolve with retry. EBUSY/EAGAIN/EPERM indicate active locks that will release.
 */
function isTransientFileAccessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // EBUSY: File locked by AV scanner
  // EAGAIN: Resource temporarily unavailable
  // EPERM: Windows Defender can return this when it has an exclusive lock
  return code === 'EBUSY' || code === 'EAGAIN' || code === 'EPERM';
}

/**
 * Execute a file access operation with retry logic for Windows AV interference.
 * Only retries on transient errors that may resolve when AV scan completes.
 *
 * @param operation - The async operation to retry
 * @param operationName - Name for logging
 * @returns Result of the operation
 * @throws Last error if all retries exhausted
 */
async function withFileAccessRetry<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  // Only use retry on Windows where AV interference is the issue
  if (process.platform !== 'win32') {
    return operation();
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= POST_UPDATE_VERIFY_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Only retry on transient errors
      if (!isTransientFileAccessError(error)) {
        throw error;
      }

      // Check if we have retries left
      if (attempt < POST_UPDATE_VERIFY_RETRY_CONFIG.maxRetries) {
        const delayMs = POST_UPDATE_VERIFY_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
        logger.warn(
          {
            attempt: attempt + 1,
            maxRetries: POST_UPDATE_VERIFY_RETRY_CONFIG.maxRetries,
            delayMs,
            code: (error as NodeJS.ErrnoException)?.code,
            message: lastError?.message,
            operationName,
          },
          '[POST-UPDATE] File access failed with transient error (likely AV interference), retrying'
        );
        await sleep(delayMs);
      } else {
        logger.error(
          {
            maxRetries: POST_UPDATE_VERIFY_RETRY_CONFIG.maxRetries,
            code: (error as NodeJS.ErrnoException)?.code,
            message: lastError?.message,
            operationName,
          },
          '[POST-UPDATE] File access failed after all retries - AV may have quarantined files'
        );
      }
    }
  }

  throw lastError;
}

/**
 * Retry an async operation with exponential backoff for Windows lock errors.
 * Used during update operations when AV software or other processes hold file locks.
 * 
 * @param operation - The async operation to retry
 * @param operationName - Name for logging purposes
 * @param updateLog - Update logger adapter for structured logging
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted
 */
async function _retryOnLockError<T>(
  operation: () => Promise<T>,
  operationName: string,
  updateLog: UpdateLogger
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt <= WINDOWS_LOCK_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const categorized = categorizeError(error);
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Only retry on lock errors
      if (categorized.category !== 'lock') {
        throw error;
      }
      
      // Check if we have retries left
      if (attempt < WINDOWS_LOCK_RETRY_CONFIG.maxRetries) {
        const delayMs = WINDOWS_LOCK_RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
        updateLog['warn'](`[UPDATE-WIN] ${operationName} failed with lock error, retrying in ${delayMs}ms`, {
          attempt: attempt + 1,
          maxRetries: WINDOWS_LOCK_RETRY_CONFIG.maxRetries,
          category: categorized.category,
          message: categorized.message,
        });
        await sleep(delayMs);
      } else {
        updateLog['error'](`[UPDATE-WIN] ${operationName} failed after ${WINDOWS_LOCK_RETRY_CONFIG.maxRetries} retries`, {
          category: categorized.category,
          message: categorized.message,
        });
      }
    }
  }
  
  throw lastError;
}

// ============================================================================
// Windows: electron-updater Implementation
// ============================================================================

/**
 * Safe quit and install for Windows using electron-updater.
 *
 * CRITICAL: This function:
 * 1. Calls gracefulShutdownServicesOnly() FIRST to release file handles
 * 2. Releases single-instance lock
 * 3. Sets quittingForUpdate flag
 * 4. Then triggers autoUpdater.quitAndInstall()
 *
 * This order is crucial because electron-updater's quitAndInstall() closes
 * windows BEFORE emitting 'before-quit', so we can't rely on event handlers.
 */
async function safeQuitAndInstallWindows(
  electronUpdater: typeof import('electron-updater').autoUpdater,
  updateLog: UpdateLogger
): Promise<{ success: boolean; error?: string }> {
  try {
    currentUpdateState = 'INSTALLING';
    updateLog['info']('[UPDATE-WIN] Initiating safe quit and install');

    // Write install marker so startup can detect stuck updates.
    // Stage 5 of the install completion contract
    // (`docs/plans/260428_install_completion_contract.md`): populate
    // `targetVersion` (the version the user expected to land on) and
    // `updateKey` so the startup reconciliation has a decisive
    // `currentVersion === marker.targetVersion` signal AND a stable key for
    // anti-collision / attemptCount bookkeeping.
    const pending = getPendingDownloadedUpdate();
    if (pending) {
      markUpdateInstallRequested({
        updateKey: pending.updateKey,
        fromVersion: app.getVersion(),
        targetVersion: pending.versionLabel,
        requestedAt: Date.now(),
      });
    }

    // Step 1: Run cleanup coordinator to release file handles
    // This is CRITICAL for Windows where file locks can prevent update
    updateLog['info']('[UPDATE-WIN] Running gracefulShutdownServicesOnly to release file handles');
    try {
      await gracefulShutdownServicesOnly();
      updateLog['info']('[UPDATE-WIN] Cleanup completed successfully');
    } catch (cleanupError) {
      // Log but continue - we still want to try the update
      updateLog['warn']('[UPDATE-WIN] Cleanup had issues but continuing with update', cleanupError);
    }

    // Step 2: Release single-instance lock BEFORE quitAndInstall
    // The new instance spawned by NSIS needs to acquire this lock
    try {
      app.releaseSingleInstanceLock();
      updateLog['info']('[UPDATE-WIN] Released single-instance lock before quitAndInstall');
    } catch (lockError) {
      updateLog['warn']('[UPDATE-WIN] Failed to release single-instance lock', lockError);
      // Continue anyway - fallback in gracefulShutdown will try again
    }

    // Step 3: Set the quitting-for-update flag
    setQuittingForUpdate();

    // Stage 3b false-positive prevention: track whether the quit is genuinely
    // proceeding. electron-updater's quitAndInstall(false, true) closes windows
    // BEFORE emitting before-quit, so we don't rely on the event for ORDERING —
    // but a fired before-quit/will-quit IS positive evidence the quit handoff
    // is underway, which is exactly what gates the force-exit backstop below.
    // Mirrors the macOS Tier-1 `if (!quitEventFired)` guard.
    let quitEventFired = false;
    let forceExitTimer: ReturnType<typeof setTimeout> | undefined;
    const markQuitProceeding = () => {
      quitEventFired = true;
      if (forceExitTimer !== undefined) {
        clearTimeout(forceExitTimer);
        forceExitTimer = undefined;
      }
    };
    app.once('before-quit', markQuitProceeding);
    app.once('will-quit', markQuitProceeding);

    // Step 4: Trigger the install
    // isSilent: false (show NSIS UI), isForceRunAfter: true (relaunch app after install)
    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: { transition: 'install_attempted', platform: process.platform as 'darwin' | 'win32' | 'linux' },
    });
    electronUpdater.quitAndInstall(false, true);

    // Stage 3b: Windows previously had NO force-exit timer here — on Electron
    // ≥41 a hung quitAndInstall left a telemetry-blind deadlock. Mirror the
    // macOS Tier-2 pattern: if the process is still alive after the budget
    // AND the quit is genuinely stuck (no before-quit/will-quit fired), emit
    // `quit_deadlock_detected` (ledger-first + bounded flush) then force-exit
    // via the fsevents-sweeping primitive. The timer is CLEARED on the clean
    // handoff (markQuitProceeding) so a normal-but-slow install is never
    // force-exited mid-install; the in-callback `isStillStuck` gate is the
    // defence-in-depth backstop if a clear is ever missed (timer/event race).
    forceExitTimer = scheduleWindowsForceExitFallback({
      isStillStuck: () => !quitEventFired,
      forceExit: () => {
        updateLog['error']('[UPDATE-WIN] App still alive after force-exit budget, forcing exit for update');
        markCleanExit();
        fireAndForget(
          immediateExitWithFseventsSweep('update-win-fallback', 0),
          'autoUpdateService.windowsForceExit',
        );
      },
    });

    return { success: true };
  } catch (error) {
    updateLog['error']('[UPDATE-WIN] Failed to install update', error);
    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: { transition: 'install_failed', platform: process.platform as 'darwin' | 'win32' | 'linux', errorCategory: categorizeError(error).category },
    });

    // Try to re-acquire lock since we're not actually quitting
    try {
      const reacquired = app.requestSingleInstanceLock();
      if (!reacquired) {
        updateLog['warn']('[UPDATE-WIN] Could not re-acquire single-instance lock after update failure');
      } else {
        updateLog['info']('[UPDATE-WIN] Re-acquired single-instance lock after update failure');
      }
    } catch (reacquireError) {
      updateLog['warn']('[UPDATE-WIN] Error re-acquiring lock', reacquireError);
    }

    clearQuittingForUpdate();
    currentUpdateState = 'ERROR';
    return { success: false, error: String(error) };
  }
}

/**
 * Test seam for the Windows install path — mirrors
 * `_safeQuitAndInstallMacOSForTesting`. Lets a test drive the force-exit
 * backstop wiring (timer armed on entry, CLEARED on a clean handoff, fires
 * only on a simulated past-budget hang) with a mocked electron-updater.
 */
export const _safeQuitAndInstallWindowsForTesting = safeQuitAndInstallWindows;

/**
 * Initialize Windows auto-updater using electron-updater.
 */
async function initWindowsAutoUpdater(): Promise<void> {
  const { autoUpdater: electronUpdater } = await import('electron-updater');
  const updateLog = createUpdateLogger();

  // Stash the electron-updater singleton so `silentAutoHealStuckInstall()`
  // can call `checkForUpdates()` on the same instance without re-importing
  // the module. Set BEFORE event-handler init so it's never observed as
  // null after `initWindowsAutoUpdater()` resolves.
  electronUpdaterRef = electronUpdater;

  // System certificates are loaded in bootstrap.ts before import('./index') via
  // native tls.getCACertificates('system') to ensure all HTTPS calls trust the OS cert store.

  // Configure electron-updater
  const isBetaApp = getBuildChannel() === 'beta';
  const channel: 'beta' | 'stable' = isBetaApp ? 'beta' : 'stable';
  const nativeArch = getNativeArch();

  // Configure electron-updater settings
  electronUpdater.logger = updateLog;
  electronUpdater.autoDownload = true;
  electronUpdater.autoInstallOnAppQuit = false; // CRITICAL: We handle install explicitly to avoid race with meeting bot
  electronUpdater.allowDowngrade = false;
  electronUpdater.channel = isBetaApp ? 'beta' : 'latest'; // Ensure correct metadata file (beta.yml vs latest.yml)

  // Determine update URL:
  // 1. Try to read from app-update.yml (generated by electron-builder at build time)
  //    This supports UPDATE_FEED_PATH override for isolated testing (e.g., nsis-test branch)
  // 2. Fall back to hardcoded channel-based URL if app-update.yml doesn't exist
  //    (GitHub artifacts, dev builds, etc.)
  let updateBaseUrl: string;
  let urlSource: 'app-update.yml' | 'fallback';
  
  // Try to read URL from electron-builder's app-update.yml
  const appUpdateYmlPath = path.join(process.resourcesPath, 'app-update.yml');
  // Import fs synchronously for file operations
   
  const nodefs: typeof import('node:fs') = require('node:fs');
  try {
    if (app.isPackaged && nodefs.existsSync(appUpdateYmlPath)) {
      const yamlContent = nodefs.readFileSync(appUpdateYmlPath, 'utf8');
      // Parse YAML manually - handles optional indentation and quoted values
      // electron-builder format: `url: https://...` or `url: "https://..."`
      const urlMatch = yamlContent.match(/^\s*url:\s*["']?([^"'\n]+)["']?\s*$/m);
      if (urlMatch && urlMatch[1]) {
        updateBaseUrl = urlMatch[1].trim();
        // Ensure trailing slash for proper relative URL resolution
        if (!updateBaseUrl.endsWith('/')) {
          updateBaseUrl += '/';
        }
        urlSource = 'app-update.yml';
        updateLog['info'](`[UPDATE-WIN] Using build-time URL from app-update.yml: ${updateBaseUrl}`);
      } else {
        throw new Error('No url field found in app-update.yml');
      }
    } else {
      throw new Error('app-update.yml not found');
    }
  } catch (err) {
    // Fall back to hardcoded URL based on channel
    // Log reason for debugging (file missing vs parse error)
    const reason = err instanceof Error ? err.message : 'unknown error';
    updateLog['debug'](`[UPDATE-WIN] app-update.yml not usable (${reason}), using fallback`);
    
    // NOTE: Update URL pattern is defined in multiple places - keep in sync:
    //   - src/main/services/autoUpdateService.ts (here + macOS section) - runtime fallback
    //   - forge.config.cjs - packageAfterCopy Step 10 app-update.yml generation
    //   - electron-builder.cjs - build-time publish config
    //   - scripts/build-windows-nsis.mjs - local build app-update.yml generation
    //   - src/main/services/health/checks/updates.ts - health check diagnostics
    const updateBasePath = isBetaApp ? 'updates-beta' : 'updates';
    // Trailing slash is important - electron-updater resolves metadata files relative to this URL
    updateBaseUrl = `https://storage.googleapis.com/mindstone-rebel/${updateBasePath}/${process.platform}/${nativeArch}/`;
    urlSource = 'fallback';
    updateLog['info'](`[UPDATE-WIN] Using fallback URL: ${updateBaseUrl}`);
  }
  
  // Critical fix: Override loadUpdateConfig to prevent ENOENT crashes on missing app-update.yml
  //
  // WHY THIS EXISTS:
  // electron-updater's getOrCreateDownloadHelper() reads updaterCacheDirName from configOnDisk,
  // which triggers loadUpdateConfig() to read app-update.yml from disk. Since Electron Forge
  // builds don't include app-update.yml, this causes an ENOENT crash during update checks.
  // See: https://github.com/electron-userland/electron-builder/issues/2761
  //
  // SECURITY NOTE:
  // This override does NOT affect update security. Signature verification uses the code signing
  // certificate embedded in the downloaded installer binary, not any configuration file.
  // electron-updater verifies the installer's Authenticode signature matches the publisher name
  // before executing. The updaterCacheDirName only controls the download cache directory name.
  //
  // The only value actually needed is updaterCacheDirName (defaults to app.name if undefined).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- electron-updater's loadUpdateConfig is not part of its public types; we're patching internals deliberately
  (electronUpdater as any).loadUpdateConfig = async () => {
    return { updaterCacheDirName: isBetaApp ? 'mindstone-rebel-beta-updater' : app.getName() };
  };

  // =========================================================================
  // TEST STUB: Set REBEL_TEST_UPDATE_YAML env var to test with hardcoded YAML
  // 
  // This allows testing the update metadata parsing without waiting for CI builds.
  // The stub intercepts YAML metadata requests but allows real installer downloads.
  //
  // Usage (PowerShell):
  //   $env:REBEL_TEST_UPDATE_YAML = "version: 0.3.999`nfiles:`n  - url: Test.exe`n    sha512: abc`n    size: 100`npath: Test.exe`nsha512: abc`nreleaseDate: '2026-01-31T00:00:00.000Z'"
  //   & "C:\path\to\Mindstone Rebel Beta.exe"
  //
  // Usage (cmd):
  //   set REBEL_TEST_UPDATE_YAML=version: 0.3.999^nfiles:^n  - url: Test.exe^n    sha512: abc^n    size: 100^npath: Test.exe^nsha512: abc^nreleaseDate: '2026-01-31T00:00:00.000Z'
  //
  // Special values:
  //   REBEL_TEST_UPDATE_YAML=SKIP - Returns YAML with current version (simulates "no update available")
  //
  // See also: docs/project/DISTRIBUTION.md (Testing Auto-Updates section)
  // =========================================================================
  const testUpdateYaml = process.env.REBEL_TEST_UPDATE_YAML;
  if (testUpdateYaml) {
    updateLog['warn']('[UPDATE-WIN] TEST MODE: Using REBEL_TEST_UPDATE_YAML stub');
    
    // Determine the YAML to return
    let stubYaml: string;
    if (testUpdateYaml === 'SKIP') {
      // Return YAML with current version to simulate "no update available"
      const currentVersion = app.getVersion();
      stubYaml = `version: ${currentVersion}\nfiles:\n  - url: NoUpdate.exe\n    sha512: skip\n    size: 0\npath: NoUpdate.exe\nsha512: skip\nreleaseDate: '${new Date().toISOString()}'`;
      updateLog['info']('[UPDATE-WIN] TEST MODE: SKIP - will report current version as latest');
    } else {
      // Use the provided YAML, parsing escaped newlines
      stubYaml = testUpdateYaml.replace(/\\n/g, '\n');
    }
    
    // Override the HTTP request handler to return our test YAML
    // electron-updater uses httpExecutor.request() for metadata fetches
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- electron-updater's httpExecutor is not part of its public types; test-mode patch only
    const originalHttpExecutor = (electronUpdater as any).httpExecutor;
    if (originalHttpExecutor && typeof originalHttpExecutor.request === 'function') {
       
      const originalRequest = originalHttpExecutor.request.bind(originalHttpExecutor);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- electron-updater's internal httpExecutor.request has no exported type signature; test-mode patch only
      originalHttpExecutor.request = async (options: any, cancellationToken: any, data: any) => {
        const url = options.url || options.path || options.href || '';
        // Check if this is a request for beta.yml or latest.yml
        if (url.includes('beta.yml') || url.includes('latest.yml')) {
          updateLog['info']('[UPDATE-WIN] TEST MODE: Returning stub YAML for', url);
          return stubYaml;
        }
        // For all other requests (like the actual installer download), use the real executor
        return originalRequest(options, cancellationToken, data);
      };
    }
  }
  // =========================================================================
  // END TEST STUB
  // =========================================================================
  
  electronUpdater.setFeedURL({
    provider: 'generic',
    url: updateBaseUrl,
    channel: isBetaApp ? 'beta' : 'latest',
    useMultipleRangeRequest: false,
  });
  updateLog['info'](`[UPDATE-WIN] Feed URL configured (source: ${urlSource}): ${updateBaseUrl}`);

  const updateRuntime = describeUpdateRuntime(updateBaseUrl, channel, nativeArch);

  updateLog['info'](`[UPDATE-WIN] electron-updater initialized`, updateRuntime);

  // -------------------------------------------------------------------------
  // IPC Handlers
  // -------------------------------------------------------------------------

  // Replace stub handler with real implementation
  ipcMain.removeHandler('check-for-updates');
  ipcMain.handle('check-for-updates', async () => {
    if (inFlightManualUpdateCheck) {
      return inFlightManualUpdateCheck;
    }

    inFlightManualUpdateCheck = (async () => {
      const checkId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      updateLog['info']('[UPDATE-WIN] Manual update check requested', { checkId, ...updateRuntime });

      try {
        currentUpdateState = 'CHECKING';
        const result = await electronUpdater.checkForUpdates();

        // Use electron-updater's built-in isUpdateAvailable flag
        // This properly compares versions and handles edge cases
        if (result?.updateInfo && result.isUpdateAvailable) {
          const version = result.updateInfo.version;
          updateLog['info']('[UPDATE-WIN] Manual check found update', { checkId, version });
          return { available: true, version };
        } else {
          const currentVersion = app.getVersion();
          const remoteVersion = result?.updateInfo?.version;
          updateLog['info']('[UPDATE-WIN] Manual check: no update available', { 
            checkId, 
            currentVersion,
            remoteVersion: remoteVersion || 'unknown'
          });
          return { available: false };
        }
      } catch (error) {
        const categorized = categorizeError(error);
        updateLog['error']('[UPDATE-WIN] Manual check failed', { checkId, error: categorized });
        currentUpdateState = 'ERROR';
        return { available: false, error: categorized.message };
      }
    })().finally(() => {
      inFlightManualUpdateCheck = null;
    });

    return inFlightManualUpdateCheck;
  });

  // Acknowledge toast handler
  ipcMain.handle('update:acknowledge-toast', () => {
    const window = getUpdatePrimaryWindow();
    const pending = getPendingDownloadedUpdate();
    if (pending) {
      acknowledgeDownloadedUpdate(pending.updateKey);
    }
    updateLog['info']('[UPDATE-WIN] Update toast acknowledged', {
      ...updateRuntime,
      pendingUpdateKey: pending?.updateKey,
      ...describeWindowForUpdateLog(window),
    });
    return { acknowledged: true };
  });

  // Install now handler
  ipcMain.handle('update:install-now', () => {
    const window = getUpdatePrimaryWindow();
    const pending = getPendingDownloadedUpdate();
    updateLog['info']('[UPDATE-WIN] Install now requested', {
      ...updateRuntime,
      pendingUpdateKey: pending?.updateKey,
      ...describeWindowForUpdateLog(window),
    });

    if (!pending) {
      return { success: false, error: 'No downloaded update is available to install.' };
    }

    // Return IPC response first, then quit on next tick
    setImmediate(() => {
      fireAndForget((async () => {
      const result = await safeQuitAndInstallWindows(electronUpdater, updateLog);
      if (result.success) {
        return;
      }

      const errorMessage = result.error ?? 'Unknown error';
      let notifiedRenderer = false;

      try {
        const target = getUpdatePrimaryWindow();
        notifiedRenderer = target
          ? safeSendToWindow(target, 'update:install-failed', {
              updateKey: pending.updateKey,
              error: errorMessage,
            })
          : false;
      } catch {
        notifiedRenderer = false;
      }

      if (!notifiedRenderer) {
        try {
          fireAndForget(dialog.showMessageBox({
            type: 'error',
            title: 'Update Failed',
            message: 'Failed to install the update.',
            detail: errorMessage,
          }), 'autoUpdate.installNowFailureDialog');
        } catch {
          // ignore
        }
      }
      })(), 'autoUpdate.installNow');
    });

    return { success: true };
  });

  // -------------------------------------------------------------------------
  // electron-updater Event Handlers
  // -------------------------------------------------------------------------

  electronUpdater.on('checking-for-update', () => {
    currentUpdateState = 'CHECKING';
    updateLog['info']('[UPDATE-WIN] Checking for updates', updateRuntime);
    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: { transition: 'check_started', platform: process.platform as 'darwin' | 'win32' | 'linux' },
    });
  });

  electronUpdater.on('update-available', (info) => {
    currentUpdateState = 'AVAILABLE';
    setUpdateDownloading(true);
    updateLog['info']('[UPDATE-WIN] Update available', { ...updateRuntime, version: info.version });
    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: { transition: 'check_succeeded', platform: process.platform as 'darwin' | 'win32' | 'linux' },
    });
  });

  electronUpdater.on('download-progress', (progress) => {
    currentUpdateState = 'DOWNLOADING';
    // Log progress periodically (every 10%)
    const percent = Math.round(progress.percent);
    if (percent % 10 === 0) {
      updateLog['info']('[UPDATE-WIN] Download progress', {
        percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    }

    // Send progress to renderer for UI feedback
    const window = getUpdatePrimaryWindow();
    if (window) {
      safeSendToWindow(window, 'update:download-progress', {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
      });
    }
  });

  electronUpdater.on('update-downloaded', (info) => {
    fireAndForget((async () => {
    currentUpdateState = 'DOWNLOADED';
    setUpdateDownloading(false);

    const versionLabel = info.version || 'unknown';
    const updateKey = `${channel}:${process.platform}:${nativeArch}:${versionLabel}`;

    setPendingDownloadedUpdate({
      updateKey,
      versionLabel,
      downloadedAt: Date.now(),
    });

    updateLog['info']('[UPDATE-WIN] Update downloaded', { ...updateRuntime, versionLabel, updateKey });

    const window = getUpdatePrimaryWindow();
    const windowInfo = describeWindowForUpdateLog(window);

    // Include the silent auto-heal counter so the renderer's toast can
    // surface the recovery copy on a push-first sequence — see
    // `useIpcListeners` and the REBEL-53B investigation doc.
    const recoveryAttempts = readRecoveryAttempts(updateKey);
    const sent = window
      ? safeSendToWindow(window, 'update:downloaded', {
          updateKey,
          version: versionLabel,
          recoveryAttempts,
        })
      : false;

    updateLog['info']('[UPDATE-WIN] Download notification attempt', {
      ...updateRuntime,
      versionLabel,
      updateKey,
      recoveryAttempts,
      sent,
      ...windowInfo,
    });

    if (sent) {
      return;
    }

    // Fallback to native dialog if renderer unavailable
    updateLog['info']('[UPDATE-WIN] Showing native dialog for update', { ...windowInfo });
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Update ${versionLabel} downloaded. Restart now to apply it?`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) {
      updateLog['info']('[UPDATE-WIN] User accepted native update dialog');
      const installResult = await safeQuitAndInstallWindows(electronUpdater, updateLog);
      if (!installResult.success) {
        try {
          fireAndForget(dialog.showMessageBox({
            type: 'error',
            title: 'Update Failed',
            message: 'Failed to install the update.',
            detail: installResult.error,
          }), 'autoUpdate.windowsInstallFailureDialog');
        } catch {
          // ignore
        }
      }
    } else {
      updateLog['info']('[UPDATE-WIN] User chose to install update later');
    }
    })(), 'autoUpdate.windowsUpdateDownloaded');
  });

  electronUpdater.on('update-not-available', (info) => {
    currentUpdateState = 'IDLE';
    setUpdateDownloading(false);
    updateLog['info']('[UPDATE-WIN] No updates available', { ...updateRuntime, currentVersion: info.version });
    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: { transition: 'check_succeeded', platform: process.platform as 'darwin' | 'win32' | 'linux' },
    });

    const window = getUpdatePrimaryWindow();
    if (window) {
      safeSendToWindow(window, 'update:not-available', { currentVersion: app.getVersion() });
    }
  });

  electronUpdater.on('error', (error) => {
    currentUpdateState = 'ERROR';
    setUpdateDownloading(false);

    const categorized = categorizeError(error);
    captureAutoUpdateFailureForSentry(categorized, process.platform, app.getVersion());

    updateLog['error']('[UPDATE-WIN] Update error', {
      ...updateRuntime,
      category: categorized.category,
      message: categorized.message,
      retryable: categorized.retryable,
    });
    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: { transition: 'check_failed', platform: process.platform as 'darwin' | 'win32' | 'linux', errorCategory: categorized.category },
    });

    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'Auto-Update Error',
      properties: {
        platform: process.platform as 'darwin' | 'win32' | 'linux',
        arch: process.arch,
        errorCategory: categorized.category,
        retryable: categorized.retryable,
      },
    });

    // Notify renderer about the error
    const window = getUpdatePrimaryWindow();
    if (window) {
      safeSendToWindow(window, 'update:error', {
        code: categorized.category.toUpperCase(),
        category: categorized.category,
        message: categorized.message,
        retryable: categorized.retryable,
      });
    }
  });

  // Start periodic update checks
  electronUpdater.checkForUpdates().catch((error) => {
    const categorized = categorizeError(error);
    updateLog['warn']('[UPDATE-WIN] Initial update check failed', categorized);
  });

  // Check every hour (pauses when app is hidden/blurred — check on resume is fine)
  createPausableInterval(
    () => {
      electronUpdater.checkForUpdates().catch((error) => {
        const categorized = categorizeError(error);
        updateLog['warn']('[UPDATE-WIN] Periodic update check failed', categorized);
      });
    },
    60 * 60 * 1000,
    { pauseOnBlur: true, catchUpPriority: 8 }
  );
}

// ============================================================================
// macOS: update-electron-app Implementation (Unchanged)
// ============================================================================

/**
 * Safely quit and install an update for macOS (Squirrel.Mac).
 *
 * CRITICAL: Release the single-instance lock BEFORE calling quitAndInstall().
 * Squirrel spawns the new instance synchronously before triggering quit.
 *
 * MACOS FIX: On macOS, quitAndInstall() closes windows but doesn't always trigger
 * app.quit() properly (due to darwin's window-all-closed behavior). We use a two-tier
 * fallback: (1) after 3s, manually call app.quit() if shutdown hasn't started,
 * (2) after 8s, force app.exit(0) as ultimate fallback.
 *
 * RELAUNCH WATCHDOG: Squirrel.Mac's ShipIt daemon has a known intermittent failure
 * where it installs the update but fails to relaunch. We spawn a detached shell process
 * that checks after 15s whether the app is running, and launches it if not.
 * See: docs-private/investigations/260223_auto_update_relaunch_regression.md
 */
async function safeQuitAndInstallMacOS(updateLog: UpdateLogger): Promise<{ success: boolean; error?: string; userNotified?: boolean }> {
  let updateCleanupRestore: (() => void) | null = null;
  let updateCleanupRestored = false;
  const restoreCleanupAfterFailedUpdate = (): void => {
    if (!updateCleanupRestore || updateCleanupRestored) return;
    updateCleanupRestored = true;
    updateCleanupRestore();
    rearmCleanExitFlagAfterFailedUpdate();
  };

  try {
    updateLog['info']('[UPDATE-MAC] Initiating safe quit and install');

    // Write install marker so startup can detect stuck updates.
    // Stage 5 of the install completion contract
    // (`docs/plans/260428_install_completion_contract.md`): populate
    // `targetVersion` (the version the user expected to land on) and
    // `updateKey` so the startup reconciliation has a decisive
    // `currentVersion === marker.targetVersion` signal AND a stable key for
    // anti-collision / attemptCount bookkeeping.
    const pending = getPendingDownloadedUpdate();
    if (pending) {
      markUpdateInstallRequested({
        updateKey: pending.updateKey,
        fromVersion: app.getVersion(),
        targetVersion: pending.versionLabel,
        requestedAt: Date.now(),
      });
    }

    const { completed, restore } = await closeNativeWatchersForUpdate();
    updateCleanupRestore = restore;
    updateLog['info']('[UPDATE-MAC] Native watcher cleanup completed before install handoff', {
      completed,
    });

    markCleanExit();

    // CRITICAL: Remove before-quit handler BEFORE quitAndInstall to let ShipIt work correctly.
    // The before-quit handler's event.preventDefault() interferes with ShipIt's file copy
    // and relaunch operations. Without this, the app installs but fails to relaunch.
    // See: docs/plans/finished/260131_auto_update_shipit_cache_corruption.md
    updateLog['info']('[UPDATE-MAC] Removing before-quit handler for ShipIt compatibility');
    removeBeforeQuitHandlerForUpdate();

    // Release lock IMMEDIATELY before quitAndInstall
    try {
      app.releaseSingleInstanceLock();
      updateLog['info']('[UPDATE-MAC] Released single-instance lock before quitAndInstall');
    } catch (lockError) {
      updateLog['warn']('[UPDATE-MAC] Failed to release single-instance lock', lockError);
    }

    // Spawn a relaunch watchdog BEFORE triggering quit. ShipIt has a known intermittent
    // failure where it installs the update but fails to relaunch via NSWorkspace.openURL().
    // The watchdog waits for ShipIt to finish, then launches the app if it isn't running.
    // This avoids the app.relaunch() race condition documented in
    // docs/plans/finished/260131_auto_update_shipit_cache_corruption.md because it waits for
    // ShipIt to complete and checks whether the app is already running before acting.
    const watchdogPid = spawnRelaunchWatchdog(updateLog);

    // Track whether quitAndInstall() actually triggered the quit sequence.
    // NOTE: We can't use isShuttingDown() here because removeBeforeQuitHandlerForUpdate()
    // already set that flag. We need a fresh, local signal from the actual before-quit event.
    let quitEventFired = false;
    app.once('before-quit', () => { quitEventFired = true; });

    setQuittingForUpdate();
    try {
      appendDiagnosticEvent({
        kind: 'auto_update_state_change',
        data: { transition: 'install_attempted', platform: process.platform as 'darwin' | 'win32' | 'linux' },
      });
      autoUpdater.quitAndInstall();
    } catch (quitErr) {
      // If quitAndInstall synchronously throws, the watchdog is already detached
      // and will eventually fire against our still-running PID. Kill it so it
      // doesn't accidentally relaunch the app on a later normal quit.
      if (watchdogPid != null) {
        try {
          process.kill(watchdogPid, 'SIGTERM');
          updateLog['warn']('[UPDATE-MAC] Killed relaunch watchdog after quitAndInstall threw', {
            watchdogPid,
          });
        } catch {
          // Watchdog may have already exited; ignore.
        }
      }
      restoreCleanupAfterFailedUpdate();
      throw quitErr;
    }

    // Tier 1 fallback: if quitAndInstall() didn't trigger before-quit within 3s,
    // manually call app.quit(). This covers macOS edge cases where quitAndInstall()
    // closes windows but doesn't properly trigger app.quit().
    setTimeout(() => {
      if (!quitEventFired) {
        updateLog['warn']('[UPDATE-MAC] before-quit did not fire within 3s, manually triggering quit');
        // Stage 3b: observable quit-deadlock signal — before-quit not firing in
        // budget is the Tier-1 deadlock symptom. Fire-and-forget (the emit is
        // ledger-first + bounded-flush internally) so it never delays the quit
        // we are about to trigger.
        // 260622: capture the native-resource liveness snapshot SYNCHRONOUSLY
        // first (fail-open, never throws) so the signal names which native
        // modules were still live at the Tier-1 boundary — BEFORE any exit.
        const tier1Liveness = captureNativeLivenessSnapshot();
        fireAndForget(
          emitQuitDeadlockDetected('mac_tier1', {}, tier1Liveness),
          'autoUpdateService.quitDeadlockTier1',
        );
        const quitTimer = setTimeout(() => app.quit(), 500);
        try {
          logger.flush(() => {
            clearTimeout(quitTimer);
            app.quit();
          });
        } catch {
          clearTimeout(quitTimer);
          app.quit();
        }
      }
    }, 3000);

    // Tier 2 fallback: ultimate fallback if still alive after 8s.
    // app.exit() emits NO lifecycle events, so this path bypasses every
    // before-quit/will-quit listener — it MUST exit via the final-exit
    // primitive so leaked fsevents instances are swept (the 260609 update
    // crash cohort; see finalExit.ts). markCleanExit() stays BEFORE the
    // primitive call: flag write, then sweep, then exit.
    setTimeout(() => {
      // 260622: capture the native-resource liveness snapshot SYNCHRONOUSLY at
      // the TOP of the Tier-2 callback — BEFORE emit and BEFORE
      // immediateExitWithFseventsSweep (which clears the fsevents live set, so
      // a post-sweep read would always be 0). Fail-open; never throws/blocks.
      // This is the most diagnostic moment: graceful shutdown has just failed,
      // so the counts say exactly what cleanup left behind.
      const tier2Liveness = captureNativeLivenessSnapshot();
      fireAndForget((async () => {
        updateLog['error']('[UPDATE-MAC] App still alive after 8s, forcing exit for update', {
          nativeLiveness: tier2Liveness,
        });
        // Stage 3b: the app still being alive after 8s is the Tier-2 deadlock
        // symptom. Emit FIRST (ledger-first + bounded ≤2s flush) so the signal
        // is durable before we force-exit; the bounded flush can never extend
        // the hang unboundedly.
        await emitQuitDeadlockDetected('mac_tier2', {}, tier2Liveness);
        markCleanExit();
        const exitTimer = setTimeout(
          () => fireAndForget(
            immediateExitWithFseventsSweep('update-tier2-fallback:flush-timeout', 0),
            'autoUpdateService.tier2FlushTimeoutExit',
          ),
          500,
        );
        try {
          logger.flush(() => {
            clearTimeout(exitTimer);
            fireAndForget(
              immediateExitWithFseventsSweep('update-tier2-fallback', 0),
              'autoUpdateService.tier2Exit',
            );
          });
        } catch {
          clearTimeout(exitTimer);
          fireAndForget(
            immediateExitWithFseventsSweep('update-tier2-fallback:flush-threw', 0),
            'autoUpdateService.tier2FlushThrewExit',
          );
        }
      })(), 'autoUpdateService.tier2QuitDeadlockExit');
    }, 8000);

    return { success: true };
  } catch (error) {
    restoreCleanupAfterFailedUpdate();
    updateLog['error']('[UPDATE-MAC] Failed to install update', error);
    const categorized = categorizeError(error);
    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: { transition: 'install_failed', platform: process.platform as 'darwin' | 'win32' | 'linux', errorCategory: categorized.category },
    });
    // macOS install failures weren't being categorized into Sentry like the
    // Windows path is — capture here too, and (for the non-retryable
    // permission/authorization class: duplicate copy / outside Applications)
    // tell the user instead of failing silently.
    captureAutoUpdateFailureForSentry(categorized, process.platform, app.getVersion());
    // If we showed the tailored "couldn't install" dialog, the callers must NOT
    // also show their generic "Update Failed" dialog (no double dialog).
    const userNotified = await maybeSurfaceUpdateFailureToUser(categorized);

    try {
      const reacquired = app.requestSingleInstanceLock();
      if (!reacquired) {
        updateLog['warn']('[UPDATE-MAC] Could not re-acquire lock after update failure');
      } else {
        updateLog['info']('[UPDATE-MAC] Re-acquired lock after update failure');
      }
    } catch (reacquireError) {
      updateLog['warn']('[UPDATE-MAC] Error re-acquiring lock', reacquireError);
    }

    clearQuittingForUpdate();
    return { success: false, error: String(error), userNotified };
  }
}

export const _safeQuitAndInstallMacOSForTesting = safeQuitAndInstallMacOS;

/**
 * Spawn a detached "relaunch watchdog" process (macOS only).
 *
 * ShipIt (Squirrel.Mac's update daemon) has a known intermittent failure where it
 * successfully installs the update but fails to relaunch the app. This watchdog:
 * 1. Survives our process exit (detached + unref'd)
 * 2. Waits for the OLD Electron process to fully exit (poll kill -0)
 * 3. Waits for the ShipIt daemon to finish its work (poll pgrep -x ShipIt)
 * 4. Checks if the new app is already running (matching by full exe path,
 *    excluding the watchdog shell itself via $$)
 * 5. If not running, launches the app bundle via `open` (which opens the NEW
 *    version since ShipIt has already replaced it on disk)
 * 6. Writes a small telemetry JSON file so the next app launch can record
 *    whether/when/how the watchdog ran into the persistent auto-update state
 *    store (see consumeWatchdogTelemetryOnStartup).
 *
 * Key reliability fixes vs. the original implementation:
 *   - Old check `pgrep -x <appName>` silently never matched for long bundle
 *     names (Darwin `p_comm` caps at ~16 chars, so "Mindstone Rebel Beta"
 *     couldn't be matched). We now match on the full Contents/MacOS exe path
 *     via `pgrep -f`, filtering out this watchdog shell's own PID ($$).
 *   - Old fixed 5s grace period raced with ShipIt on large bundles. We now
 *     wait for the ShipIt process itself to exit (capped at 90s) before
 *     deciding whether to intervene.
 *
 * This avoids the app.relaunch() race condition (see 260131_auto_update_shipit_cache_corruption.md)
 * because the watchdog waits for ShipIt to finish before acting, and checks whether
 * the app is already running to avoid double-launch.
 */
function spawnRelaunchWatchdog(updateLog: UpdateLogger): number | undefined {
  try {
    const oldPid = process.pid;

    // Derive the .app bundle path from the executable path.
    // e.g. /Applications/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel
    //   → /Applications/Mindstone Rebel.app
    const exePath = app.getPath('exe');
    const contentsIdx = exePath.indexOf('/Contents/');
    if (contentsIdx === -1) {
      updateLog['warn']('[UPDATE-MAC] Cannot derive app bundle path for relaunch watchdog', { exePath });
      return undefined;
    }
    const appBundlePath = exePath.substring(0, contentsIdx);

    // Telemetry file lives in userData so consumeWatchdogTelemetryOnStartup() can
    // pick it up on the next launch (regardless of stable/beta channel).
    const telemetryPath = path.join(app.getPath('userData'), 'auto-update-watchdog-telemetry.json');

    // Use single quotes in the shell script to avoid issues with $, backticks, etc.
    // The exe path is system-controlled (app.getPath('exe')) so injection risk is minimal,
    // but single quotes eliminate any concern.
    const shellEscape = (s: string) => s.replace(/'/g, "'\\''");
    const escapedExePath = shellEscape(exePath);
    const escapedPath = shellEscape(appBundlePath);
    const escapedTelemetryPath = shellEscape(telemetryPath);
    // Stage 2 (install completion contract): the running process IS the
    // from-version because ShipIt has not yet replaced the bundle on disk
    // when this watchdog is spawned. The watchdog uses this to detect a
    // failed install where the on-disk bundle version is unchanged.
    const expectedFromVersion = app.getVersion();
    const escapedExpectedFromVersion = shellEscape(expectedFromVersion);

    const script = buildWatchdogScript(
      oldPid,
      escapedExePath,
      escapedPath,
      escapedTelemetryPath,
      escapedExpectedFromVersion,
    );

    const watchdog = spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
    });
    watchdog.unref();

    updateLog['info']('[UPDATE-MAC] Spawned relaunch watchdog', {
      pid: watchdog.pid,
      oldPid,
      appBundlePath,
      exePath,
      telemetryPath,
      expectedFromVersion,
      versionCheckDisabled: !!process.env.REBEL_DISABLE_WATCHDOG_VERSION_CHECK,
    });
    return watchdog.pid;
  } catch (error) {
    updateLog['warn']('[UPDATE-MAC] Failed to spawn relaunch watchdog (non-fatal)', error);
    return undefined;
  }
}

/**
 * Build the shell script for the relaunch watchdog.
 *
 * Extracted as a pure function for testability.
 *
 * The script runs as a detached `/bin/sh` after our process exits and:
 * 1. Polls `kill -0 $OLD_PID` every second until the old process exits (max 120s safety cap)
 * 2. Polls `pgrep -x ShipIt` until the ShipIt daemon finishes (max 90s safety cap)
 * 3. Sleeps 3s to let LaunchServices register the new app
 * 4. Checks whether the NEW app is running via `pgrep -f <exePath>`, excluding the
 *    watchdog shell's own PID via `$$` (the pattern appears in our own argv since the
 *    script embeds it as a string literal, so we must filter ourselves out).
 * 4.5. (Stage 2 of install completion contract) Reads the on-disk Info.plist
 *    `CFBundleShortVersionString` via `plutil` and compares it to the expected
 *    from-version. Records `installFailedBundleVersionUnchanged` and
 *    `onDiskVersion` into telemetry. Per the C1 critique decision, the watchdog
 *    ALWAYS fires `open` regardless of the comparison result — Stage 5
 *    reconciliation reads telemetry to drive the recovery dialog. Honours the
 *    `REBEL_DISABLE_WATCHDOG_VERSION_CHECK` env var as a kill-switch (I17): if
 *    set at JS-build-time, Phase 4.5 is omitted entirely and the legacy script
 *    is generated.
 * 5. If the app isn't running, launches the bundle via `open`.
 * 6. Writes a small JSON telemetry file (atomic write via temp + mv) so the next
 *    launch can persist watchdog outcomes into `auto-update-state.json`.
 *
 * @param oldPid - PID of the current (soon-to-quit) Electron process
 * @param escapedExePath - Shell-escaped full executable path (Contents/MacOS/<name>)
 * @param escapedBundlePath - Shell-escaped .app bundle path for `open`
 * @param escapedTelemetryPath - Shell-escaped JSON telemetry output path
 * @param escapedExpectedFromVersion - Shell-escaped version string the running
 *   process is currently on (i.e. `app.getVersion()` at quit-time). The
 *   watchdog compares this against the on-disk bundle version after ShipIt
 *   finishes; equality means ShipIt did NOT swap the bundle.
 * @returns Shell script string
 */
export function buildWatchdogScript(
  oldPid: number,
  escapedExePath: string,
  escapedBundlePath: string,
  escapedTelemetryPath: string,
  escapedExpectedFromVersion: string,
  sigtermAfterSec: number = 30,
  sigkillAfterSec: number = 60,
  // Safety cap on the Phase-1 wait loop (kept at 120s in production so Phase 5
  // relaunch still fires; injectable only so behavioral tests run a bounded
  // loop against a deliberately-immortal child).
  maxWaitSec: number = 120,
): string {
  // Stage 2 kill-switch (I17): if the env var is set at script-build time,
  // omit Phase 4.5 entirely and generate the legacy script. This gives ops a
  // hotfix lever without redeploying if the new logic causes problems.
  const versionCheckDisabled = !!process.env.REBEL_DISABLE_WATCHDOG_VERSION_CHECK;

  const lines: string[] = [
    // Phase 1: Wait for old Electron process to die, escalating to an
    // out-of-process force-kill if it outlives the budget.
    //
    // The in-process force-exit nets (Tier-1 app.quit at 3s, Tier-2
    // immediateExitWithFseventsSweep at 8s) run on the wedged event loop and/or
    // re-enter the SAME hanging native TSFN env-teardown, so they cannot
    // GUARANTEE termination (REBEL-6AM: Tier-2 telemetry fires yet the process
    // still needs a manual force-quit; FOX-3487). This detached `/bin/sh` is the
    // ONLY net that survives an event-loop wedge — a separate OS process whose
    // firing guarantee is not entangled with the hanging subsystem.
    //
    // Gate = PID-liveness, NOT on-disk version: while the old PID is alive ShipIt
    // has not swapped the bundle (it blocks on the old process dying — that IS
    // the bug), so the on-disk version equals the from-version by construction.
    // A per-second `plutil` read would be redundant + slow; the existing Phase
    // 4.5 records the version as evidence after the loop.
    //
    // PID-reuse guard: only signal if the PID still names THIS Rebel exe. We use
    // `ps -p $PID -o command=` (full argv) and require a PREFIX match (process
    // argv begins with our exe path) — NOT `-o comm=` (Darwin's truncated/
    // name-shaped field), and NOT a substring match (a recycled PID whose argv
    // merely contains our exe path as an argument would wrongly pass). The exe
    // path is single-quoted in the `case` pattern so it matches literally (glob
    // metachars in paths like `Mindstone Rebel (Beta).app` are disabled),
    // followed by an unquoted `*` for trailing args. The guard is re-checked
    // immediately before BOTH signals (TOCTOU defence).
    //
    // WAITED counts loop iterations (`sleep 1`), which macOS suspends during
    // system sleep — so the budget is measured in *awake* seconds. This is a
    // FEATURE (don't SIGKILL a process that was merely asleep overnight); do not
    // "fix" it to wall-clock.
    `WAITED=0`,
    `EXTERNAL_FORCE_KILL_SIGNAL=none`,
    // Guard outcome so a never-matching identity guard is observable, not a
    // silent no-op (silent failure is a bug). `na` = budget never reached;
    // `identityMatched` = guard confirmed THIS exe and we signalled;
    // `identityMismatch` = budget reached but the PID no longer names this exe.
    `EXTERNAL_FORCE_KILL_GUARD=na`,
    `while kill -0 ${oldPid} 2>/dev/null; do`,
    `  sleep 1`,
    `  WAITED=$((WAITED + 1))`,
    `  if [ $WAITED -ge ${sigtermAfterSec} ] && [ "$EXTERNAL_FORCE_KILL_SIGNAL" = none ]; then`,
    `    KILL_TARGET_CMD=$(ps -p ${oldPid} -o command= 2>/dev/null)`,
    `    case "$KILL_TARGET_CMD" in`,
    `      '${escapedExePath}'*)`,
    `        kill -TERM ${oldPid} 2>/dev/null || true`,
    `        EXTERNAL_FORCE_KILL_SIGNAL=TERM`,
    `        EXTERNAL_FORCE_KILL_GUARD=identityMatched`,
    `        ;;`,
    `      *)`,
    `        EXTERNAL_FORCE_KILL_GUARD=identityMismatch`,
    `        ;;`,
    `    esac`,
    `  fi`,
    `  if [ $WAITED -ge ${sigkillAfterSec} ] && [ "$EXTERNAL_FORCE_KILL_SIGNAL" = TERM ]; then`,
    `    KILL_TARGET_CMD=$(ps -p ${oldPid} -o command= 2>/dev/null)`,
    `    case "$KILL_TARGET_CMD" in`,
    `      '${escapedExePath}'*)`,
    `        kill -KILL ${oldPid} 2>/dev/null || true`,
    `        EXTERNAL_FORCE_KILL_SIGNAL=KILL`,
    `        EXTERNAL_FORCE_KILL_GUARD=identityMatched`,
    `        ;;`,
    `      *)`,
    `        EXTERNAL_FORCE_KILL_GUARD=identityMismatch`,
    `        ;;`,
    `    esac`,
    `  fi`,
    `  if [ $WAITED -ge ${maxWaitSec} ]; then break; fi`,
    `done`,
    // Phase 2: Wait for ShipIt daemon to finish. ShipIt's process name is
    // stable (<16 chars) so pgrep -x is safe here.
    `SHIPIT_WAITED=0`,
    `while pgrep -x ShipIt > /dev/null 2>&1; do`,
    `  sleep 1`,
    `  SHIPIT_WAITED=$((SHIPIT_WAITED + 1))`,
    `  if [ $SHIPIT_WAITED -ge 90 ]; then break; fi`,
    `done`,
    // Phase 3: Small settling buffer for LaunchServices to register the new app
    `sleep 3`,
    // Phase 4: Check if the app is already running. The script's own argv
    // contains ${escapedExePath} as a substring (it's embedded below), so
    // `pgrep -f` will match this watchdog shell too — filter out $$.
    `ALREADY_RUNNING=0`,
    `if pgrep -f '${escapedExePath}' 2>/dev/null | grep -v "^$$\\$" | grep -q .; then`,
    `  ALREADY_RUNNING=1`,
    `fi`,
  ];

  if (!versionCheckDisabled) {
    lines.push(
      // Phase 4.5: Detect whether ShipIt actually swapped the bundle. Read the
      // on-disk Info.plist's CFBundleShortVersionString via `plutil`. The
      // `tr -d '\n'` is REQUIRED — `plutil -extract ... raw -o -` always emits
      // a trailing newline; without stripping, the equality test below always
      // evaluates false on the success path. NOTE: this records evidence but
      // ALWAYS lets Phase 5 fire `open` so the user is never left with a
      // closed app even if ShipIt also failed to relaunch the new version
      // (C1 critique: "skip open" was the bug).
      `ON_DISK_VERSION=$(plutil -extract CFBundleShortVersionString raw -o - '${escapedBundlePath}/Contents/Info.plist' 2>/dev/null | tr -d '\\n')`,
      `ON_DISK_VERSION_KNOWN=0`,
      `INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED=0`,
      `if [ -n "$ON_DISK_VERSION" ]; then`,
      `  ON_DISK_VERSION_KNOWN=1`,
      `  if [ "$ON_DISK_VERSION" = '${escapedExpectedFromVersion}' ]; then`,
      `    INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED=1`,
      `  fi`,
      `fi`,
      `if [ $ON_DISK_VERSION_KNOWN -eq 0 ]; then`,
      `  ON_DISK_VERSION="unknown"`,
      `fi`,
    );
  }

  lines.push(
    // Phase 5: Launch the app bundle if not already running. ALWAYS fires
    // regardless of Phase 4.5 outcome (see C1 critique above).
    `OPEN_FIRED=0`,
    `if [ $ALREADY_RUNNING -eq 0 ]; then`,
    `  open '${escapedBundlePath}' && OPEN_FIRED=1`,
    `fi`,
    // Phase 6: Write telemetry (atomic: tmp + mv). Best-effort; ignore failures.
    // printf emits JSON. Booleans for ALREADY_RUNNING / OPEN_FIRED are serialized
    // as "true"/"false" based on the 0/1 flags.
    `ALREADY_RUNNING_JSON=false`,
    `if [ $ALREADY_RUNNING -eq 1 ]; then ALREADY_RUNNING_JSON=true; fi`,
    `OPEN_FIRED_JSON=false`,
    `if [ $OPEN_FIRED -eq 1 ]; then OPEN_FIRED_JSON=true; fi`,
  );

  if (versionCheckDisabled) {
    // Legacy 6-field telemetry payload — Stage 1's isWatchdogTelemetryPayload
    // accepts this shape via the I5 back-compat contract.
    lines.push(
      `printf '{"ranAt":%s,"oldPid":%s,"oldPidWaitSec":%s,"shipItWaitSec":%s,"appAlreadyRunning":%s,"openFired":%s,"externalForceKillSignal":"%s","externalForceKillGuardOutcome":"%s"}' ` +
        `"$(date +%s)" "${oldPid}" "$WAITED" "$SHIPIT_WAITED" "$ALREADY_RUNNING_JSON" "$OPEN_FIRED_JSON" "$EXTERNAL_FORCE_KILL_SIGNAL" "$EXTERNAL_FORCE_KILL_GUARD" ` +
        `> '${escapedTelemetryPath}.tmp' 2>/dev/null && mv '${escapedTelemetryPath}.tmp' '${escapedTelemetryPath}' 2>/dev/null || true`,
    );
  } else {
    // Stage 2 telemetry payload — adds installFailedBundleVersionUnchanged
    // and onDiskVersion. The Stage 5 reconciliation reads these to drive the
    // recovery dialog without needing to re-inspect the bundle on next launch.
    lines.push(
      `INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED_JSON=false`,
      `if [ $INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED -eq 1 ]; then INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED_JSON=true; fi`,
      `printf '{"ranAt":%s,"oldPid":%s,"oldPidWaitSec":%s,"shipItWaitSec":%s,"appAlreadyRunning":%s,"openFired":%s,"installFailedBundleVersionUnchanged":%s,"onDiskVersion":"%s","externalForceKillSignal":"%s","externalForceKillGuardOutcome":"%s"}' ` +
        `"$(date +%s)" "${oldPid}" "$WAITED" "$SHIPIT_WAITED" "$ALREADY_RUNNING_JSON" "$OPEN_FIRED_JSON" "$INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED_JSON" "$ON_DISK_VERSION" "$EXTERNAL_FORCE_KILL_SIGNAL" "$EXTERNAL_FORCE_KILL_GUARD" ` +
        `> '${escapedTelemetryPath}.tmp' 2>/dev/null && mv '${escapedTelemetryPath}.tmp' '${escapedTelemetryPath}' 2>/dev/null || true`,
    );
  }

  // IMPORTANT: Join with newlines, not "; ". Prior versions joined with "; "
  // which produced invalid POSIX syntax inside while/if bodies ("do;" etc.)
  // and silently broke the watchdog in sh-strict mode.
  return lines.join('\n');
}

/**
 * Initialize macOS auto-updater using update-electron-app (Squirrel.Mac).
 * This is the existing implementation, preserved unchanged.
 */
async function initMacOSAutoUpdater(): Promise<void> {
  const { updateElectronApp, UpdateSourceType } = await import('update-electron-app');
  const updateLog = createUpdateLogger();

  const isBetaApp = getBuildChannel() === 'beta';
  // NOTE: Update URL pattern is defined in multiple places - keep in sync:
  //   - src/main/services/autoUpdateService.ts (here + Windows section) - runtime fallback
  //   - forge.config.cjs - packageAfterCopy Step 10 app-update.yml generation
  //   - electron-builder.cjs - build-time publish config
  //   - scripts/build-windows-nsis.mjs - local build app-update.yml generation
  //   - src/main/services/health/checks/updates.ts - health check diagnostics
  const updateBasePath = isBetaApp ? 'updates-beta' : 'updates';
  const nativeArch = getNativeArch();
  const updateBaseUrl = `https://storage.googleapis.com/mindstone-rebel/${updateBasePath}/${process.platform}/${nativeArch}`;
  const channel: 'beta' | 'stable' = isBetaApp ? 'beta' : 'stable';
  const updateRuntime = describeUpdateRuntime(updateBaseUrl, channel, nativeArch);

  updateLog['info'](`[UPDATE-MAC] Auto-updater channel: ${channel}`);
  updateLog['info'](`[UPDATE-MAC] Auto-updater URL: ${updateBaseUrl}`);

  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.StaticStorage,
      baseUrl: updateBaseUrl,
    },
    updateInterval: '1 hour',
    logger: updateLog,
    notifyUser: false,
  });

  // IPC handler for manual update checks
  ipcMain.removeHandler('check-for-updates');
  ipcMain.handle('check-for-updates', async () => {
    if (inFlightManualUpdateCheck) {
      return inFlightManualUpdateCheck;
    }

    inFlightManualUpdateCheck = (async () => {
      const checkId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      updateLog['info']('[UPDATE-MAC] Manual update check requested', { checkId, ...updateRuntime });

      return await new Promise<{ available: boolean; version?: string; error?: string }>((resolve) => {
        let settled = false;

        const settleWithLog = (
          result: { available: boolean; version?: string; error?: string },
          reason: string
        ) => {
          updateLog['info']('[UPDATE-MAC] Manual update check settled', { checkId, reason, result });
          settle(result);
        };

        function settle(payload: { available: boolean; version?: string; error?: string }) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(payload);
        }

        const onUpdateAvailable = (info?: unknown) => {
          const version =
            typeof (info as { version?: unknown } | undefined)?.version === 'string'
              ? (info as { version: string }).version
              : undefined;
          settleWithLog({ available: true, version }, 'update-available');
        };

        const onUpdateNotAvailable = () => {
          settleWithLog({ available: false }, 'update-not-available');
        };

        const onUpdateDownloaded = (
          _event: unknown,
          _releaseNotes: unknown,
          releaseName?: string
        ) => {
          const version = parseSemverFromReleaseName(releaseName) ?? releaseName;
          settleWithLog({ available: true, version }, 'update-downloaded');
        };

        const onError = (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          settleWithLog({ available: false, error: message }, 'error');
        };

        const timeout = setTimeout(() => {
          settleWithLog({ available: false, error: 'Update check timed out' }, 'timeout');
        }, 10_000);

        function cleanup() {
          clearTimeout(timeout);
          autoUpdater.removeListener('update-available', onUpdateAvailable);
          autoUpdater.removeListener('update-not-available', onUpdateNotAvailable);
          autoUpdater.removeListener('update-downloaded', onUpdateDownloaded);
          autoUpdater.removeListener('error', onError);
        }

        autoUpdater.on('update-available', onUpdateAvailable);
        autoUpdater.on('update-not-available', onUpdateNotAvailable);
        autoUpdater.on('update-downloaded', onUpdateDownloaded);
        autoUpdater.on('error', onError);

        try {
          autoUpdater.checkForUpdates();
        } catch (error) {
          onError(error);
        }
      });
    })().finally(() => {
      inFlightManualUpdateCheck = null;
    });

    return inFlightManualUpdateCheck;
  });

  const getPrimaryWindow = () => getUpdatePrimaryWindow();

  // Toast acknowledge handler
  ipcMain.handle('update:acknowledge-toast', () => {
    const window = getPrimaryWindow();
    const pending = getPendingDownloadedUpdate();
    if (pending) {
      acknowledgeDownloadedUpdate(pending.updateKey);
    }
    updateLog['info']('[UPDATE-MAC] Update toast acknowledged', {
      ...updateRuntime,
      pendingUpdateKey: pending?.updateKey,
      ...describeWindowForUpdateLog(window),
    });
    return { acknowledged: true };
  });

  // Install now handler
  ipcMain.handle('update:install-now', () => {
    const window = getPrimaryWindow();
    const pending = getPendingDownloadedUpdate();
    updateLog['info']('[UPDATE-MAC] Install now requested', {
      ...updateRuntime,
      pendingUpdateKey: pending?.updateKey,
      ...describeWindowForUpdateLog(window),
    });

    if (!pending) {
      return { success: false, error: 'No downloaded update is available to install.' };
    }

    setImmediate(() => {
      fireAndForget((async () => {
        const result = await safeQuitAndInstallMacOS(updateLog);
        if (result.success) return;
        // The tailored "couldn't install" dialog was already shown for this
        // failure → don't also surface the generic failure path (no double up).
        if (result.userNotified) return;

        const errorMessage = result.error ?? 'Unknown error';
        let notifiedRenderer = false;

        try {
          const target = getPrimaryWindow();
          notifiedRenderer = target
            ? safeSendToWindow(target, 'update:install-failed', {
                updateKey: pending.updateKey,
                error: errorMessage,
              })
            : false;
        } catch {
          notifiedRenderer = false;
        }

        if (!notifiedRenderer) {
          try {
            fireAndForget(dialog.showMessageBox({
              type: 'error',
              title: 'Update Failed',
              message: 'Failed to install the update.',
              detail: errorMessage,
            }), 'autoUpdateService.line2002');
          } catch {
            // ignore
          }
        }
      })(), 'autoUpdate.macInstallNow');
    });

    return { success: true };
  });

  // Event handlers for Squirrel.Mac
  autoUpdater.on('checking-for-update', () => {
    updateLog['info']('[UPDATE-MAC] Checking for updates', updateRuntime);
    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: { transition: 'check_started', platform: process.platform as 'darwin' | 'win32' | 'linux' },
    });
    updateAutoUpdateState({
      lastCheckAt: Date.now(),
      lastCheckUrl: updateBaseUrl,
      appVersionAtLastEvent: app.getVersion(),
    });
  });

  autoUpdater.on('update-available', () => {
    setUpdateDownloading(true);
    updateLog['info']('[UPDATE-MAC] Update available');
    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: { transition: 'check_succeeded', platform: process.platform as 'darwin' | 'win32' | 'linux' },
    });
    updateAutoUpdateState({ lastCheckResult: 'available', appVersionAtLastEvent: app.getVersion() });
  });

  autoUpdater.on('update-downloaded', (_event, _releaseNotes, releaseName, _releaseDate, _updateURL) => {
    fireAndForget((async () => {
    setUpdateDownloading(false);
    const versionLabel = parseSemverFromReleaseName(releaseName) ?? releaseName ?? 'unknown';
    const updateKey = `${channel}:${process.platform}:${nativeArch}:${versionLabel}`;

    setPendingDownloadedUpdate({
      updateKey,
      versionLabel,
      downloadedAt: Date.now(),
    });

    updateAutoUpdateState({
      lastDownloadedVersion: versionLabel,
      lastDownloadedAt: Date.now(),
      appVersionAtLastEvent: app.getVersion(),
    });

    updateLog['info']('[UPDATE-MAC] Update downloaded', { ...updateRuntime, versionLabel, updateKey });

    const window = getPrimaryWindow();
    const windowInfo = describeWindowForUpdateLog(window);

    // Include the silent auto-heal counter so the renderer's toast can
    // surface the recovery copy on a push-first sequence — see
    // `useIpcListeners` and the REBEL-53B investigation doc.
    const recoveryAttempts = readRecoveryAttempts(updateKey);
    const sent = window
      ? safeSendToWindow(window, 'update:downloaded', {
          updateKey,
          version: versionLabel,
          recoveryAttempts,
        })
      : false;

    updateLog['info']('[UPDATE-MAC] Download notification attempt', {
      ...updateRuntime,
      versionLabel,
      updateKey,
      recoveryAttempts,
      sent,
      ...windowInfo,
    });

    if (sent) return;

    updateLog['info']('[UPDATE-MAC] Showing native dialog for update', { ...windowInfo });
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Update ${versionLabel} downloaded. Restart now to apply it?`,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) {
      updateLog['info']('[UPDATE-MAC] User accepted native update dialog');
      const installResult = await safeQuitAndInstallMacOS(updateLog);
      // Skip the generic dialog if the tailored "couldn't install" one was shown.
      if (!installResult.success && !installResult.userNotified) {
        try {
          fireAndForget(dialog.showMessageBox({
            type: 'error',
            title: 'Update Failed',
            message: 'Failed to install the update.',
            detail: installResult.error,
          }), 'autoUpdate.macInstallFailureDialog');
        } catch {
          // ignore
        }
      }
    } else {
      updateLog['info']('[UPDATE-MAC] User chose to install update later');
    }
    })(), 'autoUpdate.macUpdateDownloaded');
  });

  autoUpdater.on('error', (error) => {
    setUpdateDownloading(false);
    const rawMessage = error?.message;
    const errorMessage = typeof rawMessage === 'string' ? rawMessage : String(error);
    const categorized = categorizeError(error);
    const appVersion = app.getVersion();

    captureAutoUpdateFailureForSentry(categorized, process.platform, appVersion);

    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: { transition: 'check_failed', platform: process.platform as 'darwin' | 'win32' | 'linux', errorCategory: categorized.category },
    });

    updateAutoUpdateState({
      lastErrorAt: Date.now(),
      lastErrorMessage: errorMessage.slice(0, 500),
      lastCheckResult: 'error',
      appVersionAtLastEvent: appVersion,
    });

    // Check for lock contention (can happen if multiple app instances try to update)
    const isLockContention =
      errorMessage.includes("Couldn't acquire lock") || errorMessage.includes('is another instance running');

    if (isLockContention) {
      updateLog['info']('[UPDATE-MAC] Update check skipped: lock contention', updateRuntime);
    } else {
      updateLog['error']('[UPDATE-MAC] Auto-update error', {
        ...updateRuntime,
        error,
        category: categorized.category,
        retryable: categorized.retryable,
      });
    }

    if (shouldNotifyRendererForUpdateError(categorized.category)) {
      const window = getPrimaryWindow();
      if (window) {
        safeSendToWindow(window, 'update:error', {
          code: categorized.category.toUpperCase(),
          category: categorized.category,
          message: categorized.message,
          retryable: categorized.retryable,
        });
      }
    }
  });

  autoUpdater.on('update-not-available', () => {
    setUpdateDownloading(false);
    updateLog['info']('[UPDATE-MAC] No updates available');
    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: { transition: 'check_succeeded', platform: process.platform as 'darwin' | 'win32' | 'linux' },
    });
    updateAutoUpdateState({ lastCheckResult: 'not-available', appVersionAtLastEvent: app.getVersion() });

    const window = getPrimaryWindow();
    if (window) {
      safeSendToWindow(window, 'update:not-available', { currentVersion: app.getVersion() });
    }
  });

  updateAutoUpdateState({ initSucceeded: true, appVersionAtLastEvent: app.getVersion() });

  logger.info(
    { platform: process.platform as 'darwin' | 'win32' | 'linux', arch: process.arch, channel, updateUrl: updateBaseUrl },
    '[UPDATE-MAC] Auto-updater initialized successfully'
  );
}

// ============================================================================
// macOS Watchdog Telemetry (consumed on next launch)
// ============================================================================

/**
 * Shape of the JSON the watchdog shell script writes on macOS.
 *
 * `installFailedBundleVersionUnchanged` and `onDiskVersion` are OPTIONAL —
 * Stage 1 of the install completion contract
 * (`docs/plans/260428_install_completion_contract.md`) lands the schema, and
 * Stage 2 makes the watchdog actually populate them. A user upgrading across
 * the Stage 2 ship may consume an OLD telemetry file that lacks the new
 * fields, so `isWatchdogTelemetryPayload()` accepts payloads without them.
 */
export interface WatchdogTelemetryPayload {
  ranAt: number;
  oldPid: number;
  oldPidWaitSec: number;
  shipItWaitSec: number;
  appAlreadyRunning: boolean;
  openFired: boolean;
  /**
   * Stage 2 (back-compat with OLD payloads): true iff the watchdog detected
   * the on-disk bundle's CFBundleShortVersionString equals the from-version
   * (i.e. ShipIt did not swap the bundle).
   */
  installFailedBundleVersionUnchanged?: boolean;
  /**
   * Stage 2 (back-compat with OLD payloads): the on-disk
   * CFBundleShortVersionString at watchdog time, or `'unknown'` if the
   * watchdog couldn't read it.
   */
  onDiskVersion?: string;
  /**
   * Out-of-process force-kill escalation (260622): the strongest signal the
   * watchdog actually sent to the wedged old PID during the Phase-1 wait loop.
   * `'none'` = the old PID died on its own before the budget (normal install);
   * `'TERM'`/`'KILL'` = the external killer fired because the PID outlived the
   * SIGTERM/SIGKILL budget AND still named this Rebel exe. OPTIONAL for the
   * same back-compat reason as the Stage 2 fields (a user mid-upgrade may
   * consume an OLD payload that lacks it).
   */
  externalForceKillSignal?: 'none' | 'TERM' | 'KILL';
  /**
   * Out-of-process force-kill escalation (260622): the identity-guard outcome,
   * so a never-matching guard (a too-strict identity check that silently never
   * fires) is observable rather than a silent no-op. `'na'` = budget never
   * reached; `'identityMatched'` = guard confirmed this exe and we signalled;
   * `'identityMismatch'` = budget reached but the PID no longer named this exe.
   */
  externalForceKillGuardOutcome?: 'na' | 'identityMatched' | 'identityMismatch';
}

export function isWatchdogTelemetryPayload(value: unknown): value is WatchdogTelemetryPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  // Required fields (back-compat: an OLD payload has only these).
  const requiredOk =
    typeof v.ranAt === 'number' &&
    typeof v.oldPid === 'number' &&
    typeof v.oldPidWaitSec === 'number' &&
    typeof v.shipItWaitSec === 'number' &&
    typeof v.appAlreadyRunning === 'boolean' &&
    typeof v.openFired === 'boolean';
  if (!requiredOk) return false;
  // Optional Stage 2 fields: when present, they must be the right type.
  if (v.installFailedBundleVersionUnchanged !== undefined &&
      typeof v.installFailedBundleVersionUnchanged !== 'boolean') {
    return false;
  }
  if (v.onDiskVersion !== undefined && typeof v.onDiskVersion !== 'string') {
    return false;
  }
  // Optional force-kill fields (260622): when present, must be the right enum.
  if (
    v.externalForceKillSignal !== undefined &&
    !['none', 'TERM', 'KILL'].includes(v.externalForceKillSignal as string)
  ) {
    return false;
  }
  if (
    v.externalForceKillGuardOutcome !== undefined &&
    !['na', 'identityMatched', 'identityMismatch'].includes(
      v.externalForceKillGuardOutcome as string,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Attempt to read and consume the watchdog telemetry file. Returns `true` iff
 * the file existed AND was successfully parsed into the persistent state store
 * (invalid/unparseable files return `false` but are still deleted).
 * Best-effort — any error is swallowed and returned as `false`.
 */
function tryConsumeWatchdogTelemetry(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const telemetryPath = path.join(app.getPath('userData'), 'auto-update-watchdog-telemetry.json');
    if (!fsSync.existsSync(telemetryPath)) return false;

    let consumed = false;
    try {
      const raw = fsSync.readFileSync(telemetryPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isWatchdogTelemetryPayload(parsed)) {
        // Required fields (always present).
        const partial: Partial<AutoUpdateState> = {
          watchdogLastRanAt: parsed.ranAt * 1000, // script writes seconds; normalize to ms
          watchdogOldPidWaitSec: parsed.oldPidWaitSec,
          watchdogShipItWaitSec: parsed.shipItWaitSec,
          watchdogAppAlreadyRunning: parsed.appAlreadyRunning,
          watchdogOpenFired: parsed.openFired,
        };
        // Stage 1 (install completion contract) optional fields. Telemetry is
        // advisory; the install marker remains the source of truth for stuck
        // detection. We persist whatever the watchdog reported so Stage 5's
        // reconciliation can use it as a disambiguating signal. Back-compat:
        // OLD payloads (no Stage 2 fields) leave the store fields at their
        // existing values rather than overwriting them with `undefined`.
        if (parsed.installFailedBundleVersionUnchanged !== undefined) {
          partial.watchdogInstallFailedBundleVersionUnchanged =
            parsed.installFailedBundleVersionUnchanged;
        }
        if (parsed.onDiskVersion !== undefined) {
          partial.watchdogOnDiskVersion = parsed.onDiskVersion;
        }
        // Out-of-process force-kill escalation (260622). Back-compat: OLD
        // payloads without these fields leave the store at its existing value.
        if (parsed.externalForceKillSignal !== undefined) {
          partial.watchdogExternalForceKillSignal = parsed.externalForceKillSignal;
        }
        if (parsed.externalForceKillGuardOutcome !== undefined) {
          partial.watchdogExternalForceKillGuardOutcome =
            parsed.externalForceKillGuardOutcome;
        }
        updateAutoUpdateState(partial);
        logger.info({ watchdog: parsed }, '[UPDATE-MAC] Consumed relaunch watchdog telemetry');
        consumed = true;

        // Distinct Sentry signal (260622): the out-of-process force-kill net
        // ACTUALLY fired in the field — separate from quit_deadlock_detected
        // (the in-process tiers). Confirms the fix works + lets us tune budgets
        // post-deploy. Emit ONLY for TERM/KILL (never the 'none'/absent
        // happy-path). Best-effort / fire-and-forget — a capture failure must
        // never throw out of telemetry consumption (mirrors emitQuitDeadlockDetected).
        if (
          parsed.externalForceKillSignal === 'TERM' ||
          parsed.externalForceKillSignal === 'KILL'
        ) {
          try {
            captureKnownCondition(
              'update_external_force_kill_fired',
              {
                signal: parsed.externalForceKillSignal,
                tags: {
                  platform: process.platform,
                  externalForceKillGuardOutcome:
                    parsed.externalForceKillGuardOutcome ?? 'na',
                },
              },
              new Error(
                `Update watchdog external force-kill fired (${parsed.externalForceKillSignal})`,
              ),
            );
          } catch (captureErr) {
            ignoreBestEffortCleanup(captureErr, {
              operation: 'tryConsumeWatchdogTelemetry.captureKnownCondition',
              reason:
                'External-force-kill Sentry capture is best-effort; a capture failure must never break telemetry consumption',
            });
          }
        }
      } else {
        logger.warn({ raw }, '[UPDATE-MAC] Watchdog telemetry file had unexpected shape, ignoring');
      }
    } finally {
      // Delete regardless so we don't re-consume on the next launch.
      try { fsSync.unlinkSync(telemetryPath); } catch { /* ignore */ }
    }
    return consumed;
  } catch (error) {
    logger.warn({ err: error }, '[UPDATE-MAC] Failed to consume watchdog telemetry (non-fatal)');
    return false;
  }
}

/**
 * Read the watchdog telemetry file WITHOUT deleting it.
 *
 * Stage 5 of the install completion contract
 * (`docs/plans/260428_install_completion_contract.md`): the install-completion
 * reconciliation runs at module-load time, BEFORE `initAutoUpdater()` calls
 * `consumeWatchdogTelemetryOnStartup()` to delete the file. Reconciliation
 * needs to peek at the payload to disambiguate stuck-vs-applied without
 * removing it from disk — `consumeWatchdogTelemetryOnStartup()` will run a
 * few lines later and persist the watchdog fields into `auto-update-state`
 * (and finally delete the file).
 *
 * Returns the parsed payload on success, or `null` if the file is absent,
 * unreadable, malformed, or fails the type predicate. Never throws.
 */
export function peekWatchdogTelemetry(): WatchdogTelemetryPayload | null {
  if (process.platform !== 'darwin') return null;
  try {
    const telemetryPath = path.join(app.getPath('userData'), 'auto-update-watchdog-telemetry.json');
    if (!fsSync.existsSync(telemetryPath)) return null;
    const raw = fsSync.readFileSync(telemetryPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isWatchdogTelemetryPayload(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Consume the watchdog telemetry file: persist its fields into
 * `auto-update-state.json` (so the health check + diagnostic bundles can see
 * them) AND delete the file (so we don't re-consume on subsequent retries).
 *
 * Idempotent: if the file is already gone, returns `false` silently.
 *
 * Stage 5 (install completion contract) calls this from the reconciliation
 * service after using the peeked telemetry to drive its decision. The
 * existing `consumeWatchdogTelemetryOnStartup()` retries also call this path
 * via `tryConsumeWatchdogTelemetry`, so the post-reconciliation retries are
 * harmless no-ops on success.
 */
export function consumeWatchdogTelemetry(): boolean {
  return tryConsumeWatchdogTelemetry();
}

/**
 * Consume watchdog telemetry on startup, with retries to cover the race where
 * ShipIt relaunches the new app BEFORE the (still-running) watchdog finishes
 * polling ShipIt + settling + writing telemetry.
 *
 * Worst-case watchdog write timing: ShipIt poll up to 90s + 3s settle + open +
 * printf = ~95s from old-PID death. We retry for 3 minutes to be comfortably
 * safe without keeping a timer alive longer than necessary.
 *
 * Called at the start of `initAutoUpdater()` so diagnostics bundles surface
 * whether the watchdog actually ran, how long ShipIt took, and whether it had
 * to fire `open`.
 */
function consumeWatchdogTelemetryOnStartup(): void {
  if (process.platform !== 'darwin') return;

  // Immediate attempt for the case where telemetry was left over from a prior
  // launch (e.g. user quit and restarted manually while telemetry was still on
  // disk from the previous update).
  if (tryConsumeWatchdogTelemetry()) return;

  // Retry schedule: 15s, 30s, 60s, 120s, 180s after startup. Covers the full
  // watchdog timing envelope (ShipIt poll up to 90s + settle + write).
  const retryDelaysMs = [15_000, 30_000, 60_000, 120_000, 180_000];
  for (const delay of retryDelaysMs) {
    const timer = setTimeout(() => {
      tryConsumeWatchdogTelemetry();
    }, delay);
    // Don't keep the event loop alive for this; best-effort only.
    timer.unref?.();
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the auto-update system.
 * Should be called early in app startup, but only runs in packaged builds.
 * Skipped in headless CLI mode to avoid blocking dialogs in CI/automation.
 *
 * Platform behavior:
 * - macOS: Uses update-electron-app with Squirrel.Mac (unchanged)
 * - Windows: Uses electron-updater with NSIS (new, more reliable)
 * - Linux: Currently uses update-electron-app (future: AppImage auto-update via electron-updater)
 */
export function initAutoUpdater(): void {
  // Log platform detection at service initialization for debugging
  logger.info(
    {
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      arch: process.arch,
      isPackaged: app.isPackaged,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
    },
    '[UPDATE] Auto-update service initializing'
  );

  // Pick up any watchdog telemetry left by the previous launch's "Install & Relaunch".
  consumeWatchdogTelemetryOnStartup();

  registerUpdatePromptIpcHandlers();
  if (isRebelTestMode()) {
    logger.info('[UPDATE] Running in rebel-test mode - auto-updates disabled');
    ipcMain.handle('check-for-updates', async () => {
      return { available: false, error: 'Auto-updates are disabled in test mode' };
    });
    return;
  }

  if (!app.isPackaged) {
    logger.info('[UPDATE] Running in development mode - auto-updates disabled');
    ipcMain.handle('check-for-updates', async () => {
      return { available: false, error: 'Auto-updates are disabled in development mode' };
    });
    return;
  }

  if (isHeadlessCli()) {
    logger.info('[UPDATE] Running in headless CLI mode - auto-updates disabled');
    ipcMain.handle('check-for-updates', async () => {
      return { available: false, error: 'Auto-updates are disabled in headless CLI mode' };
    });
    return;
  }

  // Register stub handler to cover initialization window
  ipcMain.handle('check-for-updates', async () => {
    return { available: false, error: 'Auto-updater is initializing...' };
  });

  // Platform-specific initialization with comprehensive logging
  if (process.platform === 'win32') {
    // Windows: Use electron-updater with NSIS
    // Features: differential updates (disabled), enterprise SSL via win-ca, retry logic for lock errors
    logger.info(
      { updateMechanism: 'electron-updater', installerFormat: 'NSIS' },
      '[UPDATE] Initializing Windows auto-updater'
    );
    initWindowsAutoUpdater().catch((error) => {
      logger.error({ err: error }, '[UPDATE] Failed to initialize Windows auto-updater');
      // Ensure IPC handler exists even on failure
      try {
        ipcMain.removeHandler('check-for-updates');
      } catch {
        // ignore
      }
      ipcMain.handle('check-for-updates', async () => ({
        available: false,
        error: 'Auto-updater failed to initialize',
      }));
    });
  } else if (process.platform === 'darwin') {
    // macOS: Use update-electron-app with Squirrel.Mac
    // Features: automatic updates via Squirrel, 8s timeout fallback for stuck quits
    logger.info(
      { updateMechanism: 'update-electron-app', installerFormat: 'Squirrel.Mac' },
      '[UPDATE] Initializing macOS auto-updater'
    );
    initMacOSAutoUpdater().catch((error) => {
      logger.error({ err: error }, '[UPDATE] Failed to initialize macOS auto-updater');
      try {
        ipcMain.removeHandler('check-for-updates');
      } catch {
        // ignore
      }
      ipcMain.handle('check-for-updates', async () => ({
        available: false,
        error: 'Auto-updater failed to initialize',
      }));
    });
  } else if (process.platform === 'linux') {
    // Linux: Currently uses update-electron-app as fallback
    // FUTURE: Implement AppImage auto-update via electron-updater when Linux support is prioritized
    // electron-updater supports AppImage auto-update natively, but requires:
    // - Building with electron-builder's AppImage target
    // - Publishing linux-x64.yml / linux-arm64.yml alongside releases
    // - Testing across common distros (Ubuntu, Fedora, Arch)
    // See: https://www.electron.build/configuration/linux#appimage-options
    logger.info(
      { updateMechanism: 'update-electron-app', installerFormat: 'AppImage (future: electron-updater)' },
      '[UPDATE] Initializing Linux auto-updater (limited support)'
    );
    initMacOSAutoUpdater().catch((error) => {
      logger.error({ err: error }, '[UPDATE] Failed to initialize Linux auto-updater');
      try {
        ipcMain.removeHandler('check-for-updates');
      } catch {
        // ignore
      }
      ipcMain.handle('check-for-updates', async () => ({
        available: false,
        error: 'Auto-updater failed to initialize',
      }));
    });
  } else {
    // Unknown platform
    logger.warn(
      { platform: process.platform as 'darwin' | 'win32' | 'linux' },
      '[UPDATE] Unknown platform - auto-updates not configured'
    );
    ipcMain.handle('check-for-updates', async () => ({
      available: false,
      error: `Auto-updates not supported on platform: ${process.platform}`,
    }));
  }
}

// ============================================================================
// Post-Update Health Validation
// ============================================================================

/**
 * Simple store for tracking version across app restarts.
 * Used to detect first launch after an update.
 */
type UpdateHealthStore = {
  lastKnownVersion: string | null;
  lastValidationResult: {
    timestamp: number;
    version: string;
    success: boolean;
    issues: string[];
  } | null;
};

let _updateHealthStore: KeyValueStore<UpdateHealthStore> | null = null;
const getUpdateHealthStore = (): KeyValueStore<UpdateHealthStore> => {
  if (!_updateHealthStore) {
    _updateHealthStore = createStore<UpdateHealthStore>({
      name: 'update-health',
      defaults: {
        lastKnownVersion: null,
        lastValidationResult: null,
      },
    });
  }
  return _updateHealthStore;
};

/**
 * Result of post-update integrity validation.
 */
export interface PostUpdateValidationResult {
  success: boolean;
  isFirstLaunchAfterUpdate: boolean;
  previousVersion: string | null;
  currentVersion: string;
  issues: string[];
}

/**
 * Critical files/directories that must exist for the app to function.
 * Checked during post-update validation to detect incomplete installs.
 * 
 * NOTE: app.asar uses type 'any' because Electron's ASAR patching makes
 * fs.stat() report ASAR archives as directories (virtual filesystem).
 */
const CRITICAL_PATHS = [
  // Core app bundle (at least one of these must exist)
  // app.asar: type 'any' because Electron ASAR patching reports it as directory
  { path: 'app.asar', type: 'any' as const, optional: true },
  { path: 'app', type: 'directory' as const, optional: true },
  // Rebel system (skills, help docs)
  { path: 'rebel-system', type: 'directory' as const, optional: false },
  // MCP connectors
  { path: 'mcp', type: 'directory' as const, optional: false },
  // Connector catalog for MCP discovery
  { path: 'connector-catalog.json', type: 'file' as const, optional: false },
];

/**
 * Minimum expected file count in resources directory.
 * A drastically lower count might indicate incomplete installation.
 */
const MIN_EXPECTED_RESOURCE_ITEMS = 5;

/**
 * Verify the integrity of the app installation after an update.
 * 
 * This function checks:
 * 1. Critical files exist in the resources directory
 * 2. Minimum file count is present (guards against incomplete installs)
 * 3. Main settings store can be opened
 * 
 * Should be called early in startup, after stores are initialized.
 * 
 * @returns Validation result with details about any issues found
 */
export async function verifyPostUpdateIntegrity(): Promise<PostUpdateValidationResult> {
  const currentVersion = app.getVersion();
  const lastKnownVersion = getUpdateHealthStore().get('lastKnownVersion') ?? null;
  const isFirstLaunchAfterUpdate = lastKnownVersion !== null && lastKnownVersion !== currentVersion;
  
  const issues: string[] = [];
  
  // Only perform full validation on first launch after update (or first launch ever)
  // This avoids unnecessary file system checks on every startup
  const shouldValidate = isFirstLaunchAfterUpdate || lastKnownVersion === null;
  
  if (!shouldValidate) {
    // Not first launch after update - return cached result or success
    const cached = getUpdateHealthStore().get('lastValidationResult');
    if (cached && cached.version === currentVersion) {
      return {
        success: cached.success,
        isFirstLaunchAfterUpdate: false,
        previousVersion: lastKnownVersion,
        currentVersion,
        issues: cached.issues,
      };
    }
    // No cached result for this version but not an update - assume OK
    return {
      success: true,
      isFirstLaunchAfterUpdate: false,
      previousVersion: lastKnownVersion,
      currentVersion,
      issues: [],
    };
  }
  
  logger.info(
    { currentVersion, lastKnownVersion, isFirstLaunchAfterUpdate },
    '[POST-UPDATE] Running post-update integrity validation'
  );
  
  // In dev mode, skip resource validation (resources are in different locations)
  if (!app.isPackaged) {
    logger.info('[POST-UPDATE] Skipping validation in development mode');
    getUpdateHealthStore().set('lastKnownVersion', currentVersion);
    return {
      success: true,
      isFirstLaunchAfterUpdate,
      previousVersion: lastKnownVersion,
      currentVersion,
      issues: [],
    };
  }
  
  const resourcesPath = process.resourcesPath;
  
  // Check 1: Verify critical paths exist (with retry for AV interference on Windows)
  let hasAppBundle = false;
  for (const critical of CRITICAL_PATHS) {
    const fullPath = path.join(resourcesPath, critical.path);
    try {
      const stat = await withFileAccessRetry(
        () => fs.stat(fullPath),
        `stat:${critical.path}`
      );
      
      // type 'any' means we just check existence, not file vs directory
      // (needed for app.asar because Electron ASAR patching reports it as directory)
      const isCorrectType = critical.type === 'any' 
        ? true 
        : (critical.type === 'file' ? stat.isFile() : stat.isDirectory());
      
      if (!isCorrectType) {
        if (!critical.optional) {
          issues.push(`${critical.path}: expected ${critical.type} but found ${stat.isFile() ? 'file' : 'directory'}`);
        }
      } else if (critical.path === 'app.asar' || critical.path === 'app') {
        hasAppBundle = true;
      }
    } catch {
      if (!critical.optional) {
        issues.push(`${critical.path}: missing (required ${critical.type})`);
      }
    }
  }
  
  // At least one app bundle format must exist
  if (!hasAppBundle) {
    issues.push('app bundle: neither app.asar nor app directory found');
  }
  
  // Check 2: Verify minimum file count in resources (with retry)
  try {
    const resourceItems = await withFileAccessRetry(
      () => fs.readdir(resourcesPath),
      'readdir:resources'
    );
    if (resourceItems.length < MIN_EXPECTED_RESOURCE_ITEMS) {
      issues.push(
        `resources directory has only ${resourceItems.length} items (expected at least ${MIN_EXPECTED_RESOURCE_ITEMS})`
      );
    }
  } catch (err) {
    issues.push(`Cannot read resources directory: ${err instanceof Error ? err.message : String(err)}`);
  }
  
  // Check 3: Verify settings store is accessible (with retry)
  // (Already using updateHealthStore, so electron-store is working)
  // Additional check: try to read the main settings store
  try {
    // Don't fail if settings don't exist (fresh install), just check we can access userData
    await withFileAccessRetry(
      () => fs.access(app.getPath('userData'), fsSync.constants.R_OK | fsSync.constants.W_OK),
      'access:userData'
    );
  } catch (err) {
    issues.push(`Cannot access userData directory: ${err instanceof Error ? err.message : String(err)}`);
  }
  
  const success = issues.length === 0;
  
  // Log results
  if (success) {
    logger.info(
      { currentVersion, previousVersion: lastKnownVersion },
      '[POST-UPDATE] Integrity validation passed'
    );
  } else {
    logger.error(
      { currentVersion, previousVersion: lastKnownVersion, issues },
      '[POST-UPDATE] Integrity validation failed'
    );
  }
  
  // Update stored version and cache result
  getUpdateHealthStore().set('lastKnownVersion', currentVersion);
  getUpdateHealthStore().set('lastValidationResult', {
    timestamp: Date.now(),
    version: currentVersion,
    success,
    issues,
  });
  
  // Track analytics for post-update validation
  if (isFirstLaunchAfterUpdate) {
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'Post-Update Validation',
      properties: {
        success,
        previousVersion: lastKnownVersion,
        currentVersion,
        issueCount: issues.length,
        platform: process.platform as 'darwin' | 'win32' | 'linux',
        arch: process.arch,
      },
    });
  }
  
  return {
    success,
    isFirstLaunchAfterUpdate,
    previousVersion: lastKnownVersion,
    currentVersion,
    issues,
  };
}

/**
 * Show a user-friendly dialog when post-update validation fails.
 * Gives user the option to continue anyway or report the issue.
 * 
 * @param result - The validation result with issues
 * @returns User's choice: 'continue' or 'report'
 */
export async function showPostUpdateValidationFailedDialog(
  result: PostUpdateValidationResult
): Promise<'continue' | 'report'> {
  const issueList = result.issues.map(i => `• ${i}`).join('\n');
  
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Update Verification Issue',
    message: 'Some files may not have installed correctly.',
    detail: `The following issues were detected after updating from ${result.previousVersion ?? 'unknown'} to ${result.currentVersion}:\n\n${issueList}\n\nYou can continue using the app, but some features may not work correctly. Please report this issue if problems persist.`,
    buttons: ['Continue Anyway', 'Report Issue'],
    defaultId: 0,
    cancelId: 0,
  });
  
  return response === 1 ? 'report' : 'continue';
}
