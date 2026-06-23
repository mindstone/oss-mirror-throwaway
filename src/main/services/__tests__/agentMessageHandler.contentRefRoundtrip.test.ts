import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@core/agentRuntimeTypes';
import { createAgentMessageAdapter } from '@core/rebelCore/agentMessageAdapter';
import type { RebelCoreEvent } from '@core/rebelCore/types';
import type { ContentRef } from '@shared/types';
import { collectToolHints } from '../agentMessageHandler';

const TEST_CONTENT_REF: ContentRef = {
  contentId: 'abcdef0123456789abcdef0123456789',
  mimeType: 'text/plain',
  byteSize: 250_000,
  uploadStatus: 'pending',
};

const getToolResultBlock = (message: AgentMessage): Record<string, unknown> => {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('Expected message content array');
  }
  const first = content[0];
  if (!first || typeof first !== 'object') {
    throw new Error('Expected tool_result content block');
  }
  return first as Record<string, unknown>;
};

describe('agentMessageAdapter ↔ agentMessageHandler contentRef roundtrip (Stage B1a)', () => {
  it('preserves contentRef from RebelCoreEvent through tool_result content and collectToolHints', () => {
    const adapter = createAgentMessageAdapter({
      model: 'claude-sonnet-4-20250514',
      tools: ['Read'],
      sessionId: 'test-session',
      cwd: '/tmp',
    });

    const event: Extract<RebelCoreEvent, { type: 'tool_use:result' }> = {
      type: 'tool_use:result',
      toolUseId: 'tool-use-1',
      output: 'Huge tool output (truncated summary)…',
      isError: false,
      contentRef: [TEST_CONTENT_REF],
    };

    const [message] = adapter.handleEvent(event);
    expect(message).toBeDefined();

    const toolResultBlock = getToolResultBlock(message);
    expect(toolResultBlock.contentRef).toEqual([TEST_CONTENT_REF]);

    const blocks = toolResultBlock.content as Array<Record<string, unknown>>;
    expect(Array.isArray(blocks)).toBe(true);
    const refBlock = blocks.find((block) => block.type === 'content_ref');
    expect(refBlock).toBeDefined();
    expect(refBlock?.contentRef).toEqual(TEST_CONTENT_REF);

    const toolEnd = collectToolHints(message).find((candidate) => candidate.stage === 'end');
    expect(toolEnd?.contentRef).toEqual([TEST_CONTENT_REF]);
  });

  it('falls back to top-level tool_result contentRef when content blocks do not carry refs', () => {
    const message: AgentMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-use-top-level',
          content: 'Inline summary preserved by producer',
          contentRef: [TEST_CONTENT_REF],
        }],
      },
    } as unknown as AgentMessage;

    const toolEnd = collectToolHints(message).find((candidate) => candidate.stage === 'end');
    expect(toolEnd?.contentRef).toEqual([TEST_CONTENT_REF]);
  });

  it('preserves null placeholders before content_ref blocks in tool_result content', () => {
    const message: AgentMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-use-positional',
          content: [
            { type: 'text', text: 'inline prefix' },
            { type: 'content_ref', contentRef: TEST_CONTENT_REF, summary: 'large block summary' },
          ],
        }],
      },
    } as unknown as AgentMessage;

    const toolEnd = collectToolHints(message).find((candidate) => candidate.stage === 'end');
    expect(toolEnd?.contentRef).toEqual([null, TEST_CONTENT_REF]);
  });

  it('emits no contentRef when neither block-level nor top-level refs exist', () => {
    const message: AgentMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-use-no-ref',
          content: 'plain inline output',
        }],
      },
    } as unknown as AgentMessage;

    const toolEnd = collectToolHints(message).find((candidate) => candidate.stage === 'end');
    expect(toolEnd?.contentRef).toBeUndefined();
  });
});
