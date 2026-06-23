/**
 * Lazy Electron Import Utility
 *
 * Provides runtime-only access to Electron APIs that bypasses esbuild's
 * static import resolution. This allows business logic files to
 * conditionally use desktop-only APIs (dialog, shell, clipboard,
 * powerMonitor, etc.) without pulling 'electron' into the cloud build.
 *
 * Usage:
 *   const electron = getElectronModule();
 *   if (electron) {
 *     electron.shell.openExternal(url);
 *   }
 *
 * For lifecycle hooks:
 *   onElectronAppEvent('will-quit', () => cleanup());
 */

type ElectronModule = typeof import('electron');

let _cachedModule: ElectronModule | null | undefined;

/**
 * Get the Electron module at runtime, or null if not available (cloud context).
 *
 * Uses a computed module name so esbuild cannot resolve the import statically.
 * The result is cached after first call.
 */
export function getElectronModule(): ElectronModule | null {
  if (_cachedModule !== undefined) return _cachedModule;
  try {
    const moduleName = ['e', 'l', 'e', 'c', 't', 'r', 'o', 'n'].join('');
     
    const mod = require(moduleName);
    // In plain Node.js, require('electron') returns the executable path (a string).
    // Only accept the module if it has the expected shape.
    if (mod && typeof mod === 'object' && typeof mod.app?.getVersion === 'function') {
      _cachedModule = mod as ElectronModule;
    } else {
      _cachedModule = null;
    }
  } catch {
    _cachedModule = null;
  }
  return _cachedModule;
}

/**
 * Register a handler for an Electron app lifecycle event.
 * No-op in cloud context.
 */
export function onElectronAppEvent(
  event: 'will-quit' | 'before-quit' | 'ready',
  handler: () => void
): void {
  const electron = getElectronModule();
  if (electron?.app) {
    (electron.app.on as (event: string, handler: () => void) => void)(event, handler);
  }
}
