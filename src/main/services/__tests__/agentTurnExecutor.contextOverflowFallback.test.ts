import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBuildContinuationContextMock,
  createModelNormalizationMock,
} from './agentTurnExecutor.testHarness';

const {
  queryMock,
  dispatchAgentEventMock,
  addTurnFallbackMock,
  cleanupForRetryMock,
  resolveModelConfigMock,
  contextOverflowDispatched,
  turnPromptById,
  mockTurnLogger,
} = vi.hoisted(() => {
  const queryMock = vi.fn();
  const dispatchAgentEventMock = vi.fn();
  const addTurnFallbackMock = vi.fn();
  const cleanupForRetryMock = vi.fn();
  const resolveModelConfigMock = vi.fn();
  const contextOverflowDispatched = new Set<string>();
  const turnPromptById = new Map<string, string>();
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
    contextOverflowDispatched,
    turnPromptById,
    mockTurnLogger,
  };
});

vi.mock('@core/rebelCore/queryRouter', () => ({
  queryWithRuntime: queryMock,
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: vi.fn(),
  clearAnswerPhaseStartedSentinel: vi.fn(),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn(() => ({
    coreDirectory: process.cwd(),
    models: {
      model: 'gpt-oss-120b',
      thinkingModel: null,
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: false,
      thinkingEffort: 'medium',
      apiKey: 'test-key',
      longContextFallbackModel: 'claude-opus-4-6',
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
      profiles: [],
      activeProfileId: null,
    },
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
    setTurnPrompt: vi.fn((turnId: string, prompt: string) => {
      turnPromptById.set(turnId, prompt);
    }),
    getTurnPrompt: vi.fn((turnId: string) => turnPromptById.get(turnId)),
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
    addTurnFallback: addTurnFallbackMock,
    cleanupForRetry: cleanupForRetryMock,
    hasContextOverflowDispatched: vi.fn((turnId: string) => contextOverflowDispatched.has(turnId)),
    markContextOverflowDispatched: vi.fn((turnId: string) => {
      contextOverflowDispatched.add(turnId);
    }),
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
  getApiKeyAuthEnvVars: vi.fn(() => ({})),
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
  getTurnAggregator: vi.fn(() => ({
    pushMessage: vi.fn(),
  })),
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
}});

import { executeAgentTurn } from '../agentTurnExecutor';
import { getSettings } from '@core/services/settingsStore';

const getSettingsMock = vi.mocked(getSettings);

function makeOverflowError(): Error {
  return new Error('context window exceeded');
}

function overflowIterator() {
  async function* gen(): AsyncGenerator<never, void, unknown> {
    throw makeOverflowError();
  }
  const iter = gen() as AsyncGenerator<never, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

function defaultSettings() {
  return {
    coreDirectory: process.cwd(),
    models: {
      model: 'gpt-oss-120b',
      thinkingModel: null,
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: false,
      thinkingEffort: 'medium',
      apiKey: 'test-key',
      longContextFallbackModel: 'claude-opus-4-6',
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
      profiles: [],
      activeProfileId: null,
    },
  };
}

describe('executeAgentTurn context overflow fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextOverflowDispatched.clear();
    turnPromptById.clear();

    resolveModelConfigMock.mockImplementation((model: string) => ({
      model,
      envOverrides: undefined,
    }));
    queryMock.mockImplementation(() => overflowIterator());
  });

  it('retries once with long-context fallback model, then dispatches context_overflow', async () => {
    const turnId = 'turn-overflow-1';
    await executeAgentTurn(null, turnId, 'Summarize this conversation safely.', {
      sessionId: 'renderer-session-1',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(addTurnFallbackMock).toHaveBeenCalledWith(
      turnId,
      expect.objectContaining({
        type: 'model',
        reason: 'context-overflow-long-context-fallback',
        to: 'claude-opus-4-6',
      })
    );
    expect(cleanupForRetryMock).toHaveBeenCalledTimes(1);

    // Verify status event precedes context_overflow (ordering)
    const allEvents = dispatchAgentEventMock.mock.calls.map((c: unknown[]) => c[2] as Record<string, unknown>);
    const switchIdx = allEvents.findIndex(
      (e: Record<string, unknown>) => e.type === 'status' && typeof e.message === 'string' && (e.message as string).includes('Switching to')
    );
    const overflowIdx = allEvents.findIndex((e: Record<string, unknown>) => e.type === 'context_overflow');
    expect(switchIdx).toBeGreaterThanOrEqual(0);
    expect(overflowIdx).toBeGreaterThan(switchIdx);

    // Verify context_overflow payload includes originalPrompt
    const overflowEvent = allEvents.find((e: Record<string, unknown>) => e.type === 'context_overflow') as Record<string, unknown> | undefined;
    expect(overflowEvent).toBeDefined();
    expect(overflowEvent!.originalPrompt).toBeTruthy();
  });

  it('goes straight to compaction when no fallback is configured', async () => {
    getSettingsMock.mockReturnValue({
      ...defaultSettings(),
      models: {
        ...defaultSettings().models,
        longContextFallbackModel: undefined,
      },
    } as unknown as ReturnType<typeof getSettings>);

    const turnId = 'turn-overflow-no-fallback';
    await executeAgentTurn(null, turnId, 'Test prompt.', {
      sessionId: 'renderer-session-2',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(addTurnFallbackMock).not.toHaveBeenCalled();
    expect(cleanupForRetryMock).not.toHaveBeenCalled();
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      turnId,
      expect.objectContaining({ type: 'context_overflow' })
    );
  });

  it('skips fallback when fallback model equals current model', async () => {
    getSettingsMock.mockReturnValue({
      ...defaultSettings(),
      models: {
        ...defaultSettings().models,
        model: 'claude-opus-4-7',
        longContextFallbackModel: 'claude-opus-4-7',
      },
    } as unknown as ReturnType<typeof getSettings>);

    const turnId = 'turn-overflow-same-model';
    await executeAgentTurn(null, turnId, 'Test prompt.', {
      sessionId: 'renderer-session-3',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(addTurnFallbackMock).not.toHaveBeenCalled();
    expect(cleanupForRetryMock).not.toHaveBeenCalled();
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      turnId,
      expect.objectContaining({ type: 'context_overflow' })
    );
  });

  // FOX-2857: Non-Claude provider error messages must trigger context_overflow
  it.each([
    ['OpenAI context length', "This model's maximum context length is 128000 tokens. However, your messages resulted in 200000 tokens."],
    ['Google token count exceeds', 'input token count exceeds the maximum number of tokens allowed for model gemini-2.5-pro'],
    ['generic token exceed', 'Local model error (400): The number of input tokens exceed the model limit'],
    ['request too large (413)', 'Local model error (413): request entity too large'],
  ])('dispatches context_overflow for non-Claude error: %s', async (_label, errorText) => {
    contextOverflowDispatched.clear();
    const makeError = (): Error => new Error(errorText);
    queryMock.mockImplementation(() => {
      async function* gen(): AsyncGenerator<never, void, unknown> {
        throw makeError();
      }
      const iter = gen() as AsyncGenerator<never, void, unknown> & { close: () => void };
      iter.close = vi.fn();
      return iter;
    });

    // No fallback model → goes straight to context_overflow dispatch
    getSettingsMock.mockReturnValue({
      ...defaultSettings(),
      models: {
        ...defaultSettings().models,
        longContextFallbackModel: undefined,
      },
    } as unknown as ReturnType<typeof getSettings>);

    const turnId = `turn-non-claude-${_label.replace(/\s+/g, '-')}`;
    await executeAgentTurn(null, turnId, 'Test prompt.', {
      sessionId: `renderer-session-${turnId}`,
      resetConversation: false,
    });

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      turnId,
      expect.objectContaining({ type: 'context_overflow' })
    );
  });

});

// FOX-2871: Synthetic result events must include model from turn registry
describe('executeAgentTurn synthetic result model attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextOverflowDispatched.clear();
    turnPromptById.clear();

    resolveModelConfigMock.mockImplementation((model: string) => ({
      model,
      envOverrides: undefined,
    }));
  });

  it('includes model in synthetic result when agent completes without result message (FOX-2871)', async () => {
    const { agentTurnRegistry } = await import('../agentTurnRegistry');
    const getTurnModelMock = vi.mocked(agentTurnRegistry.getTurnModel);
    getTurnModelMock.mockReturnValue('claude-sonnet-4-20250514');

    // Iterator that completes without yielding a result message
    queryMock.mockImplementation(() => {
      async function* gen(): AsyncGenerator<never, void, unknown> {
        // empty — no result message
      }
      const iter = gen() as AsyncGenerator<never, void, unknown> & { close: () => void };
      iter.close = vi.fn();
      return iter;
    });

    const turnId = 'turn-synthetic-model';
    await executeAgentTurn(null, turnId, 'Test prompt.', {
      sessionId: 'renderer-session-synthetic',
      resetConversation: false,
    });

    const allEvents = dispatchAgentEventMock.mock.calls.map((c: unknown[]) => c[2] as Record<string, unknown>);
    const resultEvent = allEvents.find((e: Record<string, unknown>) => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.model).toBe('claude-sonnet-4-20250514');
  });
});
