 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { ModelClient, StreamParams, StreamResult } from '../modelClient';
import type { ChatMessage, ToolResultBlock, ToolUseBlock } from '../modelTypes';
import type { RebelCoreEvent, TokenUsage } from '../types';
import { PARALLEL_AGENT_CAP } from '../constants/limits';
import { rebelCoreQuery } from '../rebelCoreQuery';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));

const mockRunPlanningPhase = vi.hoisted(() => vi.fn());
const mockExecuteAgentTool = vi.hoisted(() => vi.fn());
const adapterEventStore = vi.hoisted(() => ({ events: [] as unknown[] }));
const adapterHandleEvent = vi.hoisted(
  () => vi.fn((event: unknown) => {
    adapterEventStore.events.push(event);
    return [];
  }),
);

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
  createHookAwareToolExecutor: (exec: unknown) => exec,
  runStopHooksWithReason: vi.fn(async () => ({ shouldContinue: false })),
}));

vi.mock('../agentTool', () => ({
  buildAgentToolDefinition: () => ({
    name: 'Agent',
    description: '',
    input_schema: { type: 'object', properties: {} },
  }),
  executeAgentTool: (...args: unknown[]) => mockExecuteAgentTool(...args),
}));

vi.mock('../pluginServiceProvider', () => ({
  getBuiltinPluginService: () => null,
}));

vi.mock('../agentMessageAdapter', () => ({
  createAgentMessageAdapter: () => ({
    createInitMessage: () => ({ type: 'system', subtype: 'init' }),
    handleEvent: adapterHandleEvent,
    handleSubAgentEvent: () => [],
    createSyntheticToolCallPair: () => [],
    mergeSubAgentUsage: vi.fn(),
  }),
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

const PARALLEL_START_PREFIX = 'parallel:subagents:start:';
const PARALLEL_COMPLETE_PREFIX = 'parallel:subagents:complete:';

type StrictPlanStep = {
  id: string;
  description: string;
  success_signal: null;
  suggested_tools: string[];
  depends_on: string[];
  model: null;
  effort: null;
  sub_agents: null;
  parallel_group: string | null;
};

const createAbortError = (message: string): Error => {
  const abortError = new Error(message);
  abortError.name = 'AbortError';
  return abortError;
};

const getAbortSignalFromContext = (ctx: unknown): AbortSignal | undefined => {
  if (!ctx || typeof ctx !== 'object') {
    return undefined;
  }
  return (ctx as { signal?: AbortSignal }).signal;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const makeSettings = (): AppSettings => ({
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
    model: 'claude-sonnet-4-6',
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
}) as unknown as AppSettings;

const createParallelSteps = (count: number): StrictPlanStep[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: `s${index + 1}`,
    description: `Parallel research step ${index + 1}`,
    success_signal: null,
    suggested_tools: ['Read'],
    depends_on: [],
    parallel_group: 'g1',
    model: null,
    effort: null,
    sub_agents: null,
  }));

const createStepsWithoutParallelGroup = (count: number): StrictPlanStep[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: `s${index + 1}`,
    description: `Legacy sequential step ${index + 1}`,
    success_signal: null,
    suggested_tools: ['Read'],
    depends_on: [],
    parallel_group: null,
    model: null,
    effort: null,
    sub_agents: null,
  }));

const createPlanDocument = (steps: StrictPlanStep[]): Record<string, unknown> => ({
  type: 'plan',
  confidence: null,
  answer: null,
  reasoning: null,
  goal: 'Execute delegated research steps',
  assumptions: [],
  steps,
  risks: [],
  done_criteria: ['All delegated work is complete'],
  routing: null,
});

const createAgentToolUses = (count: number): ToolUseBlock[] =>
  Array.from({ length: count }, (_unused, index) => ({
    type: 'tool_use',
    id: `agent-${index + 1}`,
    name: 'Agent',
    input: {
      agent: 'researcher',
      prompt: `Execute step s${index + 1}`,
    },
  }));

const createExecutionClient = (
  firstResult: StreamResult,
  secondResult: StreamResult = END_TURN_RESULT,
): {
  client: ModelClient;
  streamMock: ReturnType<typeof vi.fn>;
  streamCalls: StreamParams[];
} => {
  const streamCalls: StreamParams[] = [];
  let callCount = 0;

  const streamMock = vi.fn(async (params: StreamParams) => {
    streamCalls.push(params);
    callCount += 1;
    if (callCount === 1) {
      return firstResult;
    }
    return secondResult;
  });

  const client: ModelClient = {
    stream: streamMock,
    create: vi.fn(async () => END_TURN_RESULT),
    capabilities: {
      hasNativeContextEditing: false,
      hasNativeCompaction: false,
      cacheStrategy: 'none' as const,
      cacheHeuristicTtlMs: 0,
      supportsImageContent: () => false,
    },
  };

  return { client, streamMock, streamCalls };
};

