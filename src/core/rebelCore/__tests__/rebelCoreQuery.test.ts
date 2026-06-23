import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import type { EventHandler, ExecuteToolFn, RebelCoreConfig, RebelCoreEvent, TokenUsage } from '../types';
import type { ModelClient } from '../modelClient';

const START_MODEL = 'deepseek-v4-flash';
const SWITCH_MODEL = 'gpt-4o-mini';
const PLANNING_MODEL = 'claude-opus-4-7';

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

const mockRunAgentLoop = vi.fn();
const mockRunPlanningPhase = vi.fn();
const mockCreateClientForModel = vi.fn();
const mockResolveModelLimits = vi.fn();
const mockResolveThinkingConfig = vi.fn();
const mockResolveEffortForApi = vi.fn();

let emittedEvents: RebelCoreEvent[] = [];

vi.mock('../agentLoop', async () => {
  const actual = await vi.importActual<typeof import('../agentLoop')>('../agentLoop');
  return {
    ...actual,
    runAgentLoop: (...args: unknown[]) => mockRunAgentLoop(...args),
  };
});

vi.mock('../planningMode', async () => {
  const actual = await vi.importActual<typeof import('../planningMode')>('../planningMode');
  return {
    ...actual,
    runPlanningPhase: (...args: unknown[]) => mockRunPlanningPhase(...args),
  };
});

vi.mock('../clientFactory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clientFactory')>();
  return {
    ...actual,
    createClientForModel: (...args: unknown[]) => mockCreateClientForModel(...args),
  };
});

vi.mock('../modelLimits', () => ({
  shouldSuppressProfileReasoning: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => profile?.thinkingCompatibility === 'incompatible',
  resolveProfileReasoningEffort: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => (profile?.thinkingCompatibility === 'incompatible' ? undefined : profile?.reasoningEffort),
  resolveModelLimits: (...args: unknown[]) => mockResolveModelLimits(...args),
  resolveThinkingConfig: (...args: unknown[]) => mockResolveThinkingConfig(...args),
  resolveEffortForApi: (...args: unknown[]) => mockResolveEffortForApi(...args),
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
  createHookAwareToolExecutor: (exec: ExecuteToolFn) => exec,
  runStopHooks: vi.fn(),
}));

vi.mock('../agentTool', () => ({
  buildAgentToolDefinition: () => ({
    name: 'Agent',
    description: '',
    input_schema: { type: 'object', properties: {} },
  }),
  executeAgentTool: vi.fn(),
}));

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

