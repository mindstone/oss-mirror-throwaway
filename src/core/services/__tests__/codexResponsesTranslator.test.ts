import { describe, expect, it, vi } from 'vitest';

// Fail-fast-offline gate (Stage 2 refinement): OpenAIClient.runWithRetry probes
// reachability on the retry path. The retry test below stubs global fetch and
// keys on exact call counts, so stub the probe to "online" (false) so it never
// issues its own corroboration HEADs through the stubbed fetch. Preserve the rest
// of the module (diagnoseTimeout etc.) via importOriginal.
vi.mock('@core/services/timeoutDiagnosticsService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../timeoutDiagnosticsService')>()),
  isMachineOffline: vi.fn(async () => false),
}));

import {
  translateChatToResponses,
  translateResponsesToChatCompletion,
  createStreamTranslator,
  parseSseEventBlock,
  ResponsesApiResponseSchema,
  readResponsesSseToCompletion,
  extractReasoningFromResponsesJson,
  type ChatCompletionRequest,
  type ResponsesApiResponse,
  type SseDiagnostic,
} from '../codexResponsesTranslator';
import { OpenAIClient } from '../../rebelCore/clients/openaiClient';
import { ModelError } from '../../rebelCore/modelErrors';
import { translateResponseToNeutral } from '../../rebelCore/clients/openaiTranslators';
import type { OpenAIResponse } from '../../rebelCore/clients/openaiTypes';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

function makeFullResponsesApiResponse(): ResponsesApiResponse {
  return {
    id: 'resp_test_123',
    object: 'response',
    model: 'gpt-5.5',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello world', annotations: [] }],
      status: 'completed',
    }],
    usage: {
      input_tokens: 100,
      output_tokens: 5,
      total_tokens: 105,
      input_tokens_details: { cached_tokens: 50 },
    },
    status: 'completed',
  };
}

function makeReadableStreamFromString(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function makeStallingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      return new Promise(() => { /* never resolves */ });
    },
  });
}

class TestUpstreamError extends Error {
  constructor(public readonly upstreamStatus: number, public readonly upstreamBody: string) {
    super(`Upstream(${upstreamStatus}): ${upstreamBody}`);
    this.name = 'TestUpstreamError';
  }
}
const throwUpstream = (status: number, body: string) => new TestUpstreamError(status, body);

// ---------------------------------------------------------------------------
// parseSseEventBlock
// ---------------------------------------------------------------------------

describe('parseSseEventBlock', () => {
  it.each([
    ['single line', 'event: response.completed\ndata: {"ok":true}', { event: 'response.completed', data: '{"ok":true}' }],
    ['multi-line data', 'event: response.completed\ndata: {"a":\ndata: 1}', { event: 'response.completed', data: '{"a":\n1}' }],
    ['event-only', 'event: response.completed', null],
    ['data-only', 'data: {"type":"response.completed"}', { event: '', data: '{"type":"response.completed"}' }],
    ['type in payload', 'data: {"type":"response.output_text.delta","delta":"Hi"}', { event: '', data: '{"type":"response.output_text.delta","delta":"Hi"}' }],
    ['blank lines interleaved', '\nevent: response.completed\n\ndata: {"ok":true}\n', { event: 'response.completed', data: '{"ok":true}' }],
    ['comment lines', ': keepalive\nevent: response.completed\n: ignored\ndata: {"ok":true}', { event: 'response.completed', data: '{"ok":true}' }],
    ['CRLF endings', 'event: response.completed\r\ndata: {"ok":true}\r\n', { event: 'response.completed', data: '{"ok":true}' }],
    ['leading whitespace after data colon', 'event: response.completed\ndata:  indented', { event: 'response.completed', data: ' indented' }],
    ['missing data', 'event: response.completed\nid: 1', null],
    ['event double-colon', 'event:: response.completed\ndata: {"ok":true}', { event: ': response.completed', data: '{"ok":true}' }],
    ['literal nested data text', 'event: response.completed\ndata: data: nested', { event: 'response.completed', data: 'data: nested' }],
  ])('%s', (_name, block, expected) => {
    expect(parseSseEventBlock(block)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// translateChatToResponses
// ---------------------------------------------------------------------------

describe('translateChatToResponses', () => {
  it('translates a minimal user-only request', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const result = translateChatToResponses(chat);

    expect(result.model).toBe('gpt-5');
    expect(result.store).toBe(false);
    expect(result.stream).toBe(false);
    expect(result.text).toEqual({ format: { type: 'text' } });
    expect(result.instructions).toBe('You are a helpful assistant.');
    expect(result.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    ]);
  });

  it('preserves user image_url content as input_image parts', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Please inspect this screenshot.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
          ],
        },
      ],
    };

    const result = translateChatToResponses(chat);
    expect(result.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Please inspect this screenshot.' },
          { type: 'input_image', image_url: 'data:image/png;base64,abc123' },
        ],
      },
    ]);
  });

  it('extracts system messages into instructions', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'You are a pirate.' },
        { role: 'user', content: 'Ahoy' },
      ],
    };
    const result = translateChatToResponses(chat);
    expect(result.instructions).toBe('You are a pirate.');
    expect(result.input).toHaveLength(1);
  });

  it('joins multiple system/developer messages with double newline', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'Rule 1' },
        { role: 'developer', content: 'Rule 2' },
        { role: 'system', content: 'Rule 3' },
        { role: 'user', content: 'Go' },
      ],
    };
    const result = translateChatToResponses(chat);
    expect(result.instructions).toBe('Rule 1\n\nRule 2\n\nRule 3');
  });

  it('skips system messages with null content', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [
        { role: 'system', content: null },
        { role: 'user', content: 'Hi' },
      ],
    };
    const result = translateChatToResponses(chat);
    expect(result.instructions).toBe('You are a helpful assistant.');
  });

  it('translates assistant messages to message items', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello there!' },
        { role: 'user', content: 'How are you?' },
      ],
    };
    const result = translateChatToResponses(chat);
    expect(result.input).toHaveLength(3);
    expect(result.input[1]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello there!', annotations: [] }],
      status: 'completed',
    });
  });

  it('translates assistant tool_calls to function_call items', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'Search for cats' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc123',
              type: 'function',
              function: { name: 'web_search', arguments: '{"q":"cats"}' },
            },
          ],
        },
      ],
    };
    const result = translateChatToResponses(chat);
    expect(result.input).toHaveLength(2);
    expect(result.input[1]).toEqual({
      type: 'function_call',
      call_id: 'call_abc123',
      name: 'web_search',
      arguments: '{"q":"cats"}',
      status: 'completed',
    });
  });

  it('translates assistant with both text and tool_calls', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'Find info' },
        {
          role: 'assistant',
          content: 'Let me search.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{}' },
            },
          ],
        },
      ],
    };
    const result = translateChatToResponses(chat);
    // text message + function_call = 3 items (user + message + function_call)
    expect(result.input).toHaveLength(3);
    expect(result.input[1]).toMatchObject({ type: 'message', role: 'assistant' });
    expect(result.input[2]).toMatchObject({ type: 'function_call', call_id: 'call_1' });
  });

  it('translates multiple tool_calls on one assistant message', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'Do multiple things' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'fn_a', arguments: '{"x":1}' } },
            { id: 'call_b', type: 'function', function: { name: 'fn_b', arguments: '{"y":2}' } },
          ],
        },
      ],
    };
    const result = translateChatToResponses(chat);
    expect(result.input).toHaveLength(3); // user + 2 function_calls
    expect(result.input[1]).toMatchObject({ type: 'function_call', call_id: 'call_a', name: 'fn_a' });
    expect(result.input[2]).toMatchObject({ type: 'function_call', call_id: 'call_b', name: 'fn_b' });
  });

  it('translates tool result messages to function_call_output items', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'Search' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_x', type: 'function', function: { name: 'search', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'Found 5 results', tool_call_id: 'call_x' },
      ],
    };
    const result = translateChatToResponses(chat);
    expect(result.input[2]).toEqual({
      type: 'function_call_output',
      call_id: 'call_x',
      output: 'Found 5 results',
    });
  });

  it('handles tool message with null content', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_y', type: 'function', function: { name: 'fn', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: null, tool_call_id: 'call_y' },
      ],
    };
    const result = translateChatToResponses(chat);
    const output = result.input.find(
      (i) => 'type' in i && i.type === 'function_call_output',
    );
    expect(output).toMatchObject({ output: '' });
  });

  it('skips tool messages without tool_call_id', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'tool', content: 'orphan result' } as ChatCompletionRequest['messages'][0],
      ],
    };
    const result = translateChatToResponses(chat);
    expect(result.input).toHaveLength(1); // only user
  });

  it('translates tools (unwraps nested function)', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather info',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
    };
    const result = translateChatToResponses(chat);
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather info',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ]);
  });

  it('does NOT forward temperature (Responses-API reasoning models reject it)', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
    };
    expect(translateChatToResponses(chat).temperature).toBeUndefined();
  });

  // Guardrail: the Responses API (Codex passthrough + OpenAI reasoning models) rejects sampling
  // params with HTTP 400. translateChatToResponses is the single Chat→Responses chokepoint, so
  // temperature must NEVER reach the wire from here — regardless of the requested value. This
  // protects every caller on the seam (operator consult, watchdogJudge, hygiene-distillation, etc.).
  it('strips temperature for every requested value (Responses-API contract guardrail)', () => {
    for (const temperature of [0, 0.2, 0.7, 1, 2]) {
      const chat: ChatCompletionRequest = {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature,
      };
      expect(translateChatToResponses(chat).temperature).toBeUndefined();
    }
  });

  it('produces a Responses request with sampling and output-token params stripped by omission', () => {
    const chat = {
      model: 'gpt-5',
      messages: [{ role: 'user' as const, content: 'Hi' }],
      temperature: 0.2,
      top_p: 0.9,
      max_completion_tokens: 4096,
      max_output_tokens: 4096,
      reasoning_effort: 'high',
    } satisfies ChatCompletionRequest & {
      top_p: number;
      max_output_tokens: number;
    };

    const result = translateChatToResponses(chat);

    expect(result).toMatchObject({
      model: 'gpt-5',
      stream: false,
      reasoning: { effort: 'high' },
    });
    expect(result).not.toHaveProperty('temperature');
    expect(result).not.toHaveProperty('top_p');
    expect(result).not.toHaveProperty('max_completion_tokens');
    expect(result).not.toHaveProperty('max_output_tokens');
  });

  it('does NOT forward max_completion_tokens (Codex rejects max_output_tokens)', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      max_completion_tokens: 4096,
    };
    expect(translateChatToResponses(chat).max_output_tokens).toBeUndefined();
  });

  it('maps reasoning_effort to reasoning.effort and requests a summary channel', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning_effort: 'high',
    };
    // summary:'auto' is required so GPT reasoning routes to its own channel and
    // never bleeds into output_text (the root cause of the reasoning-leak bug).
    expect(translateChatToResponses(chat).reasoning).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('passes through stream flag', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    };
    expect(translateChatToResponses(chat).stream).toBe(true);
  });

  it('translates string tool_choice', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: 'auto',
    };
    expect(translateChatToResponses(chat).tool_choice).toBe('auto');
  });

  it('translates object tool_choice (function)', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: { type: 'function', function: { name: 'my_fn' } },
    };
    expect(translateChatToResponses(chat).tool_choice).toEqual({
      type: 'function',
      name: 'my_fn',
    });
  });

  it('omits optional fields when not present', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Hi' }],
    };
    const result = translateChatToResponses(chat);
    expect(result.temperature).toBeUndefined();
    expect(result.max_output_tokens).toBeUndefined();
    expect(result.reasoning).toBeUndefined();
    expect(result.tools).toBeUndefined();
    expect(result.tool_choice).toBeUndefined();
  });

  it('handles empty messages array', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [],
    };
    const result = translateChatToResponses(chat);
    expect(result.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
    ]);
    expect(result.instructions).toBe('You are a helpful assistant.');
  });

  it('adds a minimal input placeholder when only system messages are present', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [{ role: 'system', content: 'Stay concise.' }],
    };
    const result = translateChatToResponses(chat);
    expect(result.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
    ]);
    expect(result.instructions).toBe('Stay concise.');
  });

  it('handles a complex multi-turn conversation', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5.3-codex',
      messages: [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: 'Now search for that.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"4"}' } },
          ],
        },
        { role: 'tool', content: 'Result: number four', tool_call_id: 'call_1' },
        { role: 'assistant', content: 'I found info about the number 4.' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'search',
            description: 'Search the web',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
        },
      ],
      temperature: 0.5,
      stream: true,
    };
    const result = translateChatToResponses(chat);

    expect(result.model).toBe('gpt-5.3-codex');
    expect(result.instructions).toBe('Be helpful.');
    expect(result.stream).toBe(true);
    expect(result.temperature).toBeUndefined(); // sampling params are stripped for the Responses API
    expect(result.input).toHaveLength(6); // user, assistant msg, user, function_call, function_call_output, assistant msg
    expect(result.tools).toHaveLength(1);
  });

  it('handles user message with null content', () => {
    const chat: ChatCompletionRequest = {
      model: 'gpt-5',
      messages: [{ role: 'user', content: null }],
    };
    const result = translateChatToResponses(chat);
    expect(result.input[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'input_text', text: '' }],
    });
  });

  describe('response_format → text.format translation', () => {
    it('forwards json_schema response_format as text.format json_schema', () => {
      const chat: ChatCompletionRequest = {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'plan' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'rebel_plan',
            schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
            strict: true,
          },
        },
      };
      const result = translateChatToResponses(chat);
      expect(result.text).toEqual({
        format: {
          type: 'json_schema',
          name: 'rebel_plan',
          schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
          strict: true,
        },
      });
    });

    it('omits strict when not provided', () => {
      const chat: ChatCompletionRequest = {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'plan' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'rebel_plan',
            schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
          },
        },
      };
      const result = translateChatToResponses(chat);
      expect(result.text).toEqual({
        format: {
          type: 'json_schema',
          name: 'rebel_plan',
          schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
        },
      });
      expect((result.text.format as { strict?: boolean }).strict).toBeUndefined();
    });

    it('defaults to text format when response_format is absent', () => {
      const chat: ChatCompletionRequest = {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      };
      const result = translateChatToResponses(chat);
      expect(result.text).toEqual({ format: { type: 'text' } });
    });

    it('defaults to text format when response_format is { type: "text" }', () => {
      const chat: ChatCompletionRequest = {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'text' },
      };
      const result = translateChatToResponses(chat);
      expect(result.text).toEqual({ format: { type: 'text' } });
    });

    // Regression: response_format: { type: 'json_object' } is the older
    // non-schema "valid JSON anything" mode. The Phase 7 refinement asserts
    // this path is not silently re-broken when the json_schema path was
    // wired up. Today it falls through to { type: 'text' } (the translator
    // does not yet emit Responses API json_object); document and pin that
    // behaviour so a future change has to acknowledge it explicitly.
    it('falls through to text format for response_format json_object (no Responses API translation yet)', () => {
      const chat: ChatCompletionRequest = {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_object' },
      };
      const result = translateChatToResponses(chat);
      // Codex Responses API expects schema-driven structured output; the
      // older json_object mode is not currently translated through. This
      // test pins that behaviour so callers who rely on json_object are
      // not silently surprised by the new json_schema path.
      expect(result.text).toEqual({ format: { type: 'text' } });
    });
  });
});

