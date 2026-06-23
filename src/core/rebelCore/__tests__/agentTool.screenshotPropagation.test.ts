import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { AgentToolContext, ToolExecutionResult } from '../types';

const {
  mockRunAgentLoop,
  mockExecuteBuiltinTool,
} = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
  mockExecuteBuiltinTool: vi.fn(),
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
  getBuiltinToolDefinitions: vi.fn().mockReturnValue([
    {
      name: 'rebel_get_app_screenshot',
      description: 'Capture screenshot',
      input_schema: {
        type: 'object',
        properties: {
          theme: { type: 'string' },
        },
        required: ['theme'],
      },
    },
  ]),
  isBuiltinToolName: vi.fn().mockImplementation((toolName: string) => toolName === 'rebel_get_app_screenshot'),
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

vi.mock('../clientFactory', () => ({
  createClientForModel: vi.fn().mockReturnValue({}),
  createClientFromRoutePlan: vi.fn().mockReturnValue({}),
  resolveTargetForModel: vi.fn().mockReturnValue({
    kind: 'anthropic-direct',
    model: unsafeAssertRoutingModelId('claude-haiku-4-20250414'),
    resolvedFrom: 'model-string',
  }),
  targetNeedsProxy: vi.fn().mockReturnValue(false),
}));

import { executeAgentTool } from '../agentTool';

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

function makeContext(
  captureRebelWindow: NonNullable<AgentToolContext['captureRebelWindow']>,
): AgentToolContext {
  return {
    agents: {
      chief_designer: {
        description: 'Chief designer',
        prompt: 'You are the chief designer.',
      },
    },
    client: {} as AgentToolContext['client'],
    settings: makeMinimalSettings(),
    parentModel: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
    depth: 0,
    captureRebelWindow,
    codexConnectivity: 'unknown',
  };
}

describe('agent tool screenshot capability propagation', () => {
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockExecuteBuiltinTool.mockReset();
  });

  it('forwards captureRebelWindow into subagent built-in tool execution', async () => {
    const captureRebelWindow = vi.fn().mockResolvedValue({
      kind: 'ok',
      path: '.rebel/screenshots/demo.png',
      width: 100,
      height: 100,
      theme: 'light',
      bytes: 512,
      currentSurface: 'home',
      base64Data: 'ZmFrZQ==',
      mimeType: 'image/png',
    });

    mockExecuteBuiltinTool.mockImplementation(async (
      toolName: string,
      toolInput: unknown,
      toolContext: { captureRebelWindow?: AgentToolContext['captureRebelWindow'] },
    ): Promise<ToolExecutionResult> => {
      if (toolName !== 'rebel_get_app_screenshot') {
        return { output: 'unexpected tool', isError: true };
      }
      if (!toolContext.captureRebelWindow) {
        return { output: 'missing screenshot capability', isError: true };
      }
      await toolContext.captureRebelWindow(toolInput as { theme: 'current' | 'light' | 'dark'; label?: string });
      return { output: 'ok', isError: false };
    });

    mockRunAgentLoop.mockImplementation(async (
      _config: unknown,
      toolExecutor: (name: string, input: unknown, id: string) => Promise<ToolExecutionResult>,
    ) => {
      await toolExecutor(
        'rebel_get_app_screenshot',
        { theme: 'current', label: 'chief-designer-entry' },
        'tool-use-1',
      );
    });

    await executeAgentTool(
      { agent: 'chief_designer', prompt: 'Review this layout.' },
      makeContext(captureRebelWindow),
      'parent-tool-use-1',
    );

    expect(captureRebelWindow).toHaveBeenCalledWith({
      theme: 'current',
      label: 'chief-designer-entry',
    });
  });

  it('forwards the shared visual verification navigation state into subagent built-in tool execution', async () => {
    const captureRebelWindow = vi.fn().mockResolvedValue({
      kind: 'ok',
      path: '.rebel/screenshots/demo.png',
      width: 100,
      height: 100,
      theme: 'light',
      bytes: 512,
      currentSurface: 'settings',
      base64Data: 'ZmFrZQ==',
      mimeType: 'image/png',
    });
    const visualVerificationNavigationState = {
      current: {
        destination: 'actions' as const,
        expectedSurface: 'tasks',
      },
    };

    mockExecuteBuiltinTool.mockImplementation(async (
      toolName: string,
      _toolInput: unknown,
      toolContext: { visualVerificationNavigationState?: AgentToolContext['visualVerificationNavigationState'] },
    ): Promise<ToolExecutionResult> => {
      if (toolName !== 'rebel_get_app_screenshot') {
        return { output: 'unexpected tool', isError: true };
      }
      expect(toolContext.visualVerificationNavigationState).toBe(visualVerificationNavigationState);
      return { output: 'ok', isError: false };
    });

    mockRunAgentLoop.mockImplementation(async (
      _config: unknown,
      toolExecutor: (name: string, input: unknown, id: string) => Promise<ToolExecutionResult>,
    ) => {
      await toolExecutor(
        'rebel_get_app_screenshot',
        { theme: 'current', label: 'chief-designer-entry' },
        'tool-use-1',
      );
    });

    await executeAgentTool(
      { agent: 'chief_designer', prompt: 'Review this layout.' },
      {
        ...makeContext(captureRebelWindow),
        visualVerificationNavigationState,
      },
      'parent-tool-use-1',
    );

    expect(mockExecuteBuiltinTool).toHaveBeenCalled();
  });
});
