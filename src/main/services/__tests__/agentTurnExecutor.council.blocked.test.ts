import {
  createAgentEventDispatcherMock,
  createLoggerMock,
  createSettingsStoreMock,
  createAgentTurnRegistryMock,
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
  createModelNormalizationMock,
  createSettingsUtilsMock,
  createSemanticContextServiceMock,
  createConversationContextServiceMock,
  createConversationHistoryServiceMock,
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
  createDefaultSettings,
  successIterator,
} from './agentTurnExecutor.testHarness';
import type { MockFactories } from './agentTurnExecutor.testHarness';
import { COUNCIL_BLOCKED_AUTH_COPY } from '@shared/utils/councilProfiles';

const {
  factories,
  hasValidAuthMock,
  isCodexConnectedMock,
  getCachedAuthConfigMock,
} = vi.hoisted(() => {
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

  const factories: MockFactories = {
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

  return {
    factories,
    hasValidAuthMock: vi.fn(() => true),
    isCodexConnectedMock: vi.fn(() => false),
    getCachedAuthConfigMock: vi.fn(
      (): { managedProvider?: { defaultModels?: { working?: string; thinking?: string; bts?: string } } } | null => null,
    ),
  };
});

vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: vi.fn(() => ({
    isConnected: isCodexConnectedMock,
    getAccessToken: vi.fn(async () => null),
    getAccountId: vi.fn(() => null),
    forceRefreshToken: vi.fn(async () => null),
    getStatus: vi.fn(() => 'disconnected'),
  })),
  CODEX_ENDPOINT_URL: 'https://chatgpt.com/backend-api/codex',
}));
vi.mock('../agentQueryRunner', () => ({ runAgentQuery: factories.runAgentQueryMock }));
vi.mock('@core/rebelCore/queryRouter', () => ({ queryWithRuntime: vi.fn() }));
vi.mock('../agentEventDispatcher', () => createAgentEventDispatcherMock(factories));
vi.mock('@core/logger', () => createLoggerMock(factories));
vi.mock('@core/services/settingsStore', () => createSettingsStoreMock());
vi.mock('../agentTurnRegistry', () => createAgentTurnRegistryMock(factories));
vi.mock('../localModelProxyServer', () => createLocalModelProxyServerMock(factories));
vi.mock('../superMcpHttpManager', () => ({ superMcpHttpManager: { getState: factories.superMcpGetStateMock } }));
vi.mock('../adHocAgentService', () => createAdHocAgentServiceMock(factories));
vi.mock('../claudeMentionAgentService', () => createClaudeMentionAgentServiceMock(factories));
vi.mock('../councilService', () => createCouncilServiceMock(factories));
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
vi.mock('../../utils/authEnvUtils', () => ({
  getAuthEnvVars: factories.getAuthEnvVarsMock,
  hasValidAuth: hasValidAuthMock,
  isUsingOAuth: vi.fn(() => false),
  isUsingOpenRouter: vi.fn(() => false),
  getApiKeyAuthEnvVars: vi.fn(() => null),
  getProviderKeyEnvVars: vi.fn(() => null),
}));
vi.mock('@shared/utils/modelNormalization', () => createModelNormalizationMock(factories));
vi.mock('@shared/utils/settingsUtils', () => createSettingsUtilsMock(factories));
vi.mock('@shared/types', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@shared/types');
  return { ...actual, getWorkingModelProfile: factories.getWorkingModelProfileMock };
});
vi.mock('../semanticContextService', () => createSemanticContextServiceMock());
vi.mock('../conversationContextService', () => createConversationContextServiceMock());
vi.mock('../conversationHistoryService', () => createConversationHistoryServiceMock());
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
vi.mock('../openRouterTokenStorage', () => ({
  hasManagedOpenRouterKey: vi.fn(() => true),
}));
vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
      onAuthStateChange: vi.fn(() => () => {}),
      getAccessToken: vi.fn(async () => null),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      refreshLicenseTier: vi.fn(async () => 'free'),
      clearCachedProviderKey: vi.fn(),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      getCachedAuthConfig: getCachedAuthConfigMock,
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

import { executeAgentTurn } from '../agentTurnExecutor';
import { getSettings } from '@core/services/settingsStore';
import * as turnCleanup from '../agentTurnCleanup';

