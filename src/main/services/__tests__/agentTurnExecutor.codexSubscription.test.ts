 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { classifyErrorUx } from '../../../../packages/shared/src/utils/classifyErrorUx';
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
} from './agentTurnExecutor.testHarness';
import type { AgentQueryConfig } from '../agentQueryRunner';
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

const agentTurnRegistryModule = vi.hoisted(() => ({
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
    cleanupTurn: vi.fn(),
    setTurnPrompt: vi.fn(),
    getTurnPrompt: vi.fn(() => undefined),
    setTurnExtendedContext: vi.fn(),
    setTurnThinkingEffort: vi.fn(),
    setTurnAuthMethod: vi.fn(),
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
    getRetryCount: vi.fn(() => 0),
    incrementRetryCount: vi.fn(() => 1),
    deleteRetryCount: vi.fn(),
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
    hasOutputCapRetryAttempted: vi.fn(() => false),
    markOutputCapRetryAttempted: vi.fn(),
    clearOutputCapRetryAttempts: vi.fn(),
    recordSessionTurn: vi.fn(),
    hasSessionHadTurns: vi.fn(() => false),
    hasUserQuestionPending: vi.fn(() => false),
  },
  cleanupTurnAggregator: vi.fn(),
  cleanupPendingApprovals: vi.fn(),
}));

vi.mock('../agentQueryRunner', () => ({ runAgentQuery: factories.runAgentQueryMock }));
vi.mock('@core/rebelCore/queryRouter', () => ({ queryWithRuntime: vi.fn() }));
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

const runAgentQueryMock = factories.runAgentQueryMock!;
const superMcpGetStateMock = factories.superMcpGetStateMock!;

