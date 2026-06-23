import { describe, expect, it } from 'vitest';
import {
  finalizeChatCompletionsBody,
  getOpenAiPresetReasoningCapability,
  serializeChatCompletionsBody,
  stripUnsupportedChatCompletionsReasoningParams,
  stripUnsupportedChatCompletionsSamplingParams,
  type ValidatedChatCompletionsBody,
} from '../chatCompletionsParamCapability';

describe('chatCompletionsParamCapability', () => {
  it('uses the OpenAI preset option set for reasoning capability', () => {
    expect(getOpenAiPresetReasoningCapability('gpt-5.5')).toBe(true);
    expect(getOpenAiPresetReasoningCapability('openai/gpt-5.5')).toBe(true);
    expect(getOpenAiPresetReasoningCapability('gpt-4.1')).toBe(false);
    expect(getOpenAiPresetReasoningCapability('unknown-model')).toBeUndefined();
  });

  it('strips temperature and top_p for first-party OpenAI reasoning models', () => {
    const body = { model: 'gpt-5.5', temperature: 0.2, top_p: 0.9, max_completion_tokens: 100 };
    const logCalls: Array<{ strippedParams: string[]; message: string }> = [];

    const stripped = stripUnsupportedChatCompletionsSamplingParams(body, {
      modelId: 'gpt-5.5',
      providerType: 'openai',
      log: {
        info(data: { strippedParams: Array<'temperature' | 'top_p' | 'reasoning_effort'> }, message: string) {
          logCalls.push({ strippedParams: [...data.strippedParams], message });
        },
      },
    });

    expect(stripped).toEqual(['temperature', 'top_p']);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body.max_completion_tokens).toBe(100);
    expect(logCalls).toEqual([
      {
        strippedParams: ['temperature', 'top_p'],
        message: 'Stripped unsupported Chat Completions sampling params for OpenAI reasoning model',
      },
    ]);
  });

  it('keeps sampling params for first-party OpenAI non-reasoning models', () => {
    const body = { temperature: 0.2, top_p: 0.9 };

    const stripped = stripUnsupportedChatCompletionsSamplingParams(body, {
      modelId: 'gpt-4.1',
      providerType: 'openai',
    });

    expect(stripped).toEqual([]);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
  });

  it('keeps sampling params for non-OpenAI providers', () => {
    const body = { temperature: 0.2, top_p: 0.9 };

    const stripped = stripUnsupportedChatCompletionsSamplingParams(body, {
      modelId: 'gpt-5.5',
      providerType: 'openrouter',
    });

    expect(stripped).toEqual([]);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
  });

  it('strips reasoning_effort for first-party OpenAI non-reasoning models', () => {
    const body = { reasoning_effort: 'high', temperature: 0.2, top_p: 0.9, max_completion_tokens: 100 };
    const logCalls: Array<{ strippedParams: string[]; message: string }> = [];

    const stripped = stripUnsupportedChatCompletionsReasoningParams(body, {
      modelId: 'gpt-4.1',
      providerType: 'openai',
      log: {
        info(data: { strippedParams: Array<'temperature' | 'top_p' | 'reasoning_effort'> }, message: string) {
          logCalls.push({ strippedParams: [...data.strippedParams], message });
        },
      },
    });

    expect(stripped).toEqual(['reasoning_effort']);
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    expect(body.max_completion_tokens).toBe(100);
    expect(logCalls).toEqual([
      {
        strippedParams: ['reasoning_effort'],
        message: 'Stripped unsupported Chat Completions reasoning params for OpenAI non-reasoning model',
      },
    ]);
  });

  it('keeps reasoning_effort for first-party OpenAI reasoning models', () => {
    const body = { reasoning_effort: 'high' };

    const stripped = stripUnsupportedChatCompletionsReasoningParams(body, {
      modelId: 'gpt-5.5',
      providerType: 'openai',
    });

    expect(stripped).toEqual([]);
    expect(body.reasoning_effort).toBe('high');
  });

  it('keeps reasoning_effort for non-OpenAI providers', () => {
    const body = { reasoning_effort: 'high' };

    const stripped = stripUnsupportedChatCompletionsReasoningParams(body, {
      modelId: 'gpt-4.1',
      providerType: 'openrouter',
    });

    expect(stripped).toEqual([]);
    expect(body.reasoning_effort).toBe('high');
  });

  it('keeps reasoning_effort for unknown OpenAI models', () => {
    const body = { reasoning_effort: 'high' };

    const stripped = stripUnsupportedChatCompletionsReasoningParams(body, {
      modelId: 'unknown-openai-model',
      providerType: 'openai',
    });

    expect(stripped).toEqual([]);
    expect(body.reasoning_effort).toBe('high');
  });

  it('finalizes gpt-5.5 bodies by stripping sampling params while keeping reasoning_effort', () => {
    const body = {
      model: 'gpt-5.5',
      temperature: 0.2,
      top_p: 0.9,
      reasoning_effort: 'high',
      max_completion_tokens: 100,
    };

    const finalized = finalizeChatCompletionsBody(body, {
      modelId: 'gpt-5.5',
      providerType: 'openai',
    });

    expect(finalized).toBe(body);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body.reasoning_effort).toBe('high');
    expect(serializeChatCompletionsBody(finalized)).toBe(JSON.stringify(body));
  });

  it('finalizes gpt-4.1 bodies by keeping sampling params while stripping reasoning_effort', () => {
    const body = {
      model: 'gpt-4.1',
      temperature: 0.2,
      top_p: 0.9,
      reasoning_effort: 'high',
      max_completion_tokens: 100,
    };

    const finalized = finalizeChatCompletionsBody(body, {
      modelId: 'gpt-4.1',
      providerType: 'openai',
    });

    expect(finalized).toBe(body);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('finalizes unknown OpenAI models without stripping params', () => {
    const body = {
      model: 'unknown-openai-model',
      temperature: 0.2,
      top_p: 0.9,
      reasoning_effort: 'high',
    };

    finalizeChatCompletionsBody(body, {
      modelId: 'unknown-openai-model',
      providerType: 'openai',
    });

    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    expect(body.reasoning_effort).toBe('high');
  });

  it('rejects unbranded bodies at branded sinks at compile time', () => {
    const requiresValidatedBody = <T extends object>(_body: ValidatedChatCompletionsBody<T>): void => {
      void _body;
    };
    const rawBody = { model: 'gpt-5.5', messages: [], max_completion_tokens: 16 };

    // @ts-expect-error — Chat-Completions sinks require finalizeChatCompletionsBody first.
    requiresValidatedBody(rawBody);

    requiresValidatedBody(finalizeChatCompletionsBody(rawBody, {
      modelId: 'gpt-5.5',
      providerType: 'openai',
    }));
  });
});
