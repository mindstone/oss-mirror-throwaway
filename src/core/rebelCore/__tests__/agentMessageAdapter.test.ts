import { describe, expect, it } from 'vitest';
import { createAgentMessageAdapter } from '../agentMessageAdapter';

describe('RebelCoreAgentMessageAdapter passthrough tool_result fields', () => {
  const makeAdapter = () =>
    createAgentMessageAdapter({
      model: 'claude-sonnet-4-20250514',
      tools: ['mcp__super-mcp-router__use_tool', 'Agent'],
      sessionId: 'test-session',
      cwd: '/tmp',
    });

  const meta = {
    ui: {
      resourceUri: 'ui://google-workspace/compose-email',
      protocolUrl: 'mcp://google-workspace/resources/compose-email',
    },
    superMcp: {
      packageId: 'google-workspace',
      toolId: 'compose_workspace_email',
    },
  };
  const structuredContent = {
    to: ['person@example.com'],
    subject: 'Hello',
    body: 'Draft body.',
  };

  it('handleEvent attaches _meta.ui and structuredContent to emitted tool_result block', () => {
    const adapter = makeAdapter();

    const messages = adapter.handleEvent({
      type: 'tool_use:result',
      toolUseId: 'tu-1',
      output: 'Draft ready',
      isError: false,
      meta,
      structuredContent,
    });

    const messageObj = (messages[0] as Record<string, unknown>).message as Record<string, unknown>;
    const toolResult = (messageObj.content as Array<Record<string, unknown>>)[0];
    expect(toolResult._meta).toBe(meta);
    expect((toolResult._meta as Record<string, unknown>).ui).toBe(meta.ui);
    expect(toolResult.structuredContent).toBe(structuredContent);
  });

  it('handleSubAgentEvent attaches _meta.ui and structuredContent to emitted tool_result block', () => {
    const adapter = makeAdapter();

    const messages = adapter.handleSubAgentEvent(
      {
        type: 'tool_use:result',
        toolUseId: 'child-tu-1',
        output: 'Draft ready',
        isError: false,
        meta,
        structuredContent,
      },
      'parent-tu-1',
    );

    const messageObj = (messages[0] as Record<string, unknown>).message as Record<string, unknown>;
    const toolResult = (messageObj.content as Array<Record<string, unknown>>)[0];
    expect(toolResult._meta).toBe(meta);
    expect((toolResult._meta as Record<string, unknown>).ui).toBe(meta.ui);
    expect(toolResult.structuredContent).toBe(structuredContent);
  });
});

describe('RebelCoreAgentMessageAdapter contentRef propagation (Stage B1a)', () => {
  const makeAdapter = () =>
    createAgentMessageAdapter({
      model: 'claude-sonnet-4-20250514',
      tools: ['mcp__super-mcp-router__use_tool', 'Agent'],
      sessionId: 'test-session',
      cwd: '/tmp',
    });

  const contentRef = {
    contentId: '0123456789abcdef0123456789abcdef',
    mimeType: 'text/plain',
    byteSize: 1024,
  };

  it('emits a content_ref block when contentRef is present on the event', () => {
    const adapter = makeAdapter();

    const messages = adapter.handleEvent({
      type: 'tool_use:result',
      toolUseId: 'tu-1',
      output: 'Inline summary (truncated)…',
      isError: false,
      contentRef: [contentRef],
    });

    const messageObj = (messages[0] as Record<string, unknown>).message as Record<string, unknown>;
    const toolResult = (messageObj.content as Array<Record<string, unknown>>)[0];
    expect(toolResult.contentRef).toEqual([contentRef]);

    const blocks = toolResult.content as Array<Record<string, unknown>>;
    expect(Array.isArray(blocks)).toBe(true);
    const refBlock = blocks.find((block) => block.type === 'content_ref');
    expect(refBlock).toBeDefined();
    expect((refBlock as { contentRef: unknown }).contentRef).toEqual(contentRef);
    expect(typeof (refBlock as { summary?: unknown }).summary).toBe('string');
  });

  it('preserves contentRef positional mapping when only a later slot is offloaded', () => {
    const adapter = makeAdapter();

    const messages = adapter.handleEvent({
      type: 'tool_use:result',
      toolUseId: 'tu-positional',
      output: 'Small inline prefix plus a later large block',
      isError: false,
      contentRef: [null, contentRef],
    });

    const messageObj = (messages[0] as Record<string, unknown>).message as Record<string, unknown>;
    const toolResult = (messageObj.content as Array<Record<string, unknown>>)[0];
    expect(toolResult.contentRef).toEqual([null, contentRef]);

    const blocks = toolResult.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'Small inline prefix plus a later large block' });
    expect(blocks[1]).toMatchObject({
      type: 'content_ref',
      contentRef,
      summary: 'Small inline prefix plus a later large block',
    });
  });

  it('leaves the tool_result.content as the raw output when no contentRef is present', () => {
    const adapter = makeAdapter();

    const messages = adapter.handleEvent({
      type: 'tool_use:result',
      toolUseId: 'tu-2',
      output: 'small output',
      isError: false,
    });

    const messageObj = (messages[0] as Record<string, unknown>).message as Record<string, unknown>;
    const toolResult = (messageObj.content as Array<Record<string, unknown>>)[0];
    expect(toolResult.content).toBe('small output');
    expect(toolResult.contentRef).toBeUndefined();
  });

  it('does not emit a content_ref block when only null entries are present', () => {
    const adapter = makeAdapter();

    const messages = adapter.handleEvent({
      type: 'tool_use:result',
      toolUseId: 'tu-3',
      output: 'fallback inline body',
      isError: false,
      contentRef: [null] as unknown as [typeof contentRef],
    });

    const messageObj = (messages[0] as Record<string, unknown>).message as Record<string, unknown>;
    const toolResult = (messageObj.content as Array<Record<string, unknown>>)[0];
    expect(toolResult.content).toBe('fallback inline body');
  });
});