// ---------------------------------------------------------------------------
// translateResponsesToChatCompletion
// ---------------------------------------------------------------------------

describe('translateResponsesToChatCompletion', () => {
  it('translates a text-only response', () => {
    const resp: ResponsesApiResponse = {
      id: 'resp_abc',
      model: 'gpt-5',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello!', annotations: [] }],
          status: 'completed',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = translateResponsesToChatCompletion(resp);

    expect(result.id).toBe('resp_abc');
    expect(result.object).toBe('chat.completion');
    expect(result.model).toBe('gpt-5');
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].message.content).toBe('Hello!');
    expect(result.choices[0].message.tool_calls).toBeUndefined();
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it('translates a response with function calls', () => {
    const resp: ResponsesApiResponse = {
      id: 'resp_def',
      model: 'gpt-5',
      output: [
        {
          type: 'function_call',
          call_id: 'call_123',
          name: 'get_weather',
          arguments: '{"city":"NYC"}',
          status: 'completed',
        },
      ],
      usage: { input_tokens: 20, output_tokens: 10 },
    };
    const result = translateResponsesToChatCompletion(resp);

    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls).toEqual([
      {
        id: 'call_123',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
      },
    ]);
    expect(result.choices[0].finish_reason).toBe('tool_calls');
  });

  it('translates a response with text and function calls', () => {
    const resp: ResponsesApiResponse = {
      id: 'resp_mixed',
      model: 'gpt-5',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Let me check.', annotations: [] }],
          status: 'completed',
        },
        {
          type: 'function_call',
          call_id: 'call_456',
          name: 'lookup',
          arguments: '{}',
          status: 'completed',
        },
      ],
    };
    const result = translateResponsesToChatCompletion(resp);

    expect(result.choices[0].message.content).toBe('Let me check.');
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].finish_reason).toBe('tool_calls');
  });

  it('handles incomplete status as length finish_reason', () => {
    const resp: ResponsesApiResponse = {
      id: 'resp_inc',
      model: 'gpt-5',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Partial...', annotations: [] }],
          status: 'incomplete',
        },
      ],
      status: 'incomplete',
    };
    const result = translateResponsesToChatCompletion(resp);
    expect(result.choices[0].finish_reason).toBe('length');
  });

  it('handles empty output array', () => {
    const resp: ResponsesApiResponse = {
      id: 'resp_empty',
      model: 'gpt-5',
      output: [],
    };
    const result = translateResponsesToChatCompletion(resp);
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls).toBeUndefined();
    expect(result.choices[0].finish_reason).toBe('stop');
  });

  it('skips non-array message content without throwing', () => {
    const parsed = ResponsesApiResponseSchema.parse({
      id: 'resp_non_array_content',
      model: 'gpt-5',
      output: [{ type: 'message', role: 'assistant', content: 'string-not-array', status: 'completed' }],
    });

    const result = translateResponsesToChatCompletion(parsed);
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].finish_reason).toBe('stop');
  });

  it('handles missing usage gracefully', () => {
    const resp: ResponsesApiResponse = {
      id: 'resp_no_usage',
      model: 'gpt-5',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hi', annotations: [] }],
          status: 'completed',
        },
      ],
    };
    const result = translateResponsesToChatCompletion(resp);
    expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it('uses total_tokens from response when provided', () => {
    const resp: ResponsesApiResponse = {
      id: 'resp_total',
      model: 'gpt-5',
      output: [],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 160 },
    };
    const result = translateResponsesToChatCompletion(resp);
    expect(result.usage.total_tokens).toBe(160);
  });

  it('concatenates text from multiple output_text blocks', () => {
    const resp: ResponsesApiResponse = {
      id: 'resp_multi',
      model: 'gpt-5',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'Hello ', annotations: [] },
            { type: 'output_text', text: 'world!', annotations: [] },
          ],
          status: 'completed',
        },
      ],
    };
    const result = translateResponsesToChatCompletion(resp);
    expect(result.choices[0].message.content).toBe('Hello world!');
  });

  it('handles multiple function calls', () => {
    const resp: ResponsesApiResponse = {
      id: 'resp_multi_fn',
      model: 'gpt-5',
      output: [
        {
          type: 'function_call',
          call_id: 'call_a',
          name: 'fn_a',
          arguments: '{"x":1}',
          status: 'completed',
        },
        {
          type: 'function_call',
          call_id: 'call_b',
          name: 'fn_b',
          arguments: '{"y":2}',
          status: 'completed',
        },
      ],
    };
    const result = translateResponsesToChatCompletion(resp);
    expect(result.choices[0].message.tool_calls).toHaveLength(2);
    expect(result.choices[0].message.tool_calls![0].id).toBe('call_a');
    expect(result.choices[0].message.tool_calls![1].id).toBe('call_b');
  });

  it('passes through input_tokens_details.cached_tokens as prompt_tokens_details.cached_tokens', () => {
    const resp: ResponsesApiResponse = {
      id: 'resp_cache',
      model: 'gpt-5',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hi', annotations: [] }],
          status: 'completed',
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 80 },
      },
    };
    const result = translateResponsesToChatCompletion(resp);
    expect(result.usage.prompt_tokens_details).toEqual({ cached_tokens: 80 });
    expect(result.usage.prompt_tokens).toBe(100);
  });

  it('omits prompt_tokens_details when input_tokens_details is absent', () => {
    const resp: ResponsesApiResponse = {
      id: 'resp_no_cache',
      model: 'gpt-5',
      output: [],
      usage: { input_tokens: 50, output_tokens: 20 },
    };
    const result = translateResponsesToChatCompletion(resp);
    expect(result.usage.prompt_tokens_details).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractReasoningFromResponsesJson
// ---------------------------------------------------------------------------

describe('extractReasoningFromResponsesJson', () => {
  it('returns empty string when output[] has no reasoning items', () => {
    const body: ResponsesApiResponse = {
      id: 'resp_1',
      model: 'gpt-5.5',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
          status: 'completed',
        },
      ],
    };
    expect(extractReasoningFromResponsesJson(body)).toBe('');
  });

  it('extracts summary_text parts from a reasoning item', () => {
    const body = {
      id: 'resp_2',
      model: 'gpt-5.5',
      output: [
        {
          type: 'reasoning',
          id: 'rs_abc',
          summary: [
            { type: 'summary_text', text: 'First thought. ' },
            { type: 'summary_text', text: 'Second thought.' },
          ],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '$0.05', annotations: [] }],
          status: 'completed',
        },
      ],
    } as unknown as ResponsesApiResponse;
    expect(extractReasoningFromResponsesJson(body)).toBe('First thought. Second thought.');
  });

  it('skips non-summary_text parts', () => {
    const body = {
      id: 'resp_3',
      model: 'gpt-5.5',
      output: [
        {
          type: 'reasoning',
          summary: [
            { type: 'unknown_part', text: 'ignored' },
            { type: 'summary_text', text: 'kept' },
          ],
        },
      ],
    } as unknown as ResponsesApiResponse;
    expect(extractReasoningFromResponsesJson(body)).toBe('kept');
  });

  it('handles reasoning items with missing or null summary gracefully', () => {
    const body = {
      id: 'resp_4',
      model: 'gpt-5.5',
      output: [
        { type: 'reasoning', summary: null },
        { type: 'reasoning' }, // no summary field
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok', annotations: [] }],
          status: 'completed',
        },
      ],
    } as unknown as ResponsesApiResponse;
    expect(extractReasoningFromResponsesJson(body)).toBe('');
  });

  it('concatenates reasoning from multiple reasoning items', () => {
    const body = {
      id: 'resp_5',
      model: 'gpt-5.5',
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Part one. ' }],
        },
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Part two.' }],
        },
      ],
    } as unknown as ResponsesApiResponse;
    expect(extractReasoningFromResponsesJson(body)).toBe('Part one. Part two.');
  });

  it('surfaces reasoning_content via translateResponsesToChatCompletion when reasoning is present', () => {
    const body = {
      id: 'resp_6',
      model: 'gpt-5.5',
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Model deliberation.' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The answer is 42.', annotations: [] }],
          status: 'completed',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      status: 'completed',
    } as unknown as ResponsesApiResponse;

    const reasoningContent = extractReasoningFromResponsesJson(body);
    const translated = translateResponsesToChatCompletion(body, { reasoningContent });
    expect(translated.choices[0].message.content).toBe('The answer is 42.');
    expect(translated.choices[0].message.reasoning_content).toBe('Model deliberation.');
  });
});

// ---------------------------------------------------------------------------
// createStreamTranslator
// ---------------------------------------------------------------------------

