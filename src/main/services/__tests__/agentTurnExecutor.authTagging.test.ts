 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import {
  createAgentEventDispatcherMock,
  createLocalModelProxyServerMock,
  createCouncilServiceMock,
  createAdHocAgentServiceMock,
  createClaudeMentionAgentServiceMock,
  createMcpServiceMock,
  createToolSafetyServiceMock,
  createMemoryWriteHookMock,
  createStagedReadHookMock,
  createFileConversationTrackingHookMock,
  createAutoContinueHookMock,
  createAutoContinueCacheMock,
  createPendingApprovalsStoreMock,
  createAgentMessageHandlerMock,
  createSystemUtilsMock,
  createAuthEnvUtilsMock,
  createModelNormalizationMock,
  createSettingsUtilsMock,
  createSemanticContextServiceMock,
  createConversationContextServiceMock,
  createConversationHistoryServiceMock,
  createBuildContinuationContextMock,
  createAgentTurnFormattersMock,
  createConversationIndexServiceMock,
  createToolIndexServiceMock,
  createTrackingMock,
  createErrorReporterMock,
  createIncrementalSessionStoreMock,
  createConstantsMock,
  createPromptCacheWarmupServiceMock,
  createMcpServerAliasMock,
  createFriendlyErrorsMock,
  createAgentErrorCatalogMock,
  createToolNameValidationMock,
  createDelayWithAbortMock,
  createApiRateLimitCooldownMock,
  createCostLedgerServiceMock,
  createPricingCalculatorMock,
  createAgentTurnUtilsMock,
  createLoggerMock,
} from './agentTurnExecutor.testHarness';
import type { MockFactories } from './agentTurnExecutor.testHarness';

const getSettingsMock = vi.hoisted(() => vi.fn());
const isCodexConnectedMock = vi.hoisted(() => vi.fn());
const getCodexAccessTokenMock = vi.hoisted(() => vi.fn(async () => 'codex-token'));
const getCodexAccountIdMock = vi.hoisted(() => vi.fn(() => 'org_123'));
const forceRefreshCodexAccessTokenMock = vi.hoisted(() => vi.fn(async () => 'codex-token-refreshed'));
const getCodexStatusMock = vi.hoisted(() => vi.fn(() => ({ connected: true })));

const factories = vi.hoisted((): MockFactories => {
  const mockTurnLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    flushSessionLogs: vi.fn(async () => {}),
    sessionLogPath: '/tmp/test-turn.log',
  };
  return {
    queryMock: vi.fn(),
    dispatchAgentEventMock: vi.fn(),
    dispatchAgentErrorEventMock: vi.fn(),
    mockTurnLogger,
    resolveModelConfigMock: vi.fn(),
    buildCouncilConfigMock: vi.fn(),
    resolveCouncilLeadModelMock: vi.fn(),
    detectModelReferencesMock: vi.fn(),
    buildAdHocAgentConfigMock: vi.fn(),
    detectClaudeModelReferencesMock: vi.fn(),
    buildClaudeSubagentConfigMock: vi.fn(),
    getThinkingProfileMock: vi.fn(),
    getWorkingProfileMock: vi.fn(),
    addRoutesMock: vi.fn(),
    getAndResetTurnStatsMock: vi.fn(),
    removeRoutesMock: vi.fn(),
    getUrlMock: vi.fn(),
    getAuthTokenMock: vi.fn(),
    getWorkingModelProfileMock: vi.fn(),
    resolveMcpServersMock: vi.fn(),
    resolveSystemPromptMock: vi.fn(),
    buildConnectedPackagesMock: vi.fn(),
    getAuthEnvVarsMock: vi.fn(),
    runAgentQueryMock: vi.fn(),
    superMcpGetStateMock: vi.fn(),
  };
});

