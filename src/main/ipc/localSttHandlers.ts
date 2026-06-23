/**
 * IPC Handlers for Local STT Model Management
 */

import { BrowserWindow, ipcMain } from 'electron';
import { localSttModelManager } from '../services/localSttModelManager';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';

const logger = createScopedLogger({ service: 'LocalSttHandlers' });

/**
 * Register IPC handlers for local STT model management.
 * All handlers accept an optional { modelId } parameter (defaults to 'parakeet-v3').
 */
export function registerLocalSttHandlers(getMainWindow: () => BrowserWindow | null): void {
  // Get model status
  ipcMain.handle('local-stt:model-status', async (_event, args?: { modelId?: string }) => {
    try {
      const modelId = args?.modelId ?? 'parakeet-v3';
      return await localSttModelManager.getStatus(modelId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Failed to get model status');
      return {
        installed: false,
        downloading: false,
        error: message,
      };
    }
  });

  // Start model download
  ipcMain.handle('local-stt:model-download', async (_event, args?: { modelId?: string }) => {
    try {
      const mainWindow = getMainWindow();
      const modelId = args?.modelId ?? 'parakeet-v3';
      return await localSttModelManager.startDownload(mainWindow, modelId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Failed to start model download');
      getErrorReporter().captureException(error instanceof Error ? error : new Error(message), {
        tags: { area: 'local-stt', component: 'ipc-model-download' },
      });
      return { started: false, error: message };
    }
  });

  // Cancel model download
  ipcMain.handle('local-stt:model-cancel-download', async (_event, args?: { modelId?: string }) => {
    try {
      const mainWindow = getMainWindow();
      const modelId = args?.modelId ?? 'parakeet-v3';
      localSttModelManager.cancelDownload(mainWindow, modelId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Failed to cancel model download');
    }
  });

  // Remove model
  ipcMain.handle('local-stt:model-remove', async (_event, args?: { modelId?: string }) => {
    try {
      const modelId = args?.modelId ?? 'parakeet-v3';
      const result = await localSttModelManager.removeModel(modelId);
      if (result.success) {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('local-stt:model-download-progress', {
            modelId,
            progress: 0,
            downloadedBytes: 0,
            totalBytes: 0,
            status: 'cancelled',
          });
        }
      }
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'Failed to remove model');
      getErrorReporter().captureException(error instanceof Error ? error : new Error(message), {
        tags: { area: 'local-stt', component: 'ipc-model-remove' },
      });
      return { success: false, error: message };
    }
  });

  logger.debug('Local STT handlers registered');
}
