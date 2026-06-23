/**
 * FOX-3097 — Task-board forced-continuation yield detection.
 *
 * Pre-implementation verification (per Diagnosis DA): the "seeded connector
 * build" bug produces 4 stacked question paragraphs. Two candidate paths:
 *   • Path A — outer `runWithStopHooks` forces 4 retries; each retry re-emits
 *     the same question, and `conversationState.ts` aggregates them.
 *   • Path B — a single outer attempt where the inner `runAgentLoop` fires
 *     the question 4× across model iterations.
 *
 * These tests mock `runAgentLoop` so each invocation is exactly one outer
 * attempt. By counting invocations, we distinguish the two paths:
 *   • If the unpatched code invokes `runAgentLoop` N>1 times → Path A.
 *   • If it invokes it once → Path B (our fix wouldn't help; brief says to
 *     extend to adapter-boundary dedupe).
 *
 * The "baseline reproduction" test below empirically reproduces Path A on the
 * unpatched behavior surface (seeded plan tasks + plain-text question + Stop
 * hook present). The "fix behavior" test then verifies `isYieldingToUser`
 * collapses it back to 1 invocation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings, AgentEvent } from '@shared/types';
import type { RebelCoreTask } from '../taskState';

// -----------------------------------------------------------------------------
// Shared state controlled by each test
// -----------------------------------------------------------------------------

let taskStoreTasks: RebelCoreTask[] = [];
let runAgentLoopCallCount = 0;
let runStopHooksReturn = true; // default: Stop hook says "continue" (simulates auto-continue loop)

// -----------------------------------------------------------------------------
// Module mocks (must come before imports)
// -----------------------------------------------------------------------------

const mockRunAgentLoop = vi.fn();
vi.mock('../agentLoop', async () => {
  const actual = await vi.importActual<typeof import('../agentLoop')>('../agentLoop');
  return {
    ...actual,
    runAgentLoop: (...args: unknown[]) => mockRunAgentLoop(...args),
  };
});

vi.mock('../clientFactory', () => {
  const mockClient = { stream: vi.fn(), capabilities: {} };
  return {
    createModelClient: () => mockClient,
    createClientForModel: () => mockClient,
    resolveTargetForModel: () => ({
      kind: 'anthropic-direct',
      model: 'claude-sonnet-4-20250514',
      resolvedFrom: 'model-string',
    }),
    targetNeedsProxy: () => false,
  };
});

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
  hasMissionGoalTask: () => true, // skip synthetic mission seed path
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
  createHookAwareToolExecutor: (exec: unknown) => exec,
  runStopHooks: vi.fn(async () => runStopHooksReturn),
  runStopHooksWithReason: vi.fn(async () => ({ shouldContinue: runStopHooksReturn })),
}));

vi.mock('../builtinTools', () => ({
  MISSION_SET_TOOL_DEFINITION: {
    name: 'MissionSet',
    description: '',
    input_schema: { type: 'object', properties: {} },
  },
  GET_PREVIOUS_TASKS_TOOL_DEFINITION: {
    name: 'GetPreviousTasks',
    description: '',
    input_schema: { type: 'object', properties: {} },
  },
  executeBuiltinTool: vi.fn(),
  extractMissionContext: () => ({}),
  getBuiltinToolDefinitions: vi.fn().mockReturnValue([]),
  isBuiltinToolName: () => false,
}));

vi.mock('../foragerPrompt', () => ({
  buildForagerAgentDef: () => ({
    description: 'test',
    prompt: 'test',
    model: 'haiku',
    maxTurns: 1,
    lightweight: true,
  }),
  FORAGER_AGENT_NAME: 'forager',
  FORAGER_BTS_CATEGORY: 'foraging',
}));

vi.mock('../agentTool', () => ({
  buildAgentToolDefinition: () => ({
    name: 'Agent',
    description: '',
    input_schema: { type: 'object', properties: {} },
  }),
  executeAgentTool: vi.fn(),
}));

vi.mock('../taskState', () => {
  const archiveTurn = vi.fn();
  return {
    createTaskStore: () => ({
      listTasks: () => taskStoreTasks,
      archiveTurn,
      getContextState: () => ({ currentGoal: null, workInProgress: null, relevantHistory: [] }),
      updateContextState: vi.fn(),
      getCompactionDeferred: () => false,
      setCompactionDeferred: vi.fn(),
    }),
    createScopedTaskStore: () => ({}),
  };
});

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

vi.mock('../contextPruning', () => ({ pruneOldToolPairs: vi.fn() }));

vi.mock('../contextStateUpdate', () => ({
  extractOldToolPairs: () => [],
  updateContextStateViaLLM: vi.fn(),
}));

vi.mock('../contextPreservation', () => ({ formatContextStateSummary: () => '' }));

// -----------------------------------------------------------------------------
// Import under test (must come after mocks)
// -----------------------------------------------------------------------------

import { rebelCoreQuery } from '../rebelCoreQuery';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';

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
      permissionMode: 'default',
      executablePath: null,
      planMode: false,
    },
    localModel: {
      workingProfileId: null,
      profiles: [],
      longContextFallbackModel: undefined,
      longContextFallbackProfileId: undefined,
    },
  } as unknown as AppSettings;
}

/**
 * Simulate a turn where the assistant emits a plain-text question and nothing
 * else. Populates the accumulator directly (bypassing the adapter, which is
 * mocked) so the side-effect detector branch in `hasLegitimateYieldSignal`
 * has turnEvents to scan.
 */
