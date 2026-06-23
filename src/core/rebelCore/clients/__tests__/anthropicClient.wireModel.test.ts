/**
 * Regression tests for AnthropicClient wire-model resolution (Bug E).
 *
 * Direct Anthropic must receive bare model ids (e.g. `claude-sonnet-4-6`).
 * OpenRouter passthrough must receive prefixed ids unchanged
 * (e.g. `anthropic/claude-sonnet-4-6`, `deepseek/...`).
 *
 * Discrimination signal: `x-openrouter-turn: 'true'` request header at
 * client construction time. See providerRouteHeaders.ts.
 *
 * See docs/plans/260505_eval_hotfix_revert_bug_d_fix_bug_e.md (Stage B).
 */

import { describe, expect, it, vi } from 'vitest';
import { AnthropicClient, resolveAnthropicWireModel } from '../anthropicClient';
import { ModelError } from '../../modelErrors';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

const routingModel = unsafeAssertRoutingModelId;
const resolveTestWireModel = (model: string, isOpenRouterPassthrough: boolean, provider: string) =>
  resolveAnthropicWireModel(routingModel(model), isOpenRouterPassthrough, provider);

const SUCCESS_MESSAGE = {
  id: 'msg_test',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  model: routingModel('claude-sonnet-4-6'),
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
} as const;

function makeStreamMock(captureBody: (body: Record<string, unknown>) => void) {
  return vi.fn().mockImplementation((body: Record<string, unknown>) => {
    captureBody(body);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { id: 'msg', usage: { input_tokens: 0 } } };
        yield { type: 'message_stop' };
      },
      finalMessage: () => SUCCESS_MESSAGE,
    };
  });
}

describe('resolveAnthropicWireModel — pure helper', () => {
  it('passes plain Claude id through on direct Anthropic', () => {
    expect(resolveTestWireModel('claude-sonnet-4-6', false, 'Anthropic')).toBe('claude-sonnet-4-6');
  });

  it('strips anthropic/ prefix on direct Anthropic', () => {
    expect(resolveTestWireModel('anthropic/claude-sonnet-4-6', false, 'Anthropic')).toBe('claude-sonnet-4-6');
  });

  it('preserves anthropic/ prefix on OpenRouter passthrough', () => {
    expect(resolveTestWireModel('anthropic/claude-sonnet-4-6', true, 'Anthropic')).toBe('anthropic/claude-sonnet-4-6');
  });

  it('preserves plain Claude id on OpenRouter passthrough (unchanged)', () => {
    expect(resolveTestWireModel('claude-sonnet-4-6', true, 'Anthropic')).toBe('claude-sonnet-4-6');
  });

  it('throws ModelError on direct Anthropic for non-Anthropic namespaced id', () => {
    expect(() => resolveTestWireModel('deepseek/deepseek-v4', false, 'Anthropic')).toThrow(ModelError);
    expect(() => resolveTestWireModel('meta-llama/llama-3.3', false, 'Anthropic')).toThrow(ModelError);
    expect(() => resolveTestWireModel('openai/gpt-5.4', false, 'Anthropic')).toThrow(ModelError);
  });

  it('preserves any namespaced id on OpenRouter passthrough', () => {
    expect(resolveTestWireModel('deepseek/deepseek-v4', true, 'Anthropic')).toBe('deepseek/deepseek-v4');
    expect(resolveTestWireModel('meta-llama/llama-3.3', true, 'Anthropic')).toBe('meta-llama/llama-3.3');
  });

  it('rejects empty / whitespace ids before wire resolution', () => {
    expect(() => resolveTestWireModel('', false, 'Anthropic')).toThrow('Invalid routing model id');
    expect(() => resolveTestWireModel('   ', false, 'Anthropic')).toThrow('Invalid routing model id');
    expect(() => resolveTestWireModel('', true, 'Anthropic')).toThrow('Invalid routing model id');
  });

  it('throws ModelError on malformed anthropic/ prefix (multi-slash)', () => {
    expect(() => resolveTestWireModel('anthropic/foo/bar', false, 'Anthropic')).toThrow(ModelError);
    expect(() => resolveTestWireModel('anthropic/', false, 'Anthropic')).toThrow(ModelError);
  });

  it('trims surrounding whitespace before resolving', () => {
    expect(resolveTestWireModel('  claude-sonnet-4-6  ', false, 'Anthropic')).toBe('claude-sonnet-4-6');
    expect(resolveTestWireModel('  anthropic/claude-sonnet-4-6  ', false, 'Anthropic')).toBe('claude-sonnet-4-6');
  });

  it('normalizes dotted Claude aliases on direct Anthropic at the wire boundary', () => {
    // Eval harness or other caller passing a dotted alias must be
    // canonicalized to the hyphenated SDK form Anthropic accepts.
    expect(resolveTestWireModel('anthropic/claude-opus-4.7', false, 'Anthropic')).toBe('claude-opus-4-7');
  });

  it('preserves dotted aliases on OpenRouter passthrough (OR catalog uses dotted form for some models)', () => {
    expect(resolveTestWireModel('anthropic/claude-opus-4.7', true, 'Anthropic')).toBe('anthropic/claude-opus-4.7');
  });

  it('does NOT normalize a BARE (un-prefixed) id — behaviour-preservation guard', () => {
    // Original semantics (preserved through the Stage 1 brand refactor): a bare
    // direct-Anthropic id is sent AS-IS; normalization (dotted->dashed, legacy
    // migration) only happens when stripping the `anthropic/` prefix. This guards
    // against silently normalizing/migrating a bare legacy id onto the wire — a
    // behaviour change the brand refactor must not introduce. (The bare-vs-prefixed
    // asymmetry is intentional-for-now; revisit as a separate, reviewed change.)
    expect(resolveTestWireModel('claude-opus-4.7', false, 'Anthropic')).toBe('claude-opus-4.7');
  });
});

