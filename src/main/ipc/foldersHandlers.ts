/**
 * Folders Domain IPC Handlers
 *
 * Wires folder IPC channels to the FolderStore service.
 * Three channels: load, save (async), save-sync (synchronous quit-flush).
 *
 * @see src/core/services/folderStore.ts
 * @see src/shared/ipc/channels/folders.ts
 */

import type { IpcMainInvokeEvent, IpcMainEvent } from 'electron';
import { ipcMain } from 'electron';
import { registerHandler } from './utils/registerHandler';
import { foldersChannels } from '@shared/ipc/channels/folders';
import { getFolderStore } from '@core/services/folderStore';
import { createScopedLogger } from '@core/logger';
import type { FolderStoreData } from '@shared/ipc/schemas/folders';

const log = createScopedLogger({ service: 'foldersHandlers' });

export function registerFoldersHandlers(): void {
  registerHandler('folders:load', (_event: IpcMainInvokeEvent) => {
    return getFolderStore().load();
  });

  registerHandler('folders:save', async (_event: IpcMainInvokeEvent, data: FolderStoreData) => {
    try {
      const validated = foldersChannels['folders:save'].request.parse(data);
      await getFolderStore().save(validated);
      return { success: true };
    } catch (err) {
      log.error({ err }, 'folders:save failed');
      return { success: false };
    }
  });

  ipcMain.on('folders:save-sync', (event: IpcMainEvent, data: FolderStoreData) => {
    try {
      const validated = foldersChannels['folders:save-sync'].request.parse(data);
      getFolderStore().saveSync(validated);
      event.returnValue = { success: true };
    } catch (err) {
      log.error({ err }, 'folders:save-sync failed');
      event.returnValue = { success: false, error: (err as Error).message };
    }
  });
}
