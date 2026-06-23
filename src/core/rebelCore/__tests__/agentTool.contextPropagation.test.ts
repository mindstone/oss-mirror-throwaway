import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { AgentToolContext, BuiltinToolContext } from '../types';
import type { ToolDefinition } from '../modelTypes';

const {
  mockExecuteBuiltinTool,
  mockRunAgentLoop,
  mockGetBuiltinToolDefinitions,
} = vi.hoisted(() => ({
  mockExecuteBuiltinTool: vi.fn(),
  mockRunAgentLoop: vi.fn(),
  mockGetBuiltinToolDefinitions: vi.fn(),
}));

vi.mock('../agentLoop', () => ({
  runAgentLoop: mockRunAgentLoop,
}));

vi.mock('../hookPipeline', () => ({
  runSubagentStartHooks: vi.fn(),
  runSubagentStopHooks: vi.fn(),
  createHookAwareToolExecutor: vi.fn().mockImplementation((base: unknown) => base),
}));

vi.mock('../builtinTools', () => ({
  getBuiltinToolDefinitions: mockGetBuiltinToolDefinitions,
  isBuiltinToolName: vi.fn((name: string) => name === 'CaptureContext'),
  executeBuiltinTool: mockExecuteBuiltinTool,
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

type CapturingToolExecutor = (name: string, input: unknown, id: string, signal: AbortSignal) => Promise<unknown>;

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

function makeCtx(): AgentToolContext {
  return {
    agents: {
      researcher: {
        description: 'Researches information',
        prompt: 'You are a research sub-agent.',
        model: 'inherit',
      },
      nested: {
        description: 'Checks nested propagation',
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
    turnId: 'turn-context-propagation-test',
    codexConnectivity: 'unknown',
  };
}

describe('executeAgentTool context propagation', () => {
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockExecuteBuiltinTool.mockReset();
    mockGetBuiltinToolDefinitions.mockReset();
    mockGetBuiltinToolDefinitions.mockReturnValue([tool('CaptureContext')]);
    mockExecuteBuiltinTool.mockResolvedValue({ output: 'captured' });
  });

  it('forwards surface capability and explicit council intent through subagent and nested-agent tool contexts', async () => {
    mockRunAgentLoop.mockImplementation(async (_config: unknown, toolExecutor: CapturingToolExecutor) => {
      const signal = new AbortController().signal;
      if (mockRunAgentLoop.mock.calls.length === 1) {
        await toolExecutor('CaptureContext', {}, 'direct-context-capture', signal);
        await toolExecutor('Agent', { agent: 'nested', prompt: 'Check the nested context.' }, 'nested-agent-call', signal);
        return;
      }
      await toolExecutor('CaptureContext', {}, 'nested-context-capture', signal);
    });

    await executeAgentTool({ agent: 'researcher', prompt: 'Inspect context propagation.' }, makeCtx());

    const contexts = mockExecuteBuiltinTool.mock.calls.map((call) => call[2] as BuiltinToolContext);
    expect(contexts).toHaveLength(2);
    expect(contexts.map((context) => context.surfaceCapability)).toEqual(['cloud', 'cloud']);
    expect(contexts.map((context) => context.wasExplicitCouncilIntent)).toEqual([true, true]);
  });
});
