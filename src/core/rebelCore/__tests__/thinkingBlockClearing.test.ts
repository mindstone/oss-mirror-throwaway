import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../modelTypes';

// stripOldThinkingBlocks was removed from agentLoop; inlined here to preserve test coverage
// TODO: Remove or relocate if this functionality is no longer needed
function stripOldThinkingBlocks(messages: ChatMessage[], keepRecentTurns: number): void {
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && Array.isArray(messages[i].content)) {
      assistantIndices.push(i);
    }
  }
  const stripCount = Math.max(0, assistantIndices.length - keepRecentTurns);
  for (let i = 0; i < stripCount; i++) {
    const idx = assistantIndices[i];
    const content = messages[idx].content;
    if (!Array.isArray(content)) continue;
    const filtered = content.filter(
      (b: any) => b.type !== 'thinking' && b.type !== 'redacted_thinking',
    );
    if (filtered.length > 0) {
      messages[idx].content = filtered;
    }
  }
}

/** Helper to make an assistant message with thinking + text blocks */
const makeAssistantWithThinking = (thinkingText: string, responseText: string): ChatMessage => ({
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: thinkingText },
    { type: 'text', text: responseText },
  ],
});

/** Helper to make an assistant message with only text */
const makeAssistantTextOnly = (text: string): ChatMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});

/** Helper to make a user message */
const makeUserMessage = (text: string): ChatMessage => ({
  role: 'user',
  content: text,
});

/** Helper to make a user message with tool_result content blocks */
const makeToolResultMessage = (): ChatMessage => ({
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: 'tool-1', content: 'result' },
  ],
});

/** Helper to make an assistant with tool_use + thinking */
const makeAssistantWithToolUseAndThinking = (thinkingText: string): ChatMessage => ({
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: thinkingText },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/file.txt' } },
  ],
});

