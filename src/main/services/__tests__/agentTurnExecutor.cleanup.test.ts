import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBuildContinuationContextMock,
  createModelNormalizationMock,
} from './agentTurnExecutor.testHarness';

const {
  queryMock,
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  rootLoggerMock,
  mockTurnLogger,
  resolveModelConfigMock,
  getErrorKindMock,
  getRetryCountMock,
  buildCouncilConfigMock,
  resolveCouncilLeadModelMock,
  detectModelReferencesMock,
  buildAdHocAgentConfigMock,
  detectClaudeModelReferencesMock,
  buildClaudeSubagentConfigMock,
  getWorkingProfileMock,
  addRoutesMock,
  getAndResetTurnStatsMock,
  removeRoutesMock,
  getUrlMock,
  getAuthTokenMock,
  cleanupTurnAggregatorMock,
  cleanupTurnMock,
  deleteTurnLoggerMock,
  deleteContextAccumulatorMock,
  getTurnLoggerMock,
  getRendererSessionMock,
  appendCostEntryMock,
  calculateModelCostMock,
  captureExceptionMock,
} = vi.hoisted(() => {
  const queryMock = vi.fn();
  const dispatchAgentEventMock = vi.fn();
  const dispatchAgentErrorEventMock = vi.fn((
    win: unknown,
    turnId: string,
    rawError: unknown,
    opts?: {
      humanizedOverride?: string;
      isTransient?: boolean;
      errorKindOverride?: string;
      providerOverride?: string;
      markActionable?: boolean;
      timeoutDiagnostic?: unknown;
      watchdogDiagnostic?: unknown;
      rateLimitMetaOverride?: unknown;
      timestampOverride?: number;
    },
  ) => {
    const providerFromRawError =
      typeof rawError === 'object' && rawError !== null && typeof (rawError as { provider?: unknown }).provider === 'string'
        ? (rawError as { provider: string }).provider
        : undefined;

    dispatchAgentEventMock(win, turnId, {
      type: 'error',
      error: opts?.humanizedOverride ?? (rawError instanceof Error ? rawError.message : String(rawError)),
      ...(opts?.isTransient !== undefined ? { isTransient: opts.isTransient } : {}),
      ...(opts?.errorKindOverride ? { errorKind: opts.errorKindOverride } : {}),
      ...((opts?.providerOverride ?? providerFromRawError) ? { provider: opts?.providerOverride ?? providerFromRawError } : {}),
      ...(opts?.timeoutDiagnostic ? { timeoutDiagnostic: opts.timeoutDiagnostic } : {}),
      ...(opts?.watchdogDiagnostic ? { watchdogDiagnostic: opts.watchdogDiagnostic } : {}),
      ...(opts?.errorKindOverride === 'rate_limit' && opts?.rateLimitMetaOverride ? { rateLimitMeta: opts.rateLimitMetaOverride } : {}),
      errorSource: 'main',
      timestamp: opts?.timestampOverride ?? Date.now(),
    });
    return { ok: true as const };
  });
  const rootLoggerMock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const captureExceptionMock = vi.fn();
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
    queryMock,
    dispatchAgentEventMock,
    dispatchAgentErrorEventMock,
    rootLoggerMock,
    mockTurnLogger,
    resolveModelConfigMock: vi.fn(),
    getErrorKindMock: vi.fn(),
    getRetryCountMock: vi.fn(),
    buildCouncilConfigMock: vi.fn(),
    resolveCouncilLeadModelMock: vi.fn(),
    detectModelReferencesMock: vi.fn(),
    buildAdHocAgentConfigMock: vi.fn(),
    detectClaudeModelReferencesMock: vi.fn(),
    buildClaudeSubagentConfigMock: vi.fn(),
    getWorkingProfileMock: vi.fn(),
    addRoutesMock: vi.fn(),
    getAndResetTurnStatsMock: vi.fn(),
    removeRoutesMock: vi.fn(),
    getUrlMock: vi.fn(),
    getAuthTokenMock: vi.fn(),
    cleanupTurnAggregatorMock: vi.fn(),
    cleanupTurnMock: vi.fn(),
    deleteTurnLoggerMock: vi.fn(),
    deleteContextAccumulatorMock: vi.fn(),
    getTurnLoggerMock: vi.fn(() => mockTurnLogger),
    getRendererSessionMock: vi.fn(() => 'renderer-session-cleanup'),
    appendCostEntryMock: vi.fn((_entry: unknown) => ({ costEntryId: 'test-cost-entry-id-executor-cleanup' })),
    calculateModelCostMock: vi.fn(),
    captureExceptionMock,
  };
});