function createSettings(profile: ModelProfile): AppSettings {
  return {
    coreDirectory: process.cwd(),
    mcpConfigFile: null,
    onboardingCompleted: false,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    activeProvider: 'anthropic',
    models: {
      model: 'claude-sonnet-4-5',
      workingProfileId: profile.id,
      thinkingModel: undefined,
      oauthToken: null,
      authMethod: 'api-key',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: false,
      thinkingEffort: 'medium',
      apiKey: 'fake-ant-test',
      longContextFallbackModel: undefined,
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
    localModel: { profiles: [profile], activeProfileId: null },
  };
}

function makeCodexProfile(): ModelProfile {
  return {
    id: 'codex-gpt-5.5',
    name: 'GPT-5.5 (ChatGPT Pro)',
    authSource: 'codex-subscription',
    model: 'gpt-5.5',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    createdAt: 0,
  };
}

function makeUnsupportedCodexProfile(): ModelProfile {
  return {
    ...makeCodexProfile(),
    id: 'codex-gpt-5.5-pro',
    name: 'GPT-5.5 Pro (ChatGPT Pro)',
    model: 'gpt-5.5-pro',
  };
}

describe('executeAgentTurn codex subscription routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const codexProfile = makeCodexProfile();
    getSettingsMock.mockReturnValue(createSettings(codexProfile));
    isCodexConnectedMock.mockReturnValueOnce(true).mockReturnValue(false);

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
    factories.getThinkingProfileMock.mockReturnValue(null);
    factories.getWorkingProfileMock.mockReturnValue(codexProfile);
    factories.getWorkingModelProfileMock.mockReturnValue(codexProfile);
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

  function setCodexActiveWithoutConnection() {
    const codexProfile = makeCodexProfile();
    const settings = createSettings(codexProfile);
    settings.activeProvider = 'codex';
    getSettingsMock.mockReturnValue(settings);
    factories.getWorkingProfileMock.mockReturnValue(codexProfile);
    factories.getWorkingModelProfileMock.mockReturnValue(codexProfile);
    isCodexConnectedMock.mockReset();
    isCodexConnectedMock.mockReturnValue(false);
  }

  function setCodexActiveWithUnsupportedModel() {
    const unsupportedProfile = makeUnsupportedCodexProfile();
    const settings = createSettings(unsupportedProfile);
    settings.activeProvider = 'codex';
    getSettingsMock.mockReturnValue(settings);
    factories.getWorkingProfileMock.mockReturnValue(unsupportedProfile);
    factories.getWorkingModelProfileMock.mockReturnValue(unsupportedProfile);
    isCodexConnectedMock.mockReset();
    isCodexConnectedMock.mockReturnValue(true);
  }

  it('captures Codex connectivity at turn start and keeps codexMode available for codex-tagged profiles with shared OpenAI keys', async () => {
    await executeAgentTurn(null, 'turn-codex-routing', 'Hello', {
      sessionId: 'renderer-session-codex',
      resetConversation: false,
    });

    expect(runAgentQueryMock).toHaveBeenCalled();
    const config = runAgentQueryMock.mock.calls[0][0] as AgentQueryConfig;
    const routerContext = config.routerContext;
    const codexMode = routerContext?.codexMode;

    expect(codexMode).toBeDefined();
    await expect(codexMode!.getAccessToken()).resolves.toBe('codex-token');
    expect(agentTurnRegistryModule.agentTurnRegistry.setTurnAuthMethod).toHaveBeenCalledWith(
      'turn-codex-routing',
      'codex-subscription',
    );
  });

  // REBEL-1H9: Codex disconnected now fails closed (symmetric with OpenRouter guard)
  // instead of falling through to Anthropic direct with a stale/placeholder key.
  it('fails closed with provider-specific error when Codex is active but disconnected', async () => {
    setCodexActiveWithoutConnection();

    await executeAgentTurn(null, 'turn-codex-disconnected-routing', 'Hello', {
      sessionId: 'renderer-session-codex-disconnected-routing',
      resetConversation: false,
    });

    // Turn should NOT reach runAgentQuery — blocked by fail-closed guard
    expect(runAgentQueryMock).not.toHaveBeenCalled();
    expect(factories.addRoutesMock).not.toHaveBeenCalled();
    expect(factories.dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'turn-codex-disconnected-routing',
      expect.objectContaining({
        message: expect.stringContaining('ChatGPT Pro is disconnected'),
      }),
      expect.objectContaining({
        // Codex was never connected — not-configured, not a credential rejection.
        errorKindOverride: 'connection-not-configured',
        humanizedOverride: expect.stringContaining('ChatGPT Pro is disconnected'),
      }),
    );
  });

  it('fails closed with unsupported_model resolution when Codex cannot run the selected model', async () => {
    setCodexActiveWithUnsupportedModel();
    const dispatchedEvents: Array<{
      errorKind?: string;
      resolution?: ReturnType<typeof classifyErrorUx>;
    }> = [];
    factories.dispatchAgentErrorEventMock.mockImplementation((_win, _turnId, rawError) => {
      const error = rawError as {
        __agentErrorKind: 'unsupported_model';
        message: string;
        provider?: string;
        wireModel: string;
      };
      const errorKind = error.__agentErrorKind;
      const resolution = classifyErrorUx({
        errorKind,
        rawMessage: error.message,
        provider: error.provider,
        settingsContext: {
          activeProvider: 'codex',
          currentModel: error.wireModel,
          hasAnthropicCredentials: true,
          hasOpenRouterCredentials: false,
          hasCodexSubscription: true,
        },
        unsupportedModelId: error.wireModel,
      });
      dispatchedEvents.push({ errorKind, resolution });
      return { ok: true, dispatchedErrorKind: errorKind };
    });

    await executeAgentTurn(null, 'turn-codex-unsupported-model', 'Hello', {
      sessionId: 'renderer-session-codex-unsupported-model',
      resetConversation: false,
    });

    expect(runAgentQueryMock).not.toHaveBeenCalled();
    const rawError = factories.dispatchAgentErrorEventMock.mock.calls[0]?.[2];
    expect(rawError).toMatchObject({
      name: 'UnsupportedModelError',
      __agentErrorKind: 'unsupported_model',
      wireModel: 'gpt-5.5-pro',
      provider: 'ChatGPT Pro',
    });
    expect(dispatchedEvents[0]?.errorKind).toBe('unsupported_model');
    expect(dispatchedEvents[0]?.resolution).toMatchObject({
      category: 'unsupported-feature',
      alternatives: [
        {
          label: 'Use GPT-5.5',
          action: 'switch-model',
          payload: { model: 'gpt-5.5' },
        },
        {
          label: 'Open settings',
          action: 'open-settings',
          payload: { settingsSection: 'providerKeys' },
        },
      ],
    });
  });
});
