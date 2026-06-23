import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelNormalizationMock } from './agentTurnExecutor.testHarness';

/**
 * Red→green regression test for the pre-dispatch liveness guard
 * (260619_turn-hang-bugmode Stage 2).
 *
 * Root cause: a dead cloud-storage mount exhausts the shared libuv thread pool;
 * the agent turn's pre-dispatch fs reads (`getSession`, `buildContinuationContext`,
 * `fs.stat(coreDirectory)`) then queue forever and hang WITHOUT throwing. No
 * watchdog is armed in the pre-dispatch window and the main try has no finally,
 * so the turn silently spins forever AND leaks the active-turn latch
 * (`completeTurnCleanup` never runs → `getActiveTurnCount()` never returns to 0).
 *
 * This test injects a never-resolving pre-dispatch dependency and asserts the
 * guard turns the silent hang into:
 *   (a) a retryable `message_timeout` terminal (renderer "Try again"),
 *   (b) a released active-turn latch (registry cleanup runs, count → 0),
 *   (c) NO second dispatch / model call / cleanup when the wedged dependency
 *       later resolves (the stale-turn guard + idempotent cleanup hold — GPT F4).
 *
 * RED before the fix: the turn hangs past the deadline, no terminal fires, the
 * latch stays set. GREEN after: terminal fires within the guard bound and the
 * latch is released.
 */

// ---------------------------------------------------------------------------
// Faithful active-turn latch: a real Set so getActiveTurnCount() reflects
// set/cleanup, letting us assert the latch is released (count → 0).
// ---------------------------------------------------------------------------
const {
  activeTurnLatch,
  queryMock,
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  resolveModelConfigMock,
  mockTurnLogger,
  assemblePreTurnContextMock,
  buildServerAccountMapMock,
  formatSuggestedToolsContextMock,
  searchToolsMock,
  hasToolIndexMock,
  getToolIndexStatusMock,
  runAgentQueryMock,
  getSessionMock,
  buildContinuationContextMock,
  resolveProviderRoutePlanMock,
  realRouteHolderRef,
  delayWithAbortMock,
  resolveMcpServersMock,
  removeRoutesMock,
  captureExceptionMock,
  addBreadcrumbMock,
  getSettingsMock,
  makeSettings,
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
    activeTurnLatch: new Set<string>(),
    queryMock: vi.fn(),
    dispatchAgentEventMock: vi.fn(),
    dispatchAgentErrorEventMock: vi.fn(),
    resolveModelConfigMock: vi.fn(),
    mockTurnLogger,
    assemblePreTurnContextMock: vi.fn(),
    buildServerAccountMapMock: vi.fn(() => new Map()),
    formatSuggestedToolsContextMock: vi.fn(() => undefined),
    searchToolsMock: vi.fn(async () => []),
    hasToolIndexMock: vi.fn(() => false),
    getToolIndexStatusMock: vi.fn(() => ({ freshnessGeneration: 0 })),
    runAgentQueryMock: vi.fn(),
    getSessionMock: vi.fn(),
    buildContinuationContextMock: vi.fn(),
    resolveProviderRoutePlanMock: vi.fn(),
    realRouteHolderRef: {} as { fn?: (...args: unknown[]) => unknown },
    delayWithAbortMock: vi.fn(async (_ms: number, _signal: AbortSignal): Promise<boolean> => false),
    resolveMcpServersMock: vi.fn(async () => ({ servers: undefined, mode: 'unavailable', upstreamCount: 0, configPath: undefined })),
    removeRoutesMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    addBreadcrumbMock: vi.fn(),
    getSettingsMock: vi.fn(),
    // Settings factory: lets a test set `coreDirectory` (Stage 3 cloud-suspicion
    // tag) without re-declaring the whole settings shape.
    makeSettings: (coreDirectory: string | null) => ({
      coreDirectory,
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
    }),
  };
});

