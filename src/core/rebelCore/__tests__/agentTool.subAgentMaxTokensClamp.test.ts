import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
/**
 * Sub-agent maxTokens clamping tests.
 *
 * Regression test for the Haiku-4.5 hiccup: when a parent on a high-output
 * model (e.g. GPT-5.5 / Opus 4.7 at 128K) delegates to a sub-agent on a
 * lower-output model (e.g. Haiku 4.5 at 64K), the sub-agent's max_tokens
 * MUST be clamped to the sub-model's own limit. Without the clamp, the
 * Anthropic API rejects the request with `400 invalid_request_error:
 * max_tokens: 128000 > 64000`.
 *
 * See agentTool.ts § "Clamp subMaxTokens to the sub-agent model's actual
 * maxOutputTokens".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentToolContext } from '../types';
import type { AppSettings } from '@shared/types';
import type { PlanningStep } from '../planningMode';

// ---- hoisted mocks ----
const { mockRunAgentLoop } = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
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

vi.mock('../clientFactory', () => ({
  createClientForModel: vi.fn().mockReturnValue({}),
  createClientFromRoutePlan: vi.fn().mockReturnValue({}),
  resolveTargetForModel: vi.fn().mockReturnValue({
    kind: 'anthropic-direct',
    model: unsafeAssertRoutingModelId('claude-haiku-4-5'),
    resolvedFrom: 'model-string',
  }),
  targetNeedsProxy: vi.fn().mockReturnValue(false),
}));

import { executeAgentTool } from '../agentTool';

function makeSettings(behindTheScenesModel?: string): AppSettings {
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
      authMethod: 'api-key' as const,
      model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
      permissionMode: 'plan' as const,
      executablePath: null,
      planMode: true,
      extendedContext: false,
      thinkingModel: undefined,
      workingProfileId: null,
      thinkingProfileId: null,
    },
    behindTheScenesModel,
    diagnostics: { enabled: false },
    localModel: { profiles: [], activeProfileId: null },
  } as unknown as AppSettings;
}

function makeCtx(
  parentMaxTokens: number,
  subAgentModel: string = 'haiku',
  behindTheScenesModel?: string,
): AgentToolContext {
  return {
    agents: {
      forager: {
        description: 'Cheap extractive triage',
        prompt: 'forager prompt',
        model: subAgentModel as 'haiku',
      },
    },
    client: {} as AgentToolContext['client'],
    settings: makeSettings(behindTheScenesModel),
    parentModel: unsafeAssertRoutingModelId('gpt-5.5'),
    parentMaxTokens,
    depth: 0,
    codexConnectivity: 'unknown',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunAgentLoop.mockResolvedValue({
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    turns: 1,
    messageHistory: [],
  });
});

describe('sub-agent maxTokens clamp', () => {
  it('clamps parent 128K to Haiku 4.5 64K limit (the original Haiku 4.5 hiccup)', async () => {
    const ctx = makeCtx(128_000, 'haiku', 'claude-haiku-4-5-20251001');

    await executeAgentTool({ agent: 'forager', prompt: 'find stuff' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    const config = mockRunAgentLoop.mock.calls[0][0] as { maxTokens: number; model: string };
    expect(config.model).toBe('claude-haiku-4-5-20251001');
    expect(config.maxTokens).toBe(64_000);
  });

  it('clamps parent 128K to older Haiku 4 16K limit', async () => {
    const ctx = makeCtx(128_000, 'haiku', 'claude-haiku-4-20250414');

    await executeAgentTool({ agent: 'forager', prompt: 'find stuff' }, ctx);

    const config = mockRunAgentLoop.mock.calls[0][0] as { maxTokens: number; model: string };
    expect(config.model).toBe('claude-haiku-4-20250414');
    expect(config.maxTokens).toBe(16_000);
  });

  it('does not clamp when parent maxTokens is at or below sub-model limit', async () => {
    // Haiku 4.5 cap is 64K; parent at 50K is below cap so the request passes through.
    const ctx = makeCtx(50_000, 'haiku', 'claude-haiku-4-5-20251001');

    await executeAgentTool({ agent: 'forager', prompt: 'find stuff' }, ctx);

    const config = mockRunAgentLoop.mock.calls[0][0] as { maxTokens: number };
    expect(config.maxTokens).toBe(50_000);
  });

  it('clamps when sub-agent uses an older Opus 4 (64K cap) and parent has 128K', async () => {
    const ctx = makeCtx(128_000, 'opus');
    ctx.settings.models!.thinkingModel = 'claude-opus-4-20250514';

    await executeAgentTool({ agent: 'forager', prompt: 'find stuff' }, ctx);

    const config = mockRunAgentLoop.mock.calls[0][0] as { maxTokens: number; model: string };
    expect(config.model).toBe('claude-opus-4-20250514');
    expect(config.maxTokens).toBe(64_000);
  });

  it('falls back to 32_768 when parent maxTokens is undefined and still clamps to lower sub-model cap', async () => {
    const ctx = makeCtx(0, 'haiku', 'claude-haiku-4-20250414');
    delete (ctx as { parentMaxTokens?: number }).parentMaxTokens;

    await executeAgentTool({ agent: 'forager', prompt: 'find stuff' }, ctx);

    const config = mockRunAgentLoop.mock.calls[0][0] as { maxTokens: number };
    // 32_768 fallback > 16_000 (older Haiku cap), so it's clamped down to 16K.
    expect(config.maxTokens).toBe(16_000);
  });

  it('clamps to an auto-learned profile cap when outputTokensSource is auto', async () => {
    const ctx = makeCtx(128_000, 'haiku', 'profile:fast-auto');
    ctx.settings.localModel = {
      activeProfileId: null,
      profiles: [
        {
          id: 'fast-auto',
          name: 'Fast auto',
          model: unsafeAssertRoutingModelId('claude-haiku-4-5-20251001'),
          providerType: 'anthropic',
          serverUrl: '',
          createdAt: 1,
          enabled: true,
          routingEligible: true,
          maxOutputTokens: 8_192,
          outputTokensSource: 'auto',
          outputTokensLearnedAt: 10_000,
          lastLearnedOutputTokens: 8_192,
        },
      ],
    } as AppSettings['localModel'];

    await executeAgentTool({ agent: 'forager', prompt: 'find stuff' }, ctx);

    const config = mockRunAgentLoop.mock.calls[0][0] as { maxTokens: number; model: string };
    expect(config.model).toBe('claude-haiku-4-5-20251001');
    expect(config.maxTokens).toBe(8_192);
  });

  it('falls back to DEFAULT_AUXILIARY_MODEL when no fast model is configured (legacy-settings recovery)', async () => {
    const ctx = makeCtx(128_000, 'haiku', '');
    const onSubAgentEvent = vi.fn();
    ctx.onSubAgentEvent = onSubAgentEvent;

    await executeAgentTool({ agent: 'forager', prompt: 'find stuff' }, ctx, 'toolu_fast');

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    const config = mockRunAgentLoop.mock.calls[0][0] as { maxTokens: number; model: string };
    expect(config.model).toBe('claude-haiku-4-5');
    expect(config.maxTokens).toBe(64_000);
    expect(onSubAgentEvent).not.toHaveBeenCalledWith(
      { type: 'status', message: 'agent:role-not-configured:fast' },
      'toolu_fast',
    );
  });
});

/**
 * Route-table (council + ad-hoc) regression coverage for the clamp.
 *
 * For these scopes the sub-agent carries TWO divergent model fields:
 *   - `model: 'working'` — the semantic alias, which resolves to the user's
 *     working model (GPT-5.5, 128K output here). This is the BODY model placeholder.
 *   - `routedModel: 'claude-haiku-4-5-20251001'` — the CONCRETE backend that
 *     actually runs (64K output), carried in the `x-routed-model` header.
 *
 * The original bug: the clamp resolved its limit against the alias-resolved
 * `model` (128K) instead of the concrete routed backend (64K), so
 * `max_tokens=128000` was sent to Haiku → API 400. The fix keys the clamp on
 * `routedModelForTransport` for route-table scopes.
 *
 * NOTE: on default route-table dispatch (no planner assignment matched)
 * `routeProfile` is null, so user-set profile output overrides are NOT applied —
 * only hard provider/registry caps gate the clamp. This is intentional for now
 * (Codex F4); these tests pin the registry-cap behavior.
 */