describe('createStreamTranslator', () => {
  function parseChunks(raw: string): unknown[] {
    return raw
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.replace('data: ', ''))
      .filter((json) => json !== '[DONE]')
      .map((json) => JSON.parse(json));
  }

  it('ignores unknown event types', () => {
    const translator = createStreamTranslator();
    expect(translator.translateEvent('response.output_item.done', {})).toBeNull();
    expect(translator.translateEvent('unknown.event', {})).toBeNull();
  });

  it('captures response metadata from response.created', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.created', {
      id: 'resp_123',
      model: 'gpt-5',
    });
    expect(result).toBeNull(); // metadata only, no chunk emitted

    // Verify metadata used in subsequent chunks
    const textResult = translator.translateEvent('response.output_text.delta', { delta: 'Hi' });
    expect(textResult).toBeTruthy();
    const chunks = parseChunks(textResult!);
    // First chunk is role, second is content
    expect(chunks).toHaveLength(2);
    const roleChunk = chunks[0] as { id: string; model: string };
    expect(roleChunk.id).toBe('resp_123');
    expect(roleChunk.model).toBe('gpt-5');
  });

  it('translates text deltas', () => {
    const translator = createStreamTranslator();
    translator.translateEvent('response.created', { id: 'resp_1', model: 'gpt-5' });

    const result = translator.translateEvent('response.output_text.delta', { delta: 'Hello' });
    expect(result).toBeTruthy();
    const chunks = parseChunks(result!);
    // Initial role + content delta
    expect(chunks).toHaveLength(2);

    const roleChunk = chunks[0] as { choices: Array<{ delta: { role?: string } }> };
    expect(roleChunk.choices[0].delta.role).toBe('assistant');

    const contentChunk = chunks[1] as { choices: Array<{ delta: { content?: string } }> };
    expect(contentChunk.choices[0].delta.content).toBe('Hello');
  });

  it('sends role chunk only once', () => {
    const translator = createStreamTranslator();
    translator.translateEvent('response.created', { id: 'resp_1', model: 'gpt-5' });

    const first = translator.translateEvent('response.output_text.delta', { delta: 'A' });
    const second = translator.translateEvent('response.output_text.delta', { delta: 'B' });

    const firstChunks = parseChunks(first!);
    const secondChunks = parseChunks(second!);

    expect(firstChunks).toHaveLength(2); // role + content
    expect(secondChunks).toHaveLength(1); // content only
  });

  it('skips empty text deltas', () => {
    const translator = createStreamTranslator();
    expect(translator.translateEvent('response.output_text.delta', {})).toBeNull();
    expect(translator.translateEvent('response.output_text.delta', { delta: '' })).toBeNull();
  });

  it('translates function call added events', () => {
    const translator = createStreamTranslator();
    translator.translateEvent('response.created', { id: 'resp_2', model: 'gpt-5' });

    const result = translator.translateEvent('response.output_item.added', {
      item: {
        type: 'function_call',
        id: 'item_abc',
        call_id: 'call_abc',
        name: 'get_weather',
      },
    });

    expect(result).toBeTruthy();
    const chunks = parseChunks(result!);
    // role chunk + tool call chunk
    expect(chunks).toHaveLength(2);

    const tcChunk = chunks[1] as {
      choices: Array<{
        delta: {
          tool_calls?: Array<{
            index: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    expect(tcChunk.choices[0].delta.tool_calls).toHaveLength(1);
    expect(tcChunk.choices[0].delta.tool_calls![0]).toMatchObject({
      index: 0,
      id: 'call_abc',
      type: 'function',
      function: { name: 'get_weather', arguments: '' },
    });
  });

  it('tracks multiple tool calls with correct indices', () => {
    const translator = createStreamTranslator();
    translator.translateEvent('response.created', { id: 'resp_3', model: 'gpt-5' });

    translator.translateEvent('response.output_item.added', {
      item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'fn_a' },
    });
    const second = translator.translateEvent('response.output_item.added', {
      item: { type: 'function_call', id: 'item_2', call_id: 'call_2', name: 'fn_b' },
    });

    const chunks = parseChunks(second!);
    const tcChunk = chunks[0] as {
      choices: Array<{ delta: { tool_calls?: Array<{ index: number }> } }>;
    };
    expect(tcChunk.choices[0].delta.tool_calls![0].index).toBe(1);
  });

  it('ignores non-function_call output_item.added events', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.output_item.added', {
      item: { type: 'message', role: 'assistant' },
    });
    expect(result).toBeNull();
  });

  it('translates function call arguments delta', () => {
    const translator = createStreamTranslator();
    translator.translateEvent('response.created', { id: 'resp_4', model: 'gpt-5' });

    // Add a function call first
    translator.translateEvent('response.output_item.added', {
      item: { type: 'function_call', id: 'item_x', call_id: 'call_x', name: 'fn' },
    });

    const result = translator.translateEvent('response.function_call_arguments.delta', {
      item_id: 'item_x',
      delta: '{"key":',
    });

    expect(result).toBeTruthy();
    const chunks = parseChunks(result!);
    expect(chunks).toHaveLength(1);

    const chunk = chunks[0] as {
      choices: Array<{
        delta: { tool_calls?: Array<{ index: number; function?: { arguments?: string } }> };
      }>;
    };
    expect(chunk.choices[0].delta.tool_calls![0]).toMatchObject({
      index: 0,
      function: { arguments: '{"key":' },
    });
  });

  it('handles arguments delta with unknown item_id gracefully', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.function_call_arguments.delta', {
      item_id: 'unknown_item',
      delta: '"val"}',
    });
    expect(result).toBeTruthy();
    const chunks = parseChunks(result!);
    const chunk = chunks[0] as {
      choices: Array<{
        delta: { tool_calls?: Array<{ index: number }> };
      }>;
    };
    // Falls back to index 0
    expect(chunk.choices[0].delta.tool_calls![0].index).toBe(0);
  });

  it('skips empty arguments delta', () => {
    const translator = createStreamTranslator();
    expect(
      translator.translateEvent('response.function_call_arguments.delta', { delta: '' }),
    ).toBeNull();
  });

  it('translates response.completed with stop finish_reason (text)', () => {
    const translator = createStreamTranslator();
    translator.translateEvent('response.created', { id: 'resp_5', model: 'gpt-5' });
    translator.translateEvent('response.output_text.delta', { delta: 'Done' });

    const result = translator.translateEvent('response.completed', {
      response: {
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    });

    expect(result).toBeTruthy();
    expect(result).toContain('[DONE]');

    const chunks = parseChunks(result!);
    expect(chunks).toHaveLength(1); // final chunk (role already sent)
    const finalChunk = chunks[0] as {
      choices: Array<{ finish_reason: string }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(finalChunk.choices[0].finish_reason).toBe('stop');
    expect(finalChunk.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
  });

  it('translates response.completed with tool_calls finish_reason', () => {
    const translator = createStreamTranslator();
    translator.translateEvent('response.created', { id: 'resp_6', model: 'gpt-5' });

    // Add a function call to mark hasToolCalls
    translator.translateEvent('response.output_item.added', {
      item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'fn' },
    });

    const result = translator.translateEvent('response.completed', { response: {} });
    expect(result).toBeTruthy();
    expect(result).toContain('[DONE]');

    const chunks = parseChunks(result!);
    const finalChunk = chunks[0] as { choices: Array<{ finish_reason: string }> };
    expect(finalChunk.choices[0].finish_reason).toBe('tool_calls');
  });

  it('translates response.completed without usage', () => {
    const translator = createStreamTranslator();
    translator.translateEvent('response.created', { id: 'resp_7', model: 'gpt-5' });
    translator.translateEvent('response.output_text.delta', { delta: 'Hi' });

    const result = translator.translateEvent('response.completed', { response: {} });
    expect(result).toBeTruthy();

    const chunks = parseChunks(result!);
    const finalChunk = chunks[0] as { usage?: unknown };
    expect(finalChunk.usage).toBeUndefined();
  });

  it('emits an error chunk when response.completed carries an upstream error', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.completed', {
      response: {
        status: 'failed',
        error: { message: 'model X not supported', type: 'invalid_request_error' },
      },
    });

    expect(result).toBeTruthy();
    expect(result).not.toContain('[DONE]');
    const parsed = JSON.parse(result!.replace('data: ', '').trim()) as { error: { message: string; type: string } };
    expect(parsed.error).toEqual({
      message: 'Codex completed with failure: model X not supported',
      type: 'server_error',
    });
  });

  it('emits an error chunk when response.completed has a non-success status', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.completed', {
      response: { status: 'cancelled' },
    });

    const parsed = JSON.parse(result!.replace('data: ', '').trim()) as { error: { message: string } };
    expect(parsed.error.message).toBe('Codex completed with failure: Codex returned status: cancelled');
    expect(result).not.toContain('[DONE]');
  });

  it('emits an error chunk for response.incomplete with the upstream reason', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.incomplete', {
      response: { incomplete_details: { reason: 'max_output_tokens' } },
    });

    const parsed = JSON.parse(result!.replace('data: ', '').trim()) as { error: { message: string } };
    expect(parsed.error.message).toBe('Codex completed incomplete: max_output_tokens');
  });

  it('sanitizes and caps opaque streaming error messages', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.failed', {
      response: { error: [{ message: `${'x'.repeat(510)}\u0000\u0001` }] },
    });

    const parsed = JSON.parse(result!.replace('data: ', '').trim()) as { error: { message: string } };
    expect(parsed.error.message).toHaveLength(500);
    expect(parsed.error.message).not.toContain('\u0000');
  });

  it('translates response.failed events', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.failed', {
      response: { error: { message: 'Rate limited' } },
    });

    expect(result).toBeTruthy();
    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error.message).toBe('Rate limited');
    expect(parsed.error.type).toBe('server_error');
  });

  it('translates response.failed with missing error message', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.failed', { response: {} });

    expect(result).toBeTruthy();
    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error.message).toBe('Codex terminal error (eventType=response.failed)');
  });

  it('translates error events', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('error', { message: 'Connection reset' });

    expect(result).toBeTruthy();
    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error.message).toBe('Connection reset');
  });

  it('translates error events with missing message', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('error', {});

    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error.message).toBe('Codex terminal error (eventType=error)');
  });

  it('translates bare error events with nested error message and code', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('error', {
      error: {
        message: 'Nested provider failure',
        type: 'server_error',
        code: 'internal_error',
      },
    });

    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error).toMatchObject({
      message: 'Nested provider failure',
      type: 'server_error',
      code: 'internal_error',
    });
  });

  it('uses an allowlisted descriptor for sparse response.failed upstream payloads', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.failed', {
      response: {
        status: 'failed',
        error: {
          type: 'server_error',
          code: 'internal_error',
          api_key: 'fake-api-secret',
          Authorization: 'Bearer secret',
          user_content: 'please do not leak this user prompt',
        },
      },
    });

    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error).toMatchObject({
      message: 'Codex terminal error (eventType=response.failed, type=server_error, code=internal_error, status=failed)',
      type: 'server_error',
      code: 'internal_error',
      status: 'failed',
    });
    const serialized = JSON.stringify(parsed.error);
    expect(serialized).not.toContain('fake-api-secret');
    expect(serialized).not.toContain('Bearer secret');
    expect(serialized).not.toContain('please do not leak this user prompt');
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('user_content');
  });

  it('caps allowlisted secret-shaped terminal error field values without exposing the full value', () => {
    // Current limitation: allowlisted `type`/`code` values are capped, not API-key-redacted.
    // FOLLOW-UP: replace cap-only handling with minimal API-key-shaped redaction.
    const secretLikeType = `${'s'}${'k'}-${'x'.repeat(600)}`;
    const secretLikeCode = `Authorization Bearer ${secretLikeType}`;
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.failed', {
      response: {
        status: 'failed',
        error: {
          type: secretLikeType,
          code: secretLikeCode,
        },
      },
    });

    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error.type).toHaveLength(500);
    expect(parsed.error.code).toHaveLength(500);
    expect(parsed.error.message).toContain(`type=${secretLikeType.slice(0, 500)}`);
    expect(parsed.error.message).toContain(`code=${secretLikeCode.slice(0, 500)}`);
    expect(JSON.stringify(parsed.error)).not.toContain(secretLikeType);
    expect(JSON.stringify(parsed.error)).not.toContain(secretLikeCode);
  });

  // --- Error code pass-through tests (Stage 2: dumb transport) ---

  it('passes through rate_limit_exceeded code in response.failed', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.failed', {
      response: {
        error: {
          message: 'Rate limit exceeded',
          type: 'rate_limit_exceeded',
          code: 'rate_limit_exceeded',
        },
      },
    });

    expect(result).toBeTruthy();
    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error.message).toBe('Rate limit exceeded');
    expect(parsed.error.type).toBe('rate_limit_exceeded');
    expect(parsed.error.code).toBe('rate_limit_exceeded');
  });

  it('preserves Codex rate_limit_exceeded type through OpenAI streaming classification', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const translator = createStreamTranslator();
    const translated = translator.translateEvent('response.failed', {
      response: {
        error: {
          message: 'Rate limit exceeded',
          type: 'rate_limit_exceeded',
        },
      },
    });

    expect(translated).toBeTruthy();
    const parsed = JSON.parse(translated!.replace('data: ', '').trim());
    expect(parsed.error).toMatchObject({
      message: 'Rate limit exceeded',
      type: 'rate_limit_exceeded',
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      body: makeReadableStreamFromString(translated!),
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI (Codex)',
      });
      const promise = client.stream({
        model: unsafeAssertRoutingModelId('gpt-5.5'),
        systemPrompt: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 256,
      }, () => {}).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);

      const error = await promise;
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).kind).toBe('rate_limit');
      expect((error as ModelError).kind).not.toBe('server_error');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('passes through insufficient_quota code in response.failed', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.failed', {
      response: {
        error: {
          message: 'You exceeded your current quota',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
      },
    });

    expect(result).toBeTruthy();
    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error.message).toBe('You exceeded your current quota');
    expect(parsed.error.type).toBe('insufficient_quota');
    expect(parsed.error.code).toBe('insufficient_quota');
  });

  it('passes through server_error code in response.failed (backwards-compatible)', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.failed', {
      response: {
        error: {
          message: 'Internal server error',
          type: 'server_error',
          code: 'server_error',
        },
      },
    });

    expect(result).toBeTruthy();
    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error.message).toBe('Internal server error');
    expect(parsed.error.type).toBe('server_error');
    expect(parsed.error.code).toBe('server_error');
  });

  it('omits code field in response.failed when upstream has no code', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.failed', {
      response: { error: { message: 'Something went wrong' } },
    });

    expect(result).toBeTruthy();
    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error.message).toBe('Something went wrong');
    expect(parsed.error.type).toBe('server_error');
    expect(parsed.error.code).toBeUndefined();
  });

  it('passes through upstream type in response.failed instead of hardcoding server_error', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('response.failed', {
      response: {
        error: {
          message: 'Invalid request',
          type: 'invalid_request_error',
          code: 'invalid_prompt',
        },
      },
    });

    expect(result).toBeTruthy();
    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error.type).toBe('invalid_request_error');
    expect(parsed.error.code).toBe('invalid_prompt');
  });

  it('passes through code in error SSE events', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('error', {
      message: 'Plan limit reached',
      type: 'rate_limit_exceeded',
      code: 'rate_limit_exceeded',
    });

    expect(result).toBeTruthy();
    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error.message).toBe('Plan limit reached');
    expect(parsed.error.type).toBe('rate_limit_exceeded');
    expect(parsed.error.code).toBe('rate_limit_exceeded');
  });

  it('omits code field in error SSE events when not present', () => {
    const translator = createStreamTranslator();
    const result = translator.translateEvent('error', { message: 'Something failed' });

    expect(result).toBeTruthy();
    const parsed = JSON.parse(result!.replace('data: ', '').trim());
    expect(parsed.error.message).toBe('Something failed');
    expect(parsed.error.type).toBe('server_error');
    expect(parsed.error.code).toBeUndefined();
  });

  it('handles a full streaming session end-to-end', () => {
    const translator = createStreamTranslator();

    // 1. Response created
    expect(translator.translateEvent('response.created', {
      id: 'resp_e2e',
      model: 'gpt-5.3-codex',
    })).toBeNull();

    // 2. Text streaming
    const text1 = translator.translateEvent('response.output_text.delta', { delta: 'Let me ' });
    expect(text1).toBeTruthy();
    const text2 = translator.translateEvent('response.output_text.delta', { delta: 'help.' });
    expect(text2).toBeTruthy();

    // 3. Function call added
    const fnAdded = translator.translateEvent('response.output_item.added', {
      item: {
        type: 'function_call',
        id: 'fc_item_1',
        call_id: 'call_e2e_1',
        name: 'search',
      },
    });
    expect(fnAdded).toBeTruthy();

    // 4. Arguments streaming
    const args1 = translator.translateEvent('response.function_call_arguments.delta', {
      item_id: 'fc_item_1',
      delta: '{"query":',
    });
    expect(args1).toBeTruthy();
    const args2 = translator.translateEvent('response.function_call_arguments.delta', {
      item_id: 'fc_item_1',
      delta: '"test"}',
    });
    expect(args2).toBeTruthy();

    // 5. Completed
    const completed = translator.translateEvent('response.completed', {
      response: {
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    });
    expect(completed).toBeTruthy();
    expect(completed).toContain('[DONE]');

    // Verify the final chunk has tool_calls finish reason (because we added a function call)
    const finalChunks = parseChunks(completed!);
    const final = finalChunks[0] as {
      choices: Array<{ finish_reason: string }>;
      usage: { prompt_tokens: number };
    };
    expect(final.choices[0].finish_reason).toBe('tool_calls');
    expect(final.usage.prompt_tokens).toBe(100);
  });

  it('isolates state between translator instances', () => {
    const t1 = createStreamTranslator();
    const t2 = createStreamTranslator();

    t1.translateEvent('response.created', { id: 'resp_t1', model: 'model_a' });
    t2.translateEvent('response.created', { id: 'resp_t2', model: 'model_b' });

    t1.translateEvent('response.output_item.added', {
      item: { type: 'function_call', id: 'item_t1', call_id: 'call_t1', name: 'fn_t1' },
    });

    // t2 should have its own state
    const t2Result = translator2AddFn(t2);
    const t2Chunks = parseChunks(t2Result!);
    const t2Fn = t2Chunks[1] as {
      choices: Array<{
        delta: { tool_calls?: Array<{ index: number; id?: string }> };
      }>;
    };
    // index should be 0 for t2, independent of t1
    expect(t2Fn.choices[0].delta.tool_calls![0].index).toBe(0);
    expect(t2Fn.choices[0].delta.tool_calls![0].id).toBe('call_t2');

    function translator2AddFn(t: ReturnType<typeof createStreamTranslator>) {
      return t.translateEvent('response.output_item.added', {
        item: { type: 'function_call', id: 'item_t2', call_id: 'call_t2', name: 'fn_t2' },
      });
    }
  });

  it('handles output_item.added without item', () => {
    const translator = createStreamTranslator();
    expect(translator.translateEvent('response.output_item.added', {})).toBeNull();
  });

  it('sends role chunk in completed event if no content was sent', () => {
    const translator = createStreamTranslator();
    translator.translateEvent('response.created', { id: 'resp_empty', model: 'gpt-5' });

    const result = translator.translateEvent('response.completed', { response: {} });
    expect(result).toBeTruthy();

    // Should contain role chunk + final chunk + [DONE]
    const chunks = parseChunks(result!);
    expect(chunks).toHaveLength(2); // role + final
    const roleChunk = chunks[0] as { choices: Array<{ delta: { role?: string } }> };
    expect(roleChunk.choices[0].delta.role).toBe('assistant');
  });

  it('forwards cache tokens in response.completed usage', () => {
    const translator = createStreamTranslator();
    translator.translateEvent('response.created', { id: 'resp_cache', model: 'gpt-5' });
    translator.translateEvent('response.output_text.delta', { delta: 'Hi' });

    const result = translator.translateEvent('response.completed', {
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 80 },
        },
      },
    });

    expect(result).toBeTruthy();
    const chunks = parseChunks(result!);
    const finalChunk = chunks[0] as {
      usage?: { prompt_tokens_details?: { cached_tokens: number } };
    };
    expect(finalChunk.usage?.prompt_tokens_details).toEqual({ cached_tokens: 80 });
  });

  it('omits prompt_tokens_details in stream when input_tokens_details is absent', () => {
    const translator = createStreamTranslator();
    translator.translateEvent('response.created', { id: 'resp_no_cache', model: 'gpt-5' });
    translator.translateEvent('response.output_text.delta', { delta: 'Hi' });

    const result = translator.translateEvent('response.completed', {
      response: {
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    });

    const chunks = parseChunks(result!);
    const finalChunk = chunks[0] as {
      usage?: { prompt_tokens_details?: unknown };
    };
    expect(finalChunk.usage?.prompt_tokens_details).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Composition test: Responses API → codex translator → OpenAI translator
// ---------------------------------------------------------------------------

describe('cache token composition: Responses API → Chat Completions → Neutral', () => {
  it('preserves cacheReadTokens through the full translation chain', () => {
    // Step 1: Responses API response with input_tokens_details.cached_tokens
    const responsesApiResponse: ResponsesApiResponse = {
      id: 'resp_chain',
      model: 'gpt-5',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello!', annotations: [] }],
          status: 'completed',
        },
      ],
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 150 },
      },
    };

    // Step 2: Translate Responses API → Chat Completions format
    const chatCompletion = translateResponsesToChatCompletion(responsesApiResponse);
    expect(chatCompletion.usage.prompt_tokens_details).toEqual({ cached_tokens: 150 });

    // Step 3: Feed Chat Completions format into OpenAI translator → Neutral format
    const openAIResponse: OpenAIResponse = {
      id: chatCompletion.id,
      object: chatCompletion.object,
      created: chatCompletion.created,
      model: chatCompletion.model,
      choices: chatCompletion.choices,
      usage: chatCompletion.usage,
    };
    const neutral = translateResponseToNeutral(openAIResponse, 'gpt-5');

    // Verify the full chain preserved cache tokens
    expect(neutral.usage.cacheReadTokens).toBe(150);
    expect(neutral.usage.cacheCreationTokens).toBe(0);
    expect(neutral.usage.inputTokens).toBe(200);
    expect(neutral.usage.outputTokens).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// ResponsesApiResponseSchema — boundary validation
// ---------------------------------------------------------------------------

describe('ResponsesApiResponseSchema', () => {
  it('accepts a full valid ResponsesApiResponse', () => {
    const result = ResponsesApiResponseSchema.safeParse(makeFullResponsesApiResponse());
    expect(result.success).toBe(true);
  });

  it('accepts a minimal valid ResponsesApiResponse (no usage, no status)', () => {
    const minimal = { id: 'r', model: 'gpt-5.5', output: [] };
    const result = ResponsesApiResponseSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('tolerates missing id field with catch default', () => {
    const result = ResponsesApiResponseSchema.safeParse({
      model: 'gpt-5.5',
      output: [],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.id).toBe('');
  });

  it('tolerates non-array output with catch default', () => {
    const result = ResponsesApiResponseSchema.safeParse({
      id: 'r',
      model: 'gpt-5.5',
      output: 'not-an-array',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.output).toEqual([]);
  });

  it('rejects null', () => {
    expect(ResponsesApiResponseSchema.safeParse(null).success).toBe(false);
  });

  // --- Real-world-shape fixtures (260506 regression prevention) ---

  it('tolerates missing id and model (empty defaults)', () => {
    const result = ResponsesApiResponseSchema.safeParse({ output: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('');
      expect(result.data.model).toBe('');
    }
  });

  it('tolerates empty output (reasoning-only completion)', () => {
    const result = ResponsesApiResponseSchema.safeParse({
      id: 'resp_1', model: 'gpt-5.4-mini', output: [],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.output).toEqual([]);
  });

  it('tolerates missing output entirely', () => {
    const result = ResponsesApiResponseSchema.safeParse({
      id: 'resp_1', model: 'gpt-5.4-mini',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.output).toEqual([]);
  });

  it('tolerates string-typed usage token counts with catch default', () => {
    const result = ResponsesApiResponseSchema.safeParse({
      id: 'resp_1', model: 'gpt-5.4-mini', output: [],
      usage: { input_tokens: '100' as unknown, output_tokens: '50' as unknown },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.usage?.input_tokens).toBe(0);
      expect(result.data.usage?.output_tokens).toBe(0);
    }
  });

  it('tolerates reasoning-only output items via passthrough', () => {
    const result = ResponsesApiResponseSchema.safeParse({
      id: 'resp_1', model: 'gpt-5.4-mini',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'abc' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi', annotations: [] }], status: 'completed' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('preserves failure detection: status=failed still parsed', () => {
    const result = ResponsesApiResponseSchema.safeParse({
      id: 'resp_1', model: 'gpt-5.4-mini', output: [],
      status: 'failed', error: { message: 'upstream broken' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('failed');
      expect(result.data.error?.message).toBe('upstream broken');
    }
  });

  it('tolerates extra and shape-drifted error envelope fields', () => {
    const result = ResponsesApiResponseSchema.safeParse({
      id: 'resp_error_shape',
      model: 'gpt-5.4-mini',
      output: [],
      status: 'failed',
      error: { message: null, type: 'invalid_request_error', detail: 'model unsupported' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error?.message).toBeUndefined();
      expect((result.data.error as Record<string, unknown>).detail).toBe('model unsupported');
    }
  });

  it('tolerates unknown message status and null annotations without dropping content', () => {
    const result = ResponsesApiResponseSchema.safeParse({
      id: 'resp_unknown_message_status',
      model: 'gpt-5.4-mini',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Still visible', annotations: null }],
        status: 'cancelled',
      }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.output[0]).toMatchObject({
        type: 'message',
        content: [{ type: 'output_text', text: 'Still visible', annotations: [] }],
        status: 'cancelled',
      });
      expect(translateResponsesToChatCompletion(result.data).choices[0].message.content).toBe('Still visible');
    }
  });

  it('tolerates function call status drift and bad arguments by defaulting arguments', () => {
    const result = ResponsesApiResponseSchema.safeParse({
      id: 'resp_unknown_function_status',
      model: 'gpt-5.4-mini',
      output: [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: null,
        status: 'in_progress',
      }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.output[0]).toMatchObject({
        type: 'function_call',
        arguments: '',
        status: 'in_progress',
      });
      expect(translateResponsesToChatCompletion(result.data).choices[0].message.tool_calls?.[0].function.arguments).toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// readResponsesSseToCompletion — buffer SSE → ResponsesApiResponse
// ---------------------------------------------------------------------------

describe('readResponsesSseToCompletion', () => {
  function makeSseEvent(event: string, data: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function makeCompletedEvent(response: Partial<ResponsesApiResponse>): string {
    return makeSseEvent('response.completed', { type: 'response.completed', response });
  }

  function makeDeltasOnlyCompletedSse(text: string): string {
    const splitAt = Math.max(1, Math.floor(text.length / 2));
    const deltas = [text.slice(0, splitAt), text.slice(splitAt)].filter(Boolean);
    return [
      makeSseEvent('response.created', { id: 'resp_delta_text', model: 'gpt-5.4-mini' }),
      makeSseEvent('response.output_item.added', {
        output_index: 0,
        item: { id: 'msg_delta_text', type: 'message', role: 'assistant' },
      }),
      ...deltas.map((delta) => (
        makeSseEvent('response.output_text.delta', {
          output_index: 0,
          item_id: 'msg_delta_text',
          delta,
        })
      )),
      makeCompletedEvent({
        id: 'resp_delta_text',
        model: 'gpt-5.4-mini',
        output: [],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
        status: 'completed',
      }),
    ].join('');
  }

  function makeMixedDeltasAndSnapshotSse(text: string): string {
    return [
      makeSseEvent('response.created', { id: 'resp_mixed_delta_snapshot', model: 'gpt-5.4-mini' }),
      makeSseEvent('response.output_item.added', {
        output_index: 0,
        item: { id: 'msg_mixed_delta_snapshot', type: 'message', role: 'assistant' },
      }),
      makeSseEvent('response.output_text.delta', {
        output_index: 0,
        item_id: 'msg_mixed_delta_snapshot',
        delta: text,
      }),
      makeCompletedEvent({
        id: 'resp_mixed_delta_snapshot',
        model: 'gpt-5.4-mini',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
          status: 'completed',
        }],
        usage: { input_tokens: 5, output_tokens: 5 },
        status: 'completed',
      }),
    ].join('');
  }

  function makeDivergentAccumulatorAndSnapshotSse(): string {
    return [
      makeSseEvent('response.created', { id: 'resp_divergent_delta_snapshot', model: 'gpt-5.4-mini' }),
      makeSseEvent('response.output_item.added', {
        output_index: 0,
        item: { id: 'msg_divergent_delta_snapshot', type: 'message', role: 'assistant' },
      }),
      makeSseEvent('response.output_text.delta', {
        output_index: 0,
        item_id: 'msg_divergent_delta_snapshot',
        delta: 'Hello deltas',
      }),
      makeCompletedEvent({
        id: 'resp_divergent_delta_snapshot',
        model: 'gpt-5.4-mini',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Different snapshot text', annotations: [] }],
            status: 'completed',
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'second item', annotations: [] }],
            status: 'completed',
          },
        ],
        usage: { input_tokens: 5, output_tokens: 5 },
        status: 'completed',
      }),
    ].join('');
  }

  function makeManyTextDeltaFragmentsSse(fragments: string[]): string {
    return [
      makeSseEvent('response.created', { id: 'resp_many_delta_fragments', model: 'gpt-5.4-mini' }),
      makeSseEvent('response.output_item.added', {
        output_index: 0,
        item: { id: 'msg_many_delta_fragments', type: 'message', role: 'assistant' },
      }),
      ...fragments.map((delta) => (
        makeSseEvent('response.output_text.delta', {
          output_index: 0,
          item_id: 'msg_many_delta_fragments',
          delta,
        })
      )),
      makeCompletedEvent({
        id: 'resp_many_delta_fragments',
        model: 'gpt-5.4-mini',
        output: [],
        status: 'completed',
      }),
    ].join('');
  }

  function makeDeltaBeforeOutputItemAddedSse(): string {
    return [
      makeSseEvent('response.created', { id: 'resp_delta_before_item', model: 'gpt-5.4-mini' }),
      makeSseEvent('response.output_text.delta', {
        output_index: 0,
        item_id: 'msg_delta_before_item',
        delta: 'Delta before item.',
      }),
      makeSseEvent('response.output_item.added', {
        output_index: 0,
        item: { id: 'msg_delta_before_item', type: 'message', role: 'assistant' },
      }),
      makeCompletedEvent({
        id: 'resp_delta_before_item',
        model: 'gpt-5.4-mini',
        output: [],
        status: 'completed',
      }),
    ].join('');
  }

  function makeReasoningSummaryIgnoredSse(): string {
    return [
      makeSseEvent('response.created', { id: 'resp_reasoning_summary', model: 'gpt-5.4-mini' }),
      makeSseEvent('response.output_item.added', {
        output_index: 0,
        item: { id: 'msg_reasoning_summary', type: 'message', role: 'assistant' },
      }),
      makeSseEvent('response.output_text.delta', {
        output_index: 0,
        item_id: 'msg_reasoning_summary',
        delta: 'Visible answer.',
      }),
      makeSseEvent('response.reasoning_summary_text.delta', {
        output_index: 0,
        item_id: 'rs_reasoning_summary',
        delta: 'Hidden reasoning summary.',
      }),
      makeCompletedEvent({
        id: 'resp_reasoning_summary',
        model: 'gpt-5.4-mini',
        output: [],
        status: 'completed',
      }),
    ].join('');
  }

  function makeToolCallDeltasSse(name: string, args: string): string {
    const splitAt = Math.max(1, Math.floor(args.length / 2));
    const deltas = [args.slice(0, splitAt), args.slice(splitAt)].filter(Boolean);
    return [
      makeSseEvent('response.created', { id: 'resp_tool_delta', model: 'gpt-5.4-mini' }),
      makeSseEvent('response.output_item.added', {
        output_index: 0,
        item: {
          id: 'fc_item_delta',
          type: 'function_call',
          call_id: 'call_delta',
          name,
        },
      }),
      ...deltas.map((delta) => (
        makeSseEvent('response.function_call_arguments.delta', {
          output_index: 0,
          item_id: 'fc_item_delta',
          delta,
        })
      )),
      makeCompletedEvent({
        id: 'resp_tool_delta',
        model: 'gpt-5.4-mini',
        output: [],
        status: 'completed',
      }),
    ].join('');
  }

  function makeMultipleOutputsViaDeltasSse(): string {
    return [
      makeSseEvent('response.created', { id: 'resp_multi_delta', model: 'gpt-5.4-mini' }),
      makeSseEvent('response.output_item.added', {
        output_index: 1,
        item: { id: 'msg_second', type: 'message', role: 'assistant' },
      }),
      makeSseEvent('response.output_text.delta', {
        output_index: 1,
        item_id: 'msg_second',
        delta: 'The plan is ready.',
      }),
      makeSseEvent('response.output_item.added', {
        output_index: 0,
        item: {
          id: 'fc_item_first',
          type: 'function_call',
          call_id: 'call_first',
          name: 'prepare_plan',
        },
      }),
      makeSseEvent('response.function_call_arguments.delta', {
        output_index: 0,
        item_id: 'fc_item_first',
        delta: '{"topic":"launch"}',
      }),
      makeCompletedEvent({
        id: 'resp_multi_delta',
        model: 'gpt-5.4-mini',
        output: [],
        status: 'completed',
      }),
    ].join('');
  }

  function makeDeltasFollowedByFailureSse(): string {
    return [
      makeSseEvent('response.created', { id: 'resp_delta_failure', model: 'gpt-5.4-mini' }),
      makeSseEvent('response.output_item.added', {
        output_index: 0,
        item: { id: 'msg_delta_failure', type: 'message', role: 'assistant' },
      }),
      makeSseEvent('response.output_text.delta', {
        output_index: 0,
        item_id: 'msg_delta_failure',
        delta: 'partial text that must not be returned',
      }),
      makeSseEvent('response.failed', {
        response: { error: { type: 'server_error', message: 'delta stream failed', code: 'server_error' } },
        secret: 'must-not-leak',
      }),
    ].join('');
  }

  function extractStreamingTextFromSse(sse: string): string {
    const translator = createStreamTranslator();
    let rawChunks = '';

    for (const block of sse.split(/\r?\n\r?\n/)) {
      if (!block.trim()) continue;
      const parsedEvent = parseSseEventBlock(block);
      if (!parsedEvent) continue;
      const eventData = JSON.parse(parsedEvent.data) as Record<string, unknown>;
      const eventType = parsedEvent.event || (typeof eventData.type === 'string' ? eventData.type : '');
      if (!eventType) continue;
      rawChunks += translator.translateEvent(eventType, eventData) ?? '';
    }

    return rawChunks
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.replace('data: ', ''))
      .filter((json) => json !== '[DONE]')
      .map((json) => JSON.parse(json) as { choices?: Array<{ delta?: { content?: string } }> })
      .map((chunk) => chunk.choices?.[0]?.delta?.content ?? '')
      .join('');
  }

  function extractStreamingErrorMessageFromSse(sse: string): string | null {
    const translator = createStreamTranslator();

    for (const block of sse.split(/\r?\n\r?\n/)) {
      if (!block.trim()) continue;
      const parsedEvent = parseSseEventBlock(block);
      if (!parsedEvent) continue;
      const eventData = JSON.parse(parsedEvent.data) as Record<string, unknown>;
      const eventType = parsedEvent.event || (typeof eventData.type === 'string' ? eventData.type : '');
      if (!eventType) continue;
      const rawChunks = translator.translateEvent(eventType, eventData) ?? '';
      for (const chunk of rawChunks.split('\n\n')) {
        if (!chunk.startsWith('data: ')) continue;
        const data = chunk.replace('data: ', '');
        if (data === '[DONE]') continue;
        const parsed = JSON.parse(data) as { error?: { message?: string } };
        if (parsed.error?.message) return parsed.error.message;
      }
    }

    return null;
  }

  it('returns the validated response on canonical event:/data: SSE', async () => {
    const body = makeFullResponsesApiResponse();
    const sse = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: body })}\n\n`;
    const stream = makeReadableStreamFromString(sse);

    const result = await readResponsesSseToCompletion(stream, {
      throwUpstreamError: throwUpstream,
    });

    expect(result.id).toBe(body.id);
    expect(result.model).toBe(body.model);
    expect(result.output).toEqual(body.output);
    expect(result.usage?.input_tokens).toBe(100);
  });

  it('returns the validated response with CRLF SSE block delimiters', async () => {
    const body = makeFullResponsesApiResponse();
    const sse = `event: response.completed\r\ndata: ${JSON.stringify({ type: 'response.completed', response: body })}\r\n\r\n`;
    const stream = makeReadableStreamFromString(sse);

    const result = await readResponsesSseToCompletion(stream, {
      throwUpstreamError: throwUpstream,
    });

    expect(result.id).toBe(body.id);
    expect(result.model).toBe(body.model);
    expect(result.output).toEqual(body.output);
  });

  it('returns the validated response on data:-only SSE with type in payload', async () => {
    const body = makeFullResponsesApiResponse();
    const sse = `data: ${JSON.stringify({ type: 'response.completed', response: body })}\n\n`;
    const stream = makeReadableStreamFromString(sse);

    const result = await readResponsesSseToCompletion(stream, {
      throwUpstreamError: throwUpstream,
    });

    expect(result.id).toBe(body.id);
  });

  it('falls back to eventData when response field is missing (envelope normalization)', async () => {
    // Codex may emit response.completed with the payload at the top level
    // (no `response:` wrapper). Envelope normalization handles this.
    const sse = `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      id: 'resp_unwrapped',
      model: 'gpt-5.4-mini',
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    })}\n\n`;
    const stream = makeReadableStreamFromString(sse);

    const result = await readResponsesSseToCompletion(stream, {
      throwUpstreamError: throwUpstream,
    });
    expect(result.id).toBe('resp_unwrapped');
    expect(result.model).toBe('gpt-5.4-mini');
    expect(result.usage?.input_tokens).toBe(1);
    expect(result.usage?.output_tokens).toBe(1);
  });

  it('tolerates malformed response with catch defaults (no 502)', async () => {
    // Schema now uses .catch() — missing/wrong-type fields get defaults
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: { id: 1, output: 'x' } })}\n\n`;
    const stream = makeReadableStreamFromString(sse);

    const result = await readResponsesSseToCompletion(stream, {
      throwUpstreamError: throwUpstream,
    });
    // id was number (not string) → catches to ''
    expect(result.id).toBe('');
    // output was string (not array) → catches to []
    expect(result.output).toEqual([]);
  });

  it('still throws 502 on completely unparseable payload (null response)', async () => {
    // null is not an object → Zod can't apply .catch() on individual fields
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: null })}\n\n`;
    const stream = makeReadableStreamFromString(sse);

    await expect(
      readResponsesSseToCompletion(stream, { throwUpstreamError: throwUpstream }),
    ).rejects.toMatchObject({ upstreamStatus: 502 });
  });

  it('terminal response.failed with usage_limit_reached → 429 rate_limit_error + preserved code/reset, no payload leak (REBEL-4GH SSE-quota fidelity)', async () => {
    // SSE-delivered quota must surface as 429 (so the proxy maps it to a clean
    // rate_limit_error + code, matching the direct-HTTP-429 path) — NOT the
    // generic 502 that bypassed the f46121138 fix. Only allowlisted fields are
    // forwarded (no raw upstream payload leak).
    const sse = `event: response.failed\ndata: ${JSON.stringify({
      type: 'response.failed',
      response: { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 9770, secret_field: 'must-not-leak' } },
    })}\n\n`;

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), { throwUpstreamError: throwUpstream }),
    ).rejects.toMatchObject({ upstreamStatus: 429 });

    try {
      await readResponsesSseToCompletion(makeReadableStreamFromString(sse), { throwUpstreamError: throwUpstream });
      throw new Error('expected throw');
    } catch (e) {
      const upstreamBody = (e as { upstreamBody: string }).upstreamBody;
      const parsed = JSON.parse(upstreamBody) as { error: { type: string; code: string; resets_in_seconds?: number } };
      expect(parsed.error.type).toBe('rate_limit_error');
      expect(parsed.error.code).toBe('usage_limit_reached');
      expect(parsed.error.resets_in_seconds).toBe(9770);
      expect(upstreamBody).not.toContain('secret_field'); // only allowlisted fields forwarded
    }
  });

  it('terminal response.failed with a GENERIC error stays 502 (narrow quota allowlist — does not over-map to 429)', async () => {
    const sse = `event: response.failed\ndata: ${JSON.stringify({
      type: 'response.failed',
      response: { error: { type: 'server_error', message: 'boom' } },
    })}\n\n`;

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), { throwUpstreamError: throwUpstream }),
    ).rejects.toMatchObject({ upstreamStatus: 502 });
  });

  it('terminal response.completed{status:failed} with usage_limit_reached → 429 (GPT-5.5 F1: completed-failed quota must not regress to 502)', async () => {
    // Quota can also arrive via response.completed with status:"failed" — that
    // branch must use the same quota→429 mapping as response.failed.
    const sse = `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_x', status: 'failed', error: { type: 'usage_limit_reached', message: 'limit hit', resets_in_seconds: 100 } },
    })}\n\n`;

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), { throwUpstreamError: throwUpstream }),
    ).rejects.toMatchObject({ upstreamStatus: 429 });
  });

  it('terminal response.completed{status:failed} with a GENERIC error stays 502', async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_x', status: 'failed', error: { type: 'server_error', message: 'boom' } },
    })}\n\n`;

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), { throwUpstreamError: throwUpstream }),
    ).rejects.toMatchObject({ upstreamStatus: 502 });
  });

  it('includes Zod issue paths in 502 error message', async () => {
    // number[] is not parseable as object → schema fails entirely
    const sse = `event: response.completed\ndata: ${JSON.stringify({
      response: [1, 2, 3],
      userContent: 'private fixture text',
    })}\n\n`;
    const stream = makeReadableStreamFromString(sse);

    await expect(
      readResponsesSseToCompletion(stream, { throwUpstreamError: throwUpstream }),
    ).rejects.toMatchObject({
      upstreamStatus: 502,
      upstreamBody: expect.stringContaining('schema mismatch'),
    });
    try {
      await readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
      });
    } catch (err) {
      const upstreamBody = (err as TestUpstreamError).upstreamBody;
      expect(upstreamBody).toContain('paths=');
      expect(upstreamBody).toContain('(invalid_type)');
      expect(upstreamBody).toContain('respKeys=');
      expect(upstreamBody).toContain('envelopeKeys=');
      expect(upstreamBody).not.toContain('private fixture text');
      expect(upstreamBody).not.toContain('1,2,3');
    }
  });

  it('throws 502 when response.completed.status === "failed"', async () => {
    const body = { ...makeFullResponsesApiResponse(), status: 'failed', error: { message: 'upstream sad' } };
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: body })}\n\n`;
    const stream = makeReadableStreamFromString(sse);
    const onDiagnostic = vi.fn();

    await expect(
      readResponsesSseToCompletion(stream, { throwUpstreamError: throwUpstream, onDiagnostic }),
    ).rejects.toMatchObject({
      upstreamStatus: 502,
      upstreamBody: expect.stringContaining('upstream sad'),
    });
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      lastEventType: 'response.completed',
      sawCompleted: false,
    }));
  });

  it('detects response.completed failure before schema parsing and surfaces upstreamMessage', async () => {
    const body = {
      id: 'resp_error_shape_drift',
      model: 'gpt-5.4-mini',
      output: [],
      status: 'failed',
      error: { message: 'model X not supported', type: 'invalid_request_error' },
    };
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: body })}\n\n`;
    const diagnostics: SseDiagnostic[] = [];

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
        onDiagnostic: (d) => diagnostics.push(d),
      }),
    ).rejects.toMatchObject({
      upstreamStatus: 502,
      upstreamBody: 'Codex completed with failure: model X not supported',
    });
    expect(diagnostics[0]).toMatchObject({
      lastEventType: 'response.completed',
      sawCompleted: false,
      upstreamMessage: 'model X not supported',
    });
  });

  it('extracts opaque response.completed errors from raw strings', async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({
      response: {
        id: 'resp_raw_error',
        model: 'gpt-5.4-mini',
        output: [],
        status: 'failed',
        error: 'raw upstream failure',
      },
    })}\n\n`;

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
      }),
    ).rejects.toMatchObject({
      upstreamBody: 'Codex completed with failure: raw upstream failure',
    });
  });

  it('falls back to status when response.completed has null error and failed status', async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({
      response: {
        id: 'resp_null_error',
        model: 'gpt-5.4-mini',
        output: [],
        status: 'failed',
        error: null,
      },
    })}\n\n`;

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
      }),
    ).rejects.toMatchObject({
      upstreamBody: 'Codex completed with failure: Codex returned status: failed',
    });
  });

  it('falls back to a capped JSON snippet when response.completed error.message is not a string', async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({
      response: {
        id: 'resp_null_message',
        model: 'gpt-5.4-mini',
        output: [],
        status: 'failed',
        error: { message: null, type: 'invalid_request_error' },
      },
    })}\n\n`;

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
      }),
    ).rejects.toMatchObject({
      upstreamBody: expect.stringContaining('"message":null'),
    });
  });

  it('extracts response.completed error detail when message is absent', async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({
      response: {
        id: 'resp_detail_error',
        model: 'gpt-5.4-mini',
        output: [],
        status: 'failed',
        error: { detail: 'detail branch surfaced' },
      },
    })}\n\n`;

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
      }),
    ).rejects.toMatchObject({
      upstreamBody: 'Codex completed with failure: detail branch surfaced',
    });
  });

  it('treats response.completed non-success status as a terminal failure', async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({
      response: {
        id: 'resp_cancelled',
        model: 'gpt-5.4-mini',
        output: [],
        status: 'cancelled',
      },
    })}\n\n`;

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
      }),
    ).rejects.toMatchObject({
      upstreamBody: 'Codex completed with failure: Codex returned status: cancelled',
    });
  });

  it('throws 502 on response.incomplete with the upstream reason', async () => {
    const sse = `event: response.incomplete\ndata: ${JSON.stringify({
      type: 'response.incomplete',
      response: {
        incomplete_details: { reason: 'content_filter' },
      },
    })}\n\n`;

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
      }),
    ).rejects.toMatchObject({
      upstreamStatus: 502,
      upstreamBody: 'Codex completed incomplete: content_filter',
    });
  });

  it('throws 502 with SANITIZED message on a GENERIC response.failed event (no raw payload leak)', async () => {
    // Generic (non-quota) terminal failure stays 502 with a sanitized plain
    // message. (A quota/rate signal instead maps to 429 — covered by the
    // usage_limit_reached test above; the narrow allowlist keeps generic 502.)
    const sensitivePayload = {
      response: { error: { type: 'server_error', message: 'too many', code: 'internal_error' } },
      // simulate sensitive data in payload that must NOT leak
      __secret: 'do-not-log-this',
    };
    const sse = `event: response.failed\ndata: ${JSON.stringify(sensitivePayload)}\n\n`;
    const stream = makeReadableStreamFromString(sse);
    const onDiagnostic = vi.fn();

    await expect(
      readResponsesSseToCompletion(stream, { throwUpstreamError: throwUpstream, onDiagnostic }),
    ).rejects.toMatchObject({
      upstreamStatus: 502,
      upstreamBody: 'too many',
    });
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      lastEventType: 'response.failed',
      sawCompleted: false,
    }));
    // Verify message does NOT contain the secret payload field
    try {
      await readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
      });
    } catch (err) {
      expect((err as TestUpstreamError).upstreamBody).not.toContain('do-not-log-this');
      expect((err as TestUpstreamError).upstreamBody).not.toContain('__secret');
    }
  });

  it('throws 502 with sanitized message on bare error event', async () => {
    const sse = `event: error\ndata: {"type":"server_error","message":"internal"}\n\n`;
    const stream = makeReadableStreamFromString(sse);
    const onDiagnostic = vi.fn();

    await expect(
      readResponsesSseToCompletion(stream, { throwUpstreamError: throwUpstream, onDiagnostic }),
    ).rejects.toMatchObject({
      upstreamStatus: 502,
      upstreamBody: expect.stringContaining('internal'),
    });
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      lastEventType: 'error',
      sawCompleted: false,
    }));
  });

  it('throws 502 when stream ends without response.completed', async () => {
    const sse = `event: response.created\ndata: {"id":"resp_x"}\n\n`;
    const stream = makeReadableStreamFromString(sse);

    await expect(
      readResponsesSseToCompletion(stream, { throwUpstreamError: throwUpstream }),
    ).rejects.toMatchObject({
      upstreamStatus: 502,
      upstreamBody: expect.stringContaining('ended without response.completed'),
    });
  });

  it('skips hostile non-JSON data bodies and throws on stream end', async () => {
    const sse = 'event: response.completed\ndata: <html>not json</html>\n\n';
    const stream = makeReadableStreamFromString(sse);

    await expect(
      readResponsesSseToCompletion(stream, { throwUpstreamError: throwUpstream }),
    ).rejects.toMatchObject({
      upstreamStatus: 502,
      upstreamBody: expect.stringContaining('ended without response.completed'),
    });
  });

  it('throws 504 on per-chunk stall exceeding streamChunkTimeoutMs', async () => {
    const stream = makeStallingStream();

    await expect(
      readResponsesSseToCompletion(stream, {
        streamChunkTimeoutMs: 50,
        throwUpstreamError: throwUpstream,
      }),
    ).rejects.toMatchObject({
      upstreamStatus: 504,
      upstreamBody: expect.stringContaining('stalled'),
    });
  });

  it('emits sanitized diagnostic on success', async () => {
    const body = makeFullResponsesApiResponse();
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: body })}\n\n`;
    const stream = makeReadableStreamFromString(sse);
    const diagnostics: unknown[] = [];

    await readResponsesSseToCompletion(stream, {
      throwUpstreamError: throwUpstream,
      onDiagnostic: (d) => diagnostics.push(d),
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      eventCount: 1,
      sawCompleted: true,
      lastEventType: 'response.completed',
    });
    expect(diagnostics[0]).toMatchObject({ usageDefaulted: false });
  });

  it('emits usageDefaulted when usage token counts were defaulted', async () => {
    const body = {
      id: 'resp_defaulted_usage',
      model: 'gpt-5.4-mini',
      output: [],
      usage: { input_tokens: 'unknown', output_tokens: 5 },
      status: 'completed',
    };
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: body })}\n\n`;
    const diagnostics: SseDiagnostic[] = [];

    const result = await readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
      throwUpstreamError: throwUpstream,
      onDiagnostic: (d) => diagnostics.push(d),
    });

    expect(result.usage?.input_tokens).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ sawCompleted: true, usageDefaulted: true });
  });

  it('emits sanitized diagnostic on malformed-stream failure', async () => {
    const sse = `event: response.created\ndata: {"id":"resp_x"}\n\n`;
    const stream = makeReadableStreamFromString(sse);
    const diagnostics: unknown[] = [];

    await expect(
      readResponsesSseToCompletion(stream, {
        throwUpstreamError: throwUpstream,
        onDiagnostic: (d) => diagnostics.push(d),
      }),
    ).rejects.toThrow();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ sawCompleted: false });
  });

  // --- Real-world envelope drift fixtures (260506 regression prevention) ---

  it('handles empty output in response.completed (reasoning-only)', async () => {
    const body = { id: 'resp_reason', model: 'gpt-5.4-mini', output: [], status: 'completed' };
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: body })}\n\n`;
    const stream = makeReadableStreamFromString(sse);

    const result = await readResponsesSseToCompletion(stream, {
      throwUpstreamError: throwUpstream,
    });
    expect(result.output).toEqual([]);
    expect(result.id).toBe('resp_reason');
    const translated = translateResponsesToChatCompletion(result);
    expect(translated.choices[0].message.content).toBeNull();
    expect(translated.choices[0].finish_reason).toBe('stop');
  });

  it('handles missing usage in response.completed', async () => {
    const body = { id: 'resp_no_usage', model: 'gpt-5.4-mini', output: [] };
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: body })}\n\n`;
    const stream = makeReadableStreamFromString(sse);

    const result = await readResponsesSseToCompletion(stream, {
      throwUpstreamError: throwUpstream,
    });
    expect(result.usage).toBeUndefined();
    const translated = translateResponsesToChatCompletion(result);
    expect(translated.usage.prompt_tokens).toBe(0);
    expect(translated.usage.completion_tokens).toBe(0);
  });

  it('handles missing id/model in response.completed (catch defaults)', async () => {
    const body = { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi', annotations: [] }], status: 'completed' }] };
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: body })}\n\n`;
    const stream = makeReadableStreamFromString(sse);

    const result = await readResponsesSseToCompletion(stream, {
      throwUpstreamError: throwUpstream,
    });
    expect(result.id).toBe('');
    expect(result.model).toBe('');
    expect(result.output).toHaveLength(1);
    const translated = translateResponsesToChatCompletion(result);
    expect(translated.id).toBe('');
    expect(translated.model).toBe('');
  });

  it('preserves successful response.completed output when error is null', async () => {
    const body = {
      id: 'resp_success_null_error',
      model: 'gpt-5.4-mini',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Null error still succeeded.', annotations: [] }],
        status: 'completed',
      }],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      status: 'completed',
      error: null,
    };
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: body })}\n\n`;

    const result = await readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
      throwUpstreamError: throwUpstream,
    });

    expect(result.output).toHaveLength(1);
    expect(translateResponsesToChatCompletion(result).choices[0].message.content)
      .toBe('Null error still succeeded.');
  });

  it('handles string-typed usage token counts with zero defaults', async () => {
    const body = {
      id: 'resp_string_tokens',
      model: 'gpt-5.4-mini',
      output: [],
      usage: { input_tokens: '100', output_tokens: '50' },
    };
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: body })}\n\n`;
    const stream = makeReadableStreamFromString(sse);

    const result = await readResponsesSseToCompletion(stream, {
      throwUpstreamError: throwUpstream,
    });
    expect(result.usage?.input_tokens).toBe(0);
    expect(result.usage?.output_tokens).toBe(0);
    const translated = translateResponsesToChatCompletion(result);
    expect(translated.usage.prompt_tokens).toBe(0);
    expect(translated.usage.completion_tokens).toBe(0);
  });

  it('preserves failure detection even with lenient schema', async () => {
    const body = { status: 'failed', error: { message: 'rate limited' } };
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: body })}\n\n`;
    const stream = makeReadableStreamFromString(sse);

    await expect(
      readResponsesSseToCompletion(stream, { throwUpstreamError: throwUpstream }),
    ).rejects.toMatchObject({
      upstreamStatus: 502,
      upstreamBody: expect.stringContaining('rate limited'),
    });
  });

  it('emits diagnostic on schema mismatch (null payload)', async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({ response: null })}\n\n`;
    const stream = makeReadableStreamFromString(sse);
    const diagnostics: unknown[] = [];

    await expect(
      readResponsesSseToCompletion(stream, {
        throwUpstreamError: throwUpstream,
        onDiagnostic: (d) => diagnostics.push(d),
      }),
    ).rejects.toThrow();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ sawCompleted: false });
  });

  it('skips non-object SSE event payloads without crashing (data: null / array / scalar)', async () => {
    const validBody = {
      id: 'resp_after_null_envelope',
      model: 'gpt-5.4-mini',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'survived null envelope', annotations: [] }],
        status: 'completed',
      }],
      usage: { input_tokens: 1, output_tokens: 2 },
      status: 'completed',
    };
    const sse = [
      `event: response.completed\ndata: null\n\n`,
      `event: response.completed\ndata: [1,2,3]\n\n`,
      `event: response.completed\ndata: 42\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ response: validBody })}\n\n`,
    ].join('');

    const result = await readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
      throwUpstreamError: throwUpstream,
    });

    expect(result.output).toHaveLength(1);
    expect(translateResponsesToChatCompletion(result).choices[0].message.content)
      .toBe('survived null envelope');
  });

  // --- Stage 4: buffering accumulator reads deltas, not only completion snapshots ---

  it('accumulates text from deltas when response.completed output is empty', async () => {
    const result = await readResponsesSseToCompletion(
      makeReadableStreamFromString(makeDeltasOnlyCompletedSse('Hello world')),
      { throwUpstreamError: throwUpstream },
    );

    expect(result.id).toBe('resp_delta_text');
    expect(result.model).toBe('gpt-5.4-mini');
    expect(result.output[0]).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello world', annotations: [] }],
      status: 'completed',
    });
    expect(result.usage?.input_tokens).toBe(11);
  });

  it('prefers accumulated deltas over a populated completion snapshot without double-counting', async () => {
    const diagnostics: unknown[] = [];
    const result = await readResponsesSseToCompletion(
      makeReadableStreamFromString(makeMixedDeltasAndSnapshotSse('Hello world')),
      {
        throwUpstreamError: throwUpstream,
        onDiagnostic: (d) => diagnostics.push(d),
      },
    );

    expect(result.output).toHaveLength(1);
    expect(result.output[0]).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: 'Hello world', annotations: [] }],
    });
    expect(translateResponsesToChatCompletion(result).choices[0].message.content).toBe('Hello world');
    expect(diagnostics[0]).toMatchObject({
      reconciliation: {
        accumulator: 'populated',
        snapshot: 'populated',
        usingAccumulator: true,
      },
    });
  });

  it('diagnoses divergence when populated accumulator and completion snapshot disagree', async () => {
    const diagnostics: SseDiagnostic[] = [];
    const result = await readResponsesSseToCompletion(
      makeReadableStreamFromString(makeDivergentAccumulatorAndSnapshotSse()),
      {
        throwUpstreamError: throwUpstream,
        onDiagnostic: (d) => diagnostics.push(d),
      },
    );

    expect(translateResponsesToChatCompletion(result).choices[0].message.content).toBe('Hello deltas');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      reconciliation: {
        accumulator: 'populated',
        snapshot: 'populated',
        usingAccumulator: true,
        divergence: {
          accumulatorItemCount: 1,
          snapshotItemCount: 2,
          accumulatorTextLength: 12,
          countMismatch: true,
          textLengthMismatch: true,
        },
      },
    });
  });

  it('accumulates 10+ text delta fragments for one message item', async () => {
    const fragments = ['A ', 'do', 'zen', ' ', 'de', 'lta', ' ', 'frag', 'men', 'ts ', 'lan', 'ded.'];
    const result = await readResponsesSseToCompletion(
      makeReadableStreamFromString(makeManyTextDeltaFragmentsSse(fragments)),
      { throwUpstreamError: throwUpstream },
    );

    expect(translateResponsesToChatCompletion(result).choices[0].message.content).toBe(fragments.join(''));
  });

  it('lazily creates a message item when text delta arrives before output_item.added', async () => {
    const result = await readResponsesSseToCompletion(
      makeReadableStreamFromString(makeDeltaBeforeOutputItemAddedSse()),
      { throwUpstreamError: throwUpstream },
    );

    expect(translateResponsesToChatCompletion(result).choices[0].message.content).toBe('Delta before item.');
    expect(result.output[0]).toMatchObject({ type: 'message', id: 'msg_delta_before_item' });
  });

  it('ignores response.reasoning_summary_text.delta in message output text', async () => {
    const result = await readResponsesSseToCompletion(
      makeReadableStreamFromString(makeReasoningSummaryIgnoredSse()),
      { throwUpstreamError: throwUpstream },
    );

    expect(translateResponsesToChatCompletion(result).choices[0].message.content).toBe('Visible answer.');
    expect(translateResponsesToChatCompletion(result).choices[0].message.content).not.toContain('Hidden reasoning summary.');
  });

  it('accumulates function-call arguments from deltas', async () => {
    const args = '{"query":"codex sse"}';
    const result = await readResponsesSseToCompletion(
      makeReadableStreamFromString(makeToolCallDeltasSse('search_docs', args)),
      { throwUpstreamError: throwUpstream },
    );

    expect(result.output[0]).toEqual({
      type: 'function_call',
      id: 'fc_item_delta',
      call_id: 'call_delta',
      name: 'search_docs',
      arguments: args,
      status: 'completed',
    });
  });

  it('preserves output_index ordering across multiple delta-built outputs', async () => {
    const result = await readResponsesSseToCompletion(
      makeReadableStreamFromString(makeMultipleOutputsViaDeltasSse()),
      { throwUpstreamError: throwUpstream },
    );

    expect(result.output).toHaveLength(2);
    expect(result.output[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_first',
      name: 'prepare_plan',
      arguments: '{"topic":"launch"}',
    });
    expect(result.output[1]).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: 'The plan is ready.', annotations: [] }],
    });
  });

  it('throws sanitized 502 when a stream fails after accumulating deltas', async () => {
    const sse = makeDeltasFollowedByFailureSse();

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
      }),
    ).rejects.toMatchObject({
      upstreamStatus: 502,
      upstreamBody: expect.stringContaining('delta stream failed'),
    });

    try {
      await readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
      });
    } catch (err) {
      expect((err as TestUpstreamError).upstreamBody).not.toContain('must-not-leak');
      expect((err as TestUpstreamError).upstreamBody).not.toContain('partial text');
    }
  });

  it('matches createStreamTranslator text output for the same deltas-only SSE fixture', async () => {
    const sse = makeDeltasOnlyCompletedSse('Hello streaming parity');
    const buffered = await readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
      throwUpstreamError: throwUpstream,
    });
    const bufferedText = buffered.output[0]?.type === 'message'
      ? buffered.output[0].content[0]?.text
      : '';

    expect(bufferedText).toBe(extractStreamingTextFromSse(sse));
  });

  it('matches createStreamTranslator error message for the same response.failed SSE fixture', async () => {
    const sse = makeSseEvent('response.failed', {
      response: { error: { type: 'server_error', message: 'same failure contract', code: 'server_error' } },
    });
    const streamingMessage = extractStreamingErrorMessageFromSse(sse);

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
      }),
    ).rejects.toMatchObject({
      upstreamBody: streamingMessage,
    });
  });

  it('matches createStreamTranslator error message for response.completed embedded failures', async () => {
    const sse = makeSseEvent('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_completed_failure_parity',
        model: 'gpt-5.4-mini',
        output: [],
        status: 'failed',
        error: { message: 'completed failure contract', type: 'server_error' },
      },
    });
    const streamingMessage = extractStreamingErrorMessageFromSse(sse);

    await expect(
      readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
        throwUpstreamError: throwUpstream,
      }),
    ).rejects.toMatchObject({
      upstreamBody: streamingMessage,
    });
  });
});

