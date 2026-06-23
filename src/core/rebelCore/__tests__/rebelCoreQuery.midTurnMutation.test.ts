 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { EventHandler, ExecuteToolFn, RebelCoreConfig, RebelCoreEvent, TokenUsage } from '../types';
import type { ModelClient } from '../modelClient';

const WORKING_MODEL = 'claude-sonnet-4-20250514';
const PLANNING_MODEL = 'claude-opus-4-7';
const ELIGIBLE_MODEL_A = 'claude-haiku-4-20250414';
const ELIGIBLE_MODEL_B = 'claude-opus-4-20250514';

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
const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

let emittedEvents: RebelCoreEvent[] = [];

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    error: loggerMocks.error,
    debug: loggerMocks.debug,
  }),
}));

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

vi.mock('../clientFactory', () => ({
  createClientForModel: (...args: unknown[]) => mockCreateClientForModel(...args),
}));

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
const routedClient = { capabilities: {}, stream: vi.fn(), create: vi.fn() } as unknown as ModelClient;

type RoutingContext = {
  eligibleProfiles: Array<{ id: string; model: string }>;
  workingModel: string;
};

function makeSettings(args: {
  profiles?: Array<{ id: string; model: string; routingEligible?: boolean; councilEnabled?: boolean; enabled?: boolean }>;
  workingProfileId?: string | null;
  activeProfileId?: string | null;
} = {}): AppSettings {
  const { profiles = [], workingProfileId, activeProfileId = null } = args;
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
      workingProfileId,
    },
    experimental: {
      adaptiveRoutingEnabled: true,
    },
    localModel: {
      activeProfileId,
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: `Profile ${profile.id}`,
        model: profile.model,
        providerType: 'anthropic',
        routingEligible: profile.routingEligible ?? true,
        councilEnabled: profile.councilEnabled ?? false,
        enabled: profile.enabled ?? true,
        maxOutputTokens: 12_000,
        contextWindow: 200_000,
        createdAt: Date.now(),
      })),
    },
  } as unknown as AppSettings;
}

function makeContext(settings: AppSettings) {
  return {
    settings,
    cwd: '/tmp',
    executionClient,
    planningClient,
  };
}

function makeParams(env: Record<string, string> = {
  PLANNING_MODEL,
  EXECUTION_MODEL: WORKING_MODEL,
}) {
  return {
    prompt: 'Do the work',
    model: 'planner',
    cwd: '/tmp',
    systemPrompt: 'System prompt',
    permissionMode: 'default',
    env,
  };
}

