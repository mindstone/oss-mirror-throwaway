import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { SystemPrompt, TextBlock, ToolDefinition } from '../modelTypes';
import type { AgentToolContext } from '../types';
import type { PlanningStep } from '../planningMode';

const {
  mockRunAgentLoop,
  mockRunSubagentStartHooks,
  mockRunSubagentStopHooks,
  mockGetBuiltinToolDefinitions,
} = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
  mockRunSubagentStartHooks: vi.fn(),
  mockRunSubagentStopHooks: vi.fn(),
  mockGetBuiltinToolDefinitions: vi.fn(),
}));

 
vi.mock('../agentLoop', () => ({
  runAgentLoop: mockRunAgentLoop,
}));

 
vi.mock('../hookPipeline', () => ({
  runSubagentStartHooks: mockRunSubagentStartHooks,
  runSubagentStopHooks: mockRunSubagentStopHooks,
  createHookAwareToolExecutor: vi.fn().mockImplementation((base: unknown) => base),
}));

 
vi.mock('../builtinTools', () => ({
  getBuiltinToolDefinitions: mockGetBuiltinToolDefinitions,
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

 
vi.mock('../clientFactory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clientFactory')>();
  return {
    ...actual,
    createClientFromRoutePlan: vi.fn().mockReturnValue({}),
  };
});

import { executeAgentTool } from '../agentTool';

const SCOPED_PROMPT_TEXT = 'You are a focused task executor. Complete the following task precisely and efficiently.\nUse the available tools as needed. Return your result directly.';
const SUMMARIZE_INSTRUCTION = 'Before completing your work, call the SummarizeResult tool';

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
    experimental: {
      adaptiveRoutingEnabled: true,
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

function makeSharedTaskStore(): AgentToolContext['taskStoreInternal'] {
  const tasks = new Map<string, {
    id: string;
    title: string;
    owner: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    createdAt: number;
    updatedAt: number;
    notes?: string;
  }>([
    ['mission', {
      id: 'mission',
      title: 'Understand the quarterly launch plan',
      owner: 'mission',
      status: 'in_progress',
      createdAt: 1,
      updatedAt: 1,
      notes: 'goal',
    }],
  ]);
  let nextTaskId = 1;

  return {
    listTasks: vi.fn(() => [...tasks.values()]),
    _getNextTaskId: vi.fn(() => nextTaskId),
    _setNextTaskId: vi.fn((value: number) => { nextTaskId = value; }),
    _setRawTask: vi.fn((id: string, task) => { tasks.set(id, task); }),
    _getRawTask: vi.fn((id: string) => tasks.get(id)),
    _refreshBlockedTasks: vi.fn(),
  } as unknown as AgentToolContext['taskStoreInternal'];
}

function makePlanSteps(context: 'scoped' | 'contextual' = 'scoped'): PlanningStep[] {
  return [{
    id: 's1',
    sub_agents: [
      {
        task: 'Use researcher to inspect the routing implementation',
        model: unsafeAssertRoutingModelId('gpt-5.5'),
        effort: 'medium',
        context,
      },
    ],
  }];
}

function makeCtx(overrides: {
  planSteps?: PlanningStep[];
  taskStoreInternal?: AgentToolContext['taskStoreInternal'];
  mcpToolDefs?: ToolDefinition[];
  mcpSession?: AgentToolContext['mcpSession'];
} = {}): AgentToolContext {
  return {
    agents: {
      researcher: {
        description: 'Researches information',
        prompt: 'You are a research sub-agent with persona, memory, and conversation context.',
        model: 'inherit',
      },
    },
    client: {} as AgentToolContext['client'],
    settings: makeSettings(),
    parentModel: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
    parentMaxTokens: 4096,
    parentEffort: 'low',
    depth: 0,
    planRouting: {
      default_model: 'claude-sonnet-4-20250514',
      default_effort: 'low',
    },
    planSteps: overrides.planSteps ?? makePlanSteps('scoped'),
    consumedAssignments: new Set<string>(),
    hooks: {
      SubagentStart: [{ hooks: [vi.fn()] }],
      SubagentStop: [{ hooks: [vi.fn()] }],
    },
    hookContext: {},
    ...(overrides.taskStoreInternal ? { taskStoreInternal: overrides.taskStoreInternal } : {}),
    ...(overrides.mcpToolDefs ? { mcpToolDefs: overrides.mcpToolDefs } : {}),
    ...(overrides.mcpSession ? { mcpSession: overrides.mcpSession } : {}),
    turnId: 'turn-scoped-mode-test',
    codexConnectivity: 'unknown',
  };
}

function getRunConfig(): Parameters<typeof mockRunAgentLoop>[0][0] {
  expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
  return mockRunAgentLoop.mock.calls[0][0];
}

function flattenSystemPrompt(systemPrompt: SystemPrompt): string {
  if (typeof systemPrompt === 'string') return systemPrompt;
  if (Array.isArray(systemPrompt)) {
    return (systemPrompt as TextBlock[]).map((block) => block.text).join('\n');
  }
  return '';
}

describe('executeAgentTool scoped context mode', () => {
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockRunSubagentStartHooks.mockReset();
    mockRunSubagentStopHooks.mockReset();
    mockGetBuiltinToolDefinitions.mockReset();

    mockRunAgentLoop.mockResolvedValue(undefined);
    mockRunSubagentStartHooks.mockResolvedValue('Dynamic context from SubagentStart.');
    mockRunSubagentStopHooks.mockResolvedValue(undefined);
    mockGetBuiltinToolDefinitions.mockReturnValue([tool('Read'), tool('Bash'), tool('TaskList')]);
  });

  it('uses a minimal system prompt without agent persona or memory context', async () => {
    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect the routing implementation' }, makeCtx());

    const systemPrompt = getRunConfig().systemPrompt;
    expect(Array.isArray(systemPrompt)).toBe(true);

    const blocks = systemPrompt as TextBlock[];
    expect(blocks[0]).toEqual({
      type: 'text',
      text: SCOPED_PROMPT_TEXT,
      cache_control: { type: 'ephemeral' },
    });

    const promptText = flattenSystemPrompt(systemPrompt);
    expect(promptText).not.toContain('research sub-agent');
    expect(promptText).not.toContain('persona');
    expect(promptText).not.toContain('memory');
    expect(promptText).not.toContain('conversation context');
  });

  it('retains MCP tools when an MCP session is provided', async () => {
    const mcpTool = tool('mcp__knowledge_search');
    await executeAgentTool(
      { agent: 'researcher', prompt: 'Inspect the routing implementation' },
      makeCtx({
        mcpToolDefs: [mcpTool],
        mcpSession: { executeTool: vi.fn() },
      }),
    );

    const toolNames = getRunConfig().tools?.map((definition: ToolDefinition) => definition.name);
    expect(toolNames).toContain('mcp__knowledge_search');
  });

  it('retains builtin tools and sub-delegation capability', async () => {
    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect the routing implementation' }, makeCtx());

    const toolNames = getRunConfig().tools?.map((definition: ToolDefinition) => definition.name);
    expect(toolNames).toEqual(expect.arrayContaining(['Read', 'Bash', 'TaskList', 'Agent', 'SummarizeResult']));
  });

  it('skips SubagentStart and SubagentStop hooks in scoped mode', async () => {
    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect the routing implementation' }, makeCtx());

    expect(mockRunSubagentStartHooks).not.toHaveBeenCalled();
    expect(mockRunSubagentStopHooks).not.toHaveBeenCalled();
  });

  it('skips mission briefing in scoped mode', async () => {
    await executeAgentTool(
      { agent: 'researcher', prompt: 'Inspect the routing implementation' },
      makeCtx({ taskStoreInternal: makeSharedTaskStore() }),
    );

    const promptText = flattenSystemPrompt(getRunConfig().systemPrompt);
    expect(promptText).not.toContain('<mission_context>');
    expect(promptText).not.toContain('Commander\'s Intent');
    expect(promptText).not.toContain('Understand the quarterly launch plan');
  });

  it('preserves contextual mode behavior by default', async () => {
    await executeAgentTool(
      { agent: 'researcher', prompt: 'Inspect the routing implementation' },
      makeCtx({
        planSteps: makePlanSteps('contextual'),
        taskStoreInternal: makeSharedTaskStore(),
      }),
    );

    const promptText = flattenSystemPrompt(getRunConfig().systemPrompt);
    expect(promptText).toContain('You are a research sub-agent');
    expect(promptText).toContain('Dynamic context from SubagentStart.');
    expect(promptText).toContain('<mission_context>');
    expect(promptText).toContain('Understand the quarterly launch plan');
    expect(promptText).toContain(SUMMARIZE_INSTRUCTION);
    expect(mockRunSubagentStartHooks).toHaveBeenCalledTimes(1);
    expect(mockRunSubagentStopHooks).toHaveBeenCalledTimes(1);
  });

  it('includes the summarize instruction in scoped mode', async () => {
    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect the routing implementation' }, makeCtx());

    expect(flattenSystemPrompt(getRunConfig().systemPrompt)).toContain(SUMMARIZE_INSTRUCTION);
  });
});