// ---------------------------------------------------------------------------
// Reasoning summary channel — streaming and buffering parity
// ---------------------------------------------------------------------------

describe('reasoning summary channel (red→green: GPT reasoning must not leak into output_text)', () => {
  function makeSseEvent(event: string, data: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function makeCompletedEvent(response: Partial<ResponsesApiResponse>): string {
    return makeSseEvent('response.completed', { type: 'response.completed', response });
  }

  /**
   * A fixture that interleaves reasoning_summary deltas with output_text deltas —
   * the exact event sequence emitted by gpt-5.5 via the Responses API.
   * Before the fix this would have caused the reasoning text to bleed into the
   * visible answer (via output_text accumulation); after the fix reasoning lands
   * in reasoning_content and output_text stays clean.
   */
  function makeInterleavedReasoningAndOutputSse(): string {
    return [
      makeSseEvent('response.created', { id: 'resp_reasoning_interleaved', model: 'gpt-5.5' }),
      makeSseEvent('response.output_item.added', {
        output_index: 0,
        item: { id: 'rs_item', type: 'reasoning' },
      }),
      makeSseEvent('response.reasoning_summary_part.added', {
        item_id: 'rs_item',
        summary_index: 0,
      }),
      makeSseEvent('response.reasoning_summary_text.delta', {
        item_id: 'rs_item',
        delta: 'Need no narration! ',
      }),
      makeSseEvent('response.reasoning_summary_text.delta', {
        item_id: 'rs_item',
        delta: 'I already violated.',
      }),
      makeSseEvent('response.reasoning_summary_text.done', {
        item_id: 'rs_item',
        text: 'Need no narration! I already violated.',
      }),
      makeSseEvent('response.reasoning_summary_part.done', {
        item_id: 'rs_item',
        summary_index: 0,
      }),
      makeSseEvent('response.output_item.added', {
        output_index: 1,
        item: { id: 'msg_item', type: 'message', role: 'assistant' },
      }),
      makeSseEvent('response.output_text.delta', {
        output_index: 1,
        item_id: 'msg_item',
        delta: 'The bat costs $0.05.',
      }),
      makeCompletedEvent({
        id: 'resp_reasoning_interleaved',
        model: 'gpt-5.5',
        output: [],
        usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
        status: 'completed',
      }),
    ].join('');
  }

  /** Parse all chunk strings from the streaming translator for an SSE fixture. */
  function extractStreamingChunks(sse: string): Array<{ content?: string; reasoning_content?: string }> {
    const translator = createStreamTranslator();
    const deltas: Array<{ content?: string; reasoning_content?: string }> = [];

    for (const block of sse.split(/\r?\n\r?\n/)) {
      if (!block.trim()) continue;
      const parsedEvent = parseSseEventBlock(block);
      if (!parsedEvent) continue;
      const eventData = JSON.parse(parsedEvent.data) as Record<string, unknown>;
      const eventType = parsedEvent.event || (typeof eventData.type === 'string' ? eventData.type : '');
      if (!eventType) continue;
      const translated = translator.translateEvent(eventType, eventData) ?? '';
      for (const chunk of translated.split('\n\n')) {
        if (!chunk.startsWith('data: ')) continue;
        const data = chunk.replace('data: ', '');
        if (data === '[DONE]') continue;
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }> };
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content !== undefined || delta?.reasoning_content !== undefined) {
          deltas.push({ content: delta.content, reasoning_content: delta.reasoning_content });
        }
      }
    }

    return deltas;
  }

  // (a) Streaming: reasoning_summary_text.delta → reasoning_content chunk, NOT content/output_text
  it('streaming: response.reasoning_summary_text.delta → reasoning_content delta (NOT content)', () => {
    const translator = createStreamTranslator();
    translator.translateEvent('response.created', { id: 'resp_reasoning', model: 'gpt-5.5' });

    const result = translator.translateEvent('response.reasoning_summary_text.delta', {
      item_id: 'rs_item',
      delta: 'Need no narration!',
    });

    expect(result).toBeTruthy();
    // Parse the emitted chunks
    const chunks = result!
      .split('\n\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.replace('data: ', ''))
      .filter((json) => json !== '[DONE]')
      .map((json) => JSON.parse(json) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }> });

    const contentChunk = chunks.find((c) => c.choices?.[0]?.delta?.content !== undefined);
    const reasoningChunk = chunks.find((c) => c.choices?.[0]?.delta?.reasoning_content !== undefined);

    expect(contentChunk).toBeUndefined(); // must NOT appear in content/output_text
    expect(reasoningChunk).toBeDefined();
    expect(reasoningChunk!.choices![0].delta!.reasoning_content).toBe('Need no narration!');
  });

  // boundary events are no-ops
  it('streaming: reasoning part boundary events (added/done, text.done) return null', () => {
    const translator = createStreamTranslator();
    expect(translator.translateEvent('response.reasoning_summary_part.added', { item_id: 'rs' })).toBeNull();
    expect(translator.translateEvent('response.reasoning_summary_part.done', { item_id: 'rs' })).toBeNull();
    expect(translator.translateEvent('response.reasoning_summary_text.done', { item_id: 'rs', text: 'full' })).toBeNull();
  });

  // (b) Buffering: same reasoning events accumulate into reasoningSummaryText (not message text)
  it('buffering: reasoning_summary_text.delta accumulates into reasoningSummaryText, not output_text', async () => {
    const sse = makeInterleavedReasoningAndOutputSse();

    let capturedReasoningSummary = '';
    const result = await readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
      throwUpstreamError: (s, b) => new Error(`${s}: ${b}`),
      onReasoningSummary: (text) => { capturedReasoningSummary = text; },
    });

    // The reasoning text must NOT appear in the Responses API output[]
    const outputText = translateResponsesToChatCompletion(result).choices[0].message.content;
    expect(outputText).toBe('The bat costs $0.05.');
    expect(outputText).not.toContain('Need no narration!');

    // The reasoning summary must be available via the callback
    expect(capturedReasoningSummary).toBe('Need no narration! I already violated.');

    // When passed through translateResponsesToChatCompletion, it becomes reasoning_content
    const withReasoning = translateResponsesToChatCompletion(result, {
      reasoningContent: capturedReasoningSummary,
    });
    expect(withReasoning.choices[0].message.reasoning_content).toBe('Need no narration! I already violated.');
    expect(withReasoning.choices[0].message.content).toBe('The bat costs $0.05.');
  });

  // (c) Extend parity test: streaming and buffering must agree on both content and reasoning
  it('parity: streaming and buffering produce the same content AND reasoning_content for interleaved fixture', async () => {
    const sse = makeInterleavedReasoningAndOutputSse();

    // Streaming side
    const streamingDeltas = extractStreamingChunks(sse);
    const streamingContent = streamingDeltas.filter((d) => d.content).map((d) => d.content).join('');
    const streamingReasoning = streamingDeltas.filter((d) => d.reasoning_content).map((d) => d.reasoning_content).join('');

    // Buffering side
    let capturedReasoningSummary = '';
    const bufferedResult = await readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
      throwUpstreamError: (s, b) => new Error(`${s}: ${b}`),
      onReasoningSummary: (text) => { capturedReasoningSummary = text; },
    });
    const bufferedChatResponse = translateResponsesToChatCompletion(bufferedResult, {
      reasoningContent: capturedReasoningSummary,
    });
    const bufferedContent = bufferedChatResponse.choices[0].message.content ?? '';
    const bufferedReasoning = bufferedChatResponse.choices[0].message.reasoning_content ?? '';

    expect(streamingContent).toBe(bufferedContent);
    expect(streamingReasoning).toBe(bufferedReasoning);
    expect(streamingContent).toBe('The bat costs $0.05.');
    expect(streamingReasoning).toBe('Need no narration! I already violated.');
  });

  // (e) F2: ordered cross-channel parity — multi-segment interleaved sequence
  //     (reasoning→text→reasoning→text). Asserts typed, ordered delta sequence matches
  //     between streaming and buffering — not just concatenated content per channel.
  it('F2 ordered parity: reasoning→text→reasoning→text interleaved sequence produces identical typed delta order in streaming', async () => {
    // A richer fixture: two reasoning segments interleaved with two text segments.
    // This exposes any ordering or typing regression that concatenation-only checks miss.
    const richSse = [
      makeSseEvent('response.created', { id: 'resp_ordered_parity', model: 'gpt-5.5' }),
      // First reasoning segment
      makeSseEvent('response.output_item.added', { output_index: 0, item: { id: 'rs_1', type: 'reasoning' } }),
      makeSseEvent('response.reasoning_summary_part.added', { item_id: 'rs_1', summary_index: 0 }),
      makeSseEvent('response.reasoning_summary_text.delta', { item_id: 'rs_1', delta: 'First thought. ' }),
      makeSseEvent('response.reasoning_summary_text.delta', { item_id: 'rs_1', delta: 'Still thinking.' }),
      makeSseEvent('response.reasoning_summary_text.done', { item_id: 'rs_1', text: 'First thought. Still thinking.' }),
      makeSseEvent('response.reasoning_summary_part.done', { item_id: 'rs_1', summary_index: 0 }),
      // First text segment
      makeSseEvent('response.output_item.added', { output_index: 1, item: { id: 'msg_1', type: 'message', role: 'assistant' } }),
      makeSseEvent('response.output_text.delta', { output_index: 1, item_id: 'msg_1', delta: 'Hello ' }),
      // Second reasoning segment (same reasoning item, new summary part)
      makeSseEvent('response.reasoning_summary_part.added', { item_id: 'rs_1', summary_index: 1 }),
      makeSseEvent('response.reasoning_summary_text.delta', { item_id: 'rs_1', delta: 'Additional reasoning.' }),
      makeSseEvent('response.reasoning_summary_text.done', { item_id: 'rs_1', text: 'Additional reasoning.' }),
      makeSseEvent('response.reasoning_summary_part.done', { item_id: 'rs_1', summary_index: 1 }),
      // Second text segment
      makeSseEvent('response.output_text.delta', { output_index: 1, item_id: 'msg_1', delta: 'world.' }),
      makeCompletedEvent({
        id: 'resp_ordered_parity',
        model: 'gpt-5.5',
        output: [],
        usage: { input_tokens: 50, output_tokens: 15, total_tokens: 65 },
        status: 'completed',
      }),
    ].join('');

    // Streaming: collect typed, ordered deltas
    const streamingDeltas = extractStreamingChunks(richSse);
    // Each delta has either content or reasoning_content (never both)
    const streamingOrdered = streamingDeltas.map((d) =>
      d.reasoning_content !== undefined
        ? { channel: 'reasoning' as const, text: d.reasoning_content }
        : { channel: 'content' as const, text: d.content ?? '' },
    );

    // Streaming assertions: reasoning deltas precede first text delta, second reasoning
    // block appears between the two text deltas, all channels correct
    const streamingReasoningTexts = streamingOrdered
      .filter((d) => d.channel === 'reasoning')
      .map((d) => d.text);
    const streamingContentTexts = streamingOrdered
      .filter((d) => d.channel === 'content')
      .map((d) => d.text);

    // All reasoning text arrives in the reasoning channel only
    expect(streamingReasoningTexts.join('')).toContain('First thought.');
    expect(streamingReasoningTexts.join('')).toContain('Additional reasoning.');
    // All content text arrives in the content channel only
    expect(streamingContentTexts.join('')).toBe('Hello world.');
    // No cross-contamination
    expect(streamingContentTexts.join('')).not.toContain('First thought.');
    expect(streamingReasoningTexts.join('')).not.toContain('Hello');

    // Ordering: all reasoning deltas appear BEFORE the first content delta that shares
    // the pre-completion portion — the delta sequence must have reasoning entries, then
    // content entries (interleaved as emitted by the model, but channel-separated).
    // At minimum: the first delta is a reasoning delta (no role delta precedes reasoning).
    expect(streamingOrdered[0]?.channel).toBe('reasoning');
    // And at least one reasoning delta appears after the first content delta (interleaved):
    const firstContentIndex = streamingOrdered.findIndex((d) => d.channel === 'content');
    const hasReasoningAfterFirstContent = streamingOrdered
      .slice(firstContentIndex + 1)
      .some((d) => d.channel === 'reasoning');
    expect(hasReasoningAfterFirstContent).toBe(true);

    // Buffering: reasoning arrives via onReasoningSummary (accumulated, not ordered)
    let capturedReasoningSummary = '';
    const bufferedResult = await readResponsesSseToCompletion(makeReadableStreamFromString(richSse), {
      throwUpstreamError: (s, b) => new Error(`${s}: ${b}`),
      onReasoningSummary: (text) => { capturedReasoningSummary = text; },
    });
    const bufferedResponse = translateResponsesToChatCompletion(bufferedResult, {
      reasoningContent: capturedReasoningSummary,
    });

    // Buffering delivers the same TOTAL content (concatenated, since buffering is non-ordered)
    expect(bufferedResponse.choices[0].message.content).toBe('Hello world.');
    expect(bufferedResponse.choices[0].message.reasoning_content).toBe(
      'First thought. Still thinking.Additional reasoning.',
    );
    // Streaming total must match buffering total
    expect(streamingReasoningTexts.join('')).toBe(
      bufferedResponse.choices[0].message.reasoning_content,
    );
    expect(streamingContentTexts.join('')).toBe(
      bufferedResponse.choices[0].message.content,
    );
  });

  // (d) Regression fixture: interleaved reasoning + output → clean separation. This test
  //     WOULD HAVE FAILED against pre-fix code (reasoning leaked into output_text).
  it('regression: interleaved reasoning summary + output_text → reasoning in thinking channel, answer stays clean', async () => {
    const sse = makeInterleavedReasoningAndOutputSse();

    // Streaming path: reasoning must be in reasoning_content, not in content
    const streamingDeltas = extractStreamingChunks(sse);
    const allContentText = streamingDeltas.filter((d) => d.content).map((d) => d.content).join('');
    const allReasoningText = streamingDeltas.filter((d) => d.reasoning_content).map((d) => d.reasoning_content).join('');

    expect(allContentText).not.toContain('Need no narration');
    expect(allReasoningText).toContain('Need no narration');
    expect(allContentText).toBe('The bat costs $0.05.');

    // Buffering path: same separation
    let capturedReasoningSummary = '';
    const bufferedResult = await readResponsesSseToCompletion(makeReadableStreamFromString(sse), {
      throwUpstreamError: (s, b) => new Error(`${s}: ${b}`),
      onReasoningSummary: (text) => { capturedReasoningSummary = text; },
    });
    const bufferedResponse = translateResponsesToChatCompletion(bufferedResult, {
      reasoningContent: capturedReasoningSummary,
    });
    expect(bufferedResponse.choices[0].message.content).not.toContain('Need no narration');
    expect(bufferedResponse.choices[0].message.reasoning_content).toContain('Need no narration');
    expect(bufferedResponse.choices[0].message.content).toBe('The bat costs $0.05.');
  });
});
