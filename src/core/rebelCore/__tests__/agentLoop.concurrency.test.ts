import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from '../agentLoop';
import type { RebelCoreConfig, RebelCoreEvent, ExecuteToolFn } from '../types';
import { ZERO_TOKEN_USAGE } from '../types';
import type { ModelClient, StreamResult } from '../modelClient';
import type { ContentBlock } from '../modelTypes';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const TOOL_USES: ContentBlock[] = [
  { type: 'tool_use', id: 'tool-a', name: 'Read', input: { path: 'a.ts' } },
  { type: 'tool_use', id: 'tool-b', name: 'Read', input: { path: 'b.ts' } },
  { type: 'tool_use', id: 'tool-c', name: 'Read', input: { path: 'c.ts' } },
];

const END_TURN_RESULT: StreamResult = {
  content: [{ type: 'text', text: 'Done' }],
  stopReason: 'end_turn',
  usage: { ...ZERO_TOKEN_USAGE },
};

function createMockClient(firstResult: StreamResult): ModelClient {
  let callCount = 0;
  return {
    stream: vi.fn(async () => {
      callCount++;
      if (callCount === 1) return firstResult;
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

function createConfig(client: ModelClient, signal?: AbortSignal): RebelCoreConfig {
  return {
    client,
    model: unsafeAssertRoutingModelId('test-model'),
    systemPrompt: 'You are a test assistant.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' as const, properties: {} } }],
    maxTokens: 1024,
    signal,
  };
}

describe('agentLoop concurrent tool execution', () => {
  it('dispatches all tool calls concurrently (not sequentially)', async () => {
    const deferreds = {
      'tool-a': createDeferred<{ output: string; isError: boolean }>(),
      'tool-b': createDeferred<{ output: string; isError: boolean }>(),
      'tool-c': createDeferred<{ output: string; isError: boolean }>(),
    };

    const executeTool: ExecuteToolFn = vi.fn(async (_name, _input, toolUseId) => {
      return deferreds[toolUseId as keyof typeof deferreds].promise;
    });

    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const events: RebelCoreEvent[] = [];
    const onEvent = vi.fn((e: RebelCoreEvent) => events.push(e));

    const loopPromise = runAgentLoop(createConfig(client), executeTool, onEvent);

    // Wait for all tool calls to be dispatched
    await vi.waitFor(() => {
      expect(executeTool).toHaveBeenCalledTimes(3);
    });

    // All 3 were called BEFORE any resolved — proves concurrent dispatch
    expect(deferreds['tool-a'].promise).toBeDefined();
    expect(deferreds['tool-b'].promise).toBeDefined();
    expect(deferreds['tool-c'].promise).toBeDefined();

    // Resolve in reverse order to prove order independence
    deferreds['tool-c'].resolve({ output: 'content-c', isError: false });
    deferreds['tool-b'].resolve({ output: 'content-b', isError: false });
    deferreds['tool-a'].resolve({ output: 'content-a', isError: false });

    await loopPromise;

    expect(executeTool).toHaveBeenCalledTimes(3);
  });

  it('preserves per-tool start→result event ordering', async () => {
    const executeTool: ExecuteToolFn = vi.fn(async (_name, _input, toolUseId) => {
      return { output: `result-${toolUseId}`, isError: false };
    });

    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const events: RebelCoreEvent[] = [];
    const onEvent = vi.fn((e: RebelCoreEvent) => events.push(e));

    await runAgentLoop(createConfig(client), executeTool, onEvent);

    // For each tool, its start must come before its result
    for (const toolId of ['tool-a', 'tool-b', 'tool-c']) {
      const startIdx = events.findIndex(
        (e) => e.type === 'tool_use:start' && 'toolUseId' in e && e.toolUseId === toolId,
      );
      const resultIdx = events.findIndex(
        (e) => e.type === 'tool_use:result' && 'toolUseId' in e && e.toolUseId === toolId,
      );
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(resultIdx).toBeGreaterThan(startIdx);
    }
  });

  it('isolates per-tool errors without affecting other tools', async () => {
    const deferreds = {
      'tool-a': createDeferred<{ output: string; isError: boolean }>(),
      'tool-b': createDeferred<{ output: string; isError: boolean }>(),
      'tool-c': createDeferred<{ output: string; isError: boolean }>(),
    };

    const executeTool: ExecuteToolFn = vi.fn(async (_name, _input, toolUseId) => {
      return deferreds[toolUseId as keyof typeof deferreds].promise;
    });

    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const events: RebelCoreEvent[] = [];
    const onEvent = vi.fn((e: RebelCoreEvent) => events.push(e));

    const loopPromise = runAgentLoop(createConfig(client), executeTool, onEvent);

    await vi.waitFor(() => {
      expect(executeTool).toHaveBeenCalledTimes(3);
    });

    // tool-b throws, others succeed
    deferreds['tool-a'].resolve({ output: 'ok-a', isError: false });
    deferreds['tool-b'].reject(new Error('tool-b exploded'));
    deferreds['tool-c'].resolve({ output: 'ok-c', isError: false });

    await loopPromise;

    // Check that tool-b got an error result, others succeeded
    const resultEvents = events.filter(
      (e): e is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => e.type === 'tool_use:result',
    );

    const resultA = resultEvents.find((e) => e.toolUseId === 'tool-a');
    const resultB = resultEvents.find((e) => e.toolUseId === 'tool-b');
    const resultC = resultEvents.find((e) => e.toolUseId === 'tool-c');

    expect(resultA?.isError).toBe(false);
    expect(resultB?.isError).toBe(true);
    expect(resultB?.output).toContain('tool-b exploded');
    expect(resultC?.isError).toBe(false);
  });

  // Regression for fix C (260609_researcher-toolcall-faultisolation.md): a
  // non-abort rejection from `executeToolUse` ITSELF (i.e. NOT the inner
  // executeTool try/catch — e.g. an `onEvent` callback throwing while emitting
  // tool_use:result, a post-try step) must be isolated to that one call and
  // converted into a tool_result-error, never rejecting the whole Promise.all
  // batch nor crashing the turn. Mirrors the sub-agent path's settled
  // semantics. Also asserts the tool_use↔tool_result pairing invariant: every
  // tool_use still yields exactly one tool_result.
  it('isolates a non-abort rejection from executeToolUse itself (batch survives)', async () => {
    const executeTool: ExecuteToolFn = vi.fn(async (_name, _input, toolUseId) => {
      return { output: `ok-${toolUseId}`, isError: false };
    });

    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    // Make the tool_use:result emit for tool-b throw — this escapes
    // executeToolUse's INNER try/catch (it's a post-try step), so the pushed
    // non-agent promise rejects. Without the per-call .catch this rejects
    // Promise.all and re-throws at the turn level.
    const events: RebelCoreEvent[] = [];
    const onEvent = vi.fn((e: RebelCoreEvent) => {
      if (e.type === 'tool_use:result' && e.toolUseId === 'tool-b') {
        throw new Error('onEvent exploded for tool-b');
      }
      events.push(e);
    });

    // The turn must complete (no crash) rather than rejecting.
    await expect(
      runAgentLoop(createConfig(client), executeTool, onEvent),
    ).resolves.toBeDefined();

    // Pairing invariant: the second-turn user message fed back to the model
    // must carry exactly one tool_result per tool_use (3), with tool-b's being
    // an isolated error.
    const streamMock = client.stream as ReturnType<typeof vi.fn>;
    expect(streamMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const secondTurnConfig = streamMock.mock.calls[1][0] as { messages: Array<{ role: string; content: ContentBlock[] }> };
    const lastUserMsg = [...secondTurnConfig.messages].reverse().find((m) => m.role === 'user');
    const toolResults = (lastUserMsg?.content ?? []).filter(
      (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
    );
    expect(toolResults).toHaveLength(3);
    const resultB = toolResults.find((b) => b.tool_use_id === 'tool-b');
    expect(resultB?.is_error).toBe(true);
    expect(toolResults.filter((b) => b.is_error !== true)).toHaveLength(2);
  });

  it('preserves result array order matching tool_use input order', async () => {
    const deferreds = {
      'tool-a': createDeferred<{ output: string; isError: boolean }>(),
      'tool-b': createDeferred<{ output: string; isError: boolean }>(),
      'tool-c': createDeferred<{ output: string; isError: boolean }>(),
    };

    const executeTool: ExecuteToolFn = vi.fn(async (_name, _input, toolUseId) => {
      return deferreds[toolUseId as keyof typeof deferreds].promise;
    });

    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const events: RebelCoreEvent[] = [];
    const onEvent = vi.fn((e: RebelCoreEvent) => events.push(e));

    const loopPromise = runAgentLoop(createConfig(client), executeTool, onEvent);

    await vi.waitFor(() => {
      expect(executeTool).toHaveBeenCalledTimes(3);
    });

    // Resolve in reverse order (c, b, a) — array should still be [a, b, c]
    deferreds['tool-c'].resolve({ output: 'content-c', isError: false });
    deferreds['tool-b'].resolve({ output: 'content-b', isError: false });
    deferreds['tool-a'].resolve({ output: 'content-a', isError: false });

    const result = await loopPromise;

    // The second message in history should be the tool results
    const toolResultMsg = result.messageHistory.find(
      (m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
    );
    expect(toolResultMsg).toBeDefined();

    const results = toolResultMsg!.content as Array<{ tool_use_id: string; content: string }>;
    expect(results[0].tool_use_id).toBe('tool-a');
    expect(results[1].tool_use_id).toBe('tool-b');
    expect(results[2].tool_use_id).toBe('tool-c');
  });

  it('throws AbortError without executing tools when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const executeTool: ExecuteToolFn = vi.fn(async () => ({ output: 'nope', isError: false }));
    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });
    const onEvent = vi.fn();

    await expect(
      runAgentLoop(createConfig(client, controller.signal), executeTool, onEvent),
    ).rejects.toThrow('abort');

    expect(executeTool).not.toHaveBeenCalled();
  });

  it('handles single tool call correctly (degenerate case)', async () => {
    const singleToolUse: ContentBlock[] = [
      { type: 'tool_use', id: 'tool-only', name: 'Read', input: { path: 'solo.ts' } },
    ];

    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'solo-content',
      isError: false,
    }));

    const client = createMockClient({
      content: singleToolUse,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const events: RebelCoreEvent[] = [];
    const onEvent = vi.fn((e: RebelCoreEvent) => events.push(e));

    const result = await runAgentLoop(createConfig(client), executeTool, onEvent);

    expect(executeTool).toHaveBeenCalledTimes(1);

    const starts = events.filter((e) => e.type === 'tool_use:start');
    const results = events.filter((e) => e.type === 'tool_use:result');
    expect(starts).toHaveLength(1);
    expect(results).toHaveLength(1);

    const toolResultMsg = result.messageHistory.find(
      (m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
    );
    expect(toolResultMsg).toBeDefined();
    const toolResults = toolResultMsg!.content as Array<{ tool_use_id: string; content: string }>;
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe('tool-only');
    expect(toolResults[0].content).toBe('solo-content');
  });

  it('aborts before tool batch when signal fires after model response', async () => {
    const controller = new AbortController();

    const client: ModelClient = {
      stream: vi.fn(async () => {
        // Abort after model response completes but before tool execution
        controller.abort();
        return {
          content: TOOL_USES,
          stopReason: 'tool_use',
          usage: { ...ZERO_TOKEN_USAGE },
        };
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

    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'should not run',
      isError: false,
    }));

    const events: RebelCoreEvent[] = [];
    const onEvent = vi.fn((e: RebelCoreEvent) => events.push(e));

    await expect(
      runAgentLoop(createConfig(client, controller.signal), executeTool, onEvent),
    ).rejects.toThrow('abort');

    // Tools should NOT have been called — abort caught by assertNotAborted before Promise.all
    expect(executeTool).not.toHaveBeenCalled();

    // No tool_use:start events should have been emitted
    const toolStarts = events.filter((e) => e.type === 'tool_use:start');
    expect(toolStarts).toHaveLength(0);
  });

  it('all tools complete even when one is slow (no early termination)', async () => {
    const deferreds = {
      'tool-a': createDeferred<{ output: string; isError: boolean }>(),
      'tool-b': createDeferred<{ output: string; isError: boolean }>(),
      'tool-c': createDeferred<{ output: string; isError: boolean }>(),
    };

    const completionOrder: string[] = [];

    const executeTool: ExecuteToolFn = vi.fn(async (_name, _input, toolUseId) => {
      const result = await deferreds[toolUseId as keyof typeof deferreds].promise;
      completionOrder.push(toolUseId);
      return result;
    });

    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const events: RebelCoreEvent[] = [];
    const onEvent = vi.fn((e: RebelCoreEvent) => events.push(e));

    const loopPromise = runAgentLoop(createConfig(client), executeTool, onEvent);

    await vi.waitFor(() => {
      expect(executeTool).toHaveBeenCalledTimes(3);
    });

    // Resolve fast tools first, slow tool last
    deferreds['tool-c'].resolve({ output: 'fast-c', isError: false });
    deferreds['tool-a'].resolve({ output: 'fast-a', isError: false });
    // tool-b is the slow one — resolve it last
    await new Promise((r) => setTimeout(r, 10));
    deferreds['tool-b'].resolve({ output: 'slow-b', isError: false });

    await loopPromise;

    // All 3 tools completed
    expect(completionOrder).toHaveLength(3);
    expect(completionOrder).toContain('tool-a');
    expect(completionOrder).toContain('tool-b');
    expect(completionOrder).toContain('tool-c');

    // All 3 result events emitted
    const resultEvents = events.filter((e) => e.type === 'tool_use:result');
    expect(resultEvents).toHaveLength(3);
  });

  it('converts all tool throws to error results without crashing the loop', async () => {
    const executeTool: ExecuteToolFn = vi.fn(async (_name, _input, toolUseId) => {
      throw new Error(`${toolUseId} failed`);
    });

    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const events: RebelCoreEvent[] = [];
    const onEvent = vi.fn((e: RebelCoreEvent) => events.push(e));

    // All tools throw, but per-tool catch converts to error results — no turn:error
    const result = await runAgentLoop(createConfig(client), executeTool, onEvent);

    // All 3 tools should have error results
    const resultEvents = events.filter(
      (e): e is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => e.type === 'tool_use:result',
    );
    expect(resultEvents).toHaveLength(3);
    expect(resultEvents.every((e) => e.isError)).toBe(true);
    expect(resultEvents[0].output).toContain('failed');

    // No turn:error emitted — per-tool catch prevents loop-level errors
    const turnErrors = events.filter((e) => e.type === 'turn:error');
    expect(turnErrors).toHaveLength(0);

    // Loop completed (model was called a second time with tool_result messages)
    expect(result.turns).toBe(2);
  });

  it('handles concurrent tools across multiple loop iterations', async () => {
    const batch1Tools: ContentBlock[] = [
      { type: 'tool_use', id: 'batch1-a', name: 'Read', input: { path: '1a.ts' } },
      { type: 'tool_use', id: 'batch1-b', name: 'Read', input: { path: '1b.ts' } },
    ];
    const batch2Tools: ContentBlock[] = [
      { type: 'tool_use', id: 'batch2-a', name: 'Read', input: { path: '2a.ts' } },
      { type: 'tool_use', id: 'batch2-b', name: 'Read', input: { path: '2b.ts' } },
    ];

    let callCount = 0;
    const client: ModelClient = {
      stream: vi.fn(async () => {
        callCount++;
        if (callCount === 1) return { content: batch1Tools, stopReason: 'tool_use', usage: { ...ZERO_TOKEN_USAGE } };
        if (callCount === 2) return { content: batch2Tools, stopReason: 'tool_use', usage: { ...ZERO_TOKEN_USAGE } };
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

    const calledToolIds: string[] = [];
    const executeTool: ExecuteToolFn = vi.fn(async (_name, _input, toolUseId) => {
      calledToolIds.push(toolUseId);
      return { output: `result-${toolUseId}`, isError: false };
    });

    const events: RebelCoreEvent[] = [];
    const onEvent = vi.fn((e: RebelCoreEvent) => events.push(e));

    const result = await runAgentLoop(createConfig(client), executeTool, onEvent);

    // Both batches executed — 4 tools total
    expect(executeTool).toHaveBeenCalledTimes(4);
    expect(calledToolIds).toContain('batch1-a');
    expect(calledToolIds).toContain('batch1-b');
    expect(calledToolIds).toContain('batch2-a');
    expect(calledToolIds).toContain('batch2-b');

    // 3 model calls: batch1 tools, batch2 tools, end_turn
    expect(client.stream).toHaveBeenCalledTimes(3);
    expect(result.turns).toBe(3);

    // Per-tool ordering preserved in each batch
    for (const toolId of ['batch1-a', 'batch1-b', 'batch2-a', 'batch2-b']) {
      const startIdx = events.findIndex(
        (e) => e.type === 'tool_use:start' && 'toolUseId' in e && e.toolUseId === toolId,
      );
      const resultIdx = events.findIndex(
        (e) => e.type === 'tool_use:result' && 'toolUseId' in e && e.toolUseId === toolId,
      );
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(resultIdx).toBeGreaterThan(startIdx);
    }
  });
});
