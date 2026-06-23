import { describe, expect, it } from 'vitest';
import { createAgentMessageAdapter } from '../agentMessageAdapter';

describe('RebelCoreAgentMessageAdapter tool_result image content', () => {
  const makeAdapter = () =>
    createAgentMessageAdapter({
      model: 'claude-sonnet-4-20250514',
      tools: ['Read', 'Bash', 'Agent'],
      sessionId: 'test-session',
      cwd: '/tmp',
    });

  it('handleEvent maps tool_use:result imageContent into tool_result content array', () => {
    const adapter = makeAdapter();

    const messages = adapter.handleEvent({
      type: 'tool_use:result',
      toolUseId: 'tu-1',
      output: 'saved image',
      isError: false,
      imageContent: [{ type: 'image', data: 'abc123', mimeType: 'image/png' }],
    });

    expect(messages).toHaveLength(1);
    const messageObj = (messages[0] as Record<string, unknown>).message as Record<string, unknown>;
    const toolResult = (messageObj.content as Array<Record<string, unknown>>)[0];
    expect(toolResult.type).toBe('tool_result');
    expect(Array.isArray(toolResult.content)).toBe(true);
    expect(toolResult.content).toEqual([
      { type: 'text', text: 'saved image' },
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ]);
  });

  it('handleSubAgentEvent maps tool_use:result imageContent into tool_result content array', () => {
    const adapter = makeAdapter();

    const messages = adapter.handleSubAgentEvent(
      {
        type: 'tool_use:result',
        toolUseId: 'child-tu-1',
        output: 'saved image',
        isError: false,
        imageContent: [{ type: 'image', data: 'abc123', mimeType: 'image/png' }],
      },
      'parent-tu-1',
    );

    expect(messages).toHaveLength(1);
    const messageObj = (messages[0] as Record<string, unknown>).message as Record<string, unknown>;
    const toolResult = (messageObj.content as Array<Record<string, unknown>>)[0];
    expect(toolResult.type).toBe('tool_result');
    expect(Array.isArray(toolResult.content)).toBe(true);
    expect(toolResult.content).toEqual([
      { type: 'text', text: 'saved image' },
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ]);
  });
});
