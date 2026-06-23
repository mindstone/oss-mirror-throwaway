import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSettings } from '@shared/types';
import {
  DEFAULT_VOICE_ACTIVATION_HOTKEY,
  DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
} from '@shared/types';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../bundledMcpManager', () => ({
  configureBundledMcpManager: vi.fn(),
  buildSplitRebelInboxPayload: vi.fn(() => ({ name: 'RebelInbox' })),
  buildSplitRebelMeetingsPayload: vi.fn(() => ({ name: 'RebelMeetings' })),
  buildSplitRebelSearchAndConversationsPayload: vi.fn(() => ({ name: 'RebelSearchAndConversations' })),
  buildSplitRebelAutomationsPayload: vi.fn(() => ({ name: 'RebelAutomations' })),
  buildSplitRebelSpacesPayload: vi.fn(() => ({ name: 'RebelSpaces' })),
  buildSplitRebelSettingsPayload: vi.fn(() => ({ name: 'RebelSettings' })),
  buildSplitRebelMcpConnectorsPayload: vi.fn(() => ({ name: 'RebelMcpConnectors' })),
  buildSplitRebelPluginsPayload: vi.fn(() => ({ name: 'RebelPlugins' })),
  buildRebelDiagnosticsPayload: vi.fn(() => ({ name: 'RebelDiagnostics' })),
  buildRebelCanvasPayload: vi.fn(() => ({ name: 'RebelCanvas' })),
  buildDiscoursePayload: vi.fn(() => ({ name: 'RebelsCommunity' })),
  writeRebelBridgeState: vi.fn(),
}));

vi.mock('../bundledInboxBridge', () => ({
  startBundledInboxBridge: vi.fn(async () => ({ port: 3456, token: 'test-token' })),
  setAutomationSchedulerGetter: vi.fn(),
  setMeetingBotServiceGetter: vi.fn(),
}));

vi.mock('../mcpService', () => ({
  warmPlatformPromptCache: vi.fn(async () => 'cached content'),
}));

vi.mock('../mcpConfigManager', () => ({
  ensureRouterConfigFile: vi.fn(),
  upsertMcpServersBatch: vi.fn(async () => ({ backupPath: null, count: 9 })),
}));

vi.mock('@main/settingsStore', () => ({
  ensureNormalizedSettings: vi.fn(),
}));

vi.mock('../memoryUpdateService', () => ({
  initializeMemoryUpdateService: vi.fn(),
}));

vi.mock('../errorRecoveryService', () => ({
  initializeErrorRecoveryService: vi.fn(),
}));

vi.mock('../bundledMcpCloudRegistration', () => ({
  discoverBundledOAuthMcps: vi.fn(async () => []),
}));

const mockAppBridgeStart = vi.fn(async () => null);
const mockAppBridgeManager = {
  start: mockAppBridgeStart,
  stop: vi.fn(async () => {}),
  isRunning: vi.fn(() => false),
  getState: vi.fn(() => null),
  getSkipReason: vi.fn(() => null),
  listPairedClients: vi.fn(() => []),
  listPairedExtensionIds: vi.fn(() => []),
  getLastError: vi.fn(() => null),
  retryStart: vi.fn(async () => null),
};

vi.mock('../appBridgeInstallerService', () => ({
  getAppBridgeInstallerService: vi.fn(() => ({
    detectBrowsers: vi.fn(async () => []),
    registerNmhManifests: vi.fn(async () => []),
  })),
}));

vi.mock('../appBridgeManager', () => ({
  createAppBridgeManager: vi.fn(() => mockAppBridgeManager),
}));

vi.mock('../appBridgeIntentService', () => ({
  createAppBridgeIntentService: vi.fn(() => ({
    createConversation: vi.fn(),
    injectMessage: vi.fn(),
    getState: vi.fn(),
    getMessages: vi.fn(),
    streamConversation: vi.fn(),
    focusConversation: vi.fn(),
  })),
}));

const mockOfficeSidecarManager = {
  start: vi.fn(async () => null),
  stop: vi.fn(async () => {}),
  isRunning: vi.fn(() => false),
  getState: vi.fn(() => null),
  getSkipReason: vi.fn(() => null),
  getLastError: vi.fn(() => null),
  retryStart: vi.fn(async () => null),
};

