import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIClient } from '../openaiClient';
import { ModelError } from '../../modelErrors';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

// Regression tests locking in the phase-scoping of the OpenAI-compatible stream
// idle deadline (`readWithFinishDeadline` in `openaiClient.ts`):
//   - idle deadline (STREAM_IDLE_TIMEOUT_MS = 90s) is armed ONLY after the first
//     chunk has arrived (inter-chunk dead-stream backstop). The PRE-first-chunk
//     phase is governed by the separate 5-min STREAM_FIRST_CHUNK_TIMEOUT_MS start
//     guard, NOT by the 90s idle deadline.
//   - finish deadline (LATE_REASONING_FINISH_DEADLINE_MS = 30s) is armed only
//     after `finishReasonSeen`; on fire it gracefully breaks (NOT an error).
//
// The just-fixed bug (F1): the 90s idle deadline used to be armed before the
// first chunk too, shrinking the first-byte window from 5 min -> 90s. Test 1
// proves that regression cannot return.
//
// Provider path driven: the standard chat-completions stream path
// (`OpenAIClient.stream` -> `streamChatCompletions` -> `consumeChatCompletionStream`),
// which is the easiest to drive deterministically (raw SSE line parsing, no
// Responses/Codex translator indirection). One path is sufficient to lock the
// phase-scoping, which lives in the shared `readWithFinishDeadline` helper used
// by all three read loops.

// Mock fetch globally (mirrors the harness in openaiClient.test.ts).
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mirror the codexResponsesTranslator mock from the sibling test file so the
// module graph loads identically; the chat-completions path does not exercise
// these, but keeping the mock avoids pulling real translator internals.
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

const encoder = new TextEncoder();

const TEXT_CHUNK = (text: string, finishReason: string | null = null): string =>
  `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":${
    text ? `{"content":${JSON.stringify(text)}}` : '{}'
  },"finish_reason":${finishReason === null ? 'null' : JSON.stringify(finishReason)}}]${
    finishReason ? ',"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}' : ''
  }}\n\n`;

const DONE_CHUNK = 'data: [DONE]\n\n';

/**
 * A ReadableStream whose controller is captured so the test can enqueue or
 * withhold chunks on demand. The body is wired into a mocked fetch Response.
 */
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

/**
 * Flush pending microtasks so the read promise and any timer-resolution promise
 * inside `readWithFinishDeadline` settle deterministically before we assert.
 */
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

