import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import type { EventHandler, ExecuteToolFn, RebelCoreConfig, RebelCoreEvent, TokenUsage } from '../types';
import type { ModelClient } from '../modelClient';
import type { RoutingDecision } from '../planningMode';

const WORKING_MODEL = 'claude-sonnet-4-20250514';
const PLANNING_MODEL = 'claude-opus-4-7';
const OVERRIDE_MODEL = 'gpt-5.5';
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
const MockConnectionNotConfiguredError = vi.hoisted(() =>
  class ConnectionNotConfiguredError extends Error {
    readonly __agentErrorKind = 'connection-not-configured';
  },
);

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

vi.mock('../clientFactory', () => ({
  ConnectionNotConfiguredError: MockConnectionNotConfiguredError,
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
import {
  createProfileConnectivity,
  type ProfileConnectivity,
} from '@shared/utils/connectivityHelpers';

const executionClient = { capabilities: {}, stream: vi.fn(), create: vi.fn() } as unknown as ModelClient;
const planningClient = { capabilities: {}, stream: vi.fn(), create: vi.fn() } as unknown as ModelClient;

function makeSettings(args: {
  adaptiveRoutingEnabled?: boolean;
  eligibleProfiles?: Array<Partial<ModelProfile> & { id: string; model: string }>;
} = {}): AppSettings {
  const { adaptiveRoutingEnabled = true, eligibleProfiles = [] } = args;
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
      profiles: eligibleProfiles.map(({ id, model, ...profile }) => ({
        name: `Profile ${id}`,
        providerType: 'anthropic',
        serverUrl: '',
        routingEligible: true,
        enabled: true,
        maxOutputTokens: 12_000,
        contextWindow: 200_000,
        createdAt: Date.now(),
        ...profile,
        id,
        model,
      })),
    },
  } as unknown as AppSettings;
}

function makeContext(args: {
  settings: AppSettings;
  executionModelOverride?: string;
  perConversationModelOverride?: boolean;
  connectivity?: ProfileConnectivity;
}) {
  return {
    settings: args.settings,
    cwd: '/tmp',
    executionClient,
    planningClient,
    ...(args.executionModelOverride !== undefined
      ? { executionModelOverride: unsafeAssertRoutingModelId(args.executionModelOverride) }
      : {}),
    ...(args.perConversationModelOverride !== undefined
      ? { perConversationModelOverride: args.perConversationModelOverride }
      : {}),
    ...(args.connectivity !== undefined
      ? { connectivity: args.connectivity }
      : {}),
  };
}

function makeParams() {
  return {
    prompt: 'Do the work',
    model: unsafeAssertRoutingModelId('planner'),
    cwd: '/tmp',
    systemPrompt: 'System prompt',
    permissionMode: 'default',
    env: {
      PLANNING_MODEL,
      EXECUTION_MODEL: WORKING_MODEL,
    },
  };
}

interface CapturedRoutingContext {
  routingContext: unknown;
}

async function drainTurnAndCaptureRouting(args: {
  settings: AppSettings;
  executionModelOverride?: string;
  perConversationModelOverride?: boolean;
  connectivity?: ProfileConnectivity;
  routing?: RoutingDecision;
}): Promise<CapturedRoutingContext> {
  const captured: CapturedRoutingContext = { routingContext: undefined };
  mockRunPlanningPhase.mockImplementation(async (options: { routingContext?: unknown }) => {
    captured.routingContext = options.routingContext;
    return {
      planText: JSON.stringify({
        goal: 'Plan',
        steps: [{ id: 's1', description: 'Do', parallel_group: null }],
        done_criteria: ['Done'],
      }),
      document: {
        goal: 'Plan',
        steps: [{ id: 's1', description: 'Do', parallel_group: null }],
        done_criteria: ['Done'],
        ...(args.routing ? { routing: args.routing } : {}),
      },
      routing: args.routing,
      usage: ZERO_USAGE,
      stopReason: 'end_turn',
      model: PLANNING_MODEL,
    };
  });
  mockRunAgentLoop.mockImplementation(async (
    _config: RebelCoreConfig,
    _toolExecutor: ExecuteToolFn,
    _emitEvent: EventHandler,
  ) => ({
    totalUsage: ZERO_USAGE,
    turns: 1,
    messageHistory: [{ role: 'user' as const, content: 'Do the work' }],
  }));

  for await (const _message of rebelCoreQuery(makeParams(), makeContext(args))) {
    // Drain the async generator.
  }

  return captured;
}

describe('rebelCoreQuery routing-eligible pool gate (Stage 8)', () => {
  beforeEach(() => {
    emittedEvents = [];
    vi.clearAllMocks();
    mockResolveModelLimits.mockReturnValue({ contextWindow: 200_000, maxOutputTokens: 12_000 });
    mockResolveThinkingConfig.mockReturnValue({ type: 'disabled' });
    mockResolveEffortForApi.mockReturnValue('low');
  });

  it('omits routingContext when perConversationModelOverride is true, even with adaptive routing on and eligible profiles', async () => {
    const settings = makeSettings({
      adaptiveRoutingEnabled: true,
      eligibleProfiles: [
        { id: 'a', model: ELIGIBLE_MODEL_A },
        { id: 'b', model: ELIGIBLE_MODEL_B },
      ],
    });

    const captured = await drainTurnAndCaptureRouting({
      settings,
      executionModelOverride: OVERRIDE_MODEL,
      perConversationModelOverride: true,
    });

    expect(captured.routingContext).toBeUndefined();
  });

  it('omits routingContext when perConversationModelOverride is true and adaptive routing is off', async () => {
    const settings = makeSettings({
      adaptiveRoutingEnabled: false,
      eligibleProfiles: [
        { id: 'a', model: ELIGIBLE_MODEL_A },
        { id: 'b', model: ELIGIBLE_MODEL_B },
      ],
    });

    const captured = await drainTurnAndCaptureRouting({
      settings,
      executionModelOverride: OVERRIDE_MODEL,
      perConversationModelOverride: true,
    });

    expect(captured.routingContext).toBeUndefined();
  });

  it('builds routingContext when no override is set, adaptive routing is on, and there are multiple eligible profiles', async () => {
    const settings = makeSettings({
      adaptiveRoutingEnabled: true,
      eligibleProfiles: [
        { id: 'a', model: ELIGIBLE_MODEL_A },
        { id: 'b', model: ELIGIBLE_MODEL_B },
      ],
    });

    const captured = await drainTurnAndCaptureRouting({ settings });

    expect(captured.routingContext).toBeDefined();
    const ctx = captured.routingContext as {
      eligibleProfiles: Array<{ model: string }>;
      workingModel: string;
    };
    expect(ctx.workingModel).toBe(WORKING_MODEL);
    const models = ctx.eligibleProfiles.map((profile) => profile.model);
    expect(models).toContain(ELIGIBLE_MODEL_A);
    expect(models).toContain(ELIGIBLE_MODEL_B);
  });

  it('builds routingContext for default working profile on a direct target — executionModelOverride set but perConversationModelOverride is false (regression for Stage 8 round 1 false-positive)', async () => {
    // The executor sets `executionModelOverride` whenever a direct (non-proxy) execution
    // client is injected — including for users on a default working profile. Smart picking
    // must NOT be disabled in that case; only an explicit per-conversation override
    // (perConversationModelOverride === true) should disable it.
    const settings = makeSettings({
      adaptiveRoutingEnabled: true,
      eligibleProfiles: [
        { id: 'a', model: ELIGIBLE_MODEL_A },
        { id: 'b', model: ELIGIBLE_MODEL_B },
      ],
    });

    const captured = await drainTurnAndCaptureRouting({
      settings,
      executionModelOverride: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
      perConversationModelOverride: false,
    });

    expect(captured.routingContext).toBeDefined();
    const ctx = captured.routingContext as {
      eligibleProfiles: Array<{ model: string }>;
      workingModel: string;
    };
    const models = ctx.eligibleProfiles.map((profile) => profile.model);
    expect(models).toContain(ELIGIBLE_MODEL_A);
    expect(models).toContain(ELIGIBLE_MODEL_B);
  });

  it('omits routingContext when no override, adaptive routing on, but only a single eligible profile (single-model pool)', async () => {
    const settings = makeSettings({
      adaptiveRoutingEnabled: true,
      eligibleProfiles: [{ id: 'a', model: WORKING_MODEL }],
    });

    const captured = await drainTurnAndCaptureRouting({ settings });

    expect(captured.routingContext).toBeUndefined();
  });

  it('omits routingContext when adaptive routing is off (regression — pre-Stage-8 behaviour preserved)', async () => {
    const settings = makeSettings({
      adaptiveRoutingEnabled: false,
      eligibleProfiles: [
        { id: 'a', model: ELIGIBLE_MODEL_A },
        { id: 'b', model: ELIGIBLE_MODEL_B },
      ],
    });

    const captured = await drainTurnAndCaptureRouting({ settings });

    expect(captured.routingContext).toBeUndefined();
  });

  it('excludes disconnected connection-managed profiles from adaptive routing candidates', async () => {
    const settings = makeSettings({
      adaptiveRoutingEnabled: true,
      eligibleProfiles: [
        {
          id: 'live',
          model: ELIGIBLE_MODEL_A,
          providerType: 'anthropic',
          profileSource: 'user',
        },
        {
          id: 'dead',
          model: ELIGIBLE_MODEL_B,
          providerType: 'openrouter',
          routeSurface: 'pool',
          profileSource: 'connection',
          serverUrl: 'https://openrouter.ai/api/v1',
        },
      ],
    });

    const captured = await drainTurnAndCaptureRouting({
      settings,
      connectivity: createProfileConnectivity({
        openRouterConnected: false,
        hasAnthropicAuth: true,
      }),
    });

    const ctx = captured.routingContext as {
      eligibleProfiles: Array<{ model: string }>;
    };
    const models = ctx.eligibleProfiles.map((profile) => profile.model);
    expect(models).toContain(ELIGIBLE_MODEL_A);
    expect(models).not.toContain(ELIGIBLE_MODEL_B);
  });

  it('keeps connection-managed profiles when connectivity context is absent', async () => {
    const settings = makeSettings({
      adaptiveRoutingEnabled: true,
      eligibleProfiles: [
        { id: 'user', model: ELIGIBLE_MODEL_A },
        {
          id: 'connection',
          model: ELIGIBLE_MODEL_B,
          providerType: 'openrouter',
          routeSurface: 'pool',
          profileSource: 'connection',
          serverUrl: 'https://openrouter.ai/api/v1',
        },
      ],
    });

    const captured = await drainTurnAndCaptureRouting({ settings });

    const ctx = captured.routingContext as {
      eligibleProfiles: Array<{ model: string }>;
    };
    const models = ctx.eligibleProfiles.map((profile) => profile.model);
    expect(models).toContain(ELIGIBLE_MODEL_A);
    expect(models).toContain(ELIGIBLE_MODEL_B);
  });

  it('omits routingContext gracefully when all adaptive candidates are disconnected', async () => {
    const settings = makeSettings({
      adaptiveRoutingEnabled: true,
      eligibleProfiles: [
        {
          id: 'dead-openrouter',
          model: ELIGIBLE_MODEL_A,
          providerType: 'openrouter',
          routeSurface: 'pool',
          profileSource: 'connection',
          serverUrl: 'https://openrouter.ai/api/v1',
        },
        {
          id: 'dead-codex',
          model: ELIGIBLE_MODEL_B,
          providerType: 'openai',
          routeSurface: 'subscription',
          authSource: 'codex-subscription',
          profileSource: 'connection',
          serverUrl: 'https://api.openai.com/v1',
        },
      ],
    });

    const captured = await drainTurnAndCaptureRouting({
      settings,
      connectivity: createProfileConnectivity({
        openRouterConnected: false,
        codexConnected: false,
      }),
    });

    expect(captured.routingContext).toBeUndefined();
  });

  it('passes the selected routed profile into initial adaptive dispatch instead of relying on model-string lookup', async () => {
    const disconnectedDuplicate: Partial<ModelProfile> & { id: string; model: string } = {
      id: 'dead-openrouter-gpt55',
      name: 'Disconnected OpenRouter GPT 5.5',
      model: unsafeAssertRoutingModelId('gpt-5.5'),
      providerType: 'openrouter',
      routeSurface: 'pool',
      profileSource: 'connection',
      serverUrl: 'https://openrouter.ai/api/v1',
    };
    const liveDuplicate: Partial<ModelProfile> & { id: string; model: string } = {
      id: 'live-openai-gpt55',
      name: 'Live OpenAI GPT 5.5',
      model: unsafeAssertRoutingModelId('gpt-5.5'),
      providerType: 'openai',
      routeSurface: 'api-key',
      profileSource: 'user',
      serverUrl: 'https://api.openai.com/v1',
      apiKey: 'fake-openai-key',
    };
    const settings = makeSettings({
      adaptiveRoutingEnabled: true,
      eligibleProfiles: [disconnectedDuplicate, liveDuplicate],
    });
    mockCreateClientForModel.mockReturnValue(executionClient);

    await drainTurnAndCaptureRouting({
      settings,
      connectivity: createProfileConnectivity({
        openRouterConnected: false,
        hasOpenAiAuth: true,
        hasAnthropicAuth: true,
      }),
      routing: {
        default_model: 'gpt-5.5',
      },
    });

    expect(mockCreateClientForModel).toHaveBeenCalledWith(expect.objectContaining({
      model: unsafeAssertRoutingModelId('gpt-5.5'),
      profile: expect.objectContaining({ id: 'live-openai-gpt55' }),
      context: 'routed-execution',
    }));
    expect(mockCreateClientForModel).not.toHaveBeenCalledWith(expect.objectContaining({
      model: unsafeAssertRoutingModelId('gpt-5.5'),
      profile: expect.objectContaining({ id: 'dead-openrouter-gpt55' }),
      context: 'routed-execution',
    }));
  });

  it('routeRef: a profile:<id> default_model disambiguates two live profiles that share a model id', async () => {
    // Both profiles are selectable, routing-eligible, and connected, AND share the model id
    // `gpt-5.5` — so the legacy bare-model resolver would pick the first match (`oai-a`).
    const dupA: Partial<ModelProfile> & { id: string; model: string } = {
      id: 'oai-a',
      name: 'OpenAI A',
      model: unsafeAssertRoutingModelId('gpt-5.5'),
      providerType: 'openai',
      routeSurface: 'api-key',
      profileSource: 'user',
      serverUrl: 'https://api.openai.com/v1',
      apiKey: 'fake-openai-key',
    };
    const dupB: Partial<ModelProfile> & { id: string; model: string } = {
      id: 'oai-b',
      name: 'OpenAI B',
      model: unsafeAssertRoutingModelId('gpt-5.5'),
      providerType: 'openai',
      routeSurface: 'api-key',
      profileSource: 'user',
      serverUrl: 'https://api.openai.com/v1',
      apiKey: 'fake-openai-key',
    };
    const settings = makeSettings({ adaptiveRoutingEnabled: true, eligibleProfiles: [dupA, dupB] });
    mockCreateClientForModel.mockReturnValue(executionClient);

    await drainTurnAndCaptureRouting({
      settings,
      connectivity: createProfileConnectivity({
        openRouterConnected: false,
        hasOpenAiAuth: true,
        hasAnthropicAuth: true,
      }),
      routing: {
        // Provider-bound reference, NOT a bare model id — must resolve to oai-b exactly.
        default_model: 'profile:oai-b',
      },
    });

    expect(mockCreateClientForModel).toHaveBeenCalledWith(expect.objectContaining({
      model: unsafeAssertRoutingModelId('gpt-5.5'),
      profile: expect.objectContaining({ id: 'oai-b' }),
      context: 'routed-execution',
    }));
    // The first-match profile (oai-a) must NOT be the one dispatched — routeRef beat first-match.
    expect(mockCreateClientForModel).not.toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({ id: 'oai-a' }),
      context: 'routed-execution',
    }));
  });

  it('routeRef: a profile:<id> route switches provider even when its model id equals the WORKING model (same-model cross-provider switch)', async () => {
    // The core motivating case: the user is working on `gpt-5.5` (say, via OpenAI), and the
    // planner routes to `profile:or-b` — a DIFFERENT provider (OpenRouter) that also exposes
    // `gpt-5.5`. A model-string-only gate would treat this as "already on gpt-5.5, stay put"
    // and never switch provider. routeRef must build a client for the explicitly-named profile.
    const orDuplicate: Partial<ModelProfile> & { id: string; model: string } = {
      id: 'or-b',
      name: 'OpenRouter B',
      model: unsafeAssertRoutingModelId('gpt-5.5'),
      providerType: 'openrouter',
      routeSurface: 'pool',
      profileSource: 'connection',
      serverUrl: 'https://openrouter.ai/api/v1',
    };
    const settings = makeSettings({ adaptiveRoutingEnabled: true, eligibleProfiles: [orDuplicate] });
    mockCreateClientForModel.mockReturnValue(executionClient);

    await drainTurnAndCaptureRouting({
      settings,
      // Working model IS gpt-5.5 — same model string the route ref resolves to.
      executionModelOverride: 'gpt-5.5',
      connectivity: createProfileConnectivity({
        openRouterConnected: true,
        hasOpenAiAuth: true,
        hasAnthropicAuth: true,
      }),
      routing: { default_model: 'profile:or-b' },
    });

    // Must build a fresh client for the OpenRouter profile despite the matching model id.
    expect(mockCreateClientForModel).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({ id: 'or-b' }),
      context: 'routed-execution',
    }));
  });
});

