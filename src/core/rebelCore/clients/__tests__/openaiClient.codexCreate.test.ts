import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenAIClient } from '../openaiClient';
import type { CodexModeConfig } from '../../codexModeTypes';
import { ModelError } from '../../modelErrors';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex';

function makeCodexMode(): CodexModeConfig {
  return {
    endpointUrl: CODEX_ENDPOINT,
    getAccessToken: vi.fn(async () => 'codex-token'),
    getAccountId: vi.fn(() => 'org_test'),
    forceRefreshToken: vi.fn(async () => 'codex-token-refreshed'),
  };
}

function makeCompletedSse(payload: Record<string, unknown> = {}): Response {
  const completedResponse = {
    id: 'resp_codex_123',
    model: 'gpt-5.5',
    output: [{
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Hello from doCodexCreate', annotations: [] }],
    }],
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    status: 'completed',
    ...payload,
  };
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`,
      ));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const BASE_PARAMS = {
  model: unsafeAssertRoutingModelId('gpt-5.5'),
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 256,
};

describe('OpenAIClient.doCodexCreate', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let capturedCodexBodies: Record<string, unknown>[];

  beforeEach(() => {
    capturedCodexBodies = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = typeof init?.body === 'string' ? init.body : '';
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* leave empty */ }

      if (urlStr.includes('chatgpt.com/backend-api/codex')) {
        capturedCodexBodies.push(parsed);
        // INVARIANT: Codex Responses API requires stream:true. Mock the real
        // 400 behavior so any regression to stream:false fails fast.
        if (parsed.stream !== true) {
          return new Response(
            JSON.stringify({ detail: 'Stream must be set to true' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        return makeCompletedSse();
      }
      throw new Error(`Unexpected fetch URL in test: ${urlStr}`);
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('TRIPWIRE: doCodexCreate sends stream:true upstream to Codex (locks 8e4ae66de-class regressions)', async () => {
    const client = new OpenAIClient({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'unused',
      codexMode: makeCodexMode(),
    });

    const result = await client.create(BASE_PARAMS);

    expect(capturedCodexBodies).toHaveLength(1);
    expect(capturedCodexBodies[0]).toMatchObject({ stream: true });
    expect(capturedCodexBodies[0].stream).not.toBe(false);
    // Smoke check that the buffered SSE → CreateResult round-trip works.
    expect(result.content).toEqual([{ type: 'text', text: 'Hello from doCodexCreate' }]);
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(7);
  });

  it('returns CreateResult assembled from buffered SSE response.completed', async () => {
    const client = new OpenAIClient({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'unused',
      codexMode: makeCodexMode(),
    });

    const result = await client.create(BASE_PARAMS);

    expect(result.stopReason).toBe('end_turn');
    expect(result.model).toBe('gpt-5.5');
  });

  it('falls back to the request model when Codex completion model is empty', async () => {
    fetchSpy.mockImplementation(async () => makeCompletedSse({ model: '' }));

    const client = new OpenAIClient({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'unused',
      codexMode: makeCodexMode(),
    });

    const result = await client.create(BASE_PARAMS);

    expect(result.model).toBe(BASE_PARAMS.model);
    expect(result.model).not.toBe('');
  });

  it('forwards 401 to token-refresh retry path with stream:true preserved on retry', async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const body = typeof init?.body === 'string' ? init.body : '';
      const parsed = JSON.parse(body) as Record<string, unknown>;
      capturedCodexBodies.push(parsed);
      if (callCount === 1) {
        return new Response('unauthorized', { status: 401 });
      }
      return makeCompletedSse();
    });

    const codexMode = makeCodexMode();
    const client = new OpenAIClient({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'unused',
      codexMode,
    });

    const result = await client.create(BASE_PARAMS);

    expect(callCount).toBe(2);
    expect(codexMode.forceRefreshToken).toHaveBeenCalledOnce();
    // Both attempts must have stream:true.
    expect(capturedCodexBodies).toHaveLength(2);
    expect(capturedCodexBodies[0]).toMatchObject({ stream: true });
    expect(capturedCodexBodies[1]).toMatchObject({ stream: true });
    expect(result.content).toEqual([{ type: 'text', text: 'Hello from doCodexCreate' }]);
  });

  it('throws ModelError(server_error) when Codex returns SSE missing response.completed', async () => {
    fetchSpy.mockImplementation(async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: response.created\ndata: {"id":"resp_x"}\n\n'));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const client = new OpenAIClient({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'unused',
      codexMode: makeCodexMode(),
    });

    await expect(client.create(BASE_PARAMS)).rejects.toBeInstanceOf(ModelError);
  });

  it('throws ModelError when Codex returns 400 (e.g. due to a future regression to stream:false)', async () => {
    // This is the contract test that documents how a regression would surface.
    // Force the regression by overriding the body's stream field after capture.
    fetchSpy.mockImplementation(async () => {
      return new Response(
        JSON.stringify({ detail: 'Stream must be set to true' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new OpenAIClient({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'unused',
      codexMode: makeCodexMode(),
    });

    await expect(client.create(BASE_PARAMS)).rejects.toBeInstanceOf(ModelError);
  });
});
