import { vi } from 'vitest';
import { createModelNormalizationMock } from '@shared/__tests__/testModuleMocks';

/**
 * Guards mocked module export names only. This catches renamed/removed exports,
 * not value semantics or function signatures.
 */
type ModuleExportNameGuard<TModule> = Partial<Record<keyof TModule, unknown>>;
type SettingsStoreMock = ModuleExportNameGuard<typeof import('@core/services/settingsStore')>;

export { createModelNormalizationMock };

export interface MockTurnLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
  flushSessionLogs: ReturnType<typeof vi.fn>;
  sessionLogPath: string;
}

export interface MockFactories {
  queryMock: ReturnType<typeof vi.fn>;
  dispatchAgentEventMock: ReturnType<typeof vi.fn>;
  dispatchAgentErrorEventMock: ReturnType<typeof vi.fn>;
  mockTurnLogger: MockTurnLogger;
  resolveModelConfigMock: ReturnType<typeof vi.fn>;
  buildCouncilConfigMock: ReturnType<typeof vi.fn>;
  resolveCouncilLeadModelMock: ReturnType<typeof vi.fn>;
  detectModelReferencesMock: ReturnType<typeof vi.fn>;
  buildAdHocAgentConfigMock: ReturnType<typeof vi.fn>;
  detectClaudeModelReferencesMock: ReturnType<typeof vi.fn>;
  buildClaudeSubagentConfigMock: ReturnType<typeof vi.fn>;
  getThinkingProfileMock: ReturnType<typeof vi.fn>;
  getWorkingProfileMock: ReturnType<typeof vi.fn>;
  addRoutesMock: ReturnType<typeof vi.fn>;
  getAndResetTurnStatsMock: ReturnType<typeof vi.fn>;
  removeRoutesMock: ReturnType<typeof vi.fn>;
  getUrlMock: ReturnType<typeof vi.fn>;
  getAuthTokenMock: ReturnType<typeof vi.fn>;
  getWorkingModelProfileMock: ReturnType<typeof vi.fn>;
  resolveMcpServersMock: ReturnType<typeof vi.fn>;
  resolveSystemPromptMock: ReturnType<typeof vi.fn>;
  buildConnectedPackagesMock: ReturnType<typeof vi.fn>;
  getAuthEnvVarsMock: ReturnType<typeof vi.fn>;
  // For runtimeRouting
  runAgentQueryMock?: ReturnType<typeof vi.fn>;
  superMcpGetStateMock?: ReturnType<typeof vi.fn>;
}

export function createMockFactories(): MockFactories {
  const queryMock = vi.fn();
  const dispatchAgentEventMock = vi.fn();
  const dispatchAgentErrorEventMock = vi.fn();
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
}

export function createDefaultSettings() {
  return {
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

export function successIterator() {
  async function* gen(): AsyncGenerator<{ type: string }, void, unknown> {
    yield { type: 'result' };
  }
  const iter = gen() as AsyncGenerator<{ type: string }, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

export function captureOptions(queryMock: ReturnType<typeof vi.fn>, callIndex = 0) {
  const turnParams = queryMock.mock.calls[callIndex][0] as Record<string, unknown>;
  return turnParams;
}

// ============================================================================
// Module Mock Builders
// ============================================================================

export function createAgentEventDispatcherMock(f: MockFactories) {
  return {
    dispatchAgentEvent: f.dispatchAgentEventMock,
    dispatchAgentErrorEvent: f.dispatchAgentErrorEventMock,
  };
}

export function createLoggerMock(f: MockFactories) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    createTurnSessionLogger: vi.fn(() => f.mockTurnLogger),
    createScopedLogger: vi.fn(() => f.mockTurnLogger),
    runWithTurnContext: vi.fn(async (_ctx: unknown, fn: () => Promise<void>) => fn()),
  };
}

export function createSettingsStoreMock() {
  const mock = {
    setSettingsStoreAdapter: vi.fn(),
    getSettings: vi.fn(() => createDefaultSettings()),
    updateSettings: vi.fn(),
    updateSettingsAtomic: vi.fn(),
    onSettingsChange: vi.fn(() => () => undefined),
  } satisfies SettingsStoreMock;
  return mock;
}

export function createAgentTurnRegistryMock(f: MockFactories) {
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
      getTurnLogger: vi.fn(() => f.mockTurnLogger),
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
      getUpstreamActivity: vi.fn(() => null),
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
    },
    cleanupTurnAggregator: vi.fn(),
    cleanupPendingApprovals: vi.fn(),
  };
}

