import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { expect, vi } from 'vitest';
import type { EmbeddingGenerator } from '@core/embeddingGenerator';
import { getEmbeddingGenerator, setEmbeddingGeneratorFactory } from '@core/embeddingGenerator';
import { setStoreFactory } from '@core/storeFactory';
import { createSearchToolInterceptHook } from '@core/services/toolIndex/searchToolInterceptHook';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import type { ExternalConversationService } from '@core/services/externalConversation/externalConversationService';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import type { AgentSession } from '@shared/types';
import { executeAgentTurn } from '@core/services/turnPipeline/agentTurnExecute';
import { cloudEventBroadcaster } from '../../cloudEventBroadcaster';
import { CloudEmbeddingGenerator } from '../../services/cloudEmbeddingGenerator';
import { cloudBootstrapWarmup } from '../../services/cloudBootstrapWarmup';

const {
  state,
  defaultSettings,
  pipelineMock,
  runAgentQueryMock,
  searchToolsMock,
  isToolIndexUsableMock,
  getToolIndexStatusMock,
  captureExceptionMock,
} = vi.hoisted(() => {
  const state = {
    coldStartDelayMs: 2_500,
    searchToolsMs: null as number | null,
    externalConversationService: null as ExternalConversationService | null,
    externalConversationAdapter: null as unknown,
    sessions: new Map<string, AgentSession>(),
    realSearchToolsProbe: null as ((query: string) => Promise<void>) | null,
  };

  const defaultSettings = {
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
    experimental: {},
  };

  const extractorMock = vi.fn(async (input: string | string[]) => {
    const values = Array.isArray(input) ? input : [input];
    return {
      tolist: () => values.map(() => Array.from({ length: 384 }, () => 0.01)),
      dispose: vi.fn(),
    };
  });
  (extractorMock as unknown as { dispose?: () => void }).dispose = vi.fn();

  const pipelineMock = vi.fn(async () => {
    if (state.coldStartDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.coldStartDelayMs));
    }
    return extractorMock;
  });

  return {
    state,
    defaultSettings,
    pipelineMock,
    runAgentQueryMock: vi.fn(),
    searchToolsMock: vi.fn(),
    isToolIndexUsableMock: vi.fn(() => true),
    getToolIndexStatusMock: vi.fn(() => ({ freshnessGeneration: 1, toolCount: 1 })),
    captureExceptionMock: vi.fn(),
  };
});

vi.mock('@huggingface/transformers', () => ({
  env: {
    cacheDir: '',
    allowLocalModels: false,
    allowRemoteModels: true,
  },
  pipeline: pipelineMock,
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn(() => ({
    addBreadcrumb: vi.fn(),
    captureException: captureExceptionMock,
    captureMessage: vi.fn(),
  })),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => ({ ...defaultSettings })),
}));

vi.mock('@core/services/settingsStore/index', () => ({
  getSettings: vi.fn(() => ({ ...defaultSettings })),
  updateSettings: vi.fn(),
  ensureNormalizedSettings: vi.fn(),
  settingsStore: {},
}));

vi.mock('@main/services/queryOptionsBuilder', () => ({
  buildSdkQueryOptions: vi.fn((ctx: Record<string, unknown>) => ({
    model: ((ctx.modelConfig as { model?: string } | undefined)?.model) ?? 'claude-sonnet-4-5',
    systemPrompt: String(ctx.finalSystemPrompt ?? ''),
    hooks: ctx.turnHooks,
    cwd: String(ctx.effectivePath ?? process.cwd()),
    permissionMode: String(ctx.permissionMode ?? 'bypassPermissions'),
    env: {},
    suppressedBuiltins: [],
  })),
}));

