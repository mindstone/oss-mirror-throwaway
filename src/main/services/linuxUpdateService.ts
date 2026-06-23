/**
 * Linux Update Notification Service
 *
 * Electron's autoUpdater does not support Linux, so we implement a notification-only
 * system that checks for updates and prompts the user to download manually.
 *
 * Features:
 * - Periodic update checks (every 4 hours)
 * - Initial check 15 seconds after startup
 * - Detects beta vs stable channel from version string
 * - Sends update notification to renderer for toast display
 */

import { app } from 'electron';
import axios from 'axios';
import semver from 'semver';
import { logger } from '@core/logger';
import { getBuildChannel } from '@main/utils/buildChannel';
import {
  getUpdatePrimaryWindow,
  isDownloadedUpdateAcknowledged,
  setPendingDownloadedUpdate,
} from './updateNotificationState';
import { getAutoUpdateState } from './autoUpdateStateStore';
import { isRebelTestMode } from '../utils/testIsolation';
import { createPausableInterval } from './visibilityAwareScheduler';
import { fireAndForget } from '@shared/utils/fireAndForget';

let updateCheckInterval: (() => void) | null = null;

/**
 * Check for Linux updates by fetching the latest manifest.
 */
async function checkForUpdate(): Promise<void> {
  try {
    const currentVersion = app.getVersion();
    const isBetaApp = getBuildChannel() === 'beta';
    const releasesPath = isBetaApp ? 'releases-beta' : 'releases';
    const manifestUrl = `https://storage.googleapis.com/mindstone-rebel/${releasesPath}/latest.json`;

    logger.info({ manifestUrl, currentVersion, isBetaApp }, 'Checking for Linux updates');

    const response = await axios.get(manifestUrl, { timeout: 10000 });
    const manifest = response.data;

    if (!manifest || typeof manifest.version !== 'string') {
      logger.warn({ manifest }, 'Invalid manifest format');
      return;
    }

    const latestVersion = manifest.version;
    const linuxArch = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
    const linuxPlatform = manifest.platforms?.[linuxArch];

    if (!linuxPlatform?.url) {
      logger.debug({ arch: linuxArch }, `No Linux ${process.arch} release available in manifest`);
      return;
    }

    if (semver.gt(latestVersion, currentVersion)) {
      logger.info({ currentVersion, latestVersion }, 'Linux update available');

      const updateKey = `${getBuildChannel()}:${process.platform}:${process.arch}:${latestVersion}`;

      setPendingDownloadedUpdate({
        updateKey,
        versionLabel: latestVersion,
        downloadedAt: Date.now(),
        downloadUrl: linuxPlatform.url,
      });

      // Avoid toast spam across periodic checks once the renderer has shown the prompt.
      if (isDownloadedUpdateAcknowledged(updateKey)) {
        return;
      }

      // Include silent auto-heal counter so the renderer toast adapts its
      // copy on a push-first sequence (REBEL-53B). Linux has no auto-heal
      // path today (the service is notification-only), but we surface the
      // counter consistently across all three platforms for forward
      // compatibility.
      let recoveryAttempts = 0;
      try {
        const map = getAutoUpdateState().recoveryAttempts ?? {};
        recoveryAttempts = map[updateKey] ?? 0;
      } catch {
        recoveryAttempts = 0;
      }

      const window = getUpdatePrimaryWindow();
      if (window) {
        window.webContents.send('update:downloaded', {
          updateKey,
          version: latestVersion,
          downloadUrl: linuxPlatform.url,
          recoveryAttempts,
        });
      }
    } else {
      logger.debug({ currentVersion, latestVersion }, 'Linux app is up to date');
    }
  } catch (error) {
    logger.warn({ err: error }, 'Failed to check for Linux updates');
  }
}

/**
 * Initialize Linux update notification system.
 * Only runs on Linux in packaged builds.
 */
export function initLinuxUpdater(): void {
  if (process.platform !== 'linux' || !app.isPackaged || isRebelTestMode()) {
    return;
  }

  // Initial check after app is ready (delayed to let UI settle)
  fireAndForget(app.whenReady().then(() => {
    setTimeout(() => {
      fireAndForget(checkForUpdate(), 'linuxUpdateService.line118');
    }, 15000); // 15 seconds after startup

    // Periodic checks every 4 hours (pauses when app is hidden/blurred — check on resume is fine)
    updateCheckInterval = createPausableInterval(() => {
      fireAndForget(checkForUpdate(), 'linuxUpdateService.line123');
    }, 4 * 60 * 60 * 1000, { pauseOnBlur: true, catchUpPriority: 8 });
  }), 'linuxUpdateService.line117');

  // Cleanup on quit
  app.on('will-quit', () => {
    if (updateCheckInterval) {
      updateCheckInterval();
      updateCheckInterval = null;
    }
  });

  logger.info('Linux update notification system initialized');
}
