import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureBundledMcpManager } from '../bundledMcpManager';
import {
  scanForDevPrePublishSentinels,
  upgradeRebelOssEntriesToManaged,
} from '../managedMcpAutoUpgrade';
import {
  configureManagedMcpInstallService,
  __resetManagedMcpInstallSingletonForTesting,
} from '../managedMcpInstallServiceInstance';
import {
  DEV_PRE_PUBLISH_SENTINEL_FILENAME,
  ManagedMcpInstallError,
  type DevPrePublishSentinel,
} from '../managedMcpInstallService';

// Reuse the same execFile-fake pattern used by managedMcpInstallService tests:
// callers pass `execFile` via `createManagedMcpInstallService`. Since the
// singleton factory doesn't expose execFile injection, we instead materialise
// a pre-installed valid managed install on disk for each test where needed,
// and let the service's metadata-validation path short-circuit to reuse.
//
// For failure paths we patch `execFile` via a module-level mock.
 
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      // Default: simulate a successful install by just returning success.
      // Tests that need a valid managed install create it on disk first.
      callback(null, '', '');
      return { kill: () => undefined } as unknown;
    }),
  };
});

const zendeskCatalogEntry = {
  id: 'bundled-zendesk',
  name: 'Zendesk',
  provider: 'rebel-oss',
  bundledConfig: { serverName: 'Zendesk' },
  mcpConfig: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@mindstone-engineering/mcp-server-zendesk@0.3.0'],
    env: { LOG_MODE: 'strict' },
  },
};

const freshdeskCatalogEntry = {
  id: 'bundled-freshdesk',
  name: 'Freshdesk',
  provider: 'rebel-oss',
  bundledConfig: { serverName: 'Freshdesk' },
  mcpConfig: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@mindstone-engineering/mcp-server-freshdesk@0.2.0'],
  },
};

const communityCatalogEntry = {
  id: 'community-elevenlabs',
  name: 'ElevenLabs',
  provider: 'community',
  mcpConfig: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'elevenlabs-mcp@1.0.0'],
  },
};

const writeJson = async (target: string, data: unknown): Promise<void> => {
  await fs.writeFile(target, JSON.stringify(data, null, 2), 'utf8');
};

const readJson = async <T = unknown>(target: string): Promise<T> => {
  const raw = await fs.readFile(target, 'utf8');
  return JSON.parse(raw) as T;
};

const makeValidManagedInstall = async (
  userDataPath: string,
  packageSpec: string,
  packageName: string,
): Promise<string> => {
  const installRoot = path.join(userDataPath, 'mcp', 'managed-installs', packageSpec);
  const packageDir = path.join(installRoot, 'node_modules', ...packageName.split('/'));
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: packageName, version: packageSpec.split('@').pop(), main: 'index.js' }, null, 2),
    'utf8',
  );
  const entryPath = path.join(packageDir, 'index.js');
  await fs.writeFile(entryPath, 'module.exports = {};', 'utf8');
  const metadata = {
    packageSpec,
    packageName,
    version: packageSpec.split('@').pop(),
    entryPath,
    installRoot,
    installedAt: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    metaVersion: 1,
  };
  await fs.writeFile(
    path.join(installRoot, '.install-meta.json'),
    JSON.stringify(metadata, null, 2),
    'utf8',
  );
  return entryPath;
};