const toPromptText = (systemPrompt: StreamParams['systemPrompt']): string => {
  if (typeof systemPrompt === 'string') {
    return systemPrompt;
  }
  return systemPrompt
    .map((block) => ('text' in block ? block.text : ''))
    .join('\n');
};

const getCapturedEvents = (): RebelCoreEvent[] => adapterEventStore.events as RebelCoreEvent[];

const parseStatusPayload = (
  events: RebelCoreEvent[],
  prefix: string,
): Array<Record<string, unknown>> =>
  events
    .filter((event): event is Extract<RebelCoreEvent, { type: 'status' }> => event.type === 'status')
    .filter((event) => event.message.startsWith(prefix))
    .map((event) => JSON.parse(event.message.slice(prefix.length)) as Record<string, unknown>);

const extractToolResultBlocks = (streamParams: StreamParams | undefined): ToolResultBlock[] => {
  if (!streamParams) {
    return [];
  }

  const toolResultMessage = [...streamParams.messages].reverse().find((message): message is ChatMessage => (
    message.role === 'user'
    && Array.isArray(message.content)
    && message.content.length > 0
    && message.content.every((block) => (block as { type?: string }).type === 'tool_result')
  ));

  if (!toolResultMessage || !Array.isArray(toolResultMessage.content)) {
    return [];
  }

  return toolResultMessage.content as ToolResultBlock[];
};

const computeMaxInFlight = (
  timeline: Array<{ enteredAt: number; exitedAt: number }>,
): number => {
  const events = timeline.flatMap((entry) => ([
    { at: entry.enteredAt, delta: 1 },
    { at: entry.exitedAt, delta: -1 },
  ]));

  events.sort((left, right) => {
    if (left.at !== right.at) {
      return left.at - right.at;
    }
    return left.delta - right.delta;
  });

  let inFlight = 0;
  let maxInFlight = 0;
  for (const event of events) {
    inFlight += event.delta;
    if (inFlight > maxInFlight) {
      maxInFlight = inFlight;
    }
  }

  return maxInFlight;
};

const runQuery = async (params: {
  planDocument: Record<string, unknown>;
  executionClient: ModelClient;
  abortController?: AbortController;
}): Promise<void> => {
  mockRunPlanningPhase.mockResolvedValue({
    planText: JSON.stringify(params.planDocument, null, 2),
    document: params.planDocument,
    usage: { ...ZERO_USAGE },
    stopReason: 'end_turn',
    model: 'claude-opus-4-7',
  });

  const turnParams = {
    prompt: 'Do the work',
    model: 'planner',
    cwd: '/tmp',
    systemPrompt: 'System prompt',
    permissionMode: 'default',
    env: {
      PLANNING_MODEL: 'claude-opus-4-7',
      EXECUTION_MODEL: 'claude-sonnet-4-6',
    },
    ...(params.abortController ? { abortController: params.abortController } : {}),
  } as Parameters<typeof rebelCoreQuery>[0];

  const context = {
    settings: makeSettings(),
    cwd: '/tmp',
    executionClient: params.executionClient,
    planningClient: params.executionClient,
  } as Parameters<typeof rebelCoreQuery>[1];

  for await (const _message of rebelCoreQuery(turnParams, context)) {
    // Drain the async generator
  }
};

