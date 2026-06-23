/**
 * Minimal window interface for sending events to the renderer.
 * Electron provides BrowserWindow, cloud provides a virtual broadcaster.
 */
export interface EventWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}
