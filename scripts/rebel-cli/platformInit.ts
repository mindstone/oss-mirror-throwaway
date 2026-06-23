import os from 'node:os';
import path from 'node:path';
import { setPlatformConfig } from '@core/platform';

process.env.REBEL_SURFACE = 'cli-standalone';
process.env.REBEL_HEADLESS_CLI = '1';
process.env.REBEL_ENABLE_STAGED_WRITES = '1';

export function resolveStandaloneUserDataPath(env: NodeJS.ProcessEnv = process.env): string {
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
  version: process.env.REBEL_VERSION || __REBEL_VERSION__,
  isPackaged: false,
  platform: process.platform,
  totalMemoryBytes: os.totalmem(),
  arch: process.arch,
  surface: 'cli',
  isOss: false,
  getAppMetrics: () => [],
});