vi.mock('../officeSidecarManager', () => ({
  createOfficeSidecarManager: vi.fn(() => mockOfficeSidecarManager),
}));

// Mock existsSync for Discourse path checks
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(() => false) };
});

// Space-maintenance wiring (Stage 1). Mocked so we can assert the call
// topology without touching a real filesystem. The adapter is mocked too
// because it imports Electron, which isn't available in the test runtime.
vi.mock('@core/services/spaceMaintenanceService', () => ({
  runStartupCleanup: vi.fn(async () => ({
    quarantinedIdentical: 0,
    orphansDeferred: 0,
    remainingConflicts: 0,
    elapsedMs: 0,
    timeBudgetExceeded: false,
    errors: [],
  })),
}));

vi.mock('../spaceMaintenanceAdapter', () => ({
  createDesktopMaintenanceDeps: vi.fn(() => ({ moveToTrash: vi.fn() })),
  createDesktopMaintenanceJournal: vi.fn(() => ({
    load: vi.fn(async () => ({ state: { schemaVersion: 1, updatedAt: 0, entries: [] }, mutable: true })),
    save: vi.fn(),
    getFilePath: vi.fn(() => '/tmp/test-user-data/space-maintenance-journal.json'),
  })),
  runDriveHistoryMigrationFromMain: vi.fn(async () => ({
    attempted: false,
    skippedBecauseAlreadyCompleted: true,
    scannedSpaces: 0,
    foundHistoryDirs: 0,
    trashedHistoryDirs: 0,
    errors: [],
  })),
}));

// Platform config is NOT mocked — the test file already calls
// `setPlatformConfig(buildPlatformConfig())` in beforeEach, which gives
// every test a real 'desktop' surface by default. Step 12's non-desktop
// skip path is exercised below by calling `setPlatformConfig({ surface:
// 'cloud' })` inside that specific test. This avoids vitest 4.x's strict
// rejection of mock-missing exports (it would refuse `setPlatformConfig`
// calls against a partial mock) and keeps the rest of the file's
// assertions (userDataPath, errorReporter, etc.) intact.

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { initCoreServices, getMcpRegistrationStatus, type CoreStartupDeps } from '../coreStartup';
import { configureBundledMcpManager, writeRebelBridgeState } from '../bundledMcpManager';
import {
  startBundledInboxBridge,
  setAutomationSchedulerGetter,
  setMeetingBotServiceGetter as _setMeetingBotServiceGetter,
} from '../bundledInboxBridge';
import { warmPlatformPromptCache } from '../mcpService';
import { ensureRouterConfigFile, upsertMcpServersBatch } from '../mcpConfigManager';
import { ensureNormalizedSettings } from '@main/settingsStore';
import { existsSync } from 'node:fs';
import { setBroadcastService } from '@core/broadcastService';
import { setErrorReporter } from '@core/errorReporter';
import { defaultCapabilities, setPlatformConfig, type PlatformConfig } from '@core/platform';
import { initializeMemoryUpdateService } from '../memoryUpdateService';
import { initializeErrorRecoveryService } from '../errorRecoveryService';
import { discoverBundledOAuthMcps } from '../bundledMcpCloudRegistration';
import { createOfficeSidecarManager } from '../officeSidecarManager';
import { runStartupCleanup } from '@core/services/spaceMaintenanceService';
import {
  createDesktopMaintenanceDeps,
  createDesktopMaintenanceJournal,
  runDriveHistoryMigrationFromMain,
} from '../spaceMaintenanceAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseSettings: AppSettings = {
  coreDirectory: null,
  mcpConfigFile: null,
  onboardingCompleted: false,
  userFirstName: null,
  userEmail: null,
  onboardingFirstCompletedAt: null,
  voice: {
    provider: 'openai-whisper',
    openaiApiKey: null,
    elevenlabsApiKey: null,
    model: 'gpt-4o-mini-transcribe-2025-12-15',
    ttsVoice: null,
    activationHotkey: DEFAULT_VOICE_ACTIVATION_HOTKEY,
    activationHotkeyVoiceMode: DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
  },
  models: {
    apiKey: 'test-key',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-5',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: true,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  diagnostics: { debugBreadcrumbsUntil: null },
};

