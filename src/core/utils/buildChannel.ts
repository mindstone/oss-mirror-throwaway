/**
 * Build channel detection utility.
 *
 * Provides a canonical way to detect which release channel the app is running from
 * (stable, beta, or dev) based on the executable name and packaged state.
 *
 * This is necessary because:
 * 1. Auto-updaters (Squirrel.Mac, electron-updater) work best with numeric-only versions
 * 2. Beta versions use format `0.3.{build_number}` without "-beta" suffix
 * 3. Channel detection must rely on app bundle/executable name instead
 *
 * @see docs/plans/finished/260106_fix-beta-versioning.md
 */

import path from 'path';
import { getPlatformConfig } from '@core/platform';

export type BuildChannel = 'stable' | 'beta' | 'dev';

/**
 * Get the basename of a path, handling both Unix and Windows separators.
 *
 * Node's `path.basename()` only recognizes the platform-native separator,
 * but we need to handle both for testability (running Windows path tests on Unix).
 * This uses `path.win32.basename()` which handles both `/` and `\` separators.
 *
 * @internal
 */
function getExecBasename(execPath: string): string {
  // path.win32.basename handles both / and \ separators, making it work
  // correctly on all platforms and in cross-platform tests
  return path.win32.basename(execPath);
}

/**
 * Get the current build channel based on the executable name and packaged state.
 *
 * Uses the basename of `process.execPath` to avoid false-positives from
 * directory names (e.g., `/Users/alice/beta/Mindstone Rebel` should return 'stable').
 *
 * In dev mode (unpackaged), returns 'dev' to enable proper segmentation
 * in analytics, Sentry, and other telemetry systems.
 *
 * @returns The build channel: 'dev', 'beta', or 'stable'
 */
export function getBuildChannel(): BuildChannel {
  // Dev mode: return 'dev' for unpackaged builds
  if (!getPlatformConfig().isPackaged) return 'dev';

  // Use basename to avoid false-positives from directory names like "/Users/alice/beta/..."
  const execName = getExecBasename(process.execPath).toLowerCase();
  if (execName.includes('beta')) return 'beta';
  return 'stable';
}
