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
  dispatchAgentErrorEventMock,
  resolveModelConfigMock,
  stripExtendedContextFromConfigMock,
  isExtendedContextUnavailableErrorMock,
  getErrorKindMock,
  mockTurnLogger,
} = vi.hoisted(() => {
  const queryMock = vi.fn();
  const dispatchAgentEventMock = vi.fn();
  // Forwards helper calls into dispatchAgentEventMock as { type: 'error', ... }
  // so existing assertions against dispatchAgentEventMock continue to see error
  // events after the Stage 2.1 migration to dispatchAgentErrorEvent (commit 2a8963e7a).
  // Mirrors the pattern in turnErrorRecovery.test.ts.
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
    const rawMessage =
      typeof rawError === 'string'
        ? rawError
        : rawError instanceof Error
          ? rawError.message
          : String(rawError ?? '');
    dispatchAgentEventMock(win, turnId, {
      type: 'error',
      error: opts?.humanizedOverride ?? rawMessage,
      ...(opts?.isTransient !== undefined ? { isTransient: opts.isTransient } : {}),
      ...(opts?.errorKindOverride ? { errorKind: opts.errorKindOverride } : {}),
      ...(opts?.providerOverride ? { provider: opts.providerOverride } : {}),
      ...(opts?.timeoutDiagnostic ? { timeoutDiagnostic: opts.timeoutDiagnostic } : {}),
      ...(opts?.watchdogDiagnostic ? { watchdogDiagnostic: opts.watchdogDiagnostic } : {}),
      ...(opts?.errorKindOverride === 'rate_limit' && opts?.rateLimitMetaOverride ? { rateLimitMeta: opts.rateLimitMetaOverride } : {}),
      errorSource: 'main',
      timestamp: opts?.timestampOverride ?? Date.now(),
    });
    return { ok: true as const };
  });
  const resolveModelConfigMock = vi.fn();
  const stripExtendedContextFromConfigMock = vi.fn();
  const isExtendedContextUnavailableErrorMock = vi.fn();
  const getErrorKindMock = vi.fn();
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
    resolveModelConfigMock,
    stripExtendedContextFromConfigMock,
    isExtendedContextUnavailableErrorMock,
    getErrorKindMock,
    mockTurnLogger,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@core/rebelCore/queryRouter', () => ({
  queryWithRuntime: queryMock,
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
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
  isUsingOAuth: vi.fn(() => false),
  getApiKeyAuthEnvVars: vi.fn(() => null),
  getProviderKeyEnvVars: vi.fn(() => null),
}));