describe('rebelCoreQuery planning-client error classification (FIX-2)', () => {
  beforeEach(() => {
    emittedEvents = [];
    vi.clearAllMocks();
    mockResolveModelLimits.mockReturnValue({ contextWindow: 200_000, maxOutputTokens: 12_000 });
    mockResolveThinkingConfig.mockReturnValue({ type: 'disabled' });
    mockResolveEffortForApi.mockReturnValue('low');
  });

  // Build a context that injects ONLY the execution client (NOT a planning client), so plan mode
  // takes the internal `createClientForModel({ context: 'planning' })` branch in rebelCoreQuery —
  // the path whose catch previously re-wrapped every failure as ModelError('auth').
  function makePlanningOnlyContext(settings: AppSettings) {
    return {
      settings,
      cwd: '/tmp',
      executionClient,
      // planningClient intentionally omitted to exercise internal planning-client creation.
    };
  }

  async function drain(settings: AppSettings): Promise<void> {
    for await (const _message of rebelCoreQuery(makeParams(), makePlanningOnlyContext(settings))) {
      // Drain the async generator (the throw happens before the first yield).
    }
  }

  it('rethrows a routing-classified planning-client failure intact (NOT re-wrapped as auth)', async () => {
    const settings = makeSettings();
    // Simulate a routing reject from the route layer (e.g. proxy-dialect-in-direct-anthropic),
    // branded the way clientFactory throws it.
    const routingError = Object.assign(
      new Error('Route plan is terminal: proxy-dialect-in-direct-anthropic'),
      { __agentErrorKind: 'routing', __routingCause: 'proxy-dialect-in-direct-anthropic' },
    );
    mockCreateClientForModel.mockRejectedValue(routingError);

    await expect(drain(settings)).rejects.toMatchObject({
      __agentErrorKind: 'routing',
      __routingCause: 'proxy-dialect-in-direct-anthropic',
      message: 'Route plan is terminal: proxy-dialect-in-direct-anthropic',
    });
    // It must be the original error, NOT a ModelError('auth') re-wrap.
    await expect(drain(settings)).rejects.not.toMatchObject({ kind: 'auth' });
  });

  it('rethrows a non-routing branded planning-client failure intact (NOT re-wrapped as auth)', async () => {
    const settings = makeSettings();
    const connectionError = new MockConnectionNotConfiguredError('Reconnect Anthropic to use this model');
    mockCreateClientForModel.mockRejectedValue(connectionError);

    try {
      await drain(settings);
      throw new Error('Expected planning-client creation to throw');
    } catch (caught) {
      expect(caught).toBe(connectionError);
      expect(caught).toMatchObject({
        __agentErrorKind: 'connection-not-configured',
        message: 'Reconnect Anthropic to use this model',
      });
    }
  });

  it('still classifies a genuine unclassified planning-client failure as auth (regression)', async () => {
    const settings = makeSettings();
    mockCreateClientForModel.mockRejectedValue(new Error('boom: no api key'));

    await expect(drain(settings)).rejects.toMatchObject({
      kind: 'auth',
    });
  });
});
