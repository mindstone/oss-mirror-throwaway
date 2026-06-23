import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildNmhManifests } from '../../../core/appBridge/installer/nmhManifest';
import { AppBridgeInstallerService, type AppBridgeInstallerServiceDeps } from '../appBridgeInstallerService';

vi.mock('../../core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const DETECTED_BROWSERS = [
  {
    id: 'chrome' as const,
    displayName: 'Google Chrome',
    installPath: '/Applications/Google Chrome.app',
    extensionsPageUrl: 'chrome://extensions',
  },
];

const tempRoots: string[] = [];

function createFixture() {
  const rootDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'rebel-nmh-'));
  tempRoots.push(rootDir);

  const homeDir = path.join(rootDir, 'home');
  const userDataDir = path.join(rootDir, 'userData');
  nodeFs.mkdirSync(homeDir, { recursive: true });
  nodeFs.mkdirSync(userDataDir, { recursive: true });

  const deps: AppBridgeInstallerServiceDeps = {
    app: {
      getPath: (key: string) => (key === 'userData' ? userDataDir : rootDir),
      isPackaged: false,
    },
    shell: {
      showItemInFolder: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
    fs,
    processPlatform: 'darwin',
    processCwd: () => rootDir,
    processResourcesDir: rootDir,
    isPackaged: false,
    env: {
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
  };

  const service = new AppBridgeInstallerService(deps);
  const [manifest] = buildNmhManifests({
    platform: 'darwin',
    homeDir,
    userDataDir,
    detectedBrowsers: DETECTED_BROWSERS,
    allowedExtensionIds: [EXTENSION_ID],
  });

  return { rootDir, homeDir, userDataDir, service, manifestPath: manifest.manifestPath };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((rootDir) => fs.rm(rootDir, { recursive: true, force: true })),
  );
});

describe('AppBridgeInstallerService NMH manifests', () => {
  it('rejects symlink escapes during registration', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const { homeDir, service } = createFixture();
    const appSupportDir = path.join(homeDir, 'Library', 'Application Support');
    nodeFs.mkdirSync(appSupportDir, { recursive: true });
    nodeFs.symlinkSync('/etc', path.join(appSupportDir, 'Google'));

    const result = await service.registerNmhManifests({
      detectedBrowsers: DETECTED_BROWSERS,
      allowedExtensionIds: [EXTENSION_ID],
    });

    expect(result).toEqual([{ browserId: 'chrome', ok: false, reason: 'symlink-escape' }]);
  });

  it('writes owner-only permissions on POSIX', async () => {
    const { service, manifestPath } = createFixture();

    const result = await service.registerNmhManifests({
      detectedBrowsers: DETECTED_BROWSERS,
      allowedExtensionIds: [EXTENSION_ID],
    });

    expect(result).toEqual([{ browserId: 'chrome', ok: true }]);
    const stat = nodeFs.statSync(manifestPath);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('returns conflict when a foreign manifest already exists', async () => {
    const { service, manifestPath } = createFixture();
    nodeFs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    nodeFs.writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'com.someone.else',
        description: 'foreign manifest',
      }),
      'utf8',
    );

    const result = await service.registerNmhManifests({
      detectedBrowsers: DETECTED_BROWSERS,
      allowedExtensionIds: [EXTENSION_ID],
    });

    expect(result).toEqual([{ browserId: 'chrome', ok: false, reason: 'conflict' }]);
  });

  it('unregisters owned manifests and leaves foreign ones in place', async () => {
    const { service, manifestPath } = createFixture();

    const registerResult = await service.registerNmhManifests({
      detectedBrowsers: DETECTED_BROWSERS,
      allowedExtensionIds: [EXTENSION_ID],
    });
    expect(registerResult).toEqual([{ browserId: 'chrome', ok: true }]);
    expect(nodeFs.existsSync(manifestPath)).toBe(true);

    const unregisterResult = await service.unregisterNmhManifests({ browserIds: ['chrome'] });
    expect(unregisterResult).toEqual([{ browserId: 'chrome', ok: true }]);
    expect(nodeFs.existsSync(manifestPath)).toBe(false);

    nodeFs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    nodeFs.writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'com.someone.else',
        description: 'foreign manifest',
      }),
      'utf8',
    );

    const foreignResult = await service.unregisterNmhManifests({ browserIds: ['chrome'] });
    expect(foreignResult).toEqual([{ browserId: 'chrome', ok: false, reason: 'conflict' }]);
    expect(nodeFs.existsSync(manifestPath)).toBe(true);
  });
});
