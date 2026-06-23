import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setErrorReporter } from '@core/errorReporter';
import {
  __resetRuntimeActivityMapperDedupeState,
  reportRuntimeActivityMapperFailure,
} from '../runtimeActivityMapperReporter';
import { AnthropicClient } from '../anthropicClient';
import { OpenAIClient } from '../openaiClient';
import type { RuntimeActivityEvent } from '../../runtimeActivity';
import * as runtimeActivity from '../../runtimeActivity';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

const loggerState = vi.hoisted(() => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => loggerState,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

type CapturedError = {
  error: unknown;
  context?: Record<string, unknown>;
};

type ProviderTag = 'anthropic' | 'openai-responses' | 'openai-chat' | 'codex';

const OPENAI_BASE_PARAMS = {
  model: unsafeAssertRoutingModelId('gpt-5.5'),
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 256,
};

const ANTHROPIC_BASE_PARAMS = {
  model: unsafeAssertRoutingModelId('claude-sonnet-4-6'),
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 256,
};

const OPENAI_TOOLS = [
  {
    name: 'Read',
    description: 'Read a file',
    input_schema: { type: 'object' as const, properties: { path: { type: 'string' } } },
  },
];

const silentReporter = {
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
};

function createUtf8Stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function createResponsesSseChunks(text: string): string[] {
  return [
    'event: response.created\ndata: {"id":"resp-1","type":"response.created","model":"gpt-5.5"}\n\n',
    `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: text })}\n\n`,
    'event: response.completed\ndata: {"response":{"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
  ];
}

function createChatSseChunks(text: string): string[] {
  return [
    `data: ${JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5.5',
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5.5',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

function createAnthropicFakeStream(textChunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start' };
      for (const text of textChunks) {
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
      }
      yield { type: 'message_stop' };
    },
    finalMessage: () => ({
      id: 'msg_test',
      content: [{ type: 'text', text: textChunks.join('') }],
      stop_reason: 'end_turn',
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }),
    abort: () => {},
  };
}

async function runOpenAIChatStream(onStreamActivity: (event: RuntimeActivityEvent) => void) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    body: createUtf8Stream(createChatSseChunks('Hello')),
  });

  const client = new OpenAIClient({
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'fake-test-key',
  });

  const emittedEvents: Array<{ type: string; text?: string }> = [];
  const result = await client.stream(
    { ...OPENAI_BASE_PARAMS, onStreamActivity },
    (event) => emittedEvents.push(event),
  );
  return { emittedEvents, result };
}

async function runOpenAIResponsesStream(onStreamActivity: (event: RuntimeActivityEvent) => void) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    body: createUtf8Stream(createResponsesSseChunks('Hello')),
  });

  const client = new OpenAIClient({
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'fake-test-key',
    providerType: 'openai',
  });

  const emittedEvents: Array<{ type: string; text?: string }> = [];
  const result = await client.stream(
    { ...OPENAI_BASE_PARAMS, tools: OPENAI_TOOLS, effort: 'high', onStreamActivity },
    (event) => emittedEvents.push(event),
  );
  return { emittedEvents, result };
}

async function runCodexStream(onStreamActivity: (event: RuntimeActivityEvent) => void) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    body: createUtf8Stream(createResponsesSseChunks('Hello')),
  });

  const client = new OpenAIClient({
    codexMode: {
      endpointUrl: 'https://chatgpt.com/backend-api/codex/responses',
      isConnected: () => true,
      getAccessToken: async () => 'token',
      getAccountId: () => 'org_test',
      forceRefreshToken: async () => 'token',
    },
  });

  const emittedEvents: Array<{ type: string; text?: string }> = [];
  const result = await client.stream(
    { ...OPENAI_BASE_PARAMS, onStreamActivity },
    (event) => emittedEvents.push(event),
  );
  return { emittedEvents, result };
}

async function runAnthropicStream(onStreamActivity: (event: RuntimeActivityEvent) => void) {
  const client = new AnthropicClient({ apiKey: 'test-key' });
  (client as any).client = {
    beta: {
      messages: {
        stream: vi.fn(() => createAnthropicFakeStream(['Hello', ' world'])),
      },
    },
  };

  const emittedEvents: Array<{ type: string; text?: string }> = [];
  const result = await client.stream(
    { ...ANTHROPIC_BASE_PARAMS, onStreamActivity },
    (event) => emittedEvents.push(event),
  );
  return { emittedEvents, result };
}

interface ProducerCase {
  providerTag: ProviderTag;
  expectedRawEventType: string | null;
  installMapperSpy: () => ReturnType<typeof vi.spyOn>;
  runStream: (onStreamActivity: (event: RuntimeActivityEvent) => void) => Promise<{
    emittedEvents: Array<{ type: string; text?: string }>;
    result: { stopReason: string; content: unknown[] };
  }>;
}

const PRODUCERS: ProducerCase[] = [
  {
    providerTag: 'anthropic',
    expectedRawEventType: 'message_start',
    installMapperSpy: () => vi.spyOn(runtimeActivity, 'mapAnthropicStreamEvent'),
    runStream: runAnthropicStream,
  },
  {
    providerTag: 'openai-responses',
    expectedRawEventType: 'response.created',
    installMapperSpy: () => vi.spyOn(runtimeActivity, 'mapOpenAIResponsesEvent'),
    runStream: runOpenAIResponsesStream,
  },
  {
    providerTag: 'openai-chat',
    expectedRawEventType: 'chat.completion.chunk',
    installMapperSpy: () => vi.spyOn(runtimeActivity, 'mapOpenAIChatChunk'),
    runStream: runOpenAIChatStream,
  },
  {
    providerTag: 'codex',
    expectedRawEventType: 'response.created',
    installMapperSpy: () => vi.spyOn(runtimeActivity, 'mapOpenAIResponsesEvent'),
    runStream: runCodexStream,
  },
];

describe('runtime-activity mapper failure observability', () => {
  let captured: CapturedError[] = [];

  beforeEach(() => {
    __resetRuntimeActivityMapperDedupeState();
    loggerState.warn.mockReset();
    captured = [];
    setErrorReporter({
      captureException: (error, context) => captured.push({ error, context }),
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
  });

  afterEach(() => {
    setErrorReporter(silentReporter);
    mockFetch.mockReset();
    vi.restoreAllMocks();
  });

  describe.each(PRODUCERS)('$providerTag producer', ({ providerTag, expectedRawEventType, installMapperSpy, runStream }) => {
    it('captures mapper failure once when the error message repeats', async () => {
      const repeatedMessage = `${providerTag}:mapper-once`;
      installMapperSpy().mockImplementation(() => {
        throw new Error(repeatedMessage);
      });

      await runStream(vi.fn());

      expect(captured).toHaveLength(1);
      expect(captured[0].context).toMatchObject({
        tags: {
          area: 'runtime-activity',
          condition: 'runtime_activity_mapper_failure',
          provider: providerTag,
        },
        extra: {
          rawEventType: expectedRawEventType,
        },
      });
      expect(captured[0].error).toBeInstanceOf(Error);
      expect((captured[0].error as Error).message).toBe(repeatedMessage);

      if (providerTag === 'openai-responses') {
        expect(captured[0].context).toMatchObject({
          fingerprint: ['runtime-activity-mapper-failure'],
          level: 'error',
          _knownConditionWrapped: true,
        });
      }
    });

    it('captures a second time when mapper error message changes', async () => {
      const firstMessage = `${providerTag}:mapper-first`;
      const secondMessage = `${providerTag}:mapper-second`;
      let callCount = 0;

      installMapperSpy().mockImplementation(() => {
        callCount += 1;
        throw new Error(callCount % 2 === 0 ? secondMessage : firstMessage);
      });

      await runStream(vi.fn());

      expect(captured).toHaveLength(2);
      const messages = captured.map((entry) => (entry.error as Error).message).sort();
      expect(messages).toEqual([firstMessage, secondMessage].sort());
    });

    it('does not crash streaming when mapper throws and still emits downstream stream events', async () => {
      installMapperSpy().mockImplementation(() => {
        throw new Error(`${providerTag}:mapper-stream-continues`);
      });

      const { emittedEvents, result } = await runStream(vi.fn());

      expect(result.stopReason).toBe('end_turn');
      expect(result.content.length).toBeGreaterThan(0);
      expect(emittedEvents.some((event) => event.type === 'text_delta')).toBe(true);
    });

    it('does not capture when mapper succeeds', async () => {
      const onStreamActivity = vi.fn();

      const { emittedEvents, result } = await runStream(onStreamActivity);

      expect(onStreamActivity).toHaveBeenCalled();
      expect(captured).toHaveLength(0);
      expect(result.stopReason).toBe('end_turn');
      expect(emittedEvents.some((event) => event.type === 'text_delta')).toBe(true);
    });
  });

  it('caps unique mapper-failure captures at 256 keys and logs a single warning when full', () => {
    for (let i = 0; i < 257; i += 1) {
      reportRuntimeActivityMapperFailure(
        'openai-responses',
        new Error(`cap-overflow-${i}`),
        { rawEventType: `response.type.${i}` },
      );
    }
    reportRuntimeActivityMapperFailure(
      'openai-responses',
      new Error('cap-overflow-after-limit'),
      { rawEventType: 'response.after-limit' },
    );

    expect(captured).toHaveLength(256);
    const capturedMessages = captured.map((entry) => (entry.error as Error).message);
    expect(capturedMessages).toContain('cap-overflow-255');
    expect(capturedMessages).not.toContain('cap-overflow-256');
    expect(capturedMessages).not.toContain('cap-overflow-after-limit');

    const capReachedMessage =
      'Runtime activity mapper-failure dedupe cap reached; subsequent unique errors will not be captured for this process lifetime';
    const capReachedCalls = loggerState.warn.mock.calls.filter(
      (call) => call[1] === capReachedMessage,
    );
    expect(capReachedCalls).toHaveLength(1);
    expect(capReachedCalls[0][0]).toEqual({ capSize: 256, provider: 'openai-responses' });
  });

  it('dedupes mapper failures by the first 200 characters of the error message', () => {
    const sharedPrefix = 'x'.repeat(200);
    const firstMessage = `${sharedPrefix}A-first`;
    const secondMessage = `${sharedPrefix}B-second`;

    reportRuntimeActivityMapperFailure(
      'codex',
      new Error(firstMessage),
      { rawEventType: 'response.created' },
    );
    reportRuntimeActivityMapperFailure(
      'codex',
      new Error(secondMessage),
      { rawEventType: 'response.completed' },
    );

    expect(captured).toHaveLength(1);
    expect((captured[0].error as Error).message).toBe(firstMessage);
  });
});
