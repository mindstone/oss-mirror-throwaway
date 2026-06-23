/**
 * Rebel Core Query — Context Overflow Fallback Path Tests
 *
 * Tests the fallback client resolution logic when context overflow occurs.
 * Covers: profile-based fallback, model-name fallback with Anthropic auth,
 * and graceful skip when no viable fallback is available.
 *
 * These tests mock the agent loop and client factory to isolate the
 * fallback routing logic in rebelCoreQuery.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { ChatMessage } from '../modelTypes';

// --- Module mocks (must be before imports) ---
const SKELETON_STATUS_MESSAGE =
  'Context was getting unwieldy, so I trimmed earlier tool work to keep going. Older lookups, screenshots, and intermediate steps were dropped. Ask me to redo any of them if you need the detail.';

// Mock agentLoop — we control when ContextOverflowError is thrown
const mockRunAgentLoop = vi.fn();
vi.mock('../agentLoop', async () => {
  const actual = await vi.importActual<typeof import('../agentLoop')>('../agentLoop');
  return {
    ...actual,
    runAgentLoop: (...args: unknown[]) => mockRunAgentLoop(...args),
  };
});

// Mock clientFactory — track what clients are created
const mockCreateModelClient = vi.fn();
const mockCreateClientForModel = vi.fn();
vi.mock('../clientFactory', () => ({
  createModelClient: (...args: unknown[]) => mockCreateModelClient(...args),
  createClientForModel: (...args: unknown[]) => mockCreateClientForModel(...args),
  resolveTargetForModel: (opts: { model: string; profile?: { providerType?: string } | null; settings: { localModel?: { profiles?: Array<{ model?: string; providerType?: string; enabled?: boolean; serverUrl?: string }> } } }) => {
    const profile = opts.profile ?? opts.settings?.localModel?.profiles?.find(
      (p: { model?: string; providerType?: string; enabled?: boolean }) => p.model === opts.model && p.enabled !== false,
    );
    if (profile?.providerType === 'google') {
      return { kind: 'anthropic-proxy', model: opts.model, proxyConfig: {}, proxyMode: 'google-thought-signatures', profile, resolvedFrom: 'explicit-profile' };
    }
    if (opts.model.startsWith('claude-')) {
      return { kind: 'anthropic-direct', model: opts.model, resolvedFrom: 'model-string' };
    }
    if (profile) {
      return { kind: 'openai-compatible', model: opts.model, profile, isLocal: false, resolvedFrom: 'explicit-profile' };
    }
    return { kind: 'default-routing', model: opts.model, resolvedFrom: 'working-profile' };
  },
  targetNeedsProxy: (target: { kind: string }) => target.kind === 'anthropic-proxy',
}));

// Mock planningMode — no real model resolution needed
vi.mock('../planningMode', () => ({
  resolveRuntimeModels: ({ env }: { model?: string; env?: Record<string, string> }) => ({
    executionModel: env?.CLAUDE_CODE_USE_MODEL ?? 'claude-sonnet-4-20250514',
    planningModel: null,
    displayModel: env?.CLAUDE_CODE_USE_MODEL ?? 'claude-sonnet-4-20250514',
    isPlanMode: false,
  }),
  buildExecutionSystemPrompt: vi.fn(),
  runPlanningPhase: vi.fn(),
  seedTaskStoreFromPlan: vi.fn(),
  hasMissionGoalTask: () => false,
  seedMissionGoalTask: vi.fn(),
}));

// Mock MCP — not relevant for fallback tests
vi.mock('../mcpClient', () => ({
  createMcpSession: vi.fn().mockResolvedValue(null),
  isMcpToolName: () => false,
}));

// Mock tool registry
vi.mock('../toolRegistry', () => ({
  executeRegisteredTool: vi.fn(),
  listRegisteredTools: () => [],
  hasRegisteredTool: () => false,
}));

// Mock hook pipeline
vi.mock('../hookPipeline', () => ({
  createHookAwareToolExecutor: (_exec: unknown) => _exec,
  runStopHooks: vi.fn(),
  runStopHooksWithReason: vi.fn(async () => ({ shouldContinue: false })),
}));

// Mock builtin tools
vi.mock('../builtinTools', () => ({
  MISSION_SET_TOOL_DEFINITION: { name: 'MissionSet', description: '', input_schema: { type: 'object', properties: {} } },
  GET_PREVIOUS_TASKS_TOOL_DEFINITION: { name: 'GetPreviousTasks', description: '', input_schema: { type: 'object', properties: {} } },
  executeBuiltinTool: vi.fn(),
  extractMissionContext: () => ({}),
  getBuiltinToolDefinitions: vi.fn().mockReturnValue([]),
  isBuiltinToolName: () => false,
}));

// Mock forager
vi.mock('../foragerPrompt', () => ({
  buildForagerAgentDef: () => ({
    description: 'Forager test agent',
    prompt: 'Forager test prompt',
    model: 'haiku',
    maxTurns: 1,
    lightweight: true,
  }),
  FORAGER_AGENT_NAME: 'forager',
  FORAGER_BTS_CATEGORY: 'foraging',
}));

// Mock agent tool
vi.mock('../agentTool', () => ({
  buildAgentToolDefinition: () => ({ name: 'Agent', description: '', input_schema: { type: 'object', properties: {} } }),
  executeAgentTool: vi.fn(),
}));

// Mock task state
vi.mock('../taskState', () => ({
  createTaskStore: () => ({
    listTasks: () => [],
    archiveTurn: vi.fn(),
  }),
  createScopedTaskStore: () => ({}),
}));

vi.mock('../taskStatePersistence', () => ({
  loadTaskBoard: vi.fn().mockResolvedValue({ loaded: false, recoveredCount: 0 }),
  saveTaskBoard: vi.fn().mockResolvedValue(undefined),
}));

// Mock agentMessageAdapter
const mockAdapterHandleEvent = vi.fn((..._args: unknown[]) => [] as unknown[]);
vi.mock('../agentMessageAdapter', () => ({
  createAgentMessageAdapter: () => ({
    createInitMessage: () => ({ type: 'system', subtype: 'init' }),
    handleEvent: (...args: unknown[]) => mockAdapterHandleEvent(...args),
    handleSubAgentEvent: () => [],
    createSyntheticToolCallPair: () => [],
  }),
}));

const mockAppendTranscriptEntry = vi.fn();
vi.mock('@core/services/transcriptService', () => ({
  appendTranscriptEntry: (...args: unknown[]) => mockAppendTranscriptEntry(...args),
  ensureTranscriptDir: vi.fn(),
  getTranscriptPath: vi.fn(() => '/tmp/rebel-transcript-test.jsonl'),
  createSeqCounter: () => {
    let seq = 0;
    return { next: () => ++seq };
  },
  serializeError: (err: unknown) => ({
    kind: 'error',
    message: err instanceof Error ? err.message : String(err),
  }),
}));

// Mock learned model limits
vi.mock('../learnedProfileWriter', () => ({
  recordContextOverflowOnProfile: vi.fn(),
}));

// Mock plugin service
vi.mock('../pluginServiceProvider', () => ({
  getBuiltinPluginService: () => null,
}));

// Mock authEnvUtils
const mockGetApiKeyForDirectUse = vi.fn();
const mockGetAuthForDirectUse = vi.fn();
const mockHasDirectAuth = vi.fn();
vi.mock('@core/utils/authEnvUtils', () => ({
  getApiKeyForDirectUse: (...args: unknown[]) => mockGetApiKeyForDirectUse(...args),
  getAuthForDirectUse: (...args: unknown[]) => mockGetAuthForDirectUse(...args),
  hasDirectAuth: (...args: unknown[]) => mockHasDirectAuth(...args),
}));

// Mock model limits
vi.mock('../modelLimits', () => ({
  shouldSuppressProfileReasoning: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => profile?.thinkingCompatibility === 'incompatible',
  resolveProfileReasoningEffort: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => (profile?.thinkingCompatibility === 'incompatible' ? undefined : profile?.reasoningEffort),
  resolveModelLimits: () => ({ contextWindow: 200000, maxOutputTokens: 8192 }),
  resolveThinkingConfig: () => ({ type: 'disabled' }),
  resolveEffortForApi: () => undefined,
}));

// Now import after all mocks
import { rebelCoreQuery } from '../rebelCoreQuery';
import * as agentLoopModule from '../agentLoop';
import { ContextOverflowError } from '../agentLoop';
import { ModelError } from '../modelErrors';

// Minimal settings factory
function makeSettings(overrides: {
  activeProvider?: 'anthropic' | 'openrouter' | 'codex';
  apiKey?: string | null;
  oauthToken?: string | null;
  openRouterToken?: string | null;
  workingProfileId?: string | null;
  longContextFallbackModel?: string;
  longContextFallbackProfileId?: string;
  profiles?: Array<{
    id: string;
    name: string;
    providerType?: 'openai' | 'google' | 'together' | 'cerebras' | 'other';
    serverUrl: string;
    apiKey?: string;
    model?: string;
  }>;
} = {}): AppSettings {
  const apiKey = Object.hasOwn(overrides, 'apiKey') ? overrides.apiKey : 'fake-ant-test-key';
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    activeProvider: overrides.activeProvider ?? 'anthropic',
    models: {
      apiKey,
      oauthToken: overrides.oauthToken ?? null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-20250514',
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
      workingProfileId: overrides.workingProfileId ?? null,
      longContextFallbackModel: overrides.longContextFallbackModel,
      longContextFallbackProfileId: overrides.longContextFallbackProfileId,
    },
    diagnostics: { enabled: false },
    localModel: {
      profiles: (overrides.profiles ?? []).map((p) => ({
        ...p,
        createdAt: Date.now(),
      })),
      activeProfileId: null,
    },
    openRouter: {
      enabled: overrides.activeProvider === 'openrouter',
      oauthToken: overrides.openRouterToken ?? null,
      selectedModel: 'anthropic/claude-sonnet-4.6',
    },
  } as unknown as AppSettings;
}

// Helper: create a ContextOverflowError
function makeOverflowError(compactedMessages: ChatMessage[] = [{ role: 'user', content: 'compacted message' }]): ContextOverflowError {
  const original = new ModelError('context_overflow', 'Context window exceeded', 400, 'anthropic');
  return new ContextOverflowError(original, compactedMessages);
}

// Sentinel objects for tracking which client was created
const PROFILE_OVERRIDE_CLIENT = { _type: 'profile-override' };
const PRIMARY_CLIENT = { _type: 'primary' };

// Helper: consume all messages from the async generator
async function drainGenerator(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const results: unknown[] = [];
  try {
    for await (const msg of gen) {
      results.push(msg);
    }
  } catch {
    // Expected — generator may throw on fallback failures
  }
  return results;
}

async function runGeneratorAndCaptureError(gen: AsyncGenerator<unknown>): Promise<Error | undefined> {
  try {
    for await (const _msg of gen) {
      // no-op
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function getEmittedEvents(): Array<{ type: string; [key: string]: unknown }> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for (const call of mockAdapterHandleEvent.mock.calls) {
    const event = (call as unknown[])[0];
    if (!!event && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string') {
      events.push(event as { type: string; [key: string]: unknown });
    }
  }
  return events;
}

describe('rebelCoreQuery — context overflow fallback', () => {
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockCreateModelClient.mockReset();
    mockCreateClientForModel.mockReset();
    mockGetApiKeyForDirectUse.mockReset();
    mockGetAuthForDirectUse.mockReset();
    mockHasDirectAuth.mockReset();
    mockAdapterHandleEvent.mockReset();
    mockAppendTranscriptEntry.mockReset();

    // Default: primary client creation returns a sentinel
    mockCreateModelClient.mockReturnValue(PRIMARY_CLIENT);
    mockCreateClientForModel.mockReturnValue(PRIMARY_CLIENT);
    mockGetApiKeyForDirectUse.mockReturnValue('fake-ant-test-key');
    mockGetAuthForDirectUse.mockReturnValue({ apiKey: 'fake-ant-test-key' });
    mockHasDirectAuth.mockReturnValue(true);
    mockAdapterHandleEvent.mockReturnValue([]);
  });

  const baseTurnParams = {
    model: 'claude-sonnet-4-20250514',
    cwd: '/tmp',
    systemPrompt: 'test',
    prompt: 'hello',
    permissionMode: 'plan' as const,
    env: {},
  };

  it('prepends recovery messages to runtime message history before the agent loop starts', async () => {
    const settings = makeSettings();
    const recoveryMessages: ChatMessage[] = [
      { role: 'user', content: 'Original stripped user request' },
      { role: 'assistant', content: 'Stripped assistant context' },
    ];
    mockRunAgentLoop.mockResolvedValueOnce({ turns: 1, totalUsage: {}, messageHistory: [] });

    const gen = rebelCoreQuery({ ...baseTurnParams, recoveryMessages }, { settings });
    await drainGenerator(gen);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expect((mockRunAgentLoop.mock.calls[0][0] as { messages: ChatMessage[] }).messages).toEqual([
      ...recoveryMessages,
      { role: 'user', content: 'hello' },
    ]);
  });

  it('fallback with longContextFallbackProfileId creates client via profileOverride', async () => {
    const settings = makeSettings({
      longContextFallbackProfileId: 'openai-fallback',
      longContextFallbackModel: 'gpt-5.5',
      profiles: [
        {
          id: 'openai-fallback',
          name: 'GPT-5.5 Fallback',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          apiKey: 'fake-openai-key',
          model: 'gpt-5.5',
        },
      ],
    });

    // First call (primary) succeeds normally until overflow
    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError())
      // Second call (fallback) succeeds
      .mockResolvedValueOnce({ turns: 1, totalUsage: {}, messageHistory: [] });

    // Fallback uses createClientForModel with provider-aware routing
    mockCreateClientForModel.mockReturnValue(PROFILE_OVERRIDE_CLIENT);

    const testProxyConfig = { baseURL: 'https://proxy.example.com/v1' };
    const gen = rebelCoreQuery(baseTurnParams, { settings, proxyConfig: testProxyConfig });
    await drainGenerator(gen);

    // Verify createClientForModel was called with explicit profile for the fallback
    expect(mockCreateClientForModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.5',
        profile: expect.objectContaining({ id: 'openai-fallback', providerType: 'openai' }),
        proxyConfig: testProxyConfig,
        context: 'execution',
      }),
    );

    // Primary and fallback both route through the public provider-aware seam.
    expect(mockCreateClientForModel).toHaveBeenCalledTimes(2);
  });

  it('fallback with longContextFallbackModel + Anthropic auth creates provider-aware client', async () => {
    const settings = makeSettings({
      longContextFallbackModel: 'claude-sonnet-4-20250514',
      // No fallback profile ID — uses model-name fallback
    });

    mockGetApiKeyForDirectUse.mockReturnValue('fake-ant-test-key');
    mockGetAuthForDirectUse.mockReturnValue({ apiKey: 'fake-ant-test-key' });

    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError())
      .mockResolvedValueOnce({ turns: 1, totalUsage: {}, messageHistory: [] });

    const gen = rebelCoreQuery(baseTurnParams, { settings });
    await drainGenerator(gen);

    // Primary and fallback both route through createClientForModel; the helper
    // resolves direct Anthropic internally when the active provider is Anthropic.
    expect(mockCreateClientForModel).toHaveBeenCalledTimes(2);
    expect(mockCreateClientForModel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: 'claude-sonnet-4-20250514',
        settings,
        context: 'execution',
      }),
    );
  });

  it('N11 routes model-name fallback through active OpenRouter provider despite lingering Anthropic key', async () => {
    const settings = makeSettings({
      activeProvider: 'openrouter',
      apiKey: 'fake-ant-lingering',
      openRouterToken: 'or-token',
      longContextFallbackModel: 'claude-sonnet-4-20250514',
    });

    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError())
      .mockResolvedValueOnce({ turns: 1, totalUsage: {}, messageHistory: [] });

    const proxyConfig = {
      baseURL: 'http://localhost:4001',
      defaultHeaders: { 'x-openrouter-turn': 'true' },
    };
    const gen = rebelCoreQuery(baseTurnParams, { settings, proxyConfig });
    await drainGenerator(gen);

    expect(mockCreateClientForModel).toHaveBeenCalledTimes(2);
    expect(mockCreateClientForModel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: 'claude-sonnet-4-20250514',
        settings: expect.objectContaining({ activeProvider: 'openrouter' }),
        proxyConfig,
        context: 'execution',
      }),
    );
    expect(mockCreateClientForModel).toHaveBeenCalledTimes(2);
  });

  it('fallback with longContextFallbackModel but NO Anthropic auth skips fallback', async () => {
    const settings = makeSettings({
      apiKey: null,
      longContextFallbackModel: 'claude-sonnet-4-20250514',
      workingProfileId: 'openai-1',
      profiles: [
        {
          id: 'openai-1',
          name: 'GPT-5.5',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          apiKey: 'fake-openai-key',
        },
      ],
    });

    // No Anthropic auth available (no API key, no OAuth)
    mockGetApiKeyForDirectUse.mockReturnValue('');
    mockGetAuthForDirectUse.mockReturnValue({});
    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError())
      .mockResolvedValueOnce({ turns: 1, totalUsage: {}, messageHistory: [] });

    const gen = rebelCoreQuery(
      { ...baseTurnParams, env: { CLAUDE_CODE_USE_MODEL: 'gpt-5.5' } },
      { settings },
    );

    // Should complete without throwing (graceful skip)
    try {
      await drainGenerator(gen);
    } catch {
      // The ContextOverflowError propagates as channel.fail — expected
    }

    // Verify fallback was NOT attempted — only the primary client is created.
    expect(mockCreateClientForModel).toHaveBeenCalledTimes(1);

    // Skeleton recovery still executes with the primary model after fallback is skipped.
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
    expect(mockAdapterHandleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery:skeleton' }),
    );
  });

  it('no fallback configured skips fallback entirely', async () => {
    const settings = makeSettings({
      // No longContextFallbackModel, no longContextFallbackProfileId
    });

    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError())
      .mockResolvedValueOnce({ turns: 1, totalUsage: {}, messageHistory: [] });

    const gen = rebelCoreQuery(baseTurnParams, { settings });

    try {
      await drainGenerator(gen);
    } catch {
      // ContextOverflowError propagates
    }

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
    expect(mockAdapterHandleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery:skeleton' }),
    );
  });

  it('fallback profile not found in profiles array skips fallback gracefully', async () => {
    const settings = makeSettings({
      longContextFallbackProfileId: 'nonexistent-profile',
      longContextFallbackModel: 'some-model',
    });

    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError())
      .mockResolvedValueOnce({ turns: 1, totalUsage: {}, messageHistory: [] });

    const gen = rebelCoreQuery(baseTurnParams, { settings });

    try {
      await drainGenerator(gen);
    } catch {
      // ContextOverflowError propagates
    }

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
    expect(mockAdapterHandleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery:skeleton' }),
    );
  });

  it('fallback profile uses profile model name when fallbackModel is not set', async () => {
    const settings = makeSettings({
      longContextFallbackProfileId: 'openai-fallback',
      // No longContextFallbackModel — should use profile's model
      profiles: [
        {
          id: 'openai-fallback',
          name: 'GPT-5.5 Fallback',
          providerType: 'openai',
          serverUrl: 'https://api.openai.com/v1',
          apiKey: 'fake-openai-key',
          model: 'gpt-5.5',
        },
      ],
    });

    mockCreateModelClient.mockImplementation((opts: Record<string, unknown>) => {
      if (opts.profileOverride) return PROFILE_OVERRIDE_CLIENT;
      return PRIMARY_CLIENT;
    });

    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError())
      .mockResolvedValueOnce({ turns: 1, totalUsage: {}, messageHistory: [] });

    const gen = rebelCoreQuery(baseTurnParams, { settings });
    await drainGenerator(gen);

    // Verify the fallback agent loop was called with the profile's model name
    const fallbackLoopCall = mockRunAgentLoop.mock.calls[1];
    expect(fallbackLoopCall).toBeDefined();
    expect((fallbackLoopCall[0] as Record<string, unknown>).model).toBe('gpt-5.5');
  });

  // Plan 260422/R4 routing hardening:
  // R2 threaded `{ model }` must reach createClientForModel for both primary
  // and fallback calls. We use distinct primary/fallback models so
  // toHaveBeenNthCalledWith can distinguish them, and pin CLAUDE_CODE_USE_MODEL
  // explicitly to avoid coupling to the planningMode mock default.
  it('R2/R4 threading: createClientForModel receives { model } on BOTH primary and fallback calls', async () => {
    const PRIMARY_MODEL = 'claude-sonnet-4-20250514';
    const FALLBACK_MODEL = 'claude-opus-4-5-20250514';
    const settings = makeSettings({
      longContextFallbackModel: FALLBACK_MODEL,
      // No fallback profile ID — uses model-name fallback → direct Anthropic
    });

    mockGetApiKeyForDirectUse.mockReturnValue('fake-ant-test-key');
    mockGetAuthForDirectUse.mockReturnValue({ apiKey: 'fake-ant-test-key' });

    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError())
      .mockResolvedValueOnce({ turns: 1, totalUsage: {}, messageHistory: [] });

    const turnParams = {
      ...baseTurnParams,
      model: PRIMARY_MODEL,
      env: { CLAUDE_CODE_USE_MODEL: PRIMARY_MODEL },
    };
    const gen = rebelCoreQuery(turnParams, { settings });
    await drainGenerator(gen);

    // Call-count guards (path-shape): primary + fallback = 2 provider-aware clients,
    // 2 agent-loop calls. If any path diverges, the Nth assertions below are diagnostic.
    expect(mockCreateClientForModel).toHaveBeenCalledTimes(2);
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);

    // Arg-shape assertions: primary path receives { model: PRIMARY }
    expect(mockCreateClientForModel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: PRIMARY_MODEL, settings, context: 'execution' }),
    );

    // Fallback path receives { model: FALLBACK }
    expect(mockCreateClientForModel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: FALLBACK_MODEL, settings, context: 'execution' }),
    );
  });

  // Plan 260422 routing test hardening — Stage 2.2:
  // Defense-in-depth guard at rebelCoreQuery.ts:357 throws a classified routing
  // error when a slash-dialect model reaches the direct path without a proxy
  // config. The guard prevents the silent-404 failure mode B2 where OR-format
  // model IDs (e.g. 'anthropic/claude-opus-4.7') could otherwise hit
  // createModelClient's PRECEDENCE 2 direct-Anthropic path. Note: drainGenerator()
  // swallows generator throws, so we must catch via manual async iteration.
  it('DiD guard: slash-dialect model + no proxy + no injected client throws classified routing error', async () => {
    const settings = makeSettings({});
    // Ensure the `else` branch (!executionClient) is taken and no proxy present.
    const turnParams = {
      ...baseTurnParams,
      model: 'anthropic/claude-opus-4.7',
      env: { CLAUDE_CODE_USE_MODEL: 'anthropic/claude-opus-4.7' },
    };
    const gen = rebelCoreQuery(turnParams, { settings });

    let caught: Error | undefined;
    try {
      // Manual iteration — drainGenerator() swallows the throw.
      for await (const _msg of gen) {
        // noop
      }
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    const e = caught as Error & { __agentErrorKind?: string; __routingCause?: string };
    // F2 (plan 260422_routing_followups_mock_and_kind): 'routing' is now a
    // first-class AgentErrorKind; the DiD guard stamps it directly instead of
    // masquerading as 'invalid_request'. `__routingCause` side-channel preserved.
    expect(e.__agentErrorKind).toBe('routing');
    expect(e.__routingCause).toBe('proxy-dialect-without-proxy-config');

    // Guard fires pre-client-construction; no client factory calls should happen.
    expect(mockCreateClientForModel).not.toHaveBeenCalled();
    expect(mockCreateModelClient).not.toHaveBeenCalled();
    // And no agent loop call — guard stops execution before the loop kicks off.
    expect(mockRunAgentLoop).not.toHaveBeenCalled();
  });

  it('Google/Gemini fallback profile receives proxyConfig for thought signature routing', async () => {
    const settings = makeSettings({
      longContextFallbackProfileId: 'gemini-fallback',
      longContextFallbackModel: 'gemini-2.5-pro',
      profiles: [
        {
          id: 'gemini-fallback',
          name: 'Gemini Fallback',
          providerType: 'google',
          serverUrl: 'https://generativelanguage.googleapis.com/v1',
          model: 'gemini-2.5-pro',
        },
      ],
    });

    mockCreateClientForModel.mockReturnValue(PROFILE_OVERRIDE_CLIENT);

    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError())
      .mockResolvedValueOnce({ turns: 1, totalUsage: {}, messageHistory: [] });

    const testProxyConfig = { baseURL: 'https://proxy.example.com/v1' };
    const gen = rebelCoreQuery(baseTurnParams, { settings, proxyConfig: testProxyConfig });
    await drainGenerator(gen);

    // Verify createClientForModel receives proxyConfig for Gemini thought signature routing
    expect(mockCreateClientForModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-pro',
        profile: expect.objectContaining({ id: 'gemini-fallback', providerType: 'google' }),
        proxyConfig: testProxyConfig,
        context: 'execution',
      }),
    );
  });

  it('ContextOverflowError → fallback fails → skeleton succeeds', async () => {
    const settings = makeSettings({
      longContextFallbackModel: 'claude-opus-4-5-20250514',
    });

    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError())
      .mockRejectedValueOnce(new Error('fallback failed'))
      .mockResolvedValueOnce({
        turns: 1,
        totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        messageHistory: [{ role: 'assistant', content: 'Recovered' }],
      });

    const error = await runGeneratorAndCaptureError(rebelCoreQuery(baseTurnParams, { settings }));

    expect(error).toBeUndefined();
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(3);
    expect(mockAdapterHandleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'recovery:skeleton',
        message: SKELETON_STATUS_MESSAGE,
      }),
    );
  });

  it('ContextOverflowError → no fallback configured → skeleton succeeds', async () => {
    const settings = makeSettings();

    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError())
      .mockResolvedValueOnce({
        turns: 1,
        totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        messageHistory: [{ role: 'assistant', content: 'Recovered' }],
      });

    const error = await runGeneratorAndCaptureError(rebelCoreQuery(baseTurnParams, { settings }));

    expect(error).toBeUndefined();
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
    expect(mockCreateClientForModel).toHaveBeenCalledTimes(1);
    expect(mockAdapterHandleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery:skeleton' }),
    );
  });

  it('ContextOverflowError → fallback fails → skeleton preflight overflow fails turn', async () => {
    const settings = makeSettings({
      longContextFallbackModel: 'claude-opus-4-5-20250514',
    });
    const hugeMessage = 'x'.repeat(5_000_000);

    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError([{ role: 'user', content: hugeMessage }]))
      .mockRejectedValueOnce(new Error('fallback failed'));

    const error = await runGeneratorAndCaptureError(rebelCoreQuery(baseTurnParams, { settings }));

    expect(error).toBeDefined();
    expect(error?.message).toBe(
      'Even a stripped-down retry exceeded the model\'s context. The current request may be too large; please start a new conversation.',
    );
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
    expect(mockAdapterHandleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery:skeleton' }),
    );
  });

  it('channel.fail is invoked when buildSkeletonMessages throws', async () => {
    const settings = makeSettings({
      longContextFallbackModel: 'claude-opus-4-5-20250514',
    });
    const overflowError = makeOverflowError();

    const buildSkeletonSpy = vi.spyOn(agentLoopModule, 'buildSkeletonMessages')
      .mockImplementationOnce(() => {
        throw new Error('skeleton helper exploded');
      });

    try {
      mockRunAgentLoop
        .mockRejectedValueOnce(overflowError)
        .mockRejectedValueOnce(new Error('fallback failed'));

      const error = await runGeneratorAndCaptureError(rebelCoreQuery(baseTurnParams, { settings }));

      expect(error).toBeDefined();
      expect(error?.message).toBe('skeleton helper exploded');
      expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
      expect(getEmittedEvents().some((event) => event.type === 'recovery:skeleton')).toBe(false);
    } finally {
      buildSkeletonSpy.mockRestore();
    }
  });

  it('preserves ContextOverflowError as cause when skeleton fails', async () => {
    const settings = makeSettings({
      longContextFallbackModel: 'claude-opus-4-5-20250514',
    });
    const overflowError = makeOverflowError();

    mockRunAgentLoop
      .mockRejectedValueOnce(overflowError)
      .mockRejectedValueOnce(new Error('fallback failed'))
      .mockRejectedValueOnce(new Error('skeleton failed'));

    const error = await runGeneratorAndCaptureError(rebelCoreQuery(baseTurnParams, { settings }));

    expect(error).toBeDefined();
    expect(error?.message).toBe('skeleton failed');
    expect((error as Error & { cause?: unknown })?.cause).toBe(overflowError);
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(3);
    expect(mockAdapterHandleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'recovery:skeleton' }),
    );
  });

  it('channel.finish (not fail) when skeleton attempt is aborted', async () => {
    const settings = makeSettings({
      longContextFallbackModel: 'claude-opus-4-5-20250514',
    });
    const abortController = new AbortController();

    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError())
      .mockRejectedValueOnce(new Error('fallback failed'))
      .mockImplementationOnce(async () => {
        abortController.abort();
        const abortError = new Error('skeleton attempt aborted');
        abortError.name = 'AbortError';
        throw abortError;
      });

    const error = await runGeneratorAndCaptureError(rebelCoreQuery(
      { ...baseTurnParams, abortController },
      { settings },
    ));

    expect(error).toBeUndefined();
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(3);
    expect(getEmittedEvents().some((event) => event.type === 'recovery:skeleton')).toBe(true);
    expect(getEmittedEvents().some((event) => event.type === 'turn:error')).toBe(false);
  });

  it('ContextOverflowError after abort signal does not attempt skeleton', async () => {
    const settings = makeSettings();
    const abortController = new AbortController();
    abortController.abort();

    mockRunAgentLoop.mockRejectedValueOnce(makeOverflowError());

    const error = await runGeneratorAndCaptureError(rebelCoreQuery(
      { ...baseTurnParams, abortController },
      { settings },
    ));

    expect(error).toBeDefined();
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expect(getEmittedEvents().some((event) => event.type === 'recovery:skeleton')).toBe(false);
  });

  it('integration chain: overflow → fallback fails → skeleton succeeds with sanitized fixture + transcript marker', async () => {
    const settings = makeSettings({
      longContextFallbackModel: 'claude-opus-4-5-20250514',
    });
    const fixture: ChatMessage[] = [
      { role: 'user', content: 'Please continue the report draft.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running screenshot tool now.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
          { type: 'thinking', thinking: 'hidden reasoning' },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: [
            { type: 'text', text: 'Saved screenshot to /tmp/capture.png' },
            { type: 'image', data: 'A'.repeat(4000), mimeType: 'image/png' },
            { type: 'image', data: 'B'.repeat(4000), mimeType: 'image/png' },
          ],
        }],
      },
    ];

    mockRunAgentLoop
      .mockRejectedValueOnce(makeOverflowError(fixture))
      .mockRejectedValueOnce(new Error('fallback failed'))
      .mockImplementationOnce(async (...args: unknown[]) => {
        const [config, , onEvent] = args as [Record<string, unknown>, unknown, (event: { type: string; [key: string]: unknown }) => void];
        const skeletonMessages = config.messages as ChatMessage[];
        const hasTranscriptMarker = mockAppendTranscriptEntry.mock.calls.some(([entry]) => (
          (entry as { event?: { kind?: string; tag?: string } }).event?.kind === 'synthetic'
          && (entry as { event?: { kind?: string; tag?: string } }).event?.tag === 'recovery:skeleton:start'
        ));
        expect(hasTranscriptMarker).toBe(true);
        expect(config.model).toBe(baseTurnParams.model);
        expect(skeletonMessages.some((message) => (
          Array.isArray(message.content)
          && message.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result')
        ))).toBe(false);
        expect(skeletonMessages.some((message) => (
          Array.isArray(message.content)
          && message.content.some((block) => (block as { type?: string }).type === 'image')
        ))).toBe(false);

        onEvent({ type: 'assistant:text', text: 'Recovered from skeleton mode' });
        return {
          turns: 1,
          totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
          messageHistory: [{ role: 'assistant', content: 'Recovered from skeleton mode' }],
        };
      });

    const error = await runGeneratorAndCaptureError(rebelCoreQuery(
      baseTurnParams,
      { settings, sessionId: 'session-1', turnId: 'turn-1' },
    ));

    expect(error).toBeUndefined();
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(3);

    const events = getEmittedEvents();
    const fallbackIndex = events.findIndex((event) => event.type === 'recovery:fallback');
    const skeletonIndex = events.findIndex((event) => event.type === 'recovery:skeleton');
    expect(fallbackIndex).toBeGreaterThanOrEqual(0);
    expect(skeletonIndex).toBeGreaterThan(fallbackIndex);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'recovery:skeleton',
      message: SKELETON_STATUS_MESSAGE,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'assistant:text',
      text: 'Recovered from skeleton mode',
    }));
  });
});
