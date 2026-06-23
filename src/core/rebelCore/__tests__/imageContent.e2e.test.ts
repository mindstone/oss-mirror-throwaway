import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
/**
 * End-to-end validation: MCP image content flows from processCallToolResult
 * through agentLoop → agentMessageAdapter → agentMessageHandler extraction.
 *
 * This test exercises the real code at each boundary to confirm that a
 * Super-MCP response with text + image content blocks produces a UI tool
 * event with imageContent set.
 */
import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from '../agentLoop';
import { RebelCoreAgentMessageAdapter } from '../agentMessageAdapter';
import type { ModelClient, StreamResult } from '../modelClient';
import type { ExecuteToolFn, RebelCoreConfig, RebelCoreEvent } from '../types';
import { ZERO_TOKEN_USAGE } from '../types';

// Tiny 1x1 PNG as base64
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const TOOL_USE_RESULT: StreamResult = {
  content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__img-gen__generate', input: { prompt: 'banana' } }],
  stopReason: 'tool_use',
  usage: { ...ZERO_TOKEN_USAGE },
};

const END_TURN_RESULT: StreamResult = {
  content: [{ type: 'text', text: 'Here is your image' }],
  stopReason: 'end_turn',
  usage: { ...ZERO_TOKEN_USAGE },
};

function createMockClient(): ModelClient {
  let callCount = 0;
  return {
    stream: vi.fn(async () => {
      callCount += 1;
      return callCount === 1 ? TOOL_USE_RESULT : END_TURN_RESULT;
    }),
    create: vi.fn(async () => END_TURN_RESULT),
    capabilities: {
      hasNativeContextEditing: false,
      hasNativeCompaction: false,
      cacheStrategy: 'none' as const,
      cacheHeuristicTtlMs: 0,
      supportsImageContent: () => true,
    },
  };
}

describe('Image content E2E pipeline validation', () => {
  it('image blocks flow from executeTool → agentLoop event → adapter → handler-compatible content', async () => {
    // Step 1: executeTool returns imageContent (simulating processCallToolResult output)
    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: '{"status":"materialized","preserved_text":"Saved to: img.png","image_files":[".rebel/tool-outputs/img.png"]}',
      isError: false,
      imageContent: [{ type: 'image' as const, data: TINY_PNG, mimeType: 'image/png' }],
    }));

    // Step 2: agentLoop emits events including tool_use:result with imageContent
    const events: RebelCoreEvent[] = [];
    const config: RebelCoreConfig = {
      client: createMockClient(),
      model: unsafeAssertRoutingModelId('test-model'),
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'generate an image' }],
      tools: [{ name: 'mcp__img-gen__generate', description: 'Image gen', input_schema: { type: 'object', properties: {} } }],
      maxTokens: 1024,
    };

    await runAgentLoop(config, executeTool, (event) => events.push(event));

    const resultEvent = events.find(
      (e): e is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => e.type === 'tool_use:result',
    );
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.imageContent).toHaveLength(1);
    expect(resultEvent!.imageContent![0].mimeType).toBe('image/png');

    // Step 3: adapter converts event to AgentMessage with array content
    const adapter = new RebelCoreAgentMessageAdapter({
      model: unsafeAssertRoutingModelId('test-model'),
      tools: ['mcp__img-gen__generate'],
      sessionId: 'test-session',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      contextWindow: 200000,
      maxOutputTokens: 4096,
    });

    // Feed events through adapter, collect messages (handleEvent returns arrays)
    const messages: unknown[] = [];
    for (const event of events) {
      const msgs = adapter.handleEvent(event);
      if (msgs) messages.push(...msgs);
    }

    // Step 4: Find the tool_result message and verify it has image blocks
    const toolResultMsg = messages.find((m: any) =>
      m?.message?.role === 'user'
      && Array.isArray(m.message.content)
      && m.message.content.some((b: any) => b.type === 'tool_result'),
    ) as any;

    expect(toolResultMsg).toBeDefined();

    const toolResultBlock = toolResultMsg.message.content.find(
      (b: any) => b.type === 'tool_result',
    );
    expect(toolResultBlock).toBeDefined();

    // Content should be an array with text + image blocks
    expect(Array.isArray(toolResultBlock.content)).toBe(true);
    const imageBlock = toolResultBlock.content.find((b: any) => b.type === 'image');
    expect(imageBlock).toBeDefined();
    expect(imageBlock.data).toBe(TINY_PNG);
    expect(imageBlock.mimeType).toBe('image/png');

    // The text part should be the tool output
    const textBlock = toolResultBlock.content.find((b: any) => b.type === 'text');
    expect(textBlock).toBeDefined();
    expect(textBlock.text).toContain('materialized');
  });

  // Stage 2.5 policy reversal:
  // imageContent must now be model-facing so the next API call can see screenshots.
  it('API message history includes image blocks in the next model request', async () => {
    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'Generated image saved',
      isError: false,
      imageContent: [{ type: 'image' as const, data: TINY_PNG, mimeType: 'image/png' }],
    }));

    const client = createMockClient();
    await runAgentLoop(
      {
        client,
        model: unsafeAssertRoutingModelId('test-model'),
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'test' }],
        tools: [{ name: 'mcp__img-gen__generate', description: 'gen', input_schema: { type: 'object', properties: {} } }],
        maxTokens: 1024,
      },
      executeTool,
      vi.fn(),
    );

    // Second API call receives message history with tool_result
    const secondCall = (client.stream as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as any;
    const toolResultMsg = secondCall?.messages?.find((m: any) =>
      m.role === 'user' && Array.isArray(m.content)
      && m.content.some((b: any) => b.type === 'tool_result'),
    );

    const toolResultBlock = toolResultMsg?.content?.find((b: any) => b.type === 'tool_result');
    expect(Array.isArray(toolResultBlock?.content)).toBe(true);
    expect(toolResultBlock?.content).toEqual([
      { type: 'text', text: 'Generated image saved' },
      { type: 'image', data: TINY_PNG, mimeType: 'image/png' },
    ]);
  });
});
