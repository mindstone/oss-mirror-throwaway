const noop = () => {};
const noopAsync = () => Promise.resolve();
type NoopProxy = ((...args: unknown[]) => unknown) & Record<PropertyKey, unknown>;
const noopProxy: NoopProxy = new Proxy(function noopProxyTarget() {}, {
  get: (_target, prop) => (prop === 'then' ? undefined : noopProxy),
  apply: () => noopProxy,
  construct: () => noopProxy,
}) as NoopProxy;

export const app = {
  getPath: () => process.env.REBEL_USER_DATA || process.cwd(),
  getAppPath: () => process.cwd(),
  getVersion: () => process.env.REBEL_VERSION || 'unknown',
  getName: () => 'rebel-cli',
  isPackaged: false,
  isReady: () => true,
  whenReady: noopAsync,
  on: noop,
  once: noop,
  quit: noop,
  relaunch: noop,
  requestSingleInstanceLock: () => true,
  getAppMetrics: () => [],
};
export const BrowserWindow = class {
  static getAllWindows() { return []; }
  static getFocusedWindow() { return null; }
};
export const ipcMain = { handle: noop, removeHandler: noop, on: noop };
export const shell = { openExternal: noopAsync };
export const dialog = { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }), showMessageBox: () => Promise.resolve({ response: 0 }) };
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (text: string) => Buffer.from(text), decryptString: (buf: Buffer) => buf.toString('utf8') };
export const clipboard = { writeText: noop, readText: () => '' };
export const nativeTheme = { shouldUseDarkColors: true, themeSource: 'dark', on: noop };
export const systemPreferences = { getMediaAccessStatus: () => 'granted' };
export const nativeImage = { createFromPath: () => ({}) };
export const Notification = class { show() {} };
export const utilityProcess = { fork: () => null };
export const screen = { getPrimaryDisplay: () => ({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }), getAllDisplays: () => [] };
export const powerMonitor = { on: noop, removeListener: noop, getSystemIdleState: () => 'active' };
export const powerSaveBlocker = { start: () => 0, stop: noop, isStarted: () => false };
export const autoUpdater = { on: noop, setFeedURL: noop, checkForUpdates: noop };
export const desktopCapturer = { getSources: () => Promise.resolve([]) };
export const net = { request: () => noopProxy };
export const session = { defaultSession: { webRequest: { onHeadersReceived: noop }, on: noop } };
export const protocol = { registerSchemesAsPrivileged: noop, handle: noop };
export const webContents = { getAllWebContents: () => [], fromId: () => null };
export const crashReporter = { start: noop, getLastCrashReport: () => null };
export const contentTracing = { startRecording: noopAsync, stopRecording: () => Promise.resolve(''), getCategories: () => Promise.resolve([]) };

export default {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  safeStorage,
  clipboard,
  nativeTheme,
  systemPreferences,
  nativeImage,
  Notification,
  utilityProcess,
  screen,
  powerMonitor,
  powerSaveBlocker,
  autoUpdater,
  desktopCapturer,
  net,
  session,
  protocol,
  webContents,
  crashReporter,
  contentTracing,
};
