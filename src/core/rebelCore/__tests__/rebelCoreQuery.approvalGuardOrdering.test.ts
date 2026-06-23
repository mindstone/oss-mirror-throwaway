/**
 * FOX-2771 Stage 2 — approval-execution guard vs task-board ordering
 * (GPT review F1/F2/F5).
 *
 * Integration-style tests at the `rebelCoreQuery` level with the REAL
 * `hookPipeline` (unlike rebelCoreQuery.taskBoardYield.test.ts, which mocks
 * it) and the REAL approval-execution guard + sessionApprovals storage.
 * `runAgentLoop` is mocked so each invocation is exactly one outer attempt,
 * and its received `config.messages` tell us WHICH continuation was injected.
 *
 * Pins:
 *  1. Pending task-board tasks + unconsumed execution expectation → the
 *     task-board layer SURRENDERS (via `params.hasPendingApprovalExecutions`)
 *     and the guard injects its approval-specific continuation — exactly once.
 *     Subsequent attempts fall back to the generic task-board continuation
 *     (no starvation).
 *  2. Pending user question → guard yields (stop allowed, single attempt) and
 *     the forced-continuation budget is NOT spent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { RebelCoreTask } from '../taskState';

// -----------------------------------------------------------------------------
// Shared state controlled by each test
// -----------------------------------------------------------------------------

let taskStoreTasks: RebelCoreTask[] = [];

// -----------------------------------------------------------------------------
// Module mocks (must come before imports). Mirror of
// rebelCoreQuery.taskBoardYield.test.ts EXCEPT `../hookPipeline` stays REAL so
// the actual Stop-hook chain (and thus the real guard) runs.
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
// Imports under test (after mocks)
// -----------------------------------------------------------------------------

import { rebelCoreQuery } from '../rebelCoreQuery';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import {
  storeSingleUseApproval,
  hasActionableExecutionExpectations,
  currentApprovalSequence,
  _testing_resetSingleUseApprovals,
} from '@main/services/safety/sessionApprovals';
import { createApprovalExecutionGuardHook } from '@main/services/safety/approvalExecutionGuardHook';
import type { RebelCoreHookMatcher } from '../types';

const SESSION = 'sess-approval-guard-ordering';
const TURN_ID = 'test-turn-fox-2771-guard';

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

/** Task created "this turn" — far-future stamps dodge turnStartTime jitter. */
function makeTurnCreatedTask(overrides: Partial<RebelCoreTask> = {}): RebelCoreTask {
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

function assistantMessageHistoryEntry(text: string): { role: 'assistant'; content: Array<{ type: 'text'; text: string }> } {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

async function drainGenerator(gen: AsyncGenerator<unknown, void, undefined>): Promise<void> {
  try {
    for await (const _msg of gen) {
      // drain
    }
  } catch {
    // swallow — mocks intentionally don't yield a full result
  }
}

/**
 * Extract the injected `[System: auto-continue]` continuation texts from the
 * configs runAgentLoop received (the first attempt's last message is the
 * original user prompt — not a continuation — so filter by the marker).
 */
function injectedContinuations(configs: unknown[]): string[] {
  const out: string[] = [];
  for (const config of configs) {
    const messages = (config as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
    const last = messages[messages.length - 1];
    if (
      last &&
      last.role === 'user' &&
      typeof last.content === 'string' &&
      last.content.includes('[System: auto-continue]')
    ) {
      out.push(last.content);
    }
  }
  return out;
}

describe('rebelCoreQuery — approval-execution guard ordering (FOX-2771 Stage 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _testing_resetSingleUseApprovals();
    taskStoreTasks = [];
  });

  it('model ignores the forced approval continuation + tasks pending → next stop pass SURFACES "Approved but not executed", then generic task-board resumes (confirm-round F1)', async () => {
    taskStoreTasks = [makeTurnCreatedTask({ id: 't1', title: 'Phase 0', status: 'in_progress' })];

    // Approval stored BEFORE the turn (legacy retry continuation shape).
    storeSingleUseApproval('tool', SESSION, 'mcp__gmail__send_email', { expectExecution: true });
    const approvalSeqAtTurnStart = currentApprovalSequence();

    const onApprovedNotExecuted = vi.fn();
    const guardHook = createApprovalExecutionGuardHook({
      sessionId: SESSION,
      approvalSeqAtTurnStart,
      onApprovedNotExecuted,
    });

    // Stand-in for autoContinueHook (registered AFTER the guard in
    // production): blocks every pass it is reached on. It lets the run
    // continue past the guard's surfacing pass so we can observe that the
    // generic task-board continuation RESUMES once the predicate goes false.
    const probeHook = async () => ({ decision: 'block' as const, reason: 'probe-continue' });

    const receivedConfigs: unknown[] = [];
    mockRunAgentLoop.mockImplementation(async (config: unknown) => {
      receivedConfigs.push(config);
      // Non-yield text and NO consumption: the model ignores every
      // continuation, including the guard's approval-specific one.
      const text = "Now I'll proceed to fetch the API docs.";
      return {
        totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        turns: 1,
        messageHistory: [assistantMessageHistoryEntry(text)],
      };
    });

    const gen = rebelCoreQuery(
      {
        model: 'claude-sonnet-4-20250514',
        prompt: 'test prompt',
        systemPrompt: 'test system',
        hooks: {
          Stop: [
            { hooks: [guardHook] } as unknown as RebelCoreHookMatcher,
            { hooks: [probeHook] } as unknown as RebelCoreHookMatcher,
          ],
        },
        hasPendingApprovalExecutions: () =>
          hasActionableExecutionExpectations(SESSION, approvalSeqAtTurnStart),
      },
      { settings: makeSettings(), turnId: TURN_ID },
    );

    await drainGenerator(gen);

    // Expected attempt sequence:
    //  attempt 0 end: predicate true (unconsumed, unsurfaced) → task-board
    //    yields → Stop chain → guard BLOCKS (forced) → attempt 1.
    //  attempt 1 end: predicate STILL true (unsurfaced — the confirm-round
    //    fix) → task-board yields AGAIN → Stop chain → guard SURFACES and
    //    allows → probe hook blocks → attempt 2.
    //  attempt 2 end: predicate false (surfaced) → task-board resumes its
    //    GENERIC injection → attempt 3 (last attempt, hooks skipped).
    expect(receivedConfigs.length).toBeGreaterThanOrEqual(3);

    const continuations = injectedContinuations(receivedConfigs);
    const approvalSpecific = continuations.filter((c) =>
      c.includes('mcp__gmail__send_email') && c.includes('NOT been executed'),
    );
    const genericTaskBoard = continuations.filter((c) =>
      c.includes('Tasks #t1') && c.includes('still incomplete'),
    );

    // Ordering pin: the FIRST injected continuation is the guard's
    // approval-specific message, NOT the generic task-board one (review F1).
    expect(continuations[0]).toContain('mcp__gmail__send_email');
    expect(continuations[0]).toContain('NOT been executed');
    // Exactly-one contract: the guard forces only once.
    expect(approvalSpecific).toHaveLength(1);

    // THE CONFIRM-ROUND PIN: the surfacing leg actually ran — the guard got a
    // post-forced Stop-hook pass instead of being preempted by the generic
    // task-board continuation.
    expect(onApprovedNotExecuted).toHaveBeenCalledTimes(1);
    const surfacedItems = onApprovedNotExecuted.mock.calls[0][0] as Array<{ identifier: string }>;
    expect(surfacedItems.map((i) => i.identifier)).toEqual(['mcp__gmail__send_email']);

    // No starvation: once surfaced, the predicate is false and the generic
    // task-board continuation resumes — strictly AFTER the surfacing pass.
    // The probe continuation is injected on the same stop pass that surfaced,
    // so generic-after-probe pins "generic resumed after surfacing", not
    // merely "after the forced block".
    expect(genericTaskBoard.length).toBeGreaterThanOrEqual(1);
    const probeIndex = continuations.findIndex((c) => c.includes('probe-continue'));
    expect(probeIndex).toBeGreaterThan(-1);
    expect(continuations.indexOf(genericTaskBoard[0])).toBeGreaterThan(probeIndex);
    expect(hasActionableExecutionExpectations(SESSION, approvalSeqAtTurnStart)).toBe(false);

    agentTurnRegistry.cleanupTurn(TURN_ID);
  });

  it('pending user question → stop allowed (single attempt) and forced-continuation budget unspent', async () => {
    taskStoreTasks = [makeTurnCreatedTask({ id: 't1', title: 'Phase 0', status: 'in_progress' })];

    storeSingleUseApproval('tool', SESSION, 'mcp__gmail__send_email', { expectExecution: true });
    const approvalSeqAtTurnStart = currentApprovalSequence();

    const guardHook = createApprovalExecutionGuardHook({
      sessionId: SESSION,
      approvalSeqAtTurnStart,
      isAwaitingUserInput: () => agentTurnRegistry.hasUserQuestionPending(TURN_ID),
      onApprovedNotExecuted: vi.fn(),
    });

    // Turn stops to wait for the user's answer (AskUserQuestion pending).
    agentTurnRegistry.markUserQuestionPending(TURN_ID);

    const receivedConfigs: unknown[] = [];
    mockRunAgentLoop.mockImplementation(async (config: unknown) => {
      receivedConfigs.push(config);
      const text = 'Proceeding with option A.';
      return {
        totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        turns: 1,
        messageHistory: [assistantMessageHistoryEntry(text)],
      };
    });

    const gen = rebelCoreQuery(
      {
        model: 'claude-sonnet-4-20250514',
        prompt: 'test prompt',
        systemPrompt: 'test system',
        hooks: { Stop: [{ hooks: [guardHook] } as unknown as RebelCoreHookMatcher] },
        hasPendingApprovalExecutions: () =>
          hasActionableExecutionExpectations(SESSION, approvalSeqAtTurnStart),
      },
      { settings: makeSettings(), turnId: TURN_ID },
    );

    await drainGenerator(gen);

    // Single attempt: task-board skips (user question pending), the REAL Stop
    // chain runs, and the guard yields without forcing (review F2).
    expect(receivedConfigs).toHaveLength(1);

    // Budget unspent: the expectation is still actionable for the post-answer
    // continuation turn.
    expect(hasActionableExecutionExpectations(SESSION, approvalSeqAtTurnStart)).toBe(true);

    agentTurnRegistry.clearUserQuestionPending(TURN_ID);
    agentTurnRegistry.cleanupTurn(TURN_ID);
  });
});