const agentTurnRegistryModule = vi.hoisted(() => {
  type DriftCase = 'caseA' | 'caseB';
  const codexProfileDriftWarningTurns = new Map<string, Set<DriftCase>>();
  let retryCount = 0;

  return {
    agentTurnRegistry: {
      setActiveTurnController: vi.fn(),
      setRendererSession: vi.fn(),
      getRendererSession: vi.fn(() => null),
      clearExtendedContextFailed: vi.fn(),
      hasExtendedContextFailed: vi.fn(() => false),
      setTurnPrivateMode: vi.fn(),
      setTurnCategory: vi.fn(),
      setTurnLogger: vi.fn(),
      getTurnLogger: vi.fn(() => factories.mockTurnLogger),
      deleteTurnLogger: vi.fn(),
      deleteContextAccumulator: vi.fn(),
      cleanupTurn: vi.fn((turnId: string) => {
        codexProfileDriftWarningTurns.delete(turnId);
        retryCount = 0;
      }),
      setTurnPrompt: vi.fn(),
      getTurnPrompt: vi.fn(() => undefined),
      setTurnExtendedContext: vi.fn(),
      setTurnThinkingEffort: vi.fn(),
      setTurnAuthMethod: vi.fn(),
      hasCodexProfileDriftWarningEmitted: vi.fn((turnId: string, kase: DriftCase) =>
        codexProfileDriftWarningTurns.get(turnId)?.has(kase) ?? false,
      ),
      markCodexProfileDriftWarningEmitted: vi.fn((turnId: string, kase: DriftCase) => {
        let set = codexProfileDriftWarningTurns.get(turnId);
        if (!set) {
          set = new Set<DriftCase>();
          codexProfileDriftWarningTurns.set(turnId, set);
        }
        set.add(kase);
      }),
      setTurnPlanningModel: vi.fn(),
      setTurnFastModel: vi.fn(),
      getActiveTurnCount: vi.fn(() => 1),
      setTurnSpawnDelayed: vi.fn(),
      getTurnSpawnDelayed: vi.fn(() => false),
      getTurnModel: vi.fn(() => null),
      getTurnActiveProvider: vi.fn(() => undefined),
      setTurnActiveProvider: vi.fn(),
      setTurnModel: vi.fn(),
      addTurnFallback: vi.fn(),
      cleanupForRetry: vi.fn(),
      hasContextOverflowDispatched: vi.fn(() => false),
      markContextOverflowDispatched: vi.fn(),
      markExtendedContextFailed: vi.fn(),
      hasActionableErrorDispatched: vi.fn(() => false),
      getRetryCount: vi.fn(() => retryCount),
      incrementRetryCount: vi.fn(() => {
        retryCount += 1;
        return retryCount;
      }),
      deleteRetryCount: vi.fn(() => {
        retryCount = 0;
      }),
      getContextAccumulator: vi.fn(() => ''),
      getTurnExtendedContext: vi.fn(() => false),
      getTurnContextWindow: vi.fn(() => null),
      setTurnContextWindow: vi.fn(),
      getActiveTurnController: vi.fn(() => null),
      setTurnCloseCallback: vi.fn(),
      getTurnCloseCallback: vi.fn(() => undefined),
      deleteTurnCloseCallback: vi.fn(),
      hasSuccessResultDispatched: vi.fn(() => false),
      hasCostRecorded: vi.fn(() => false),
      markCostRecorded: vi.fn(),
      recordSessionTurn: vi.fn(),
      hasSessionHadTurns: vi.fn(() => false),
      hasUserQuestionPending: vi.fn(() => false),
      hasOutputCapRetryAttempted: vi.fn(() => false),
      markOutputCapRetryAttempted: vi.fn(),
      clearOutputCapRetryAttempted: vi.fn(),
      getTurnPlanningModel: vi.fn(() => undefined),
      getTurnFastModel: vi.fn(() => undefined),
      recordWatchdogSelfResolution: vi.fn(),
      __resetAuthTaggingTestState: () => {
        codexProfileDriftWarningTurns.clear();
        retryCount = 0;
      },
    },
    cleanupTurnAggregator: vi.fn(),
    cleanupPendingApprovals: vi.fn(),
    cleanupSessionPendingApprovals: vi.fn(),
  };
});

vi.mock('../agentQueryRunner', () => ({ runAgentQuery: factories.runAgentQueryMock }));
vi.mock('@core/rebelCore/queryRouter', () => ({ queryWithRuntime: vi.fn() }));
vi.mock('@core/logger', () => createLoggerMock(factories));
vi.mock('../agentEventDispatcher', () => createAgentEventDispatcherMock(factories));
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: getSettingsMock,
}));
vi.mock('../agentTurnRegistry', () => agentTurnRegistryModule);
vi.mock('../localModelProxyServer', () => createLocalModelProxyServerMock(factories));
vi.mock('../superMcpHttpManager', () => ({ superMcpHttpManager: { getState: factories.superMcpGetStateMock } }));
vi.mock('../councilService', () => createCouncilServiceMock(factories));
vi.mock('../adHocAgentService', () => createAdHocAgentServiceMock(factories));
vi.mock('../claudeMentionAgentService', () => createClaudeMentionAgentServiceMock(factories));
vi.mock('../mcpService', () => createMcpServiceMock(factories));
vi.mock('../toolSafetyService', () => createToolSafetyServiceMock());
vi.mock('../safety/memoryWriteHook', () => createMemoryWriteHookMock());
vi.mock('../safety/stagedReadHook', () => createStagedReadHookMock());
vi.mock('../fileConversationTrackingHook', () => createFileConversationTrackingHookMock());
vi.mock('../autoContinueHook', () => createAutoContinueHookMock());
vi.mock('../autoContinueCache', () => createAutoContinueCacheMock());
vi.mock('../safety/pendingApprovalsStore', () => createPendingApprovalsStoreMock());
vi.mock('../agentMessageHandler', () => createAgentMessageHandlerMock());
vi.mock('../../utils/systemUtils', () => createSystemUtilsMock());
vi.mock('../utils/authEnvUtils', () => createAuthEnvUtilsMock(factories));
vi.mock('@shared/utils/modelNormalization', () => createModelNormalizationMock(factories));
vi.mock('@core/rebelCore/modelLimits', () => ({
  shouldSuppressProfileReasoning: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => profile?.thinkingCompatibility === 'incompatible',
  resolveProfileReasoningEffort: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => (profile?.thinkingCompatibility === 'incompatible' ? undefined : profile?.reasoningEffort),
  resolveModelLimits: vi.fn(() => ({ contextWindow: 200_000, maxOutputTokens: 8192 })),
}));

