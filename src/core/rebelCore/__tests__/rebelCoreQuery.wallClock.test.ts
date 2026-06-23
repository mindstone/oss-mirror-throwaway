/**
 * Rebel Core Query — Wall-Clock Deadline Tests
 *
 * Verifies the Layer-0 wall-clock sentinel behavior. After Stage 1 of the
 * watchdog LLM-judge plan, this is a 6-hour sentinel above the watchdog's
 * effective per-turn ceiling — it just guards against catastrophic stuck
 * generators, not normal turn lengths.
 *
 * 1. Turn that exceeds the sentinel → abort signal fires
 * 2. Turn that completes normally → timeout cleared, no abort
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSettings } from '@shared/types';

// --- Module mocks (must be before imports) ---

const mockRunAgentLoop = vi.fn();
vi.mock('../agentLoop', async () => {
  const actual = await vi.importActual<typeof import('../agentLoop')>('../agentLoop');
  return {
    ...actual,
    runAgentLoop: (...args: unknown[]) => mockRunAgentLoop(...args),
  };
});

const mockCreateModelClient = vi.fn();
const mockCreateClientForModel = vi.fn();
vi.mock('../clientFactory', () => ({
  createModelClient: (...args: unknown[]) => mockCreateModelClient(...args),
  createClientForModel: (...args: unknown[]) => mockCreateClientForModel(...args),
  resolveTargetForModel: () => ({ kind: 'anthropic-direct', model: 'claude-sonnet-4-20250514', resolvedFrom: 'model-string' }),
  targetNeedsProxy: () => false,
}));

vi.mock('../planningMode', () => ({
  resolveRuntimeModels: () => ({
    executionModel: 'claude-sonnet-4-20250514',
    planningModel: null,
    displayModel: 'claude-sonnet-4-20250514',
    isPlanMode: false,
  }),
  buildExecutionSystemPrompt: vi.fn(),
  runPlanningPhase: vi.fn(),
  seedTaskStoreFromPlan: vi.fn(),
  hasMissionGoalTask: () => false,
  seedMissionGoalTask: vi.fn(),
}));

vi.mock('../mcpClient', () => ({
  createMcpSession: vi.fn().mockResolvedValue(null),
  isMcpToolName: () => false,
}));

vi.mock('../toolRegistry', () => ({
  executeRegisteredTool: vi.fn(),
  listRegisteredTools: () => [],
  hasRegisteredTool: () => false,
}));

vi.mock('../hookPipeline', () => ({
  createHookAwareToolExecutor: (_exec: unknown) => _exec,
  runStopHooks: vi.fn(),
  runStopHooksWithReason: vi.fn(async () => ({ shouldContinue: false })),
}));

vi.mock('../builtinTools', () => ({
  MISSION_SET_TOOL_DEFINITION: { name: 'MissionSet', description: '', input_schema: { type: 'object', properties: {} } },
  GET_PREVIOUS_TASKS_TOOL_DEFINITION: { name: 'GetPreviousTasks', description: '', input_schema: { type: 'object', properties: {} } },
  executeBuiltinTool: vi.fn(),
  extractMissionContext: () => ({}),
  getBuiltinToolDefinitions: vi.fn().mockReturnValue([]),
  isBuiltinToolName: () => false,
}));

vi.mock('../foragerPrompt', () => ({
  buildForagerAgentDef: () => ({
    description: 'Forager test agent',
    prompt: 'test',
    model: 'haiku',
    maxTurns: 1,
    lightweight: true,
  }),
  FORAGER_AGENT_NAME: 'forager',
  FORAGER_BTS_CATEGORY: 'foraging',
}));

vi.mock('../agentTool', () => ({
  buildAgentToolDefinition: () => ({ name: 'Agent', description: '', input_schema: { type: 'object', properties: {} } }),
  executeAgentTool: vi.fn(),
}));

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

vi.mock('../agentMessageAdapter', () => ({
  createAgentMessageAdapter: () => ({
    createInitMessage: () => ({ type: 'system', subtype: 'init' }),
    handleEvent: () => [],
    handleSubAgentEvent: () => [],
    createSyntheticToolCallPair: () => [],
    mergeSubAgentUsage: vi.fn(),
  }),
}));

vi.mock('../learnedProfileWriter', () => ({
  recordContextOverflowOnProfile: vi.fn(),
}));

vi.mock('../pluginServiceProvider', () => ({
  getBuiltinPluginService: () => null,
}));

vi.mock('@core/utils/authEnvUtils', () => ({
  getApiKeyForDirectUse: () => 'fake-test',
  getAuthForDirectUse: () => ({ apiKey: 'fake-test' }),
  hasDirectAuth: () => true,
}));

vi.mock('../modelLimits', () => ({
  shouldSuppressProfileReasoning: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => profile?.thinkingCompatibility === 'incompatible',
  resolveProfileReasoningEffort: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => (profile?.thinkingCompatibility === 'incompatible' ? undefined : profile?.reasoningEffort),
  resolveModelLimits: () => ({ contextWindow: 200_000, maxOutputTokens: 8192 }),
  resolveThinkingConfig: () => ({ type: 'disabled' }),
  resolveEffortForApi: () => undefined,
}));

vi.mock('../settingsAccessors', () => ({
  getModelEfforts: () => ({}),
  getGlobalThinkingEffort: () => undefined,
  getContextOverflowFallbackModel: () => undefined,
  getContextOverflowFallbackProfileId: () => undefined,
}));

vi.mock('../contextPolicy', () => ({
  decideCompaction: () => ({ action: 'none' }),
  DEFAULT_COMPACTION_CONFIG: {},
}));

vi.mock('../contextPruning', () => ({
  pruneOldToolPairs: vi.fn(),
}));

vi.mock('../contextStateUpdate', () => ({
  extractOldToolPairs: () => [],
  updateContextStateViaLLM: vi.fn(),
}));

vi.mock('../contextPreservation', () => ({
  formatContextStateSummary: () => '',
}));

// Now import after all mocks
import { rebelCoreQuery } from '../rebelCoreQuery';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function makeSettings(): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    models: {
      apiKey: 'fake-ant-test-key',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-20250514',
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
    },
    localModel: {
      workingProfileId: null,
      profiles: [],
      longContextFallbackModel: undefined,
      longContextFallbackProfileId: undefined,
    },
  } as unknown as AppSettings;
}

const mockClient = {
  stream: vi.fn(),
  capabilities: {},
};

describe('rebelCoreQuery wall-clock deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockCreateModelClient.mockReturnValue(mockClient);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts the turn after the Layer-0 wall-clock sentinel (6 hours)', async () => {
    const abortController = new AbortController();

    // Mock runAgentLoop to hang indefinitely until aborted
    mockRunAgentLoop.mockImplementation(async (config: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        config.signal?.addEventListener('abort', () => {
          const err = new Error('Operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const gen = rebelCoreQuery(
      {
        model: 'claude-sonnet-4-6',
        prompt: 'test prompt',
        systemPrompt: 'test system',
        abortController,
      },
      { settings: makeSettings() },
    );

    // Consume the init message — the generator pauses at `yield adapter.createInitMessage()`
    await gen.next();

    // Start the next iteration — this continues execution past the yield,
    // sets up the wall-clock timer, starts runWithStopHooks(), and enters `yield* channel`.
    // The promise won't resolve until the channel produces or finishes,
    // but we need the timer to be registered first.
    const nextPromise = gen.next();

    // Flush microtasks so that the async setup inside the generator body completes
    // (MCP session, task board, etc.) and the setTimeout is registered.
    await vi.advanceTimersByTimeAsync(100);

    // Advance past the Layer-0 sentinel — this fires the setTimeout callback
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

    // The abort signal should have been triggered
    expect(abortController.signal.aborted).toBe(true);

    // Drain the generator to prevent dangling promises
    try {
      await nextPromise;
    } catch {
      // AbortError expected
    }
    try {
      for await (const _msg of gen) {
        // drain
      }
    } catch {
      // AbortError expected
    }
  });

  it('clears the timeout when the turn completes normally', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    // Mock runAgentLoop to complete immediately
    mockRunAgentLoop.mockResolvedValue({
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      turns: 1,
      messageHistory: [],
    });

    const gen = rebelCoreQuery(
      {
        model: 'claude-sonnet-4-6',
        prompt: 'test prompt',
        systemPrompt: 'test system',
      },
      { settings: makeSettings() },
    );

    // Drain the generator
    const messages = [];
    for await (const msg of gen) {
      messages.push(msg);
    }

    // clearTimeout should have been called (timer was cleaned up)
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(0);

    clearTimeoutSpy.mockRestore();
  });
});
