/**
 * Cloud Platform Initialization
 *
 * Sets PlatformConfig as the very first operation before any other modules load.
 * This MUST be imported before anything that transitively calls getPlatformConfig().
 *
 * In ESM, static imports are evaluated depth-first before the importing module's
 * body runs. By isolating setPlatformConfig in a leaf module with no heavy deps,
 * we guarantee it executes before bootstrap.ts's transitive imports (which include
 * @main/services/* that call getPlatformConfig() at module evaluation time).
 */

import path from 'node:path';
import os from 'node:os';
import { setPlatformConfig } from '@core/platform';
import { assertTestDataRootSafe } from './testDataRootGuard';

process.env.REBEL_ENABLE_STAGED_WRITES = '1';

assertTestDataRootSafe(process.env.REBEL_USER_DATA, { label: 'cloud platform REBEL_USER_DATA' });

const _dataPath = process.env.REBEL_USER_DATA || '/data';
setPlatformConfig({
  userDataPath: _dataPath,
  appPath: process.env.REBEL_APP_ROOT || process.cwd(),
  tempPath: '/tmp',
  logsPath: path.join(_dataPath, 'logs'),
  homePath: process.env.HOME || '/root',
  documentsPath: path.join(process.env.HOME || '/root', 'Documents'),
  desktopPath: path.join(process.env.HOME || '/root', 'Desktop'),
  appDataPath: _dataPath,
  version: process.env.REBEL_VERSION || __REBEL_VERSION__,
  isPackaged: false,
  platform: process.platform,
  totalMemoryBytes: os.totalmem(),
  arch: process.arch,
  surface: 'cloud',
  isOss: false, // Cloud is always enterprise infra.
  getAppMetrics: () => [],
});
