import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIClient } from '../openaiClient';
import { ModelError } from '../../modelErrors';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import type { StreamEvent } from '../../modelClient';

// Mid-stream retry idempotency guard (Option X) —
// docs/plans/260616_proxy-transient-retry/PLAN.md
//
// Bug: `runWithRetry` retries a transient stream failure by RE-RUNNING the whole
// `doStream` thunk. If the transient error fires AFTER a `text_delta` has already
// been forwarded to the consumer, the retry re-emits the text and the adapter's
// `accumulatedText` becomes `attempt1_partial + attempt2_full` -> duplicated
// output -> silent transcript corruption.
//
// Fix: once a result-affecting `text_delta` has been forwarded for the logical
// `stream()` call, a subsequent transient error must NOT be retried — throw it
// instead (fail clean). `thinking_delta` is ephemeral and must NOT trip the
// guard (we preserve retry-recovery during the thinking phase). Pre-emission
// transient errors still retry. `create()` (atomic) is unaffected.

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Fail-fast-offline gate (Stage 2 refinement): OpenAIClient.runWithRetry now
// probes reachability on the retry path. These tests assert the retry-FOLD with a
// healthy network and key on exact mockFetch call counts, so stub the probe to
// "online" (false) so it never issues its own corroboration HEADs through mockFetch.
vi.mock('@core/services/timeoutDiagnosticsService', () => ({
  isMachineOffline: vi.fn(async () => false),
}));

vi.mock('@core/services/codexResponsesTranslator', () => ({
  translateChatToResponses: vi.fn((req: unknown) => req),
  translateResponsesToChatCompletion: vi.fn((res: unknown) => res),
  createStreamTranslator: vi.fn(() => ({
    translateEvent: vi.fn(() => null),
  })),
  parseSseEventBlock: vi.fn(() => null),
  readResponsesSseToCompletion: vi.fn(),
}));

const BASE_PARAMS = {
  model: unsafeAssertRoutingModelId('gpt-5.5'),
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 256,
};

const STREAM_IDLE_TIMEOUT_MS = 90_000;
const RETRY_BASE_DELAY_MS = 1_000;

const encoder = new TextEncoder();

const TEXT_CHUNK = (text: string, finishReason: string | null = null): string =>
  `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":${
    text ? `{"content":${JSON.stringify(text)}}` : '{}'
  },"finish_reason":${finishReason === null ? 'null' : JSON.stringify(finishReason)}}]${
    finishReason ? ',"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}' : ''
  }}\n\n`;

const DONE_CHUNK = 'data: [DONE]\n\n';

// A first SSE chunk that ARMS the idle deadline (firstChunkSeen=true once any
// bytes arrive, openaiClient.ts:~1134) but emits NO StreamEvent at all: a
// role-only delta with no content/reasoning/tool_calls -> processStreamChunk
// produces zero events. This exercises the "idle deadline armed but no
// result-affecting (nor any) emission" window.
const ROLE_ONLY_CHUNK =
  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n';

function makeControllableStream(): {
  body: ReadableStream<Uint8Array>;
  enqueue: (sse: string) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    body,
    enqueue: (sse: string) => controller.enqueue(encoder.encode(sse)),
    close: () => controller.close(),
  };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

const makeClient = (): OpenAIClient =>
  new OpenAIClient({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'fake-test',
    provider: 'OpenRouter',
    providerType: 'other',
  });

