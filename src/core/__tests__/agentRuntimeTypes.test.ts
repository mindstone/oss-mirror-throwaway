import { describe, it, expect } from 'vitest';
import { extractAgentAssistantText } from '@core/agentRuntimeTypes';
import type { AgentAssistantMessage } from '@core/agentRuntimeTypes';

/** Helper to build a minimal AgentAssistantMessage shape for testing. */
function makeAgentAssistantMessage(
  content: unknown[]
): AgentAssistantMessage {
  return {
    type: 'assistant',
    message: { content } as AgentAssistantMessage['message'],
    parent_tool_use_id: null,
    uuid: 'test-uuid' as AgentAssistantMessage['uuid'],
    session_id: 'test-session',
  };
}

describe('extractAgentAssistantText', () => {
  it('extracts text from a single text block', () => {
    const msg = makeAgentAssistantMessage([
      { type: 'text', text: 'Hello world' },
    ]);
    expect(extractAgentAssistantText(msg)).toBe('Hello world');
  });

  it('joins multiple text blocks with newlines', () => {
    const msg = makeAgentAssistantMessage([
      { type: 'text', text: 'First paragraph' },
      { type: 'text', text: 'Second paragraph' },
    ]);
    expect(extractAgentAssistantText(msg)).toBe('First paragraph\nSecond paragraph');
  });

  it('returns empty string for empty content array', () => {
    const msg = makeAgentAssistantMessage([]);
    expect(extractAgentAssistantText(msg)).toBe('');
  });

  it('extracts only text blocks from mixed content (text + tool_use)', () => {
    const msg = makeAgentAssistantMessage([
      { type: 'text', text: 'Before tool' },
      { type: 'tool_use', id: 'tool-1', name: 'read', input: {} },
      { type: 'text', text: 'After tool' },
    ]);
    expect(extractAgentAssistantText(msg)).toBe('Before tool\nAfter tool');
  });

  it('returns empty string when message.content is undefined', () => {
    const msg: AgentAssistantMessage = {
      type: 'assistant',
      message: {} as AgentAssistantMessage['message'],
      parent_tool_use_id: null,
      uuid: 'test-uuid' as AgentAssistantMessage['uuid'],
      session_id: 'test-session',
    };
    expect(extractAgentAssistantText(msg)).toBe('');
  });

  it('skips null and non-object entries in content array', () => {
    const msg = makeAgentAssistantMessage([
      null,
      undefined,
      'bare string',
      { type: 'text', text: 'Valid' },
    ]);
    expect(extractAgentAssistantText(msg)).toBe('Valid');
  });

  it('trims leading and trailing whitespace from result', () => {
    const msg = makeAgentAssistantMessage([
      { type: 'text', text: '  padded  ' },
    ]);
    expect(extractAgentAssistantText(msg)).toBe('padded');
  });

  it('skips text blocks where text is not a string', () => {
    const msg = makeAgentAssistantMessage([
      { type: 'text', text: 42 },
      { type: 'text', text: 'Valid text' },
    ]);
    expect(extractAgentAssistantText(msg)).toBe('Valid text');
  });
});
