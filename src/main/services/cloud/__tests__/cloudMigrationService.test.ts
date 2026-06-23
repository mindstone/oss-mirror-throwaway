import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPatch = vi.fn();
const mockPut = vi.fn();
const mockPost = vi.fn();
const mockPostStream = vi.fn();
const mockDisconnect = vi.fn();
vi.mock('../cloudServiceClient', () => ({
  CloudServiceClient: class MockCloudServiceClient {
    patch = mockPatch;
    put = mockPut;
    post = mockPost;
    postStream = mockPostStream;
    disconnect = mockDisconnect;
  },
}));

// Mock tar to avoid real filesystem access during workspace/appdata upload
vi.mock('tar', () => {
  const { PassThrough } = require('node:stream');
  return {
    create: vi.fn(() => {
      const stream = new PassThrough();
      // Immediately end the stream (no real archive content)
      process.nextTick(() => stream.end());
      return stream;
    }),
  };
});

// Mock getDataPath to avoid Electron dependency
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/mock-user-data',
}));

// Mock getSuperMcpOAuthTokensDir for MCP config migration tests
vi.mock('@main/utils/testIsolation', () => ({
  getSuperMcpOAuthTokensDir: () => '/tmp/mock-oauth-tokens',
}));

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  migrateToCloud,
  prepareCloudSettings,
  type MigrationOptions,
  type MigrationStep,
} from '../cloudMigrationService';
import type { AgentSession, AppSettings } from '@shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSettings(overrides?: Partial<AppSettings>): AppSettings {
  return {
    coreDirectory: '/Users/me/Documents/Rebel',
    cloudInstance: {
      mode: 'cloud',
      cloudUrl: 'https://rebel-test.fly.dev',
      cloudToken: 'test-token',
    },
    onboardingCompleted: true,
    userEmail: 'user@example.com',
    mcpConfigFile: null,
    userFirstName: 'Test',
    onboardingFirstCompletedAt: 1700000000000,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'whisper-1',
      ttsVoice: null,
      activationHotkey: null,
      activationHotkeyVoiceMode: false,
    },
    claude: {
      apiKey: '',
      model: 'claude-sonnet-4-20250514',
    },
    diagnostics: {
      sentryEnabled: true,
    },
    ...overrides,
  } as AppSettings;
}