describe('OpenAIClient stream idle deadline phase-scoping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Deterministic retry backoff jitter.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
    vi.restoreAllMocks();
  });

  // ── Test 1 (the F1 regression guard) ──────────────────────────────────────
  it('does NOT idle-trip while waiting for the FIRST chunk (>90s pre-first-chunk silence)', async () => {
    const stream = makeControllableStream();
    mockFetch.mockResolvedValueOnce({ ok: true, body: stream.body });

    const client = makeClient();
    const events: Array<{ type: string; text?: string }> = [];
    let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
    let caught: unknown;

    const promise = client
      .stream(BASE_PARAMS, (e) => events.push(e))
      .then((r) => {
        settled = 'resolved';
        return r;
      })
      .catch((e: unknown) => {
        settled = 'rejected';
        caught = e;
        return undefined;
      });

    // Let fetch resolve and the read loop reach the first (bare) reader.read().
    await flushMicrotasks();

    // Withhold the first chunk and advance fake time well past the 90s idle
    // deadline. Pre-first-chunk, the idle deadline must NOT be armed.
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 30_000); // 120s
    await flushMicrotasks();

    // The stream must still be in flight: no transient idle error, no retry.
    expect(settled).toBe('pending');
    expect(caught).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Now deliver a normal first chunk + [DONE]; the stream completes normally.
    stream.enqueue(TEXT_CHUNK('Hello', 'stop'));
    await flushMicrotasks();
    stream.enqueue(DONE_CHUNK);
    stream.close();
    await flushMicrotasks();

    const result = await promise;
    expect(settled).toBe('resolved');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: 'text_delta', text: 'Hello' }]);
    expect(result?.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(result?.stopReason).toBe('end_turn');
  });

  // ── Test 2: inter-chunk idle AFTER a text_delta -> fail clean, NO retry ────
  // Updated for the Option-X mid-stream idempotency guard
  // (docs/plans/260616_proxy-transient-retry/PLAN.md). The idle deadline still
  // arms post-first-chunk (phase-scoping invariant preserved), but because a
  // result-affecting `text_delta` ('Partial') was already forwarded to the
  // consumer, re-running `doStream` would duplicate output. So the transient
  // idle error now FAILS CLEAN (single error, no second fetch) rather than
  // retrying — preventing `attempt1_partial + attempt2_full` corruption.
  it('idle-trips on >90s inter-chunk silence AFTER text emission -> fails clean (no retry)', async () => {
    const first = makeControllableStream();
    // A second stream is wired but must NEVER be fetched (the guard blocks the
    // retry). If a retry leaked through, fetch count would be 2 and the assert
    // below would catch it.
    const second = makeControllableStream();
    mockFetch
      .mockResolvedValueOnce({ ok: true, body: first.body })
      .mockResolvedValueOnce({ ok: true, body: second.body });

    const client = makeClient();
    const onRetry = vi.fn();
    const events: Array<{ type: string; text?: string }> = [];
    let caught: unknown;

    const promise = client
      .stream({ ...BASE_PARAMS, onRetry }, (e) => events.push(e))
      .catch((e: unknown) => {
        caught = e;
        return undefined;
      });

    await flushMicrotasks();

    // Deliver a first valid chunk (no finish_reason) -> arms the idle deadline
    // AND emits a result-affecting text_delta -> trips the idempotency guard.
    first.enqueue(TEXT_CHUNK('Partial'));
    await flushMicrotasks();

    // Then withhold and advance past the 90s idle deadline -> idle trip.
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1_000);
    await flushMicrotasks();

    await promise;

    // Fail clean: exactly one fetch (no retry), no onRetry callback, the text
    // delta emitted exactly once, and the transient idle error surfaced.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'text_delta', text: 'Partial' }]);
    expect(caught).toBeInstanceOf(ModelError);
    expect((caught as ModelError).kind).toBe('server_error');
    expect((caught as ModelError).message).toContain('went idle');
  });

  // ── Test 3: post-finishReasonSeen silence -> graceful finish path ──────────
  it('takes the graceful 30s finish-deadline path (not the idle error) after finish_reason', async () => {
    const stream = makeControllableStream();
    mockFetch.mockResolvedValueOnce({ ok: true, body: stream.body });

    const client = makeClient();
    const onRetry = vi.fn();
    const events: Array<{ type: string; text?: string }> = [];

    const promise = client.stream({ ...BASE_PARAMS, onRetry }, (e) => events.push(e));

    await flushMicrotasks();

    // Deliver a chunk that carries content AND a finish_reason. This both marks
    // firstChunkSeen (arming the idle deadline on the next read) AND sets
    // state.finishReasonSeen (arming the 30s finish deadline). The finish
    // deadline is shorter, so it binds first and gracefully ends the stream.
    stream.enqueue(TEXT_CHUNK('Answer', 'stop'));
    await flushMicrotasks();

    // Withhold any further bytes (e.g. no trailing [DONE]) and advance ~30s. The
    // 30s finish deadline fires before the 90s idle deadline -> graceful break.
    await vi.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();

    const result = await promise;

    // Graceful: resolved normally, no transient idle error, no retry.
    expect(onRetry).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: 'text_delta', text: 'Answer' }]);
    expect(result.content).toEqual([{ type: 'text', text: 'Answer' }]);
    expect(result.stopReason).toBe('end_turn');
  });

  // Supplementary guard: the idle timeout is classified as a transient
  // server_error. Pre-Option-X this would have retried up to MAX_RETRIES times;
  // post-guard, because a `text_delta` ('Partial') is emitted on the attempt
  // before the idle trip, the retry is blocked and the error surfaces clean on
  // the FIRST attempt (mid-stream idempotency). The classification (transient
  // server_error) is unchanged — only the retry decision differs.
  it('surfaces the idle timeout as a transient server_error and fails clean after text emission', async () => {
    // Every attempt: deliver one chunk then go silent so each attempt idle-trips.
    const controllers: Array<ReturnType<typeof makeControllableStream>> = [];
    mockFetch.mockImplementation(async () => {
      const s = makeControllableStream();
      controllers.push(s);
      // Enqueue the first chunk on the next microtask so the read loop arms the
      // idle deadline, then stays silent.
      queueMicrotask(() => s.enqueue(TEXT_CHUNK('Partial')));
      return { ok: true, body: s.body };
    });

    const client = makeClient();
    const promise = client.stream(BASE_PARAMS, () => {}).catch((e: unknown) => e);

    // The first attempt emits a text_delta then idle-trips. The idempotency
    // guard blocks the retry -> the error surfaces immediately (no backoff loop).
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
    await flushMicrotasks();

    const err = await promise;
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('server_error');
    expect((err as ModelError).message).toContain('went idle');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
