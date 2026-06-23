import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelNormalizationMock } from './agentTurnExecutor.testHarness';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be created before any vi.mock() calls
// ---------------------------------------------------------------------------
const {
  queryMock,
  dispatchAgentEventMock,
  mockTurnLogger,
  resolveModelConfigMock,
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
  clearExtendedContextFailedMock,
  clearPendingApprovalsForSessionMock,
  clearSchemaGateSessionMock,
  loadConversationHistoryMock,
  buildContinuationContextMock,
  listSessionsMock,
  recordSessionTurnMock,
  hasSessionHadTurnsMock,
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
  return {
    queryMock: vi.fn(),
    dispatchAgentEventMock: vi.fn(),
    mockTurnLogger,
    resolveModelConfigMock: vi.fn(),
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
    clearExtendedContextFailedMock: vi.fn(),
    clearPendingApprovalsForSessionMock: vi.fn(),
    clearSchemaGateSessionMock: vi.fn(),
    loadConversationHistoryMock: vi.fn(async () => ''),
    buildContinuationContextMock: vi.fn(async () => ({
      prefix: '',
      meta: {
        headerIncluded: false,
        headerBytes: 0,
        historyIncluded: false,
        historyBytes: 0,
        truncated: false,
      },
    })),
    listSessionsMock: vi.fn(() => [] as Array<{ id: string; messageCount: number; title: string }>),
    recordSessionTurnMock: vi.fn(),
    hasSessionHadTurnsMock: vi.fn(() => false),
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@core/rebelCore/queryRouter', () => ({ queryWithRuntime: queryMock }));
vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createTurnSessionLogger: vi.fn(() => mockTurnLogger),
  createScopedLogger: vi.fn(() => mockTurnLogger),
  runWithTurnContext: vi.fn(async (_ctx: unknown, fn: () => Promise<void>) => fn()),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn(() => ({
    coreDirectory: process.cwd(),
    claude: {
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
    models: { apiKey: 'test-key' },
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
    getRendererSession: vi.fn(() => null),
    clearExtendedContextFailed: clearExtendedContextFailedMock,
    hasExtendedContextFailed: vi.fn(() => false),
    recordSessionTurn: recordSessionTurnMock,
    hasSessionHadTurns: hasSessionHadTurnsMock,
    setTurnPrivateMode: vi.fn(),
    setTurnCategory: vi.fn(),
    setTurnLogger: vi.fn(),
    getTurnLogger: vi.fn(() => mockTurnLogger),
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
    markCostRecorded: vi.fn(),
    getTurnAuthMethod: vi.fn(() => 'api-key'),
    hasUserQuestionPending: vi.fn(() => false),
      hasOutputCapRetryAttempted: vi.fn(() => false),
      markOutputCapRetryAttempted: vi.fn(),
      clearOutputCapRetryAttempted: vi.fn(),
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
  cleanupSessionPendingApprovals: clearPendingApprovalsForSessionMock,
}));
vi.mock('../safety/memoryWriteHook', () => ({
  createMemoryWriteHook: vi.fn(() => undefined),
  createCheckpointIntegrityHook: vi.fn(() => undefined),
  clearCheckpointLockedState: vi.fn(),
}));
vi.mock('../safety/stagedReadHook', () => ({ createStagedReadHook: vi.fn(() => undefined) }));
vi.mock('../fileConversationTrackingHook', () => ({ createFileConversationTrackingHook: vi.fn(() => undefined) }));
vi.mock('../autoContinueHook', () => ({ createAutoContinueHook: vi.fn(() => undefined) }));
vi.mock('../autoContinueCache', () => ({ cleanupAutoContinueCache: vi.fn() }));
vi.mock('../safety/pendingApprovalsStore', () => ({
  getPendingApprovals: vi.fn(() => []),
  getPendingMemoryApprovals: vi.fn(() => []),
  clearPendingApprovalsForSession: clearPendingApprovalsForSessionMock,
}));
vi.mock('../agentMessageHandler', () => ({ handleAgentMessage: vi.fn() }));
vi.mock('../../utils/systemUtils', () => ({ setupNodeEnvironment: vi.fn(), resolveLibraryPath: vi.fn(() => null) }));
vi.mock('../utils/authEnvUtils', () => ({
  getAuthEnvVars: vi.fn(() => ({})),
  hasValidAuth: vi.fn(() => true),
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

vi.mock('@shared/types', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getWorkingModelProfile: vi.fn(() => null) };
});

vi.mock('../semanticContextService', () => ({
  enhancePromptWithSemanticContext: vi.fn(async (prompt: string) => ({
    enhancedPrompt: prompt,
    contextAdded: false,
    fileCount: 0,
  })),
  RELEVANCE_THRESHOLDS: { default: 0.5, explicitSearch: 0.3, actionIntent: 0.35 },
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
  loadConversationHistory: loadConversationHistoryMock,
  loadIntelligentConversationHistory: vi.fn(async () => ''),
  buildConversationHistoryContext: vi.fn(() => ''),
}));

vi.mock('@core/services/buildContinuationContext', () => ({
  buildContinuationContext: buildContinuationContextMock,
}));

vi.mock('../../utils/agentTurnFormatters', () => ({
  formatFrequentToolsContext: vi.fn(() => undefined),
  formatConnectedPackagesContext: vi.fn(() => undefined),
  formatSuggestedToolsContext: vi.fn(() => undefined),
  extractParamHints: vi.fn(() => ''),
  isEmptyParamSchema: vi.fn(() => false),
}));

vi.mock('../conversationIndexService', () => ({ searchConversations: vi.fn(async () => []) }));
vi.mock('../toolIndexService', () => ({ searchTools: vi.fn(async () => []), hasToolIndex: vi.fn(() => false) }));
vi.mock('../../tracking', () => ({ getTurnAggregator: vi.fn(() => ({ pushMessage: vi.fn() })), cleanupTurnAggregator: vi.fn(), mainTracking: { chatSessionCreated: vi.fn() } }));
vi.mock('@core/errorReporter', () => ({ getErrorReporter: vi.fn(() => ({ captureException: vi.fn(), captureMessage: vi.fn() })) }));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({
    getSession: vi.fn(async () => null),
    listSessions: listSessionsMock,
  })),
}));

