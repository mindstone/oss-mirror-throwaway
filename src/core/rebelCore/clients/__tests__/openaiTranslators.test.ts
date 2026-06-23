import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolDefinition } from '../../modelTypes';
import type { OpenAIMessage, OpenAIResponse, OpenAIStreamChunk } from '../openaiTypes';
import {
  createOpenAIStreamState,
  extractMiniMaxXmlToolCalls,
  extractOpenAITextFields,
  flushLateReasoningBuffer,
  getSystemRole,
  processStreamChunk,
  translateMessagesToOpenAI,
  translateResponseToNeutral,
  translateToolsToOpenAI,
} from '../openaiTranslators';
import { buildUnsendableImageAttachmentPlaceholder } from '@core/utils/fileTypeDetection';

const hasAssistantWithEmptyStringContent = (messages: OpenAIMessage[]): boolean =>
  messages.some((message) =>
    message.role === 'assistant'
    && message.content === ''
    && (!message.tool_calls || message.tool_calls.length === 0));

describe('getSystemRole', () => {
  it('returns "developer" for GPT-5+ models', () => {
    expect(getSystemRole('gpt-5')).toBe('developer');
    expect(getSystemRole('gpt-5.5')).toBe('developer');
    expect(getSystemRole('gpt-5.5-high')).toBe('developer');
  });

  it('returns "developer" for o1/o3/o4 models', () => {
    expect(getSystemRole('o1-preview')).toBe('developer');
    expect(getSystemRole('o3-mini')).toBe('developer');
    expect(getSystemRole('o4-mini')).toBe('developer');
  });

  it('returns "system" for GPT-4 and other models', () => {
    expect(getSystemRole('gpt-4o')).toBe('system');
    expect(getSystemRole('gpt-4-turbo')).toBe('system');
    expect(getSystemRole('llama-3.1-70b')).toBe('system');
    expect(getSystemRole('some-custom-model')).toBe('system');
  });

  it('is case-insensitive', () => {
    expect(getSystemRole('GPT-5.5')).toBe('developer');
    expect(getSystemRole('O1-Preview')).toBe('developer');
  });
});

