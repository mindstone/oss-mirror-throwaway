import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAssetStoreForTesting, setAssetStore } from '@core/assetStore';
import { VISION_UNSUPPORTED_REPORT_INSTRUCTION } from '@core/utils/fileTypeDetection';
import type { AssetStore } from '@core/assetStore';
import { runAgentLoop } from '../agentLoop';
import type { ModelClient, StreamResult } from '../modelClient';
import type { ExecuteToolFn, RebelCoreConfig, RebelCoreEvent } from '../types';
import { ZERO_TOKEN_USAGE } from '../types';

const TOOL_USE_RESULT: StreamResult = {
  content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__super-mcp-router__use_tool', input: { q: 'x' } }],
  stopReason: 'tool_use',
  usage: { ...ZERO_TOKEN_USAGE },
};

const END_TURN_RESULT: StreamResult = {
  content: [{ type: 'text', text: 'Done' }],
  stopReason: 'end_turn',
  usage: { ...ZERO_TOKEN_USAGE },
};

function createMockClient(options?: { supportsImageContent?: boolean }): ModelClient {
  const supportsImageContent = options?.supportsImageContent ?? true;
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
      supportsImageContent: () => supportsImageContent,
    },
  };
}

function createConfig(client: ModelClient): RebelCoreConfig {
  return {
    client,
    model: unsafeAssertRoutingModelId('test-model'),
    systemPrompt: 'You are a test assistant.',
    messages: [{ role: 'user', content: 'test' }],
    tools: [{ name: 'mcp__super-mcp-router__use_tool', description: 'MCP tool', input_schema: { type: 'object', properties: {} } }],
    maxTokens: 1024,
  };
}

function createMockAssetStore(): AssetStore {
  return {
    writeAsset: vi.fn(async ({ assetId, mimeType, bytes }) => ({
      ref: { assetId, mimeType, byteSize: bytes.byteLength },
    })),
    writeThumbnail: vi.fn(async () => undefined),
    generateThumbnail: vi.fn(async () => ({
      bytes: Buffer.from('thumb'),
      mimeType: 'image/png' as const,
    })),
    readAsset: vi.fn(async () => ({ reason: 'not-found' as const })),
    hasAsset: vi.fn(async () => ({ has: false })),
    listSessionAssets: vi.fn(async () => []),
    deleteSession: vi.fn(async () => undefined),
    moveSessionAssetsToDeleted: vi.fn(async () => undefined),
    restoreSessionAssetsFromDeleted: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  resetAssetStoreForTesting();
});