vi.mock('@shared/utils/settingsUtils', () => createSettingsUtilsMock(factories));
vi.mock('@shared/types', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@shared/types');
  return { ...actual, getWorkingModelProfile: factories.getWorkingModelProfileMock };
});
vi.mock('../semanticContextService', () => createSemanticContextServiceMock());
vi.mock('../conversationContextService', () => createConversationContextServiceMock());
vi.mock('../conversationHistoryService', () => createConversationHistoryServiceMock());
vi.mock('@core/services/buildContinuationContext', () => createBuildContinuationContextMock());
vi.mock('../../utils/agentTurnFormatters', () => createAgentTurnFormattersMock());
vi.mock('../conversationIndexService', () => createConversationIndexServiceMock());
vi.mock('../toolIndexService', () => createToolIndexServiceMock());
vi.mock('../../tracking', () => createTrackingMock());
vi.mock('@core/errorReporter', () => createErrorReporterMock());
vi.mock('../incrementalSessionStore', () => createIncrementalSessionStoreMock());
vi.mock('../../constants', () => createConstantsMock());
vi.mock('../promptCacheWarmupService', () => createPromptCacheWarmupServiceMock());
vi.mock('../mcpServerAlias', () => createMcpServerAliasMock());
vi.mock('@shared/utils/friendlyErrors', () => createFriendlyErrorsMock());
vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) => createAgentErrorCatalogMock(importOriginal));
vi.mock('@shared/utils/toolNameValidation', () => createToolNameValidationMock());
vi.mock('@core/utils/delayWithAbort', () => createDelayWithAbortMock());
vi.mock('@core/services/apiRateLimitCooldown', () => createApiRateLimitCooldownMock());
vi.mock('../costLedgerService', () => createCostLedgerServiceMock());
vi.mock('@shared/utils/pricingCalculator', () => createPricingCalculatorMock());
vi.mock('../../utils/agentTurnUtils', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../utils/agentTurnUtils');
  return createAgentTurnUtilsMock(actual);
});
vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: vi.fn(() => ({
    isConnected: isCodexConnectedMock,
    getAccessToken: getCodexAccessTokenMock,
    getAccountId: getCodexAccountIdMock,
    forceRefreshToken: forceRefreshCodexAccessTokenMock,
    getStatus: getCodexStatusMock,
  })),
  CODEX_ENDPOINT_URL: 'https://chatgpt.com/backend-api/codex',
}));

import { executeAgentTurn } from '../agentTurnExecutor';
// Stage 4b: the real per-credential cooldown singleton (NOT mocked in this file) —
// spied on to assert the post-turn success path clears the just-used credential's cooldown.
import { providerRateLimitCooldowns } from '@core/services/providerRateLimitCooldowns';

const runAgentQueryMock = factories.runAgentQueryMock!;
const superMcpGetStateMock = factories.superMcpGetStateMock!;
const registryMock = agentTurnRegistryModule.agentTurnRegistry;
const CASE_A_DRIFT_WARNING_MESSAGE =
  'Codex profile state rescued: route plan tagged subscription despite null working profile';
const CASE_B_DRIFT_WARNING_MESSAGE =
  'Codex active+connected but route did not resolve to subscription (model or profile mismatch)';

function makeCodexProfile(): ModelProfile {
  return {
    id: 'codex-gpt-5.5',
    name: 'GPT-5.5 (ChatGPT Pro)',
    authSource: 'codex-subscription',
    model: 'gpt-5.5',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    enabled: true,
    createdAt: 0,
  };
}