describe('translateMessagesToOpenAI', () => {
  it('prepends system prompt as a string', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await translateMessagesToOpenAI(messages, { supportsImageContent: true }, 'You are helpful.');
    expect(result[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(result[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('prepends system prompt from structured blocks', async () => {
    const systemPrompt = [
      { type: 'text' as const, text: 'Line one' },
      { type: 'text' as const, text: 'Line two' },
    ];
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await translateMessagesToOpenAI(messages, { supportsImageContent: true }, systemPrompt);
    expect(result[0]).toEqual({ role: 'system', content: 'Line one\nLine two' });
  });

  it('uses developer role for GPT-5+ when model name is provided', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await translateMessagesToOpenAI(messages, { supportsImageContent: true }, 'System', 'gpt-5.5');
    expect(result[0].role).toBe('developer');
  });

  it('skips system message if systemPrompt is empty', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await translateMessagesToOpenAI(messages, { supportsImageContent: true }, undefined);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('translates user text messages', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'First message' },
      { role: 'user', content: 'Second message' },
    ];
    const result = await translateMessagesToOpenAI(messages, { supportsImageContent: true });
    expect(result).toEqual([
      { role: 'user', content: 'First message' },
      { role: 'user', content: 'Second message' },
    ]);
  });

  it('translates assistant messages with tool_use blocks to tool_calls', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me help' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Read',
            input: { path: '/tmp/file.txt' },
          },
        ],
      },
    ];
    const result = await translateMessagesToOpenAI(messages, { supportsImageContent: true });
    expect(result).toEqual([
      {
        role: 'assistant',
        content: 'Let me help',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'Read',
              arguments: JSON.stringify({ path: '/tmp/file.txt' }),
            },
          },
        ],
      },
    ]);
  });

  it('translates tool result messages to tool role messages', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: 'File contents here',
          },
        ],
      },
    ];
    const result = await translateMessagesToOpenAI(messages, { supportsImageContent: true });
    expect(result).toEqual([
      {
        role: 'tool',
        content: 'File contents here',
        tool_call_id: 'call_1',
      },
    ]);
  });

  it('preserves tool_result image blocks as OpenAI image_url content parts', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: 'Screenshot captured.' },
              { type: 'image', data: 'abc123', mimeType: 'image/png' },
            ],
          },
        ],
      },
    ];

    const result = await translateMessagesToOpenAI(messages, { supportsImageContent: true });
    expect(result).toEqual([
      {
        role: 'tool',
        content: 'Screenshot captured.',
        tool_call_id: 'call_1',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Visual output from tool call call_1.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
        ],
      },
    ]);
  });

  it('preserves direct user image attachments as OpenAI image_url content parts', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Did you receive the image too?' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'abc123',
            },
          },
        ] as unknown as ChatMessage['content'],
      },
    ];

    const result = await translateMessagesToOpenAI(messages, { supportsImageContent: true });

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Did you receive the image too?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
        ],
      },
    ]);
  });

  it('preserves interleaved direct user text and image attachment order', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First image:' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'first',
            },
          },
          { type: 'text', text: 'Second image:' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: 'second',
            },
          },
        ] as unknown as ChatMessage['content'],
      },
    ];

    const result = await translateMessagesToOpenAI(messages, { supportsImageContent: true });

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First image:' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,first' } },
          { type: 'text', text: 'Second image:' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,second' } },
        ],
      },
    ]);
  });

  it('substitutes a placeholder for a MALFORMED direct user image block on a vision-capable model (260506 drop shape — Claude stage-4 review F3)', async () => {
    // A `type === 'image'` block that fails the strict base64 shape check
    // (here: url source) bound for a VISION-CAPABLE model used to be silently
    // dropped — the exact 260506_openai_translator_user_image_block_drop
    // postmortem shape, surviving only in this supported+malformed corner.
    // SUBSTITUTE, never drop: the model must learn an attachment existed.
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is the screenshot:' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        ] as unknown as ChatMessage['content'],
      },
    ];

    const result = await translateMessagesToOpenAI(messages, { supportsImageContent: true });

    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is the screenshot:' },
          // Index 0 = first image-typed block, malformed → placeholder…
          { type: 'text', text: buildUnsendableImageAttachmentPlaceholder(0) },
          // …while the well-formed sibling (index 1) is still really sent.
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
        ],
      },
    ]);
  });

  it('never emits assistant messages with empty string content for empty-content inputs', async () => {
    const cases: Array<{
      name: string;
      messages: ChatMessage[];
      systemPrompt?: string;
      expected: OpenAIMessage[];
    }> = [
      {
        name: 'mixed sequence keeps surrounding messages while dropping the empty assistant',
        systemPrompt: 'System',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '' },
          { role: 'user', content: 'still there?' },
        ],
        expected: [
          { role: 'system', content: 'System' },
          { role: 'user', content: 'hi' },
          { role: 'user', content: 'still there?' },
        ],
      },
      {
        name: 'assistant empty string content is dropped',
        messages: [{ role: 'assistant', content: '' }],
        expected: [],
      },
      {
        name: 'assistant empty content-block array is dropped',
        messages: [{ role: 'assistant', content: [] }],
        expected: [],
      },
      {
        name: 'assistant array of empty text blocks is dropped',
        messages: [{
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: '' },
          ],
        }],
        expected: [],
      },
      {
        name: 'assistant whitespace-only string content is preserved by current truthiness semantics',
        messages: [{ role: 'assistant', content: '   \n\t' }],
        expected: [{ role: 'assistant', content: '   \n\t' }],
      },
      {
        name: 'assistant non-empty content is preserved',
        messages: [{ role: 'assistant', content: 'ready' }],
        expected: [{ role: 'assistant', content: 'ready' }],
      },
    ];

    for (const testCase of cases) {
      const result = await translateMessagesToOpenAI(testCase.messages, { supportsImageContent: true }, testCase.systemPrompt);
      expect(
        hasAssistantWithEmptyStringContent(result),
        `${testCase.name}: translated wire messages must not contain empty assistant content`,
      ).toBe(false);
      expect(result, testCase.name).toEqual(testCase.expected);
    }
  });

  it('logs a structured warning only when an empty assistant message is dropped', async () => {
    vi.resetModules();

    const warn = vi.fn();
     
    vi.doMock('@core/logger', () => ({
      createScopedLogger: vi.fn(() => ({ warn })),
    }));

    try {
      const { translateMessagesToOpenAI: translateWithMockLogger } = await import('../openaiTranslators');

      await translateWithMockLogger(
        [{ role: 'assistant', content: '' }],
        { supportsImageContent: true },
        undefined,
        'command-a-03-2025',
      );

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        {
          messageRole: 'assistant',
          dropPath: 'string',
          modelName: 'command-a-03-2025',
        },
        'Dropping empty-content assistant message before OpenAI-compat dispatch',
      );

      warn.mockClear();
      await translateWithMockLogger(
        [{ role: 'assistant', content: 'ready' }],
        { supportsImageContent: true },
        undefined,
        'command-a-03-2025',
      );
      expect(warn).not.toHaveBeenCalled();

      await translateWithMockLogger(
        [{ role: 'assistant', content: [{ type: 'text', text: '' }] }],
        { supportsImageContent: true },
        undefined,
        'command-a-03-2025',
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        {
          messageRole: 'assistant',
          dropPath: 'contentBlocks',
          blockTypes: ['text'],
          modelName: 'command-a-03-2025',
        },
        'Dropping empty-content assistant message before OpenAI-compat dispatch',
      );
    } finally {
      vi.doUnmock('@core/logger');
    }
  });

  it('handles assistant with tool_use blocks but no text', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Write',
            input: { path: '/tmp/out.txt', content: 'hello' },
          },
        ],
      },
    ];
    const result = await translateMessagesToOpenAI(messages, { supportsImageContent: true });
    expect(result[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'Write',
            arguments: JSON.stringify({ path: '/tmp/out.txt', content: 'hello' }),
          },
        },
      ],
    });
  });

  it('emits reasoning_content when supportsReasoningReplay is enabled', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'chain-of-thought' },
          { type: 'text', text: 'Final answer' },
        ],
      },
    ];

    const result = await translateMessagesToOpenAI(messages, { supportsReasoningReplay: true, supportsImageContent: false }, undefined, 'deepseek-v4-flash');
    expect(result).toEqual([
      {
        role: 'assistant',
        content: 'Final answer',
        reasoning_content: 'chain-of-thought',
      },
    ]);
  });

  it('coalesces thinking_delta blocks into one reasoning_content string', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking_delta', thinking: 'part-1 ' },
          { type: 'thinking_delta', thinking: 'part-2' },
          { type: 'text', text: 'answer' },
        ] as unknown as ChatMessage['content'],
      },
    ];

    const result = await translateMessagesToOpenAI(messages, { supportsReasoningReplay: true, supportsImageContent: false }, undefined, 'deepseek-v4-flash');
    expect(result[0]).toMatchObject({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'part-1 part-2',
    });
  });

  it('does not emit reasoning_content when capability flag is disabled', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning' },
          { type: 'text', text: 'answer' },
        ],
      },
    ];

    const result = await translateMessagesToOpenAI(messages, { supportsReasoningReplay: false, supportsImageContent: true }, undefined, 'gpt-4o-mini');
    expect(result).toEqual([
      {
        role: 'assistant',
        content: 'answer',
      },
    ]);
  });

  it('does not emit empty reasoning_content when no thinking blocks exist', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'plain' }],
      },
    ];

    const result = await translateMessagesToOpenAI(messages, { supportsReasoningReplay: true, supportsImageContent: false }, undefined, 'deepseek-v4-flash');
    expect(result[0]).toEqual({ role: 'assistant', content: 'plain' });
    expect('reasoning_content' in result[0]).toBe(false);
  });
});

