import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBuildContinuationContextMock,
  createModelNormalizationMock,
} from './agentTurnExecutor.testHarness';

// ---------------------------------------------------------------------------
// vi.hoisted mock refs
// ---------------------------------------------------------------------------
const {
  queryMock,
  dispatchAgentEventMock,
  resolveModelConfigMock,
  mockTurnLogger,
  assemblePreTurnContextMock,
  buildServerAccountMapMock,
  formatSuggestedToolsContextMock,
  searchToolsMock,
  hasToolIndexMock,
  getToolIndexStatusMock,
  runAgentQueryMock,
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
    resolveModelConfigMock: vi.fn(),
    mockTurnLogger,
    assemblePreTurnContextMock: vi.fn(),
    buildServerAccountMapMock: vi.fn(() => new Map()),
    formatSuggestedToolsContextMock: vi.fn(() => undefined),
    searchToolsMock: vi.fn(async () => []),
    hasToolIndexMock: vi.fn(() => false),
    getToolIndexStatusMock: vi.fn(() => ({ freshnessGeneration: 0 })),
    runAgentQueryMock: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Module mocks (same structure as other executor test files)
// ---------------------------------------------------------------------------

vi.mock('../agentQueryRunner', () => ({
  runAgentQuery: runAgentQueryMock,
}));

vi.mock('@core/rebelCore/queryRouter', () => ({
  queryWithRuntime: queryMock,
}));

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

// 260622 Stage 5: these tests run user-initiated desktop interactive turns
// (`sessionId` → `conversation` kind, default manual/interactive policy, the
// vitest desktop surface) under FAKE TIMERS, so the Stage-3 Chief-of-Staff
// admission gate would otherwise drive the REAL killable bounded README read,
// which never settles while timers are faked → the turn hangs. These tests
// exercise the pre-turn assembly timeout, NOT the CoS gate, so we stub the gate
// to admit instantly (matching turnAdmission.chiefOfStaff.test.ts). The gate's
// own behaviour is covered by chiefOfStaffAdmission.test.ts +
// turnAdmission.chiefOfStaff*.test.ts.
vi.mock('@core/services/turnPipeline/chiefOfStaffAdmission', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@core/services/turnPipeline/chiefOfStaffAdmission')>();
  return {
    ...actual,
    evaluateChiefOfStaffAdmission: vi.fn(async () => ({ decision: 'admit', outcome: 'absent' })),
  };
});

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
    clearExtendedContextFailed: vi.fn(),
    hasExtendedContextFailed: vi.fn(() => false),
    getRendererSession: vi.fn(() => null),
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
    deleteTurnCloseCallback: vi.fn(),
    hasSuccessResultDispatched: vi.fn(() => false),
    hasCostRecorded: vi.fn(() => false),
    hasUserQuestionPending: vi.fn(() => false),
    markCostRecorded: vi.fn(),
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

vi.mock('../localModelProxyServer', () => ({
  proxyManager: {
    getAndResetTurnStats: vi.fn(() => new Map()),
    removeRoutes: vi.fn(),
    getUrl: vi.fn(() => null),
    getAuthToken: vi.fn(() => null),
  },
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
  buildServerAccountMap: buildServerAccountMapMock,
  buildFrequentToolGroups: vi.fn(() => []),
  reportMcpError: vi.fn(),
}));

vi.mock('../toolSafetyService', () => ({
  createToolSafetyHook: vi.fn(() => undefined),
  createCanUseTool: vi.fn(() => undefined),
  cleanupPendingApprovals: vi.fn(),
  cleanupSessionPendingApprovals: vi.fn(),
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
  getWorkingProfile: vi.fn(() => null),
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
  buildConversationHistoryContext: vi.fn(() => ''),
  loadIntelligentConversationHistory: vi.fn(async () => ''),
}));

vi.mock('@core/services/buildContinuationContext', () => createBuildContinuationContextMock());

vi.mock('../../utils/agentTurnFormatters', () => ({
  formatFrequentToolsContext: vi.fn(() => undefined),
  formatConnectedPackagesContext: vi.fn(() => undefined),
  formatSuggestedToolsContext: formatSuggestedToolsContextMock,
  extractParamHints: vi.fn(() => ''),
  isEmptyParamSchema: vi.fn(() => false),
}));

vi.mock('../conversationIndexService', () => ({
  searchConversations: vi.fn(async () => []),
}));

vi.mock('@core/services/toolIndex/toolIndexService', () => ({
  searchTools: searchToolsMock,
  hasToolIndex: hasToolIndexMock,
  getToolIndexStatus: getToolIndexStatusMock,
}));

vi.mock('../toolIndexService', () => ({
  searchTools: searchToolsMock,
  hasToolIndex: hasToolIndexMock,
  getToolIndexStatus: getToolIndexStatusMock,
}));

