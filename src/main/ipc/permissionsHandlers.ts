/**
 * Permissions Domain IPC Handlers
 *
 * Handles OS-level permission checks (microphone, file access).
 */

import { shell, systemPreferences, app, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createScopedLogger } from '@core/logger';
import { registerHandler } from './utils/registerHandler';
import { probeWorkspaceAccess } from '../services/health/checks/filesystem';

const log = createScopedLogger({ service: 'permissions' });

/**
 * Check if running on macOS Ventura (13) or newer.
 * Darwin version 22.x = macOS 13 (Ventura)
 * Darwin version 23.x = macOS 14 (Sonoma)
 * Darwin version 24.x = macOS 15 (Sequoia)
 */
const isMacOSVenturaOrNewer = (): boolean => {
  if (process.platform !== 'darwin') return false;
  const release = os.release();
  const majorVersion = parseInt(release.split('.')[0], 10);
  return majorVersion >= 22;
};
import type { AppSettings } from '@shared/types';

export interface PermissionsHandlerDeps {
  getSettings: () => AppSettings;
}

export function registerPermissionsHandlers(deps: PermissionsHandlerDeps): void {
  const { getSettings } = deps;

  const logDevMicrophoneContext = (payload: Record<string, unknown>): void => {
    if (app.isPackaged) {
      return;
    }

    log.debug(
      {
        ...payload,
        execPath: process.execPath,
        appPath: app.getAppPath(),
        appName: app.getName(),
        isPackaged: app.isPackaged,
        electronRunAsNode: process.env['ELECTRON_RUN_AS_NODE'] ?? null
      },
      'Dev microphone permission diagnostics'
    );
  };

  registerHandler('permissions:get-microphone-status', async (_event: IpcMainInvokeEvent) => {
    if (process.platform !== 'darwin') {
      // Only macOS requires explicit permission checks
      return 'granted';
    }

    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      log.debug({ status }, 'Microphone permission status checked');
      logDevMicrophoneContext({ phase: 'status-check', status });
      return status;
    } catch (error) {
      log.error({ err: error }, 'Failed to check microphone permission status');
      logDevMicrophoneContext({ phase: 'status-check-error', error: error instanceof Error ? error.message : String(error) });
      return 'not-determined';
    }
  });

  registerHandler('permissions:request-microphone', async (_event: IpcMainInvokeEvent) => {
    if (process.platform !== 'darwin') {
      return { granted: true };
    }

    try {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      log.info({ granted }, 'Microphone permission requested');
      logDevMicrophoneContext({ phase: 'request', granted });
      return { granted };
    } catch (error) {
      log.error({ err: error }, 'Failed to request microphone permission');
      logDevMicrophoneContext({ phase: 'request-error', error: error instanceof Error ? error.message : String(error) });
      return { granted: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  registerHandler(
    'permissions:check-file-access',
    async (_event: IpcMainInvokeEvent, workspacePath?: string) => {
      const settings = getSettings();

      // Use provided workspace path (from onboarding draft) or fall back to saved settings
      const coreDirectory = workspacePath || settings.coreDirectory;

      log.debug({
        providedPath: workspacePath,
        settingsPath: settings.coreDirectory,
        usingPath: coreDirectory,
        isPackaged: app.isPackaged,
      }, 'Starting file access check');

      if (!coreDirectory) {
        log.debug('No workspace configured');
        return { hasAccess: false, reason: 'no-workspace-configured' };
      }

      // In development mode, bypass strict permission checks
      // Entitlements only apply to packaged builds, and dev mode has different permission behavior
      if (!app.isPackaged) {
        log.debug('Development mode detected - bypassing strict checks');
        try {
          const root = path.resolve(coreDirectory);
          log.debug({ workspace: root }, 'Creating workspace directory');
          await fs.mkdir(root, { recursive: true });
          log.info({ workspace: root }, 'Development mode: workspace access granted');
          return { hasAccess: true, devMode: true };
        } catch (error: unknown) {
          const err = error as { code?: string; message?: string };
          log.warn(
            { err: error, workspace: coreDirectory },
            'Development mode: failed to create workspace'
          );
          return {
            hasAccess: false,
            reason: 'access-denied',
            errorCode: err?.code,
            errorMessage: err?.message || String(error),
          };
        }
      }

      log.debug('Production mode - using full verification');

      try {
        // Try to read the workspace directory to check for file system access
        const root = path.resolve(coreDirectory);
        // Ensure the workspace directory exists before access checks
        await fs.mkdir(root, { recursive: true });
        await fs.access(root, fs.constants.R_OK | fs.constants.W_OK);

        // Try to list files as an additional check
        await fs.readdir(root);

        // Stronger verification: use robust probe with retry for cloud sync resilience
        // The probe creates a unique temp file, reads it back, verifies content, then cleans up
        // Retry is enabled to handle transient cloud sync interference (Google Drive, OneDrive, etc.)
        const probeResult = await probeWorkspaceAccess(root, {
          createIfMissing: false, // Already created above
          retry: { enabled: true },
        });

        if (!probeResult.accessible) {
          log.warn(
            {
              workspace: coreDirectory,
              errorCode: probeResult.code,
              errorMessage: probeResult.error,
            },
            'Workspace probe failed after retries'
          );

          return {
            hasAccess: false,
            reason: 'access-denied',
            errorCode: probeResult.code,
            errorMessage: probeResult.error,
          };
        }

        log.debug({ workspace: root }, 'File system access verified');
        return { hasAccess: true };
      } catch (error: unknown) {
        const err = error as { code?: string; message?: string };
        const errorCode = err?.code;
        const errorMessage = err?.message || String(error);

        log.warn(
          {
            err: error,
            workspace: coreDirectory,
            errorCode,
          },
          'File system access check failed'
        );

        return {
          hasAccess: false,
          reason: 'access-denied',
          errorCode,
          errorMessage,
        };
      }
    }
  );

  registerHandler(
    'permissions:open-system-preferences',
    async (_event: IpcMainInvokeEvent, type: 'microphone' | 'files' | 'screen-recording' | 'notifications') => {
      if (type === 'notifications') {
        try {
          if (process.platform === 'darwin') {
            await shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension');
          } else if (process.platform === 'win32') {
            await shell.openExternal('ms-settings:notifications');
          } else {
            return { success: false, reason: 'not-supported' };
          }
          return { success: true };
        } catch (error) {
          log.error({ err: error, type }, 'Failed to open notification settings');
          return { success: false, reason: 'error', error: error instanceof Error ? error.message : String(error) };
        }
      }

      if (process.platform !== 'darwin') {
        log.warn({ type }, 'System preferences opening is only supported on macOS');
        return { success: false, reason: 'not-supported' };
      }

      try {
        const useNewSystemSettings = isMacOSVenturaOrNewer();
        let url = '';

        if (useNewSystemSettings) {
          if (type === 'microphone') {
            url = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone';
          } else if (type === 'files') {
            url = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_FilesAndFolders';
          } else if (type === 'screen-recording') {
            url = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture';
          }
        } else {
          if (type === 'microphone') {
            url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
          } else if (type === 'files') {
            url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders';
          } else if (type === 'screen-recording') {
            url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
          }
        }

        if (url) {
          log.info({ type, url, useNewSystemSettings }, 'Opening system preferences');
          await shell.openExternal(url);
          return { success: true };
        }

        return { success: false, reason: 'invalid-type' };
      } catch (error) {
        log.error({ err: error, type }, 'Failed to open system preferences');
        return {
          success: false,
          reason: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );
}

