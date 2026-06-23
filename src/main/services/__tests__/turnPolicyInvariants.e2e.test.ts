import { describe, expect, it, vi } from 'vitest';
import type { AgentTurnRequest } from '@shared/types';
import type { SessionType } from '@core/services/promptTemplateService';
import type { TurnPolicy } from '@core/types/turnPolicy';
import { derivePolicy, getDefaultPolicyForSessionType } from '@core/services/turnPolicy';
import { startAgentTurn, type AgentTurnServiceDeps } from '@core/services/agentTurnService';
import { localTurnLimiter } from '@core/services/turnConcurrencyLimiter';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { AUTOMATION_HARD_CEILING_MS } from '@core/services/turnPipeline/watchdogConstants';
import { createBuildContinuationContextMock } from './agentTurnExecutor.testHarness';

const {
  queryMock,
  runAgentQueryMock,
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  resolveModelConfigMock,
  resolveMcpServersMock,
  resolveSystemPromptMock,
  buildConnectedPackagesMock,
  buildServerAccountMapMock,
  mockTurnLogger,
  assemblePreTurnContextMock,
  parseConversationSearchKeywordMock,
  loadFilterAndFormatConversationsMock,
  searchConversationsMock,
  prefetchDocumentsMock,
  formatPrefetchedDocumentsContextMock,
  createMcpPrefetchFnMock,
  resolveActiveServerInstancesMock,
  searchToolsMock,
  hasToolIndexMock,
  getToolIndexStatusMock,
  getPendingApprovalsMock,
  getPendingMemoryApprovalsMock,
  chatSessionCreatedMock,
  listSessionsMock,
} = vi.hoisted(() => {
  const mockTurnLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    flushSessionLogs: vi.fn(async () => {}),
    sessionLogPath: '/tmp/test-turn-policy-invariants.log',
  };

  return {
    queryMock: vi.fn(),
    runAgentQueryMock: vi.fn(),
    dispatchAgentEventMock: vi.fn(),
    dispatchAgentErrorEventMock: vi.fn(),
    resolveModelConfigMock: vi.fn(),
    resolveMcpServersMock: vi.fn(),
    resolveSystemPromptMock: vi.fn(),
    buildConnectedPackagesMock: vi.fn(),
    buildServerAccountMapMock: vi.fn(() => new Map()),
    mockTurnLogger,
    assemblePreTurnContextMock: vi.fn(),
    parseConversationSearchKeywordMock: vi.fn(),
    loadFilterAndFormatConversationsMock: vi.fn(),
    searchConversationsMock: vi.fn(),
    prefetchDocumentsMock: vi.fn(),
    formatPrefetchedDocumentsContextMock: vi.fn(),
    createMcpPrefetchFnMock: vi.fn(),
    resolveActiveServerInstancesMock: vi.fn(),
    searchToolsMock: vi.fn(),
    hasToolIndexMock: vi.fn(),
    getToolIndexStatusMock: vi.fn(),
    getPendingApprovalsMock: vi.fn(),
    getPendingMemoryApprovalsMock: vi.fn(),
    chatSessionCreatedMock: vi.fn(),
    listSessionsMock: vi.fn(),
  };
});

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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
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
    preventSleepDuringTurns: false,
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
    getRetryStartTime: vi.fn(() => undefined),
    setRetryStartTime: vi.fn(),
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
    recordSessionTurn: vi.fn(),
    hasSessionHadTurns: vi.fn(() => false),
    getUpstreamActivity: vi.fn(() => null),
    getTurnAuthMethod: vi.fn(() => 'api-key'),
    hasCodexProfileDriftWarningEmitted: vi.fn(() => false),
    markCodexProfileDriftWarningEmitted: vi.fn(),
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
    addRoutes: vi.fn(async () => undefined),
    getUrl: vi.fn(() => 'http://proxy.local'),
    getAuthToken: vi.fn(() => 'proxy-auth-token'),
  },
}));