const makeDeps = (overrides?: Partial<CoreStartupDeps>): CoreStartupDeps => ({
  userDataDir: '/tmp/test-user-data',
  resourcesDir: '/tmp/test-resources',
  isPackaged: false,
  routerConfigPath: '/tmp/test-user-data/mcp/super-mcp-router.json',
  getSettings: () => baseSettings,
  ...overrides,
});

function buildPlatformConfig(): PlatformConfig {
  return {
    userDataPath: '/tmp/test-user-data',
    appPath: '/tmp/test-app',
    tempPath: '/tmp',
    logsPath: '/tmp/test-user-data/logs',
    homePath: '/tmp',
    documentsPath: '/tmp/Documents',
    desktopPath: '/tmp/Desktop',
    appDataPath: '/tmp/AppData',
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

const setElectronVersionForTest = (value: string | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(process.versions, 'electron');
    return;
  }
  Object.defineProperty(process.versions, 'electron', {
    value,
    configurable: true,
  });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initCoreServices', () => {
  let savedStreamTimeout: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    setElectronVersionForTest('test-electron');
    savedStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    setPlatformConfig(buildPlatformConfig());
    setBroadcastService({
      sendToAllWindows: vi.fn(),
      sendToFocusedWindow: vi.fn(),
    });
    setErrorReporter({
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    });
  });

  afterEach(() => {
    setElectronVersionForTest(undefined);
    // Restore env var
    if (savedStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = savedStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }
  });

  // ── 1. Calls all initialization functions ──

  it('calls all initialization functions', async () => {
    const deps = makeDeps();
    await initCoreServices(deps);

    expect(configureBundledMcpManager).toHaveBeenCalledWith({
      userDataDir: '/tmp/test-user-data',
      resourcesDir: '/tmp/test-resources',
      isPackaged: false,
    });
    expect(ensureNormalizedSettings).toHaveBeenCalled();
    expect(warmPlatformPromptCache).toHaveBeenCalled();
    expect(ensureRouterConfigFile).toHaveBeenCalledWith(deps.routerConfigPath);
    expect(startBundledInboxBridge).toHaveBeenCalled();
    expect(writeRebelBridgeState).toHaveBeenCalledWith({ port: 3456, token: 'test-token' });
    expect(upsertMcpServersBatch).toHaveBeenCalledWith(
      deps.routerConfigPath,
      expect.arrayContaining([
        expect.objectContaining({ name: 'RebelInbox' }),
        expect.objectContaining({ name: 'RebelDiagnostics' }),
      ]),
    );
    expect(createOfficeSidecarManager).toHaveBeenCalledWith({
      platformConfig: expect.objectContaining({ userDataPath: '/tmp/test-user-data', surface: 'desktop' }),
      errorReporter: expect.objectContaining({
        captureException: expect.any(Function),
        captureMessage: expect.any(Function),
        addBreadcrumb: expect.any(Function),
      }),
    });
    expect(mockOfficeSidecarManager.start).not.toHaveBeenCalled();
  });

  // ── 2. Returns bridge state on success ──

  it('returns bridge state on success', async () => {
    const result = await initCoreServices(makeDeps());
    expect(result.bridgeState).toEqual({ port: 3456, token: 'test-token' });
  });

  it('returns the office sidecar manager without starting it', async () => {
    const result = await initCoreServices(makeDeps());

    expect(result.officeSidecarManager).toBe(mockOfficeSidecarManager);
    expect(mockOfficeSidecarManager.start).not.toHaveBeenCalled();
  });

  // ── 3. Returns MCP count on success ──

  it('returns registered MCP count on success', async () => {
    const result = await initCoreServices(makeDeps());
    expect(result.registeredMcpCount).toBe(9);
  });

  // ── 4. Handles warmPlatformPromptCache failure gracefully ──

  it('handles warmPlatformPromptCache failure gracefully', async () => {
    vi.mocked(warmPlatformPromptCache).mockRejectedValueOnce(new Error('cache read failed'));

    const result = await initCoreServices(makeDeps());

    expect(result.errors).toContainEqual(
      expect.objectContaining({ service: 'warmPlatformPromptCache' }),
    );
    // Other services should still succeed
    expect(result.bridgeState).toEqual({ port: 3456, token: 'test-token' });
    expect(result.registeredMcpCount).toBe(9);
  });

  // ── 5. Handles startBundledInboxBridge failure gracefully ──

  it('handles startBundledInboxBridge failure gracefully', async () => {
    vi.mocked(startBundledInboxBridge).mockRejectedValueOnce(new Error('bridge failed'));

    const result = await initCoreServices(makeDeps());

    expect(result.bridgeState).toBeNull();
    expect(result.errors).toContainEqual(
      expect.objectContaining({ service: 'startBundledInboxBridge' }),
    );
    // MCP registration should still succeed
    expect(result.registeredMcpCount).toBe(9);
  });

  // ── 6. Handles upsertMcpServersBatch failure gracefully ──

  it('handles upsertMcpServersBatch failure gracefully', async () => {
    vi.mocked(upsertMcpServersBatch).mockRejectedValueOnce(new Error('batch failed'));

    const result = await initCoreServices(makeDeps());

    expect(result.registeredMcpCount).toBe(0);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ service: 'upsertMcpServersBatch' }),
    );
    // Bridge should still succeed
    expect(result.bridgeState).toEqual({ port: 3456, token: 'test-token' });
  });

  // ── 7. Skips Discourse payload when script doesn't exist ──

  it('skips Discourse payload when script does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    await initCoreServices(makeDeps());

    const payloads = vi.mocked(upsertMcpServersBatch).mock.calls[0]?.[1] as Array<{ name: string }>;
    const names = payloads.map((p) => p.name);
    expect(names).not.toContain('RebelsCommunity');
  });

  // ── 8. Includes Discourse payload when script exists ──

  it('includes Discourse payload when script exists', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    await initCoreServices(makeDeps());

    const payloads = vi.mocked(upsertMcpServersBatch).mock.calls[0]?.[1] as Array<{ name: string }>;
    const names = payloads.map((p) => p.name);
    expect(names).toContain('RebelsCommunity');
  });

  // ── 9. Stage 2a: no OpenAI Image auto-registration on startup ──

  it('does not auto-register OpenAI Image payload at startup even when an OpenAI key exists', async () => {
    const settingsWithKey: AppSettings = {
      ...baseSettings,
      providerKeys: { openai: 'fake-test-key' },
      voice: { ...baseSettings.voice, openaiApiKey: 'fake-test-key' },
    };

    await initCoreServices(makeDeps({ getSettings: () => settingsWithKey }));

    const payloads = vi.mocked(upsertMcpServersBatch).mock.calls[0]?.[1] as Array<{ name: string }>;
    const names = payloads.map((p) => p.name);
    expect(names).not.toContain('OpenAIImageGeneration');
  });

  // ── 10. CLAUDE_CODE_STREAM_CLOSE_TIMEOUT env var ──

  it('sets CLAUDE_CODE_STREAM_CLOSE_TIMEOUT only if not already set', async () => {
    // Case 1: not set → should be set to 600000
    delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    await initCoreServices(makeDeps());
    expect(process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe('600000');
  });

  it('does not override CLAUDE_CODE_STREAM_CLOSE_TIMEOUT if already set', async () => {
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';
    await initCoreServices(makeDeps());
    expect(process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe('300000');
  });

  // ── 11. Wires automation scheduler getter when provided ──

  it('wires automation scheduler getter when provided', async () => {
    const getter = vi.fn(() => null as any);
    await initCoreServices(makeDeps({ getAutomationScheduler: getter }));

    expect(setAutomationSchedulerGetter).toHaveBeenCalled();
  });

  // ── 12. Does not wire automation scheduler getter when not provided ──

  it('does not wire automation scheduler getter when not provided', async () => {
    await initCoreServices(makeDeps());

    expect(setAutomationSchedulerGetter).not.toHaveBeenCalled();
  });

  // ── 13. Initializes memory update service when deps are provided ──

  it('initializes memory update service when deps are provided', async () => {
    const memDeps = {
      executeAgentTurn: vi.fn(),
      getSettings: () => baseSettings,
      broadcastMemoryUpdateStatus: vi.fn(),
    };
    await initCoreServices(makeDeps({ memoryUpdateDeps: memDeps }));

    expect(initializeMemoryUpdateService).toHaveBeenCalledWith(memDeps);
  });

  // ── 14. Skips memory update service when deps are not provided ──

  it('skips memory update service when deps are not provided', async () => {
    await initCoreServices(makeDeps());

    expect(initializeMemoryUpdateService).not.toHaveBeenCalled();
  });

  // ── 15. Initializes error recovery service when deps are provided ──

  it('initializes error recovery service when deps are provided', async () => {
    const errDeps = {
      executeAgentTurn: vi.fn(),
      getSettings: () => baseSettings,
      notifyRenderer: vi.fn(),
    };
    await initCoreServices(makeDeps({ errorRecoveryDeps: errDeps }));

    expect(initializeErrorRecoveryService).toHaveBeenCalledWith(errDeps);
  });

  // ── 17. Skips error recovery service when deps are not provided ──

  it('skips error recovery service when deps are not provided', async () => {
    await initCoreServices(makeDeps());

    expect(initializeErrorRecoveryService).not.toHaveBeenCalled();
  });

  // ── 18. Handles memory update init failure gracefully ──

  it('handles memory update init failure gracefully', async () => {
    vi.mocked(initializeMemoryUpdateService).mockImplementationOnce(() => {
      throw new Error('memory init boom');
    });

    const result = await initCoreServices(makeDeps({
      memoryUpdateDeps: {
        executeAgentTurn: vi.fn(),
        getSettings: () => baseSettings,
        broadcastMemoryUpdateStatus: vi.fn(),
      },
    }));

    expect(result.errors).toContainEqual(
      expect.objectContaining({ service: 'memoryUpdateService' }),
    );
    // Other services should still succeed
    expect(result.bridgeState).toEqual({ port: 3456, token: 'test-token' });
  });

  // ── 19. Handles error recovery init failure gracefully ──

  it('handles error recovery init failure gracefully', async () => {
    vi.mocked(initializeErrorRecoveryService).mockImplementationOnce(() => {
      throw new Error('recovery init boom');
    });

    const result = await initCoreServices(makeDeps({
      errorRecoveryDeps: {
        executeAgentTurn: vi.fn(),
        getSettings: () => baseSettings,
        notifyRenderer: vi.fn(),
      },
    }));

    expect(result.errors).toContainEqual(
      expect.objectContaining({ service: 'errorRecoveryService' }),
    );
    expect(result.bridgeState).toEqual({ port: 3456, token: 'test-token' });
  });

  // ── 20. Calls discoverBundledOAuthMcps with userDataDir ──

  it('calls discoverBundledOAuthMcps with userDataDir', async () => {
    await initCoreServices(makeDeps());

    expect(discoverBundledOAuthMcps).toHaveBeenCalledWith('/tmp/test-user-data');
  });

  // ── 21. Registers OAuth MCPs when discovered ──

  it('registers discovered OAuth MCPs and adds to count', async () => {
    vi.mocked(discoverBundledOAuthMcps).mockResolvedValueOnce([
      { name: 'GoogleWorkspace-test', transport: 'stdio', command: 'node', args: ['/test'] },
      { name: 'Slack-test', transport: 'stdio', command: 'node', args: ['/test'] },
    ]);
    // Second upsertMcpServersBatch call for OAuth MCPs
    vi.mocked(upsertMcpServersBatch)
      .mockResolvedValueOnce({ backupPath: null, count: 9 })   // first call: internal MCPs
      .mockResolvedValueOnce({ backupPath: null, count: 2 });   // second call: OAuth MCPs

    const result = await initCoreServices(makeDeps());

    expect(upsertMcpServersBatch).toHaveBeenCalledTimes(2);
    expect(result.registeredMcpCount).toBe(11); // 9 internal + 2 OAuth
  });

  // ── 22. Handles discoverBundledOAuthMcps failure gracefully ──

  it('handles discoverBundledOAuthMcps failure gracefully', async () => {
    vi.mocked(discoverBundledOAuthMcps).mockRejectedValueOnce(new Error('discovery boom'));

    const result = await initCoreServices(makeDeps());

    expect(result.errors).toContainEqual(
      expect.objectContaining({ service: 'discoverBundledOAuthMcps' }),
    );
    // Other services should still succeed
    expect(result.bridgeState).toEqual({ port: 3456, token: 'test-token' });
    expect(result.registeredMcpCount).toBe(9);
  });

  // ── 23. MCP Registration Status — lifecycle transitions ──

  it('resets MCP registration status to in_progress at start of initCoreServices', async () => {
    // Run once to put status into completed state
    await initCoreServices(makeDeps());
    expect(getMcpRegistrationStatus().lifecycle).toBe('completed');

    // Run again — should reset to in_progress then complete
    await initCoreServices(makeDeps());
    const status = getMcpRegistrationStatus();
    expect(status.lifecycle).toBe('completed');
    expect(status.capturedAt).toBeTruthy();
  });

  it('tracks registered servers in MCP registration status', async () => {
    const settingsWithMeetings: AppSettings = { ...baseSettings, meetingBotUnlocked: true };
    await initCoreServices(makeDeps({ getSettings: () => settingsWithMeetings }));

    const status = getMcpRegistrationStatus();
    expect(status.lifecycle).toBe('completed');
    expect(status.registered).toContain('RebelInbox');
    expect(status.registered).toContain('RebelDiagnostics');
    expect(status.registered).toContain('RebelCanvas');
    expect(status.registered).toContain('RebelMeetings');
    expect(status.gated).toHaveLength(0);
    expect(status.failed).toHaveLength(0);
  });

  it('tracks gated RebelMeetings when meetingBotUnlocked is false', async () => {
    // baseSettings has meetingBotUnlocked undefined (not true)
    await initCoreServices(makeDeps());

    const status = getMcpRegistrationStatus();
    expect(status.gated).toEqual([{ id: 'RebelMeetings', code: 'feature_gate_meetingBotUnlocked' }]);
    expect(status.registered).not.toContain('RebelMeetings');
  });

  it('registers RebelMeetings when meetingBotUnlocked is true', async () => {
    const settingsWithMeetings: AppSettings = {
      ...baseSettings,
      meetingBotUnlocked: true,
    };
    await initCoreServices(makeDeps({ getSettings: () => settingsWithMeetings }));

    const status = getMcpRegistrationStatus();
    expect(status.registered).toContain('RebelMeetings');
    expect(status.gated).toHaveLength(0);
  });

  it('sets lifecycle to failed when upsertMcpServersBatch throws', async () => {
    vi.mocked(upsertMcpServersBatch).mockRejectedValueOnce(new Error('batch failed'));

    await initCoreServices(makeDeps());

    const status = getMcpRegistrationStatus();
    expect(status.lifecycle).toBe('failed');
    expect(status.failed).toContainEqual({ id: 'batch', code: 'upsert_batch_failed' });
    expect(status.capturedAt).toBeTruthy();
  });

  it('returns a copy from getMcpRegistrationStatus (not the mutable reference)', async () => {
    await initCoreServices(makeDeps());

    const status1 = getMcpRegistrationStatus();
    const status2 = getMcpRegistrationStatus();
    expect(status1).toEqual(status2);
    expect(status1).not.toBe(status2);
    expect(status1.registered).not.toBe(status2.registered);
    expect(status1.gated).not.toBe(status2.gated);
    expect(status1.failed).not.toBe(status2.failed);
  });

  // ── Step 12: Space-maintenance startup cleanup (F4) ──

  describe('space-maintenance startup cleanup', () => {
    it('skips runStartupCleanup when localFilesystemAccess capability is false', async () => {
      // Override the desktop default set in beforeEach; step 12 only runs
      // on hosts with localFilesystemAccess (desktop), so any non-desktop
      // surface must skip — and capabilities must be overridden consistently
      // with the surface, otherwise the gate (which now reads capabilities)
      // would inherit the stale desktop defaults from buildPlatformConfig().
      setPlatformConfig({
        ...buildPlatformConfig(),
        surface: 'cloud',
        capabilities: defaultCapabilities('cloud'),
      });

      await initCoreServices(makeDeps());

      expect(runStartupCleanup).not.toHaveBeenCalled();
    });

    it('invokes runStartupCleanup with coreDirectory + DI deps on desktop', async () => {
      // beforeEach already set a desktop platform config.
      const settingsWithCore: AppSettings = {
        ...baseSettings,
        coreDirectory: '/tmp/test-library',
      };

      await initCoreServices(makeDeps({ getSettings: () => settingsWithCore }));

      expect(createDesktopMaintenanceJournal).toHaveBeenCalledWith('/tmp/test-user-data');
      expect(createDesktopMaintenanceDeps).toHaveBeenCalled();
      expect(runStartupCleanup).toHaveBeenCalledWith(
        '/tmp/test-library',
        settingsWithCore,
        expect.objectContaining({ load: expect.any(Function), save: expect.any(Function) }),
        expect.objectContaining({ moveToTrash: expect.any(Function) }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('skips runStartupCleanup when capabilities.localFilesystemAccess is false on desktop surface', async () => {
      const desktopConfig = buildPlatformConfig();
      setPlatformConfig({
        ...desktopConfig,
        capabilities: { ...desktopConfig.capabilities, localFilesystemAccess: false },
      });
      const settingsWithCore: AppSettings = {
        ...baseSettings,
        coreDirectory: '/tmp/test-library',
      };

      await initCoreServices(makeDeps({ getSettings: () => settingsWithCore }));

      expect(runStartupCleanup).not.toHaveBeenCalled();
    });

    it('catches runStartupCleanup failures and records them on the startup result', async () => {
      vi.mocked(runStartupCleanup).mockRejectedValueOnce(new Error('maintenance boom'));

      const settingsWithCore: AppSettings = {
        ...baseSettings,
        coreDirectory: '/tmp/test-library',
      };
      const result = await initCoreServices(makeDeps({ getSettings: () => settingsWithCore }));

      expect(result.errors).toContainEqual(
        expect.objectContaining({ service: 'spaceMaintenanceStartupCleanup' }),
      );
      // App still boots — MCP registration still succeeds.
      expect(result.registeredMcpCount).toBe(9);
    });
  });

  describe('drive-history migration startup step', () => {
    it('skips drive-history migration when localFilesystemAccess capability is false', async () => {
      setPlatformConfig({
        ...buildPlatformConfig(),
        surface: 'cloud',
        capabilities: defaultCapabilities('cloud'),
      });
      await initCoreServices(makeDeps());
      expect(runDriveHistoryMigrationFromMain).not.toHaveBeenCalled();
    });

    it('invokes drive-history migration after startup cleanup on desktop', async () => {
      const settingsWithCore: AppSettings = {
        ...baseSettings,
        coreDirectory: '/tmp/test-library',
      };
      await initCoreServices(makeDeps({ getSettings: () => settingsWithCore }));
      expect(runDriveHistoryMigrationFromMain).toHaveBeenCalledWith(
        '/tmp/test-library',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('skips drive-history migration when capabilities.localFilesystemAccess is false on desktop surface', async () => {
      const desktopConfig = buildPlatformConfig();
      setPlatformConfig({
        ...desktopConfig,
        capabilities: { ...desktopConfig.capabilities, localFilesystemAccess: false },
      });
      const settingsWithCore: AppSettings = {
        ...baseSettings,
        coreDirectory: '/tmp/test-library',
      };
      await initCoreServices(makeDeps({ getSettings: () => settingsWithCore }));
      expect(runDriveHistoryMigrationFromMain).not.toHaveBeenCalled();
    });

    it('captures drive-history migration failures as non-fatal startup errors', async () => {
      vi.mocked(runDriveHistoryMigrationFromMain).mockRejectedValueOnce(new Error('migration boom'));
      const settingsWithCore: AppSettings = {
        ...baseSettings,
        coreDirectory: '/tmp/test-library',
      };
      const result = await initCoreServices(makeDeps({ getSettings: () => settingsWithCore }));
      expect(result.errors).toContainEqual(expect.objectContaining({ service: 'driveHistoryMigration' }));
      expect(result.registeredMcpCount).toBe(9);
    });
  });
});
