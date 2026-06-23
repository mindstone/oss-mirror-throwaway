 
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { EventHandler, ExecuteToolFn, RebelCoreConfig, RebelCoreEvent, TokenUsage } from '../types';
import type { ModelClient } from '../modelClient';
import type { RoutingDecision } from '../planningMode';

const WORKING_MODEL = 'claude-sonnet-4-20250514';
const PLANNING_MODEL = 'claude-opus-4-7';
const ESCALATED_MODEL = 'claude-opus-4-20250514';

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
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { seedTaskStoreFromPlan } from '../planningMode';
import { createTaskStore } from '../taskState';

const executionClient = { capabilities: {}, stream: vi.fn(), create: vi.fn() } as unknown as ModelClient;
const planningClient = { capabilities: {}, stream: vi.fn(), create: vi.fn() } as unknown as ModelClient;
const escalatedClient = { capabilities: {}, stream: vi.fn(), create: vi.fn() } as unknown as ModelClient;

function makePlan(routing: RoutingDecision): { planText: string; document: Record<string, unknown>; routing: RoutingDecision } {
  const document = {
    goal: 'Complete the routed work',
    steps: [
      { id: 's1', description: 'Gather inputs', parallel_group: null },
      { id: 's2', description: 'Perform deep synthesis', depends_on: ['s1'], parallel_group: null },
      { id: 's3', description: 'Write final answer', depends_on: ['s2'], parallel_group: null },
    ],
    done_criteria: ['Answer delivered'],
    routing,
  };

  return {
    planText: JSON.stringify(document),
    document,
    routing,
  };
}

function makeRouting(overrides: Partial<NonNullable<RoutingDecision['escalation']>> = {}): RoutingDecision {
  return {
    default_model: WORKING_MODEL,
    default_effort: 'low',
    escalation: {
      at_step: 's2',
      to_model: ESCALATED_MODEL,
      to_effort: 'high',
      reason: 'Needs deeper synthesis',
      ...overrides,
    },
  };
}

function makeSettings(adaptiveRoutingEnabled = true): AppSettings {
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
      model: WORKING_MODEL,
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
    },
    experimental: {
      adaptiveRoutingEnabled,
    },
    localModel: {
      workingProfileId: null,
      activeProfileId: null,
      profiles: [
        {
          id: 'escalated',
          name: 'Escalated Opus',
          model: ESCALATED_MODEL,
          providerType: 'anthropic',
          routingEligible: true,
          enabled: true,
          maxOutputTokens: 12_000,
          contextWindow: 200_000,
          createdAt: Date.now(),
        },
      ],
    },
  } as unknown as AppSettings;
}

function makeContext(settings = makeSettings()) {
  return {
    settings,
    cwd: '/tmp',
    executionClient,
    planningClient,
  };
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
      EXECUTION_MODEL: WORKING_MODEL,
    },
  };
}

async function drainTurn(settings = makeSettings()): Promise<void> {
  for await (const _message of rebelCoreQuery(makeParams(), makeContext(settings))) {
    // Drain the async generator.
  }
}

// FOX-3436 Stage 2: drive a turn with a real turnId in context so the adaptive-routing /
// mid-turn model-switch sites sync agentTurnRegistry.setTurnModel(context.turnId, ...).
async function drainTurnWithTurnId(turnId: string, settings = makeSettings()): Promise<void> {
  const context = { ...makeContext(settings), turnId };
  for await (const _message of rebelCoreQuery(makeParams(), context)) {
    // Drain the async generator.
  }
}

function mockPlan(routing: RoutingDecision): void {
  const plan = makePlan(routing);
  mockRunPlanningPhase.mockResolvedValue({
    planText: plan.planText,
    document: plan.document,
    routing: plan.routing,
    usage: ZERO_USAGE,
    stopReason: 'end_turn',
    model: PLANNING_MODEL,
  });
}

function mockSingleLoop(
  runBetweenTurns: (config: RebelCoreConfig, toolExecutor: ExecuteToolFn, emitEvent: EventHandler) => Promise<void>,
): void {
  mockRunAgentLoop.mockImplementation(async (
    config: RebelCoreConfig,
    toolExecutor: ExecuteToolFn,
    emitEvent: EventHandler,
  ) => {
    await runBetweenTurns(config, toolExecutor, emitEvent);
    return {
      totalUsage: ZERO_USAGE,
      turns: 1,
      messageHistory: [{ role: 'user' as const, content: 'Do the work' }],
    };
  });
}

const TEST_TOOL_SIGNAL = new AbortController().signal;

async function advanceToSecondTask(toolExecutor: ExecuteToolFn): Promise<void> {
  const first = await toolExecutor('TaskUpdate', { id: '1', status: 'completed' }, 'tool-1', TEST_TOOL_SIGNAL);
  expect(first.isError).toBe(false);

  const second = await toolExecutor('TaskUpdate', { id: '2', status: 'in_progress', blockers: [] }, 'tool-2', TEST_TOOL_SIGNAL);
  expect(second.isError).toBe(false);
}

