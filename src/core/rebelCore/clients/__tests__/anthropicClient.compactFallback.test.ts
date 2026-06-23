/**
 * Tests for the `compact_20260112` not-supported fallback in AnthropicClient.
 *
 * Implements the Stage 6 fallback documented in
 * docs/plans/260405_cache_aware_context_management.md and addresses Sentry
 * REBEL-51K (Haiku 4.5 rejecting `compact_20260112`).
 */

import { describe, expect, it, vi } from 'vitest';
import { AnthropicClient, isCompactNotSupportedError, modelSupportsAnthropicCompact } from '../anthropicClient';
import { supportsCompact } from '../../modelLimits';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

function getAnthropicBetaHeader(client: AnthropicClient): string | undefined {
  return (
    (client as unknown as { client?: { _options?: { defaultHeaders?: Record<string, string> } } })
      .client
      ?._options
      ?.defaultHeaders
      ?.['anthropic-beta']
  );
}

describe('AnthropicClient constructor anthropic-beta header', () => {
  it('includes context-management and compact betas in stable order with deduplication', () => {
    const client = new AnthropicClient({
      apiKey: 'test-key',
      enableContextManagement: true,
      enableCompact: true,
      defaultHeaders: {
        'anthropic-beta': 'compact-2026-01-12,other-flag,context-management-2025-06-27,other-flag',
      },
    });

    expect(getAnthropicBetaHeader(client)).toBe(
      'context-management-2025-06-27,compact-2026-01-12,other-flag',
    );
  });

  it('includes only context-management when compact is disabled', () => {
    const client = new AnthropicClient({
      apiKey: 'test-key',
      enableContextManagement: true,
      enableCompact: false,
      defaultHeaders: {
        'anthropic-beta': 'compact-2026-01-12,other-flag',
      },
    });

    expect(getAnthropicBetaHeader(client)).toBe('context-management-2025-06-27,other-flag');
  });

  it('does not inject context/compact betas when context management is disabled', () => {
    const client = new AnthropicClient({
      apiKey: 'test-key',
      enableContextManagement: false,
      enableCompact: true,
    });

    expect(getAnthropicBetaHeader(client)).toBeUndefined();
  });
});

describe('isCompactNotSupportedError', () => {
  it('matches the live Anthropic 400 body for Haiku 4.5 (REBEL-51K)', () => {
    const message = `400 {"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"'claude-haiku-4-5-20251001' does not support the 'compact_20260112' context management strategy.\\"},\\"request_id\\":\\"req_011CaY7Q1UFyMK779eTCBwkE\\"}","provider_name":"Anthropic","is_byok":false}},"user_id":"org_3CV9R02Xj0nLrVCkAMm4ZU2Kt8T"}`;
    expect(isCompactNotSupportedError(new Error(message))).toBe(true);
  });

  it('matches a plain Anthropic-direct 400 body', () => {
    const message = `400 {"type":"error","error":{"type":"invalid_request_error","message":"'claude-some-model' does not support the 'compact_20260112' context management strategy."}}`;
    expect(isCompactNotSupportedError(new Error(message))).toBe(true);
  });

  it('matches the current Anthropic wording from REBEL-52B probe', () => {
    const message = "context_management.edits.1: Input tag 'compact_20260112' found using 'type' does not match any of the expected tags: 'clear_thinking_20251015', 'clear_tool_uses_20250919'";
    expect(isCompactNotSupportedError(new Error(message))).toBe(true);
  });

  it('matches synthetic future wording when status=400 and compact token are present', () => {
    const error = Object.assign(
      new Error('future phrasing: compact_20260112 was rejected by schema gate'),
      { status: 400 },
    );
    expect(isCompactNotSupportedError(error)).toBe(true);
  });

  it('does NOT match unrelated 400 errors', () => {
    expect(
      isCompactNotSupportedError(
        new Error(
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.6: `tool_use` ids were found without `tool_result` blocks immediately after"}}',
        ),
      ),
    ).toBe(false);
  });

  it('does NOT match prompt-too-long 400s (REBEL-52D)', () => {
    expect(
      isCompactNotSupportedError(
        new Error('400 {"error":{"message":"prompt is too long: 4556590 tokens > 1000000 maximum"}}'),
      ),
    ).toBe(false);
  });

  it('does NOT match without both the compact_20260112 token and a 400/invalid-request signal', () => {
    // `compact_20260112` token present but no 400/invalid-request signal (e.g.
    // preserved in an unrelated debug echo) — the structural anchor is missing.
    expect(
      isCompactNotSupportedError(new Error('debug: applied edits compact_20260112 succeeded')),
    ).toBe(false);
    // A 400 rejection without the compact_20260112 token — different failure.
    expect(
      isCompactNotSupportedError(new Error('400: "does not support streaming for this model"')),
    ).toBe(false);
  });

  it('returns false for null, undefined, empty string, non-Error inputs', () => {
    expect(isCompactNotSupportedError(null)).toBe(false);
    expect(isCompactNotSupportedError(undefined)).toBe(false);
    expect(isCompactNotSupportedError('')).toBe(false);
    expect(isCompactNotSupportedError({})).toBe(false);
    expect(isCompactNotSupportedError(0)).toBe(false);
  });

  it('matches plain string errors carrying both markers', () => {
    // Some providers/proxies may surface bare string errors. Helper accepts
    // any input and stringifies sensibly.
    expect(
      isCompactNotSupportedError(
        "compact_20260112: model does not support this context management strategy",
      ),
    ).toBe(true);
    expect(
      isCompactNotSupportedError(
        new Error("compact_20260112: model does not support this context management strategy"),
      ),
    ).toBe(true);
  });
});

