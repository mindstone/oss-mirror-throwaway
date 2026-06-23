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
  addTurnFallbackMock,
  cleanupForRetryMock,
  resolveModelConfigMock,
  stripExtendedContextFromConfigMock,
  isExtendedContextUnavailableErrorMock,
  isThinkingModelUnavailableErrorMock,
  downgradeThinkingModelConfigMock,
  getErrorKindMock,
  isTransientErrorMock,
  isRateLimitMessageMock,
  incrementRetryCountMock,
  getRetryCountMock,
  setTurnAuthMethodMock,
  setTurnExtendedContextMock,
  captureMessageMock,
  mockTurnLogger,
} = vi.hoisted(() => {
  const queryMock = vi.fn();
  const dispatchAgentEventMock = vi.fn();
  const addTurnFallbackMock = vi.fn();
  const cleanupForRetryMock = vi.fn();
  const resolveModelConfigMock = vi.fn();
  const stripExtendedContextFromConfigMock = vi.fn();
  const isExtendedContextUnavailableErrorMock = vi.fn();
  const isThinkingModelUnavailableErrorMock = vi.fn();
  const downgradeThinkingModelConfigMock = vi.fn();
  const getErrorKindMock = vi.fn();
  const isTransientErrorMock = vi.fn();
  const isRateLimitMessageMock = vi.fn();
  const incrementRetryCountMock = vi.fn();
  const getRetryCountMock = vi.fn();
  const setTurnAuthMethodMock = vi.fn();
  const setTurnExtendedContextMock = vi.fn();
  const captureMessageMock = vi.fn();
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
    addTurnFallbackMock,
    cleanupForRetryMock,
    resolveModelConfigMock,
    stripExtendedContextFromConfigMock,
    isExtendedContextUnavailableErrorMock,
    isThinkingModelUnavailableErrorMock,
    downgradeThinkingModelConfigMock,
    getErrorKindMock,
    isTransientErrorMock,
    isRateLimitMessageMock,
    incrementRetryCountMock,
    getRetryCountMock,
    setTurnAuthMethodMock,
    setTurnExtendedContextMock,
    captureMessageMock,
    mockTurnLogger,
  };
});

// ---------------------------------------------------------------------------
// Module mocks (must mirror existing test patterns exactly)
// ---------------------------------------------------------------------------

vi.mock('@core/rebelCore/queryRouter', () => ({
  queryWithRuntime: queryMock,
}));

vi.mock('@core/rebelCore/clientFactory', () => ({
  resolveTargetForModel: vi.fn(() => { throw new Error('mock: no target'); }),
  createClientFromTarget: vi.fn(() => ({ streamChat: vi.fn(), capabilities: {} })),
  targetNeedsProxy: vi.fn(() => false),
  createClientForModel: vi.fn(() => { throw new Error('mock: no client'); }),
}));

vi.mock('../powerSaveBlockerService', () => ({
  acquireBlock: vi.fn(() => ({ release: vi.fn() })),
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: vi.fn(),
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
    setTurnPrivateMode: vi.fn(),
    setTurnCategory: vi.fn(),
    setTurnLogger: vi.fn(),
    getTurnLogger: vi.fn(() => mockTurnLogger),
    deleteTurnLogger: vi.fn(),
    deleteContextAccumulator: vi.fn(),
    cleanupTurn: vi.fn(),
    setTurnPrompt: vi.fn(),
    getTurnPrompt: vi.fn(() => undefined),
    setTurnExtendedContext: setTurnExtendedContextMock,
    setTurnThinkingEffort: vi.fn(),
    setTurnAuthMethod: setTurnAuthMethodMock,
    setTurnPlanningModel: vi.fn(),
    setTurnFastModel: vi.fn(),
    getActiveTurnCount: vi.fn(() => 1),
    setTurnSpawnDelayed: vi.fn(),
    getTurnSpawnDelayed: vi.fn(() => false),
    getTurnModel: vi.fn(() => null),
      getTurnActiveProvider: vi.fn(() => undefined),
      setTurnActiveProvider: vi.fn(),
    setTurnModel: vi.fn(),
    addTurnFallback: addTurnFallbackMock,
    cleanupForRetry: cleanupForRetryMock,
    hasContextOverflowDispatched: vi.fn(() => false),
    markContextOverflowDispatched: vi.fn(),
    markExtendedContextFailed: vi.fn(),
    clearExtendedContextFailed: vi.fn(),
    hasExtendedContextFailed: vi.fn(() => false),
    getRendererSession: vi.fn(() => null),
    hasActionableErrorDispatched: vi.fn(() => false),
    getRetryCount: getRetryCountMock,
    incrementRetryCount: incrementRetryCountMock,
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
    getUrl: vi.fn(() => 'http://localhost:0'),
    getAuthToken: vi.fn(() => 'mock-token'),
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
  getProviderKeyEnvVars: vi.fn(() => null),
}));

