import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureBundledMcpManager } from '../bundledMcpManager';
import { backfillCatalogEnvForExistingServers } from '../catalogEnvBackfillMigration';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
}));

 
vi.mock('@core/logger', () => ({
  logger: loggerMock,
  createLogger: () => loggerMock,
  createScopedLogger: () => loggerMock,
  createTurnSessionLogger: () => loggerMock,
}));

describe('backfillCatalogEnvForExistingServers', () => {
  let tempUserData: string;
  let tempResources: string;
  let configPath: string;

  const catalogEntries = [
    {
      id: 'n8n-community',
      name: 'n8n (Community)',
      provider: 'community',
      mcpConfig: {
        command: 'npx',
        args: ['-y', 'n8n-mcp@2.51.3'],
        env: {
          MCP_MODE: 'stdio',
          LOG_LEVEL: 'error',
          DISABLE_CONSOLE_OUTPUT: 'true',
          N8N_MCP_TELEMETRY_DISABLED: 'true',
        },
        headers: {
          'X-N8N-Static': 'enabled',
        },
      },
    },
    {
      id: 'mongodb',
      name: 'MongoDB',
      provider: 'community',
      mcpConfig: {
        command: 'npx',
        args: ['-y', 'mongodb-mcp-server'],
        env: {
          MDB_MCP_READ_ONLY: 'true',
          MDB_MCP_TELEMETRY: 'disabled',
        },
      },
    },
    {
      id: 'basecamp',
      name: 'Basecamp',
      provider: 'community',
      mcpConfig: {
        command: 'npx',
        args: ['-y', 'basecamp-mcp'],
        env: {
          BASECAMP_REDIRECT_URI: 'http://localhost:8787/callback',
          BASECAMP_USER_AGENT: 'Rebel (basecamp-mcp)',
        },
      },
    },
    {
      id: 'bundled-gamma',
      name: 'Gamma',
      provider: 'rebel-oss',
      mcpConfig: {
        command: 'npx',
        args: ['-y', '@mindstone-engineering/gamma'],
        env: {
          GAMMA_API_KEY: '{{GAMMA_API_KEY}}',
          GAMMA_STATIC_MODE: 'safe',
        },
        headers: {
          Authorization: '{{GAMMA_AUTH_HEADER}}',
          'X-Gamma-Static': 'enabled',
        },
      },
    },
    {
      id: 'bundled-runway',
      name: 'Runway',
      provider: 'rebel-oss',
      mcpConfig: {
        command: 'npx',
        args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
        env: {
          MCP_HOST_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
          RUNWAY_ALLOWED_ROOT: '{{ALLOWED_ROOTS_ANCESTOR}}',
          RUNWAY_DOWNLOAD_ROOT: '{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}',
        },
      },
    },
  ];

  const writeCatalog = async (connectors: unknown[] = catalogEntries): Promise<void> => {
    await fs.writeFile(
      path.join(tempResources, 'connector-catalog.json'),
      JSON.stringify({ connectors }, null, 2),
      'utf8',
    );
  };

  const writeConfig = async (config: unknown): Promise<void> => {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  };

  const readConfig = async (): Promise<Record<string, unknown>> => {
    const raw = await fs.readFile(configPath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  };

  const listBackups = async (): Promise<string[]> => {
    const entries = await fs.readdir(path.dirname(configPath));
    return entries.filter((entry) => /^super-mcp-router\.json\.\d+\.bak$/.test(entry));
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tempUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-env-backfill-user-'));
    tempResources = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-env-backfill-resources-'));
    configPath = path.join(tempUserData, 'mcp', 'super-mcp-router.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeCatalog();
    configureBundledMcpManager({
      userDataDir: tempUserData,
      resourcesDir: tempResources,
      isPackaged: false,
    });
  });

  afterEach(async () => {
    await fs.rm(tempUserData, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(tempResources, { recursive: true, force: true }).catch(() => undefined);
  });

  it('adds missing n8n-community catalog env and header keys to an existing entry', async () => {
    await writeConfig({
      mcpServers: {
        'n8n (Community)-user-example-com': {
          command: 'npx',
          args: ['-y', 'n8n-mcp@2.51.3'],
          catalogId: 'n8n-community',
          env: {
            N8N_API_URL: 'https://n8n.example.test',
            N8N_API_KEY: 'secret',
          },
        },
      },
    });

    const result = await backfillCatalogEnvForExistingServers(configPath);

    expect(result).toEqual({
      repaired: [{
        serverName: 'n8n (Community)-user-example-com',
        catalogId: 'n8n-community',
        addedEnvKeys: ['MCP_MODE', 'LOG_LEVEL', 'DISABLE_CONSOLE_OUTPUT', 'N8N_MCP_TELEMETRY_DISABLED'],
        addedHeaderKeys: ['X-N8N-Static'],
      }],
      skipped: 0,
      errored: 0,
    });
    const config = await readConfig();
    const servers = config.mcpServers as Record<string, { env: Record<string, string>; headers: Record<string, string> }>;
    expect(servers['n8n (Community)-user-example-com'].env).toEqual({
      MCP_MODE: 'stdio',
      LOG_LEVEL: 'error',
      DISABLE_CONSOLE_OUTPUT: 'true',
      N8N_MCP_TELEMETRY_DISABLED: 'true',
      N8N_API_URL: 'https://n8n.example.test',
      N8N_API_KEY: 'secret',
    });
    expect(servers['n8n (Community)-user-example-com'].headers).toEqual({
      'X-N8N-Static': 'enabled',
    });
    expect(await listBackups()).toHaveLength(1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      {
        serverName: 'n8n (Community)-user-example-com',
        catalogId: 'n8n-community',
        addedEnvKeys: ['MCP_MODE', 'LOG_LEVEL', 'DISABLE_CONSOLE_OUTPUT', 'N8N_MCP_TELEMETRY_DISABLED'],
        addedHeaderKeys: ['X-N8N-Static'],
      },
      'Backfilled catalog static env on existing MCP entry',
    );
  });

  it('adds missing mongodb safety and telemetry catalog env keys to an existing entry', async () => {
    await writeConfig({
      mcpServers: {
        MongoDB: {
          command: 'npx',
          args: ['-y', 'mongodb-mcp-server'],
          catalogId: 'mongodb',
          env: {
            MDB_CONNECTION_STRING: 'mongodb://localhost:27017',
          },
        },
      },
    });

    const result = await backfillCatalogEnvForExistingServers(configPath);

    expect(result).toEqual({
      repaired: [{
        serverName: 'MongoDB',
        catalogId: 'mongodb',
        addedEnvKeys: ['MDB_MCP_READ_ONLY', 'MDB_MCP_TELEMETRY'],
        addedHeaderKeys: [],
      }],
      skipped: 0,
      errored: 0,
    });
    const config = await readConfig();
    const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(servers.MongoDB.env).toEqual({
      MDB_CONNECTION_STRING: 'mongodb://localhost:27017',
      MDB_MCP_READ_ONLY: 'true',
      MDB_MCP_TELEMETRY: 'disabled',
    });
  });

  it('adds missing basecamp redirect and user-agent catalog env keys to an existing entry', async () => {
    await writeConfig({
      mcpServers: {
        Basecamp: {
          command: 'npx',
          args: ['-y', 'basecamp-mcp'],
          catalogId: 'basecamp',
          env: {
            BASECAMP_ACCESS_TOKEN: 'token',
          },
        },
      },
    });

    const result = await backfillCatalogEnvForExistingServers(configPath);

    expect(result).toEqual({
      repaired: [{
        serverName: 'Basecamp',
        catalogId: 'basecamp',
        addedEnvKeys: ['BASECAMP_REDIRECT_URI', 'BASECAMP_USER_AGENT'],
        addedHeaderKeys: [],
      }],
      skipped: 0,
      errored: 0,
    });
    const config = await readConfig();
    const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(servers.Basecamp.env).toEqual({
      BASECAMP_ACCESS_TOKEN: 'token',
      BASECAMP_REDIRECT_URI: 'http://localhost:8787/callback',
      BASECAMP_USER_AGENT: 'Rebel (basecamp-mcp)',
    });
  });

  it('treats non-string existing catalog env values as missing and overwrites with catalog defaults', async () => {
    await writeConfig({
      mcpServers: {
        MongoDB: {
          command: 'npx',
          args: ['-y', 'mongodb-mcp-server'],
          catalogId: 'mongodb',
          env: {
            MDB_MCP_READ_ONLY: null,
            MDB_MCP_TELEMETRY: 'disabled',
          },
        },
      },
    });

    const result = await backfillCatalogEnvForExistingServers(configPath);

    expect(result.repaired).toEqual([{
      serverName: 'MongoDB',
      catalogId: 'mongodb',
      addedEnvKeys: ['MDB_MCP_READ_ONLY'],
      addedHeaderKeys: [],
    }]);
    const config = await readConfig();
    const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(servers.MongoDB.env).toEqual({
      MDB_MCP_READ_ONLY: 'true',
      MDB_MCP_TELEMETRY: 'disabled',
    });
  });

  it('no-ops when the existing entry already has all catalog static keys', async () => {
    const completeConfig = {
      mcpServers: {
        N8nComplete: {
          command: 'npx',
          args: ['-y', 'n8n-mcp@2.51.3'],
          catalogId: 'n8n-community',
          env: {
            MCP_MODE: 'stdio',
            LOG_LEVEL: 'error',
            DISABLE_CONSOLE_OUTPUT: 'true',
            N8N_MCP_TELEMETRY_DISABLED: 'true',
          },
          headers: {
            'X-N8N-Static': 'enabled',
          },
        },
      },
    };
    await writeConfig(completeConfig);

    const result = await backfillCatalogEnvForExistingServers(configPath);

    expect(result).toEqual({ repaired: [], skipped: 0, errored: 0 });
    expect(await readConfig()).toEqual(completeConfig);
    expect(await listBackups()).toHaveLength(0);
  });

  it('preserves user-customized catalog key values', async () => {
    await writeConfig({
      mcpServers: {
        N8nCustomized: {
          command: 'npx',
          args: ['-y', 'n8n-mcp@2.51.3'],
          catalogId: 'n8n-community',
          env: {
            LOG_LEVEL: 'debug',
          },
        },
      },
    });

    const result = await backfillCatalogEnvForExistingServers(configPath);

    expect(result.repaired).toHaveLength(1);
    const config = await readConfig();
    const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
    expect(servers.N8nCustomized.env).toEqual({
      MCP_MODE: 'stdio',
      LOG_LEVEL: 'debug',
      DISABLE_CONSOLE_OUTPUT: 'true',
      N8N_MCP_TELEMETRY_DISABLED: 'true',
    });
    expect(result.repaired[0].addedEnvKeys).toEqual([
      'MCP_MODE',
      'DISABLE_CONSOLE_OUTPUT',
      'N8N_MCP_TELEMETRY_DISABLED',
    ]);
  });

  it('skips entries without catalogId', async () => {
    const originalConfig = {
      mcpServers: {
        CustomServer: {
          command: 'node',
          args: ['server.js'],
          env: { CUSTOM_KEY: 'value' },
        },
      },
    };
    await writeConfig(originalConfig);

    const result = await backfillCatalogEnvForExistingServers(configPath);

    expect(result).toEqual({ repaired: [], skipped: 1, errored: 0 });
    expect(await readConfig()).toEqual(originalConfig);
    expect(await listBackups()).toHaveLength(0);
  });

  it('skips stale catalogId entries with a warning', async () => {
    const originalConfig = {
      mcpServers: {
        StaleCatalog: {
          command: 'npx',
          args: ['-y', 'stale'],
          catalogId: 'missing-catalog',
        },
      },
    };
    await writeConfig(originalConfig);

    const result = await backfillCatalogEnvForExistingServers(configPath);

    expect(result).toEqual({ repaired: [], skipped: 1, errored: 0 });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      { serverName: 'StaleCatalog', catalogId: 'missing-catalog' },
      'Catalog entry missing during catalog static env backfill',
    );
    expect(await readConfig()).toEqual(originalConfig);
  });

  it('filters placeholder env and header values for bundled entries', async () => {
    await writeConfig({
      mcpServers: {
        Gamma: {
          command: 'npx',
          args: ['-y', '@mindstone-engineering/gamma'],
          catalogId: 'bundled-gamma',
          env: {},
          headers: {},
        },
      },
    });

    const result = await backfillCatalogEnvForExistingServers(configPath);

    expect(result.repaired).toEqual([{
      serverName: 'Gamma',
      catalogId: 'bundled-gamma',
      addedEnvKeys: ['GAMMA_STATIC_MODE'],
      addedHeaderKeys: ['X-Gamma-Static'],
    }]);
    const config = await readConfig();
    const servers = config.mcpServers as Record<string, { env: Record<string, string>; headers: Record<string, string> }>;
    expect(servers.Gamma.env).toEqual({ GAMMA_STATIC_MODE: 'safe' });
    expect(servers.Gamma.env).not.toHaveProperty('GAMMA_API_KEY');
    expect(servers.Gamma.headers).toEqual({ 'X-Gamma-Static': 'enabled' });
    expect(servers.Gamma.headers).not.toHaveProperty('Authorization');
  });

  it('is idempotent when run twice in a row', async () => {
    await writeConfig({
      mcpServers: {
        N8nIdempotent: {
          command: 'npx',
          args: ['-y', 'n8n-mcp@2.51.3'],
          catalogId: 'n8n-community',
          env: {
            N8N_API_URL: 'https://n8n.example.test',
          },
        },
      },
    });

    const first = await backfillCatalogEnvForExistingServers(configPath);
    const configAfterFirst = await readConfig();
    const backupsAfterFirst = await listBackups();
    const second = await backfillCatalogEnvForExistingServers(configPath);

    expect(first.repaired).toHaveLength(1);
    expect(second).toEqual({ repaired: [], skipped: 0, errored: 0 });
    expect(await readConfig()).toEqual(configAfterFirst);
    expect(await listBackups()).toEqual(backupsAfterFirst);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Default-only sandbox env keys (DEFAULT_ONLY_SANDBOX_ENV_KEYS) — F-DA-1.
  // The placeholder-free pass above filters out catalog values containing
  // `{{...}}`, so existing already-npx / managed-install Runway entries never
  // got `RUNWAY_ALLOWED_ROOT` / `RUNWAY_DOWNLOAD_ROOT` and the spawn path
  // collapsed to tmpdir in a way that broke workspace access. The second
  // pass resolves those placeholders here and injects only when missing,
  // preserving any user override.
  // ─────────────────────────────────────────────────────────────────────────
  describe('default-only sandbox env keys (Runway)', () => {
    // The exact resolved ancestor depends on the local trust-root inputs
    // (workspace, ~/mcp-servers, rebel-system submodule, etc.) so most tests
    // assert *shape* — concrete absolute path with no leftover `{{...}}` —
    // and the DOWNLOAD_ROOT = ALLOWED_ROOT + 'runway-mcp' invariant. The
    // separate "settings adapter throws" test below pins the tmpdir
    // fallback path explicitly.
    const isPlaceholderFreeAbsolutePath = (value: unknown): boolean =>
      typeof value === 'string'
      && value.length > 0
      && !value.includes('{{')
      && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'));
    const expectedTmpDirAncestor = os.tmpdir();
    const expectedTmpDirDownloadRoot = path.join(os.tmpdir(), 'runway-mcp');

    it('backfills both sandbox env keys on an already-npx Runway entry', async () => {
      await writeConfig({
        mcpServers: {
          Runway: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
            catalogId: 'bundled-runway',
            env: {
              MCP_HOST_BRIDGE_STATE: '/tmp/bridge.json',
              RUNWAYML_API_SECRET: 'key_test',
            },
          },
        },
      });

      const result = await backfillCatalogEnvForExistingServers(configPath);

      expect(result.repaired).toHaveLength(1);
      const repair = result.repaired[0];
      expect(repair.serverName).toBe('Runway');
      expect(repair.catalogId).toBe('bundled-runway');
      expect(repair.addedEnvKeys).toEqual(['RUNWAY_ALLOWED_ROOT', 'RUNWAY_DOWNLOAD_ROOT']);
      expect(repair.addedHeaderKeys).toEqual([]);
      expect(repair.addedSandboxEnvKeys).toEqual(['RUNWAY_ALLOWED_ROOT', 'RUNWAY_DOWNLOAD_ROOT']);
      expect(repair.sandboxResolutionStatus).toBeDefined();

      const config = await readConfig();
      const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
      const allowedRoot = servers.Runway.env.RUNWAY_ALLOWED_ROOT;
      const downloadRoot = servers.Runway.env.RUNWAY_DOWNLOAD_ROOT;
      expect(isPlaceholderFreeAbsolutePath(allowedRoot)).toBe(true);
      expect(isPlaceholderFreeAbsolutePath(downloadRoot)).toBe(true);
      expect(downloadRoot).toBe(path.join(allowedRoot, 'runway-mcp'));
      expect(servers.Runway.env.RUNWAYML_API_SECRET).toBe('key_test');
      expect(servers.Runway.env.MCP_HOST_BRIDGE_STATE).toBe('/tmp/bridge.json');
    });

    it('backfills both sandbox env keys on a managed-install Runway entry', async () => {
      await writeConfig({
        mcpServers: {
          Runway: {
            command: 'node',
            args: ['/managed/installs/@mindstone/mcp-server-runway@0.3.2/dist/index.js'],
            catalogId: 'bundled-runway',
            env: {
              MCP_HOST_BRIDGE_STATE: '/tmp/bridge.json',
              RUNWAYML_API_SECRET: 'key_test',
            },
          },
        },
      });

      const result = await backfillCatalogEnvForExistingServers(configPath);

      expect(result.repaired).toHaveLength(1);
      const repair = result.repaired[0];
      expect(repair.addedEnvKeys).toEqual(['RUNWAY_ALLOWED_ROOT', 'RUNWAY_DOWNLOAD_ROOT']);
      expect(repair.addedSandboxEnvKeys).toEqual(['RUNWAY_ALLOWED_ROOT', 'RUNWAY_DOWNLOAD_ROOT']);

      const config = await readConfig();
      const servers = config.mcpServers as Record<string, { env: Record<string, string>; command: string; args: string[] }>;
      expect(servers.Runway.command).toBe('node');
      const allowedRoot = servers.Runway.env.RUNWAY_ALLOWED_ROOT;
      const downloadRoot = servers.Runway.env.RUNWAY_DOWNLOAD_ROOT;
      expect(isPlaceholderFreeAbsolutePath(allowedRoot)).toBe(true);
      expect(isPlaceholderFreeAbsolutePath(downloadRoot)).toBe(true);
      expect(downloadRoot).toBe(path.join(allowedRoot, 'runway-mcp'));
    });

    it('preserves a user-set RUNWAY_ALLOWED_ROOT override and only adds the missing RUNWAY_DOWNLOAD_ROOT', async () => {
      await writeConfig({
        mcpServers: {
          Runway: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
            catalogId: 'bundled-runway',
            env: {
              RUNWAY_ALLOWED_ROOT: '/custom/root',
              RUNWAYML_API_SECRET: 'key_test',
            },
          },
        },
      });

      const result = await backfillCatalogEnvForExistingServers(configPath);

      expect(result.repaired).toHaveLength(1);
      const repair = result.repaired[0];
      expect(repair.addedEnvKeys).toEqual(['RUNWAY_DOWNLOAD_ROOT']);
      expect(repair.addedSandboxEnvKeys).toEqual(['RUNWAY_DOWNLOAD_ROOT']);

      const config = await readConfig();
      const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
      expect(servers.Runway.env.RUNWAY_ALLOWED_ROOT).toBe('/custom/root');
      // RUNWAY_DOWNLOAD_ROOT comes from the catalog placeholder resolution,
      // NOT from the user override on RUNWAY_ALLOWED_ROOT — this matches the
      // spawn path semantics (catalog default-only keys are independent).
      expect(isPlaceholderFreeAbsolutePath(servers.Runway.env.RUNWAY_DOWNLOAD_ROOT)).toBe(true);
    });

    it('no-ops when both sandbox keys are already concretely set on the entry', async () => {
      const initial = {
        mcpServers: {
          Runway: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
            catalogId: 'bundled-runway',
            env: {
              RUNWAY_ALLOWED_ROOT: '/already/set',
              RUNWAY_DOWNLOAD_ROOT: '/already/set/downloads',
            },
          },
        },
      };
      await writeConfig(initial);

      const result = await backfillCatalogEnvForExistingServers(configPath);

      expect(result).toEqual({ repaired: [], skipped: 0, errored: 0 });
      expect(await readConfig()).toEqual(initial);
      expect(await listBackups()).toHaveLength(0);
    });

    // Whitespace-only strings count as "set" because `isExistingValid` only
    // checks that the value is a string. The migration is intentionally
    // conservative here: we never overwrite a string the user persisted, even
    // a whitespace one. If the user wants the catalog default they can blank
    // out the override or remove the key entirely.
    it('preserves a whitespace-only RUNWAY_ALLOWED_ROOT user value (treated as "set")', async () => {
      await writeConfig({
        mcpServers: {
          Runway: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
            catalogId: 'bundled-runway',
            env: {
              RUNWAY_ALLOWED_ROOT: '   ',
            },
          },
        },
      });

      const result = await backfillCatalogEnvForExistingServers(configPath);

      expect(result.repaired).toHaveLength(1);
      expect(result.repaired[0].addedEnvKeys).toEqual(['RUNWAY_DOWNLOAD_ROOT']);
      const config = await readConfig();
      const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
      expect(servers.Runway.env.RUNWAY_ALLOWED_ROOT).toBe('   ');
      expect(isPlaceholderFreeAbsolutePath(servers.Runway.env.RUNWAY_DOWNLOAD_ROOT)).toBe(true);
    });

    // Verifies the migration's resilience pathway: when settings/platform
    // access fails inside `resolveSandboxAncestor`, its top-level catch
    // returns `{ancestor: undefined, dcaStatus: 'fallback-tmpdir',
    // fallbackReason: 'helper-threw'}`, and the migration still produces
    // concrete tmpdir-based values rather than throwing.
    it('completes without exception when settings adapter throws (falls back to tmpdir)', async () => {
      const { setSettingsStoreAdapter } = await import('@core/services/settingsStore');
      const { DEFAULT_TEST_SETTINGS } = await import('../../../core/__tests__/builders/settingsBuilder');

      setSettingsStoreAdapter({
        getSettings: () => { throw new Error('settings store not initialized'); },
        updateSettings: () => { /* no-op */ },
        updateSettingsAtomic: () => { /* no-op */ },
      });

      try {
        await writeConfig({
          mcpServers: {
            Runway: {
              command: 'npx',
              args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
              catalogId: 'bundled-runway',
              env: {},
            },
          },
        });

        const result = await backfillCatalogEnvForExistingServers(configPath);

        expect(result.repaired).toHaveLength(1);
        const repair = result.repaired[0];
        expect(repair.addedSandboxEnvKeys).toEqual(['RUNWAY_ALLOWED_ROOT', 'RUNWAY_DOWNLOAD_ROOT']);
        expect(repair.sandboxResolutionStatus).toBe('fallback-tmpdir');
        expect(repair.sandboxResolutionFallbackReason).toBe('helper-threw');

        const config = await readConfig();
        const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
        expect(servers.Runway.env.RUNWAY_ALLOWED_ROOT).toBe(expectedTmpDirAncestor);
        expect(servers.Runway.env.RUNWAY_DOWNLOAD_ROOT).toBe(expectedTmpDirDownloadRoot);
      } finally {
        setSettingsStoreAdapter({
          getSettings: () => structuredClone(DEFAULT_TEST_SETTINGS),
          updateSettings: () => { /* no-op */ },
          updateSettingsAtomic: () => { /* no-op */ },
        });
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Stale-value scrub for default-only sandbox env keys — SF-7. Cloud
  // bootstrap opts in via `scrubStaleDefaultOnlyEnvKeys: true`. The bug
  // pattern: a desktop→cloud migration baked `/Users/<desktop_user>/...`
  // into the cloud config; on a Linux cloud machine those paths don't
  // exist, `realpathSync.native` throws, and we re-resolve via the
  // catalog placeholder. Plan: docs/plans/260520_runway_sandbox_central_trusted_roots.md.
  // ─────────────────────────────────────────────────────────────────────────
  describe('scrubStaleDefaultOnlyEnvKeys (cloud SF-7)', () => {
    const isPlaceholderFreeAbsolutePath = (value: unknown): boolean =>
      typeof value === 'string'
      && value.length > 0
      && !value.includes('{{')
      && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'));

    it('scrubs a stale RUNWAY_ALLOWED_ROOT desktop path and re-adds the resolved value, also scrubbing the paired RUNWAY_DOWNLOAD_ROOT', async () => {
      const stalePath = path.join(os.tmpdir(), 'rebel-stale-desktop-path-does-not-exist-' + Date.now());
      const stalePairedDownloadRoot = path.join(stalePath, 'runway-mcp');
      await writeConfig({
        mcpServers: {
          Runway: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
            catalogId: 'bundled-runway',
            env: {
              MCP_HOST_BRIDGE_STATE: '/tmp/bridge.json',
              RUNWAY_ALLOWED_ROOT: stalePath,
              RUNWAY_DOWNLOAD_ROOT: stalePairedDownloadRoot,
              RUNWAYML_API_SECRET: 'key_test',
            },
          },
        },
      });

      const result = await backfillCatalogEnvForExistingServers(configPath, {
        scrubStaleDefaultOnlyEnvKeys: true,
      });

      expect(result.repaired).toHaveLength(1);
      const repair = result.repaired[0];
      // Paired-key semantics: primary (RUNWAY_ALLOWED_ROOT) is realpath-checked
      // and stale; the paired key (RUNWAY_DOWNLOAD_ROOT) gets scrubbed alongside
      // even though it isn't probed independently. Both then get re-resolved
      // by the default-only sandbox env pass.
      expect(repair.scrubbedSandboxEnvKeys).toEqual(['RUNWAY_ALLOWED_ROOT', 'RUNWAY_DOWNLOAD_ROOT']);
      expect(repair.addedSandboxEnvKeys).toEqual(['RUNWAY_ALLOWED_ROOT', 'RUNWAY_DOWNLOAD_ROOT']);

      const config = await readConfig();
      const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
      const allowedRoot = servers.Runway.env.RUNWAY_ALLOWED_ROOT;
      const downloadRoot = servers.Runway.env.RUNWAY_DOWNLOAD_ROOT;
      expect(allowedRoot).not.toBe(stalePath);
      expect(downloadRoot).not.toBe(stalePairedDownloadRoot);
      expect(isPlaceholderFreeAbsolutePath(allowedRoot)).toBe(true);
      expect(isPlaceholderFreeAbsolutePath(downloadRoot)).toBe(true);
      expect(downloadRoot).toBe(path.join(allowedRoot, 'runway-mcp'));
      expect(servers.Runway.env.RUNWAYML_API_SECRET).toBe('key_test');
      expect(servers.Runway.env.MCP_HOST_BRIDGE_STATE).toBe('/tmp/bridge.json');
    });

    it('scrubs both RUNWAY_ALLOWED_ROOT and an independently-stale RUNWAY_DOWNLOAD_ROOT when primary is stale', async () => {
      // Both primary and paired carry desktop paths from an old migration,
      // and the paired path is NOT a subdirectory of the primary (i.e. would
      // also fail an independent realpath probe). Verifies paired-key
      // scrubbing fires regardless of how the paired value was set.
      const stalePrimary = path.join(os.tmpdir(), 'rebel-stale-primary-' + Date.now());
      const stalePaired = path.join(os.tmpdir(), 'rebel-stale-paired-elsewhere-' + Date.now());
      await writeConfig({
        mcpServers: {
          Runway: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
            catalogId: 'bundled-runway',
            env: {
              RUNWAY_ALLOWED_ROOT: stalePrimary,
              RUNWAY_DOWNLOAD_ROOT: stalePaired,
            },
          },
        },
      });

      const result = await backfillCatalogEnvForExistingServers(configPath, {
        scrubStaleDefaultOnlyEnvKeys: true,
      });

      expect(result.repaired).toHaveLength(1);
      const repair = result.repaired[0];
      expect(repair.scrubbedSandboxEnvKeys).toEqual(['RUNWAY_ALLOWED_ROOT', 'RUNWAY_DOWNLOAD_ROOT']);
      expect(repair.addedSandboxEnvKeys).toEqual(['RUNWAY_ALLOWED_ROOT', 'RUNWAY_DOWNLOAD_ROOT']);

      const config = await readConfig();
      const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
      expect(servers.Runway.env.RUNWAY_ALLOWED_ROOT).not.toBe(stalePrimary);
      expect(servers.Runway.env.RUNWAY_DOWNLOAD_ROOT).not.toBe(stalePaired);
      expect(isPlaceholderFreeAbsolutePath(servers.Runway.env.RUNWAY_ALLOWED_ROOT)).toBe(true);
      expect(isPlaceholderFreeAbsolutePath(servers.Runway.env.RUNWAY_DOWNLOAD_ROOT)).toBe(true);
    });

    it('is idempotent when primary RUNWAY_ALLOWED_ROOT resolves and paired RUNWAY_DOWNLOAD_ROOT points at a not-yet-created subdirectory', async () => {
      // Replays the exact post-boot-backfill state: primary points at a
      // realpath-able ancestor, paired points at `<ancestor>/runway-mcp`
      // which the runtime creates lazily on first use. Without paired-key
      // semantics, the previous detector would mark RUNWAY_DOWNLOAD_ROOT
      // stale on every boot and trigger a scrub→re-add loop.
      const validPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-paired-key-idempotent-'));
      const pairedSubdir = path.join(validPath, 'runway-mcp');
      try {
        await writeConfig({
          mcpServers: {
            Runway: {
              command: 'npx',
              args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
              catalogId: 'bundled-runway',
              env: {
                RUNWAY_ALLOWED_ROOT: validPath,
                RUNWAY_DOWNLOAD_ROOT: pairedSubdir,
              },
            },
          },
        });

        const result = await backfillCatalogEnvForExistingServers(configPath, {
          scrubStaleDefaultOnlyEnvKeys: true,
        });

        expect(result).toEqual({ repaired: [], skipped: 0, errored: 0 });
        const config = await readConfig();
        const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
        expect(servers.Runway.env.RUNWAY_ALLOWED_ROOT).toBe(validPath);
        expect(servers.Runway.env.RUNWAY_DOWNLOAD_ROOT).toBe(pairedSubdir);
        expect(await listBackups()).toHaveLength(0);
      } finally {
        await fs.rm(validPath, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    it('preserves a RUNWAY_ALLOWED_ROOT that resolves successfully on this machine', async () => {
      const validPath = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-valid-allowed-root-'));
      try {
        await writeConfig({
          mcpServers: {
            Runway: {
              command: 'npx',
              args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
              catalogId: 'bundled-runway',
              env: {
                RUNWAY_ALLOWED_ROOT: validPath,
              },
            },
          },
        });

        const result = await backfillCatalogEnvForExistingServers(configPath, {
          scrubStaleDefaultOnlyEnvKeys: true,
        });

        expect(result.repaired).toHaveLength(1);
        const repair = result.repaired[0];
        expect(repair.scrubbedSandboxEnvKeys).toBeUndefined();
        expect(repair.addedEnvKeys).toEqual(['RUNWAY_DOWNLOAD_ROOT']);
        const config = await readConfig();
        const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
        expect(servers.Runway.env.RUNWAY_ALLOWED_ROOT).toBe(validPath);
        expect(isPlaceholderFreeAbsolutePath(servers.Runway.env.RUNWAY_DOWNLOAD_ROOT)).toBe(true);
      } finally {
        await fs.rm(validPath, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    it('does not scrub when the option is off (desktop default behaviour)', async () => {
      const stalePath = '/Users/desktop_user/Workspace/Core';
      await writeConfig({
        mcpServers: {
          Runway: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
            catalogId: 'bundled-runway',
            env: {
              RUNWAY_ALLOWED_ROOT: stalePath,
              RUNWAY_DOWNLOAD_ROOT: path.join(stalePath, 'runway-mcp'),
            },
          },
        },
      });

      const result = await backfillCatalogEnvForExistingServers(configPath);

      expect(result.repaired).toEqual([]);
      const config = await readConfig();
      const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
      expect(servers.Runway.env.RUNWAY_ALLOWED_ROOT).toBe(stalePath);
    });

    it('does not treat unresolved placeholder values as stale (no scrub, no rewrite)', async () => {
      // Pre-existing placeholder strings count as "set" via `mergeMissingStaticKeys`;
      // the scrub pass also skips them (we only scrub concrete-but-unreachable
      // values). Net effect: the entry stays as-is. The cloud surface relies on
      // the scrub pass to deal with stale concrete values, not unresolved
      // placeholders left over from upstream tooling bugs.
      const initial = {
        mcpServers: {
          Runway: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
            catalogId: 'bundled-runway',
            env: {
              RUNWAY_ALLOWED_ROOT: '{{ALLOWED_ROOTS_ANCESTOR}}',
              RUNWAY_DOWNLOAD_ROOT: '{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}',
            },
          },
        },
      };
      await writeConfig(initial);

      const result = await backfillCatalogEnvForExistingServers(configPath, {
        scrubStaleDefaultOnlyEnvKeys: true,
      });

      expect(result).toEqual({ repaired: [], skipped: 0, errored: 0 });
      expect(await readConfig()).toEqual(initial);
    });
  });
});