// ---------------------------------------------------------------------------
// Module mocks (mirrors agentTurnExecutor.preTurnTimeout.test.ts).
// ---------------------------------------------------------------------------

vi.mock('../agentQueryRunner', () => ({
  runAgentQuery: runAgentQueryMock,
}));

vi.mock('@core/rebelCore/queryRouter', () => ({
  queryWithRuntime: queryMock,
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
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
// exercise the pre-dispatch liveness guard, NOT the CoS gate, so we stub the
// gate to admit instantly (matching turnAdmission.chiefOfStaff.test.ts). The
// gate's own behaviour is covered by chiefOfStaffAdmission.test.ts +
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
  getSettings: getSettingsMock,
  updateSettings: vi.fn(),
  updateSettingsAtomic: vi.fn(),
  onSettingsChange: vi.fn(() => () => undefined),
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    // Faithful latch: set on admission, cleared on cleanupTurn.
    setActiveTurnController: vi.fn((turnId: string) => { activeTurnLatch.add(turnId); }),
    cleanupTurn: vi.fn((turnId: string) => { activeTurnLatch.delete(turnId); }),
    cleanupForRetry: vi.fn((turnId: string) => { activeTurnLatch.delete(turnId); }),
    getActiveTurnCount: vi.fn(() => activeTurnLatch.size),
    setRendererSession: vi.fn(),
    setTurnPrivateMode: vi.fn(),
    setTurnCategory: vi.fn(),
    setTurnLogger: vi.fn(),
    getTurnLogger: vi.fn(() => mockTurnLogger),
    deleteTurnLogger: vi.fn(),
    deleteContextAccumulator: vi.fn(),
    setTurnPrompt: vi.fn(),
    getTurnPrompt: vi.fn(() => undefined),
    setTurnExtendedContext: vi.fn(),
    setTurnThinkingEffort: vi.fn(),
    setTurnAuthMethod: vi.fn(),
    setTurnPlanningModel: vi.fn(),
    setTurnFastModel: vi.fn(),
    setTurnSpawnDelayed: vi.fn(),
    getTurnSpawnDelayed: vi.fn(() => false),
    getTurnModel: vi.fn(() => null),
    getTurnActiveProvider: vi.fn(() => undefined),
    setTurnActiveProvider: vi.fn(),
    setTurnModel: vi.fn(),
    addTurnFallback: vi.fn(),
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
    getRendererSessionByTurn: vi.fn(() => null),
  },
  cleanupTurnAggregator: vi.fn(),
  cleanupPendingApprovals: vi.fn(),
}));

vi.mock('../localModelProxyServer', () => ({
  proxyManager: {
    getAndResetTurnStats: vi.fn(() => new Map()),
    removeRoutes: removeRoutesMock,
    getUrl: vi.fn(() => null),
    getAuthToken: vi.fn(() => null),
  },
}));

vi.mock('../mcpService', () => ({
  resolveMcpServers: resolveMcpServersMock,
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
  shouldSuppressProfileReasoning: () => false,
  resolveProfileReasoningEffort: () => undefined,
  resolveModelLimits: vi.fn(() => ({ contextWindow: 200_000, maxOutputTokens: 8192 })),
}));

// resolveProviderRoutePlan is the final pre-dispatch await (post-abort-checkpoint-3).
// Default the mock to the real impl (captured on realRouteHolderRef so beforeEach
// can restore it after clearAllMocks); the F6 test wedges this window.
vi.mock('@core/rebelCore/providerRouting', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@core/rebelCore/providerRouting');
  realRouteHolderRef.fn = actual.resolveProviderRoutePlan as (...args: unknown[]) => unknown;
  return {
    ...actual,
    resolveProviderRoutePlan: resolveProviderRoutePlanMock,
  };
});

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
  loadConversationHistory: vi.fn(async () => ''),
  buildConversationHistoryContext: vi.fn(() => ''),
  loadIntelligentConversationHistory: vi.fn(async () => ''),
}));

