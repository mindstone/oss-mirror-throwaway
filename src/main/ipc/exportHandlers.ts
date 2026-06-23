/**
 * Export Domain IPC Handlers
 *
 * Handles PDF and file export operations.
 */

import { type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { exportToPdf, saveFileWithDialog } from '../services/exportService';
import { registerHandler } from './utils/registerHandler';

export interface ExportHandlerDeps {
  getWindowForEvent: (sender: Electron.WebContents) => BrowserWindow | null;
}

export function registerExportHandlers(deps: ExportHandlerDeps): void {
  const { getWindowForEvent } = deps;

  registerHandler(
    'export:to-pdf',
    async (event: IpcMainInvokeEvent, payload: { html: string; fileName: string }) => {
      const win = getWindowForEvent(event.sender);
      return exportToPdf(win, payload);
    }
  );

  registerHandler(
    'export:save-file',
    async (
      event: IpcMainInvokeEvent,
      payload: { data: ArrayBuffer; fileName: string; filters: Electron.FileFilter[]; title?: string }
    ) => {
      const win = getWindowForEvent(event.sender);
      return saveFileWithDialog(win, payload);
    }
  );
}

