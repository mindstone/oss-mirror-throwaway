/**
 * Version Domain IPC Handlers
 *
 * Handles version check operations for the update banner feature.
 * Allows renderer to check if app is outdated (2+ minor versions behind).
 */

import { type IpcMainInvokeEvent } from 'electron';
import { createScopedLogger } from '@core/logger';
import { registerHandler } from './utils/registerHandler';
import { checkVersion, clearVersionCheckCache } from '@main/services/versionCheckService';
import { isUserDataReadOnly, getUserDataReadOnlyReason, getUserDataNewerAppVersion } from '@core/userDataWriteGate';

const log = createScopedLogger({ service: 'version-handlers' });

export function registerVersionHandlers(): void {
  registerHandler('version:check', async (_event: IpcMainInvokeEvent) => {
    log.debug('[IPC] version:check called');
    return await checkVersion();
  });

  registerHandler('version:clear-cache', async (_event: IpcMainInvokeEvent) => {
    log.debug('[IPC] version:clear-cache called');
    clearVersionCheckCache();
    return { success: true };
  });

  registerHandler('version:read-only-status', async (_event: IpcMainInvokeEvent) => {
    return {
      readOnly: isUserDataReadOnly(),
      reason: getUserDataReadOnlyReason(),
      newerAppVersion: getUserDataNewerAppVersion(),
    };
  });
}
