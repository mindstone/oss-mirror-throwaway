import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
/**
 * Sub-Agent Prompt Caching Structure Tests
 *
 * Verifies that the sub-agent system prompt is structured as a TextBlock[]
 * with an explicit cache_control breakpoint on the stable agent definition prompt,
 * and that dynamic parts (additionalContext, missionBriefing, summarize) are
 * in a separate block without cache_control.
 *
 * See: docs/plans/260327_sub_agent_prompt_caching.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SystemPrompt, TextBlock } from '../modelTypes';

// ---- hoisted mocks ----
const { mockRunAgentLoop, mockRunSubagentStartHooks } = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
  mockRunSubagentStartHooks: vi.fn(),
}));

vi.mock('../agentLoop', () => ({
  runAgentLoop: mockRunAgentLoop,
}));

vi.mock('../hookPipeline', () => ({
  runSubagentStartHooks: mockRunSubagentStartHooks,
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
  resolveThinkingConfig: vi.fn().mockReturnValue({ type: 'disabled' }),
  resolveEffortForApi: vi.fn().mockReturnValue(undefined),
  resolveModelLimits: vi.fn().mockReturnValue({ contextWindow: 200_000, maxOutputTokens: 64_000 }),
}));

vi.mock('../clientFactory', () => ({
  createClientForModel: vi.fn().mockReturnValue({}),
  createClientFromRoutePlan: vi.fn().mockReturnValue({}),
  resolveTargetForModel: vi.fn().mockReturnValue({ kind: 'anthropic-direct', model: unsafeAssertRoutingModelId('claude-haiku-4-20250414'), resolvedFrom: 'model-string' }),
  targetNeedsProxy: vi.fn().mockReturnValue(false),
}));

// Import after mocks
import { executeAgentTool } from '../agentTool';
import type { AgentToolContext } from '../types';
import type { AppSettings } from '@shared/types';

// ---- helpers ----

function makeMinimalSettings(): AppSettings {
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
      behindTheScenesModel: undefined,
    },
    diagnostics: { enabled: false },
    localModel: { profiles: [], activeProfileId: null },
  } as unknown as AppSettings;
}

function makeCtx(overrides: {
  agentPrompt?: string;
  additionalContext?: string;
  withHooks?: boolean;
} = {}): AgentToolContext {
  return {
    agents: {
      reviewer: {
        description: 'Reviews code',
        prompt: overrides.agentPrompt ?? 'You are a code reviewer.\nFollow best practices.',
      },
    },
    client: {} as any,
    settings: makeMinimalSettings(),
    parentModel: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
    depth: 0,
    ...(overrides.withHooks ? {
      hooks: { SubagentStart: [{ hooks: [vi.fn()] }] },
      hookContext: {} as any,
    } : {}),
    codexConnectivity: 'unknown',
  };
}

/** Extract the systemPrompt from the first call to runAgentLoop */
function getCapturedSystemPrompt(): SystemPrompt {
  expect(mockRunAgentLoop).toHaveBeenCalled();
  const config = mockRunAgentLoop.mock.calls[0][0];
  return config.systemPrompt;
}

describe('Sub-agent system prompt caching structure', () => {
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockRunSubagentStartHooks.mockReset();
    // runAgentLoop resolves cleanly (sub-agent completes with no output)
    mockRunAgentLoop.mockResolvedValue(undefined);
    mockRunSubagentStartHooks.mockResolvedValue(undefined);
  });

  it('produces a TextBlock[] with cache_control on the first block', async () => {
    const ctx = makeCtx({ agentPrompt: 'You are a code reviewer.\nFollow best practices.' });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this code' }, ctx);

    const systemPrompt = getCapturedSystemPrompt();
    expect(Array.isArray(systemPrompt)).toBe(true);

    const blocks = systemPrompt as TextBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('puts dynamic parts (additionalContext, summarize instruction) in the second block without cache_control', async () => {
    mockRunSubagentStartHooks.mockResolvedValue('Here are your frequent tools: ...');
    const ctx = makeCtx({ withHooks: true });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this code' }, ctx);

    const systemPrompt = getCapturedSystemPrompt();
    const blocks = systemPrompt as TextBlock[];

    // Block 1: stable agent prompt only (no additionalContext)
    expect(blocks[0].text).toContain('You are a code reviewer.');
    expect(blocks[0].text).not.toContain('frequent tools');

    // Block 2: dynamic parts (additionalContext + summarize)
    expect(blocks[1].type).toBe('text');
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[1].text).toContain('Here are your frequent tools: ...');
    expect(blocks[1].text).toContain('Before completing your work, call the SummarizeResult tool');
  });

  it('falls back to plain string when agentDef.prompt is empty', async () => {
    const ctx = makeCtx({ agentPrompt: '' });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this code' }, ctx);

    const systemPrompt = getCapturedSystemPrompt();
    expect(typeof systemPrompt).toBe('string');
    expect(systemPrompt as string).toContain('Before completing your work, call the SummarizeResult tool');
  });

  it('preserves semantic content parity with old string concatenation format', async () => {
    const agentPrompt = 'You are a code reviewer.\nFollow best practices.';
    mockRunSubagentStartHooks.mockResolvedValue('Additional context here.');
    const ctx = makeCtx({ agentPrompt, withHooks: true });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this code' }, ctx);

    const systemPrompt = getCapturedSystemPrompt();
    const blocks = systemPrompt as TextBlock[];

    // Reconstruct the full text as OpenAI translators would: join blocks with '\n'
    const joinedText = blocks.map((b) => b.text).join('\n');

    // The old format was: agentDef.prompt + \n\n + additionalContext + \n\n + summarize
    // Block 1 ends with \n, joiner adds \n, so we get \n\n between blocks
    expect(joinedText).toContain(agentPrompt);
    expect(joinedText).toContain('Additional context here.');
    expect(joinedText).toContain('Before completing your work, call the SummarizeResult tool');

    // Verify the \n\n separator is preserved between stable and dynamic parts
    expect(joinedText).toContain(`${agentPrompt}\n\nAdditional context here.`);
  });

  it('first block text ends with \\n for OpenAI separator preservation', async () => {
    const agentPrompt = 'You are a code reviewer.';
    const ctx = makeCtx({ agentPrompt });

    await executeAgentTool({ agent: 'reviewer', prompt: 'Review this code' }, ctx);

    const systemPrompt = getCapturedSystemPrompt();
    const blocks = systemPrompt as TextBlock[];

    // Block 1 must end with \n so .join('\n') produces \n\n between blocks
    expect(blocks[0].text.endsWith('\n')).toBe(true);
  });
});