vi.mock('../mcpService', () => ({
  resolveMcpServers: resolveMcpServersMock,
  resolveSystemPrompt: resolveSystemPromptMock,
  buildConnectedPackages: buildConnectedPackagesMock,
  buildServerAccountMap: buildServerAccountMapMock,
  buildFrequentToolGroups: vi.fn(() => []),
  resolveMcpConfigPath: vi.fn(() => null),
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
  getPendingApprovals: getPendingApprovalsMock,
  getPendingMemoryApprovals: getPendingMemoryApprovalsMock,
  clearPendingApprovalsForSession: vi.fn(),
}));

vi.mock('../agentMessageHandler', () => ({
  handleAgentMessage: vi.fn(),
}));

vi.mock('../../utils/systemUtils', () => ({
  setupNodeEnvironment: vi.fn(async () => process.env.PATH ?? ''),
  resolveLibraryPath: vi.fn(() => null),
}));

vi.mock('../utils/authEnvUtils', () => ({
  getAuthEnvVars: vi.fn(() => ({})),
  hasValidAuth: vi.fn(() => true),
  isUsingOAuth: vi.fn(() => false),
  isUsingOpenRouter: vi.fn(() => false),
  getApiKeyAuthEnvVars: vi.fn(() => null),
  getProviderKeyEnvVars: vi.fn(() => null),
  getAuthMethodDescription: vi.fn(() => 'api-key'),
}));

vi.mock('@core/utils/authEnvUtils', () => ({
  getAuthEnvVars: vi.fn(() => ({})),
  hasValidAuth: vi.fn(() => true),
  isUsingOAuth: vi.fn(() => false),
  isUsingOpenRouter: vi.fn(() => false),
  getApiKeyAuthEnvVars: vi.fn(() => null),
  getProviderKeyEnvVars: vi.fn(() => null),
  getAuthMethodDescription: vi.fn(() => 'api-key'),
  getAuthForDirectUse: vi.fn(() => null),
  getRateLimitFallbackTarget: vi.fn(() => null),
}));

vi.mock('@shared/utils/modelNormalization', async () => {
  // vi.hoisted imports production early here; keep this dynamic to avoid static-import ordering.
  const { createModelNormalizationMock } = await import('./agentTurnExecutor.testHarness');
  return createModelNormalizationMock({ resolveModelConfigMock });
});

vi.mock('@core/rebelCore/modelLimits', () => ({
  shouldSuppressProfileReasoning: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => profile?.thinkingCompatibility === 'incompatible',
  resolveProfileReasoningEffort: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => (profile?.thinkingCompatibility === 'incompatible' ? undefined : profile?.reasoningEffort),
  resolveModelLimits: vi.fn(() => ({ contextWindow: 200_000, maxOutputTokens: 8_192 })),
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
  parseConversationSearchKeyword: parseConversationSearchKeywordMock,
  AUTO_CONVERSATION_THRESHOLD: 0.70,
  MAX_AUTO_CONVERSATION_CHARS: 10_000,
  MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION: 5_000,
  loadFilterAndFormatConversations: loadFilterAndFormatConversationsMock,
}));

vi.mock('../conversationIndexService', () => ({
  searchConversations: searchConversationsMock,
}));

vi.mock('@core/services/buildContinuationContext', () => createBuildContinuationContextMock());

vi.mock('../../utils/agentTurnFormatters', () => ({
  formatFrequentToolsContext: vi.fn(() => undefined),
  formatConnectedPackagesContext: vi.fn(() => undefined),
  formatSuggestedToolsContext: vi.fn(() => undefined),
  extractParamHints: vi.fn(() => ''),
  isEmptyParamSchema: vi.fn(() => false),
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

vi.mock('@core/services/documentPrefetchService', () => ({
  prefetchDocuments: prefetchDocumentsMock,
  formatPrefetchedDocumentsContext: formatPrefetchedDocumentsContextMock,
}));

vi.mock('../documentPrefetchAdapter', () => ({
  createMcpPrefetchFn: createMcpPrefetchFnMock,
  resolveActiveServerInstances: resolveActiveServerInstancesMock,
}));

vi.mock('../../tracking', () => ({
  getTurnAggregator: vi.fn(() => ({ pushMessage: vi.fn() })),
  cleanupTurnAggregator: vi.fn(),
  mainTracking: {
    chatSessionCreated: chatSessionCreatedMock,
  },
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
    listSessions: listSessionsMock,
  })),
}));

