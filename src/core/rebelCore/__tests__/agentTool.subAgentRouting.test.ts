import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { resolveRoutingProfileRef } from '@shared/utils/connectivityHelpers';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { AgentToolContext } from '../types';
import type { PlanningStep } from '../planningMode';

const {
  mockRunAgentLoop,
  mockCreateClientFromRoutePlan,
  mockResolveThinkingConfig,
  mockResolveEffortForApi,
  mockLogProviderRetryTelemetry,
} = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
  mockCreateClientFromRoutePlan: vi.fn().mockReturnValue({}),
  mockResolveThinkingConfig: vi.fn().mockReturnValue({ type: 'disabled' }),
  mockResolveEffortForApi: vi.fn().mockReturnValue(undefined),
  mockLogProviderRetryTelemetry: vi.fn(),
}));

 
vi.mock('../agentLoop', () => ({
  runAgentLoop: mockRunAgentLoop,
}));

 
vi.mock('../hookPipeline', () => ({
  runSubagentStartHooks: vi.fn().mockResolvedValue(undefined),
  runSubagentStopHooks: vi.fn().mockResolvedValue(undefined),
  createHookAwareToolExecutor: vi.fn().mockImplementation((base: unknown) => base),
}));

 
vi.mock('../builtinTools', () => ({
  getBuiltinToolDefinitions: vi.fn().mockReturnValue([]),
  isBuiltinToolName: vi.fn().mockReturnValue(false),
  executeBuiltinTool: vi.fn(),
  GET_MISSION_CONTEXT_TOOL_DEFINITION: {
    name: 'GetMissionContext',
    description: 'Get mission context',
    input_schema: { type: 'object', properties: {} },
  },
  SUMMARIZE_RESULT_TOOL_DEFINITION: {
    name: 'SummarizeResult',
    description: 'Summarize result',
    input_schema: { type: 'object', properties: {} },
  },
}));

 
vi.mock('../mcpClient', () => ({
  isMcpToolName: vi.fn().mockReturnValue(false),
}));

 
vi.mock('../taskState', () => ({
  createScopedTaskStore: vi.fn().mockReturnValue({
    listTasks: vi.fn().mockReturnValue([]),
    createTask: vi.fn(),
  }),
  createTaskStore: vi.fn().mockReturnValue({
    listTasks: vi.fn().mockReturnValue([]),
    createTask: vi.fn(),
  }),
}));

 
vi.mock('../modelLimits', () => ({
  shouldSuppressProfileReasoning: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => profile?.thinkingCompatibility === 'incompatible',
  resolveProfileReasoningEffort: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => (profile?.thinkingCompatibility === 'incompatible' ? undefined : profile?.reasoningEffort),
  resolveThinkingConfig: mockResolveThinkingConfig,
  resolveEffortForApi: mockResolveEffortForApi,
  resolveModelLimits: vi.fn().mockReturnValue({ contextWindow: 200_000, maxOutputTokens: 64_000 }),
}));

 
vi.mock('../clientFactory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clientFactory')>();
  return {
    ...actual,
    createClientFromRoutePlan: mockCreateClientFromRoutePlan,
  };
});

 
vi.mock('../util/retryTelemetry', () => ({
  logProviderRetryTelemetry: mockLogProviderRetryTelemetry,
}));

import {
  claimSubAgentAssignment,
  executeAgentTool,
  findSelectableProfileForModel,
  resolveAssignedSubAgentProfile,
} from '../agentTool';

function makeSettings(adaptiveRoutingEnabled = true): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    models: {
      apiKey: 'fake-ant-test',
      oauthToken: null,
      authMethod: 'api-key',
      model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
      thinkingModel: undefined,
      workingProfileId: null,
      thinkingProfileId: null,
      behindTheScenesModel: undefined,
    },
    diagnostics: { enabled: false },
    experimental: {
      adaptiveRoutingEnabled,
    },
    localModel: {
      activeProfileId: null,
      profiles: [
        {
          id: 'local-gpt-55',
          name: 'Local GPT-5.5',
          providerType: 'local',
          serverUrl: 'http://localhost:11434/v1',
          model: unsafeAssertRoutingModelId('gpt-5.5'),
          enabled: true,
          routingEligible: true,
          createdAt: Date.now(),
        },
      ],
    },
  } as unknown as AppSettings;
}

