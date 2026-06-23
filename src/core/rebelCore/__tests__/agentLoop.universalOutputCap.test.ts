import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ContentBlock } from '../modelTypes';
import type { ModelClient } from '../modelClient';
import type { ProviderCapabilities } from '../contextPolicy';
import type { ExecuteToolFn, RebelCoreEvent, ToolExecutionResult } from '../types';
import { CONTENT_REF_THRESHOLD_BYTES } from '@core/contentStore';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
}));

const mockPeekCloudCapabilities = vi.hoisted(() => vi.fn<() => readonly string[] | null>());
const mockMaterializeContentRefsForEvent = vi.hoisted(() => vi.fn());

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => mockLog),
  logger: mockLog,
}));

vi.mock('@core/cloudCapabilityProbe', () => ({
  peekCloudCapabilities: mockPeekCloudCapabilities,
}));

vi.mock('@core/services/contentMaterialization', () => ({
  materializeContentRefsForEvent: mockMaterializeContentRefsForEvent,
}));

import {
  runAgentLoop,
  boundToolOutputForSafety,
  UNIVERSAL_TOOL_OUTPUT_CAP_BYTES,
} from '../agentLoop';

const TEST_CAPABILITIES: ProviderCapabilities = {
  hasNativeContextEditing: false,
  hasNativeCompaction: false,
  cacheStrategy: 'none',
  cacheHeuristicTtlMs: 0,
  supportsImageContent: () => false,
};

// A client that asks for one Read tool call, then ends. We capture the messages
// passed to the SECOND stream() call — that is the request the model sees AFTER
// the tool result has been appended, i.e. the model-facing tool_result content.
interface ChatMessageLike {
  role: string;
  content: unknown;
}

function makeToolUseClient(): {
  client: ModelClient;
  getSecondCallMessages: () => ChatMessageLike[];
} {
  let secondCallArgs: unknown;
  const stream = vi
    .fn()
    .mockImplementationOnce(async () => ({
      content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'file.txt' } }] as ContentBlock[],
      stopReason: 'tool_use',
      usage: { inputTokens: 1_000, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0 },
    }))
    .mockImplementationOnce(async (args: unknown) => {
      secondCallArgs = args;
      return {
        content: [{ type: 'text', text: 'Done' }] as ContentBlock[],
        stopReason: 'end_turn',
        usage: { inputTokens: 1_000, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0 },
      };
    });
  const client: ModelClient = {
    create: vi.fn(),
    stream,
    capabilities: TEST_CAPABILITIES,
  };
  return {
    client,
    getSecondCallMessages: () => {
      const a = secondCallArgs as { messages?: unknown } | undefined;
      return (Array.isArray(a?.messages) ? a!.messages : []) as ChatMessageLike[];
    },
  };
}

// Extract the text of the tool_result block (tool-1) from the model-facing
// messages sent to the provider on the second turn.
function getModelFacingToolResultText(messages: ChatMessageLike[]): string {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && block.tool_use_id === 'tool-1') {
        const content = block.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .filter((b: Record<string, unknown>) => b.type === 'text')
            .map((b: Record<string, unknown>) => String(b.text))
            .join('\n');
        }
      }
    }
  }
  return '';
}

async function runWithToolResult(result: ToolExecutionResult): Promise<{
  events: RebelCoreEvent[];
  modelFacingText: string;
}> {
  const { client, getSecondCallMessages } = makeToolUseClient();
  const executeTool: ExecuteToolFn = vi.fn(async () => result);
  const events: RebelCoreEvent[] = [];

  await runAgentLoop(
    {
      client,
      model: unsafeAssertRoutingModelId('test-model'),
      systemPrompt: 'Test.',
      messages: [{ role: 'user', content: 'Read the file' }],
      tools: [{ name: 'Read', description: 'Read file', input_schema: { type: 'object', properties: {} } }],
      maxTokens: 256,
      sessionId: 'sess-1',
      turnId: 'turn-1',
    },
    executeTool,
    (event) => events.push(event),
  );

  return {
    events,
    modelFacingText: getModelFacingToolResultText(getSecondCallMessages() as ChatMessageLike[]),
  };
}

function getResultEvent(events: RebelCoreEvent[]) {
  return events.find(
    (event): event is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => event.type === 'tool_use:result',
  );
}

