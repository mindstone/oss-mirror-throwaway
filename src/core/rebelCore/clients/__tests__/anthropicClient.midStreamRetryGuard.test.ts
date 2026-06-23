/**
 * Mid-stream retry idempotency guard (Option X) for AnthropicClient —
 * docs/plans/260616_proxy-transient-retry/PLAN.md
 *
 * Bug: `runWithRetry` retries a transient stream failure by RE-RUNNING the
 * whole `doStream` thunk. If the transient error fires AFTER a `text_delta`
 * has already been forwarded to the consumer, the retry re-emits the text and
 * the adapter's `accumulatedText` becomes `attempt1_partial + attempt2_full`
 * -> duplicated output -> silent transcript corruption (the `result` then
 * overwrites the clean assistant message via the superset merge rule).
 *
 * Fix: once a result-affecting `text_delta` has been forwarded for the logical
 * `stream()` call, a subsequent transient error must NOT be retried — throw it
 * (fail clean). `thinking_delta` is ephemeral (never enters accumulatedText /
 * result), so it must NOT trip the guard — retry-recovery during the thinking
 * phase is preserved. Pre-emission transient errors still retry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fail-fast-offline gate (Stage 2): runWithRetry probes reachability on the retry
// path. These tests assert the retry-FOLD behavior with a healthy network, so stub
// the probe to "online" (false) for determinism (avoids a real fetch to
// api.anthropic.com tripping the offline gate).
vi.mock('@core/services/timeoutDiagnosticsService', () => ({
  isMachineOffline: vi.fn(async () => false),
}));

import { AnthropicClient } from '../anthropicClient';
import { ModelError } from '../../modelErrors';
import { isMachineOffline } from '@core/services/timeoutDiagnosticsService';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import type { StreamEvent } from '../../modelClient';

const MODEL = unsafeAssertRoutingModelId('claude-sonnet-4-6');

const BASE_PARAMS = {
  model: MODEL,
  systemPrompt: 'system',
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 16,
};

function buildFinalMessage(text: string): unknown {
  return {
    id: 'msg_test',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    model: MODEL,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

const textDeltaEvent = (text: string) => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text },
});

const thinkingDeltaEvent = (thinking: string) => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'thinking_delta', thinking },
});

/** A fake SDK stream that yields the given events then optionally throws. */
function buildFakeStream(opts: {
  events: unknown[];
  throwAfterEvents?: () => unknown; // if set, throw this error after yielding events
  finalText?: string;
}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of opts.events) {
        yield e;
      }
      if (opts.throwAfterEvents) {
        throw opts.throwAfterEvents();
      }
    },
    finalMessage: () => buildFinalMessage(opts.finalText ?? ''),
    abort: () => {},
  };
}

// A transient error: a plain Error whose message matches
// friendlyErrors.isTransientError -> classifyError maps it to server_error
// (isTransient: true).
const transientError = () => new Error('fetch failed');