function makeRouteTableSettings(workingModel: string): AppSettings {
  const settings = makeSettings('claude-haiku-4-5-20251001');
  // The 'working' alias resolves the working role from settings.models.model.
  (settings.models as { model: string }).model = workingModel;
  // Route-table assignment matching is gated on this flag; the default ad-hoc
  // dispatch (no planSteps) does not need it, but the assigned-plan branch does.
  (settings as { experimental?: { adaptiveRoutingEnabled?: boolean } }).experimental = {
    adaptiveRoutingEnabled: true,
  };
  return settings;
}

function makeRouteTableCtx(args: {
  parentMaxTokens: number;
  workingModel: string;
  routingMode: 'ad-hoc' | 'council';
  routedModel: string;
  extraAgents?: AgentToolContext['agents'];
  planSteps?: PlanningStep[];
}): AgentToolContext {
  return {
    agents: {
      researcher: {
        description: 'Researches information',
        prompt: 'You are a research sub-agent.',
        model: 'working' as 'haiku',
        routingMode: args.routingMode,
        routedModel: args.routedModel,
      },
      ...(args.extraAgents ?? {}),
    },
    client: {} as AgentToolContext['client'],
    settings: makeRouteTableSettings(args.workingModel),
    parentModel: unsafeAssertRoutingModelId('gpt-5.5'),
    parentMaxTokens: args.parentMaxTokens,
    parentEffort: 'low',
    depth: 0,
    consumedAssignments: new Set<string>(),
    turnId: 'turn-clamp-route-table',
    codexConnectivity: 'unknown',
    ...(args.planSteps
      ? {
        planRouting: { default_model: 'gpt-5.5', default_effort: 'low' },
        planSteps: args.planSteps,
      }
      : {}),
  } as AgentToolContext;
}

