import type { BrowserWindow } from 'electron';
import { getElectronModule } from '@core/lazyElectron';

export type PendingDownloadedUpdate = {
  updateKey: string;
  versionLabel: string;
  downloadedAt: number;
  downloadUrl?: string;
};

let pendingDownloadedUpdate: PendingDownloadedUpdate | null = null;
const acknowledgedUpdateKeys = new Set<string>();
let getMainWindow: () => BrowserWindow | null = () => null;

export function setUpdateMainWindowGetter(getter: () => BrowserWindow | null): void {
  getMainWindow = getter;
}

export function getUpdatePrimaryWindow(): BrowserWindow | null {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    return mainWindow;
  }

  const electron = getElectronModule();
  if (!electron) return null;
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: update toast uses injected main-window getter first; fallback is legacy and should migrate later to ensure-main-window capability.
  const fallback = electron.BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !win.webContents.isDestroyed());
  return fallback ?? null;
}

export function setPendingDownloadedUpdate(update: PendingDownloadedUpdate): void {
  const previousKey = pendingDownloadedUpdate?.updateKey ?? null;
  pendingDownloadedUpdate = update;
  // Only clear ack when the update key changes (avoid re-enabling toasts on periodic checks).
  if (previousKey !== update.updateKey) {
    acknowledgedUpdateKeys.delete(update.updateKey);
  }
}

export function getPendingDownloadedUpdate(): PendingDownloadedUpdate | null {
  return pendingDownloadedUpdate;
}

/**
 * Reset the in-memory pending update (no persistence).
 *
 * Called by `silentAutoHealStuckInstall()` so the fresh
 * `autoUpdater.checkForUpdates()` doesn't conflate the stuck (cached)
 * download with the new one — the renderer should only see the toast
 * after the new download completes.
 *
 * @see docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md
 */
export function clearPendingDownloadedUpdate(): void {
  pendingDownloadedUpdate = null;
}

export function acknowledgeDownloadedUpdate(updateKey: string): void {
  acknowledgedUpdateKeys.add(updateKey);
}

export function isDownloadedUpdateAcknowledged(updateKey: string): boolean {
  return acknowledgedUpdateKeys.has(updateKey);
}

/**
 * Returns pending update state *for renderer prompting*.
 *
 * If the current pending updateKey has already been acknowledged this session,
 * return null to avoid toast spam across renderer reloads.
 */
export function getPendingDownloadedUpdateForRenderer(): PendingDownloadedUpdate | null {
  if (!pendingDownloadedUpdate) {
    return null;
  }
  if (acknowledgedUpdateKeys.has(pendingDownloadedUpdate.updateKey)) {
    return null;
  }
  return pendingDownloadedUpdate;
}
