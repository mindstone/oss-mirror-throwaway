/**
 * Stage 1 (260502): watchdog level-1 Sentry-capture gate — typed-predicate
 * path coverage plus F17 (lens-testability) integration coverage for the
 * rawStreamTracker contract that the executor relies on.
 *
 * Scoping decision (per Stage 1 packet): `executeAgentTurn` is heavyweight —
 * wiring a full executor harness (model client, MCP, settings, IPC, registry,
 * tool registry, plugin pre-turn, etc.) for one gate test would dwarf the test
 * itself in setup. The packet explicitly authorises scoping to verifying the
 * gate's decision via the watchdog tracker callback path. This file does
 * exactly that:
 *
 *   (a) builds the same `rawStreamTracker` shape and the same
 *       `onStreamActivity` callback the executor wires,
 *   (b) exercises the same gate-suppression decision the executor's setInterval
 *       tick computes.
 *
 * The full canonical-event-type-derived parameterised suite that walks every
 * Anthropic SDK delta type and every documented OpenAI Responses event type
 * lives in `watchdogTracker.test.ts` (typed-predicate coverage) and
 * `runtimeActivity.test.ts` (mapper coverage).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldSuppressLevel1WatchdogCapture } from '../watchdogTracker';
import {
  serializeRuntimeActivityForTelemetry,
  type RuntimeActivityEvent,
} from '@core/rebelCore/runtimeActivity';
import {
  UNMAPPED_RUNTIME_ACTIVITY_OBSERVED_CAP,
  recordUnmappedActivityObservationOnce,
  __resetUnmappedActivityObservedForTests,
} from '../agentTurnExecutor';

interface RawStreamTracker {
  lastActivity: RuntimeActivityEvent | null;
  lastEventType: string | null;
  lastTimestamp: number | null;
  eventCount: number;
}

function makeRawStreamTracker(): RawStreamTracker {
  return { lastActivity: null, lastEventType: null, lastTimestamp: null, eventCount: 0 };
}

function makeOnStreamActivity(tracker: RawStreamTracker, now: () => number) {
  return (event: RuntimeActivityEvent): void => {
    tracker.lastActivity = event;
    tracker.lastEventType = serializeRuntimeActivityForTelemetry(event);
    tracker.lastTimestamp = now();
    tracker.eventCount++;
  };
}

function evaluateGate(tracker: RawStreamTracker): boolean {
  return shouldSuppressLevel1WatchdogCapture(tracker.lastActivity);
}

describe('agentTurnExecutor watchdog gate — typed RuntimeActivityEvent path', () => {
  let tracker: RawStreamTracker;
  let onStreamActivity: (event: RuntimeActivityEvent) => void;
  let nowMs = 1_700_000_000_000;

  beforeEach(() => {
    tracker = makeRawStreamTracker();
    nowMs = 1_700_000_000_000;
    onStreamActivity = makeOnStreamActivity(tracker, () => nowMs);
  });

  it('updates rawStreamTracker.lastActivity from typed callback', () => {
    onStreamActivity({ kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta' });
    expect(tracker.lastActivity).toEqual({
      kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta',
    });
    expect(tracker.eventCount).toBe(1);
    expect(tracker.lastTimestamp).toBe(nowMs);
  });

  it('serialises lastEventType to the exact raw provider string (F3 — round-trip)', () => {
    const cases: RuntimeActivityEvent[] = [
      { kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta' },
      { kind: 'token-delta', subkind: 'thinking', rawEventType: 'thinking_delta' },
      { kind: 'token-delta', subkind: 'tool-input', rawEventType: 'input_json_delta' },
      { kind: 'lifecycle', subkind: 'message-start', rawEventType: 'message_start' },
      { kind: 'token-delta', subkind: 'text', rawEventType: 'response.output_text.delta' },
      {
        kind: 'token-delta', subkind: 'tool-input',
        rawEventType: 'response.function_call_arguments.delta',
      },
      { kind: 'lifecycle', subkind: 'chat-chunk-final', rawEventType: 'chat.completion.chunk' },
      { kind: 'unknown', rawEventType: 'vendor.unknown.event' },
    ];
    for (const event of cases) {
      const local = makeRawStreamTracker();
      const cb = makeOnStreamActivity(local, () => nowMs);
      cb(event);
      expect(local.lastEventType).toBe(event.rawEventType);
    }
  });

  it('gate suppresses level-1 capture for token-delta activities', () => {
    onStreamActivity({ kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta' });
    expect(evaluateGate(tracker)).toBe(true);
    onStreamActivity({ kind: 'token-delta', subkind: 'thinking', rawEventType: 'thinking_delta' });
    expect(evaluateGate(tracker)).toBe(true);
    onStreamActivity({
      kind: 'token-delta', subkind: 'tool-input', rawEventType: 'input_json_delta',
    });
    expect(evaluateGate(tracker)).toBe(true);
  });

  it('gate fires (does NOT suppress) for lifecycle activities', () => {
    onStreamActivity({ kind: 'lifecycle', subkind: 'message-start', rawEventType: 'message_start' });
    expect(evaluateGate(tracker)).toBe(false);
    onStreamActivity({
      kind: 'lifecycle', subkind: 'response-completed', rawEventType: 'response.completed',
    });
    expect(evaluateGate(tracker)).toBe(false);
    onStreamActivity({
      kind: 'lifecycle', subkind: 'chat-chunk-final', rawEventType: 'chat.completion.chunk',
    });
    expect(evaluateGate(tracker)).toBe(false);
  });

  it('gate fires (does NOT suppress) for unknown activities — fail-closed', () => {
    onStreamActivity({ kind: 'unknown', rawEventType: 'vendor.unknown.event' });
    expect(evaluateGate(tracker)).toBe(false);
  });

  it('gate fires (does NOT suppress) when no activity has been recorded', () => {
    expect(evaluateGate(tracker)).toBe(false);
  });
});

// ============================================================================
// F25 — F6 firehose-mitigation tests for the bounded breadcrumb dedupe Set.
// Validates per-process rate-limited breadcrumb observation behaviour:
//   (a) first call for a given key returns true (breadcrumb fires once)
//   (b) subsequent calls for the same key return false (deduped)
//   (c) cap at 256 with FIFO eviction — eldest entry evicted on overflow
// ============================================================================
describe('recordUnmappedActivityObservationOnce — F25 firehose dedupe', () => {
  beforeEach(() => {
    __resetUnmappedActivityObservedForTests();
  });

  afterEach(() => {
    __resetUnmappedActivityObservedForTests();
  });

  it('returns true on first observation, false on subsequent observations of the same key', () => {
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event')).toBe(true);
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event')).toBe(false);
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event')).toBe(false);
  });

  it('treats distinct keys independently', () => {
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event_a')).toBe(true);
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event_b')).toBe(true);
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event_a')).toBe(false);
    expect(recordUnmappedActivityObservationOnce('vendor.unknown.event_b')).toBe(false);
  });

  it('evicts the eldest entry FIFO once the cap is reached', () => {
    const cap = UNMAPPED_RUNTIME_ACTIVITY_OBSERVED_CAP;
    expect(cap).toBe(256);

    for (let i = 0; i < cap; i++) {
      expect(recordUnmappedActivityObservationOnce(`evict_test:key_${i}`)).toBe(true);
    }

    expect(recordUnmappedActivityObservationOnce('evict_test:key_0')).toBe(false);
    expect(recordUnmappedActivityObservationOnce(`evict_test:key_${cap - 1}`)).toBe(false);

    expect(recordUnmappedActivityObservationOnce(`evict_test:key_${cap}`)).toBe(true);

    expect(recordUnmappedActivityObservationOnce('evict_test:key_0')).toBe(true);
    expect(recordUnmappedActivityObservationOnce('evict_test:key_0')).toBe(false);

    expect(recordUnmappedActivityObservationOnce(`evict_test:key_${cap - 1}`)).toBe(false);
  });
});