describe('rebelCoreQuery escalation ratchet', () => {
  beforeEach(() => {
    emittedEvents = [];
    vi.clearAllMocks();
    mockCreateClientForModel.mockReturnValue(escalatedClient);
    mockResolveModelLimits.mockImplementation((input: { model: string }) => (
      input.model === ESCALATED_MODEL
        ? { contextWindow: 200_000, maxOutputTokens: 12_000 }
        : { contextWindow: 100_000, maxOutputTokens: 8_000 }
    ));
    mockResolveThinkingConfig.mockImplementation((effort: string | undefined) => (
      effort === 'high'
        ? { type: 'enabled', budget_tokens: 2048 }
        : { type: 'disabled' }
    ));
    mockResolveEffortForApi.mockImplementation((effort: string | undefined) => (
      effort === 'xhigh' ? 'max' : effort
    ));
  });

  it('triggers escalation when the target step task becomes in_progress', async () => {
    mockPlan(makeRouting());
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor);
      await config.betweenTurns?.([], ZERO_USAGE);
    });

    await drainTurn();

    expect(mockCreateClientForModel).toHaveBeenCalledWith(expect.objectContaining({
      model: ESCALATED_MODEL,
      context: 'escalated-execution',
    }));
    expect(observedConfigRef.current?.model).toBe(ESCALATED_MODEL);
    expect(observedConfigRef.current?.client).toBe(escalatedClient);
    expect(observedConfigRef.current?.maxTokens).toBe(12_000);
    expect(emittedEvents).toContainEqual({ type: 'status', message: `Escalating to ${ESCALATED_MODEL}` });
  });

  it('triggers escalation to a model with NO matching routing profile (profile is optional metadata)', async () => {
    // Behaviour-preservation guard for the Stage 1 chokepoint-A migration: an
    // escalation must still fire when the planner-emitted to_model does NOT
    // resolve to a known routing profile (and isn't the working model). The
    // initial chokepoint-A implementation regressed this — it resolved the
    // planner name against the routing pool and silently DROPPED the escalation
    // when no profile matched. The to_model is decoded into a RoutingModelId; the
    // profile is optional. (See adversarial review 260531_010000 finding #1.)
    const NO_PROFILE_MODEL = 'claude-haiku-4-5'; // valid id, NOT in settings.localModel.profiles
    mockPlan(makeRouting({ to_model: NO_PROFILE_MODEL }));
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor);
      await config.betweenTurns?.([], ZERO_USAGE);
    });

    await drainTurn();

    expect(mockCreateClientForModel).toHaveBeenCalledWith(expect.objectContaining({
      model: NO_PROFILE_MODEL,
      context: 'escalated-execution',
    }));
    expect(observedConfigRef.current?.model).toBe(NO_PROFILE_MODEL);
  });

  it('does not trigger escalation before the target step is reached', async () => {
    mockPlan(makeRouting());
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config) => {
      observedConfigRef.current = config;
      await config.betweenTurns?.([], ZERO_USAGE);
    });

    await drainTurn();

    expect(mockCreateClientForModel).not.toHaveBeenCalled();
    expect(observedConfigRef.current?.model).toBe(WORKING_MODEL);
    expect(emittedEvents).not.toContainEqual({ type: 'status', message: `Escalating to ${ESCALATED_MODEL}` });
  });

  it('keeps escalation one-way after it has triggered', async () => {
    mockPlan(makeRouting());
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor);
      await config.betweenTurns?.([], ZERO_USAGE);
      await toolExecutor('TaskUpdate', { id: '2', status: 'pending' }, 'tool-3', TEST_TOOL_SIGNAL);
      await config.betweenTurns?.([], ZERO_USAGE);
    });

    await drainTurn();

    expect(mockCreateClientForModel).toHaveBeenCalledTimes(1);
    expect(observedConfigRef.current?.model).toBe(ESCALATED_MODEL);
  });

  it('triggers multiple per-step model switches as target tasks are reached', async () => {
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      default_effort: 'low',
    };
    const document = {
      goal: 'Complete the routed work',
      steps: [
        { id: 's1', description: 'Gather inputs', parallel_group: null, model: WORKING_MODEL, effort: 'low' },
        {
          id: 's2',
          description: 'Perform deep synthesis',
          depends_on: ['s1'],
          parallel_group: null,
          model: ESCALATED_MODEL,
          effort: 'high',
        },
        {
          id: 's3',
          description: 'Write final answer',
          depends_on: ['s2'],
          parallel_group: null,
          model: WORKING_MODEL,
          effort: 'low',
        },
      ],
      done_criteria: ['Answer delivered'],
      routing,
    };
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify(document),
      document,
      routing,
      usage: ZERO_USAGE,
      stopReason: 'end_turn',
      model: PLANNING_MODEL,
    });
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor);
      await config.betweenTurns?.([], ZERO_USAGE);
      expect(config.model).toBe(ESCALATED_MODEL);

      const third = await toolExecutor('TaskUpdate', { id: '3', status: 'in_progress', blockers: [] }, 'tool-3', TEST_TOOL_SIGNAL);
      expect(third.isError).toBe(false);
      await config.betweenTurns?.([], ZERO_USAGE);
    });

    await drainTurn();

    expect(mockCreateClientForModel).toHaveBeenCalledTimes(2);
    expect(mockCreateClientForModel).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: ESCALATED_MODEL,
      context: 'escalated-execution',
    }));
    expect(mockCreateClientForModel).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: WORKING_MODEL,
      context: 'escalated-execution',
    }));
    expect(observedConfigRef.current?.model).toBe(WORKING_MODEL);
    expect(emittedEvents).toContainEqual({ type: 'status', message: `routing:model:${ESCALATED_MODEL}` });
    expect(emittedEvents).toContainEqual({ type: 'status', message: `routing:model:${WORKING_MODEL}` });
  });

  it('supports effort-only escalation without creating a new client', async () => {
    mockPlan(makeRouting({ to_model: WORKING_MODEL, to_effort: 'high' }));
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor);
      await config.betweenTurns?.([], ZERO_USAGE);
    });

    await drainTurn();

    expect(mockCreateClientForModel).not.toHaveBeenCalled();
    expect(observedConfigRef.current?.model).toBe(WORKING_MODEL);
    expect(observedConfigRef.current?.client).toBe(executionClient);
    expect(observedConfigRef.current?.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(observedConfigRef.current?.effort).toBe('high');
  });

  it('does not initialize escalation when the feature flag is off', async () => {
    mockPlan(makeRouting());
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor);
      await config.betweenTurns?.([], ZERO_USAGE);
    });

    await drainTurn(makeSettings(false));

    expect(mockCreateClientForModel).not.toHaveBeenCalled();
    expect(observedConfigRef.current?.model).toBe(WORKING_MODEL);
  });

  it('continues the turn when escalated client creation fails', async () => {
    mockPlan(makeRouting());
    mockCreateClientForModel.mockImplementation(() => {
      throw new Error('client boom');
    });
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor);
      await expect(config.betweenTurns?.([], ZERO_USAGE)).resolves.toBeUndefined();
    });

    await drainTurn();

    expect(mockCreateClientForModel).toHaveBeenCalledTimes(1);
    expect(observedConfigRef.current?.model).toBe(WORKING_MODEL);
    expect(observedConfigRef.current?.client).toBe(executionClient);
  });

  it('falls back to the plan ordinal of the escalation step when task tracking does not trigger', async () => {
    // Stage 2 (DA-F7): the iteration-count backstop is now sourced from the
    // escalation step's 1-based plan ordinal (compileStepRoutes → route.ordinal),
    // NOT scraped from the trailing digits of the step id. s2 is the 2nd seeded
    // step → threshold 2, so the switch fires on the 2nd betweenTurns iteration
    // even though no task was ever marked in_progress.
    mockPlan(makeRouting({ at_step: 's2' }));
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config) => {
      observedConfigRef.current = config;
      await config.betweenTurns?.([], ZERO_USAGE);
      expect(config.model).toBe(WORKING_MODEL);
      await config.betweenTurns?.([], ZERO_USAGE);
    });

    await drainTurn();

    expect(mockCreateClientForModel).toHaveBeenCalledTimes(1);
    expect(observedConfigRef.current?.model).toBe(ESCALATED_MODEL);
  });

  it('sources the iteration fallback from plan ordinal even when the step id has NO trailing digits', async () => {
    // The OLD digit-scraper returned null for a digit-less step id, disabling the
    // fallback entirely. With ordinal-sourcing the fallback still fires. Here the
    // escalation step id has no digits but is the 2nd seeded step → threshold 2.
    const document = {
      goal: 'Complete the routed work',
      steps: [
        { id: 'phase-alpha', description: 'Gather inputs', parallel_group: null },
        { id: 'phase-beta', description: 'Synthesis', depends_on: ['phase-alpha'], parallel_group: null },
        { id: 'phase-gamma', description: 'Write', depends_on: ['phase-beta'], parallel_group: null },
      ],
      done_criteria: ['Answer delivered'],
      routing: {
        default_model: WORKING_MODEL,
        default_effort: 'low',
        escalation: { at_step: 'phase-beta', to_model: ESCALATED_MODEL, to_effort: 'high' },
      },
    };
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify(document),
      document,
      routing: document.routing,
      usage: ZERO_USAGE,
      stopReason: 'end_turn',
      model: PLANNING_MODEL,
    });
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config) => {
      observedConfigRef.current = config;
      await config.betweenTurns?.([], ZERO_USAGE); // iteration 1 — not yet due
      expect(config.model).toBe(WORKING_MODEL);
      await config.betweenTurns?.([], ZERO_USAGE); // iteration 2 — ordinal threshold met
    });

    await drainTurn();

    expect(mockCreateClientForModel).toHaveBeenCalledTimes(1);
    expect(observedConfigRef.current?.model).toBe(ESCALATED_MODEL);
  });

  // GPT-F3 (highest-ROI parity test): drive a sparse-override + escalation plan
  // through compile → schedule → metadata → simulated switch application INCLUDING
  // a createClientForModel failure, and assert the emitted routing:tasks: snapshot
  // and the actual active execution model cannot disagree silently. The failed
  // switch must NOT leave a task badge claiming the unapplied target model.
  it('does not let a failed switch leave a task badge claiming the unapplied model (parity)', async () => {
    mockPlan(makeRouting()); // escalation s2 → ESCALATED_MODEL
    mockCreateClientForModel.mockImplementation(() => {
      throw new Error('client boom');
    });
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      // Advance so the s2 escalation switch is task-store-due, then run the
      // switch application (which fails to construct the escalated client).
      await advanceToSecondTask(toolExecutor);
      await expect(config.betweenTurns?.([], ZERO_USAGE)).resolves.toBeUndefined();
    });

    await drainTurn();

    // Execution stayed on the working model (switch failed).
    expect(mockCreateClientForModel).toHaveBeenCalledTimes(1);
    expect(observedConfigRef.current?.model).toBe(WORKING_MODEL);
    expect(observedConfigRef.current?.client).toBe(executionClient);

    // PARITY: parse the LAST routing:tasks: snapshot and assert NO task badge
    // advertises the unapplied target (ESCALATED_MODEL) — the snapshot must agree
    // with the model execution actually ran on (WORKING_MODEL).
    const taskRoutingEvents = emittedEvents
      .filter((e): e is { type: 'status'; message: string } =>
        e.type === 'status' && typeof (e as { message?: unknown }).message === 'string'
        && (e as { message: string }).message.startsWith('routing:tasks:'))
      .map((e) => JSON.parse(e.message.slice('routing:tasks:'.length)) as Record<string, { model: string }>);
    expect(taskRoutingEvents.length).toBeGreaterThan(0);
    const lastSnapshot = taskRoutingEvents[taskRoutingEvents.length - 1]!;
    const advertisedModels = Object.values(lastSnapshot).map((entry) => entry.model);
    expect(advertisedModels).not.toContain(ESCALATED_MODEL);
    expect(advertisedModels.every((m) => m === WORKING_MODEL)).toBe(true);
  });

  // Phase-6 refinement (Stage 2 review must-address): fail-then-succeed RETRY.
  // A failed switch transiently rewrites badges to the still-running model and
  // leaves the switch retry-eligible. When a later iteration RETRIES and
  // SUCCEEDS, the badge must follow execution back to the target — otherwise the
  // renderer (last-routing:tasks:-snapshot-wins) keeps showing the stale OLD
  // model while execution runs the target, reintroducing the UI/exec divergence
  // this refactor exists to kill.
  it('restores the task badge to the switched model when a failed switch later succeeds on retry', async () => {
    mockPlan(makeRouting()); // escalation s2 → ESCALATED_MODEL
    // Fail the FIRST createClientForModel, succeed on the SECOND (retry).
    mockCreateClientForModel
      .mockImplementationOnce(() => {
        throw new Error('client boom (transient)');
      })
      .mockImplementation(() => escalatedClient);
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor);
      // Iteration 1: switch is due, client construction FAILS → badge corrected
      // to the still-running WORKING_MODEL, switch stays untriggered.
      await expect(config.betweenTurns?.([], ZERO_USAGE)).resolves.toBeUndefined();
      expect(config.model).toBe(WORKING_MODEL);
      // Iteration 2: same task still in_progress → switch RETRIES and SUCCEEDS.
      await expect(config.betweenTurns?.([], ZERO_USAGE)).resolves.toBeUndefined();
    });

    await drainTurn();

    // Two construction attempts (fail then succeed); execution now on the target.
    expect(mockCreateClientForModel).toHaveBeenCalledTimes(2);
    expect(observedConfigRef.current?.model).toBe(ESCALATED_MODEL);
    expect(observedConfigRef.current?.client).toBe(escalatedClient);

    // PARITY after retry: the LAST routing:tasks: snapshot must show the
    // SWITCHED-TO model for the escalated tasks — NOT the stale WORKING_MODEL the
    // failure correction left behind.
    const snapshots = emittedEvents
      .filter((e): e is { type: 'status'; message: string } =>
        e.type === 'status' && typeof (e as { message?: unknown }).message === 'string'
        && (e as { message: string }).message.startsWith('routing:tasks:'))
      .map((e) => JSON.parse(e.message.slice('routing:tasks:'.length)) as Record<string, { model: string }>);
    expect(snapshots.length).toBeGreaterThan(0);
    const lastSnapshot = snapshots[snapshots.length - 1]!;
    const advertised = Object.values(lastSnapshot).map((entry) => entry.model);
    // At least one badge now shows the switched-to model, and none shows it stale.
    expect(advertised).toContain(ESCALATED_MODEL);
  });

  // Phase-7 final-review must-address (parent/overlay-split): a SUB-AGENT step
  // whose child/overlay model coincidentally equals a pending PARENT switch
  // target must NOT have its badge clobbered by parent-switch failure correction
  // (nor by the fail-then-succeed restore). Sub-agent badges are outside
  // parent-execution parity — the correction keys on the parent-route model and
  // skips sub-agent-overlaid entries entirely.
  it('preserves a sub-agent overlay badge through a failed parent switch even when the child model equals the switch target', async () => {
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      default_effort: 'low',
      // Parent escalation at s2 → ESCALATED_MODEL (also the s1 child model).
      escalation: { at_step: 's2', to_model: ESCALATED_MODEL, to_effort: 'high', reason: 'deep' },
    };
    const document = {
      goal: 'Complete the routed work',
      steps: [
        // s1 parent route is WORKING, but it delegates to a sub-agent whose CHILD
        // model equals the pending parent switch target (ESCALATED_MODEL). Its
        // badge legitimately shows the child model — the overlay must survive.
        {
          id: 's1',
          description: 'Delegate research',
          parallel_group: null,
          sub_agents: [{ task: 'Use researcher to dig in', model: ESCALATED_MODEL, effort: 'high', context: 'scoped' }],
        },
        { id: 's2', description: 'Synthesis', depends_on: ['s1'], parallel_group: null },
        { id: 's3', description: 'Write', depends_on: ['s2'], parallel_group: null },
      ],
      done_criteria: ['Answer delivered'],
      routing,
    };
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify(document),
      document,
      routing,
      usage: ZERO_USAGE,
      stopReason: 'end_turn',
      model: PLANNING_MODEL,
    });
    // Parent switch construction FAILS.
    mockCreateClientForModel.mockImplementation(() => {
      throw new Error('client boom');
    });
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor); // s2 due → parent switch fails
      await expect(config.betweenTurns?.([], ZERO_USAGE)).resolves.toBeUndefined();
    });

    await drainTurn();

    // Execution stayed on WORKING (parent switch failed).
    expect(observedConfigRef.current?.model).toBe(WORKING_MODEL);

    // Resolve the s1 (sub-agent) task id and the parent-route task ids.
    const seedStore = createTaskStore();
    const seeded = seedTaskStoreFromPlan(JSON.stringify(document), seedStore);
    const s1TaskId = seeded.stepIdToTaskIdMap.get('s1')!;
    const s2TaskId = seeded.stepIdToTaskIdMap.get('s2')!;
    const s3TaskId = seeded.stepIdToTaskIdMap.get('s3')!;

    const snapshots = emittedEvents
      .filter((e): e is { type: 'status'; message: string } =>
        e.type === 'status' && typeof (e as { message?: unknown }).message === 'string'
        && (e as { message: string }).message.startsWith('routing:tasks:'))
      .map((e) => JSON.parse(e.message.slice('routing:tasks:'.length)) as Record<string, { model: string; isSubAgent?: boolean }>);
    expect(snapshots.length).toBeGreaterThan(0);
    const lastSnapshot = snapshots[snapshots.length - 1]!;

    // Sub-agent overlay SURVIVES the failed parent switch (the bug would have
    // clobbered this to WORKING because its display model was a pending target).
    expect(lastSnapshot[s1TaskId]?.model).toBe(ESCALATED_MODEL);
    expect(lastSnapshot[s1TaskId]?.isSubAgent).toBe(true);
    // Parent-route task badges ARE corrected to the running model (parity holds).
    expect(lastSnapshot[s2TaskId]?.model).toBe(WORKING_MODEL);
    expect(lastSnapshot[s3TaskId]?.model).toBe(WORKING_MODEL);
  });

  // Stage 2 first-step timing fix: a switch whose task is ALREADY in_progress at
  // turn start (the first seeded step) must apply ONCE pre-loop, before the first
  // agent-loop iteration — not a full iteration late. The first runAgentLoop call
  // must therefore observe the switched model already in config.
  it('applies a first-step override before the first iteration (pre-loop switch pass)', async () => {
    const routing: RoutingDecision = { default_model: WORKING_MODEL, default_effort: 'low' };
    const document = {
      goal: 'Complete the routed work',
      steps: [
        // s1 is seeded in_progress pre-loop AND carries a per-step override → the
        // pre-loop pass must switch the parent model before the loop runs.
        { id: 's1', description: 'Heavy first step', parallel_group: null, model: ESCALATED_MODEL, effort: 'high' },
        { id: 's2', description: 'Lighter follow-up', depends_on: ['s1'], parallel_group: null, model: WORKING_MODEL, effort: 'low' },
      ],
      done_criteria: ['Answer delivered'],
      routing,
    };
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify(document),
      document,
      routing,
      usage: ZERO_USAGE,
      stopReason: 'end_turn',
      model: PLANNING_MODEL,
    });
    let modelAtFirstIteration: string | undefined;
    mockSingleLoop(async (config) => {
      // Capture the model the FIRST agent-loop iteration runs on (BEFORE any
      // betweenTurns). With the pre-loop pass it must already be ESCALATED.
      modelAtFirstIteration = config.model;
    });

    await drainTurn();

    expect(mockCreateClientForModel).toHaveBeenCalledWith(expect.objectContaining({
      model: ESCALATED_MODEL,
      context: 'escalated-execution',
    }));
    expect(modelAtFirstIteration).toBe(ESCALATED_MODEL);
  });

  // ---- Edge-case / cross-boundary battery (failed-switch hot region) ----

  // Failed-switch × MULTIPLE pending switches: a plan with two distinct
  // non-default per-step targets where the FIRST switch fails to construct. Only
  // the failing switch is held; the snapshot must never advertise an unapplied
  // model, every still-pending parent target badge is corrected to the running
  // model, and no second client is constructed on this iteration.
  it('holds only the failing switch and corrects all unapplied parent badges when the first of multiple pending switches fails', async () => {
    const routing: RoutingDecision = { default_model: WORKING_MODEL, default_effort: 'low' };
    const document = {
      goal: 'Complete the routed work',
      steps: [
        { id: 's1', description: 'Gather', parallel_group: null },
        { id: 's2', description: 'Synthesis', depends_on: ['s1'], parallel_group: null, model: ESCALATED_MODEL, effort: 'high' },
        { id: 's3', description: 'More synthesis', depends_on: ['s2'], parallel_group: null, model: ESCALATED_MODEL, effort: 'high' },
      ],
      done_criteria: ['done'],
      routing,
    };
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify(document), document, routing, usage: ZERO_USAGE, stopReason: 'end_turn', model: PLANNING_MODEL,
    });
    // s2 → ESCALATED switch fails to construct.
    mockCreateClientForModel.mockImplementation(() => { throw new Error('client boom'); });
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor); // s2 in_progress → switch due → fails
      await expect(config.betweenTurns?.([], ZERO_USAGE)).resolves.toBeUndefined();
    });

    await drainTurn();

    // The switch failed → execution stayed on WORKING; only ONE construction attempt.
    expect(mockCreateClientForModel).toHaveBeenCalledTimes(1);
    expect(observedConfigRef.current?.model).toBe(WORKING_MODEL);

    const snapshots = emittedEvents
      .filter((e): e is { type: 'status'; message: string } =>
        e.type === 'status' && typeof (e as { message?: unknown }).message === 'string'
        && (e as { message: string }).message.startsWith('routing:tasks:'))
      .map((e) => JSON.parse(e.message.slice('routing:tasks:'.length)) as Record<string, { model: string }>);
    expect(snapshots.length).toBeGreaterThan(0);
    const lastSnapshot = snapshots[snapshots.length - 1]!;
    const advertised = Object.values(lastSnapshot).map((entry) => entry.model);
    // NEITHER pending target (both ESCALATED) may appear — both parent badges
    // are corrected to the running WORKING model.
    expect(advertised).not.toContain(ESCALATED_MODEL);
    expect(advertised.every((m) => m === WORKING_MODEL)).toBe(true);
  });

  // Fail-then-succeed × ESCALATION: the escalation switch fails on the first
  // attempt, then succeeds on retry. The LAST routing:tasks: snapshot must show
  // the escalation target (badge follows execution back), and the ratchet stays
  // latched (no revert to WORKING afterwards).
  it('after an escalation switch fails then succeeds on retry, the last snapshot is the escalation target and the ratchet stays latched', async () => {
    mockPlan(makeRouting()); // escalation s2 → ESCALATED_MODEL
    mockCreateClientForModel
      .mockImplementationOnce(() => { throw new Error('client boom (transient)'); })
      .mockImplementation(() => escalatedClient);
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor);
      await expect(config.betweenTurns?.([], ZERO_USAGE)).resolves.toBeUndefined(); // fail
      expect(config.model).toBe(WORKING_MODEL);
      await expect(config.betweenTurns?.([], ZERO_USAGE)).resolves.toBeUndefined(); // retry → succeed
      expect(config.model).toBe(ESCALATED_MODEL);
      // Mark the task pending again — the one-way ratchet must NOT revert.
      await toolExecutor('TaskUpdate', { id: '2', status: 'pending' }, 'tool-x', TEST_TOOL_SIGNAL);
      await expect(config.betweenTurns?.([], ZERO_USAGE)).resolves.toBeUndefined();
    });

    await drainTurn();

    expect(mockCreateClientForModel).toHaveBeenCalledTimes(2); // fail + succeed; no third construction
    expect(observedConfigRef.current?.model).toBe(ESCALATED_MODEL); // ratchet latched

    const snapshots = emittedEvents
      .filter((e): e is { type: 'status'; message: string } =>
        e.type === 'status' && typeof (e as { message?: unknown }).message === 'string'
        && (e as { message: string }).message.startsWith('routing:tasks:'))
      .map((e) => JSON.parse(e.message.slice('routing:tasks:'.length)) as Record<string, { model: string }>);
    const lastSnapshot = snapshots[snapshots.length - 1]!;
    expect(Object.values(lastSnapshot).map((e) => e.model)).toContain(ESCALATED_MODEL);
  });

  // Failed-switch × sub-agent overlay coincidence + FAIL-THEN-SUCCEED (strong
  // pin for the just-fixed bug): a sub-agent child model equals the pending
  // parent target. The overlay must survive BOTH the failed parent switch AND the
  // subsequent successful retry — the fail-then-succeed restore keys on the
  // parent route and must never reach into the sub-agent badge.
  it('preserves a sub-agent overlay badge through a failed-then-succeeded parent switch when the child model equals the target', async () => {
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      default_effort: 'low',
      escalation: { at_step: 's2', to_model: ESCALATED_MODEL, to_effort: 'high', reason: 'deep' },
    };
    const document = {
      goal: 'Complete the routed work',
      steps: [
        {
          id: 's1',
          description: 'Delegate research',
          parallel_group: null,
          sub_agents: [{ task: 'Use researcher', model: ESCALATED_MODEL, effort: 'high', context: 'scoped' }],
        },
        { id: 's2', description: 'Synthesis', depends_on: ['s1'], parallel_group: null },
        { id: 's3', description: 'Write', depends_on: ['s2'], parallel_group: null },
      ],
      done_criteria: ['done'],
      routing,
    };
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify(document), document, routing, usage: ZERO_USAGE, stopReason: 'end_turn', model: PLANNING_MODEL,
    });
    // Fail the first parent switch, succeed on retry.
    mockCreateClientForModel
      .mockImplementationOnce(() => { throw new Error('client boom (transient)'); })
      .mockImplementation(() => escalatedClient);
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor);
      await expect(config.betweenTurns?.([], ZERO_USAGE)).resolves.toBeUndefined(); // fail
      await expect(config.betweenTurns?.([], ZERO_USAGE)).resolves.toBeUndefined(); // retry → succeed
    });

    await drainTurn();

    expect(observedConfigRef.current?.model).toBe(ESCALATED_MODEL); // parent switch eventually succeeded

    const seedStore = createTaskStore();
    const seeded = seedTaskStoreFromPlan(JSON.stringify(document), seedStore);
    const s1TaskId = seeded.stepIdToTaskIdMap.get('s1')!;

    const snapshots = emittedEvents
      .filter((e): e is { type: 'status'; message: string } =>
        e.type === 'status' && typeof (e as { message?: unknown }).message === 'string'
        && (e as { message: string }).message.startsWith('routing:tasks:'))
      .map((e) => JSON.parse(e.message.slice('routing:tasks:'.length)) as Record<string, { model: string; isSubAgent?: boolean }>);
    const lastSnapshot = snapshots[snapshots.length - 1]!;
    // The sub-agent overlay survived BOTH the fail and the success restore — its
    // child model (== the parent target) was never touched by parent correction.
    expect(lastSnapshot[s1TaskId]?.model).toBe(ESCALATED_MODEL);
    expect(lastSnapshot[s1TaskId]?.isSubAgent).toBe(true);
  });

  // F3 (wording): an ordinary per-step switch (NOT escalation) must emit neutral
  // "Routing to…" copy, while the actual escalation switch emits "Escalating to…".
  // The machine-readable routing:model: status is emitted for BOTH.
  it('F3: emits neutral "Routing to" for a per-step switch and "Escalating to" only for escalation', async () => {
    const routing: RoutingDecision = { default_model: WORKING_MODEL, default_effort: 'low' };
    const document = {
      goal: 'Complete the routed work',
      steps: [
        { id: 's1', description: 'Gather', parallel_group: null, model: WORKING_MODEL, effort: 'low' },
        { id: 's2', description: 'Heavy', depends_on: ['s1'], parallel_group: null, model: ESCALATED_MODEL, effort: 'high' },
        { id: 's3', description: 'Back', depends_on: ['s2'], parallel_group: null, model: WORKING_MODEL, effort: 'low' },
      ],
      done_criteria: ['done'],
      routing,
    };
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify(document), document, routing, usage: ZERO_USAGE, stopReason: 'end_turn', model: PLANNING_MODEL,
    });
    mockSingleLoop(async (config, toolExecutor) => {
      await advanceToSecondTask(toolExecutor); // s2 due → per-step switch to ESCALATED
      await config.betweenTurns?.([], ZERO_USAGE);
      await toolExecutor('TaskUpdate', { id: '3', status: 'in_progress', blockers: [] }, 'tool-3', TEST_TOOL_SIGNAL);
      await config.betweenTurns?.([], ZERO_USAGE); // s3 → back to WORKING
    });

    await drainTurn();

    const statusMessages = emittedEvents
      .filter((e): e is { type: 'status'; message: string } =>
        e.type === 'status' && typeof (e as { message?: unknown }).message === 'string')
      .map((e) => e.message);
    // Per-step switches are NEUTRAL routing, never escalation copy.
    expect(statusMessages).toContain(`Routing to ${ESCALATED_MODEL}`);
    expect(statusMessages).toContain(`Routing to ${WORKING_MODEL}`);
    expect(statusMessages).not.toContain(`Escalating to ${ESCALATED_MODEL}`);
    // But the machine-readable signal is still emitted for both.
    expect(statusMessages).toContain(`routing:model:${ESCALATED_MODEL}`);
    expect(statusMessages).toContain(`routing:model:${WORKING_MODEL}`);
  });

  it('F3: a genuine escalation switch still emits "Escalating to", not "Routing to"', async () => {
    mockPlan(makeRouting()); // escalation s2 → ESCALATED_MODEL
    mockSingleLoop(async (config, toolExecutor) => {
      await advanceToSecondTask(toolExecutor);
      await config.betweenTurns?.([], ZERO_USAGE);
    });

    await drainTurn();

    const statusMessages = emittedEvents
      .filter((e): e is { type: 'status'; message: string } =>
        e.type === 'status' && typeof (e as { message?: unknown }).message === 'string')
      .map((e) => e.message);
    expect(statusMessages).toContain(`Escalating to ${ESCALATED_MODEL}`);
    expect(statusMessages).not.toContain(`Routing to ${ESCALATED_MODEL}`);
  });

  // F2 (switch-back telemetry): a switch BACK to the working model must
  // reconstruct the default client WITH the working profile (restoring profile
  // id + limits), not by bare model string. Asserts createClientForModel is
  // called for the back-switch carrying the working profile.
  it('F2: a switch-back to the working model reconstructs the default client with the working profile', async () => {
    const WORKING_PROFILE_ID = 'working-profile';
    const settings = makeSettings();
    // Add a working profile for the working model + point workingProfileId at it.
    (settings.localModel!.profiles as unknown[]).push({
      id: WORKING_PROFILE_ID,
      name: 'Working Sonnet',
      model: WORKING_MODEL,
      providerType: 'anthropic',
      routingEligible: true,
      enabled: true,
      maxOutputTokens: 8_000,
      contextWindow: 100_000,
      createdAt: Date.now(),
    });
    // getWorkingModelProfile reads workingProfileId from settings.models/claude,
    // then falls back to localModel.activeProfileId — set the fallback here.
    (settings.localModel as unknown as { activeProfileId: string }).activeProfileId = WORKING_PROFILE_ID;

    const routing: RoutingDecision = { default_model: WORKING_MODEL, default_effort: 'low' };
    const document = {
      goal: 'Complete the routed work',
      steps: [
        { id: 's1', description: 'Gather', parallel_group: null, model: WORKING_MODEL, effort: 'low' },
        { id: 's2', description: 'Heavy', depends_on: ['s1'], parallel_group: null, model: ESCALATED_MODEL, effort: 'high' },
        { id: 's3', description: 'Back', depends_on: ['s2'], parallel_group: null, model: WORKING_MODEL, effort: 'low' },
      ],
      done_criteria: ['done'],
      routing,
    };
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify(document), document, routing, usage: ZERO_USAGE, stopReason: 'end_turn', model: PLANNING_MODEL,
    });
    mockCreateClientForModel.mockReturnValue(escalatedClient);
    mockSingleLoop(async (config, toolExecutor) => {
      await advanceToSecondTask(toolExecutor); // s2 → ESCALATED
      await config.betweenTurns?.([], ZERO_USAGE);
      await toolExecutor('TaskUpdate', { id: '3', status: 'in_progress', blockers: [] }, 'tool-3', TEST_TOOL_SIGNAL);
      await config.betweenTurns?.([], ZERO_USAGE); // s3 → back to WORKING
    });

    await drainTurn(settings);

    // The back-switch to the working model carried the working profile (NOT a
    // bare model-string reconstruction), so profile telemetry is preserved.
    expect(mockCreateClientForModel).toHaveBeenCalledWith(expect.objectContaining({
      model: WORKING_MODEL,
      profile: expect.objectContaining({ id: WORKING_PROFILE_ID }),
    }));
  });

  // F2 REGRESSION (GPT High must-address): when the planner re-points the turn
  // DEFAULT to a model different from the settings working model, the
  // working-route profile passed to the compiler MUST describe the ROUTED
  // default, not the stale settings working profile. Otherwise a switch-BACK to
  // default builds a client for the stale profile's OWN model (explicit profile
  // wins) while routing:model: claims the routed default — model/UI divergence.
  //
  // Repro: settings working profile = Sonnet; planner default_model = Opus;
  // s1=default(Opus), s2=per-step Haiku, s3=default(back to Opus). The s3
  // back-switch must build the OPUS client carrying the ROUTED (Opus) profile,
  // NEVER the original Sonnet working profile.
  it('F2: a switch-back to a planner-routed default uses the ROUTED profile, not the stale settings working profile', async () => {
    const SONNET_WORKING_PROFILE_ID = 'sonnet-working';
    const OPUS_ROUTED_PROFILE_ID = 'escalated'; // Opus, already in makeSettings pool
    const HAIKU_MODEL = 'claude-haiku-4-5';
    const HAIKU_PROFILE_ID = 'haiku-profile';
    const settings = makeSettings();
    // Add a Sonnet working profile (the settings working model) + a Haiku pool
    // profile; point the active/working profile at Sonnet.
    (settings.localModel!.profiles as unknown[]).push(
      {
        id: SONNET_WORKING_PROFILE_ID,
        name: 'Working Sonnet',
        model: WORKING_MODEL,
        providerType: 'anthropic',
        routingEligible: true,
        enabled: true,
        maxOutputTokens: 8_000,
        contextWindow: 100_000,
        createdAt: Date.now(),
      },
      {
        id: HAIKU_PROFILE_ID,
        name: 'Haiku',
        model: HAIKU_MODEL,
        providerType: 'anthropic',
        routingEligible: true,
        enabled: true,
        maxOutputTokens: 8_000,
        contextWindow: 100_000,
        createdAt: Date.now(),
      },
    );
    (settings.localModel as unknown as { activeProfileId: string }).activeProfileId = SONNET_WORKING_PROFILE_ID;

    // Planner re-points the turn DEFAULT to Opus (≠ Sonnet working model).
    const routing: RoutingDecision = { default_model: ESCALATED_MODEL, default_effort: 'low' };
    const document = {
      goal: 'Complete the routed work',
      steps: [
        { id: 's1', description: 'Default work', parallel_group: null }, // default → Opus
        { id: 's2', description: 'Cheap detour', depends_on: ['s1'], parallel_group: null, model: HAIKU_MODEL, effort: 'low' },
        { id: 's3', description: 'Back to default', depends_on: ['s2'], parallel_group: null }, // back → Opus
      ],
      done_criteria: ['done'],
      routing,
    };
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify(document), document, routing, usage: ZERO_USAGE, stopReason: 'end_turn', model: PLANNING_MODEL,
    });
    mockCreateClientForModel.mockReturnValue(escalatedClient);
    const observedConfigRef: { current?: RebelCoreConfig } = {};
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;
      await advanceToSecondTask(toolExecutor); // s2 → Haiku
      await config.betweenTurns?.([], ZERO_USAGE);
      await toolExecutor('TaskUpdate', { id: '3', status: 'in_progress', blockers: [] }, 'tool-3', TEST_TOOL_SIGNAL);
      await config.betweenTurns?.([], ZERO_USAGE); // s3 → back to Opus default
    });

    await drainTurn(settings);

    // The back-switch to the routed default (Opus) must carry the ROUTED (Opus)
    // profile, NOT the stale Sonnet working profile — and never pair Opus with
    // the Sonnet profile id.
    const backSwitchCalls = mockCreateClientForModel.mock.calls
      .map((c) => c[0] as { model: string; profile?: { id?: string } })
      .filter((arg) => arg.model === ESCALATED_MODEL);
    expect(backSwitchCalls.length).toBeGreaterThan(0);
    for (const call of backSwitchCalls) {
      // If a profile is attached it MUST be the Opus routed profile, never Sonnet.
      if (call.profile) {
        expect(call.profile.id).toBe(OPUS_ROUTED_PROFILE_ID);
      }
      expect(call.profile?.id).not.toBe(SONNET_WORKING_PROFILE_ID);
    }
    // Execution ends on the routed default (Opus).
    expect(observedConfigRef.current?.model).toBe(ESCALATED_MODEL);
  });

  it('exposes stepIdToTaskIdMap from seedTaskStoreFromPlan', () => {
    const taskStore = createTaskStore();
    const seeded = seedTaskStoreFromPlan(makePlan(makeRouting()).planText, taskStore);
    const tasks = taskStore.listTasks().filter((task) => task.owner !== 'mission');

    expect(seeded.stepIdToTaskIdMap.get('s1')).toBe(tasks[0].id);
    expect(seeded.stepIdToTaskIdMap.get('s2')).toBe(tasks[1].id);
    expect(seeded.stepIdToTaskIdMap.get('s3')).toBe(tasks[2].id);
  });

  // Stage 6 (atomicity-claim correction, per GPT-5.5 cross-family review): pins
  // the HONEST runtime timing of grouped escalation. Stage 6's compiler change
  // makes the grouped-escalation ROUTE + SCHEDULE atomic (a single escalation
  // switch keyed to the group's FIRST member). This test documents that the
  // switch applies via the STANDARD betweenTurns path — when the keyed task
  // reaches in_progress — exactly like every other per-step/escalation switch.
  //
  // It does NOT add pre-dispatch runtime atomicity: like all switches, the keyed
  // task's own first iteration can run on the pre-escalation model (the switch is
  // observed at the next betweenTurns). True pre-dispatch switching for a later
  // group's first concurrent tool batch is a SEPARATE, system-wide agent-loop
  // capability — explicitly out of Stage 6 scope, recorded as a follow-up.
  it('keys grouped escalation to the group first member and applies it via the standard betweenTurns path (Stage 6 runtime timing)', async () => {
    const routing: RoutingDecision = {
      default_model: WORKING_MODEL,
      default_effort: 'low',
      // at_step is g2 — a LATER member of the parallel group. The compiler
      // re-points engagement to the group's first member (g1).
      escalation: { at_step: 'g2', to_model: ESCALATED_MODEL, to_effort: 'high', reason: 'deep' },
    };
    const document = {
      goal: 'Complete the routed work',
      steps: [
        { id: 's1', description: 'Gather inputs', parallel_group: null },
        { id: 'g1', description: 'Branch A', depends_on: ['s1'], parallel_group: 'grp' },
        { id: 'g2', description: 'Branch B', depends_on: ['s1'], parallel_group: 'grp' },
        { id: 's3', description: 'Write', depends_on: ['g1', 'g2'], parallel_group: null },
      ],
      done_criteria: ['Answer delivered'],
      routing,
    };
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify(document),
      document,
      routing,
      usage: ZERO_USAGE,
      stopReason: 'end_turn',
      model: PLANNING_MODEL,
    });

    // Resolve the real seeded task ids so the assertions key on the group's
    // FIRST member (g1), not a positional guess.
    const seedStore = createTaskStore();
    const seeded = seedTaskStoreFromPlan(JSON.stringify(document), seedStore);
    const s1TaskId = seeded.stepIdToTaskIdMap.get('s1')!;
    const g1TaskId = seeded.stepIdToTaskIdMap.get('g1')!;

    const observedConfigRef: { current?: RebelCoreConfig } = {};
    let modelBeforeGroupInProgress: string | undefined;
    mockSingleLoop(async (config, toolExecutor) => {
      observedConfigRef.current = config;

      // HONEST LIMITATION: with only the first seeded step (s1) in_progress, the
      // escalation switch (keyed to g1) is NOT yet due — the group's first batch
      // would dispatch on the pre-escalation model. No pre-dispatch atomicity.
      await config.betweenTurns?.([], ZERO_USAGE);
      modelBeforeGroupInProgress = config.model;

      // Standard path: once the group's FIRST member (g1) is in_progress, the
      // single escalation switch becomes due and applies at this betweenTurns.
      await toolExecutor('TaskUpdate', { id: s1TaskId, status: 'completed' }, 'tool-1', TEST_TOOL_SIGNAL);
      await toolExecutor('TaskUpdate', { id: g1TaskId, status: 'in_progress', blockers: [] }, 'tool-2', TEST_TOOL_SIGNAL);
      await config.betweenTurns?.([], ZERO_USAGE);
    });

    await drainTurn();

    // Before the group's first member is in_progress: still on the working model
    // (the switch had not applied — the documented runtime timing, not a bug).
    expect(modelBeforeGroupInProgress).toBe(WORKING_MODEL);

    // The escalation switch applied exactly once, keyed to the group boundary.
    expect(mockCreateClientForModel).toHaveBeenCalledTimes(1);
    expect(mockCreateClientForModel).toHaveBeenCalledWith(expect.objectContaining({
      model: ESCALATED_MODEL,
      context: 'escalated-execution',
    }));
    expect(observedConfigRef.current?.model).toBe(ESCALATED_MODEL);
    // It is an escalation switch (group-atomic, single boundary trigger).
    expect(emittedEvents).toContainEqual({ type: 'status', message: `Escalating to ${ESCALATED_MODEL}` });
  });

  // FOX-3436 Stage 2: the adaptive-routing / mid-turn model-switch sole-writer commit must keep
  // agentTurnRegistry in sync so buildModelRoles() binds the working role to the routed model
  // rather than the configured alias. Without this, the registry goes stale exactly like seam (a).
  describe('FOX-3436 Stage 2: registry sync on adaptive model switch', () => {
    afterEach(() => {
      agentTurnRegistry.cleanupTurn('turn-stage2-switch');
      agentTurnRegistry.cleanupTurn('turn-stage2-effort');
      agentTurnRegistry.cleanupTurn('turn-stage2-switchback');
      agentTurnRegistry.cleanupTurn('turn-stage2-default-route');
    });

    // Site (a): the PRE-LOOP adaptive default-route commit (rebelCoreQuery.ts:1698) fires when the
    // planner re-points the turn DEFAULT to a model different from the configured working model
    // (so isWorkingModel/isSameModel are false). Mirrors the F2 setup: working = Sonnet
    // (WORKING_MODEL), planner default = Opus (ESCALATED_MODEL, the routing-eligible pool profile).
    // The registry must record the routed default BEFORE the agent loop runs.
    it('records the routed default model from the pre-loop adaptive default route (site a)', async () => {
      const turnId = 'turn-stage2-default-route';
      // Seed the registry with the configured working model, mimicking the executor base write.
      agentTurnRegistry.setTurnModel(turnId, WORKING_MODEL);
      // adaptiveRoutingEnabled is on via makeSettings() default.
      const routing: RoutingDecision = { default_model: ESCALATED_MODEL, default_effort: 'low' };
      const document = {
        goal: 'Complete the routed work',
        steps: [
          { id: 's1', description: 'Gather inputs', parallel_group: null },
          { id: 's2', description: 'Write final answer', depends_on: ['s1'], parallel_group: null },
        ],
        done_criteria: ['Answer delivered'],
        routing,
      };
      mockRunPlanningPhase.mockResolvedValue({
        planText: JSON.stringify(document),
        document,
        routing,
        usage: ZERO_USAGE,
        stopReason: 'end_turn',
        model: PLANNING_MODEL,
      });
      mockCreateClientForModel.mockReturnValue(escalatedClient);
      const observedConfigRef: { current?: RebelCoreConfig } = {};
      mockSingleLoop(async (config) => {
        observedConfigRef.current = config;
        // The pre-loop default route has already committed before the loop runs, so the
        // registry must already reflect the routed default by the time the loop body executes.
        expect(agentTurnRegistry.getTurnModel(turnId)).toBe(ESCALATED_MODEL);
        await config.betweenTurns?.([], ZERO_USAGE);
      });

      await drainTurnWithTurnId(turnId);

      // Pre-loop route built the routed (Opus) client and committed the routed default as the
      // execution model — confirming site (a) fired (isSameModel was false).
      expect(mockCreateClientForModel).toHaveBeenCalledWith(expect.objectContaining({
        model: ESCALATED_MODEL,
        context: 'routed-execution',
      }));
      expect(observedConfigRef.current?.model).toBe(ESCALATED_MODEL);
      expect(agentTurnRegistry.getTurnModel(turnId)).toBe(ESCALATED_MODEL);
    });

    it('records the escalated model in the turn registry after a mid-turn model switch', async () => {
      const turnId = 'turn-stage2-switch';
      // Seed the registry with the configured alias, mimicking the executor base write.
      agentTurnRegistry.setTurnModel(turnId, WORKING_MODEL);
      mockPlan(makeRouting()); // escalation at s2 → ESCALATED_MODEL
      mockSingleLoop(async (config, toolExecutor) => {
        await advanceToSecondTask(toolExecutor);
        await config.betweenTurns?.([], ZERO_USAGE);
      });

      await drainTurnWithTurnId(turnId);

      expect(agentTurnRegistry.getTurnModel(turnId)).toBe(ESCALATED_MODEL);
    });

    it('does NOT change the registry model on an effort-only (isSameModel) switch', async () => {
      const turnId = 'turn-stage2-effort';
      agentTurnRegistry.setTurnModel(turnId, WORKING_MODEL);
      mockPlan(makeRouting({ to_model: WORKING_MODEL, to_effort: 'high' })); // effort-only → no model change
      mockSingleLoop(async (config, toolExecutor) => {
        await advanceToSecondTask(toolExecutor);
        await config.betweenTurns?.([], ZERO_USAGE);
      });

      await drainTurnWithTurnId(turnId);

      expect(mockCreateClientForModel).not.toHaveBeenCalled();
      expect(agentTurnRegistry.getTurnModel(turnId)).toBe(WORKING_MODEL);
    });

    it('tracks each model on a switch then switch-back (WORKING -> ESCALATED -> WORKING)', async () => {
      const turnId = 'turn-stage2-switchback';
      agentTurnRegistry.setTurnModel(turnId, WORKING_MODEL);
      const routing: RoutingDecision = { default_model: WORKING_MODEL, default_effort: 'low' };
      const document = {
        goal: 'Complete the routed work',
        steps: [
          { id: 's1', description: 'Gather inputs', parallel_group: null, model: WORKING_MODEL, effort: 'low' },
          { id: 's2', description: 'Perform deep synthesis', depends_on: ['s1'], parallel_group: null, model: ESCALATED_MODEL, effort: 'high' },
          { id: 's3', description: 'Write final answer', depends_on: ['s2'], parallel_group: null, model: WORKING_MODEL, effort: 'low' },
        ],
        done_criteria: ['Answer delivered'],
        routing,
      };
      mockRunPlanningPhase.mockResolvedValue({
        planText: JSON.stringify(document),
        document,
        routing,
        usage: ZERO_USAGE,
        stopReason: 'end_turn',
        model: PLANNING_MODEL,
      });
      mockSingleLoop(async (config, toolExecutor) => {
        await advanceToSecondTask(toolExecutor);
        await config.betweenTurns?.([], ZERO_USAGE);
        // After the first switch the registry should track the escalated model.
        expect(agentTurnRegistry.getTurnModel(turnId)).toBe(ESCALATED_MODEL);
        const third = await toolExecutor('TaskUpdate', { id: '3', status: 'in_progress', blockers: [] }, 'tool-3', TEST_TOOL_SIGNAL);
        expect(third.isError).toBe(false);
        await config.betweenTurns?.([], ZERO_USAGE);
      });

      await drainTurnWithTurnId(turnId);

      // Switch-back to WORKING_MODEL must be reflected too.
      expect(agentTurnRegistry.getTurnModel(turnId)).toBe(WORKING_MODEL);
    });
  });
});
