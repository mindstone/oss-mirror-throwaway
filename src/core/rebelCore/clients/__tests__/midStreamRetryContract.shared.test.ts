/**
 * SHARED mid-stream-retry no-replay contract — class-level coverage for the
 * mid-stream-retry-duplication bug class.
 *
 *   Bug class: `260616_midstream_retry_duplicates_assistant_output`
 *   (sibling `260402_rebel_core_double_reply`).
 *
 * The per-client point regressions (`anthropicClient.midStreamRetryGuard.test.ts`,
 * `openaiClient.midStreamRetryGuard.test.ts`) each assert the guard ONCE, through
 * that client's own bespoke transport plumbing (Anthropic SDK stream spy vs.
 * OpenAI SSE fetch ReadableStream). What they leave open is the **class-level
 * contract**: the no-replay invariant is the SAME for every client and must hold
 * for the FULL `StreamEvent` union, not just the two variants each point test
 * happens to exercise (`text_delta` + `thinking_delta`).
 *
 * This harness drives the SAME parameterized scenario through BOTH real clients'
 * real `stream()` -> `runWithRetry` -> `isResultAffectingStreamEvent` guard, by
 * stubbing only the lowest seam (`doStream`) so the guard wiring under test is the
 * production wiring. The event matrix is built off the canonical `StreamEvent`
 * union via a `satisfies Record<StreamEvent['type'], …>` map, so a NEW union
 * member fails to compile until the contract author classifies it (result-
 * affecting => must block retry; ephemeral => must preserve retry). That closes
 * the gap the point tests cannot: a future event kind silently becoming
 * result-affecting (or vice versa) without a corresponding contract decision.
 *
 * Scope note (non-duplication): this asserts the SHARED `stream()` retry-fold
 * contract — that result-affecting emission blocks the re-run — at the
 * client-contract level for both clients via one harness. It does NOT re-run the
 * point tests' transport-specific plumbing assertions (SSE byte framing, idle
 * deadline timing, fetch-call counts). Those stay where they are.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fail-fast-offline gate (Stage 2 + refinement): BOTH AnthropicClient AND
// OpenAIClient runWithRetry now probe reachability on the retry path (shared
// gate). This contract asserts the retry-FOLD with a healthy network, so stub
// the probe to "online" (false) for determinism across both client legs.
vi.mock('@core/services/timeoutDiagnosticsService', () => ({
  isMachineOffline: vi.fn(async () => false),
}));

import { AnthropicClient } from '../anthropicClient';
import { OpenAIClient } from '../openaiClient';
import { ModelError } from '../../modelErrors';
import { isResultAffectingStreamEvent } from '../../modelClient';
import type { StreamEvent, StreamParams, StreamResult } from '../../modelClient';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

// A transient error: `isTransientError('fetch failed')` -> classifyError maps to
// server_error (isTransient: true). Same trigger both point tests use.
const transientError = (): Error => new Error('fetch failed');

// ── Canonical event matrix, built off the StreamEvent union ─────────────────
// The `satisfies Record<StreamEvent['type'], …>` makes this exhaustive by
// construction: add a new StreamEvent variant and this object fails to compile
// until the new kind is classified here (a forced contract decision). Each cell
// pairs a concrete sample event with the no-replay expectation the guard MUST
// honour — and we cross-check that expectation against the production classifier
// `isResultAffectingStreamEvent` so the matrix can never silently drift from it.

interface EventContractCase {
  /** A concrete StreamEvent of this `type`. */
  readonly sample: StreamEvent;
  /**
   * The class-level invariant: when this event has been forwarded and a
   * transient error then fires, MUST the retry be BLOCKED (true) because the
   * event is result-affecting, or PRESERVED (false) because it is ephemeral?
   */
  readonly blocksRetry: boolean;
}

const EVENT_CONTRACT = {
  text_delta: {
    sample: { type: 'text_delta', text: 'Hello' },
    blocksRetry: true, // enters accumulatedText/result -> replay would duplicate
  },
  thinking_delta: {
    sample: { type: 'thinking_delta', thinking: 'reasoning...' },
    blocksRetry: false, // ephemeral -> retry-recovery must be preserved
  },
  'degraded-status': {
    sample: { type: 'degraded-status', reason: 'late-reasoning-buffer-cap', cap: 'bytes' },
    blocksRetry: false, // ephemeral status signal -> retry preserved
  },
} satisfies Record<StreamEvent['type'], EventContractCase>;

const EVENT_CASES: ReadonlyArray<readonly [StreamEvent['type'], EventContractCase]> =
  Object.entries(EVENT_CONTRACT) as ReadonlyArray<readonly [StreamEvent['type'], EventContractCase]>;

// ── Client adapters: each exposes a real client and a way to stub its lowest
//    seam (`doStream`) so the SHARED stream()/runWithRetry/guard runs verbatim.
//    `doStream` is private; we override it on the instance (test-only) so the
//    production `stream()` wrapper (which builds guardedOnEvent + isRetrySafe) is
//    exactly the code under test.

interface ClientAdapter {
  readonly name: string;
  /** Construct a real client and return it plus a hook to install a fake doStream. */
  make(): {
    stream: (params: StreamParams, onEvent: (e: StreamEvent) => void) => Promise<StreamResult>;
    setDoStream: (fn: (params: StreamParams, onEvent: (e: StreamEvent) => void) => Promise<StreamResult>) => void;
  };
}

