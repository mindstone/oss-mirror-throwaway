import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBuildContinuationContextMock,
  createModelNormalizationMock,
} from './agentTurnExecutor.testHarness';

const {
  queryMock,
  dispatchAgentEventMock,
  resolveModelConfigMock,
  mockTurnLogger,
  resolveMcpServersMock,
  buildConnectedPackagesMock,
  resolveSystemPromptMock,
} = vi.hoisted(() => {
  const queryMock = vi.fn();
  const dispatchAgentEventMock = vi.fn();
  const resolveModelConfigMock = vi.fn();
  const resolveMcpServersMock = vi.fn();
  const buildConnectedPackagesMock = vi.fn();
  const resolveSystemPromptMock = vi.fn();
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
    resolveModelConfigMock,
    mockTurnLogger,
    resolveMcpServersMock,
    buildConnectedPackagesMock,
    resolveSystemPromptMock,
  };
});

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
      hasOutputCapRetryAttempted: vi.fn(() => false),
      markOutputCapRetryAttempted: vi.fn(),
      clearOutputCapRetryAttempted: vi.fn(),
    markCostRecorded: vi.fn(),
    recordSessionTurn: vi.fn(),
    hasSessionHadTurns: vi.fn(() => false),
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
  resolveMcpServers: resolveMcpServersMock,
  resolveSystemPrompt: resolveSystemPromptMock,
  buildConnectedPackages: buildConnectedPackagesMock,
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

// NOTE: resolveCapabilities is NOT mocked — it runs as a real pure function
// so the test exercises the full resolution logic end-to-end

import { executeAgentTurn } from '../agentTurnExecutor';

function successIterator() {
  async function* gen(): AsyncGenerator<{ type: string }, void, unknown> {
    yield { type: 'result' };
  }
  const iter = gen() as AsyncGenerator<{ type: string }, void, unknown> & { close: () => void };
  iter.close = vi.fn();
  return iter;
}

const PERPLEXITY_PACKAGES = [
  {
    name: 'Perplexity',
    description: 'AI-powered web search',
    capabilities: [
      { id: 'web-search', promptGuidance: 'Use perplexity_search for web queries.' },
    ],
  },
];

const PACKAGES_WITHOUT_CAPABILITIES = [
  { name: 'Slack', description: 'Team messaging', capabilities: [] },
];

