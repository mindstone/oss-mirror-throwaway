import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIClient } from '../openaiClient';
import type { CodexModeConfig } from '../../codexModeTypes';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex';

const BASE_PARAMS = {
  model: unsafeAssertRoutingModelId('gpt-5.5'),
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 256,
};

function makeCodexMode(): CodexModeConfig {
  return {
    endpointUrl: CODEX_ENDPOINT,
    getAccessToken: vi.fn(async () => 'codex-token'),
    getAccountId: vi.fn(() => 'org_test'),
    forceRefreshToken: vi.fn(async () => 'codex-token-refreshed'),
  };
}

function makeCompletedSse(
  headers: Record<string, string>,
  payload: Record<string, unknown> = {},
): Response {
  const completedResponse = {
    id: 'resp_codex_provider_capture',
    model: 'gpt-5.5-codex',
    output: [{
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Codex hello', annotations: [] }],
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
    headers: {
      'content-type': 'text/event-stream',
      ...headers,
    },
  });
}

describe('OpenAIClient provider metadata capture', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('captures allowlisted OpenAI-direct headers and excludes privacy-sensitive headers', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'resp-1',
          object: 'chat.completion',
          created: Date.now(),
          model: 'gpt-5.5',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hi there!' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cf-ray': 'ray-abc',
            'openai-version': '2024-10-01',
            'openai-processing-ms': '412',
            'openai-organization': 'org-secret',
            'x-request-id': 'req-secret',
          },
        },
      ),
    );

    const client = new OpenAIClient({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
    const result = await client.create(BASE_PARAMS);

    expect(result.usage.fulfillmentProvider).toEqual({
      name: null,
      transport: 'openai-direct',
      source: 'response-headers-hints',
      serverHints: {
        'cf-ray': 'ray-abc',
        'openai-version': '2024-10-01',
        'openai-processing-ms': '412',
      },
    });
    expect(result.usage.fulfillmentProvider?.serverHints).not.toHaveProperty('openai-organization');
    expect(result.usage.fulfillmentProvider?.serverHints).not.toHaveProperty('x-request-id');
  });

  it('uses response-body-echo source when OpenAI-direct has no allowlisted header hints', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'resp-2',
          object: 'chat.completion',
          created: Date.now(),
          model: 'gpt-5.5',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hi there!' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );

    const client = new OpenAIClient({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
    const result = await client.create(BASE_PARAMS);

    expect(result.usage.fulfillmentProvider).toEqual({
      name: null,
      transport: 'openai-direct',
      source: 'response-body-echo',
    });
  });

  it('classifies Codex endpoint responses as codex transport', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeCompletedSse({
        'openai-version': '2024-10-01',
      }),
    );

    const client = new OpenAIClient({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'unused',
      codexMode: makeCodexMode(),
    });
    const result = await client.create(BASE_PARAMS);

    expect(result.usage.fulfillmentProvider).toEqual({
      name: null,
      transport: 'codex',
      source: 'response-headers-hints',
      serverHints: {
        'openai-version': '2024-10-01',
      },
    });
  });
});