export function createLocalModelProxyServerMock(f: MockFactories) {
  return {
    proxyManager: {
      addRoutes: f.addRoutesMock,
      getAndResetTurnStats: f.getAndResetTurnStatsMock,
      removeRoutes: f.removeRoutesMock,
      getUrl: f.getUrlMock,
      getAuthToken: f.getAuthTokenMock,
    },
  };
}

export function createCouncilServiceMock(f: MockFactories) {
  return {
    buildCouncilConfig: f.buildCouncilConfigMock,
    resolveCouncilLeadModel: f.resolveCouncilLeadModelMock,
    buildAvailableModelsPrompt: vi.fn(() => ''),
  };
}

export function createAdHocAgentServiceMock(f: MockFactories) {
  return {
    detectModelReferences: f.detectModelReferencesMock,
    buildAdHocAgentConfig: f.buildAdHocAgentConfigMock,
  };
}

export function createClaudeMentionAgentServiceMock(f: MockFactories) {
  return {
    CLAUDE_MENTION_TARGETS: [],
    detectClaudeModelReferences: f.detectClaudeModelReferencesMock,
    buildClaudeSubagentConfig: f.buildClaudeSubagentConfigMock,
  };
}

export function createMcpServiceMock(f: MockFactories) {
  return {
    resolveMcpServers: f.resolveMcpServersMock,
    resolveSystemPrompt: f.resolveSystemPromptMock,
    buildConnectedPackages: f.buildConnectedPackagesMock,
    buildServerAccountMap: vi.fn(() => new Map()),
    buildFrequentToolGroups: vi.fn(() => []),
    reportMcpError: vi.fn(),
  };
}

export function createToolSafetyServiceMock() {
  return {
    createToolSafetyHook: vi.fn(() => undefined),
    createCanUseTool: vi.fn(() => undefined),
    cleanupPendingApprovals: vi.fn(),
    cleanupSessionPendingApprovals: vi.fn(),
  };
}

export function createMemoryWriteHookMock() {
  return {
    createMemoryWriteHook: vi.fn(() => undefined),
    createCheckpointIntegrityHook: vi.fn(() => undefined),
    clearCheckpointLockedState: vi.fn(),
  };
}

export function createStagedReadHookMock() {
  return {
    createStagedReadHook: vi.fn(() => undefined),
  };
}

export function createFileConversationTrackingHookMock() {
  return {
    createFileConversationTrackingHook: vi.fn(() => undefined),
  };
}

export function createAutoContinueHookMock() {
  return {
    createAutoContinueHook: vi.fn(() => undefined),
  };
}

export function createAutoContinueCacheMock() {
  return {
    cleanupAutoContinueCache: vi.fn(),
  };
}

export function createPendingApprovalsStoreMock() {
  return {
    getPendingApprovals: vi.fn(() => []),
    getPendingMemoryApprovals: vi.fn(() => []),
    clearPendingApprovalsForSession: vi.fn(),
  };
}

export function createAgentMessageHandlerMock() {
  return {
    handleAgentMessage: vi.fn(),
  };
}

export function createSystemUtilsMock() {
  return {
    setupNodeEnvironment: vi.fn(),
    resolveLibraryPath: vi.fn(() => null),
  };
}

export function createAuthEnvUtilsMock(f: MockFactories) {
  return {
    getAuthEnvVars: f.getAuthEnvVarsMock,
    hasValidAuth: vi.fn(() => true),
    isUsingOpenRouter: vi.fn((settings: { activeProvider?: string }) => settings.activeProvider === 'openrouter'),
    isUsingOAuth: vi.fn(() => false),
    getApiKeyAuthEnvVars: vi.fn(() => null),
    getProviderKeyEnvVars: vi.fn(() => null),
  };
}

export function createSettingsUtilsMock(f: MockFactories) {
  return {
    getThinkingProfile: f.getThinkingProfileMock,
    getWorkingProfile: f.getWorkingProfileMock,
  };
}

export function createSemanticContextServiceMock() {
  return {
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
  };
}

export function createConversationContextServiceMock() {
  return {
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
  };
}

export function createConversationHistoryServiceMock() {
  return {
    loadConversationHistory: vi.fn(async () => ''),
    buildConversationHistoryContext: vi.fn(() => ''),
    loadIntelligentConversationHistory: vi.fn(async () => ''),
  };
}