// buildContinuationContext is injectable per-test so we can wedge it.
vi.mock('@core/services/buildContinuationContext', () => ({
  buildContinuationContext: buildContinuationContextMock,
}));

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
    captureException: captureExceptionMock,
    captureMessage: vi.fn(),
    addBreadcrumb: addBreadcrumbMock,
  })),
  setErrorReporter: vi.fn(),
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({
    getSession: getSessionMock,
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
  delayWithAbort: delayWithAbortMock,
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
    averagePreTurnDurationBucket: '<100ms',
  })),
};

vi.mock('@core/preTurnWorker', () => ({
  getPreTurnWorker: vi.fn(() => preTurnWorkerApiMock),
}));

// ---------------------------------------------------------------------------
// Import SUT + constant + real cleanup (NOT mocked — we assert it runs).
// ---------------------------------------------------------------------------
import { executeAgentTurn, PRE_DISPATCH_SETUP_TIMEOUT_MS } from '../agentTurnExecutor';
import { councilTurnIds, adHocTurnIds } from '../agentTurnCleanup';
// REAL (unmocked) pure cloud-detection util — the exact function the Stage-3
// guard calls on the pre-captured coreDirectory string.
import { detectCloudStorage } from '@core/utils/cloudStorageUtils';

const EMPTY_CONTINUATION = {
  prefix: '',
  meta: { headerIncluded: false, headerBytes: 0, historyIncluded: false, historyBytes: 0, truncated: false },
};

// Helper: extract dispatched events (3rd arg to dispatchAgentEvent).
function dispatchedEvents() {
  return dispatchAgentEventMock.mock.calls.map((c: unknown[]) => c[2] as Record<string, unknown>);
}

// Helper: the message_timeout error-event dispatch calls.
function messageTimeoutErrorDispatches() {
  return dispatchAgentErrorEventMock.mock.calls.filter((c: unknown[]) => {
    const opts = c[3] as Record<string, unknown> | undefined;
    return opts?.errorKindOverride === 'message_timeout';
  });
}