function seedAssistantQuestionEvent(turnId: string, text: string): void {
  const accumulator = agentTurnRegistry.getOrCreateAccumulator(turnId);
  const event: AgentEvent = {
    type: 'assistant',
    text,
    timestamp: Date.now(),
  } as AgentEvent;
  accumulator.appendEvent(event);
}

/**
 * Build a `messageHistory` entry matching the Anthropic-style assistant
 * message shape. Since Phase 7b, `runWithStopHooks` sources
 * `lastAssistantText` directly from the returned `result.messageHistory`
 * (synchronously populated by `runAgentLoop`) instead of from the
 * asynchronously-populated registry accumulator — so the mock's return value
 * must include the assistant message for the predicate to see it.
 */
function assistantMessageHistoryEntry(text: string): { role: 'assistant'; content: Array<{ type: 'text'; text: string }> } {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  };
}

async function drainGenerator(
  gen: AsyncGenerator<unknown, void, unknown>,
): Promise<void> {
  try {
    for await (const _msg of gen) {
      // drain
    }
  } catch {
    // swallow — some mocks intentionally don't yield a full result
  }
}

// =============================================================================
// Tests
// =============================================================================

const SEEDED_QUESTION =
  "What would you like to connect to Rebel? Just type the name of the service (e.g., 'Zendesk', 'our internal CRM') and a link to their site or API docs if you have one — that helps me get started faster.";

// Minimal `RebelCoreHookMatcher` that forces `hooks.Stop?.length > 0` so the
// `isLastAttempt` branch in `runWithStopHooks` evaluates to false for
// attempts 0..2. `runStopHooks` is mocked at the module level (see below).
const NOOP_STOP_HOOK = {
  matcher: '*',
  hooks: [async () => ({})],
} as unknown as import('../types').RebelCoreHookMatcher;

