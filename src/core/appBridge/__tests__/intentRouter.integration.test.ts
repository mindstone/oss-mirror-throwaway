import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppBridge } from '@core/appBridge/server/bridge';
import { DEV_EXTENSION_IDS_FILE } from '@core/appBridge/server/originGuard';
import type { ErrorReporter } from '@core/errorReporter';
import { defaultCapabilities, type PlatformConfig } from '@core/platform';
import { createAppBridgeManager, type AppBridgeManager } from '@main/services/appBridgeManager';

const UNKNOWN_EXT_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

const managers: AppBridgeManager[] = [];
const dirs: string[] = [];

let portBase = 56000;
function nextPortRange(count = 3): number[] {
  const start = portBase;
  portBase += count + 1;
  return Array.from({ length: count }, (_, index) => start + index);
}

function buildPlatformConfig(userDataPath: string): PlatformConfig {
  return {
    userDataPath,
    appPath: userDataPath,
    tempPath: os.tmpdir(),
    logsPath: path.join(userDataPath, 'logs'),
    homePath: userDataPath,
    documentsPath: path.join(userDataPath, 'Documents'),
    desktopPath: path.join(userDataPath, 'Desktop'),
    appDataPath: path.join(userDataPath, 'appData'),
    version: '0.0.0-test',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface: 'desktop',
    isOss: false,
    capabilities: defaultCapabilities('desktop'),
  };
}

function buildErrorReporter(): ErrorReporter {
  return {
    addBreadcrumb: () => {},
    captureException: () => {},
    captureMessage: () => {},
  };
}

afterEach(async () => {
  while (managers.length > 0) {
    const manager = managers.pop();
    if (manager) {
      await manager.stop();
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('intentRouter integration', () => {
  it('returns the limited health payload quickly without creating a pending TOFU approval', async () => {
    const userDataPath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'intent-router-integration-'),
    );
    dirs.push(userDataPath);

    const manager = createAppBridgeManager({
      platformConfig: buildPlatformConfig(userDataPath),
      errorReporter: buildErrorReporter(),
      previewMode: true,
      createBridge: (options) =>
        createAppBridge({
          ...options,
          portCandidates: nextPortRange(),
        }),
    });
    managers.push(manager);

    const state = await manager.start();
    if (!state) {
      throw new Error('Expected the App Bridge manager to start.');
    }

    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${state.port}/intent/health`, {
      method: 'GET',
      headers: {
        Origin: `chrome-extension://${UNKNOWN_EXT_ID}`,
        Host: `127.0.0.1:${state.port}`,
      },
      signal: AbortSignal.timeout(100),
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(100);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: 'rebel-app-bridge',
    });
    expect(manager.listPendingApprovals()).toEqual([]);
    await expect(
      fs.readFile(
        path.join(userDataPath, 'mcp', 'rebel-app-bridge', DEV_EXTENSION_IDS_FILE),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
