/**
 * Single-Instance Lock (All Platforms)
 *
 * Prevents multiple instances of the app from running simultaneously.
 * When a second instance is launched, focus the existing window instead.
 * Skip in headless CLI mode to allow concurrent automation runs.
 *
 * Must be called before heavy initialization but after Squirrel event handling.
 *
 * Special handling for update relaunch fallback: When the app is relaunched as
 * a backup during auto-update (via --update-relaunch-fallback flag), exit silently
 * if another instance already has the lock. This prevents confusing "already running"
 * dialogs when both Squirrel and Electron's relaunch succeed.
 * See: docs/plans/finished/260129_auto_update_relaunch_failure.md
 */

import { app } from 'electron';
import { isHeadlessCli, isE2eTestMode } from '../utils/testIsolation';
import { showStartupErrorBox } from './startupDialog';

const DEEP_LINK_PROTOCOL = 'mindstone';
const UPDATE_RELAUNCH_FALLBACK_FLAG = '--update-relaunch-fallback';

/**
 * Check if this instance was launched via protocol handler (e.g., mindstone://callback).
 * On Windows, deep link URLs are passed as command line arguments to a new instance.
 */
function isProtocolHandlerInvocation(): boolean {
  return process.argv.some((arg) => arg.startsWith(`${DEEP_LINK_PROTOCOL}://`));
}

/**
 * Check if this instance was launched as an update relaunch fallback.
 * This happens when Electron's app.relaunch() is used as a backup in case
 * Squirrel/ShipIt fails to spawn the new instance during auto-update.
 */
function isUpdateRelaunchFallback(): boolean {
  return process.argv.includes(UPDATE_RELAUNCH_FALLBACK_FLAG);
}

/**
 * Acquire single-instance lock.
 * @returns true if lock was acquired or not needed, false if another instance is running
 */
export function acquireSingleInstanceLock(): boolean {
  // Skip in headless CLI mode to allow concurrent automation runs
  if (isHeadlessCli()) {
    return true;
  }

  // Skip in E2E test mode so tests can run while the real app is open.
  // Tests use isolated userData directories, so there's no data conflict.
  if (isE2eTestMode()) {
    return true;
  }

  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    // For protocol handler invocations (OAuth callbacks on Windows), exit silently.
    // The first instance receives the deep link URL via second-instance event.
    // 
    // Key insight: Electron forwards argv to the first instance as part of the
    // single-instance lock handoff. The critical fix is avoiding the blocking dialog
    // that interferes with IPC delivery.
    //
    // Use app.exit(0) for clean exit (Electron's recommended immediate exit pattern).
    if (isProtocolHandlerInvocation()) {
      // eslint-disable-next-line no-console -- intentional: pre-bootstrap single-instance exit path runs before the app logger is initialized
      console.log('[singleInstanceLock] Protocol handler detected, exiting to let primary instance handle');
      app.exit(0);
      return false;
    }

    // For update relaunch fallback, exit silently.
    // This happens when both Squirrel/ShipIt AND Electron's app.relaunch() succeed
    // in spawning a new instance. The first one wins the lock, the second exits quietly.
    // No dialog needed - this is expected behavior, not an error.
    // See: docs/plans/finished/260129_auto_update_relaunch_failure.md
    if (isUpdateRelaunchFallback()) {
      // eslint-disable-next-line no-console -- intentional: pre-bootstrap update-relaunch fallback runs before the app logger is initialized
      console.log('[singleInstanceLock] Update relaunch fallback: another instance running, exiting silently');
      app.exit(0);
      return false;
    }

    // For manual double-launch, show user-friendly error
    // (Focusing the existing instance is handled via the `second-instance` handler
    // in the main app, but this provides user feedback when we can't reliably focus cross-app.)
    showStartupErrorBox(
      'Rebel is already running',
      'Another instance of Rebel is already open. Switch to the existing window and close this one.',
    );

    app.quit();
    process.exit(0);
  }

  return true;
}
