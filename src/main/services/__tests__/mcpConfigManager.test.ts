/**
 * Tests for mcpConfigManager disable/enable functionality.
 * 
 * Tests the `setMcpServerDisabled()` and `isServerDisabled()` functions
 * that manage the `disabledServers` array in MCP router configs.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  setMcpServerDisabled,
  isServerDisabled,
  setMcpServerOAuthFlag,
  repairBundledMcpScriptPaths,
  backfillCatalogIds,
  isAllowedCatalogNpxPackageMigration,
  reconcileBundledMcpScriptPaths,
  reconcileNpxPackageVersions,
  reconcileHttpUrls,
  getMcpServerNames,
  ensureRouterConfigFile,
} from '../mcpConfigManager';

describe('mcpConfigManager disable/enable', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-mcp-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  beforeEach(async () => {
    // Create fresh config for each test
    configPath = path.join(tempDir, `config-${Date.now()}.json`);
    const baseConfig = {
      configPaths: [],
      mcpServers: {
        'test-server-1': { command: 'node', args: ['server1.js'] },
        'test-server-2': { command: 'node', args: ['server2.js'] },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(baseConfig, null, 2), 'utf8');
  });

  it('creates the Super-MCP router file with owner-only permissions', async () => {
    const routerPath = path.join(tempDir, `super-mcp-router-${Date.now()}`, 'super-mcp-router.json');

    await ensureRouterConfigFile(routerPath);

    if (process.platform !== 'win32') {
      const mode = (await fs.stat(routerPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  describe('setMcpServerDisabled', () => {
    it('adds server to disabledServers array when disabling', async () => {
      await setMcpServerDisabled(configPath, 'test-server-1', true);

      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(config.disabledServers).toEqual(['test-server-1']);
    });

    it('removes server from disabledServers array when enabling', async () => {
      // First disable the server
      await setMcpServerDisabled(configPath, 'test-server-1', true);
      let config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(config.disabledServers).toEqual(['test-server-1']);

      // Now enable it
      await setMcpServerDisabled(configPath, 'test-server-1', false);
      config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      // Empty array should be cleaned up
      expect(config.disabledServers).toBeUndefined();
    });

    it('is idempotent when disabling already-disabled server', async () => {
      // Disable twice
      await setMcpServerDisabled(configPath, 'test-server-1', true);
      await setMcpServerDisabled(configPath, 'test-server-1', true);

      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      // Should only appear once (no duplicates)
      expect(config.disabledServers).toEqual(['test-server-1']);
    });

    it('is idempotent when enabling already-enabled server', async () => {
      // Enable without disabling first (server is enabled by default)
      await setMcpServerDisabled(configPath, 'test-server-1', false);

      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      // disabledServers should be cleaned up (undefined, not empty array)
      expect(config.disabledServers).toBeUndefined();
    });

    it('cleans up empty disabledServers array from config', async () => {
      // Disable then enable
      await setMcpServerDisabled(configPath, 'test-server-1', true);
      await setMcpServerDisabled(configPath, 'test-server-1', false);

      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      // Key should be deleted, not set to empty array
      expect(config).not.toHaveProperty('disabledServers');
    });

    it('throws error for empty serverId', async () => {
      await expect(setMcpServerDisabled(configPath, '', true)).rejects.toThrow(
        'Server ID is required'
      );
    });

    it('throws error for whitespace-only serverId', async () => {
      await expect(setMcpServerDisabled(configPath, '   ', true)).rejects.toThrow(
        'Server ID is required'
      );
    });

    it('preserves other servers in disabledServers array', async () => {
      // Disable two servers
      await setMcpServerDisabled(configPath, 'test-server-1', true);
      await setMcpServerDisabled(configPath, 'test-server-2', true);

      let config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(config.disabledServers).toContain('test-server-1');
      expect(config.disabledServers).toContain('test-server-2');
      expect(config.disabledServers).toHaveLength(2);

      // Enable only the first one
      await setMcpServerDisabled(configPath, 'test-server-1', false);
      config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(config.disabledServers).toEqual(['test-server-2']);
    });

    it('handles config without existing disabledServers', async () => {
      // Config doesn't have disabledServers field initially
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(config.disabledServers).toBeUndefined();

      // Should create it when disabling
      await setMcpServerDisabled(configPath, 'test-server-1', true);
      const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(updated.disabledServers).toEqual(['test-server-1']);
    });

    it('handles config with invalid disabledServers (non-array)', async () => {
      // Set disabledServers to invalid value
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      config.disabledServers = 'invalid-not-an-array';
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

      // Should replace with valid array
      await setMcpServerDisabled(configPath, 'test-server-1', true);
      const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(Array.isArray(updated.disabledServers)).toBe(true);
      expect(updated.disabledServers).toEqual(['test-server-1']);
    });
  });

  describe('isServerDisabled', () => {
    it('returns true for disabled server', async () => {
      await setMcpServerDisabled(configPath, 'test-server-1', true);

      const disabled = await isServerDisabled(configPath, 'test-server-1');
      expect(disabled).toBe(true);
    });

    it('returns false for enabled server', async () => {
      // Server not in disabledServers
      const disabled = await isServerDisabled(configPath, 'test-server-1');
      expect(disabled).toBe(false);
    });

    it("returns false when disabledServers doesn't exist", async () => {
      // Verify config doesn't have disabledServers
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(config.disabledServers).toBeUndefined();

      const disabled = await isServerDisabled(configPath, 'test-server-1');
      expect(disabled).toBe(false);
    });

    it('returns false for non-existent config file', async () => {
      const nonExistentPath = path.join(tempDir, 'non-existent.json');

      // Should not throw, just return false
      const disabled = await isServerDisabled(nonExistentPath, 'test-server-1');
      expect(disabled).toBe(false);
    });

    it('returns false for invalid JSON config', async () => {
      const invalidPath = path.join(tempDir, 'invalid.json');
      await fs.writeFile(invalidPath, 'not valid json', 'utf8');

      // Should not throw, just return false
      const disabled = await isServerDisabled(invalidPath, 'test-server-1');
      expect(disabled).toBe(false);
    });

    it('backs up malformed JSON without overwriting the original config', async () => {
      const invalidPath = path.join(tempDir, `invalid-backup-${Date.now()}.json`);
      const malformedJson = '{ "mcpServers": {';
      await fs.writeFile(invalidPath, malformedJson, 'utf8');

      const names = await getMcpServerNames(invalidPath);

      expect(names).toEqual([]);
      await expect(fs.readFile(invalidPath, 'utf8')).resolves.toBe(malformedJson);

      const files = await fs.readdir(tempDir);
      const backups = files.filter((file) =>
        file.startsWith(`${path.basename(invalidPath)}.malformed-`) && file.endsWith('.bak')
      );
      expect(backups).toHaveLength(1);
      await expect(fs.readFile(path.join(tempDir, backups[0]), 'utf8')).resolves.toBe(malformedJson);
    });

    it('returns false when disabledServers is not an array', async () => {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      config.disabledServers = 'not-an-array';
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

      const disabled = await isServerDisabled(configPath, 'test-server-1');
      expect(disabled).toBe(false);
    });

    it('correctly distinguishes between disabled and enabled servers', async () => {
      // Disable server 1, leave server 2 enabled
      await setMcpServerDisabled(configPath, 'test-server-1', true);

      expect(await isServerDisabled(configPath, 'test-server-1')).toBe(true);
      expect(await isServerDisabled(configPath, 'test-server-2')).toBe(false);
    });
  });

  describe('setMcpServerOAuthFlag', () => {
    it('adds oauth:true to a server that lacks the flag', async () => {
      await setMcpServerOAuthFlag(configPath, 'test-server-1', true);
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(config.mcpServers['test-server-1'].oauth).toBe(true);
      // Untouched sibling.
      expect(config.mcpServers['test-server-2'].oauth).toBeUndefined();
    });

    it('removes oauth flag when set to false', async () => {
      await setMcpServerOAuthFlag(configPath, 'test-server-1', true);
      await setMcpServerOAuthFlag(configPath, 'test-server-1', false);
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(config.mcpServers['test-server-1'].oauth).toBeUndefined();
    });

    it('is idempotent when flag already at desired value', async () => {
      await setMcpServerOAuthFlag(configPath, 'test-server-1', true);
      await setMcpServerOAuthFlag(configPath, 'test-server-1', true);
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(config.mcpServers['test-server-1'].oauth).toBe(true);
    });

    it('preserves unrelated fields (command/args/env/oauthClientId)', async () => {
      const before = JSON.parse(await fs.readFile(configPath, 'utf8'));
      before.mcpServers['test-server-1'] = {
        ...before.mcpServers['test-server-1'],
        url: 'https://example.com/mcp',
        oauthClientId: 'client-123',
        env: { API_KEY: 'secret' },
      };
      await fs.writeFile(configPath, JSON.stringify(before, null, 2), 'utf8');

      await setMcpServerOAuthFlag(configPath, 'test-server-1', true);

      const after = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(after.mcpServers['test-server-1'].oauth).toBe(true);
      expect(after.mcpServers['test-server-1'].url).toBe('https://example.com/mcp');
      expect(after.mcpServers['test-server-1'].oauthClientId).toBe('client-123');
      expect(after.mcpServers['test-server-1'].env).toEqual({ API_KEY: 'secret' });
      expect(after.mcpServers['test-server-1'].command).toBe('node');
    });

    it('no-ops when server is missing (does not crash)', async () => {
      await expect(
        setMcpServerOAuthFlag(configPath, 'does-not-exist', true)
      ).resolves.toBeUndefined();
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(config.mcpServers['does-not-exist']).toBeUndefined();
    });

    it('rejects empty server name', async () => {
      await expect(setMcpServerOAuthFlag(configPath, '', true)).rejects.toThrow(/Server name/);
      await expect(setMcpServerOAuthFlag(configPath, '   ', true)).rejects.toThrow(/Server name/);
    });
  });
});

describe('repairBundledMcpScriptPaths', () => {
  let tempDir: string;
  let configPath: string;
  const currentResourcesPath = 'C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.3.8\\resources';

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-mcp-repair-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  beforeEach(async () => {
    configPath = path.join(tempDir, `config-${Date.now()}.json`);
  });

  it('repairs stale Windows paths in args', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365Calendar': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\microsoft-calendar\\build\\index.js'],
          catalogId: 'bundled-microsoft-calendar',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await repairBundledMcpScriptPaths(configPath, tempDir, true, currentResourcesPath);

    expect(result.repaired).toBe(1);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    // Should contain the new resources path and the relative suffix
    expect(updated.mcpServers['Microsoft365Calendar'].args[0]).toContain('app-0.3.8');
    expect(updated.mcpServers['Microsoft365Calendar'].args[0]).toContain('microsoft-calendar');
    expect(updated.mcpServers['Microsoft365Calendar'].args[0]).not.toContain('app-0.2.35');
  });

  it('repairs stale paths in env.NODE_PATH', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Slack': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\slack\\build\\index.js'],
          env: {
            NODE_PATH: 'C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\slack\\node_modules',
          },
          catalogId: 'bundled-slack',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await repairBundledMcpScriptPaths(configPath, tempDir, true, currentResourcesPath);

    expect(result.repaired).toBe(1);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    // Should contain the new resources path and the relative suffix
    expect(updated.mcpServers['Slack'].env.NODE_PATH).toContain('app-0.3.8');
    expect(updated.mcpServers['Slack'].env.NODE_PATH).toContain('node_modules');
    expect(updated.mcpServers['Slack'].env.NODE_PATH).not.toContain('app-0.2.35');
  });

  it('handles prerelease version paths (e.g., app-0.3.8-beta.1)', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365Mail': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.3.7-beta.2\\resources\\mcp\\microsoft-mail\\build\\index.js'],
          catalogId: 'bundled-microsoft-mail',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await repairBundledMcpScriptPaths(configPath, tempDir, true, currentResourcesPath);

    expect(result.repaired).toBe(1);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['Microsoft365Mail'].args[0]).toContain('app-0.3.8');
  });

  it('skips non-bundled servers (no catalogId prefix)', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'CustomServer': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\custom\\server.js'],
          catalogId: 'custom-server', // Not bundled-*
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await repairBundledMcpScriptPaths(configPath, tempDir, true, currentResourcesPath);

    expect(result.repaired).toBe(0);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['CustomServer'].args[0]).toContain('app-0.2.35'); // Unchanged
  });

  it('skips servers without catalogId', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'LegacyServer': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\legacy\\index.js'],
          // No catalogId
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await repairBundledMcpScriptPaths(configPath, tempDir, true, currentResourcesPath);

    expect(result.repaired).toBe(0);
  });

  it('is idempotent - no changes when paths are already correct', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365Calendar': {
          command: 'node',
          args: [path.join(currentResourcesPath, 'mcp', 'microsoft-calendar', 'build', 'index.js')],
          catalogId: 'bundled-microsoft-calendar',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await repairBundledMcpScriptPaths(configPath, tempDir, true, currentResourcesPath);

    expect(result.repaired).toBe(0);
    expect(result.backupPath).toBeNull();
  });

  it('skips in dev mode (isPackaged = false)', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365Calendar': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\calendar\\index.js'],
          catalogId: 'bundled-microsoft-calendar',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await repairBundledMcpScriptPaths(configPath, tempDir, false, currentResourcesPath);

    expect(result.repaired).toBe(0);
  });

  it('skips non-router configs (no configPaths array)', async () => {
    const config = {
      // No configPaths array - not a router config
      mcpServers: {
        'Microsoft365Calendar': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\calendar\\index.js'],
          catalogId: 'bundled-microsoft-calendar',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await repairBundledMcpScriptPaths(configPath, tempDir, true, currentResourcesPath);

    expect(result.repaired).toBe(0);
  });

  it('skips configs outside userData directory', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-outside-'));
    const outsidePath = path.join(outsideDir, 'config.json');
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365Calendar': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\calendar\\index.js'],
          catalogId: 'bundled-microsoft-calendar',
        },
      },
    };
    await fs.writeFile(outsidePath, JSON.stringify(config, null, 2), 'utf8');

    // Pass tempDir as userDataPath, but config is in outsideDir
    const result = await repairBundledMcpScriptPaths(outsidePath, tempDir, true, currentResourcesPath);

    expect(result.repaired).toBe(0);
    await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('creates backup when making repairs', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365Calendar': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\calendar\\index.js'],
          catalogId: 'bundled-microsoft-calendar',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await repairBundledMcpScriptPaths(configPath, tempDir, true, currentResourcesPath);

    expect(result.repaired).toBe(1);
    expect(result.backupPath).not.toBeNull();
    // Verify backup exists
    const backupExists = await fs.stat(result.backupPath!).then(() => true).catch(() => false);
    expect(backupExists).toBe(true);
  });

  it('repairs multiple servers in single pass', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365Calendar': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\microsoft-calendar\\build\\index.js'],
          catalogId: 'bundled-microsoft-calendar',
        },
        'Microsoft365Mail': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\microsoft-mail\\build\\index.js'],
          catalogId: 'bundled-microsoft-mail',
        },
        'Slack': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\slack\\build\\index.js'],
          catalogId: 'bundled-slack',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await repairBundledMcpScriptPaths(configPath, tempDir, true, currentResourcesPath);

    expect(result.repaired).toBe(3);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['Microsoft365Calendar'].args[0]).toContain('app-0.3.8');
    expect(updated.mcpServers['Microsoft365Mail'].args[0]).toContain('app-0.3.8');
    expect(updated.mcpServers['Slack'].args[0]).toContain('app-0.3.8');
  });

  it('preserves non-path env values', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365Calendar': {
          command: 'node',
          args: ['C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\calendar\\index.js'],
          env: {
            NODE_PATH: 'C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.2.35\\resources\\mcp\\calendar\\node_modules',
            MS_CLIENT_ID: '12345-abcde',
            LOG_MODE: 'strict',
          },
          catalogId: 'bundled-microsoft-calendar',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    await repairBundledMcpScriptPaths(configPath, tempDir, true, currentResourcesPath);

    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    // Non-path env values should be unchanged
    expect(updated.mcpServers['Microsoft365Calendar'].env.MS_CLIENT_ID).toBe('12345-abcde');
    expect(updated.mcpServers['Microsoft365Calendar'].env.LOG_MODE).toBe('strict');
  });
});

describe('reconcileBundledMcpScriptPaths', () => {
  let tempDir: string;
  let configPath: string;
  const currentResourcesPath = 'C:\\Users\\test\\AppData\\Local\\rebel-app\\app-0.3.8\\resources';

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-mcp-reconcile-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  beforeEach(async () => {
    configPath = path.join(tempDir, `config-${Date.now()}.json`);
  });

  it('rewrites imported npx Google Workspace configs to the bundled server.cjs in mcp-generated/', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        GoogleWorkspace: {
          command: 'npx',
          args: ['-y', '@anthropic-ai/google-workspace-mcp'],
          catalogId: 'bundled-google',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    // Generated MCPs now live in mcp-generated/
    const expectedPath = path.join(currentResourcesPath, 'mcp-generated', 'google-workspace', 'server.cjs');
    const fakeAccess = async (p: string) => {
      if (p === expectedPath) return;
      throw new Error('ENOENT');
    };

    const result = await reconcileBundledMcpScriptPaths(
      configPath,
      tempDir,
      true,
      currentResourcesPath,
      fakeAccess
    );

    expect(result.reconciled).toBe(1);

    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers.GoogleWorkspace.command).toBe('node');
    expect(updated.mcpServers.GoogleWorkspace.args).toEqual([expectedPath]);
  });

  it('handles version-pinned npm package args (e.g., @anthropic-ai/google-workspace-mcp@1.2.3)', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'GoogleWorkspace-test-example-com': {
          command: 'npx',
          args: ['-y', '@anthropic-ai/google-workspace-mcp@1.2.3'],
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    // Generated MCPs now live in mcp-generated/
    const expectedPath = path.join(currentResourcesPath, 'mcp-generated', 'google-workspace', 'server.cjs');
    const fakeAccess = async (p: string) => {
      if (p === expectedPath) return;
      throw new Error('ENOENT');
    };

    const result = await reconcileBundledMcpScriptPaths(
      configPath,
      tempDir,
      true,
      currentResourcesPath,
      fakeAccess
    );

    expect(result.reconciled).toBe(1);

    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['GoogleWorkspace-test-example-com'].command).toBe('node');
    expect(updated.mcpServers['GoogleWorkspace-test-example-com'].args).toEqual([expectedPath]);
  });

  it('migrates generated MCP paths from old /mcp/ to new /mcp-generated/ location', async () => {
    // This simulates a user who has an existing config pointing to the OLD location
    const oldPath = path.join(currentResourcesPath, 'mcp', 'discourse', 'server.cjs');
    const config = {
      configPaths: [],
      mcpServers: {
        'Discourse': {
          command: 'node',
          args: [oldPath],
          catalogId: 'bundled-discourse',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    // The NEW correct path is in mcp-generated/
    const newPath = path.join(currentResourcesPath, 'mcp-generated', 'discourse', 'server.cjs');
    const fakeAccess = async (p: string) => {
      // Old path doesn't exist anymore (would fail), new path does exist
      if (p === newPath) return;
      throw new Error('ENOENT');
    };

    const result = await reconcileBundledMcpScriptPaths(
      configPath,
      tempDir,
      true,
      currentResourcesPath,
      fakeAccess
    );

    expect(result.reconciled).toBe(1);

    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers.Discourse.args[0]).toBe(newPath);
    expect(updated.mcpServers.Discourse.args[0]).toContain('mcp-generated');
  });

  it('does not migrate hand-written MCPs - they stay in /mcp/', async () => {
    // Hand-written MCPs (like rebel-inbox) should stay in /mcp/
    const rebelInboxPath = path.join(currentResourcesPath, 'mcp', 'rebel-inbox', 'server.cjs');
    const config = {
      configPaths: [],
      mcpServers: {
        'RebelInbox': {
          command: 'node',
          args: [rebelInboxPath],
          catalogId: 'rebel-inbox',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const fakeAccess = async (p: string) => {
      // The path already exists and is correct
      if (p === rebelInboxPath) return;
      throw new Error('ENOENT');
    };

    const result = await reconcileBundledMcpScriptPaths(
      configPath,
      tempDir,
      true,
      currentResourcesPath,
      fakeAccess
    );

    // Should not be reconciled - path is already correct
    expect(result.reconciled).toBe(0);

    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers.RebelInbox.args[0]).toBe(rebelInboxPath);
    expect(updated.mcpServers.RebelInbox.args[0]).toContain(path.join('mcp', 'rebel-inbox'));
    expect(updated.mcpServers.RebelInbox.args[0]).not.toContain('mcp-generated');
  });

  it('migrates multiple generated MCPs from old /mcp/ to /mcp-generated/', async () => {
    // Multiple generated MCPs with old paths (only remaining bundled connectors)
    const config = {
      configPaths: [],
      mcpServers: {
        'Discourse': {
          command: 'node',
          args: [path.join(currentResourcesPath, 'mcp', 'discourse', 'server.cjs')],
          catalogId: 'bundled-discourse',
        },
        'Microsoft365Calendar': {
          command: 'node',
          args: [path.join(currentResourcesPath, 'mcp', 'microsoft-calendar', 'server.cjs')],
          catalogId: 'bundled-microsoft-calendar',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const fakeAccess = async (p: string) => {
      // Only the new mcp-generated paths exist
      if (p.includes('mcp-generated')) return;
      throw new Error('ENOENT');
    };

    const result = await reconcileBundledMcpScriptPaths(
      configPath,
      tempDir,
      true,
      currentResourcesPath,
      fakeAccess
    );

    expect(result.reconciled).toBe(2);

    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers.Discourse.args[0]).toContain('mcp-generated');
    expect(updated.mcpServers.Microsoft365Calendar.args[0]).toContain('mcp-generated');
  });
});

describe('reconcileNpxPackageVersions', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-mcp-npx-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  beforeEach(async () => {
    configPath = path.join(tempDir, `config-${Date.now()}.json`);
  });

  it('updates stale Xero npx package specifier to match catalog', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Xero-acme': {
          command: 'npx',
          args: ['-y', '@harrybloom18/xero-mcp-server@0.0.14-fix.1'],
          catalogId: 'xero',
          env: { XERO_CLIENT_ID: 'abc', XERO_CLIENT_SECRET: 'secret' },
          email: '[external-email]',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileNpxPackageVersions(configPath, tempDir);

    expect(result.updated).toBe(1);
    expect(result.backupPath).toBeTruthy();
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    // Package and version should be updated to the catalog pin.
    expect(updated.mcpServers['Xero-acme'].args[1]).toBe('@mindstone/mcp-server-xero@0.0.17');
    expect(updated.mcpServers['Xero-acme'].args[1]).not.toBe('@harrybloom18/xero-mcp-server@0.0.14-fix.1');
    // Other config preserved
    expect(updated.mcpServers['Xero-acme'].env.XERO_CLIENT_ID).toBe('abc');
    expect(updated.mcpServers['Xero-acme'].email).toBe('[external-email]');
  });

  it('skips servers already at the correct version', async () => {
    // Read the actual catalog to find the current xero version
    const catalogJson = JSON.parse(
      await fs.readFile(path.join(__dirname, '../../../../resources/connector-catalog.json'), 'utf8')
    );
    const xeroEntry = catalogJson.connectors.find((c: { id: string }) => c.id === 'xero');
    const currentXeroArgs = xeroEntry?.mcpConfig?.args;

    const config = {
      configPaths: [],
      mcpServers: {
        'Xero-acme': {
          command: 'npx',
          args: [...currentXeroArgs],
          catalogId: 'xero',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileNpxPackageVersions(configPath, tempDir);

    expect(result.updated).toBe(0);
    expect(result.backupPath).toBeNull();
  });

  it('skips servers without a catalogId', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'CustomXero': {
          command: 'npx',
          args: ['-y', '@harrybloom18/xero-mcp-server@0.0.1'],
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileNpxPackageVersions(configPath, tempDir);
    expect(result.updated).toBe(0);
  });

  it('skips non-npx servers', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'BundledServer': {
          command: 'node',
          args: ['/path/to/server.cjs'],
          catalogId: 'bundled-google',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileNpxPackageVersions(configPath, tempDir);
    expect(result.updated).toBe(0);
  });

  it('skips if unscoped package name does not match catalog', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Xero-custom': {
          command: 'npx',
          args: ['-y', '@some-other/xero-server@1.0.0'],
          catalogId: 'xero',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileNpxPackageVersions(configPath, tempDir);
    expect(result.updated).toBe(0);
  });

  it('allows the managed Xero package rename to the Mindstone package name', () => {
    expect(
      isAllowedCatalogNpxPackageMigration(
        'xero',
        '@harrybloom18/xero-mcp-server',
        '@mindstone/mcp-server-xero',
      ),
    ).toBe(true);
    expect(
      isAllowedCatalogNpxPackageMigration(
        'xero',
        '@xeroapi/xero-mcp-server',
        '@mindstone/mcp-server-xero',
      ),
    ).toBe(true);
  });

  it('rewrites the managed Xero personal package to the Mindstone package when catalog points there', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Xero-acme': {
          command: 'npx',
          args: ['-y', '@harrybloom18/xero-mcp-server@0.0.14-fix.5', '--debug'],
          catalogId: 'xero',
          env: { XERO_CLIENT_ID: 'abc', XERO_CLIENT_SECRET: 'secret' },
          email: '[external-email]',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const futureCatalog = {
      connectors: [
        {
          id: 'xero',
          mcpConfig: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-xero@0.0.17'],
          },
        },
      ],
    };

    const result = await reconcileNpxPackageVersions(configPath, tempDir, futureCatalog as never);

    expect(result.updated).toBe(1);
    expect(result.backupPath).toBeTruthy();

    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['Xero-acme'].args).toEqual([
      '-y',
      '@mindstone/mcp-server-xero@0.0.17',
      '--debug',
    ]);
    expect(updated.mcpServers['Xero-acme'].env).toEqual({
      XERO_CLIENT_ID: 'abc',
      XERO_CLIENT_SECRET: 'secret',
    });
    expect(updated.mcpServers['Xero-acme'].email).toBe('[external-email]');
  });

  it('does not allow non-Xero package renames with different package names', () => {
    expect(
      isAllowedCatalogNpxPackageMigration(
        'xero',
        '@some-other/xero-server',
        '@mindstone/mcp-server-xero',
      ),
    ).toBe(false);
    expect(
      isAllowedCatalogNpxPackageMigration(
        'bundled-fathom',
        '@old-org/fathom-server',
        '@mindstone/mcp-server-fathom',
      ),
    ).toBe(false);
  });

  it('updates package specifier when catalog scope changes (org rename)', async () => {
    // Simulates a user with an old scope whose catalog now points to the
    // current scope — the unscoped name matches so it should update.
    const config = {
      configPaths: [],
      mcpServers: {
        Fathom: {
          command: 'npx',
          args: ['-y', '@old-org/mcp-server-fathom'],
          catalogId: 'bundled-fathom',
          env: { FATHOM_CONFIG_PATH: '/some/path', LOG_MODE: 'strict' },
          email: '[external-email]',
          lastConnectedAt: 1700000000000,
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileNpxPackageVersions(configPath, tempDir);

    expect(result.updated).toBe(1);
    expect(result.backupPath).toBeTruthy();
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    // Package specifier should now use the catalog's scope (not the old one)
    expect(updated.mcpServers.Fathom.args[1]).toContain('mcp-server-fathom');
    expect(updated.mcpServers.Fathom.args[1]).not.toContain('@old-org/');
    // All other config preserved
    expect(updated.mcpServers.Fathom.env.FATHOM_CONFIG_PATH).toBe('/some/path');
    expect(updated.mcpServers.Fathom.env.LOG_MODE).toBe('strict');
    expect(updated.mcpServers.Fathom.email).toBe('[external-email]');
    expect(updated.mcpServers.Fathom.lastConnectedAt).toBe(1700000000000);
    expect(updated.mcpServers.Fathom.catalogId).toBe('bundled-fathom');
  });

  it('updates when both scope and version change simultaneously', async () => {
    // User has old scope + old version; catalog has current scope (+ possibly newer version)
    const config = {
      configPaths: [],
      mcpServers: {
        Fathom: {
          command: 'npx',
          args: ['-y', '@old-org/mcp-server-fathom@0.2.0'],
          catalogId: 'bundled-fathom',
          env: { FATHOM_CONFIG_PATH: '/some/path' },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileNpxPackageVersions(configPath, tempDir);

    expect(result.updated).toBe(1);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    // Should have updated both scope and version to match catalog
    expect(updated.mcpServers.Fathom.args[1]).toContain('mcp-server-fathom');
    expect(updated.mcpServers.Fathom.args[1]).not.toContain('@old-org/');
    expect(updated.mcpServers.Fathom.args[1]).not.toBe('@old-org/mcp-server-fathom@0.2.0');
    // Env preserved
    expect(updated.mcpServers.Fathom.env.FATHOM_CONFIG_PATH).toBe('/some/path');
  });

  it('preserves trailing args after the package specifier', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Xero-acme': {
          command: 'npx',
          args: ['-y', '@harrybloom18/xero-mcp-server@0.0.1', '--debug'],
          catalogId: 'xero',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileNpxPackageVersions(configPath, tempDir);

    expect(result.updated).toBe(1);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    // Trailing arg preserved
    expect(updated.mcpServers['Xero-acme'].args[2]).toBe('--debug');
    // Only the package specifier was updated
    expect(updated.mcpServers['Xero-acme'].args[0]).toBe('-y');
  });

  it('updates multiple servers in one pass', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Xero-llc': {
          command: 'npx',
          args: ['-y', '@harrybloom18/xero-mcp-server@0.0.1'],
          catalogId: 'xero',
        },
        'Xero-uk': {
          command: 'npx',
          args: ['-y', '@harrybloom18/xero-mcp-server@0.0.2'],
          catalogId: 'xero',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileNpxPackageVersions(configPath, tempDir);

    expect(result.updated).toBe(2);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['Xero-llc'].args[1]).toBe(updated.mcpServers['Xero-uk'].args[1]);
  });

  it('skips configs outside userData directory', async () => {
    const outsidePath = path.join(os.tmpdir(), `outside-config-${Date.now()}.json`);
    const config = {
      configPaths: [],
      mcpServers: {
        'Xero-acme': {
          command: 'npx',
          args: ['-y', '@harrybloom18/xero-mcp-server@0.0.1'],
          catalogId: 'xero',
        },
      },
    };
    await fs.writeFile(outsidePath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileNpxPackageVersions(outsidePath, tempDir);
    expect(result.updated).toBe(0);

    await fs.rm(outsidePath).catch(() => undefined);
  });

  it('skips non-router configs (missing configPaths)', async () => {
    const config = {
      mcpServers: {
        'Xero-acme': {
          command: 'npx',
          args: ['-y', '@harrybloom18/xero-mcp-server@0.0.1'],
          catalogId: 'xero',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileNpxPackageVersions(configPath, tempDir);
    expect(result.updated).toBe(0);
  });
});

describe('reconcileHttpUrls', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-mcp-url-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  beforeEach(async () => {
    configPath = path.join(tempDir, `config-${Date.now()}.json`);
  });

  // The webflow catalog entry is our canonical example (beta → stable migration).
  // Tests read the catalog at runtime to avoid hard-coding URLs that may evolve.
  const loadCatalogUrl = async (catalogId: string): Promise<string> => {
    const catalogJson = JSON.parse(
      await fs.readFile(path.join(__dirname, '../../../../resources/connector-catalog.json'), 'utf8')
    );
    const entry = catalogJson.connectors.find((c: { id: string }) => c.id === catalogId);
    if (!entry?.mcpConfig?.url) {
      throw new Error(`Catalog entry ${catalogId} missing mcpConfig.url`);
    }
    return entry.mcpConfig.url as string;
  };

  it('updates stale HTTP URL to match catalog when origin matches (Webflow beta → stable)', async () => {
    const catalogUrl = await loadCatalogUrl('webflow');
    // Sanity-check: the fix shipped the stable endpoint
    expect(catalogUrl).toBe('https://mcp.webflow.com/mcp');

    const config = {
      configPaths: [],
      mcpServers: {
        'Webflow-admin-acme-example': {
          type: 'http',
          url: 'https://mcp.webflow.com/beta/mcp',
          oauth: true,
          catalogId: 'webflow',
          email: '[external-email]',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileHttpUrls(configPath, tempDir);

    expect(result.updated).toBe(1);
    expect(result.backupPath).toBeTruthy();
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['Webflow-admin-acme-example'].url).toBe(catalogUrl);
    // Other config preserved
    expect(updated.mcpServers['Webflow-admin-acme-example'].oauth).toBe(true);
    expect(updated.mcpServers['Webflow-admin-acme-example'].email).toBe('[external-email]');
    expect(updated.mcpServers['Webflow-admin-acme-example'].type).toBe('http');
  });

  it('is idempotent — re-running on an already-fixed config is a no-op', async () => {
    const catalogUrl = await loadCatalogUrl('webflow');
    const config = {
      configPaths: [],
      mcpServers: {
        'Webflow-admin': {
          type: 'http',
          url: catalogUrl,
          catalogId: 'webflow',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileHttpUrls(configPath, tempDir);
    expect(result.updated).toBe(0);
    expect(result.backupPath).toBeNull();
  });

  it('skips entries without a catalogId (user-added custom servers)', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'CustomWebflow': {
          type: 'http',
          url: 'https://mcp.webflow.com/beta/mcp',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileHttpUrls(configPath, tempDir);
    expect(result.updated).toBe(0);
    const after = JSON.parse(await fs.readFile(configPath, 'utf8'));
    // User-customized URL preserved
    expect(after.mcpServers['CustomWebflow'].url).toBe('https://mcp.webflow.com/beta/mcp');
  });

  it('skips cross-origin URL changes (same-origin guard blocks malicious redirect)', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Webflow-admin': {
          type: 'http',
          // User's stored URL is on a totally different domain — never update
          // to a different origin even if the catalog moved domains.
          url: 'https://custom-proxy.example.com/mcp',
          catalogId: 'webflow',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileHttpUrls(configPath, tempDir);
    expect(result.updated).toBe(0);
    const after = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(after.mcpServers['Webflow-admin'].url).toBe('https://custom-proxy.example.com/mcp');
  });

  it('skips entries without a url (stdio/command-based servers)', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Xero-acme': {
          command: 'npx',
          args: ['-y', '@harrybloom18/xero-mcp-server@0.0.1'],
          catalogId: 'xero',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileHttpUrls(configPath, tempDir);
    expect(result.updated).toBe(0);
  });

  it('skips entries with malformed stored URL', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Webflow-admin': {
          type: 'http',
          url: 'not-a-valid-url',
          catalogId: 'webflow',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileHttpUrls(configPath, tempDir);
    expect(result.updated).toBe(0);
    const after = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(after.mcpServers['Webflow-admin'].url).toBe('not-a-valid-url');
  });

  it('refuses to modify configs outside userData directory', async () => {
    const outsidePath = path.join(os.tmpdir(), `outside-config-${Date.now()}.json`);
    const config = {
      configPaths: [],
      mcpServers: {
        'Webflow-admin': {
          type: 'http',
          url: 'https://mcp.webflow.com/beta/mcp',
          catalogId: 'webflow',
        },
      },
    };
    await fs.writeFile(outsidePath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileHttpUrls(outsidePath, tempDir);
    expect(result.updated).toBe(0);

    await fs.rm(outsidePath).catch(() => undefined);
  });

  it('refuses to modify non-router configs (missing configPaths)', async () => {
    const config = {
      mcpServers: {
        'Webflow-admin': {
          type: 'http',
          url: 'https://mcp.webflow.com/beta/mcp',
          catalogId: 'webflow',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileHttpUrls(configPath, tempDir);
    expect(result.updated).toBe(0);
  });

  it('updates multiple instances of the same catalog entry (multi-account)', async () => {
    const catalogUrl = await loadCatalogUrl('webflow');
    const config = {
      configPaths: [],
      mcpServers: {
        'Webflow-admin-site1': {
          type: 'http',
          url: 'https://mcp.webflow.com/beta/mcp',
          catalogId: 'webflow',
          email: '[external-email]',
        },
        'Webflow-admin-site2': {
          type: 'http',
          url: 'https://mcp.webflow.com/beta/mcp',
          catalogId: 'webflow',
          email: '[external-email]',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await reconcileHttpUrls(configPath, tempDir);
    expect(result.updated).toBe(2);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['Webflow-admin-site1'].url).toBe(catalogUrl);
    expect(updated.mcpServers['Webflow-admin-site2'].url).toBe(catalogUrl);
  });
});

describe('backfillCatalogIds — Microsoft entries', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-mcp-backfill-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  beforeEach(async () => {
    configPath = path.join(tempDir, `config-${Date.now()}.json`);
  });

  it('backfills static Microsoft365SharePoint with bundled-microsoft-sharepoint catalogId', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365SharePoint': {
          command: 'node',
          args: ['/path/to/sharepoint/server.cjs'],
          // No catalogId — should be backfilled
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await backfillCatalogIds(configPath, tempDir);

    expect(result.updated).toBe(1);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['Microsoft365SharePoint'].catalogId).toBe('bundled-microsoft-sharepoint');
  });

  it('backfills all 5 static Microsoft entries', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365Mail': { command: 'node', args: [] },
        'Microsoft365Calendar': { command: 'node', args: [] },
        'Microsoft365Files': { command: 'node', args: [] },
        'Microsoft365Teams': { command: 'node', args: [] },
        'Microsoft365SharePoint': { command: 'node', args: [] },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await backfillCatalogIds(configPath, tempDir);

    expect(result.updated).toBe(5);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['Microsoft365Mail'].catalogId).toBe('bundled-microsoft-mail');
    expect(updated.mcpServers['Microsoft365Calendar'].catalogId).toBe('bundled-microsoft-calendar');
    expect(updated.mcpServers['Microsoft365Files'].catalogId).toBe('bundled-microsoft-files');
    expect(updated.mcpServers['Microsoft365Teams'].catalogId).toBe('bundled-microsoft-teams');
    expect(updated.mcpServers['Microsoft365SharePoint'].catalogId).toBe('bundled-microsoft-sharepoint');
  });

  it('backfills instance-based Microsoft365Mail-user-outlook-com via prefix match', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365Mail-user-outlook-com': {
          command: 'node',
          args: ['/path/to/mail/server.cjs'],
          // No catalogId — should be backfilled via prefix
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await backfillCatalogIds(configPath, tempDir);

    expect(result.updated).toBe(1);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['Microsoft365Mail-user-outlook-com'].catalogId).toBe('bundled-microsoft-mail');
  });

  it('backfills instance-based Microsoft365SharePoint via prefix match', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365SharePoint-admin-corp-org': {
          command: 'node',
          args: ['/path/to/sharepoint/server.cjs'],
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await backfillCatalogIds(configPath, tempDir);

    expect(result.updated).toBe(1);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['Microsoft365SharePoint-admin-corp-org'].catalogId).toBe('bundled-microsoft-sharepoint');
  });

  it('skips entries that already have catalogId', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Microsoft365Mail': {
          command: 'node',
          args: [],
          catalogId: 'bundled-microsoft-mail', // Already set
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await backfillCatalogIds(configPath, tempDir);

    expect(result.updated).toBe(0);
  });

  it('backfills static Salesforce with bundled-salesforce catalogId', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Salesforce': {
          command: 'node',
          args: ['/path/to/salesforce/server.cjs'],
          // No catalogId — must be backfilled. Regression guard for REBEL-13Y:
          // before the fix this entry slipped past backfill, then was skipped
          // by migrateBundledConnectorsToNpx, leaving a stale node path that
          // failed every spawn with -32000 Connection closed.
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await backfillCatalogIds(configPath, tempDir);

    expect(result.updated).toBe(1);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['Salesforce'].catalogId).toBe('bundled-salesforce');
  });

  it('backfills instance-suffixed Salesforce-<email> via prefix match', async () => {
    const config = {
      configPaths: [],
      mcpServers: {
        'Salesforce-user-example-com': {
          command: 'node',
          args: ['/path/to/salesforce/server.cjs'],
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await backfillCatalogIds(configPath, tempDir);

    expect(result.updated).toBe(1);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(updated.mcpServers['Salesforce-user-example-com'].catalogId).toBe('bundled-salesforce');
  });
});