describe('OpenAIClient mid-stream retry idempotency guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
    vi.restoreAllMocks();
  });

  // ── (1) Post-text-emission transient -> fail clean, NO retry, NO double text ─
  it('does NOT retry a transient error after a text_delta has been emitted', async () => {
    const first = makeControllableStream();
    const second = makeControllableStream();
    mockFetch
      .mockResolvedValueOnce({ ok: true, body: first.body })
      .mockResolvedValueOnce({ ok: true, body: second.body });

    const client = makeClient();
    const onRetry = vi.fn();
    const events: StreamEvent[] = [];
    let caught: unknown;

    const promise = client
      .stream({ ...BASE_PARAMS, onRetry }, (e) => events.push(e))
      .catch((e: unknown) => {
        caught = e;
        return undefined;
      });

    await flushMicrotasks();

    // Emit a result-affecting text_delta (arms the idle deadline too).
    first.enqueue(TEXT_CHUNK('Hello'));
    await flushMicrotasks();

    // Mid-stream transient failure (idle trip after 90s).
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1_000);
    await flushMicrotasks();

    await promise;

    // Exactly one fetch (no retry), text emitted exactly once, transient error
    // surfaced clean. If the guard were absent, fetch would be called twice and
    // 'Hello' would be re-emitted on the retry (the corruption vector).
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Hello' },
    ]);
    expect(caught).toBeInstanceOf(ModelError);
    expect((caught as ModelError).kind).toBe('server_error');
  });

  // ── (2) Pre-emission transient -> recovery preserved (retries, succeeds) ────
  it('still retries a transient error that fires BEFORE any text_delta (recovery preserved)', async () => {
    const second = makeControllableStream();
    mockFetch
      // First attempt: connection-class transient rejection BEFORE any byte.
      .mockRejectedValueOnce(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
      )
      // Second attempt: a clean stream.
      .mockResolvedValueOnce({ ok: true, body: second.body });

    const client = makeClient();
    const onRetry = vi.fn();
    const events: StreamEvent[] = [];

    const promise = client.stream({ ...BASE_PARAMS, onRetry }, (e) => events.push(e));

    await flushMicrotasks();
    // Back off (RETRY_BASE_DELAY_MS * 2^0 = 1000ms) then re-issue fetch.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_DELAY_MS);
    await flushMicrotasks();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);

    second.enqueue(TEXT_CHUNK('Recovered', 'stop'));
    await flushMicrotasks();
    second.enqueue(DONE_CHUNK);
    second.close();
    await flushMicrotasks();

    const result = await promise;
    // Text emitted exactly once, from the successful attempt only.
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Recovered' },
    ]);
    expect(result.content).toEqual([{ type: 'text', text: 'Recovered' }]);
    expect(result.stopReason).toBe('end_turn');
  });

  // ── (3) thinking_delta does NOT trip the guard -> still retries ─────────────
  it('does NOT trip the guard on thinking_delta (retry-recovery during thinking preserved)', async () => {
    const first = makeControllableStream();
    const second = makeControllableStream();
    mockFetch
      .mockResolvedValueOnce({ ok: true, body: first.body })
      .mockResolvedValueOnce({ ok: true, body: second.body });

    const client = makeClient();
    const onRetry = vi.fn();
    const events: StreamEvent[] = [];

    const promise = client.stream({ ...BASE_PARAMS, onRetry }, (e) => events.push(e));

    await flushMicrotasks();

    // Emit a reasoning (thinking) delta — ephemeral, must NOT trip the guard.
    first.enqueue(
      `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"reasoning_content":"thinking..."},"finish_reason":null}]}\n\n`,
    );
    await flushMicrotasks();

    // Mid-stream idle trip after a thinking delta (no text yet).
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1_000);
    await flushMicrotasks();
    // Back off then retry.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_DELAY_MS);
    await flushMicrotasks();

    // Because only a thinking_delta was emitted, the guard allows the retry.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);

    second.enqueue(TEXT_CHUNK('Recovered', 'stop'));
    await flushMicrotasks();
    second.enqueue(DONE_CHUNK);
    second.close();
    await flushMicrotasks();

    const result = await promise;
    expect(events.some((e) => e.type === 'thinking_delta')).toBe(true);
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Recovered' },
    ]);
    expect(result.content).toEqual([{ type: 'text', text: 'Recovered' }]);
  });

  // ── (4) Armed-but-no-emission idle -> still retries to MAX_RETRIES ──────────
  // A first chunk that ARMS the idle deadline (firstChunkSeen) but emits NO
  // StreamEvent (role-only delta — not text, not thinking, not a tool call).
  // The guard is keyed on result-affecting emission, so it must NOT trip here:
  // the idle transient retries normally and exhausts MAX_RETRIES (fetch x4).
  // This restores the idle-path-to-exhaustion coverage and proves the guard
  // only blocks AFTER a text_delta, preserving pre-text idle recovery.
  it('still retries to exhaustion on idle after an armed-but-non-emitting first chunk (fetch x4)', async () => {
    // Every attempt: deliver a role-only chunk (arms idle deadline, emits no
    // StreamEvent) then go silent so each attempt idle-trips.
    mockFetch.mockImplementation(async () => {
      const s = makeControllableStream();
      queueMicrotask(() => s.enqueue(ROLE_ONLY_CHUNK));
      return { ok: true, body: s.body };
    });

    const client = makeClient();
    const onRetry = vi.fn();
    const events: StreamEvent[] = [];
    const promise = client
      .stream({ ...BASE_PARAMS, onRetry }, (e) => events.push(e))
      .catch((e: unknown) => e);

    // 4 attempts (initial + 3 retries). Each: arm idle -> 90s trip -> backoff.
    // Backoffs: 1s, 2s, 4s (Math.random stubbed to 0).
    for (const backoff of [1_000, 2_000, 4_000]) {
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(backoff);
      await flushMicrotasks();
    }
    // Final (4th) attempt idle-trips with no further retry.
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
    await flushMicrotasks();

    const err = await promise;
    expect(mockFetch).toHaveBeenCalledTimes(4); // guard did NOT trip — full retry budget used
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('server_error');
    expect((err as ModelError).message).toContain('went idle');
    // No result-affecting (nor any) event was ever emitted.
    expect(events).toHaveLength(0);
  });
});