vi.mock('../../tracking', () => ({
  getTurnAggregator: vi.fn(() => ({ pushMessage: vi.fn() })),
  cleanupTurnAggregator: vi.fn(),
  mainTracking: { chatSessionCreated: vi.fn() },
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn(() => ({
    captureException: vi.fn(),
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
    getErrorKind: vi.fn(() => 'unknown'),
    isRoutedError: vi.fn(() => false),
    createRoutedError: vi.fn((kind: string, msg: string) => {
      const err = new Error(`${kind}: ${msg}`);
      (err as any).__agentErrorKind = kind;
      (err as any).__rawMessage = msg;
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

const preTurnWorkerApiMock = {
  waitForWorkerReady: vi.fn(async () => {}),
  isWorkerAvailable: vi.fn(() => true),
  assemblePreTurnContext: assemblePreTurnContextMock,
  disposeWorker: vi.fn(async () => {}),
  getWorkerStatus: vi.fn(() => ({
    isReady: true,
    permanentlyDisabled: false,
    consecutiveCrashes: 0,
    crashCooldownRemainingMs: 0,
    workspacePath: '/tmp/workspace',
  })),
  getPreTurnWorkerStats: vi.fn(() => ({
    since: 'app_start',
    appStartedAt: 1234567890,
    spawnCount: 1,
    restartCount: 0,
    currentlyRestarting: false,
    averagePreTurnDurationBucket: '<100ms'
  })),
};

vi.mock('@core/preTurnWorker', () => ({
  getPreTurnWorker: vi.fn(() => preTurnWorkerApiMock),
}));

// ---------------------------------------------------------------------------
// Import SUT
// ---------------------------------------------------------------------------
import { executeAgentTurn } from '../agentTurnExecutor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successIterator() {
  async function* gen(): AsyncGenerator<{ type: string; message?: unknown }, void, unknown> {
    yield {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
      },
    };
    yield { type: 'result', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], model: 'claude-sonnet-4-5', stop_reason: 'end_turn' } };
  }
  const iter = gen() as AsyncGenerator<{ type: string; message?: unknown }, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeAgentTurn pre-turn assembly timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    resolveModelConfigMock.mockImplementation((model: string) => ({
      model,
      envOverrides: undefined,
    }));

    // Default: worker assembly resolves immediately with empty results
    assemblePreTurnContextMock.mockResolvedValue({
      semanticContext: null,
      suggestedTools: [],
      suggestedConversations: [],
      suggestedSkills: [],
      conversationSearchStatus: 'ok',
      toolSearchStatus: 'ok',
    });
    buildServerAccountMapMock.mockReturnValue(new Map());
    formatSuggestedToolsContextMock.mockReturnValue(undefined);
    searchToolsMock.mockResolvedValue([]);
    hasToolIndexMock.mockReturnValue(false);
    getToolIndexStatusMock.mockReturnValue({ freshnessGeneration: 0 });

    runAgentQueryMock.mockResolvedValue({
      abortedByUser: false,
      terminatedByHandler: false,
    });

    // Agent query returns a successful iterator
    queryMock.mockImplementation(() => successIterator());
  });

  it('proceeds normally when assembly completes within timeout', async () => {
    const turnId = 'turn-normal-assembly';
    await executeAgentTurn(null, turnId, 'Hello', {
      sessionId: 'session-normal',
      resetConversation: false,
    });

    // Should NOT see timeout warning
    const warnCalls = mockTurnLogger.warn.mock.calls;
    const timeoutWarns = warnCalls.filter((call: unknown[]) =>
      typeof call[1] === 'string' && call[1].includes('timed out')
    );
    expect(timeoutWarns).toHaveLength(0);

    // Should NOT see timeout status event
    const statusEvents = dispatchAgentEventMock.mock.calls
      .map((c: unknown[]) => c[2] as Record<string, unknown>)
      .filter((e: Record<string, unknown>) =>
        e.type === 'status' && typeof e.message === 'string' && (e.message as string).includes('longer than expected')
      );
    expect(statusEvents).toHaveLength(0);
  });

  it('fires timeout and proceeds without context when assembly hangs', async () => {
    vi.useFakeTimers();

    // Make worker assembly hang forever
    assemblePreTurnContextMock.mockImplementation(() => new Promise(() => {}));

    const turnId = 'turn-timeout';
    const turnPromise = executeAgentTurn(null, turnId, 'Hello', {
      sessionId: 'session-timeout',
      resetConversation: false,
    });

    // Advance past the 60s timeout
    await vi.advanceTimersByTimeAsync(61_000);

    // Let the turn complete
    vi.useRealTimers();
    await turnPromise;

    // Should see timeout warning with assemblyPhase
    const warnCalls = mockTurnLogger.warn.mock.calls;
    const timeoutWarns = warnCalls.filter((call: unknown[]) =>
      typeof call[1] === 'string' && call[1].includes('timed out')
    );
    expect(timeoutWarns.length).toBeGreaterThanOrEqual(1);

    // Should include assemblyPhase in structured log data
    const timeoutLogData = timeoutWarns[0][0] as Record<string, unknown>;
    expect(timeoutLogData).toHaveProperty('assemblyPhase');
    expect(timeoutLogData).toHaveProperty('timeoutMs', 60_000);

    // Should dispatch user-facing status event
    const statusEvents = dispatchAgentEventMock.mock.calls
      .map((c: unknown[]) => c[2] as Record<string, unknown>)
      .filter((e: Record<string, unknown>) =>
        e.type === 'status' && typeof e.message === 'string' && (e.message as string).includes('longer than expected')
      );
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('does not dispatch late tool events after timeout fires', async () => {
    vi.useFakeTimers();

    // Worker assembly resolves AFTER timeout with context data
    let resolveAssembly: ((value: unknown) => void) | undefined;
    assemblePreTurnContextMock.mockImplementation(() => new Promise(resolve => {
      resolveAssembly = resolve;
    }));

    const turnId = 'turn-late-resolve';
    const turnPromise = executeAgentTurn(null, turnId, 'Hello', {
      sessionId: 'session-late',
      resetConversation: false,
    });

    // Advance past the 60s timeout
    await vi.advanceTimersByTimeAsync(61_000);

    // Now resolve the assembly with context data (simulating late completion)
    resolveAssembly!({
      semanticContext: {
        formattedContext: 'Late file context',
        fileCount: 3,
        files: [],
      },
      suggestedTools: [],
      suggestedConversations: [],
      suggestedSkills: [],
      conversationSearchStatus: 'ok',
      toolSearchStatus: 'ok',
    });

    // Let microtasks flush
    await vi.advanceTimersByTimeAsync(100);
    vi.useRealTimers();
    await turnPromise;

    // file_search events dispatched BEFORE timeout are acceptable,
    // but NO file_search events should appear AFTER the timeout fired
    const allEvents = dispatchAgentEventMock.mock.calls.map((c: unknown[]) => c[2] as Record<string, unknown>);
    const fileSearchEvents = allEvents.filter((e: Record<string, unknown>) =>
      e.type === 'tool' && (e as any).toolName === 'file_search'
    );

    // The late-resolving assembly should NOT produce file_search events
    // because isAssemblyStillActive() returns false after timeout
    expect(fileSearchEvents).toHaveLength(0);
  });

  it('skips main-process tool fallback when the worker intentionally skipped tool search', async () => {
    hasToolIndexMock.mockReturnValue(true);
    assemblePreTurnContextMock.mockResolvedValue({
      semanticContext: null,
      suggestedTools: [],
      suggestedConversations: [],
      suggestedSkills: [],
      conversationSearchStatus: 'ok',
      toolSearchStatus: 'skipped',
    });

    await executeAgentTurn(null, 'turn-skip-fallback', 'Hello', {
      sessionId: 'session-skip-fallback',
      resetConversation: true,
    });

    expect(searchToolsMock).not.toHaveBeenCalled();
  });

  it('runs main-process hybrid fallback when worker returned ok but found zero tools', async () => {
    hasToolIndexMock.mockReturnValue(true);
    assemblePreTurnContextMock.mockResolvedValue({
      semanticContext: null,
      suggestedTools: [],
      suggestedConversations: [],
      suggestedSkills: [],
      conversationSearchStatus: 'ok',
      toolSearchStatus: 'ok',
    });
    searchToolsMock.mockResolvedValue([]);

    await executeAgentTurn(null, 'turn-ok-fallback', 'Hello', {
      sessionId: 'session-ok-fallback',
      resetConversation: true,
    });

    expect(searchToolsMock).toHaveBeenCalled();
  });

  it('passes toolIndexUsable=false to pre-turn worker when tool index is not usable', async () => {
    hasToolIndexMock.mockReturnValue(false);
    assemblePreTurnContextMock.mockResolvedValue({
      semanticContext: null,
      suggestedTools: [],
      suggestedConversations: [],
      suggestedSkills: [],
      conversationSearchStatus: 'ok',
      toolSearchStatus: 'unavailable',
    });

    await executeAgentTurn(null, 'turn-tool-index-unusable', 'Hello', {
      sessionId: 'session-tool-index-unusable',
      resetConversation: true,
    });

    expect(assemblePreTurnContextMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        prompt: 'Hello',
        toolIndexUsable: false,
      }),
      undefined,
    );
  });

  it('skips main-process fallback when worker found tools successfully', async () => {
    hasToolIndexMock.mockReturnValue(true);
    const mockTool = { toolId: 'notion-fetch', packageId: 'Notion', name: 'notion-fetch', summary: 'Fetch a Notion page', inputSchema: '{}' };
    assemblePreTurnContextMock.mockResolvedValue({
      semanticContext: null,
      suggestedTools: [mockTool],
      suggestedConversations: [],
      suggestedSkills: [],
      conversationSearchStatus: 'ok',
      toolSearchStatus: 'ok',
    });
    (formatSuggestedToolsContextMock as ReturnType<typeof vi.fn>).mockReturnValue('some tools context');

    await executeAgentTurn(null, 'turn-ok-with-tools', 'Hello', {
      sessionId: 'session-ok-with-tools',
      resetConversation: true,
    });

    expect(searchToolsMock).not.toHaveBeenCalled();
  });

  it('discards worker suggested tools when tool index freshness changes during worker search', async () => {
    hasToolIndexMock.mockReturnValue(true);
    getToolIndexStatusMock
      .mockReturnValueOnce({ freshnessGeneration: 1 })
      .mockReturnValueOnce({ freshnessGeneration: 2 });
    const mockTool = { toolId: 'stale-search', packageId: 'Microsoft365Mail', name: 'stale-search', summary: 'Search stale mail', inputSchema: '{}' };
    assemblePreTurnContextMock.mockResolvedValue({
      semanticContext: null,
      suggestedTools: [mockTool],
      suggestedConversations: [],
      suggestedSkills: [],
      conversationSearchStatus: 'ok',
      toolSearchStatus: 'ok',
    });
    (formatSuggestedToolsContextMock as ReturnType<typeof vi.fn>).mockReturnValue('stale tools context');

    await executeAgentTurn(null, 'turn-stale-worker-tools', 'Hello', {
      sessionId: 'session-stale-worker-tools',
      resetConversation: true,
    });

    expect(formatSuggestedToolsContextMock).not.toHaveBeenCalled();
    expect(mockTurnLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        resultToolCount: 1,
        preTurnToolIndexGeneration: 1,
        currentToolIndexGeneration: 2,
      }),
      'Discarding worker suggested tools because tool index freshness changed',
    );
  });

  it('times out tool-search fallback after 5 seconds and continues without suggested tools', async () => {
    vi.useFakeTimers();
    hasToolIndexMock.mockReturnValue(true);
    assemblePreTurnContextMock.mockResolvedValue({
      semanticContext: null,
      suggestedTools: [],
      suggestedConversations: [],
      suggestedSkills: [],
      conversationSearchStatus: 'ok',
      toolSearchStatus: 'unavailable',
    });
    searchToolsMock.mockImplementation(() => new Promise(() => {}));

    const turnPromise = executeAgentTurn(null, 'turn-tool-fallback-timeout', 'Hello', {
      sessionId: 'session-tool-fallback-timeout',
      resetConversation: true,
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(mockTurnLogger.warn).not.toHaveBeenCalledWith('Tool search fallback timed out — proceeding without suggested tools');

    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await expect(turnPromise).resolves.toBeUndefined();

    expect(searchToolsMock).toHaveBeenCalledTimes(1);
    expect(mockTurnLogger.warn).toHaveBeenCalledWith('Tool search fallback timed out — proceeding without suggested tools');

    const toolSearchEvents = dispatchAgentEventMock.mock.calls
      .map((call: unknown[]) => call[2] as { type?: string; toolName?: string })
      .filter(event => event.type === 'tool' && event.toolName === 'tool_search');
    expect(toolSearchEvents).toHaveLength(0);
  });
});

describe('executeAgentTurn pre-turn worker stats emit', () => {
  it('emits worker_stats_pre_turn exactly once per turn', async () => {
    const diagnosticEventsLedger = await import('@core/services/diagnosticEventsLedger');
    const appendSpy = vi.spyOn(diagnosticEventsLedger, 'appendDiagnosticEvent');

    assemblePreTurnContextMock.mockResolvedValue({
      semanticContext: null,
      suggestedTools: [],
      suggestedConversations: [],
      suggestedSkills: [],
      conversationSearchStatus: 'ok',
      toolSearchStatus: 'ok',
    });

    await executeAgentTurn(null, 'turn-stats-emit', 'Hello', {
      sessionId: 'session-stats-emit',
      resetConversation: true,
    });

    // Check that it was called exactly once with the worker stats
    const workerStatsCalls = appendSpy.mock.calls.filter(
      (call) => call[0].kind === 'worker_stats_pre_turn'
    );
    expect(workerStatsCalls.length).toBe(1);
    expect(workerStatsCalls[0][0].data).toMatchObject({
      since: 'app_start',
      spawnCount: expect.any(Number),
      restartCount: expect.any(Number),
      currentlyRestarting: expect.any(Boolean)
    });
  });
});