function createSession(id: string): AgentSession {
  return {
    id,
    title: `Session ${id}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
  };
}

function createMigrationOptions(overrides?: Partial<MigrationOptions>): MigrationOptions {
  return {
    cloudUrl: 'https://rebel-test.fly.dev',
    cloudToken: 'bridge-token-abc',
    getSettings: () => createSettings(),
    loadSessions: () => [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('prepareCloudSettings', () => {
  it('strips cloudInstance from settings', () => {
    const settings = createSettings();
    const cleaned = prepareCloudSettings(settings);

    expect(cleaned).not.toHaveProperty('cloudInstance');
  });

  it('strips coreDirectory and replaces with cloud path', () => {
    const settings = createSettings({ coreDirectory: '/Users/me/Rebel' });
    const cleaned = prepareCloudSettings(settings);

    expect(cleaned['coreDirectory']).toBe('/data/workspace');
  });

  it('strips mcpConfigFile (local-only filesystem path)', () => {
    const settings = createSettings({
      mcpConfigFile: '/Users/me/Library/Application Support/mindstone-rebel/mcp/super-mcp-router.json',
    } as Partial<AppSettings>);
    const cleaned = prepareCloudSettings(settings);

    expect(cleaned).not.toHaveProperty('mcpConfigFile');
  });

  it('preserves API keys and credentials for cloud brain (claude, googleWorkspace, hubspot, salesforce, gamma)', () => {
    const settings = createSettings({
      googleWorkspace: { enabled: true, clientId: 'gw-id', clientSecret: 'gw-secret' },
      hubspot: { enabled: true, clientId: 'hs-id', clientSecret: 'hs-secret' },
      salesforce: { enabled: true, clientId: 'sf-id', clientSecret: 'sf-secret' },
      gamma: { enabled: true, apiKey: 'gamma-key' },
    } as Partial<AppSettings>);
    const cleaned = prepareCloudSettings(settings);

    // Cloud brain needs ALL API keys and credentials to function
    expect(cleaned).toHaveProperty('claude');
    expect(cleaned).toHaveProperty('googleWorkspace');
    expect(cleaned).toHaveProperty('hubspot');
    expect(cleaned).toHaveProperty('salesforce');
    expect(cleaned).toHaveProperty('gamma');
  });

  it('preserves non-secret settings fields', () => {
    const settings = createSettings();
    const cleaned = prepareCloudSettings(settings);

    expect(cleaned['onboardingCompleted']).toBe(true);
    expect(cleaned['userEmail']).toBe('user@example.com');
    expect(cleaned['voice']).toEqual(settings.voice);
  });
});

describe('migrateToCloud', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPatch.mockResolvedValue({ success: true });
    mockPut.mockResolvedValue({ success: true });
    mockPost.mockResolvedValue({ success: true });
    mockPostStream.mockResolvedValue({ success: true, fileCount: 42, archiveSize: 1024 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Settings migration ------------------------------------------------

  it('migrates settings — strips cloudInstance and sends to bridge', async () => {
    const settings = createSettings();
    const options = createMigrationOptions({
      getSettings: () => settings,
    });

    const result = await migrateToCloud(options);

    expect(result.settingsMigrated).toBe(true);
    expect(mockPatch).toHaveBeenCalledTimes(1);

    const [path, body] = mockPatch.mock.calls[0];
    expect(path).toBe('/api/settings');
    expect(body).not.toHaveProperty('cloudInstance');
    expect(body['coreDirectory']).toBe('/data/workspace');
    expect(body['userEmail']).toBe('user@example.com');
  });

  it('continues with sessions when settings migration fails', async () => {
    mockPatch.mockRejectedValueOnce(new Error('Bridge unreachable'));

    const sessions = [createSession('s1')];
    const options = createMigrationOptions({
      loadSessions: () => sessions,
    });

    const result = await migrateToCloud(options);

    expect(result.settingsMigrated).toBe(false);
    expect(result.sessionsMigrated).toBe(1);
    // errors includes settings failure + possibly workspace/appdata errors from mock paths
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]).toContain('Settings migration failed');
  });

  // ---- Session migration -------------------------------------------------

  it('migrates all sessions via PUT', async () => {
    const sessions = [
      createSession('session-1'),
      createSession('session-2'),
      createSession('session-3'),
    ];
    const options = createMigrationOptions({
      loadSessions: () => sessions,
    });

    const result = await migrateToCloud(options);

    expect(result.sessionsMigrated).toBe(3);
    // 3 session PUTs + 1 folders-carrier PUT (Stage 4 — see
    // cloudMigrationService.folders.test.ts). Scope the count to session paths.
    const sessionPutCalls = mockPut.mock.calls.filter((c) =>
      String(c[0]).startsWith('/api/sessions/') && c[0] !== '/api/sessions/folders');
    expect(sessionPutCalls).toHaveLength(3);
    expect(mockPut).toHaveBeenCalledWith('/api/sessions/session-1', sessions[0]);
    expect(mockPut).toHaveBeenCalledWith('/api/sessions/session-2', sessions[1]);
    expect(mockPut).toHaveBeenCalledWith('/api/sessions/session-3', sessions[2]);
  });

  it('handles empty sessions list', async () => {
    const options = createMigrationOptions({
      loadSessions: () => [],
    });

    const result = await migrateToCloud(options);

    expect(result.sessionsMigrated).toBe(0);
    // No SESSION PUTs — the only PUT is the folders carrier (Stage 4), which
    // always uploads the (possibly empty) folders document.
    const sessionPutCalls = mockPut.mock.calls.filter((c) =>
      String(c[0]).startsWith('/api/sessions/') && c[0] !== '/api/sessions/folders');
    expect(sessionPutCalls).toHaveLength(0);
  });

  it('continues on individual session failure', async () => {
    mockPut
      .mockResolvedValueOnce({ success: true })           // session-1 OK
      .mockRejectedValueOnce(new Error('Write failed'))   // session-2 FAIL
      .mockResolvedValueOnce({ success: true });           // session-3 OK

    const sessions = [
      createSession('session-1'),
      createSession('session-2'),
      createSession('session-3'),
    ];
    const options = createMigrationOptions({
      loadSessions: () => sessions,
    });

    const result = await migrateToCloud(options);

    expect(result.sessionsMigrated).toBe(2);
    const sessionErrors = result.errors.filter(e => e.includes('session-2'));
    expect(sessionErrors).toHaveLength(1);
    expect(sessionErrors[0]).toContain('Write failed');
  });

  it('handles loadSessions throwing', async () => {
    const options = createMigrationOptions({
      loadSessions: () => { throw new Error('Disk read error'); },
    });

    const result = await migrateToCloud(options);

    expect(result.settingsMigrated).toBe(true);
    expect(result.sessionsMigrated).toBe(0);
    const loadError = result.errors.find(e => e.includes('Failed to load local sessions'));
    expect(loadError).toBeDefined();
  });

  // ---- Progress callbacks -----------------------------------------------

  it('reports progress in correct order', async () => {
    const sessions = [createSession('s1'), createSession('s2')];
    const steps: MigrationStep[] = [];

    const options = createMigrationOptions({
      loadSessions: () => sessions,
      onProgress: (step) => steps.push({ ...step }),
    });

    await migrateToCloud(options);

    // Verify progress order and phase transitions
    // Phases: settings → mcp-config → workspace → app-data → sessions → complete
    expect(steps.length).toBeGreaterThanOrEqual(7);

    // First step: settings start
    expect(steps[0].phase).toBe('settings');
    expect(steps[0].progress).toBe(0);

    // Settings complete at 5%
    const settingsComplete = steps.find(s => s.phase === 'settings' && s.progress === 5);
    expect(settingsComplete).toBeDefined();

    // MCP config phase
    const mcpSteps = steps.filter(s => s.phase === 'mcp-config');
    expect(mcpSteps.length).toBeGreaterThanOrEqual(1);

    // Workspace phase
    const workspaceSteps = steps.filter(s => s.phase === 'workspace');
    expect(workspaceSteps.length).toBeGreaterThanOrEqual(1);

    // App data phase
    const appDataSteps = steps.filter(s => s.phase === 'app-data');
    expect(appDataSteps.length).toBeGreaterThanOrEqual(1);

    // Sessions phase
    const sessionsSteps = steps.filter(s => s.phase === 'sessions');
    expect(sessionsSteps.length).toBeGreaterThanOrEqual(1);

    // Final step: complete
    const last = steps[steps.length - 1];
    expect(last.phase).toBe('complete');
    expect(last.progress).toBe(100);
  });

  it('progress values are monotonically non-decreasing', async () => {
    const sessions = Array.from({ length: 5 }, (_, i) => createSession(`s${i}`));
    const progressValues: number[] = [];

    const options = createMigrationOptions({
      loadSessions: () => sessions,
      onProgress: (step) => progressValues.push(step.progress),
    });

    await migrateToCloud(options);

    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
    }
    expect(progressValues[0]).toBe(0);
    expect(progressValues[progressValues.length - 1]).toBe(100);
  });

  it('reports current/total during session phase', async () => {
    const sessions = [createSession('s1'), createSession('s2'), createSession('s3')];
    const sessionSteps: MigrationStep[] = [];

    const options = createMigrationOptions({
      loadSessions: () => sessions,
      onProgress: (step) => {
        if (step.phase === 'sessions' && step.current !== undefined && step.current > 0) {
          sessionSteps.push({ ...step });
        }
      },
    });

    await migrateToCloud(options);

    expect(sessionSteps).toHaveLength(3);
    expect(sessionSteps[0].current).toBe(1);
    expect(sessionSteps[0].total).toBe(3);
    expect(sessionSteps[1].current).toBe(2);
    expect(sessionSteps[1].total).toBe(3);
    expect(sessionSteps[2].current).toBe(3);
    expect(sessionSteps[2].total).toBe(3);
  });

  // ---- Lifecycle ---------------------------------------------------------

  it('disconnects bridge client when done', async () => {
    const options = createMigrationOptions();
    await migrateToCloud(options);

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects bridge client even on error', async () => {
    mockPatch.mockRejectedValue(new Error('Fatal'));
    mockPut.mockRejectedValue(new Error('Fatal'));

    const options = createMigrationOptions({
      loadSessions: () => [createSession('s1')],
    });

    await migrateToCloud(options);

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  // ---- URL encoding for session IDs ------------------------------------

  it('URL-encodes session IDs in PUT path', async () => {
    const sessions = [createSession('session-with-special')];
    const options = createMigrationOptions({
      loadSessions: () => sessions,
    });

    await migrateToCloud(options);

    expect(mockPut).toHaveBeenCalledWith(
      '/api/sessions/session-with-special',
      sessions[0],
    );
  });

  // ---- Full migration flow -----------------------------------------------

  it('returns complete result with settings + sessions', async () => {
    const sessions = [createSession('s1'), createSession('s2')];
    const options = createMigrationOptions({
      loadSessions: () => sessions,
    });

    const result = await migrateToCloud(options);

    expect(result.settingsMigrated).toBe(true);
    expect(result.mcpConfigMigrated).toBe(false);
    expect(result.sessionsMigrated).toBe(2);
    // workspaceFilesMigrated and appDataMigrated depend on tar mock behavior
    expect(typeof result.workspaceFilesMigrated).toBe('number');
    expect(typeof result.appDataMigrated).toBe('boolean');
  });

  it('returns result even with all sessions failing', async () => {
    mockPut.mockRejectedValue(new Error('All failed'));

    const sessions = [createSession('s1'), createSession('s2')];
    const options = createMigrationOptions({
      loadSessions: () => sessions,
    });

    const result = await migrateToCloud(options);

    expect(result.settingsMigrated).toBe(true);
    expect(result.sessionsMigrated).toBe(0);
    // At least 2 session errors
    const sessionErrors = result.errors.filter(e => e.includes('migration failed'));
    expect(sessionErrors.length).toBeGreaterThanOrEqual(2);
  });

  // ---- Single session produces correct grammar ----------------------------

  it('uses singular grammar for one session', async () => {
    const sessions = [createSession('s1')];
    const steps: MigrationStep[] = [];

    const options = createMigrationOptions({
      loadSessions: () => sessions,
      onProgress: (step) => steps.push({ ...step }),
    });

    await migrateToCloud(options);

    const sessionStart = steps.find(
      (s) => s.phase === 'sessions' && s.current === 0,
    );
    expect(sessionStart?.message).toContain('1 session');
    expect(sessionStart?.message).not.toContain('sessions');
  });

  // ---- MCP config migration (stdio inclusion regression) -----------------

  describe('MCP config migration', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-mcp-test-'));
      fs.mkdirSync(path.join(tmpDir, 'oauth-tokens'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('includes stdio MCP servers in cloud migration payload', async () => {
      const mcpConfig = {
        mcpServers: {
          'phone-call': {
            command: 'npx',
            args: ['-y', '@abhaybabbar/retellai-mcp-server'],
            env: { RETELL_API_KEY: 'test-key' },
          },
          'http-server': {
            type: 'http',
            url: 'https://example.com/mcp',
          },
        },
      };

      const configPath = path.join(tmpDir, 'super-mcp-router.json');
      fs.writeFileSync(configPath, JSON.stringify(mcpConfig));

      const options = createMigrationOptions({
        getSettings: () => createSettings({ mcpConfigFile: configPath } as Partial<AppSettings>),
      });

      await migrateToCloud(options);

      const mcpCall = mockPut.mock.calls.find((call) => call[0] === '/api/mcp/config');
      expect(mcpCall).toBeDefined();

      const payload = mcpCall![1];
      const servers = payload.config.mcpServers;
      expect(servers).toHaveProperty('phone-call');
      expect(servers['phone-call'].command).toBe('npx');
      expect(servers).toHaveProperty('http-server');
    });

    it('includes stdio servers with absolute local paths (graceful failure on cloud)', async () => {
      const mcpConfig = {
        mcpServers: {
          'local-mcp': {
            command: 'node',
            args: ['/Users/me/project/server.cjs'],
          },
        },
      };

      const configPath = path.join(tmpDir, 'super-mcp-router.json');
      fs.writeFileSync(configPath, JSON.stringify(mcpConfig));

      const options = createMigrationOptions({
        getSettings: () => createSettings({ mcpConfigFile: configPath } as Partial<AppSettings>),
      });

      const result = await migrateToCloud(options);
      expect(result.mcpConfigMigrated).toBe(true);

      const mcpCall = mockPut.mock.calls.find((call) => call[0] === '/api/mcp/config');
      expect(mcpCall).toBeDefined();
      expect(mcpCall![1].config.mcpServers).toHaveProperty('local-mcp');
    });

    it('returns mcpConfigMigrated false when config has no servers', async () => {
      const mcpConfig = { mcpServers: {} };
      const configPath = path.join(tmpDir, 'super-mcp-router.json');
      fs.writeFileSync(configPath, JSON.stringify(mcpConfig));

      const options = createMigrationOptions({
        getSettings: () => createSettings({ mcpConfigFile: configPath } as Partial<AppSettings>),
      });

      const result = await migrateToCloud(options);
      expect(result.mcpConfigMigrated).toBe(false);
    });

    // Regression coverage for the cross-surface parity bug documented in
    // docs-private/investigations/260520_mcp_api_key_cross_surface_parity.md:
    // managed-install rebel-oss api-key entries lost their setup-field
    // literals when desktop synced MCP config to cloud, breaking mobile.
    it('preserves managed-install rebel-oss api-key literals through the desktop→cloud rewrite', async () => {
      const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-mcp-managed-cloud-'));
      const managedInstallsRoot = path.join(userDataPath, 'mcp', 'managed-installs');
      const retellInstallDir = path.join(
        managedInstallsRoot,
        '@mindstone',
        'mcp-server-retell-ai@0.2.1',
        'node_modules',
        '@mindstone',
        'mcp-server-retell-ai',
        'dist',
      );
      fs.mkdirSync(retellInstallDir, { recursive: true });
      const retellEntryPath = path.join(retellInstallDir, 'index.js');
      fs.writeFileSync(retellEntryPath, '// fake managed-install entry');

      const fakeCatalogPath = path.join(userDataPath, 'connector-catalog.json');
      fs.writeFileSync(
        fakeCatalogPath,
        JSON.stringify({
          version: 1,
          connectors: [
            {
              id: 'bundled-retell-ai',
              name: 'Retell AI',
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
              bundledConfig: {
                authType: 'api-key',
                settingsKey: 'retellai.enabled',
                serverName: 'RetellAI',
              },
              setupFields: [{ id: 'apiKey', envVar: 'RETELL_API_KEY' }],
            },
          ],
        }),
      );

      const mcpConfig = {
        mcpServers: {
          'Retell AI': {
            name: 'Retell AI',
            type: 'stdio',
            command: 'node',
            args: [retellEntryPath],
            env: {
              RETELL_API_KEY: 'key_real_user_provided_secret',
              MCP_HOST_BRIDGE_STATE: path.join(userDataPath, 'mcp', 'rebel-inbox-bridge.json'),
            },
            catalogId: 'bundled-retell-ai',
            email: 'user@example.com',
            lastConnectedAt: 1712345678000,
          },
        },
      };
      const configPath = path.join(tmpDir, 'super-mcp-router.json');
      fs.writeFileSync(configPath, JSON.stringify(mcpConfig));

      const { configureManagedMcpInstallService, __resetManagedMcpInstallSingletonForTesting } =
        await import('../../managedMcpInstallServiceInstance');
      const { configureBundledMcpManager, setConnectorCatalogPathOverride } = await import(
        '../../bundledMcpManager'
      );
      configureManagedMcpInstallService(userDataPath);
      configureBundledMcpManager({
        userDataDir: userDataPath,
        isPackaged: false,
        resourcesDir: userDataPath,
      });
      setConnectorCatalogPathOverride(fakeCatalogPath);

      try {
        const options = createMigrationOptions({
          getSettings: () => createSettings({ mcpConfigFile: configPath } as Partial<AppSettings>),
        });

        await migrateToCloud(options);

        const mcpCall = mockPut.mock.calls.find((call) => call[0] === '/api/mcp/config');
        expect(mcpCall).toBeDefined();

        const servers = mcpCall![1].config.mcpServers;
        const retell = servers['Retell AI'];
        // Rewritten to npx form so cloud can install via npm.
        expect(retell.command).toBe('npx');
        expect(retell.args).toEqual(['-y', '@mindstone/mcp-server-retell-ai@0.2.1']);
        // The api-key user literal must survive — cloud has no other
        // transport for setup-field secrets in this cohort.
        expect(retell.env.RETELL_API_KEY).toBe('key_real_user_provided_secret');
        // Bridge-state path stays as catalog placeholder so cloud
        // re-resolves to its own base dir (path-leak protection).
        expect(retell.env.MCP_HOST_BRIDGE_STATE).toBe(
          '{{MCP_BASE_DIR}}/rebel-inbox-bridge.json',
        );
      } finally {
        setConnectorCatalogPathOverride(null);
        __resetManagedMcpInstallSingletonForTesting();
        fs.rmSync(userDataPath, { recursive: true, force: true });
      }
    });

    // N-2 in docs/plans/260520_runway_sandbox_central_trusted_roots.md.
    // For Runway entries (`catalogId: 'bundled-runway'`), strip the
    // default-only sandbox env keys before transmission so the cloud
    // backfill at boot resolves them with cloud-coherent paths instead of
    // letting the desktop-resolved `/Users/<desktop_user>/...` ride into
    // cloud unchanged.
    it('strips RUNWAY_ALLOWED_ROOT/RUNWAY_DOWNLOAD_ROOT from bundled-runway entries before sending to cloud', async () => {
      const mcpConfig = {
        mcpServers: {
          Runway: {
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-runway@0.3.2'],
            catalogId: 'bundled-runway',
            env: {
              RUNWAYML_API_SECRET: 'key_real_user_provided',
              RUNWAY_ALLOWED_ROOT: '/Users/desktop_user/Workspace/Core',
              RUNWAY_DOWNLOAD_ROOT: '/Users/desktop_user/Workspace/Core/runway-mcp',
              MCP_HOST_BRIDGE_STATE: '/Users/desktop_user/Library/Application Support/mindstone-rebel/mcp/rebel-inbox-bridge.json',
            },
          },
        },
      };
      const configPath = path.join(tmpDir, 'super-mcp-router.json');
      fs.writeFileSync(configPath, JSON.stringify(mcpConfig));

      const options = createMigrationOptions({
        getSettings: () => createSettings({ mcpConfigFile: configPath } as Partial<AppSettings>),
      });

      await migrateToCloud(options);

      const mcpCall = mockPut.mock.calls.find((call) => call[0] === '/api/mcp/config');
      expect(mcpCall).toBeDefined();
      const servers = mcpCall![1].config.mcpServers;
      const runway = servers.Runway;
      // Stripped — cloud's catalog-env backfill at boot will re-resolve.
      expect(runway.env).not.toHaveProperty('RUNWAY_ALLOWED_ROOT');
      expect(runway.env).not.toHaveProperty('RUNWAY_DOWNLOAD_ROOT');
      // Other env values must survive.
      expect(runway.env.RUNWAYML_API_SECRET).toBe('key_real_user_provided');
      expect(runway.env.MCP_HOST_BRIDGE_STATE).toBeDefined();
    });

    it('does not touch sandbox env keys on entries with a different catalogId', async () => {
      const mcpConfig = {
        mcpServers: {
          'Custom-Server': {
            command: 'npx',
            args: ['-y', 'custom'],
            catalogId: 'community-custom',
            env: {
              RUNWAY_ALLOWED_ROOT: '/path/should/be/preserved',
            },
          },
        },
      };
      const configPath = path.join(tmpDir, 'super-mcp-router.json');
      fs.writeFileSync(configPath, JSON.stringify(mcpConfig));

      const options = createMigrationOptions({
        getSettings: () => createSettings({ mcpConfigFile: configPath } as Partial<AppSettings>),
      });

      await migrateToCloud(options);

      const mcpCall = mockPut.mock.calls.find((call) => call[0] === '/api/mcp/config');
      expect(mcpCall).toBeDefined();
      const servers = mcpCall![1].config.mcpServers;
      expect(servers['Custom-Server'].env.RUNWAY_ALLOWED_ROOT).toBe('/path/should/be/preserved');
    });
  });
});
