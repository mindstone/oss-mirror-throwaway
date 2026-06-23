import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
/**
 * F1 — Sub-agent suppression for prior-turns inspection tools.
 *
 * Verifies that `executeAgentTool()` filters `inspect_prior_turns` and
 * `get_tool_call` out of the sub-agent's tool list, AND propagates the
 * suppression union into nested sub-agent contexts so deeper-nested
 * sub-agents inherit it.
 *
 * Covers acceptance (e) of Stage 3 of
 * `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`:
 *
 *   - `agentDef.tools` omitted → both prior-turn tools excluded from the
 *     sub-agent's `tools` array.
 *   - `agentDef.tools` explicitly listing every builtin → both prior-turn
 *     tools STILL excluded (filter happens before allowlist selection).
 *   - Nested sub-agent: parent's existing `suppressedBuiltins` is preserved
 *     in the union, and the propagated `AgentToolContext.suppressedBuiltins`
 *     carried into deeper-nested sub-agents includes both prior-turn names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { AgentToolContext } from '../types';
import type { ToolDefinition } from '../modelTypes';

const {
  mockRunAgentLoop,
  mockGetBuiltinToolDefinitions,
} = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
  mockGetBuiltinToolDefinitions: vi.fn(),
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
  getBuiltinToolDefinitions: mockGetBuiltinToolDefinitions,
  isBuiltinToolName: vi.fn((name: string) =>
    ['Read', 'WebFetch', 'inspect_prior_turns', 'get_tool_call'].includes(name),
  ),
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
  resolveThinkingConfig: vi.fn().mockReturnValue({ type: 'disabled' }),
  resolveEffortForApi: vi.fn().mockReturnValue(undefined),
  resolveModelLimits: vi.fn().mockReturnValue({ contextWindow: 200_000, maxOutputTokens: 64_000 }),
}));

vi.mock('../clientFactory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clientFactory')>();
  return {
    ...actual,
    createClientFromRoutePlan: vi.fn().mockReturnValue({}),
  };
});

import { executeAgentTool } from '../agentTool';

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    input_schema: { type: 'object', properties: {} },
  };
}

function makeSettings(): AppSettings {
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
    experimental: {},
  } as unknown as AppSettings;
}

function makeCtx(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    agents: {
      researcher: {
        description: 'Researches information',
        prompt: 'You are a research sub-agent.',
        model: 'inherit',
      },
      nested: {
        description: 'Nested-delegation sub-agent',
        prompt: 'You are a nested sub-agent.',
        model: 'inherit',
      },
    },
    client: {} as AgentToolContext['client'],
    settings: makeSettings(),
    parentModel: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
    parentMaxTokens: 4096,
    parentEffort: 'low',
    depth: 0,
    surfaceCapability: 'cloud',
    wasExplicitCouncilIntent: true,
    turnId: 'turn-prior-turns-suppression-test',
    ...overrides,
    codexConnectivity: 'unknown',
  };
}

describe('executeAgentTool — F1 prior-turns suppression', () => {
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockGetBuiltinToolDefinitions.mockReset();
    mockGetBuiltinToolDefinitions.mockReturnValue([
      tool('Read'),
      tool('WebFetch'),
      tool('inspect_prior_turns'),
      tool('get_tool_call'),
    ]);
    mockRunAgentLoop.mockResolvedValue({
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      turns: 1,
      messageHistory: [],
    });
  });

  it("excludes prior-turn tools when agentDef.tools is omitted (sub-agent inherits all builtins)", async () => {
    const ctx = makeCtx();
    expect(ctx.agents.researcher.tools).toBeUndefined();

    await executeAgentTool({ agent: 'researcher', prompt: 'inspect things' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    const config = mockRunAgentLoop.mock.calls[0][0] as { tools: ToolDefinition[] };
    const toolNames = config.tools.map((t) => t.name);
    expect(toolNames).not.toContain('inspect_prior_turns');
    expect(toolNames).not.toContain('get_tool_call');
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('WebFetch');
  });

  it("excludes prior-turn tools even when agentDef.tools explicitly lists every builtin", async () => {
    const ctx = makeCtx({
      agents: {
        researcher: {
          description: 'Researches information',
          prompt: 'You are a research sub-agent.',
          model: 'inherit',
          tools: [
            'Read',
            'WebFetch',
            'inspect_prior_turns',
            'get_tool_call',
          ],
        },
      },
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'inspect things' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    const config = mockRunAgentLoop.mock.calls[0][0] as { tools: ToolDefinition[] };
    const toolNames = config.tools.map((t) => t.name);
    expect(toolNames).not.toContain('inspect_prior_turns');
    expect(toolNames).not.toContain('get_tool_call');
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('WebFetch');
  });

  it("propagates suppression into nested sub-agent context (parent's suppressedBuiltins ∪ prior-turn tools)", async () => {
    const ctx = makeCtx({ suppressedBuiltins: ['WebFetch'] });

    type ToolExec = (
      name: string,
      input: unknown,
      id: string,
      signal: AbortSignal,
    ) => Promise<unknown>;
    mockRunAgentLoop.mockImplementationOnce(
      async (_config: unknown, toolExecutor: ToolExec) => {
        const signal = new AbortController().signal;
        // The nested-Agent invocation routes back into executeAgentTool
        // with a child AgentToolContext built from the parent's
        // suppression union. Its effect surfaces on the SECOND
        // runAgentLoop call below.
        await toolExecutor(
          'Agent',
          { agent: 'nested', prompt: 'nested work' },
          'sub-1',
          signal,
        );
        return {
          totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
          turns: 1,
          messageHistory: [],
        };
      },
    );

    mockRunAgentLoop.mockImplementationOnce(async () => ({
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      turns: 1,
      messageHistory: [],
    }));

    await executeAgentTool({ agent: 'researcher', prompt: 'top-level' }, ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(2);
    const nestedConfig = mockRunAgentLoop.mock.calls[1][0] as { tools: ToolDefinition[] };
    const nestedToolNames = nestedConfig.tools.map((t) => t.name);
    expect(nestedToolNames).not.toContain('inspect_prior_turns');
    expect(nestedToolNames).not.toContain('get_tool_call');
    // The parent's existing suppression of WebFetch must also be inherited
    // by the nested sub-agent (the union: ctx.suppressedBuiltins ∪
    // SUBAGENT_SUPPRESSED_PRIOR_TURN_BUILTINS).
    expect(nestedToolNames).not.toContain('WebFetch');
    // Other builtins still flow through.
    expect(nestedToolNames).toContain('Read');
  });
});