/**
 * Settings with a single `gpt-5.5` profile whose routing-pool gates can be
 * tweaked per-test (Stage-3 sub-agent eligibility/connectivity gate coverage).
 */
function makeSettingsWithProfile(profileOverrides: Record<string, unknown>): AppSettings {
  const base = makeSettings();
  return {
    ...base,
    localModel: {
      activeProfileId: null,
      profiles: [
        {
          id: 'local-gpt-55',
          name: 'Local GPT-5.5',
          providerType: 'local',
          serverUrl: 'http://localhost:11434/v1',
          model: unsafeAssertRoutingModelId('gpt-5.5'),
          enabled: true,
          routingEligible: true,
          createdAt: Date.now(),
          ...profileOverrides,
        },
      ],
    },
  } as unknown as AppSettings;
}

function makeCtx(overrides: {
  settings?: AppSettings;
  planSteps?: PlanningStep[];
  consumedAssignments?: Set<string>;
  onSubAgentEvent?: AgentToolContext['onSubAgentEvent'];
  onTaskRoutingMetadataUpdate?: AgentToolContext['onTaskRoutingMetadataUpdate'];
  taskStoreInternal?: AgentToolContext['taskStoreInternal'];
  connectivity?: AgentToolContext['connectivity'];
} = {}): AgentToolContext {
  return {
    agents: {
      researcher: {
        description: 'Researches information',
        prompt: 'You are a research sub-agent.',
        model: 'inherit',
      },
    },
    client: {} as AgentToolContext['client'],
    settings: overrides.settings ?? makeSettings(),
    parentModel: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
    parentMaxTokens: 4096,
    parentEffort: 'low',
    depth: 0,
    planRouting: {
      default_model: 'claude-sonnet-4-20250514',
      default_effort: 'low',
    },
    planSteps: overrides.planSteps,
    consumedAssignments: overrides.consumedAssignments ?? new Set<string>(),
    turnId: 'turn-routing-test',
    ...(overrides.onSubAgentEvent ? { onSubAgentEvent: overrides.onSubAgentEvent } : {}),
    ...(overrides.onTaskRoutingMetadataUpdate
      ? { onTaskRoutingMetadataUpdate: overrides.onTaskRoutingMetadataUpdate }
      : {}),
    ...(overrides.taskStoreInternal
      ? { taskStoreInternal: overrides.taskStoreInternal }
      : {}),
    ...(overrides.connectivity ? { connectivity: overrides.connectivity } : {}),
    codexConnectivity: 'unknown',
  };
}

/**
 * Build a minimal taskStoreInternal mock that tracks delegation tracking task
 * creation. createDelegationTrackingTask requires _getNextTaskId, _setRawTask,
 * _setNextTaskId, and _refreshBlockedTasks; everything else can be a no-op
 * for these unit tests.
 */
type TrackingTaskStore = NonNullable<AgentToolContext['taskStoreInternal']> & {
  __tasks: Map<string, unknown>;
};

function makeTrackingTaskStore(): TrackingTaskStore {
  let nextId = 1;
  const tasks = new Map<string, unknown>();
  const store = {
    listTasks: () => [],
    createTask: () => ({ id: '0', title: '', status: 'pending', createdAt: 0, updatedAt: 0 }),
    getTask: () => null,
    updateTask: () => null,
    replaceWithTodos: () => [],
    getContextState: () => ({ currentGoal: null, workInProgress: null, relevantHistory: [] }),
    updateContextState: () => undefined,
    _getNextTaskId: () => nextId,
    _setNextTaskId: (n: number) => { nextId = n; },
    _setRawTask: (id: string, task: unknown) => { tasks.set(id, task); },
    _getRawTask: (id: string) => tasks.get(id) as never,
    _deleteTask: () => false,
    _getAllTasks: () => new Map() as never,
    _refreshBlockedTasks: () => undefined,
    archiveTurn: () => undefined,
    getArchivedTurns: () => [],
    exportState: () => ({ tasks: [], nextTaskId: nextId }),
    importState: () => undefined,
    __tasks: tasks,
  };
  return store as unknown as TrackingTaskStore;
}

