import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));

 
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

import { runAgentLoop } from '../agentLoop';
import type { RebelCoreConfig, RebelCoreEvent, ExecuteToolFn, ToolExecutionResult } from '../types';
import { ZERO_TOKEN_USAGE } from '../types';
import type { ModelClient, StreamResult } from '../modelClient';
import type { ToolUseBlock } from '../modelTypes';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const END_TURN_RESULT: StreamResult = {
  content: [{ type: 'text', text: 'Done' }],
  stopReason: 'end_turn',
  usage: { ...ZERO_TOKEN_USAGE },
};

const createAgentToolUse = (index: number): ToolUseBlock => ({
  type: 'tool_use',
  id: `agent-${index}`,
  name: 'Agent',
  input: { agent: 'researcher', prompt: `task-${index}` },
});

const createTaskToolUse = (index: number): ToolUseBlock => ({
  type: 'tool_use',
  id: `task-${index}`,
  name: 'Task',
  input: { agent: 'researcher', prompt: `task-alias-${index}` },
});

const createReadToolUse = (index: number): ToolUseBlock => ({
  type: 'tool_use',
  id: `read-${index}`,
  name: 'Read',
  input: { path: `file-${index}.ts` },
});

const createBashToolUse = (index: number): ToolUseBlock => ({
  type: 'tool_use',
  id: `bash-${index}`,
  name: 'Bash',
  input: { command: `echo ${index}` },
});

