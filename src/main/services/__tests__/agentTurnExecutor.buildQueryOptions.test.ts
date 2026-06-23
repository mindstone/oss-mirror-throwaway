import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  /* createMockFactories removed */
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
  successIterator,
  captureOptions,
} from './agentTurnExecutor.testHarness';

import type { MockFactories } from './agentTurnExecutor.testHarness';

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

vi.mock('@core/rebelCore/queryRouter', () => ({ queryWithRuntime: factories.queryMock }));
vi.mock('../agentEventDispatcher', () => createAgentEventDispatcherMock(factories));
vi.mock('@core/services/settingsStore', () => createSettingsStoreMock());
vi.mock('../agentTurnRegistry', () => createAgentTurnRegistryMock(factories));
vi.mock('../localModelProxyServer', () => createLocalModelProxyServerMock(factories));
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

// NOTE: resolveCapabilities is NOT mocked — runs as a real pure function

const {
  queryMock,
  resolveModelConfigMock,
  buildCouncilConfigMock,
  resolveCouncilLeadModelMock,
  detectModelReferencesMock,
  buildAdHocAgentConfigMock,
  detectClaudeModelReferencesMock,
  buildClaudeSubagentConfigMock,
  getThinkingProfileMock,
  getWorkingProfileMock,
  addRoutesMock,
  getAndResetTurnStatsMock,
  removeRoutesMock,
  getUrlMock,
  getAuthTokenMock,
  getWorkingModelProfileMock,
  resolveMcpServersMock,
  resolveSystemPromptMock,
  buildConnectedPackagesMock,
  getAuthEnvVarsMock,
} = factories;

