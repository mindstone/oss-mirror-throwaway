import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AppSettings } from '@shared/types';
import { DEFAULT_VOICE_ACTIVATION_HOTKEY, DEFAULT_VOICE_ACTIVATION_VOICE_MODE } from '@shared/types';
import { OFFICE_MCP_PACKAGE_SPEC } from '@shared/sidecar/officePackage';
import * as hubspotTelemetry from '../hubspotTelemetry';
import {
  __resetManagedMcpInstallSingletonForTesting,
  configureManagedMcpInstallService,
} from '../managedMcpInstallServiceInstance';
import { runMultiInstanceRebelOssMigrationFixture } from './multiInstanceMigrationFixture';

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
  configureBundledMcpManager,
  buildSplitRebelInboxPayload,
  buildBundledMcpPayload,
  buildBundledHttpMcpPayload,
  buildPayloadFromCatalog,
  findRebelOssConnectorsUsingProviderKey,
  writeRebelBridgeState,
  migrateLegacyWrapperSettingsIfNeeded,
  extractManagedWrapperMetadata,
  migrateRebelSearchToRebelSearchAndConversations,
  migrateBundledConnectorsToNpx,
  pruneStaleHubSpotRefreshEnv,
  resolveEnvPlaceholders,
  mergePreservedUserEnv,
  repairBridgeStatePathLiterals,
  isBundledMcp,
  rewriteManagedMcpEntriesToNpxForCloud,
} from '../bundledMcpManager';

const TEST_HUBSPOT_TELEMETRY_SALT_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const baseSettings: AppSettings = {
  coreDirectory: null,
  mcpConfigFile: null,
  onboardingCompleted: false,
  userEmail: null,
  onboardingFirstCompletedAt: null,
  voice: {
    provider: 'openai-whisper',
    openaiApiKey: null,
    elevenlabsApiKey: null,
    model: 'gpt-4o-mini-transcribe-2025-12-15',
    ttsVoice: null,
    activationHotkey: DEFAULT_VOICE_ACTIVATION_HOTKEY,
    activationHotkeyVoiceMode: DEFAULT_VOICE_ACTIVATION_VOICE_MODE
  },
  models: {
    apiKey: 'test',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-5',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: true,
    extendedContext: true,
    thinkingEffort: 'high'
  },
  diagnostics: {
    debugBreadcrumbsUntil: null
  }
};

