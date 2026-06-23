import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppBridge } from '@core/appBridge/server/bridge';
import { TokenStore } from '@core/appBridge/server/tokenStore';

const cleanupDirs: string[] = [];
const cleanupStops: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupStops.length > 0) {
    const stop = cleanupStops.pop();
    if (stop) {
      await stop().catch(() => undefined);
    }
  }
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-bridge-migration-'));
  cleanupDirs.push(dir);
  return dir;
}

describe('appBridge/server/bridge migration + persisted security state', () => {
  it('revokes legacy browser-extension app tokens once while preserving office tokens', async () => {
    const stateDirectory = await makeStateDir();
    const stateFilePath = path.join(stateDirectory, 'state.json');
    const seedStore = new TokenStore({ routerInternalToken: 'router-token-seed' });
    const browserToken = seedStore.issueAppToken('browser-extension', 'browser-client');
    const officeToken = seedStore.issueAppToken('office-addin', 'office-client');

    await fs.writeFile(
      stateFilePath,
      JSON.stringify({
        port: 55601,
        pid: process.pid,
        protocolVersion: '1.0',
        startedAt: new Date().toISOString(),
        routerToken: 'router-token-seed',
        appTokens: seedStore.listPersistedAppTokens(),
      }),
      'utf8',
    );

    const handle = await createAppBridge({
      stateDirectory,
      portCandidates: [55601, 55602, 55603],
    });
    cleanupStops.push(() => handle.stop());

    expect(
      handle.tokenStore.verifyAppToken(browserToken, {
        appId: 'browser-extension',
        clientId: 'browser-client',
      }),
    ).toBeNull();
    expect(
      handle.tokenStore.verifyAppToken(officeToken, {
        appId: 'office-addin',
        clientId: 'office-client',
      }),
    ).not.toBeNull();

    const persisted = JSON.parse(await fs.readFile(handle.stateFilePath, 'utf8')) as {
      browserExtensionBootTokenMigrationCompleted?: boolean;
    };
    expect(persisted.browserExtensionBootTokenMigrationCompleted).toBe(true);
  });

  it('rehydrates persisted install-session denylist and client-extension bindings', async () => {
    const stateDirectory = await makeStateDir();
    const stateFilePath = path.join(stateDirectory, 'state.json');

    await fs.writeFile(
      stateFilePath,
      JSON.stringify({
        port: 55611,
        pid: process.pid,
        protocolVersion: '1.0',
        startedAt: new Date().toISOString(),
        routerToken: 'router-token-seed',
        browserExtensionBootTokenMigrationCompleted: true,
        installSessionDenylist: [
          { installSessionId: 'install-session-1', revokedAt: 1_234 },
        ],
        clientExtensionBindings: [
          {
            clientId: 'browser-client-a',
            extensionId: 'extension-a',
            createdAt: 5_678,
          },
        ],
      }),
      'utf8',
    );

    const handle = await createAppBridge({
      stateDirectory,
      portCandidates: [55611, 55612, 55613],
    });
    cleanupStops.push(() => handle.stop());

    expect(handle.tokenStore.isInstallSessionRevoked('install-session-1')).toBe(true);
    expect(handle.tokenStore.lookupExtensionByClientId('browser-client-a')).toBe('extension-a');
    expect(handle.tokenStore.lookupClientByExtensionId('extension-a')).toBe('browser-client-a');
  });
});