vi.mock('../../constants', () => ({
  KNOWLEDGE_WORKER_AGENT_NAME: 'Rebel',
  KNOWLEDGE_WORKER_AGENT_DESCRIPTION: 'Test',
}));

vi.mock('../promptCacheWarmupService', () => ({
  updateLastApiCallTime: vi.fn(),
  getLastApiCallTime: vi.fn(() => undefined),
}));

vi.mock('../mcpServerAlias', () => ({
  aliasMcpServersForClaudeSdk: vi.fn((servers: unknown) => servers),
}));

vi.mock('@core/preTurnWorker', () => ({
  getPreTurnWorker: vi.fn(() => ({
    waitForWorkerReady: vi.fn(async () => undefined),
    isWorkerAvailable: vi.fn(() => true),
    assemblePreTurnContext: assemblePreTurnContextMock,
    disposeWorker: vi.fn(async () => undefined),
    getWorkerStatus: vi.fn(() => ({
      isReady: true,
      permanentlyDisabled: false,
      consecutiveCrashes: 0,
      crashCooldownRemainingMs: 0,
      workspacePath: '/tmp/workspace',
    })),
    getPreTurnWorkerStats: vi.fn(() => ({
      since: 'app_start',
      appStartedAt: 1_234_567_890,
      spawnCount: 1,
      restartCount: 0,
      currentlyRestarting: false,
      averagePreTurnDurationBucket: '<100ms',
    })),
  })),
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
    createRoutedError: vi.fn((kind: string, message: string) => {
      const err = new Error(`${kind}: ${message}`);
      (err as unknown as Record<string, unknown>).__agentErrorKind = kind;
      (err as unknown as Record<string, unknown>).__rawMessage = message;
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
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

vi.mock('../mcpBuildAutoDetectHook', () => ({
  buildStuckRegistrationReminder: vi.fn(() => undefined),
  promoteTestingContributionIfRegistered: vi.fn(async () => undefined),
  createMcpBuildAutoDetectHook: vi.fn(() => async () => ({})),
}));

vi.mock('@shared/utils/pricingCalculator', () => ({
  calculateCost: vi.fn(() => 0),
  calculateCostOrWarn: vi.fn(() => 0),
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
import {
  applyWatchdogApprovalWaitCommitGate,
  shouldAbortForAutomationHardCeiling,
} from '../agentTurnExecutor';
import { WatchdogTracker } from '../watchdogTracker';

type ToolEvent = {
  type: 'tool';
  toolName: string;
  detail?: string;
  stage?: string;
};

type ScenarioOutcome = {
  sessionType: SessionType;
  derivedPolicy: TurnPolicy;
  defaultPolicy: Readonly<TurnPolicy>;
  resolveSystemPromptSessionType: unknown;
  resolveSystemPromptPromptSessionMode: unknown;
  acquiredLane: 'foreground' | 'background';
  hasDocumentPrefetchEvent: boolean;
  hasFileSearchEvent: boolean;
  hasAutoConversationEvent: boolean;
  prefetchInvoked: boolean;
  semanticAssemblyInvoked: boolean;
  autoConversationInvoked: boolean;
  watchdogSuppressionActive: boolean;
  hardCeilingArmed: boolean;
  analyticsOrigin: unknown;
};

function parseToolDetail(detail: unknown): Record<string, unknown> | null {
  if (typeof detail !== 'string') return null;
  try {
    return JSON.parse(detail) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getToolEvents(): ToolEvent[] {
  return dispatchAgentEventMock.mock.calls
    .map((call: unknown[]) => call[2] as ToolEvent | undefined)
    .filter((event): event is ToolEvent => event?.type === 'tool');
}

function resetExecutionMocks(): void {
  vi.clearAllMocks();

  resolveModelConfigMock.mockImplementation((model: string) => ({
    model,
    envOverrides: undefined,
  }));
  resolveMcpServersMock.mockResolvedValue({
    servers: undefined,
    mode: 'unavailable',
    upstreamCount: 0,
    configPath: undefined,
  });
  resolveSystemPromptMock.mockResolvedValue('You are Rebel.');
  buildConnectedPackagesMock.mockResolvedValue([]);
  buildServerAccountMapMock.mockReturnValue(new Map());
  listSessionsMock.mockReturnValue([]);

  assemblePreTurnContextMock.mockResolvedValue({
    semanticContext: {
      formattedContext: 'Relevant file context',
      fileCount: 1,
      files: [],
    },
    suggestedTools: [],
    suggestedConversations: [
      {
        sessionId: 'conversation-1',
        title: 'Previous planning notes',
        score: 0.91,
        createdAt: 1,
        messageCount: 4,
      },
    ],
    suggestedSkills: [],
    conversationSearchStatus: 'ok',
    toolSearchStatus: 'ok',
  });
  parseConversationSearchKeywordMock.mockImplementation((prompt: string) => ({
    hasConversationSearch: false,
    sanitizedPrompt: prompt,
  }));
  loadFilterAndFormatConversationsMock.mockResolvedValue({
    formattedContext: 'Relevant conversation context',
    count: 1,
    totalChars: 256,
    topScore: 0.91,
  });
  searchConversationsMock.mockResolvedValue([]);

  prefetchDocumentsMock.mockResolvedValue([
    { status: 'fetched', url: 'https://example.com' },
  ]);
  formatPrefetchedDocumentsContextMock.mockReturnValue('Prefetched document context');
  createMcpPrefetchFnMock.mockReturnValue(vi.fn(async () => ({ status: 'fetched' })));
  resolveActiveServerInstancesMock.mockResolvedValue([]);

  searchToolsMock.mockResolvedValue([]);
  hasToolIndexMock.mockReturnValue(false);
  getToolIndexStatusMock.mockReturnValue({ freshnessGeneration: 0 });
  getPendingApprovalsMock.mockReturnValue([]);
  getPendingMemoryApprovalsMock.mockReturnValue([]);

  queryMock.mockImplementation(() => {
    async function* iterator(): AsyncGenerator<{ type: string }, void, unknown> {
      yield { type: 'result' };
    }
    const iter = iterator() as AsyncGenerator<{ type: string }, void, unknown> & { close: () => void };
    iter.close = vi.fn();
    return iter;
  });
  runAgentQueryMock.mockResolvedValue({
    abortedByUser: false,
    terminatedByHandler: false,
  });
}

async function drainMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function toRequestSessionType(sessionType: SessionType): AgentTurnRequest['sessionType'] | SessionType {
  if (sessionType === 'interactive') return 'manual';
  return sessionType;
}

async function captureLaneSelection(sessionType: SessionType): Promise<'foreground' | 'background'> {
  const acquireSpy = vi.spyOn(localTurnLimiter, 'acquire').mockResolvedValue(() => undefined);

  const executeAgentTurnStub = vi.fn<AgentTurnServiceDeps['executeAgentTurn']>(async () => undefined);
  const deps: AgentTurnServiceDeps = {
    executeAgentTurn: executeAgentTurnStub,
    dispatchAgentEvent: vi.fn(),
    deleteRendererSessionByTurn: vi.fn(),
    cancelExistingTurnForSession: vi.fn(() => undefined),
  };

  const sessionId = `lane-session-${sessionType}`;
  const { turnId } = startAgentTurn(
    deps,
    {
      prompt: `lane-check-${sessionType}`,
      sessionId,
      sessionType: toRequestSessionType(sessionType) as AgentTurnRequest['sessionType'],
    } as AgentTurnRequest,
    null,
  );

  await drainMicrotasks();

  const lane = acquireSpy.mock.calls[0]?.[1];

  // The real startAgentTurn flow relies on executeAgentTurn to clear turn state.
  // Our stub returns immediately, so cleanup here keeps the singleton registry clean.
  agentTurnRegistry.deleteActiveTurnController(turnId);
  agentTurnRegistry.deleteRendererSession(turnId);
  acquireSpy.mockRestore();

  if (lane !== 'foreground' && lane !== 'background') {
    throw new Error(`Expected lane selection for ${sessionType}, received ${String(lane)}.`);
  }

  return lane;
}

async function runScenario(sessionType: SessionType): Promise<ScenarioOutcome> {
  resetExecutionMocks();

  const turnId = `turn-${sessionType}`;
  await executeAgentTurn(null, turnId, 'Review https://example.com for action items', {
    sessionId: `session-${sessionType}`,
    sessionType,
  });

  const toolEvents = getToolEvents();
  const hasDocumentPrefetchEvent = toolEvents.some((event) => event.toolName === 'document_prefetch');
  const hasFileSearchEvent = toolEvents.some((event) => event.toolName === 'file_search');
  const hasAutoConversationEvent = toolEvents.some((event) => {
    if (event.toolName !== 'conversation_search') return false;
    const parsed = parseToolDetail(event.detail);
    return parsed?.trigger === 'auto';
  });

  const defaultPolicy = getDefaultPolicyForSessionType(sessionType);
  const derivedPolicy = derivePolicy(sessionType);

  const referenceWatchdog = new WatchdogTracker(1_000_000);
  const checkResult = referenceWatchdog.check(1_035_000, true);
  const watchdogSuppressionActive = applyWatchdogApprovalWaitCommitGate({
    watchdog: referenceWatchdog,
    checkResult,
    now: 1_035_000,
    isWaitingForUser: true,
    watchdogAbortsDuringApprovalWait: derivedPolicy.watchdogAbortsDuringApprovalWait,
  });

  const hardCeilingArmed = shouldAbortForAutomationHardCeiling(
    derivedPolicy.watchdogHardCeilingMs,
    AUTOMATION_HARD_CEILING_MS,
  );

  const acquiredLane = await captureLaneSelection(sessionType);
  const resolveSystemPromptSessionType = resolveSystemPromptMock.mock.calls[0]?.[1]?.sessionType;
  const resolveSystemPromptPromptSessionMode = resolveSystemPromptMock.mock.calls[0]?.[1]?.promptSessionMode;
  const analyticsOrigin = chatSessionCreatedMock.mock.calls[0]?.[0]?.origin;

  return {
    sessionType,
    derivedPolicy,
    defaultPolicy,
    resolveSystemPromptSessionType,
    resolveSystemPromptPromptSessionMode,
    acquiredLane,
    hasDocumentPrefetchEvent,
    hasFileSearchEvent,
    hasAutoConversationEvent,
    prefetchInvoked: prefetchDocumentsMock.mock.calls.length > 0,
    semanticAssemblyInvoked: assemblePreTurnContextMock.mock.calls.length > 0,
    autoConversationInvoked: loadFilterAndFormatConversationsMock.mock.calls.length > 0,
    watchdogSuppressionActive,
    hardCeilingArmed,
    analyticsOrigin,
  };
}

describe('TurnPolicy invariants — interactive', () => {
  it('satisfies the interactive behaviour matrix invariants', async () => {
    const outcome = await runScenario('interactive');

    expect(outcome.derivedPolicy).toEqual(outcome.defaultPolicy);
    expect(Object.isFrozen(outcome.defaultPolicy)).toBe(true);
    expect(outcome.resolveSystemPromptSessionType).toBe(outcome.defaultPolicy.promptSessionMode);
    expect(outcome.acquiredLane).toBe(outcome.defaultPolicy.lane);
    expect(outcome.hasDocumentPrefetchEvent).toBe(true);
    expect(outcome.prefetchInvoked).toBe(true);
    expect(outcome.hasFileSearchEvent).toBe(true);
    expect(outcome.semanticAssemblyInvoked).toBe(true);
    expect(outcome.hasAutoConversationEvent).toBe(true);
    expect(outcome.autoConversationInvoked).toBe(true);
    expect(outcome.watchdogSuppressionActive).toBe(true);
    expect(outcome.hardCeilingArmed).toBe(false);
    expect(outcome.analyticsOrigin).toBe('manual');
  });
});

describe('TurnPolicy invariants — automation', () => {
  it('satisfies the automation behaviour matrix invariants', async () => {
    const outcome = await runScenario('automation');

    expect(outcome.derivedPolicy).toEqual(outcome.defaultPolicy);
    expect(Object.isFrozen(outcome.defaultPolicy)).toBe(true);
    expect(outcome.resolveSystemPromptSessionType).toBe(outcome.defaultPolicy.promptSessionMode);
    expect(outcome.acquiredLane).toBe(outcome.defaultPolicy.lane);
    expect(outcome.hasDocumentPrefetchEvent).toBe(false);
    expect(outcome.prefetchInvoked).toBe(false);
    expect(outcome.hasFileSearchEvent).toBe(false);
    expect(outcome.semanticAssemblyInvoked).toBe(false);
    expect(outcome.hasAutoConversationEvent).toBe(false);
    expect(outcome.autoConversationInvoked).toBe(false);
    expect(outcome.watchdogSuppressionActive).toBe(false);
    expect(outcome.hardCeilingArmed).toBe(true);
    expect(outcome.defaultPolicy.watchdogHardCeilingMs).toBe(AUTOMATION_HARD_CEILING_MS);
    expect(outcome.analyticsOrigin).toBe('automation');
  });

  it('passes policy-derived promptSessionMode while preserving raw sessionType for prompt resolution options', async () => {
    resetExecutionMocks();

    await executeAgentTurn(null, 'turn-automation-policy-override', 'Review https://example.com for action items', {
      sessionId: 'session-automation-policy-override',
      sessionType: 'automation',
      policyOverrides: { promptSessionMode: 'cli' },
    });

    const promptOptions = (resolveSystemPromptMock.mock.calls[0]?.[1] ?? {}) as {
      sessionType?: unknown;
      promptSessionMode?: unknown;
    };

    expect(promptOptions.sessionType).toBe('automation');
    expect(promptOptions.promptSessionMode).toBe('cli');
  });
});

describe('TurnPolicy invariants — cli', () => {
  it('satisfies the cli behaviour matrix invariants', async () => {
    const outcome = await runScenario('cli');

    expect(outcome.derivedPolicy).toEqual(outcome.defaultPolicy);
    expect(Object.isFrozen(outcome.defaultPolicy)).toBe(true);
    expect(outcome.resolveSystemPromptSessionType).toBe('cli');
    expect(outcome.resolveSystemPromptSessionType).toBe(outcome.defaultPolicy.promptSessionMode);
    expect(outcome.acquiredLane).toBe(outcome.defaultPolicy.lane);
    expect(outcome.hasDocumentPrefetchEvent).toBe(true);
    expect(outcome.prefetchInvoked).toBe(true);
    expect(outcome.hasFileSearchEvent).toBe(true);
    expect(outcome.semanticAssemblyInvoked).toBe(true);
    expect(outcome.hasAutoConversationEvent).toBe(true);
    expect(outcome.autoConversationInvoked).toBe(true);
    expect(outcome.watchdogSuppressionActive).toBe(true);
    expect(outcome.hardCeilingArmed).toBe(false);
    expect(outcome.analyticsOrigin).toBe('manual');
  });
});

describe('TurnPolicy invariants — mcp_server', () => {
  it('satisfies the mcp_server behaviour matrix invariants', async () => {
    const outcome = await runScenario('mcp_server');

    expect(outcome.derivedPolicy).toEqual(outcome.defaultPolicy);
    expect(Object.isFrozen(outcome.defaultPolicy)).toBe(true);
    expect(outcome.resolveSystemPromptSessionType).toBe('mcp_server');
    expect(outcome.resolveSystemPromptSessionType).toBe(outcome.defaultPolicy.promptSessionMode);
    expect(outcome.acquiredLane).toBe(outcome.defaultPolicy.lane);
    expect(outcome.hasDocumentPrefetchEvent).toBe(true);
    expect(outcome.prefetchInvoked).toBe(true);
    expect(outcome.hasFileSearchEvent).toBe(true);
    expect(outcome.semanticAssemblyInvoked).toBe(true);
    expect(outcome.hasAutoConversationEvent).toBe(true);
    expect(outcome.autoConversationInvoked).toBe(true);
    expect(outcome.watchdogSuppressionActive).toBe(true);
    expect(outcome.hardCeilingArmed).toBe(false);
    expect(outcome.analyticsOrigin).toBe('manual');
  });
});
