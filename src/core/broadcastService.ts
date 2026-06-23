/**
 * BroadcastService — platform-agnostic event broadcasting to renderer/clients.
 *
 * Replaces direct BrowserWindow.getAllWindows() + webContents.send() usage.
 * Electron impl broadcasts via BrowserWindow; cloud impl uses cloudEventBroadcaster.
 */

import { wrapBroadcastWithContractParse } from './broadcastContractSeam';

export interface BroadcastService {
  sendToAllWindows(channel: string, ...args: unknown[]): void;
  sendToFocusedWindow(channel: string, ...args: unknown[]): void;
}

let _broadcast: BroadcastService | undefined;

export function setBroadcastService(service: BroadcastService): void {
  // Dev/test-gated contract-parse seam — returns the SAME reference when the
  // gate is off (packaged prod), so there's no wrapper on the hot path.
  _broadcast = wrapBroadcastWithContractParse(service);
}

export function getBroadcastService(): BroadcastService {
  if (!_broadcast) {
    throw new Error(
      'BroadcastService not initialized. Call setBroadcastService() before broadcasting.',
    );
  }
  return _broadcast;
}