vi.mock('@core/rebelCore/queryRouter', () => ({
  queryWithRuntime: queryMock,
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
}));

vi.mock('@core/logger', () => ({
  logger: rootLoggerMock,
  createTurnSessionLogger: vi.fn(() => mockTurnLogger),
  createScopedLogger: vi.fn(() => mockTurnLogger),
  runWithTurnContext: vi.fn(async (_ctx: unknown, fn: () => Promise<void>) => fn()),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn(() => ({
    coreDirectory: process.cwd(),
    models: {
      model: 'claude-sonnet-4-5',
      thinkingModel: null,
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: false,
      thinkingEffort: 'medium',
      apiKey: 'test-key',
      longContextFallbackModel: null,
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'whisper-1',
      ttsVoice: null,
      activationHotkey: 'Alt+Space',
      activationHotkeyVoiceMode: 'Alt+Space',
    },
    localModel: { profiles: [], activeProfileId: null },
  })),
  updateSettings: vi.fn(),
  updateSettingsAtomic: vi.fn(),
  onSettingsChange: vi.fn(() => () => undefined),
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    setActiveTurnController: vi.fn(),
    setRendererSession: vi.fn(),
    getRendererSession: getRendererSessionMock,
    clearExtendedContextFailed: vi.fn(),
    hasExtendedContextFailed: vi.fn(() => false),
    setTurnPrivateMode: vi.fn(),
    setTurnCategory: vi.fn(),
    setTurnLogger: vi.fn(),
    getTurnLogger: getTurnLoggerMock,
    deleteTurnLogger: deleteTurnLoggerMock,
    deleteContextAccumulator: deleteContextAccumulatorMock,
    cleanupTurn: cleanupTurnMock,
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
    getTurnModel: vi.fn(() => 'claude-sonnet-4-5'),
      getTurnActiveProvider: vi.fn(() => undefined),
      setTurnActiveProvider: vi.fn(),
    setTurnModel: vi.fn(),
    addTurnFallback: vi.fn(),
    cleanupForRetry: vi.fn(),
    hasContextOverflowDispatched: vi.fn(() => false),
    markContextOverflowDispatched: vi.fn(),
    markExtendedContextFailed: vi.fn(),
    hasActionableErrorDispatched: vi.fn(() => false),
    getRetryCount: getRetryCountMock,
    incrementRetryCount: vi.fn(() => 1),
    getRetryStartTime: vi.fn((): number | undefined => undefined),
    setRetryStartTime: vi.fn(),
    deleteRetryCount: vi.fn(),
    deleteRetryStartTime: vi.fn(),
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
    hasUserQuestionPending: vi.fn(() => false),
    markCostRecorded: vi.fn(),
    getTurnAuthMethod: vi.fn(() => 'api-key'),
    recordSessionTurn: vi.fn(),
    hasSessionHadTurns: vi.fn(() => false),
      hasOutputCapRetryAttempted: vi.fn(() => false),
    markOutputCapRetryAttempted: vi.fn(),
    clearOutputCapRetryAttempted: vi.fn(),
    getTurnPlanningModel: vi.fn(() => undefined),
    getTurnFastModel: vi.fn(() => undefined),
    recordWatchdogSelfResolution: vi.fn(),
},
  cleanupTurnAggregator: vi.fn(),
  cleanupPendingApprovals: vi.fn(),
}));