describe('sub-agent adaptive routing assignment matching', () => {
  it('exact agent name match works', () => {
    const consumed = new Set<string>();
    const claim = claimSubAgentAssignment(
      'researcher',
      'Look up release details',
      [{
        id: 's1',
        sub_agents: [
          { task: 'Use researcher to look up release details', model: unsafeAssertRoutingModelId('gpt-5.5'), effort: 'medium' },
        ],
      }],
      consumed,
    );

    const assignment = claim?.assignment;
    expect(assignment?.model).toBe('gpt-5.5');
    expect(consumed.has('0:0')).toBe(true);
  });

  it('keyword overlap match works', () => {
    const claim = claimSubAgentAssignment(
      'forager',
      'Investigate routing dispatch failures in sub-agent execution',
      [{
        id: 's1',
        sub_agents: [
          { task: 'Research routing dispatch failure evidence', model: unsafeAssertRoutingModelId('gpt-5.5') },
        ],
      }],
      new Set<string>(),
    );

    const assignment = claim?.assignment;
    expect(assignment?.task).toBe('Research routing dispatch failure evidence');
  });

  it('no match returns null', () => {
    const claim = claimSubAgentAssignment(
      'researcher',
      'Debug an Electron crash on startup',
      [{
        id: 's1',
        sub_agents: [
          { task: 'Summarize sales notes from the meeting', model: unsafeAssertRoutingModelId('gpt-5.5') },
        ],
      }],
      new Set<string>(),
    );

    expect(claim).toBeNull();
  });

  it('consumed assignment is not re-matched', () => {
    const consumed = new Set<string>();
    const planSteps: PlanningStep[] = [{
      id: 's1',
      sub_agents: [
        { task: 'Use researcher to gather routing evidence', model: unsafeAssertRoutingModelId('gpt-5.5') },
      ],
    }];

    expect(claimSubAgentAssignment('researcher', 'Gather routing evidence', planSteps, consumed)).not.toBeNull();
    expect(claimSubAgentAssignment('researcher', 'Gather routing evidence again', planSteps, consumed)).toBeNull();
  });
});