describe('translateToolsToOpenAI', () => {
  it('converts ToolDefinition[] to OpenAI function format', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ];
    const result = translateToolsToOpenAI(tools);
    expect(result).toEqual([
      {
        type: 'function',
        function: {
          name: 'Read',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ]);
  });

  it('returns undefined for empty tools', () => {
    expect(translateToolsToOpenAI([])).toBeUndefined();
    expect(translateToolsToOpenAI(undefined)).toBeUndefined();
  });
});

describe('translateResponseToNeutral', () => {
  const makeResponse = (overrides: Partial<OpenAIResponse['choices'][0]['message']> = {}): OpenAIResponse => ({
    id: 'resp-1',
    object: 'chat.completion',
    created: Date.now(),
    model: 'gpt-5.5',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello there', ...overrides },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  it('converts text content', () => {
    const result = translateResponseToNeutral(makeResponse(), 'gpt-5.5');
    expect(result.content).toEqual([{ type: 'text', text: 'Hello there' }]);
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });

  it('strips think tags from text content', () => {
    const result = translateResponseToNeutral(
      makeResponse({ content: '<think>Hidden reasoning</think>\nClean answer' }),
      'minimax/minimax-m2.7',
    );
    expect(result.content).toEqual([{ type: 'text', text: 'Clean answer' }]);
  });

  it('keeps reasoning_content as thinking while stripping think tags from text content', () => {
    const result = translateResponseToNeutral(
      makeResponse({
        reasoning_content: 'Provider reasoning field',
        content: '<think>Duplicate hidden reasoning</think>\nClean answer',
      }),
      'deepseek/deepseek-r1',
    );
    expect(result.content).toEqual([
      { type: 'thinking', thinking: 'Provider reasoning field' },
      { type: 'text', text: 'Clean answer' },
    ]);
  });

  it('converts tool calls to ToolUseBlock[]', () => {
    const result = translateResponseToNeutral(
      makeResponse({
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{"path":"/tmp/test"}' },
          },
        ],
      }),
      'gpt-5.5',
    );
    expect(result.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'Read',
        input: { path: '/tmp/test' },
      },
    ]);
    expect(result.stopReason).toBe('end_turn');
  });

  it('maps tool_calls finish_reason to tool_use', () => {
    const response = makeResponse({ content: null });
    response.choices[0].finish_reason = 'tool_calls';
    const result = translateResponseToNeutral(response, 'gpt-5.5');
    expect(result.stopReason).toBe('tool_use');
  });

  it('converts reasoning content to ThinkingBlock', () => {
    const result = translateResponseToNeutral(
      makeResponse({ reasoning_content: 'Let me think...' }),
      'gpt-5.5',
    );
    expect(result.content[0]).toEqual({ type: 'thinking', thinking: 'Let me think...' });
    expect(result.content[1]).toEqual({ type: 'text', text: 'Hello there' });
  });

  it('throws on empty response choices', () => {
    const response: OpenAIResponse = {
      id: 'resp-1',
      object: 'chat.completion',
      created: Date.now(),
      model: 'gpt-5.5',
      choices: [],
    };
    expect(() => translateResponseToNeutral(response, 'gpt-5.5')).toThrow('No response choices');
  });

  it('handles missing usage gracefully', () => {
    const response = makeResponse();
    delete response.usage;
    const result = translateResponseToNeutral(response, 'gpt-5.5');
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
  });

  it('extracts prompt_tokens_details.cached_tokens into cacheReadTokens', () => {
    const response = makeResponse();
    response.usage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 80 },
    };
    const result = translateResponseToNeutral(response, 'gpt-5.5');
    expect(result.usage.cacheReadTokens).toBe(80);
    expect(result.usage.cacheCreationTokens).toBe(0);
    expect(result.usage.inputTokens).toBe(100);
  });

  it('defaults cacheReadTokens to 0 when prompt_tokens_details is absent', () => {
    const response = makeResponse();
    response.usage = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 };
    const result = translateResponseToNeutral(response, 'gpt-5.5');
    expect(result.usage.cacheReadTokens).toBe(0);
  });

  it('extracts MiniMax XML tool calls from text and overrides stopReason', () => {
    const response = makeResponse({
      content: '<minimax:tool_call>\n<invoke name="mcp__router__use_tool"><parameter name="package_id">TestPkg</parameter></invoke>\n</minimax:tool_call>',
    });
    const result = translateResponseToNeutral(response, 'minimax/minimax-m2.7');
    expect(result.stopReason).toBe('tool_use');
    const tools = result.content.filter((b) => b.type === 'tool_use');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: 'tool_use',
      name: 'mcp__router__use_tool',
      input: { package_id: 'TestPkg' },
    });
  });
});