vi.mock('../taskStatePersistence', () => ({
  loadTaskBoard: vi.fn().mockResolvedValue({ loaded: false, recoveredCount: 0 }),
  saveTaskBoard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../agentMessageAdapter', () => ({
  createAgentMessageAdapter: () => ({
    createInitMessage: () => ({ type: 'system', subtype: 'init' }),
    handleEvent: (event: RebelCoreEvent) => {
      emittedEvents.push(event);
      return [];
    },
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

vi.mock('../settingsAccessors', () => ({
  getModelEfforts: () => ({}),
  getGlobalThinkingEffort: () => 'low',
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

vi.mock('@core/utils/authEnvUtils', () => ({
  getApiKeyForDirectUse: () => 'fake-test',
  getAuthForDirectUse: () => ({ apiKey: 'fake-test' }),
  hasDirectAuth: () => true,
}));

import { rebelCoreQuery } from '../rebelCoreQuery';

const executionClient = { capabilities: {}, stream: vi.fn(), create: vi.fn() } as unknown as ModelClient;
const planningClient = { capabilities: {}, stream: vi.fn(), create: vi.fn() } as unknown as ModelClient;
const switchedClient = { capabilities: {}, stream: vi.fn(), create: vi.fn() } as unknown as ModelClient;

const TEST_TOOL_SIGNAL = new AbortController().signal;

const ds4Profile = (): ModelProfile => ({
  id: 'ds4-profile',
  name: 'DS4',
  model: START_MODEL,
  providerType: 'other',
  presetKey: 'local:ds4',
  routeSurface: 'local',
  serverUrl: 'http://127.0.0.1:8000/v1',
  enabled: true,
  routingEligible: true,
  createdAt: Date.now(),
});

const switchProfile = (): ModelProfile => ({
  id: 'switch-profile',
  name: 'OpenAI',
  model: SWITCH_MODEL,
  providerType: 'openai',
  routeSurface: 'api-key',
  serverUrl: 'https://api.openai.com/v1',
  enabled: true,
  routingEligible: true,
  createdAt: Date.now(),
});

function makeSettings(adaptiveRoutingEnabled: boolean): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    activeProvider: 'anthropic',
    models: {
      apiKey: 'fake-ant-test-key',
      oauthToken: null,
      authMethod: 'api-key',
      model: START_MODEL,
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
    },
    experimental: { adaptiveRoutingEnabled },
    localModel: {
      workingProfileId: 'ds4-profile',
      activeProfileId: 'ds4-profile',
      profiles: [ds4Profile(), switchProfile()],
    },
  } as unknown as AppSettings;
}

function makeParams() {
  return {
    prompt: 'Do the work',
    model: 'planner',
    cwd: '/tmp',
    systemPrompt: 'System prompt',
    permissionMode: 'default',
    env: {
      PLANNING_MODEL,
      EXECUTION_MODEL: START_MODEL,
    },
  };
}

function makeContext(settings: AppSettings) {
  return {
    settings,
    cwd: '/tmp',
    executionClient,
    planningClient,
  };
}

async function advanceToSecondTask(toolExecutor: ExecuteToolFn): Promise<void> {
  const first = await toolExecutor('TaskUpdate', { id: '1', status: 'completed' }, 'tool-1', TEST_TOOL_SIGNAL);
  expect(first.isError).toBe(false);

  const second = await toolExecutor('TaskUpdate', { id: '2', status: 'in_progress', blockers: [] }, 'tool-2', TEST_TOOL_SIGNAL);
  expect(second.isError).toBe(false);
}

async function drainTurn(settings: AppSettings): Promise<void> {
  for await (const _message of rebelCoreQuery(makeParams(), makeContext(settings))) {
    // Drain generator.
  }
}

describe('rebelCoreQuery supportsReasoningReplay wiring', () => {
  beforeEach(() => {
    emittedEvents = [];
    vi.clearAllMocks();
    mockCreateClientForModel.mockReturnValue(switchedClient);
    mockResolveModelLimits.mockImplementation((input: { model: string }) => (
      input.model === SWITCH_MODEL
        ? { contextWindow: 128_000, maxOutputTokens: 8_000 }
        : { contextWindow: 131_072, maxOutputTokens: 12_000 }
    ));
    mockResolveThinkingConfig.mockReturnValue({ type: 'disabled' });
    mockResolveEffortForApi.mockReturnValue('low');
  });

  it('threads supportsReasoningReplay from activeProfile into runAgentLoop opts', async () => {
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify({
        goal: 'Plan',
        steps: [{ id: 's1', description: 'Do', parallel_group: null }],
        done_criteria: ['Done'],
      }),
      document: {
        goal: 'Plan',
        steps: [{ id: 's1', description: 'Do', parallel_group: null }],
        done_criteria: ['Done'],
      },
      routing: undefined,
      usage: ZERO_USAGE,
      stopReason: 'end_turn',
      model: PLANNING_MODEL,
    });

    let capturedOpts: { supportsReasoningReplay?: boolean } | undefined;
    mockRunAgentLoop.mockImplementation(async (
      _config: RebelCoreConfig,
      _toolExecutor: ExecuteToolFn,
      _emitEvent: EventHandler,
      opts?: { supportsReasoningReplay?: boolean },
    ) => {
      capturedOpts = opts;
      return {
        totalUsage: ZERO_USAGE,
        turns: 1,
        messageHistory: [{ role: 'user' as const, content: 'Do the work' }],
      };
    });

    await drainTurn(makeSettings(false));

    expect(capturedOpts).toEqual({ supportsReasoningReplay: true });
  });

  it('emits actionable Settings Advanced copy when MCP tools are unavailable', async () => {
    const settings = makeSettings(false);
    settings.models.planMode = false;

    mockRunAgentLoop.mockResolvedValue({
      totalUsage: ZERO_USAGE,
      turns: 1,
      messageHistory: [{ role: 'user' as const, content: 'Do the work' }],
    });

    for await (const _message of rebelCoreQuery(
      makeParams(),
      { ...makeContext(settings), superMcpUrl: 'http://127.0.0.1:3131/mcp' },
    )) {
      // Drain generator.
    }

    expect(emittedEvents).toContainEqual({
      type: 'warning',
      category: 'mcp',
      message: "I couldn't connect to your apps and tools for this turn. Try Settings → Advanced.",
    });
  });

  it('recomputes supportsReasoningReplay when adaptive modelSwitch changes destination profile', async () => {
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify({
        goal: 'Plan',
        steps: [
          { id: 's1', description: 'Gather context', parallel_group: null, model: START_MODEL, effort: 'low' },
          { id: 's2', description: 'Escalate synthesis', parallel_group: null, depends_on: ['s1'], model: SWITCH_MODEL, effort: 'low' },
        ],
        done_criteria: ['Done'],
        routing: { default_model: START_MODEL, default_effort: 'low' },
      }),
      document: {
        goal: 'Plan',
        steps: [
          { id: 's1', description: 'Gather context', parallel_group: null, model: START_MODEL, effort: 'low' },
          { id: 's2', description: 'Escalate synthesis', parallel_group: null, depends_on: ['s1'], model: SWITCH_MODEL, effort: 'low' },
        ],
        done_criteria: ['Done'],
        routing: { default_model: START_MODEL, default_effort: 'low' },
      },
      routing: { default_model: START_MODEL, default_effort: 'low' },
      usage: ZERO_USAGE,
      stopReason: 'end_turn',
      model: PLANNING_MODEL,
    });

    let optsBeforeSwitch: boolean | undefined;
    let optsAfterSwitch: boolean | undefined;
    mockRunAgentLoop.mockImplementation(async (
      config: RebelCoreConfig,
      toolExecutor: ExecuteToolFn,
      _emitEvent: EventHandler,
      opts?: { supportsReasoningReplay?: boolean },
    ) => {
      optsBeforeSwitch = opts?.supportsReasoningReplay;
      await advanceToSecondTask(toolExecutor);
      await config.betweenTurns?.([], ZERO_USAGE);
      optsAfterSwitch = opts?.supportsReasoningReplay;
      return {
        totalUsage: ZERO_USAGE,
        turns: 1,
        messageHistory: [{ role: 'user' as const, content: 'Do the work' }],
      };
    });

    await drainTurn(makeSettings(true));

    expect(optsBeforeSwitch).toBe(true);
    expect(optsAfterSwitch).toBe(false);
  });
});
