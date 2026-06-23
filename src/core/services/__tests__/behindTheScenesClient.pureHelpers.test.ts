import { describe, it, expect } from 'vitest';
import { ModelError } from '@core/rebelCore/modelErrors';
import {
  isTransientNetworkError,
  stripThinkingBlocks,
  extractJsonFromStructuredResponse,
  parseJsonResponseBody
} from '../behindTheScenesClient';

describe('behindTheScenesClient pure helpers', () => {
  describe('isTransientNetworkError', () => {
    it('returns true for timeout errors', () => {
      const err = new Error('Request etimedout');
      expect(isTransientNetworkError(err)).toBe(true);
    });

    it('returns true for 500/502/503/504 API errors', () => {
      const err500 = new Error('Anthropic API error (500): Internal Server Error');
      const err503 = new Error('Profile API error (503): Service Unavailable');
      expect(isTransientNetworkError(err500)).toBe(true);
      expect(isTransientNetworkError(err503)).toBe(true);
    });

    it('returns true for server_error ModelErrors and false for rate_limit ModelErrors', () => {
      const serverError = new ModelError('server_error', 'Internal Server Error', 500, 'Anthropic');
      const rateLimitError = new ModelError('rate_limit', 'Rate limit exceeded', 429, 'Anthropic');
      expect(isTransientNetworkError(serverError)).toBe(true);
      expect(isTransientNetworkError(rateLimitError)).toBe(false);
    });

    it('returns false for 400 API errors', () => {
      const err = new Error('Anthropic API error (400): Bad Request');
      expect(isTransientNetworkError(err)).toBe(false);
    });

    it('returns true for fetch failed', () => {
      const err = new Error('fetch failed');
      expect(isTransientNetworkError(err)).toBe(true);
    });

    it('returns false for generic errors', () => {
      const err = new Error('Something went wrong');
      expect(isTransientNetworkError(err)).toBe(false);
    });

    it('checks inner cause', () => {
      const innerErr = new Error('econnrefused');
      const outerErr = new Error('Outer error');
      (outerErr as any).cause = innerErr;
      expect(isTransientNetworkError(outerErr)).toBe(true);
    });

    it('checks AggregateError causes', () => {
      const err1 = new Error('Some error');
      const err2 = new Error('socket hang up');
      const aggregate = new AggregateError([err1, err2], 'Multiple errors');
      expect(isTransientNetworkError(aggregate)).toBe(true);
    });

    it('checks AggregateError cause when errors are non-transient', () => {
      const nonTransientErrors = [new Error('Bad request'), new Error('Invalid input')];
      const transientCause = new Error('econnrefused');
      const aggregate = new AggregateError(nonTransientErrors, 'Multiple errors', { cause: transientCause });
      expect(isTransientNetworkError(aggregate)).toBe(true);
    });
  });

  describe('stripThinkingBlocks', () => {
    it('returns text as-is if no thinking blocks', () => {
      expect(stripThinkingBlocks('Hello world')).toBe('Hello world');
    });

    it('strips closed thinking blocks', () => {
      const text = '<think>\nThis is a thought process.\n</think>\nHello world';
      expect(stripThinkingBlocks(text)).toBe('Hello world');
    });

    it('strips multiple thinking blocks', () => {
      const text = '<think>first</think>Part 1<think>second</think>Part 2';
      expect(stripThinkingBlocks(text)).toBe('Part 1Part 2');
    });

    it('strips trailing unclosed thinking block', () => {
      const text = 'Hello world\n<think>\nThis thought is cut off...';
      expect(stripThinkingBlocks(text)).toBe('Hello world');
    });
  });

  describe('extractJsonFromStructuredResponse', () => {
    it('returns valid JSON as-is', () => {
      const json = '{"key": "value"}';
      expect(extractJsonFromStructuredResponse(json)).toBe(json);
    });

    it('returns valid JSON array as-is', () => {
      const json = '[1, 2, 3]';
      expect(extractJsonFromStructuredResponse(json)).toBe(json);
    });

    it('strips markdown fences around JSON', () => {
      const text = '```json\n{"key": "value"}\n```';
      expect(extractJsonFromStructuredResponse(text)).toBe('{"key": "value"}');
    });

    it('strips generic markdown fences', () => {
      const text = '```\n[1, 2, 3]\n```';
      expect(extractJsonFromStructuredResponse(text)).toBe('[1, 2, 3]');
    });

    it('extracts JSON when surrounded by preamble and postamble', () => {
      const text = 'Here is your JSON:\n\n{"key": "value"}\n\nHope this helps!';
      expect(extractJsonFromStructuredResponse(text)).toBe('{"key": "value"}');
    });

    it('extracts JSON array when surrounded by text', () => {
      const text = 'Data:\n[1, 2]\nDone.';
      expect(extractJsonFromStructuredResponse(text)).toBe('[1, 2]');
    });

    it('returns original text if no JSON structure is found', () => {
      const text = 'This is just some normal text.';
      expect(extractJsonFromStructuredResponse(text)).toBe(text);
    });

    it('returns original text if empty', () => {
      expect(extractJsonFromStructuredResponse('   ')).toBe('');
    });
  });

  describe('parseJsonResponseBody', () => {
    // BTS calls are always non-streaming. parseJsonResponseBody enforces this
    // contract by throwing a clear diagnostic error when a provider/proxy
    // returns SSE (text/event-stream) instead of JSON.
    // See docs/plans/260429_bts_sse_parsing_fix.md.

    it('parses a normal JSON response', async () => {
      const response = new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'hello' }], model: 'gpt-5.5' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
      const parsed = await parseJsonResponseBody(response);
      expect(parsed).toEqual({
        content: [{ type: 'text', text: 'hello' }],
        model: 'gpt-5.5',
      });
    });

    it('throws a diagnostic error when Content-Type is text/event-stream', async () => {
      const sseBody = 'event: message_start\ndata: {"type":"message_start"}\n\n';
      const response = new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
      await expect(parseJsonResponseBody(response)).rejects.toThrow(
        /BTS call received streaming response/,
      );
    });

    it('throws when body starts with "event:" even without SSE content-type', async () => {
      // Defense-in-depth: some proxies/providers may stream without setting
      // the correct Content-Type. The body sniff catches that case.
      const sseBody = 'event: message_start\ndata: {"type":"message_start"}\n\n';
      const response = new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
      await expect(parseJsonResponseBody(response)).rejects.toThrow(
        /BTS call received streaming response/,
      );
    });

    it('throws an error message that includes the content-type from the response', async () => {
      const sseBody = 'event: message_start\ndata: {"type":"message_start"}\n\n';
      const response = new Response(sseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
      await expect(parseJsonResponseBody(response)).rejects.toThrow(
        /content-type: text\/event-stream/,
      );
    });

    it('throws JSON SyntaxError for non-JSON, non-SSE bodies (preserves underlying parse error)', async () => {
      // The SSE guard only fires for content-type=event-stream OR body starting with "event:".
      // Other malformed JSON bodies should fail at JSON.parse with the standard error so
      // upstream classifyError logic still works.
      const response = new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      await expect(parseJsonResponseBody(response)).rejects.toThrow(SyntaxError);
    });
  });
});
