 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { ChatMessage, TokenUsage } from '../modelTypes';
import type { RebelCoreConfig } from '../types';

const {
  mockAppendCostEntry,
  mockCalculateCostOrWarn,
  mockClient,
  mockRunAgentLoop,
  mockTaskStore,
  mockUpdateContextStateViaLLM,
  oldToolPair,
} = vi.hoisted(() => ({
  mockAppendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id-compaction' })),
  mockCalculateCostOrWarn: vi.fn(() => 0.0123),
  mockClient: {
    capabilities: {
      hasNativeContextEditing: false,
      hasNativeCompaction: false,
      cacheStrategy: 'none',
      cacheHeuristicTtlMs: 0,
      supportsImageContent: () => false,
    },
  },
  mockRunAgentLoop: vi.fn(),
  mockTaskStore: {
    listTasks: vi.fn(() => []),
    archiveTurn: vi.fn(),
    getContextState: vi.fn(() => ({
      taskContext: { goals: '', constraints: '', requirements: '' },
      keyDecisions: [],
      artifacts: [],
      constraints: [],
      progressState: { accomplished: [], remaining: [], blockers: [], failedApproaches: [] },
      recentContextSummary: '',
    })),
    updateContextState: vi.fn(),
    getCompactionDeferred: vi.fn(() => false),
    setCompactionDeferred: vi.fn(),
  },
  mockUpdateContextStateViaLLM: vi.fn(),
  oldToolPair: [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/file.txt' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }],
    },
  ],
}));

vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: mockAppendCostEntry,
}));

vi.mock('@shared/utils/pricingCalculator', () => ({
  calculateCostOrWarn: mockCalculateCostOrWarn,
}));

vi.mock('../agentLoop', async () => {
  const actual = await vi.importActual<typeof import('../agentLoop')>('../agentLoop');
  return {
    ...actual,
    runAgentLoop: (...args: unknown[]) => mockRunAgentLoop(...args),
  };
});

vi.mock('../clientFactory', () => ({
  createClientForModel: () => mockClient,
}));

vi.mock('../planningMode', () => ({
  resolveRuntimeModels: ({ model }: { model: string }) => ({
    executionModel: model,
    planningModel: null,
    displayModel: model,
    isPlanMode: false,
  }),
  buildExecutionSystemPrompt: vi.fn(),
  derivePlanParallelGroups: vi.fn(() => new Map()),
  runPlanningPhase: vi.fn(),
  sanitizePlanTextForExecution: (planText: string) => planText,
  seedTaskStoreFromPlan: vi.fn(),
  hasMissionGoalTask: () => true,
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
  runStopHooksWithReason: vi.fn(async () => ({ shouldContinue: false })),
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

vi.mock('../taskState', () => ({
  createTaskStore: () => mockTaskStore,
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

vi.mock('../modelLimits', () => ({
  shouldSuppressProfileReasoning: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => profile?.thinkingCompatibility === 'incompatible',
  resolveProfileReasoningEffort: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => (profile?.thinkingCompatibility === 'incompatible' ? undefined : profile?.reasoningEffort),
  resolveModelLimits: () => ({ contextWindow: 100_000, maxOutputTokens: 8_192 }),
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
  decideCompaction: () => ({ action: 'bts_immediate', reason: 'test compaction' }),
  DEFAULT_COMPACTION_CONFIG: {},
}));

vi.mock('../contextPruning', () => ({
  pruneOldToolPairs: vi.fn(() => 1),
}));

vi.mock('../contextStateUpdate', async () => {
  const actual = await vi.importActual<typeof import('../contextStateUpdate')>('../contextStateUpdate');
  return {
    extractOldToolPairs: () => oldToolPair,
    updateContextStateViaLLM: (...args: unknown[]) => mockUpdateContextStateViaLLM(...args),
    // Use the real (pure) mapper so the test exercises actual reason attribution.
    contextStateFailureToLedgerReason: actual.contextStateFailureToLedgerReason,
  };
});

vi.mock('../contextPreservation', () => ({
  formatContextStateSummary: () => 'Compacted context summary',
}));

import { rebelCoreQuery } from '../rebelCoreQuery';

const zeroUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

function makeSettings(): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    models: {
      apiKey: 'fake-test-key',
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
    },
  } as unknown as AppSettings;
}

async function drainTurn(): Promise<void> {
  for await (const _message of rebelCoreQuery(
    {
      model: 'claude-sonnet-4-20250514',
      prompt: 'test prompt',
      systemPrompt: 'test system',
      permissionMode: 'default',
    },
    { settings: makeSettings(), turnId: 'test-turn-compaction-cost' },
  )) {
    // Drain the async generator.
  }
}

function mockCompactionLoop(): void {
  mockRunAgentLoop.mockImplementation(async (config: RebelCoreConfig) => {
    await config.betweenTurns?.(
      [...(oldToolPair as ChatMessage[])],
      {
        inputTokens: 95_000,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    );

    return {
      totalUsage: zeroUsage,
      turns: 1,
      messageHistory: [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Done' }] }],
    };
  });
}

describe('rebelCoreQuery compaction cost outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompactionLoop();
    mockUpdateContextStateViaLLM.mockResolvedValue({
      ok: true,
      state: mockTaskStore.getContextState(),
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheCreationTokens: 30,
        cacheReadTokens: 40,
      },
    });
  });

  it('writes auxiliary_success outcome when BTS compaction succeeds', async () => {
    await drainTurn();

    expect(mockAppendCostEntry).toHaveBeenCalledWith(expect.objectContaining({
      cat: 'compaction-bts',
      cost: 0.0123,
      est: true,
      outcome: { kind: 'auxiliary_success' },
    }));
  });

  it('writes auxiliary_failed outcome when BTS compaction returns an unusable update', async () => {
    mockUpdateContextStateViaLLM.mockResolvedValueOnce({
      ok: false,
      state: mockTaskStore.getContextState(),
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheCreationTokens: 30,
        cacheReadTokens: 40,
      },
    });

    await drainTurn();

    expect(mockAppendCostEntry).toHaveBeenCalledWith(expect.objectContaining({
      cat: 'compaction-bts',
      cost: 0.0123,
      est: true,
      outcome: { kind: 'auxiliary_failed', reason: 'other' },
    }));
  });

  it('attributes a truncation failure as reason:truncated (not the catch-all other)', async () => {
    mockUpdateContextStateViaLLM.mockResolvedValueOnce({
      ok: false,
      failureReason: 'truncated',
      state: mockTaskStore.getContextState(),
      usage: {
        inputTokens: 1_000,
        outputTokens: 8_192,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    });

    await drainTurn();

    expect(mockAppendCostEntry).toHaveBeenCalledWith(expect.objectContaining({
      cat: 'compaction-bts',
      outcome: { kind: 'auxiliary_failed', reason: 'truncated' },
    }));
  });
});