vi.mock('../../constants', () => ({ KNOWLEDGE_WORKER_AGENT_NAME: 'Rebel', KNOWLEDGE_WORKER_AGENT_DESCRIPTION: 'Test' }));
vi.mock('../promptCacheWarmupService', () => ({ updateLastApiCallTime: vi.fn() }));
vi.mock('../mcpServerAlias', () => ({ aliasMcpServersForClaudeSdk: vi.fn((servers: unknown) => servers) }));
vi.mock('@shared/utils/friendlyErrors', () => ({
  humanizeError: vi.fn((msg: string) => msg),
  isTransientError: vi.fn(() => false),
  isRateLimitMessage: vi.fn(() => false),
  isNetworkError: vi.fn(() => false),
  extractRetryAfterMs: vi.fn(() => undefined),
}));
vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@shared/utils/agentErrorCatalog');
  return {
    ...actual,
    getErrorKind: vi.fn(() => 'unknown'),
    isRoutedError: vi.fn(() => false),
    createRoutedError: vi.fn((kind: string, msg: string) => {
      const err = new Error(`${kind}: ${msg}`);
      (err as unknown as Record<string, unknown>).__agentErrorKind = kind;
      (err as unknown as Record<string, unknown>).__rawMessage = msg;
      return err;
    }),
  };
});
vi.mock('@shared/utils/toolNameValidation', () => ({ isToolNameLengthError: vi.fn(() => false) }));
vi.mock('@core/utils/delayWithAbort', () => ({ delayWithAbort: vi.fn(async () => false) }));
vi.mock('@core/services/apiRateLimitCooldown', () => ({
  apiRateLimitCooldown: { remainingMs: vi.fn(() => 0), recordRateLimit: vi.fn(), recordSuccess: vi.fn() },
  safetyEvalRateLimitCooldown: { remainingMs: vi.fn(() => 0), isAvailable: vi.fn(() => true), recordRateLimit: vi.fn(), recordSuccess: vi.fn(), reset: vi.fn() },
}));
vi.mock('../costLedgerService', () => ({ appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })) }));
vi.mock('@shared/utils/pricingCalculator', () => ({ calculateCost: vi.fn(() => 0) }));
vi.mock('../../utils/agentTurnUtils', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../utils/agentTurnUtils');
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
    resolveSkillModelRecommendations: vi.fn(() => ({ claudeAliases: [], profileMatches: [], unresolvedModels: [] })),
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

vi.mock('../schemaGateHook', () => ({
  createSchemaGateHook: vi.fn(() => undefined),
  clearSchemaGateSession: clearSchemaGateSessionMock,
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER all vi.mock calls)
// ---------------------------------------------------------------------------
import { executeAgentTurn } from '../agentTurnExecutor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function successIterator() {
  async function* gen(): AsyncGenerator<{ type: string }, void, unknown> {
    yield { type: 'result' };
  }
  const iter = gen() as AsyncGenerator<{ type: string }, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('executeAgentTurn main-process resetConversation decision', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock returns
    resolveModelConfigMock.mockImplementation((model: string) => ({
      model,
      envOverrides: undefined,
    }));
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
    queryMock.mockImplementation(() => successIterator());
    loadConversationHistoryMock.mockResolvedValue('');
    listSessionsMock.mockReturnValue([]);
  });

  // -------------------------------------------------------------------------
  // Test 1: Explicit true → effectiveResetConversation is true
  // -------------------------------------------------------------------------
  it('respects explicit resetConversation: true (side effects fire)', async () => {
    // Session exists in index with messages — but explicit true should override
    listSessionsMock.mockReturnValue([
      { id: 'session-explicit-true', messageCount: 10, title: 'Existing session' },
    ]);

    await executeAgentTurn(null, 'turn-rc-explicit-true', 'Hello', {
      sessionId: 'session-explicit-true',
      resetConversation: true,
    });

    // Side effects should fire (reset clears stale state)
    expect(clearExtendedContextFailedMock).toHaveBeenCalledWith('session-explicit-true');
    expect(clearPendingApprovalsForSessionMock).toHaveBeenCalledWith('session-explicit-true');
    expect(clearSchemaGateSessionMock).toHaveBeenCalledWith('session-explicit-true');

    // History should be loaded with resetConversation=true
    expect(buildContinuationContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-explicit-true',
        resetConversation: true,
        scope: 'main',
        modeInput: { mode: 'proactive-main' },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: Explicit false → effectiveResetConversation is false
  // -------------------------------------------------------------------------
  it('respects explicit resetConversation: false (side effects do NOT fire)', async () => {
    // Session NOT in index — but explicit false should override
    listSessionsMock.mockReturnValue([]);

    await executeAgentTurn(null, 'turn-rc-explicit-false', 'Continue', {
      sessionId: 'session-explicit-false',
      resetConversation: false,
    });

    // Side effects should NOT fire
    expect(clearExtendedContextFailedMock).not.toHaveBeenCalled();
    expect(clearPendingApprovalsForSessionMock).not.toHaveBeenCalled();
    expect(clearSchemaGateSessionMock).not.toHaveBeenCalled();

    // History should be loaded with resetConversation=false
    expect(buildContinuationContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-explicit-false',
        resetConversation: false,
        scope: 'main',
        modeInput: { mode: 'proactive-main' },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: undefined + session has messages → continuation (false)
  // -------------------------------------------------------------------------
  it('decides false when session exists in index with messageCount > 0', async () => {
    listSessionsMock.mockReturnValue([
      { id: 'session-has-history', messageCount: 5, title: 'Has messages' },
    ]);

    await executeAgentTurn(null, 'turn-rc-continuation', 'Follow up', {
      sessionId: 'session-has-history',
      // resetConversation is NOT set (undefined) — main process decides
    });

    // Side effects should NOT fire (continuation)
    expect(clearExtendedContextFailedMock).not.toHaveBeenCalled();
    expect(clearPendingApprovalsForSessionMock).not.toHaveBeenCalled();
    expect(clearSchemaGateSessionMock).not.toHaveBeenCalled();

    // History should be loaded with resetConversation=false
    expect(buildContinuationContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-has-history',
        resetConversation: false,
        scope: 'main',
        modeInput: { mode: 'proactive-main' },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: undefined + session NOT in index → new session (true)
  // -------------------------------------------------------------------------
  it('decides true when session is not in index', async () => {
    listSessionsMock.mockReturnValue([]); // Empty index

    await executeAgentTurn(null, 'turn-rc-new-session', 'First message', {
      sessionId: 'session-brand-new',
      // resetConversation is NOT set (undefined) — main process decides
    });

    // Side effects should fire (new session)
    expect(clearExtendedContextFailedMock).toHaveBeenCalledWith('session-brand-new');
    expect(clearPendingApprovalsForSessionMock).toHaveBeenCalledWith('session-brand-new');
    expect(clearSchemaGateSessionMock).toHaveBeenCalledWith('session-brand-new');

    // History should be loaded with resetConversation=true
    expect(buildContinuationContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-brand-new',
        resetConversation: true,
        scope: 'main',
        modeInput: { mode: 'proactive-main' },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: undefined + session exists with messageCount === 0 → new (true)
  // -------------------------------------------------------------------------
  it('decides true when session exists in index but has messageCount 0', async () => {
    listSessionsMock.mockReturnValue([
      { id: 'session-empty', messageCount: 0, title: 'Empty session' },
    ]);

    await executeAgentTurn(null, 'turn-rc-empty-session', 'First message', {
      sessionId: 'session-empty',
      // resetConversation is NOT set (undefined)
    });

    // Side effects should fire (brand new session with 0 messages)
    expect(clearExtendedContextFailedMock).toHaveBeenCalledWith('session-empty');
    expect(clearPendingApprovalsForSessionMock).toHaveBeenCalledWith('session-empty');
    expect(clearSchemaGateSessionMock).toHaveBeenCalledWith('session-empty');

    // History should be loaded with resetConversation=true
    expect(buildContinuationContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-empty',
        resetConversation: true,
        scope: 'main',
        modeInput: { mode: 'proactive-main' },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 6: No session ID → effectiveResetConversation is true
  // -------------------------------------------------------------------------
  it('decides true when no session ID is provided', async () => {
    await executeAgentTurn(null, 'turn-rc-no-session', 'Standalone turn', {
      // No sessionId — standalone/headless turn
    });

    // listSessions should not even be called (no session to look up)
    expect(listSessionsMock).not.toHaveBeenCalled();

    // No side effects because the session branch is skipped (no rendererSessionId)
    expect(clearExtendedContextFailedMock).not.toHaveBeenCalled();

    // loadConversationHistory not called either (requires rendererSessionId)
    expect(buildContinuationContextMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 7: Race condition — session had prior turn this boot → false
  // -------------------------------------------------------------------------
  it('decides false when session had a prior turn this boot (300ms persistence race)', async () => {
    // Session NOT in the disk index yet (persistence debounce hasn't fired)
    listSessionsMock.mockReturnValue([]);
    // But the in-memory sessionsWithTurns set knows about it
    hasSessionHadTurnsMock.mockReturnValue(true);

    await executeAgentTurn(null, 'turn-rc-race', 'Follow up quickly', {
      sessionId: 'session-race',
      // resetConversation is NOT set (undefined) — main process decides
    });

    // Should NOT check the disk index (in-memory check is authoritative)
    expect(listSessionsMock).not.toHaveBeenCalled();

    // Side effects should NOT fire (continuation — session had a prior turn)
    expect(clearExtendedContextFailedMock).not.toHaveBeenCalled();
    expect(clearPendingApprovalsForSessionMock).not.toHaveBeenCalled();
    expect(clearSchemaGateSessionMock).not.toHaveBeenCalled();

    // History should be loaded with resetConversation=false
    expect(buildContinuationContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-race',
        resetConversation: false,
        scope: 'main',
        modeInput: { mode: 'proactive-main' },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 8: Records session turn after decision
  // -------------------------------------------------------------------------
  it('records session turn after the resetConversation decision', async () => {
    listSessionsMock.mockReturnValue([]);
    hasSessionHadTurnsMock.mockReturnValue(false);

    await executeAgentTurn(null, 'turn-rc-record', 'First message', {
      sessionId: 'session-record',
    });

    // recordSessionTurn should be called with the session ID
    expect(recordSessionTurnMock).toHaveBeenCalledWith('session-record');
  });
});
