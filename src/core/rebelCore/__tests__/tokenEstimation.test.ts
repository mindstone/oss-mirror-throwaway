import { describe, expect, it } from 'vitest';
import { estimateTokensFromUnknown as estimateTokensFromUnknownFromAgentLoop } from '../agentLoop';
import type { ChatMessage, ToolDefinition } from '../modelTypes';
import type { OpenAIMessage } from '../clients/openaiTypes';
import {
  APPROX_CHARS_PER_TOKEN,
  IMAGE_BLOCK_TOKEN_COST,
  estimatePromptTokens,
  estimateTokensFromUnknown,
} from '../tokenEstimation';

const LARGE_BASE64_IMAGE_A = 'A'.repeat(3_000_000);
const LARGE_BASE64_IMAGE_B = 'B'.repeat(3_000_000);

const oldEstimator = (value: unknown): number => {
  try {
    return Math.ceil(JSON.stringify(value).length / APPROX_CHARS_PER_TOKEN);
  } catch {
    return Math.ceil(String(value).length / APPROX_CHARS_PER_TOKEN);
  }
};

describe('estimateTokensFromUnknown', () => {
  it('returns 0 for null/undefined', () => {
    expect(estimateTokensFromUnknown(null)).toBe(0);
    expect(estimateTokensFromUnknown(undefined)).toBe(0);
  });

  it('counts strings by length / 4', () => {
    expect(estimateTokensFromUnknown('abcd')).toBe(1);
    expect(estimateTokensFromUnknown('abcde')).toBe(2);
  });

  it('returns 1 for numbers', () => {
    expect(estimateTokensFromUnknown(0)).toBe(1);
    expect(estimateTokensFromUnknown(42)).toBe(1);
  });

  it('returns IMAGE_BLOCK_TOKEN_COST for { type: "image", data: <3MB base64> } and does NOT include base64 length', () => {
    const estimate = estimateTokensFromUnknown({
      type: 'image',
      data: LARGE_BASE64_IMAGE_A,
      mimeType: 'image/png',
    });

    expect(estimate).toBe(IMAGE_BLOCK_TOKEN_COST);
  });

  it('returns IMAGE_BLOCK_TOKEN_COST for OpenAI-style { type: "image_url", image_url: {...} }', () => {
    const estimate = estimateTokensFromUnknown({
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${LARGE_BASE64_IMAGE_A}`,
      },
    });

    expect(estimate).toBe(IMAGE_BLOCK_TOKEN_COST);
  });

  it('walks ContentBlock-shaped tool_result with mixed text + image blocks correctly (text counted, images flat)', () => {
    const toolResultWithTextOnly = {
      type: 'tool_result',
      tool_use_id: 'tool-mixed',
      content: [{ type: 'text', text: 'Tool output summary for the user.' }],
    };
    const toolResultWithTextAndImage = {
      ...toolResultWithTextOnly,
      content: [
        { type: 'text', text: 'Tool output summary for the user.' },
        { type: 'image', data: LARGE_BASE64_IMAGE_A, mimeType: 'image/png' },
      ],
    };

    const estimate = estimateTokensFromUnknown(toolResultWithTextAndImage);
    const textOnlyEstimate = estimateTokensFromUnknown(toolResultWithTextOnly);

    expect(estimate).toBe(textOnlyEstimate + IMAGE_BLOCK_TOKEN_COST);
  });

  it('walks legacy { type: "tool_result", content: "string" } correctly (length / 4 plus key overhead)', () => {
    const legacyContent = 'legacy text output'.repeat(20);
    const estimate = estimateTokensFromUnknown({
      type: 'tool_result',
      tool_use_id: 'legacy',
      content: legacyContent,
    });

    const KEY_OVERHEAD = 3;
    const KEY_NAME_TOKENS = Math.ceil('type'.length / APPROX_CHARS_PER_TOKEN)
      + Math.ceil('tool_use_id'.length / APPROX_CHARS_PER_TOKEN)
      + Math.ceil('content'.length / APPROX_CHARS_PER_TOKEN);
    const expected = KEY_OVERHEAD
      + KEY_NAME_TOKENS
      + estimateTokensFromUnknown('tool_result')
      + estimateTokensFromUnknown('legacy')
      + Math.ceil(legacyContent.length / APPROX_CHARS_PER_TOKEN);
    expect(estimate).toBe(expected);
  });

  it('counts content within MAX_RECURSION_DEPTH and returns finite, bounded result', () => {
    let shallow: Record<string, unknown> = { text: 'nested text' };
    for (let i = 0; i < 8; i += 1) {
      shallow = { nested: shallow };
    }

    const shallowEstimate = estimateTokensFromUnknown(shallow);

    expect(Number.isFinite(shallowEstimate)).toBe(true);
    expect(shallowEstimate).toBeGreaterThan(0);
    expect(shallowEstimate).toBeLessThan(1_000);
  });

  it('caps recursion at MAX_RECURSION_DEPTH for pathological deeply-nested input', () => {
    let deep: Record<string, unknown> = { text: 'unreachable text' };
    for (let i = 0; i < 64; i += 1) {
      deep = { nested: deep };
    }

    const deepEstimate = estimateTokensFromUnknown(deep);

    expect(Number.isFinite(deepEstimate)).toBe(true);
    // The walker accumulates key overhead at each depth before hitting the cap, but the unreachable inner text and the bulk of nesting beyond MAX_RECURSION_DEPTH are excluded.
    expect(deepEstimate).toBeLessThan(200);
  });
});

describe('estimatePromptTokens', () => {
  it('sums systemPrompt + messages + tools', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'Read',
        description: 'Read files',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
        },
      },
    ];
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello from user' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello from assistant' }] },
    ];

    const estimate = estimatePromptTokens({
      systemPrompt: 'You are helpful.',
      messages,
      tools,
    });
    const expected = estimateTokensFromUnknown('You are helpful.')
      + estimateTokensFromUnknown(messages)
      + estimateTokensFromUnknown(tools);

    expect(estimate).toBe(expected);
  });

  it('returns finite number for the regression fixture (2 image-block tool_results with 3MB base64 each)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Please generate two concept images.' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Generated two images and stored them on disk.' }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'img-1',
            content: [
              { type: 'text', text: 'Image 1 saved to /tmp/image-1.png' },
              { type: 'image', data: LARGE_BASE64_IMAGE_A, mimeType: 'image/png' },
            ],
          },
          {
            type: 'tool_result',
            tool_use_id: 'img-2',
            content: [
              { type: 'text', text: 'Image 2 saved to /tmp/image-2.png' },
              { type: 'image', data: LARGE_BASE64_IMAGE_B, mimeType: 'image/png' },
            ],
          },
        ],
      },
    ];

    const estimate = estimatePromptTokens({
      systemPrompt: 'You are Rebel.',
      messages,
      tools: [],
    });

    expect(Number.isFinite(estimate)).toBe(true);
    expect(estimate).toBeGreaterThan(IMAGE_BLOCK_TOKEN_COST * 2);
    expect(estimate).toBeLessThan(20_000);
  });

  it('counts object keys (not just values) so structured tool schemas are not under-counted', () => {
    const toolSchema = {
      name: 'fetch_account_information',
      description: 'Fetch detailed account information for a customer',
      input_schema: {
        type: 'object',
        properties: {
          account_identifier: { type: 'string' },
          include_billing_history: { type: 'boolean' },
          maximum_records_to_return: { type: 'integer' },
        },
        required: ['account_identifier'],
      },
    };

    const newEstimate = estimateTokensFromUnknown(toolSchema);
    const oldEstimate = oldEstimator(toolSchema);
    const relativeDelta = Math.abs(newEstimate - oldEstimate) / oldEstimate;

    expect(newEstimate).toBeGreaterThan(0);
    expect(relativeDelta).toBeLessThanOrEqual(0.1);
  });

  it('produces near-identical output (within ±10%) to the old JSON-stringify estimator on a text-only fixture', () => {
    const textOnlyFixture = {
      systemPrompt: 'You are Rebel and summarize documents.'.repeat(40),
      messages: [
        { role: 'user', content: 'User message text.'.repeat(200) },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Assistant response text.'.repeat(180) }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-text',
              content: 'Tool output text'.repeat(250),
            },
          ],
        },
      ],
      tools: [
        {
          name: 'Read',
          description: 'Read files',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        },
      ],
    };

    const newEstimate = estimatePromptTokens(textOnlyFixture);
    const oldEstimate = oldEstimator(textOnlyFixture.systemPrompt)
      + oldEstimator(textOnlyFixture.messages)
      + oldEstimator(textOnlyFixture.tools);
    const relativeDelta = Math.abs(newEstimate - oldEstimate) / oldEstimate;

    expect(relativeDelta).toBeLessThanOrEqual(0.1);
  });

  it('returns POSITIVE_INFINITY only when walker throws unexpected error', () => {
    const throwingObject: Record<string, unknown> = {};
    Object.defineProperty(throwingObject, 'broken', {
      enumerable: true,
      get() {
        throw new Error('broken getter');
      },
    });

    expect(() => estimateTokensFromUnknown(throwingObject)).toThrow('broken getter');
    expect(estimatePromptTokens({ messages: [throwingObject] })).toBe(Number.POSITIVE_INFINITY);
    expect(estimatePromptTokens({ messages: ['safe text'] })).not.toBe(Number.POSITIVE_INFINITY);
  });
});

describe('shared utility consumed by both agentLoop and openaiClient', () => {
  it('returns the same finite token count when the same multimodal content is passed via an OpenAI-style message vs an Anthropic-style ContentBlock array', () => {
    const anthropicStyleMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Please reason over this image.' },
        { type: 'image', data: LARGE_BASE64_IMAGE_A, mimeType: 'image/png' },
      ],
    };

    const openAIStyleMessage: OpenAIMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Please reason over this image.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${LARGE_BASE64_IMAGE_A}` } },
      ],
    };

    const anthropicEstimate = estimateTokensFromUnknownFromAgentLoop(anthropicStyleMessage);
    const openAIEstimate = estimatePromptTokens({ messages: [openAIStyleMessage] });

    expect(Number.isFinite(anthropicEstimate)).toBe(true);
    expect(Number.isFinite(openAIEstimate)).toBe(true);
    expect(openAIEstimate).toBe(anthropicEstimate);
  });
});