function makeLocalProfile(): ModelProfile {
  return {
    id: 'local-llama',
    name: 'Local Llama',
    model: 'llama-local',
    providerType: 'local',
    serverUrl: 'http://localhost:11434/v1',
    enabled: true,
    createdAt: 0,
  };
}

function makeTogetherLlamaProfile(): ModelProfile {
  return {
    id: 'together-llama',
    name: 'Together Llama',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    providerType: 'openai',
    serverUrl: 'https://api.together.xyz/v1',
    apiKey: 'fake-together-profile-key',
    enabled: true,
    createdAt: 0,
  };
}

function createSettings(overrides: {
  activeProvider?: AppSettings['activeProvider'];
  model?: string;
  profile?: ModelProfile | null;
  workingProfileId?: string | null;
  openRouterToken?: string | null;
} = {}): AppSettings {
  const profile = overrides.profile ?? null;
  return {
    coreDirectory: process.cwd(),
    mcpConfigFile: null,
    onboardingCompleted: false,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    activeProvider: overrides.activeProvider ?? 'anthropic',
    models: {
      model: overrides.model ?? profile?.model ?? 'claude-sonnet-4-5',
      workingProfileId: (
        overrides.workingProfileId === null
          ? null
          : overrides.workingProfileId ?? profile?.id
      ) as unknown as string | undefined,
      thinkingModel: undefined,
      oauthToken: null,
      authMethod: 'api-key',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: false,
      thinkingEffort: 'medium',
      apiKey: 'fake-anthropic-key',
      longContextFallbackModel: undefined,
    },
    claude: {
      model: overrides.model ?? profile?.model ?? 'claude-sonnet-4-5',
      workingProfileId: (
        overrides.workingProfileId === null
          ? null
          : overrides.workingProfileId ?? profile?.id
      ) as unknown as string | undefined,
      thinkingModel: undefined,
      oauthToken: null,
      authMethod: 'api-key',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: false,
      thinkingEffort: 'medium',
      apiKey: 'fake-anthropic-key',
      longContextFallbackModel: undefined,
    },
    openRouter: {
      enabled: overrides.activeProvider === 'openrouter',
      oauthToken: overrides.openRouterToken ?? null,
      selectedModel: 'anthropic/claude-sonnet-4-5',
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'whisper-1',
      ttsVoice: null,
      activationHotkey: 'Alt+Space',
      activationHotkeyVoiceMode: true,
    },
    providerKeys: { openai: 'fake-shared-openai' },
    localModel: { profiles: profile ? [profile] : [], activeProfileId: null },
  };
}

function setSettingsForTurn(settings: AppSettings, profile: ModelProfile | null): void {
  getSettingsMock.mockReturnValue(settings);
  factories.getThinkingProfileMock.mockReturnValue(null);
  factories.getWorkingProfileMock.mockReturnValue(profile);
  factories.getWorkingModelProfileMock.mockReturnValue(profile);
}

async function runTurn(turnId = 'turn-auth-tagging'): Promise<void> {
  await executeAgentTurn(null, turnId, 'Hello', {
    sessionId: `renderer-session-${turnId}`,
    resetConversation: false,
  });
}

function driftWarningCalls(): unknown[][] {
  return factories.mockTurnLogger.warn.mock.calls.filter(
    (call) => call[1] === CASE_A_DRIFT_WARNING_MESSAGE || call[1] === CASE_B_DRIFT_WARNING_MESSAGE,
  );
}

function driftWarningCallsFor(message: string): unknown[][] {
  return factories.mockTurnLogger.warn.mock.calls.filter((call) => call[1] === message);
}

type AuthTaggingScenario = {
  id: string;
  name: string;
  profile: () => ModelProfile | null;
  settings: (profile: ModelProfile | null) => AppSettings;
  expectedAuth: 'codex-subscription' | 'api-key' | 'local' | 'profile-direct' | 'openrouter';
  expectedDriftWarnings: string[];
};

