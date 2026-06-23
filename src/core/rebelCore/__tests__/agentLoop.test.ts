import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from '../agentLoop';
import type { ModelClient } from '../modelClient';
import type { ContentBlock } from '../modelTypes';
import type { ProviderCapabilities } from '../contextPolicy';
import type { ExecuteToolFn, RebelCoreEvent } from '../types';

const TEST_CAPABILITIES: ProviderCapabilities = {
  hasNativeContextEditing: false,
  hasNativeCompaction: false,
  cacheStrategy: 'none',
  cacheHeuristicTtlMs: 0,
  supportsImageContent: () => false,
};

describe('runAgentLoop model fallback', () => {
  it('uses requested model when provider stream result model is empty string', async () => {
    const requestedModel = unsafeAssertRoutingModelId('gpt-5.3-codex');
    const client: ModelClient = {
      create: vi.fn(),
      stream: vi.fn(async () => ({
        content: [{ type: 'text', text: 'Done' }] as ContentBlock[],
        stopReason: 'end_turn',
        usage: { inputTokens: 1_000, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0 },
        model: '',
      })),
      capabilities: TEST_CAPABILITIES,
    };

    const events: RebelCoreEvent[] = [];
    await runAgentLoop(
      {
        client,
        model: requestedModel,
        systemPrompt: 'Test.',
        messages: [{ role: 'user', content: 'Say hi' }],
        tools: [],
        maxTokens: 256,
      },
      async () => ({ output: 'ok', isError: false }),
      (event) => events.push(event),
    );

    const turnComplete = events.find(
      (event): event is Extract<RebelCoreEvent, { type: 'turn:complete' }> => event.type === 'turn:complete',
    );
    expect(turnComplete).toBeDefined();
    expect(turnComplete?.model).toBe(requestedModel);
  });

  it('preserves provider stream result model when non-empty and different from requested model', async () => {
    const requestedModel = unsafeAssertRoutingModelId('gpt-5.3-codex');
    const streamedModel = 'gpt-5.5';
    const client: ModelClient = {
      create: vi.fn(),
      stream: vi.fn(async () => ({
        content: [{ type: 'text', text: 'Done' }] as ContentBlock[],
        stopReason: 'end_turn',
        usage: { inputTokens: 1_000, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0 },
        model: streamedModel,
      })),
      capabilities: TEST_CAPABILITIES,
    };

    const events: RebelCoreEvent[] = [];
    await runAgentLoop(
      {
        client,
        model: requestedModel,
        systemPrompt: 'Test.',
        messages: [{ role: 'user', content: 'Say hi' }],
        tools: [],
        maxTokens: 256,
      },
      async () => ({ output: 'ok', isError: false }),
      (event) => events.push(event),
    );

    const turnComplete = events.find(
      (event): event is Extract<RebelCoreEvent, { type: 'turn:complete' }> => event.type === 'turn:complete',
    );
    expect(turnComplete).toBeDefined();
    expect(turnComplete?.model).toBe(streamedModel);
  });

  it('emits tool_use:result passthrough fields returned by executeTool', async () => {
    const client: ModelClient = {
      create: vi.fn(),
      stream: vi.fn()
        .mockResolvedValueOnce({
          content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__super-mcp-router__use_tool', input: { q: 'x' } }] as ContentBlock[],
          stopReason: 'tool_use',
          usage: { inputTokens: 1_000, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Done' }] as ContentBlock[],
          stopReason: 'end_turn',
          usage: { inputTokens: 1_000, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0 },
        }),
      capabilities: TEST_CAPABILITIES,
    };
    const meta = { ui: { resourceUri: 'ui://google-workspace/compose-email' }, superMcp: { packageId: 'google-workspace' } };
    const structuredContent = { to: ['person@example.com'], subject: 'Hello', body: 'Draft body.' };
    const imageContent = [{ type: 'image' as const, data: 'abc123', mimeType: 'image/png' }];
    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'Draft ready',
      isError: false,
      outputChars: 123,
      imageContent,
      meta,
      structuredContent,
    }));

    const events: RebelCoreEvent[] = [];
    await runAgentLoop(
      {
        client,
        model: unsafeAssertRoutingModelId('test-model'),
        systemPrompt: 'Test.',
        messages: [{ role: 'user', content: 'Call the tool' }],
        tools: [{ name: 'mcp__super-mcp-router__use_tool', description: 'MCP tool', input_schema: { type: 'object', properties: {} } }],
        maxTokens: 256,
      },
      executeTool,
      (event) => events.push(event),
    );

    const resultEvent = events.find(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => event.type === 'tool_use:result',
    );
    expect(resultEvent).toEqual(expect.objectContaining({
      toolUseId: 'tool-1',
      output: 'Draft ready',
      isError: false,
      outputChars: 123,
      imageContent,
      meta,
      structuredContent,
    }));
  });

  it('uses supportsReasoningReplay opts to control thinking retention between turns', async () => {
    const makeClient = () => {
      const stream = vi.fn()
        .mockResolvedValueOnce({
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/a' } }] as ContentBlock[],
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Done' }] as ContentBlock[],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
        });
      return {
        create: vi.fn(),
        stream,
        capabilities: TEST_CAPABILITIES,
      } as unknown as ModelClient & { stream: ReturnType<typeof vi.fn> };
    };

    const makeInitialHistory = () => ([
      { role: 'user' as const, content: 'u1' },
      { role: 'assistant' as const, content: [{ type: 'thinking', thinking: 'r1' }, { type: 'text', text: 'a1' }] as ContentBlock[] },
      { role: 'user' as const, content: 'u2' },
      { role: 'assistant' as const, content: [{ type: 'thinking', thinking: 'r2' }, { type: 'text', text: 'a2' }] as ContentBlock[] },
      { role: 'user' as const, content: 'u3' },
      { role: 'assistant' as const, content: [{ type: 'thinking', thinking: 'r3' }, { type: 'text', text: 'a3' }] as ContentBlock[] },
    ]);

    const noReplayClient = makeClient();
    await runAgentLoop(
      {
        client: noReplayClient,
        model: unsafeAssertRoutingModelId('test-model'),
        systemPrompt: 'Test.',
        messages: makeInitialHistory(),
        tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object', properties: {} } }],
        maxTokens: 256,
      },
      async () => ({ output: 'ok', isError: false }),
      () => {},
      { supportsReasoningReplay: false },
    );

    const replayClient = makeClient();
    await runAgentLoop(
      {
        client: replayClient,
        model: unsafeAssertRoutingModelId('test-model'),
        systemPrompt: 'Test.',
        messages: makeInitialHistory(),
        tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object', properties: {} } }],
        maxTokens: 256,
      },
      async () => ({ output: 'ok', isError: false }),
      () => {},
      { supportsReasoningReplay: true },
    );

    const noReplaySecondCallMessages = noReplayClient.stream.mock.calls[1][0].messages as Array<{ role: string; content: unknown }>;
    const replaySecondCallMessages = replayClient.stream.mock.calls[1][0].messages as Array<{ role: string; content: unknown }>;

    const countThinkingBlocks = (messages: Array<{ role: string; content: unknown }>) =>
      messages.reduce((count, message) => {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) return count;
        return count + message.content.filter((block: unknown) =>
          typeof block === 'object'
          && block !== null
          && (block as { type?: string }).type === 'thinking').length;
      }, 0);

    expect(countThinkingBlocks(noReplaySecondCallMessages)).toBeLessThan(countThinkingBlocks(replaySecondCallMessages));
  });
});