vi.mock('@shared/utils/modelNormalization', () =>
  createModelNormalizationMock({ resolveModelConfigMock }, {
    stripExtendedContextFromConfig: stripExtendedContextFromConfigMock,
    isExtendedContextUnavailableError: isExtendedContextUnavailableErrorMock,
    isThinkingModelUnavailableError: isThinkingModelUnavailableErrorMock,
    downgradeThinkingModelConfig: downgradeThinkingModelConfigMock,
    getModelDisplayName: vi.fn((id: string) => id),
  }));

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
  cleanupTurnAggregator: vi.fn(),
  mainTracking: { chatSessionCreated: vi.fn() },
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn(() => ({
    captureException: vi.fn(),
    captureMessage: captureMessageMock,
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
  isTransientError: isTransientErrorMock,
  isNetworkError: vi.fn(() => false),
  isRateLimitMessage: isRateLimitMessageMock,
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
  delayWithAbort: vi.fn(async () => false), // never aborted
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

// ---------------------------------------------------------------------------
// Import SUT (after mocks)
// ---------------------------------------------------------------------------
import { executeAgentTurn } from '../agentTurnExecutor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let retryCountsByTurn = new Map<string, number>();

/** Create an async iterator that throws a specific error. */
function errorIterator(error: Error) {
  async function* gen(): AsyncGenerator<never, void, unknown> {
    throw error;
  }
  const iter = gen() as AsyncGenerator<never, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

/** Create an async iterator that yields a result successfully. */
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

describe('executeAgentTurn fallback chains', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retryCountsByTurn = new Map();

    // Default behaviour: resolve model config pass-through, no special errors
    resolveModelConfigMock.mockImplementation((model: string) => ({
      model,
      envOverrides: undefined,
    }));
    isExtendedContextUnavailableErrorMock.mockReturnValue(false);
    isThinkingModelUnavailableErrorMock.mockReturnValue(false);
    downgradeThinkingModelConfigMock.mockImplementation((cfg: unknown) => cfg);
    stripExtendedContextFromConfigMock.mockImplementation((cfg: unknown) => cfg);
    getErrorKindMock.mockReturnValue('unknown');
    isTransientErrorMock.mockReturnValue(false);
    isRateLimitMessageMock.mockReturnValue(false);
    getRetryCountMock.mockImplementation((turnId: string) => retryCountsByTurn.get(turnId) ?? 0);
    incrementRetryCountMock.mockImplementation((turnId: string) => {
      const nextRetryCount = (retryCountsByTurn.get(turnId) ?? 0) + 1;
      retryCountsByTurn.set(turnId, nextRetryCount);
      return nextRetryCount;
    });

    // Default query: throws a generic error
    queryMock.mockImplementation(() => errorIterator(new Error('generic failure')));
  });

  // -------------------------------------------------------------------
  // (a) Extended context 1M → 200K fallback
  // -------------------------------------------------------------------
  describe('extended context 1M → 200K fallback', () => {
    it('strips extended context and retries on success', async () => {
      const extCtxError = new Error('extended context unavailable');

      // First call: throw extended-context error
      // Second call: succeed
      let callCount = 0;
      queryMock.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return errorIterator(extCtxError);
        return successIterator();
      });
      isExtendedContextUnavailableErrorMock.mockReturnValue(true);
      stripExtendedContextFromConfigMock.mockImplementation((cfg: Record<string, unknown>) => ({
        ...cfg,
        model: 'claude-sonnet-4-5',
      }));

      const turnId = 'turn-ext-ctx-fallback';
      await executeAgentTurn(null, turnId, 'Test prompt', {
        sessionId: 'session-ext-ctx',
        resetConversation: false,
      });

      expect(queryMock).toHaveBeenCalledTimes(2);
      expect(stripExtendedContextFromConfigMock).toHaveBeenCalled();
      expect(setTurnExtendedContextMock).toHaveBeenCalledWith(turnId, false);

      // Verify status message about 1M not available
      const statusEvents = dispatchAgentEventMock.mock.calls
        .map((c: unknown[]) => c[2] as Record<string, unknown>)
        .filter((e: Record<string, unknown>) => e.type === 'status');
      expect(statusEvents.some((e: Record<string, unknown>) =>
        typeof e.message === 'string' && (e.message as string).includes('1M context not available')
      )).toBe(true);

      // Verify fallback recorded
      expect(addTurnFallbackMock).toHaveBeenCalledWith(
        turnId,
        expect.objectContaining({
          type: 'context',
          from: '1M',
          to: '200K',
          reason: 'extended-context-unavailable',
        })
      );
    });

    // Extended context 1M → 200K fallback:
    // Tested directly in turnErrorRecovery.test.ts § handleExtendedContextFallback.
    // The extracted handler is independently testable without the full executor mock setup.
  });

  // -------------------------------------------------------------------
  // (c) Thinking model downgrade (Opus → fallback)
  // -------------------------------------------------------------------
  describe('Thinking model downgrade', () => {
    it('downgrades thinking model when preferred model is unavailable', async () => {
      const opusError = new Error('opus unavailable');
      let callCount = 0;
      queryMock.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return errorIterator(opusError);
        return successIterator();
      });
      isThinkingModelUnavailableErrorMock.mockReturnValue(true);
      downgradeThinkingModelConfigMock.mockReturnValue({
        model: 'claude-opus-4-6',
        envOverrides: { PLANNING_MODEL: 'claude-opus-4-6-20260205' },
      });
      resolveModelConfigMock.mockReturnValue({
        model: 'claude-opus-4-7',
        envOverrides: { PLANNING_MODEL: 'claude-opus-4-7-20260320' },
      });

      const turnId = 'turn-opus-downgrade';
      await executeAgentTurn(null, turnId, 'Test prompt', {
        sessionId: 'session-opus',
        resetConversation: false,
      });

      expect(queryMock).toHaveBeenCalledTimes(2);

      // Status mentions the fallback model
      const statusEvents = dispatchAgentEventMock.mock.calls
        .map((c: unknown[]) => c[2] as Record<string, unknown>)
        .filter((e: Record<string, unknown>) => e.type === 'status');
      expect(statusEvents.some((e: Record<string, unknown>) =>
        typeof e.message === 'string' && (e.message as string).includes('claude-opus-4-6')
      )).toBe(true);

      // Fallback recorded
      expect(addTurnFallbackMock).toHaveBeenCalledWith(
        turnId,
        expect.objectContaining({
          type: 'model',
          reason: 'model-unavailable',
        })
      );
    });

    it('does not retry when already on fallback model (configChanged=false)', async () => {
      const opusError = new Error('opus unavailable');
      queryMock.mockImplementation(() => errorIterator(opusError));
      isThinkingModelUnavailableErrorMock.mockReturnValue(true);

      // downgrade returns same config → configChanged = false
      const sameConfig = { model: 'claude-opus-4-6', envOverrides: undefined };
      resolveModelConfigMock.mockReturnValue(sameConfig);
      downgradeThinkingModelConfigMock.mockReturnValue(sameConfig);

      const turnId = 'turn-opus-already-fallback';
      await executeAgentTurn(null, turnId, 'Test prompt', {
        sessionId: 'session-opus-same',
        resetConversation: false,
      });

      // Only the original query — no retry
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(addTurnFallbackMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // (d) Alt-model → Claude fallback
  // -------------------------------------------------------------------
  describe('alt-model → Claude fallback', () => {
    it('falls back to Claude after exhausting fast retry', async () => {
      const serverError = new Error('server_error from proxy');

      // All calls throw server error (except the Claude fallback)
      let callCount = 0;
      queryMock.mockImplementation(() => {
        callCount++;
        // Call 1: original query (alt-model) → server error
        // Call 2: fast retry (alt-model) → server error
        // Call 3: Claude fallback → success
        if (callCount <= 2) return errorIterator(serverError);
        return successIterator();
      });

      getErrorKindMock.mockReturnValue('server_error');

      // Use settings with an active local model profile to set isDirectRoleProfile=true
      const { getSettings } = await import('@core/services/settingsStore');
      vi.mocked(getSettings).mockReturnValue({
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
        localModel: {
          profiles: [{ id: 'gpt-4o-profile', name: 'GPT-4o', model: 'gpt-4o', baseUrl: 'http://proxy', apiKey: 'k' }],
          activeProfileId: 'gpt-4o-profile',
        },
      } as unknown as ReturnType<typeof getSettings>);


      const turnId = 'turn-alt-model';
      await executeAgentTurn(null, turnId, 'Test prompt', {
        sessionId: 'session-alt',
        resetConversation: false,
      });

      // Alt-model fallback uses one fast retry on the proxy model, then switches to the
      // configured fallback model (only after the fallback route is proven dispatchable).

      // Sentry breadcrumb captured
      expect(captureMessageMock).toHaveBeenCalledWith(
        'Alt-model fallback',
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({
            component: 'alt-model-fallback',
          }),
        })
      );

      // Fallback recorded with proxy-server-error
      expect(addTurnFallbackMock).toHaveBeenCalledWith(
        turnId,
        expect.objectContaining({
          type: 'model',
          reason: 'proxy-server-error',
        })
      );
    });
  });

  // -------------------------------------------------------------------
  // (e) Server error retry
  // Tested directly in turnErrorRecovery.test.ts § handleServerErrorRetry:
  // - "retries via retryTurn when retry count < 2"
  // - "dispatches error when retries exhausted (count >= 2)"
  // The extracted handler is independently testable without recursive executor calls.
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // (f) Rate limit handling
  // Tested directly in turnErrorRecovery.test.ts § handleRateLimitFallback:
  // - "shows error when rate limited (no fallback)"
  // The extracted handler is independently testable without full executor mock setup.
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // (g) Transient retry after only synthetic system:* messages
  //
  // End-to-end regression for rebel://conversation/10d9eec1-...:
  // verifies that the executor's onMessage callback correctly filters
  // synthetic system:* messages from messageCount, so a transient error
  // after only system:init / system:status is silently retried instead
  // of surfaced to the user.
  //
  // The unit-level behaviour of isApiOutputMessage is covered in
  // agentTurnUtils.test.ts. The handler-level behaviour is covered in
  // turnErrorRecovery.test.ts ("retries silently when messageCount === 0").
  // This test closes the wiring gap between them.
  // -------------------------------------------------------------------
  describe('Transient retry after synthetic system messages', () => {
    it('retries silently when only system:init/status precede a transient error', async () => {
      const transientError = new Error('Connection error.');
      let callCount = 0;
      queryMock.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Yield ONLY synthetic system:* messages, then throw.
          // Pre-fix: messageCount === 2 → transient retry guard tripped → user-visible error.
          // Post-fix: isApiOutputMessage filters both → messageCount === 0 → silent retry.
          async function* gen(): AsyncGenerator<{ type: string; subtype?: string; message?: string }, void, unknown> {
            yield { type: 'system', subtype: 'init' };
            yield { type: 'system', subtype: 'status', message: 'Planning approach...' };
            throw transientError;
          }
          const iter = gen() as AsyncGenerator<{ type: string }, void, unknown> & { close: () => void };
          iter.close = vi.fn();
          return iter;
        }
        return successIterator();
      });
      isTransientErrorMock.mockReturnValue(true);

      await executeAgentTurn(null, 'turn-transient-after-system', 'hello', {
        sessionId: 'session-transient',
        resetConversation: false,
      });

      // Two query attempts = silent retry happened. Pre-fix this would have been 1.
      expect(queryMock).toHaveBeenCalledTimes(2);
      expect(cleanupForRetryMock).toHaveBeenCalledWith('turn-transient-after-system');
    });

    it('does NOT retry when an assistant message precedes the transient error (preserves duplicate-prevention invariant)', async () => {
      const transientError = new Error('Connection error.');
      let callCount = 0;
      queryMock.mockImplementation(() => {
        callCount++;
        async function* gen(): AsyncGenerator<{ type: string; subtype?: string; message?: { role: string; content: unknown[] } }, void, unknown> {
          yield { type: 'system', subtype: 'init' };
          // Real API output — would be duplicated by retry.
          yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } };
          throw transientError;
        }
        const iter = gen() as AsyncGenerator<{ type: string }, void, unknown> & { close: () => void };
        iter.close = vi.fn();
        return iter;
      });
      isTransientErrorMock.mockReturnValue(true);

      await executeAgentTurn(null, 'turn-transient-after-assistant', 'hello', {
        sessionId: 'session-transient-assistant',
        resetConversation: false,
      });

      // Only ONE query attempt — assistant content was emitted, retry would duplicate.
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(cleanupForRetryMock).not.toHaveBeenCalled();
    });
  });
});