describe('boundToolOutputForSafety (Stage 1 unit)', () => {
  it('passes through output under the cap unchanged', () => {
    const small = 'hello world';
    const out = boundToolOutputForSafety(small, false);
    expect(out.truncated).toBe(false);
    expect(out.output).toBe(small);
    expect(out.originalBytes).toBe(Buffer.byteLength(small, 'utf8'));
  });

  it('truncates oversized output to <= cap with a note and original size', () => {
    const big = 'A'.repeat(CONTENT_REF_THRESHOLD_BYTES + 50_000);
    const out = boundToolOutputForSafety(big, false);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.output, 'utf8')).toBeLessThanOrEqual(UNIVERSAL_TOOL_OUTPUT_CAP_BYTES);
    expect(out.output).toContain('[output truncated:');
    expect(out.output).toContain(`of ${out.originalBytes} total`);
    expect(out.originalBytes).toBe(Buffer.byteLength(big, 'utf8'));
  });

  it('does NOT re-wrap already-materialised output', () => {
    const big = 'A'.repeat(CONTENT_REF_THRESHOLD_BYTES + 50_000);
    const out = boundToolOutputForSafety(big, /* materialized */ true);
    expect(out.truncated).toBe(false);
    expect(out.output).toBe(big);
  });

  it('does not split a multi-byte UTF-8 character at the boundary', () => {
    // Each '😀' is 4 UTF-8 bytes. Build an oversized run of emoji so the cut
    // point lands inside a multi-byte sequence with high probability.
    const emoji = '😀';
    const count = Math.ceil((CONTENT_REF_THRESHOLD_BYTES + 10_000) / Buffer.byteLength(emoji, 'utf8'));
    const big = emoji.repeat(count);
    const out = boundToolOutputForSafety(big, false);
    expect(out.truncated).toBe(true);
    // Round-tripping through Buffer must not introduce the U+FFFD replacement
    // char, which is what a split surrogate/continuation byte would produce.
    expect(out.output).not.toContain('�');
    // The preview portion (everything before the note) must be whole emoji.
    const previewPortion = out.output.slice(0, out.output.indexOf('\n\n[output truncated:'));
    expect(Buffer.from(previewPortion, 'utf8').toString('utf8')).toBe(previewPortion);
  });
});

describe('runAgentLoop universal output cap (Stage 1 behavioral)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPeekCloudCapabilities.mockReturnValue([]);
  });

  it('bounds BOTH model-facing content AND emitted event for a >cap non-Bash output', async () => {
    const big = 'B'.repeat(CONTENT_REF_THRESHOLD_BYTES + 100_000);
    const { events, modelFacingText } = await runWithToolResult({ output: big, isError: false });

    // Model-facing content is bounded + carries the note.
    expect(Buffer.byteLength(modelFacingText, 'utf8')).toBeLessThanOrEqual(UNIVERSAL_TOOL_OUTPUT_CAP_BYTES);
    expect(modelFacingText).toContain('[output truncated:');

    // Emitted/persisted event output is bounded too (can't re-enter messages).
    const resultEvent = getResultEvent(events);
    expect(resultEvent).toBeDefined();
    expect(Buffer.byteLength(resultEvent!.output, 'utf8')).toBeLessThanOrEqual(UNIVERSAL_TOOL_OUTPUT_CAP_BYTES);
    expect(resultEvent!.output).toContain('[output truncated:');

    // Original size is recorded for compaction/context accounting.
    expect(resultEvent!.outputChars).toBe(big.length);
  });

  it('the exact bug shape: a ~9MB output yields a tiny model-facing payload', async () => {
    const NINE_MB = 9 * 1024 * 1024;
    const huge = 'x'.repeat(NINE_MB);
    const { events, modelFacingText } = await runWithToolResult({ output: huge, isError: false });

    expect(Buffer.byteLength(modelFacingText, 'utf8')).toBeLessThanOrEqual(UNIVERSAL_TOOL_OUTPUT_CAP_BYTES);
    // Tiny relative to the original — not megabytes.
    expect(Buffer.byteLength(modelFacingText, 'utf8')).toBeLessThan(NINE_MB / 10);
    const resultEvent = getResultEvent(events);
    expect(Buffer.byteLength(resultEvent!.output, 'utf8')).toBeLessThanOrEqual(UNIVERSAL_TOOL_OUTPUT_CAP_BYTES);
    // content-ref must NOT be used as the cap mechanism.
    expect(mockMaterializeContentRefsForEvent).not.toHaveBeenCalled();
  });

  it('passes through output UNDER the cap unchanged (model + event)', async () => {
    const small = 'just a normal tool result';
    const { events, modelFacingText } = await runWithToolResult({ output: small, isError: false });

    expect(modelFacingText).toBe(small);
    const resultEvent = getResultEvent(events);
    expect(resultEvent!.output).toBe(small);
    expect(resultEvent!.output).not.toContain('[output truncated:');
  });

  it('does NOT re-wrap a materialized (Bash-style) result even if it were large', async () => {
    // Simulate a tool that has already materialised: marker set, output is a
    // bounded preview. The cap must leave it exactly as-is.
    const preview = 'Command exited with status 0. Stdout (first 2048 chars):\n...preview...\n[output truncated — full 9999999 chars saved to .rebel/tool-outputs/x.txt]';
    const { events, modelFacingText } = await runWithToolResult({
      output: preview,
      isError: false,
      outputChars: 9_999_999,
      materialized: true,
    });

    expect(modelFacingText).toBe(preview);
    const resultEvent = getResultEvent(events);
    expect(resultEvent!.output).toBe(preview);
    // The original-size accounting from the tool is preserved.
    expect(resultEvent!.outputChars).toBe(9_999_999);
  });
});
