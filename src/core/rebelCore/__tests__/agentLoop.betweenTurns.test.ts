import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from '../agentLoop';
import type { RebelCoreConfig, RebelCoreEvent } from '../types';
import type { ModelClient, StreamResult } from '../modelClient';
import type { TokenUsage } from '../modelTypes';

const TOOL_USE_RESULT: StreamResult = {
  content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } }],
  stopReason: 'tool_use',
  usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
};

const END_TURN_RESULT: StreamResult = {
  content: [{ type: 'text', text: 'Done' }],
  stopReason: 'end_turn',
  usage: { inputTokens: 200, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 },
};

function createMockClient(): ModelClient {
  let callCount = 0;
  return {
    stream: vi.fn(async () => {
      callCount++;
      if (callCount === 1) return TOOL_USE_RESULT;
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

function createConfig(overrides?: Partial<RebelCoreConfig>): RebelCoreConfig {
  return {
    client: createMockClient(),
    model: unsafeAssertRoutingModelId('test-model'),
    systemPrompt: 'You are a test assistant.',
    messages: [{ role: 'user', content: 'test' }],
    tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
    ...overrides,
  };
}

describe('betweenTurns hook', () => {
  it('is called after tool results are appended', async () => {
    let capturedLength = 0;
    let capturedLastRole = '';
    let capturedLastType = '';
    const hookFn = vi.fn((messages: any[]) => {
      // Snapshot at call time since messages is a live reference
      capturedLength = messages.length;
      capturedLastRole = messages[messages.length - 1]?.role;
      const content = messages[messages.length - 1]?.content;
      capturedLastType = Array.isArray(content) ? content[0]?.type : '';
    });
    const config = createConfig({ betweenTurns: hookFn });

    const executeTool = vi.fn(async () => ({ output: 'file content', isError: false }));
    const onEvent = vi.fn();

    await runAgentLoop(config, executeTool, onEvent);

    expect(hookFn).toHaveBeenCalledTimes(1);
    expect(capturedLength).toBeGreaterThanOrEqual(3); // user, assistant(tool_use), user(tool_result)
    expect(capturedLastRole).toBe('user');
    expect(capturedLastType).toBe('tool_result');
  });

  it('receives per-turn usage from the last stream call', async () => {
    const hookFn = vi.fn();
    const config = createConfig({ betweenTurns: hookFn });

    const executeTool = vi.fn(async () => ({ output: 'ok', isError: false }));
    await runAgentLoop(config, executeTool, vi.fn());

    const [, usage] = hookFn.mock.calls[0] as [unknown, TokenUsage];
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
  });

  it('hook errors are non-fatal — loop continues with a warning', async () => {
    const hookFn = vi.fn().mockRejectedValue(new Error('hook failed'));
    const config = createConfig({ betweenTurns: hookFn });

    const executeTool = vi.fn(async () => ({ output: 'ok', isError: false }));
    const events: RebelCoreEvent[] = [];
    const onEvent = vi.fn((e: RebelCoreEvent) => events.push(e));

    const result = await runAgentLoop(config, executeTool, onEvent);

    // Loop should complete successfully despite hook failure
    expect(result.turns).toBe(2);
    // Warning event should have been emitted
    const warnings = events.filter((e) => e.type === 'warning');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatchObject({
      type: 'warning',
      category: 'mcp',
      message: expect.stringContaining('hook failed'),
    });
  });

  it('is not called when there are no tool uses (end_turn on first response)', async () => {
    const hookFn = vi.fn();
    const client: ModelClient = {
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
    const config = createConfig({ client, betweenTurns: hookFn });

    await runAgentLoop(config, vi.fn(), vi.fn());

    expect(hookFn).not.toHaveBeenCalled();
  });

  it('mutations from hook affect subsequent API calls', async () => {
    let callCount = 0;
    const streamSpy = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return TOOL_USE_RESULT;
      return END_TURN_RESULT;
    });

    const client: ModelClient = {
      stream: streamSpy,
      create: vi.fn(async () => END_TURN_RESULT),
      capabilities: {
        hasNativeContextEditing: false,
        hasNativeCompaction: false,
        cacheStrategy: 'none' as const,
        cacheHeuristicTtlMs: 0,
        supportsImageContent: () => false,
      },
    };

    // Hook adds a synthetic message
    const hookFn = vi.fn((messages: any[]) => {
      messages.push({ role: 'user', content: 'injected by hook' });
    });

    const config = createConfig({ client, betweenTurns: hookFn });
    const executeTool = vi.fn(async () => ({ output: 'ok', isError: false }));

    await runAgentLoop(config, executeTool, vi.fn());

    // Second stream call should receive messages including the injected one
    const secondCallMessages = (streamSpy.mock.calls[1] as unknown as [{ messages: Array<{ content: string }> }])[0].messages;
    const hasInjected = secondCallMessages.some(
      (m: any) => m.content === 'injected by hook',
    );
    expect(hasInjected).toBe(true);
  });
});

describe('onIterationEnd hook', () => {
  it('fires once per agent-loop iteration after tool results settle', async () => {
    const onIterationEnd = vi.fn();
    let callCount = 0;
    const streamSpy = vi.fn(async () => {
      callCount++;
      if (callCount <= 2) return TOOL_USE_RESULT;
      return END_TURN_RESULT;
    });
    const client: ModelClient = {
      stream: streamSpy,
      create: vi.fn(async () => END_TURN_RESULT),
      capabilities: {
        hasNativeContextEditing: false,
        hasNativeCompaction: false,
        cacheStrategy: 'none' as const,
        cacheHeuristicTtlMs: 0,
        supportsImageContent: () => false,
      },
    };
    const config = createConfig({ client, onIterationEnd });
    const executeTool = vi.fn(async () => ({ output: 'ok', isError: false }));

    await runAgentLoop(config, executeTool, vi.fn());

    // Two iterations had tool uses → two onIterationEnd fires.
    // Final iteration ended with end_turn → no fire (no tool execution boundary).
    expect(onIterationEnd).toHaveBeenCalledTimes(2);
  });

  it('is not called when there are no tool uses', async () => {
    const onIterationEnd = vi.fn();
    const client: ModelClient = {
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
    const config = createConfig({ client, onIterationEnd });

    await runAgentLoop(config, vi.fn(), vi.fn());

    expect(onIterationEnd).not.toHaveBeenCalled();
  });

  it('errors are non-fatal — loop continues without warning event', async () => {
    const onIterationEnd = vi.fn().mockImplementation(() => {
      throw new Error('flush failed');
    });
    const config = createConfig({ onIterationEnd });
    const executeTool = vi.fn(async () => ({ output: 'ok', isError: false }));
    const events: RebelCoreEvent[] = [];
    const onEvent = vi.fn((e: RebelCoreEvent) => events.push(e));

    const result = await runAgentLoop(config, executeTool, onEvent);

    expect(result.turns).toBe(2);
    // No `warning` event for onIterationEnd failures (they're observability hooks,
    // not user-visible state-mutators like betweenTurns) — only logged.
    const warnings = events.filter((e) => e.type === 'warning');
    expect(warnings).toHaveLength(0);
  });

  it('fires after betweenTurns within the same iteration', async () => {
    const callOrder: string[] = [];
    const betweenTurns = vi.fn(() => {
      callOrder.push('betweenTurns');
    });
    const onIterationEnd = vi.fn(() => {
      callOrder.push('onIterationEnd');
    });
    const config = createConfig({ betweenTurns, onIterationEnd });
    const executeTool = vi.fn(async () => ({ output: 'ok', isError: false }));

    await runAgentLoop(config, executeTool, vi.fn());

    expect(callOrder).toEqual(['betweenTurns', 'onIterationEnd']);
  });
});
