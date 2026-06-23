import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ContentBlock } from '../modelTypes';
import type { ModelClient } from '../modelClient';
import type { ProviderCapabilities } from '../contextPolicy';
import type { ExecuteToolFn, RebelCoreEvent } from '../types';
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

import { runAgentLoop } from '../agentLoop';

const TEST_CAPABILITIES: ProviderCapabilities = {
  hasNativeContextEditing: false,
  hasNativeCompaction: false,
  cacheStrategy: 'none',
  cacheHeuristicTtlMs: 0,
  supportsImageContent: () => false,
};

function makeToolUseClient(): ModelClient {
  return {
    create: vi.fn(),
    stream: vi.fn()
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'file.txt' } }] as ContentBlock[],
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
}

describe('runAgentLoop contentRef producer gating (Stage B1a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPeekCloudCapabilities.mockReturnValue([]);
  });

  // Stage 1 (260529_guard-large-tool-outputs) supersedes the content-ref
  // producer path for FRESH tool outputs: the universal output cap in
  // executeToolUse runs BEFORE the content-ref block at the SAME 200 KiB
  // threshold, so an oversized fresh output is byte-bounded before the
  // content-ref machinery ever sees it. The old behaviour (keep raw oversized
  // bytes inline + emit a capability-fallback log) is gone — we now never keep
  // raw oversized bytes inline at all. No content_ref is produced for capped
  // output, so there is nothing for translators to hydrate back. See
  // docs/plans/260529_guard-large-tool-outputs/PLAN.md § Stage 1.
  it('bounds oversized fresh output before content-ref; no contentRef, no raw inline', async () => {
    const executeTool: ExecuteToolFn = vi.fn(async () => ({
      output: 'x'.repeat(CONTENT_REF_THRESHOLD_BYTES + 1),
      isError: false,
    }));
    const events: RebelCoreEvent[] = [];

    await runAgentLoop(
      {
        client: makeToolUseClient(),
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

    const resultEvent = events.find(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => event.type === 'tool_use:result',
    );
    // No content_ref: Stage 1 already shrank the output, so the content-ref
    // producer never engages.
    expect(resultEvent?.contentRef).toBeUndefined();
    expect(mockMaterializeContentRefsForEvent).not.toHaveBeenCalled();
    // Emitted/persisted event output is bounded (not the raw oversized bytes).
    expect(Buffer.byteLength(resultEvent?.output ?? '', 'utf8')).toBeLessThanOrEqual(CONTENT_REF_THRESHOLD_BYTES);
    expect(resultEvent?.output).toContain('[output truncated:');
    // Stage 1 emitted its truncation log for this fresh oversized output.
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ capBytes: CONTENT_REF_THRESHOLD_BYTES }),
      'tool-output:universal-cap:truncated',
    );
  });

  it('normalizes nullish tool output before measuring output length', async () => {
    const executeTool = vi.fn(async () => ({
      output: undefined,
      isError: false,
    })) as unknown as ExecuteToolFn;
    const events: RebelCoreEvent[] = [];

    await runAgentLoop(
      {
        client: makeToolUseClient(),
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

    const resultEvent = events.find(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => event.type === 'tool_use:result',
    );
    expect(resultEvent?.output).toBe('');
  });
});