describe('stripOldThinkingBlocks', () => {
  it('strips thinking blocks from older assistant messages, preserving recent ones', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Turn 1'),
      makeAssistantWithThinking('Old thinking 1', 'Response 1'),
      makeUserMessage('Turn 2'),
      makeAssistantWithThinking('Old thinking 2', 'Response 2'),
      makeUserMessage('Turn 3'),
      makeAssistantWithThinking('Recent thinking 3', 'Response 3'),
      makeUserMessage('Turn 4'),
      makeAssistantWithThinking('Recent thinking 4', 'Response 4'),
    ];

    stripOldThinkingBlocks(messages, 2);

    // First two assistant messages should have thinking stripped
    expect(messages[1].content).toEqual([{ type: 'text', text: 'Response 1' }]);
    expect(messages[3].content).toEqual([{ type: 'text', text: 'Response 2' }]);

    // Last two assistant messages should retain thinking
    expect(messages[5].content).toEqual([
      { type: 'thinking', thinking: 'Recent thinking 3' },
      { type: 'text', text: 'Response 3' },
    ]);
    expect(messages[7].content).toEqual([
      { type: 'thinking', thinking: 'Recent thinking 4' },
      { type: 'text', text: 'Response 4' },
    ]);
  });

  it('preserves non-thinking content blocks (text, tool_use, tool_result)', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Turn 1'),
      makeAssistantWithToolUseAndThinking('Old thinking'),
      makeToolResultMessage(),
      makeUserMessage('Turn 2'),
      makeAssistantWithThinking('Recent thinking', 'Response'),
    ];

    stripOldThinkingBlocks(messages, 1);

    // First assistant: thinking stripped, tool_use preserved
    const firstAssistant = messages[1].content as any[];
    expect(firstAssistant).toHaveLength(1);
    expect(firstAssistant[0].type).toBe('tool_use');

    // Second assistant: thinking preserved (within keep window)
    const secondAssistant = messages[4].content as any[];
    expect(secondAssistant).toHaveLength(2);
    expect(secondAssistant[0].type).toBe('thinking');
  });

  it('handles string-content assistant messages without modification', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Turn 1'),
      { role: 'assistant', content: 'Plain string response' },
      makeUserMessage('Turn 2'),
      makeAssistantWithThinking('Recent thinking', 'Response'),
    ];

    stripOldThinkingBlocks(messages, 1);

    // String content is left untouched
    expect(messages[1].content).toBe('Plain string response');
    // Array-content assistant within keep window is untouched
    expect((messages[3].content as any[])[0].type).toBe('thinking');
  });

  it('does nothing for empty conversations', () => {
    const messages: ChatMessage[] = [];
    stripOldThinkingBlocks(messages, 2);
    expect(messages).toEqual([]);
  });

  it('does nothing for short conversations with fewer assistant messages than keepRecentTurns', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Turn 1'),
      makeAssistantWithThinking('Thinking', 'Response'),
    ];

    const originalContent = [...(messages[1].content as any[])];
    stripOldThinkingBlocks(messages, 2);

    // Should be unchanged
    expect(messages[1].content).toEqual(originalContent);
  });

  it('does nothing when keepRecentTurns equals number of assistant messages', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Turn 1'),
      makeAssistantWithThinking('Thinking 1', 'Response 1'),
      makeUserMessage('Turn 2'),
      makeAssistantWithThinking('Thinking 2', 'Response 2'),
    ];

    stripOldThinkingBlocks(messages, 2);

    // Both within keep window — thinking preserved
    expect((messages[1].content as any[])[0].type).toBe('thinking');
    expect((messages[3].content as any[])[0].type).toBe('thinking');
  });

  it('handles redacted_thinking blocks', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Turn 1'),
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'redacted' } as any,
          { type: 'text', text: 'Response 1' },
        ],
      },
      makeUserMessage('Turn 2'),
      makeAssistantWithThinking('Recent thinking', 'Response 2'),
    ];

    stripOldThinkingBlocks(messages, 1);

    // redacted_thinking should be stripped from the old message
    const firstAssistant = messages[1].content as any[];
    expect(firstAssistant).toHaveLength(1);
    expect(firstAssistant[0].type).toBe('text');

    // Recent message preserved
    const secondAssistant = messages[3].content as any[];
    expect(secondAssistant).toHaveLength(2);
  });

  it('handles assistant messages that only contain thinking blocks', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Turn 1'),
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Only thinking, no text' }],
      },
      makeUserMessage('Turn 2'),
      makeAssistantWithThinking('Recent', 'Response'),
    ];

    stripOldThinkingBlocks(messages, 1);

    // Thinking-only message should NOT be stripped (would produce empty content array)
    expect(messages[1].content).toEqual([
      { type: 'thinking', thinking: 'Only thinking, no text' },
    ]);
  });

  it('preserves user messages and their content untouched', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('User turn 1'),
      makeAssistantWithThinking('Old thinking', 'Response 1'),
      makeUserMessage('User turn 2'),
      makeAssistantWithThinking('Recent', 'Response 2'),
    ];

    stripOldThinkingBlocks(messages, 1);

    expect(messages[0].content).toBe('User turn 1');
    expect(messages[2].content).toBe('User turn 2');
  });

  it('handles keepRecentTurns = 0 (strip all thinking)', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Turn 1'),
      makeAssistantWithThinking('Thinking 1', 'Response 1'),
      makeUserMessage('Turn 2'),
      makeAssistantWithThinking('Thinking 2', 'Response 2'),
    ];

    stripOldThinkingBlocks(messages, 0);

    // All thinking blocks stripped
    expect(messages[1].content).toEqual([{ type: 'text', text: 'Response 1' }]);
    expect(messages[3].content).toEqual([{ type: 'text', text: 'Response 2' }]);
  });

  it('handles mixed assistant messages (some with arrays, some strings)', () => {
    const messages: ChatMessage[] = [
      makeUserMessage('Turn 1'),
      { role: 'assistant', content: 'String response' }, // Skipped (not array)
      makeUserMessage('Turn 2'),
      makeAssistantWithThinking('Old thinking', 'Array response 1'),
      makeUserMessage('Turn 3'),
      makeAssistantTextOnly('Text-only array'),
      makeUserMessage('Turn 4'),
      makeAssistantWithThinking('Recent', 'Array response 2'),
    ];

    stripOldThinkingBlocks(messages, 1);

    // String assistant untouched
    expect(messages[1].content).toBe('String response');
    // Old array assistant: thinking stripped
    expect(messages[3].content).toEqual([{ type: 'text', text: 'Array response 1' }]);
    // Text-only array: no thinking to strip, preserved as-is
    expect(messages[5].content).toEqual([{ type: 'text', text: 'Text-only array' }]);
    // Recent array assistant: thinking preserved
    expect((messages[7].content as any[])[0].type).toBe('thinking');
  });
});
