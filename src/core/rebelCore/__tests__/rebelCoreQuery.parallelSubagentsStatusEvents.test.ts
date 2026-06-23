import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { runAgentLoop } from '../agentLoop';
import { PARALLEL_AGENT_CAP } from '../constants/limits';
import type { ExecuteToolFn, RebelCoreEvent, TokenUsage } from '../types';
import type { ModelClient, StreamResult } from '../modelClient';
import type { ToolUseBlock } from '../modelTypes';
import { rebelCoreQuery } from '../rebelCoreQuery';
import { AgentToolTimeoutError } from '../agentToolErrors';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));

const mockRunPlanningPhase = vi.hoisted(() => vi.fn());

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    debug: loggerMocks.debug,
    error: loggerMocks.error,
    trace: loggerMocks.trace,
    fatal: loggerMocks.fatal,
  }),
}));

vi.mock('../planningMode', async () => {
  const actual = await vi.importActual<typeof import('../planningMode')>('../planningMode');
  return {
    ...actual,
    runPlanningPhase: (...args: unknown[]) => mockRunPlanningPhase(...args),
  };
});

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
  runStopHooksWithReason: vi.fn(),
}));

vi.mock('../agentTool', () => ({
  buildAgentToolDefinition: () => ({
    name: 'Agent',
    description: '',
    input_schema: { type: 'object', properties: {} },
  }),
  executeAgentTool: vi.fn(),
}));

vi.mock('../pluginServiceProvider', () => ({
  getBuiltinPluginService: () => null,
}));

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

const END_TURN_RESULT: StreamResult = {
  content: [{ type: 'text', text: 'Done' }],
  stopReason: 'end_turn',
  usage: { ...ZERO_USAGE },
};

const createAgentToolUse = (index: number): ToolUseBlock => ({
  type: 'tool_use',
  id: `agent-${index}`,
  name: 'Agent',
  input: { agent: 'researcher', prompt: `task-${index}` },
});

const createReadToolUse = (index: number): ToolUseBlock => ({
  type: 'tool_use',
  id: `read-${index}`,
  name: 'Read',
  input: { path: `file-${index}.ts` },
});

function createMockClient(firstResult: StreamResult): ModelClient {
  let callCount = 0;
  return {
    stream: vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return firstResult;
      }
      return END_TURN_RESULT;
    }),
    create: vi.fn(async () => END_TURN_RESULT),
    capabilities: {
      hasNativeContextEditing: false,
      hasNativeCompaction: false,
      cacheStrategy: 'none' as const,
      cacheHeuristicTtlMs: 0,
      supportsImageContent: () => false,
    },
  };
}

const parseStatusPayload = (events: RebelCoreEvent[], prefix: string): Array<Record<string, unknown>> =>
  events
    .filter((event): event is Extract<RebelCoreEvent, { type: 'status' }> => event.type === 'status')
    .filter((event) => event.message.startsWith(prefix))
    .map((event) => JSON.parse(event.message.slice(prefix.length)) as Record<string, unknown>);

const getStatusEvents = (events: RebelCoreEvent[]): Array<Extract<RebelCoreEvent, { type: 'status' }>> =>
  events.filter((event): event is Extract<RebelCoreEvent, { type: 'status' }> => event.type === 'status');

const runLoopForToolUses = async (
  toolUses: ToolUseBlock[],
  executeTool: ExecuteToolFn,
  signal?: AbortSignal,
): Promise<RebelCoreEvent[]> => {
  const client = createMockClient({
    content: toolUses,
    stopReason: 'tool_use',
    usage: { ...ZERO_USAGE },
  });

  const events: RebelCoreEvent[] = [];
  await runAgentLoop(
    {
      client,
      model: unsafeAssertRoutingModelId('test-model'),
      systemPrompt: 'You are a test assistant.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
      tools: [
        { name: 'Agent', description: 'Delegate task', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'Read', description: 'Read file', input_schema: { type: 'object' as const, properties: {} } },
      ],
      maxTokens: 1024,
      ...(signal ? { signal } : {}),
    },
    executeTool,
    (event) => events.push(event),
  );

  return events;
};