vi.mock('../promptCacheWarmupService', () => ({
  getLastApiCallTime: vi.fn(() => undefined),
  updateLastApiCallTime: vi.fn(),
}));

vi.mock('../localModelProxyServer', () => ({
  proxyManager: {
    addRoutes: addRoutesMock,
    getAndResetTurnStats: getAndResetTurnStatsMock,
    removeRoutes: removeRoutesMock,
    getUrl: getUrlMock,
    getAuthToken: getAuthTokenMock,
  },
}));

vi.mock('../councilService', () => ({
  buildCouncilConfig: buildCouncilConfigMock,
  resolveCouncilLeadModel: resolveCouncilLeadModelMock,
  buildAvailableModelsPrompt: vi.fn(() => ''),
}));

vi.mock('../adHocAgentService', () => ({
  detectModelReferences: detectModelReferencesMock,
  buildAdHocAgentConfig: buildAdHocAgentConfigMock,
}));

vi.mock('../claudeMentionAgentService', () => ({
  CLAUDE_MENTION_TARGETS: [],
  detectClaudeModelReferences: detectClaudeModelReferencesMock,
  buildClaudeSubagentConfig: buildClaudeSubagentConfigMock,
}));

vi.mock('../mcpService', () => ({
  resolveMcpServers: vi.fn(async () => ({
    servers: undefined,
    mode: 'unavailable',
    upstreamCount: 0,
    configPath: undefined,
  })),
  resolveSystemPrompt: vi.fn(async () => ''),
  buildConnectedPackages: vi.fn(() => []),
  buildServerAccountMap: vi.fn(() => new Map()),
  buildFrequentToolGroups: vi.fn(() => []),
  reportMcpError: vi.fn(),
}));

vi.mock('../toolSafetyService', () => ({
  createToolSafetyHook: vi.fn(() => undefined),
  createCanUseTool: vi.fn(() => undefined),
  cleanupPendingApprovals: vi.fn(),
}));

vi.mock('../safety/memoryWriteHook', () => ({
  createMemoryWriteHook: vi.fn(() => undefined),
  createCheckpointIntegrityHook: vi.fn(() => undefined),
  clearCheckpointLockedState: vi.fn(),
}));

vi.mock('../safety/stagedReadHook', () => ({
  createStagedReadHook: vi.fn(() => undefined),
}));

vi.mock('../fileConversationTrackingHook', () => ({
  createFileConversationTrackingHook: vi.fn(() => undefined),
}));

vi.mock('../autoContinueHook', () => ({
  createAutoContinueHook: vi.fn(() => undefined),
}));

