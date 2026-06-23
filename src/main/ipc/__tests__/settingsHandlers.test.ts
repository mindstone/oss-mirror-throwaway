/**
 * Settings handler coverage for the narrow-slice approval-flow channels.
 *
 * Covers the gaps flagged in Round-2 review:
 *  - F4-4 (audit-log emission): `settings:add-trusted-tool` must emit the
 *    structured `Added trusted tool atomically` log entry with the `toolId`
 *    field. The safetyPromptRoute.test only proves the route reaches the
 *    handler; the audit log itself was untested.
 *  - Route test mocks the handler, so the real
 *    `UNKNOWN_SPACE_ID` branch in `settings:set-space-safety-level` is not
 *    exercised on the actual settingsHandlers code path — we do that here.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OFFICE_MCP_PACKAGE_SPEC, OFFICE_MCP_PACKAGE_NAME, OFFICE_MCP_PACKAGE_VERSION } from '@shared/sidecar/officePackage';
import type { AppSettings, McpServerConfigDetails, McpServerUpsertPayload, TrustedTool } from '@shared/types';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above any import of the handlers module.
// ---------------------------------------------------------------------------

const loggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

const managedMcpInstallServiceMock = vi.hoisted(() => ({
  install: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  logger: loggerMock,
  createLogger: () => loggerMock,
  createScopedLogger: () => loggerMock,
  createTurnSessionLogger: () => loggerMock,
}));

let readOnlyFlag = false;
vi.mock('@core/userDataWriteGate', () => ({
  isUserDataReadOnly: () => readOnlyFlag,
}));

// Capture registered handlers so we can invoke them directly.
const handlers = new Map<string, (...args: any[]) => any>();
vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, fn: (...args: any[]) => any) => {
    handlers.set(channel, fn);
  },
}));

// Mock the bareToolId import target (dynamic import in the handler).
vi.mock('@shared/utils/trustedToolNormalization', () => ({
  bareToolId: (id: string) => {
    const slash = id.lastIndexOf('/');
    return (slash >= 0 ? id.slice(slash + 1) : id) as string & { __bareToolId: never };
  },
}));

// Stub the entire electron module — the handler file transitively imports
// from getElectronModule but the narrow-slice handlers we're testing don't
// need dialogs / app / BrowserWindow.
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => null,
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({
    userDataPath: '/tmp/test-userdata',
    totalMemoryBytes: 16 * 1024 * 1024 * 1024,
  }),
}));

// Broad stubs for the heavy transitive imports in settingsHandlers.ts —
// the narrow-slice channels we exercise don't touch these code paths, but
// the top-level imports must resolve for the module to load.
vi.mock('../../services/mcpService', () => ({
  describeMcpConfiguration: vi.fn(),
  resolveMcpConfigPath: vi.fn(),
  fetchPackageTools: vi.fn(),
  invalidateConnectedPackagesCache: vi.fn(),
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution: vi.fn(),
  reconfigureSuperMcpWithCacheRefreshDetached: vi.fn(),
  reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral: vi.fn(),
  restartSuperMcpForConfigChangeAndAwaitExecution: vi.fn(),
  validateMcpServerAfterConfigChange: vi.fn(),
}));
vi.mock('../../services/superMcpHttpManager', () => ({
  superMcpHttpManager: {
    getState: () => ({ isRunning: false, url: null }),
    isConfigured: vi.fn(() => true),
  },
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
  upsertMcpServerEntry: vi.fn(),
  patchRouterConfigPaths: vi.fn(),
  readMcpServerDetails: vi.fn(),
  touchMcpServerLastConnected: vi.fn(),
  setMcpToolEnabled: vi.fn(),
  setMcpServerDisabled: vi.fn(),
  isServerDisabled: vi.fn(),
  findExistingCatalogServer: vi.fn(),
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
  isSelfConfiguringMcp: vi.fn(),
  buildSelfConfiguringMcpPayload: vi.fn(),
  getProviderKeyMapping: vi.fn(),
  findRebelOssConnectorsUsingProviderKey: vi.fn().mockResolvedValue([]),
  migrateLegacyWrapperSettingsIfNeeded: vi.fn(async (settings: AppSettings) => settings),
  migrateRebelTaskQueueToInbox: vi.fn(),
  DISCOURSE_CUSTOM_SERVERS: [],
  writeDiscourseProfile: vi.fn(),
  buildDiscourseWritePayload: vi.fn(),
  buildStandaloneDiscoursePayload: vi.fn(),
  buildPayloadFromCatalog: vi.fn(),
  lookupCatalogEntry: vi.fn(),
  resolveConnectorCatalogPath: vi.fn(),
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
vi.mock('../../services/officeSidecarManager', () => ({
  startOfficeSidecar: vi.fn(async () => null),
  stopOfficeSidecar: vi.fn(async () => undefined),
}));
vi.mock('../../services/managedMcpInstallServiceInstance', () => ({
  getManagedMcpInstallService: vi.fn(() => managedMcpInstallServiceMock),
}));
vi.mock('../../services/localModelProxyServer', () => ({
  proxyManager: {
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
    setBaseProfile: vi.fn(),
    getUrl: vi.fn().mockReturnValue('http://127.0.0.1:11434'),
  },
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

// ---------------------------------------------------------------------------
// In-memory settings store + deps factory
// ---------------------------------------------------------------------------

import {
  describeMcpConfiguration,
  resolveMcpConfigPath,
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution,
  reconfigureSuperMcpWithCacheRefreshDetached,
  reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral,
  restartSuperMcpForConfigChangeAndAwaitExecution,
  validateMcpServerAfterConfigChange,
} from '../../services/mcpService';
import {
  ensureRouterConfigFile,
  findExistingCatalogServer,
  isServerDisabled,
  patchRouterConfigPaths,
  readMcpServerDetails,
  setMcpServerDisabled,
  touchMcpServerLastConnected,
  upsertMcpServerEntry,
} from '../../services/mcpConfigManager';
import { removeMcpServerWithCleanup } from '../../services/mcpServerRemovalService';
import {
  buildPayloadFromCatalog,
  findRebelOssConnectorsUsingProviderKey,
  getProviderKeyMapping,
  isSelfConfiguringMcp,
  lookupCatalogEntry,
  resolveConnectorCatalogPath,
} from '../../services/bundledMcpManager';
import { getManagedMcpInstallService } from '../../services/managedMcpInstallServiceInstance';
import { startOfficeSidecar, stopOfficeSidecar } from '../../services/officeSidecarManager';

interface TestSettingsState {
  spaces?: Array<{ path: string; type?: string }>;
  spaceSafetyLevels?: Record<string, string>;
  trustedTools?: TrustedTool[];
  providerKeys?: Record<string, string | null>;
  // Plus whatever other AppSettings fields the code touches — we widen to any
  // because the handlers only touch the fields above for these channels.
}

function makeStore(initial: TestSettingsState = {}) {
  let state = { ...initial } as TestSettingsState;
  return {
    get store() {
      return state as AppSettings;
    },
    set store(next: AppSettings) {
      state = next as unknown as TestSettingsState;
    },
    __raw: () => state,
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

function makeMcpServerDetails(overrides: Partial<McpServerConfigDetails> = {}): McpServerConfigDetails {
  return {
    name: 'Gamma-user-example-com',
    type: null,
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    url: null,
    cwd: null,
    env: null,
    headers: null,
    description: null,
    catalogId: 'bundled-gamma',
    email: '[external-email]',
    workspace: null,
    lastConnectedAt: 123_456,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('settingsHandlers — narrow-slice approval channels', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
    readOnlyFlag = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // settings:add-trusted-tool — audit-log emission (F4-4)
  // -------------------------------------------------------------------------

  describe('settings:add-trusted-tool — audit log (F4-4)', () => {
    it('adds a new tool and emits the structured audit-log entry', async () => {
      const store = makeStore({ trustedTools: [] });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:add-trusted-tool')!;
      expect(handler).toBeDefined();

      const res = await handler(null, {
        toolId: 'slack_send_message',
        displayName: 'Slack: Send Message',
        serverHint: 'slack-mcp',
      });

      expect(res).toEqual({ success: true });

      // Audit log: structured payload + human-readable msg.
      const auditCalls = (loggerMock.info as Mock).mock.calls.filter(
        ([, msg]) => msg === 'Added trusted tool atomically',
      );
      expect(auditCalls.length).toBe(1);
      expect(auditCalls[0]![0]).toEqual({ toolId: 'slack_send_message' });

      // Store mutation happened.
      const stored = store.__raw().trustedTools!;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.toolId).toBe('slack_send_message');
      expect(stored[0]!.displayName).toBe('Slack: Send Message');
      expect(stored[0]!.serverHint).toBe('slack-mcp');
      expect(typeof stored[0]!.addedAt).toBe('number');
    });

    it('deduplicates against canonical (bare) form and does NOT re-emit audit entry', async () => {
      const store = makeStore({
        trustedTools: [{ toolId: 'send_email' as TrustedTool['toolId'], addedAt: 1000 }],
      });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:add-trusted-tool')!;
      // Legacy compound ID that normalizes to the same bare id.
      const res = await handler(null, { toolId: 'gmail/send_email' });
      expect(res).toEqual({ success: true });

      // No duplicate entry.
      expect(store.__raw().trustedTools).toHaveLength(1);
      // No new audit entry (dedup path is silent-no-op).
      const auditCalls = (loggerMock.info as Mock).mock.calls.filter(
        ([, msg]) => msg === 'Added trusted tool atomically',
      );
      expect(auditCalls.length).toBe(0);
    });

    it('refuses in read-only mode and emits the rejection warn log (fail-loud)', async () => {
      readOnlyFlag = true;
      const store = makeStore({ trustedTools: [] });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:add-trusted-tool')!;
      const res = await handler(null, { toolId: 'slack_send_message' });
      // Stage 4 R2: return typed READ_ONLY code + toolId so ApprovalTransport
      // consumers can classify the failure the same way they classify
      // set-space-safety-level's UNKNOWN_SPACE_ID / READ_ONLY.
      expect(res).toEqual({
        success: false,
        error: 'READ_ONLY',
        toolId: 'slack_send_message',
      });

      // Nothing written.
      expect(store.__raw().trustedTools).toEqual([]);

      // Structured rejection log. First arg must be the structured object,
      // second arg the message — matches the Pino argument-order rule.
      const warnCalls = (loggerMock.warn as Mock).mock.calls.filter(
        ([obj]) =>
          obj &&
          typeof obj === 'object' &&
          obj.event === 'settings.add-trusted-tool.rejected',
      );
      expect(warnCalls.length).toBe(1);
      expect(warnCalls[0]![0]).toMatchObject({
        event: 'settings.add-trusted-tool.rejected',
        reason: 'read_only',
        toolId: 'slack_send_message',
      });
    });
  });

  describe('settings:mcp-add-bundled-server — update mode', () => {
    const catalogEntry = {
      id: 'bundled-gamma',
      name: 'Gamma',
      provider: 'community',
      setupFields: [
        { id: 'apiKey', type: 'password', envVar: 'GAMMA_API_KEY' },
      ],
    };

    const newPayload = (overrides: Partial<McpServerUpsertPayload> = {}): McpServerUpsertPayload => ({
      name: 'Gamma-new-generated',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      catalogId: 'bundled-gamma',
      email: 'user@example.com',
      env: {},
      lastConnectedAt: 999_999,
      ...overrides,
    });

    beforeEach(() => {
      vi.mocked(resolveMcpConfigPath).mockReturnValue('/tmp/test-userdata/mcp/super-mcp-router.json');
      vi.mocked(describeMcpConfiguration).mockResolvedValue({} as Awaited<ReturnType<typeof describeMcpConfiguration>>);
      vi.mocked(restartSuperMcpForConfigChangeAndAwaitExecution).mockResolvedValue(undefined);
      vi.mocked(upsertMcpServerEntry).mockResolvedValue({ backupPath: null });
      vi.mocked(isSelfConfiguringMcp).mockReturnValue(true);
      vi.mocked(lookupCatalogEntry).mockReturnValue(catalogEntry);
      vi.mocked(resolveConnectorCatalogPath).mockReturnValue(
        path.join(process.cwd(), 'resources', 'connector-catalog.json'),
      );
      vi.mocked(buildPayloadFromCatalog).mockResolvedValue(newPayload());
      vi.mocked(readMcpServerDetails).mockResolvedValue(makeMcpServerDetails({
        env: { GAMMA_API_KEY: 'old-secret' },
      }));
      vi.mocked(findExistingCatalogServer).mockResolvedValue({
        exists: true,
        serverName: 'Gamma-user-example-com',
      });
      vi.mocked(getProviderKeyMapping).mockReturnValue(undefined);
    });

    it('update mode reads existing entry and rewrites payload.name to existing serverName via findExistingCatalogServer', async () => {
      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      expect(handler).toBeDefined();

      await handler?.(null, {
        serverName: 'Gamma-user-example-com',
        catalogId: 'bundled-gamma',
        email: 'user@example.com',
        credentials: { apiKey: '' },
        mode: 'update',
      });

      expect(readMcpServerDetails).toHaveBeenCalledWith(
        '/tmp/test-userdata/mcp/super-mcp-router.json',
        'Gamma-user-example-com',
      );
      expect(findExistingCatalogServer).toHaveBeenCalledWith(
        '/tmp/test-userdata/mcp/super-mcp-router.json',
        'bundled-gamma',
        'user@example.com',
      );
      expect(upsertMcpServerEntry).toHaveBeenCalledWith(
        '/tmp/test-userdata/mcp/super-mcp-router.json',
        expect.objectContaining({
          name: 'Gamma-user-example-com',
          env: { GAMMA_API_KEY: 'old-secret' },
        }),
      );
    });

    it('update mode throws when resolved upsert target diverges from existing entry name', async () => {
      vi.mocked(findExistingCatalogServer).mockResolvedValueOnce({
        exists: true,
        serverName: 'Gamma-different-config-key',
      });
      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      await expect(handler?.(null, {
        serverName: 'Gamma-user-example-com',
        catalogId: 'bundled-gamma',
        email: 'user@example.com',
        credentials: { apiKey: '' },
        mode: 'update',
      })).rejects.toThrow('Connector identity mismatch — refusing to update');
      expect(upsertMcpServerEntry).not.toHaveBeenCalled();
    });

    it('update mode throws when catalogId mismatch', async () => {
      vi.mocked(readMcpServerDetails).mockResolvedValueOnce(makeMcpServerDetails({
        catalogId: 'different-catalog',
      }));
      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      await expect(handler?.(null, {
        serverName: 'Gamma-user-example-com',
        catalogId: 'bundled-gamma',
        email: 'user@example.com',
        mode: 'update',
      })).rejects.toThrow('Connector identity mismatch — refusing to update');
      expect(upsertMcpServerEntry).not.toHaveBeenCalled();
    });

    it('update mode throws when email mismatch (case-insensitive)', async () => {
      vi.mocked(readMcpServerDetails).mockResolvedValueOnce(makeMcpServerDetails({
        email: 'other@example.com',
      }));
      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      await expect(handler?.(null, {
        serverName: 'Gamma-user-example-com',
        catalogId: 'bundled-gamma',
        email: 'USER@example.com',
        mode: 'update',
      })).rejects.toThrow('Connector identity mismatch — refusing to update');
      expect(upsertMcpServerEntry).not.toHaveBeenCalled();
    });

    it('update mode throws when target server does not exist', async () => {
      vi.mocked(readMcpServerDetails).mockRejectedValueOnce(new Error('not found'));
      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      await expect(handler?.(null, {
        serverName: 'MissingGamma',
        catalogId: 'bundled-gamma',
        email: 'user@example.com',
        mode: 'update',
      })).rejects.toThrow('Cannot update — connector entry not found');
      expect(upsertMcpServerEntry).not.toHaveBeenCalled();
    });

    it('update mode does NOT save apiKey to providerKeys (no mapping promotion)', async () => {
      vi.mocked(getProviderKeyMapping).mockReturnValueOnce({ apiKey: 'openai' });
      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      await handler?.(null, {
        serverName: 'Gamma-user-example-com',
        catalogId: 'bundled-gamma',
        email: 'user@example.com',
        apiKey: 'new-shared-key',
        mode: 'update',
      });

      expect(store.__raw().providerKeys).toEqual({});
    });

    it('update mode preserves lastConnectedAt across the call', async () => {
      vi.mocked(readMcpServerDetails).mockResolvedValueOnce(makeMcpServerDetails({
        lastConnectedAt: 444_555,
      }));
      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      await handler?.(null, {
        serverName: 'Gamma-user-example-com',
        catalogId: 'bundled-gamma',
        email: 'user@example.com',
        mode: 'update',
      });

      expect(upsertMcpServerEntry).toHaveBeenCalledWith(
        '/tmp/test-userdata/mcp/super-mcp-router.json',
        expect.objectContaining({ lastConnectedAt: 444_555 }),
      );
    });

    it('create mode (default, no mode field) keeps existing behaviour', async () => {
      vi.mocked(getProviderKeyMapping).mockReturnValueOnce({ apiKey: 'openai' });
      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      await handler?.(null, {
        serverName: 'GammaMcp',
        catalogId: 'bundled-gamma',
        email: 'user@example.com',
        apiKey: 'shared-key',
      });

      expect(readMcpServerDetails).not.toHaveBeenCalled();
      expect(store.__raw().providerKeys).toEqual({ openai: 'shared-key' });
      expect(upsertMcpServerEntry).toHaveBeenCalledWith(
        '/tmp/test-userdata/mcp/super-mcp-router.json',
        expect.objectContaining({
          name: 'Gamma-user-example-com',
          lastConnectedAt: 999_999,
        }),
      );
    });

    // Regression matrix for the 2026-05-04 "Unknown bundled server" class of bug.
    //
    // Pre-fix, the IPC guard at settingsHandlers.ts only recognised rebel-oss
    // connectors when `request.serverName === bundledConfig.serverName`. This
    // rejected all real Update key flows because the renderer correctly passes
    // the existing super-mcp-router.json entry key as `serverName`, which can
    // diverge from the catalog's `bundledConfig.serverName` in two ways:
    //
    //   Class A — display name keyed entries, e.g. an old install where the
    //     catalog's `bundledConfig.serverName` value has since changed (Runway:
    //     entry "Runway ML", current catalog "Runway"). 11 connectors today.
    //
    //   Class B — email-instanced runtime names (every accountIdentity:'email'
    //     rebel-oss api-key connector). `generateInstanceId('Fathom', email)`
    //     produces "Fathom-user-example-com", which never matches the catalog
    //     "Fathom".
    //
    // Below: parameterised coverage of both classes plus the EmailImap shared-
    // serverName edge case (3 catalog ids share `bundledConfig.serverName:
    // EmailImap` — recognition must rely on catalogId, not serverName).
    describe.each<{
      caseName: string;
      runtimeServerName: string;
      catalogServerName: string;
      catalogId: string;
      email: string | null;
      envKey: string;
    }>([
      {
        caseName: 'Class A — divergent display name (Runway ML)',
        runtimeServerName: 'Runway ML',
        catalogServerName: 'Runway',
        catalogId: 'bundled-runway',
        email: null,
        envKey: 'RUNWAYML_API_SECRET',
      },
      {
        caseName: 'Class A — divergent serverName (Gamma → GammaMcp)',
        runtimeServerName: 'Gamma',
        catalogServerName: 'GammaMcp',
        catalogId: 'bundled-gamma',
        email: null,
        envKey: 'GAMMA_API_KEY',
      },
      {
        caseName: 'Class A — Google Analytics (display "Google Analytics" → "GoogleAnalytics")',
        runtimeServerName: 'Google Analytics',
        catalogServerName: 'GoogleAnalytics',
        catalogId: 'bundled-google-analytics',
        email: null,
        envKey: 'GOOGLE_ANALYTICS_API_KEY',
      },
      {
        caseName: 'Class B — email-instanced matching catalog (Fathom-user-example-com)',
        runtimeServerName: 'Fathom-user-example-com',
        catalogServerName: 'Fathom',
        catalogId: 'bundled-fathom',
        email: 'user@example.com',
        envKey: 'FATHOM_API_KEY',
      },
      {
        caseName: 'Class A+B — email-instanced AND divergent (GammaMcp-user-example-com)',
        runtimeServerName: 'GammaMcp-user-example-com',
        catalogServerName: 'GammaMcp',
        catalogId: 'bundled-gamma',
        email: 'user@example.com',
        envKey: 'GAMMA_API_KEY',
      },
      {
        caseName: 'EmailImap shared-serverName edge — iCloud Mail variant',
        runtimeServerName: 'EmailImap-user-icloud-com',
        catalogServerName: 'EmailImap',
        catalogId: 'bundled-icloud-mail',
        email: '[external-email]',
        envKey: 'IMAP_PASSWORD',
      },
      {
        caseName: 'EmailImap shared-serverName edge — Yahoo Mail variant',
        runtimeServerName: 'EmailImap-user-yahoo-com',
        catalogServerName: 'EmailImap',
        catalogId: 'bundled-yahoo-mail',
        email: '[external-email]',
        envKey: 'IMAP_PASSWORD',
      },
    ])('rebel-oss update mode recognition — $caseName', ({
      runtimeServerName,
      catalogServerName,
      catalogId,
      email,
      envKey,
    }) => {
      it('accepts the request via catalogId match and upserts under the existing entry name', async () => {
        vi.mocked(isSelfConfiguringMcp).mockReturnValue(false);
        vi.mocked(readMcpServerDetails).mockResolvedValueOnce(makeMcpServerDetails({
          name: runtimeServerName,
          catalogId,
          email,
          env: { [envKey]: 'old-secret' },
        }));
        vi.mocked(findExistingCatalogServer).mockResolvedValueOnce({
          exists: true,
          serverName: runtimeServerName,
        });
        vi.mocked(buildPayloadFromCatalog).mockResolvedValueOnce(newPayload({
          name: catalogServerName,
          catalogId,
          email: email ?? undefined,
          env: { [envKey]: 'new-secret' },
        }));

        const store = makeStore({ providerKeys: {} });
        const deps = makeDeps(store);
        const { registerSettingsHandlers } = await import('../settingsHandlers');
        registerSettingsHandlers(deps);

        const handler = handlers.get('settings:mcp-add-bundled-server');
        await handler?.(null, {
          serverName: runtimeServerName,
          catalogId,
          apiKey: 'new-secret',
          credentials: { apiKey: 'new-secret' },
          email: email ?? undefined,
          mode: 'update',
        });

        expect(upsertMcpServerEntry).toHaveBeenCalledWith(
          '/tmp/test-userdata/mcp/super-mcp-router.json',
          expect.objectContaining({
            name: runtimeServerName,
            catalogId,
          }),
        );
      });
    });

    it('rebel-oss update mode still rejects when neither catalogId nor serverName match a known connector', async () => {
      // Negative case: a request for a non-existent catalogId on an unknown
      // serverName must still throw "Unknown bundled server" — we widened
      // recognition, not authorisation.
      vi.mocked(isSelfConfiguringMcp).mockReturnValue(false);
      vi.mocked(readMcpServerDetails).mockResolvedValueOnce(makeMcpServerDetails({
        name: 'Bogus-server',
        catalogId: 'bundled-does-not-exist',
      }));

      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      await expect(handler?.(null, {
        serverName: 'Bogus-server',
        catalogId: 'bundled-does-not-exist',
        mode: 'update',
      })).rejects.toThrow('Unknown bundled server: Bogus-server');
      expect(upsertMcpServerEntry).not.toHaveBeenCalled();
    });
  });

  describe('settings:mcp-upsert-server — catalog static env/header merge', () => {
    let tempDir: string;
    let catalogPath: string;

    const affectedCommunityCatalog = [
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
    ];

    const writeCatalog = async (connectors: unknown[]): Promise<void> => {
      await fs.writeFile(catalogPath, JSON.stringify({ connectors }, null, 2), 'utf8');
    };

    const basePayload = (overrides: Partial<McpServerUpsertPayload> = {}): McpServerUpsertPayload => ({
      name: 'n8n (Community)-user-example-com',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'n8n-mcp@2.51.3'],
      catalogId: 'n8n-community',
      ...overrides,
    });

    const registerUpsertHandler = async () => {
      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);
      const handler = handlers.get('settings:mcp-upsert-server');
      expect(handler).toBeDefined();
      return handler!;
    };

    const lastUpsertPayload = (): McpServerUpsertPayload => {
      const call = vi.mocked(upsertMcpServerEntry).mock.calls.at(-1);
      expect(call).toBeDefined();
      return call![1] as McpServerUpsertPayload;
    };

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-upsert-catalog-'));
      catalogPath = path.join(tempDir, 'connector-catalog.json');
      await writeCatalog(affectedCommunityCatalog);

      vi.mocked(resolveMcpConfigPath).mockReturnValue(path.join(tempDir, 'super-mcp-router.json'));
      vi.mocked(describeMcpConfiguration).mockResolvedValue({} as Awaited<ReturnType<typeof describeMcpConfiguration>>);
      vi.mocked(restartSuperMcpForConfigChangeAndAwaitExecution).mockResolvedValue(undefined);
      vi.mocked(upsertMcpServerEntry).mockResolvedValue({ backupPath: null });
      vi.mocked(resolveConnectorCatalogPath).mockReturnValue(catalogPath);
      vi.mocked(lookupCatalogEntry).mockImplementation((catalogId: string, catalog: Record<string, unknown>[]) =>
        catalog.find((entry) => entry.id === catalogId),
      );
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    });

    it('merges n8n-community catalog env when payload env is omitted', async () => {
      const handler = await registerUpsertHandler();

      await handler(null, basePayload());

      expect(lastUpsertPayload().env).toEqual({
        MCP_MODE: 'stdio',
        LOG_LEVEL: 'error',
        DISABLE_CONSOLE_OUTPUT: 'true',
        N8N_MCP_TELEMETRY_DISABLED: 'true',
      });
    });

    it('keeps payload env values on catalog collisions', async () => {
      const handler = await registerUpsertHandler();

      await handler(null, basePayload({
        env: {
          N8N_MCP_TELEMETRY_DISABLED: 'false',
          N8N_API_URL: 'https://n8n.example.test',
        },
      }));

      expect(lastUpsertPayload().env).toEqual({
        MCP_MODE: 'stdio',
        LOG_LEVEL: 'error',
        DISABLE_CONSOLE_OUTPUT: 'true',
        N8N_MCP_TELEMETRY_DISABLED: 'false',
        N8N_API_URL: 'https://n8n.example.test',
      });
    });

    it('leaves payload unchanged when catalogId is absent', async () => {
      const handler = await registerUpsertHandler();
      const payload = basePayload({
        catalogId: undefined,
        env: { USER_ENV: 'value' },
      });

      await handler(null, payload);

      expect(resolveConnectorCatalogPath).not.toHaveBeenCalled();
      expect(lastUpsertPayload()).toMatchObject({
        catalogId: undefined,
        env: { USER_ENV: 'value' },
      });
    });

    it('warns and upserts unchanged when catalog lookup fails', async () => {
      await writeCatalog([]);
      const handler = await registerUpsertHandler();
      const payload = basePayload({ env: { N8N_API_KEY: 'secret' } });

      await handler(null, payload);

      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ catalogId: 'n8n-community' }),
        'Failed to merge catalog static env on upsert; using payload as-is',
      );
      expect(lastUpsertPayload()).toMatchObject({
        catalogId: 'n8n-community',
        env: { N8N_API_KEY: 'secret' },
      });
    });

    it('warns and upserts unchanged when the catalog file is unreadable', async () => {
      await fs.unlink(catalogPath);
      const handler = await registerUpsertHandler();
      const payload = basePayload({ env: { N8N_API_KEY: 'secret' } });

      await expect(handler(null, payload)).resolves.toEqual({
        summary: {},
        backupPath: null,
      });

      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ catalogId: 'n8n-community' }),
        'Failed to merge catalog static env on upsert; using payload as-is',
      );
      expect(lastUpsertPayload()).toMatchObject({
        catalogId: 'n8n-community',
        env: { N8N_API_KEY: 'secret' },
      });
    });

    it('filters placeholder catalog env values instead of injecting raw templates', async () => {
      await writeCatalog([
        {
          id: 'bundled-gamma',
          name: 'Gamma',
          provider: 'rebel-oss',
          mcpConfig: {
            command: 'npx',
            args: ['-y', '@mindstone-engineering/gamma'],
            env: {
              GAMMA_API_KEY: '{{GAMMA_API_KEY}}',
            },
          },
        },
      ]);
      const handler = await registerUpsertHandler();

      await handler(null, basePayload({
        name: 'Gamma',
        catalogId: 'bundled-gamma',
        env: {},
      }));

      expect(lastUpsertPayload().env).toEqual({});
      expect(lastUpsertPayload().env).not.toHaveProperty('GAMMA_API_KEY');
    });

    it('merges catalog headers with payload collision precedence and placeholder filtering', async () => {
      await writeCatalog([
        {
          id: 'headers-connector',
          name: 'Headers Connector',
          provider: 'community',
          mcpConfig: {
            url: 'https://example.test/mcp',
            headers: {
              Authorization: 'Bearer catalog',
              'X-Static': 'enabled',
              'X-Placeholder': '{{HEADER_TOKEN}}',
            },
          },
        },
      ]);
      const handler = await registerUpsertHandler();

      await handler(null, basePayload({
        name: 'Headers Connector',
        catalogId: 'headers-connector',
        headers: { Authorization: 'Bearer payload' },
      }));

      expect(lastUpsertPayload().headers).toEqual({
        Authorization: 'Bearer payload',
        'X-Static': 'enabled',
      });
    });

    it('restores the placeholder-free catalog env superset for affected community connectors', async () => {
      const handler = await registerUpsertHandler();

      for (const connector of affectedCommunityCatalog) {
        await handler(null, basePayload({
          name: connector.name,
          catalogId: connector.id,
          env: { USER_KEY: `${connector.id}-user-value` },
        }));
        const expectedCatalogEnv = connector.mcpConfig.env;
        expect(lastUpsertPayload().env).toEqual(expect.objectContaining({
          ...expectedCatalogEnv,
          USER_KEY: `${connector.id}-user-value`,
        }));
      }
    });
  });

  describe('settings:mcp-validate-server', () => {
    beforeEach(() => {
      vi.mocked(resolveMcpConfigPath).mockReturnValue('/tmp/test-userdata/mcp/super-mcp-router.json');
      vi.mocked(touchMcpServerLastConnected).mockResolvedValue({ backupPath: '/tmp/backup.json' });
    });

    it('settings:mcp-validate-server returns ok and advances lastConnectedAt when health check passes', async () => {
      vi.mocked(validateMcpServerAfterConfigChange).mockResolvedValue({ status: 'ok' });
      const store = makeStore();
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-validate-server');
      await expect(handler?.(null, { serverName: 'Gamma' })).resolves.toEqual({ status: 'ok' });

      expect(validateMcpServerAfterConfigChange).toHaveBeenCalledWith('Gamma');
      expect(touchMcpServerLastConnected).toHaveBeenCalledWith(
        '/tmp/test-userdata/mcp/super-mcp-router.json',
        'Gamma',
      );
    });

    it('settings:mcp-validate-server returns error and does NOT advance lastConnectedAt when health check fails', async () => {
      vi.mocked(validateMcpServerAfterConfigChange).mockResolvedValue({
        status: 'error',
        error: 'Bad credentials',
      });
      const store = makeStore();
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-validate-server');
      await expect(handler?.(null, { serverName: 'Gamma' })).resolves.toEqual({
        status: 'error',
        error: 'Bad credentials',
      });

      expect(validateMcpServerAfterConfigChange).toHaveBeenCalledWith('Gamma');
      expect(touchMcpServerLastConnected).not.toHaveBeenCalled();
    });

    it('settings:mcp-validate-server returns unavailable when health check times out / no signal', async () => {
      vi.mocked(validateMcpServerAfterConfigChange).mockResolvedValue({ status: 'unavailable' });
      const store = makeStore();
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-validate-server');
      await expect(handler?.(null, { serverName: 'Gamma' })).resolves.toEqual({ status: 'unavailable' });

      expect(validateMcpServerAfterConfigChange).toHaveBeenCalledWith('Gamma');
      expect(touchMcpServerLastConnected).not.toHaveBeenCalled();
    });
  });

  describe('settings:update provider key rotation lifecycle (Stage 2a)', () => {
    const configPath = '/tmp/test-userdata/mcp/super-mcp-router.json';

    const makeConnector = (
      overrides: Partial<{
        id: string;
        name: string;
        mapping: Record<string, 'openai' | 'google'>;
        serverName: string;
      }> = {},
    ) => {
      const id = overrides.id ?? 'openai-image-generation';
      const name = overrides.name ?? 'OpenAIImageGeneration';
      return {
        serverName: overrides.serverName ?? name,
        catalogId: id,
        email: undefined,
        catalogEntry: {
          id,
          name,
          provider: 'rebel-oss',
          bundledConfig: {
            serverName: overrides.serverName ?? name,
            providerKeyMapping: overrides.mapping ?? { OPENAI_API_KEY: 'openai' as const },
          },
          mcpConfig: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@mindstone/mcp-server-openai-image@0.1.2'],
            env: {
              OPENAI_API_KEY: '{{OPENAI_API_KEY}}',
            },
          },
        },
      };
    };

    const registerUpdateHandler = async (store: ReturnType<typeof makeStore>) => {
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);
      const handler = handlers.get('settings:update');
      expect(handler).toBeDefined();
      return handler!;
    };

    beforeEach(() => {
      vi.mocked(resolveMcpConfigPath).mockReturnValue(configPath);
      vi.mocked(upsertMcpServerEntry).mockResolvedValue({ backupPath: null });
      vi.mocked(restartSuperMcpForConfigChangeAndAwaitExecution).mockResolvedValue(undefined);
      vi.mocked(findRebelOssConnectorsUsingProviderKey).mockResolvedValue([]);
      vi.mocked(buildPayloadFromCatalog).mockImplementation(async (_entry, options) => ({
        name: 'placeholder',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'placeholder'],
        catalogId: 'placeholder',
        env: {
          OPENAI_API_KEY: (options as { providerKeys?: Record<string, string | null | undefined> } | undefined)?.providerKeys?.openai ?? '',
          GEMINI_API_KEY: (options as { providerKeys?: Record<string, string | null | undefined> } | undefined)?.providerKeys?.google ?? '',
        },
      }));
    });

    it('rotated key triggers cohort restart for matching provider mappings only', async () => {
      const store = makeStore({ providerKeys: { openai: 'fake-openai-old', google: 'g-stable' } });
      const handler = await registerUpdateHandler(store);
      const openAiConnector = makeConnector();

      vi.mocked(findRebelOssConnectorsUsingProviderKey).mockImplementation(async (providerId) =>
        providerId === 'openai' ? [openAiConnector] : [],
      );

      await handler(null, { ...store.store, providerKeys: { openai: 'fake-openai-new', google: 'g-stable' } });

      expect(findRebelOssConnectorsUsingProviderKey).toHaveBeenCalledTimes(1);
      expect(findRebelOssConnectorsUsingProviderKey).toHaveBeenCalledWith('openai');
      expect(upsertMcpServerEntry).toHaveBeenCalledTimes(1);
      expect(upsertMcpServerEntry).toHaveBeenCalledWith(
        configPath,
        expect.objectContaining({
          name: 'OpenAIImageGeneration',
          env: expect.objectContaining({ OPENAI_API_KEY: 'fake-openai-new' }),
        }),
      );
    });

    it('cleared key restarts in unconfigured mode and does not remove the MCP entry', async () => {
      const store = makeStore({ providerKeys: { openai: 'fake-openai-old' } });
      const handler = await registerUpdateHandler(store);
      const openAiConnector = makeConnector();

      vi.mocked(findRebelOssConnectorsUsingProviderKey).mockResolvedValue([openAiConnector]);

      await handler(null, { ...store.store, providerKeys: { openai: null } });

      expect(upsertMcpServerEntry).toHaveBeenCalledWith(
        configPath,
        expect.objectContaining({
          name: 'OpenAIImageGeneration',
          env: expect.objectContaining({ OPENAI_API_KEY: '' }),
        }),
      );
      expect(removeMcpServerWithCleanup).not.toHaveBeenCalled();
    });

    it('provider changes only affect the matching provider-key cohort', async () => {
      const store = makeStore({ providerKeys: { openai: 'fake-openai-stable', google: 'g-old' } });
      const handler = await registerUpdateHandler(store);
      const googleConnector = makeConnector({
        id: 'bundled-nano-banana',
        name: 'NanoBanana',
        serverName: 'NanoBanana',
        mapping: { GEMINI_API_KEY: 'google' as const },
      });

      vi.mocked(findRebelOssConnectorsUsingProviderKey).mockImplementation(async (providerId) =>
        providerId === 'google' ? [googleConnector] : [],
      );

      await handler(null, { ...store.store, providerKeys: { openai: 'fake-openai-stable', google: 'g-new' } });

      expect(findRebelOssConnectorsUsingProviderKey).toHaveBeenCalledTimes(1);
      expect(findRebelOssConnectorsUsingProviderKey).toHaveBeenCalledWith('google');
      expect(upsertMcpServerEntry).toHaveBeenCalledWith(
        configPath,
        expect.objectContaining({ name: 'NanoBanana' }),
      );
      expect(upsertMcpServerEntry).not.toHaveBeenCalledWith(
        configPath,
        expect.objectContaining({ name: 'OpenAIImageGeneration' }),
      );
    });

    it('connectors without providerKeyMapping remain unaffected', async () => {
      const store = makeStore({ providerKeys: { openai: 'fake-openai-old' } });
      const handler = await registerUpdateHandler(store);

      vi.mocked(findRebelOssConnectorsUsingProviderKey).mockResolvedValue([]);

      await handler(null, { ...store.store, providerKeys: { openai: 'fake-openai-new' } });

      expect(findRebelOssConnectorsUsingProviderKey).toHaveBeenCalledWith('openai');
      expect(upsertMcpServerEntry).not.toHaveBeenCalled();
    });

    it('bridge-written provider key updates trigger the same settings:update lifecycle path', async () => {
      const store = makeStore({ providerKeys: { openai: 'fake-openai-old' } });
      const handler = await registerUpdateHandler(store);
      const openAiConnector = makeConnector();

      vi.mocked(findRebelOssConnectorsUsingProviderKey).mockResolvedValue([openAiConnector]);

      // Mirrors the bridge path: `bundledInboxBridge` now invokes settings:update
      // with a full AppSettings payload after writing providerKeys.
      await handler(null, { ...store.store, providerKeys: { openai: 'fake-openai-bridge-new' } });

      expect(findRebelOssConnectorsUsingProviderKey).toHaveBeenCalledWith('openai');
      expect(upsertMcpServerEntry).toHaveBeenCalledWith(
        configPath,
        expect.objectContaining({
          name: 'OpenAIImageGeneration',
          env: expect.objectContaining({ OPENAI_API_KEY: 'fake-openai-bridge-new' }),
        }),
      );
    });

    it('multi-provider rotation in one update restarts each cohort exactly once', async () => {
      const store = makeStore({ providerKeys: { openai: 'fake-openai-old', google: 'g-old' } });
      const handler = await registerUpdateHandler(store);
      const openAiConnector = makeConnector();
      const googleConnector = makeConnector({
        id: 'bundled-nano-banana',
        name: 'NanoBanana',
        serverName: 'NanoBanana',
        mapping: { GEMINI_API_KEY: 'google' as const },
      });

      vi.mocked(findRebelOssConnectorsUsingProviderKey).mockImplementation(async (providerId) => {
        if (providerId === 'openai') return [openAiConnector];
        if (providerId === 'google') return [googleConnector];
        return [];
      });

      await handler(null, {
        ...store.store,
        providerKeys: { openai: 'fake-openai-new', google: 'g-new' },
      });

      expect(findRebelOssConnectorsUsingProviderKey).toHaveBeenCalledTimes(2);
      const upsertedNames = vi.mocked(upsertMcpServerEntry).mock.calls.map(([, payload]) => (payload as McpServerUpsertPayload).name);
      expect(upsertedNames.filter((name) => name === 'OpenAIImageGeneration')).toHaveLength(1);
      expect(upsertedNames.filter((name) => name === 'NanoBanana')).toHaveLength(1);
    });
  });

  describe('office sidecar MCP lifecycle hooks', () => {
    beforeEach(() => {
      vi.mocked(resolveMcpConfigPath).mockReturnValue('/tmp/test-userdata/mcp/super-mcp-router.json');
      vi.mocked(describeMcpConfiguration).mockResolvedValue({} as Awaited<ReturnType<typeof describeMcpConfiguration>>);
      vi.mocked(restartSuperMcpForConfigChangeAndAwaitExecution).mockResolvedValue(undefined);
      vi.mocked(reconfigureSuperMcpWithCacheRefreshAndAwaitExecution).mockResolvedValue(undefined);
      vi.mocked(ensureRouterConfigFile).mockResolvedValue(undefined);
      vi.mocked(upsertMcpServerEntry).mockResolvedValue({ backupPath: null });
      vi.mocked(findExistingCatalogServer).mockResolvedValue({ exists: false });
      vi.mocked(getManagedMcpInstallService).mockReturnValue(
        managedMcpInstallServiceMock as unknown as ReturnType<typeof getManagedMcpInstallService>,
      );
      managedMcpInstallServiceMock.install.mockResolvedValue({
        packageSpec: OFFICE_MCP_PACKAGE_SPEC,
        packageName: OFFICE_MCP_PACKAGE_NAME,
        version: OFFICE_MCP_PACKAGE_VERSION,
        entryPath: '/tmp/test-userdata/mcp/managed-installs/office/dist/index.js',
        installRoot: '/tmp/test-userdata/mcp/managed-installs/office',
        installedAt: '2026-04-29T00:00:00.000Z',
        metaVersion: 1,
      });
      vi.mocked(lookupCatalogEntry).mockReturnValue({
        id: 'bundled-office',
        name: 'Microsoft Office',
        provider: 'rebel-oss',
        mcpConfig: {
          command: 'npx',
          args: ['-y', OFFICE_MCP_PACKAGE_SPEC],
        },
      });
      vi.mocked(buildPayloadFromCatalog).mockResolvedValue({
        name: 'RebelOffice',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', OFFICE_MCP_PACKAGE_SPEC],
        catalogId: 'bundled-office',
      });
      vi.mocked(isSelfConfiguringMcp).mockImplementation((serverName: string) => serverName !== 'RebelOffice');
      vi.mocked(getProviderKeyMapping).mockReturnValue(undefined);
      vi.mocked(resolveConnectorCatalogPath).mockReturnValue(
        path.join(process.cwd(), 'resources', 'connector-catalog.json'),
      );
      vi.mocked(removeMcpServerWithCleanup).mockResolvedValue({
        backupPath: null,
        serverName: 'RebelOffice',
        toolsRemoved: 0,
      });
      vi.mocked(isServerDisabled).mockResolvedValue(false);
      vi.mocked(setMcpServerDisabled).mockResolvedValue(undefined);
      vi.mocked(startOfficeSidecar).mockResolvedValue(null);
      vi.mocked(stopOfficeSidecar).mockResolvedValue(undefined);
    });

    it('installs the Office rebel-oss package before starting the sidecar on fresh enable', async () => {
      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      expect(handler).toBeDefined();

      await handler?.(null, {
        serverName: 'RebelOffice',
        catalogId: 'bundled-office',
      });

      expect(managedMcpInstallServiceMock.install).toHaveBeenCalledWith({
        packageSpec: OFFICE_MCP_PACKAGE_SPEC,
      });
      expect(startOfficeSidecar).toHaveBeenCalledTimes(1);
      expect(managedMcpInstallServiceMock.install.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(startOfficeSidecar).mock.invocationCallOrder[0]!,
      );
      expect(stopOfficeSidecar).not.toHaveBeenCalled();
    });

    it('propagates Office install failures without starting the sidecar', async () => {
      managedMcpInstallServiceMock.install.mockRejectedValueOnce(new Error('npm failed'));

      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      expect(handler).toBeDefined();

      await expect(handler?.(null, {
        serverName: 'RebelOffice',
        catalogId: 'bundled-office',
      })).rejects.toThrow("Couldn't prepare Microsoft Office — install failed. Please retry.");

      expect(managedMcpInstallServiceMock.install).toHaveBeenCalledWith({
        packageSpec: OFFICE_MCP_PACKAGE_SPEC,
      });
      expect(upsertMcpServerEntry).not.toHaveBeenCalled();
      expect(startOfficeSidecar).not.toHaveBeenCalled();
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.objectContaining({
          packageSpec: OFFICE_MCP_PACKAGE_SPEC,
          err: expect.any(Error),
        }),
        'Managed MCP install failed while preparing rebel-oss connector',
      );
    });

    it('propagates Office sidecar startup failures distinctly after install succeeds', async () => {
      vi.mocked(startOfficeSidecar).mockRejectedValueOnce(new Error('spawn failed'));

      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      expect(handler).toBeDefined();

      await expect(handler?.(null, {
        serverName: 'RebelOffice',
        catalogId: 'bundled-office',
      })).rejects.toThrow("Couldn't start Microsoft Office — sidecar failed to start. Please retry.");

      expect(managedMcpInstallServiceMock.install).toHaveBeenCalledWith({
        packageSpec: OFFICE_MCP_PACKAGE_SPEC,
      });
      expect(upsertMcpServerEntry).toHaveBeenCalledTimes(1);
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.objectContaining({
          packageSpec: OFFICE_MCP_PACKAGE_SPEC,
          err: expect.any(Error),
        }),
        'Office sidecar start after add failed',
      );
    });

    it('does not start the office sidecar when adding an unrelated connector', async () => {
      vi.mocked(lookupCatalogEntry).mockReturnValueOnce({
        id: 'bundled-slack',
        name: 'Slack',
        provider: 'bundled',
      });
      vi.mocked(buildPayloadFromCatalog).mockResolvedValueOnce({
        name: 'Slack',
        transport: 'stdio',
        command: 'node',
        args: ['slack-server.js'],
        catalogId: 'bundled-slack',
      });

      const store = makeStore({ providerKeys: {} });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-add-bundled-server');
      expect(handler).toBeDefined();

      await handler?.(null, {
        serverName: 'Slack',
        catalogId: 'bundled-slack',
      });

      expect(managedMcpInstallServiceMock.install).not.toHaveBeenCalled();
      expect(startOfficeSidecar).not.toHaveBeenCalled();
      expect(stopOfficeSidecar).not.toHaveBeenCalled();
    });

    it('starts and stops the office sidecar when RebelOffice is toggled', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-toggle-server-enabled');
      expect(handler).toBeDefined();

      vi.mocked(isServerDisabled).mockResolvedValueOnce(true);
      await expect(handler?.(null, { serverId: 'RebelOffice' })).resolves.toEqual({ success: true });
      expect(startOfficeSidecar).toHaveBeenCalledTimes(1);
      expect(stopOfficeSidecar).not.toHaveBeenCalled();

      vi.mocked(isServerDisabled).mockResolvedValueOnce(false);
      await expect(handler?.(null, { serverId: 'RebelOffice' })).resolves.toEqual({ success: true });
      expect(stopOfficeSidecar).toHaveBeenCalledTimes(1);
    });

    it('does not start or stop the office sidecar when unrelated connectors are toggled', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-toggle-server-enabled');
      expect(handler).toBeDefined();

      vi.mocked(isServerDisabled).mockResolvedValueOnce(false);
      await expect(handler?.(null, { serverId: 'Slack' })).resolves.toEqual({ success: true });

      expect(startOfficeSidecar).not.toHaveBeenCalled();
      expect(stopOfficeSidecar).not.toHaveBeenCalled();
    });

    // Regression: the toggle IPC must not block on the deferred Super-MCP
    // restart (deferred up to 30 min while agent turns drain) — same class as
    // the connector-disconnect hang, see
    // docs/plans/260610_gworkspace-mcp-error-disconnect-hang/PLAN.md.
    it('toggle resolves promptly while the Super-MCP restart is deferred', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-toggle-server-enabled');
      expect(handler).toBeDefined();

      vi.mocked(isServerDisabled).mockResolvedValueOnce(false);
      // Never-resolving promise simulates the restart deferred behind active turns.
      vi.mocked(reconfigureSuperMcpWithCacheRefreshAndAwaitExecution).mockReturnValueOnce(
        new Promise<never>(() => {})
      );

      const sentinel = Symbol('toggle-still-pending');
      const winner = await Promise.race([
        handler?.(null, { serverId: 'Slack' }),
        // Macrotask fires only after all pending microtasks drain.
        new Promise((resolve) => setTimeout(() => resolve(sentinel), 0)),
      ]);

      expect(winner).toEqual({ success: true });
      // Context carries the toggled serverId so the renderer's deferred-op
      // matching (UnifiedConnectionsPanel) can exact-match the toggled card.
      expect(reconfigureSuperMcpWithCacheRefreshAndAwaitExecution).toHaveBeenCalledWith(
        expect.any(String),
        { context: 'mcp-server-toggle:Slack' },
      );
    });

    // F2 sync-throw guard: a future synchronous throw from the fire-and-forget
    // reconfigure must be downgraded to a warn, NOT fail the IPC — the
    // disabled-state config write already succeeded.
    it('toggle still succeeds when the Super-MCP reconfigure throws synchronously', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-toggle-server-enabled');
      expect(handler).toBeDefined();

      vi.mocked(isServerDisabled).mockResolvedValueOnce(false);
      vi.mocked(reconfigureSuperMcpWithCacheRefreshAndAwaitExecution).mockImplementationOnce(() => {
        throw new Error('sync throw before promise');
      });

      await expect(handler?.(null, { serverId: 'Slack' })).resolves.toEqual({ success: true });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), serverId: 'Slack' }),
        expect.stringContaining('reconfigure after server toggle failed'),
      );
    });

    it('toggle still succeeds when the background Super-MCP restart fails', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-toggle-server-enabled');
      expect(handler).toBeDefined();

      vi.mocked(isServerDisabled).mockResolvedValueOnce(false);
      vi.mocked(reconfigureSuperMcpWithCacheRefreshAndAwaitExecution).mockRejectedValueOnce(
        new Error('restart failed in background')
      );

      await expect(handler?.(null, { serverId: 'Slack' })).resolves.toEqual({ success: true });

      // Flush so the background .catch runs; vitest fails on unhandled rejections.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), serverId: 'Slack' }),
        expect.stringContaining('reconfigure after server toggle failed'),
      );
    });

    it('stops the office sidecar when RebelOffice is removed', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-remove-server');
      expect(handler).toBeDefined();

      await handler?.(null, 'RebelOffice');

      expect(stopOfficeSidecar).toHaveBeenCalledTimes(1);
      expect(startOfficeSidecar).not.toHaveBeenCalled();
    });

    it('does not stop the office sidecar when an unrelated connector is removed', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-remove-server');
      expect(handler).toBeDefined();

      await handler?.(null, 'Slack');

      expect(startOfficeSidecar).not.toHaveBeenCalled();
      expect(stopOfficeSidecar).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // settings:mcp-router-path — migration branch must not block on the
  // deferred Super-MCP restart (Stage 4,
  // docs/plans/260610_gworkspace-mcp-error-disconnect-hang). The response
  // summary is computed BEFORE the reconfigure and nothing after the await
  // reads router state, so prompt resolution is the whole fix here (advanced
  // config-path surface, no tracked renderer op).
  // -------------------------------------------------------------------------

  describe('settings:mcp-router-path — migration branch deferred-restart decoupling', () => {
    // Deterministic by construction (confirming-round fix, GPT-F1): the
    // migration branch does REAL async work before the reconfigure (an
    // unmocked fs.access probe on the external config path), so a
    // setTimeout(0)-sentinel race could lose to that legitimate work and
    // flake. Instead, the execution-awaiting form is mocked never-settling
    // and the resolve-on-deferral variant resolves — a plain `await` of the
    // handler then proves promptness by construction: if the handler
    // regressed to awaiting the execution form, this test times out red.
    // Merge synthesis: the migration site uses ResolvingOnDeferral, NOT the
    // peer run's Detached (idle path still awaits the executed restart).
    it('migration branch resolves while the Super-MCP restart is deferred (never-settling execution form)', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:mcp-router-path');
      expect(handler).toBeDefined();

      // External config (outside the mocked /tmp/test-userdata) → didMigrate
      // branch → reconfigure runs.
      vi.mocked(resolveMcpConfigPath).mockReturnValue('/external/custom-mcp.json');
      vi.mocked(patchRouterConfigPaths).mockResolvedValue({ backupPath: '/tmp/backup.json' } as never);
      const summary = { status: 'ready', servers: [] };
      vi.mocked(describeMcpConfiguration).mockResolvedValue(summary as never);
      // Never-resolving promise simulates the restart deferred behind active
      // turns — the migrated-path hang this stage kills. The handler must not
      // touch this form at all (asserted below).
      vi.mocked(reconfigureSuperMcpWithCacheRefreshAndAwaitExecution).mockReturnValue(
        new Promise<never>(() => {})
      );
      vi.mocked(reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral).mockResolvedValue(
        { queued: true }
      );

      const response = await handler?.(null, { action: 'add', path: '/external/another.json' });

      expect(response).toEqual({ summary, backupPath: '/tmp/backup.json' });
      // Context byte-identical (literal on purpose; guards constant drift).
      expect(reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral).toHaveBeenCalledWith(
        expect.stringContaining('super-mcp-router.json'),
        { context: 'settings-migration' },
      );
      // Belt-and-braces: the migration branch must use neither the
      // execution-awaiting form (would have hung above anyway) nor the
      // peer run's Detached form (loses the idle "applied before resolve"
      // semantics this site keeps under the synthesis).
      expect(reconfigureSuperMcpWithCacheRefreshAndAwaitExecution).not.toHaveBeenCalled();
      expect(reconfigureSuperMcpWithCacheRefreshDetached).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // settings:set-space-safety-level — real UNKNOWN_SPACE_ID branch
  // -------------------------------------------------------------------------

  describe('settings:set-space-safety-level — UNKNOWN_SPACE_ID (F4-4 completeness)', () => {
    it('rejects unknown spaceId with UNKNOWN_SPACE_ID and does not mutate the store', async () => {
      const store = makeStore({
        spaces: [
          { path: '/spaces/team-ops', type: 'shared' },
          { path: '/spaces/chief-of-staff', type: 'chief-of-staff' },
        ],
        spaceSafetyLevels: {},
      });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:set-space-safety-level')!;
      const res = await handler(null, {
        spaceId: '/spaces/does-not-exist',
        level: 'cautious',
      });
      expect(res).toEqual({
        success: false,
        error: 'UNKNOWN_SPACE_ID',
        spaceId: '/spaces/does-not-exist',
      });

      // No mutation.
      expect(store.__raw().spaceSafetyLevels).toEqual({});

      // Structured info log with reason=unknown_space.
      const infoCalls = (loggerMock.info as Mock).mock.calls.filter(
        ([obj]) =>
          obj &&
          typeof obj === 'object' &&
          obj.event === 'settings.set-space-safety-level.rejected' &&
          obj.reason === 'unknown_space',
      );
      expect(infoCalls.length).toBe(1);
      expect(infoCalls[0]![0]).toMatchObject({
        event: 'settings.set-space-safety-level.rejected',
        reason: 'unknown_space',
        spaceId: '/spaces/does-not-exist',
      });
    });

    it('rejects the hardcoded chief-of-staff space', async () => {
      // `chief-of-staff` type is stripped from the knownPaths set; the
      // handler must reject it as UNKNOWN_SPACE_ID even though the path
      // is listed in `spaces` — matches the documented never-stored rule.
      const store = makeStore({
        spaces: [{ path: '/spaces/chief-of-staff', type: 'chief-of-staff' }],
        spaceSafetyLevels: {},
      });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:set-space-safety-level')!;
      const res = await handler(null, {
        spaceId: '/spaces/chief-of-staff',
        level: 'balanced',
      });
      expect(res).toEqual({
        success: false,
        error: 'UNKNOWN_SPACE_ID',
        spaceId: '/spaces/chief-of-staff',
      });
    });

    it('refuses in read-only mode with READ_ONLY and emits the rejection warn log', async () => {
      readOnlyFlag = true;
      const store = makeStore({
        spaces: [{ path: '/spaces/team-ops' }],
        spaceSafetyLevels: {},
      });
      const deps = makeDeps(store);
      const { registerSettingsHandlers } = await import('../settingsHandlers');
      registerSettingsHandlers(deps);

      const handler = handlers.get('settings:set-space-safety-level')!;
      const res = await handler(null, {
        spaceId: '/spaces/team-ops',
        level: 'permissive',
      });
      expect(res).toEqual({ success: false, error: 'READ_ONLY' });

      const warnCalls = (loggerMock.warn as Mock).mock.calls.filter(
        ([obj]) =>
          obj &&
          typeof obj === 'object' &&
          obj.event === 'settings.set-space-safety-level.rejected' &&
          obj.reason === 'read_only',
      );
      expect(warnCalls.length).toBe(1);
    });
  });
});
