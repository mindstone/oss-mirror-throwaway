/**
 * Path Adapter Helpers
 *
 * Provides environment-variable fallbacks for platform path APIs.
 * Used by both Electron and cloud service contexts.
 *
 * Reads paths from PlatformConfig (set at startup) instead of
 * importing Electron's `app` directly, making this module
 * platform-agnostic.
 */

import { getPlatformConfig } from '../platform';

let _dataPath: string | null = null;

/**
 * Get the user data path (userData directory).
 * First checks REBEL_USER_DATA env var, then falls back to PlatformConfig.
 */
export function getDataPath(): string {
  if (_dataPath) return _dataPath;
  // Resolve into a provably-`string` local before memoizing. Returning the
  // module-level `_dataPath` (typed `string | null`) directly isn't narrowed by
  // control-flow analysis under the mobile project's stricter tsc (where
  // `process.env.X` is `string | null`), tripping TS2322. Behaviour is
  // unchanged: a non-empty REBEL_USER_DATA wins, otherwise PlatformConfig.
  const resolved = process.env.REBEL_USER_DATA || getPlatformConfig().userDataPath;
  _dataPath = resolved;
  return resolved;
}

/**
 * Get the app version.
 * First checks REBEL_VERSION env var, then falls back to PlatformConfig.
 */
export function getAppVersion(): string {
  if (process.env.REBEL_VERSION) return process.env.REBEL_VERSION;
  return getPlatformConfig().version;
}

/**
 * Check if the app is packaged.
 * In cloud service mode (IS_CLOUD_SERVICE=1), returns false to use dev-mode paths.
 */
export function isPackaged(): boolean {
  if (process.env.IS_CLOUD_SERVICE === '1') return false;
  return getPlatformConfig().isPackaged;
}

/**
 * Get the app root path.
 * First checks REBEL_APP_ROOT env var, then falls back to PlatformConfig.
 * Falls back to process.cwd() if PlatformConfig is not available (e.g., in tests).
 */
export function getAppRoot(): string {
  if (process.env.REBEL_APP_ROOT) return process.env.REBEL_APP_ROOT;
  try {
    return getPlatformConfig().appPath;
  } catch {
    return process.cwd();
  }
}