vi.mock('../autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

vi.mock('../safety/pendingApprovalsStore', () => ({
  getPendingApprovals: vi.fn(() => []),
  getPendingMemoryApprovals: vi.fn(() => []),
  clearPendingApprovalsForSession: vi.fn(),
}));

vi.mock('../agentMessageHandler', () => ({
  handleAgentMessage: vi.fn(),
}));

vi.mock('../../utils/systemUtils', () => ({
  setupNodeEnvironment: vi.fn(),
  resolveLibraryPath: vi.fn(() => null),
}));

vi.mock('../utils/authEnvUtils', () => ({
  getAuthEnvVars: vi.fn(() => ({})),
  hasValidAuth: vi.fn(() => true),
  isUsingOpenRouter: vi.fn((settings: { activeProvider?: string }) => settings.activeProvider === 'openrouter'),
  isUsingOAuth: vi.fn(() => false),
  getApiKeyAuthEnvVars: vi.fn(() => null),
  getProviderKeyEnvVars: vi.fn(() => null),
}));

vi.mock('@shared/utils/modelNormalization', () =>
  createModelNormalizationMock({ resolveModelConfigMock }));

vi.mock('@core/rebelCore/modelLimits', () => ({
  shouldSuppressProfileReasoning: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => profile?.thinkingCompatibility === 'incompatible',
  resolveProfileReasoningEffort: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => (profile?.thinkingCompatibility === 'incompatible' ? undefined : profile?.reasoningEffort),
  resolveModelLimits: vi.fn(() => ({ contextWindow: 200_000, maxOutputTokens: 8192 })),
}));

vi.mock('@shared/utils/settingsUtils', () => ({
  getThinkingProfile: vi.fn(() => null),
  getWorkingProfile: getWorkingProfileMock,
}));

vi.mock('../semanticContextService', () => ({
  enhancePromptWithSemanticContext: vi.fn(async (prompt: string) => ({
    enhancedPrompt: prompt,
    contextAdded: false,
    fileCount: 0,
  })),
  RELEVANCE_THRESHOLDS: {
    default: 0.5,
    explicitSearch: 0.3,
    actionIntent: 0.35,
  },
}));

vi.mock('../conversationContextService', () => ({
  enhancePromptWithConversationContext: vi.fn(async (prompt: string) => ({
    enhancedPrompt: prompt,
    contextAdded: false,
    conversationCount: 0,
  })),
  extractBookendExcerpt: vi.fn(() => ({ excerpt: '', messageRange: null })),
  formatAutoConversationContext: vi.fn(() => ''),
  parseConversationSearchKeyword: vi.fn((prompt: string) => ({ hasConversationSearch: false, sanitizedPrompt: prompt })),
  AUTO_CONVERSATION_THRESHOLD: 0.70,
  MAX_AUTO_CONVERSATION_CHARS: 10_000,
  MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION: 5_000,
  loadFilterAndFormatConversations: vi.fn(async () => null),
}));

vi.mock('../conversationHistoryService', () => ({
  loadConversationHistory: vi.fn(async () => ''),
  loadIntelligentConversationHistory: vi.fn(async () => ''),
  buildConversationHistoryContext: vi.fn(() => ''),
}));

vi.mock('@core/services/buildContinuationContext', () => createBuildContinuationContextMock());

vi.mock('../../utils/agentTurnFormatters', () => ({
  formatFrequentToolsContext: vi.fn(() => undefined),
  formatConnectedPackagesContext: vi.fn(() => undefined),
  formatSuggestedToolsContext: vi.fn(() => undefined),
  extractParamHints: vi.fn(() => ''),
  isEmptyParamSchema: vi.fn(() => false),
}));

vi.mock('../conversationIndexService', () => ({
  searchConversations: vi.fn(async () => []),
}));

vi.mock('../toolIndexService', () => ({
  searchTools: vi.fn(async () => []),
  hasToolIndex: vi.fn(() => false),
}));

vi.mock('../../tracking', () => ({
  getTurnAggregator: vi.fn(() => ({ pushMessage: vi.fn() })),
  cleanupTurnAggregator: cleanupTurnAggregatorMock,
  mainTracking: { chatSessionCreated: vi.fn() },
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn(() => ({
    captureException: captureExceptionMock,
    captureMessage: vi.fn(),
  })),
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({
    getSession: vi.fn(async () => null),
  })),
}));

vi.mock('../../constants', () => ({
  KNOWLEDGE_WORKER_AGENT_NAME: 'Rebel',
  KNOWLEDGE_WORKER_AGENT_DESCRIPTION: 'Test',
}));

vi.mock('../promptCacheWarmupService', () => ({
  updateLastApiCallTime: vi.fn(),
}));

vi.mock('../mcpServerAlias', () => ({
  aliasMcpServersForClaudeSdk: vi.fn((servers: unknown) => servers),
}));



vi.mock('@shared/utils/friendlyErrors', () => ({
  humanizeError: vi.fn((msg: string) => msg),
  isTransientError: vi.fn(() => false),
  isNetworkError: vi.fn(() => false),
  isRateLimitMessage: vi.fn(() => false),
  extractRetryAfterMs: vi.fn(() => undefined),
}));

vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@shared/utils/agentErrorCatalog');
  return {
    ...actual,
    getErrorKind: getErrorKindMock,
    isRoutedError: vi.fn(() => false),
    createRoutedError: vi.fn((kind: string, msg: string) => {
      const err = new Error(`${kind}: ${msg}`);
      (err as unknown as Record<string, unknown>).__agentErrorKind = kind;
      (err as unknown as Record<string, unknown>).__rawMessage = msg;
      return err;
    }),
  };
});

vi.mock('@shared/utils/toolNameValidation', () => ({
  isToolNameLengthError: vi.fn(() => false),
}));

vi.mock('@core/utils/delayWithAbort', () => ({
  delayWithAbort: vi.fn(async () => false),
}));

vi.mock('@core/services/apiRateLimitCooldown', () => ({
  apiRateLimitCooldown: {
    remainingMs: vi.fn(() => 0),
    recordRateLimit: vi.fn(),
    recordSuccess: vi.fn(),
  },
  safetyEvalRateLimitCooldown: {
    remainingMs: vi.fn(() => 0),
    isAvailable: vi.fn(() => true),
    recordRateLimit: vi.fn(),
    recordSuccess: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: appendCostEntryMock,
}));

vi.mock('@shared/utils/pricingCalculator', () => ({
  calculateCost: calculateModelCostMock,
  calculateCostOrWarn: calculateModelCostMock,
}));

vi.mock('../../utils/agentTurnUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/agentTurnUtils')>();
  return {
    buildUserMessageContext: actual.buildUserMessageContext,
    buildResponseShapeContractForPrompt: actual.buildResponseShapeContractForPrompt,
    MAX_RENDERER_ATTACHMENTS: 20,
    MAX_ATTACHMENT_CHAR_LENGTH: 50_000,
    MAX_IMAGE_ATTACHMENTS: 4,
    MAX_IMAGE_SIZE_BYTES: 32 * 1024 * 1024,
    MAX_TEXT_FILE_ATTACHMENTS: 10,
    MAX_TEXT_FILE_CONTENT_BYTES: 200_000,
    appendAttachmentsToPrompt: vi.fn((prompt: string) => prompt),
    appendOfficeAttachmentsToPrompt: vi.fn((prompt: string) => prompt),
    appendExtractedPdfAttachmentsToPrompt: vi.fn((prompt: string) => prompt),
    appendTextFileAttachmentsToPrompt: vi.fn((prompt: string) => prompt),
    appendBinaryAttachmentsToPrompt: vi.fn((prompt: string) => prompt),
    attachSkillMetadataToTextAttachments: vi.fn((attachments: unknown[]) => attachments),
    collectSkillModelRecommendations: vi.fn(() => []),
    computeEffectiveEffort: vi.fn((userEffort: string | undefined, profileEffort: string | undefined) => profileEffort ?? userEffort),
    resolveSkillModelRecommendations: vi.fn(() => ({
      claudeAliases: [],
      profileMatches: [],
      unresolvedModels: [],
    })),
    separateAttachments: vi.fn(() => ({
      textAttachments: [],
      imageAttachments: [],
      documentAttachments: [],
      extractedPdfAttachments: [],
      officeAttachments: [],
      textFileAttachments: [],
      binaryAttachments: [],
    })),
    createUserMessageGenerator: vi.fn((prompt: string) => prompt),
    getErrorMessage: actual.getErrorMessage,
    getErrorName: actual.getErrorName,
    getRawErrorMessage: actual.getRawErrorMessage,
    getErrorProvider: actual.getErrorProvider,
    isApiOutputMessage: actual.isApiOutputMessage,
  };
});

import { executeAgentTurn } from '../agentTurnExecutor';
import { getSettings } from '@core/services/settingsStore';
import { PREFERRED_PLANNING_MODEL } from '@shared/utils/modelNormalization';

const getSettingsMock = vi.mocked(getSettings);

type TurnStat = {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  errorCount: number;
};