describe('executeAgentTool sub-agent adaptive routing overrides', () => {
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockCreateClientFromRoutePlan.mockReset();
    mockResolveThinkingConfig.mockReset();
    mockResolveEffortForApi.mockReset();
    mockLogProviderRetryTelemetry.mockReset();
    mockRunAgentLoop.mockResolvedValue(undefined);
    mockCreateClientFromRoutePlan.mockReturnValue({});
    mockResolveThinkingConfig.mockReturnValue({ type: 'disabled' });
    mockResolveEffortForApi.mockReturnValue(undefined);
  });

  it('model override is applied when matched', async () => {
    const ctx = makeCtx({
      planSteps: [{
        id: 's1',
        sub_agents: [
          { task: 'Use researcher to inspect routing dispatch', model: unsafeAssertRoutingModelId('gpt-5.5') },
        ],
      }],
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect routing dispatch' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expect(mockRunAgentLoop.mock.calls[0][0]).toMatchObject({ model: unsafeAssertRoutingModelId('gpt-5.5') });
  });

  it('effort override is applied when matched', async () => {
    mockResolveEffortForApi.mockImplementation((effort: string | undefined) =>
      effort === 'high' ? 'high' : undefined
    );
    const ctx = makeCtx({
      planSteps: [{
        id: 's1',
        sub_agents: [
          { task: 'Use researcher to inspect routing dispatch', model: unsafeAssertRoutingModelId('gpt-5.5'), effort: 'high' },
        ],
      }],
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect routing dispatch' }, ctx);

    expect(mockResolveThinkingConfig).toHaveBeenLastCalledWith('high', 'gpt-5.5', 4096);
    expect(mockResolveEffortForApi).toHaveBeenLastCalledWith('high', 'gpt-5.5');
    expect(mockRunAgentLoop.mock.calls[0][0]).toMatchObject({ model: unsafeAssertRoutingModelId('gpt-5.5'), effort: 'high' });
  });

  it('emits routing metadata keyed by the parent Agent toolUseId when matched', async () => {
    mockResolveEffortForApi.mockImplementation((effort: string | undefined) =>
      effort === 'high' ? 'high' : undefined
    );
    const onSubAgentEvent = vi.fn();
    const ctx = makeCtx({
      onSubAgentEvent,
      planSteps: [{
        id: 's1',
        sub_agents: [
          { task: 'Use researcher to inspect routing dispatch', model: unsafeAssertRoutingModelId('gpt-5.5'), effort: 'high', context: 'scoped' },
        ],
      }],
    });

    await executeAgentTool(
      { agent: 'researcher', prompt: 'Inspect routing dispatch' },
      ctx,
      'toolu_parent_agent_1',
    );

    expect(onSubAgentEvent).toHaveBeenCalledWith(
      {
        type: 'status',
        message: 'routing:subagent:toolu_parent_agent_1:gpt-5.5:scoped:high:gpt-5.5:high:0',
      },
      'toolu_parent_agent_1',
    );
  });

  it('no matching assignment leaves default routing in place', async () => {
    const ctx = makeCtx({
      planSteps: [{
        id: 's1',
        sub_agents: [
          { task: 'Summarize sales notes from the meeting', model: unsafeAssertRoutingModelId('gpt-5.5') },
        ],
      }],
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'Debug an Electron crash on startup' }, ctx);

    expect(mockRunAgentLoop.mock.calls[0][0]).toMatchObject({ model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514') });
    expect(ctx.consumedAssignments?.size).toBe(0);
  });

  it('feature flag OFF leaves default routing in place', async () => {
    const ctx = makeCtx({
      settings: makeSettings(false),
      planSteps: [{
        id: 's1',
        sub_agents: [
          { task: 'Use researcher to inspect routing dispatch', model: unsafeAssertRoutingModelId('gpt-5.5') },
        ],
      }],
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect routing dispatch' }, ctx);

    expect(mockRunAgentLoop.mock.calls[0][0]).toMatchObject({ model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514') });
    expect(ctx.consumedAssignments?.size).toBe(0);
  });

  it('invalid model in assignment falls back to default', async () => {
    const ctx = makeCtx({
      planSteps: [{
        id: 's1',
        sub_agents: [
          { task: 'Use researcher to inspect routing dispatch', model: unsafeAssertRoutingModelId('missing-model') },
        ],
      }],
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect routing dispatch' }, ctx);

    expect(mockRunAgentLoop.mock.calls[0][0]).toMatchObject({ model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514') });
  });

  // Stage-3 fix: the planner-assigned sub-agent model now honours the routing
  // pool's `routingEligible` gate (previously ignored). A profile that is
  // enabled + selectable but NOT routing-eligible must NOT be picked — the
  // sub-agent falls back to the default route, exactly like the parent path.
  it('non-routing-eligible assignment profile falls back to default', async () => {
    const ctx = makeCtx({
      settings: makeSettingsWithProfile({ routingEligible: false }),
      planSteps: [{
        id: 's1',
        sub_agents: [
          { task: 'Use researcher to inspect routing dispatch', model: unsafeAssertRoutingModelId('gpt-5.5') },
        ],
      }],
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect routing dispatch' }, ctx);

    expect(mockRunAgentLoop.mock.calls[0][0]).toMatchObject({ model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514') });
  });

  // Stage-3 fix: the planner-assigned sub-agent model now honours the parent
  // turn's connectivity snapshot for connection-gated profiles. A
  // connection-gated assignment whose connection is dead must fall back to the
  // default route.
  it('dead-connection assignment profile falls back to default', async () => {
    const ctx = makeCtx({
      // A connection-gated (profileSource:'connection') openrouter profile whose
      // connection is reported dead by the connectivity snapshot.
      settings: makeSettingsWithProfile({
        providerType: 'openrouter',
        profileSource: 'connection',
        serverUrl: 'https://openrouter.ai/api/v1',
      }),
      connectivity: { isProfileLive: () => false },
      planSteps: [{
        id: 's1',
        sub_agents: [
          { task: 'Use researcher to inspect routing dispatch', model: unsafeAssertRoutingModelId('gpt-5.5') },
        ],
      }],
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect routing dispatch' }, ctx);

    expect(mockRunAgentLoop.mock.calls[0][0]).toMatchObject({ model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514') });
  });

  it('stamps the delegation tracking task with sub-agent routing metadata', async () => {
    const onTaskRoutingMetadataUpdate = vi.fn();
    const taskStoreInternal = makeTrackingTaskStore();
    const ctx = makeCtx({
      taskStoreInternal,
      onTaskRoutingMetadataUpdate,
      planSteps: [{
        id: 's1',
        sub_agents: [
          { task: 'Use researcher to inspect routing dispatch', model: unsafeAssertRoutingModelId('gpt-5.5'), context: 'contextual' },
        ],
      }],
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect routing dispatch' }, ctx);

    expect(onTaskRoutingMetadataUpdate).toHaveBeenCalledTimes(1);
    const [taskId, info] = onTaskRoutingMetadataUpdate.mock.calls[0];
    expect(typeof taskId).toBe('string');
    expect(taskId.length).toBeGreaterThan(0);
    expect(info).toMatchObject({
      model: unsafeAssertRoutingModelId('gpt-5.5'),
      isSubAgent: true,
      subAgentContext: 'contextual',
    });
  });

  it('wires runAgentLoop onRetry to sub-agent retry telemetry callsite', async () => {
    const ctx = makeCtx();

    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect routing dispatch' }, ctx);

    const runConfig = mockRunAgentLoop.mock.calls[0]?.[0];
    expect(runConfig).toBeDefined();
    expect(typeof runConfig.onRetry).toBe('function');

    runConfig.onRetry({
      attempt: 1,
      maxRetries: 2,
      delayMs: 100,
      errorKind: 'rate_limit',
      provider: 'anthropic',
    });

    expect(mockLogProviderRetryTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        maxRetries: 2,
        delayMs: 100,
        errorKind: 'rate_limit',
        provider: 'anthropic',
      }),
      'sub-agent',
    );
  });

  it('creates an orchestration tracking task with routed-model label and child namespace owner', async () => {
    const taskStoreInternal = makeTrackingTaskStore();
    const ctx = makeCtx({ taskStoreInternal });
    ctx.agents.researcher = {
      ...ctx.agents.researcher,
      model: 'working',
      routingMode: 'ad-hoc',
      routedModel: 'gemini-2.5-pro',
    };

    await executeAgentTool({ agent: 'researcher', prompt: 'Investigate routing dispatch' }, ctx);

    const task = taskStoreInternal.__tasks.get('1') as { title: string; kind?: string; owner?: string } | undefined;
    expect(task).toBeDefined();
    expect(task?.title).toContain('Delegated to Gemini 2.5-pro:');
    expect(task?.kind).toBe('orchestration');
    expect(task?.owner).toBe('main/researcher');
  });

  it('skips routing metadata stamping when no taskStoreInternal is available', async () => {
    const onTaskRoutingMetadataUpdate = vi.fn();
    const ctx = makeCtx({
      onTaskRoutingMetadataUpdate,
      planSteps: [{
        id: 's1',
        sub_agents: [
          { task: 'Use researcher to inspect routing dispatch', model: unsafeAssertRoutingModelId('gpt-5.5') },
        ],
      }],
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect routing dispatch' }, ctx);

    expect(onTaskRoutingMetadataUpdate).not.toHaveBeenCalled();
  });
});

/**
 * Stage-3 resolver-gate-delta coverage. The planner-ASSIGNED sub-agent resolver
 * (`resolveAssignedSubAgentProfile`) applies the routing-pool gate
 * (routingEligible + connectivity), whereas the agent-OWN-model resolver
 * (`findSelectableProfileForModel`) intentionally does NOT — that delta is the
 * invariant being protected. Direct unit tests pin both gate sets so a future
 * "single resolver" flatten cannot pass silently.
 */
describe('resolveAssignedSubAgentProfile / findSelectableProfileForModel gate deltas', () => {
  it('assigned resolver matches an eligible profile', () => {
    const settings = makeSettingsWithProfile({ routingEligible: true });
    const profile = resolveAssignedSubAgentProfile(
      { settings,
        codexConnectivity: 'unknown',
      } as AgentToolContext,
      'gpt-5.5',
    );
    expect(profile?.id).toBe('local-gpt-55');
  });

  it('assigned resolver rejects a non-routing-eligible profile', () => {
    const settings = makeSettingsWithProfile({ routingEligible: false });
    const profile = resolveAssignedSubAgentProfile(
      { settings,
        codexConnectivity: 'unknown',
      } as AgentToolContext,
      'gpt-5.5',
    );
    expect(profile).toBeNull();
  });

  it('assigned resolver rejects a dead-connection profile but matches a live one', () => {
    const settings = makeSettingsWithProfile({
      providerType: 'openrouter',
      profileSource: 'connection',
      serverUrl: 'https://openrouter.ai/api/v1',
    });
    const dead = resolveAssignedSubAgentProfile(
      { settings, connectivity: { isProfileLive: () => false } } as unknown as AgentToolContext,
      'gpt-5.5',
    );
    expect(dead).toBeNull();
    const live = resolveAssignedSubAgentProfile(
      { settings, connectivity: { isProfileLive: () => true } } as unknown as AgentToolContext,
      'gpt-5.5',
    );
    expect(live?.id).toBe('local-gpt-55');
  });

  it('agent-own resolver IGNORES routingEligible (the protected gate delta)', () => {
    const settings = makeSettingsWithProfile({ routingEligible: false });
    // Same profile the assigned resolver REJECTS above is matched here, because
    // the agent's own configured model is NOT a routing-pool reference.
    const profile = findSelectableProfileForModel(settings, 'gpt-5.5');
    expect(profile?.id).toBe('local-gpt-55');
  });

  it('both resolvers support profile:<id> references', () => {
    const settings = makeSettingsWithProfile({ routingEligible: true });
    expect(findSelectableProfileForModel(settings, 'profile:local-gpt-55')?.id).toBe('local-gpt-55');
    expect(
      resolveAssignedSubAgentProfile({ settings,
        codexConnectivity: 'unknown',
      } as AgentToolContext, 'profile:local-gpt-55')?.id,
    ).toBe('local-gpt-55');
  });

  // Negative profile:<id> gate coverage (Stage 3 GPT review F1, folded into
  // Stage 4): the assigned-sub-agent resolver applies routingEligible +
  // connectivity gates even when the reference is resolved by profile id, and
  // the parent-routing-pool path does NOT accept profile:<id> at all.
  it('assigned profile:<id> reference rejects a non-routing-eligible profile', () => {
    const settings = makeSettingsWithProfile({ routingEligible: false });
    expect(
      resolveAssignedSubAgentProfile({ settings,
        codexConnectivity: 'unknown',
      } as AgentToolContext, 'profile:local-gpt-55'),
    ).toBeNull();
  });

  it('assigned profile:<id> reference rejects a dead-connection profile but matches a live one', () => {
    const settings = makeSettingsWithProfile({
      providerType: 'openrouter',
      profileSource: 'connection',
      serverUrl: 'https://openrouter.ai/api/v1',
    });
    expect(
      resolveAssignedSubAgentProfile(
        { settings, connectivity: { isProfileLive: () => false } } as unknown as AgentToolContext,
        'profile:local-gpt-55',
      ),
    ).toBeNull();
    expect(
      resolveAssignedSubAgentProfile(
        { settings, connectivity: { isProfileLive: () => true } } as unknown as AgentToolContext,
        'profile:local-gpt-55',
      )?.id,
    ).toBe('local-gpt-55');
  });

  it('parent/default routing-pool resolution does NOT accept profile:<id> references', () => {
    // findRoutingProfile (parent default/per-step + escalation metadata) is not
    // exported; assert the gate flags it passes to the shared chokepoint. The
    // routing-pool path matches by model string only (supportsProfileId off),
    // so a profile:<id> reference never resolves there even when the underlying
    // profile is fully eligible.
    const settings = makeSettingsWithProfile({ routingEligible: true });
    const pool = settings.localModel?.profiles ?? [];
    expect(
      resolveRoutingProfileRef('profile:local-gpt-55', { pool, requireRoutingEligible: true }),
    ).toBeNull();
    // sanity: the same profile resolves by its model string under that gate.
    expect(
      resolveRoutingProfileRef('gpt-5.5', { pool, requireRoutingEligible: true })?.id,
    ).toBe('local-gpt-55');
  });
});