describe('AnthropicClient mid-stream retry idempotency guard', () => {
  beforeEach(() => {
    // Deterministic backoff jitter; real timers fine — backoff is short and we
    // never block on >1s sleeps because the post-emission case never retries.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // Reset the offline-probe mock to "online" each test — vi.restoreAllMocks()
    // does NOT reset the hoisted vi.fn() from the module mock, so a stray
    // mockResolvedValueOnce(true) (test 1b) would otherwise leak into the next test.
    vi.mocked(isMachineOffline).mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── (1) Post-text-emission transient -> fail clean, NO retry, NO double text ─
  it('does NOT retry a transient error after a text_delta has been emitted', async () => {
    const client = new AnthropicClient({ apiKey: 'test-key' });

    const streamSpy = vi.fn();
    // Attempt 1: emit a text_delta, then throw a transient error mid-stream.
    streamSpy.mockImplementationOnce(() =>
      buildFakeStream({ events: [textDeltaEvent('Hello')], throwAfterEvents: transientError }),
    );
    // Attempt 2 wired but must NEVER be reached (guard blocks retry).
    streamSpy.mockImplementationOnce(() =>
      buildFakeStream({ events: [textDeltaEvent('Hello world')], finalText: 'Hello world' }),
    );

    (client as unknown as { client: unknown }).client = {
      beta: { messages: { stream: streamSpy } },
    };

    const events: StreamEvent[] = [];
    const onRetry = vi.fn();

    await expect(
      client.stream({ ...BASE_PARAMS, onRetry }, (e) => events.push(e)),
    ).rejects.toBeInstanceOf(ModelError);

    // Exactly one SDK stream construction (no retry), text emitted exactly once.
    // Without the guard: streamSpy would be called twice and 'Hello' + 'Hello
    // world' would both be emitted (the duplication / corruption vector).
    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Hello' },
    ]);
  });

  // ── (1b) F3: even if OFFLINE, post-emission fails clean via isRetrySafe — NOT
  //         converted to the offline terminal (the idempotency guard wins, and it
  //         sits BEFORE the offline gate in runWithRetry's catch) ──────────────
  it('post-emission transient is NOT converted to the offline terminal even when offline (isRetrySafe wins)', async () => {
    // The offline probe WOULD say offline, but result-affecting content already
    // emitted → isRetrySafe() throws the plain transient error first; the offline
    // gate (which sits after isRetrySafe) is never reached, so no marker.
    vi.mocked(isMachineOffline).mockResolvedValue(true);

    const client = new AnthropicClient({ apiKey: 'test-key' });
    const streamSpy = vi.fn();
    streamSpy.mockImplementationOnce(() =>
      buildFakeStream({ events: [textDeltaEvent('Hello')], throwAfterEvents: transientError }),
    );
    streamSpy.mockImplementationOnce(() =>
      buildFakeStream({ events: [textDeltaEvent('Hello world')], finalText: 'Hello world' }),
    );
    (client as unknown as { client: unknown }).client = {
      beta: { messages: { stream: streamSpy } },
    };

    const events: StreamEvent[] = [];
    const error = await client
      .stream({ ...BASE_PARAMS }, (e) => events.push(e))
      .catch((e) => e);

    expect(error).toBeInstanceOf(ModelError);
    // NOT the offline terminal — the mid-stream guard fails clean.
    expect((error as ModelError).details?.offlineFailFast).toBeUndefined();
    // No retry, text emitted exactly once.
    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Hello' },
    ]);
    // The offline gate was never even reached — isRetrySafe threw first.
    expect(vi.mocked(isMachineOffline)).not.toHaveBeenCalled();
  });

  // ── (2) Pre-emission transient -> recovery preserved (retries, succeeds) ────
  it('still retries a transient error that fires BEFORE any text_delta (recovery preserved)', async () => {
    const client = new AnthropicClient({ apiKey: 'test-key' });

    const streamSpy = vi.fn();
    // Attempt 1: throw a transient error before yielding ANY event.
    streamSpy.mockImplementationOnce(() =>
      buildFakeStream({ events: [], throwAfterEvents: transientError }),
    );
    // Attempt 2: a clean stream that produces the full text.
    streamSpy.mockImplementationOnce(() =>
      buildFakeStream({ events: [textDeltaEvent('Recovered')], finalText: 'Recovered' }),
    );

    (client as unknown as { client: unknown }).client = {
      beta: { messages: { stream: streamSpy } },
    };

    const events: StreamEvent[] = [];
    const onRetry = vi.fn();

    const result = await client.stream({ ...BASE_PARAMS, onRetry }, (e) => events.push(e));

    expect(streamSpy).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // Text emitted exactly once, from the successful (second) attempt only.
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Recovered' },
    ]);
    expect(result.content).toEqual([{ type: 'text', text: 'Recovered' }]);
  });

  // ── (3) thinking_delta does NOT trip the guard -> still retries ─────────────
  it('does NOT trip the guard on thinking_delta (retry-recovery during thinking preserved)', async () => {
    const client = new AnthropicClient({ apiKey: 'test-key' });

    const streamSpy = vi.fn();
    // Attempt 1: emit a thinking_delta (ephemeral), then throw transiently.
    streamSpy.mockImplementationOnce(() =>
      buildFakeStream({
        events: [thinkingDeltaEvent('reasoning...')],
        throwAfterEvents: transientError,
      }),
    );
    // Attempt 2: clean stream with the full answer.
    streamSpy.mockImplementationOnce(() =>
      buildFakeStream({ events: [textDeltaEvent('Recovered')], finalText: 'Recovered' }),
    );

    (client as unknown as { client: unknown }).client = {
      beta: { messages: { stream: streamSpy } },
    };

    const events: StreamEvent[] = [];
    const onRetry = vi.fn();

    const result = await client.stream({ ...BASE_PARAMS, onRetry }, (e) => events.push(e));

    // The thinking_delta did NOT trip the guard, so the retry proceeded.
    expect(streamSpy).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'thinking_delta')).toBe(true);
    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Recovered' },
    ]);
    expect(result.content).toEqual([{ type: 'text', text: 'Recovered' }]);
  });
});