const AUTH_TAGGING_SCENARIOS: AuthTaggingScenario[] = [
  {
    id: 'codex-profile',
    name: 'connected Codex profile',
    profile: makeCodexProfile,
    settings: (profile) => createSettings({ activeProvider: 'codex', profile }),
    expectedAuth: 'codex-subscription',
    expectedDriftWarnings: [],
  },
  {
    id: 'codex-null-profile',
    name: 'connected Codex with null working profile',
    profile: () => null,
    settings: () => createSettings({ activeProvider: 'codex', model: 'gpt-5.5', workingProfileId: null }),
    expectedAuth: 'codex-subscription',
    expectedDriftWarnings: [CASE_A_DRIFT_WARNING_MESSAGE],
  },
  {
    id: 'codex-claude-model',
    name: 'connected Codex with non-subscription route',
    profile: () => null,
    settings: () => createSettings({ activeProvider: 'codex', model: 'claude-sonnet-4', workingProfileId: null }),
    expectedAuth: 'api-key',
    expectedDriftWarnings: [CASE_B_DRIFT_WARNING_MESSAGE],
  },
  {
    id: 'codex-local-profile',
    name: 'connected Codex with local profile',
    profile: makeLocalProfile,
    settings: (profile) => createSettings({ activeProvider: 'codex', profile }),
    expectedAuth: 'local',
    expectedDriftWarnings: [CASE_B_DRIFT_WARNING_MESSAGE],
  },
  {
    id: 'anthropic-api-key',
    name: 'Anthropic API-key route',
    profile: () => null,
    settings: () => createSettings({ activeProvider: 'anthropic', model: 'claude-sonnet-4-5' }),
    expectedAuth: 'api-key',
    expectedDriftWarnings: [],
  },
  {
    id: 'anthropic-profile-direct',
    name: 'Anthropic active with OpenAI-compatible profile',
    profile: makeTogetherLlamaProfile,
    settings: (profile) => createSettings({
      activeProvider: 'anthropic',
      model: profile?.model,
      profile,
      workingProfileId: 'together-llama',
    }),
    expectedAuth: 'profile-direct',
    expectedDriftWarnings: [],
  },
  {
    id: 'openrouter-token',
    name: 'OpenRouter OAuth route',
    profile: () => null,
    settings: () => createSettings({
      activeProvider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
      openRouterToken: 'fake-openrouter-token',
    }),
    expectedAuth: 'openrouter',
    expectedDriftWarnings: [],
  },
];