describe('bundledMcpManager', () => {
  let tempUserData: string;
  let tempResources: string;
  let sourceConfig: string;

  const writeHubSpotAccountsForHostScopeLookup = async (accounts: unknown[]): Promise<void> => {
    const hostAccountsPath = path.join('/tmp/test-user-data', 'mcp', 'hubspot', 'accounts.json');
    await fs.mkdir(path.dirname(hostAccountsPath), { recursive: true });
    await fs.writeFile(hostAccountsPath, JSON.stringify({ accounts }, null, 2), 'utf8');
  };

  beforeAll(async () => {
    tempUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-wrapper-user-'));
    tempResources = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-wrapper-resources-'));
    vi.spyOn(hubspotTelemetry, 'getTelemetrySaltHex').mockResolvedValue(TEST_HUBSPOT_TELEMETRY_SALT_HEX);
    const serverDir = path.join(tempResources, 'mcp', 'rebel-inbox');
    await fs.mkdir(serverDir, { recursive: true });
    const serverPath = path.join(serverDir, 'server.cjs');
    await fs.writeFile(serverPath, "#!/usr/bin/env node\nconsole.error('stub server');", 'utf8');

    configureBundledMcpManager({
      userDataDir: tempUserData,
      resourcesDir: tempResources,
      isPackaged: false
    });

    sourceConfig = path.join(tempUserData, 'user.json');
    await fs.writeFile(
      sourceConfig,
      JSON.stringify(
        {
          mcpServers: {
            filesystem: {
              command: 'node',
              args: ['server.js']
            }
          }
        },
        null,
        2
      ),
      'utf8'
    );
  });

  afterAll(async () => {
    await fs.rm(tempUserData, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(tempResources, { recursive: true, force: true }).catch(() => undefined);
  });

  it('builds a RebelInbox payload with static env', () => {
    const payload = buildSplitRebelInboxPayload();
    expect(payload.name).toBe('RebelInbox');
    expect(payload.transport).toBe('stdio');
    expect(payload.env?.MCP_HOST_BRIDGE_STATE).toBeDefined();
    expect(payload.env?.MCP_HOST_BRIDGE_STATE).toContain(path.join('mcp', 'rebel-inbox-bridge.json'));
  });

  it('builds a bundled HTTP payload without Authorization headers', () => {
    const payload = buildBundledHttpMcpPayload('OpenAIImageGeneration', {
      url: 'http://127.0.0.1:9123/',
      catalogId: 'openai-image-generation',
    });

    expect(payload).toMatchObject({
      name: 'OpenAIImageGeneration',
      transport: 'http',
      type: 'http',
      url: 'http://127.0.0.1:9123/',
      description: '',
      catalogId: 'openai-image-generation',
    });
    expect(payload.headers?.Authorization).toBeUndefined();
  });

  it('writes both new and legacy bridge-state env keys on rebel-* payloads', () => {
    // Bundled rebel-*/server.cjs scripts still read MINDSTONE_REBEL_BRIDGE_STATE.
    // Until those readers are updated, every spawn payload must carry both names
    // pointing to the same path. See bridgeStateEnv() in bundledMcpManager.ts.
    const payload = buildSplitRebelInboxPayload();
    const newKey = payload.env?.MCP_HOST_BRIDGE_STATE;
    const legacyKey = payload.env?.MINDSTONE_REBEL_BRIDGE_STATE;
    expect(newKey).toBeDefined();
    expect(legacyKey).toBeDefined();
    expect(legacyKey).toBe(newKey);
  });

  it('writes bridge state file', async () => {
    await writeRebelBridgeState({ port: 4321, token: 'test-token' });
    const statePath = path.join(tempUserData, 'mcp', 'rebel-inbox-bridge.json');
    const raw = await fs.readFile(statePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({ port: 4321, token: 'test-token' });
  });

  it('migrates legacy wrapper configs back to the source file', async () => {
    const wrapperPath = path.join(tempUserData, 'mcp', 'wrappers', 'wrapper-legacy.json');
    await fs.mkdir(path.dirname(wrapperPath), { recursive: true });
    const legacyWrapper = {
      superMcpVersion: '1.0',
      managedBy: 'mindstone-rebel',
      managedWrapper: {
        version: 1,
        sourcePath: sourceConfig,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      configPaths: [sourceConfig],
      mcpServers: {
        RebelTaskQueue: {
          command: 'node',
          args: ['legacy-server.mjs']
        }
      }
    };
    await fs.writeFile(wrapperPath, JSON.stringify(legacyWrapper, null, 2), 'utf8');

    const migrated = await migrateLegacyWrapperSettingsIfNeeded({
      ...baseSettings,
      mcpConfigFile: wrapperPath
    });

    expect(migrated.mcpConfigFile).toBe(sourceConfig);
    const updatedSourceRaw = await fs.readFile(sourceConfig, 'utf8');
    const updatedSource = JSON.parse(updatedSourceRaw);
    expect(updatedSource.mcpServers).toHaveProperty('RebelInternal');

    const metadata = extractManagedWrapperMetadata(legacyWrapper);
    expect(metadata?.sourcePath).toBe(sourceConfig);
  });

  describe('migrateRebelSearchToRebelSearchAndConversations', () => {
    it('migrates internal RebelSearch entry and associated config', async () => {
      // Create a config file with legacy internal RebelSearch
      const legacyConfigPath = path.join(tempUserData, 'legacy-search-config.json');
      const legacyConfig = {
        mcpServers: {
          RebelSearch: {
            command: 'node',
            args: ['/path/to/resources/mcp/rebel-search/server.cjs'],
            transport: 'stdio'
          },
          OtherServer: {
            command: 'node',
            args: ['other-server.js']
          }
        },
        userDisabledToolsByServer: {
          RebelSearch: ['rebel_search_files', 'rebel_search_sources'],
          OtherServer: ['some_tool']
        },
        disabledServers: ['RebelSearch', 'SomeOther']
      };
      await fs.writeFile(legacyConfigPath, JSON.stringify(legacyConfig, null, 2), 'utf8');

      // Run migration
      const result = await migrateRebelSearchToRebelSearchAndConversations(legacyConfigPath);

      // Verify result
      expect(result.removedRebelSearch).toBe(true);
      expect(result.migratedTools).toBe(2);
      expect(result.updatedDisabledServers).toBe(true);

      // Read and verify migrated config
      const migratedRaw = await fs.readFile(legacyConfigPath, 'utf8');
      const migrated = JSON.parse(migratedRaw);

      // RebelSearch should be removed from mcpServers
      expect(migrated.mcpServers.RebelSearch).toBeUndefined();
      expect(migrated.mcpServers.OtherServer).toBeDefined();

      // Tools should be migrated to RebelSearchAndConversations
      expect(migrated.userDisabledToolsByServer.RebelSearch).toBeUndefined();
      expect(migrated.userDisabledToolsByServer.RebelSearchAndConversations).toEqual(
        expect.arrayContaining(['rebel_search_files', 'rebel_search_sources'])
      )!;
      expect(migrated.userDisabledToolsByServer.OtherServer).toEqual(['some_tool']);

      // disabledServers should have RebelSearchAndConversations instead of RebelSearch
      expect(migrated.disabledServers).not.toContain('RebelSearch');
      expect(migrated.disabledServers).toContain('RebelSearchAndConversations');
      expect(migrated.disabledServers).toContain('SomeOther');
    });

    it('does NOT remove non-internal RebelSearch entries (user-defined)', async () => {
      // Create a config file with user-defined RebelSearch (args not matching /mcp/rebel-search/)
      const userConfigPath = path.join(tempUserData, 'user-defined-search-config.json');
      const userConfig = {
        mcpServers: {
          RebelSearch: {
            command: 'python',
            args: ['/home/user/my-custom-search/server.py'],
            transport: 'stdio'
          }
        },
        userDisabledToolsByServer: {
          RebelSearch: ['custom_tool']
        }
      };
      await fs.writeFile(userConfigPath, JSON.stringify(userConfig, null, 2), 'utf8');

      // Run migration
      const result = await migrateRebelSearchToRebelSearchAndConversations(userConfigPath);

      // Verify NO changes for non-internal entry - migration is completely gated
      expect(result.removedRebelSearch).toBe(false);
      expect(result.migratedTools).toBe(0);
      expect(result.updatedDisabledServers).toBe(false);

      // Read and verify config is unchanged
      const migratedRaw = await fs.readFile(userConfigPath, 'utf8');
      const migrated = JSON.parse(migratedRaw);

      // User's custom RebelSearch server should still be there
      expect(migrated.mcpServers.RebelSearch).toBeDefined();
      expect(migrated.mcpServers.RebelSearch.command).toBe('python');

      // userDisabledToolsByServer should remain under RebelSearch (NOT migrated)
      expect(migrated.userDisabledToolsByServer.RebelSearch).toEqual(['custom_tool']);
      // RebelSearchAndConversations key should NOT be created
      expect(migrated.userDisabledToolsByServer.RebelSearchAndConversations).toBeUndefined();
    });

    it('handles Windows-style paths with backslashes', async () => {
      // Create a config file with Windows-style path
      const windowsConfigPath = path.join(tempUserData, 'windows-search-config.json');
      const windowsConfig = {
        mcpServers: {
          RebelSearch: {
            command: 'node',
            args: ['C:\\Program Files\\rebel-app\\resources\\mcp\\rebel-search\\server.cjs'],
            transport: 'stdio'
          }
        }
      };
      await fs.writeFile(windowsConfigPath, JSON.stringify(windowsConfig, null, 2), 'utf8');

      // Run migration
      const result = await migrateRebelSearchToRebelSearchAndConversations(windowsConfigPath);

      // Should detect and remove the internal entry
      expect(result.removedRebelSearch).toBe(true);

      // Verify removal
      const migratedRaw = await fs.readFile(windowsConfigPath, 'utf8');
      const migrated = JSON.parse(migratedRaw);
      expect(migrated.mcpServers.RebelSearch).toBeUndefined();
    });

    it('is idempotent - running twice has no effect', async () => {
      // Create a config file
      const idempotentConfigPath = path.join(tempUserData, 'idempotent-config.json');
      const config = {
        mcpServers: {
          RebelSearch: {
            command: 'node',
            args: ['/resources/mcp/rebel-search/server.cjs']
          }
        },
        disabledServers: ['RebelSearch']
      };
      await fs.writeFile(idempotentConfigPath, JSON.stringify(config, null, 2), 'utf8');

      // Run migration first time
      const result1 = await migrateRebelSearchToRebelSearchAndConversations(idempotentConfigPath);
      expect(result1.removedRebelSearch).toBe(true);
      expect(result1.updatedDisabledServers).toBe(true);

      // Read state after first migration
      const afterFirst = await fs.readFile(idempotentConfigPath, 'utf8');

      // Run migration second time
      const result2 = await migrateRebelSearchToRebelSearchAndConversations(idempotentConfigPath);
      expect(result2.removedRebelSearch).toBe(false);
      expect(result2.migratedTools).toBe(0);
      expect(result2.updatedDisabledServers).toBe(false);

      // Config should be unchanged
      const afterSecond = await fs.readFile(idempotentConfigPath, 'utf8');
      expect(afterSecond).toBe(afterFirst);
    });
  });

  describe('buildBundledMcpPayload IBKR static env override', () => {
    it('uses defaults when no credentials provided', async () => {
      const payload = await buildBundledMcpPayload('IBKR', {});

      expect(payload.name).toBe('IBKR');
      expect(payload.env?.IBKR_HOST).toBe('127.0.0.1');
      expect(payload.env?.IBKR_PORT).toBe('4002');
      expect(payload.env?.IBKR_CLIENT_ID).toBe('1');
      expect(payload.env?.IBKR_MODE).toBe('paper');
      expect(payload.env?.MCP_HOST_BRIDGE_STATE).toBeDefined();
      // Catalog-driven payloads with needsBridgeState must also write the
      // legacy key for bundled OSS bridges that still read it (see bridgeStateEnv()).
      expect(payload.env?.MINDSTONE_REBEL_BRIDGE_STATE).toBeDefined();
      expect(payload.env?.MINDSTONE_REBEL_BRIDGE_STATE).toBe(payload.env?.MCP_HOST_BRIDGE_STATE);
    });

    it('overrides staticEnv with matching credentials', async () => {
      const payload = await buildBundledMcpPayload('IBKR', {
        credentials: {
          host: '192.168.1.100',
          port: '4001',
          clientId: '5',
          mode: 'live',
        },
      });

      expect(payload.env?.IBKR_HOST).toBe('192.168.1.100');
      expect(payload.env?.IBKR_PORT).toBe('4001');
      expect(payload.env?.IBKR_CLIENT_ID).toBe('5');
      expect(payload.env?.IBKR_MODE).toBe('live');
    });

    it('partially overrides staticEnv (only provided credentials)', async () => {
      const payload = await buildBundledMcpPayload('IBKR', {
        credentials: {
          port: '7497',
          clientId: '3',
        },
      });

      expect(payload.env?.IBKR_HOST).toBe('127.0.0.1');
      expect(payload.env?.IBKR_PORT).toBe('7497');
      expect(payload.env?.IBKR_CLIENT_ID).toBe('3');
      expect(payload.env?.IBKR_MODE).toBe('paper');
    });

    it('trims whitespace from credential values', async () => {
      const payload = await buildBundledMcpPayload('IBKR', {
        credentials: {
          host: '  10.0.0.1  \n',
          port: ' 4001 ',
        },
      });

      expect(payload.env?.IBKR_HOST).toBe('10.0.0.1');
      expect(payload.env?.IBKR_PORT).toBe('4001');
    });

    it('ignores empty credential values (keeps defaults)', async () => {
      const payload = await buildBundledMcpPayload('IBKR', {
        credentials: {
          host: '',
          port: '  ',
          clientId: '2',
        },
      });

      expect(payload.env?.IBKR_HOST).toBe('127.0.0.1');
      expect(payload.env?.IBKR_PORT).toBe('4002');
      expect(payload.env?.IBKR_CLIENT_ID).toBe('2');
    });

    it('has correct catalogId', async () => {
      const payload = await buildBundledMcpPayload('IBKR', {});
      expect(payload.catalogId).toBe('bundled-ibkr');
    });
  });

  describe('migrated connectors excluded from BUNDLED_MCP_CATALOG', () => {
    const MIGRATED_CONNECTOR_NAMES = [
      'Fathom',
      'Humaans',
      'PandaDoc',
      'TalentLMS',
      'QuickBooks',
      'ServiceNow',
      'Mixmax',
      'Gamma',
      'Napkin',
      'Kling',
      'Runway',
      'Freshdesk',
      'ElevenLabs',
      'NanoBanana',
      'EmailImap',
      'HubSpot',
      'Workday',
      'RebelOffice',
      'Slack',
      'ReplitSSH',
    ];

    it.each(MIGRATED_CONNECTOR_NAMES)(
      '%s is not in BUNDLED_MCP_CATALOG',
      (name) => {
        expect(isBundledMcp(name)).toBe(false);
      }
    );

    it('none of the migrated connectors are bundled', () => {
      const bundled = MIGRATED_CONNECTOR_NAMES.filter(isBundledMcp);
      expect(bundled).toEqual([]);
    });
  });

  describe('bundled-runway sandbox env resolution', () => {
    it('builds Runway with resolved sandbox roots (no literal {{...}})', async () => {
      const payload = await buildPayloadFromCatalog(
        {
          id: 'bundled-runway',
          name: 'Runway ML',
          provider: 'rebel-oss',
          bundledConfig: {
            authType: 'api-key',
            serverName: 'Runway',
          },
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
            env: {
              RUNWAY_ALLOWED_ROOT: '{{ALLOWED_ROOTS_ANCESTOR}}',
              RUNWAY_DOWNLOAD_ROOT: '{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}',
            },
          },
          setupFields: [{ id: 'apiKey', envVar: 'RUNWAYML_API_SECRET' }],
        },
        { setupFields: { apiKey: 'fake-secret' } },
      )!;

      expect(payload.env?.RUNWAY_ALLOWED_ROOT).toBeDefined();
      expect(payload.env?.RUNWAY_DOWNLOAD_ROOT).toBeDefined();
      expect(payload.env?.RUNWAY_ALLOWED_ROOT).not.toMatch(/\{\{/);
      expect(payload.env?.RUNWAY_DOWNLOAD_ROOT).not.toMatch(/\{\{/);
      expect(payload.env?.RUNWAY_DOWNLOAD_ROOT).toContain('runway-mcp');
      expect(payload.env?.RUNWAYML_API_SECRET).toBe('fake-secret');
    });
  });

  describe('bundled-replit-ssh rebel-oss payload regression', () => {
    it('builds bundled-replit-ssh as a pinned npx payload', async () => {
      const payload = await buildPayloadFromCatalog(
        {
          id: 'bundled-replit-ssh',
          name: 'Replit',
          provider: 'rebel-oss',
          bundledConfig: {
            authType: 'none',
            serverName: 'ReplitSSH',
          },
          mcpConfig: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-replit-ssh@0.1.2'],
          },
        },
        {},
      )!;

      expect(payload.name).toBe('Replit');
      expect(payload.catalogId).toBe('bundled-replit-ssh');
      expect(payload.command).toBe('npx');
      expect(payload.args).toEqual(['-y', '@mindstone/mcp-server-replit-ssh@0.1.2']);
      expect(payload.env).toBeNull();
    });
  });

  describe('subdomain/instance normalization', () => {
    it('normalizes BambooHR company subdomain from full host', async () => {
      const payload = await buildPayloadFromCatalog(
        {
          id: 'bamboohr',
          name: 'BambooHR',
          provider: 'community',
          mcpConfig: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
          },
          setupFields: [{ id: 'companyDomain', envVar: 'BAMBOOHR_COMPANY_DOMAIN' }],
        },
        {
          setupFields: { companyDomain: 'https://acme.bamboohr.com' },
        }
      )!;

      expect(payload.env?.BAMBOOHR_COMPANY_DOMAIN).toBe('acme');
    });
  });

  describe('accountIdentityEnvVar wiring', () => {
    // Regression guard for Email IMAP connectors (and any future connector
    // where the account-identity email is captured via the shared Account
    // Email input rather than a setupField). The upstream package reads
    // EMAIL_IMAP_EMAIL from env; without this wire the subprocess has no
    // email to authenticate with.
    it('maps options.email into env when bundledConfig.accountIdentityEnvVar is set', async () => {
      const payload = await buildPayloadFromCatalog(
        {
          id: 'bundled-icloud-mail',
          name: 'iCloud Mail',
          provider: 'rebel-oss',
          bundledConfig: {
            authType: 'api-key',
            serverName: 'EmailImap',
            accountIdentityEnvVar: 'EMAIL_IMAP_EMAIL',
          },
          mcpConfig: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: { EMAIL_IMAP_PROVIDER: 'icloud' },
          },
          setupFields: [{ id: 'password', envVar: 'EMAIL_IMAP_PASSWORD' }],
        },
        {
          email: '  [external-email]  ',
          setupFields: { password: 'app-specific-pw' },
        }
      )!;

      expect(payload.env?.EMAIL_IMAP_EMAIL).toBe('[external-email]');
      expect(payload.env?.EMAIL_IMAP_PASSWORD).toBe('app-specific-pw');
      expect(payload.env?.EMAIL_IMAP_PROVIDER).toBe('icloud');
    });

    it('does not set env var when accountIdentityEnvVar is absent', async () => {
      const payload = await buildPayloadFromCatalog(
        {
          id: 'bundled-fathom',
          name: 'Fathom',
          provider: 'rebel-oss',
          bundledConfig: { authType: 'api-key', serverName: 'Fathom' },
          mcpConfig: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
          },
          setupFields: [{ id: 'apiKey', envVar: 'FATHOM_API_KEY' }],
        },
        {
          email: '[external-email]',
          setupFields: { apiKey: 'secret' },
        }
      )!;

      expect(payload.env?.EMAIL_IMAP_EMAIL).toBeUndefined();
    });

    it('does not set env var when email is missing', async () => {
      const payload = await buildPayloadFromCatalog(
        {
          id: 'bundled-icloud-mail',
          name: 'iCloud Mail',
          provider: 'rebel-oss',
          bundledConfig: {
            authType: 'api-key',
            serverName: 'EmailImap',
            accountIdentityEnvVar: 'EMAIL_IMAP_EMAIL',
          },
          mcpConfig: { transport: 'stdio', command: 'node', args: ['server.js'] },
          setupFields: [{ id: 'password', envVar: 'EMAIL_IMAP_PASSWORD' }],
        },
        {
          setupFields: { password: 'app-specific-pw' },
        }
      )!;

      expect(payload.env?.EMAIL_IMAP_EMAIL).toBeUndefined();
    });

    it('builds Microsoft Office as a rebel-oss payload while preserving sidecar state wiring', async () => {
      const payload = await buildPayloadFromCatalog(
        {
          id: 'bundled-office',
          name: 'Microsoft Office',
          provider: 'rebel-oss',
          bundledConfig: {
            authType: 'none',
            serverName: 'RebelOffice',
          },
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', OFFICE_MCP_PACKAGE_SPEC],
            env: {
              MCP_OFFICE_SIDECAR_STATE: '{{MCP_CONFIG_DIR}}/sidecar-state.json',
            },
          },
        },
        {},
      )!;

      expect(payload.name).toBe('RebelOffice');
      expect(payload.catalogId).toBe('bundled-office');
      expect(payload.command).toBe('npx');
      expect(payload.args).toEqual(['-y', OFFICE_MCP_PACKAGE_SPEC]);
      expect(payload.env?.MCP_OFFICE_SIDECAR_STATE).toBe(
        path.join(tempUserData, 'mcp', 'rebeloffice', 'sidecar-state.json'),
      );
    });

    it('uses stored HubSpot scope tier for rebel-oss payload construction when account email is present', async () => {
      await writeHubSpotAccountsForHostScopeLookup([
        { email: 'hubspot@example.com', hubId: 1, scopeTier: 'full' },
      ]);

      const payload = await buildPayloadFromCatalog(
        {
          id: 'bundled-hubspot',
          name: 'HubSpot',
          provider: 'rebel-oss',
          bundledConfig: {
            authType: 'oauth',
            serverName: 'HubSpot',
          },
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'],
            env: {
              HUBSPOT_CONFIG_DIR: '{{MCP_CONFIG_DIR}}',
            },
          },
          setupFields: [
            { id: 'scopeTier' },
          ],
        },
        {
          email: 'hubspot@example.com',
          setupFields: { scopeTier: 'readonly' },
        },
      );

      expect(payload.env?.HUBSPOT_SCOPE_TIER).toBe('full');
      expect(payload.env?.HUBSPOT_TELEMETRY_SALT).toBe(TEST_HUBSPOT_TELEMETRY_SALT_HEX);
    });

    it('falls back to provided HubSpot scopeTier when account email is unavailable', async () => {
      const payload = await buildPayloadFromCatalog(
        {
          id: 'bundled-hubspot',
          name: 'HubSpot',
          provider: 'rebel-oss',
          bundledConfig: {
            authType: 'oauth',
            serverName: 'HubSpot',
          },
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'],
            env: {
              HUBSPOT_CONFIG_DIR: '{{MCP_CONFIG_DIR}}',
            },
          },
          setupFields: [
            { id: 'scopeTier' },
          ],
        },
        {
          setupFields: { scopeTier: 'readonly' },
        },
      );

      expect(payload.env?.HUBSPOT_SCOPE_TIER).toBe('readonly');
      expect(payload.env?.HUBSPOT_TELEMETRY_SALT).toBe(TEST_HUBSPOT_TELEMETRY_SALT_HEX);
    });

    it('injects HUBSPOT_CONFIG_DIR / DISABLE_REFRESH / SOURCE_LABEL / ACCOUNT_EMAIL for rebel-oss HubSpot payloads', async () => {
      // Regression for runtime failure 2026-05-14 (rebel://conversation/e38e168c):
      // After catalog flip, the catalog-spawn path was missing the HubSpot env
      // vars the OSS package needs to locate accounts.json + credentials.
      // Result: list_hubspot_accounts returned "No HubSpot accounts connected"
      // even though OAuth had succeeded. The catalog-spawn path must mirror
      // discoverHubSpot in bundledMcpCloudRegistration.ts.
      await writeHubSpotAccountsForHostScopeLookup([
        { email: 'hubspot@example.com', hubId: 1, scopeTier: 'full' },
      ]);

      const payload = await buildPayloadFromCatalog(
        {
          id: 'bundled-hubspot',
          name: 'HubSpot',
          provider: 'rebel-oss',
          bundledConfig: {
            authType: 'oauth',
            serverName: 'HubSpot',
          },
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'],
            env: { LOG_MODE: 'strict' },
          },
        },
        { email: 'hubspot@example.com' },
      );

      expect(payload.env?.HUBSPOT_CONFIG_DIR).toBe(
        path.join(tempUserData, 'mcp', 'hubspot'),
      );
      // 260517 fix: desktop is the refresh authority — DISABLE_REFRESH must NOT
      // be injected on the desktop catalog-spawn path. The cloud-discovery path
      // still injects it (see bundledMcpCloudRegistration.discoverHubSpot).
      expect(payload.env?.HUBSPOT_DISABLE_REFRESH).toBeUndefined();
      expect(payload.env?.HUBSPOT_ALLOW_CLOUD_REFRESH).toBeUndefined();
      expect(payload.env?.HUBSPOT_SOURCE_LABEL).toBe('Mindstone Rebel');
      expect(payload.env?.HUBSPOT_ACCOUNT_EMAIL).toBe('hubspot@example.com');
      expect(payload.env?.LOG_MODE).toBe('strict');
    });

    it('uses options.scopeTier as fallback when first-time OAuth registration runs before accounts.json exists', async () => {
      // Regression for runtime failure 2026-05-14 (rebel://conversation/b5ac8ae4):
      // After catalog flip to provider: rebel-oss, the IPC handler called
      // buildPayloadFromCatalog with an email but no account yet in accounts.json
      // (OAuth flow writes the account AFTER MCP registration). getStoredScopeTier
      // correctly throws ACCOUNT_NOT_FOUND, but the call site previously only
      // threaded providedFields.scopeTier (which is empty for HubSpot — scopeTier
      // is a top-level IPC param, not a setupField) as the fallback, so the
      // throw propagated to the renderer and blocked the connect click.
      const payload = await buildPayloadFromCatalog(
        {
          id: 'bundled-hubspot',
          name: 'HubSpot',
          provider: 'rebel-oss',
          bundledConfig: {
            authType: 'oauth',
            serverName: 'HubSpot',
          },
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'],
            env: {
              HUBSPOT_CONFIG_DIR: '{{MCP_CONFIG_DIR}}',
            },
          },
        },
        {
          email: 'unauthenticated@example.com',
          scopeTier: 'readonly',
        },
      );

      expect(payload.env?.HUBSPOT_SCOPE_TIER).toBe('readonly');
      expect(payload.env?.HUBSPOT_TELEMETRY_SALT).toBe(TEST_HUBSPOT_TELEMETRY_SALT_HEX);
    });
  });

  describe('buildPayloadFromCatalog providerKeyMapping resolver', () => {
    const createOpenAiImageCatalogEntry = (
      overrides?: Partial<{
        bundledConfig: {
          authType?: string;
          serverName?: string;
          providerKeyMapping?: Record<string, 'openai'>;
        };
        mcpConfig: {
          transport?: string;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
        };
        setupFields: Array<{ id: string; envVar?: string }>;
      }>,
    ) => ({
      id: 'openai-image-generation',
      name: 'OpenAIImageGeneration',
      provider: 'rebel-oss',
      bundledConfig: {
        authType: 'none',
        serverName: 'OpenAIImageGeneration',
        providerKeyMapping: { OPENAI_API_KEY: 'openai' as const },
        ...(overrides?.bundledConfig ?? {}),
      },
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone-engineering/mcp-server-openai-image@0.1.0'],
        env: {
          OPENAI_API_KEY: '{{OPENAI_API_KEY}}',
          MCP_WORKSPACE_PATH: '{{MCP_BASE_DIR}}/workspace',
        },
        ...(overrides?.mcpConfig ?? {}),
      },
      setupFields: overrides?.setupFields ?? [],
    });

    it('resolves provider key mapping on first connect when key is configured', async () => {
      const payload = await buildPayloadFromCatalog(
        createOpenAiImageCatalogEntry(),
        {
          providerKeys: { openai: 'fake-first-connect' } as AppSettings['providerKeys'],
        },
      );

      expect(payload.env?.OPENAI_API_KEY).toBe('fake-first-connect');
    });

    it('writes an empty string when provider key is missing on first connect', async () => {
      const payload = await buildPayloadFromCatalog(
        createOpenAiImageCatalogEntry(),
        {
          providerKeys: { openai: null } as AppSettings['providerKeys'],
        },
      );

      expect(payload.env?.OPENAI_API_KEY).toBe('');
    });

    it('is idempotent across reconnects with the same key', async () => {
      const entry = createOpenAiImageCatalogEntry();
      const first = await buildPayloadFromCatalog(entry, {
        providerKeys: { openai: 'fake-same-key' } as AppSettings['providerKeys'],
      });
      const second = await buildPayloadFromCatalog(entry, {
        providerKeys: { openai: 'fake-same-key' } as AppSettings['providerKeys'],
      });

      expect(first.env?.OPENAI_API_KEY).toBe('fake-same-key');
      expect(second.env?.OPENAI_API_KEY).toBe('fake-same-key');
      expect(second.env?.OPENAI_API_KEY).toBe(first.env?.OPENAI_API_KEY);
    });

    it('uses the latest key value on reconnect after key rotation', async () => {
      const entry = createOpenAiImageCatalogEntry();
      const beforeRotation = await buildPayloadFromCatalog(entry, {
        providerKeys: { openai: 'fake-old' } as AppSettings['providerKeys'],
      });
      const afterRotation = await buildPayloadFromCatalog(entry, {
        providerKeys: { openai: 'fake-new' } as AppSettings['providerKeys'],
      });

      expect(beforeRotation.env?.OPENAI_API_KEY).toBe('fake-old');
      expect(afterRotation.env?.OPENAI_API_KEY).toBe('fake-new');
    });

    it('trims whitespace from mapped provider keys', async () => {
      const payload = await buildPayloadFromCatalog(
        createOpenAiImageCatalogEntry(),
        {
          providerKeys: { openai: '  fake-trimmed  ' } as AppSettings['providerKeys'],
        },
      );

      expect(payload.env?.OPENAI_API_KEY).toBe('fake-trimmed');
    });

    it('preserves setup-field credentials over provider key mapping', async () => {
      const payload = await buildPayloadFromCatalog(
        createOpenAiImageCatalogEntry({
          setupFields: [{ id: 'apiKey', envVar: 'OPENAI_API_KEY' }],
        }),
        {
          setupFields: { apiKey: 'fake-user-entered' },
          providerKeys: { openai: 'fake-provider' } as AppSettings['providerKeys'],
        },
      );

      expect(payload.env?.OPENAI_API_KEY).toBe('fake-user-entered');
    });

    it('does not mutate env values for connectors without providerKeyMapping', async () => {
      const payload = await buildPayloadFromCatalog(
        createOpenAiImageCatalogEntry({
          bundledConfig: {
            providerKeyMapping: undefined,
          },
        }),
        {
          providerKeys: { openai: 'fake-ignored' } as AppSettings['providerKeys'],
        },
      );

      expect(payload.env?.OPENAI_API_KEY).toBe('{{OPENAI_API_KEY}}');
    });

    it('preserves user literal values that contain braces but are not exact placeholders', async () => {
      const payload = await buildPayloadFromCatalog(
        createOpenAiImageCatalogEntry({
          mcpConfig: {
            env: { OPENAI_API_KEY: '{{OPENAI_API_KEY-EXTRA}}' },
          },
        }),
        {
          providerKeys: { openai: 'fake-provider' } as AppSettings['providerKeys'],
        },
      );

      expect(payload.env?.OPENAI_API_KEY).toBe('{{OPENAI_API_KEY-EXTRA}}');
    });
  });

  describe('findRebelOssConnectorsUsingProviderKey', () => {
    it('returns registered rebel-oss connector entries whose mapping references the provider key', async () => {
      const matches = await findRebelOssConnectorsUsingProviderKey(
        'openai',
        {
          OpenAIImageGeneration: { catalogId: 'openai-image-generation' },
          Gamma: { catalogId: 'bundled-gamma' },
          GoogleWorkspace: { catalogId: 'bundled-google' },
        },
        [
          {
            id: 'openai-image-generation',
            provider: 'rebel-oss',
            bundledConfig: { providerKeyMapping: { OPENAI_API_KEY: 'openai' } },
          },
          {
            id: 'bundled-gamma',
            provider: 'rebel-oss',
            bundledConfig: { providerKeyMapping: { OPENAI_API_KEY: 'openai' } },
          },
          {
            id: 'bundled-google',
            provider: 'rebel-oss',
            bundledConfig: { providerKeyMapping: { GEMINI_API_KEY: 'google' } },
          },
        ],
      );

      expect(matches).toEqual([
        expect.objectContaining({ serverName: 'OpenAIImageGeneration', catalogId: 'openai-image-generation' }),
        expect.objectContaining({ serverName: 'Gamma', catalogId: 'bundled-gamma' }),
      ]);
    });

    it('does not return connectors whose catalog provider is not rebel-oss', async () => {
      const matches = await findRebelOssConnectorsUsingProviderKey(
        'openai',
        {
          OpenAIImageGeneration: { catalogId: 'openai-image-generation' },
        },
        [
          {
            id: 'openai-image-generation',
            provider: 'bundled',
            bundledConfig: { providerKeyMapping: { OPENAI_API_KEY: 'openai' } },
          },
        ],
      );

      expect(matches).toEqual([]);
    });

    it('returns an empty array when no connector matches the provider key mapping', async () => {
      const matches = await findRebelOssConnectorsUsingProviderKey(
        'openai',
        {
          NanoBanana: { catalogId: 'bundled-nano-banana' },
        },
        [
          {
            id: 'bundled-nano-banana',
            provider: 'rebel-oss',
            bundledConfig: { providerKeyMapping: { GEMINI_API_KEY: 'google' } },
          },
        ],
      );

      expect(matches).toEqual([]);
    });

    it('handles provider mappings that use non-standard env var names', async () => {
      const matches = await findRebelOssConnectorsUsingProviderKey(
        'openai',
        {
          CustomConnector: { catalogId: 'bundled-custom' },
        },
        [
          {
            id: 'bundled-custom',
            provider: 'rebel-oss',
            bundledConfig: { providerKeyMapping: { CUSTOM_TOKEN: 'openai' } },
          },
        ],
      );

      expect(matches).toEqual([
        expect.objectContaining({ serverName: 'CustomConnector', catalogId: 'bundled-custom' }),
      ]);
    });
  });

  describe('OpenAIImageGeneration catalog registration (FOX-3264)', () => {
    it('isBundledMcp recognises OpenAIImageGeneration so the connect IPC accepts it', () => {
      expect(isBundledMcp('OpenAIImageGeneration')).toBe(true);
    });

    // Two follow-on tests removed when `openai-image-generation` was migrated
    // from `provider: bundled` (with out-of-band HTTP registration via
    // ensureOpenAIImageMcpRegistration) to `provider: rebel-oss` (npx via
    // generic buildPayloadFromCatalog rebel_oss branch). The FOX-3264
    // class-of-bug they guarded against is now structurally impossible — the
    // catalog flip removed the dual-registration surface that originally
    // motivated the null-payload special case.
  });

  describe('Mixpanel catalog registration (FOX-3135)', () => {
    // Stage 2 regression coverage per docs/plans/260515_mixpanel_mcp.md.
    // Ensures the 4 Mixpanel setupFields map to MIXPANEL_REGION / MIXPANEL_PROJECT_ID /
    // MIXPANEL_USERNAME / MIXPANEL_SECRET in the built payload, and that all three
    // registries (catalog id, BUNDLED_MCP_CATALOG entry, BUNDLED_SERVER_TO_CATALOG_ID
    // mapping) agree.
    it('isBundledMcp recognises Mixpanel so the connect IPC accepts it', () => {
      expect(isBundledMcp('Mixpanel')).toBe(true);
    });

    it('buildPayloadFromCatalog maps Mixpanel setupFields to the expected env vars', async () => {
      const catalogEntry = {
        id: 'bundled-mixpanel',
        name: 'Mixpanel',
        provider: 'bundled',
        bundledConfig: { serverName: 'Mixpanel', authType: 'api-key' },
      };

      const payload = await buildPayloadFromCatalog(catalogEntry, {
        setupFields: {
          region: 'eu',
          projectId: '3179321',
          username: 'rebel.mp-service-account',
          secret: 'super-secret-value',
        },
      });

      expect(payload).not.toBeNull();
      expect(payload?.env?.MIXPANEL_REGION).toBe('eu');
      expect(payload?.env?.MIXPANEL_PROJECT_ID).toBe('3179321');
      expect(payload?.env?.MIXPANEL_USERNAME).toBe('rebel.mp-service-account');
      expect(payload?.env?.MIXPANEL_SECRET).toBe('super-secret-value');
      expect(payload?.catalogId).toBe('bundled-mixpanel');
    });

    it('builds a Mixpanel payload directly via buildBundledMcpPayload with credentials', async () => {
      const payload = await buildBundledMcpPayload('Mixpanel', {
        credentials: {
          region: 'us',
          projectId: '42',
          username: 'u',
          secret: 's',
        },
      });
      expect(payload.env?.MIXPANEL_REGION).toBe('us');
      expect(payload.env?.MIXPANEL_PROJECT_ID).toBe('42');
      expect(payload.env?.MIXPANEL_USERNAME).toBe('u');
      expect(payload.env?.MIXPANEL_SECRET).toBe('s');
      expect(payload.catalogId).toBe('bundled-mixpanel');
      expect(payload.transport).toBe('stdio');
      expect(payload.command).toBe('node');
    });

    it('three-way catalog id parity: connector-catalog.json id === BUNDLED_MCP_CATALOG.Mixpanel.catalogId === BUNDLED_SERVER_TO_CATALOG_ID.Mixpanel', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const catalogPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../resources/connector-catalog.json',
      );
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
        connectors: Array<{ id: string; bundledConfig?: { serverName?: string } }>;
      };
      const mixpanelEntry = catalog.connectors.find((c) => c.id === 'bundled-mixpanel');
      expect(mixpanelEntry, 'connector-catalog.json must have a "bundled-mixpanel" entry').toBeTruthy();
      expect(mixpanelEntry?.bundledConfig?.serverName).toBe('Mixpanel');

      // Backfill mapping must agree (DL-13 + Completeness specialist note in plan).
      const mcpConfigManagerPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../core/services/mcpConfigManager.ts',
      );
      const mcpConfigManagerSource = readFileSync(mcpConfigManagerPath, 'utf8');
      expect(
        mcpConfigManagerSource,
        'BUNDLED_SERVER_TO_CATALOG_ID must map "Mixpanel" → "bundled-mixpanel" so backfillCatalogIds() resolves legacy router entries.',
      ).toMatch(/'Mixpanel':\s*'bundled-mixpanel'/);
    });
  });

  describe('catalog parity guardrail (FOX-3264 class-of-bug)', () => {
    // Every non-internal provider:'bundled' entry in connector-catalog.json must
    // either be in BUNDLED_MCP_CATALOG (so isBundledMcp() returns true and the
    // settings:mcp-add-bundled-server IPC handler accepts the connect click) OR
    // be an explicitly allow-listed exception that has its own connect plumbing.
    // The Discourse trio uses --profile file auth and is special-cased earlier
    // in settingsHandlers.ts via DISCOURSE_CUSTOM_SERVERS, before the
    // isSelfConfiguringMcp guard runs.
    const BUNDLED_CATALOG_PARITY_EXCEPTIONS = new Set<string>([
      'discourse',
      'rebels-community-write',
      'rebels-community',
      // HubSpot is intentionally in the Stage-5 transitional state: the
      // production catalog stays bundled until publish, while startup
      // migration can convert existing entries through the rebel-oss catalog
      // override path with host-side HubSpot env injection.
      'bundled-hubspot',
    ]);

    it('every non-internal bundled catalog entry has a matching BUNDLED_MCP_CATALOG registration', async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const catalogPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../resources/connector-catalog.json',
      );
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
        connectors: Array<{
          id: string;
          provider: string;
          isInternal?: boolean;
          bundledConfig?: { serverName?: string };
        }>;
      };

      const stranded: string[] = [];
      for (const entry of catalog.connectors) {
        if (entry.provider !== 'bundled') continue;
        if (entry.isInternal === true) continue;
        if (BUNDLED_CATALOG_PARITY_EXCEPTIONS.has(entry.id)) continue;
        const serverName = entry.bundledConfig?.serverName;
        if (!serverName) {
          stranded.push(`${entry.id} (missing bundledConfig.serverName)`);
          continue;
        }
        if (!isBundledMcp(serverName)) {
          stranded.push(`${entry.id} → serverName "${serverName}" not in BUNDLED_MCP_CATALOG`);
        }
      }

      expect(
        stranded,
        'Bundled catalog entries with no BUNDLED_MCP_CATALOG registration cannot be connected from the UI ' +
          '(settings:mcp-add-bundled-server throws "Unknown bundled server"). Either add the server to ' +
          'BUNDLED_MCP_CATALOG in bundledMcpManager.ts, mark it isInternal:true if it should not be user-visible, ' +
          'or add it to BUNDLED_CATALOG_PARITY_EXCEPTIONS with the special-case wiring it relies on.',
      ).toEqual([]);
    });
  });

  describe('resolveEnvPlaceholders', () => {
    it('resolves {{MCP_CONFIG_DIR}} and {{MCP_BASE_DIR}} placeholders', () => {
      const env = {
        CONFIG_PATH: '{{MCP_CONFIG_DIR}}/config.json',
        BRIDGE_STATE: '{{MCP_BASE_DIR}}/rebel-inbox-bridge.json',
        LOG_MODE: 'strict',
      };
      const result = resolveEnvPlaceholders(env, '/data/mcp/zendesk', '/data/mcp', {});
      expect(result).toEqual({
        CONFIG_PATH: '/data/mcp/zendesk/config.json',
        BRIDGE_STATE: '/data/mcp/rebel-inbox-bridge.json',
        LOG_MODE: 'strict',
      });
    });

    it('resolves {{BRIDGE_STATE_PATH}} via bridgeStatePath()', () => {
      const result = resolveEnvPlaceholders(
        { MCP_HOST_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}' },
        '/dir',
        '/base',
        {},
      );

      expect(result.MCP_HOST_BRIDGE_STATE).toBe(path.join(tempUserData, 'mcp', 'rebel-inbox-bridge.json'));
    });

    it('co-resolves all three placeholders independently in one value', () => {
      const result = resolveEnvPlaceholders(
        { COMBINED: '{{MCP_CONFIG_DIR}}/x;{{MCP_BASE_DIR}}/y;{{BRIDGE_STATE_PATH}}' },
        '/data/mcp/runway',
        '/data/mcp',
        {},
      );

      expect(result.COMBINED).toBe(
        `/data/mcp/runway/x;/data/mcp/y;${path.join(tempUserData, 'mcp', 'rebel-inbox-bridge.json')}`,
      );
    });

    it('handles env with no placeholders', () => {
      const env = { KEY: 'value', OTHER: 'plain' };
      const result = resolveEnvPlaceholders(env, '/dir', '/base', {});
      expect(result).toEqual({ KEY: 'value', OTHER: 'plain' });
    });

    it('handles empty env', () => {
      expect(resolveEnvPlaceholders({}, '/dir', '/base', {})).toEqual({});
    });

    it('resolves {{ALLOWED_ROOTS_ANCESTOR}} to the supplied ancestor', () => {
      const result = resolveEnvPlaceholders(
        { RUNWAY_ALLOWED_ROOT: '{{ALLOWED_ROOTS_ANCESTOR}}' },
        '/dir',
        '/base',
        { ancestor: '/Users/foo' },
      );
      expect(result.RUNWAY_ALLOWED_ROOT).toBe('/Users/foo');
    });

    it('resolves {{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}} via path.join with default subdir', () => {
      const result = resolveEnvPlaceholders(
        { RUNWAY_DOWNLOAD_ROOT: '{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}' },
        '/dir',
        '/base',
        { ancestor: '/Users/foo' },
      );
      expect(result.RUNWAY_DOWNLOAD_ROOT).toBe(path.join('/Users/foo', 'runway-mcp'));
    });

    it('falls back to os.tmpdir() when ancestor is undefined', () => {
      const result = resolveEnvPlaceholders(
        {
          ALLOWED: '{{ALLOWED_ROOTS_ANCESTOR}}',
          DOWNLOADS: '{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}',
        },
        '/dir',
        '/base',
        {},
      );
      expect(result.ALLOWED).toBe(os.tmpdir());
      expect(result.DOWNLOADS).toBe(path.join(os.tmpdir(), 'runway-mcp'));
    });

    it('is idempotent on repeat calls when no placeholders remain', () => {
      const first = resolveEnvPlaceholders(
        { RUNWAY_ALLOWED_ROOT: '{{ALLOWED_ROOTS_ANCESTOR}}' },
        '/dir',
        '/base',
        { ancestor: '/Users/foo' },
      );
      const second = resolveEnvPlaceholders(first, '/dir', '/base', { ancestor: '/Users/bar' });
      expect(second).toEqual(first);
    });

    it('does not partially clobber {{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}} via the ANCESTOR pattern', () => {
      const result = resolveEnvPlaceholders(
        {
          ANCESTOR: '{{ALLOWED_ROOTS_ANCESTOR}}',
          DOWNLOADS: '{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}',
        },
        '/dir',
        '/base',
        { ancestor: '/Users/foo' },
      );
      expect(result.ANCESTOR).toBe('/Users/foo');
      expect(result.DOWNLOADS).toBe(path.join('/Users/foo', 'runway-mcp'));
    });
  });

  describe('mergePreservedUserEnv', () => {
    it('merges user keys onto resolved env', () => {
      const merged = mergePreservedUserEnv(
        { A: 'user-val', NODE_PATH: '/stale' },
        { B: 'resolved' },
      );

      expect(merged).toEqual({ B: 'resolved', A: 'user-val' });
    });

    it('drops stale value when catalog has resolved value for same key', () => {
      const merged = mergePreservedUserEnv(
        { FRESHDESK_CONFIG_PATH: '/stale/path' },
        { FRESHDESK_CONFIG_PATH: '/new/path' },
      );

      expect(merged.FRESHDESK_CONFIG_PATH).toBe('/new/path');
    });

    it('preserves user value when catalog has unresolved placeholder for same key', () => {
      const merged = mergePreservedUserEnv(
        { GAMMA_API_KEY: 'gamma-real' },
        { GAMMA_API_KEY: '{{GAMMA_API_KEY}}' },
      );

      expect(merged.GAMMA_API_KEY).toBe('gamma-real');
    });

    it('F-1: preserves user RUNWAY_ALLOWED_ROOT even when catalog value is already resolved', () => {
      // Catalog has been resolved to a real path before merge — without the
      // default-only sandbox key handling, this clobbered the user override.
      const merged = mergePreservedUserEnv(
        { RUNWAY_ALLOWED_ROOT: '/Users/foo/custom' },
        { RUNWAY_ALLOWED_ROOT: '/var/folders/tmp' },
      );
      expect(merged.RUNWAY_ALLOWED_ROOT).toBe('/Users/foo/custom');
    });

    it('F-1: preserves user RUNWAY_DOWNLOAD_ROOT even when catalog value is already resolved', () => {
      const merged = mergePreservedUserEnv(
        { RUNWAY_DOWNLOAD_ROOT: '/Users/foo/custom-downloads' },
        { RUNWAY_DOWNLOAD_ROOT: '/var/folders/tmp/runway-mcp' },
      );
      expect(merged.RUNWAY_DOWNLOAD_ROOT).toBe('/Users/foo/custom-downloads');
    });

    it('rejects array previousEnv', () => {
      const merged = mergePreservedUserEnv(['x', 'y'], { A: '1' });

      expect(merged).toEqual({ A: '1' });
    });
  });

  describe('repairBridgeStatePathLiterals', () => {
    let repairCounter = 0;

    const expectedBridgeStatePath = (): string => path.join(tempUserData, 'mcp', 'rebel-inbox-bridge.json');

    const writeRepairConfig = async (name: string, config: unknown): Promise<string> => {
      const configDir = path.join(tempUserData, 'repair-configs');
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, `${repairCounter++}-${name}`);
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
      return configPath;
    };

    const readRepairConfig = async (configPath: string): Promise<Record<string, unknown>> => {
      const raw = await fs.readFile(configPath, 'utf8');
      return JSON.parse(raw);
    };

    it('rewrites the literal token to the resolved path', async () => {
      const configPath = await writeRepairConfig('literal.json', {
        mcpServers: {
          Runway: {
            env: {
              MCP_HOST_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
            },
          },
        },
      });

      const result = await repairBridgeStatePathLiterals(configPath);

      expect(result).toEqual({ repaired: ['Runway'] });
      const config = await readRepairConfig(configPath);
      const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
      expect(servers.Runway.env.MCP_HOST_BRIDGE_STATE).toBe(expectedBridgeStatePath());
    });

    it('is a no-op when no literal is present', async () => {
      const configPath = await writeRepairConfig('no-literal.json', {
        mcpServers: {
          Runway: {
            env: {
              MCP_HOST_BRIDGE_STATE: expectedBridgeStatePath(),
            },
          },
        },
      });
      const fixedTimestamp = new Date('2020-01-01T00:00:00.000Z');
      await fs.utimes(configPath, fixedTimestamp, fixedTimestamp);
      const before = await fs.stat(configPath);

      const result = await repairBridgeStatePathLiterals(configPath);

      const after = await fs.stat(configPath);
      expect(result).toEqual({ repaired: [] });
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    it('is idempotent on consecutive runs', async () => {
      const configPath = await writeRepairConfig('idempotent.json', {
        mcpServers: {
          Runway: {
            env: {
              MCP_HOST_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
            },
          },
        },
      });

      const first = await repairBridgeStatePathLiterals(configPath);
      const second = await repairBridgeStatePathLiterals(configPath);

      expect(first).toEqual({ repaired: ['Runway'] });
      expect(second).toEqual({ repaired: [] });
    });

    it('rewrites across multiple connectors in one pass', async () => {
      const configPath = await writeRepairConfig('multiple.json', {
        mcpServers: {
          Gamma: {
            env: {
              MCP_HOST_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
            },
          },
          Runway: {
            env: {
              MCP_HOST_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
            },
          },
          Napkin: {
            env: {
              MCP_HOST_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
            },
          },
        },
      });

      const result = await repairBridgeStatePathLiterals(configPath);

      expect(result).toEqual({ repaired: ['Gamma', 'Runway', 'Napkin'] });
      const config = await readRepairConfig(configPath);
      const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
      expect(servers.Gamma.env.MCP_HOST_BRIDGE_STATE).toBe(expectedBridgeStatePath());
      expect(servers.Runway.env.MCP_HOST_BRIDGE_STATE).toBe(expectedBridgeStatePath());
      expect(servers.Napkin.env.MCP_HOST_BRIDGE_STATE).toBe(expectedBridgeStatePath());
    });

    it('tolerates missing or malformed config', async () => {
      const missingPath = path.join(tempUserData, 'repair-configs', 'missing.json');
      await expect(repairBridgeStatePathLiterals(missingPath)).resolves.toEqual({ repaired: [] });

      const noServersPath = await writeRepairConfig('no-servers.json', { someOtherKey: true });
      await expect(repairBridgeStatePathLiterals(noServersPath)).resolves.toEqual({ repaired: [] });

      const nonObjectServersPath = await writeRepairConfig('non-object-servers.json', {
        mcpServers: 'not-an-object',
      });
      await expect(repairBridgeStatePathLiterals(nonObjectServersPath)).resolves.toEqual({ repaired: [] });
    });

    it('preserves surrounding content in compound values', async () => {
      const configPath = await writeRepairConfig('compound.json', {
        mcpServers: {
          Runway: {
            env: {
              MCP_HOST_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}.backup',
            },
          },
        },
      });

      const result = await repairBridgeStatePathLiterals(configPath);

      expect(result).toEqual({ repaired: ['Runway'] });
      const config = await readRepairConfig(configPath);
      const servers = config.mcpServers as Record<string, { env: Record<string, string> }>;
      expect(servers.Runway.env.MCP_HOST_BRIDGE_STATE).toBe(`${expectedBridgeStatePath()}.backup`);
    });
  });

  describe('migrateBundledConnectorsToNpx', () => {
    let migrationTempDir: string;

    const makeCatalog = (connectors: unknown[]) => JSON.stringify({ connectors }, null, 2);

    const zendeskCatalogEntry = {
      id: 'bundled-zendesk',
      name: 'Zendesk',
      provider: 'rebel-oss',
      bundledConfig: { serverName: 'Zendesk' },
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone-engineering/mcp-server-zendesk'],
        env: {
          ZENDESK_CONFIG_PATH: '{{MCP_CONFIG_DIR}}',
          MCP_HOST_BRIDGE_STATE: '{{MCP_BASE_DIR}}/rebel-inbox-bridge.json',
          LOG_MODE: 'strict',
        },
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
        args: ['-y', '@mindstone-engineering/mcp-server-freshdesk'],
        env: {
          FRESHDESK_CONFIG_PATH: '{{MCP_CONFIG_DIR}}',
          LOG_MODE: 'strict',
        },
      },
    };

    const officeCatalogEntry = {
      id: 'bundled-office',
      name: 'Microsoft Office',
      provider: 'rebel-oss',
      bundledConfig: { serverName: 'RebelOffice' },
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', OFFICE_MCP_PACKAGE_SPEC],
      },
    };

    const runwayCatalogEntry = {
      id: 'bundled-runway',
      name: 'Runway',
      provider: 'rebel-oss',
      bundledConfig: { serverName: 'Runway' },
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone-engineering/mcp-server-runway'],
        env: {
          MCP_HOST_BRIDGE_STATE: '{{BRIDGE_STATE_PATH}}',
          RUNWAY_ALLOWED_ROOT: '{{ALLOWED_ROOTS_ANCESTOR}}',
          RUNWAY_DOWNLOAD_ROOT: '{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}',
        },
      },
    };

    const salesforceCatalogEntry = {
      id: 'bundled-salesforce',
      name: 'Salesforce',
      provider: 'rebel-oss',
      bundledConfig: { serverName: 'Salesforce' },
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone-engineering/mcp-server-salesforce@0.1.1'],
        env: {
          SALESFORCE_CONFIG_DIR: '{{MCP_CONFIG_DIR}}',
          MCP_HOST_BRIDGE_STATE: '{{MCP_BASE_DIR}}/rebel-inbox-bridge.json',
          MCP_BRIDGE_CONFIGURE_ENDPOINT: '/bundled/salesforce/start-auth',
        },
      },
    };

    const hubspotCatalogEntry = {
      id: 'bundled-hubspot',
      name: 'HubSpot',
      provider: 'rebel-oss',
      bundledConfig: {
        serverName: 'HubSpot',
        authType: 'oauth',
        authApi: 'hubspotApi',
      },
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'],
        env: {
          HUBSPOT_CONFIG_DIR: '{{MCP_CONFIG_DIR}}',
          HUBSPOT_SOURCE_LABEL: 'Mindstone Rebel',
          LOG_MODE: 'strict',
        },
      },
    };

    const openAiImageCatalogEntry = {
      id: 'openai-image-generation',
      name: 'OpenAIImageGeneration',
      provider: 'rebel-oss',
      bundledConfig: {
        serverName: 'OpenAIImageGeneration',
        providerKeyMapping: { OPENAI_API_KEY: 'openai' as const },
      },
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone-engineering/mcp-server-openai-image@0.1.0'],
        env: {
          OPENAI_API_KEY: '{{OPENAI_API_KEY}}',
          MCP_WORKSPACE_PATH: '{{MCP_BASE_DIR}}/workspace',
        },
      },
    };

    const slackCatalogEntry = {
      id: 'bundled-slack',
      name: 'Slack',
      provider: 'rebel-oss',
      bundledConfig: {
        serverName: 'Slack',
        authType: 'oauth',
        authApi: 'slackApi',
      },
      mcpConfig: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone/mcp-server-slack@0.1.3'],
        env: {
          MCP_HOST_BRIDGE_STATE: '{{MCP_BASE_DIR}}/rebel-inbox-bridge.json',
          LOG_MODE: 'strict',
        },
      },
    };

    beforeAll(async () => {
      migrationTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-npx-migration-'));
      // Write the catalog file in the tempResources dir (used by resolveConnectorCatalogPath)
      const catalogPath = path.join(path.resolve(tempResources), 'connector-catalog.json');
      await fs.writeFile(
        catalogPath,
        makeCatalog([
          zendeskCatalogEntry,
          freshdeskCatalogEntry,
          officeCatalogEntry,
          runwayCatalogEntry,
          salesforceCatalogEntry,
          hubspotCatalogEntry,
          openAiImageCatalogEntry,
          slackCatalogEntry,
        ]),
        'utf8',
      );
    });

    afterAll(async () => {
      await fs.rm(migrationTempDir, { recursive: true, force: true }).catch(() => undefined);
    });

    const writeConfig = async (name: string, config: unknown): Promise<string> => {
      const configPath = path.join(migrationTempDir, name);
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
      return configPath;
    };

    const readConfig = async (configPath: string): Promise<Record<string, unknown>> => {
      const raw = await fs.readFile(configPath, 'utf8');
      return JSON.parse(raw);
    };

    it('migrates a single legacy node entry to npx', async () => {
      const configPath = await writeConfig('basic-migration.json', {
        mcpServers: {
          Zendesk: {
            command: 'node',
            args: ['/path/to/resources/mcp/zendesk/build/index.js'],
            catalogId: 'bundled-zendesk',
            email: 'user@example.com',
            description: 'user@example.com - Zendesk tickets',
            lastConnectedAt: 1712345678000,
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(1);
      expect(result.migrated[0]).toEqual({
        catalogId: 'bundled-zendesk',
        oldNames: ['Zendesk'],
        newName: 'Zendesk',
      });
      expect(result.skipped).toHaveLength(0);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers.Zendesk.command).toBe('npx');
      expect(servers.Zendesk.args).toEqual(['-y', '@mindstone-engineering/mcp-server-zendesk']);
      expect(servers.Zendesk.email).toBe('user@example.com');
      expect(servers.Zendesk.description).toBe('user@example.com - Zendesk tickets');
      expect(servers.Zendesk.lastConnectedAt).toBe(1712345678000);
      expect(servers.Zendesk.catalogId).toBe('bundled-zendesk');
      expect(servers.Zendesk.type).toBe('stdio');
    });

    it('preserves the RebelOffice key when migrating legacy Office entries to npx', async () => {
      const configPath = await writeConfig('office-preserve-server-name.json', {
        mcpServers: {
          RebelOffice: {
            command: 'node',
            args: [path.join(migrationTempDir, 'server.cjs')],
            catalogId: 'bundled-office',
            lastConnectedAt: 1712345678000,
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(1);
      expect(result.migrated[0]).toEqual({
        catalogId: 'bundled-office',
        oldNames: ['RebelOffice'],
        newName: 'RebelOffice',
      });

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers['Microsoft Office']).toBeUndefined();
      expect(servers.RebelOffice).toBeDefined();
      expect(servers.RebelOffice.command).toBe('npx');
      expect(servers.RebelOffice.args).toEqual(['-y', OFFICE_MCP_PACKAGE_SPEC]);
      expect(servers.RebelOffice.catalogId).toBe('bundled-office');
      expect(servers.RebelOffice.lastConnectedAt).toBe(1712345678000);
    });

    it('migrates instance-suffixed name to base name', async () => {
      const configPath = await writeConfig('instance-suffix.json', {
        mcpServers: {
          'Zendesk-teammember-mindstone-com': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
            email: '[Mindstone-email]',
            description: '[Mindstone-email] - Zendesk',
            lastConnectedAt: 1712345678000,
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(1);
      expect(result.migrated[0].oldNames).toEqual(['Zendesk-teammember-mindstone-com']);
      expect(result.migrated[0].newName).toBe('Zendesk');

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers['Zendesk-teammember-mindstone-com']).toBeUndefined();
      expect(servers.Zendesk).toBeDefined();
      expect(servers.Zendesk.command).toBe('npx');
      expect(servers.Zendesk.email).toBe('[Mindstone-email]');
    });

    it('deletes all legacy entries for same catalogId, migrates latest', async () => {
      const configPath = await writeConfig('multiple-entries.json', {
        mcpServers: {
          'Zendesk-user1': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
            email: 'user1@example.com',
            lastConnectedAt: 1000,
          },
          'Zendesk-user2': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
            email: 'user2@example.com',
            lastConnectedAt: 2000,
          },
          'Zendesk-user3': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
            email: 'user3@example.com',
            lastConnectedAt: 1500,
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(1);
      expect(result.migrated[0].oldNames).toHaveLength(3);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers['Zendesk-user1']).toBeUndefined();
      expect(servers['Zendesk-user2']).toBeUndefined();
      expect(servers['Zendesk-user3']).toBeUndefined();
      expect(servers.Zendesk).toBeDefined();
      expect(servers.Zendesk.command).toBe('npx');
      // Should pick user2 (latest lastConnectedAt)
      expect(servers.Zendesk.email).toBe('user2@example.com');
      expect(servers.Zendesk.lastConnectedAt).toBe(2000);
    });

    it('skips creation when target npx entry already exists (same catalogId), still deletes legacy entries', async () => {
      const configPath = await writeConfig('already-npx.json', {
        mcpServers: {
          Zendesk: {
            command: 'npx',
            args: ['-y', '@mindstone-engineering/mcp-server-zendesk'],
            catalogId: 'bundled-zendesk',
            email: 'existing@example.com',
          },
          'Zendesk-old': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
            email: 'old@example.com',
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(1);
      expect(result.migrated[0].oldNames).toEqual(['Zendesk-old']);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      // Old entry should be deleted
      expect(servers['Zendesk-old']).toBeUndefined();
      // Existing npx entry should NOT be overwritten
      expect(servers.Zendesk.command).toBe('npx');
      expect(servers.Zendesk.email).toBe('existing@example.com');
    });

    it('skips entirely when destination is owned by different catalogId', async () => {
      const configPath = await writeConfig('collision.json', {
        mcpServers: {
          Zendesk: {
            command: 'node',
            args: ['/some/custom/server.js'],
            catalogId: 'some-other-catalog',
          },
          'Zendesk-legacy': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].catalogId).toBe('bundled-zendesk');
      expect(result.skipped[0].reason).toContain('some-other-catalog');
      expect(result.migrated).toHaveLength(0);

      // Neither entry should be modified
      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers.Zendesk.catalogId).toBe('some-other-catalog');
      expect(servers['Zendesk-legacy']).toBeDefined();
    });

    it('migrates multiple connectors (Zendesk + Freshdesk)', async () => {
      const configPath = await writeConfig('multi-connector.json', {
        mcpServers: {
          'Zendesk-user': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
            email: 'user@example.com',
            lastConnectedAt: 1000,
          },
          'Freshdesk-user': {
            command: 'node',
            args: ['/path/to/freshdesk/index.js'],
            catalogId: 'bundled-freshdesk',
            email: 'user@example.com',
            lastConnectedAt: 2000,
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(2);
      const catalogIds = result.migrated.map(m => m.catalogId).sort();
      expect(catalogIds).toEqual(['bundled-freshdesk', 'bundled-zendesk']);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers['Zendesk-user']).toBeUndefined();
      expect(servers['Freshdesk-user']).toBeUndefined();
      expect(servers.Zendesk.command).toBe('npx');
      expect(servers.Freshdesk.command).toBe('npx');
    });

    it('migrates HubSpot entries per account and injects HUBSPOT_ACCOUNT_EMAIL per instance', async () => {
      const hubspotDir = path.join(migrationTempDir, 'hubspot-multi-account');
      const configPath = await writeConfig('hubspot-multi-account.json', {
        mcpServers: {
          'HubSpot-acct1-example-com': {
            command: 'node',
            args: ['/path/to/resources/mcp/hubspot/server.cjs'],
            catalogId: 'bundled-hubspot',
            email: 'acct1@example.com',
            description: 'acct1@example.com - HubSpot CRM',
            env: {
              HUBSPOT_CONFIG_DIR: hubspotDir,
              HUBSPOT_CLIENT_ID: 'client-id-a',
              HUBSPOT_CLIENT_SECRET: 'client-secret-a',
              HUBSPOT_SCOPE_TIER: 'readonly',
              HUBSPOT_SOURCE_LABEL: 'Mindstone Rebel',
            },
            lastConnectedAt: 1000,
          },
          'HubSpot-acct2-example-com': {
            command: 'node',
            args: ['/path/to/resources/mcp/hubspot/server.cjs'],
            catalogId: 'bundled-hubspot',
            email: 'acct2@example.com',
            description: 'acct2@example.com - HubSpot CRM',
            env: {
              HUBSPOT_CONFIG_DIR: hubspotDir,
              HUBSPOT_CLIENT_ID: 'client-id-b',
              HUBSPOT_CLIENT_SECRET: 'client-secret-b',
              HUBSPOT_SCOPE_TIER: 'full',
              HUBSPOT_SOURCE_LABEL: 'Mindstone Rebel',
            },
            lastConnectedAt: 2000,
          },
        },
      });

      await fs.mkdir(hubspotDir, { recursive: true });
      const accountsFixture = [
        { email: 'acct1@example.com', hubId: 11, scopeTier: 'readonly', grantedScopes: ['crm.objects.contacts.read'] },
        { email: 'acct2@example.com', hubId: 22, scopeTier: 'full', grantedScopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'] },
      ];
      await fs.writeFile(path.join(hubspotDir, 'accounts.json'), JSON.stringify({ accounts: accountsFixture }, null, 2), 'utf8');
      await writeHubSpotAccountsForHostScopeLookup(accountsFixture);

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);
      const hubspotMigrations = result.migrated.filter((m) => m.catalogId === 'bundled-hubspot');
      expect(hubspotMigrations).toHaveLength(2);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;

      expect(servers['HubSpot-acct1-example-com']?.command).toBe('npx');
      expect(servers['HubSpot-acct1-example-com']?.args).toEqual(['-y', '@mindstone/mcp-server-hubspot@0.2.0']);
      expect((servers['HubSpot-acct1-example-com']?.env as Record<string, string>).HUBSPOT_ACCOUNT_EMAIL).toBe('acct1@example.com');
      expect((servers['HubSpot-acct1-example-com']?.env as Record<string, string>).HUBSPOT_SCOPE_TIER).toBe('readonly');
      expect((servers['HubSpot-acct1-example-com']?.env as Record<string, string>).HUBSPOT_CLIENT_ID).toBe('client-id-a');
      expect((servers['HubSpot-acct1-example-com']?.env as Record<string, string>).HUBSPOT_CLIENT_SECRET).toBe('client-secret-a');
      expect((servers['HubSpot-acct1-example-com']?.env as Record<string, string>).HUBSPOT_SOURCE_LABEL).toBe('Mindstone Rebel');
      expect((servers['HubSpot-acct1-example-com']?.env as Record<string, string>).HUBSPOT_TELEMETRY_SALT).toBe(TEST_HUBSPOT_TELEMETRY_SALT_HEX);

      expect(servers['HubSpot-acct2-example-com']?.command).toBe('npx');
      expect((servers['HubSpot-acct2-example-com']?.env as Record<string, string>).HUBSPOT_ACCOUNT_EMAIL).toBe('acct2@example.com');
      expect((servers['HubSpot-acct2-example-com']?.env as Record<string, string>).HUBSPOT_SCOPE_TIER).toBe('full');
      expect((servers['HubSpot-acct2-example-com']?.env as Record<string, string>).HUBSPOT_CLIENT_ID).toBe('client-id-b');
      expect((servers['HubSpot-acct2-example-com']?.env as Record<string, string>).HUBSPOT_CLIENT_SECRET).toBe('client-secret-b');
      expect((servers['HubSpot-acct2-example-com']?.env as Record<string, string>).HUBSPOT_SOURCE_LABEL).toBe('Mindstone Rebel');
      expect((servers['HubSpot-acct2-example-com']?.env as Record<string, string>).HUBSPOT_TELEMETRY_SALT).toBe(TEST_HUBSPOT_TELEMETRY_SALT_HEX);
    });

    it('uses an existing managed install when migrating HubSpot account entries', async () => {
      __resetManagedMcpInstallSingletonForTesting();
      configureManagedMcpInstallService(tempUserData);
      const hubspotDir = path.join(migrationTempDir, 'hubspot-managed-account');
      const managedSlotRoot = path.join(
        tempUserData,
        'mcp',
        'managed-installs',
        '@mindstone',
        'mcp-server-hubspot@0.2.0',
      );
      const managedEntryPath = path.join(
        managedSlotRoot,
        'node_modules',
        '@mindstone',
        'mcp-server-hubspot',
        'dist',
        'index.js',
      );
      const managedMetaPath = path.join(
        managedSlotRoot,
        '.install-meta.json',
      );
      const configPath = await writeConfig('hubspot-managed-account.json', {
        mcpServers: {
          'HubSpot-managed-example-com': {
            command: 'node',
            args: ['/path/to/resources/mcp/hubspot/server.cjs'],
            catalogId: 'bundled-hubspot',
            email: 'managed@example.com',
            description: 'managed@example.com - HubSpot CRM',
            env: {
              HUBSPOT_CONFIG_DIR: hubspotDir,
              HUBSPOT_CLIENT_ID: 'client-id-managed',
              HUBSPOT_CLIENT_SECRET: 'client-secret-managed',
              HUBSPOT_SCOPE_TIER: 'readonly',
              HUBSPOT_SOURCE_LABEL: 'Mindstone Rebel',
            },
            lastConnectedAt: 3000,
          },
        },
      });

      await fs.mkdir(path.dirname(managedEntryPath), { recursive: true });
      await fs.writeFile(managedEntryPath, '#!/usr/bin/env node\n', 'utf8');
      await fs.writeFile(
        managedMetaPath,
        JSON.stringify({ entryPath: managedEntryPath }, null, 2),
        'utf8',
      );
      await fs.mkdir(hubspotDir, { recursive: true });
      const accountsFixture = [
        { email: 'managed@example.com', hubId: 33, scopeTier: 'readonly', grantedScopes: ['crm.objects.contacts.read'] },
      ];
      await fs.writeFile(path.join(hubspotDir, 'accounts.json'), JSON.stringify({ accounts: accountsFixture }, null, 2), 'utf8');
      await writeHubSpotAccountsForHostScopeLookup(accountsFixture);

      try {
        const result = await migrateBundledConnectorsToNpx(configPath, undefined);
        expect(result.skipped).toHaveLength(0);

        const config = await readConfig(configPath);
        const servers = config.mcpServers as Record<string, Record<string, unknown>>;
        const entry = servers['HubSpot-managed-example-com'];
        expect(entry.command).toBe('node');
        expect(entry.args).toEqual([managedEntryPath]);
        expect(entry.lastConnectedAt).toBe(3000);
        const env = entry.env as Record<string, string>;
        expect(env.HUBSPOT_ACCOUNT_EMAIL).toBe('managed@example.com');
        expect(env.HUBSPOT_SCOPE_TIER).toBe('readonly');
        expect(env.HUBSPOT_CLIENT_ID).toBe('client-id-managed');
        expect(env.HUBSPOT_CLIENT_SECRET).toBe('client-secret-managed');
        expect(env.HUBSPOT_SOURCE_LABEL).toBe('Mindstone Rebel');
        expect(env.HUBSPOT_TELEMETRY_SALT).toBe(TEST_HUBSPOT_TELEMETRY_SALT_HEX);
      } finally {
        __resetManagedMcpInstallSingletonForTesting();
        await fs.rm(managedSlotRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    it('migrates each Slack workspace independently and preserves per-workspace SLACK_TEAM_ID + tokens', async () => {
      // Regression: the default migration branch picks one bestCandidate per
      // catalogId by lastConnectedAt and unions all envs into a single 'Slack'
      // entry, dropping the other workspaces' SLACK_TEAM_ID. This test exercises
      // a 3-workspace fixture and asserts identity + env preservation per
      // workspace.
      const slackConfigDir = path.join(migrationTempDir, 'slack');
      const configPath = await writeConfig('slack-multi-workspace.json', {
        mcpServers: {
          'Slack-mindstone': {
            command: 'node',
            args: ['/path/to/resources/mcp/slack/server.cjs'],
            catalogId: 'bundled-slack',
            workspace: 'Mindstone',
            description: 'Mindstone workspace - Team messaging and channel access',
            env: {
              SLACK_BOT_TOKEN: 'xoxb-mindstone',
              SLACK_USER_TOKEN: 'xoxp-mindstone',
              SLACK_CONFIG_PATH: path.join(slackConfigDir, 'config.json'),
              SLACK_TEAM_ID: 'T-MIND',
              SLACK_MCP_PACKAGE_ID: 'Slack-mindstone',
              SLACK_CLIENT_ID: 'client-id-a',
              SLACK_CLIENT_SECRET: 'client-secret-a',
            },
            lastConnectedAt: 3000,
          },
          'Slack-acme': {
            command: 'node',
            args: ['/path/to/resources/mcp/slack/server.cjs'],
            catalogId: 'bundled-slack',
            workspace: 'Acme',
            description: 'Acme workspace - Team messaging and channel access',
            env: {
              SLACK_BOT_TOKEN: 'xoxb-acme',
              SLACK_CONFIG_PATH: path.join(slackConfigDir, 'config.json'),
              SLACK_TEAM_ID: 'T-ACME',
              SLACK_MCP_PACKAGE_ID: 'Slack-acme',
              SLACK_CLIENT_ID: 'client-id-b',
              SLACK_CLIENT_SECRET: 'client-secret-b',
            },
            lastConnectedAt: 2000,
          },
          'Slack-foo': {
            command: 'node',
            args: ['/path/to/resources/mcp/slack/server.cjs'],
            catalogId: 'bundled-slack',
            workspace: 'Foo',
            description: 'Foo workspace - Team messaging and channel access',
            env: {
              SLACK_BOT_TOKEN: 'xoxb-foo',
              SLACK_CONFIG_PATH: path.join(slackConfigDir, 'config.json'),
              SLACK_TEAM_ID: 'T-FOO',
              SLACK_MCP_PACKAGE_ID: 'Slack-foo',
              SLACK_CLIENT_ID: 'client-id-c',
              SLACK_CLIENT_SECRET: 'client-secret-c',
            },
            lastConnectedAt: 1000,
          },
        },
      });

      const { servers } = await runMultiInstanceRebelOssMigrationFixture({
        catalogId: 'bundled-slack',
        configPath,
        expectedInstanceIds: ['Slack-mindstone', 'Slack-acme', 'Slack-foo'],
        expectedArgs: ['-y', '@mindstone/mcp-server-slack@0.1.3'],
        collapsedName: 'Slack',
        migrate: (pathToConfig) => migrateBundledConnectorsToNpx(pathToConfig, undefined),
        readConfig,
      });

      // Per-workspace env preserved verbatim — no cross-pollination.
      const mindstoneEnv = servers['Slack-mindstone']?.env as Record<string, string>;
      expect(mindstoneEnv.SLACK_TEAM_ID).toBe('T-MIND');
      expect(mindstoneEnv.SLACK_BOT_TOKEN).toBe('xoxb-mindstone');
      expect(mindstoneEnv.SLACK_USER_TOKEN).toBe('xoxp-mindstone');
      expect(mindstoneEnv.SLACK_CLIENT_ID).toBe('client-id-a');
      expect(mindstoneEnv.SLACK_CLIENT_SECRET).toBe('client-secret-a');
      expect(mindstoneEnv.SLACK_MCP_PACKAGE_ID).toBe('Slack-mindstone');

      const acmeEnv = servers['Slack-acme']?.env as Record<string, string>;
      expect(acmeEnv.SLACK_TEAM_ID).toBe('T-ACME');
      expect(acmeEnv.SLACK_BOT_TOKEN).toBe('xoxb-acme');
      expect(acmeEnv.SLACK_CLIENT_ID).toBe('client-id-b');
      // Acme has no user token in legacy env — must remain absent (not bleed
      // from Mindstone) on the migrated entry.
      expect(acmeEnv.SLACK_USER_TOKEN).toBeUndefined();

      const fooEnv = servers['Slack-foo']?.env as Record<string, string>;
      expect(fooEnv.SLACK_TEAM_ID).toBe('T-FOO');
      expect(fooEnv.SLACK_BOT_TOKEN).toBe('xoxb-foo');
      expect(fooEnv.SLACK_CLIENT_ID).toBe('client-id-c');
    });

    it('skips Slack legacy entries with no SLACK_BOT_TOKEN and preserves the legacy entry', async () => {
      const configPath = await writeConfig('slack-missing-bot-token.json', {
        mcpServers: {
          'Slack-broken': {
            command: 'node',
            args: ['/path/to/resources/mcp/slack/server.cjs'],
            catalogId: 'bundled-slack',
            workspace: 'Broken',
            env: {
              // SLACK_BOT_TOKEN intentionally missing
              SLACK_TEAM_ID: 'T-BROKEN',
              SLACK_CONFIG_PATH: '/tmp/slack/config.json',
            },
            lastConnectedAt: 5000,
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);
      const skipped = result.skipped.find((s) =>
        s.catalogId === 'bundled-slack' && s.reason.includes('Slack workspace migration failed'),
      );
      expect(skipped).toBeDefined();

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      // Legacy entry preserved (no destructive rewrite on failure).
      expect(servers['Slack-broken']?.command).toBe('node');
    });

    it('preserves disabledServers and userDisabledToolsByServer mappings when Slack identity is preserved', async () => {
      const configPath = await writeConfig('slack-disabled-tools.json', {
        mcpServers: {
          'Slack-mindstone': {
            command: 'node',
            args: ['/path/to/resources/mcp/slack/server.cjs'],
            catalogId: 'bundled-slack',
            workspace: 'Mindstone',
            env: {
              SLACK_BOT_TOKEN: 'xoxb-mindstone',
              SLACK_TEAM_ID: 'T-MIND',
              SLACK_CONFIG_PATH: '/tmp/slack/config.json',
              SLACK_MCP_PACKAGE_ID: 'Slack-mindstone',
            },
            lastConnectedAt: 1000,
          },
        },
        // Identity-preserving migration (oldName === newName) — the disabled-tools
        // and disabled-servers entries must remain keyed by 'Slack-mindstone' so
        // the user-disabled state survives the node→npx rewrite. A careless
        // unconditional rename would drop these.
        userDisabledToolsByServer: {
          'Slack-mindstone': ['post_slack_message'],
        },
        disabledServers: ['Slack-mindstone'],
      });

      await migrateBundledConnectorsToNpx(configPath, undefined);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers['Slack-mindstone']?.command).toBe('npx');
      const disabledByServer = config.userDisabledToolsByServer as Record<string, string[]>;
      expect(disabledByServer['Slack-mindstone']).toEqual(['post_slack_message']);
      expect(config.disabledServers).toContain('Slack-mindstone');
    });

    it('Slack migration is idempotent: second run leaves the config untouched', async () => {
      const configPath = await writeConfig('slack-idempotent.json', {
        mcpServers: {
          'Slack-mindstone': {
            command: 'node',
            args: ['/path/to/resources/mcp/slack/server.cjs'],
            catalogId: 'bundled-slack',
            workspace: 'Mindstone',
            env: {
              SLACK_BOT_TOKEN: 'xoxb-mindstone',
              SLACK_TEAM_ID: 'T-MIND',
              SLACK_CONFIG_PATH: '/tmp/slack/config.json',
              SLACK_MCP_PACKAGE_ID: 'Slack-mindstone',
            },
            lastConnectedAt: 1000,
          },
        },
      });

      const firstRun = await migrateBundledConnectorsToNpx(configPath, undefined);
      expect(firstRun.migrated.filter((m) => m.catalogId === 'bundled-slack')).toHaveLength(1);
      const afterFirst = JSON.stringify(await readConfig(configPath));

      const secondRun = await migrateBundledConnectorsToNpx(configPath, undefined);
      expect(secondRun.migrated.filter((m) => m.catalogId === 'bundled-slack')).toHaveLength(0);
      expect(secondRun.skipped.filter((s) => s.catalogId === 'bundled-slack')).toHaveLength(0);
      const afterSecond = JSON.stringify(await readConfig(configPath));
      expect(afterSecond).toBe(afterFirst);
    });

    it('uses redacted instance identifiers in missing-legacy HubSpot migration skip reasons', async () => {
      const hubspotDir = path.join(migrationTempDir, 'hubspot-missing-legacy-reason');
      const configPath = await writeConfig('hubspot-missing-legacy-reason.json', {
        mcpServers: {
          'HubSpot-acct1-example-com': {
            command: 'node',
            args: ['/path/to/resources/mcp/hubspot/server.cjs'],
            catalogId: 'bundled-hubspot',
            email: 'acct1@example.com',
            env: {
              HUBSPOT_CONFIG_DIR: hubspotDir,
              HUBSPOT_CLIENT_ID: 'client-id-a',
              HUBSPOT_CLIENT_SECRET: 'client-secret-a',
              HUBSPOT_SCOPE_TIER: 'readonly',
              HUBSPOT_SOURCE_LABEL: 'Mindstone Rebel',
            },
            lastConnectedAt: 1000,
          },
        },
      });

      await fs.mkdir(hubspotDir, { recursive: true });
      const accountsFixture = [
        { email: 'acct1@example.com', hubId: 11, scopeTier: 'readonly' },
        { email: 'acct2@example.com', hubId: 22, scopeTier: 'full' },
      ];
      await fs.writeFile(path.join(hubspotDir, 'accounts.json'), JSON.stringify({ accounts: accountsFixture }, null, 2), 'utf8');
      await writeHubSpotAccountsForHostScopeLookup(accountsFixture);

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);
      const missingLegacySkip = result.skipped.find((entry) => entry.reason.includes('No legacy HubSpot entry found'));

      expect(missingLegacySkip?.reason).toContain('HubSpot-acct2-example-com');
      expect(missingLegacySkip?.reason).not.toContain('acct2@example.com');
    });

    it('uses stored HubSpot scope tier during migration even when legacy env differs', async () => {
      const hubspotDir = path.join(migrationTempDir, 'hubspot-migration-scope-tier-source');
      const configPath = await writeConfig('hubspot-migration-scope-tier-source.json', {
        mcpServers: {
          'HubSpot-acct1-example-com': {
            command: 'node',
            args: ['/path/to/resources/mcp/hubspot/server.cjs'],
            catalogId: 'bundled-hubspot',
            email: 'acct1@example.com',
            env: {
              HUBSPOT_CONFIG_DIR: hubspotDir,
              HUBSPOT_CLIENT_ID: 'client-id-a',
              HUBSPOT_CLIENT_SECRET: 'client-secret-a',
              HUBSPOT_SCOPE_TIER: 'readonly',
              HUBSPOT_SOURCE_LABEL: 'Mindstone Rebel',
            },
            lastConnectedAt: 1000,
          },
        },
      });

      await fs.mkdir(hubspotDir, { recursive: true });
      const accountsFixture = [
        { email: 'acct1@example.com', hubId: 11, scopeTier: 'full' },
      ];
      await fs.writeFile(path.join(hubspotDir, 'accounts.json'), JSON.stringify({ accounts: accountsFixture }, null, 2), 'utf8');
      await writeHubSpotAccountsForHostScopeLookup(accountsFixture);

      await migrateBundledConnectorsToNpx(configPath, undefined);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect((servers['HubSpot-acct1-example-com']?.env as Record<string, string>).HUBSPOT_SCOPE_TIER).toBe('full');
    });

    it('isolates partial HubSpot migration failures (one instance fails, one succeeds)', async () => {
      const hubspotDir = path.join(migrationTempDir, 'hubspot-partial-failure');
      const configPath = await writeConfig('hubspot-partial-failure.json', {
        mcpServers: {
          'HubSpot-success-example-com': {
            command: 'node',
            args: ['/path/to/resources/mcp/hubspot/server.cjs'],
            catalogId: 'bundled-hubspot',
            email: 'success@example.com',
            env: {
              HUBSPOT_CONFIG_DIR: hubspotDir,
              HUBSPOT_CLIENT_ID: 'client-id-success',
              HUBSPOT_CLIENT_SECRET: 'client-secret-success',
              HUBSPOT_SCOPE_TIER: 'readonly',
              HUBSPOT_SOURCE_LABEL: 'Mindstone Rebel',
            },
            lastConnectedAt: 1000,
          },
          'HubSpot-failure-example-com': {
            command: 'node',
            args: ['/path/to/resources/mcp/hubspot/server.cjs'],
            catalogId: 'bundled-hubspot',
            email: 'failure@example.com',
            env: {
              HUBSPOT_CONFIG_DIR: hubspotDir,
              HUBSPOT_CLIENT_ID: 'client-id-failure',
              // Missing HUBSPOT_CLIENT_SECRET triggers a fail-loud per-instance migration failure.
              HUBSPOT_SCOPE_TIER: 'full',
              HUBSPOT_SOURCE_LABEL: 'Mindstone Rebel',
            },
            lastConnectedAt: 2000,
          },
        },
      });

      await fs.mkdir(hubspotDir, { recursive: true });
      const accountsFixture = [
        { email: 'success@example.com', hubId: 11, scopeTier: 'readonly' },
        { email: 'failure@example.com', hubId: 22, scopeTier: 'full' },
      ];
      await fs.writeFile(path.join(hubspotDir, 'accounts.json'), JSON.stringify({ accounts: accountsFixture }, null, 2), 'utf8');
      await writeHubSpotAccountsForHostScopeLookup(accountsFixture);

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);
      const hubspotMigrations = result.migrated.filter((m) => m.catalogId === 'bundled-hubspot');
      expect(hubspotMigrations).toHaveLength(1);
      expect(hubspotMigrations[0]?.newName).toBe('HubSpot-success-example-com');

      expect(result.skipped.some((skip) => skip.reason.includes('HubSpot-failure-example-com'))).toBe(true);
      expect(result.skipped.every((skip) => !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(skip.reason))).toBe(true);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;

      // Successful account migrated to npx shape.
      expect(servers['HubSpot-success-example-com']?.command).toBe('npx');
      expect((servers['HubSpot-success-example-com']?.env as Record<string, string>).HUBSPOT_ACCOUNT_EMAIL).toBe('success@example.com');

      // Failed account preserved in legacy node shape.
      expect(servers['HubSpot-failure-example-com']?.command).toBe('node');
      expect((servers['HubSpot-failure-example-com']?.env as Record<string, string>).HUBSPOT_CLIENT_SECRET).toBeUndefined();
    });

    it('skips HubSpot migration when scope tier cannot be resolved without fallback', async () => {
      const hubspotDir = path.join(migrationTempDir, 'hubspot-no-scope-tier');
      const configPath = await writeConfig('hubspot-no-scope-tier.json', {
        mcpServers: {
          'HubSpot-no-scope-tier-example-com': {
            command: 'node',
            args: ['/path/to/resources/mcp/hubspot/server.cjs'],
            catalogId: 'bundled-hubspot',
            email: 'no-scope-tier@example.com',
            env: {
              HUBSPOT_CONFIG_DIR: hubspotDir,
              HUBSPOT_CLIENT_ID: 'client-id',
              HUBSPOT_CLIENT_SECRET: 'client-secret',
              HUBSPOT_SOURCE_LABEL: 'Mindstone Rebel',
            },
            lastConnectedAt: 1000,
          },
        },
      });

      await fs.mkdir(hubspotDir, { recursive: true });
      await fs.writeFile(
        path.join(hubspotDir, 'accounts.json'),
        JSON.stringify({ accounts: [{ email: 'no-scope-tier@example.com', hubId: 11 }] }, null, 2),
        'utf8',
      );
      await writeHubSpotAccountsForHostScopeLookup([
        { email: 'different@example.com', hubId: 22, scopeTier: 'readonly' },
      ]);

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated.filter((entry) => entry.catalogId === 'bundled-hubspot')).toHaveLength(0);
      expect(result.skipped.some((skip) => skip.reason.includes('no_scope_tier'))).toBe(true);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers['HubSpot-no-scope-tier-example-com']?.command).toBe('node');
      expect((servers['HubSpot-no-scope-tier-example-com']?.env as Record<string, string>).HUBSPOT_SCOPE_TIER).toBeUndefined();
    });

    it('no-ops when entries already use npx', async () => {
      const configPath = await writeConfig('already-migrated.json', {
        mcpServers: {
          Zendesk: {
            command: 'npx',
            args: ['-y', '@mindstone-engineering/mcp-server-zendesk'],
            catalogId: 'bundled-zendesk',
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });

    it('no-ops when no entries match the catalog', async () => {
      const configPath = await writeConfig('no-match.json', {
        mcpServers: {
          CustomServer: {
            command: 'node',
            args: ['/custom/server.js'],
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });

    it('migrates userDisabledToolsByServer from old names to new name', async () => {
      const configPath = await writeConfig('disabled-tools.json', {
        mcpServers: {
          'Zendesk-user1': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
            lastConnectedAt: 1000,
          },
          'Zendesk-user2': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
            lastConnectedAt: 2000,
          },
        },
        userDisabledToolsByServer: {
          'Zendesk-user1': ['tool_a', 'tool_b'],
          'Zendesk-user2': ['tool_b', 'tool_c'],
          OtherServer: ['tool_x'],
        },
      });

      await migrateBundledConnectorsToNpx(configPath, undefined);

      const config = await readConfig(configPath);
      const disabled = config.userDisabledToolsByServer as Record<string, string[]>;
      expect(disabled['Zendesk-user1']).toBeUndefined();
      expect(disabled['Zendesk-user2']).toBeUndefined();
      expect(disabled.OtherServer).toEqual(['tool_x']);
      // Merged and deduped
      const zendeskTools = new Set(disabled.Zendesk);
      expect(zendeskTools).toEqual(new Set(['tool_a', 'tool_b', 'tool_c']));
    });

    it('migrates disabledServers array from old names to new name', async () => {
      const configPath = await writeConfig('disabled-servers.json', {
        mcpServers: {
          'Zendesk-user1': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
            lastConnectedAt: 1000,
          },
          'Zendesk-user2': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
            lastConnectedAt: 2000,
          },
        },
        disabledServers: ['Zendesk-user1', 'SomeOther', 'Zendesk-user2'],
      });

      await migrateBundledConnectorsToNpx(configPath, undefined);

      const config = await readConfig(configPath);
      const disabled = config.disabledServers as string[];
      expect(disabled).not.toContain('Zendesk-user1');
      expect(disabled).not.toContain('Zendesk-user2');
      expect(disabled).toContain('Zendesk');
      expect(disabled).toContain('SomeOther');
      // No duplicates
      expect(new Set(disabled).size).toBe(disabled.length);
    });

    it('is idempotent: running twice produces same result', async () => {
      const configPath = await writeConfig('idempotent.json', {
        mcpServers: {
          'Zendesk-user': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
            email: 'user@example.com',
            lastConnectedAt: 1000,
          },
        },
        disabledServers: ['Zendesk-user'],
      });

      const result1 = await migrateBundledConnectorsToNpx(configPath, undefined);
      expect(result1.migrated).toHaveLength(1);

      const afterFirst = await fs.readFile(configPath, 'utf8');

      const result2 = await migrateBundledConnectorsToNpx(configPath, undefined);
      expect(result2.migrated).toHaveLength(0);

      const afterSecond = await fs.readFile(configPath, 'utf8');
      expect(afterSecond).toBe(afterFirst);
    });

    it('resolves env var placeholders correctly', async () => {
      const configPath = await writeConfig('env-resolution.json', {
        mcpServers: {
          'Zendesk-user': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath, undefined);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.Zendesk.env as Record<string, string>;
      // configDir = path.dirname(configPath) + '/zendesk' (lowercase serverName)
      const expectedConfigDir = path.join(path.dirname(configPath), 'zendesk');
      const expectedBaseDir = path.dirname(configPath);
      expect(env.ZENDESK_CONFIG_PATH).toBe(expectedConfigDir);
      expect(env.MCP_HOST_BRIDGE_STATE).toBe(path.join(expectedBaseDir, 'rebel-inbox-bridge.json'));
      expect(env.LOG_MODE).toBe('strict');
    });

    it('resolves providerKeyMapping values when migrating legacy OpenAI Image entries with a configured key', async () => {
      const configPath = await writeConfig('openai-migration-with-key.json', {
        mcpServers: {
          'OpenAIImageGeneration-legacy': {
            command: 'node',
            args: ['/path/to/resources/mcp/openai-image/server.cjs'],
            catalogId: 'openai-image-generation',
            env: { OPENAI_API_KEY: 'fake-stale' },
            lastConnectedAt: 1712345678000,
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath, {
        openai: 'fake-fresh',
      } as AppSettings['providerKeys']);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.OpenAIImageGeneration.env as Record<string, string>;
      expect(servers['OpenAIImageGeneration-legacy']).toBeUndefined();
      expect(servers.OpenAIImageGeneration.command).toBe('npx');
      expect(env.OPENAI_API_KEY).toBe('fake-fresh');
    });

    it('preserves concrete OPENAI_API_KEY values when migrating legacy OpenAI Image entries without a provider key', async () => {
      const configPath = await writeConfig('openai-migration-without-key.json', {
        mcpServers: {
          'OpenAIImageGeneration-legacy': {
            command: 'node',
            args: ['/path/to/resources/mcp/openai-image/server.cjs'],
            catalogId: 'openai-image-generation',
            env: { OPENAI_API_KEY: 'fake-stale' },
            lastConnectedAt: 1712345678000,
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath, {
        openai: null,
      } as AppSettings['providerKeys']);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.OpenAIImageGeneration.env as Record<string, string>;
      expect(env.OPENAI_API_KEY).toBe('fake-stale');
    });

    it('preserves non-placeholder OPENAI_API_KEY values on existing npx entries during migration cleanup', async () => {
      const configPath = await writeConfig('openai-existing-npx-preserve.json', {
        mcpServers: {
          OpenAIImageGeneration: {
            command: 'npx',
            args: ['-y', '@mindstone-engineering/mcp-server-openai-image@0.1.0'],
            catalogId: 'openai-image-generation',
            env: { OPENAI_API_KEY: 'fake-user-customized' },
          },
          'OpenAIImageGeneration-legacy': {
            command: 'node',
            args: ['/path/to/resources/mcp/openai-image/server.cjs'],
            catalogId: 'openai-image-generation',
            lastConnectedAt: 1712345678000,
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath, {
        openai: 'fake-provider-rotated',
      } as AppSettings['providerKeys']);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.OpenAIImageGeneration.env as Record<string, string>;
      expect(servers['OpenAIImageGeneration-legacy']).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBe('fake-user-customized');
    });

    it('resolves exact OPENAI_API_KEY placeholders on existing npx entries during migration cleanup', async () => {
      const configPath = await writeConfig('openai-existing-npx-placeholder.json', {
        mcpServers: {
          OpenAIImageGeneration: {
            command: 'npx',
            args: ['-y', '@mindstone-engineering/mcp-server-openai-image@0.1.0'],
            catalogId: 'openai-image-generation',
            env: { OPENAI_API_KEY: '{{OPENAI_API_KEY}}' },
          },
          'OpenAIImageGeneration-legacy': {
            command: 'node',
            args: ['/path/to/resources/mcp/openai-image/server.cjs'],
            catalogId: 'openai-image-generation',
            lastConnectedAt: 1712345678000,
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath, {
        openai: 'fake-provider',
      } as AppSettings['providerKeys']);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.OpenAIImageGeneration.env as Record<string, string>;
      expect(env.OPENAI_API_KEY).toBe('fake-provider');
    });

    it('resolves placeholders on already-npx-only entries when no legacy node sibling exists', async () => {
      const configPath = await writeConfig('openai-existing-npx-only-placeholder.json', {
        mcpServers: {
          OpenAIImageGeneration: {
            command: 'npx',
            args: ['-y', '@mindstone-engineering/mcp-server-openai-image@0.1.0'],
            catalogId: 'openai-image-generation',
            env: { OPENAI_API_KEY: '{{OPENAI_API_KEY}}' },
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath, {
        openai: 'fake-provider-from-settings',
      } as AppSettings['providerKeys']);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.OpenAIImageGeneration.env as Record<string, string>;
      expect(env.OPENAI_API_KEY).toBe('fake-provider-from-settings');
    });

    it('preserves user-edited values on already-npx-only entries with provider keys configured', async () => {
      const configPath = await writeConfig('openai-existing-npx-only-user-edit.json', {
        mcpServers: {
          OpenAIImageGeneration: {
            command: 'npx',
            args: ['-y', '@mindstone-engineering/mcp-server-openai-image@0.1.0'],
            catalogId: 'openai-image-generation',
            env: { OPENAI_API_KEY: 'fake-user-customized' },
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath, {
        openai: 'fake-provider-from-settings',
      } as AppSettings['providerKeys']);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.OpenAIImageGeneration.env as Record<string, string>;
      expect(env.OPENAI_API_KEY).toBe('fake-user-customized');
    });

    it('skips non-string env values on already-npx entries with a warning instead of throwing', async () => {
      const configPath = await writeConfig('openai-existing-npx-non-string-env.json', {
        mcpServers: {
          OpenAIImageGeneration: {
            command: 'npx',
            args: ['-y', '@mindstone-engineering/mcp-server-openai-image@0.1.0'],
            catalogId: 'openai-image-generation',
            env: {
              OPENAI_API_KEY: '{{OPENAI_API_KEY}}',
              OPENAI_IMAGE_MODEL: 123,
            },
          },
          'OpenAIImageGeneration-legacy': {
            command: 'node',
            args: ['/path/to/resources/mcp/openai-image/server.cjs'],
            catalogId: 'openai-image-generation',
            lastConnectedAt: 1712345678000,
          },
        },
      });

      bundledMcpManagerLoggerMock.warn.mockClear();
      await expect(
        migrateBundledConnectorsToNpx(configPath, {
          openai: 'fake-provider-from-settings',
        } as AppSettings['providerKeys']),
      ).resolves.toEqual(expect.objectContaining({ migrated: expect.any(Array) }));

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.OpenAIImageGeneration.env as Record<string, unknown>;
      expect(env.OPENAI_API_KEY).toBe('fake-provider-from-settings');
      expect(env.OPENAI_IMAGE_MODEL).toBe(123);
      expect(bundledMcpManagerLoggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          catalogId: 'openai-image-generation',
          envKey: 'OPENAI_IMAGE_MODEL',
          valueType: 'number',
        }),
        'migrateBundledConnectorsToNpx: skipping non-string env value on existing npx entry',
      );
    });

    it('migrates HTTP-shape legacy OpenAI Image entry to npx with provider key resolution', async () => {
      const configPath = await writeConfig('openai-http-legacy-migration.json', {
        mcpServers: {
          OpenAIImageGeneration: {
            name: 'OpenAIImageGeneration',
            type: 'http',
            url: 'http://127.0.0.1:9101/',
            description: 'Generate images from text descriptions using OpenAI gpt-image-2.',
            catalogId: 'openai-image-generation',
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, {
        openai: 'fake-key-from-provider-keys',
      } as AppSettings['providerKeys']);

      expect(result.migrated).toHaveLength(1);
      expect(result.migrated[0]).toEqual({
        catalogId: 'openai-image-generation',
        oldNames: ['OpenAIImageGeneration'],
        newName: 'OpenAIImageGeneration',
      });

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const entry = servers.OpenAIImageGeneration;
      expect(entry.command).toBe('npx');
      expect(entry.args).toEqual(['-y', '@mindstone-engineering/mcp-server-openai-image@0.1.0']);
      expect(entry.type).toBe('stdio');
      expect(entry.catalogId).toBe('openai-image-generation');
      expect(entry.url).toBeUndefined();
      const env = entry.env as Record<string, string>;
      expect(env.OPENAI_API_KEY).toBe('fake-key-from-provider-keys');
    });

    it('preserves HTTP-shape entry whose catalogId is NOT in the rebel-oss lookup', async () => {
      const configPath = await writeConfig('http-non-rebel-oss-catalogid.json', {
        mcpServers: {
          MyCustomHttpMcp: {
            name: 'MyCustomHttpMcp',
            type: 'http',
            url: 'http://127.0.0.1:8080/',
            catalogId: 'community-some-mcp',
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(0);
      const config = await readConfig(configPath);
      const entry = (config.mcpServers as Record<string, Record<string, unknown>>).MyCustomHttpMcp;
      expect(entry.type).toBe('http');
      expect(entry.url).toBe('http://127.0.0.1:8080/');
      expect(entry.command).toBeUndefined();
    });

    it('preserves HTTP-shape entry that has no catalogId field', async () => {
      const configPath = await writeConfig('http-no-catalogid.json', {
        mcpServers: {
          SomeRemoteHttpMcp: {
            name: 'SomeRemoteHttpMcp',
            type: 'http',
            url: 'http://127.0.0.1:9999/',
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(0);
      const config = await readConfig(configPath);
      const entry = (config.mcpServers as Record<string, Record<string, unknown>>).SomeRemoteHttpMcp;
      expect(entry.type).toBe('http');
      expect(entry.command).toBeUndefined();
    });

    it('preserves HTTP-shape entry with rebel-oss catalogId but non-loopback url (defence-in-depth)', async () => {
      const configPath = await writeConfig('http-non-loopback-rebel-oss.json', {
        mcpServers: {
          OpenAIImageGeneration: {
            name: 'OpenAIImageGeneration',
            type: 'http',
            url: 'https://api.example.com/mcp',
            catalogId: 'openai-image-generation',
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(0);
      const config = await readConfig(configPath);
      const entry = (config.mcpServers as Record<string, Record<string, unknown>>).OpenAIImageGeneration;
      expect(entry.type).toBe('http');
      expect(entry.url).toBe('https://api.example.com/mcp');
      expect(entry.command).toBeUndefined();
    });

    it('migrates HTTP-shape legacy OpenAI Image entry on localhost loopback URL', async () => {
      const configPath = await writeConfig('openai-http-legacy-localhost.json', {
        mcpServers: {
          OpenAIImageGeneration: {
            name: 'OpenAIImageGeneration',
            type: 'http',
            url: 'http://localhost:9101/',
            catalogId: 'openai-image-generation',
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, {
        openai: 'fake-key',
      } as AppSettings['providerKeys']);

      expect(result.migrated).toHaveLength(1);
      const config = await readConfig(configPath);
      const entry = (config.mcpServers as Record<string, Record<string, unknown>>).OpenAIImageGeneration;
      expect(entry.command).toBe('npx');
      expect(entry.url).toBeUndefined();
    });

    it('preserves identity fields (email, description, lastConnectedAt)', async () => {
      const configPath = await writeConfig('identity.json', {
        mcpServers: {
          'Zendesk-legacy': {
            command: 'node',
            args: ['/path/to/zendesk/index.js'],
            catalogId: 'bundled-zendesk',
            email: 'preserve@example.com',
            description: 'preserve@example.com - Zendesk support tickets',
            lastConnectedAt: 9999999,
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath, undefined);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers.Zendesk.email).toBe('preserve@example.com');
      expect(servers.Zendesk.description).toBe('preserve@example.com - Zendesk support tickets');
      expect(servers.Zendesk.lastConnectedAt).toBe(9999999);
    });

    it('preserves user-set credentials in env on migration', async () => {
      const configPath = await writeConfig('preserve-user-env.json', {
        mcpServers: {
          Runway: {
            command: 'node',
            args: ['/path/to/resources/mcp/runway/build/index.js'],
            catalogId: 'bundled-runway',
            env: {
              RUNWAYML_API_SECRET: 'fake-runway-real-secret',
              MCP_HOST_BRIDGE_STATE: '/old/stale/path',
            },
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.Runway.env as Record<string, string>;
      expect(env.RUNWAYML_API_SECRET).toBe('fake-runway-real-secret');
      expect(env.MCP_HOST_BRIDGE_STATE).toBe(path.join(tempUserData, 'mcp', 'rebel-inbox-bridge.json'));

      // N-5: post-migration Runway env contains resolved sandbox roots
      // (no literal `{{...}}` survives the merge + resolution pipeline).
      expect(env.RUNWAY_ALLOWED_ROOT).toBeDefined();
      expect(env.RUNWAY_DOWNLOAD_ROOT).toBeDefined();
      expect(env.RUNWAY_ALLOWED_ROOT).not.toMatch(/\{\{/);
      expect(env.RUNWAY_DOWNLOAD_ROOT).not.toMatch(/\{\{/);
      expect(env.RUNWAY_DOWNLOAD_ROOT).toContain('runway-mcp');
    });

    it('F-1: user override of RUNWAY_ALLOWED_ROOT survives migration even with resolved catalog default', async () => {
      const configPath = await writeConfig('preserve-runway-allowed-root.json', {
        mcpServers: {
          Runway: {
            command: 'node',
            args: ['/path/to/resources/mcp/runway/build/index.js'],
            catalogId: 'bundled-runway',
            env: {
              RUNWAY_ALLOWED_ROOT: '/Users/foo/custom-runway',
              RUNWAYML_API_SECRET: 'fake-secret',
            },
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.Runway.env as Record<string, string>;
      expect(env.RUNWAY_ALLOWED_ROOT).toBe('/Users/foo/custom-runway');
    });

    it('drops INTERNAL_ENV_KEYS values from previous entry', async () => {
      const configPath = await writeConfig('drop-internal-env.json', {
        mcpServers: {
          Freshdesk: {
            command: 'node',
            args: ['/path/to/resources/mcp/freshdesk/build/index.js'],
            catalogId: 'bundled-freshdesk',
            env: {
              NODE_PATH: '/stale/old/path',
            },
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.Freshdesk.env as Record<string, string>;
      expect(env.NODE_PATH).toBeUndefined();
    });

    it('does not preserve unresolved {{...}} placeholders from previous env', async () => {
      const configPath = await writeConfig('drop-unresolved-env-placeholder.json', {
        mcpServers: {
          Freshdesk: {
            command: 'node',
            args: ['/path/to/resources/mcp/freshdesk/build/index.js'],
            catalogId: 'bundled-freshdesk',
            env: {
              GAMMA_API_KEY: '{{GAMMA_API_KEY}}',
            },
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.Freshdesk.env as Record<string, string>;
      expect(env.GAMMA_API_KEY).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain('{{GAMMA_API_KEY}}');
    });

    it('preserves user env even when catalog has no env block', async () => {
      const configPath = await writeConfig('preserve-user-env-no-catalog-env.json', {
        mcpServers: {
          RebelOffice: {
            command: 'node',
            args: [path.join(migrationTempDir, 'server.cjs')],
            catalogId: 'bundled-office',
            env: {
              CUSTOM_USER_KEY: 'value',
            },
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.RebelOffice.env as Record<string, string>;
      expect(env.CUSTOM_USER_KEY).toBe('value');
    });

    it('handles missing config file gracefully', async () => {
      const result = await migrateBundledConnectorsToNpx('/nonexistent/path.json', undefined);
      expect(result.migrated).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });

    it('handles config with no mcpServers', async () => {
      const configPath = await writeConfig('no-servers.json', { someOtherKey: true });
      const result = await migrateBundledConnectorsToNpx(configPath, undefined);
      expect(result.migrated).toHaveLength(0);
    });

    it('does not revert a managed-install entry back to npx', async () => {
      const managedEntryPath = path.join(
        tempUserData,
        'mcp',
        'managed-installs',
        '@mindstone-engineering',
        'mcp-server-zendesk@0.3.0',
        'node_modules',
        '@mindstone-engineering',
        'mcp-server-zendesk',
        'dist',
        'index.js',
      );

      const configPath = await writeConfig('managed-install-gate.json', {
        mcpServers: {
          Zendesk: {
            command: 'node',
            args: [managedEntryPath],
            catalogId: 'bundled-zendesk',
            email: 'user@example.com',
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers.Zendesk.command).toBe('node');
      expect(servers.Zendesk.args).toEqual([managedEntryPath]);
    });

    describe('rewriteManagedMcpEntriesToNpxForCloud', () => {
      const catalog: Parameters<typeof rewriteManagedMcpEntriesToNpxForCloud>[2] = [
        {
          id: 'bundled-zendesk',
          provider: 'rebel-oss',
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@mindstone-engineering/mcp-server-zendesk@0.3.0'],
            env: {
              ZENDESK_CONFIG_PATH: '{{MCP_CONFIG_DIR}}',
              LOG_MODE: 'strict',
            },
          },
        },
        {
          id: 'bundled-freshdesk',
          provider: 'rebel-oss',
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@mindstone-engineering/mcp-server-freshdesk@0.2.0'],
          },
        },
        {
          id: 'bundled-office',
          provider: 'rebel-oss',
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', OFFICE_MCP_PACKAGE_SPEC],
            env: {
              MCP_OFFICE_SIDECAR_STATE: '{{MCP_CONFIG_DIR}}/sidecar-state.json',
            },
          },
        },
        {
          id: 'bundled-retell-ai',
          provider: 'rebel-oss',
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-retell-ai@0.2.1'],
            env: {
              RETELL_API_KEY: '{{RETELL_API_KEY}}',
              MCP_HOST_BRIDGE_STATE: '{{MCP_BASE_DIR}}/rebel-inbox-bridge.json',
            },
          },
        },
        {
          id: 'bundled-elevenlabs',
          provider: 'rebel-oss',
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-elevenlabs@0.1.0'],
            env: {
              ELEVENLABS_API_KEY: '{{ELEVENLABS_API_KEY}}',
            },
          },
        },
        {
          id: 'bundled-hubspot',
          provider: 'rebel-oss',
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'],
            env: {
              HUBSPOT_SCOPE_TIER: '{{HUBSPOT_SCOPE_TIER}}',
              LOG_MODE: 'strict',
            },
          },
        },
      ];

      const makeManagedEntry = (managedInstallsRoot: string, spec: string) => ({
        name: 'Zendesk',
        type: 'stdio',
        command: 'node',
        args: [
          path.join(
            managedInstallsRoot,
            spec,
            'node_modules',
            '@mindstone-engineering',
            'mcp-server-zendesk',
            'dist',
            'index.js',
          ),
        ],
        env: {
          ZENDESK_CONFIG_PATH: '/Users/alice/Library/Application Support/mindstone-rebel/mcp/zendesk',
          LOG_MODE: 'strict',
        },
        catalogId: 'bundled-zendesk',
        email: 'alice@example.com',
        description: 'alice@example.com - Zendesk tickets',
        lastConnectedAt: 1712345678000,
      });

      it('rewrites a managed entry back to its catalog npx form and merges env with catalog placeholders winning over user-resolved paths', () => {
        const managedInstallsRoot = path.join(tempUserData, 'mcp', 'managed-installs');
        const spec = '@mindstone-engineering/mcp-server-zendesk@0.3.0';
        const managedEntry = makeManagedEntry(managedInstallsRoot, spec);
        const servers: Record<string, Record<string, unknown>> = { Zendesk: { ...managedEntry } };

        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(servers, managedInstallsRoot, catalog);

        expect(rewritten).toBe(1);
        expect(servers.Zendesk.command).toBe('npx');
        expect(servers.Zendesk.args).toEqual([
          '-y',
          '@mindstone-engineering/mcp-server-zendesk@0.3.0',
        ]);
        expect(servers.Zendesk.type).toBe('stdio');
        // ZENDESK_CONFIG_PATH: user resolved to a desktop-local absolute path,
        // catalog has the portable placeholder. Catalog wins (path-leak
        // protection — cloud has its own MCP_CONFIG_DIR).
        // LOG_MODE: catalog declares a literal, not a placeholder, so it
        // never accepts a user override.
        expect(servers.Zendesk.env).toEqual({
          ZENDESK_CONFIG_PATH: '{{MCP_CONFIG_DIR}}',
          LOG_MODE: 'strict',
        });
        // Identity preserved
        expect(servers.Zendesk.catalogId).toBe('bundled-zendesk');
        expect(servers.Zendesk.email).toBe('alice@example.com');
        expect(servers.Zendesk.description).toBe('alice@example.com - Zendesk tickets');
        expect(servers.Zendesk.lastConnectedAt).toBe(1712345678000);
      });

      it('drops env when catalog entry has no env defined', () => {
        const managedInstallsRoot = path.join(tempUserData, 'mcp', 'managed-installs');
        const spec = '@mindstone-engineering/mcp-server-freshdesk@0.2.0';
        const entryPath = path.join(
          managedInstallsRoot,
          spec,
          'node_modules',
          '@mindstone-engineering',
          'mcp-server-freshdesk',
          'dist',
          'index.js',
        );
        const servers: Record<string, Record<string, unknown>> = {
          Freshdesk: {
            name: 'Freshdesk',
            type: 'stdio',
            command: 'node',
            args: [entryPath],
            env: { SOMETHING_LOCAL: '/Users/alice/stuff' },
            catalogId: 'bundled-freshdesk',
          },
        };

        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(servers, managedInstallsRoot, catalog);

        expect(rewritten).toBe(1);
        expect(servers.Freshdesk.command).toBe('npx');
        // Catalog entry has no env at all; nothing to replace with, so drop.
        expect(servers.Freshdesk.env).toBeUndefined();
      });

      it('rewrites a managed Office entry back to npx form with sidecar state env placeholder (path-leak protection)', () => {
        const managedInstallsRoot = path.join(tempUserData, 'mcp', 'managed-installs');
        const spec = OFFICE_MCP_PACKAGE_SPEC;
        const entryPath = path.join(
          managedInstallsRoot,
          spec,
          'node_modules',
          '@mindstone-engineering',
          'mcp-server-office',
          'dist',
          'index.js',
        );
        const servers: Record<string, Record<string, unknown>> = {
          RebelOffice: {
            name: 'RebelOffice',
            type: 'stdio',
            command: 'node',
            args: [entryPath],
            env: {
              MCP_OFFICE_SIDECAR_STATE: path.join(tempUserData, 'mcp', 'rebeloffice', 'sidecar-state.json'),
            },
            catalogId: 'bundled-office',
          },
        };

        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(servers, managedInstallsRoot, catalog);

        expect(rewritten).toBe(1);
        expect(servers.RebelOffice?.command).toBe('npx');
        expect(servers.RebelOffice?.args).toEqual([
          '-y',
          OFFICE_MCP_PACKAGE_SPEC,
        ]);
        // User-resolved absolute path is rejected; catalog placeholder wins
        // so cloud re-resolves to its own sidecar location.
        expect(servers.RebelOffice?.env).toEqual({
          MCP_OFFICE_SIDECAR_STATE: '{{MCP_CONFIG_DIR}}/sidecar-state.json',
        });
      });

      it('preserves user-set api-key literal for Retell AI (preserves credential through cloud sync)', () => {
        const managedInstallsRoot = path.join(tempUserData, 'mcp', 'managed-installs');
        const spec = '@mindstone/mcp-server-retell-ai@0.2.1';
        const entryPath = path.join(
          managedInstallsRoot,
          spec,
          'node_modules',
          '@mindstone',
          'mcp-server-retell-ai',
          'dist',
          'index.js',
        );
        const servers: Record<string, Record<string, unknown>> = {
          'Retell AI': {
            name: 'Retell AI',
            type: 'stdio',
            command: 'node',
            args: [entryPath],
            env: {
              RETELL_API_KEY: 'key_real_user_provided_secret',
              MCP_HOST_BRIDGE_STATE: path.join(tempUserData, 'mcp', 'rebel-inbox-bridge.json'),
            },
            catalogId: 'bundled-retell-ai',
          },
        };

        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(servers, managedInstallsRoot, catalog);

        expect(rewritten).toBe(1);
        const env = servers['Retell AI']?.env as Record<string, string>;
        // The api-key literal must survive — cloud has no other transport
        // for setup-field secrets in this cohort.
        expect(env.RETELL_API_KEY).toBe('key_real_user_provided_secret');
        // MCP_HOST_BRIDGE_STATE is INTERNAL_ENV_KEYS — catalog placeholder
        // always wins so cloud doesn't see the desktop's absolute bridge
        // state path.
        expect(env.MCP_HOST_BRIDGE_STATE).toBe('{{MCP_BASE_DIR}}/rebel-inbox-bridge.json');
      });

      it('preserves user-set api-key literal for ElevenLabs (cohort coverage)', () => {
        const managedInstallsRoot = path.join(tempUserData, 'mcp', 'managed-installs');
        const spec = '@mindstone/mcp-server-elevenlabs@0.1.0';
        const entryPath = path.join(
          managedInstallsRoot,
          spec,
          'node_modules',
          '@mindstone',
          'mcp-server-elevenlabs',
          'dist',
          'index.js',
        );
        const servers: Record<string, Record<string, unknown>> = {
          ElevenLabs: {
            name: 'ElevenLabs',
            type: 'stdio',
            command: 'node',
            args: [entryPath],
            env: {
              ELEVENLABS_API_KEY: 'sk_eleven_real_user_secret',
            },
            catalogId: 'bundled-elevenlabs',
          },
        };

        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(servers, managedInstallsRoot, catalog);

        expect(rewritten).toBe(1);
        const env = servers.ElevenLabs?.env as Record<string, string>;
        expect(env.ELEVENLABS_API_KEY).toBe('sk_eleven_real_user_secret');
      });

      it('preserves runtime-injected literal for HubSpot scope tier', () => {
        const managedInstallsRoot = path.join(tempUserData, 'mcp', 'managed-installs');
        const spec = '@mindstone/mcp-server-hubspot@0.2.0';
        const entryPath = path.join(
          managedInstallsRoot,
          spec,
          'node_modules',
          '@mindstone',
          'mcp-server-hubspot',
          'dist',
          'index.js',
        );
        const servers: Record<string, Record<string, unknown>> = {
          HubSpot: {
            name: 'HubSpot',
            type: 'stdio',
            command: 'node',
            args: [entryPath],
            env: {
              HUBSPOT_SCOPE_TIER: 'full',
            },
            catalogId: 'bundled-hubspot',
          },
        };

        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(servers, managedInstallsRoot, catalog);

        expect(rewritten).toBe(1);
        const env = servers.HubSpot?.env as Record<string, string>;
        // Runtime-injected literal survives because catalog declares a
        // matching placeholder slot.
        expect(env.HUBSPOT_SCOPE_TIER).toBe('full');
        // Catalog literal wins for non-placeholder slots.
        expect(env.LOG_MODE).toBe('strict');
      });

      it('drops user env keys not present in the catalog (stale-leak prevention)', () => {
        const managedInstallsRoot = path.join(tempUserData, 'mcp', 'managed-installs');
        const spec = '@mindstone/mcp-server-retell-ai@0.2.1';
        const entryPath = path.join(
          managedInstallsRoot,
          spec,
          'node_modules',
          '@mindstone',
          'mcp-server-retell-ai',
          'dist',
          'index.js',
        );
        const servers: Record<string, Record<string, unknown>> = {
          'Retell AI': {
            name: 'Retell AI',
            type: 'stdio',
            command: 'node',
            args: [entryPath],
            env: {
              RETELL_API_KEY: 'key_real_user_provided_secret',
              STALE_LEGACY_ENV_KEY: 'should-not-leak-to-cloud',
              ANOTHER_NON_CATALOG_KEY: 'also-dropped',
            },
            catalogId: 'bundled-retell-ai',
          },
        };

        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(servers, managedInstallsRoot, catalog);

        expect(rewritten).toBe(1);
        const env = servers['Retell AI']?.env as Record<string, string>;
        expect(Object.keys(env).sort()).toEqual(
          ['MCP_HOST_BRIDGE_STATE', 'RETELL_API_KEY'].sort(),
        );
        expect(env).not.toHaveProperty('STALE_LEGACY_ENV_KEY');
        expect(env).not.toHaveProperty('ANOTHER_NON_CATALOG_KEY');
      });

      it('drops managed-installs absolute paths in non-credential keys (managed-install path-leak prevention)', () => {
        const managedInstallsRoot = path.join(tempUserData, 'mcp', 'managed-installs');
        const spec = '@mindstone-engineering/mcp-server-zendesk@0.3.0';
        const managedEntry = makeManagedEntry(managedInstallsRoot, spec);
        // Replace the user-resolved config path with an absolute path under
        // the managed-installs root — simulating a hand-edited config that
        // copied a managed-installs path into a config slot.
        const sneakyPath = path.join(managedInstallsRoot, 'something', 'cache', 'state.json');
        const servers: Record<string, Record<string, unknown>> = {
          Zendesk: {
            ...managedEntry,
            env: {
              ...managedEntry.env,
              ZENDESK_CONFIG_PATH: sneakyPath,
            },
          },
        };

        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(servers, managedInstallsRoot, catalog);

        expect(rewritten).toBe(1);
        const env = servers.Zendesk?.env as Record<string, string>;
        expect(env.ZENDESK_CONFIG_PATH).toBe('{{MCP_CONFIG_DIR}}');
      });

      it('drops Windows UNC absolute paths in non-credential keys (Windows path-leak prevention)', () => {
        const managedInstallsRoot = path.join(tempUserData, 'mcp', 'managed-installs');
        const spec = '@mindstone-engineering/mcp-server-zendesk@0.3.0';
        const managedEntry = makeManagedEntry(managedInstallsRoot, spec);
        // Hand-edited Windows config could carry a UNC path
        // (`\\server\share\zendesk`) in a slot the catalog declares as a
        // portable placeholder. The cloud has no notion of the Windows
        // server, so the catalog placeholder must win.
        const uncPath = '\\\\server\\share\\zendesk';
        const servers: Record<string, Record<string, unknown>> = {
          Zendesk: {
            ...managedEntry,
            env: {
              ...managedEntry.env,
              ZENDESK_CONFIG_PATH: uncPath,
            },
          },
        };

        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(servers, managedInstallsRoot, catalog);

        expect(rewritten).toBe(1);
        const env = servers.Zendesk?.env as Record<string, string>;
        expect(env.ZENDESK_CONFIG_PATH).toBe('{{MCP_CONFIG_DIR}}');
      });

      it('leaves npx entries untouched', () => {
        const managedInstallsRoot = path.join(tempUserData, 'mcp', 'managed-installs');
        const servers: Record<string, Record<string, unknown>> = {
          Zendesk: {
            command: 'npx',
            args: ['-y', '@mindstone-engineering/mcp-server-zendesk@0.3.0'],
            catalogId: 'bundled-zendesk',
          },
        };

        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(servers, managedInstallsRoot, catalog);

        expect(rewritten).toBe(0);
        expect(servers.Zendesk.command).toBe('npx');
      });

      it('leaves node entries that are NOT under the managed installs root untouched', () => {
        const managedInstallsRoot = path.join(tempUserData, 'mcp', 'managed-installs');
        const servers: Record<string, Record<string, unknown>> = {
          CustomNode: {
            command: 'node',
            args: ['/tmp/some/other/node/script.js'],
            catalogId: 'bundled-zendesk',
          },
        };

        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(servers, managedInstallsRoot, catalog);

        expect(rewritten).toBe(0);
        expect(servers.CustomNode.command).toBe('node');
      });

      it('skips managed entries whose catalogId is unknown', () => {
        const managedInstallsRoot = path.join(tempUserData, 'mcp', 'managed-installs');
        const servers: Record<string, Record<string, unknown>> = {
          Zendesk: {
            command: 'node',
            args: [path.join(managedInstallsRoot, 'unknown-pkg@1.0.0', 'node_modules', 'unknown', 'index.js')],
            catalogId: 'not-in-catalog',
          },
        };

        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(servers, managedInstallsRoot, catalog);

        expect(rewritten).toBe(0);
        expect(servers.Zendesk.command).toBe('node');
      });
    });

    it('cleans up legacy node entries while leaving a managed-install entry at the target name intact', async () => {
      const managedEntryPath = path.join(
        tempUserData,
        'mcp',
        'managed-installs',
        '@mindstone-engineering',
        'mcp-server-freshdesk@0.2.0',
        'node_modules',
        '@mindstone-engineering',
        'mcp-server-freshdesk',
        'dist',
        'index.js',
      );

      const configPath = await writeConfig('managed-install-coexistence.json', {
        mcpServers: {
          // Stale legacy bundled entry under a legacy name (old bundled node path).
          'Freshdesk-user-example': {
            command: 'node',
            args: ['/path/to/resources/mcp/freshdesk/build/index.js'],
            catalogId: 'bundled-freshdesk',
            email: 'user@example.com',
            lastConnectedAt: 1711111111000,
          },
          // Managed install already wired up at the canonical Freshdesk name.
          Freshdesk: {
            command: 'node',
            args: [managedEntryPath],
            catalogId: 'bundled-freshdesk',
            email: 'user@example.com',
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath, undefined);

      expect(result.migrated).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers['Freshdesk-user-example']).toBeUndefined();
      expect(servers.Freshdesk.command).toBe('node');
      expect(servers.Freshdesk.args).toEqual([managedEntryPath]);
    });

    // Regression coverage for REBEL-13Y: pre-OSS-migration Salesforce entries
    // were never given a catalogId and never picked up by this migration, so
    // their stale `command: 'node'` paths persisted on disk and produced
    // -32000 Connection closed → -33004 PACKAGE_UNAVAILABLE on every spawn.
    // These tests assume the matching entries already have catalogId stamped
    // (the backfill step in mcpConfigManager that runs immediately before
    // this migration). The catalogId backfill is covered separately in
    // mcpConfigManager.test.ts.

    it('migrates legacy base Salesforce entry to npx', async () => {
      const configPath = await writeConfig('salesforce-base.json', {
        mcpServers: {
          Salesforce: {
            command: 'node',
            args: ['/legacy/path/mcp-generated/salesforce/server.cjs'],
            catalogId: 'bundled-salesforce',
            email: 'user@example.com',
            description: 'user@example.com - Salesforce',
            lastConnectedAt: 1712345678000,
            env: {
              SALESFORCE_CLIENT_ID: 'fake-client-id',
              SALESFORCE_CLIENT_SECRET: 'fake-client-secret',
            },
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath);

      expect(result.migrated).toHaveLength(1);
      expect(result.migrated[0]).toEqual({
        catalogId: 'bundled-salesforce',
        oldNames: ['Salesforce'],
        newName: 'Salesforce',
      });

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers.Salesforce.command).toBe('npx');
      expect(servers.Salesforce.args).toEqual([
        '-y',
        '@mindstone-engineering/mcp-server-salesforce@0.1.1',
      ]);
      expect(servers.Salesforce.catalogId).toBe('bundled-salesforce');
      expect(servers.Salesforce.email).toBe('user@example.com');
      expect(servers.Salesforce.lastConnectedAt).toBe(1712345678000);

      // User-supplied OAuth credentials must survive the rewrite.
      const env = servers.Salesforce.env as Record<string, string>;
      expect(env.SALESFORCE_CLIENT_ID).toBe('fake-client-id');
      expect(env.SALESFORCE_CLIENT_SECRET).toBe('fake-client-secret');
      // All catalog env keys for Salesforce must end up on the new entry.
      expect(env.MCP_BRIDGE_CONFIGURE_ENDPOINT).toBe('/bundled/salesforce/start-auth');
      expect(env.SALESFORCE_CONFIG_DIR).toBeTruthy();
      expect(env.MCP_HOST_BRIDGE_STATE).toBeTruthy();
    });

    it('migrates legacy email-suffixed Salesforce-<email> to base Salesforce', async () => {
      const configPath = await writeConfig('salesforce-suffixed.json', {
        mcpServers: {
          'Salesforce-user-example-com': {
            command: 'node',
            args: ['/legacy/path/mcp-generated/salesforce/server.cjs'],
            catalogId: 'bundled-salesforce',
            email: 'user@example.com',
            lastConnectedAt: 1712345678000,
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath);

      expect(result.migrated).toHaveLength(1);
      expect(result.migrated[0].oldNames).toEqual(['Salesforce-user-example-com']);
      expect(result.migrated[0].newName).toBe('Salesforce');

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers['Salesforce-user-example-com']).toBeUndefined();
      expect(servers.Salesforce.command).toBe('npx');
      expect(servers.Salesforce.email).toBe('user@example.com');
    });

    it('unions env across duplicate legacy Salesforce entries so OAuth creds on the older entry survive', async () => {
      // Real-world hazard discovered during Phase 6 review: when the user has
      // both a legacy `Salesforce-<email>` and a legacy base `Salesforce`,
      // OAuth client credentials may live on only one of them. Migration must
      // union env across all duplicate entries (not just the bestCandidate by
      // lastConnectedAt) or those creds get silently dropped at migration time
      // and the user is forced to re-auth via the bridge.
      const configPath = await writeConfig('salesforce-creds-on-older.json', {
        mcpServers: {
          'Salesforce-user-example-com': {
            // OLDER entry — has the OAuth client creds.
            command: 'node',
            args: ['/legacy/old.cjs'],
            catalogId: 'bundled-salesforce',
            email: 'user@example.com',
            lastConnectedAt: 1000,
            env: {
              SALESFORCE_CLIENT_ID: 'creds-on-older',
              SALESFORCE_CLIENT_SECRET: 'secret-on-older',
            },
          },
          Salesforce: {
            // NEWER entry (bestCandidate by lastConnectedAt) — but missing creds.
            command: 'node',
            args: ['/legacy/old.cjs'],
            catalogId: 'bundled-salesforce',
            email: 'user@example.com',
            lastConnectedAt: 2000,
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath);

      expect(result.migrated).toHaveLength(1);
      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.Salesforce.env as Record<string, string>;
      expect(env.SALESFORCE_CLIENT_ID).toBe('creds-on-older');
      expect(env.SALESFORCE_CLIENT_SECRET).toBe('secret-on-older');
    });

    it('newer entry env wins ties when unioning across duplicate legacy entries', async () => {
      // Companion to the union test above: when both duplicate legacy entries
      // hold the same key, the bestCandidate (newer) must win — otherwise the
      // user's most recent auth state would silently be overwritten by stale
      // values.
      const configPath = await writeConfig('salesforce-creds-conflict.json', {
        mcpServers: {
          'Salesforce-user-example-com': {
            command: 'node',
            args: ['/legacy/old.cjs'],
            catalogId: 'bundled-salesforce',
            email: 'user@example.com',
            lastConnectedAt: 1000,
            env: { SALESFORCE_CLIENT_ID: 'older-stale-id' },
          },
          Salesforce: {
            command: 'node',
            args: ['/legacy/old.cjs'],
            catalogId: 'bundled-salesforce',
            email: 'user@example.com',
            lastConnectedAt: 2000,
            env: { SALESFORCE_CLIENT_ID: 'newer-current-id' },
          },
        },
      });

      await migrateBundledConnectorsToNpx(configPath);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      const env = servers.Salesforce.env as Record<string, string>;
      expect(env.SALESFORCE_CLIENT_ID).toBe('newer-current-id');
    });

    it('converges legacy base + legacy suffixed Salesforce entries to a single base npx entry', async () => {
      // Mirrors the actual REBEL-13Y cohort observation: many users had BOTH
      // a legacy `Salesforce` and a legacy `Salesforce-<email>` entry on disk
      // and Sentry showed -33004 events under both names within seconds of
      // each other. Migration must collapse them onto the catalogEntry.name
      // base key, picking the most recently used as authoritative.
      const configPath = await writeConfig('salesforce-both-legacy.json', {
        mcpServers: {
          Salesforce: {
            command: 'node',
            args: ['/legacy/old.cjs'],
            catalogId: 'bundled-salesforce',
            email: 'older@example.com',
            lastConnectedAt: 1000,
          },
          'Salesforce-newer-example-com': {
            command: 'node',
            args: ['/legacy/old.cjs'],
            catalogId: 'bundled-salesforce',
            email: 'newer@example.com',
            lastConnectedAt: 2000,
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath);

      expect(result.migrated).toHaveLength(1);
      expect(result.migrated[0].oldNames.sort()).toEqual(
        ['Salesforce', 'Salesforce-newer-example-com'].sort(),
      );
      expect(result.migrated[0].newName).toBe('Salesforce');

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expect(servers['Salesforce-newer-example-com']).toBeUndefined();
      expect(servers.Salesforce.command).toBe('npx');
      // Most recently used wins identity preservation.
      expect(servers.Salesforce.email).toBe('newer@example.com');
      expect(servers.Salesforce.lastConnectedAt).toBe(2000);
    });

    it('does not double-rewrite an already-migrated Salesforce npx entry', async () => {
      const configPath = await writeConfig('salesforce-already-npx.json', {
        mcpServers: {
          Salesforce: {
            command: 'npx',
            args: ['-y', '@mindstone-engineering/mcp-server-salesforce@0.1.1'],
            catalogId: 'bundled-salesforce',
            email: 'user@example.com',
            lastConnectedAt: 1712345678000,
          },
        },
      });
      const before = await fs.readFile(configPath, 'utf8');

      const result = await migrateBundledConnectorsToNpx(configPath);

      expect(result.migrated).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
      const after = await fs.readFile(configPath, 'utf8');
      expect(after).toBe(before);
    });

    it('preserves a post-OAuth-bridge npx Salesforce entry while cleaning legacy suffixed entry', async () => {
      // Reproduces the real-world post-`/bundled/salesforce/start-auth` state:
      // the bridge wrote a base `Salesforce` npx entry with the bridge env, but
      // the user's legacy email-suffixed entry was never cleaned up. Migration
      // must NOT overwrite the bridge entry; it must only delete the stale
      // legacy entry. Otherwise we'd lose the bridge-specific env (incl.
      // SALESFORCE_CLIENT_ID/SECRET injected by R5d).
      const configPath = await writeConfig('salesforce-bridge-coexistence.json', {
        mcpServers: {
          Salesforce: {
            command: 'npx',
            args: ['-y', '@mindstone-engineering/mcp-server-salesforce@0.1.1'],
            catalogId: 'bundled-salesforce',
            email: 'user@example.com',
            env: {
              SALESFORCE_CONFIG_DIR: '/some/bridge/config',
              SALESFORCE_CLIENT_ID: 'bridge-injected-id',
              SALESFORCE_CLIENT_SECRET: 'bridge-injected-secret',
              MCP_BRIDGE_CONFIGURE_ENDPOINT: '/bundled/salesforce/start-auth',
            },
            lastConnectedAt: 5000,
          },
          'Salesforce-user-example-com': {
            command: 'node',
            args: ['/legacy/path.cjs'],
            catalogId: 'bundled-salesforce',
            email: 'user@example.com',
            lastConnectedAt: 1000,
          },
        },
      });

      const result = await migrateBundledConnectorsToNpx(configPath);

      const config = await readConfig(configPath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;

      // Legacy entry deleted.
      expect(servers['Salesforce-user-example-com']).toBeUndefined();

      // Bridge entry preserved verbatim.
      expect(servers.Salesforce.command).toBe('npx');
      expect(servers.Salesforce.lastConnectedAt).toBe(5000);
      const env = servers.Salesforce.env as Record<string, string>;
      expect(env.SALESFORCE_CLIENT_ID).toBe('bridge-injected-id');
      expect(env.SALESFORCE_CLIENT_SECRET).toBe('bridge-injected-secret');
      expect(env.SALESFORCE_CONFIG_DIR).toBe('/some/bridge/config');

      // The migration's "already migrated, just clean up legacy" branch records
      // a migrated entry to capture the legacy-cleanup work, but the existing
      // bridge entry at `newName` is preserved untouched (the only side effect
      // is deleting the orphaned legacy key, asserted above).
      expect(result.migrated).toHaveLength(1);
      expect(result.migrated[0].oldNames).toEqual(['Salesforce-user-example-com']);
      expect(result.migrated[0].newName).toBe('Salesforce');
    });

  });

  describe('pruneStaleHubSpotRefreshEnv (260517)', () => {
    let pruneTempDir: string;

    beforeAll(async () => {
      pruneTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindstone-prune-stale-hubspot-'));
    });

    afterAll(async () => {
      await fs.rm(pruneTempDir, { recursive: true, force: true }).catch(() => undefined);
    });

    const writeConfig = async (name: string, config: unknown): Promise<string> => {
      const configPath = path.join(pruneTempDir, name);
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
      return configPath;
    };

    const readConfig = async (configPath: string): Promise<Record<string, unknown>> => {
      const raw = await fs.readFile(configPath, 'utf8');
      return JSON.parse(raw);
    };

    it('strips DISABLE_REFRESH and ALLOW_CLOUD_REFRESH from an npx-shaped HubSpot entry, preserving other env', async () => {
      const configPath = await writeConfig('npx-stale.json', {
        mcpServers: {
          'HubSpot-user-example-com': {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'],
            type: 'stdio',
            catalogId: 'bundled-hubspot',
            email: 'user@example.com',
            env: {
              HUBSPOT_CONFIG_DIR: '/some/dir',
              HUBSPOT_DISABLE_REFRESH: '1',
              HUBSPOT_ALLOW_CLOUD_REFRESH: '0',
              HUBSPOT_ACCOUNT_EMAIL: 'user@example.com',
              LOG_MODE: 'strict',
            },
          },
        },
      });

      const result = await pruneStaleHubSpotRefreshEnv(configPath);
      expect(result.pruned).toHaveLength(1);
      expect(result.pruned[0].name).toBe('HubSpot-user-example-com');
      expect(result.pruned[0].removed.sort()).toEqual([
        'HUBSPOT_ALLOW_CLOUD_REFRESH',
        'HUBSPOT_DISABLE_REFRESH',
      ]);

      const config = await readConfig(configPath);
      const env = (config.mcpServers as Record<string, Record<string, unknown>>)['HubSpot-user-example-com'].env as Record<string, string>;
      expect(env).not.toHaveProperty('HUBSPOT_DISABLE_REFRESH');
      expect(env).not.toHaveProperty('HUBSPOT_ALLOW_CLOUD_REFRESH');
      expect(env.HUBSPOT_CONFIG_DIR).toBe('/some/dir');
      expect(env.HUBSPOT_ACCOUNT_EMAIL).toBe('user@example.com');
      expect(env.LOG_MODE).toBe('strict');
    });

    it('strips stale flags from a managed-install HubSpot entry (command: node under managedInstallsRoot)', async () => {
      const managedRoot = path.join(tempUserData, 'mcp', 'managed-installs');
      const managedEntryPath = path.join(
        managedRoot,
        '@mindstone',
        'mcp-server-hubspot@0.2.0',
        'node_modules',
        '@mindstone',
        'mcp-server-hubspot',
        'dist',
        'index.js',
      );
      const configPath = await writeConfig('managed-stale.json', {
        mcpServers: {
          'HubSpot-managed-example-com': {
            command: 'node',
            args: [managedEntryPath],
            type: 'stdio',
            catalogId: 'bundled-hubspot',
            email: 'managed@example.com',
            env: {
              HUBSPOT_CONFIG_DIR: '/some/dir',
              HUBSPOT_DISABLE_REFRESH: '1',
              HUBSPOT_ALLOW_CLOUD_REFRESH: '0',
              HUBSPOT_ACCOUNT_EMAIL: 'managed@example.com',
            },
          },
        },
      });

      const result = await pruneStaleHubSpotRefreshEnv(configPath);
      expect(result.pruned).toHaveLength(1);
      expect(result.pruned[0].name).toBe('HubSpot-managed-example-com');

      const config = await readConfig(configPath);
      const entry = (config.mcpServers as Record<string, Record<string, unknown>>)['HubSpot-managed-example-com'];
      expect(entry.command).toBe('node');
      expect(entry.args).toEqual([managedEntryPath]);
      const env = entry.env as Record<string, string>;
      expect(env).not.toHaveProperty('HUBSPOT_DISABLE_REFRESH');
      expect(env).not.toHaveProperty('HUBSPOT_ALLOW_CLOUD_REFRESH');
      expect(env.HUBSPOT_ACCOUNT_EMAIL).toBe('managed@example.com');
    });

    it('is idempotent: a clean HubSpot entry produces no writes and pruned=[]', async () => {
      const configPath = await writeConfig('npx-clean.json', {
        mcpServers: {
          'HubSpot-clean-example-com': {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'],
            type: 'stdio',
            catalogId: 'bundled-hubspot',
            email: 'clean@example.com',
            env: {
              HUBSPOT_CONFIG_DIR: '/some/dir',
              HUBSPOT_ACCOUNT_EMAIL: 'clean@example.com',
            },
          },
        },
      });

      const result = await pruneStaleHubSpotRefreshEnv(configPath);
      expect(result.pruned).toHaveLength(0);
    });

    it('skips non-HubSpot entries even when they carry the same env keys (defensive)', async () => {
      const configPath = await writeConfig('non-hubspot.json', {
        mcpServers: {
          SomeOtherServer: {
            command: 'npx',
            args: ['-y', '@example/something'],
            type: 'stdio',
            catalogId: 'bundled-other',
            env: {
              HUBSPOT_DISABLE_REFRESH: '1',
              HUBSPOT_ALLOW_CLOUD_REFRESH: '0',
              OTHER_KEY: 'value',
            },
          },
        },
      });

      const result = await pruneStaleHubSpotRefreshEnv(configPath);
      expect(result.pruned).toHaveLength(0);

      const config = await readConfig(configPath);
      const env = (config.mcpServers as Record<string, Record<string, unknown>>).SomeOtherServer.env as Record<string, string>;
      expect(env.HUBSPOT_DISABLE_REFRESH).toBe('1');
      expect(env.OTHER_KEY).toBe('value');
    });

    it('handles entries with missing / non-object env shape without throwing', async () => {
      const configPath = await writeConfig('weird-env.json', {
        mcpServers: {
          'HubSpot-no-env': {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'],
            type: 'stdio',
            catalogId: 'bundled-hubspot',
          },
          'HubSpot-null-env': {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'],
            type: 'stdio',
            catalogId: 'bundled-hubspot',
            env: null,
          },
          'HubSpot-array-env': {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-hubspot@0.2.0'],
            type: 'stdio',
            catalogId: 'bundled-hubspot',
            env: ['oops'],
          },
        },
      });

      const result = await pruneStaleHubSpotRefreshEnv(configPath);
      expect(result.pruned).toHaveLength(0);
    });

    it('returns empty pruned list when config file is missing or has no mcpServers', async () => {
      const missingPath = path.join(pruneTempDir, 'missing.json');
      const result = await pruneStaleHubSpotRefreshEnv(missingPath);
      expect(result.pruned).toHaveLength(0);

      const emptyPath = await writeConfig('empty.json', {});
      const result2 = await pruneStaleHubSpotRefreshEnv(emptyPath);
      expect(result2.pruned).toHaveLength(0);
    });

    it('skips legacy `command: node` HubSpot entries that are NOT under managedInstallsRoot (those are bundled-source legacy, handled by migrateBundledConnectorsToNpx instead)', async () => {
      // The pruner only touches npx + managed-install entries because those
      // are the post-260517 shapes the OSS subprocess actually spawns from.
      // Legacy `command: node` pointing at bundled `resources/mcp/...` is
      // covered by migrateBundledConnectorsToNpx upstream of this pass.
      const configPath = await writeConfig('legacy-node.json', {
        mcpServers: {
          'HubSpot-legacy': {
            command: 'node',
            args: ['/some/random/path/server.js'],
            type: 'stdio',
            catalogId: 'bundled-hubspot',
            env: {
              HUBSPOT_DISABLE_REFRESH: '1',
              HUBSPOT_ALLOW_CLOUD_REFRESH: '0',
            },
          },
        },
      });

      const result = await pruneStaleHubSpotRefreshEnv(configPath);
      expect(result.pruned).toHaveLength(0);
    });
  });
});