function planFor(model: string) {
  return {
    planText: JSON.stringify({
      goal: 'Plan',
      steps: [{ id: 's1', description: 'Do', parallel_group: null }],
      done_criteria: ['Done'],
      routing: {
        default_model: model,
        default_effort: 'low',
        escalation: null,
        rationale: 'Use the model selected at planning start.',
      },
    }),
    document: {
      goal: 'Plan',
      steps: [{ id: 's1', description: 'Do', parallel_group: null }],
      done_criteria: ['Done'],
    },
    routing: {
      default_model: model,
      default_effort: 'low',
      rationale: 'Use the model selected at planning start.',
    },
    usage: ZERO_USAGE,
    stopReason: 'end_turn',
    model: PLANNING_MODEL,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function drainTurn(settings: AppSettings, params = makeParams()): Promise<void> {
  for await (const _message of rebelCoreQuery(params, makeContext(settings))) {
    // Drain the async generator.
  }
}

function mutateProfile(
  settings: AppSettings,
  profileId: string,
  mutate: (profile: NonNullable<AppSettings['localModel']>['profiles'][number]) => void,
): void {
  const profile = settings.localModel?.profiles?.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error(`Missing profile ${profileId}`);
  mutate(profile);
}

async function runDeferredPlanningTurn(args: {
  settings: AppSettings;
  mutate: () => void;
  planModel: string;
  params?: ReturnType<typeof makeParams>;
}): Promise<{ routingContext: RoutingContext | undefined }> {
  const plan = createDeferred<ReturnType<typeof planFor>>();
  let routingContext: RoutingContext | undefined;
  let planningStarted!: () => void;
  const planningStartedPromise = new Promise<void>((resolve) => {
    planningStarted = resolve;
  });

  mockRunPlanningPhase.mockImplementationOnce((options: { routingContext?: RoutingContext }) => {
    routingContext = options.routingContext;
    planningStarted();
    return plan.promise;
  });

  const drain = drainTurn(args.settings, args.params);
  await planningStartedPromise;
  args.mutate();
  plan.resolve(planFor(args.planModel));
  await drain;

  return { routingContext };
}

function expectRoutedExecution(model: string): void {
  expect(mockCreateClientForModel).toHaveBeenCalledWith(
    expect.objectContaining({ model }),
  );
  expect(mockRunAgentLoop.mock.calls.map(([config]) => (config as RebelCoreConfig).model))
    .toContain(model);
}

function getPlanningSnapshotLog(): Record<string, unknown> {
  const call = loggerMocks.info.mock.calls.find(([, message]) => message === 'Planning start: settings snapshot');
  if (!call) throw new Error('Missing planning-start settings snapshot log');
  return call[0] as Record<string, unknown>;
}

describe('rebelCoreQuery mid-turn settings mutation safety (Stage 9)', () => {
  beforeEach(() => {
    emittedEvents = [];
    vi.clearAllMocks();
    mockCreateClientForModel.mockReturnValue(routedClient);
    mockResolveModelLimits.mockReturnValue({ contextWindow: 200_000, maxOutputTokens: 12_000 });
    mockResolveThinkingConfig.mockReturnValue({ type: 'disabled' });
    mockResolveEffortForApi.mockReturnValue('low');
    mockRunAgentLoop.mockImplementation(async (
      _config: RebelCoreConfig,
      _toolExecutor: ExecuteToolFn,
      _emitEvent: EventHandler,
    ) => ({
      totalUsage: ZERO_USAGE,
      turns: 1,
      messageHistory: [{ role: 'user' as const, content: 'Do the work' }],
    }));
  });

  it('keeps the in-flight turn on its planning-start routing pool when routingEligible flips true to false in place', async () => {
    const settings = makeSettings({
      profiles: [
        { id: 'a', model: ELIGIBLE_MODEL_A, routingEligible: true, councilEnabled: true },
        { id: 'b', model: ELIGIBLE_MODEL_B, routingEligible: true },
      ],
    });

    const { routingContext } = await runDeferredPlanningTurn({
      settings,
      planModel: ELIGIBLE_MODEL_A,
      mutate: () => mutateProfile(settings, 'a', (profile) => {
        profile.routingEligible = false;
      }),
    });

    expect(routingContext?.eligibleProfiles.map((profile) => profile.id)).toEqual([
      'a',
      'b',
      '__working__',
    ]);
    expect(settings.localModel?.profiles?.find((profile) => profile.id === 'a')?.routingEligible)
      .toBe(false);
    expectRoutedExecution(ELIGIBLE_MODEL_A);
  });

  it('does not pick up a newly routing-eligible profile when routingEligible flips false to true in place', async () => {
    const settings = makeSettings({
      profiles: [
        { id: 'a', model: ELIGIBLE_MODEL_A, routingEligible: false },
        { id: 'b', model: ELIGIBLE_MODEL_B, routingEligible: true },
      ],
    });

    const { routingContext } = await runDeferredPlanningTurn({
      settings,
      planModel: ELIGIBLE_MODEL_A,
      mutate: () => mutateProfile(settings, 'a', (profile) => {
        profile.routingEligible = true;
      }),
    });

    expect(routingContext?.eligibleProfiles.map((profile) => profile.id)).toEqual([
      'b',
      '__working__',
    ]);
    expect(settings.localModel?.profiles?.find((profile) => profile.id === 'a')?.routingEligible)
      .toBe(true);
    expect(mockCreateClientForModel).not.toHaveBeenCalledWith(
      expect.objectContaining({ model: ELIGIBLE_MODEL_A }),
    );
    expect(mockRunAgentLoop.mock.calls.map(([config]) => (config as RebelCoreConfig).model))
      .toContain(WORKING_MODEL);
  });

  it('keeps the planning-start Council snapshot when councilEnabled flips true to false in place', async () => {
    const settings = makeSettings({
      profiles: [
        { id: 'a', model: ELIGIBLE_MODEL_A, routingEligible: true, councilEnabled: true },
        { id: 'b', model: ELIGIBLE_MODEL_B, routingEligible: true },
      ],
    });

    await runDeferredPlanningTurn({
      settings,
      planModel: ELIGIBLE_MODEL_A,
      mutate: () => mutateProfile(settings, 'a', (profile) => {
        profile.councilEnabled = false;
      }),
    });

    expect(getPlanningSnapshotLog()).toMatchObject({ councilEnabledCount: 1 });
    expect(settings.localModel?.profiles?.find((profile) => profile.id === 'a')?.councilEnabled)
      .toBe(false);
    expectRoutedExecution(ELIGIBLE_MODEL_A);
  });

  it('keeps the planning-start enabled snapshot when enabled flips true to false in place', async () => {
    const settings = makeSettings({
      profiles: [
        { id: 'a', model: ELIGIBLE_MODEL_A, routingEligible: true, enabled: true },
        { id: 'b', model: ELIGIBLE_MODEL_B, routingEligible: true },
      ],
    });

    const { routingContext } = await runDeferredPlanningTurn({
      settings,
      planModel: ELIGIBLE_MODEL_A,
      mutate: () => mutateProfile(settings, 'a', (profile) => {
        profile.enabled = false;
      }),
    });

    expect(routingContext?.eligibleProfiles.map((profile) => profile.id)).toEqual([
      'a',
      'b',
      '__working__',
    ]);
    expect(getPlanningSnapshotLog()).toMatchObject({ profilesEnabledCount: 2 });
    expect(settings.localModel?.profiles?.find((profile) => profile.id === 'a')?.enabled)
      .toBe(false);
    expectRoutedExecution(ELIGIBLE_MODEL_A);
  });

  it('keeps the planning-start working model when workingProfileId changes in place', async () => {
    const settings = makeSettings({
      workingProfileId: 'a',
      profiles: [
        { id: 'a', model: ELIGIBLE_MODEL_A, routingEligible: true },
        { id: 'b', model: ELIGIBLE_MODEL_B, routingEligible: true },
      ],
    });

    const { routingContext } = await runDeferredPlanningTurn({
      settings,
      params: makeParams({ PLANNING_MODEL }),
      planModel: ELIGIBLE_MODEL_A,
      mutate: () => {
        if (settings.models) settings.models.workingProfileId = 'b';
        if (settings.models) settings.models.workingProfileId = 'b';
      },
    });

    expect(routingContext?.workingModel).toBe(ELIGIBLE_MODEL_A);
    expect(getPlanningSnapshotLog()).toMatchObject({ workingProfileId: 'a' });
    expect(settings.models?.workingProfileId).toBe('b');
    expect(mockRunAgentLoop.mock.calls.map(([config]) => (config as RebelCoreConfig).model))
      .toContain(ELIGIBLE_MODEL_A);
  });
});