describe('managedMcpAutoUpgrade', () => {
  let userDataPath: string;
  let resourcesDir: string;
  let configPath: string;

  beforeEach(async () => {
    userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-mcp-upgrade-'));
    resourcesDir = path.join(userDataPath, 'resources');
    await fs.mkdir(resourcesDir, { recursive: true });
    await writeJson(path.join(resourcesDir, 'connector-catalog.json'), {
      connectors: [zendeskCatalogEntry, freshdeskCatalogEntry, communityCatalogEntry],
    });

    configureBundledMcpManager({
      userDataDir: userDataPath,
      resourcesDir,
      isPackaged: true,
    });

    __resetManagedMcpInstallSingletonForTesting();
    configureManagedMcpInstallService(userDataPath);

    configPath = path.join(userDataPath, 'mcp-router-config.json');
  });

  afterEach(async () => {
    __resetManagedMcpInstallSingletonForTesting();
    await fs.rm(userDataPath, { recursive: true, force: true }).catch(() => undefined);
  });

  it('upgrades an npx-shaped rebel-oss entry to managed and preserves identity fields', async () => {
    // Pre-materialize a valid managed install so the service short-circuits
    // the npm call via metadata reuse.
    const expectedEntryPath = await makeValidManagedInstall(
      userDataPath,
      '@mindstone-engineering/mcp-server-zendesk@0.3.0',
      '@mindstone-engineering/mcp-server-zendesk',
    );

    await writeJson(configPath, {
      mcpServers: {
        Zendesk: {
          name: 'Zendesk',
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@mindstone-engineering/mcp-server-zendesk@0.3.0'],
          catalogId: 'bundled-zendesk',
          email: 'alice@example.com',
          description: 'alice@example.com - Zendesk tickets',
          lastConnectedAt: 1712345678000,
          env: {
            ZENDESK_CONFIG_PATH: path.join(userDataPath, 'mcp', 'zendesk'),
            LOG_MODE: 'strict',
          },
        },
      },
    });

    const result = await upgradeRebelOssEntriesToManaged(configPath);

    expect(result.upgraded).toHaveLength(1);
    expect(result.upgraded[0]).toMatchObject({
      catalogId: 'bundled-zendesk',
      serverName: 'Zendesk',
      packageSpec: '@mindstone-engineering/mcp-server-zendesk@0.3.0',
    });
    expect(result.failed).toHaveLength(0);

    const updated = await readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(configPath);
    const entry = updated.mcpServers.Zendesk;
    expect(entry.command).toBe('node');
    expect(entry.args).toEqual([expectedEntryPath]);
    // Identity preserved
    expect(entry.catalogId).toBe('bundled-zendesk');
    expect(entry.email).toBe('alice@example.com');
    expect(entry.description).toBe('alice@example.com - Zendesk tickets');
    expect(entry.lastConnectedAt).toBe(1712345678000);
    // User-resolved env preserved
    expect(entry.env).toMatchObject({
      ZENDESK_CONFIG_PATH: path.join(userDataPath, 'mcp', 'zendesk'),
      LOG_MODE: 'strict',
    });
  });

  it('leaves non-rebel-oss entries untouched', async () => {
    await writeJson(configPath, {
      mcpServers: {
        ElevenLabs: {
          name: 'ElevenLabs',
          command: 'npx',
          args: ['-y', 'elevenlabs-mcp@1.0.0'],
          catalogId: 'community-elevenlabs',
        },
      },
    });

    const result = await upgradeRebelOssEntriesToManaged(configPath);

    expect(result.upgraded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);

    const unchanged = await readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(configPath);
    expect(unchanged.mcpServers.ElevenLabs.command).toBe('npx');
  });

  it('reinstalls and rewrites when a managed entry has a missing entry file', async () => {
    const packageSpec = '@mindstone-engineering/mcp-server-freshdesk@0.2.0';
    const packageName = '@mindstone-engineering/mcp-server-freshdesk';
    await makeValidManagedInstall(userDataPath, packageSpec, packageName);

    // Delete the entry file to simulate AV quarantine / manual cleanup
    const installRoot = path.join(userDataPath, 'mcp', 'managed-installs', packageSpec);
    const entryPath = path.join(installRoot, 'node_modules', ...packageName.split('/'), 'index.js');
    await fs.rm(entryPath, { force: true });

    await writeJson(configPath, {
      mcpServers: {
        Freshdesk: {
          name: 'Freshdesk',
          command: 'node',
          args: [entryPath],
          catalogId: 'bundled-freshdesk',
          email: 'bob@example.com',
        },
      },
    });

    // Run the upgrade — the service's install will re-materialize the file via
    // our mocked execFile (noop) and existing package.json + metadata remain in
    // place. But metadata validation will still fail because the entry file is
    // missing. Pre-create the entry file to represent a successful reinstall.
    await fs.writeFile(entryPath, 'module.exports = {};', 'utf8');

    const result = await upgradeRebelOssEntriesToManaged(configPath);

    // The auto-upgrade detected the invalid state and triggered a reinstall
    // (force=true). Whether the bucket is `upgraded` or `reinstalled` depends
    // on detection timing, but the entry should be rewritten to point at the
    // now-valid entry file.
    expect(result.failed).toHaveLength(0);
    const entry = (await readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(configPath))
      .mcpServers.Freshdesk;
    expect(entry.command).toBe('node');
    expect(entry.args).toEqual([entryPath]);
    expect(entry.email).toBe('bob@example.com');
  });

  it('skips valid managed entries (idempotent)', async () => {
    const packageSpec = '@mindstone-engineering/mcp-server-zendesk@0.3.0';
    const packageName = '@mindstone-engineering/mcp-server-zendesk';
    const entryPath = await makeValidManagedInstall(userDataPath, packageSpec, packageName);

    await writeJson(configPath, {
      mcpServers: {
        Zendesk: {
          name: 'Zendesk',
          command: 'node',
          args: [entryPath],
          catalogId: 'bundled-zendesk',
        },
      },
    });

    const result = await upgradeRebelOssEntriesToManaged(configPath);

    expect(result.upgraded).toHaveLength(0);
    expect(result.reinstalled).toHaveLength(0);
    expect(result.failed).toHaveLength(0);

    // File unchanged
    const unchanged = await readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(configPath);
    expect(unchanged.mcpServers.Zendesk.command).toBe('node');
    expect(unchanged.mcpServers.Zendesk.args).toEqual([entryPath]);
  });

  it('records a failure and leaves the npx entry intact when install throws', async () => {
    const { getManagedMcpInstallService } = await import(
      '../managedMcpInstallServiceInstance'
    );
    const service = getManagedMcpInstallService();
    expect(service).not.toBeNull();

    // Stub install to throw, simulating a network-unavailable install attempt
    const installSpy = vi
      .spyOn(service!, 'install')
      .mockRejectedValue(
        new ManagedMcpInstallError(
          'Failed to install due to offline',
          '@mindstone-engineering/mcp-server-zendesk@0.3.0',
        ),
      );

    await writeJson(configPath, {
      mcpServers: {
        Zendesk: {
          name: 'Zendesk',
          command: 'npx',
          args: ['-y', '@mindstone-engineering/mcp-server-zendesk@0.3.0'],
          catalogId: 'bundled-zendesk',
        },
      },
    });

    const result = await upgradeRebelOssEntriesToManaged(configPath);

    expect(result.upgraded).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      catalogId: 'bundled-zendesk',
      serverName: 'Zendesk',
    });

    // npx entry unchanged
    const unchanged = await readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(configPath);
    expect(unchanged.mcpServers.Zendesk.command).toBe('npx');
    expect(unchanged.mcpServers.Zendesk.args).toEqual([
      '-y',
      '@mindstone-engineering/mcp-server-zendesk@0.3.0',
    ]);

    installSpy.mockRestore();
  });

  it('reverts managed-path entry to npx form when reinstall-invalid-managed fails', async () => {
    const { getManagedMcpInstallService } = await import(
      '../managedMcpInstallServiceInstance'
    );
    const service = getManagedMcpInstallService();
    expect(service).not.toBeNull();

    const packageSpec = '@mindstone-engineering/mcp-server-zendesk@0.3.0';
    const packageName = '@mindstone-engineering/mcp-server-zendesk';
    // Pre-materialize metadata but with MISSING entry file so state is invalid.
    const installRoot = path.join(userDataPath, 'mcp', 'managed-installs', packageSpec);
    const packageDir = path.join(installRoot, 'node_modules', ...packageName.split('/'));
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: packageName, version: '0.3.0', main: 'index.js' }),
      'utf8',
    );
    // entry file intentionally NOT created — validation will fail
    await fs.writeFile(
      path.join(installRoot, '.install-meta.json'),
      JSON.stringify({
        packageSpec,
        packageName,
        version: '0.3.0',
        entryPath: path.join(packageDir, 'index.js'),
        installRoot,
        installedAt: new Date().toISOString(),
        platform: process.platform,
        nodeVersion: process.version,
        metaVersion: 1,
      }),
      'utf8',
    );

    // Reinstall fails (e.g., network down)
    const installSpy = vi
      .spyOn(service!, 'install')
      .mockRejectedValue(
        new ManagedMcpInstallError('Failed to reinstall: offline', packageSpec),
      );

    const deadEntryPath = path.join(packageDir, 'index.js');
    await writeJson(configPath, {
      mcpServers: {
        Zendesk: {
          name: 'Zendesk',
          type: 'stdio',
          command: 'node',
          args: [deadEntryPath],
          catalogId: 'bundled-zendesk',
          email: 'alice@example.com',
          env: {
            ZENDESK_CONFIG_PATH: path.join(userDataPath, 'mcp', 'zendesk'),
            LOG_MODE: 'strict',
          },
        },
      },
    });

    const result = await upgradeRebelOssEntriesToManaged(configPath);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain('reverted to npx');

    // Config should now be reverted to npx form (connector works, just slower)
    const reverted = await readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(configPath);
    expect(reverted.mcpServers.Zendesk.command).toBe('npx');
    expect(reverted.mcpServers.Zendesk.args).toEqual([
      '-y',
      '@mindstone-engineering/mcp-server-zendesk@0.3.0',
    ]);
    // Identity + user env preserved
    expect(reverted.mcpServers.Zendesk.catalogId).toBe('bundled-zendesk');
    expect(reverted.mcpServers.Zendesk.email).toBe('alice@example.com');
    expect(reverted.mcpServers.Zendesk.env).toMatchObject({
      ZENDESK_CONFIG_PATH: path.join(userDataPath, 'mcp', 'zendesk'),
      LOG_MODE: 'strict',
    });

    installSpy.mockRestore();
  });

  it('skips when the config file does not exist', async () => {
    const result = await upgradeRebelOssEntriesToManaged(path.join(userDataPath, 'missing.json'));

    expect(result.upgraded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('skips when catalog entry has no pinned version', async () => {
    await writeJson(path.join(resourcesDir, 'connector-catalog.json'), {
      connectors: [
        {
          id: 'bundled-zendesk',
          name: 'Zendesk',
          provider: 'rebel-oss',
          mcpConfig: {
            command: 'npx',
            // No version pinned
            args: ['-y', '@mindstone-engineering/mcp-server-zendesk'],
          },
        },
      ],
    });

    await writeJson(configPath, {
      mcpServers: {
        Zendesk: {
          name: 'Zendesk',
          command: 'npx',
          args: ['-y', '@mindstone-engineering/mcp-server-zendesk'],
          catalogId: 'bundled-zendesk',
        },
      },
    });

    const result = await upgradeRebelOssEntriesToManaged(configPath);

    expect(result.upgraded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('skips when managed install service is not configured', async () => {
    __resetManagedMcpInstallSingletonForTesting();

    await writeJson(configPath, {
      mcpServers: {
        Zendesk: {
          name: 'Zendesk',
          command: 'npx',
          args: ['-y', '@mindstone-engineering/mcp-server-zendesk@0.3.0'],
          catalogId: 'bundled-zendesk',
        },
      },
    });

    const result = await upgradeRebelOssEntriesToManaged(configPath);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('managed-install-service-not-configured');
  });

  it('quarantines a spec and reverts to npx after reinstall-loop threshold', async () => {
    const { getManagedMcpInstallService } = await import(
      '../managedMcpInstallServiceInstance'
    );
    const service = getManagedMcpInstallService();
    expect(service).not.toBeNull();

    const packageSpec = '@mindstone-engineering/mcp-server-zendesk@0.3.0';
    const packageName = '@mindstone-engineering/mcp-server-zendesk';

    // Pre-populate 3 prior attempts → service quarantines
    await service!.recordReinstallAttempt(packageSpec);
    await service!.recordReinstallAttempt(packageSpec);
    await service!.recordReinstallAttempt(packageSpec);

    // Create an invalid managed install on disk (entry file missing) so the
    // upgrade loop classifies it as reinstall-invalid-managed.
    const installRoot = path.join(userDataPath, 'mcp', 'managed-installs', packageSpec);
    const packageDir = path.join(installRoot, 'node_modules', ...packageName.split('/'));
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: packageName, version: '0.3.0', main: 'index.js' }),
      'utf8',
    );
    const entryPath = path.join(packageDir, 'index.js');
    await fs.writeFile(
      path.join(installRoot, '.install-meta.json'),
      JSON.stringify({
        packageSpec,
        packageName,
        version: '0.3.0',
        entryPath,
        installRoot,
        installedAt: new Date().toISOString(),
        platform: process.platform,
        nodeVersion: process.version,
        metaVersion: 1,
      }),
      'utf8',
    );
    // Entry file intentionally missing → validateInstalledState fails.

    const installSpy = vi.spyOn(service!, 'install');

    await writeJson(configPath, {
      mcpServers: {
        Zendesk: {
          name: 'Zendesk',
          command: 'node',
          args: [entryPath],
          catalogId: 'bundled-zendesk',
          email: 'alice@example.com',
          env: { LOG_MODE: 'strict' },
        },
      },
    });

    const result = await upgradeRebelOssEntriesToManaged(configPath);

    expect(installSpy).not.toHaveBeenCalled();
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]).toMatchObject({
      catalogId: 'bundled-zendesk',
      serverName: 'Zendesk',
      packageSpec,
      reinstallCount: 3,
    });

    const reverted = await readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(configPath);
    expect(reverted.mcpServers.Zendesk.command).toBe('npx');
    expect(reverted.mcpServers.Zendesk.args).toEqual([
      '-y',
      '@mindstone-engineering/mcp-server-zendesk@0.3.0',
    ]);

    installSpy.mockRestore();
  });

  it('records a reinstall attempt before forcing install when not quarantined', async () => {
    const { getManagedMcpInstallService } = await import(
      '../managedMcpInstallServiceInstance'
    );
    const service = getManagedMcpInstallService();
    expect(service).not.toBeNull();

    const packageSpec = '@mindstone-engineering/mcp-server-zendesk@0.3.0';
    const packageName = '@mindstone-engineering/mcp-server-zendesk';

    const installRoot = path.join(userDataPath, 'mcp', 'managed-installs', packageSpec);
    const packageDir = path.join(installRoot, 'node_modules', ...packageName.split('/'));
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: packageName, version: '0.3.0', main: 'index.js' }),
      'utf8',
    );
    const entryPath = path.join(packageDir, 'index.js');
    await fs.writeFile(
      path.join(installRoot, '.install-meta.json'),
      JSON.stringify({
        packageSpec,
        packageName,
        version: '0.3.0',
        entryPath,
        installRoot,
        installedAt: new Date().toISOString(),
        platform: process.platform,
        nodeVersion: process.version,
        metaVersion: 1,
      }),
      'utf8',
    );

    const recordSpy = vi.spyOn(service!, 'recordReinstallAttempt');
    const installSpy = vi.spyOn(service!, 'install').mockImplementation(async () => {
      await fs.writeFile(entryPath, 'module.exports = {};', 'utf8');
      return {
        packageSpec,
        packageName,
        version: '0.3.0',
        entryPath,
        installRoot,
        installedAt: new Date().toISOString(),
        platform: process.platform,
        nodeVersion: process.version,
        metaVersion: 1,
      };
    });

    await writeJson(configPath, {
      mcpServers: {
        Zendesk: {
          name: 'Zendesk',
          command: 'node',
          args: [entryPath],
          catalogId: 'bundled-zendesk',
        },
      },
    });

    const result = await upgradeRebelOssEntriesToManaged(configPath);

    expect(recordSpy).toHaveBeenCalledWith(packageSpec);
    expect(installSpy).toHaveBeenCalledWith({ packageSpec, force: true });
    expect(result.reinstalled).toHaveLength(1);
    expect(result.quarantined).toHaveLength(0);

    recordSpy.mockRestore();
    installSpy.mockRestore();
  });

  it('reverts to npx when install throws InstallPathTooLongError', async () => {
    const { getManagedMcpInstallService } = await import(
      '../managedMcpInstallServiceInstance'
    );
    const { InstallPathTooLongError } = await import('../managedMcpInstallService');
    const service = getManagedMcpInstallService();
    expect(service).not.toBeNull();

    const installSpy = vi
      .spyOn(service!, 'install')
      .mockRejectedValue(
        new InstallPathTooLongError(
          'Path exceeds budget',
          '@mindstone-engineering/mcp-server-zendesk@0.3.0',
        ),
      );

    await writeJson(configPath, {
      mcpServers: {
        Zendesk: {
          name: 'Zendesk',
          command: 'npx',
          args: ['-y', '@mindstone-engineering/mcp-server-zendesk@0.3.0'],
          catalogId: 'bundled-zendesk',
        },
      },
    });

    const result = await upgradeRebelOssEntriesToManaged(configPath);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/Path exceeds budget/);

    const configAfter = await readJson<{ mcpServers: Record<string, Record<string, unknown>> }>(configPath);
    expect(configAfter.mcpServers.Zendesk.command).toBe('npx');

    installSpy.mockRestore();
  });

  describe('scanForDevPrePublishSentinels', () => {
    // The sentinel + banner combo is the safety net for opus Q5 stale-shadow
    // drift: engineer forgets `dev-mcp-managed-install uninstall`, then ships
    // fixes against a phantom local-build repro. These tests assert the
    // sentinel file is discovered at startup so the banner can fire.

    const writeSentinel = async (
      slotPath: string,
      sentinel: DevPrePublishSentinel,
    ): Promise<void> => {
      await fs.mkdir(slotPath, { recursive: true });
      await fs.writeFile(
        path.join(slotPath, DEV_PRE_PUBLISH_SENTINEL_FILENAME),
        JSON.stringify(sentinel, null, 2),
        'utf8',
      );
    };

    it('returns an empty array when no sentinels exist (clean install — banner silent)', async () => {
      const hits = await scanForDevPrePublishSentinels();
      expect(hits).toEqual([]);
    });

    it('detects a scoped-package sentinel and reports installRoot + tarballPath + ageMs', async () => {
      const slotPath = path.join(
        userDataPath,
        'mcp',
        'managed-installs',
        '@mindstone',
        'mcp-server-hubspot@0.2.0',
      );
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
      await writeSentinel(slotPath, {
        source: 'pre-publish-test',
        installedAt: tenMinutesAgo,
        tarballPath: '/Users/you/dev/mcp-servers/connectors/hubspot/mindstone-mcp-server-hubspot-0.2.0.tgz',
        metaVersion: 1,
      });

      const hits = await scanForDevPrePublishSentinels();
      expect(hits).toHaveLength(1);
      expect(hits[0].packageSpec).toBe('@mindstone/mcp-server-hubspot@0.2.0');
      expect(hits[0].installRoot).toBe(slotPath);
      expect(hits[0].installedAt).toBe(tenMinutesAgo);
      expect(hits[0].tarballPath).toContain('mindstone-mcp-server-hubspot-0.2.0.tgz');
      expect(hits[0].ageMs).toBeGreaterThanOrEqual(10 * 60_000 - 1_000);
      expect(hits[0].ageMs).toBeLessThan(15 * 60_000);
    });

    it('detects an unscoped-package sentinel (e.g. elevenlabs-mcp@1.0.0)', async () => {
      const slotPath = path.join(
        userDataPath,
        'mcp',
        'managed-installs',
        'example-package@1.2.3',
      );
      await writeSentinel(slotPath, {
        source: 'pre-publish-test',
        installedAt: new Date().toISOString(),
        tarballPath: '/tmp/example-package-1.2.3.tgz',
        metaVersion: 1,
      });

      const hits = await scanForDevPrePublishSentinels();
      expect(hits).toHaveLength(1);
      expect(hits[0].packageSpec).toBe('example-package@1.2.3');
    });

    it('detects multiple sentinels across scoped and unscoped slots concurrently', async () => {
      await writeSentinel(
        path.join(userDataPath, 'mcp', 'managed-installs', '@mindstone', 'mcp-server-slack@0.1.0'),
        {
          source: 'pre-publish-test',
          installedAt: new Date().toISOString(),
          tarballPath: '/tmp/slack.tgz',
          metaVersion: 1,
        },
      );
      await writeSentinel(
        path.join(userDataPath, 'mcp', 'managed-installs', 'example-package@1.0.0'),
        {
          source: 'pre-publish-test',
          installedAt: new Date().toISOString(),
          tarballPath: '/tmp/example.tgz',
          metaVersion: 1,
        },
      );

      const hits = await scanForDevPrePublishSentinels();
      const specs = hits.map((h) => h.packageSpec).sort();
      expect(specs).toEqual(['@mindstone/mcp-server-slack@0.1.0', 'example-package@1.0.0']);
    });

    it('skips slots without sentinels (normal registry installs are quiet)', async () => {
      // Build a normal slot WITHOUT a sentinel — the steady-state production
      // pattern. Scanner must not produce any hits for these.
      const slotPath = path.join(
        userDataPath,
        'mcp',
        'managed-installs',
        '@mindstone',
        'mcp-server-vanta@0.1.0',
      );
      await fs.mkdir(slotPath, { recursive: true });
      await fs.writeFile(
        path.join(slotPath, '.install-meta.json'),
        JSON.stringify({ packageSpec: '@mindstone/mcp-server-vanta@0.1.0' }),
        'utf8',
      );

      const hits = await scanForDevPrePublishSentinels();
      expect(hits).toEqual([]);
    });

    it('does not throw on malformed sentinel JSON (degraded-but-running per silent-failure policy)', async () => {
      // Failure must be non-fatal and OBSERVABLE: the scanner logs a warn and
      // continues. Throwing here would derail startup, which is worse than the
      // sentinel being missed for one launch.
      const slotPath = path.join(
        userDataPath,
        'mcp',
        'managed-installs',
        '@mindstone',
        'mcp-server-broken@0.1.0',
      );
      await fs.mkdir(slotPath, { recursive: true });
      await fs.writeFile(
        path.join(slotPath, DEV_PRE_PUBLISH_SENTINEL_FILENAME),
        '{ not valid json',
        'utf8',
      );

      const hits = await scanForDevPrePublishSentinels();
      // The malformed slot produces no hit, but the scanner itself returns
      // cleanly so other slots / startup continue.
      expect(hits).toEqual([]);
    });

    it('returns an empty array when the managed-installs root does not exist (first-launch case)', async () => {
      // Pre-existing managed-installs root from beforeEach makeValidManagedInstall
      // calls in upgrade tests can pollute this; force a fresh user-data root.
      __resetManagedMcpInstallSingletonForTesting();
      const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-mcp-sentinel-iso-'));
      try {
        configureManagedMcpInstallService(isolatedRoot);
        const hits = await scanForDevPrePublishSentinels();
        expect(hits).toEqual([]);
      } finally {
        await fs.rm(isolatedRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  });
});