describe('runWithStopHooks — task-board forced continuation (FOX-3097)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskStoreTasks = [];
    runAgentLoopCallCount = 0;
    runStopHooksReturn = false; // default: allow stop unless test overrides

    // Default mock implementation — seeds a legitimate-yield question. Tests
    // that need different phrasing override via `mockRunAgentLoop.mockImplementation`.
    mockRunAgentLoop.mockImplementation(async (_config: unknown) => {
      runAgentLoopCallCount += 1;
      const turnId = 'test-turn-fox-3097';
      seedAssistantQuestionEvent(turnId, SEEDED_QUESTION);
      return {
        totalUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        turns: 1,
        messageHistory: [assistantMessageHistoryEntry(SEEDED_QUESTION)],
      };
    });
  });

  /**
   * Build a task-store row whose `createdAt` / `updatedAt` match the future
   * `turnStartTime` captured inside `runWithStopHooks`. We can't read that
   * timestamp directly, but the task-board filter uses
   * `(t.createdAt >= turnStartTime || t.updatedAt >= turnStartTime)`, so
   * stamping tasks with `Date.now() + skew` from the test body guarantees
   * they survive the filter.
   */
  function makeTurnCreatedTask(
    overrides: Partial<RebelCoreTask> = {},
  ): RebelCoreTask {
    // Use a far-future timestamp to dodge timing jitter between test setup
    // and the in-product `Date.now()` captured as turnStartTime.
    const future = Date.now() + 60_000;
    return {
      id: 't1',
      title: 'Phase 0',
      status: 'in_progress',
      createdAt: future,
      updatedAt: future,
      ...overrides,
    } as RebelCoreTask;
  }

  it('[path A reproduction] without fix, seeded tasks + plain-text question loops 4 times', async () => {
    // Simulate the fix DISABLED by using a yield-incompatible message.
    // The "next I'll ..." phrasing is gated by the lazy-continuation guard
    // inside `isYieldingToUser` → returns false → falls through to forced
    // continuation. Proves the 4-attempt loop is indeed Path A.
    taskStoreTasks = [
      makeTurnCreatedTask({ id: 't1', title: 'Phase 0', status: 'in_progress' }),
      makeTurnCreatedTask({ id: 't2', title: 'Phase 1', status: 'pending' }),
    ];

    mockRunAgentLoop.mockImplementation(async () => {
      runAgentLoopCallCount += 1;
      const text = "Next, I'll fetch the API docs and continue building the connector.";
      seedAssistantQuestionEvent('test-turn-fox-3097', text);
      return {
        totalUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        turns: 1,
        messageHistory: [assistantMessageHistoryEntry(text)],
      };
    });

    const gen = rebelCoreQuery(
      {
        model: 'claude-sonnet-4-20250514',
        prompt: 'test prompt',
        systemPrompt: 'test system',
        hooks: { Stop: [NOOP_STOP_HOOK] },
      },
      { settings: makeSettings(), turnId: 'test-turn-fox-3097' },
    );

    await drainGenerator(gen);

    // Path A confirmed: 4 outer attempts (attempt = 0, 1, 2, 3) because the
    // task-board sees incomplete tasks AND the last message does NOT look
    // like a legitimate yield.
    expect(runAgentLoopCallCount).toBe(4);

    agentTurnRegistry.cleanupTurn('test-turn-fox-3097');
  });

  it('[fix — case 1] seeded tasks + plain-text yield → stops after 1 attempt', async () => {
    taskStoreTasks = [
      makeTurnCreatedTask({ id: 't1', title: 'Phase 0', status: 'in_progress' }),
      makeTurnCreatedTask({ id: 't2', title: 'Phase 1', status: 'pending' }),
    ];

    const gen = rebelCoreQuery(
      {
        model: 'claude-sonnet-4-20250514',
        prompt: 'test prompt',
        systemPrompt: 'test system',
        hooks: { Stop: [NOOP_STOP_HOOK] },
      },
      { settings: makeSettings(), turnId: 'test-turn-fox-3097' },
    );

    await drainGenerator(gen);

    // Fix behavior: isYieldingToUser returns true (legitimate plain-text
    // question + no task work) → task-board continuation is skipped → Stop
    // hook returns false (allow stop) → single outer attempt.
    expect(runAgentLoopCallCount).toBe(1);

    agentTurnRegistry.cleanupTurn('test-turn-fox-3097');
  });

  it('[fix — case 2] seeded tasks + NO user-yield handoff → still forces continuation', async () => {
    taskStoreTasks = [
      makeTurnCreatedTask({ id: 't1', title: 'Phase 0', status: 'in_progress' }),
    ];

    mockRunAgentLoop.mockImplementation(async () => {
      runAgentLoopCallCount += 1;
      const text = "Now I'll proceed to fetch the API docs.";
      seedAssistantQuestionEvent('test-turn-fox-3097', text);
      return {
        totalUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        turns: 1,
        messageHistory: [assistantMessageHistoryEntry(text)],
      };
    });

    const gen = rebelCoreQuery(
      {
        model: 'claude-sonnet-4-20250514',
        prompt: 'test prompt',
        systemPrompt: 'test system',
        hooks: { Stop: [NOOP_STOP_HOOK] },
      },
      { settings: makeSettings(), turnId: 'test-turn-fox-3097' },
    );

    await drainGenerator(gen);

    // Completion-verification invariant preserved: no legitimate yield signal,
    // so task-board forces continuation until the retry budget is exhausted.
    expect(runAgentLoopCallCount).toBe(4);

    agentTurnRegistry.cleanupTurn('test-turn-fox-3097');
  });

  it('[fix — case 3] AskUserQuestion pending → bypasses continuation as before', async () => {
    taskStoreTasks = [
      makeTurnCreatedTask({ id: 't1', title: 'Phase 0', status: 'in_progress' }),
    ];

    // Mark user question pending BEFORE the turn runs. This is the structured
    // AskUserQuestion fast path — must short-circuit task-board continuation.
    agentTurnRegistry.markUserQuestionPending('test-turn-fox-3097');

    // Use a message with no plain-text yield signal so the ONLY exemption in
    // effect is `hasUserQuestionPending` — proving the fast path still works.
    mockRunAgentLoop.mockImplementation(async () => {
      runAgentLoopCallCount += 1;
      const text = 'Proceeding with option A.';
      seedAssistantQuestionEvent('test-turn-fox-3097', text);
      return {
        totalUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        turns: 1,
        messageHistory: [assistantMessageHistoryEntry(text)],
      };
    });

    const gen = rebelCoreQuery(
      {
        model: 'claude-sonnet-4-20250514',
        prompt: 'test prompt',
        systemPrompt: 'test system',
        hooks: { Stop: [NOOP_STOP_HOOK] },
      },
      { settings: makeSettings(), turnId: 'test-turn-fox-3097' },
    );

    await drainGenerator(gen);

    expect(runAgentLoopCallCount).toBe(1);

    agentTurnRegistry.clearUserQuestionPending('test-turn-fox-3097');
    agentTurnRegistry.cleanupTurn('test-turn-fox-3097');
  });

  it('[regression — FOX-3097 Phase 7b accumulator race] accumulator empty + messageHistory populated → yields (1 attempt)', async () => {
    // Locks down GPT-5.5's Round 2 Must-Address: the predicate must not
    // depend on the asynchronously-populated registry accumulator for
    // `lastAssistantText`. This mock explicitly does NOT seed the
    // accumulator — only the return value's `messageHistory` — to prove the
    // yield decision is driven by the synchronous `result.messageHistory`.
    taskStoreTasks = [
      makeTurnCreatedTask({ id: 't1', title: 'Phase 0', status: 'in_progress' }),
      makeTurnCreatedTask({ id: 't2', title: 'Phase 1', status: 'pending' }),
    ];

    mockRunAgentLoop.mockImplementation(async () => {
      runAgentLoopCallCount += 1;
      // Deliberately do NOT call seedAssistantQuestionEvent — the accumulator
      // is left empty to simulate the worst-case microtask-ordering scenario.
      return {
        totalUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        turns: 1,
        messageHistory: [assistantMessageHistoryEntry(SEEDED_QUESTION)],
      };
    });

    const gen = rebelCoreQuery(
      {
        model: 'claude-sonnet-4-20250514',
        prompt: 'test prompt',
        systemPrompt: 'test system',
        hooks: { Stop: [NOOP_STOP_HOOK] },
      },
      { settings: makeSettings(), turnId: 'test-turn-fox-3097' },
    );

    await drainGenerator(gen);

    // With only messageHistory populated (accumulator empty), the yield
    // predicate must still correctly recognize the Phase 0.0 question →
    // 1 attempt, not 4.
    expect(runAgentLoopCallCount).toBe(1);

    agentTurnRegistry.cleanupTurn('test-turn-fox-3097');
  });

  it('[regression — FOX-3097 Phase 7b] TaskUpdate(status=completed) before Phase 0.0 question → yields (1 attempt)', async () => {
    // Reproduces the production bug from transcript
    // 57a52249-078d-4696-ab8d-05f9436e4247. Before Phase 7b, the model marked
    // its "Ask the user" task `completed` via TaskUpdate, then emitted the
    // question — and the old predicate treated that completion as "work in
    // progress" → task-board forced continuation fired 3 more times, each
    // emitting the same reminder paragraph.
    const future = Date.now() + 60_000;
    taskStoreTasks = [
      makeTurnCreatedTask({
        id: 't1',
        title: 'Ask the user which service they want to connect',
        status: 'completed',
        createdAt: future,
        updatedAt: future + 50, // TaskUpdate fired just after creation
      }),
      makeTurnCreatedTask({ id: 't2', title: 'Phase 1', status: 'pending' }),
      makeTurnCreatedTask({ id: 't8', title: 'Phase 3', status: 'pending' }),
    ];

    const gen = rebelCoreQuery(
      {
        model: 'claude-sonnet-4-20250514',
        prompt: 'test prompt',
        systemPrompt: 'test system',
        hooks: { Stop: [NOOP_STOP_HOOK] },
      },
      { settings: makeSettings(), turnId: 'test-turn-fox-3097' },
    );

    await drainGenerator(gen);

    // Completed task + untouched pending seeds must not block the yield for
    // the real Phase 0.0 question phrasing.
    expect(runAgentLoopCallCount).toBe(1);

    agentTurnRegistry.cleanupTurn('test-turn-fox-3097');
  });

  it('[fix — case 4] task actively in-progress this turn + handoff-like message → forced-continuation preserved (known limitation, tracked in YieldToUser plan)', async () => {
    // Invariant under test: when the model has actually done work in this
    // turn (TaskUpdate fired → `updatedAt > createdAt`), `isYieldingToUser`
    // returns false by design — the completion-verification safety net from
    // commit `0be8a51df` must still catch mid-work questions to prevent the
    // "created tasks, walked away" failure mode.
    //
    // Known limitation (FOX-3097 Phase 6 reviewer feedback): this means a
    // turn that did real work AND ended with a legitimate question is still
    // force-continued by the task-board. In production, the autoContinueHook
    // LLM slow path is expected to recognize the handoff — but because the
    // task-board check runs *before* Stop hooks, the LLM never gets a say
    // here. The class-level resolution is tracked in
    // `docs/plans/260420_yield_to_user_semantic_signal.md` (`YieldToUser`
    // first-class signal + unified continuation decision layer).
    //
    // Until that lands, this test LOCKS IN the conservative behavior so an
    // accidental broadening doesn't silently weaken completion verification.
    const future = Date.now() + 60_000;
    taskStoreTasks = [
      makeTurnCreatedTask({
        id: 't1',
        title: 'Phase 0',
        status: 'in_progress',
        createdAt: future,
        updatedAt: future + 500, // task updated during the turn
      }),
    ];

    mockRunAgentLoop.mockImplementation(async () => {
      runAgentLoopCallCount += 1;
      const text = 'Which environment would you like to deploy to?';
      seedAssistantQuestionEvent('test-turn-fox-3097', text);
      return {
        totalUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        turns: 1,
        messageHistory: [assistantMessageHistoryEntry(text)],
      };
    });

    const gen = rebelCoreQuery(
      {
        model: 'claude-sonnet-4-20250514',
        prompt: 'test prompt',
        systemPrompt: 'test system',
        hooks: { Stop: [NOOP_STOP_HOOK] },
      },
      { settings: makeSettings(), turnId: 'test-turn-fox-3097' },
    );

    await drainGenerator(gen);

    // Because tasks were actively worked on this turn, the yield helper
    // returns false and the task-board forces continuation. This preserves
    // the completion-verification safety net for real multi-step work.
    expect(runAgentLoopCallCount).toBe(4);

    agentTurnRegistry.cleanupTurn('test-turn-fox-3097');
  });
});

// =============================================================================
// Case 5 — transcript aggregation in conversationState remains append-based
// =============================================================================

describe('conversationState transcript aggregation — no silent dedupe regression', () => {
  it('[fix — case 5] four identical assistant events aggregate with \\n\\n separators', async () => {
    // This is a sanity test guaranteeing we did NOT introduce renderer-side
    // or state-level deduplication. If this test starts returning only the
    // first paragraph, the fix accidentally changed aggregation semantics.
    const { updateConversationWithEvent } = await import(
      '@shared/utils/conversationState'
    );
    type State = import('@shared/utils/conversationState').ConversationStateShape;
    let state: State = {
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      focusedTurnId: null,
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set<string>(),
    };

    const turnId = 'test-turn-case5';
    const text = 'Same paragraph.';
    for (let i = 0; i < 4; i++) {
      state = updateConversationWithEvent(state, turnId, {
        type: 'assistant',
        text,
        timestamp: Date.now() + i,
      } as AgentEvent);
    }

    const assistantMessage = state.messages.find((m) => m.role === 'assistant');
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage!.text).toBe([text, text, text, text].join('\n\n'));
  });
});
