/**
 * Unit tests for `isDemoModeActive()` test-mode guard.
 *
 * The function returns `false` early when any of REBEL_TEST_MODE,
 * REBEL_E2E_TEST_MODE, or REBEL_TEST_USER_DATA_DIR indicate a test/E2E launch
 * (these would otherwise false-positive because E2E places userData under
 * os.tmpdir()). Absent those, it returns `true` iff the resolved userDataPath
 * is contained under the resolved os.tmpdir().
 *
 * @see src/main/services/demoModeService.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mutable platform config so each test can control userDataPath.
const mockPlatformConfig = {
  isPackaged: false,
  userDataPath: '/mock/userData',
  homePath: os.homedir(),
  tempPath: os.tmpdir(),
  logsPath: '/mock/logs',
  documentsPath: '/mock/docs',
  desktopPath: '/mock/desktop',
  appDataPath: '/mock/appData',
  appPath: '/mock/app',
  version: '1.0.0',
  appName: 'Mindstone Rebel',
};

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => mockPlatformConfig,
}));

// Heavy / electron-coupled module-level imports — mock so the module imports
// cleanly under vitest. None are exercised by isDemoModeActive().
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => ({}),
}));
vi.mock('../../startup/ensureDemoModeUserData', () => ({
  writeDemoModeFlag: vi.fn(),
  clearDemoModeFlag: vi.fn(),
}));

import { isDemoModeActive } from '../demoModeService';

const TEST_ENV_KEYS = [
  'REBEL_TEST_MODE',
  'REBEL_E2E_TEST_MODE',
  'REBEL_TEST_USER_DATA_DIR',
] as const;

describe('isDemoModeActive', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let tmpUserData: string;

  beforeEach(() => {
    // Save and clear the test-mode env vars so the vitest process's own env
    // (which may set some of these) can't leak into the "unset" cases.
    for (const key of TEST_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // A real existing dir under os.tmpdir() so fs.realpathSync resolves.
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-mode-test-'));
    mockPlatformConfig.userDataPath = tmpUserData;
  });

  afterEach(() => {
    for (const key of TEST_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    try {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('returns true when userDataPath is under os.tmpdir() and no test env vars set', () => {
    expect(isDemoModeActive()).toBe(true);
  });

  it('returns false when userDataPath is NOT under os.tmpdir()', () => {
    // os.homedir() exists (so realpathSync succeeds) and is not under tmpdir.
    mockPlatformConfig.userDataPath = os.homedir();
    expect(isDemoModeActive()).toBe(false);
  });

  it('returns false when REBEL_TEST_MODE=1 even if userDataPath is under tmpdir', () => {
    process.env.REBEL_TEST_MODE = '1';
    expect(isDemoModeActive()).toBe(false);
  });

  it('returns false when REBEL_E2E_TEST_MODE=1 even if userDataPath is under tmpdir', () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    expect(isDemoModeActive()).toBe(false);
  });

  it('returns false when REBEL_TEST_USER_DATA_DIR is set even if userDataPath is under tmpdir', () => {
    process.env.REBEL_TEST_USER_DATA_DIR = tmpUserData;
    expect(isDemoModeActive()).toBe(false);
  });
});