describe('agentLoop image content handling', () => {
  it('emits tool_use:result event with imageContent when tool returns images', async () => {
    const client = createMockClient();
    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'hello',
      isError: false,
      imageContent: [{ type: 'image' as const, data: 'abc123', mimeType: 'image/png' }],
    }));
    const events: RebelCoreEvent[] = [];

    await runAgentLoop(createConfig(client), executeTool, (event) => events.push(event));

    const resultEvent = events.find(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => event.type === 'tool_use:result',
    );
    expect(resultEvent).toBeDefined();
    expect(resultEvent?.imageContent).toEqual([
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ]);
  });

  it('includes image blocks in model-facing tool_result content when provider supports images', async () => {
    const client = createMockClient();
    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'hello',
      isError: false,
      imageContent: [{ type: 'image' as const, data: 'abc123', mimeType: 'image/png' }],
    }));

    await runAgentLoop(createConfig(client), executeTool, vi.fn());

    const secondStreamCall = (client.stream as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as
      | { messages?: Array<{ role: string; content: unknown }> }
      | undefined;
    expect(secondStreamCall?.messages).toBeDefined();

    const toolResultMessage = secondStreamCall?.messages?.find((message) =>
      message.role === 'user'
      && Array.isArray(message.content)
      && (message.content as Array<{ type?: string }>).some((block) => block.type === 'tool_result'),
    );

    expect(toolResultMessage).toBeDefined();
    const toolResultBlock = (toolResultMessage?.content as Array<{
      type: string;
      content: unknown;
      tool_use_id: string;
    }>).find((block) => block.type === 'tool_result');

    expect(toolResultBlock).toBeDefined();
    expect(Array.isArray(toolResultBlock?.content)).toBe(true);
    expect(toolResultBlock?.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ]);
  });

  it('replaces image blocks with text placeholders when provider lacks image support', async () => {
    const client = createMockClient({ supportsImageContent: false });
    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: '{"path":".rebel/screenshots/capture.png","status":"ok"}',
      isError: false,
      imageContent: [{ type: 'image' as const, data: 'abc123', mimeType: 'image/png' }],
    }));

    await runAgentLoop(createConfig(client), executeTool, vi.fn());

    const secondStreamCall = (client.stream as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as
      | { messages?: Array<{ role: string; content: unknown }> }
      | undefined;

    const toolResultMessage = secondStreamCall?.messages?.find((message) =>
      message.role === 'user'
      && Array.isArray(message.content)
      && (message.content as Array<{ type?: string }>).some((block) => block.type === 'tool_result'),
    );

    const toolResultBlock = (toolResultMessage?.content as Array<{
      type: string;
      content: unknown;
    }>).find((block) => block.type === 'tool_result');

    expect(Array.isArray(toolResultBlock?.content)).toBe(true);
    expect(toolResultBlock?.content).toEqual([
      { type: 'text', text: '{"path":".rebel/screenshots/capture.png","status":"ok"}' },
      {
        type: 'text',
        // Suffix asserted via the shared const (not re-inlined) so placeholder
        // copy and test cannot drift apart.
        text: '[Screenshot 1 at .rebel/screenshots/capture.png - vision not supported by the current model; '
          + `use Read with the saved path. ${VISION_UNSUPPORTED_REPORT_INSTRUCTION}]`,
      },
    ]);
  });

  it('attaches imageRef while keeping imageContent on tool_use:result events', async () => {
    const client = createMockClient();
    setAssetStore(createMockAssetStore());

    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'hello',
      isError: false,
      imageContent: [{ type: 'image' as const, data: 'abc123', mimeType: 'image/png' }],
    }));
    const events: RebelCoreEvent[] = [];

    await runAgentLoop(
      {
        ...createConfig(client),
        sessionId: 'session-1',
        turnId: 'turn-1',
        nextToolResultEventSeq: () => 42,
        imageAssetSurface: 'desktop',
      },
      executeTool,
      (event) => events.push(event),
    );

    const resultEvent = events.find(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => event.type === 'tool_use:result',
    );
    expect(resultEvent?.imageContent).toEqual([
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ]);
    expect(resultEvent?.imageRef).toEqual([
      {
        assetId: 'turn-1-42-0',
        mimeType: 'image/png',
        byteSize: Buffer.from('abc123', 'base64').byteLength,
        thumbnailAssetId: 'turn-1-42-0_thumb',
        uploadStatus: 'pending',
      },
    ]);
  });

  it('universal guard: reduces an oversized imageContent from a non-Read tool to a placeholder (vision provider)', async () => {
    // A vision-capable provider, but the inline image block exceeds the
    // provider's base64 limit. The boundary must replace it with a text
    // placeholder regardless of which tool produced it (Stage 4 #2).
    const client = createMockClient({ supportsImageContent: true });
    // base64 string longer than ANTHROPIC_IMAGE_BYTE_LIMIT (5 MiB).
    const oversizedBase64 = 'A'.repeat(5 * 1024 * 1024 + 16);
    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'mcp produced a big image',
      isError: false,
      imageContent: [{ type: 'image' as const, data: oversizedBase64, mimeType: 'image/png' }],
    }));

    await runAgentLoop(createConfig(client), executeTool, vi.fn());

    const secondStreamCall = (client.stream as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as
      | { messages?: Array<{ role: string; content: unknown }> }
      | undefined;
    const toolResultMessage = secondStreamCall?.messages?.find((message) =>
      message.role === 'user'
      && Array.isArray(message.content)
      && (message.content as Array<{ type?: string }>).some((block) => block.type === 'tool_result'),
    );
    const toolResultBlock = (toolResultMessage?.content as Array<{ type: string; content: unknown }>)
      .find((block) => block.type === 'tool_result');
    const blocks = toolResultBlock?.content as Array<{ type: string; text?: string; data?: string }>;

    expect(Array.isArray(blocks)).toBe(true);
    // No image block survived; the oversized base64 is NOT in the request.
    expect(blocks.some((block) => block.type === 'image')).toBe(false);
    const placeholder = blocks.find((block) => block.type === 'text' && /Image 1 omitted/.test(block.text ?? ''));
    expect(placeholder).toBeDefined();
    expect(placeholder?.text).toMatch(/exceeds the/);
    // The megabytes are gone from the model-facing payload.
    const totalChars = blocks.reduce((sum, block) => sum + (block.text?.length ?? 0) + (block.data?.length ?? 0), 0);
    expect(totalChars).toBeLessThan(1024);
  });

  it('universal guard: an in-limit imageContent from a non-Read tool passes through unchanged (vision provider)', async () => {
    const client = createMockClient({ supportsImageContent: true });
    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'small image',
      isError: false,
      imageContent: [{ type: 'image' as const, data: 'c21hbGw=', mimeType: 'image/png' }],
    }));

    await runAgentLoop(createConfig(client), executeTool, vi.fn());

    const secondStreamCall = (client.stream as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as
      | { messages?: Array<{ role: string; content: unknown }> }
      | undefined;
    const toolResultMessage = secondStreamCall?.messages?.find((message) =>
      message.role === 'user'
      && Array.isArray(message.content)
      && (message.content as Array<{ type?: string }>).some((block) => block.type === 'tool_result'),
    );
    const toolResultBlock = (toolResultMessage?.content as Array<{ type: string; content: unknown }>)
      .find((block) => block.type === 'tool_result');
    expect(toolResultBlock?.content).toEqual([
      { type: 'text', text: 'small image' },
      { type: 'image', data: 'c21hbGw=', mimeType: 'image/png' },
    ]);
  });

  it('falls back to imageContent with a null positional imageRef when materialization write fails', async () => {
    const client = createMockClient();
    const assetStore = createMockAssetStore() as AssetStore & {
      writeAsset: ReturnType<typeof vi.fn>;
    };
    assetStore.writeAsset.mockRejectedValue({ code: 'storage-full' });
    setAssetStore(assetStore);

    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'hello',
      isError: false,
      imageContent: [{ type: 'image' as const, data: 'abc123', mimeType: 'image/png' }],
    }));
    const events: RebelCoreEvent[] = [];

    await runAgentLoop(
      {
        ...createConfig(client),
        sessionId: 'session-1',
        turnId: 'turn-1',
        nextToolResultEventSeq: () => 7,
        imageAssetSurface: 'desktop',
      },
      executeTool,
      (event) => events.push(event),
    );

    const resultEvent = events.find(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => event.type === 'tool_use:result',
    );
    expect(resultEvent?.imageContent).toEqual([
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ]);
    expect(resultEvent?.imageRef).toEqual([null]);
  });
});