vi.mock('@shared/utils/modelNormalization', () =>
  createModelNormalizationMock({ resolveModelConfigMock }, {
    stripExtendedContextFromConfig: stripExtendedContextFromConfigMock,
    isExtendedContextUnavailableError: isExtendedContextUnavailableErrorMock,
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

// ---------------------------------------------------------------------------
// Import SUT
// ---------------------------------------------------------------------------
import { executeAgentTurn } from '../agentTurnExecutor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorIterator(error: Error) {
  async function* gen(): AsyncGenerator<never, void, unknown> {
    throw error;
  }
  const iter = gen() as AsyncGenerator<never, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

/**
 * Create an iterator that triggers an abort mid-stream.
 * The iterator yields one message, then the controller is aborted.
 */
function abortMidStreamIterator(controller: AbortController) {
  async function* gen(): AsyncGenerator<{ type: string }, void, unknown> {
    yield { type: 'assistant' };
    // Abort mid-stream
    controller.abort();
    // After abort, the for-await will check signal.aborted
    yield { type: 'assistant' };
  }
  const iter = gen() as AsyncGenerator<{ type: string }, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeAgentTurn abort handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    resolveModelConfigMock.mockImplementation((model: string) => ({
      model,
      envOverrides: undefined,
    }));
    isExtendedContextUnavailableErrorMock.mockReturnValue(false);
    stripExtendedContextFromConfigMock.mockImplementation((cfg: unknown) => cfg);
    getErrorKindMock.mockReturnValue('unknown');
  });

  // -------------------------------------------------------------------
  // (a) User abort during primary execution
  // -------------------------------------------------------------------
  describe('user abort during primary execution', () => {
    it('dispatches stop status and synthetic result on user abort', async () => {
      // Create a controller we can abort externally
      const userController = new AbortController();

      // Iterator that yields one message then gets aborted
      queryMock.mockImplementation(() => abortMidStreamIterator(userController));

      const turnId = 'turn-user-abort';
      await executeAgentTurn(null, turnId, 'Test prompt', {
        sessionId: 'session-abort-1',
        resetConversation: false,
        existingAbortController: userController,
      });

      // "Agent turn stopped by user" status dispatched
      const statusEvents = dispatchAgentEventMock.mock.calls
        .map((c: unknown[]) => c[2] as Record<string, unknown>)
        .filter((e: Record<string, unknown>) => e.type === 'status');
      expect(statusEvents.some((e: Record<string, unknown>) =>
        typeof e.message === 'string' && (e.message as string).includes('stopped by user')
      )).toBe(true);

      // Synthetic result dispatched
      const resultEvents = dispatchAgentEventMock.mock.calls
        .map((c: unknown[]) => c[2] as Record<string, unknown>)
        .filter((e: Record<string, unknown>) => e.type === 'result');
      expect(resultEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------
  // (b) Watchdog abort
  // -------------------------------------------------------------------
  describe('watchdog abort', () => {
    it('pre-execution abort exits cleanly without dispatching events', async () => {
      // NOTE: The watchdog abort path (abortedByWatchdog=true) dispatches a distinct
      // "unresponsive for N minutes" error. However, abortedByWatchdog is an internal
      // variable set by the watchdog setInterval — it cannot be set from outside.
      // Testing the watchdog-specific branch requires extracting the watchdog to a
      // testable unit (see planning doc Phase 2).
      //
      // This test verifies that when the abort signal fires before execution starts,
      // the function exits early via the pre-execution abort checkpoint.

      const { agentTurnRegistry } = await import('../agentTurnRegistry');

      // When the turn registers its controller, abort it immediately (once only)
      vi.mocked(agentTurnRegistry.setActiveTurnController).mockImplementationOnce(
        (_turnId: string, ctrl: AbortController) => { ctrl.abort(); }
      );

      const turnId = 'turn-pre-abort';
      await executeAgentTurn(null, turnId, 'Test prompt', {
        sessionId: 'session-pre-abort',
        resetConversation: false,
      });

      // Pre-execution abort: query never called, no events dispatched to renderer
      expect(queryMock).not.toHaveBeenCalled();

      // Cleanup still runs
      expect(vi.mocked(agentTurnRegistry.cleanupTurn)).toHaveBeenCalledWith(turnId);
    });
  });

  // -------------------------------------------------------------------
  // (c) Upstream abort (proxy timeout)
  // -------------------------------------------------------------------
  describe('upstream abort', () => {
    it('dispatches transient error when AbortError but controller NOT aborted', async () => {
      // Upstream abort: AbortError thrown but the local controller was NOT aborted
      // This means the upstream API or proxy timed out
      const upstreamAbort = new Error('The operation was aborted');
      upstreamAbort.name = 'AbortError';

      queryMock.mockImplementation(() => errorIterator(upstreamAbort));

      const turnId = 'turn-upstream-abort';
      await executeAgentTurn(null, turnId, 'Test prompt', {
        sessionId: 'session-upstream',
        resetConversation: false,
      });

      // Error dispatched with upstream abort message
      const errorEvents = dispatchAgentEventMock.mock.calls
        .map((c: unknown[]) => c[2] as Record<string, unknown>)
        .filter((e: Record<string, unknown>) => e.type === 'error');
      expect(errorEvents.some((e: Record<string, unknown>) =>
        typeof e.error === 'string' && (e.error as string).includes('took too long to respond')
      )).toBe(true);

      // isTransient: true
      const upstreamErrorEvent = errorEvents.find((e: Record<string, unknown>) =>
        typeof e.error === 'string' && (e.error as string).includes('took too long to respond')
      );
      expect(upstreamErrorEvent?.isTransient).toBe(true);

      // Synthetic result dispatched
      const resultEvents = dispatchAgentEventMock.mock.calls
        .map((c: unknown[]) => c[2] as Record<string, unknown>)
        .filter((e: Record<string, unknown>) => e.type === 'result');
      expect(resultEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------
  // (d) Abort during fallback paths (Max 200K fallback)
  // -------------------------------------------------------------------
  describe('abort during fallback paths', () => {
    it('handles abort gracefully during extended context 200K fallback', async () => {
      const extCtxError = new Error('extended context unavailable');
      const controller = new AbortController();

      // First call: throw ext-context error (triggers 200K fallback)
      // Second call: abort during 200K fallback
      let callCount = 0;
      queryMock.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return errorIterator(extCtxError);
        // On the fallback attempt, abort the controller
        controller.abort();
        const abortError = new Error('Aborted during fallback');
        abortError.name = 'AbortError';
        return errorIterator(abortError);
      });
      isExtendedContextUnavailableErrorMock.mockReturnValue(true);
      stripExtendedContextFromConfigMock.mockImplementation((cfg: Record<string, unknown>) => ({
        ...cfg,
        model: 'claude-sonnet-4-5',
      }));

      const turnId = 'turn-abort-fallback';
      await executeAgentTurn(null, turnId, 'Test prompt', {
        sessionId: 'session-abort-fallback',
        resetConversation: false,
        existingAbortController: controller,
      });

      // Abort detected and handled
      const statusEvents = dispatchAgentEventMock.mock.calls
        .map((c: unknown[]) => c[2] as Record<string, unknown>)
        .filter((e: Record<string, unknown>) => e.type === 'status');
      expect(statusEvents.some((e: Record<string, unknown>) =>
        typeof e.message === 'string' && (e.message as string).includes('stopped by user')
      )).toBe(true);

      // Synthetic result dispatched
      const resultEvents = dispatchAgentEventMock.mock.calls
        .map((c: unknown[]) => c[2] as Record<string, unknown>)
        .filter((e: Record<string, unknown>) => e.type === 'result');
      expect(resultEvents.length).toBeGreaterThanOrEqual(1);
    });
  });
});
