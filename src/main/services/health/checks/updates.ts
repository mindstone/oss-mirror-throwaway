/**
 * Auto-Update Health Checks
 *
 * Checks auto-update configuration, channel detection, and runtime state.
 * Uses the persistent auto-update state store for init failures and recent errors.
 */

import { getPlatformConfig } from '@core/platform';
import { getBuildChannel, type BuildChannel } from '@main/utils/buildChannel';
import { getNativeArch } from '@main/utils/nativeArch';
import { getAutoUpdateState } from '../../autoUpdateStateStore';
import type { CheckResult } from '../types';

// Report errors as warnings if they occurred within the last hour
const RECENT_ERROR_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Get the detected update channel.
 * Uses the centralized channel detection utility (returns 'dev' for unpackaged builds).
 */
function getUpdateChannel(): BuildChannel {
  return getBuildChannel();
}

/**
 * Check auto-update configuration and runtime state.
 * Reports update channel, whether auto-updates are enabled, and any recent failures.
 */
export function checkAutoUpdateHealth(): CheckResult {
  const isPackaged = getPlatformConfig().isPackaged;
  const channel = getUpdateChannel();

  if (!isPackaged) {
    return {
      id: 'autoUpdateHealth',
      name: 'Auto-Updates',
      status: 'skip',
      message: 'Auto-updates disabled in development mode',
      details: {
        isPackaged,
        channel,
      },
    };
  }

  const nativeArch = getNativeArch();
  // NOTE: Update URL pattern is defined in multiple places - keep in sync:
  //   - src/main/services/health/checks/updates.ts (here) - health check diagnostics
  //   - src/main/services/autoUpdateService.ts - runtime fallback (Windows & macOS)
  //   - forge.config.cjs - packageAfterCopy Step 10 app-update.yml generation
  //   - electron-builder.cjs - build-time publish config
  //   - scripts/build-windows-nsis.mjs - local build app-update.yml generation
  const updateBasePath = channel === 'beta' ? 'updates-beta' : 'updates';
  const updateBaseUrl = `https://storage.googleapis.com/mindstone-rebel/${updateBasePath}/${process.platform}/${nativeArch}`;
  const runtimeState = getAutoUpdateState();

  // Check for init failure
  if (runtimeState.initSucceeded === false) {
    return {
      id: 'autoUpdateHealth',
      name: 'Auto-Updates',
      status: 'warn',
      message: 'Auto-updater failed to initialize',
      details: {
        isPackaged,
        channel,
        platform: process.platform,
        arch: nativeArch,
        runningArch: process.arch !== nativeArch ? process.arch : undefined,
        updateUrl: updateBaseUrl,
        runtimeState,
      },
    };
  }

  // Note: REBEL-53B removed the `stuckInstall` warn branch. The new
  // architecture surfaces stuck installs via the `UpdateAvailableToast`
  // (driven by `recoveryAttempts`) — the health check no longer needs to
  // double-surface them. See
  // docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md.

  // Check for recent error
  if (
    runtimeState.lastCheckResult === 'error' &&
    runtimeState.lastErrorAt &&
    Date.now() - runtimeState.lastErrorAt < RECENT_ERROR_THRESHOLD_MS
  ) {
    return {
      id: 'autoUpdateHealth',
      name: 'Auto-Updates',
      status: 'warn',
      message: `Auto-update error: ${runtimeState.lastErrorMessage ?? 'unknown'}`,
      details: {
        isPackaged,
        channel,
        platform: process.platform,
        arch: nativeArch,
        runningArch: process.arch !== nativeArch ? process.arch : undefined,
        updateUrl: updateBaseUrl,
        runtimeState,
      },
    };
  }

  return {
    id: 'autoUpdateHealth',
    name: 'Auto-Updates',
    status: 'pass',
    message: `Auto-updates enabled (${channel} channel)`,
    details: {
      isPackaged,
      channel,
      platform: process.platform,
      arch: nativeArch,
      runningArch: process.arch !== nativeArch ? process.arch : undefined,
      updateUrl: updateBaseUrl,
      runtimeState,
    },
  };
}