describe('processStreamChunk', () => {
  const makeChunk = (
    delta: Record<string, unknown>,
    finishReason: 'stop' | 'tool_calls' | 'length' | null = null,
  ): OpenAIStreamChunk => ({
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: Date.now(),
    model: 'gpt-5.5',
    choices: [
      {
        index: 0,
        delta: delta as OpenAIStreamChunk['choices'][0]['delta'],
        finish_reason: finishReason,
      },
    ],
  });

  it('emits text_delta events', () => {
    const state = createOpenAIStreamState();
    const events = processStreamChunk(makeChunk({ content: 'Hello' }), state);
    expect(events).toEqual([{ type: 'text_delta', text: 'Hello' }]);
    expect(state.content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('accumulates text across chunks', () => {
    const state = createOpenAIStreamState();
    processStreamChunk(makeChunk({ content: 'Hello ' }), state);
    processStreamChunk(makeChunk({ content: 'world' }), state);
    expect(state.content).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('emits thinking_delta events', () => {
    const state = createOpenAIStreamState();
    const events = processStreamChunk(makeChunk({ reasoning_content: 'Thinking...' }), state);
    expect(events).toEqual([{ type: 'thinking_delta', thinking: 'Thinking...' }]);
    expect(state.content).toEqual([{ type: 'thinking', thinking: 'Thinking...' }]);
  });

  it('handles tool call streaming', () => {
    const state = createOpenAIStreamState();
    processStreamChunk(
      makeChunk({
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '' } },
        ],
      }),
      state,
    );
    processStreamChunk(
      makeChunk({
        tool_calls: [{ index: 0, function: { arguments: '{"path"' } }],
      }),
      state,
    );
    processStreamChunk(
      makeChunk({
        tool_calls: [{ index: 0, function: { arguments: ':"/tmp/f"}' } }],
      }),
      state,
    );

    expect(state.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: '/tmp/f' } },
    ]);
  });

  it('OR-accumulates thought-signature presence flags across deltas (diagnostic; value never extracted)', () => {
    const FAKE_SIG = 'FAKE-STREAM-SIGNATURE-MUST-NOT-LEAK';
    const state = createOpenAIStreamState();
    // First delta opens the tool-call and carries litellm's provider_specific_fields.
    processStreamChunk(
      makeChunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '' },
            provider_specific_fields: { thought_signature: FAKE_SIG },
          },
        ],
      }),
      state,
    );
    // A later delta (no id) carries Google's extra_content convention.
    processStreamChunk(
      makeChunk({
        tool_calls: [
          {
            index: 0,
            function: { arguments: '{}' },
            extra_content: { google: { thought_signature: FAKE_SIG } },
          },
        ],
      }),
      state,
    );

    const callState = state.toolCalls.get(0);
    expect(callState?.sawProviderSpecificFields).toBe(true);
    expect(callState?.sawExtraContent).toBe(true);
    // The signature VALUE must never be stored on the stream state.
    expect(JSON.stringify(state)).not.toContain(FAKE_SIG);
  });

  it('preserves accumulated flags/args/name when the real id arrives AFTER a fallback (F1)', () => {
    // F1 regression: a signature-bearing delta with NO id opens a fallback-id
    // state; the real id arrives in a later delta. The state machine must UPGRADE
    // the fallback id in place — NOT replace the state — or the accumulated
    // sawProviderSpecificFields / arguments / name would be lost (pre-F1 bug).
    const state = createOpenAIStreamState();
    // Delta 1: no id; carries the signature + name + partial args.
    processStreamChunk(
      makeChunk({
        tool_calls: [
          {
            index: 0,
            type: 'function',
            function: { name: 'health_check', arguments: '{"a"' },
            provider_specific_fields: { thought_signature: 'FAKE-SIG-VALUE' },
          },
        ],
      }),
      state,
    );
    // Delta 2: the REAL id arrives, plus the rest of the args.
    processStreamChunk(
      makeChunk({
        tool_calls: [{ index: 0, id: 'call_real_99', function: { arguments: ':1}' } }],
      }),
      state,
    );

    // Exactly one tool-call state at this index (not replaced/duplicated).
    expect(state.toolCalls.size).toBe(1);
    const callState = state.toolCalls.get(0);
    expect(callState?.id).toBe('call_real_99'); // upgraded in place
    expect(callState?.name).toBe('health_check'); // preserved
    expect(callState?.arguments).toBe('{"a":1}'); // accumulated across both deltas
    expect(callState?.sawProviderSpecificFields).toBe(true); // PRESERVED (the F1 fix)
    // The content block must carry the upgraded id + assembled input.
    expect(state.content).toEqual([
      { type: 'tool_use', id: 'call_real_99', name: 'health_check', input: { a: 1 } },
    ]);
  });

  it('leaves signature flags false for a plain GPT-style streamed tool call', () => {
    const state = createOpenAIStreamState();
    processStreamChunk(
      makeChunk({
        tool_calls: [
          { index: 0, id: 'call_abc123', type: 'function', function: { name: 'Read', arguments: '{}' } },
        ],
      }),
      state,
    );
    const callState = state.toolCalls.get(0);
    expect(callState?.sawProviderSpecificFields).toBe(false);
    expect(callState?.sawExtraContent).toBe(false);
  });

  it('sets stop reason on finish', () => {
    const state = createOpenAIStreamState();
    processStreamChunk(makeChunk({ content: 'Done' }, 'stop'), state);
    expect(state.stopReason).toBe('end_turn');
  });

  it('tracks usage when present', () => {
    const state = createOpenAIStreamState();
    const chunk = makeChunk({});
    chunk.usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    processStreamChunk(chunk, state);
    expect(state.usage.inputTokens).toBe(10);
    expect(state.usage.outputTokens).toBe(5);
  });

  it('filters garbage text deltas', () => {
    const state = createOpenAIStreamState();
    const events = processStreamChunk(makeChunk({ content: '(no content)' }), state);
    expect(events).toEqual([]);
    expect(state.content).toEqual([]);
  });

  it('accumulates cacheReadTokens from usage chunk with prompt_tokens_details', () => {
    const state = createOpenAIStreamState();
    const chunk = makeChunk({});
    chunk.usage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 80 },
    };
    processStreamChunk(chunk, state);
    expect(state.usage.cacheReadTokens).toBe(80);
    expect(state.usage.inputTokens).toBe(100);
  });

  it('defaults cacheReadTokens to 0 when prompt_tokens_details is absent in stream', () => {
    const state = createOpenAIStreamState();
    const chunk = makeChunk({});
    chunk.usage = { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 };
    processStreamChunk(chunk, state);
    expect(state.usage.cacheReadTokens).toBe(0);
  });

  it('buffers post-finish reasoning and flushes it on stream close', () => {
    const state = createOpenAIStreamState();
    processStreamChunk(makeChunk({ content: 'done' }, 'stop'), state);

    const bufferedEvents = processStreamChunk(makeChunk({ reasoning_content: 'late-think' }), state);
    expect(bufferedEvents).toEqual([]);

    const flushed = flushLateReasoningBuffer(state);
    expect(flushed).toEqual([{ type: 'thinking_delta', thinking: 'late-think' }]);
    expect(state.content[state.content.length - 1]).toEqual({ type: 'thinking', thinking: 'late-think' });
  });

  it('emits degraded-status when byte cap is hit', () => {
    const state = createOpenAIStreamState();
    processStreamChunk(makeChunk({ content: 'done' }, 'stop'), state);
    processStreamChunk(makeChunk({ reasoning_content: 'x'.repeat(300_000) }), state);

    const flushed = flushLateReasoningBuffer(state);
    expect(flushed[0]).toEqual({
      type: 'degraded-status',
      reason: 'late-reasoning-buffer-cap',
      cap: 'bytes',
    });
    expect(flushed[1]).toEqual({ type: 'thinking_delta', thinking: 'x'.repeat(300_000) });
  });

  it('emits degraded-status when chunk cap is hit', () => {
    const state = createOpenAIStreamState();
    processStreamChunk(makeChunk({ content: 'done' }, 'stop'), state);
    for (let i = 0; i < 1000; i += 1) {
      processStreamChunk(makeChunk({ reasoning_content: 'z' }), state);
    }

    const flushed = flushLateReasoningBuffer(state);
    expect(flushed[0]).toEqual({
      type: 'degraded-status',
      reason: 'late-reasoning-buffer-cap',
      cap: 'chunks',
    });
    expect(flushed[1]).toEqual({ type: 'thinking_delta', thinking: 'z'.repeat(1000) });
  });

  it('emits degraded-status when time cap is hit', () => {
    const state = createOpenAIStreamState();
    state.lateReasoningBuffer = 'late';
    state.lateReasoningBufferedBytes = 4;
    state.lateReasoningBufferedChunks = 1;
    state.lateReasoningCapHit = 'time';

    const flushed = flushLateReasoningBuffer(state);
    expect(flushed[0]).toEqual({
      type: 'degraded-status',
      reason: 'late-reasoning-buffer-cap',
      cap: 'time',
    });
    expect(flushed[1]).toEqual({ type: 'thinking_delta', thinking: 'late' });
  });
});

