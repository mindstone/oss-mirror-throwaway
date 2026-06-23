import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { runAgentLoop } from '../agentLoop';
import type { RebelCoreConfig, RebelCoreEvent, ExecuteToolFn } from '../types';
import { ZERO_TOKEN_USAGE } from '../types';
import type { ModelClient, StreamResult } from '../modelClient';
import type { ContentBlock } from '../modelTypes';
import { ToolKilledByWatchdogError } from '../toolErrors';

const TOOL_USES: ContentBlock[] = [
  { type: 'tool_use', id: 'tool-a', name: 'Read', input: { path: 'a.ts' } },
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
    tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object' as const, properties: {} } }],
    maxTokens: 1024,
    signal,
  };
}

const OriginalAbortController = globalThis.AbortController;

describe('agentLoop per-tool child AbortController scaffolding', () => {
  it('passes a child AbortSignal into executeTool that is distinct from the parent signal', async () => {
    let observedToolSignal: AbortSignal | undefined;

    const executeTool: ExecuteToolFn = vi.fn(async (_name, _input, _id, signal) => {
      observedToolSignal = signal;
      return { output: 'ok', isError: false };
    });

    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const onEvent = vi.fn();
    const parentAC = new OriginalAbortController();

    await runAgentLoop(createConfig(client, parentAC.signal), executeTool, onEvent);

    expect(observedToolSignal).toBeDefined();
    expect(observedToolSignal).not.toBe(parentAC.signal);
    expect(observedToolSignal?.aborted).toBe(false);
    expect(parentAC.signal.aborted).toBe(false);
  });

  it('parent-signal abort propagates to the per-tool child signal', async () => {
    const parentAC = new OriginalAbortController();
    let observedToolSignal: AbortSignal | undefined;

    const executeTool: ExecuteToolFn = vi.fn(async (_name, _input, _id, signal) => {
      observedToolSignal = signal;
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('Operation was aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
        setTimeout(resolve, 200);
      });
      return { output: 'late', isError: false };
    });

    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const onEvent = vi.fn();
    const loopPromise = runAgentLoop(createConfig(client, parentAC.signal), executeTool, onEvent);

    await vi.waitFor(() => {
      expect(executeTool).toHaveBeenCalledTimes(1);
    });
    parentAC.abort();

    await expect(loopPromise).rejects.toThrow();

    expect(observedToolSignal).toBeDefined();
    expect(observedToolSignal!.aborted).toBe(true);
    expect(parentAC.signal.aborted).toBe(true);
  });

  it('child-signal abort does NOT propagate to the parent signal', async () => {
    // Capture AbortController construction so the test can identify and abort
    // the loop-owned per-tool child controller without aborting the parent.
    const captured: AbortController[] = [];
    class CapturingAbortController extends OriginalAbortController {
      constructor() {
        super();
        captured.push(this);
      }
    }
    globalThis.AbortController = CapturingAbortController as unknown as typeof AbortController;

    try {
      const cancelReason = new Error('test-tool-cancel');
      const executeTool: ExecuteToolFn = async (_name, _input, _id, signal) => {
        const childAC = captured.find((ac) => ac.signal === signal);
        expect(childAC).toBeDefined();
        childAC!.abort(cancelReason);
        return { output: 'ok', isError: false };
      };

      const client = createMockClient({
        content: TOOL_USES,
        stopReason: 'tool_use',
        usage: { ...ZERO_TOKEN_USAGE },
      });

      const onEvent = vi.fn();
      const parentAC = new OriginalAbortController();

      await runAgentLoop(createConfig(client, parentAC.signal), executeTool, onEvent);

      expect(parentAC.signal.aborted).toBe(false);
      const childAC = captured.find((ac) => ac.signal !== parentAC.signal);
      expect(childAC).toBeDefined();
      expect(childAC!.signal.aborted).toBe(true);
    } finally {
      globalThis.AbortController = OriginalAbortController;
    }
  });

  it('parent-signal abort during tool execution still triggers the existing turn-abort path', async () => {
    const parentAC = new OriginalAbortController();
    const executeTool: ExecuteToolFn = vi.fn(async () => {
      parentAC.abort();
      const err = new Error('Operation was aborted');
      err.name = 'AbortError';
      throw err;
    });

    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const onEvent = vi.fn();

    await expect(
      runAgentLoop(createConfig(client, parentAC.signal), executeTool, onEvent),
    ).rejects.toThrow();

    expect(parentAC.signal.aborted).toBe(true);
  });

  it('child-only abort drives the catch-block gate and produces a synthetic tool_result with the cancel reason', async () => {
    // Stage 0 has no production trigger that aborts the child without the
    // parent. We drive the new gate from a test-only mock that grabs the
    // loop-owned child AC via constructor capture and aborts it ahead of
    // throwing AbortError.
    const captured: AbortController[] = [];
    class CapturingAbortController extends OriginalAbortController {
      constructor() {
        super();
        captured.push(this);
      }
    }
    globalThis.AbortController = CapturingAbortController as unknown as typeof AbortController;

    try {
      const cancelReason = new ToolKilledByWatchdogError({
        cancelledAtMs: 123,
        judgeReason: 'judge said stop',
        priorExtensionCount: 1,
      });
      const executeTool: ExecuteToolFn = async (_name, _input, _id, signal) => {
        const childAC = captured.find((ac) => ac.signal === signal);
        expect(childAC).toBeDefined();
        childAC!.abort(cancelReason);
        const err = new Error('Operation was aborted: child cancelled');
        err.name = 'AbortError';
        throw err;
      };

      const client = createMockClient({
        content: TOOL_USES,
        stopReason: 'tool_use',
        usage: { ...ZERO_TOKEN_USAGE },
      });

      const events: RebelCoreEvent[] = [];
      const onEvent = vi.fn((e: RebelCoreEvent) => events.push(e));
      const parentAC = new OriginalAbortController();

      const result = await runAgentLoop(
        createConfig(client, parentAC.signal),
        executeTool,
        onEvent,
      );

      expect(parentAC.signal.aborted).toBe(false);
      expect(result.turns).toBeGreaterThanOrEqual(1);

      const resultEvents = events.filter((e) => e.type === 'tool_use:result') as Array<
        RebelCoreEvent & { type: 'tool_use:result' }
      >;
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].isError).toBe(true);
      expect(resultEvents[0].output).toContain('time check');
      expect(resultEvents[0].output).toContain('judge said stop');
      expect(resultEvents[0].output).not.toContain('Tool cancelled by watchdog judge');
    } finally {
      globalThis.AbortController = OriginalAbortController;
    }
  });

  it('AgentToolTimeoutError thrown by executeTool is converted into a synthetic tool_result and the loop continues', async () => {
    const { AgentToolTimeoutError } = await import('../agentToolErrors');

    const executeTool: ExecuteToolFn = vi.fn(async () => {
      throw new AgentToolTimeoutError('Sub-agent "forager" timed out after 164726ms', 165_000);
    });

    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    const events: RebelCoreEvent[] = [];

    const result = await runAgentLoop(createConfig(client), executeTool, (event) => events.push(event));

    expect(result.turns).toBeGreaterThanOrEqual(1);
    const resultEvents = events.filter((e) => e.type === 'tool_use:result') as Array<
      RebelCoreEvent & { type: 'tool_use:result' }
    >;
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0].isError).toBe(true);
    expect(resultEvents[0].output.startsWith('Subagent ran out of time:')).toBe(true);
    expect(resultEvents[0].output).toContain('Sub-agent "forager" timed out after 164726ms');
  });

  it('AgentToolTimeoutError still re-throws when parent signal is aborted (user-cancel precedence)', async () => {
    const { AgentToolTimeoutError } = await import('../agentToolErrors');

    const parentAC = new OriginalAbortController();
    parentAC.abort();

    const executeTool: ExecuteToolFn = vi.fn(async () => {
      throw new AgentToolTimeoutError('Sub-agent timed out', 165_000);
    });

    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    await expect(runAgentLoop(createConfig(client, parentAC.signal), executeTool, vi.fn())).rejects.toThrow();
  });

  it('reports tool dispatch and settle callbacks around tool execution', async () => {
    const dispatches: Array<{ toolUseId: string; controller: AbortController }> = [];
    const settles: string[] = [];
    const executeTool: ExecuteToolFn = vi.fn(async () => ({ output: 'ok', isError: false }));
    const client = createMockClient({
      content: TOOL_USES,
      stopReason: 'tool_use',
      usage: { ...ZERO_TOKEN_USAGE },
    });

    await runAgentLoop(
      {
        ...createConfig(client),
        onToolDispatch: (toolUseId, controller) => dispatches.push({ toolUseId, controller }),
        onToolSettle: (toolUseId) => settles.push(toolUseId),
      },
      executeTool,
      vi.fn(),
    );

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].toolUseId).toBe('tool-a');
    expect(dispatches[0].controller.signal.aborted).toBe(false);
    expect(settles).toEqual(['tool-a']);
  });
});