describe('sub-agent maxTokens clamp — route-table scope (council + ad-hoc)', () => {
  it('ad-hoc: clamps to the CONCRETE routed backend cap (Haiku 64K), not the alias/parent (GPT-5.5 128K) — the routing bug', async () => {
    const ctx = makeRouteTableCtx({
      parentMaxTokens: 128_000,
      workingModel: 'gpt-5.5',
      routingMode: 'ad-hoc',
      routedModel: 'claude-haiku-4-5-20251001',
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'investigate routing dispatch' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    const config = mockRunAgentLoop.mock.calls[0][0] as { maxTokens: number; model: string };
    // THE assertion that fails on unfixed code (would be 128000, exceeding Haiku's
    // 64K hard cap → API 400). With the fix, clamped to the concrete backend cap.
    expect(config.maxTokens).toBe(64_000);
    // The body model stays the 'working' placeholder — we did NOT change the
    // body-model contract; the concrete backend rides in the x-routed-model header.
    expect(config.model).toBe('working');
    expect(config.model).not.toBe('claude-haiku-4-5-20251001');
  });

  it('council: clamps to the concrete routed backend cap (Haiku 64K) under a 128K parent', async () => {
    const ctx = makeRouteTableCtx({
      parentMaxTokens: 128_000,
      workingModel: 'gpt-5.5',
      routingMode: 'council',
      routedModel: 'claude-haiku-4-5-20251001',
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'weigh in on the question' }, ctx);

    const config = mockRunAgentLoop.mock.calls[0][0] as { maxTokens: number; model: string };
    expect(config.maxTokens).toBe(64_000);
    expect(config.model).toBe('working');
  });

  it('no over-clamp: a higher-cap concrete backend (Opus 4.8, 128K) under a lower-cap parent (64K) uses the parent value', async () => {
    // Parent (working = Haiku 4.5, 64K) is BELOW the concrete backend (Opus 4.8,
    // 128K). The clamp only LOWERS, so the parent's 64K passes through unchanged
    // even though the routed backend could emit more.
    const ctx = makeRouteTableCtx({
      parentMaxTokens: 64_000,
      workingModel: 'claude-haiku-4-5-20251001',
      routingMode: 'ad-hoc',
      routedModel: 'claude-opus-4-8-20260101',
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'investigate routing dispatch' }, ctx);

    const config = mockRunAgentLoop.mock.calls[0][0] as { maxTokens: number; model: string };
    expect(config.maxTokens).toBe(64_000);
    expect(config.model).toBe('working');
  });

  it('assigned-plan route-table branch: clamps to the assigned agent\'s concrete routedModel cap (Haiku 64K)', async () => {
    // The planner assigns a task to a generated route-table agent ('model-fast')
    // whose own routedModel is the concrete Haiku backend. The assigned-plan branch
    // (agentTool.ts ~1228-1245) sets BOTH routedModelForTransport AND `model` from
    // that agent's routedModel (no profile match), so on this branch `model` already
    // equals the concrete backend — the clamp would compute 64K with or without the
    // fix here. This case is coverage that the assigned-plan dispatch reaches the
    // clamp with the correct concrete cap (and that the fix's `routedModelForTransport
    // ?? model` is harmless here — both are Haiku); it is NOT the red→green guard.
    // The genuine bug (and red→green) lives on the DEFAULT ad-hoc/council path above,
    // where `model` is the 'working' alias and diverges from the concrete backend.
    const ctx = makeRouteTableCtx({
      parentMaxTokens: 128_000,
      workingModel: 'gpt-5.5',
      routingMode: 'ad-hoc',
      // The dispatching agent ('researcher') routes to GPT (128K) by default...
      routedModel: 'gpt-5.5',
      extraAgents: {
        // Generated route-table agents use the `model-` slug convention; the
        // assigned-plan branch canonicalizes the assignment to this slug and
        // adopts its concrete routedModel as routedModelForTransport.
        'model-fast': {
          description: 'Fast extractive helper',
          prompt: 'You are a fast helper.',
          model: 'working' as 'haiku',
          routingMode: 'ad-hoc',
          // ...but the matched assignment redirects to this agent's concrete backend.
          routedModel: 'claude-haiku-4-5-20251001',
        },
      },
      planSteps: [{
        id: 's1',
        sub_agents: [
          {
            task: 'Use researcher to investigate routing dispatch',
            model: 'model-fast' as unknown as ReturnType<typeof unsafeAssertRoutingModelId>,
          },
        ],
      }],
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'investigate routing dispatch' }, ctx);

    const config = mockRunAgentLoop.mock.calls[0][0] as { maxTokens: number; model: string };
    expect(config.maxTokens).toBe(64_000);
  });
});

/**
 * Reasoning-replay capability + capability-model fence (route-table scope).
 *
 * `supportsReasoningReplay` is a CLIENT-SIDE gate (passed as runAgentLoop's 4th
 * arg) that controls how aggressively old thinking blocks are stripped between
 * turns (50 turns retained for DeepSeek/DS4 vs 2). Unlike `thinking`/`effort`
 * (which the proxy drops + rebuilds on route-table dispatch, so they're inert on
 * the wire), this gate takes effect regardless of the proxy — so it MUST key on
 * the concrete routed backend, not the `'working'` alias.
 *
 * The fence test pins that `subApiEffort` (the wire effort + the UI effort badge)
 * INTENTIONALLY stays alias-keyed: it's inert on the wire and the alias is the
 * correct value to surface to the user. A future "consistency fix" that flips it
 * to the concrete backend would silently regress the effort badge.
 */
describe('sub-agent capability model — reasoning replay + effort fence (route-table)', () => {
  it('keys supportsReasoningReplay on the CONCRETE DeepSeek backend, not the non-DeepSeek alias (retention 50, not 2)', async () => {
    const ctx = makeRouteTableCtx({
      parentMaxTokens: 64_000,
      workingModel: 'gpt-5.5', // alias resolves to a non-DeepSeek model
      routingMode: 'ad-hoc',
      // Production shape: the OpenRouter/Mindstone DeepSeek backends are slash-prefixed
      // (`deepseek/deepseek-v4-flash` is the OR BTS default). A bare `deepseek-v4-*`
      // would have masked the predicate's `^deepseek-` gap.
      routedModel: 'deepseek/deepseek-v4-flash',
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'investigate routing dispatch' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    // 4th arg to runAgentLoop carries { supportsReasoningReplay }.
    const replayOpts = mockRunAgentLoop.mock.calls[0][3] as { supportsReasoningReplay: boolean };
    // FAILS on the alias-keyed code (computeSupportsReasoningReplay('working'→gpt-5.5)
    // → false → retention 2, stripping the DeepSeek backend's reasoning too early).
    expect(replayOpts.supportsReasoningReplay).toBe(true);
  });

  it('keys supportsReasoningReplay on the CONCRETE non-DeepSeek backend, not the DeepSeek alias (false, not over-retained)', async () => {
    const ctx = makeRouteTableCtx({
      parentMaxTokens: 64_000,
      workingModel: 'deepseek-v4-pro', // alias resolves to DeepSeek
      routingMode: 'ad-hoc',
      routedModel: 'claude-haiku-4-5-20251001', // concrete backend is NOT DeepSeek
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'investigate routing dispatch' }, ctx);

    const replayOpts = mockRunAgentLoop.mock.calls[0][3] as { supportsReasoningReplay: boolean };
    // FAILS on the alias-keyed code (alias DeepSeek → true → retention 50, keeping
    // reasoning a non-DeepSeek backend can't replay).
    expect(replayOpts.supportsReasoningReplay).toBe(false);
  });

  it('FENCE: subApiEffort stays alias-keyed — the wire effort reflects the requested working-tier effort, not the concrete backend', async () => {
    // working alias = GPT-5.5 (supports effort) routed to Haiku (does NOT support
    // effort). If subApiEffort were (wrongly) flipped to the concrete backend, the
    // effort would be dropped. It must stay derived from the alias.
    const ctx = makeRouteTableCtx({
      parentMaxTokens: 64_000,
      workingModel: 'gpt-5.5',
      routingMode: 'ad-hoc',
      routedModel: 'claude-haiku-4-5-20251001',
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'investigate routing dispatch' }, ctx);

    const config = mockRunAgentLoop.mock.calls[0][0] as { effort?: string };
    // parentEffort 'low' (makeRouteTableCtx) → resolveEffortForApi('low', gpt-5.5)='low'.
    // A flip to the concrete Haiku backend (no effort support) would drop it.
    expect(config.effort).toBe('low');
  });
});