describe('AnthropicClient — wire model in request body (doCreate)', () => {
  it('(a) direct Anthropic + plain id → request body model unchanged', async () => {
    const client = new AnthropicClient({ apiKey: 'test-key' });
    let body: Record<string, unknown> | undefined;
    const createSpy = vi.fn().mockImplementation((b: Record<string, unknown>) => {
      body = b;
      return Promise.resolve(SUCCESS_MESSAGE);
    });
    (client as unknown as { client: unknown }).client = { beta: { messages: { create: createSpy } } };

    await client.create({
      model: routingModel('claude-sonnet-4-6'),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
    });

    expect(body?.model).toBe('claude-sonnet-4-6');
  });

  it('(b) direct Anthropic + anthropic/ prefix → stripped on the wire', async () => {
    const client = new AnthropicClient({ apiKey: 'test-key' });
    let body: Record<string, unknown> | undefined;
    const createSpy = vi.fn().mockImplementation((b: Record<string, unknown>) => {
      body = b;
      return Promise.resolve(SUCCESS_MESSAGE);
    });
    (client as unknown as { client: unknown }).client = { beta: { messages: { create: createSpy } } };

    await client.create({
      model: routingModel('anthropic/claude-sonnet-4-6'),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
    });

    expect(body?.model).toBe('claude-sonnet-4-6');
  });

  it('(c) OpenRouter passthrough + anthropic/ prefix → preserved on the wire', async () => {
    const client = new AnthropicClient({
      apiKey: 'test-key',
      defaultHeaders: { 'x-openrouter-turn': 'true' },
    });
    let body: Record<string, unknown> | undefined;
    const createSpy = vi.fn().mockImplementation((b: Record<string, unknown>) => {
      body = b;
      return Promise.resolve(SUCCESS_MESSAGE);
    });
    (client as unknown as { client: unknown }).client = { beta: { messages: { create: createSpy } } };

    await client.create({
      model: routingModel('anthropic/claude-sonnet-4-6'),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
    });

    expect(body?.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('(d) OpenRouter passthrough + plain id → preserved unchanged', async () => {
    const client = new AnthropicClient({
      apiKey: 'test-key',
      defaultHeaders: { 'x-openrouter-turn': 'true' },
    });
    let body: Record<string, unknown> | undefined;
    const createSpy = vi.fn().mockImplementation((b: Record<string, unknown>) => {
      body = b;
      return Promise.resolve(SUCCESS_MESSAGE);
    });
    (client as unknown as { client: unknown }).client = { beta: { messages: { create: createSpy } } };

    await client.create({
      model: routingModel('claude-sonnet-4-6'),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
    });

    expect(body?.model).toBe('claude-sonnet-4-6');
  });

  it('(f) direct Anthropic + foreign-namespaced id → ModelError, no API call', async () => {
    const client = new AnthropicClient({ apiKey: 'test-key' });
    const createSpy = vi.fn();
    (client as unknown as { client: unknown }).client = { beta: { messages: { create: createSpy } } };

    await expect(
      client.create({
        model: routingModel('deepseek/deepseek-v4'),
        systemPrompt: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 16,
      }),
    ).rejects.toThrow(ModelError);

    expect(createSpy).not.toHaveBeenCalled();
  });

  it('baseURL alone (no x-openrouter-turn header) is treated as direct → strips anthropic/ on the wire', async () => {
    // Detection MUST be header-based, not baseURL-based: test paths and custom
    // proxies set baseURL without setting the OR signal header.
    const client = new AnthropicClient({
      apiKey: 'test-key',
      baseURL: 'http://proxy.local',
    });
    let body: Record<string, unknown> | undefined;
    const createSpy = vi.fn().mockImplementation((b: Record<string, unknown>) => {
      body = b;
      return Promise.resolve(SUCCESS_MESSAGE);
    });
    (client as unknown as { client: unknown }).client = { beta: { messages: { create: createSpy } } };

    await client.create({
      model: routingModel('anthropic/claude-sonnet-4-6'),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
    });

    expect(body?.model).toBe('claude-sonnet-4-6');
  });

  it('mixed-case x-openrouter-turn header is normalized to lowercase → OR passthrough preserved', async () => {
    // Internal producers emit lowercase, but env-derived custom headers via
    // extractProxyConfig preserve caller casing; we normalize at constructor
    // boundary so a mixed-case header still enables OR mode.
    const client = new AnthropicClient({
      apiKey: 'test-key',
      defaultHeaders: { 'X-OpenRouter-Turn': 'true' },
    });
    let body: Record<string, unknown> | undefined;
    const createSpy = vi.fn().mockImplementation((b: Record<string, unknown>) => {
      body = b;
      return Promise.resolve(SUCCESS_MESSAGE);
    });
    (client as unknown as { client: unknown }).client = { beta: { messages: { create: createSpy } } };

    await client.create({
      model: routingModel('anthropic/claude-sonnet-4-6'),
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
    });

    expect(body?.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

describe('AnthropicClient — wire model in request body (doStream)', () => {
  it('(e1) doStream parity: direct Anthropic + anthropic/ prefix → stripped', async () => {
    const client = new AnthropicClient({ apiKey: 'test-key' });
    let body: Record<string, unknown> | undefined;
    const streamSpy = makeStreamMock((b) => {
      body = b;
    });
    (client as unknown as { client: unknown }).client = {
      beta: { messages: { stream: streamSpy, create: vi.fn() } },
    };

    await client.stream(
      {
        model: routingModel('anthropic/claude-sonnet-4-6'),
        systemPrompt: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 16,
      },
      () => {
        /* no-op */
      },
    );

    expect(body?.model).toBe('claude-sonnet-4-6');
  });

  it('(e2) doStream parity: OpenRouter passthrough + anthropic/ prefix → preserved', async () => {
    const client = new AnthropicClient({
      apiKey: 'test-key',
      defaultHeaders: { 'x-openrouter-turn': 'true' },
    });
    let body: Record<string, unknown> | undefined;
    const streamSpy = makeStreamMock((b) => {
      body = b;
    });
    (client as unknown as { client: unknown }).client = {
      beta: { messages: { stream: streamSpy, create: vi.fn() } },
    };

    await client.stream(
      {
        model: routingModel('anthropic/claude-sonnet-4-6'),
        systemPrompt: 's',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 16,
      },
      () => {
        /* no-op */
      },
    );

    expect(body?.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('doStream + direct Anthropic + foreign-namespaced id → ModelError, no stream call', async () => {
    const client = new AnthropicClient({ apiKey: 'test-key' });
    const streamSpy = vi.fn();
    (client as unknown as { client: unknown }).client = {
      beta: { messages: { stream: streamSpy, create: vi.fn() } },
    };

    await expect(
      client.stream(
        {
          model: routingModel('meta-llama/llama-3.3'),
          systemPrompt: 's',
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 16,
        },
        () => {
          /* no-op */
        },
      ),
    ).rejects.toThrow(ModelError);

    expect(streamSpy).not.toHaveBeenCalled();
  });
});