function createMockClient(firstResult: StreamResult): {
  client: ModelClient;
  streamMock: ReturnType<typeof vi.fn>;
} {
  let callCount = 0;
  const streamMock = vi.fn(async () => {
    callCount += 1;
    if (callCount === 1) {
      return firstResult;
    }
    return END_TURN_RESULT;
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

  return { client, streamMock };
}

function createConfig(client: ModelClient, signal?: AbortSignal): RebelCoreConfig {
  return {
    client,
    model: unsafeAssertRoutingModelId('test-model'),
    systemPrompt: 'You are a test assistant.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    tools: [
      { name: 'Agent', description: 'Delegate task', input_schema: { type: 'object' as const, properties: {} } },
      { name: 'Task', description: 'Legacy delegate alias', input_schema: { type: 'object' as const, properties: {} } },
      { name: 'Read', description: 'Read file', input_schema: { type: 'object' as const, properties: {} } },
      { name: 'Bash', description: 'Run shell command', input_schema: { type: 'object' as const, properties: {} } },
    ],
    maxTokens: 1024,
    signal,
  };
}

const createAbortError = (): Error => {
  const error = new Error('Operation was aborted');
  error.name = 'AbortError';
  return error;
};

describe('agentLoop parallel Agent cap', () => {
  beforeEach(() => {
    loggerMocks.info.mockClear();
    loggerMocks.warn.mockClear();
    loggerMocks.debug.mockClear();
    loggerMocks.error.mockClear();
    loggerMocks.trace.mockClear();
    loggerMocks.fatal.mockClear();
  });

  it('caps Agent tool calls at 4 while leaving non-Agent tools uncapped', async () => {
    const toolUses: ToolUseBlock[] = [];
    const agentDeferreds = new Map<string, ReturnType<typeof createDeferred<ToolExecutionResult>>>();
    const readDeferreds = new Map<string, ReturnType<typeof createDeferred<ToolExecutionResult>>>();

    for (let index = 0; index < 8; index += 1) {
      const agent = createAgentToolUse(index);
      const read = createReadToolUse(index);
      toolUses.push(agent, read);
      agentDeferreds.set(agent.id, createDeferred<ToolExecutionResult>());
      readDeferreds.set(read.id, createDeferred<ToolExecutionResult>());
    }

    const { client } = createMockClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const startedAgents: string[] = [];
    const startedReads: string[] = [];
    let agentInFlight = 0;
    let readInFlight = 0;
    let maxAgentInFlight = 0;
    let maxReadInFlight = 0;

    const executeTool: ExecuteToolFn = vi.fn(async (toolName, _input, toolUseId) => {
      if (toolName === 'Agent') {
        const deferred = agentDeferreds.get(toolUseId)!;
        startedAgents.push(toolUseId);
        agentInFlight += 1;
        maxAgentInFlight = Math.max(maxAgentInFlight, agentInFlight);
        try {
          return await deferred.promise;
        } finally {
          agentInFlight -= 1;
        }
      }

      const deferred = readDeferreds.get(toolUseId)!;
      startedReads.push(toolUseId);
      readInFlight += 1;
      maxReadInFlight = Math.max(maxReadInFlight, readInFlight);
      try {
        return await deferred.promise;
      } finally {
        readInFlight -= 1;
      }
    });

    const loopPromise = runAgentLoop(createConfig(client), executeTool, vi.fn());

    await vi.waitFor(() => {
      expect(startedAgents).toHaveLength(4);
      expect(startedReads).toHaveLength(8);
    });

    expect(maxAgentInFlight).toBe(4);
    expect(maxReadInFlight).toBe(8);

    agentDeferreds.forEach((deferred, toolUseId) => {
      deferred.resolve({ output: `agent-result-${toolUseId}`, isError: false });
    });
    readDeferreds.forEach((deferred, toolUseId) => {
      deferred.resolve({ output: `read-result-${toolUseId}`, isError: false });
    });

    await loopPromise;

    expect(startedAgents).toHaveLength(8);
    expect(startedReads).toHaveLength(8);
    expect(maxAgentInFlight).toBe(4);

    const capLog = loggerMocks.info.mock.calls.find((call) => call[1] === 'agent_fanout_cap_engaged');
    expect(capLog).toBeDefined();
    expect(capLog?.[0]).toMatchObject({
      requested: 8,
      cap: 4,
      queued: 4,
    });
  });

  it('logs parallel-tool-results-summary with cumulative output chars', async () => {
    const toolUses: ToolUseBlock[] = [
      createAgentToolUse(0),
      createReadToolUse(0),
      createReadToolUse(1),
    ];
    const { client } = createMockClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const executeTool: ExecuteToolFn = vi.fn(async (toolName, _input, toolUseId) => {
      if (toolName === 'Agent') {
        return { output: `agent-${toolUseId}`, outputChars: 50, isError: false };
      }
      if (toolUseId === 'read-0') {
        return { output: 'abcde', isError: false };
      }
      return { output: '1234567890', isError: false };
    });

    await runAgentLoop(createConfig(client), executeTool, vi.fn());

    const summaryLog = loggerMocks.info.mock.calls.find(
      (call) => call[1] === 'parallel-tool-results-summary',
    );
    expect(summaryLog).toBeDefined();
    expect(summaryLog?.[0]).toMatchObject({
      cumulativeToolResultChars: 65,
      agentToolCount: 1,
      nonAgentToolCount: 2,
    });
  });

  it('does not emit parallel-tool-results-summary for a solo non-Agent tool call', async () => {
    const toolUses: ToolUseBlock[] = [createReadToolUse(0)];
    const { client } = createMockClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'solo-read-result',
      isError: false,
    }));

    await runAgentLoop(createConfig(client), executeTool, vi.fn());

    const summaryLog = loggerMocks.info.mock.calls.find(
      (call) => call[1] === 'parallel-tool-results-summary',
    );
    expect(summaryLog).toBeUndefined();
  });

  it('triggers post-fanout projected-utilization compaction once and keeps proactive flag latched', async () => {
    const firstBatch = Array.from({ length: 4 }, (_tool, index) => createAgentToolUse(index));
    const secondBatch = Array.from({ length: 4 }, (_tool, index) => createAgentToolUse(index + 10));

    let streamCalls = 0;
    const client: ModelClient = {
      stream: vi.fn(async () => {
        streamCalls += 1;
        if (streamCalls === 1) {
          return {
            content: firstBatch,
            stopReason: 'tool_use',
            usage: { ...ZERO_TOKEN_USAGE, inputTokens: 100_000 },
          };
        }
        if (streamCalls === 2) {
          return {
            content: secondBatch,
            stopReason: 'tool_use',
            usage: { ...ZERO_TOKEN_USAGE, inputTokens: 100_000 },
          };
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

    const events: RebelCoreEvent[] = [];
    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'x'.repeat(6_000),
      outputChars: 200_000,
      isError: false,
    }));

    await runAgentLoop(
      {
        ...createConfig(client),
        contextWindow: 200_000,
      },
      executeTool,
      (event) => events.push(event),
    );

    const compactionEvents = events.filter(
      (event): event is Extract<RebelCoreEvent, { type: 'recovery:compaction' }> => event.type === 'recovery:compaction',
    );
    expect(compactionEvents).toHaveLength(1);

    const summaryLogs = loggerMocks.info.mock.calls.filter(
      (call) => call[1] === 'parallel-tool-results-summary',
    );
    expect(summaryLogs).toHaveLength(2);
    expect(summaryLogs[0]?.[0]).toMatchObject({
      cumulativeToolResultChars: 800_000,
      agentToolCount: 4,
      nonAgentToolCount: 0,
    });

    const projectedCompactionLog = loggerMocks.info.mock.calls.find(
      (call) => call[1] === 'Post-fanout projected utilization crossed proactive compaction threshold',
    );
    expect(projectedCompactionLog).toBeDefined();
    expect((projectedCompactionLog?.[0] as { removedChars?: number }).removedChars ?? 0).toBeGreaterThan(0);
  });

  it('does not inject a per-tool consecutive advisory for one parallel Agent failure batch', async () => {
    const toolUses: ToolUseBlock[] = Array.from({ length: 4 }, (_tool, index) => createAgentToolUse(index));
    const { client } = createMockClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'Sub-agent failed: timeout',
      isError: true,
    }));

    const result = await runAgentLoop(createConfig(client), executeTool, vi.fn());

    const advisoryMessages = result.messageHistory.filter(
      (message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('[SYSTEM]'),
    );
    expect(advisoryMessages).toHaveLength(0);
  });

  it('applies the same cap to Task alias tool calls', async () => {
    const toolUses = Array.from({ length: 8 }, (_tool, index) => createTaskToolUse(index));
    const deferreds = new Map<string, ReturnType<typeof createDeferred<ToolExecutionResult>>>();
    for (const toolUse of toolUses) {
      deferreds.set(toolUse.id, createDeferred<ToolExecutionResult>());
    }

    const { client } = createMockClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const startedTasks: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const executeTool: ExecuteToolFn = vi.fn(async (toolName, _input, toolUseId) => {
      if (toolName !== 'Task') {
        throw new Error(`Unexpected tool: ${toolName}`);
      }

      startedTasks.push(toolUseId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);

      try {
        return await deferreds.get(toolUseId)!.promise;
      } finally {
        inFlight -= 1;
      }
    });

    const loopPromise = runAgentLoop(createConfig(client), executeTool, vi.fn());

    await vi.waitFor(() => {
      expect(startedTasks).toHaveLength(4);
    });
    expect(maxInFlight).toBe(4);

    deferreds.forEach((deferred, toolUseId) => {
      deferred.resolve({ output: `result-${toolUseId}`, isError: false });
    });

    await loopPromise;

    expect(startedTasks).toHaveLength(8);
    expect(maxInFlight).toBe(4);
  });

  it('keeps mixed 8 Agent + 8 Read ordering aligned under burst while capping Agent concurrency', async () => {
    const toolUses: ToolUseBlock[] = [];
    for (let index = 0; index < 8; index += 1) {
      toolUses.push(createAgentToolUse(index), createReadToolUse(index));
    }

    const { client } = createMockClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const deferreds = new Map<string, ReturnType<typeof createDeferred<ToolExecutionResult>>>();
    for (const toolUse of toolUses) {
      deferreds.set(toolUse.id, createDeferred<ToolExecutionResult>());
    }

    const startedAgents: string[] = [];
    const startedReads: string[] = [];
    let agentInFlight = 0;
    let maxAgentInFlight = 0;

    const executeTool: ExecuteToolFn = vi.fn(async (toolName, _input, toolUseId) => {
      if (toolName === 'Agent') {
        startedAgents.push(toolUseId);
        agentInFlight += 1;
        maxAgentInFlight = Math.max(maxAgentInFlight, agentInFlight);
      } else {
        startedReads.push(toolUseId);
      }

      try {
        return await deferreds.get(toolUseId)!.promise;
      } finally {
        if (toolName === 'Agent') {
          agentInFlight -= 1;
        }
      }
    });

    const loopPromise = runAgentLoop(createConfig(client), executeTool, vi.fn());

    await vi.waitFor(() => {
      expect(startedReads).toHaveLength(8);
      expect(startedAgents).toHaveLength(4);
    });
    expect(maxAgentInFlight).toBeLessThanOrEqual(4);

    for (const toolUseId of toolUses.map((toolUse) => toolUse.id).reverse()) {
      deferreds.get(toolUseId)!.resolve({ output: `result-${toolUseId}`, isError: false });
    }

    const result = await loopPromise;
    expect(startedAgents).toHaveLength(8);
    expect(maxAgentInFlight).toBeLessThanOrEqual(4);

    const toolResultMessage = result.messageHistory.find(
      (message) => message.role === 'user'
        && Array.isArray(message.content)
        && message.content[0]?.type === 'tool_result',
    );
    expect(toolResultMessage).toBeDefined();

    const toolResultIds = (toolResultMessage!.content as Array<{ tool_use_id: string }>).map(
      (toolResult) => toolResult.tool_use_id,
    );
    const toolUseIds = toolUses.map((toolUse) => toolUse.id);
    expect(toolResultIds).toEqual(toolUseIds);
  });

  it('aborts cleanly during a burst and does not continue to the next assistant turn', async () => {
    const controller = new AbortController();
    const toolUses = Array.from({ length: 8 }, (_tool, index) => createAgentToolUse(index));
    const { client, streamMock } = createMockClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const startedAgents: string[] = [];
    let inFlightAbortSignals = 0;
    const events: RebelCoreEvent[] = [];

    const executeTool: ExecuteToolFn = vi.fn(async (_toolName, _input, toolUseId) => {
      startedAgents.push(toolUseId);
      return await new Promise<ToolExecutionResult>((_resolve, reject) => {
        const onAbort = () => {
          inFlightAbortSignals += 1;
          reject(createAbortError());
        };

        if (controller.signal.aborted) {
          onAbort();
          return;
        }

        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    const loopPromise = runAgentLoop(
      createConfig(client, controller.signal),
      executeTool,
      (event) => events.push(event),
    );

    await vi.waitFor(() => {
      expect(startedAgents).toHaveLength(4);
    });

    controller.abort();

    await expect(loopPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(startedAgents).toHaveLength(4);
    expect(inFlightAbortSignals).toBe(4);
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === 'assistant:message')).toHaveLength(1);

    const toolUseStartEvents = events.filter(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:start' }> => event.type === 'tool_use:start',
    );
    const toolUseResultEvents = events.filter(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => event.type === 'tool_use:result',
    );

    expect(toolUseStartEvents).toHaveLength(4);
    expect(new Set(toolUseStartEvents.map((event) => event.toolUseId))).toEqual(new Set(startedAgents));
    expect(toolUseResultEvents.filter((event) => startedAgents.includes(event.toolUseId))).toHaveLength(0);
  });

  it('rejects with AbortError without emitting tool_use:result when a tool resolves after abort', async () => {
    const controller = new AbortController();
    const toolUse = createAgentToolUse(0);
    const deferred = createDeferred<ToolExecutionResult>();
    const events: RebelCoreEvent[] = [];

    const { client } = createMockClient({
      content: [toolUse],
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const executeTool: ExecuteToolFn = vi.fn(async () => deferred.promise);

    const loopPromise = runAgentLoop(createConfig(client, controller.signal), executeTool, (event) => events.push(event));

    await vi.waitFor(() => {
      expect(executeTool).toHaveBeenCalledTimes(1);
    });

    controller.abort();
    deferred.resolve({ output: 'late-success', isError: false });

    await expect(loopPromise).rejects.toMatchObject({ name: 'AbortError' });

    const toolResultEvents = events.filter(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => event.type === 'tool_use:result',
    );
    expect(toolResultEvents).toHaveLength(0);
  });

  it('stringifies non-Error rejections while continuing other tool executions', async () => {
    const toolUses: ToolUseBlock[] = [
      createReadToolUse(0),
      createBashToolUse(0),
      createReadToolUse(1),
    ];
    const events: RebelCoreEvent[] = [];

    const { client } = createMockClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const executeTool: ExecuteToolFn = vi.fn(async (_toolName, _input, toolUseId) => {
      if (toolUseId === 'bash-0') {
        return Promise.reject('boom');
      }
      return { output: `ok-${toolUseId}`, isError: false };
    });

    const result = await runAgentLoop(createConfig(client), executeTool, (event) => events.push(event));

    expect(executeTool).toHaveBeenCalledTimes(3);

    const toolResultEvents = events.filter(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => event.type === 'tool_use:result',
    );
    expect(toolResultEvents).toHaveLength(3);

    expect(toolResultEvents.find((event) => event.toolUseId === 'bash-0')).toMatchObject({
      toolUseId: 'bash-0',
      isError: true,
      output: 'Tool execution failed: boom',
    });
    expect(toolResultEvents.find((event) => event.toolUseId === 'read-0')?.isError).toBe(false);
    expect(toolResultEvents.find((event) => event.toolUseId === 'read-1')?.isError).toBe(false);
    expect(events.filter((event) => event.type === 'turn:error')).toHaveLength(0);
    expect(result.turns).toBe(2);
  });

  it('aborts mixed Agent/Read/Bash fan-out without starting queued Agents or emitting late non-Agent results', async () => {
    const controller = new AbortController();
    const toolUses: ToolUseBlock[] = [
      createAgentToolUse(0),
      createReadToolUse(0),
      createBashToolUse(0),
      createAgentToolUse(1),
      createReadToolUse(1),
      createAgentToolUse(2),
      createBashToolUse(1),
      createAgentToolUse(3),
      createAgentToolUse(4),
      createAgentToolUse(5),
    ];
    const nonAgentDeferreds = new Map<string, ReturnType<typeof createDeferred<ToolExecutionResult>>>();
    for (const toolUse of toolUses) {
      if (toolUse.name === 'Read' || toolUse.name === 'Bash') {
        nonAgentDeferreds.set(toolUse.id, createDeferred<ToolExecutionResult>());
      }
    }

    const { client, streamMock } = createMockClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const events: RebelCoreEvent[] = [];
    const startedAgents: string[] = [];
    const startedNonAgents: string[] = [];

    const executeTool: ExecuteToolFn = vi.fn(async (toolName, _input, toolUseId) => {
      if (toolName === 'Read' || toolName === 'Bash') {
        startedNonAgents.push(toolUseId);
        return await nonAgentDeferreds.get(toolUseId)!.promise;
      }

      if (toolName !== 'Agent') {
        throw new Error(`Unexpected tool: ${toolName}`);
      }

      startedAgents.push(toolUseId);
      return await new Promise<ToolExecutionResult>((_resolve, reject) => {
        const onAbort = () => reject(createAbortError());
        if (controller.signal.aborted) {
          onAbort();
          return;
        }
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    const loopPromise = runAgentLoop(createConfig(client, controller.signal), executeTool, (event) => events.push(event));

    await vi.waitFor(() => {
      expect(startedAgents).toHaveLength(4);
      expect(startedNonAgents).toHaveLength(4);
    });

    controller.abort();
    nonAgentDeferreds.forEach((deferred, toolUseId) => {
      deferred.resolve({ output: `late-success-${toolUseId}`, isError: false });
    });

    await expect(loopPromise).rejects.toMatchObject({ name: 'AbortError' });

    expect(startedAgents).toHaveLength(4);
    expect(startedAgents).toEqual(expect.arrayContaining(['agent-0', 'agent-1', 'agent-2', 'agent-3']));
    expect(startedAgents).not.toContain('agent-4');
    expect(startedAgents).not.toContain('agent-5');
    expect(streamMock).toHaveBeenCalledTimes(1);

    const toolUseStartEvents = events.filter(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:start' }> => event.type === 'tool_use:start',
    );
    expect(toolUseStartEvents.map((event) => event.toolUseId)).not.toContain('agent-4');
    expect(toolUseStartEvents.map((event) => event.toolUseId)).not.toContain('agent-5');

    const toolUseResultEvents = events.filter(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => event.type === 'tool_use:result',
    );
    expect(toolUseResultEvents.map((event) => event.toolUseId)).not.toContain('read-0');
    expect(toolUseResultEvents.map((event) => event.toolUseId)).not.toContain('bash-0');
    expect(toolUseResultEvents.map((event) => event.toolUseId)).not.toContain('read-1');
    expect(toolUseResultEvents.map((event) => event.toolUseId)).not.toContain('bash-1');
  });

  it('keeps behavior unchanged when there are 4 or fewer Agent tool calls', async () => {
    const toolUses: ToolUseBlock[] = [
      createAgentToolUse(0),
      createReadToolUse(0),
      createAgentToolUse(1),
      createReadToolUse(1),
      createAgentToolUse(2),
      createAgentToolUse(3),
    ];

    const { client } = createMockClient({
      content: toolUses,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const deferreds = new Map<string, ReturnType<typeof createDeferred<ToolExecutionResult>>>();
    for (const toolUse of toolUses) {
      deferreds.set(toolUse.id, createDeferred<ToolExecutionResult>());
    }

    const startedAgents: string[] = [];
    let maxAgentInFlight = 0;
    let agentInFlight = 0;

    const executeTool: ExecuteToolFn = vi.fn(async (toolName, _input, toolUseId) => {
      if (toolName === 'Agent') {
        startedAgents.push(toolUseId);
        agentInFlight += 1;
        maxAgentInFlight = Math.max(maxAgentInFlight, agentInFlight);
      }

      try {
        return await deferreds.get(toolUseId)!.promise;
      } finally {
        if (toolName === 'Agent') {
          agentInFlight -= 1;
        }
      }
    });

    const loopPromise = runAgentLoop(createConfig(client), executeTool, vi.fn());

    await vi.waitFor(() => {
      expect(startedAgents).toHaveLength(4);
    });

    expect(maxAgentInFlight).toBe(4);

    deferreds.forEach((deferred, toolUseId) => {
      deferred.resolve({ output: `result-${toolUseId}`, isError: false });
    });

    await loopPromise;
    expect(startedAgents).toHaveLength(4);
    expect(maxAgentInFlight).toBe(4);
  });

  it('preserves the pre-fanout assertNotAborted gate', async () => {
    const controller = new AbortController();
    const toolUses = Array.from({ length: 6 }, (_tool, index) => createAgentToolUse(index));

    const streamMock = vi.fn(async () => {
      controller.abort();
      return {
        content: toolUses,
        stopReason: 'tool_use',
        usage: { ...ZERO_TOKEN_USAGE },
      };
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

    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'should not run',
      isError: false,
    }));

    const events: RebelCoreEvent[] = [];

    await expect(
      runAgentLoop(createConfig(client, controller.signal), executeTool, (event) => events.push(event)),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(executeTool).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'tool_use:start')).toHaveLength(0);
  });
});