function successIterator() {
  async function* gen(): AsyncGenerator<{ type: string }, void, unknown> {
    yield { type: 'result' };
  }
  const iter = gen() as AsyncGenerator<{ type: string }, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

function errorIterator(error: Error) {
  async function* gen(): AsyncGenerator<never, void, unknown> {
    throw error;
  }
  const iter = gen() as AsyncGenerator<never, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

function defaultSettings() {
  return {
    coreDirectory: process.cwd(),
    activeProvider: 'anthropic',
    models: {
      model: 'claude-sonnet-4-5',
      thinkingModel: null,
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: false,
      thinkingEffort: 'medium',
      apiKey: 'test-key',
      longContextFallbackModel: null,
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'whisper-1',
      ttsVoice: null,
      activationHotkey: 'Alt+Space',
      activationHotkeyVoiceMode: 'Alt+Space',
    },
    localModel: { profiles: [], activeProfileId: null },
  };
}

function makeStats(entries: Record<string, TurnStat>) {
  return new Map(Object.entries(entries));
}

function getFinalizationReasons() {
  return rootLoggerMock.info.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((payload) => payload?.turnId)
    .map((payload) => payload.reason);
}

describe('executeAgentTurn completeTurnCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getSettingsMock.mockReturnValue(defaultSettings() as unknown as ReturnType<typeof getSettings>);
    resolveModelConfigMock.mockImplementation((model: string) => ({ model, envOverrides: undefined }));
    getErrorKindMock.mockImplementation((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'kind' in error) {
        return (error as { kind?: string }).kind ?? 'unknown';
      }
      return 'unknown';
    });
    getRetryCountMock.mockReturnValue(0);
    buildCouncilConfigMock.mockReturnValue(null);
    resolveCouncilLeadModelMock.mockReturnValue('claude-sonnet-4-5');
    detectModelReferencesMock.mockReturnValue([]);
    buildAdHocAgentConfigMock.mockReturnValue(null);
    detectClaudeModelReferencesMock.mockReturnValue([]);
    buildClaudeSubagentConfigMock.mockReturnValue(null);
    getWorkingProfileMock.mockReturnValue(null);
    addRoutesMock.mockResolvedValue(undefined);
    getAndResetTurnStatsMock.mockReturnValue(new Map());
    removeRoutesMock.mockReturnValue(undefined);
    getUrlMock.mockReturnValue('http://proxy.local');
    getAuthTokenMock.mockReturnValue('proxy-auth-token');
    calculateModelCostMock.mockReturnValue(1.5);
    queryMock.mockImplementation(() => successIterator());
  });

  it('keeps the modelNormalization mock aligned with the current preferred planning model', () => {
    expect(PREFERRED_PLANNING_MODEL).toBe('claude-opus-4-8');
  });

  it('finalizes logger without proxy cleanup for a successful direct role-routed turn', async () => {
    const workingProfile = {
      id: 'gpt-4o-profile',
      name: 'GPT-4o',
      model: 'gpt-4o',
      baseUrl: 'http://proxy.local',
      apiKey: 'test-key',
    };
    getWorkingProfileMock.mockReturnValue(workingProfile);
    getSettingsMock.mockReturnValue({
      ...defaultSettings(),
      localModel: {
        profiles: [workingProfile],
        activeProfileId: null,
      },
    } as unknown as ReturnType<typeof getSettings>);
    getAndResetTurnStatsMock.mockReturnValue(
      makeStats({
        'gpt-4o': { inputTokens: 12, outputTokens: 34, requestCount: 1, errorCount: 0 },
      })
    );

    await executeAgentTurn(null, 'turn-cleanup-basic', 'Summarize this.', {
      sessionId: 'renderer-session-cleanup',
      resetConversation: false,
    });

    expect(getAndResetTurnStatsMock).not.toHaveBeenCalled();
    expect(removeRoutesMock).not.toHaveBeenCalled();
    expect(cleanupTurnMock).toHaveBeenCalledWith('turn-cleanup-basic');
    expect(cleanupTurnAggregatorMock).toHaveBeenCalledWith('turn-cleanup-basic');
    expect(deleteTurnLoggerMock).toHaveBeenCalledWith('turn-cleanup-basic');
    expect(deleteContextAccumulatorMock).toHaveBeenCalledWith('turn-cleanup-basic');
    expect(mockTurnLogger.flushSessionLogs).toHaveBeenCalled();
    expect(rootLoggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'turn-cleanup-basic', reason: 'completed' }),
      'Agent turn session log finalized'
    );
  });

  it('logs council stats before removing routes and clears council state for later turns', async () => {
    buildCouncilConfigMock.mockReturnValue({
      leadModel: 'claude-sonnet-4-5',
      systemPromptSuffix: '',
      agents: { alpha: {}, beta: {} },
      routeTable: {
        routes: new Map([
          ['openai/gpt-4o', { name: 'GPT-4o' }],
          ['google/gemini-2.5-pro', { name: 'Gemini 2.5 Pro' }],
        ]),
      },
    });
    getAndResetTurnStatsMock.mockReturnValue(
      makeStats({
        'openai/gpt-4o': { inputTokens: 10, outputTokens: 5, requestCount: 1, errorCount: 1 },
        'google/gemini-2.5-pro': { inputTokens: 8, outputTokens: 6, requestCount: 1, errorCount: 0 },
      })
    );
    calculateModelCostMock.mockReturnValue(2.25);

    await executeAgentTurn(null, 'turn-cleanup-council', 'Use //council for this', {
      sessionId: 'renderer-session-council',
      resetConversation: false,
      councilMode: true,
    });

    const summaryCallIndex = mockTurnLogger.info.mock.calls.findIndex(
      (call) => call[1] === 'Council proxy usage summary'
    );
    expect(summaryCallIndex).toBeGreaterThanOrEqual(0);
    expect(mockTurnLogger.info.mock.invocationCallOrder[summaryCallIndex]).toBeLessThan(
      removeRoutesMock.mock.invocationCallOrder[0]
    );
    expect(appendCostEntryMock).toHaveBeenCalledTimes(2);
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'turn-cleanup-council',
      expect.objectContaining({
        type: 'status',
        message: expect.stringContaining('Council:'),
      })
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ wasExplicitCouncilIntent: true }),
    );

    vi.clearAllMocks();
    getSettingsMock.mockReturnValue(defaultSettings() as unknown as ReturnType<typeof getSettings>);
    resolveModelConfigMock.mockImplementation((model: string) => ({ model, envOverrides: undefined }));
    getErrorKindMock.mockReturnValue('unknown');
    buildCouncilConfigMock.mockReturnValue(null);
    getWorkingProfileMock.mockReturnValue(null);
    queryMock.mockImplementation(() => successIterator());
    getAndResetTurnStatsMock.mockReturnValue(new Map());
    getUrlMock.mockReturnValue('http://proxy.local');
    getAuthTokenMock.mockReturnValue('proxy-auth-token');

    await executeAgentTurn(null, 'turn-cleanup-council', 'Normal follow-up', {
      sessionId: 'renderer-session-council',
      resetConversation: false,
      councilMode: false,
    });

    expect(getAndResetTurnStatsMock).not.toHaveBeenCalled();
    expect(removeRoutesMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ wasExplicitCouncilIntent: false }),
    );
  });

  it('captures Sentry before surfacing provider proxy startup failures', async () => {
    addRoutesMock.mockRejectedValue(new Error('proxy startup failed'));
    getSettingsMock.mockReturnValue({
      ...defaultSettings(),
      activeProvider: 'openrouter',
      openRouter: {
        enabled: true,
        oauthToken: 'or-token',
      },
    } as unknown as ReturnType<typeof getSettings>);

    await executeAgentTurn(null, 'turn-provider-proxy-failed', 'Use the fallback provider', {
      sessionId: 'renderer-session-provider-proxy',
      resetConversation: false,
    });

    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Provider proxy failed to start' }),
      expect.objectContaining({
        tags: { area: 'agent-turn', component: 'provider-proxy' },
        extra: expect.objectContaining({
          turnId: 'turn-provider-proxy-failed',
          provider: 'openrouter',
        }),
      }),
    );
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'turn-provider-proxy-failed',
      expect.objectContaining({ message: 'Failed to start provider proxy. Please try again.' }),
      { humanizedOverride: 'Failed to start provider proxy. Please try again.' },
    );

    const providerProxyErrorCallIndex = dispatchAgentEventMock.mock.calls.findIndex(
      (call) => call[1] === 'turn-provider-proxy-failed'
        && typeof call[2] === 'object'
        && call[2] !== null
        && (call[2] as { type?: string }).type === 'error',
    );
    expect(providerProxyErrorCallIndex).toBeGreaterThanOrEqual(0);
    expect(captureExceptionMock.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchAgentEventMock.mock.invocationCallOrder[providerProxyErrorCallIndex],
    );
    expect(removeRoutesMock).toHaveBeenCalledWith('turn-provider-proxy-failed');
    expect(getFinalizationReasons()).toContain('openrouter-proxy-failed');
  });

  it('still performs cleanup when server-error handling ends the turn with an error', async () => {
    const serverError = Object.assign(new Error('API server error'), {
      kind: 'server_error',
      provider: 'anthropic',
    });
    getRetryCountMock.mockReturnValue(2);
    queryMock.mockImplementation(() => errorIterator(serverError));

    await executeAgentTurn(null, 'turn-cleanup-server-error', 'Trigger a server error', {
      sessionId: 'renderer-session-server-error',
      resetConversation: false,
    });

    expect(cleanupTurnMock).toHaveBeenCalledWith('turn-cleanup-server-error');
    expect(cleanupTurnAggregatorMock).toHaveBeenCalledWith('turn-cleanup-server-error');
    expect(mockTurnLogger.flushSessionLogs).toHaveBeenCalled();
    expect(getFinalizationReasons()).toContain('server-error');
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'turn-cleanup-server-error',
      expect.objectContaining({ type: 'error', provider: 'anthropic', errorSource: 'main' })
    );
  });

  it('completes cleanup with win=null when the Claude alt-model fallback also fails', async () => {
    const workingProfile = {
      id: 'gpt-4o-profile',
      name: 'GPT-4o',
      model: 'gpt-4o',
      baseUrl: 'http://proxy.local',
      apiKey: 'test-key',
    };
    getWorkingProfileMock.mockReturnValue(workingProfile);
    getSettingsMock.mockReturnValue({
      ...defaultSettings(),
      localModel: {
        profiles: [workingProfile],
        activeProfileId: null,
      },
    } as unknown as ReturnType<typeof getSettings>);
    getRetryCountMock.mockReturnValue(1);

    const altModelServerError = Object.assign(new Error('proxy server error'), {
      kind: 'server_error',
      provider: 'openai',
    });
    const claudeFallbackError = Object.assign(new Error('Claude fallback failed'), {
      provider: 'anthropic',
    });

    queryMock
      .mockImplementationOnce(() => errorIterator(altModelServerError))
      .mockImplementationOnce(() => errorIterator(claudeFallbackError));

    await expect(
      executeAgentTurn(null, 'turn-cleanup-altmodel-failed', 'Ask the alt model', {
        sessionId: 'renderer-session-altmodel',
        resetConversation: false,
      })
    ).resolves.toBeUndefined();

    expect(cleanupTurnMock).toHaveBeenCalledWith('turn-cleanup-altmodel-failed');
    expect(mockTurnLogger.flushSessionLogs).toHaveBeenCalled();
    expect(getFinalizationReasons()).toContain('altmodel-fallback-failed');
    expect(removeRoutesMock).not.toHaveBeenCalled();
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'turn-cleanup-altmodel-failed',
      expect.objectContaining({ type: 'error', provider: 'anthropic', errorSource: 'main' })
    );
  });
});
