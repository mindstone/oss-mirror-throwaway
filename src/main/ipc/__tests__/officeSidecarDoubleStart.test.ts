import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

const { loggerMock, handlers } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('@core/logger', () => ({
  logger: loggerMock,
  createLogger: () => loggerMock,
  createScopedLogger: () => loggerMock,
  createTurnSessionLogger: () => loggerMock,
}));

vi.mock('@core/userDataWriteGate', () => ({
  isUserDataReadOnly: () => false,
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn);
  },
}));

vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => null,
}));

vi.mock('../../services/mcpService', () => ({
  describeMcpConfiguration: vi.fn(async () => ({})),
  resolveMcpConfigPath: vi.fn(),
  fetchPackageTools: vi.fn(),
  invalidateConnectedPackagesCache: vi.fn(),
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution: vi.fn(),
  reconfigureSuperMcpWithCacheRefreshDetached: vi.fn(),
  restartSuperMcpForConfigChangeAndAwaitExecution: vi.fn(async () => undefined),
}));
vi.mock('../../services/superMcpHttpManager', () => ({
  superMcpHttpManager: { getState: () => ({ isRunning: false, url: null }) },
}));
vi.mock('../../services/systemHealthService', () => ({
  startSuperMcpWithRetries: vi.fn(),
}));
vi.mock('../../services/workspaceWatcherService', () => ({
  workspaceWatcherService: { ensureForWorkspace: vi.fn(), stop: vi.fn() },
}));
vi.mock('../../services/libraryBroadcaster', () => ({
  libraryBroadcaster: { broadcast: vi.fn() },
}));
vi.mock('../../services/mcpConfigManager', () => ({
  ensureRouterConfigFile: vi.fn(),
  upsertMcpServerEntry: vi.fn(async () => ({ backupPath: null })),
  patchRouterConfigPaths: vi.fn(),
  readMcpServerDetails: vi.fn(),
  setMcpToolEnabled: vi.fn(),
  setMcpServerDisabled: vi.fn(),
  isServerDisabled: vi.fn(),
  findExistingCatalogServer: vi.fn(async () => ({ exists: false, serverName: null })),
}));
vi.mock('../../services/mcpServerRemovalService', () => ({
  removeMcpServerWithCleanup: vi.fn(),
}));
vi.mock('../../services/bundledMcpManager', () => ({
  buildSplitRebelInboxPayload: vi.fn(),
  buildSplitRebelMeetingsPayload: vi.fn(),
  buildSplitRebelSearchAndConversationsPayload: vi.fn(),
  buildSplitRebelAutomationsPayload: vi.fn(),
  buildSplitRebelSpacesPayload: vi.fn(),
  buildSplitRebelSettingsPayload: vi.fn(),
  buildSplitRebelMcpConnectorsPayload: vi.fn(),
  buildSplitRebelPluginsPayload: vi.fn(),
  isSelfConfiguringMcp: vi.fn((serverName: string) => serverName !== 'RebelOffice'),
  buildSelfConfiguringMcpPayload: vi.fn(),
  getProviderKeyMapping: vi.fn(() => undefined),
  findRebelOssConnectorsUsingProviderKey: vi.fn().mockResolvedValue([]),
  migrateLegacyWrapperSettingsIfNeeded: vi.fn(),
  migrateRebelTaskQueueToInbox: vi.fn(),
  DISCOURSE_CUSTOM_SERVERS: [],
  writeDiscourseProfile: vi.fn(),
  buildDiscourseWritePayload: vi.fn(),
  buildStandaloneDiscoursePayload: vi.fn(),
  buildPayloadFromCatalog: vi.fn(async () => ({
    name: 'RebelOffice',
    transport: 'stdio',
    command: 'node',
    args: ['office-server.js'],
    catalogId: 'bundled-office',
  })),
  lookupCatalogEntry: vi.fn(() => ({ id: 'bundled-office' })),
  resolveConnectorCatalogPath: vi.fn(() => path.join(process.cwd(), 'resources', 'connector-catalog.json')),
}));
vi.mock('../../services/systemSettingsSync', () => ({
  createLibrarySymlink: vi.fn(),
  createAgentsMdSymlink: vi.fn(),
  createClaudeMdSymlink: vi.fn(),
}));
vi.mock('../../services/spaceService', () => ({
  ensureChiefOfStaffSpace: vi.fn(),
  rewritePath: vi.fn(),
}));
vi.mock('../../utils/systemUtils', () => ({
  getUsername: vi.fn().mockReturnValue('testuser'),
}));
vi.mock('../../services/fileWatcherService', () => ({
  stopWatching: vi.fn(),
}));
vi.mock('../../services/gracefulShutdown', () => ({
  gracefulShutdownServicesOnly: vi.fn(),
}));
vi.mock('../../services/localModelProxyServer', () => ({
  proxyManager: { start: vi.fn(), stop: vi.fn() },
}));
vi.mock('../../services/toolUsageStore', () => ({
  getFrequentToolsWithCounts: vi.fn().mockReturnValue([]),
  clearToolUsage: vi.fn().mockReturnValue(true),
}));
vi.mock('../../services/achievementsStore', () => ({
  markJourneyDayComplete: vi.fn(),
  getOnboardingJourney: vi.fn(),
}));
vi.mock('../../services/achievementsEvaluator', () => ({
  getCurrentJourneyDay: vi.fn(),
}));
vi.mock('../../services/apiKeyValidation', () => ({
  VALIDATION_TIMEOUT_MS: 5_000,
  validateOpenAiKey: vi.fn(),
  validateClaudeKey: vi.fn(),
  validateElevenLabsKey: vi.fn(),
}));
vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
      onAuthStateChange: vi.fn(() => () => {}),
      getAccessToken: vi.fn(async () => null),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      getCachedAuthConfig: vi.fn(() => null),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      refreshLicenseTier: vi.fn(async () => 'free'),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      clearCachedProviderKey: vi.fn(),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