describe('parallel sub-agent status events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits start before complete and never emits wave:start', async () => {
    const events = await runLoopForToolUses(
      [
        createAgentToolUse(0),
        createAgentToolUse(1),
        createReadToolUse(0),
      ],
      vi.fn(async () => ({ output: 'ok', isError: false })),
    );

    const statusEvents = getStatusEvents(events);
    const startIndex = statusEvents.findIndex((event) =>
      event.message.startsWith('parallel:subagents:start:'),
    );
    const completeIndex = statusEvents.findIndex((event) =>
      event.message.startsWith('parallel:subagents:complete:'),
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(completeIndex).toBeGreaterThan(startIndex);
    expect(
      statusEvents.some((event) => event.message.startsWith('parallel:subagents:wave:start:')),
    ).toBe(false);
  });

  it('keeps complete counts equal to requested on all-success runs', async () => {
    const events = await runLoopForToolUses(
      [
        createAgentToolUse(0),
        createAgentToolUse(1),
        createAgentToolUse(2),
        createAgentToolUse(3),
      ],
      vi.fn(async () => ({ output: 'ok', isError: false })),
    );

    const startPayload = parseStatusPayload(events, 'parallel:subagents:start:')[0];
    const completePayload = parseStatusPayload(events, 'parallel:subagents:complete:')[0];
    expect(startPayload).toEqual({
      requested: 4,
      cap: PARALLEL_AGENT_CAP,
    });
    expect(completePayload).toEqual(
      expect.objectContaining({
        requested: 4,
        succeeded: 4,
        failed: 0,
        aborted: 0,
        skipped: 0,
      }),
    );
    expect(
      Number(completePayload.succeeded) + Number(completePayload.failed) + Number(completePayload.aborted) + Number(completePayload.skipped ?? 0),
    ).toBe(Number(startPayload.requested));
  });

  it('reports mixed success/failure counts for 3 succeeds + 1 thrown execution', async () => {
    const events = await runLoopForToolUses(
      [
        createAgentToolUse(0),
        createAgentToolUse(1),
        createAgentToolUse(2),
        createAgentToolUse(3),
      ],
      vi.fn(async (toolName, _input, toolUseId) => {
        if (toolName === 'Agent' && toolUseId === 'agent-3') {
          throw new Error('Sub-agent crashed');
        }
        return { output: 'ok', isError: false };
      }),
    );

    const startPayload = parseStatusPayload(events, 'parallel:subagents:start:')[0];
    const completePayload = parseStatusPayload(events, 'parallel:subagents:complete:')[0];
    expect(completePayload).toEqual(
      expect.objectContaining({
        requested: 4,
        succeeded: 3,
        failed: 1,
        aborted: 0,
        skipped: 0,
      }),
    );
    expect(
      Number(completePayload.succeeded) + Number(completePayload.failed) + Number(completePayload.aborted) + Number(completePayload.skipped ?? 0),
    ).toBe(Number(startPayload.requested));
  });

  it('AgentToolTimeoutError now surfaces as a synthetic is_error tool_result and counts as failed (per A15 — recoverable, not an outright abort)', async () => {
    const events = await runLoopForToolUses(
      [
        createAgentToolUse(0),
        createAgentToolUse(1),
        createAgentToolUse(2),
        createAgentToolUse(3),
      ],
      vi.fn(async (toolName, _input, toolUseId) => {
        if (toolName === 'Agent' && toolUseId === 'agent-2') {
          throw new AgentToolTimeoutError('Simulated timeout', 1_000);
        }
        return { output: 'ok', isError: false };
      }),
    );

    const startPayload = parseStatusPayload(events, 'parallel:subagents:start:')[0];
    const completePayload = parseStatusPayload(events, 'parallel:subagents:complete:')[0];

    expect(Number(completePayload.failed)).toBeGreaterThanOrEqual(1);
    expect(completePayload.aborted).toBe(0);
    expect(
      Number(completePayload.succeeded) + Number(completePayload.failed) + Number(completePayload.aborted) + Number(completePayload.skipped ?? 0),
    ).toBe(Number(startPayload.requested));
  });

  it('keeps regular thrown errors classified as failed (not aborted)', async () => {
    const events = await runLoopForToolUses(
      [
        createAgentToolUse(0),
        createAgentToolUse(1),
        createAgentToolUse(2),
        createAgentToolUse(3),
      ],
      vi.fn(async (toolName, _input, toolUseId) => {
        if (toolName === 'Agent' && toolUseId === 'agent-1') {
          throw new Error('Regular agent failure');
        }
        return { output: 'ok', isError: false };
      }),
    );

    const completePayload = parseStatusPayload(events, 'parallel:subagents:complete:')[0];
    expect(Number(completePayload.failed)).toBeGreaterThanOrEqual(1);
    expect(completePayload.aborted).toBe(0);
  });

  it('reports aborted counts and preserves total equality when aborted mid-fanout', async () => {
    const abortController = new AbortController();
    let startedAgents = 0;
    const executeTool: ExecuteToolFn = vi.fn(async (toolName) => {
      if (toolName !== 'Agent') {
        return { output: 'ok', isError: false };
      }
      startedAgents += 1;
      if (startedAgents === PARALLEL_AGENT_CAP) {
        setTimeout(() => abortController.abort(), 0);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        const onAbort = () => {
          clearTimeout(timer);
          const abortError = new Error('Aborted by test');
          abortError.name = 'AbortError';
          reject(abortError);
        };
        abortController.signal.addEventListener('abort', onAbort, { once: true });
      });
      return { output: 'ok', isError: false };
    });

    const toolUses: ToolUseBlock[] = [
      createAgentToolUse(0),
      createAgentToolUse(1),
      createAgentToolUse(2),
      createAgentToolUse(3),
      createAgentToolUse(4),
      createAgentToolUse(5),
    ];
    const events: RebelCoreEvent[] = [];
    await expect(
      runAgentLoop(
        {
          client: createMockClient({
            content: toolUses,
            stopReason: 'tool_use',
            usage: { ...ZERO_USAGE },
          }),
          model: unsafeAssertRoutingModelId('test-model'),
          systemPrompt: 'You are a test assistant.',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
          tools: [
            { name: 'Agent', description: 'Delegate task', input_schema: { type: 'object' as const, properties: {} } },
            { name: 'Read', description: 'Read file', input_schema: { type: 'object' as const, properties: {} } },
          ],
          maxTokens: 1024,
          signal: abortController.signal,
        },
        executeTool,
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const startPayload = parseStatusPayload(events, 'parallel:subagents:start:')[0];
    const completePayload = parseStatusPayload(events, 'parallel:subagents:complete:')[0];
    expect(startPayload).toEqual({
      requested: 6,
      cap: PARALLEL_AGENT_CAP,
    });
    expect(Number(completePayload.aborted)).toBeGreaterThanOrEqual(1);
    expect(
      Number(completePayload.succeeded) + Number(completePayload.failed) + Number(completePayload.aborted) + Number(completePayload.skipped ?? 0),
    ).toBe(Number(startPayload.requested));
  });

  it('reports queued-not-started sub-agents as skipped (not aborted) when user cancels mid-fanout', async () => {
    const abortController = new AbortController();
    let startedAgents = 0;
    const executeTool: ExecuteToolFn = vi.fn(async (toolName) => {
      if (toolName !== 'Agent') {
        return { output: 'ok', isError: false };
      }
      startedAgents += 1;
      if (startedAgents === PARALLEL_AGENT_CAP) {
        setTimeout(() => abortController.abort(), 0);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        const onAbort = () => {
          clearTimeout(timer);
          const abortError = new Error('Aborted by test');
          abortError.name = 'AbortError';
          reject(abortError);
        };
        abortController.signal.addEventListener('abort', onAbort, { once: true });
      });
      return { output: 'ok', isError: false };
    });

    const toolUses: ToolUseBlock[] = [
      createAgentToolUse(0),
      createAgentToolUse(1),
      createAgentToolUse(2),
      createAgentToolUse(3),
      createAgentToolUse(4),
      createAgentToolUse(5),
    ];
    const events: RebelCoreEvent[] = [];
    await expect(
      runAgentLoop(
        {
          client: createMockClient({
            content: toolUses,
            stopReason: 'tool_use',
            usage: { ...ZERO_USAGE },
          }),
          model: unsafeAssertRoutingModelId('test-model'),
          systemPrompt: 'You are a test assistant.',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
          tools: [
            { name: 'Agent', description: 'Delegate task', input_schema: { type: 'object' as const, properties: {} } },
            { name: 'Read', description: 'Read file', input_schema: { type: 'object' as const, properties: {} } },
          ],
          maxTokens: 1024,
          signal: abortController.signal,
        },
        executeTool,
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const startPayload = parseStatusPayload(events, 'parallel:subagents:start:')[0];
    const completePayload = parseStatusPayload(events, 'parallel:subagents:complete:')[0];
    expect(Number(startPayload.requested)).toBe(6);
    expect(Number(completePayload.skipped)).toBeGreaterThanOrEqual(1);
    expect(Number(completePayload.skipped)).toBeLessThanOrEqual(6 - PARALLEL_AGENT_CAP);
    expect(
      Number(completePayload.succeeded) + Number(completePayload.failed) + Number(completePayload.aborted) + Number(completePayload.skipped),
    ).toBe(Number(startPayload.requested));
  });
});

function makeSettings(): AppSettings {
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
      model: unsafeAssertRoutingModelId('claude-sonnet-4-6'),
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
    },
    localModel: {
      activeProfileId: null,
      profiles: [],
    },
    diagnostics: { enabled: false },
  } as unknown as AppSettings;
}

