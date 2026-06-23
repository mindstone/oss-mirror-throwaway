import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock oauthCredentials to provide controlled credential responses
const mockGoogleCreds = { clientId: 'google-client-id', clientSecret: 'google-client-secret' };
const mockHubSpotCreds = { clientId: 'hubspot-client-id', clientSecret: 'hubspot-client-secret' };
const mockMicrosoftClientId = 'ms-client-id';
const mockTelemetrySaltHex = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const mockSlackCreds = { clientId: 'slack-client-id', clientSecret: 'slack-client-secret' };

vi.mock('../oauthCredentials', () => ({
  resolveOAuthCredentials: vi.fn((source: { provider: string }) => {
    if (source.provider === 'google') return mockGoogleCreds;
    if (source.provider === 'hubspot') return mockHubSpotCreds;
    if (source.provider === 'slack') return mockSlackCreds;
    return null;
  }),
  resolveMicrosoftClientId: vi.fn(() => mockMicrosoftClientId),
  googleCredentialSource: { provider: 'google' },
  hubspotCredentialSource: { provider: 'hubspot' },
  slackCredentialSource: { provider: 'slack' },
  microsoftCredentialSource: { provider: 'microsoft' },
}));

vi.mock('../hubspotAuthService', () => ({
  getStoredScopeTier: vi.fn(async (email?: string) => {
    if (process.env.HUBSPOT_SCOPE_TIER === 'readonly' || process.env.HUBSPOT_SCOPE_TIER === 'full') {
      return process.env.HUBSPOT_SCOPE_TIER;
    }
    return email?.includes('second') || email?.includes('acct2') ? 'full' : 'readonly';
  }),
}));

vi.mock('../hubspotTelemetry', () => ({
  getTelemetrySaltHex: vi.fn(async () => mockTelemetrySaltHex),
}));