describe('executeAgentTurn auth tagging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registryMock.__resetAuthTaggingTestState();

    isCodexConnectedMock.mockReturnValue(true);
    getCodexStatusMock.mockReturnValue({ connected: true });
    factories.resolveModelConfigMock.mockImplementation((model: string) => ({
      model,
      envOverrides: undefined,
    }));
    factories.resolveSystemPromptMock.mockResolvedValue('You are Rebel.');
    factories.resolveMcpServersMock.mockResolvedValue({
      servers: undefined,
      mode: 'unavailable',
      upstreamCount: 0,
      configPath: undefined,
    });
    factories.buildConnectedPackagesMock.mockResolvedValue([]);
    factories.getAuthEnvVarsMock.mockReturnValue({});
    factories.buildCouncilConfigMock.mockReturnValue(null);
    factories.resolveCouncilLeadModelMock.mockReturnValue('claude-sonnet-4-5');
    factories.detectModelReferencesMock.mockReturnValue([]);
    factories.buildAdHocAgentConfigMock.mockReturnValue(null);
    factories.detectClaudeModelReferencesMock.mockReturnValue([]);
    factories.buildClaudeSubagentConfigMock.mockReturnValue(null);
    factories.addRoutesMock.mockResolvedValue(undefined);
    factories.getAndResetTurnStatsMock.mockReturnValue(new Map());
    factories.removeRoutesMock.mockReturnValue(undefined);
    factories.getUrlMock.mockReturnValue('http://proxy.local');
    factories.getAuthTokenMock.mockReturnValue('proxy-auth-token');
    superMcpGetStateMock.mockReturnValue({ isRunning: false, url: '' });
    runAgentQueryMock.mockResolvedValue({
      abortedByUser: false,
      terminatedByHandler: false,
    });
  });

  describe.each(AUTH_TAGGING_SCENARIOS)('$name', (scenario) => {
    it(`tags auth as ${scenario.expectedAuth}`, async () => {
      const profile = scenario.profile();
      setSettingsForTurn(scenario.settings(profile), profile);

      await runTurn(`turn-auth-matrix-${scenario.id}`);

      expect(registryMock.setTurnAuthMethod).toHaveBeenCalledWith(
        `turn-auth-matrix-${scenario.id}`,
        scenario.expectedAuth,
      );
      expect(driftWarningCalls()).toHaveLength(scenario.expectedDriftWarnings.length);
      for (const message of scenario.expectedDriftWarnings) {
        expect(driftWarningCallsFor(message)).toHaveLength(1);
      }
    });
  });

  // FOX-3436: the turn registry's working-model binding must reflect the routed profile model even
  // on the managed flat-fee / proxy-required route (directExecutionClient undefined). The minimal
  // fix drops the `directExecutionClient &&` precondition so the write fires whenever an active
  // profile model overrides the configured base; the no-profile default path is untouched (the
  // base model is already recorded at :3240).
  describe('FOX-3436 working-model registry binding', () => {
    function lastTurnModelFor(turnId: string): string | undefined {
      const calls = registryMock.setTurnModel.mock.calls.filter((c) => c[0] === turnId);
      return calls.length ? (calls[calls.length - 1][1] as string) : undefined;
    }

    it('records the proxy-routed profile model (not the configured base) on the proxy-required path', async () => {
      // Connected Codex profile → directExecutionClient is left undefined (proxy-backed), while the
      // configured base model is a DIFFERENT Claude alias. Pre-fix the registry kept the base alias.
      const profile = makeCodexProfile(); // model: 'gpt-5.5', codex-subscription → proxy
      setSettingsForTurn(
        createSettings({ activeProvider: 'codex', model: 'claude-opus-4-8', profile, workingProfileId: profile.id }),
        profile,
      );

      await runTurn('turn-fox3436-proxy');

      expect(registryMock.setTurnModel).toHaveBeenCalledWith('turn-fox3436-proxy', 'gpt-5.5');
      expect(lastTurnModelFor('turn-fox3436-proxy')).toBe('gpt-5.5');
    });

    it('still records the profile model on the direct-client path (behavior preserved)', async () => {
      const profile = makeTogetherLlamaProfile(); // OpenAI-compatible → real direct client
      setSettingsForTurn(
        createSettings({ activeProvider: 'anthropic', model: 'claude-opus-4-8', profile, workingProfileId: profile.id }),
        profile,
      );

      await runTurn('turn-fox3436-direct');

      expect(lastTurnModelFor('turn-fox3436-direct')).toBe(profile.model);
    });

    it('does NOT add an extra write at this seam on the no-profile default path', async () => {
      // No active profile → activeProfileModel is undefined → the relaxed guard does not write here.
      // The base model is recorded once at :3240 and left untouched (no fixture churn). Assert the
      // configured base is recorded exactly once and the seam adds nothing beyond it.
      setSettingsForTurn(createSettings({ activeProvider: 'anthropic', model: 'claude-sonnet-4-5' }), null);

      await runTurn('turn-fox3436-noprofile');

      const baseWrites = registryMock.setTurnModel.mock.calls.filter(
        (c) => c[0] === 'turn-fox3436-noprofile' && c[1] === 'claude-sonnet-4-5',
      );
      expect(baseWrites).toHaveLength(1);
      expect(lastTurnModelFor('turn-fox3436-noprofile')).toBe('claude-sonnet-4-5');
    });
  });

  it('tags a connected Codex profile as codex-subscription without a drift warning', async () => {
    const profile = makeCodexProfile();
    setSettingsForTurn(createSettings({ activeProvider: 'codex', profile }), profile);

    await runTurn('turn-codex-profile');

    expect(registryMock.setTurnAuthMethod).toHaveBeenCalledWith('turn-codex-profile', 'codex-subscription');
    expect(driftWarningCalls()).toHaveLength(0);
  });

  it('tags connected Codex with a null working profile as codex-subscription and warns once', async () => {
    setSettingsForTurn(
      createSettings({ activeProvider: 'codex', model: 'gpt-5.5', workingProfileId: null }),
      null,
    );

    await runTurn('turn-codex-null-profile');

    expect(registryMock.setTurnAuthMethod).toHaveBeenCalledWith('turn-codex-null-profile', 'codex-subscription');
    const calls = driftWarningCallsFor(CASE_A_DRIFT_WARNING_MESSAGE);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      workingProfileId: null,
      profileId: undefined,
      profileType: undefined,
      codexConnected: true,
      activeProvider: 'codex',
      model: 'gpt-5.5',
      resolvedAuthLabel: 'codex-subscription',
      credentialSource: 'codex-subscription',
    });
    expect(calls[0][1]).toBe(CASE_A_DRIFT_WARNING_MESSAGE);
    expect(driftWarningCallsFor(CASE_B_DRIFT_WARNING_MESSAGE)).toHaveLength(0);
  });

  it('routes connected Codex with a Claude model through api-key and warns once', async () => {
    setSettingsForTurn(
      createSettings({ activeProvider: 'codex', model: 'claude-sonnet-4', workingProfileId: null }),
      null,
    );

    await runTurn('turn-codex-claude-model');

    expect(registryMock.setTurnAuthMethod).toHaveBeenCalledWith('turn-codex-claude-model', 'api-key');
    expect(registryMock.setTurnAuthMethod).not.toHaveBeenCalledWith('turn-codex-claude-model', 'codex-subscription');
    const calls = driftWarningCallsFor(CASE_B_DRIFT_WARNING_MESSAGE);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      workingProfileId: null,
      profileId: undefined,
      profileType: undefined,
      codexConnected: true,
      activeProvider: 'codex',
      model: 'claude-sonnet-4',
      resolvedAuthLabel: 'api-key',
      credentialSource: 'anthropic-api-key',
    });
    expect(driftWarningCallsFor(CASE_A_DRIFT_WARNING_MESSAGE)).toHaveLength(0);
  });

  it('preserves the local auth tag for a connected Codex turn with a local profile', async () => {
    const profile = makeLocalProfile();
    setSettingsForTurn(createSettings({ activeProvider: 'codex', profile }), profile);

    await runTurn('turn-codex-local-profile');

    expect(registryMock.setTurnAuthMethod).toHaveBeenCalledWith('turn-codex-local-profile', 'local');
    const calls = driftWarningCallsFor(CASE_B_DRIFT_WARNING_MESSAGE);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      workingProfileId: 'local-llama',
      profileId: 'local-llama',
      profileType: 'local',
      codexConnected: true,
      activeProvider: 'codex',
      model: 'llama-local',
      resolvedAuthLabel: 'local',
      credentialSource: 'local-none',
    });
  });

  it('does not tag auth when active Codex is disconnected because admission fails closed', async () => {
    const profile = makeCodexProfile();
    setSettingsForTurn(createSettings({ activeProvider: 'codex', profile }), profile);
    isCodexConnectedMock.mockReturnValue(false);
    getCodexStatusMock.mockReturnValue({ connected: false });

    await runTurn('turn-codex-disconnected');

    expect(runAgentQueryMock).not.toHaveBeenCalled();
    expect(registryMock.setTurnAuthMethod).not.toHaveBeenCalled();
    expect(factories.dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'turn-codex-disconnected',
      expect.objectContaining({
        message: expect.stringContaining('ChatGPT Pro is disconnected'),
      }),
      expect.objectContaining({
        // Codex was never connected — not-configured, never an auth rejection.
        // (The test name "does not tag auth" is now literally satisfied.)
        errorKindOverride: 'connection-not-configured',
        humanizedOverride: expect.stringContaining('ChatGPT Pro is disconnected'),
      }),
    );
  });

  it('tags Anthropic API-key turns as api-key without a drift warning', async () => {
    setSettingsForTurn(createSettings({ activeProvider: 'anthropic', model: 'claude-sonnet-4-5' }), null);

    await runTurn('turn-anthropic-api-key');

    expect(registryMock.setTurnAuthMethod).toHaveBeenCalledWith('turn-anthropic-api-key', 'api-key');
    expect(driftWarningCalls()).toHaveLength(0);
  });

  // Stage 4b (Testing MA-1): the post-turn success path must clear the per-credential
  // cooldown for the credential that just succeeded, so a credential cooled earlier in
  // the session becomes selectable again after a clean dispatch on it.
  it('clears the per-credential cooldown on a successful turn (providerRateLimitCooldowns.recordSuccess)', async () => {
    const recordSuccessSpy = vi.spyOn(providerRateLimitCooldowns, 'recordSuccess');
    setSettingsForTurn(createSettings({ activeProvider: 'anthropic', model: 'claude-sonnet-4-5' }), null);

    await runTurn('turn-record-success-seam');

    // The success path (runAgentQuery resolves with abortedByUser:false) reaches the
    // post-turn cleanup that clears the routed credential's cooldown.
    expect(recordSuccessSpy).toHaveBeenCalledWith('anthropic-api-key');
    recordSuccessSpy.mockRestore();
  });

  it('tags Anthropic active turns using a non-Anthropic OpenAI-compatible profile as profile-direct', async () => {
    const profile = makeTogetherLlamaProfile();
    setSettingsForTurn(
      createSettings({
        activeProvider: 'anthropic',
        model: profile.model,
        profile,
        workingProfileId: 'together-llama',
      }),
      profile,
    );

    await runTurn('turn-anthropic-together-profile');

    expect(registryMock.setTurnAuthMethod).toHaveBeenCalledWith(
      'turn-anthropic-together-profile',
      'profile-direct',
    );
    expect(driftWarningCalls()).toHaveLength(0);
  });

  it('tags OpenRouter turns as openrouter without a drift warning', async () => {
    setSettingsForTurn(
      createSettings({
        activeProvider: 'openrouter',
        model: 'anthropic/claude-sonnet-4-5',
        openRouterToken: 'fake-openrouter-token',
      }),
      null,
    );

    await runTurn('turn-openrouter');

    expect(registryMock.setTurnAuthMethod).toHaveBeenCalledWith('turn-openrouter', 'openrouter');
    expect(driftWarningCalls()).toHaveLength(0);
  });

  it('dedupes the Codex profile drift warning across retry attempts in the same turn', async () => {
    setSettingsForTurn(
      createSettings({ activeProvider: 'codex', model: 'gpt-5.5', workingProfileId: null }),
      null,
    );
    runAgentQueryMock
      .mockRejectedValueOnce(new Error('empty_result_anomaly'))
      .mockResolvedValueOnce({
        abortedByUser: false,
        terminatedByHandler: false,
      });

    await runTurn('turn-codex-drift-retry');

    expect(registryMock.setTurnAuthMethod).toHaveBeenCalledWith('turn-codex-drift-retry', 'codex-subscription');
    expect(registryMock.setTurnAuthMethod).toHaveBeenCalledTimes(2);
    expect(registryMock.cleanupForRetry).toHaveBeenCalledWith('turn-codex-drift-retry');
    expect(driftWarningCallsFor(CASE_A_DRIFT_WARNING_MESSAGE)).toHaveLength(1);
    expect(driftWarningCallsFor(CASE_B_DRIFT_WARNING_MESSAGE)).toHaveLength(0);
  });

  it('dedupes the Codex non-subscription drift warning across retry attempts in the same turn', async () => {
    setSettingsForTurn(
      createSettings({ activeProvider: 'codex', model: 'claude-sonnet-4', workingProfileId: null }),
      null,
    );
    runAgentQueryMock
      .mockRejectedValueOnce(new Error('empty_result_anomaly'))
      .mockResolvedValueOnce({
        abortedByUser: false,
        terminatedByHandler: false,
      });

    await runTurn('turn-codex-case-b-drift-retry');

    expect(registryMock.setTurnAuthMethod).toHaveBeenCalledWith('turn-codex-case-b-drift-retry', 'api-key');
    expect(registryMock.setTurnAuthMethod).toHaveBeenCalledTimes(2);
    expect(registryMock.cleanupForRetry).toHaveBeenCalledWith('turn-codex-case-b-drift-retry');
    expect(driftWarningCallsFor(CASE_B_DRIFT_WARNING_MESSAGE)).toHaveLength(1);
    expect(driftWarningCallsFor(CASE_A_DRIFT_WARNING_MESSAGE)).toHaveLength(0);
  });

  it('emits the drift warning with Pino object-first argument order', async () => {
    setSettingsForTurn(
      createSettings({ activeProvider: 'codex', model: 'gpt-5.5', workingProfileId: null }),
      null,
    );

    await runTurn('turn-codex-pino-order');

    const [payload, message] = driftWarningCalls()[0];
    expect(typeof payload).toBe('object');
    expect(message).toBe(CASE_A_DRIFT_WARNING_MESSAGE);
    expect(payload).toMatchObject({
      resolvedAuthLabel: 'codex-subscription',
      credentialSource: 'codex-subscription',
    });
  });

  it('drift dedup tracks Case A and Case B independently per turn (per-case dedup regression)', () => {
    // Regression for the conflated-Set bug: Case A on a prior attempt MUST NOT
    // suppress Case B on a later attempt (or vice versa) — they describe
    // distinct failure modes and operators need both signals. The legacy single
    // Set<turnId> dedup would silently suppress whichever case arrived second.
    const turnId = 'turn-percase-dedup-regression';
    expect(registryMock.hasCodexProfileDriftWarningEmitted(turnId, 'caseA')).toBe(false);
    expect(registryMock.hasCodexProfileDriftWarningEmitted(turnId, 'caseB')).toBe(false);

    registryMock.markCodexProfileDriftWarningEmitted(turnId, 'caseA');
    expect(registryMock.hasCodexProfileDriftWarningEmitted(turnId, 'caseA')).toBe(true);
    // Critical: marking Case A must NOT mark Case B.
    expect(registryMock.hasCodexProfileDriftWarningEmitted(turnId, 'caseB')).toBe(false);

    registryMock.markCodexProfileDriftWarningEmitted(turnId, 'caseB');
    expect(registryMock.hasCodexProfileDriftWarningEmitted(turnId, 'caseB')).toBe(true);
    expect(registryMock.hasCodexProfileDriftWarningEmitted(turnId, 'caseA')).toBe(true);

    // Cleanup clears both cases for that turn.
    registryMock.cleanupTurn(turnId);
    expect(registryMock.hasCodexProfileDriftWarningEmitted(turnId, 'caseA')).toBe(false);
    expect(registryMock.hasCodexProfileDriftWarningEmitted(turnId, 'caseB')).toBe(false);
  });
});
