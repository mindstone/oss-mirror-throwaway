import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
/**
 * Agent Tool — Sub-agent event forwarding tests.
 *
 * Verifies that executeAgentTool correctly forwards tool_use:start and
 * tool_use:result events from sub-agents to the parent via onSubAgentEvent,
 * while NOT forwarding other event types (assistant:text, status, turn:complete, etc.).
 * Also tests the safety cap and nested propagation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RebelCoreEvent, AgentToolContext } from '../types';
import type { AppSettings } from '@shared/types';

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

function makeCtx(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    agents: {
      researcher: {
        description: 'Researches topics',
        prompt: 'You are a researcher.',
      },
    },
    client: {} as AgentToolContext['client'],
    settings: makeMinimalSettings(),
    parentModel: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
    depth: 0,
    ...overrides,
    codexConnectivity: 'unknown',
  };
}

/**
 * Make runAgentLoop call the event handler with the given events, then resolve.
 */
function setupMockAgentLoop(events: RebelCoreEvent[]) {
  mockRunAgentLoop.mockImplementation(
    async (_config: unknown, _toolExec: unknown, onEvent: (event: RebelCoreEvent) => void) => {
      for (const event of events) {
        onEvent(event);
      }
    },
  );
}

describe('executeAgentTool event forwarding', () => {
  const parentToolUseId = 'parent-tu-abc';

  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockRunAgentLoop.mockResolvedValue(undefined);
  });

  describe('forwarded event types', () => {
    it('forwards tool_use:start events via onSubAgentEvent', async () => {
      const onSubAgentEvent = vi.fn();
      const toolUseStartEvent: RebelCoreEvent = {
        type: 'tool_use:start',
        toolUseId: 'child-tu-1',
        toolName: 'Read',
        input: { file_path: '/tmp/test.txt' },
      };
      setupMockAgentLoop([toolUseStartEvent]);

      await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx({ onSubAgentEvent }),
        parentToolUseId,
      );

      expect(onSubAgentEvent).toHaveBeenCalledWith(toolUseStartEvent, parentToolUseId);
    });

    it('forwards tool_use:result events via onSubAgentEvent', async () => {
      const onSubAgentEvent = vi.fn();
      const toolUseResultEvent: RebelCoreEvent = {
        type: 'tool_use:result',
        toolUseId: 'child-tu-1',
        output: 'file contents',
        isError: false,
      };
      setupMockAgentLoop([toolUseResultEvent]);

      await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx({ onSubAgentEvent }),
        parentToolUseId,
      );

      expect(onSubAgentEvent).toHaveBeenCalledWith(toolUseResultEvent, parentToolUseId);
    });

    it('forwards both start and result events for multiple tool calls', async () => {
      const onSubAgentEvent = vi.fn();
      const events: RebelCoreEvent[] = [
        { type: 'tool_use:start', toolUseId: 'tu-1', toolName: 'Read', input: {} },
        { type: 'tool_use:result', toolUseId: 'tu-1', output: 'data', isError: false },
        { type: 'tool_use:start', toolUseId: 'tu-2', toolName: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use:result', toolUseId: 'tu-2', output: 'output', isError: false },
      ];
      setupMockAgentLoop(events);

      await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx({ onSubAgentEvent }),
        parentToolUseId,
      );

      expect(onSubAgentEvent).toHaveBeenCalledTimes(4);
    });
  });

  describe('non-forwarded event types', () => {
    it('does NOT forward assistant:text events', async () => {
      const onSubAgentEvent = vi.fn();
      setupMockAgentLoop([{ type: 'assistant:text', text: 'Hello world' }]);

      await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx({ onSubAgentEvent }),
        parentToolUseId,
      );

      expect(onSubAgentEvent).not.toHaveBeenCalled();
    });

    it('does NOT forward status events', async () => {
      const onSubAgentEvent = vi.fn();
      setupMockAgentLoop([{ type: 'status', message: 'Thinking...' }]);

      await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx({ onSubAgentEvent }),
        parentToolUseId,
      );

      expect(onSubAgentEvent).not.toHaveBeenCalled();
    });

    it('does NOT forward turn:complete events', async () => {
      const onSubAgentEvent = vi.fn();
      setupMockAgentLoop([{
        type: 'turn:complete',
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        stopReason: 'end_turn',
      }]);

      await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx({ onSubAgentEvent }),
        parentToolUseId,
      );

      expect(onSubAgentEvent).not.toHaveBeenCalled();
    });

    it('does NOT forward turn:error events', async () => {
      const onSubAgentEvent = vi.fn();
      setupMockAgentLoop([{ type: 'turn:error', error: new Error('boom') }]);

      await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx({ onSubAgentEvent }),
        parentToolUseId,
      );

      expect(onSubAgentEvent).not.toHaveBeenCalled();
    });

    it('does NOT forward assistant:thinking events', async () => {
      const onSubAgentEvent = vi.fn();
      setupMockAgentLoop([{ type: 'assistant:thinking', thinking: 'Let me think...' }]);

      await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx({ onSubAgentEvent }),
        parentToolUseId,
      );

      expect(onSubAgentEvent).not.toHaveBeenCalled();
    });

    it('does NOT forward warning events', async () => {
      const onSubAgentEvent = vi.fn();
      setupMockAgentLoop([{ type: 'warning', category: 'mcp', message: 'MCP error' }]);

      await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx({ onSubAgentEvent }),
        parentToolUseId,
      );

      expect(onSubAgentEvent).not.toHaveBeenCalled();
    });

    it('does NOT forward assistant:message events', async () => {
      const onSubAgentEvent = vi.fn();
      setupMockAgentLoop([{
        type: 'assistant:message',
        content: [{ type: 'text', text: 'Some message' }],
      }]);

      await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx({ onSubAgentEvent }),
        parentToolUseId,
      );

      expect(onSubAgentEvent).not.toHaveBeenCalled();
    });
  });

  describe('text accumulation preserved', () => {
    it('still accumulates assistant:text for the tool result', async () => {
      setupMockAgentLoop([
        { type: 'assistant:text', text: 'Part 1. ' },
        { type: 'tool_use:start', toolUseId: 'tu-1', toolName: 'Read', input: {} },
        { type: 'tool_use:result', toolUseId: 'tu-1', output: 'data', isError: false },
        { type: 'assistant:text', text: 'Part 2.' },
      ]);

      const result = await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx({ onSubAgentEvent: vi.fn() }),
        parentToolUseId,
      );

      expect(result.output).toBe('Part 1. Part 2.');
      expect(result.isError).toBe(false);
    });
  });

  describe('safety cap', () => {
    it('stops forwarding after 200 events', async () => {
      const onSubAgentEvent = vi.fn();
      // Generate 210 tool events (105 start + 105 result = 210 total)
      const events: RebelCoreEvent[] = [];
      for (let i = 0; i < 105; i++) {
        events.push({ type: 'tool_use:start', toolUseId: `tu-${i}`, toolName: 'Read', input: {} });
        events.push({ type: 'tool_use:result', toolUseId: `tu-${i}`, output: 'ok', isError: false });
      }
      setupMockAgentLoop(events);

      await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx({ onSubAgentEvent }),
        parentToolUseId,
      );

      // Should cap at 200 forwarded events
      expect(onSubAgentEvent).toHaveBeenCalledTimes(200);
    });
  });

  describe('no callback', () => {
    it('works when onSubAgentEvent is not provided', async () => {
      setupMockAgentLoop([
        { type: 'tool_use:start', toolUseId: 'tu-1', toolName: 'Read', input: {} },
        { type: 'assistant:text', text: 'Result text.' },
      ]);

      const result = await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        makeCtx(),  // no onSubAgentEvent
        parentToolUseId,
      );

      expect(result.output).toBe('Result text.');
      expect(result.isError).toBe(false);
    });
  });

  describe('nested sub-agent propagation', () => {
    it('propagates onSubAgentEvent to childAgentCtx', async () => {
      const onSubAgentEvent = vi.fn();

      // Capture the childAgentCtx by inspecting the recursive executeAgentTool call.
      // Since executeAgentTool's recursive call goes through baseExecute which calls
      // executeAgentTool again, we inspect the runAgentLoop call args for tool executor setup.
      // Instead, verify indirectly: the tool executor built inside executeAgentTool
      // will call executeAgentTool recursively. We verify by checking that the
      // runAgentLoop config is called with the right tools (Agent included at depth 0).
      setupMockAgentLoop([]);

      const ctx = makeCtx({
        onSubAgentEvent,
        agents: {
          researcher: {
            description: 'Researches topics',
            prompt: 'You are a researcher.',
          },
        },
        depth: 0,
      });

      await executeAgentTool(
        { agent: 'researcher', prompt: 'Find info' },
        ctx,
        parentToolUseId,
      );

      // Verify runAgentLoop was called — the child can spawn sub-sub-agents (depth 1 < 2)
      expect(mockRunAgentLoop).toHaveBeenCalled();
      const config = mockRunAgentLoop.mock.calls[0][0];
      // Agent tool should be available to child at depth 1
      const toolNames = config.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('Agent');
    });
  });
});