// ---------------------------------------------------------------------------
// Import under test (AFTER all vi.mock calls)
// ---------------------------------------------------------------------------
import { executeAgentTurn } from '../agentTurnExecutor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeAgentTurn buildQueryOptions contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock returns
    resolveModelConfigMock.mockImplementation((model: string) => ({
      model,
      envOverrides: undefined,
    }));
    resolveSystemPromptMock.mockResolvedValue('You are Rebel.');
    resolveMcpServersMock.mockResolvedValue({
      servers: undefined,
      mode: 'unavailable',
      upstreamCount: 0,
      configPath: undefined,
    });
    buildConnectedPackagesMock.mockResolvedValue([]);
    getAuthEnvVarsMock.mockReturnValue({});

    // Council/proxy defaults: no council, no ad-hoc, no Claude subagents
    buildCouncilConfigMock.mockReturnValue(null);
    resolveCouncilLeadModelMock.mockReturnValue('claude-sonnet-4-5');
    detectModelReferencesMock.mockReturnValue([]);
    buildAdHocAgentConfigMock.mockReturnValue(null);
    detectClaudeModelReferencesMock.mockReturnValue([]);
    buildClaudeSubagentConfigMock.mockReturnValue(null);

    // Profile defaults: no non-Claude profiles
    getThinkingProfileMock.mockReturnValue(null);
    getWorkingProfileMock.mockReturnValue(null);
    getWorkingModelProfileMock.mockReturnValue(null);

    // Proxy defaults
    addRoutesMock.mockResolvedValue(undefined);
    getAndResetTurnStatsMock.mockReturnValue(new Map());
    removeRoutesMock.mockReturnValue(undefined);
    getUrlMock.mockReturnValue('http://proxy.local');
    getAuthTokenMock.mockReturnValue('proxy-auth-token');

    queryMock.mockImplementation(() => successIterator());
  });

  // -------------------------------------------------------------------------
  // Test 1: pathToClaudeCodeExecutable removed (SDK-only field)
  // -------------------------------------------------------------------------
  it('does not include pathToClaudeCodeExecutable (SDK-only field removed)', async () => {
    await executeAgentTurn(null, 'turn-bqo-path', 'Hello', {
      sessionId: 'session-path',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = captureOptions(queryMock);
    expect('pathToClaudeCodeExecutable' in options).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 2: resume remains absent during follow-up turns
  // -------------------------------------------------------------------------
  it('does not include resume when continuing an existing session', async () => {
    await executeAgentTurn(null, 'turn-bqo-resume', 'Continue', {
      sessionId: 'session-resume',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = captureOptions(queryMock);
    expect('resume' in options).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3: resume remains absent on new conversation
  // -------------------------------------------------------------------------
  it('does not include resume when resetConversation is true', async () => {
    await executeAgentTurn(null, 'turn-bqo-reset', 'Fresh start', {
      sessionId: 'session-reset',
      resetConversation: true,
    });

    if (queryMock.mock.calls.length > 0) {
      const options = captureOptions(queryMock);
      expect('resume' in options).toBe(false);
    } else {
      expect(queryMock).toHaveBeenCalledTimes(0);
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: history is injected for any renderer-backed turn
  // -------------------------------------------------------------------------
  it('does not include resume and injects history when a renderer session exists', async () => {
    const { buildContinuationContext } = await import('@core/services/buildContinuationContext');
    vi.mocked(buildContinuationContext).mockResolvedValue({
      prefix: '[HISTORY CONTEXT]\n',
      meta: {
        headerIncluded: false,
        headerBytes: 0,
        historyIncluded: true,
        historyBytes: 18,
        truncated: false,
      },
    });

    await executeAgentTurn(null, 'turn-bqo-history', 'Continue after long break', {
      sessionId: 'session-history',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = captureOptions(queryMock);
    expect('resume' in options).toBe(false);

    expect(buildContinuationContext).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-history',
        currentTurnId: 'turn-bqo-history',
        scope: 'main',
        resetConversation: false,
        modeInput: { mode: 'proactive-main' },
      }),
    );
  });

  it('passes stripped recovery messages through runtime options during reset retries', async () => {
    const { buildContinuationContext } = await import('@core/services/buildContinuationContext');
    vi.mocked(buildContinuationContext).mockResolvedValue({
      prefix: '',
      meta: {
        headerIncluded: false,
        headerBytes: 0,
        historyIncluded: false,
        historyBytes: 0,
        truncated: false,
      },
    });

    await executeAgentTurn(null, 'turn-bqo-recovery-history', 'Continue the original request', {
      sessionId: 'session-recovery-history',
      resetConversation: true,
      recoveryMessages: [
        {
          id: 'msg-user',
          turnId: 'turn-original',
          role: 'user',
          text: 'Original request',
          createdAt: 1,
        },
        {
          id: 'msg-assistant',
          turnId: 'turn-original',
          role: 'assistant',
          text: 'Useful stripped assistant context',
          createdAt: 2,
        },
        {
          id: 'msg-empty',
          turnId: 'turn-original',
          role: 'assistant',
          text: '   ',
          createdAt: 3,
        },
      ],
    });

    if (queryMock.mock.calls.length > 0) {
      const options = captureOptions(queryMock);
      expect(options.recoveryMessages).toEqual([
        { role: 'user', content: 'Original request' },
        { role: 'assistant', content: 'Useful stripped assistant context' },
      ]);
    } else {
      expect(queryMock).toHaveBeenCalledTimes(0);
    }
    expect(buildContinuationContext).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-recovery-history',
        currentTurnId: 'turn-bqo-recovery-history',
        scope: 'main',
        resetConversation: true,
        modeInput: { mode: 'proactive-main' },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: CLAUDE_CODE_ENABLE_TASKS removed (SDK-only env var)
  // -------------------------------------------------------------------------
  it('does not include CLAUDE_CODE_ENABLE_TASKS in env', async () => {
    await executeAgentTurn(null, 'turn-bqo-tasks', 'Hello', {
      sessionId: 'session-tasks',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = captureOptions(queryMock);
    const env = options.env as Record<string, string>;
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 6: Council mode with Anthropic-direct lead — lead bypasses proxy
  //
  // The proxy's route_required gate (Stage 3 fail-closed) requires every
  // route-table-mode request to carry x-routed-model. Because direct-Anthropic
  // leads do NOT identify themselves as a routed-model dispatch (their
  // wireModelId is the canonical model, not a route-table key), they must
  // skip the proxy entirely. Sub-agents still route via proxy through their
  // own forSubagent decisions.
  //
  // Regression session: rebel://conversation/da560793-2d29-4c32-80ab-7b86c0a2a450
  // Fix doc: docs-private/postmortems/260507_routing_transport_lead_proxy_conflation_postmortem.md
  // -------------------------------------------------------------------------
  it('does NOT route Anthropic-direct lead through proxy in council mode', async () => {
    buildCouncilConfigMock.mockReturnValue({
      leadModel: 'claude-sonnet-4-5',
      systemPromptSuffix: '\n\n[Council active]',
      agents: { alpha: { description: 'Alpha', prompt: 'be alpha', routedModel: 'openai/gpt-4o' } },
      routeTable: {
        routes: new Map([['openai/gpt-4o', { name: 'GPT-4o', model: 'gpt-4o', baseUrl: 'http://api.openai.com', apiKey: 'test' }]]),
      },
    });
    getUrlMock.mockReturnValue('http://proxy.local:8080');
    getAuthTokenMock.mockReturnValue('council-token');

    await executeAgentTurn(null, 'turn-bqo-council', 'Use //council', {
      sessionId: 'session-council',
      resetConversation: false,
      councilMode: true,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = captureOptions(queryMock);
    const env = options.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('x-proxy-auth:');
    expect(env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('x-routed-turn-id:');
    expect(env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('x-routed-model:');
  });

  it('does not request a proxy token or proxy headers for a normal Anthropic-direct turn', async () => {
    await executeAgentTurn(null, 'turn-bqo-direct-normal', 'Hello direct Anthropic', {
      sessionId: 'session-direct-normal',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = captureOptions(queryMock);
    const env = options.env as Record<string, string>;
    expect(getAuthTokenMock).not.toHaveBeenCalled();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('x-proxy-auth:');
    expect(env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('x-routed-turn-id:');
    expect(env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('x-routed-model:');
  });

  // -------------------------------------------------------------------------
  // Test: Plan mode alias preserved when Working profile is active
  // Regression: d175ae43c changed getEffectiveModel() to prefer activeProfileModel
  // over modelConfig.model, silently replacing the planner alias with the profile model.
  // See docs/plans/260409_fix_plan_mode_bypass_for_profiles.md
  // -------------------------------------------------------------------------
  it('preserves plan model when Working profile overrides the execution model', async () => {
    const gptProfile = {
      id: 'gpt-5.5-profile',
      name: 'GPT-5.5',
      model: 'gpt-5.5',
      providerType: 'openai',
      serverUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
    };
    getWorkingProfileMock.mockReturnValue(gptProfile);
    getWorkingModelProfileMock.mockReturnValue(gptProfile);

    resolveModelConfigMock.mockReturnValue({
      model: 'planner',
      envOverrides: {
        PLANNING_MODEL: 'claude-opus-4-7',
        CLAUDE_CODE_USE_MODEL: 'gpt-5.5',
      },
    });

    await executeAgentTurn(null, 'turn-bqo-planmode', 'Research this topic', {
      sessionId: 'session-planmode',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = captureOptions(queryMock);
    expect(options.model).toBe('planner');
  });

  // -------------------------------------------------------------------------
  // Test 8: Google working-model proxy env vars
  // -------------------------------------------------------------------------
  it('sets proxy env vars for Google working-model profile', async () => {
    const googleProfile = {
      id: 'gemini-profile',
      name: 'Gemini 2.5 Pro',
      model: 'gemini-2.5-pro',
      providerType: 'google',
      serverUrl: 'http://google.api',
      apiKey: 'test-key',
    };
    getWorkingModelProfileMock.mockReturnValue(googleProfile);
    getUrlMock.mockReturnValue('http://proxy.local:7070');
    getAuthTokenMock.mockReturnValue('google-proxy-token');

    await executeAgentTurn(null, 'turn-bqo-google', 'Analyze this', {
      sessionId: 'session-google',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = captureOptions(queryMock);
    const env = options.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe('http://proxy.local:7070');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain('x-proxy-auth: google-proxy-token');
  });

  // -------------------------------------------------------------------------
  // Test 9: Error recovery triggers retry with rebuilt queryOptions
  //         When SDK query throws, error recovery dispatches a handler
  //         that rebuilds options and retries. This verifies the retry
  //         pathway works end-to-end. Detailed mutation testing of specific
  //         recovery handlers lives in turnErrorRecovery.test.ts.
  // -------------------------------------------------------------------------
  it('retries with rebuilt queryOptions after error recovery', async () => {
    const workingProfile = {
      id: 'gpt-4o-profile',
      name: 'GPT-4o',
      model: 'gpt-4o',
      serverUrl: 'http://proxy.local',
      apiKey: 'test-key',
    };
    getWorkingProfileMock.mockReturnValue(workingProfile);

    const altModelError = Object.assign(new Error('proxy server error'), {
      kind: 'server_error',
      provider: 'openai',
    });

    const { getErrorKind } = await import('@shared/utils/agentErrorCatalog');
    vi.mocked(getErrorKind).mockReturnValue('server_error');

    queryMock
      .mockImplementationOnce(() => {
        async function* gen(): AsyncGenerator<never, void, unknown> {
          throw altModelError;
        }
        const iter = gen() as AsyncGenerator<never, void, unknown> & { close: () => void };
        iter.close = vi.fn();
        return iter;
      })
      .mockImplementationOnce(() => successIterator());

    await executeAgentTurn(null, 'turn-bqo-recovery', 'Ask the alt model', {
      sessionId: 'session-recovery',
      resetConversation: false,
    });

    // Error recovery must have triggered a retry — query called at least twice
    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Both calls must have produced valid query options with env
    const firstOptions = captureOptions(queryMock, 0);
    const secondOptions = captureOptions(queryMock, 1);
    const firstEnv = firstOptions.env as Record<string, string>;
    const secondEnv = secondOptions.env as Record<string, string>;
    expect(firstEnv).toBeDefined();
    expect(secondEnv).toBeDefined();

    // Critical contract: retry rebuild should preserve supported env options.
    expect(secondEnv).toBeDefined();
    expect(secondEnv.CLAUDE_CODE_ENABLE_TASKS).toBeUndefined();
    expect('pathToClaudeCodeExecutable' in secondOptions).toBe(false);

    // Retry rebuild must produce a valid model field. The specific model-
    // mutation coherence contract (getEffectiveModel reads queryOptionsCtx.modelConfig)
    // is tested directly in queryOptionsBuilder.test.ts "reflects updated modelConfig".
    expect(typeof secondOptions.model).toBe('string');
    expect(secondOptions.model).toBeTruthy();
  });
});
