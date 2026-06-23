/**
 * App Domain IPC Handlers
 *
 * Handles shell operations like opening paths/URLs.
 */

import { app, shell, clipboard, nativeImage, dialog, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '@core/logger';
import { registerHandler } from './utils/registerHandler';
import { isAllowedExternalUrl } from '../utils/isAllowedExternalUrl';
import { wasCleanExit } from '../services/gracefulShutdown';
import {
  getSafeModeContext,
  saveContextBeforeRelaunch,
  type SafeModeReason,
  type SafeModeErrorCategory,
} from '../services/safeModeContext';
import { getTutorialPlayerUrl } from '../services/tutorialPlayerServer';
import { resolveViaSpaceName } from '../services/spaceService';
import {
  consumePendingNotificationClickIntentResult,
  type NotificationClickIntent,
} from '../services/desktopNotification/notificationClickIntent';
import type { AppSettings } from '@shared/types';
import type { RevealPathResult } from '@shared/ipc/channels/app';

export interface AppHandlerDeps {
  getSettings: () => AppSettings;
  isSafeMode: () => boolean;
  setSafeModeEnabled: (enabled: boolean) => void;
}

interface EnterSafeModePayload {
  reason: SafeModeReason;
  sentryEventId?: string;
  errorCategory?: SafeModeErrorCategory;
}

export function registerAppHandlers(deps: AppHandlerDeps): void {
  const { getSettings, isSafeMode: _isSafeMode, setSafeModeEnabled } = deps;

  registerHandler('app:was-clean-exit', () => {
    return wasCleanExit();
  });

  registerHandler('app:open-path', async (_event: IpcMainInvokeEvent, target: string) => {
    if (!target) return;
    try {
      let resolvedPath = target;
      if (!path.isAbsolute(target)) {
        const settings = getSettings();
        if (settings.coreDirectory) {
          resolvedPath = path.resolve(settings.coreDirectory, target);
          // Space-name resolution: if the direct path doesn't exist, try
          // interpreting the first segment as a space display name.
          try {
            await fs.stat(resolvedPath);
          } catch {
            const spaceResolved = await resolveViaSpaceName(target, settings.coreDirectory);
            if (spaceResolved) {
              resolvedPath = spaceResolved;
            }
          }
          logger.debug({ original: target, resolved: resolvedPath }, 'Resolved relative path for open');
        }
      }
      const result = await shell.openPath(resolvedPath);
      if (result) {
        throw new Error(result);
      }
    } catch (error) {
      logger.error({ err: error, target }, 'Failed to open path');
      throw new Error('Unable to open path in system file explorer.');
    }
  });

  registerHandler('app:open-url', async (_event: IpcMainInvokeEvent, url: string) => {
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid URL provided.');
    }
    const trimmedUrl = url.trim();
    // Shared allowlist — same policy as setWindowOpenHandler / will-navigate.
    // See src/main/utils/isAllowedExternalUrl.ts.
    if (!isAllowedExternalUrl(trimmedUrl)) {
      logger.warn({ url: trimmedUrl }, 'Blocked attempt to open non-http(s) URL');
      throw new Error('Only http and https URLs are allowed.');
    }
    try {
      await shell.openExternal(trimmedUrl);
      logger.debug({ url: trimmedUrl }, 'Opened external URL in default browser');
    } catch (error) {
      logger.error({ err: error, url: trimmedUrl }, 'Failed to open external URL');
      throw new Error('Unable to open URL in default browser.');
    }
  });

  registerHandler('app:reveal-path', async (_event: IpcMainInvokeEvent, target: string): Promise<RevealPathResult> => {
    if (!target || typeof target !== 'string') {
      // Programmer error rather than a runtime reveal failure — classify as system.
      return { ok: false, reason: 'system', message: 'Invalid path provided.' };
    }
    try {
      // Resolve relative paths against workspace root
      let resolvedPath = target;
      if (!path.isAbsolute(target)) {
        const settings = getSettings();
        if (settings.coreDirectory) {
          resolvedPath = path.resolve(settings.coreDirectory, target);
          logger.debug({ original: target, resolved: resolvedPath }, 'Resolved relative path for reveal');
        }
      }

      // Preflight: classify missing vs permission before touching the shell so
      // we can give the user an actionable reason (FOX-3422).
      let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
      try {
        stat = await fs.stat(resolvedPath);
      } catch (statErr) {
        const code = (statErr as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          logger.error({ err: statErr, target }, 'Failed to reveal path: file missing');
          return { ok: false, reason: 'missing', message: 'The file or folder no longer exists.' };
        }
        if (code === 'EACCES' || code === 'EPERM') {
          logger.error({ err: statErr, target }, 'Failed to reveal path: permission denied');
          return {
            ok: false,
            reason: 'permission',
            message: 'Your computer is blocking access to this file.',
          };
        }
        // Unknown stat error — fall through and let the shell attempt it.
        logger.warn({ err: statErr, target }, 'Reveal path stat failed with unexpected error');
      }

      if (stat && stat.isFile()) {
        // Reveal the file in its folder and select it
        shell.showItemInFolder(resolvedPath);
        return { ok: true };
      }
      // For directories or unknown: open the folder
      const directory = stat && stat.isDirectory() ? resolvedPath : path.dirname(resolvedPath);
      const result = await shell.openPath(directory);
      if (result) {
        throw new Error(result);
      }
      return { ok: true };
    } catch (error) {
      // Best-effort operation: log but don't throw. Most callers fire-and-forget
      // (void revealPath(...)), so throwing causes unhandled promise rejections (REBEL-2E).
      // FOX-3422: return a structured failure so callers can surface a toast.
      logger.error({ err: error, target }, 'Failed to reveal path');
      const message = error instanceof Error ? error.message : String(error);
      const reason: 'permission' | 'system' =
        /permission|denied|EACCES|EPERM/i.test(message) ? 'permission' : 'system';
      return {
        ok: false,
        reason,
        message:
          reason === 'permission'
            ? 'Your computer is blocking access to this file.'
            : 'Unable to reveal the file in the system file explorer.',
      };
    }
  });

  registerHandler(
    'app:show-notification',
    async (_event: IpcMainInvokeEvent, payload: { title: string; body: string; sessionId?: string; filePath?: string }) => {
      if (!payload || typeof payload !== 'object') {
        logger.debug('Invalid notification payload');
        return;
      }
      const { showDesktopNotification } = await import('../services/desktopNotificationService');
      showDesktopNotification(payload);
    }
  );

  registerHandler(
    'app:consume-pending-notification-click',
    (): NotificationClickIntent | null => {
      const result = consumePendingNotificationClickIntentResult();
      const { intent } = result;
      if (!intent) {
        logger.info(
          { hit: false, missReason: result.missReason, intentAgeMs: result.intentAgeMs },
          'Consumed pending notification click intent',
        );
        return null;
      }
      logger.info(
        { hit: true, intentAgeMs: result.intentAgeMs, sessionId: intent.sessionId, filePath: intent.filePath },
        'Consumed pending notification click intent',
      );
      return intent;
    }
  );

  registerHandler(
    'app:copy-image-to-clipboard',
    async (_event: IpcMainInvokeEvent, payload: { dataUrl?: string; filePath?: string }) => {
      try {
        let image: Electron.NativeImage;

        if (payload.dataUrl) {
          image = nativeImage.createFromDataURL(payload.dataUrl);
        } else if (payload.filePath) {
          // Resolve relative paths against workspace root
          let resolvedPath = payload.filePath;
          if (!path.isAbsolute(payload.filePath)) {
            const settings = getSettings();
            if (settings.coreDirectory) {
              resolvedPath = path.resolve(settings.coreDirectory, payload.filePath);
            }
          }
          image = nativeImage.createFromPath(resolvedPath);
        } else {
          throw new Error('Either dataUrl or filePath must be provided');
        }

        if (image.isEmpty()) {
          throw new Error('Failed to create image - the image may be invalid or unsupported');
        }

        clipboard.writeImage(image);
        logger.debug('Image copied to clipboard');
      } catch (error) {
        logger.error({ err: error }, 'Failed to copy image to clipboard');
        throw new Error('Unable to copy image to clipboard.');
      }
    }
  );

  registerHandler(
    'app:save-image-as',
    async (
      _event: IpcMainInvokeEvent,
      payload: { dataUrl?: string; filePath?: string; defaultName?: string }
    ): Promise<{ saved: boolean; savedPath?: string }> => {
      try {
        // Determine file extension from source
        let ext = 'png';
        if (payload.dataUrl) {
          const mimeMatch = payload.dataUrl.match(/^data:image\/(\w+);/);
          if (mimeMatch) {
            ext = mimeMatch[1] === 'jpeg' ? 'jpg' : mimeMatch[1];
          }
        } else if (payload.filePath) {
          ext = path.extname(payload.filePath).slice(1).toLowerCase() || 'png';
        }

        const defaultName = payload.defaultName || `image.${ext}`;

        const result = await dialog.showSaveDialog({
          title: 'Save Image',
          defaultPath: defaultName,
          filters: [
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        });

        if (result.canceled || !result.filePath) {
          return { saved: false };
        }

        let imageBuffer: Buffer;

        if (payload.dataUrl) {
          // Extract base64 data from data URL
          const base64Match = payload.dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
          if (!base64Match) {
            throw new Error('Invalid data URL format');
          }
          imageBuffer = Buffer.from(base64Match[1], 'base64');
        } else if (payload.filePath) {
          // Read from source file
          let resolvedPath = payload.filePath;
          if (!path.isAbsolute(payload.filePath)) {
            const settings = getSettings();
            if (settings.coreDirectory) {
              resolvedPath = path.resolve(settings.coreDirectory, payload.filePath);
            }
          }
          imageBuffer = await fs.readFile(resolvedPath);
        } else {
          throw new Error('Either dataUrl or filePath must be provided');
        }

        await fs.writeFile(result.filePath, imageBuffer);
        logger.debug({ savedPath: result.filePath }, 'Image saved');

        return { saved: true, savedPath: result.filePath };
      } catch (error) {
        logger.error({ err: error }, 'Failed to save image');
        throw new Error('Unable to save image.');
      }
    }
  );

  registerHandler(
    'app:save-text-as',
    async (
      _event: IpcMainInvokeEvent,
      payload: { content: string; defaultName?: string; defaultPath?: string }
    ): Promise<{ saved: boolean; savedPath?: string }> => {
      try {
        const settings = getSettings();
        const fallbackName = payload.defaultName || 'document.md';
        let defaultPath: string;

        if (payload.defaultPath) {
          defaultPath = payload.defaultPath;
          if (!path.isAbsolute(defaultPath) && settings.coreDirectory) {
            defaultPath = path.resolve(settings.coreDirectory, defaultPath);
          }
        } else if (settings.coreDirectory) {
          defaultPath = path.join(settings.coreDirectory, fallbackName);
        } else {
          defaultPath = fallbackName;
        }

        const result = await dialog.showSaveDialog({
          title: 'Save Document',
          defaultPath,
          filters: [
            { name: 'Markdown', extensions: ['md'] },
            { name: 'Text', extensions: ['txt'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        });

        if (result.canceled || !result.filePath) {
          return { saved: false };
        }

        await fs.writeFile(result.filePath, payload.content, 'utf8');
        logger.debug({ savedPath: result.filePath }, 'Text saved');

        return { saved: true, savedPath: result.filePath };
      } catch (error) {
        logger.error({ err: error }, 'Failed to save text');
        throw new Error('Unable to save text.');
      }
    }
  );

  // =============================================================================
  // Safe Mode Handlers
  // =============================================================================

  registerHandler('app:safe-mode-state', () => {
    // Return full Safe Mode context (isEnabled, reason, errorCategory, sentryEventId, triggeredAt)
    return getSafeModeContext();
  });

  registerHandler('app:enter-safe-mode', async (_event: IpcMainInvokeEvent, payload: EnterSafeModePayload) => {
    const { reason, sentryEventId, errorCategory } = payload;
    logger.info({ reason, sentryEventId, errorCategory }, 'Entering Safe Mode - app will restart without tools');

    // Save context to temp file BEFORE relaunch (must await to ensure write completes)
    await saveContextBeforeRelaunch({
      reason,
      sentryEventId,
      errorCategory,
    });

    setSafeModeEnabled(true);
    // Relaunch with --safe-mode flag
    app.relaunch({ args: [...process.argv.slice(1).filter(arg => arg !== '--safe-mode'), '--safe-mode'] });
    app.quit();
  });

  registerHandler('app:exit-safe-mode', () => {
    logger.info('Exiting Safe Mode - app will restart normally');
    setSafeModeEnabled(false);
    // Relaunch without --safe-mode flag
    app.relaunch({ args: process.argv.slice(1).filter(arg => arg !== '--safe-mode') });
    app.quit();
  });

  // =============================================================================
  // Tutorial Player Handler
  // =============================================================================

  registerHandler('app:get-tutorial-player-url', (_event: IpcMainInvokeEvent, youtubeId: string) => {
    // Returns the localhost URL for the tutorial player, or null if server not running
    return getTutorialPlayerUrl(youtubeId);
  });

  // =============================================================================
  // App Relaunch Handler
  // =============================================================================

  registerHandler('app:relaunch', () => {
    logger.info('App relaunch requested - restarting application');
    // Use setImmediate to allow IPC response to flush before quitting
    setImmediate(() => {
      app.relaunch();
      app.quit();
    });
  });
}

/**
 * Register emergency IPC handlers that use fire-and-forget (ipcMain.on instead of handle).
 * These are used by the EmergencyStartupRecovery component when normal IPC may be unresponsive.
 * 
 * IMPORTANT: These handlers must be registered early in startup, before any blocking operations.
 */
export function registerEmergencyHandlers(deps: Pick<AppHandlerDeps, 'setSafeModeEnabled'>): void {
  const { setSafeModeEnabled } = deps;
  const { ipcMain } = require('electron');

  // Emergency safe mode request - fire and forget, no response expected
  ipcMain.on('app:emergency-safe-mode-request', async () => {
    logger.warn('Emergency safe mode request received - startup may have been blocked');

    try {
      // Save context to temp file (best effort - may fail if FS is blocked too)
      await saveContextBeforeRelaunch({
        reason: 'failure',
        errorCategory: 'timeout',
      });
    } catch (err) {
      logger.error({ err }, 'Failed to save safe mode context during emergency restart');
    }

    setSafeModeEnabled(true);
    // Relaunch with --safe-mode flag
    app.relaunch({ args: [...process.argv.slice(1).filter(arg => arg !== '--safe-mode'), '--safe-mode'] });
    app.quit();
  });

  // Emergency quit request - fire and forget, no response expected
  ipcMain.on('app:emergency-quit-request', () => {
    logger.warn('Emergency quit request received');
    app.quit();
  });

  // Emergency relaunch request - fire and forget, no response expected
  // Used by error boundary when API mismatch requires full restart
  ipcMain.on('app:emergency-relaunch-request', () => {
    logger.info('Emergency relaunch request received - restarting application');
    app.relaunch();
    app.quit();
  });

  logger.debug('Emergency IPC handlers registered');
}