describe('rebelCoreQuery parallel execution integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterEventStore.events = [];
    mockExecuteAgentTool.mockReset();
    mockExecuteAgentTool.mockResolvedValue({ output: 'ok', isError: false });
  });

  it('max in-flight ≤ PARALLEL_AGENT_CAP, all 6 settle', async () => {
    const planDocument = createPlanDocument(createParallelSteps(6));
    const toolUses = createAgentToolUses(6);
    const { client, streamCalls } = createExecutionClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_USAGE },
    });

    const timeline: Array<{ id: string; enteredAt: number; exitedAt: number }> = [];
    const activityTimeline: Array<{ kind: 'enter' | 'exit'; toolUseId: string }> = [];
    mockExecuteAgentTool.mockImplementation(async (_input: unknown, _ctx: unknown, toolUseId: unknown) => {
      activityTimeline.push({ kind: 'enter', toolUseId: String(toolUseId) });
      const enteredAt = Date.now();
      await delay(50);
      const exitedAt = Date.now();
      activityTimeline.push({ kind: 'exit', toolUseId: String(toolUseId) });
      timeline.push({ id: String(toolUseId), enteredAt, exitedAt });
      return { output: `ok-${String(toolUseId)}`, isError: false };
    });

    await runQuery({ planDocument, executionClient: client });

    const maxInFlight = computeMaxInFlight(
      timeline.map(({ enteredAt, exitedAt }) => ({ enteredAt, exitedAt })),
    );
    expect(maxInFlight).toBeLessThanOrEqual(PARALLEL_AGENT_CAP);
    expect(maxInFlight).toBeGreaterThanOrEqual(PARALLEL_AGENT_CAP);
    expect(timeline).toHaveLength(6);
    const firstExitIndex = activityTimeline.findIndex((event) => event.kind === 'exit');
    expect(firstExitIndex).toBeGreaterThanOrEqual(0);
    const entriesBeforeFirstExit = activityTimeline
      .slice(0, firstExitIndex)
      .filter((event) => event.kind === 'enter')
      .length;
    expect(entriesBeforeFirstExit).toBeGreaterThanOrEqual(PARALLEL_AGENT_CAP);

    const toolResults = extractToolResultBlocks(streamCalls[1]);
    expect(toolResults).toHaveLength(6);

    const statusEvents = getCapturedEvents();
    const statusMessages = statusEvents
      .filter((event): event is Extract<RebelCoreEvent, { type: 'status' }> => event.type === 'status')
      .filter((event) => event.message.startsWith('parallel:subagents:'))
      .map((event) => event.message);
    const startIdx = statusMessages.findIndex((message) => message.startsWith(PARALLEL_START_PREFIX));
    const completeIdx = statusMessages.findIndex((message) => message.startsWith(PARALLEL_COMPLETE_PREFIX));
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeLessThan(completeIdx);
    const startPayload = parseStatusPayload(statusEvents, PARALLEL_START_PREFIX)[0];
    const completePayload = parseStatusPayload(statusEvents, PARALLEL_COMPLETE_PREFIX)[0];
    expect(startPayload).toEqual({
      requested: 6,
      cap: PARALLEL_AGENT_CAP,
    });
    expect(completePayload).toEqual(
      expect.objectContaining({
        requested: 6,
        succeeded: 6,
        failed: 0,
        aborted: 0,
        skipped: 0,
        durationMs: expect.any(Number),
      }),
    );
  });

  it('parallel-groups section appeared in execution system prompt', async () => {
    const planDocument = createPlanDocument(createParallelSteps(6));
    const toolUses = createAgentToolUses(6);
    const { client, streamCalls } = createExecutionClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_USAGE },
    });

    await runQuery({ planDocument, executionClient: client });

    const firstCall = streamCalls[0];
    expect(firstCall).toBeDefined();
    const systemPromptText = toPromptText(firstCall.systemPrompt);
    expect(systemPromptText).toContain('PARALLEL EXECUTION:');
    expect(systemPromptText).toContain('- g1: steps s1, s2, s3, s4, s5, s6');
  });

  it('abort during burst stops the queue', async () => {
    const planDocument = createPlanDocument(createParallelSteps(6));
    const toolUses = createAgentToolUses(6);
    const { client } = createExecutionClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_USAGE },
    });

    const abortController = new AbortController();
    let abortAt: number | null = null;
    const abortTimer = setTimeout(() => {
      abortAt = Date.now();
      abortController.abort();
    }, 100);

    const startTimeline: Array<{ id: string; startedAt: number }> = [];
    mockExecuteAgentTool.mockImplementation(async (_input: unknown, ctx: unknown, toolUseId: unknown) => {
      const signal = getAbortSignalFromContext(ctx);
      expect(signal).toBeDefined();
      // Signal is the per-tool child AbortSignal (not the parent directly).
      // The child is wired to mirror the parent: aborting the parent must
      // also abort the child. Identity is intentionally NOT preserved.
      expect(signal).not.toBe(abortController.signal);
      expect(signal!.aborted).toBe(false);
      startTimeline.push({ id: String(toolUseId), startedAt: Date.now() });

      await new Promise<void>((resolve, reject) => {
        const finishTimer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, 200);
        const onAbort = () => {
          clearTimeout(finishTimer);
          signal?.removeEventListener('abort', onAbort);
          reject(createAbortError('Aborted during burst'));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });

      return { output: `ok-${String(toolUseId)}`, isError: false };
    });

    await runQuery({
      planDocument,
      executionClient: client,
      abortController,
    });

    clearTimeout(abortTimer);
    expect(abortAt).not.toBeNull();
    const dispatchedCount = mockExecuteAgentTool.mock.calls.length;
    expect(dispatchedCount).toBeLessThanOrEqual(PARALLEL_AGENT_CAP);

    const completePayload = parseStatusPayload(getCapturedEvents(), PARALLEL_COMPLETE_PREFIX)[0];
    expect(Number(completePayload.aborted)).toBeGreaterThanOrEqual(1);
    expect(
      Number(completePayload.succeeded) + Number(completePayload.failed) + Number(completePayload.aborted) + Number(completePayload.skipped ?? 0),
    ).toBe(Number(completePayload.requested));

    const startedAfterAbort = startTimeline.filter((entry) => entry.startedAt > (abortAt as number));
    expect(startedAfterAbort).toHaveLength(0);
  });

  it('tool_use → tool_result ordering preserved', async () => {
    const planDocument = createPlanDocument(createParallelSteps(PARALLEL_AGENT_CAP));
    const toolUses = createAgentToolUses(PARALLEL_AGENT_CAP);
    const { client, streamCalls } = createExecutionClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_USAGE },
    });

    let invocationCount = 0;
    const timeline: Array<{ kind: 'exit'; toolUseId: string }> = [];
    mockExecuteAgentTool.mockImplementation(async (_input: unknown, _ctx: unknown, toolUseId: unknown) => {
      invocationCount += 1;
      await delay((toolUses.length - invocationCount) * 30);
      timeline.push({ kind: 'exit', toolUseId: String(toolUseId) });
      return { output: `ok-${String(toolUseId)}`, isError: false };
    });

    await runQuery({ planDocument, executionClient: client });

    const completionOrder = timeline
      .filter((event) => event.kind === 'exit')
      .map((event) => event.toolUseId);
    const invocationOrder = toolUses.map((toolUse) => toolUse.id);
    expect(completionOrder).not.toEqual(invocationOrder);
    expect(completionOrder).toEqual([...invocationOrder].reverse());

    const toolResults = extractToolResultBlocks(streamCalls[1]);
    expect(toolResults.map((block) => block.tool_use_id)).toEqual(toolUses.map((toolUse) => toolUse.id));
  });

  it('sibling failure does not cancel siblings', async () => {
    const planDocument = createPlanDocument(createParallelSteps(6));
    const toolUses = createAgentToolUses(6);
    const { client, streamCalls } = createExecutionClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_USAGE },
    });

    let invocationCount = 0;
    mockExecuteAgentTool.mockImplementation(async (_input: unknown, _ctx: unknown, toolUseId: unknown) => {
      invocationCount += 1;
      if (invocationCount === 3) {
        throw new Error('synthetic-failure');
      }
      await delay(20);
      return { output: `ok-${String(toolUseId)}`, isError: false };
    });

    await runQuery({ planDocument, executionClient: client });

    const completePayload = parseStatusPayload(getCapturedEvents(), PARALLEL_COMPLETE_PREFIX)[0];
    expect(completePayload).toEqual(
      expect.objectContaining({
        requested: 6,
        succeeded: 5,
        failed: 1,
        aborted: 0,
        skipped: 0,
      }),
    );

    const toolResults = extractToolResultBlocks(streamCalls[1]);
    expect(toolResults).toHaveLength(6);
    expect(toolResults.map((block) => block.tool_use_id)).toEqual(toolUses.map((toolUse) => toolUse.id));
    const errorResults = toolResults.filter((block) => block.is_error === true);
    expect(errorResults).toHaveLength(1);
    expect(errorResults[0]?.tool_use_id).toBe('agent-3');
    expect(toolResults.filter((block) => block.is_error !== true)).toHaveLength(5);
  });

  it('backward compatibility — plan with no parallel_group works', async () => {
    const planDocument = createPlanDocument(createStepsWithoutParallelGroup(1));
    const toolUses = createAgentToolUses(1);
    const { client, streamCalls } = createExecutionClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_USAGE },
    });

    await runQuery({ planDocument, executionClient: client });

    const statusEvents = getCapturedEvents();
    expect(parseStatusPayload(statusEvents, PARALLEL_START_PREFIX)).toHaveLength(0);

    const parallelGroupLogs = loggerMocks.info.mock.calls.filter(
      (call) => call[1] === 'parallel-groups: detected post-seeding',
    );
    expect(parallelGroupLogs).toHaveLength(0);

    const toolResults = extractToolResultBlocks(streamCalls[1]);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.tool_use_id).toBe('agent-1');
  });

  it('Pino telemetry — parallel-groups detected post-seeding', async () => {
    const planDocument = createPlanDocument(createParallelSteps(6));
    const toolUses = createAgentToolUses(6);
    const { client } = createExecutionClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_USAGE },
    });

    await runQuery({ planDocument, executionClient: client });

    const parallelGroupLogs = loggerMocks.info.mock.calls.filter(
      (call) => call[1] === 'parallel-groups: detected post-seeding',
    );
    expect(parallelGroupLogs).toHaveLength(1);
    expect(parallelGroupLogs[0]?.[0]).toEqual(
      expect.objectContaining({
        totalMembers: 6,
      }),
    );
  });
});
