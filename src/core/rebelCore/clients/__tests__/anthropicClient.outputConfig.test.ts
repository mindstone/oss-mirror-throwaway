/**
 * Tests for AnthropicClient output_config.format propagation. Verifies the
 * planner's universal-subset schema flows through to Anthropic unchanged
 * (a flat root `type:'object'` with a nested `type` discriminator enum),
 * distinguishing it from the OpenAI-strict dialect fork delivered by
 * `toOpenAIResponseFormat`. Both dialects share the same flat shape; they
 * differ only in nullability encoding (universal-subset uses nested
 * `anyOf:[{type},{type:'null'}]` for Anthropic compatibility, strict uses
 * `type:['T','null']` arrays).
 *
 * See:
 *   - docs/plans/260505_eval_hotfix_revert_bug_d_fix_bug_e.md (Stage A)
 *   - docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md (§9b)
 */

import { describe, expect, it, vi } from 'vitest';
import { AnthropicClient } from '../anthropicClient';
import { PLAN_OUTPUT_FORMAT, PLAN_RESPONSE_SCHEMA, PLAN_RESPONSE_SCHEMA_OPENAI_STRICT } from '../../planningMode';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

const SUCCESS_MESSAGE = {
  id: 'msg_test',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  model: 'claude-sonnet-4-6',
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
} as const;

describe('AnthropicClient — universal-subset planner schema delivery', () => {
  it('forwards PLAN_OUTPUT_FORMAT.schema to output_config.format on create() unchanged (universal subset, NOT the OpenAI-strict dialect)', async () => {
    const client = new AnthropicClient({ apiKey: 'test-key' });

    let capturedBody: Record<string, unknown> | undefined;
    const createSpy = vi.fn().mockImplementation((body: Record<string, unknown>) => {
      capturedBody = body;
      return Promise.resolve(SUCCESS_MESSAGE);
    });

    (client as unknown as { client: unknown }).client = {
      beta: { messages: { create: createSpy } },
    };

    await client.create({
      model: unsafeAssertRoutingModelId('claude-sonnet-4-6'),
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
      outputConfig: { format: PLAN_OUTPUT_FORMAT },
    });

    expect(capturedBody).toBeDefined();
    const outputConfig = capturedBody!.output_config as { format?: { schema?: unknown } } | undefined;
    expect(outputConfig).toBeDefined();
    expect(outputConfig!.format).toBeDefined();

    const deliveredSchema = outputConfig!.format!.schema as Record<
      string,
      unknown
    > & { properties?: Record<string, unknown> };
    // Anthropic must receive the canonical universal-subset, not the dialect fork.
    expect(deliveredSchema).toBe(PLAN_RESPONSE_SCHEMA);
    expect(deliveredSchema).not.toBe(PLAN_RESPONSE_SCHEMA_OPENAI_STRICT);
    // Universal-subset uses a flat root object with a nested `type`
    // discriminator enum (per the §9b post-Phase-7 flatten).
    expect(deliveredSchema.type).toBe('object');
    expect(deliveredSchema.anyOf).toBeUndefined();
    expect(deliveredSchema.properties?.type).toMatchObject({
      type: 'string',
      enum: ['direct_answer', 'plan'],
    });
  });

  it('forwards PLAN_OUTPUT_FORMAT.schema to output_config.format on stream() unchanged (universal subset)', async () => {
    const client = new AnthropicClient({ apiKey: 'test-key' });

    let capturedBody: Record<string, unknown> | undefined;
    const streamSpy = vi.fn().mockImplementation((body: Record<string, unknown>) => {
      capturedBody = body;
      // Minimal stream object: async iterable + finalMessage().
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'message_start', message: { id: 'msg', usage: { input_tokens: 0 } } };
          yield { type: 'message_stop' };
        },
        finalMessage: () => SUCCESS_MESSAGE,
      };
    });

    (client as unknown as { client: unknown }).client = {
      beta: { messages: { stream: streamSpy, create: vi.fn() } },
    };

    await client.stream(
      {
        model: unsafeAssertRoutingModelId('claude-sonnet-4-6'),
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 16,
        outputConfig: { format: PLAN_OUTPUT_FORMAT },
      },
      () => {
        /* no-op event sink */
      },
    );

    expect(capturedBody).toBeDefined();
    const outputConfig = capturedBody!.output_config as { format?: { schema?: unknown } } | undefined;
    expect(outputConfig).toBeDefined();
    expect(outputConfig!.format).toBeDefined();

    const deliveredSchema = outputConfig!.format!.schema as Record<
      string,
      unknown
    > & { properties?: Record<string, unknown> };
    expect(deliveredSchema).toBe(PLAN_RESPONSE_SCHEMA);
    expect(deliveredSchema.type).toBe('object');
    expect(deliveredSchema.anyOf).toBeUndefined();
    expect(deliveredSchema.properties?.type).toMatchObject({
      type: 'string',
      enum: ['direct_answer', 'plan'],
    });
  });
});
