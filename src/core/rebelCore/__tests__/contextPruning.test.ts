import { describe, expect, it } from 'vitest';
import { pruneOldToolPairs } from '../contextPruning';
import type { ChatMessage } from '../modelTypes';

/** Helper to build an assistant message with a tool_use block */
const makeToolUseMessage = (
  id: string,
  name = 'Read',
  extraContent?: { type: 'text'; text: string }[],
): ChatMessage => ({
  role: 'assistant',
  content: [
    ...(extraContent ?? []),
    { type: 'tool_use', id, name, input: { path: `/file-${id}.txt` } },
  ],
});

/** Helper to build a user message with a tool_result block */
const makeToolResultMessage = (toolUseId: string, output = 'result'): ChatMessage => ({
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: toolUseId, content: output },
  ],
});

/** Helper: user text message */
const makeUserMessage = (text: string): ChatMessage => ({
  role: 'user',
  content: text,
});

/** Helper: assistant text message */
const makeAssistantMessage = (text: string): ChatMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});

describe('pruneOldToolPairs', () => {
  it('removes oldest pairs when keeping 1 of 3', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Start'),
      makeToolUseMessage('tool-1'),
      makeToolResultMessage('tool-1'),
      makeToolUseMessage('tool-2'),
      makeToolResultMessage('tool-2'),
      makeToolUseMessage('tool-3'),
      makeToolResultMessage('tool-3'),
      makeAssistantMessage('Done'),
    ];

    const removed = pruneOldToolPairs(messages, 1);

    expect(removed).toBe(2);
    // tool-1 and tool-2 messages removed, tool-3 kept
    // Original: 8 messages → 4 messages removed (2 pairs = 4 messages) → 4 remaining
    expect(messages).toHaveLength(4);
    expect(messages[0].content).toBe('Start');

    // tool-3 pair should remain
    const tool3Use = messages.find((m) =>
      Array.isArray(m.content) && m.content.some(
        (b) => b.type === 'tool_use' && b.id === 'tool-3',
      ),
    );
    expect(tool3Use).toBeDefined();

    const tool3Result = messages.find((m) =>
      Array.isArray(m.content) && m.content.some(
        (b) => b.type === 'tool_result' && b.tool_use_id === 'tool-3',
      ),
    );
    expect(tool3Result).toBeDefined();
  });

  it('removes all pairs when keepRecent is 0', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Start'),
      makeToolUseMessage('tool-1'),
      makeToolResultMessage('tool-1'),
      makeToolUseMessage('tool-2'),
      makeToolResultMessage('tool-2'),
      makeAssistantMessage('Done'),
    ];

    const removed = pruneOldToolPairs(messages, 0);

    expect(removed).toBe(2);
    // Only non-tool messages remain
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Start');
    expect((messages[1].content as { type: string }[])[0]).toEqual({ type: 'text', text: 'Done' });
  });

  it('removes none when keepRecent exceeds available pairs', () => {
    const messages: ChatMessage[] = [
      makeToolUseMessage('tool-1'),
      makeToolResultMessage('tool-1'),
      makeToolUseMessage('tool-2'),
      makeToolResultMessage('tool-2'),
    ];

    const removed = pruneOldToolPairs(messages, 10);

    expect(removed).toBe(0);
    expect(messages).toHaveLength(4);
  });

  it('is a no-op when there are no tool pairs', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Hello'),
      makeAssistantMessage('Hi there'),
    ];

    const removed = pruneOldToolPairs(messages, 1);

    expect(removed).toBe(0);
    expect(messages).toHaveLength(2);
  });

  it('is a no-op for empty messages', () => {
    const messages: ChatMessage[] = [];
    const removed = pruneOldToolPairs(messages, 1);
    expect(removed).toBe(0);
  });

  it('preserves orphaned tool_result blocks (no matching tool_use)', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Start'),
      makeToolUseMessage('tool-1'),
      makeToolResultMessage('tool-1'),
      // Orphaned result — no matching tool_use (e.g., from context_management edits)
      makeToolResultMessage('tool-orphan'),
      makeAssistantMessage('Done'),
    ];

    const removed = pruneOldToolPairs(messages, 0);

    // Only tool-1 pair removed; orphaned result preserved
    expect(removed).toBe(1);
    const orphanResult = messages.find((m) =>
      Array.isArray(m.content) && m.content.some(
        (b) => b.type === 'tool_result' && b.tool_use_id === 'tool-orphan',
      ),
    );
    expect(orphanResult).toBeDefined();
  });

  it('preserves text content when tool_use is removed from mixed-content message', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Start'),
      // Assistant message with text AND tool_use
      makeToolUseMessage('tool-1', 'Read', [{ type: 'text', text: 'Let me read that file' }]),
      makeToolResultMessage('tool-1'),
      makeToolUseMessage('tool-2'),
      makeToolResultMessage('tool-2'),
      makeAssistantMessage('Done'),
    ];

    const removed = pruneOldToolPairs(messages, 1);

    expect(removed).toBe(1); // tool-1 pair removed, tool-2 kept

    // The assistant message that had text + tool_use should still have text
    const mixedMessage = messages.find((m) =>
      Array.isArray(m.content) && m.content.some(
        (b) => b.type === 'text' && b.text === 'Let me read that file',
      ),
    );
    expect(mixedMessage).toBeDefined();
    // tool_use should be gone from that message
    const hasToolUse = Array.isArray(mixedMessage!.content) &&
      mixedMessage!.content.some((b) => b.type === 'tool_use' && b.id === 'tool-1');
    expect(hasToolUse).toBe(false);
  });

  it('cleans up empty messages after removal', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Start'),
      makeToolUseMessage('tool-1'), // Will become empty after removal
      makeToolResultMessage('tool-1'), // Will become empty after removal
      makeAssistantMessage('Done'),
    ];

    const removed = pruneOldToolPairs(messages, 0);

    expect(removed).toBe(1);
    // Empty messages should be cleaned up
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Start');
  });

  it('handles multiple tool_use blocks in a single assistant message', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Start'),
      // Single assistant message with two tool_use blocks
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-a', name: 'Read', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'tool-b', name: 'Read', input: { path: 'b.ts' } },
        ],
      },
      // Single user message with two tool_result blocks
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-a', content: 'result-a' },
          { type: 'tool_result', tool_use_id: 'tool-b', content: 'result-b' },
        ],
      },
      makeToolUseMessage('tool-c'),
      makeToolResultMessage('tool-c'),
      makeAssistantMessage('Done'),
    ];

    const removed = pruneOldToolPairs(messages, 1);

    // tool-a and tool-b removed, tool-c kept
    expect(removed).toBe(2);
    // Both blocks removed from assistant message → message is empty → cleaned up
    // Both blocks removed from user message → message is empty → cleaned up
    const remainingToolUse = messages.find((m) =>
      Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use' && b.id === 'tool-c'),
    );
    expect(remainingToolUse).toBeDefined();
  });

  it('returns correct count matching pairs removed', () => {
    const messages: ChatMessage[] = [
      makeToolUseMessage('tool-1'),
      makeToolResultMessage('tool-1'),
      makeToolUseMessage('tool-2'),
      makeToolResultMessage('tool-2'),
      makeToolUseMessage('tool-3'),
      makeToolResultMessage('tool-3'),
      makeToolUseMessage('tool-4'),
      makeToolResultMessage('tool-4'),
      makeToolUseMessage('tool-5'),
      makeToolResultMessage('tool-5'),
    ];

    const removed = pruneOldToolPairs(messages, 2);

    expect(removed).toBe(3); // 5 total - 2 kept = 3 removed
  });

  it('handles string-content messages without error', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      makeToolUseMessage('tool-1'),
      makeToolResultMessage('tool-1'),
    ];

    const removed = pruneOldToolPairs(messages, 0);

    expect(removed).toBe(1);
    // String messages preserved
    expect(messages[0].content).toBe('Hello');
    expect(messages[1].content).toBe('Hi');
  });
});