const getSettingsMock = getSettings as ReturnType<typeof vi.fn>;
const runAgentQueryMock = factories.runAgentQueryMock as NonNullable<MockFactories['runAgentQueryMock']>;

describe('executeAgentTurn council blocking', () => {
  let savedAnthropicApiKey: string | undefined;
  let cleanupSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    savedAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    cleanupSpy = vi.spyOn(turnCleanup, 'completeTurnCleanup');
    hasValidAuthMock.mockReturnValue(true);
    getCachedAuthConfigMock.mockReturnValue(null);

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
    factories.getThinkingProfileMock.mockReturnValue(null);
    factories.getWorkingProfileMock.mockReturnValue(null);
    factories.getWorkingModelProfileMock.mockReturnValue(null);
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
    factories.superMcpGetStateMock?.mockReturnValue({ isRunning: false, url: '' });
    runAgentQueryMock.mockResolvedValue(successIterator());
  });

  afterEach(() => {
    cleanupSpy.mockRestore();
    if (savedAnthropicApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedAnthropicApiKey;
    }
  });

  it('blocks council turn when managed allow-list removes all members', async () => {
    getCachedAuthConfigMock.mockReturnValue({
      managedProvider: { defaultModels: {} },
    });
    getSettingsMock.mockReturnValue({
      ...createDefaultSettings(),
      activeProvider: 'mindstone',
      localModel: {
        profiles: [
          {
            id: 'council-or',
            name: 'Council OR',
            serverUrl: 'https://openrouter.ai/api/v1',
            providerType: 'openrouter',
            model: 'openai/gpt-5.5',
            createdAt: 1,
            councilEnabled: true,
            enabled: true,
          },
        ],
        activeProfileId: null,
      },
    });

    await executeAgentTurn(null, 'turn-council-blocked', 'Hello', {
      sessionId: 'session-council-blocked',
      resetConversation: false,
      councilMode: true,
    });

    expect(factories.dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'turn-council-blocked',
      expect.objectContaining({ message: COUNCIL_BLOCKED_AUTH_COPY }),
      {
        errorKindOverride: 'auth',
        humanizedOverride: COUNCIL_BLOCKED_AUTH_COPY,
      },
    );
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    // The executor threads a per-attempt epoch (rework-F3) as the 3rd arg.
    expect(cleanupSpy).toHaveBeenCalledWith('turn-council-blocked', 'council_blocked', expect.any(Number));
    expect(factories.buildCouncilConfigMock).not.toHaveBeenCalled();
    expect(runAgentQueryMock).not.toHaveBeenCalled();
  });

  it('passes only eligible managed survivors to buildCouncilConfig', async () => {
    getCachedAuthConfigMock.mockReturnValue({
      managedProvider: {
        defaultModels: { working: 'openai/gpt-5.5' },
      },
    });
    getSettingsMock.mockReturnValue({
      ...createDefaultSettings(),
      activeProvider: 'mindstone',
      localModel: {
        profiles: [
          {
            id: 'council-allowed',
            name: 'Council Allowed',
            serverUrl: 'https://openrouter.ai/api/v1',
            providerType: 'openrouter',
            model: 'openai/gpt-5.5',
            createdAt: 1,
            councilEnabled: true,
            enabled: true,
          },
          {
            id: 'council-filtered',
            name: 'Council Filtered',
            serverUrl: 'https://openrouter.ai/api/v1',
            providerType: 'openrouter',
            model: 'openai/gpt-5.9',
            createdAt: 2,
            councilEnabled: true,
            enabled: true,
          },
        ],
        activeProfileId: null,
      },
    });

    await executeAgentTurn(null, 'turn-council-filtered', 'Hello', {
      sessionId: 'session-council-filtered',
      resetConversation: false,
      councilMode: true,
    });

    expect(factories.buildCouncilConfigMock).toHaveBeenCalledTimes(1);
    const call = factories.buildCouncilConfigMock.mock.calls[0];
    const councilSettings = call?.[0] as { localModel?: { profiles?: Array<{ id: string; model: string }> } } | undefined;
    expect(councilSettings?.localModel?.profiles).toEqual([
      expect.objectContaining({
        id: 'council-allowed',
        model: 'openai/gpt-5.5',
      }),
    ]);
  });
});
