/**
 * Fable 5 — client-level wire locks at the anthropicClient body seams
 * (Phase-6 refinement: GPT F3 + Testing F5/T2).
 *
 * The shared `assertWireSafeForAlwaysOnThinking` helper is unit-tested on its
 * own, and the BTS transports' assertion seam is wire-tested — but nothing
 * proved the CORE client's two body builds (doCreate / doStream) actually
 * invoke the assertion, nor that `thinking.display: 'summarized'` survives
 * onto the serialized request body. These tests drive the REAL create()/
 * stream() entry points against an SDK spy:
 *   - a poisoned Fable body (non-adaptive thinking) rejects in test env
 *     BEFORE the SDK is called — proving the assertion is wired at each seam;
 *   - the adaptive + display shape reaches the SDK body untouched for Fable;
 *   - `logRefusalStopDetails` logs `stop_details.category` on both surfaces
 *     (the log line is the only place the category lands today).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicClient } from '../anthropicClient';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

const { mockLog } = vi.hoisted(() => ({
  mockLog: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLog,
  getTurnContext: vi.fn(() => undefined),
}));

function makeMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_test',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    model: 'claude-fable-5',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  };
}

function makeStreamStub(finalMessage: Record<string, unknown>) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { id: 'msg', usage: { input_tokens: 0 } } };
      yield { type: 'message_stop' };
    },
    finalMessage: () => finalMessage,
  };
}

function makeClient(spies: { create?: ReturnType<typeof vi.fn>; stream?: ReturnType<typeof vi.fn> }): AnthropicClient {
  const client = new AnthropicClient({ apiKey: 'test-key' });
  (client as unknown as { client: unknown }).client = {
    beta: {
      messages: {
        create: spies.create ?? vi.fn(),
        stream: spies.stream ?? vi.fn(),
      },
    },
  };
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

const FABLE = unsafeAssertRoutingModelId('claude-fable-5');
const BASE = {
  systemPrompt: 'system',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 256,
};

describe('AnthropicClient — always-on-thinking wire locks (Fable 5)', () => {
  it('doCreate invokes the wire-safety assertion on the built body: a poisoned Fable request rejects BEFORE the SDK call', async () => {
    const createSpy = vi.fn();
    const client = makeClient({ create: createSpy });

    await expect(
      client.create({
        ...BASE,
        model: FABLE,
        // Realistic future-caller mistake: an explicit budgeted-thinking
        // config, which Fable rejects with a 400.
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }),
    ).rejects.toThrow(/Wire-safety violation/);

    expect(createSpy).not.toHaveBeenCalled();
  });

  it('doStream invokes the wire-safety assertion on the built body: a poisoned Fable request rejects BEFORE the SDK call', async () => {
    const streamSpy = vi.fn();
    const client = makeClient({ stream: streamSpy });

    await expect(
      client.stream(
        {
          ...BASE,
          model: FABLE,
          thinking: { type: 'enabled', budget_tokens: 1024 },
        },
        () => {},
      ),
    ).rejects.toThrow(/Wire-safety violation/);

    expect(streamSpy).not.toHaveBeenCalled();
  });

  it('doCreate serializes thinking.display: "summarized" onto the request body for Fable', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const createSpy = vi.fn().mockImplementation((body: Record<string, unknown>) => {
      capturedBody = body;
      return Promise.resolve(makeMessage());
    });
    const client = makeClient({ create: createSpy });

    await client.create({
      ...BASE,
      model: FABLE,
      thinking: { type: 'adaptive', display: 'summarized' },
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(capturedBody?.model).toBe('claude-fable-5');
    expect(capturedBody?.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('doStream serializes thinking.display: "summarized" onto the request body for Fable', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const streamSpy = vi.fn().mockImplementation((body: Record<string, unknown>) => {
      capturedBody = body;
      return makeStreamStub(makeMessage());
    });
    const client = makeClient({ stream: streamSpy });

    await client.stream(
      {
        ...BASE,
        model: FABLE,
        thinking: { type: 'adaptive', display: 'summarized' },
      },
      () => {},
    );

    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(capturedBody?.model).toBe('claude-fable-5');
    expect(capturedBody?.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });
});

describe('AnthropicClient — logRefusalStopDetails (refusal observability)', () => {
  it('doCreate logs stop_details.category when stop_reason is refusal', async () => {
    const createSpy = vi.fn().mockResolvedValue(
      makeMessage({
        content: [],
        stop_reason: 'refusal',
        stop_details: { category: 'harmful_content' },
      }),
    );
    const client = makeClient({ create: createSpy });

    const result = await client.create({ ...BASE, model: FABLE });

    expect(result.stopReason).toBe('refusal');
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        stopReason: 'refusal',
        stopDetailsCategory: 'harmful_content',
        surface: 'doCreate',
        model: 'claude-fable-5',
      }),
      expect.stringContaining('refusal'),
    );
  });

  it('doStream logs stop_details.category when stop_reason is refusal', async () => {
    const streamSpy = vi.fn().mockImplementation(() =>
      makeStreamStub(
        makeMessage({
          content: [],
          stop_reason: 'refusal',
          stop_details: { category: 'harmful_content' },
        }),
      ),
    );
    const client = makeClient({ stream: streamSpy });

    const result = await client.stream({ ...BASE, model: FABLE }, () => {});

    expect(result.stopReason).toBe('refusal');
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        stopReason: 'refusal',
        stopDetailsCategory: 'harmful_content',
        surface: 'doStream',
      }),
      expect.stringContaining('refusal'),
    );
  });

  it('does NOT emit the refusal log for a non-refusal stop reason', async () => {
    const createSpy = vi.fn().mockResolvedValue(makeMessage());
    const client = makeClient({ create: createSpy });

    await client.create({ ...BASE, model: FABLE });

    const refusalWarns = mockLog.warn.mock.calls.filter(
      ([ctx]) => (ctx as { stopReason?: string } | undefined)?.stopReason === 'refusal',
    );
    expect(refusalWarns).toHaveLength(0);
  });
});
