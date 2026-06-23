/**
 * Standalone platform-config bootstrap for the time-saved backfill script.
 *
 * Mirrors `scripts/rebel-cli/platformInit.ts` but trims everything the
 * backfill doesn't need (CLI flags, headless runtime env vars). Imported
 * for side effects: `setPlatformConfig()` must run before any `@core/*`
 * module reads `getPlatformConfig()`.
 */

import os from 'node:os';
import path from 'node:path';
import { setPlatformConfig } from '@core/platform';

export function resolveStandaloneUserDataPath(env: NodeJS.ProcessEnv = process.env): string {
  // Allow override via --user-data=PATH (the script parses it but we read the
  // resolved env var here so platform init stays a single source of truth).
  const fromArgs = process.argv.find((a) => a.startsWith('--user-data='));
  if (fromArgs) {
    return path.resolve(fromArgs.slice('--user-data='.length));
  }
  if (env.REBEL_USER_DATA) return path.resolve(env.REBEL_USER_DATA);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'mindstone-rebel');
  }
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'mindstone-rebel');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'mindstone-rebel');
}

export const userDataPath = resolveStandaloneUserDataPath();
// The cloud-service electron-store shim reads this env var to anchor file
// paths. Set it before any store factory imports happen.
process.env.REBEL_USER_DATA = userDataPath;

setPlatformConfig({
  userDataPath,
  appPath: process.env.REBEL_APP_ROOT || process.cwd(),
  tempPath: os.tmpdir(),
  logsPath: path.join(userDataPath, 'logs'),
  homePath: os.homedir(),
  documentsPath: path.join(os.homedir(), 'Documents'),
  desktopPath: path.join(os.homedir(), 'Desktop'),
  appDataPath: userDataPath,
  version: process.env.REBEL_VERSION || '0.0.0-backfill',
  isPackaged: false,
  platform: process.platform,
  totalMemoryBytes: os.totalmem(),
  arch: process.arch,
  surface: 'cli',
  isOss: false,
  getAppMetrics: () => [],
});
