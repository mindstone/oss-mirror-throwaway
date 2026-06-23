/**
 * Prompt Caching Unit Tests
 *
 * Verifies that the AnthropicClient injects cache_control in API requests
 * and that system prompt passthrough works correctly (string and array forms).
 *
 * See: docs/plans/260326_rebel_core_prompt_caching.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- hoisted mocks ----
const { mockStream, mockCreate } = vi.hoisted(() => ({
  mockStream: vi.fn(),
  mockCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { stream: mockStream, create: mockCreate };
    beta = { messages: { stream: mockStream, create: mockCreate } };
    constructor() { /* accept any config */ }
  }
  class APIUserAbortError extends Error { name = 'APIUserAbortError'; }
  class APIError extends Error { status?: number; }
  return { Anthropic: MockAnthropic, APIUserAbortError, APIError };
});

// Import after mocks are set up
import { AnthropicClient } from '../clients/anthropicClient';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

// ---- helpers ----

/** Build a fake async-iterable stream + finalMessage() that the client iterates over. */
function createMockStreamResponse(overrides?: {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}) {
  const message = {
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: overrides?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: overrides?.cache_read_input_tokens ?? 0,
    },
  };

  // The stream must be async-iterable (for await ... of) and expose finalMessage()
  const asyncIterator = {
    async *[Symbol.asyncIterator]() {
      // Yield one text delta so the loop body executes
      yield {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      };
    },
    finalMessage: async () => message,
  };

  return asyncIterator;
}

/** Build a fake create() response with cache metrics. */
function createMockCreateResponse(overrides?: {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}) {
  return {
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: overrides?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: overrides?.cache_read_input_tokens ?? 0,
    },
  };
}

describe('AnthropicClient prompt caching', () => {
  let capturedParams: Record<string, unknown>;
  let capturedCreateParams: Record<string, unknown>;

  beforeEach(() => {
    capturedParams = {};
    capturedCreateParams = {};
    mockStream.mockReset();
    mockCreate.mockReset();
    mockStream.mockImplementation((params: Record<string, unknown>) => {
      capturedParams = params;
      return createMockStreamResponse();
    });
    mockCreate.mockImplementation((params: Record<string, unknown>) => {
      capturedCreateParams = params;
      return Promise.resolve(createMockCreateResponse());
    });
  });

  const noopOnEvent = () => {};

  it('includes cache_control: { type: "ephemeral" } in request params', async () => {
    const client = new AnthropicClient({ apiKey: 'fake-test-dummy' });

    await client.stream(
      {
        model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
        systemPrompt: 'You are a helpful assistant.',
        messages: [{ role: 'user' as const, content: 'Hello' }],
        maxTokens: 1024,
      },
      noopOnEvent,
    );

    expect(capturedParams.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('passes string system prompt through without conversion', async () => {
    const client = new AnthropicClient({ apiKey: 'fake-test-dummy' });
    const systemPrompt = 'You are a file reader assistant.';

    await client.stream(
      {
        model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
        systemPrompt,
        messages: [{ role: 'user' as const, content: 'Read a file' }],
        maxTokens: 1024,
      },
      noopOnEvent,
    );

    // The system prompt should be passed through as a string, not wrapped in an array
    expect(capturedParams.system).toBe(systemPrompt);
    expect(typeof capturedParams.system).toBe('string');
  });

  it('passes array system prompt through without conversion', async () => {
    const client = new AnthropicClient({ apiKey: 'fake-test-dummy' });
    const systemPrompt = [
      { type: 'text' as const, text: 'You are a helpful assistant.' },
      { type: 'text' as const, text: 'Be concise.', cache_control: { type: 'ephemeral' as const } },
    ];

    await client.stream(
      {
        model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
        systemPrompt: systemPrompt as any,
        messages: [{ role: 'user' as const, content: 'Hello' }],
        maxTokens: 1024,
      },
      noopOnEvent,
    );

    // Should be passed through as-is (same array reference)
    expect(capturedParams.system).toBe(systemPrompt);
    expect(Array.isArray(capturedParams.system)).toBe(true);
    expect(capturedParams.system).toHaveLength(2);
  });

  it('flows cache metrics through mapUsage into StreamResult.usage', async () => {
    mockStream.mockImplementation((params: Record<string, unknown>) => {
      capturedParams = params;
      return createMockStreamResponse({
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 12000,
      });
    });

    const client = new AnthropicClient({ apiKey: 'fake-test-dummy' });

    const result = await client.stream(
      {
        model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
        systemPrompt: 'You are a helpful assistant.',
        messages: [{ role: 'user' as const, content: 'Hello' }],
        maxTokens: 1024,
      },
      noopOnEvent,
    );

    expect(result.usage.cacheCreationTokens).toBe(5000);
    expect(result.usage.cacheReadTokens).toBe(12000);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
  });

  it('includes cache_control even when no tools are provided', async () => {
    const client = new AnthropicClient({ apiKey: 'fake-test-dummy' });

    await client.stream(
      {
        model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
        systemPrompt: 'You are a helpful assistant.',
        messages: [{ role: 'user' as const, content: 'Hello' }],
        maxTokens: 512,
        // tools intentionally omitted
      },
      noopOnEvent,
    );

    expect(capturedParams.cache_control).toEqual({ type: 'ephemeral' });
    // tools should not be in the request at all
    expect(capturedParams.tools).toBeUndefined();
  });

  // ---- doCreate() caching parity tests ----

  it('doCreate() includes cache_control: { type: "ephemeral" } in request params', async () => {
    const client = new AnthropicClient({ apiKey: 'fake-test-dummy' });

    await client.create({
      model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user' as const, content: 'Hello' }],
      maxTokens: 1024,
    });

    expect(capturedCreateParams.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('doCreate() passes string system prompt through correctly', async () => {
    const client = new AnthropicClient({ apiKey: 'fake-test-dummy' });
    const systemPrompt = 'You are a specialized agent.';

    await client.create({
      model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
      systemPrompt,
      messages: [{ role: 'user' as const, content: 'Do something' }],
      maxTokens: 1024,
    });

    expect(capturedCreateParams.system).toBe(systemPrompt);
    expect(typeof capturedCreateParams.system).toBe('string');
  });

  it('doCreate() maps cache metrics through mapUsage into CreateResult.usage', async () => {
    mockCreate.mockImplementation((params: Record<string, unknown>) => {
      capturedCreateParams = params;
      return Promise.resolve(createMockCreateResponse({
        cache_creation_input_tokens: 3000,
        cache_read_input_tokens: 8000,
      }));
    });

    const client = new AnthropicClient({ apiKey: 'fake-test-dummy' });

    const result = await client.create({
      model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user' as const, content: 'Hello' }],
      maxTokens: 1024,
    });

    expect(result.usage.cacheCreationTokens).toBe(3000);
    expect(result.usage.cacheReadTokens).toBe(8000);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
  });
});
