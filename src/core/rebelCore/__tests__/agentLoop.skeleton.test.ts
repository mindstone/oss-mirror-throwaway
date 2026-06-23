import { describe, expect, it } from 'vitest';
import { buildSkeletonMessages } from '../agentLoop';
import { SKELETON_FALLBACK_USER_TEXT } from '../skeletonStripping';
import type { ChatMessage, ContentBlock } from '../modelTypes';

const getArrayBlockTypes = (messages: ChatMessage[]): string[] =>
  messages.flatMap((message) => (
    Array.isArray(message.content)
      ? message.content.map((block) => (block as { type: string }).type)
      : []
  ));

describe('buildSkeletonMessages', () => {
  it('passes through user string text with zero drop counters', () => {
    const input: ChatMessage[] = [{ role: 'user', content: 'Please summarize this.' }];

    const result = buildSkeletonMessages(input);

    expect(result.messages).toEqual(input);
    expect(result.droppedToolResultCount).toBe(0);
    expect(result.droppedToolUseCount).toBe(0);
    expect(result.droppedThinkingCount).toBe(0);
    expect(result.droppedImageCount).toBe(0);
    expect(result.userTextPreserved).toBe(true);
  });

  it('drops user tool_result-only message and counts dropped tool results', () => {
    const input: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tool output' }],
      },
      { role: 'user', content: 'Actual request' },
    ];

    const result = buildSkeletonMessages(input);

    expect(result.droppedToolResultCount).toBe(1);
    expect(result.messages).toEqual([{ role: 'user', content: 'Actual request' }]);
    expect(result.userTextPreserved).toBe(true);
  });

  it('preserves user text blocks and drops tool_result blocks in mixed user content', () => {
    const input: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Keep me' },
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'drop me' },
        ],
      },
    ];

    const result = buildSkeletonMessages(input);

    expect(result.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Keep me' }],
      },
    ]);
    expect(result.droppedToolResultCount).toBe(1);
    expect(result.userTextPreserved).toBe(true);
  });

  it('counts user-side tool_use blocks', () => {
    const input: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'x', name: 'foo', input: {} },
        ],
      },
    ];

    const result = buildSkeletonMessages(input);

    expect(result.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      },
    ]);
    expect(result.droppedToolUseCount).toBe(1);
  });

  it('counts user-side thinking blocks', () => {
    const input: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'thinking', thinking: 'internal' },
        ] as unknown as ContentBlock[],
      },
    ];

    const result = buildSkeletonMessages(input);

    expect(result.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      },
    ]);
    expect(result.droppedThinkingCount).toBe(1);
  });

  it('reduces assistant mixed content to text-only and counts dropped tool_use/thinking', () => {
    const input: ChatMessage[] = [
      { role: 'user', content: 'Prompt' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Answer' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
          { type: 'thinking', thinking: 'internal' },
        ],
      },
    ];

    const result = buildSkeletonMessages(input);

    expect(result.messages).toEqual([
      { role: 'user', content: 'Prompt' },
      { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
    ]);
    expect(result.droppedToolUseCount).toBe(1);
    expect(result.droppedThinkingCount).toBe(1);
  });

  it('drops assistant message that contains only tool_use blocks', () => {
    const input: ChatMessage[] = [
      { role: 'user', content: 'Prompt' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
      },
    ];

    const result = buildSkeletonMessages(input);

    expect(result.messages).toEqual([{ role: 'user', content: 'Prompt' }]);
    expect(result.droppedToolUseCount).toBe(1);
  });

  it('counts dropped assistant image blocks', () => {
    const input: ChatMessage[] = [
      { role: 'user', content: 'Prompt' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Answer' },
          { type: 'image', data: 'abc', mimeType: 'image/png' },
        ] as unknown as ContentBlock[],
      },
    ];

    const result = buildSkeletonMessages(input);

    expect(result.messages).toEqual([
      { role: 'user', content: 'Prompt' },
      { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
    ]);
    expect(result.droppedImageCount).toBe(1);
  });

  it('injects placeholder when no user text survives', () => {
    const input: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tool output 1' }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'tool output 2' }],
      },
    ];

    const result = buildSkeletonMessages(input);

    expect(result.userTextPreserved).toBe(false);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: SKELETON_FALLBACK_USER_TEXT,
    });
    expect(result.droppedToolResultCount).toBe(2);
  });

  it('injects placeholder for an empty input message array', () => {
    const result = buildSkeletonMessages([]);

    expect(result.userTextPreserved).toBe(false);
    expect(result.messages).toEqual([
      {
        role: 'user',
        content: SKELETON_FALLBACK_USER_TEXT,
      },
    ]);
  });

  it('unwraps compaction artifacts in user text', () => {
    const input: ChatMessage[] = [{
      role: 'user',
      content: '[COMPACTION_DEPTH:1] preamble\n=== CONTINUE WITH REQUEST ===\nactual ask',
    }];

    const result = buildSkeletonMessages(input);

    expect(result.messages).toEqual([{ role: 'user', content: 'actual ask' }]);
  });

  it('enforces output invariant: no orphan tool blocks and at least one user text message', () => {
    const input: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] },
          { type: 'text', text: 'Request text' },
        ] as unknown as ContentBlock[],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-2', name: 'Read', input: {} },
          { type: 'redacted_thinking', data: 'x' },
          { type: 'text', text: 'Kept assistant text' },
        ] as unknown as ContentBlock[],
      },
    ];

    const result = buildSkeletonMessages(input);
    const outputBlockTypes = getArrayBlockTypes(result.messages);
    const hasUserText = result.messages.some((message) => {
      if (message.role !== 'user') return false;
      if (typeof message.content === 'string') return message.content.trim().length > 0;
      return message.content.some((block) => block.type === 'text' && block.text.trim().length > 0);
    });

    expect(outputBlockTypes).not.toContain('tool_use');
    expect(outputBlockTypes).not.toContain('tool_result');
    expect(hasUserText).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