/**
 * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`:
 * mock for `@core/services/buildContinuationContext`. Defaults to the
 * empty/no-op shape; tests asserting on prompt-assembly behaviour MUST
 * pass an explicit non-empty `prefix` via `mockResponse`.
 */
export function createBuildContinuationContextMock(mockResponse?: {
  prefix?: string;
  meta?: Partial<{
    headerIncluded: boolean;
    headerBytes: number;
    historyIncluded: boolean;
    historyBytes: number;
    truncated: boolean;
  }>;
}) {
  const meta = {
    headerIncluded: false,
    headerBytes: 0,
    historyIncluded: false,
    historyBytes: 0,
    truncated: false,
    ...(mockResponse?.meta ?? {}),
  };
  const result = { prefix: mockResponse?.prefix ?? '', meta };
  return {
    buildContinuationContext: vi.fn(async () => result),
  };
}

export function createAgentTurnFormattersMock() {
  return {
    formatFrequentToolsContext: vi.fn(() => undefined),
    formatConnectedPackagesContext: vi.fn(() => undefined),
    formatSuggestedToolsContext: vi.fn(() => undefined),
    extractParamHints: vi.fn(() => ''),
    isEmptyParamSchema: vi.fn(() => false),
  };
}

export function createConversationIndexServiceMock() {
  return {
    searchConversations: vi.fn(async () => []),
  };
}

export function createToolIndexServiceMock() {
  return {
    searchTools: vi.fn(async () => []),
    hasToolIndex: vi.fn(() => false),
  };
}

export function createTrackingMock() {
  return {
    getTurnAggregator: vi.fn(() => ({ pushMessage: vi.fn() })),
    cleanupTurnAggregator: vi.fn(),
    mainTracking: {
      chatSessionCreated: vi.fn(),
      council: {
        skippedMember: vi.fn(),
        blocked: vi.fn(),
      },
    },
  };
}

export function createErrorReporterMock() {
  return {
    getErrorReporter: vi.fn(() => ({
      captureException: vi.fn(),
      captureMessage: vi.fn(),
    })),
  };
}

export function createIncrementalSessionStoreMock() {
  return {
    getIncrementalSessionStore: vi.fn(() => ({
      getSession: vi.fn(async () => null),
    })),
  };
}

export function createConstantsMock() {
  return {
    KNOWLEDGE_WORKER_AGENT_NAME: 'Rebel',
    KNOWLEDGE_WORKER_AGENT_DESCRIPTION: 'Test',
  };
}

export function createPromptCacheWarmupServiceMock() {
  return {
    updateLastApiCallTime: vi.fn(),
  };
}

export function createMcpServerAliasMock() {
  return {
    aliasMcpServersForClaudeSdk: vi.fn((servers: unknown) => servers),
  };
}



export function createFriendlyErrorsMock() {
  return {
    humanizeError: vi.fn((msg: string) => msg),
    isTransientError: vi.fn(() => false),
    isRateLimitMessage: vi.fn(() => false),
    isNetworkError: vi.fn(() => false),
    extractRetryAfterMs: vi.fn(() => undefined),
  };
}

/**
 * Mock factory for `@shared/utils/agentErrorCatalog`.
 *
 * Spreads the real exports via `importOriginal` so consumers transitively
 * importing constants like `AGENT_ERROR_KINDS` (used by Zod schemas in
 * `src/shared/ipc/schemas/agent.ts`) still see them. Only the routed-error
 * helpers are stubbed.
 *
 * Usage:
 *   vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) =>
 *     createAgentErrorCatalogMock(importOriginal));
 */
export async function createAgentErrorCatalogMock(
  importOriginal: () => Promise<unknown>,
) {
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
}

export function createToolNameValidationMock() {
  return {
    isToolNameLengthError: vi.fn(() => false),
  };
}

export function createDelayWithAbortMock() {
  return {
    delayWithAbort: vi.fn(async () => false),
  };
}

export function createApiRateLimitCooldownMock() {
  return {
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
  };
}

export function createCostLedgerServiceMock() {
  return {
    appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id-harness' })),
  };
}

export function createPricingCalculatorMock() {
  return {
    calculateCost: vi.fn(() => 0),
  };
}

export function createAgentTurnUtilsMock(actual: typeof import('../../utils/agentTurnUtils')) {
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
}