vi.mock('@main/services/mcpService', () => ({
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

vi.mock('@main/services/semanticContextService', () => ({
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

vi.mock('@main/services/conversationContextService', () => ({
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

vi.mock('@main/services/conversationHistoryService', () => ({
  loadConversationHistory: vi.fn(async () => ''),
  buildConversationHistoryContext: vi.fn(() => ''),
  loadIntelligentConversationHistory: vi.fn(async () => ''),
}));

vi.mock('@core/services/buildContinuationContext', () => ({
  buildContinuationContext: vi.fn(() => ({ prefix: '', meta: { headerIncluded: false } })),
}));

vi.mock('@main/services/conversationIndexService', () => ({
  searchConversations: vi.fn(async () => []),
}));

vi.mock('@main/services/documentPrefetchAdapter', () => ({
  createMcpPrefetchFn: vi.fn(() => undefined),
  resolveActiveServerInstances: vi.fn(() => []),
}));

vi.mock('@core/services/documentPrefetchService', () => ({
  prefetchDocuments: vi.fn(async () => ({ prefetched: [] })),
  formatPrefetchedDocumentsContext: vi.fn(() => ''),
}));

vi.mock('@main/services/toolSafetyService', () => ({
  createToolSafetyHook: vi.fn(() => undefined),
  createCanUseTool: vi.fn(() => undefined),
  cleanupPendingApprovals: vi.fn(),
  cleanupSessionPendingApprovals: vi.fn(),
}));

vi.mock('@main/services/safety/memoryWriteHook', () => ({
  createMemoryWriteHook: vi.fn(() => undefined),
  createCheckpointIntegrityHook: vi.fn(() => undefined),
  clearCheckpointLockedState: vi.fn(),
}));

vi.mock('@main/services/safety/stagedReadHook', () => ({
  createStagedReadHook: vi.fn(() => undefined),
}));

vi.mock('@main/services/fileConversationTrackingHook', () => ({
  createFileConversationTrackingHook: vi.fn(() => undefined),
}));

vi.mock('@main/services/autoContinueHook', () => ({
  createAutoContinueHook: vi.fn(() => undefined),
}));

vi.mock('@main/services/autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

vi.mock('@main/services/safety/pendingApprovalsStore', () => ({
  getPendingApprovals: vi.fn(() => []),
  getPendingMemoryApprovals: vi.fn(() => []),
  clearPendingApprovalsForSession: vi.fn(),
}));

vi.mock('@main/services/localModelProxyServer', () => ({
  proxyManager: {
    getAndResetTurnStats: vi.fn(() => new Map()),
    removeRoutes: vi.fn(),
    getUrl: vi.fn(() => null),
    getAuthToken: vi.fn(() => null),
  },
}));

vi.mock('@main/services/promptCacheWarmupService', () => ({
  updateLastApiCallTime: vi.fn(),
  getLastApiCallTime: vi.fn(() => Date.now()),
}));

vi.mock('@main/services/mcpServerAlias', () => ({
  aliasMcpServersForClaudeSdk: vi.fn((servers: unknown) => servers),
}));

vi.mock('@main/services/toolUsageStore', () => ({
  getFrequentTools: vi.fn(() => []),
}));

vi.mock('@main/services/pluginPreTurnContextStore', () => ({
  getPluginPreTurnContexts: vi.fn(() => []),
}));

vi.mock('@main/services/mcpAppModelContextStore', () => ({
  mcpAppModelContextStore: {
    get: vi.fn(() => null),
    set: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('@main/services/superMcpHttpManager', () => ({
  superMcpHttpManager: {
    getState: vi.fn(() => ({ isRunning: false, url: null })),
  },
}));

vi.mock('@main/services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({
    getSession: vi.fn(async () => null),
    loadSync: vi.fn(() => []),
    load: vi.fn(async () => []),
  })),
}));

vi.mock('@shared/utils/modelNormalization', () => ({
  MODEL_OPTIONS: [],
  resolveModelConfig: vi.fn(() => ({ model: 'claude-sonnet-4-5', thinkingModel: null })),
  DEFAULT_AUXILIARY_MODEL: 'claude-haiku-4-5',
  stripExtendedContextFromConfig: vi.fn((cfg: unknown) => cfg),
  isExtendedContextUnavailableError: vi.fn(() => false),
  isThinkingModelUnavailableError: vi.fn(() => false),
  downgradeThinkingModelConfig: vi.fn((cfg: unknown) => cfg),
  ENV_THINKING_MODEL: 'PLANNING_MODEL',
  ENV_EXECUTION_MODEL: 'EXECUTION_MODEL',
  modelSupportsExtendedContext: vi.fn(() => false),
  PREFERRED_PLANNING_MODEL: 'claude-opus-4-8',
  PLAN_MODE_ALIAS: 'planner',
  getModelEffort: vi.fn(() => undefined),
  normalizeModel: vi.fn((m: string) => m),
}));

vi.mock('@core/rebelCore/modelLimits', () => ({
  resolveModelLimits: vi.fn(() => ({ contextWindow: 200_000, maxOutputTokens: 8192 })),
}));

vi.mock('@shared/utils/settingsUtils', () => ({
  getThinkingProfile: vi.fn(() => null),
  getWorkingProfile: vi.fn(() => null),
}));

vi.mock('@main/services/agentQueryRunner', () => ({
  runAgentQuery: runAgentQueryMock,
}));

vi.mock('@core/services/toolIndex/toolIndexService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/services/toolIndex/toolIndexService')>();
  state.realSearchToolsProbe = async (query: string) => {
    await actual.searchTools(query, 1, 0, 1);
  };
  return {
    ...actual,
    searchTools: searchToolsMock,
    hasToolIndex: vi.fn(() => false),
    isToolIndexUsable: isToolIndexUsableMock,
    getToolIndexStatus: getToolIndexStatusMock,
  };
});

vi.mock('../../services/externalConversationServiceFactory', () => ({
  getExternalConversationService: vi.fn(() => {
    if (!state.externalConversationService) {
      throw new Error('External conversation service has not been initialised for test');
    }
    return state.externalConversationService;
  }),
  get slackThreadAdapterInstance() {
    return state.externalConversationAdapter;
  },
}));

export type InboundRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface HarnessRouteDeps {
  externalConversationService: ExternalConversationService | null;
  embeddingGenerator: EmbeddingGenerator;
  agentTurnRegistry: typeof agentTurnRegistry;
  broadcaster: typeof cloudEventBroadcaster;
  sessions: Map<string, AgentSession>;
  captureException: (error: unknown, context?: Record<string, unknown>) => void;
  bindExternalConversationFactory: (args: {
    externalConversationService: ExternalConversationService;
    adapter?: unknown;
  }) => void;
  registerCleanup: (cleanup: () => void | Promise<void>) => void;
}

export interface InboundColdBootScenario {
  name: string;
  syncAckBudgetMs: number;
  firstSearchToolsBudgetMs: number;
  endpointPath: string;
  buildRequestBody: () => string;
  signRequest: (body: string, headers: Record<string, string>) => void;
  installRoute: (deps: HarnessRouteDeps) => InboundRouteHandler;
  assertHttpAck?: (response: Response, parsedResponseBody: unknown) => void | Promise<void>;
}

function createSessionSkeleton(sessionId: string, scenarioLabel: string): AgentSession {
  const now = Date.now();
  return {
    id: sessionId,
    title: `${scenarioLabel} cold boot test`,
    createdAt: now,
    updatedAt: now,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    origin: 'inbound-trigger',
  };
}

function parseResponseBody(rawBody: string): unknown {
  if (!rawBody) {
    return null;
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function resetHarnessState(): void {
  vi.clearAllMocks();
  conversationScopeResolver.clearAll();
  cloudBootstrapWarmup.resetForTests();

  state.coldStartDelayMs = 2_500;
  state.searchToolsMs = null;
  state.sessions = new Map<string, AgentSession>();
  state.externalConversationService = null;
  state.externalConversationAdapter = null;

  setStoreFactory(() => {
    const values = new Map<string, unknown>();
    return {
      path: '/tmp/test-store.json',
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => {
        values.set(key, value);
      },
      delete: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
      has: (key: string) => values.has(key),
      onDidAnyChange: undefined,
    } as never;
  });

  runAgentQueryMock.mockImplementation(async (config: {
    queryOptions?: {
      hooks?: {
        PreToolUse?: Array<{ hooks?: Array<(input: unknown, toolUseId: string, options: { signal?: AbortSignal }) => Promise<unknown>> }>
      }
    };
    abortController: AbortController;
  }) => {
    const preToolHooks = config.queryOptions?.hooks?.PreToolUse ?? [];
    const hookInput = {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__super-mcp-router__search_tools',
      tool_input: {
        query: 'search tools for this cold-boot inbound request',
        limit: 5,
        threshold: 0,
      },
      session_id: 'session-cold-boot',
      transcript_path: '/tmp/rebel-cold-boot-transcript.log',
      cwd: process.cwd(),
    };

    let intercepted = false;
    for (const matcher of preToolHooks) {
      for (const hook of matcher.hooks ?? []) {
        try {
          const hookResult = await hook(
            hookInput,
            'tool-use-cold-boot',
            { signal: config.abortController.signal },
          ) as {
            hookSpecificOutput?: {
              replaceResult?: unknown;
            };
          };
          if (hookResult?.hookSpecificOutput?.replaceResult) {
            intercepted = true;
            break;
          }
        } catch {
          // Ignore non-search hooks that reject for this synthetic hook input.
        }
      }
      if (intercepted) break;
    }

    if (!intercepted) {
      throw new Error('search_tools intercept hook did not return replaceResult');
    }

    return {
      abortedByUser: false,
      terminatedByHandler: false,
    };
  });

  searchToolsMock.mockImplementation(async (query: string) => {
    if (state.realSearchToolsProbe) {
      await state.realSearchToolsProbe(query);
    }
    const startedAt = Date.now();
    await getEmbeddingGenerator().generateQueryEmbedding(query);
    state.searchToolsMs = Date.now() - startedAt;
    return [{
      toolId: 'mcp__super-mcp-router__search_tools',
      serverId: 'super-mcp-router',
      name: 'search_tools',
      summary: 'Find matching tools',
      description: 'Find matching tools',
      score: 0.99,
    }];
  });

  isToolIndexUsableMock.mockReturnValue(true);
  getToolIndexStatusMock.mockReturnValue({ freshnessGeneration: 1, toolCount: 1 });
  setEmbeddingGeneratorFactory(() => new CloudEmbeddingGenerator());
}

function cleanupHarnessState(): void {
  conversationScopeResolver.clearAll();
  cloudEventBroadcaster.closeAll();
  cloudBootstrapWarmup.resetForTests();
  state.externalConversationService = null;
  state.externalConversationAdapter = null;
}

export async function runInboundColdBootScenario(scenario: InboundColdBootScenario): Promise<{
  durationsMs: {
    httpAck: number;
    firstSearchTools: number | null;
  };
  searchToolsInvoked: boolean;
  agentTurnDispatched: boolean;
}> {
  resetHarnessState();

  const cleanups: Array<() => void | Promise<void>> = [];
  const embeddingGenerator = getEmbeddingGenerator();

  const routeDeps: HarnessRouteDeps = {
    externalConversationService: null,
    embeddingGenerator,
    agentTurnRegistry,
    broadcaster: cloudEventBroadcaster,
    sessions: state.sessions,
    captureException: (error, context) => {
      captureExceptionMock(error, context);
    },
    bindExternalConversationFactory: ({ externalConversationService, adapter }) => {
      routeDeps.externalConversationService = externalConversationService;
      state.externalConversationService = externalConversationService;
      state.externalConversationAdapter = adapter ?? null;
    },
    registerCleanup: (cleanup) => {
      cleanups.push(cleanup);
    },
  };

  const routeHandler = scenario.installRoute(routeDeps);

  expect(pipelineMock).not.toHaveBeenCalled();
  expect(cloudBootstrapWarmup.getState()).toBe('not_scheduled');

  let turnError: unknown = null;
  let turnStarted = false;
  let executeTurnCalls = 0;
  let resolveTurn: (() => void) | null = null;
  let rejectTurn: ((error: unknown) => void) | null = null;
  const turnCompleted = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });

  const unsubscribe = cloudEventBroadcaster.onChannel('conversations:start-requested', (_channel, payload) => {
    const request = payload as { sessionId?: string; text?: string };
    if (turnStarted) return;
    if (!request || typeof request.sessionId !== 'string' || typeof request.text !== 'string') return;
    turnStarted = true;

    if (!state.sessions.has(request.sessionId)) {
      state.sessions.set(request.sessionId, createSessionSkeleton(request.sessionId, scenario.name));
    }
    const turnPrompt = request.text.trim().length > 0
      ? request.text
      : `Reply to this ${scenario.name} inbound ping.`;

    void (async () => {
      try {
        executeTurnCalls += 1;
        await executeAgentTurn(null, 'turn-cold-boot', turnPrompt, {
          sessionId: request.sessionId,
          resetConversation: true,
        });

        const searchInterceptHook = createSearchToolInterceptHook();
        const hookResult = await searchInterceptHook(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'mcp__super-mcp-router__search_tools',
            tool_input: {
              query: `search tools for this ${scenario.name} inbound request`,
              limit: 5,
              threshold: 0,
            },
          } as never,
          'tool-use-cold-boot',
          { signal: new AbortController().signal },
        ) as {
          hookSpecificOutput?: {
            replaceResult?: unknown;
          };
        };
        if (!hookResult?.hookSpecificOutput?.replaceResult) {
          throw new Error('search_tools intercept hook did not return replaceResult');
        }

        resolveTurn?.();
      } catch (error) {
        turnError = error;
        rejectTurn?.(error);
      }
    })();
  });

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === scenario.endpointPath) {
      void routeHandler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve test server address');
    }

    const body = scenario.buildRequestBody();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    scenario.signRequest(body, headers);

    const ackStartedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${address.port}${scenario.endpointPath}`, {
      method: 'POST',
      headers,
      body,
    });
    const responseText = await response.text();
    const ackMs = Date.now() - ackStartedAt;
    const parsedResponseBody = parseResponseBody(responseText);

    if (scenario.assertHttpAck) {
      await scenario.assertHttpAck(response, parsedResponseBody);
    } else {
      expect(response.ok).toBe(true);
    }
    expect(ackMs).toBeLessThanOrEqual(scenario.syncAckBudgetMs);

    await Promise.race([
      turnCompleted,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Timed out waiting for cold-boot turn completion')), scenario.firstSearchToolsBudgetMs + 2_000);
      }),
    ]);

    expect(turnError).toBeNull();
    expect(executeTurnCalls).toBe(1);
    expect(searchToolsMock).toHaveBeenCalledTimes(1);
    expect(state.searchToolsMs).not.toBeNull();
    expect(state.searchToolsMs!).toBeLessThanOrEqual(scenario.firstSearchToolsBudgetMs);

    const capturedErrorTexts = captureExceptionMock.mock.calls.map(([error]) => (
      error instanceof Error ? error.message : String(error)
    ));
    expect(capturedErrorTexts.some((message) => /embedding generator not ready|not initialized/i.test(message))).toBe(false);

    return {
      durationsMs: {
        httpAck: ackMs,
        firstSearchTools: state.searchToolsMs,
      },
      searchToolsInvoked: searchToolsMock.mock.calls.length > 0,
      agentTurnDispatched: turnStarted,
    };
  } finally {
    unsubscribe();
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
    cleanupHarnessState();
  }
}