describe('executeAgentTurn pre-dispatch liveness guard (260619 Stage 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeTurnLatch.clear();
    councilTurnIds.clear();
    adHocTurnIds.clear();
    vi.useRealTimers();

    // Default: a local (non-cloud) coreDirectory. Per-test overrides set a cloud
    // path to exercise the Stage 3 cloudWorkspaceSuspected tag.
    getSettingsMock.mockImplementation(() => makeSettings(process.cwd()));
    resolveModelConfigMock.mockImplementation((model: string) => ({ model, envOverrides: undefined }));

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
    runAgentQueryMock.mockResolvedValue({ abortedByUser: false, terminatedByHandler: false });
    // Default: pre-dispatch deps resolve immediately.
    getSessionMock.mockResolvedValue(null);
    buildContinuationContextMock.mockResolvedValue(EMPTY_CONTINUATION);
    // Restore the real route-plan resolution (clearAllMocks wiped the impl).
    if (realRouteHolderRef.fn) {
      resolveProviderRoutePlanMock.mockImplementation(realRouteHolderRef.fn as (...args: unknown[]) => unknown);
    }
    delayWithAbortMock.mockImplementation(async (_ms: number, _signal: AbortSignal) => false);
    resolveMcpServersMock.mockImplementation(async () => ({ servers: undefined, mode: 'unavailable', upstreamCount: 0, configPath: undefined }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns a never-resolving buildContinuationContext into a retryable terminal and releases the latch', async () => {
    vi.useFakeTimers();

    // Wedge the conversation-history read forever (the logforensics prime-suspect
    // pre-dispatch hang site). Simulates a dead cloud mount blocking the fs read.
    let resolveBuild: ((value: unknown) => void) | undefined;
    buildContinuationContextMock.mockImplementation(() => new Promise((resolve) => { resolveBuild = resolve; }));

    const turnId = 'turn-wedged-buildcontext';
    const turnPromise = executeAgentTurn(null, turnId, 'test', {
      sessionId: 'session-wedged',
      resetConversation: false,
    });

    // Latch is held while the turn is wedged in the pre-dispatch window.
    expect(activeTurnLatch.has(turnId)).toBe(true);

    // No terminal yet — it is silently hung (this is the bug being guarded).
    expect(messageTimeoutErrorDispatches()).toHaveLength(0);

    // Advance past the coarse pre-dispatch deadline → the guard fires.
    await vi.advanceTimersByTimeAsync(PRE_DISPATCH_SETUP_TIMEOUT_MS + 1_000);

    // (a) A retryable message_timeout terminal fired (renderer "Try again").
    expect(messageTimeoutErrorDispatches().length).toBeGreaterThanOrEqual(1);
    // F5: the terminal carries structured metadata distinguishing pre-dispatch
    // setup timeout from a real awaiting-API stall (both are message_timeout).
    const guardDispatch = messageTimeoutErrorDispatches()[0];
    const guardDiag = (guardDispatch[3] as Record<string, unknown>).watchdogDiagnostic as Record<string, unknown> | undefined;
    expect(guardDiag?.phase).toBe('pre_dispatch_setup');
    // A synthetic result('error') follows to clear the renderer busy state.
    const errorResults = dispatchedEvents().filter(
      (e) => e.type === 'result' && e.turnEndReason === 'error',
    );
    expect(errorResults.length).toBeGreaterThanOrEqual(1);

    // (b) The active-turn latch was released (count → 0).
    expect(activeTurnLatch.has(turnId)).toBe(false);
    expect(activeTurnLatch.size).toBe(0);

    // Telemetry surfaced (Sentry capture + breadcrumb) — no longer invisible.
    expect(captureExceptionMock).toHaveBeenCalled();
    expect(addBreadcrumbMock).toHaveBeenCalled();

    // (c) The wedged dependency resolves LATE (the kernel thread eventually
    // returns). The stale-turn guard must hold: no second model call, no second
    // terminal, no double cleanup re-adding the latch.
    const errorDispatchesAfterGuard = messageTimeoutErrorDispatches().length;
    const errorResultsAfterGuard = errorResults.length;

    resolveBuild?.({ prefix: 'Late history that should be discarded', meta: undefined });
    await vi.advanceTimersByTimeAsync(1_000);

    // Let any resumed continuation flush.
    vi.useRealTimers();
    await turnPromise;

    expect(runAgentQueryMock).not.toHaveBeenCalled();
    expect(messageTimeoutErrorDispatches().length).toBe(errorDispatchesAfterGuard);
    const errorResultsFinal = dispatchedEvents().filter(
      (e) => e.type === 'result' && e.turnEndReason === 'error',
    );
    expect(errorResultsFinal.length).toBe(errorResultsAfterGuard);
    // Latch must NOT have been re-added by the resumed continuation.
    expect(activeTurnLatch.size).toBe(0);
    // No council/ad-hoc proxy residue left by a late-resumed setup branch
    // (GPT-stage2 F1/F3 — state created after cleanup must not persist).
    expect(councilTurnIds.has(turnId)).toBe(false);
    expect(adHocTurnIds.has(turnId)).toBe(false);
    // rework2-F2: a stale continuation must NOT call turn-keyed proxy cleanup
    // (it could clobber a same-turnId retry's routes). No council/adHoc state was
    // set here, so removeRoutes must not be invoked by any stale path.
    expect(removeRoutesMock).not.toHaveBeenCalled();
  });

  it('handles a post-checkpoint-3 wedge: late provider route-plan resolve produces no duplicate terminal or model call (GPT-stage2 F5)', async () => {
    vi.useFakeTimers();

    // Wedge the FINAL pre-dispatch await — resolveProviderRoutePlan — which runs
    // after abort-checkpoint-3 (the window the pre-watchdog-arm chokepoint + stale
    // bails must cover). buildContinuationContext etc. resolve normally first.
    let resolveRoutePlan: ((value: unknown) => void) | undefined;
    resolveProviderRoutePlanMock.mockImplementation(() => new Promise((resolve) => { resolveRoutePlan = resolve; }));

    const turnId = 'turn-wedged-routeplan';
    const turnPromise = executeAgentTurn(null, turnId, 'test', {
      sessionId: 'session-wedged-routeplan',
      resetConversation: false,
    });

    // Let the synchronous-up-to-the-wedge pre-dispatch flow run.
    await vi.advanceTimersByTimeAsync(0);
    expect(activeTurnLatch.has(turnId)).toBe(true);
    expect(messageTimeoutErrorDispatches()).toHaveLength(0);

    // Guard fires.
    await vi.advanceTimersByTimeAsync(PRE_DISPATCH_SETUP_TIMEOUT_MS + 1_000);
    expect(messageTimeoutErrorDispatches().length).toBeGreaterThanOrEqual(1);
    expect(activeTurnLatch.size).toBe(0);

    const terminalsAfterGuard = messageTimeoutErrorDispatches().length;
    const errorTerminalsAfterGuard = dispatchAgentErrorEventMock.mock.calls.length;

    // Late resolve of the wedged route plan — must hit the pre-watchdog-arm bail.
    resolveRoutePlan?.({ decision: { profileId: null, credentialSource: 'api-key' }, proxyRequired: false });
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    await turnPromise;

    // No model call, no duplicate terminal of any kind, latch stays released.
    expect(runAgentQueryMock).not.toHaveBeenCalled();
    expect(messageTimeoutErrorDispatches().length).toBe(terminalsAfterGuard);
    expect(dispatchAgentErrorEventMock.mock.calls.length).toBe(errorTerminalsAfterGuard);
    expect(activeTurnLatch.size).toBe(0);
    expect(councilTurnIds.has(turnId)).toBe(false);
    expect(adHocTurnIds.has(turnId)).toBe(false);
  });

  it('a late-resolving meeting-companion context dispatches NO events and mutates NO state after the guard (rework-F1)', async () => {
    vi.useFakeTimers();

    // Wedge a post-checkpoint-2 context await (getMeetingCompanionContext) that,
    // on resume, would mutate contextSections + call setLastInjectedCoachPath.
    let resolveMeeting: ((value: unknown) => void) | undefined;
    const getMeetingCompanionContext = vi.fn(() => new Promise((resolve) => { resolveMeeting = resolve; }));
    const setLastInjectedCoachPath = vi.fn();

    const turnId = 'turn-wedged-meeting';
    const turnPromise = executeAgentTurn(null, turnId, 'test', {
      sessionId: 'session-wedged-meeting',
      resetConversation: false,
      getMeetingCompanionContext: getMeetingCompanionContext as never,
      setLastInjectedCoachPath: setLastInjectedCoachPath as never,
    } as never);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PRE_DISPATCH_SETUP_TIMEOUT_MS + 1_000);

    expect(messageTimeoutErrorDispatches().length).toBeGreaterThanOrEqual(1);
    const eventCountAfterGuard = dispatchAgentEventMock.mock.calls.length;
    const errorEventCountAfterGuard = dispatchAgentErrorEventMock.mock.calls.length;

    // Late resolve with a coach payload that WOULD mutate state + dispatch.
    resolveMeeting?.({ currentCoachPath: '/coach.md', lastInjectedCoachPath: undefined, coachSkillContent: 'coach' });
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    await turnPromise;

    // No NEW events of any kind dispatched after the guard fired, no state mutation.
    expect(dispatchAgentEventMock.mock.calls.length).toBe(eventCountAfterGuard);
    expect(dispatchAgentErrorEventMock.mock.calls.length).toBe(errorEventCountAfterGuard);
    expect(setLastInjectedCoachPath).not.toHaveBeenCalled();
    expect(runAgentQueryMock).not.toHaveBeenCalled();
    expect(activeTurnLatch.size).toBe(0);
  });

  it('guard firing during the concurrent-spawn delay emits exactly ONE terminal, no duplicate user_stopped (rework-F2)', async () => {
    vi.useFakeTimers();

    // Force the concurrent-spawn-delay branch: a SECOND active turn in the latch
    // makes getActiveTurnCount() > 1. The spawn delay's delayWithAbort stays
    // PENDING until the guard's 120s deadline fires + aborts the controller,
    // then resolves true (aborted) — simulating the guard landing mid-delay.
    activeTurnLatch.add('other-concurrent-turn');
    let resolveSpawnDelay: ((aborted: boolean) => void) | undefined;
    delayWithAbortMock.mockImplementation((_ms: number, signal: AbortSignal) => new Promise<boolean>((resolve) => {
      resolveSpawnDelay = resolve;
      // Mirror real delayWithAbort: resolve true the moment the signal aborts
      // (the guard calls abortController.abort()).
      signal.addEventListener('abort', () => resolve(true), { once: true });
    }));

    const turnId = 'turn-spawn-delay-guard';
    const turnPromise = executeAgentTurn(null, turnId, 'test', {
      sessionId: 'session-spawn-delay',
      resetConversation: false,
    });

    // Let the pre-dispatch flow run up to the (now-pending) spawn delay.
    await vi.advanceTimersByTimeAsync(0);
    // Guard fires → aborts the controller → the pending delay resolves true.
    await vi.advanceTimersByTimeAsync(PRE_DISPATCH_SETUP_TIMEOUT_MS + 1_000);
    resolveSpawnDelay?.(true);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    await turnPromise;

    // Exactly one terminal: the guard's message_timeout. NO duplicate
    // "Agent turn stopped by user" status or user_stopped synthetic result.
    expect(messageTimeoutErrorDispatches().length).toBe(1);
    const stoppedStatuses = dispatchedEvents().filter(
      (e) => e.type === 'status' && typeof e.message === 'string' && (e.message as string).includes('stopped by user'),
    );
    expect(stoppedStatuses).toHaveLength(0);
    const userStoppedResults = dispatchedEvents().filter(
      (e) => e.type === 'result' && e.turnEndReason === 'user_stopped',
    );
    expect(userStoppedResults).toHaveLength(0);
    // Exactly one error-result (from the guard), latch released.
    const errorResults = dispatchedEvents().filter((e) => e.type === 'result' && e.turnEndReason === 'error');
    expect(errorResults).toHaveLength(1);
    expect(runAgentQueryMock).not.toHaveBeenCalled();
    expect(activeTurnLatch.has(turnId)).toBe(false);
  });

  it('a late MCP "Super-MCP not running" rejection after the guard dispatches NO stale status (rework2-F1)', async () => {
    vi.useFakeTimers();

    // Wedge resolveMcpServers; it later REJECTS with a Super-MCP-not-running
    // error (the graceful-degradation path that would dispatch a status event).
    let rejectMcp: ((err: Error) => void) | undefined;
    resolveMcpServersMock.mockImplementation(() => new Promise((_resolve, reject) => { rejectMcp = reject; }));

    const turnId = 'turn-wedged-mcp';
    const turnPromise = executeAgentTurn(null, turnId, 'test', {
      sessionId: 'session-wedged-mcp',
      resetConversation: false,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PRE_DISPATCH_SETUP_TIMEOUT_MS + 1_000);
    expect(messageTimeoutErrorDispatches().length).toBeGreaterThanOrEqual(1);
    const eventsAfterGuard = dispatchAgentEventMock.mock.calls.length;

    // Late rejection on the Super-MCP degradation path.
    rejectMcp?.(new Error('Super-MCP is not running'));
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    await turnPromise;

    // The "Tools are temporarily unavailable" status must NOT be dispatched.
    const toolsUnavailableStatus = dispatchedEvents().filter(
      (e) => e.type === 'status' && typeof e.message === 'string' && (e.message as string).includes('temporarily unavailable'),
    );
    expect(toolsUnavailableStatus).toHaveLength(0);
    // No NEW events of any kind after the guard.
    expect(dispatchAgentEventMock.mock.calls.length).toBe(eventsAfterGuard);
    expect(runAgentQueryMock).not.toHaveBeenCalled();
    expect(activeTurnLatch.size).toBe(0);
  });

  it('does NOT fire the guard when pre-dispatch completes normally (healthy turn dispatches)', async () => {
    const turnId = 'turn-healthy';
    await executeAgentTurn(null, turnId, 'test', {
      sessionId: 'session-healthy',
      resetConversation: false,
    });

    // Healthy turn dispatches to the model and never emits the guard terminal.
    expect(runAgentQueryMock).toHaveBeenCalledTimes(1);
    expect(messageTimeoutErrorDispatches()).toHaveLength(0);
    // Latch released by the normal completion path.
    expect(activeTurnLatch.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stage 3 (turn-hang follow-ups): the pre-dispatch terminal carries a
// `cloudWorkspaceSuspected` tag (+ breadcrumb datum) derived from the
// PRE-CAPTURED coreDirectory via the pure, I/O-free `detectCloudStorage` — and
// MUST NOT read settings again inside the timeout callback (GPT F1). NOTE: the
// real `@core/utils/cloudStorageUtils` is used here (NOT mocked) so the string
// match is exercised end-to-end.
// ---------------------------------------------------------------------------

// Extract the captureException tags for the guard's terminal.
function guardCaptureTags(): Record<string, unknown> | undefined {
  const call = captureExceptionMock.mock.calls.find((c: unknown[]) => {
    const opts = c[1] as { tags?: Record<string, unknown> } | undefined;
    return opts?.tags?.reason === 'pre_turn_setup_timeout';
  });
  return (call?.[1] as { tags?: Record<string, unknown> } | undefined)?.tags;
}

// Extract the guard breadcrumb's data.
function guardBreadcrumbData(): Record<string, unknown> | undefined {
  const call = addBreadcrumbMock.mock.calls.find((c: unknown[]) => {
    const crumb = c[0] as { message?: string } | undefined;
    return crumb?.message === '[pre-dispatch-guard] pre-turn setup timed out';
  });
  return (call?.[0] as { data?: Record<string, unknown> } | undefined)?.data;
}

describe('executeAgentTurn pre-dispatch liveness guard — cloudWorkspaceSuspected tag (Stage 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeTurnLatch.clear();
    councilTurnIds.clear();
    adHocTurnIds.clear();
    vi.useRealTimers();

    getSettingsMock.mockImplementation(() => makeSettings(process.cwd()));
    resolveModelConfigMock.mockImplementation((model: string) => ({ model, envOverrides: undefined }));
    assemblePreTurnContextMock.mockResolvedValue({
      semanticContext: null,
      suggestedTools: [],
      suggestedConversations: [],
      suggestedSkills: [],
      conversationSearchStatus: 'ok',
      toolSearchStatus: 'ok',
    });
    buildServerAccountMapMock.mockReturnValue(new Map());
    runAgentQueryMock.mockResolvedValue({ abortedByUser: false, terminatedByHandler: false });
    getSessionMock.mockResolvedValue(null);
    buildContinuationContextMock.mockResolvedValue(EMPTY_CONTINUATION);
    if (realRouteHolderRef.fn) {
      resolveProviderRoutePlanMock.mockImplementation(realRouteHolderRef.fn as (...args: unknown[]) => unknown);
    }
    delayWithAbortMock.mockImplementation(async (_ms: number, _signal: AbortSignal) => false);
    resolveMcpServersMock.mockImplementation(async () => ({ servers: undefined, mode: 'unavailable', upstreamCount: 0, configPath: undefined }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Wedge buildContinuationContext, arm + fire the guard, return after teardown.
  async function fireGuardWithWedgedSetup(turnId: string): Promise<void> {
    vi.useFakeTimers();
    let resolveBuild: ((value: unknown) => void) | undefined;
    buildContinuationContextMock.mockImplementation(() => new Promise((resolve) => { resolveBuild = resolve; }));

    const turnPromise = executeAgentTurn(null, turnId, 'test', {
      sessionId: `session-${turnId}`,
      resetConversation: false,
    });

    // Flush all the pre-dispatch setup up to the wedge (buildContinuationContext
    // stays pending). This drains every getSettings() call the NORMAL setup makes
    // before the guard's deadline, so the snapshot below isolates the guard
    // callback's own (expected: zero) reads.
    await vi.advanceTimersByTimeAsync(0);
    const settingsReadsBeforeFire = getSettingsMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(PRE_DISPATCH_SETUP_TIMEOUT_MS + 1_000);

    // F1 invariant: the guard callback must NOT call getSettings() (it uses the
    // pre-captured coreDirectory string). The setup is wedged at
    // buildContinuationContext, so the ONLY thing that runs between the snapshot
    // and the deadline is the guard's timeout callback — any increment here would
    // be a settings (fs.readFileSync-on-miss) read inside the wedge-firing guard.
    expect(getSettingsMock.mock.calls.length).toBe(settingsReadsBeforeFire);

    // Let the wedged dep resolve late and the turn settle.
    resolveBuild?.({ prefix: '', meta: undefined });
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    await turnPromise;
  }

  it('tags cloudWorkspaceSuspected=true for a cloud coreDirectory (and uses no settings read at fire time)', async () => {
    getSettingsMock.mockImplementation(() =>
      makeSettings('/Users/test/Library/CloudStorage/GoogleDrive-user@example.com/My Workspace'),
    );

    await fireGuardWithWedgedSetup('turn-cloud-core');

    expect(messageTimeoutErrorDispatches().length).toBeGreaterThanOrEqual(1);
    expect(guardCaptureTags()).toMatchObject({
      area: 'turn-pre-dispatch',
      reason: 'pre_turn_setup_timeout',
      cloudWorkspaceSuspected: true,
    });
    expect(guardBreadcrumbData()).toMatchObject({ cloudWorkspaceSuspected: true });
  });

  it('tags cloudWorkspaceSuspected=false for a local coreDirectory', async () => {
    getSettingsMock.mockImplementation(() => makeSettings('/Users/test/Documents/LocalProject'));

    await fireGuardWithWedgedSetup('turn-local-core');

    expect(guardCaptureTags()).toMatchObject({ cloudWorkspaceSuspected: false });
    expect(guardBreadcrumbData()).toMatchObject({ cloudWorkspaceSuspected: false });
  });

  it('tags cloudWorkspaceSuspected=false for a missing/empty coreDirectory (no throw)', async () => {
    // A null/empty coreDirectory derails the turn at admission (core-directory
    // validation) BEFORE the pre-dispatch wedge, so it can't fire the guard's
    // message_timeout terminal — that path is unrelated to Stage 3. The Stage-3
    // contract for a MISSING dir is precisely the input the guard computes on:
    // the pre-captured string is `coreDirectory ?? ''`, and the guard runs the
    // pure `detectCloudStorage(...).isCloud` on it. Pin that exact call is
    // false-and-no-throw for the empty string (what the guard would tag), while
    // the two firing tests above prove the guard wiring never throws.
    expect(() => detectCloudStorage('').isCloud).not.toThrow();
    expect(detectCloudStorage('').isCloud).toBe(false);
  });
});