// Mock bundledMcpManager to avoid dependency on configureBundledMcpManager
vi.mock('../bundledMcpManager', () => ({
  buildGoogleWorkspaceInstancePayload: vi.fn((config: {
    instanceId: string;
    email: string;
    clientId: string;
    clientSecret: string;
    accountsPath: string;
    credentialsPath: string;
  }) => ({
    name: config.instanceId,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@mindstone/mcp-server-google-workspace@0.1.3'],
    email: config.email,
    catalogId: 'bundled-google',
    env: {
      GOOGLE_CLIENT_ID: config.clientId,
      GOOGLE_CLIENT_SECRET: config.clientSecret,
      ACCOUNTS_PATH: config.accountsPath,
      CREDENTIALS_PATH: config.credentialsPath,
      MCP_MODE: 'true',
      LOG_MODE: 'strict',
    },
  })),
  buildSlackInstancePayload: vi.fn((config: {
    teamId: string;
    teamName: string;
    botToken: string;
    userToken?: string;
    configPath: string;
    clientId?: string;
    clientSecret?: string;
  }) => ({
    name: `Slack-${config.teamName.toLowerCase()}`,
    transport: 'stdio',
    command: 'node',
    args: ['/app/resources/mcp-generated/slack/server.cjs'],
    workspace: config.teamName,
    catalogId: 'bundled-slack',
    env: {
      SLACK_BOT_TOKEN: config.botToken,
      ...(config.userToken ? { SLACK_USER_TOKEN: config.userToken } : {}),
      SLACK_CONFIG_PATH: config.configPath,
      SLACK_TEAM_ID: config.teamId,
      ...(config.clientId ? { SLACK_CLIENT_ID: config.clientId } : {}),
      ...(config.clientSecret ? { SLACK_CLIENT_SECRET: config.clientSecret } : {}),
    },
  })),
  buildMicrosoft365MailPayload: vi.fn(() => ({
    name: 'Microsoft365Mail',
    transport: 'stdio',
    command: 'node',
    args: ['/app/resources/mcp-generated/microsoft-mail/server.cjs'],
    catalogId: 'bundled-microsoft-mail',
  })),
  buildMicrosoft365CalendarPayload: vi.fn(() => ({
    name: 'Microsoft365Calendar',
    transport: 'stdio',
    command: 'node',
    catalogId: 'bundled-microsoft-calendar',
  })),
  buildMicrosoft365FilesPayload: vi.fn(() => ({
    name: 'Microsoft365Files',
    transport: 'stdio',
    command: 'node',
    catalogId: 'bundled-microsoft-files',
  })),
  buildMicrosoft365TeamsPayload: vi.fn(() => ({
    name: 'Microsoft365Teams',
    transport: 'stdio',
    command: 'node',
    catalogId: 'bundled-microsoft-teams',
  })),
  buildMicrosoft365SharePointPayload: vi.fn(() => ({
    name: 'Microsoft365SharePoint',
    transport: 'stdio',
    command: 'node',
    catalogId: 'bundled-microsoft-sharepoint',
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { discoverBundledOAuthMcps } from '../bundledMcpCloudRegistration';
import { resolveOAuthCredentials, resolveMicrosoftClientId } from '../oauthCredentials';
import {
  buildGoogleWorkspaceInstancePayload,
  buildSlackInstancePayload,
  buildMicrosoft365MailPayload,
} from '../bundledMcpManager';
import { getStoredScopeTier } from '../hubspotAuthService';
import { getTelemetrySaltHex } from '../hubspotTelemetry';
import { getPlatformConfig, setPlatformConfig, type PlatformSurface } from '@core/platform';

/**
 * Run an async block with a temporarily-overridden `PlatformConfig.surface`.
 * Restores the original value (and current PlatformConfig shape) afterwards
 * so tests for the desktop and cloud branches stay isolated.
 */
async function withSurface<T>(surface: PlatformSurface, fn: () => Promise<T>): Promise<T> {
  const original = getPlatformConfig();
  setPlatformConfig({ ...original, surface });
  try {
    return await fn();
  } finally {
    setPlatformConfig(original);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDataDir: string;

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('discoverBundledOAuthMcps', () => {
  beforeAll(async () => {
    tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundled-mcp-cloud-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations to factory defaults (clearAllMocks only clears call counts)
    vi.mocked(resolveOAuthCredentials).mockImplementation((source: unknown) => {
      const src = source as { provider?: string };
      if (src.provider === 'google') return mockGoogleCreds;
      if (src.provider === 'hubspot') return mockHubSpotCreds;
      if (src.provider === 'slack') return mockSlackCreds;
      return null;
    });
    vi.mocked(resolveMicrosoftClientId).mockReturnValue(mockMicrosoftClientId);
    vi.mocked(getTelemetrySaltHex).mockResolvedValue(mockTelemetrySaltHex);
    // Default each test to cloud refresh enabled (OSS sync mode) unless a test
    // explicitly sets OSS_SYNC_DISABLED=1.
    delete process.env.OSS_SYNC_DISABLED;
    delete process.env.HUBSPOT_SCOPE_TIER;
  });

  // ── Returns empty array when no credential directories exist ──

  it('returns empty array when no credential directories exist', async () => {
    const emptyDir = path.join(tempDataDir, 'empty-' + Date.now());
    await fs.mkdir(emptyDir, { recursive: true });

    const result = await discoverBundledOAuthMcps(emptyDir);

    expect(result).toEqual([]);
  });

  // ── Google Workspace: discovers instances ──

  describe('Google Workspace', () => {
    let googleDir: string;

    beforeAll(async () => {
      googleDir = path.join(tempDataDir, 'google-test-' + Date.now());
      await fs.mkdir(googleDir, { recursive: true });
    });

    it('discovers a single Google Workspace instance', async () => {
      const dataDir = path.join(googleDir, 'single');
      const gwDir = path.join(dataDir, 'google-workspace-mcp');
      const instanceDir = path.join(gwDir, 'taylor-example-com');

      await writeJson(path.join(instanceDir, 'accounts.json'), {
        accounts: [{ email: 'taylor@example.com', category: 'personal' }],
      });
      await writeJson(path.join(instanceDir, 'credentials', 'taylor-example-com.token.json'), {
        access_token: 'mock-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'GoogleWorkspace-taylor-example-com',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@mindstone/mcp-server-google-workspace@0.1.3'],
        email: 'taylor@example.com',
        catalogId: 'bundled-google',
        env: expect.objectContaining({
          GOOGLE_CLIENT_ID: 'google-client-id',
          GOOGLE_CLIENT_SECRET: 'google-client-secret',
          ACCOUNTS_PATH: path.join(instanceDir, 'accounts.json'),
          CREDENTIALS_PATH: path.join(instanceDir, 'credentials'),
          MCP_MODE: 'true',
          LOG_MODE: 'strict',
        }),
      });
      expect(buildGoogleWorkspaceInstancePayload).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'taylor@example.com',
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
          accountsPath: path.join(instanceDir, 'accounts.json'),
          credentialsPath: path.join(instanceDir, 'credentials'),
        }),
      );
    });

    it('discovers multiple Google Workspace instances', async () => {
      const dataDir = path.join(googleDir, 'multi');
      const gwDir = path.join(dataDir, 'google-workspace-mcp');

      // Instance 1
      const inst1 = path.join(gwDir, 'taylor-example-com');
      await writeJson(path.join(inst1, 'accounts.json'), {
        accounts: [{ email: 'taylor@example.com' }],
      });
      await writeJson(path.join(inst1, 'credentials', 'taylor.token.json'), { access_token: 't1' });

      // Instance 2
      const inst2 = path.join(gwDir, 'jane-example-com');
      await writeJson(path.join(inst2, 'accounts.json'), {
        accounts: [{ email: 'jane@example.com' }],
      });
      await writeJson(path.join(inst2, 'credentials', 'jane.token.json'), { access_token: 't2' });

      const result = await discoverBundledOAuthMcps(dataDir);

      const googlePayloads = result.filter(p => p.catalogId === 'bundled-google');
      expect(googlePayloads).toHaveLength(2);
    });

    it('skips instances without token files', async () => {
      const dataDir = path.join(googleDir, 'no-tokens');
      const gwDir = path.join(dataDir, 'google-workspace-mcp');
      const instanceDir = path.join(gwDir, 'no-creds');

      // accounts.json exists but no token files
      await writeJson(path.join(instanceDir, 'accounts.json'), {
        accounts: [{ email: 'test@example.com' }],
      });
      // Create empty credentials dir
      await fs.mkdir(path.join(instanceDir, 'credentials'), { recursive: true });

      const result = await discoverBundledOAuthMcps(dataDir);

      const googlePayloads = result.filter(p => p.catalogId === 'bundled-google');
      expect(googlePayloads).toHaveLength(0);
    });

    it('skips instances without accounts.json', async () => {
      const dataDir = path.join(googleDir, 'no-accounts');
      const gwDir = path.join(dataDir, 'google-workspace-mcp');
      const instanceDir = path.join(gwDir, 'orphan');

      // Token exists but no accounts.json
      await writeJson(path.join(instanceDir, 'credentials', 'orphan.token.json'), {
        access_token: 'mock',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const googlePayloads = result.filter(p => p.catalogId === 'bundled-google');
      expect(googlePayloads).toHaveLength(0);
    });

    it('skips when no Google OAuth credentials available', async () => {
      vi.mocked(resolveOAuthCredentials).mockReturnValueOnce(null);

      const dataDir = path.join(googleDir, 'no-creds-available');
      const gwDir = path.join(dataDir, 'google-workspace-mcp');
      const instanceDir = path.join(gwDir, 'test');

      await writeJson(path.join(instanceDir, 'accounts.json'), {
        accounts: [{ email: 'test@example.com' }],
      });
      await writeJson(path.join(instanceDir, 'credentials', 'test.token.json'), {
        access_token: 'mock',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const googlePayloads = result.filter(p => p.catalogId === 'bundled-google');
      expect(googlePayloads).toHaveLength(0);
    });

    it('skips the bare "credentials" directory (shared staging dir)', async () => {
      const dataDir = path.join(googleDir, 'staging');
      const gwDir = path.join(dataDir, 'google-workspace-mcp');

      // Create "credentials" directory at root level (staging dir, not an instance)
      await writeJson(path.join(gwDir, 'credentials', 'some-file.token.json'), {
        access_token: 'staging-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const googlePayloads = result.filter(p => p.catalogId === 'bundled-google');
      expect(googlePayloads).toHaveLength(0);
    });

    it('does NOT set GOOGLE_WORKSPACE_DISABLE_REFRESH on desktop surface (refresh stays enabled)', async () => {
      const dataDir = path.join(googleDir, 'desktop-refresh-' + Date.now());
      const instanceDir = path.join(dataDir, 'google-workspace-mcp', 'desktop-example-com');

      await writeJson(path.join(instanceDir, 'accounts.json'), {
        accounts: [{ email: 'desktop@example.com' }],
      });
      await writeJson(path.join(instanceDir, 'credentials', 'desktop-example-com.token.json'), {
        access_token: 'mock-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);
      const googlePayload = result.find((payload) => payload.catalogId === 'bundled-google');

      expect(googlePayload).toBeDefined();
      expect(googlePayload?.command).toBe('npx');
      expect(googlePayload?.args).toEqual(['-y', '@mindstone/mcp-server-google-workspace@0.1.3']);
      expect(googlePayload?.env).not.toHaveProperty('GOOGLE_WORKSPACE_DISABLE_REFRESH');
    });

    it('does NOT set GOOGLE_WORKSPACE_DISABLE_REFRESH on cloud surface by default', async () => {
      const dataDir = path.join(googleDir, 'cloud-refresh-disabled-' + Date.now());
      const instanceDir = path.join(dataDir, 'google-workspace-mcp', 'cloud-example-com');

      await writeJson(path.join(instanceDir, 'accounts.json'), {
        accounts: [{ email: 'cloud@example.com' }],
      });
      await writeJson(path.join(instanceDir, 'credentials', 'cloud-example-com.token.json'), {
        access_token: 'mock-token',
      });

      const result = await withSurface('cloud', () => discoverBundledOAuthMcps(dataDir));
      const googlePayload = result.find((payload) => payload.catalogId === 'bundled-google');

      expect(googlePayload).toBeDefined();
      expect(googlePayload?.command).toBe('npx');
      expect(googlePayload?.args).toEqual(['-y', '@mindstone/mcp-server-google-workspace@0.1.3']);
      expect(googlePayload?.env).not.toHaveProperty('GOOGLE_WORKSPACE_DISABLE_REFRESH');
    });

    it('sets GOOGLE_WORKSPACE_DISABLE_REFRESH on cloud when OSS_SYNC_DISABLED=1', async () => {
      process.env.OSS_SYNC_DISABLED = '1';
      try {
        const dataDir = path.join(googleDir, 'cloud-refresh-enabled-' + Date.now());
        const instanceDir = path.join(dataDir, 'google-workspace-mcp', 'cloud-optin-example-com');

        await writeJson(path.join(instanceDir, 'accounts.json'), {
          accounts: [{ email: 'cloud-optin@example.com' }],
        });
        await writeJson(path.join(instanceDir, 'credentials', 'cloud-optin-example-com.token.json'), {
          access_token: 'mock-token',
        });

        const result = await withSurface('cloud', () => discoverBundledOAuthMcps(dataDir));
        const googlePayload = result.find((payload) => payload.catalogId === 'bundled-google');

        expect(googlePayload).toBeDefined();
        expect(googlePayload?.command).toBe('npx');
        expect(googlePayload?.args).toEqual(['-y', '@mindstone/mcp-server-google-workspace@0.1.3']);
        expect(googlePayload?.env).toEqual(expect.objectContaining({
          GOOGLE_WORKSPACE_DISABLE_REFRESH: '1',
        }));
      } finally {
        delete process.env.OSS_SYNC_DISABLED;
      }
    });
  });

  // ── Slack: discovers workspaces ──

  describe('Slack', () => {
    it('discovers Slack workspaces from config.json', async () => {
      const dataDir = path.join(tempDataDir, 'slack-test-' + Date.now());
      const slackDir = path.join(dataDir, 'mcp', 'slack');

      await writeJson(path.join(slackDir, 'config.json'), {
        workspaces: [
          { teamId: 'T123', teamName: 'Mindstone' },
          { teamId: 'T456', teamName: 'Acme' },
        ],
      });
      await writeJson(path.join(slackDir, 'workspaces', 'T123.json'), {
        botToken: 'xoxb-111',
        userToken: 'xoxp-111',
      });
      await writeJson(path.join(slackDir, 'workspaces', 'T456.json'), {
        botToken: 'xoxb-222',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const slackPayloads = result.filter(p => p.catalogId === 'bundled-slack');
      expect(slackPayloads).toHaveLength(2);
      expect(buildSlackInstancePayload).toHaveBeenCalledTimes(2);
      expect(buildSlackInstancePayload).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 'T123', teamName: 'Mindstone', botToken: 'xoxb-111' }),
      );
    });

    it('skips workspaces without bot token files', async () => {
      const dataDir = path.join(tempDataDir, 'slack-notoken-' + Date.now());
      const slackDir = path.join(dataDir, 'mcp', 'slack');

      await writeJson(path.join(slackDir, 'config.json'), {
        workspaces: [{ teamId: 'T789', teamName: 'NoTokens' }],
      });
      // No token file for T789

      const result = await discoverBundledOAuthMcps(dataDir);

      const slackPayloads = result.filter(p => p.catalogId === 'bundled-slack');
      expect(slackPayloads).toHaveLength(0);
    });

    it('skips when no config.json exists', async () => {
      const dataDir = path.join(tempDataDir, 'slack-noconfig-' + Date.now());
      const slackDir = path.join(dataDir, 'mcp', 'slack');
      await fs.mkdir(slackDir, { recursive: true });

      const result = await discoverBundledOAuthMcps(dataDir);

      const slackPayloads = result.filter(p => p.catalogId === 'bundled-slack');
      expect(slackPayloads).toHaveLength(0);
    });

    // -------------------------------------------------------------------------
    // Stage 0 OSS Slack migration: cred injection + cross-surface refresh authority.
    // See docs/plans/260429_slack_mcp_oss_migration.md (Stage 0, Risk 4b).
    // -------------------------------------------------------------------------

    it('injects SLACK_CLIENT_ID and SLACK_CLIENT_SECRET resolved via slackCredentialSource', async () => {
      const dataDir = path.join(tempDataDir, 'slack-creds-' + Date.now());
      const slackDir = path.join(dataDir, 'mcp', 'slack');
      await writeJson(path.join(slackDir, 'config.json'), {
        workspaces: [{ teamId: 'T1', teamName: 'CredsTeam' }],
      });
      await writeJson(path.join(slackDir, 'workspaces', 'T1.json'), { botToken: 'xoxb-1' });

      const result = await discoverBundledOAuthMcps(dataDir);

      const slack = result.find((p) => p.catalogId === 'bundled-slack');
      expect(slack).toBeDefined();
      expect(buildSlackInstancePayload).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'T1',
          teamName: 'CredsTeam',
          clientId: 'slack-client-id',
          clientSecret: 'slack-client-secret',
        }),
      );
      // Mock surfaces creds in env — verify the resulting payload carries them.
      expect(slack?.env).toEqual(expect.objectContaining({
        SLACK_CLIENT_ID: 'slack-client-id',
        SLACK_CLIENT_SECRET: 'slack-client-secret',
      }));
    });

    it('still discovers Slack workspaces when OAuth client creds are unavailable', async () => {
      vi.mocked(resolveOAuthCredentials).mockImplementation((source) => {
        const src = source as { provider?: string };
        if (src.provider === 'slack') return null;
        return null;
      });

      const dataDir = path.join(tempDataDir, 'slack-no-creds-' + Date.now());
      const slackDir = path.join(dataDir, 'mcp', 'slack');
      await writeJson(path.join(slackDir, 'config.json'), {
        workspaces: [{ teamId: 'T1', teamName: 'NoCreds' }],
      });
      await writeJson(path.join(slackDir, 'workspaces', 'T1.json'), { botToken: 'xoxb-1' });

      const result = await discoverBundledOAuthMcps(dataDir);

      const slack = result.find((p) => p.catalogId === 'bundled-slack');
      expect(slack).toBeDefined();
      expect(slack?.env).not.toHaveProperty('SLACK_CLIENT_ID');
      expect(slack?.env).not.toHaveProperty('SLACK_CLIENT_SECRET');
    });

    it('does NOT set SLACK_DISABLE_REFRESH on cloud surface by default', async () => {
      const dataDir = path.join(tempDataDir, 'slack-cloud-default-' + Date.now());
      const slackDir = path.join(dataDir, 'mcp', 'slack');
      await writeJson(path.join(slackDir, 'config.json'), {
        workspaces: [{ teamId: 'T1', teamName: 'CloudTeam' }],
      });
      await writeJson(path.join(slackDir, 'workspaces', 'T1.json'), { botToken: 'xoxb-1' });

      const result = await withSurface('cloud', () => discoverBundledOAuthMcps(dataDir));

      const slack = result.find((p) => p.catalogId === 'bundled-slack');
      expect(slack).toBeDefined();
      expect(slack?.env).not.toHaveProperty('SLACK_DISABLE_REFRESH');
      expect(slack?.env).toEqual(expect.objectContaining({
        SLACK_CLIENT_ID: 'slack-client-id',
        SLACK_CLIENT_SECRET: 'slack-client-secret',
      }));
    });

    it('sets SLACK_DISABLE_REFRESH on cloud when OSS_SYNC_DISABLED=1', async () => {
      process.env.OSS_SYNC_DISABLED = '1';

      const dataDir = path.join(tempDataDir, 'slack-cloud-optout-' + Date.now());
      const slackDir = path.join(dataDir, 'mcp', 'slack');
      await writeJson(path.join(slackDir, 'config.json'), {
        workspaces: [{ teamId: 'T1', teamName: 'OptOut' }],
      });
      await writeJson(path.join(slackDir, 'workspaces', 'T1.json'), { botToken: 'xoxb-1' });

      const result = await withSurface('cloud', () => discoverBundledOAuthMcps(dataDir));

      const slack = result.find((p) => p.catalogId === 'bundled-slack');
      expect(slack).toBeDefined();
      expect(slack?.env).toEqual(expect.objectContaining({
        SLACK_DISABLE_REFRESH: '1',
        SLACK_CLIENT_ID: 'slack-client-id',
        SLACK_CLIENT_SECRET: 'slack-client-secret',
      }));
      delete process.env.OSS_SYNC_DISABLED;
    });

    it('does NOT set SLACK_DISABLE_REFRESH on desktop surface (refresh stays enabled)', async () => {
      const dataDir = path.join(tempDataDir, 'slack-desktop-' + Date.now());
      const slackDir = path.join(dataDir, 'mcp', 'slack');
      await writeJson(path.join(slackDir, 'config.json'), {
        workspaces: [{ teamId: 'T1', teamName: 'DesktopTeam' }],
      });
      await writeJson(path.join(slackDir, 'workspaces', 'T1.json'), { botToken: 'xoxb-1' });

      // Default vitest setup uses surface='desktop'.
      const result = await discoverBundledOAuthMcps(dataDir);

      const slack = result.find((p) => p.catalogId === 'bundled-slack');
      expect(slack).toBeDefined();
      expect(slack?.env).not.toHaveProperty('SLACK_DISABLE_REFRESH');
    });
  });

  // ── HubSpot ──

  describe('HubSpot', () => {
    it('discovers one HubSpot payload per account and injects account-scoped env', async () => {
      const dataDir = path.join(tempDataDir, 'hubspot-test-' + Date.now());
      const hubspotDir = path.join(dataDir, 'mcp', 'hubspot');
      const email = 'sales@example.com';

      await writeJson(path.join(hubspotDir, 'accounts.json'), {
        accounts: [{ email, scopeTier: 'readonly' }],
      });
      await writeJson(path.join(hubspotDir, 'credentials', 'sales-example-com.token.json'), {
        access_token: 'hs-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const hubspotPayloads = result.filter(p => p.catalogId === 'bundled-hubspot');
      expect(hubspotPayloads).toHaveLength(1);
      expect(hubspotPayloads[0]).toMatchObject({
        name: 'HubSpot-sales-example-com',
        command: 'npx',
        args: ['-y', '@mindstone/mcp-server-hubspot@0.2.1'],
        email,
        env: expect.objectContaining({
          HUBSPOT_CLIENT_ID: 'hubspot-client-id',
          HUBSPOT_CLIENT_SECRET: 'hubspot-client-secret',
          HUBSPOT_CONFIG_DIR: hubspotDir,
          HUBSPOT_ACCOUNT_EMAIL: email,
          HUBSPOT_SCOPE_TIER: 'readonly',
          HUBSPOT_TELEMETRY_SALT: mockTelemetrySaltHex,
          HUBSPOT_SOURCE_LABEL: 'Mindstone Rebel',
        }),
      });
      // 260517 fix: desktop is the refresh authority — DISABLE_REFRESH must NOT
      // be injected on desktop surface. Test runs with default surface='desktop'.
      expect(hubspotPayloads[0].env).not.toHaveProperty('HUBSPOT_DISABLE_REFRESH');
    });

    it('injects HUBSPOT_TELEMETRY_SALT from telemetry helper output', async () => {
      const customTelemetrySaltHex = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
      vi.mocked(getTelemetrySaltHex).mockResolvedValueOnce(customTelemetrySaltHex);

      const dataDir = path.join(tempDataDir, 'hubspot-salt-env-' + Date.now());
      const hubspotDir = path.join(dataDir, 'mcp', 'hubspot');
      const email = 'salt@example.com';

      await writeJson(path.join(hubspotDir, 'accounts.json'), {
        accounts: [{ email, scopeTier: 'readonly' }],
      });
      await writeJson(path.join(hubspotDir, 'credentials', 'salt-example-com.token.json'), {
        access_token: 'hs-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);
      const payload = result.find((entry) => entry.catalogId === 'bundled-hubspot');

      expect(payload).toBeDefined();
      expect(payload?.env).toEqual(expect.objectContaining({
        HUBSPOT_TELEMETRY_SALT: customTelemetrySaltHex,
      }));
      expect(getTelemetrySaltHex).toHaveBeenCalledTimes(1);
    });

    it('discovers multiple HubSpot accounts as distinct router entries', async () => {
      const dataDir = path.join(tempDataDir, 'hubspot-multi-' + Date.now());
      const hubspotDir = path.join(dataDir, 'mcp', 'hubspot');

      await writeJson(path.join(hubspotDir, 'accounts.json'), {
        accounts: [
          { email: 'first@example.com', scopeTier: 'readonly' },
          { email: 'second@example.com', scopeTier: 'full' },
        ],
      });
      await writeJson(path.join(hubspotDir, 'credentials', 'first-example-com.token.json'), {
        access_token: 'hs-token-first',
      });
      await writeJson(path.join(hubspotDir, 'credentials', 'second-example-com.token.json'), {
        access_token: 'hs-token-second',
      });

      const result = await discoverBundledOAuthMcps(dataDir);
      const hubspotPayloads = result.filter(p => p.catalogId === 'bundled-hubspot');

      expect(hubspotPayloads).toHaveLength(2);
      expect(hubspotPayloads.map((p) => p.name).sort()).toEqual([
        'HubSpot-first-example-com',
        'HubSpot-second-example-com',
      ]);
      expect(hubspotPayloads.map((p) => (p.env as Record<string, string>).HUBSPOT_ACCOUNT_EMAIL).sort()).toEqual([
        'first@example.com',
        'second@example.com',
      ]);
      // 260517 fix: default surface='desktop' — DISABLE_REFRESH must NOT be set.
      expect(hubspotPayloads.every((p) => !(p.env as Record<string, string>).HUBSPOT_DISABLE_REFRESH)).toBe(true);
      expect(getStoredScopeTier).toHaveBeenCalledWith('first@example.com');
      expect(getStoredScopeTier).toHaveBeenCalledWith('second@example.com');
    });

    it('continues with remaining HubSpot accounts when one scope-tier lookup fails', async () => {
      vi.mocked(getStoredScopeTier).mockImplementation(async (email?: string) => {
        if (email === 'broken@example.com') {
          throw new Error('EACCES');
        }
        return 'full';
      });

      const dataDir = path.join(tempDataDir, 'hubspot-partial-scope-failure-' + Date.now());
      const hubspotDir = path.join(dataDir, 'mcp', 'hubspot');
      await writeJson(path.join(hubspotDir, 'accounts.json'), {
        accounts: [
          { email: 'broken@example.com', scopeTier: 'readonly' },
          { email: 'healthy@example.com', scopeTier: 'full' },
        ],
      });
      await writeJson(path.join(hubspotDir, 'credentials', 'broken-example-com.token.json'), {
        access_token: 'hs-token-broken',
      });
      await writeJson(path.join(hubspotDir, 'credentials', 'healthy-example-com.token.json'), {
        access_token: 'hs-token-healthy',
      });

      const result = await discoverBundledOAuthMcps(dataDir);
      const hubspotPayloads = result.filter((payload) => payload.catalogId === 'bundled-hubspot');

      expect(hubspotPayloads).toHaveLength(1);
      expect(hubspotPayloads[0]?.name).toBe('HubSpot-healthy-example-com');
      expect(getStoredScopeTier).toHaveBeenCalledWith('broken@example.com');
      expect(getStoredScopeTier).toHaveBeenCalledWith('healthy@example.com');
    });

    it('skips HubSpot when only accounts.json exists without token files (disconnected)', async () => {
      const dataDir = path.join(tempDataDir, 'hubspot-accounts-' + Date.now());
      const hubspotDir = path.join(dataDir, 'mcp', 'hubspot');

      // accounts.json alone should not cause re-registration
      await writeJson(path.join(hubspotDir, 'accounts.json'), {
        accounts: [{ portalId: '12345' }],
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const hubspotPayloads = result.filter(p => p.catalogId === 'bundled-hubspot');
      expect(hubspotPayloads).toHaveLength(0);
    });

    it('skips HubSpot when no credentials available', async () => {
      vi.mocked(resolveOAuthCredentials).mockImplementation((source) => {
        if ((source as { provider: string }).provider === 'hubspot') return null;
        return mockGoogleCreds;
      });

      const dataDir = path.join(tempDataDir, 'hubspot-nocreds-' + Date.now());
      const hubspotDir = path.join(dataDir, 'mcp', 'hubspot');
      await writeJson(path.join(hubspotDir, 'accounts.json'), {
        accounts: [{ email: 'nocreds@example.com' }],
      });
      await writeJson(path.join(hubspotDir, 'credentials', 'nocreds-example-com.token.json'), {
        access_token: 'hs-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const hubspotPayloads = result.filter(p => p.catalogId === 'bundled-hubspot');
      expect(hubspotPayloads).toHaveLength(0);
    });

    it('does NOT set HUBSPOT_DISABLE_REFRESH on desktop surface (refresh stays enabled)', async () => {
      // 260517 fix: desktop is the sole refresh authority. The OSS subprocess
      // running locally is what refreshes the access token via the stored
      // refresh_token; injecting DISABLE_REFRESH=1 here would make every CRM
      // call after the 30-60 min access-token TTL return auth_required.
      // See `docs-private/postmortems/260517_hubspot_disable_refresh_desktop_bypass_postmortem.md`.
      const dataDir = path.join(tempDataDir, 'hubspot-desktop-' + Date.now());
      const hubspotDir = path.join(dataDir, 'mcp', 'hubspot');
      await writeJson(path.join(hubspotDir, 'accounts.json'), {
        accounts: [{ email: 'desktop@example.com', scopeTier: 'full' }],
      });
      await writeJson(path.join(hubspotDir, 'credentials', 'desktop-example-com.token.json'), {
        access_token: 'hs-token',
      });

      // Default vitest setup uses surface='desktop'.
      const result = await discoverBundledOAuthMcps(dataDir);
      const hubspotPayload = result.find((payload) => payload.catalogId === 'bundled-hubspot');

      expect(hubspotPayload).toBeDefined();
      expect(hubspotPayload?.env).not.toHaveProperty('HUBSPOT_DISABLE_REFRESH');
    });

    it('does NOT inject HUBSPOT_DISABLE_REFRESH on cloud surface by default', async () => {
      const dataDir = path.join(tempDataDir, 'hubspot-cloud-' + Date.now());
      const hubspotDir = path.join(dataDir, 'mcp', 'hubspot');
      await writeJson(path.join(hubspotDir, 'accounts.json'), {
        accounts: [{ email: 'cloud@example.com', scopeTier: 'full' }],
      });
      await writeJson(path.join(hubspotDir, 'credentials', 'cloud-example-com.token.json'), {
        access_token: 'hs-token',
      });

      const result = await withSurface('cloud', () => discoverBundledOAuthMcps(dataDir));
      const hubspotPayload = result.find((payload) => payload.catalogId === 'bundled-hubspot');

      expect(hubspotPayload).toBeDefined();
      expect(hubspotPayload?.env).not.toHaveProperty('HUBSPOT_DISABLE_REFRESH');
    });

    it('injects HUBSPOT_DISABLE_REFRESH on cloud when OSS_SYNC_DISABLED=1', async () => {
      process.env.OSS_SYNC_DISABLED = '1';
      try {
        const dataDir = path.join(tempDataDir, 'hubspot-cloud-optin-' + Date.now());
        const hubspotDir = path.join(dataDir, 'mcp', 'hubspot');
        await writeJson(path.join(hubspotDir, 'accounts.json'), {
          accounts: [{ email: 'optin@example.com', scopeTier: 'full' }],
        });
        await writeJson(path.join(hubspotDir, 'credentials', 'optin-example-com.token.json'), {
          access_token: 'hs-token',
        });

        const result = await withSurface('cloud', () => discoverBundledOAuthMcps(dataDir));
        const hubspotPayload = result.find((payload) => payload.catalogId === 'bundled-hubspot');

        expect(hubspotPayload).toBeDefined();
        expect(hubspotPayload?.env).toEqual(expect.objectContaining({
          HUBSPOT_DISABLE_REFRESH: '1',
        }));
      } finally {
        delete process.env.OSS_SYNC_DISABLED;
      }
    });
  });

  // ── Microsoft 365 ──

  describe('Microsoft 365', () => {
    it('discovers Microsoft 365 and registers all 5 MCPs', async () => {
      const dataDir = path.join(tempDataDir, 'ms-test-' + Date.now());
      const msDir = path.join(dataDir, 'microsoft-mcp');

      await writeJson(path.join(msDir, 'accounts.json'), {
        accounts: [{ email: '[external-email]' }],
      });
      // Token filename must match sanitized email (non-alnum → hyphen)
      await writeJson(path.join(msDir, 'credentials', 'taylor-outlook-com.token.json'), {
        access_token: 'ms-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const msPayloads = result.filter(p =>
        typeof p.catalogId === 'string' && p.catalogId.startsWith('bundled-microsoft-'),
      );
      expect(msPayloads).toHaveLength(5);
      expect(buildMicrosoft365MailPayload).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'ms-client-id',
          configDir: msDir,
          email: '[external-email]',
        }),
      );
    });

    it('skips Microsoft when only token files exist without accounts.json', async () => {
      const dataDir = path.join(tempDataDir, 'ms-notokens-' + Date.now());
      const msDir = path.join(dataDir, 'microsoft-mcp');

      // Only token file, no accounts.json — should not re-register
      await writeJson(path.join(msDir, 'credentials', 'user.token.json'), {
        access_token: 'ms-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const msPayloads = result.filter(p =>
        typeof p.catalogId === 'string' && p.catalogId.startsWith('bundled-microsoft-'),
      );
      expect(msPayloads).toHaveLength(0);
    });

    it('skips Microsoft when accounts.json has empty accounts array (disconnected)', async () => {
      const dataDir = path.join(tempDataDir, 'ms-disconnected-' + Date.now());
      const msDir = path.join(dataDir, 'microsoft-mcp');

      await writeJson(path.join(msDir, 'accounts.json'), {
        accounts: [],
      });
      await writeJson(path.join(msDir, 'credentials', 'leftover.token.json'), {
        access_token: 'old-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const msPayloads = result.filter(p =>
        typeof p.catalogId === 'string' && p.catalogId.startsWith('bundled-microsoft-'),
      );
      expect(msPayloads).toHaveLength(0);
    });

    it('skips Microsoft when account exists but token is for a different email', async () => {
      const dataDir = path.join(tempDataDir, 'ms-mismatch-' + Date.now());
      const msDir = path.join(dataDir, 'microsoft-mcp');

      await writeJson(path.join(msDir, 'accounts.json'), {
        accounts: [{ email: '[external-email]' }],
      });
      // Token file is for a different user (bob), not alice
      await writeJson(path.join(msDir, 'credentials', 'bob-outlook-com.token.json'), {
        access_token: 'bobs-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const msPayloads = result.filter(p =>
        typeof p.catalogId === 'string' && p.catalogId.startsWith('bundled-microsoft-'),
      );
      expect(msPayloads).toHaveLength(0);
    });

    it('discovers multiple Microsoft accounts and registers 5 MCPs per account', async () => {
      const dataDir = path.join(tempDataDir, 'ms-multi-' + Date.now());
      const msDir = path.join(dataDir, 'microsoft-mcp');

      // Two accounts in accounts.json
      await writeJson(path.join(msDir, 'accounts.json'), {
        accounts: [
          { email: '[external-email]' },
          { email: '[external-email]' },
        ],
      });
      // Matching token files for both
      await writeJson(path.join(msDir, 'credentials', 'alice-outlook-com.token.json'), {
        access_token: 'alice-token',
      });
      await writeJson(path.join(msDir, 'credentials', 'bob-company-com.token.json'), {
        access_token: 'bob-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const msPayloads = result.filter(p =>
        typeof p.catalogId === 'string' && p.catalogId.startsWith('bundled-microsoft-'),
      );
      // 2 accounts × 5 MCPs each = 10 payloads
      expect(msPayloads).toHaveLength(10);
      // Verify Mail was called for both accounts
      expect(buildMicrosoft365MailPayload).toHaveBeenCalledTimes(2);
      expect(buildMicrosoft365MailPayload).toHaveBeenCalledWith(
        expect.objectContaining({ email: '[external-email]' }),
      );
      expect(buildMicrosoft365MailPayload).toHaveBeenCalledWith(
        expect.objectContaining({ email: '[external-email]' }),
      );
    });

    it('skips Microsoft when no client ID available', async () => {
      vi.mocked(resolveMicrosoftClientId).mockReturnValueOnce(null);

      const dataDir = path.join(tempDataDir, 'ms-noclient-' + Date.now());
      const msDir = path.join(dataDir, 'microsoft-mcp');
      await writeJson(path.join(msDir, 'accounts.json'), {
        accounts: [{ email: '[external-email]' }],
      });
      await writeJson(path.join(msDir, 'credentials', 'test-outlook-com.token.json'), {
        access_token: 'ms-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const msPayloads = result.filter(p =>
        typeof p.catalogId === 'string' && p.catalogId.startsWith('bundled-microsoft-'),
      );
      expect(msPayloads).toHaveLength(0);
    });

    // Phase B3 — surface-gated MICROSOFT_DISABLE_REFRESH injection.
    // Single-refresh-authority model: desktop is the refresh authority.
    // Cloud subprocesses must defer to desktop. Same shape as HubSpot's
    // Phase 5b fix (postmortem 260517) — unconditional injection caused
    // desktop subprocesses to bounce every CRM call to auth_required.

    it('does NOT set MICROSOFT_DISABLE_REFRESH on desktop surface (refresh stays enabled)', async () => {
      const dataDir = path.join(tempDataDir, 'ms-desktop-' + Date.now());
      const msDir = path.join(dataDir, 'microsoft-mcp');
      await writeJson(path.join(msDir, 'accounts.json'), {
        accounts: [{ email: '[external-email]' }],
      });
      await writeJson(path.join(msDir, 'credentials', 'desktop-outlook-com.token.json'), {
        access_token: 'ms-token',
      });

      // Default vitest setup uses surface='desktop'.
      const result = await discoverBundledOAuthMcps(dataDir);
      const msPayloads = result.filter((p) =>
        typeof p.catalogId === 'string' && p.catalogId.startsWith('bundled-microsoft-'),
      );

      expect(msPayloads).toHaveLength(5);
      for (const payload of msPayloads) {
        expect(payload.env ?? {}).not.toHaveProperty('MICROSOFT_DISABLE_REFRESH');
      }
    });

    it('does NOT inject MICROSOFT_DISABLE_REFRESH on cloud surface by default', async () => {
      const dataDir = path.join(tempDataDir, 'ms-cloud-' + Date.now());
      const msDir = path.join(dataDir, 'microsoft-mcp');
      await writeJson(path.join(msDir, 'accounts.json'), {
        accounts: [{ email: '[external-email]' }],
      });
      await writeJson(path.join(msDir, 'credentials', 'cloud-outlook-com.token.json'), {
        access_token: 'ms-token',
      });

      const result = await withSurface('cloud', () => discoverBundledOAuthMcps(dataDir));
      const msPayloads = result.filter((p) =>
        typeof p.catalogId === 'string' && p.catalogId.startsWith('bundled-microsoft-'),
      );

      expect(msPayloads).toHaveLength(5);
      for (const payload of msPayloads) {
        expect(payload.env ?? {}).not.toHaveProperty('MICROSOFT_DISABLE_REFRESH');
      }
      // All 5 surfaces gated — Mail, Calendar, Files, Teams, SharePoint.
      const catalogIds = msPayloads.map((p) => p.catalogId);
      expect(catalogIds).toEqual(expect.arrayContaining([
        'bundled-microsoft-mail',
        'bundled-microsoft-calendar',
        'bundled-microsoft-files',
        'bundled-microsoft-teams',
        'bundled-microsoft-sharepoint',
      ]));
    });

    it('injects MICROSOFT_DISABLE_REFRESH on cloud when OSS_SYNC_DISABLED=1', async () => {
      process.env.OSS_SYNC_DISABLED = '1';
      try {
        const dataDir = path.join(tempDataDir, 'ms-cloud-optin-' + Date.now());
        const msDir = path.join(dataDir, 'microsoft-mcp');
        await writeJson(path.join(msDir, 'accounts.json'), {
          accounts: [{ email: '[external-email]' }],
        });
        await writeJson(path.join(msDir, 'credentials', 'optin-outlook-com.token.json'), {
          access_token: 'ms-token',
        });

        const result = await withSurface('cloud', () => discoverBundledOAuthMcps(dataDir));
        const msPayloads = result.filter((p) =>
          typeof p.catalogId === 'string' && p.catalogId.startsWith('bundled-microsoft-'),
        );

        expect(msPayloads).toHaveLength(5);
        for (const payload of msPayloads) {
          expect(payload.env).toEqual(expect.objectContaining({
            MICROSOFT_DISABLE_REFRESH: '1',
          }));
        }
      } finally {
        delete process.env.OSS_SYNC_DISABLED;
      }
    });
  });

  // ── Multiple providers at once ──

  describe('Multiple providers', () => {
    it('discovers all providers simultaneously', async () => {
      const dataDir = path.join(tempDataDir, 'all-providers-' + Date.now());

      // Google
      const gwDir = path.join(dataDir, 'google-workspace-mcp', 'taylor-example-com');
      await writeJson(path.join(gwDir, 'accounts.json'), {
        accounts: [{ email: 'taylor@example.com' }],
      });
      await writeJson(path.join(gwDir, 'credentials', 'taylor.token.json'), { access_token: 't' });

      // Slack
      const slackDir = path.join(dataDir, 'mcp', 'slack');
      await writeJson(path.join(slackDir, 'config.json'), {
        workspaces: [{ teamId: 'T1', teamName: 'Test' }],
      });
      await writeJson(path.join(slackDir, 'workspaces', 'T1.json'), { botToken: 'xoxb-1' });

      // HubSpot (requires accounts.json + matching token file)
      await writeJson(path.join(dataDir, 'mcp', 'hubspot', 'accounts.json'), {
        accounts: [{ email: 'hub@example.com', scopeTier: 'readonly' }],
      });
      await writeJson(path.join(dataDir, 'mcp', 'hubspot', 'credentials', 'hub-example-com.token.json'), {
        access_token: 'hs-t',
      });

      // Microsoft (needs both accounts.json with email AND matching token file)
      await writeJson(path.join(dataDir, 'microsoft-mcp', 'accounts.json'), {
        accounts: [{ email: '[external-email]' }],
      });
      await writeJson(path.join(dataDir, 'microsoft-mcp', 'credentials', 'test-outlook-com.token.json'), {
        access_token: 'ms-t',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      // Google(1) + Slack(1) + HubSpot(1) + Microsoft(5) = 8
      expect(result).toHaveLength(8);
    });
  });

  // ── Error isolation ──

  describe('Error isolation', () => {
    it('continues discovering other providers when one fails', async () => {
      // Make Google discovery throw by providing an invalid directory structure
      // but ensure HubSpot still works
      const dataDir = path.join(tempDataDir, 'error-isolation-' + Date.now());

      // HubSpot should still work
      const hsDir = path.join(dataDir, 'mcp', 'hubspot');
      await writeJson(path.join(hsDir, 'accounts.json'), {
        accounts: [{ email: 'recover@example.com', scopeTier: 'full' }],
      });
      await writeJson(path.join(hsDir, 'credentials', 'recover-example-com.token.json'), {
        access_token: 'hs-token',
      });

      const result = await discoverBundledOAuthMcps(dataDir);

      const hsPayloads = result.filter(p => p.catalogId === 'bundled-hubspot');
      expect(hsPayloads).toHaveLength(1);
    });
  });
});