import { defaultCapabilities, setPlatformConfig, type PlatformConfig } from '@core/platform';
import { describeMcpConfiguration, resolveMcpConfigPath, restartSuperMcpForConfigChangeAndAwaitExecution } from '../../services/mcpService';
import { buildPayloadFromCatalog, lookupCatalogEntry, resolveConnectorCatalogPath } from '../../services/bundledMcpManager';
import { findExistingCatalogServer, upsertMcpServerEntry } from '../../services/mcpConfigManager';
import {
  createOfficeSidecarManager,
  setOfficeSidecarManagerForShutdown,
  startOfficeSidecar,
  type OfficeSidecarManager,
  type OfficeSidecarManagerOptions,
} from '../../services/officeSidecarManager';
import { registerSettingsHandlers } from '../settingsHandlers';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(_signal: NodeJS.Signals = 'SIGTERM'): boolean {
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit('exit', 0, null);
    });
    return true;
  }
}

function buildPlatformConfig(userDataPath: string): PlatformConfig {
  return {
    userDataPath,
    appPath: '/tmp/mindstone-rebel-test-app',
    tempPath: os.tmpdir(),
    logsPath: path.join(userDataPath, 'logs'),
    homePath: os.homedir(),
    documentsPath: path.join(os.homedir(), 'Documents'),
    desktopPath: path.join(os.homedir(), 'Desktop'),
    appDataPath: path.join(os.homedir(), 'AppData'),
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

function makeStore(initial: Partial<AppSettings> = {}) {
  let state = initial as AppSettings;
  return {
    get store() {
      return state;
    },
    set store(next: AppSettings) {
      state = next;
    },
  };
}

function makeDeps(store: ReturnType<typeof makeStore>) {
  return {
    getSettings: () => store.store,
    getSettingsStore: () => store as any,
    ensureNormalizedSettings: vi.fn(),
    applyVoiceActivationHotkey: vi.fn().mockReturnValue({ success: true }),
    getPendingVoiceActivationHotkey: vi.fn().mockReturnValue(null),
    setPendingVoiceActivationHotkey: vi.fn(),
    broadcastDiagnosticsUpdate: vi.fn(),
    scheduleDiagnosticsExpiry: vi.fn(),
    getWindowForEvent: vi.fn().mockReturnValue(null),
  };
}

describe('office sidecar double-start regression', () => {
  let tempDir: string;
  let manager: OfficeSidecarManager | null = null;
  let spawnChildCount: number;

  beforeEach(async () => {
    handlers.clear();
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sidecar-double-start-'));
    setPlatformConfig(buildPlatformConfig(tempDir));
    setOfficeSidecarManagerForShutdown(null);

    vi.mocked(resolveMcpConfigPath).mockReturnValue(path.join(tempDir, 'mcp', 'super-mcp-router.json'));
    vi.mocked(describeMcpConfiguration).mockResolvedValue({} as Awaited<ReturnType<typeof describeMcpConfiguration>>);
    vi.mocked(restartSuperMcpForConfigChangeAndAwaitExecution).mockResolvedValue(undefined);
    vi.mocked(findExistingCatalogServer).mockResolvedValue({ exists: false });
    vi.mocked(lookupCatalogEntry).mockReturnValue({ id: 'bundled-office' });
    vi.mocked(resolveConnectorCatalogPath).mockReturnValue(path.join(process.cwd(), 'resources', 'connector-catalog.json'));
    vi.mocked(buildPayloadFromCatalog).mockResolvedValue({
      name: 'RebelOffice',
      transport: 'stdio',
      command: 'node',
      args: ['office-server.js'],
      catalogId: 'bundled-office',
    });
    vi.mocked(upsertMcpServerEntry).mockResolvedValue({ backupPath: null });

    const fakeCliPath = path.join(tempDir, 'office-sidecar-cli.js');
    const fakeAddinDir = path.join(tempDir, 'office-addin');
    await fs.mkdir(fakeAddinDir, { recursive: true });
    await fs.writeFile(fakeCliPath, '// test cli stub\n', 'utf8');

    let nextPid = 4_000;
    spawnChildCount = 0;
    const spawnChild: NonNullable<OfficeSidecarManagerOptions['spawnChild']> = (_modulePath, _args, _options) => {
      spawnChildCount += 1;
      const child = new FakeChild(nextPid++);
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({
          type: 'ready',
          pid: child.pid,
          port: 52_100,
          token: 'a'.repeat(32),
          stateFilePath: path.join(tempDir, 'mcp', 'rebeloffice', 'sidecar-state.json'),
          wefInstallResults: [],
        })}\n`);
      });
      return child as unknown as ChildProcess;
    };

    manager = createOfficeSidecarManager({
      platformConfig: buildPlatformConfig(tempDir),
      errorReporter: {
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        addBreadcrumb: vi.fn(),
      },
      spawnChild,
      resolveSidecarScript: () => fakeCliPath,
      resolveAddinDir: () => fakeAddinDir,
      timings: {
        startTimeoutMs: 100,
        healthTimeoutMs: 50,
        identifyTimeoutMs: 50,
        lockRetryDelayMs: 10,
        lockMaxAttempts: 5,
        stopTimeoutMs: 50,
        stopPollIntervalMs: 5,
        restartBackoffsMs: [20, 40, 60, 80, 100],
        stabilityResetMs: 100,
      },
    });
    setOfficeSidecarManagerForShutdown(manager);
    registerSettingsHandlers(makeDeps(makeStore({ providerKeys: {} })));
  });

  afterEach(async () => {
    await manager?.stop();
    setOfficeSidecarManagerForShutdown(null);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('coalesces settings-handler and bundledInboxBridge start triggers into one spawn', async () => {
    const addHandler = handlers.get('settings:mcp-add-bundled-server');
    expect(addHandler).toBeDefined();

    // Simulate the settings IPC path and the bundledInboxBridge safety-net path
    // racing to start the sidecar for the same Office connector add/upsert.
    await Promise.all([
      addHandler?.(null, {
        serverName: 'RebelOffice',
        catalogId: 'bundled-office',
      }),
      startOfficeSidecar(),
    ]);

    expect(spawnChildCount).toBe(1);
    expect(manager?.isRunning()).toBe(true);
  });
});