const ANTHROPIC_MODEL = unsafeAssertRoutingModelId('claude-sonnet-4-6');
const OPENAI_MODEL = unsafeAssertRoutingModelId('gpt-5.5');

const BASE_PARAMS_BY_CLIENT: Record<string, StreamParams> = {
  AnthropicClient: {
    model: ANTHROPIC_MODEL,
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 16,
  },
  OpenAIClient: {
    model: OPENAI_MODEL,
    systemPrompt: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hello' }],
    maxTokens: 256,
  },
};

const STREAM_RESULT_STUB: StreamResult = {
  content: [{ type: 'text', text: 'Recovered' }],
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
};

function overrideDoStream(
  client: object,
  fn: (params: StreamParams, onEvent: (e: StreamEvent) => void) => Promise<StreamResult>,
): void {
  // `doStream` is private at the type level but a real method at runtime; the
  // shared stream() wrapper invokes it via `this.doStream(...)`. Overriding it on
  // the instance keeps the guard wiring (guardedOnEvent + isRetrySafe) authentic.
  (client as Record<string, unknown>).doStream = fn;
}

const ADAPTERS: ClientAdapter[] = [
  {
    name: 'AnthropicClient',
    make() {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      return {
        stream: (params, onEvent) => client.stream(params, onEvent),
        setDoStream: (fn) => overrideDoStream(client, fn),
      };
    },
  },
  {
    name: 'OpenAIClient',
    make() {
      const client = new OpenAIClient({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'fake-test',
        provider: 'OpenRouter',
        providerType: 'other',
      });
      return {
        stream: (params, onEvent) => client.stream(params, onEvent),
        setDoStream: (fn) => overrideDoStream(client, fn),
      };
    },
  },
];

describe('mid-stream retry no-replay contract (shared across clients)', () => {
  beforeEach(() => {
    // Deterministic, near-zero backoff. The retry-BLOCKED cases never sleep
    // (guard throws first); the retry-PRESERVED cases sleep ~1s of real time
    // once — acceptable and matches the Anthropic point test's real-timer use.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Cross-check: the test's expectation table MUST agree with the production
  // classifier. If someone flips a `blocksRetry` cell without changing the
  // classifier (or vice-versa), this fails — the matrix cannot silently drift.
  it('event matrix expectations agree with isResultAffectingStreamEvent (no drift)', () => {
    for (const [kind, c] of EVENT_CASES) {
      expect(
        isResultAffectingStreamEvent(c.sample),
        `EVENT_CONTRACT['${kind}'].blocksRetry must equal isResultAffectingStreamEvent(sample)`,
      ).toBe(c.blocksRetry);
    }
  });

  for (const adapter of ADAPTERS) {
    describe(adapter.name, () => {
      const baseParams = BASE_PARAMS_BY_CLIENT[adapter.name];

      for (const [kind, contract] of EVENT_CASES) {
        if (contract.blocksRetry) {
          it(`does NOT retry a transient error after a result-affecting '${kind}' event (no replay)`, async () => {
            const { stream, setDoStream } = adapter.make();
            const doStreamSpy = vi.fn(
              async (_params: StreamParams, onEvent: (e: StreamEvent) => void) => {
                // Attempt 1: forward the result-affecting event, THEN fail transiently.
                onEvent(contract.sample);
                throw transientError();
              },
            );
            setDoStream(doStreamSpy);

            const events: StreamEvent[] = [];
            const onRetry = vi.fn();

            await expect(
              stream({ ...baseParams, onRetry }, (e) => events.push(e)),
            ).rejects.toBeInstanceOf(ModelError);

            // Guard fired: exactly one doStream construction (NO re-run), event
            // forwarded exactly once, no retry callback. Without the guard the
            // retry would re-run doStream and re-emit -> duplicated output.
            expect(doStreamSpy).toHaveBeenCalledTimes(1);
            expect(onRetry).not.toHaveBeenCalled();
            expect(events.filter((e) => e.type === kind)).toEqual([contract.sample]);
          });
        } else {
          it(`STILL retries a transient error after an ephemeral '${kind}' event (recovery preserved)`, async () => {
            const { stream, setDoStream } = adapter.make();
            let attempt = 0;
            const doStreamSpy = vi.fn(
              async (_params: StreamParams, onEvent: (e: StreamEvent) => void) => {
                attempt += 1;
                if (attempt === 1) {
                  // Attempt 1: forward the ephemeral event, then fail transiently.
                  onEvent(contract.sample);
                  throw transientError();
                }
                // Attempt 2: clean recovery, emits the real text exactly once.
                onEvent({ type: 'text_delta', text: 'Recovered' });
                return STREAM_RESULT_STUB;
              },
            );
            setDoStream(doStreamSpy);

            const events: StreamEvent[] = [];
            const onRetry = vi.fn();

            const result = await stream({ ...baseParams, onRetry }, (e) => events.push(e));

            // Guard did NOT trip on the ephemeral event: doStream re-ran, retry
            // callback fired, and the result text was emitted exactly once.
            expect(doStreamSpy).toHaveBeenCalledTimes(2);
            expect(onRetry).toHaveBeenCalledTimes(1);
            expect(events.filter((e) => e.type === 'text_delta')).toEqual([
              { type: 'text_delta', text: 'Recovered' },
            ]);
            expect(result.content).toEqual([{ type: 'text', text: 'Recovered' }]);
          });
        }
      }
    });
  }
});