describe('compact capability SSOT', () => {
  it.each([
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-sonnet-4-6',
  ])('returns true in both gates for %s', (model) => {
    expect(modelSupportsAnthropicCompact(model)).toBe(true);
    expect(supportsCompact(model)).toBe(true);
  });

  it.each([
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5',
    'claude-3-5-sonnet-20241022',
  ])('returns false in both gates for %s', (model) => {
    expect(modelSupportsAnthropicCompact(model)).toBe(false);
    expect(supportsCompact(model)).toBe(false);
  });
});

describe('AnthropicClient compact_20260112 fallback', () => {
  // Use a model that passes the modelSupportsAnthropicCompact gate so
  // compact_20260112 is actually included in the first request. These tests
  // verify the API-rejection fallback, not the client-side model gate.
  const COMPACT_MODEL = unsafeAssertRoutingModelId('claude-sonnet-4-6');

  function buildSuccessMessage(): unknown {
    return {
      id: 'msg_test',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      model: COMPACT_MODEL,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
  }

  it('retries once without compact when the model rejects compact_20260112 (create)', async () => {
    const client = new AnthropicClient({
      apiKey: 'test-key',
      enableContextManagement: true,
      enableCompact: true,
    });

    const createSpy = vi.fn();
    let firstBody: Record<string, unknown> | undefined;
    let secondBody: Record<string, unknown> | undefined;
    createSpy.mockImplementationOnce((body: Record<string, unknown>) => {
      firstBody = body;
      throw new Error(
        `400 {"type":"error","error":{"type":"invalid_request_error","message":"'${COMPACT_MODEL}' does not support the 'compact_20260112' context management strategy."}}`,
      );
    });
    createSpy.mockImplementationOnce((body: Record<string, unknown>) => {
      secondBody = body;
      return Promise.resolve(buildSuccessMessage());
    });

    (client as any).client = { beta: { messages: { create: createSpy } } };

    const result = await client.create({
      model: COMPACT_MODEL,
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
    });

    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(createSpy).toHaveBeenCalledTimes(2);

    // First request body should include compact_20260112
    const firstEdits = (firstBody?.context_management as { edits: Array<{ type: string }> })?.edits;
    expect(firstEdits.some((e) => e.type === 'compact_20260112')).toBe(true);

    // Retry should NOT include compact_20260112
    const secondEdits = (secondBody?.context_management as { edits: Array<{ type: string }> })?.edits;
    expect(secondEdits.some((e) => e.type === 'compact_20260112')).toBe(false);
    // clear_tool_uses_20250919 still applied
    expect(secondEdits.some((e) => e.type === 'clear_tool_uses_20250919')).toBe(true);
  });

  it('caches the rejection per client — subsequent calls skip compact entirely', async () => {
    const client = new AnthropicClient({
      apiKey: 'test-key',
      enableContextManagement: true,
      enableCompact: true,
    });

    const bodies: Array<Record<string, unknown>> = [];
    const createSpy = vi.fn().mockImplementation((body: Record<string, unknown>) => {
      bodies.push(body);
      // First call rejects compact, second-call onwards succeeds.
      if (bodies.length === 1) {
        throw new Error(
          `400 {"error":{"message":"'${COMPACT_MODEL}' does not support the 'compact_20260112' context management strategy."}}`,
        );
      }
      return Promise.resolve(buildSuccessMessage());
    });

    (client as any).client = { beta: { messages: { create: createSpy } } };

    // Turn 1 — pays the rejection round-trip and falls back.
    await client.create({
      model: COMPACT_MODEL,
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'turn 1' }],
      maxTokens: 16,
    });
    // Turn 2 — should skip compact from the start, no rejection round-trip.
    await client.create({
      model: COMPACT_MODEL,
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'turn 2' }],
      maxTokens: 16,
    });

    // 2 total calls for turn 1 (initial + fallback) + 1 for turn 2 = 3
    expect(createSpy).toHaveBeenCalledTimes(3);

    // Turn 2 (the third call) should NOT have compact_20260112 — proving
    // the rejection is sticky for the rest of the client's lifetime.
    const turn2Body = bodies[2];
    const turn2Edits = (turn2Body.context_management as { edits: Array<{ type: string }> })?.edits;
    expect(turn2Edits.some((e) => e.type === 'compact_20260112')).toBe(false);
    expect(turn2Edits.some((e) => e.type === 'clear_tool_uses_20250919')).toBe(true);
  });

  it('does NOT trigger fallback for unrelated 400 errors', async () => {
    const client = new AnthropicClient({
      apiKey: 'test-key',
      enableContextManagement: true,
      enableCompact: true,
    });

    const createSpy = vi.fn().mockImplementation(() => {
      throw new Error(
        "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages.6: `tool_use` ids were found without `tool_result` blocks immediately after\"}}",
      );
    });

    (client as any).client = { beta: { messages: { create: createSpy } } };

    await expect(
      client.create({
        model: COMPACT_MODEL,
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 16,
      }),
    ).rejects.toThrow();

    // Generic retry path may retry (server_error/rate_limit yes; invalid_request no).
    // For this specific invalid_request error, MAX_RETRIES does NOT apply
    // since it's not transient. Expect a single SDK call.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT trigger fallback when enableCompact is false', async () => {
    const client = new AnthropicClient({
      apiKey: 'test-key',
      enableContextManagement: true,
      enableCompact: false,
    });

    const createSpy = vi.fn().mockImplementation(() => {
      // Synthetic error — even if the API somehow returned this with compact off,
      // we should NOT mask it with a fallback retry.
      throw new Error(
        `400 {"error":{"message":"'${COMPACT_MODEL}' does not support the 'compact_20260112' context management strategy."}}`,
      );
    });

    (client as any).client = { beta: { messages: { create: createSpy } } };

    await expect(
      client.create({
        model: COMPACT_MODEL,
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 16,
      }),
    ).rejects.toThrow();
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('retries the streaming path without compact when the model rejects compact_20260112', async () => {
    const client = new AnthropicClient({
      apiKey: 'test-key',
      enableContextManagement: true,
      enableCompact: true,
    });

    const events: Array<{ type: string }> = [];
    const onEvent = (e: { type: string }) => events.push({ type: e.type });

    // Build a fake stream that exposes the same async-iteration shape
    // AnthropicClient.doStream() consumes (`for await (event of stream)`,
    // `stream.finalMessage()`, `stream.abort()`).
    const buildFakeStream = (text: string) => {
      const finalMessage = {
        id: 'msg_test',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        model: COMPACT_MODEL,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
        },
        finalMessage: () => finalMessage,
        abort: () => {},
      };
    };

    const streamSpy = vi.fn();
    const bodies: Array<Record<string, unknown>> = [];
    streamSpy.mockImplementationOnce((body: Record<string, unknown>) => {
      bodies.push(body);
      throw new Error(
        `400 {"error":{"message":"'${COMPACT_MODEL}' does not support the 'compact_20260112' context management strategy."}}`,
      );
    });
    streamSpy.mockImplementationOnce((body: Record<string, unknown>) => {
      bodies.push(body);
      return buildFakeStream('hello');
    });

    (client as any).client = { beta: { messages: { stream: streamSpy } } };

    const result = await client.stream(
      {
        model: COMPACT_MODEL,
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 16,
      },
      onEvent,
    );

    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(streamSpy).toHaveBeenCalledTimes(2);

    // First request body included compact_20260112
    const firstEdits = (bodies[0]?.context_management as { edits: Array<{ type: string }> })?.edits;
    expect(firstEdits.some((e) => e.type === 'compact_20260112')).toBe(true);

    // Retry must NOT include compact_20260112 (clear_tool_uses still present)
    const secondEdits = (bodies[1]?.context_management as { edits: Array<{ type: string }> })?.edits;
    expect(secondEdits.some((e) => e.type === 'compact_20260112')).toBe(false);
    expect(secondEdits.some((e) => e.type === 'clear_tool_uses_20250919')).toBe(true);

    // The first call threw before yielding any events, so onEvent must be
    // called exactly once for the second call's text_delta — never duplicated.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('text_delta');

    // Same model on both calls — no accidental model swap on retry.
    expect(bodies[0]?.model).toBe(COMPACT_MODEL);
    expect(bodies[1]?.model).toBe(COMPACT_MODEL);
  });
});
