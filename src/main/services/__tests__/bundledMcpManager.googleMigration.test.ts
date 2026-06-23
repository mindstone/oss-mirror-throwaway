import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const bundledMcpManagerLoggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
}));

vi.mock('@core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/logger')>();
  return {
    ...actual,
    createScopedLogger: () => bundledMcpManagerLoggerMock,
  };
});

import {
  buildGoogleWorkspaceInstancePayload,
  buildPayloadFromCatalog,
  configureBundledMcpManager,
  generateInstanceId,
  migrateBundledConnectorsToNpx,
  setConnectorCatalogPathOverride,
} from '../bundledMcpManager';
import { runMultiInstanceRebelOssMigrationFixture } from './multiInstanceMigrationFixture';

const GOOGLE_PACKAGE_SPEC = '@mindstone/mcp-server-google-workspace@0.1.3';

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
};

const readJson = async (filePath: string): Promise<Record<string, any>> => {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, any>;
};

describe('bundledMcpManager Google Workspace OSS migration', () => {
  let tempUserData: string;
  let tempResources: string;
  let catalogPath: string;

  const googleDataDir = (): string => path.join(tempUserData, 'google-workspace-mcp');

  const writeCatalog = async (): Promise<void> => {
    catalogPath = path.join(tempResources, 'connector-catalog.json');
    await writeJson(catalogPath, {
      connectors: [
        {
          id: 'bundled-google',
          name: 'Google Workspace',
          provider: 'rebel-oss',
          bundledConfig: {
            authType: 'oauth',
            settingsKey: 'googleWorkspace.enabled',
            serverName: 'GoogleWorkspace',
            setupToolName: 'authenticate_workspace_account',
            authApi: 'googleWorkspaceApi',
          },
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', GOOGLE_PACKAGE_SPEC],
            env: {
              MCP_MODE: 'stdio',
              LOG_MODE: 'strict',
            },
          },
        },
      ],
    });
    setConnectorCatalogPathOverride(catalogPath);
  };

  const writeConfig = async (
    name: string,
    servers: Record<string, Record<string, unknown>>,
    extras: Record<string, unknown> = {},
  ): Promise<string> => {
    const configPath = path.join(tempUserData, name);
    await writeJson(configPath, {
      mcpServers: servers,
      ...extras,
    });
    return configPath;
  };

  const writeGoogleAccount = async (instanceId: string, email: string): Promise<void> => {
    const instanceDir = path.join(googleDataDir(), instanceId);
    await writeJson(path.join(instanceDir, 'accounts.json'), {
      accounts: [{ email, category: 'personal', description: 'Connected via Rebel' }],
    });
    await writeJson(path.join(instanceDir, 'credentials', `${email.replace(/[^a-zA-Z0-9]/g, '-')}.token.json`), {
      access_token: 'fake-access-token',
      refresh_token: 'fake-refresh-token',
      token_type: 'Bearer',
      scope: 'email',
      expiry_date: Date.now() + 3600_000,
    });
  };

  const legacyEntry = (
    instanceId: string,
    email: string | undefined,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const instanceDir = path.join(googleDataDir(), instanceId);
    return {
      command: 'node',
      args: ['/legacy/google-workspace/server.cjs'],
      catalogId: 'bundled-google',
      description: email ? `${email} - Calendar, Drive, Gmail, Contacts` : 'Google Workspace',
      ...(email ? { email } : {}),
      env: {
        GOOGLE_CLIENT_ID: 'legacy-google-client-id',
        GOOGLE_CLIENT_SECRET: 'legacy-google-client-secret',
        ACCOUNTS_PATH: path.join(instanceDir, 'accounts.json'),
        CREDENTIALS_PATH: path.join(instanceDir, 'credentials'),
        MCP_MODE: 'stdio',
        LOG_MODE: 'strict',
        ENABLE_GOOGLE_TASKS_FORMS: 'true',
      },
      lastConnectedAt: 1712345678000,
      ...overrides,
    };
  };

  beforeEach(async () => {
    tempUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'google-migration-user-'));
    tempResources = await fs.mkdtemp(path.join(os.tmpdir(), 'google-migration-resources-'));
    configureBundledMcpManager({
      userDataDir: tempUserData,
      resourcesDir: tempResources,
      isPackaged: false,
    });
    await writeCatalog();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    setConnectorCatalogPathOverride(null);
    await fs.rm(tempUserData, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(tempResources, { recursive: true, force: true }).catch(() => undefined);
  });

  it('builds Google Workspace instance payloads from the published OSS catalog config', () => {
    const email = '[Mindstone-email]';
    const instanceId = generateInstanceId('GoogleWorkspace', email);
    const accountsPath = path.join(googleDataDir(), instanceId, 'accounts.json');
    const credentialsPath = path.join(googleDataDir(), instanceId, 'credentials');

    const payload = buildGoogleWorkspaceInstancePayload({
      instanceId,
      email,
      description: `${email} - Calendar, Drive, Gmail, Contacts access`,
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
      accountsPath,
      credentialsPath,
    });

    expect(payload).toMatchObject({
      name: instanceId,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', GOOGLE_PACKAGE_SPEC],
      description: `${email} - Calendar, Drive, Gmail, Contacts access`,
      catalogId: 'bundled-google',
      email,
      env: {
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
        ACCOUNTS_PATH: accountsPath,
        CREDENTIALS_PATH: credentialsPath,
        MCP_MODE: 'true',
        LOG_MODE: 'strict',
      },
    });
  });

  it('leaves a profile with zero Google accounts unchanged', async () => {
    const configPath = await writeConfig('zero.json', { filesystem: { command: 'node', args: ['server.js'] } });

    const result = await migrateBundledConnectorsToNpx(configPath);

    expect(result.migrated).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    const config = await readJson(configPath);
    expect(config.mcpServers.filesystem.command).toBe('node');
  });

  it('migrates one Google account to the same per-instance name', async () => {
    const email = '[Mindstone-email]';
    const instanceId = generateInstanceId('GoogleWorkspace', email);
    await writeGoogleAccount(instanceId, email);
    const configPath = await writeConfig('one.json', {
      [instanceId]: legacyEntry(instanceId, email),
    });

    const result = await migrateBundledConnectorsToNpx(configPath);

    expect(result.migrated).toEqual([{ catalogId: 'bundled-google', oldNames: [instanceId], newName: instanceId }]);
    const config = await readJson(configPath);
    const migrated = config.mcpServers[instanceId];
    expect(migrated.command).toBe('npx');
    expect(migrated.args).toEqual(['-y', GOOGLE_PACKAGE_SPEC]);
    expect(migrated.email).toBe(email);
    expect(migrated.env.GOOGLE_CLIENT_ID).toBe('legacy-google-client-id');
    expect(migrated.env.GOOGLE_CLIENT_SECRET).toBe('legacy-google-client-secret');
    expect(migrated.env.ENABLE_GOOGLE_TASKS_FORMS).toBe('true');
  });

  it('preserves all three live Google accounts as distinct per-account subprocess entries', async () => {
    const emails = ['[Mindstone-email]', '[external-email]', '[external-email]'];
    const servers: Record<string, Record<string, unknown>> = {};
    for (const email of emails) {
      const instanceId = generateInstanceId('GoogleWorkspace', email);
      await writeGoogleAccount(instanceId, email);
      servers[instanceId] = legacyEntry(instanceId, email);
    }
    const configPath = await writeConfig('three.json', servers);

    await runMultiInstanceRebelOssMigrationFixture({
      catalogId: 'bundled-google',
      configPath,
      expectedInstanceIds: emails.map((email) => generateInstanceId('GoogleWorkspace', email)),
      expectedArgs: ['-y', GOOGLE_PACKAGE_SPEC],
      migrate: migrateBundledConnectorsToNpx,
      readConfig: readJson,
      assertInstance: (instanceId, server) => {
        const email = emails.find((candidate) => generateInstanceId('GoogleWorkspace', candidate) === instanceId);
        expect(server.email).toBe(email);
      },
    });
  });

  it('continues migrating healthy accounts when one Google account fails mid-flight', async () => {
    const healthyEmails = ['[Mindstone-email]', '[external-email]'];
    const brokenEmail = '[external-email]';
    const servers: Record<string, Record<string, unknown>> = {};
    for (const email of [...healthyEmails, brokenEmail]) {
      const instanceId = generateInstanceId('GoogleWorkspace', email);
      await writeGoogleAccount(instanceId, email);
      servers[instanceId] = legacyEntry(instanceId, email, email === brokenEmail
        ? {
            env: {
              GOOGLE_CLIENT_ID: 'legacy-google-client-id',
              ACCOUNTS_PATH: path.join(googleDataDir(), instanceId, 'accounts.json'),
              CREDENTIALS_PATH: path.join(googleDataDir(), instanceId, 'credentials'),
            },
          }
        : {});
    }
    const configPath = await writeConfig('partial.json', servers);

    const result = await migrateBundledConnectorsToNpx(configPath);

    expect(result.migrated).toHaveLength(2);
    expect(result.skipped[0]?.reason).toMatch(/missing GOOGLE_CLIENT_SECRET/);
    const config = await readJson(configPath);
    for (const email of healthyEmails) {
      expect(config.mcpServers[generateInstanceId('GoogleWorkspace', email)].command).toBe('npx');
    }
    expect(config.mcpServers[generateInstanceId('GoogleWorkspace', brokenEmail)].command).toBe('node');
  });

  it('is idempotent on re-entry after a successful migration', async () => {
    const email = '[Mindstone-email]';
    const instanceId = generateInstanceId('GoogleWorkspace', email);
    await writeGoogleAccount(instanceId, email);
    const configPath = await writeConfig('idempotent.json', {
      [instanceId]: legacyEntry(instanceId, email),
    });

    await migrateBundledConnectorsToNpx(configPath);
    const second = await migrateBundledConnectorsToNpx(configPath);

    expect(second.migrated).toHaveLength(0);
    expect(second.skipped).toHaveLength(0);
    const config = await readJson(configPath);
    expect(Object.keys(config.mcpServers)).toEqual([instanceId]);
    expect(config.mcpServers[instanceId].command).toBe('npx');
  });

  it('handles special-character emails and cleans up old names when the slug normalises', async () => {
    const emails = ['[external-email]', 'Alice.Smith@example.com', 'nāme@example.com'];
    const servers: Record<string, Record<string, unknown>> = {};
    for (const email of emails) {
      const oldName = `GoogleWorkspace-legacy-${email.length}`;
      await writeGoogleAccount(oldName, email);
      servers[oldName] = legacyEntry(oldName, email);
    }
    const configPath = await writeConfig('special.json', servers, {
      userDisabledToolsByServer: {
        'GoogleWorkspace-legacy-23': ['search_workspace_emails'],
      },
      disabledServers: ['GoogleWorkspace-legacy-23'],
    });

    await migrateBundledConnectorsToNpx(configPath);

    const config = await readJson(configPath);
    for (const email of emails) {
      const newName = generateInstanceId('GoogleWorkspace', email);
      expect(config.mcpServers[newName].command).toBe('npx');
      expect(config.mcpServers[newName].email).toBe(email);
    }
    expect(Object.keys(config.mcpServers).some((name) => name.startsWith('GoogleWorkspace-legacy-'))).toBe(false);
  });

  it('logs security severity and skips colliding Google Workspace email slugs', async () => {
    const firstEmail = 'harry+test@example.com';
    const secondEmail = 'harry.test@example.com';
    const firstOldName = 'GoogleWorkspace-first-collision';
    const secondOldName = 'GoogleWorkspace-second-collision';
    await writeGoogleAccount(firstOldName, firstEmail);
    await writeGoogleAccount(secondOldName, secondEmail);
    const configPath = await writeConfig('collision.json', {
      [firstOldName]: legacyEntry(firstOldName, firstEmail),
      [secondOldName]: legacyEntry(secondOldName, secondEmail),
    });

    const result = await migrateBundledConnectorsToNpx(configPath);

    expect(result.migrated).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/collision/);
    expect(bundledMcpManagerLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'google.sanitiser_collision',
        severity: 'security',
        collidedSlug: generateInstanceId('GoogleWorkspace', firstEmail),
      }),
      expect.stringContaining('collision'),
    );
    const config = await readJson(configPath);
    expect(config.mcpServers[firstOldName].command).toBe('node');
    expect(config.mcpServers[secondOldName].command).toBe('node');
  });

  it('builds rebel-oss Google Workspace payloads with email-derived per-instance routing', async () => {
    const email = '[Mindstone-email]';
    const instanceId = generateInstanceId('GoogleWorkspace', email);
    const googleCatalogEntry = {
      id: 'bundled-google',
      name: 'Google Workspace',
      provider: 'rebel-oss',
      bundledConfig: {
        authType: 'oauth',
        settingsKey: 'googleWorkspace.enabled',
        serverName: 'GoogleWorkspace',
        setupToolName: 'authenticate_workspace_account',
        authApi: 'googleWorkspaceApi',
      },
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', GOOGLE_PACKAGE_SPEC],
        env: { MCP_MODE: 'stdio', LOG_MODE: 'strict' },
      },
    } as unknown as Parameters<typeof buildPayloadFromCatalog>[0];

    const payload = await buildPayloadFromCatalog(googleCatalogEntry, { email });

    expect(payload.name).toBe(instanceId);
    expect(payload.command).toBe('npx');
    expect(payload.args).toEqual(['-y', GOOGLE_PACKAGE_SPEC]);
    expect(payload.email).toBe(email);
    expect(payload.env?.ACCOUNTS_PATH).toBe(path.join(googleDataDir(), instanceId, 'accounts.json'));
    expect(payload.env?.CREDENTIALS_PATH).toBe(path.join(googleDataDir(), instanceId, 'credentials'));
  });

  it('fails fast instead of falling back to catalogEntry.name when Google Workspace email is missing', async () => {
    const googleCatalogEntry = {
      id: 'bundled-google',
      name: 'Google Workspace',
      provider: 'rebel-oss',
      bundledConfig: {
        authType: 'oauth',
        settingsKey: 'googleWorkspace.enabled',
        serverName: 'GoogleWorkspace',
        setupToolName: 'authenticate_workspace_account',
        authApi: 'googleWorkspaceApi',
      },
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', GOOGLE_PACKAGE_SPEC],
      },
    } as unknown as Parameters<typeof buildPayloadFromCatalog>[0];

    await expect(buildPayloadFromCatalog(googleCatalogEntry, {})).rejects.toThrow(/requires email/);
  });
});
