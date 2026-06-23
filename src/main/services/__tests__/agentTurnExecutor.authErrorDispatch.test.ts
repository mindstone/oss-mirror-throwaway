import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { MockFactories } from './agentTurnExecutor.testHarness';

const { factories, hasValidAuthMock, isCodexConnectedMock, forcedTerminalInvalidReasonRef } = vi.hoisted(() => {
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

  const forcedTerminalInvalidReasonRef: {
    current: 'missing-openrouter-credentials' | 'missing-profile-credentials' | null;
  } = { current: null };

  return {
    factories,
    hasValidAuthMock: vi.fn(() => true),
    isCodexConnectedMock: vi.fn(() => false),
    forcedTerminalInvalidReasonRef,
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
 
vi.mock('@core/rebelCore/providerRouting', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/rebelCore/providerRouting')>();
  return {
    ...actual,
    resolveProviderRoutePlan: async (...args: Parameters<typeof actual.resolveProviderRoutePlan>) => {
      const forcedReason = forcedTerminalInvalidReasonRef.current;
      if (!forcedReason) {
        return actual.resolveProviderRoutePlan(...args);
      }
      if (forcedReason === 'missing-openrouter-credentials') {
        return {
          decision: {
            kind: 'terminal',
            provider: 'openrouter',
            transport: 'no-credentials',
            dispatchPath: 'none',
            modelDialect: 'openrouter-prefixed',
            role: 'execution',
            routeScope: 'normal-turn',
            routedModel: null,
            canonicalModelId: 'openai/gpt-5.5',
            wireModelId: 'openai/gpt-5.5',
            profileId: null,
            resolvedFrom: 'settings',
            codexConnectivity: 'unknown',
            fallbackHint: null,
            credentialSource: 'missing-openrouter',
            invalidReason: 'missing-openrouter-credentials',
          },
          auth: {
            kind: 'none',
            resolvedAuthLabel: 'none',
            credentialSource: 'missing-openrouter',
            credentialStatus: 'missing',
            env: [],
          },
          headers: [],
          proxyBaseURL: null,
          resolvedAuthLabel: 'none',
          proxyRequired: false,
          invalidReason: 'missing-openrouter-credentials',
        } as unknown as Awaited<ReturnType<typeof actual.resolveProviderRoutePlan>>;
      }
      return {
        decision: {
          kind: 'terminal',
          provider: 'profile',
          transport: 'no-credentials',
          dispatchPath: 'none',
          modelDialect: 'profile-ref',
          role: 'execution',
          routeScope: 'normal-turn',
          routedModel: null,
          canonicalModelId: 'openai/gpt-5.5',
          wireModelId: 'openai/gpt-5.5',
          profileId: 'profile-missing-key',
          resolvedFrom: 'working-profile',
          codexConnectivity: 'unknown',
          fallbackHint: null,
          credentialSource: 'missing-profile',
          invalidReason: 'missing-profile-credentials',
        },
        auth: {
          kind: 'none',
          resolvedAuthLabel: 'none',
          credentialSource: 'missing-profile',
          credentialStatus: 'missing',
          env: [],
        },
        headers: [],
        proxyBaseURL: null,
        resolvedAuthLabel: 'none',
        proxyRequired: false,
        invalidReason: 'missing-profile-credentials',
      } as unknown as Awaited<ReturnType<typeof actual.resolveProviderRoutePlan>>;
    },
  };
});
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

import { executeAgentTurn } from '../agentTurnExecutor';
import { getSettings } from '@core/services/settingsStore';
import { createDefaultSettings } from './agentTurnExecutor.testHarness';

const getSettingsMock = getSettings as ReturnType<typeof vi.fn>;

describe('executeAgentTurn auth dispatch', () => {
  let savedAnthropicApiKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    forcedTerminalInvalidReasonRef.current = null;
    // validateProviderCredentials checks process.env.ANTHROPIC_API_KEY as a
    // fallback — clear it so the host env doesn't leak a real key into tests.
    savedAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    hasValidAuthMock.mockReturnValue(false);
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
  });

  afterEach(() => {
    if (savedAnthropicApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedAnthropicApiKey;
    }
  });

  it('routes missing credentials through dispatchAgentErrorEvent', async () => {
    getSettingsMock.mockReturnValue({
      ...createDefaultSettings(),
      activeProvider: 'anthropic',
      models: { ...createDefaultSettings().models, apiKey: null },
    });
    await executeAgentTurn(null, 'turn-auth-missing', 'Hello', {
      sessionId: 'session-auth',
      resetConversation: false,
    });

    expect(factories.dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'turn-auth-missing',
      expect.objectContaining({
        message: 'Authentication is missing. Please add an API key in Settings.',
      }),
      // A *missing* key is not-configured, not rejected.
      { errorKindOverride: 'connection-not-configured' },
    );
    expect(factories.runAgentQueryMock).not.toHaveBeenCalled();
  });

  // Regression: REBEL-1GD — OpenRouter selected but oauthToken missing should
  // fail closed with a provider-specific error, NOT fall through to Anthropic auth.
  describe('OpenRouter provider-integrity guard', () => {
    it('dispatches provider-specific error when activeProvider is openrouter but oauthToken is missing', async () => {
      getSettingsMock.mockReturnValue({
        ...createDefaultSettings(),
        activeProvider: 'openrouter',
        openRouter: { oauthToken: null, enabled: true },
        models: { ...createDefaultSettings().models, apiKey: null },
      });
      hasValidAuthMock.mockReturnValue(false);

      await executeAgentTurn(null, 'turn-or-no-token', 'Hello', {
        sessionId: 'session-or',
        resetConversation: false,
      });

      expect(factories.dispatchAgentErrorEventMock).toHaveBeenCalledWith(
        null,
        'turn-or-no-token',
        expect.objectContaining({
          message: expect.stringContaining('OpenRouter is disconnected'),
        }),
        expect.objectContaining({
          // Never-connected provider: not-configured, not rejected.
          errorKindOverride: 'connection-not-configured',
          humanizedOverride: expect.stringContaining('OpenRouter is disconnected'),
        }),
      );
      expect(factories.runAgentQueryMock).not.toHaveBeenCalled();
    });

    it('fires BEFORE hasValidAuth — stale Anthropic key does not mask the OpenRouter disconnect', async () => {
      getSettingsMock.mockReturnValue({
        ...createDefaultSettings(),
        activeProvider: 'openrouter',
        openRouter: { oauthToken: null, enabled: true },
        models: { ...createDefaultSettings().models, apiKey: 'stale-anthropic-key' },
      });
      // hasValidAuth would return true due to the stale Anthropic key —
      // the guard must fire before it gets called.
      hasValidAuthMock.mockReturnValue(true);

      await executeAgentTurn(null, 'turn-or-stale-key', 'Hello', {
        sessionId: 'session-or-stale',
        resetConversation: false,
      });

      expect(factories.dispatchAgentErrorEventMock).toHaveBeenCalledWith(
        null,
        'turn-or-stale-key',
        expect.objectContaining({
          message: expect.stringContaining('OpenRouter is disconnected'),
        }),
        expect.objectContaining({
          // Never-connected provider: not-configured, not rejected.
          errorKindOverride: 'connection-not-configured',
          humanizedOverride: expect.stringContaining('OpenRouter is disconnected'),
        }),
      );
      expect(factories.runAgentQueryMock).not.toHaveBeenCalled();
    });
  });

  // Regression: REBEL-1H9 — Codex selected but not connected should fail closed
  // with a provider-specific error, NOT fall through to Anthropic direct using a
  // stale/placeholder claude.apiKey.
  describe('Codex provider-integrity guard', () => {
    it('dispatches provider-specific error when activeProvider is codex but Codex is disconnected', async () => {
      getSettingsMock.mockReturnValue({
        ...createDefaultSettings(),
        activeProvider: 'codex',
        models: { ...createDefaultSettings().models, apiKey: null },
      });
      isCodexConnectedMock.mockReturnValue(false);
      hasValidAuthMock.mockReturnValue(false);

      await executeAgentTurn(null, 'turn-codex-disconnected', 'Hello', {
        sessionId: 'session-codex',
        resetConversation: false,
      });

      expect(factories.dispatchAgentErrorEventMock).toHaveBeenCalledWith(
        null,
        'turn-codex-disconnected',
        expect.objectContaining({
          message: expect.stringContaining('ChatGPT Pro is disconnected'),
        }),
        expect.objectContaining({
          // Codex was never connected: not-configured, not rejected.
          errorKindOverride: 'connection-not-configured',
          humanizedOverride: expect.stringContaining('ChatGPT Pro is disconnected'),
        }),
      );
      expect(factories.runAgentQueryMock).not.toHaveBeenCalled();
    });

    it('fires BEFORE hasValidAuth — placeholder Anthropic key does not mask the Codex disconnect', async () => {
      getSettingsMock.mockReturnValue({
        ...createDefaultSettings(),
        activeProvider: 'codex',
        models: { ...createDefaultSettings().models, apiKey: 'placeholder-demo-key' },
      });
      isCodexConnectedMock.mockReturnValue(false);
      // hasValidAuth would return true due to the placeholder Anthropic key —
      // the guard must fire before it gets called.
      hasValidAuthMock.mockReturnValue(true);

      await executeAgentTurn(null, 'turn-codex-placeholder-key', 'Hello', {
        sessionId: 'session-codex-placeholder',
        resetConversation: false,
      });

      expect(factories.dispatchAgentErrorEventMock).toHaveBeenCalledWith(
        null,
        'turn-codex-placeholder-key',
        expect.objectContaining({
          message: expect.stringContaining('ChatGPT Pro is disconnected'),
        }),
        expect.objectContaining({
          // Codex was never connected: not-configured, not rejected.
          errorKindOverride: 'connection-not-configured',
          humanizedOverride: expect.stringContaining('ChatGPT Pro is disconnected'),
        }),
      );
      expect(factories.runAgentQueryMock).not.toHaveBeenCalled();
    });

    it('allows turn to proceed when Codex is connected', async () => {
      getSettingsMock.mockReturnValue({
        ...createDefaultSettings(),
        activeProvider: 'codex',
        models: { ...createDefaultSettings().models, apiKey: null },
      });
      isCodexConnectedMock.mockReturnValue(true);
      hasValidAuthMock.mockReturnValue(true);

      await executeAgentTurn(null, 'turn-codex-connected', 'Hello', {
        sessionId: 'session-codex-connected',
        resetConversation: false,
      });

      // Should NOT dispatch the Codex-disconnected error
      const errorCalls = factories.dispatchAgentErrorEventMock.mock.calls;
      const codexDisconnectError = errorCalls.find(
        (call: unknown[]) => (call[2] as Error | undefined)?.message?.includes('ChatGPT Pro is disconnected'),
      );
      expect(codexDisconnectError).toBeUndefined();
    });
  });

  describe('recoverable terminal route dispatch', () => {
    it('dispatches connection-not-configured for missing-openrouter-credentials terminal plan', async () => {
      forcedTerminalInvalidReasonRef.current = 'missing-openrouter-credentials';
      hasValidAuthMock.mockReturnValue(true);
      getSettingsMock.mockReturnValue({
        ...createDefaultSettings(),
        activeProvider: 'anthropic',
      });

      await executeAgentTurn(null, 'turn-terminal-openrouter-reconnect', 'Hello', {
        sessionId: 'session-terminal-openrouter',
        resetConversation: false,
      });

      const [win, turnId, error] = factories.dispatchAgentErrorEventMock.mock.calls.at(-1) ?? [];
      expect(win).toBeNull();
      expect(turnId).toBe('turn-terminal-openrouter-reconnect');
      expect(error).toMatchObject({
        __agentErrorKind: 'connection-not-configured',
        provider: 'OpenRouter',
        message: 'OpenRouter needs reconnecting. Sign in again in Settings to continue.',
      });
      expect(factories.runAgentQueryMock).not.toHaveBeenCalled();
    });

    it('dispatches connection-not-configured for missing-profile-credentials terminal plan', async () => {
      forcedTerminalInvalidReasonRef.current = 'missing-profile-credentials';
      hasValidAuthMock.mockReturnValue(true);
      const missingKeyProfile = {
        id: 'profile-missing-key',
        name: 'Profile missing key',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        model: 'openai/gpt-5.5',
        apiKey: null,
        createdAt: Date.now(),
      };
      getSettingsMock.mockReturnValue({
        ...createDefaultSettings(),
        localModel: {
          activeProfileId: 'profile-missing-key',
          profiles: [missingKeyProfile],
        },
      });
      factories.getWorkingModelProfileMock.mockReturnValue(missingKeyProfile);

      await executeAgentTurn(null, 'turn-terminal-profile-reconnect', 'Hello', {
        sessionId: 'session-terminal-profile',
        resetConversation: false,
      });

      const [win, turnId, error] = factories.dispatchAgentErrorEventMock.mock.calls.at(-1) ?? [];
      expect(win).toBeNull();
      expect(turnId).toBe('turn-terminal-profile-reconnect');
      expect(error).toMatchObject({
        __agentErrorKind: 'connection-not-configured',
        provider: 'Profile',
        message: 'This profile is missing a working API key. Add or update it in Settings to continue.',
      });
      expect(factories.runAgentQueryMock).not.toHaveBeenCalled();
    });
  });
});