describe('rebelCoreQuery parallel group telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs parallel-groups: detected post-seeding once per turn', async () => {
    const executionClient: ModelClient = {
      stream: vi.fn(async () => END_TURN_RESULT),
      create: vi.fn(async () => END_TURN_RESULT),
      capabilities: {
        hasNativeContextEditing: false,
        hasNativeCompaction: false,
        cacheStrategy: 'none' as const,
        cacheHeuristicTtlMs: 0,
        supportsImageContent: () => false,
      },
    };

    const planningDocument = {
      goal: 'Parallel plan',
      steps: [
        { id: 's1', description: 'Research source A', parallel_group: 'g1' },
        { id: 's2', description: 'Research source B', parallel_group: 'g1' },
      ],
      done_criteria: ['Answer delivered'],
    };
    mockRunPlanningPhase.mockResolvedValue({
      planText: JSON.stringify(planningDocument),
      document: planningDocument,
      usage: ZERO_USAGE,
      stopReason: 'end_turn',
      model: unsafeAssertRoutingModelId('claude-opus-4-7'),
    });

    const params = {
      prompt: 'Do the work',
      model: unsafeAssertRoutingModelId('planner'),
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      permissionMode: 'default',
      env: {
        PLANNING_MODEL: 'claude-opus-4-7',
        EXECUTION_MODEL: 'claude-sonnet-4-6',
      },
    } as Parameters<typeof rebelCoreQuery>[0];

    const context = {
      settings: makeSettings(),
      cwd: '/tmp',
      executionClient,
      planningClient: executionClient,
    } as Parameters<typeof rebelCoreQuery>[1];

    for await (const _message of rebelCoreQuery(params, context)) {
      // Drain generator
    }

    const parallelGroupLogs = loggerMocks.info.mock.calls.filter(
      (call) => call[1] === 'parallel-groups: detected post-seeding',
    );
    expect(parallelGroupLogs).toHaveLength(1);
    expect(parallelGroupLogs[0]?.[0]).toEqual(
      expect.objectContaining({
        turnId: expect.any(String),
        totalMembers: 2,
        cap: PARALLEL_AGENT_CAP,
        groups: [
          {
            groupId: 'g1',
            memberStepIds: ['s1', 's2'],
            memberTaskIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
          },
        ],
      }),
    );
  });
});