describe('extractMiniMaxXmlToolCalls', () => {
  it('extracts a single tool call from text', () => {
    const content = [
      {
        type: 'text' as const,
        text: '<minimax:tool_call>\n<invoke name="get_weather"><parameter name="city">London</parameter></invoke>\n</minimax:tool_call>',
      },
    ];
    const result = extractMiniMaxXmlToolCalls(content, 'msg1');
    expect(result.hadXmlToolCalls).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'get_weather',
      input: { city: 'London' },
    });
  });

  it('preserves text before and after XML', () => {
    const content = [
      {
        type: 'text' as const,
        text: 'Let me check the weather.\n<minimax:tool_call>\n<invoke name="get_weather"><parameter name="city">Tokyo</parameter></invoke>\n</minimax:tool_call>\nDone.',
      },
    ];
    const result = extractMiniMaxXmlToolCalls(content);
    expect(result.hadXmlToolCalls).toBe(true);
    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'Let me check the weather.' });
    expect(result.content[1]).toMatchObject({ type: 'tool_use', name: 'get_weather' });
    expect(result.content[2]).toMatchObject({ type: 'text', text: 'Done.' });
  });

  it('handles multiple invoke blocks in one tool_call', () => {
    const content = [
      {
        type: 'text' as const,
        text: '<minimax:tool_call>\n<invoke name="search_web"><parameter name="query">OpenAI</parameter></invoke>\n<invoke name="search_web"><parameter name="query">Gemini</parameter></invoke>\n</minimax:tool_call>',
      },
    ];
    const result = extractMiniMaxXmlToolCalls(content, 'msg2');
    expect(result.hadXmlToolCalls).toBe(true);
    const tools = result.content.filter((b) => b.type === 'tool_use');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'search_web', input: { query: 'OpenAI' } });
    expect(tools[1]).toMatchObject({ name: 'search_web', input: { query: 'Gemini' } });
    expect(tools[0].id).not.toBe(tools[1].id);
  });

  it('parses JSON array parameter values', () => {
    const content = [
      {
        type: 'text' as const,
        text: '<minimax:tool_call>\n<invoke name="search"><parameter name="tags">["tech", "ai"]</parameter></invoke>\n</minimax:tool_call>',
      },
    ];
    const result = extractMiniMaxXmlToolCalls(content);
    expect(result.content[0]).toMatchObject({
      type: 'tool_use',
      input: { tags: ['tech', 'ai'] },
    });
  });

  it('parses JSON object parameter values', () => {
    const content = [
      {
        type: 'text' as const,
        text: '<minimax:tool_call>\n<invoke name="configure"><parameter name="config">{"verbose": true, "limit": 10}</parameter></invoke>\n</minimax:tool_call>',
      },
    ];
    const result = extractMiniMaxXmlToolCalls(content);
    expect(result.content[0]).toMatchObject({
      type: 'tool_use',
      input: { config: { verbose: true, limit: 10 } },
    });
  });

  it('parses numeric and boolean parameter values', () => {
    const content = [
      {
        type: 'text' as const,
        text: '<minimax:tool_call>\n<invoke name="set"><parameter name="count">42</parameter><parameter name="verbose">true</parameter><parameter name="label">null</parameter></invoke>\n</minimax:tool_call>',
      },
    ];
    const result = extractMiniMaxXmlToolCalls(content);
    expect(result.content[0]).toMatchObject({
      type: 'tool_use',
      input: { count: 42, verbose: true, label: null },
    });
  });

  it('leaves plain text unchanged when no XML tool calls present', () => {
    const content = [
      { type: 'text' as const, text: 'Just a normal response with no tool calls.' },
    ];
    const result = extractMiniMaxXmlToolCalls(content);
    expect(result.hadXmlToolCalls).toBe(false);
    expect(result.content).toEqual(content);
  });

  it('preserves non-text blocks untouched', () => {
    const content = [
      { type: 'thinking' as const, thinking: 'reasoning...' },
      { type: 'text' as const, text: 'Hello world' },
    ];
    const result = extractMiniMaxXmlToolCalls(content);
    expect(result.hadXmlToolCalls).toBe(false);
    expect(result.content).toEqual(content);
  });

  it('does not duplicate tool_use when native tool_calls already exist', () => {
    const content = [
      {
        type: 'text' as const,
        text: '<minimax:tool_call>\n<invoke name="get_weather"><parameter name="city">Paris</parameter></invoke>\n</minimax:tool_call>',
      },
      {
        type: 'tool_use' as const,
        id: 'call_123',
        name: 'get_weather',
        input: { city: 'Paris' },
      },
    ];
    const result = extractMiniMaxXmlToolCalls(content);
    const tools = result.content.filter((b) => b.type === 'tool_use');
    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe('call_123');
  });

  it('handles incomplete/malformed XML gracefully', () => {
    const content = [
      {
        type: 'text' as const,
        text: '<minimax:tool_call>\n<invoke name="broken">no closing tags',
      },
    ];
    const result = extractMiniMaxXmlToolCalls(content);
    expect(result.hadXmlToolCalls).toBe(false);
    expect(result.content[0]).toMatchObject({ type: 'text' });
  });

  it('generates unique IDs with prefix', () => {
    const content = [
      {
        type: 'text' as const,
        text: '<minimax:tool_call>\n<invoke name="a"><parameter name="x">1</parameter></invoke>\n</minimax:tool_call>\n<minimax:tool_call>\n<invoke name="b"><parameter name="y">2</parameter></invoke>\n</minimax:tool_call>',
      },
    ];
    const result = extractMiniMaxXmlToolCalls(content, 'test_msg');
    const tools = result.content.filter((b) => b.type === 'tool_use');
    expect(tools).toHaveLength(2);
    expect(tools[0].id).toBe('toolu_minimax_test_msg_0');
    expect(tools[1].id).toBe('toolu_minimax_test_msg_1');
  });

  it('handles MCP-routed tool names with double underscores', () => {
    const content = [
      {
        type: 'text' as const,
        text: '<minimax:tool_call>\n<invoke name="mcp__super-mcp-router__use_tool"><parameter name="package_id">RebelMcpConnectors</parameter><parameter name="tool_name">search</parameter></invoke>\n</minimax:tool_call>',
      },
    ];
    const result = extractMiniMaxXmlToolCalls(content);
    expect(result.hadXmlToolCalls).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'mcp__super-mcp-router__use_tool',
      input: { package_id: 'RebelMcpConnectors', tool_name: 'search' },
    });
  });
});

describe('extractOpenAITextFields', () => {
  it('returns content and no reasoning when only content is present', () => {
    const result = extractOpenAITextFields({ content: 'Hello', reasoning_content: null });
    expect(result).toEqual({ text: 'Hello', reasoningText: '', hasReasoningContent: false });
  });

  it('returns both fields when both are present', () => {
    const result = extractOpenAITextFields({ content: 'Answer', reasoning_content: 'Thinking...' });
    expect(result).toEqual({ text: 'Answer', reasoningText: 'Thinking...', hasReasoningContent: true });
  });

  it('returns empty text when content is null', () => {
    const result = extractOpenAITextFields({ content: null, reasoning_content: 'Only reasoning' });
    expect(result).toEqual({ text: '', reasoningText: 'Only reasoning', hasReasoningContent: true });
  });

  it('returns empty strings when both fields are null/undefined', () => {
    const result = extractOpenAITextFields({});
    expect(result).toEqual({ text: '', reasoningText: '', hasReasoningContent: false });
  });

  it('handles undefined reasoning_content', () => {
    const result = extractOpenAITextFields({ content: 'text' });
    expect(result).toEqual({ text: 'text', reasoningText: '', hasReasoningContent: false });
  });
});