describe('runAgentLoop refusal terminality (Fable 5 Stage 6)', () => {
  // Lock test (Runtime Safety T3): a refused response carrying tool_use blocks
  // must NEVER have its tools executed — the provider's safety classifier
  // declined to stand behind the response, so acting on it would perform real
  // side-effects on behalf of refused content. The loop must exit BEFORE tool
  // execution and must not re-call the model.
  it('does NOT execute tool_use blocks and exits the loop when stopReason is refusal', async () => {
    const client: ModelClient = {
      create: vi.fn(),
      stream: vi.fn(async () => ({
        content: [
          { type: 'text', text: 'Partial text before the classifier stopped the response' },
          { type: 'tool_use', id: 'tool-refused', name: 'Read', input: { path: '/tmp/a' } },
        ] as ContentBlock[],
        stopReason: 'refusal',
        usage: { inputTokens: 1_000, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        model: 'claude-fable-5',
      })),
      capabilities: TEST_CAPABILITIES,
    };
    const executeTool: ExecuteToolFn = vi.fn(async () => ({ output: 'must never run', isError: false }));

    const events: RebelCoreEvent[] = [];
    await runAgentLoop(
      {
        client,
        model: unsafeAssertRoutingModelId('claude-fable-5'),
        systemPrompt: 'Test.',
        messages: [{ role: 'user', content: 'Do the thing' }],
        tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object', properties: {} } }],
        maxTokens: 256,
      },
      executeTool,
      (event) => events.push(event),
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(client.stream).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'tool_use:start')).toBe(false);
    const turnComplete = events.find(
      (event): event is Extract<RebelCoreEvent, { type: 'turn:complete' }> => event.type === 'turn:complete',
    );
    expect(turnComplete?.stopReason).toBe('refusal');
  });

  // Behavior-preservation counterpart: identical shape with a non-refusal
  // stopReason still executes the tool (the new exit branch fires ONLY on
  // refusal).
  it('still executes tool_use blocks for non-refusal stop reasons', async () => {
    const client: ModelClient = {
      create: vi.fn(),
      stream: vi.fn()
        .mockResolvedValueOnce({
          content: [
            { type: 'tool_use', id: 'tool-ok', name: 'Read', input: { path: '/tmp/a' } },
          ] as ContentBlock[],
          stopReason: 'tool_use',
          usage: { inputTokens: 1_000, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Done' }] as ContentBlock[],
          stopReason: 'end_turn',
          usage: { inputTokens: 1_000, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
        }),
      capabilities: TEST_CAPABILITIES,
    };
    const executeTool: ExecuteToolFn = vi.fn(async () => ({ output: 'ok', isError: false }));

    await runAgentLoop(
      {
        client,
        model: unsafeAssertRoutingModelId('claude-fable-5'),
        systemPrompt: 'Test.',
        messages: [{ role: 'user', content: 'Do the thing' }],
        tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object', properties: {} } }],
        maxTokens: 256,
      },
      executeTool,
      () => {},
    );

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(client.stream).toHaveBeenCalledTimes(2);
  });
});