describe('executeAgentTurn MCP capability integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveModelConfigMock.mockImplementation((model: string) => ({
      model,
      envOverrides: undefined,
    }));
    resolveSystemPromptMock.mockResolvedValue('You are Rebel.');
    queryMock.mockImplementation(() => successIterator());
  });

  it('suppresses WebSearch and injects guidance when MCP is available with search capability', async () => {
    resolveMcpServersMock.mockResolvedValue({
      servers: { 'super-mcp-router': { command: 'node', args: ['router.js'] } },
      mode: 'router',
      upstreamCount: 1,
      configPath: '/tmp/mcp.json',
    });
    buildConnectedPackagesMock.mockResolvedValue(PERPLEXITY_PACKAGES);

    await executeAgentTurn(null, 'turn-cap-1', 'Search for AI news', {
      sessionId: 'session-1',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = queryMock.mock.calls[0][0] as Record<string, unknown>;

    const systemPrompt = options.systemPrompt as string;
    expect(systemPrompt).toContain('Active capability upgrades');
    expect(systemPrompt).toContain('perplexity_search');
  });

  it('does NOT suppress WebSearch when MCP is unavailable (degraded mode)', async () => {
    resolveMcpServersMock.mockResolvedValue({
      servers: undefined,
      mode: 'unavailable',
      upstreamCount: 0,
      configPath: undefined,
    });
    buildConnectedPackagesMock.mockResolvedValue(PERPLEXITY_PACKAGES);

    await executeAgentTurn(null, 'turn-cap-2', 'Search for AI news', {
      sessionId: 'session-2',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = queryMock.mock.calls[0][0] as Record<string, unknown>;

    // System prompt should NOT contain capability guidance
    const systemPrompt = options.systemPrompt as string;
    expect(systemPrompt).not.toContain('Active capability upgrades');
    expect(systemPrompt).not.toContain('perplexity_search');
  });

  it('does not set disallowedTools when connected packages have no capabilities', async () => {
    resolveMcpServersMock.mockResolvedValue({
      servers: { 'super-mcp-router': { command: 'node', args: ['router.js'] } },
      mode: 'router',
      upstreamCount: 1,
      configPath: '/tmp/mcp.json',
    });
    buildConnectedPackagesMock.mockResolvedValue(PACKAGES_WITHOUT_CAPABILITIES);

    await executeAgentTurn(null, 'turn-cap-3', 'Send a Slack message', {
      sessionId: 'session-3',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = queryMock.mock.calls[0][0] as Record<string, unknown>;
    const systemPrompt = options.systemPrompt as string;
    expect(systemPrompt).not.toContain('Active capability upgrades');
  });

  it('logs active capabilities when MCP search is connected', async () => {
    resolveMcpServersMock.mockResolvedValue({
      servers: { 'super-mcp-router': { command: 'node', args: ['router.js'] } },
      mode: 'router',
      upstreamCount: 1,
      configPath: '/tmp/mcp.json',
    });
    buildConnectedPackagesMock.mockResolvedValue(PERPLEXITY_PACKAGES);

    await executeAgentTurn(null, 'turn-cap-4', 'Search for something', {
      sessionId: 'session-4',
      resetConversation: false,
    });

    expect(mockTurnLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        activeCapabilities: expect.arrayContaining([
          expect.objectContaining({ capabilityId: 'web-search', provider: 'Perplexity' }),
        ]),
        disallowedTools: ['WebSearch'],
      }),
      'MCP capabilities active — built-in tools suppressed'
    );
  });

  it('includes mcpServers at BOTH root level and agent level when MCP servers are connected', async () => {
    const mcpServerConfig = { 'super-mcp-router': { command: 'node', args: ['router.js'] } };
    resolveMcpServersMock.mockResolvedValue({
      servers: mcpServerConfig,
      mode: 'router',
      upstreamCount: 1,
      configPath: '/tmp/mcp.json',
    });
    buildConnectedPackagesMock.mockResolvedValue(PACKAGES_WITHOUT_CAPABILITIES);

    await executeAgentTurn(null, 'turn-dual-mcp', 'Send an email', {
      sessionId: 'session-dual-mcp',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = queryMock.mock.calls[0][0] as Record<string, unknown>;

    // Root-level mcpServers: direct tool access for the lead agent
    expect(options.mcpServers).toEqual(mcpServerConfig);

    // Agent-level mcpServers: knowledge-worker subagent also gets MCP access
    const agents = options.agents as Record<string, { mcpServers?: unknown[] }>;
    expect(agents).toBeDefined();
    expect(agents['Rebel']).toBeDefined();
    expect(agents['Rebel'].mcpServers).toBeDefined();
    expect(agents['Rebel'].mcpServers).toHaveLength(1);
    expect(agents['Rebel'].mcpServers![0]).toEqual(mcpServerConfig);
  });

  it('does NOT include root-level mcpServers when no MCP servers are connected', async () => {
    resolveMcpServersMock.mockResolvedValue({
      servers: undefined,
      mode: 'unavailable',
      upstreamCount: 0,
      configPath: undefined,
    });
    buildConnectedPackagesMock.mockResolvedValue([]);

    await executeAgentTurn(null, 'turn-no-mcp', 'Hello', {
      sessionId: 'session-no-mcp',
      resetConversation: false,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = queryMock.mock.calls[0][0] as Record<string, unknown>;

    // Root-level mcpServers should not be present when no servers are connected
    expect(options.mcpServers).toBeUndefined();
  });

  it('wires skill frontmatter into prompt annotation and effective effort', async () => {
    const actualAgentTurnUtils = await vi.importActual<typeof import('../../utils/agentTurnUtils')>(
      '../../utils/agentTurnUtils'
    );
    const mockedAgentTurnUtils = await import('../../utils/agentTurnUtils');
    const { agentTurnRegistry } = await import('../agentTurnRegistry');

    vi.mocked(mockedAgentTurnUtils.separateAttachments).mockImplementation(actualAgentTurnUtils.separateAttachments);
    vi.mocked(mockedAgentTurnUtils.attachSkillMetadataToTextAttachments).mockImplementation(
      actualAgentTurnUtils.attachSkillMetadataToTextAttachments
    );
    vi.mocked(mockedAgentTurnUtils.collectSkillModelRecommendations).mockImplementation(
      actualAgentTurnUtils.collectSkillModelRecommendations
    );
    vi.mocked(mockedAgentTurnUtils.computeEffectiveEffort).mockImplementation(
      actualAgentTurnUtils.computeEffectiveEffort
    );
    vi.mocked(mockedAgentTurnUtils.appendAttachmentsToPrompt).mockImplementation(
      actualAgentTurnUtils.appendAttachmentsToPrompt
    );
    vi.mocked(mockedAgentTurnUtils.resolveSkillModelRecommendations).mockImplementation(
      actualAgentTurnUtils.resolveSkillModelRecommendations
    );

    await executeAgentTurn(null, 'turn-cap-skill-frontmatter', 'Follow attached guidance.', {
      sessionId: 'session-skill-frontmatter',
      resetConversation: false,
      attachments: [
        {
          id: 'skill-1',
          name: 'SKILL.md',
          path: '/tmp/skills/writing/email-helper/SKILL.md',
          relativePath: 'skills/writing/email-helper/SKILL.md',
          size: 128,
          content: '---\ndescription: Email helper\nmodel: opus\neffort: high\n---\nBody',
        },
      ],
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const queryArg = queryMock.mock.calls[0][0] as {
      prompt: unknown;
      env?: Record<string, string>;
    };
    expect(typeof queryArg.prompt).toBe('string');
    expect(queryArg.prompt as string).toContain(
      '[Skill metadata: model recommendation = opus, effort = high]'
    );
    expect(queryArg.env?.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');

    // A4a: agentTurnExecute now resolves effort via the shared `resolveReasoningEffort`
    // (not `computeEffectiveEffort`). The skill-frontmatter → effort wiring is verified
    // behaviorally: without the skill floor ['high'] the user/global default would be
    // 'medium', so the 'high' outcome above (CLAUDE_CODE_EFFORT_LEVEL) and below
    // (setTurnThinkingEffort) proves the skill floor was applied.
    expect(vi.mocked(agentTurnRegistry.setTurnThinkingEffort)).toHaveBeenCalledWith(
      'turn-cap-skill-frontmatter',
      'high'
    );
  });
});
