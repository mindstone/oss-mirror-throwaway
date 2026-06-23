/**
 * Integration test for the Stage 2 stale-sync merge guard wiring inside
 * the desktop `settings:update` IPC handler.
 *
 * The unit tests in `src/shared/utils/__tests__/learnedLimitsMergeGuard.test.ts`
 * already cover the merge semantics. This test verifies the handler
 * actually invokes the guard before writing to the store — i.e. that an
 * incoming `'auto'` payload with an older `contextWindowLearnedAt` does
 * NOT clobber a fresher local `'user'` (or `'auto'`) value.
 *
 * See docs/plans/260503_unify_learned_limits_into_profiles.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';

const testState = vi.hoisted(() => ({
  sendToAllWindows: vi.fn(),
  codexConnected: vi.fn(() => false),
}));

const loggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

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

const handlers = new Map<string, (...args: any[]) => any>();
vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, fn: (...args: any[]) => any) => {
    handlers.set(channel, fn);
  },
}));

vi.mock('@shared/utils/trustedToolNormalization', () => ({
  bareToolId: (id: string) => id as string & { __bareToolId: never },
}));

vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => null,
}));

vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: () => ({
    isConnected: testState.codexConnected,
  }),
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ sendToAllWindows: testState.sendToAllWindows });
});

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({
    userDataPath: '/tmp/test-userdata',
    totalMemoryBytes: 16 * 1024 * 1024 * 1024,
  }),
}));

vi.mock('../../services/mcpService', () => ({
  describeMcpConfiguration: vi.fn(),
  resolveMcpConfigPath: vi.fn().mockReturnValue(null),
  fetchPackageTools: vi.fn(),
  invalidateConnectedPackagesCache: vi.fn(),
  reconfigureSuperMcpWithCacheRefreshAndAwaitExecution: vi.fn(),
  reconfigureSuperMcpWithCacheRefreshDetached: vi.fn(),
  restartSuperMcpForConfigChangeAndAwaitExecution: vi.fn(),
  validateMcpServerAfterConfigChange: vi.fn(),
}));
vi.mock('../../services/superMcpHttpManager', () => ({
  superMcpHttpManager: {
    getState: () => ({ isRunning: false, url: null }),
    requestDebouncedRestartWhenIdle: vi.fn().mockResolvedValue(undefined),
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
  migrateLegacyWrapperSettingsIfNeeded: vi.fn(async (s: AppSettings) => s),
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
  getManagedMcpInstallService: vi.fn(() => ({ install: vi.fn() })),
}));
vi.mock('../../services/localModelProxyServer', () => ({
  proxyManager: {
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
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

const baseProfile: ModelProfile = {
  id: 'p-merge-guard',
  name: 'Merge Guard Profile',
  model: 'gpt-test',
  providerType: 'other',
  serverUrl: 'https://example.test',
  createdAt: 1,
};

function buildSettings(profile: ModelProfile): AppSettings {
  return {
    coreDirectory: '/tmp',
    localModel: { profiles: [profile], activeProfileId: null },
  } as unknown as AppSettings;
}

function makeStore(initial: AppSettings) {
  let state = initial;
  return {
    get store() {
      return state;
    },
    set store(next: AppSettings) {
      state = next;
    },
    __raw: () => state,
  };
}

function makeDeps(
  store: ReturnType<typeof makeStore>,
  overrides: Partial<{
    getScheduler: () => { handleAppLaunch: () => void };
  }> = {},
) {
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
    ...(overrides.getScheduler
      ? { getScheduler: overrides.getScheduler as any }
      : {}),
  };
}

describe('settings:update — Stage 2 stale-sync merge guard', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    readOnlyFlag = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves a local user-set context window when an older auto payload arrives', async () => {
    const localProfile: ModelProfile = {
      ...baseProfile,
      contextWindow: 1_500_000,
      contextWindowSource: 'user',
    };
    const store = makeStore(buildSettings(localProfile));
    const deps = makeDeps(store);

    const { registerSettingsHandlers } = await import('../settingsHandlers');
    registerSettingsHandlers(deps);

    const handler = handlers.get('settings:update');
    expect(handler).toBeDefined();

    const incomingProfile: ModelProfile = {
      ...baseProfile,
      contextWindow: 880_000,
      contextWindowSource: 'auto',
      contextWindowLearnedAt: 1,
    };

    await handler!(null, buildSettings(incomingProfile));

    const persisted = store.__raw().localModel!.profiles![0];
    expect(persisted.contextWindow).toBe(1_500_000);
    expect(persisted.contextWindowSource).toBe('user');
  });

  it('takes incoming user-set value over local auto-learned (user wins inverse)', async () => {
    const localProfile: ModelProfile = {
      ...baseProfile,
      contextWindow: 600_000,
      contextWindowSource: 'auto',
      contextWindowLearnedAt: 9_999,
    };
    const store = makeStore(buildSettings(localProfile));
    const deps = makeDeps(store);

    const { registerSettingsHandlers } = await import('../settingsHandlers');
    registerSettingsHandlers(deps);

    const handler = handlers.get('settings:update');
    const incomingProfile: ModelProfile = {
      ...baseProfile,
      contextWindow: 1_400_000,
      contextWindowSource: 'user',
    };
    await handler!(null, buildSettings(incomingProfile));

    const persisted = store.__raw().localModel!.profiles![0];
    expect(persisted.contextWindow).toBe(1_400_000);
    expect(persisted.contextWindowSource).toBe('user');
  });

  it('preserves local connection profileSource when incoming payload sends null', async () => {
    const localProfile: ModelProfile = {
      ...baseProfile,
      profileSource: 'connection',
    };
    const store = makeStore(buildSettings(localProfile));
    const deps = makeDeps(store);

    const { registerSettingsHandlers } = await import('../settingsHandlers');
    registerSettingsHandlers(deps);

    const handler = handlers.get('settings:update');
    const incomingProfile: ModelProfile = {
      ...baseProfile,
      profileSource: null as unknown as ModelProfile['profileSource'],
    };
    await handler!(null, buildSettings(incomingProfile));

    const persisted = store.__raw().localModel!.profiles![0];
    expect(persisted.profileSource).toBe('connection');
  });
});

describe('settings:update — Efficiency Mode coordination (260524_performance_mode)', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    readOnlyFlag = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildSettingsWith(extras: Partial<AppSettings>): AppSettings {
    return {
      coreDirectory: '/tmp',
      localModel: { profiles: [baseProfile], activeProfileId: null },
      ...extras,
    } as unknown as AppSettings;
  }

  it('snapshots the prior sub-settings into baseline when efficiencyMode goes off → on', async () => {
    const store = makeStore(buildSettingsWith({
      dailySparkMode: 'on',
      heroChoiceRunMode: 'automatic',
      timeSavedEstimation: { enabled: true },
      personaQuipsEnabled: true,
      cpuEmbeddingIdleDisposalEnabled: false,
    }));
    const deps = makeDeps(store);

    const { registerSettingsHandlers } = await import('../settingsHandlers');
    registerSettingsHandlers(deps);

    const handler = handlers.get('settings:update');
    expect(handler).toBeDefined();

    // Renderer sends the master toggle flipping to 'on'; sub-settings unchanged
    // in the payload.
    await handler!(null, buildSettingsWith({
      efficiencyMode: 'on',
      dailySparkMode: 'on',
      heroChoiceRunMode: 'automatic',
      timeSavedEstimation: { enabled: true },
      personaQuipsEnabled: true,
      cpuEmbeddingIdleDisposalEnabled: false,
    }));

    const persisted = store.__raw();
    expect(persisted.efficiencyMode).toBe('on');
    expect(persisted.efficiencyModeBaseline).toEqual({
      dailySparkMode: 'on',
      heroChoiceRunMode: 'automatic',
      timeSavedEstimationEnabled: true,
      personaQuipsEnabled: true,
      cpuEmbeddingIdleDisposalEnabled: false,
    });
    // Underlying sub-settings flipped to lite values
    expect(persisted.dailySparkMode).toBe('off');
    expect(persisted.heroChoiceRunMode).toBe('off');
    expect(persisted.timeSavedEstimation?.enabled).toBe(false);
    expect(persisted.personaQuipsEnabled).toBe(false);
    expect(persisted.cpuEmbeddingIdleDisposalEnabled).toBe(true);
  });

  it('restores the snapshotted values when efficiencyMode goes on → off', async () => {
    const store = makeStore(buildSettingsWith({
      efficiencyMode: 'on',
      efficiencyModeBaseline: {
        dailySparkMode: 'subtle',
        heroChoiceRunMode: 'ask',
        timeSavedEstimationEnabled: true,
        personaQuipsEnabled: true,
        cpuEmbeddingIdleDisposalEnabled: false,
      },
      dailySparkMode: 'off',
      heroChoiceRunMode: 'off',
      timeSavedEstimation: { enabled: false },
      personaQuipsEnabled: false,
      cpuEmbeddingIdleDisposalEnabled: true,
    }));
    const deps = makeDeps(store);

    const { registerSettingsHandlers } = await import('../settingsHandlers');
    registerSettingsHandlers(deps);

    const handler = handlers.get('settings:update');

    await handler!(null, buildSettingsWith({
      efficiencyMode: 'off',
      // Renderer's other fields are ignored for the gated keys; main process
      // restores from baseline.
      dailySparkMode: 'off',
      heroChoiceRunMode: 'off',
      timeSavedEstimation: { enabled: false },
      personaQuipsEnabled: false,
      cpuEmbeddingIdleDisposalEnabled: true,
    }));

    const persisted = store.__raw();
    expect(persisted.efficiencyMode).toBe('off');
    expect(persisted.efficiencyModeBaseline).toBeUndefined();
    expect(persisted.dailySparkMode).toBe('subtle');
    expect(persisted.heroChoiceRunMode).toBe('ask');
    expect(persisted.timeSavedEstimation?.enabled).toBe(true);
    expect(persisted.personaQuipsEnabled).toBe(true);
    expect(persisted.cpuEmbeddingIdleDisposalEnabled).toBe(false);
  });

  it('idempotently re-applies the preset when efficiencyMode stays on (unrelated field changes)', async () => {
    const store = makeStore(buildSettingsWith({
      efficiencyMode: 'on',
      efficiencyModeBaseline: { dailySparkMode: 'on' },
      dailySparkMode: 'off',
    }));
    const deps = makeDeps(store);

    const { registerSettingsHandlers } = await import('../settingsHandlers');
    registerSettingsHandlers(deps);

    const handler = handlers.get('settings:update');

    // Update with efficiencyMode still 'on' but a normal (unrelated) field changed.
    await handler!(null, buildSettingsWith({
      efficiencyMode: 'on',
      efficiencyModeBaseline: { dailySparkMode: 'on' },
      dailySparkMode: 'off',
      theme: 'dark',
    }));

    const persisted = store.__raw();
    expect(persisted.efficiencyMode).toBe('on');
    // Baseline preserved unchanged via the idempotent enable path.
    expect(persisted.efficiencyModeBaseline).toEqual({ dailySparkMode: 'on' });
    expect((persisted as AppSettings & { theme?: string }).theme).toBe('dark');
  });

  // Race / idempotency guard: a stale full-settings payload that arrives while
  // efficiencyMode is already on must NOT silently clobber the baseline or
  // un-quiet the sub-settings. See the behavioral-safety review in
  // `docs/plans/260524_performance_mode.md`.
  it('rejects a stale unchanged-on payload that tries to overwrite the baseline / un-quiet sub-settings', async () => {
    const realBaseline = {
      dailySparkMode: 'on' as const,
      heroChoiceRunMode: 'ask' as const,
      timeSavedEstimationEnabled: true,
      personaQuipsEnabled: true,
      cpuEmbeddingIdleDisposalEnabled: false,
    };
    const store = makeStore(buildSettingsWith({
      efficiencyMode: 'on',
      efficiencyModeBaseline: realBaseline,
      dailySparkMode: 'off',
      heroChoiceRunMode: 'off',
      timeSavedEstimation: { enabled: false },
      personaQuipsEnabled: false,
      cpuEmbeddingIdleDisposalEnabled: true,
    }));
    const deps = makeDeps(store);

    const { registerSettingsHandlers } = await import('../settingsHandlers');
    registerSettingsHandlers(deps);

    const handler = handlers.get('settings:update');

    // A stale full payload (e.g. from a rapid double-click on the Home offer)
    // tries to overwrite the baseline with the Efficiency preset values AND
    // un-quiet the sub-settings. The server must idempotently re-apply the
    // preset and preserve the real baseline.
    await handler!(null, buildSettingsWith({
      efficiencyMode: 'on',
      efficiencyModeBaseline: undefined,
      dailySparkMode: 'on',
      heroChoiceRunMode: 'ask',
      timeSavedEstimation: { enabled: true },
      personaQuipsEnabled: true,
      cpuEmbeddingIdleDisposalEnabled: false,
    }));

    const persisted = store.__raw();
    expect(persisted.efficiencyMode).toBe('on');
    expect(persisted.efficiencyModeBaseline).toEqual(realBaseline);
    expect(persisted.dailySparkMode).toBe('off');
    expect(persisted.heroChoiceRunMode).toBe('off');
    expect(persisted.timeSavedEstimation?.enabled).toBe(false);
    expect(persisted.personaQuipsEnabled).toBe(false);
    expect(persisted.cpuEmbeddingIdleDisposalEnabled).toBe(true);
  });
});

describe('settings:update — provider credential signaling (Stage 3 round 3)', () => {
  const buildProviderSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
    coreDirectory: '/tmp',
    onboardingCompleted: true,
    models: {
      apiKey: null,
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-opus-4-7',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    openRouter: {
      enabled: false,
      oauthToken: null,
      selectedModel: 'openai/gpt-5.5',
    },
    activeProvider: 'anthropic',
    localModel: { profiles: [baseProfile], activeProfileId: null },
    ...overrides,
  } as unknown as AppSettings);

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    readOnlyFlag = false;
    testState.sendToAllWindows.mockClear();
    testState.codexConnected.mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('broadcasts settings:external-update when provider credential-relevant fields change', async () => {
    const store = makeStore(buildProviderSettings());
    const deps = makeDeps(store);

    const { registerSettingsHandlers } = await import('../settingsHandlers');
    registerSettingsHandlers(deps);
    const handler = handlers.get('settings:update');

    await handler!(null, buildProviderSettings({ activeProvider: 'codex' }));

    expect(testState.sendToAllWindows).toHaveBeenCalledWith('settings:external-update');
  });

  it('does not broadcast settings:external-update for unrelated settings writes', async () => {
    const store = makeStore(buildProviderSettings());
    const deps = makeDeps(store);

    const { registerSettingsHandlers } = await import('../settingsHandlers');
    registerSettingsHandlers(deps);
    const handler = handlers.get('settings:update');

    await handler!(null, buildProviderSettings({ onboardingCompleted: false }));

    expect(testState.sendToAllWindows).not.toHaveBeenCalledWith('settings:external-update');
  });

  it('triggers a catch-up sweep when credential readiness transitions blocked -> ready', async () => {
    const scheduler = { handleAppLaunch: vi.fn() };
    const store = makeStore(buildProviderSettings({
      activeProvider: 'anthropic',
      models: {
        apiKey: null,
        oauthToken: null,
        authMethod: 'api-key',
        model: 'claude-opus-4-7',
        permissionMode: 'bypassPermissions',
        executablePath: null,
        planMode: false,
        extendedContext: true,
        thinkingEffort: 'high',
      },
    }));
    const deps = makeDeps(store, {
      getScheduler: () => scheduler,
    });

    const { registerSettingsHandlers } = await import('../settingsHandlers');
    registerSettingsHandlers(deps);
    const handler = handlers.get('settings:update');

    await handler!(null, buildProviderSettings({
      activeProvider: 'anthropic',
      models: {
        apiKey: 'test-anthropic-key-ready',
        oauthToken: null,
        authMethod: 'api-key',
        model: 'claude-opus-4-7',
        permissionMode: 'bypassPermissions',
        executablePath: null,
        planMode: false,
        extendedContext: true,
        thinkingEffort: 'high',
      },
    }));

    expect(testState.sendToAllWindows).toHaveBeenCalledWith('settings:external-update');
    expect(scheduler.handleAppLaunch).toHaveBeenCalledTimes(1);
  });
});

// Regression: a BARE PARTIAL `settings:update` (e.g. `{ cloudInstance }` from the
// cloud-provisioning flow) must NOT be treated as a whole-document replace. Before
// the fix, `normalizeSettings(partial)` back-filled every missing field with
// DEFAULTS — flipping `onboardingCompleted` → false (re-onboarding) and resetting
// `voice` to defaults (wiping STT credentials). The handler now shallow-merges the
// incoming partial over current settings before normalize/write.
// See docs/plans/260622_mobile-setup-investigation.
describe('settings:update — partial payloads must not clobber unrelated fields', () => {
  const buildFullSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
    coreDirectory: '/tmp/workspace',
    mcpConfigFile: null,
    onboardingCompleted: true,
    onboardingFirstCompletedAt: 1_700_000_000_000,
    userEmail: 'user@example.com',
    // Populated voice config — a provisioned STT credential that must survive.
    voice: {
      provider: 'openai-whisper',
      // Derived from providerKeys.openai by normalizeSettings — seed both so the
      // key round-trips through normalization.
      openaiApiKey: 'fake-openai-voice-key',
      elevenlabsApiKey: 'el-test-elevenlabs-key',
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: 'nova',
    },
    providerKeys: { openai: 'fake-openai-voice-key' },
    models: {
      apiKey: 'fake-anthropic-key',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-opus-4-7',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    activeProvider: 'anthropic',
    localModel: { profiles: [baseProfile], activeProfileId: null },
    theme: 'dark',
    ...overrides,
  } as unknown as AppSettings);

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    readOnlyFlag = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves onboardingCompleted and voice when only { cloudInstance } is sent', async () => {
    const store = makeStore(buildFullSettings());
    const deps = makeDeps(store);

    const { registerSettingsHandlers } = await import('../settingsHandlers');
    registerSettingsHandlers(deps);

    const handler = handlers.get('settings:update');
    expect(handler).toBeDefined();

    // The cloud-provisioning flow sends a BARE PARTIAL — only cloudInstance.
    const newCloudConfig = {
      mode: 'cloud' as const,
      cloudUrl: 'https://rebel-test.example.dev',
      cloudToken: 'cloud-token-xyz',
      providerId: 'fly' as const,
      provisionedAt: 1_700_000_100_000,
      provisionMode: 'managed' as const,
    };

    await handler!(null, { cloudInstance: newCloudConfig });

    const persisted = store.__raw();
    // The bug: these would be clobbered to DEFAULTS without the merge.
    expect(persisted.onboardingCompleted).toBe(true);
    expect(persisted.voice.openaiApiKey).toBe('fake-openai-voice-key');
    expect(persisted.voice.elevenlabsApiKey).toBe('el-test-elevenlabs-key');
    expect(persisted.voice.provider).toBe('openai-whisper');
    // And the intended update still lands.
    expect(persisted.cloudInstance?.mode).toBe('cloud');
    expect(persisted.cloudInstance?.cloudUrl).toBe('https://rebel-test.example.dev');
  });

  it('preserves unrelated fields when only { cloudUpdateChannel } is sent', async () => {
    const store = makeStore(buildFullSettings({ cloudUpdateChannel: 'stable' }));
    const deps = makeDeps(store);

    const { registerSettingsHandlers } = await import('../settingsHandlers');
    registerSettingsHandlers(deps);

    const handler = handlers.get('settings:update');

    await handler!(null, { cloudUpdateChannel: 'beta' });

    const persisted = store.__raw();
    expect(persisted.cloudUpdateChannel).toBe('beta');
    expect(persisted.onboardingCompleted).toBe(true);
    expect(persisted.voice.elevenlabsApiKey).toBe('el-test-elevenlabs-key');
    expect(persisted.coreDirectory).toBe('/tmp/workspace');
  });
});
