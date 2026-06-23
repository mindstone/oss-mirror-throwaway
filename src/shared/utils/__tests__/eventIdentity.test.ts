import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  assertEventHasSeq,
  dedupEventsByIdentity,
  dropContentEquivalentRestamps,
  getContentEquivalenceKey,
  getEventIdentity,
  isValidSeq,
  replaceTurnEventsFromSuperset,
  unionEventsByIdentity,
} from '../eventIdentity';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
type StatusEvent = Extract<AgentEvent, { type: 'status' }>;
type AssistantEvent = Extract<AgentEvent, { type: 'assistant' }>;
type ResultEvent = Extract<AgentEvent, { type: 'result' }>;
type ToolEvent = Extract<AgentEvent, { type: 'tool' }>;

const restoreNodeEnv = (): void => {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
    return;
  }
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
};

const makeStatusEvent = (overrides: Partial<StatusEvent> = {}): StatusEvent => ({
  type: 'status',
  message: 'status',
  timestamp: 1_000,
  ...overrides,
});

const makeAssistantEvent = (overrides: Partial<AssistantEvent> = {}): AssistantEvent => ({
  type: 'assistant',
  text: 'hello',
  timestamp: 2_000,
  ...overrides,
});

const makeResultEvent = (overrides: Partial<ResultEvent> = {}): ResultEvent => ({
  type: 'result',
  text: 'final answer',
  timestamp: 3_000,
  ...overrides,
});

const makeToolEvent = (overrides: Partial<ToolEvent> = {}): ToolEvent => ({
  type: 'tool',
  toolName: 'Read',
  toolUseId: 'tool-use-1',
  detail: 'detail',
  stage: 'start',
  timestamp: 4_000,
  ...overrides,
});

type SeqStampingAccumulator = {
  appendEvent(event: AgentEvent): AgentEvent;
  stampSeq(event: AgentEvent): AgentEvent;
};

const createSeqStampingAccumulator = async (turnId: string): Promise<SeqStampingAccumulator> => {
  const modulePath = '../../../core/services/' + 'lazyContextAccumulator';
  const module = await import(modulePath) as {
    LazyContextAccumulator: new (id: string) => SeqStampingAccumulator;
  };
  return new module.LazyContextAccumulator(turnId);
};

afterEach(() => {
  restoreNodeEnv();
  vi.restoreAllMocks();
});

describe('getEventIdentity', () => {
  it('returns stable identity for same turnId and seq', () => {
    const turnId = 'turn-1';
    const first = makeStatusEvent({ seq: 7, timestamp: 1111 });
    const second = makeStatusEvent({ seq: 7, timestamp: 9999 });

    expect(getEventIdentity(turnId, first)).toBe(getEventIdentity(turnId, second));
  });

  it('uses type+timestamp fallback when seq is absent', () => {
    const turnId = 'turn-legacy';
    const first = makeStatusEvent({ timestamp: 1234 });
    const second = makeStatusEvent({ timestamp: 1234 });

    expect(getEventIdentity(turnId, first)).toBe(getEventIdentity(turnId, second));
  });

  it('distinguishes fallback identities by type', () => {
    const turnId = 'turn-legacy';
    const status = makeStatusEvent({ timestamp: 1234 });
    const assistant = makeAssistantEvent({ timestamp: 1234 });

    expect(getEventIdentity(turnId, status)).not.toBe(getEventIdentity(turnId, assistant));
  });

  it('distinguishes fallback identities by timestamp', () => {
    const turnId = 'turn-legacy';
    const first = makeStatusEvent({ timestamp: 1234 });
    const second = makeStatusEvent({ timestamp: 5678 });

    expect(getEventIdentity(turnId, first)).not.toBe(getEventIdentity(turnId, second));
  });

  it('treats invalid seq values as legacy fallback identities', () => {
    const turnId = 'turn-invalid';
    const first = makeStatusEvent({ seq: Number.NaN, timestamp: 1234 });
    const second = makeStatusEvent({ timestamp: 1234 });

    expect(getEventIdentity(turnId, first)).toBe(getEventIdentity(turnId, second));
  });
});

describe('dedupEventsByIdentity', () => {
  it('is idempotent when applied repeatedly', () => {
    const turnId = 'turn-dedup';
    const events = [
      makeStatusEvent({ seq: 1 }),
      makeAssistantEvent({ seq: 2 }),
      makeStatusEvent({ seq: 1 }),
    ];

    const once = dedupEventsByIdentity(turnId, events);
    const twice = dedupEventsByIdentity(turnId, once);

    expect(twice).toEqual(once);
  });

  it('preserves first-occurrence order', () => {
    const turnId = 'turn-order';
    const first = makeStatusEvent({ seq: 1, message: 'first' });
    const second = makeAssistantEvent({ seq: 2, text: 'second' });
    const duplicateFirst = makeStatusEvent({ seq: 1, message: 'duplicate-first' });
    const third = makeStatusEvent({ seq: 3, message: 'third' });

    const deduped = dedupEventsByIdentity(turnId, [first, second, duplicateFirst, third]);

    expect(deduped).toHaveLength(3);
    expect(deduped[0]).toBe(first);
    expect(deduped[1]).toBe(second);
    expect(deduped[2]).toBe(third);
  });
});

describe('unionEventsByIdentity', () => {
  it('keeps base events first and appends only new incoming events', () => {
    const turnId = 'turn-union';
    const baseA = makeStatusEvent({ seq: 1, message: 'base-a' });
    const baseB = makeAssistantEvent({ seq: 2, text: 'base-b' });
    const incomingDuplicate = makeStatusEvent({ seq: 2, message: 'duplicate-base-b' });
    const incomingNew = makeStatusEvent({ seq: 3, message: 'incoming-new' });

    const unioned = unionEventsByIdentity(turnId, [baseA, baseB], [incomingDuplicate, incomingNew]);

    expect(unioned).toEqual([baseA, baseB, incomingNew]);
  });

  it('returns incoming superset when incoming already contains base', () => {
    const turnId = 'turn-superset';
    const base = [makeStatusEvent({ seq: 1 }), makeAssistantEvent({ seq: 2 })];
    const incoming = [...base, makeStatusEvent({ seq: 3 })];

    const unioned = unionEventsByIdentity(turnId, base, incoming);

    expect(unioned).toEqual(incoming);
  });

  it('removes overlap duplicates from incoming', () => {
    const turnId = 'turn-overlap';
    const base = [makeStatusEvent({ seq: 1 }), makeAssistantEvent({ seq: 2 })];
    const incoming = [makeAssistantEvent({ seq: 2 }), makeStatusEvent({ seq: 3 })];

    const unioned = unionEventsByIdentity(turnId, base, incoming);

    expect(unioned).toHaveLength(3);
    expect(unioned.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('reports legacy fallback usage once per union call with the event count', () => {
    const turnId = 'turn-legacy-callback';
    const onLegacyFallbackIdentityUsed = vi.fn();
    const base = [makeStatusEvent({ seq: 1 })];
    const incoming = [
      makeStatusEvent({ timestamp: 1_111 }),
      makeAssistantEvent({ timestamp: 2_222 }),
      makeStatusEvent({ seq: 2 }),
    ];

    unionEventsByIdentity(turnId, base, incoming, {
      onLegacyFallbackIdentityUsed,
    });

    expect(onLegacyFallbackIdentityUsed).toHaveBeenCalledTimes(1);
    expect(onLegacyFallbackIdentityUsed).toHaveBeenCalledWith({
      turnId,
      legacyEventCount: 2,
    });
  });

  it('reports seq gaps once per union call when unioned events are discontinuous', () => {
    const turnId = 'turn-seq-gap';
    const onSeqGapDetected = vi.fn();
    const base = [makeStatusEvent({ seq: 1 }), makeAssistantEvent({ seq: 2 })];
    const incoming = [makeStatusEvent({ seq: 5 }), makeAssistantEvent({ seq: 6 })];

    unionEventsByIdentity(turnId, base, incoming, {
      onSeqGapDetected,
    });

    expect(onSeqGapDetected).toHaveBeenCalledTimes(1);
    expect(onSeqGapDetected).toHaveBeenCalledWith({
      turnId,
      gaps: [{ start: 3, end: 4 }],
    });
  });

  it('does not report seq gaps when unioned events are contiguous', () => {
    const turnId = 'turn-seq-contiguous';
    const onSeqGapDetected = vi.fn();
    const base = [makeStatusEvent({ seq: 3 }), makeAssistantEvent({ seq: 4 })];
    const incoming = [makeStatusEvent({ seq: 5 }), makeAssistantEvent({ seq: 6 })];

    unionEventsByIdentity(turnId, base, incoming, {
      onSeqGapDetected,
    });

    expect(onSeqGapDetected).not.toHaveBeenCalled();
  });
});

describe('replaceTurnEventsFromSuperset', () => {
  it('returns a shallow copy of the provided superset', () => {
    const input = [makeStatusEvent({ seq: 1 }), makeAssistantEvent({ seq: 2 })];

    const replaced = replaceTurnEventsFromSuperset('turn-copy', input);

    expect(replaced).toEqual(input);
    expect(replaced).not.toBe(input);
  });
});

describe('assertEventHasSeq', () => {
  it('returns true when seq exists', () => {
    const event = makeStatusEvent({ seq: 5 });
    expect(assertEventHasSeq(event, 'test')).toBe(true);
  });

  it('throws in non-production when seq is missing', () => {
    process.env.NODE_ENV = 'test';
    const event = makeStatusEvent();

    expect(() => assertEventHasSeq(event, 'test.dev')).toThrow(
      '[eventIdentity] event missing seq at test.dev (type=status)',
    );
  });

  it('logs and returns false in production when seq is missing', () => {
    process.env.NODE_ENV = 'production';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = makeStatusEvent();

    expect(assertEventHasSeq(event, 'test.prod')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      '[eventIdentity] event missing seq at test.prod (type=status)',
    );
  });

  it('throws in non-production when seq is invalid', () => {
    process.env.NODE_ENV = 'test';
    const event = makeStatusEvent({ seq: Number.NaN });

    expect(() => assertEventHasSeq(event, 'test.invalid')).toThrow(
      '[eventIdentity] event invalid seq at test.invalid (type=status)',
    );
  });

  it('throws absent-event reason in non-production when event is undefined', () => {
    process.env.NODE_ENV = 'test';

    expect(() => assertEventHasSeq(undefined, 'test.absent')).toThrow(
      '[eventIdentity] event absent-event seq at test.absent (type=unknown)',
    );
  });

  it('throws absent-event reason in non-production when event is null', () => {
    process.env.NODE_ENV = 'test';

    expect(() => assertEventHasSeq(null, 'test.null')).toThrow(
      '[eventIdentity] event absent-event seq at test.null (type=unknown)',
    );
  });

  it('logs and returns false in production when event is null/undefined', () => {
    process.env.NODE_ENV = 'production';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(assertEventHasSeq(undefined, 'test.prod.absent')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      '[eventIdentity] event absent-event seq at test.prod.absent (type=unknown)',
    );
  });

  it('narrows the event to SequencedAgentEvent<T> on success (predicate)', () => {
    process.env.NODE_ENV = 'test';
    const event = makeStatusEvent({ seq: 7 });
    if (assertEventHasSeq(event, 'test.narrowing')) {
      // Inside the branch the type is narrowed to SequencedAgentEvent —
      // accessing `seq` without optional-chaining must compile and equal 7.
      const seqValue: number = event.seq;
      expect(seqValue).toBe(7);
    } else {
      expect.fail('predicate should have narrowed the type');
    }
  });
});

describe('isValidSeq', () => {
  it('accepts only positive integers', () => {
    expect(isValidSeq(1)).toBe(true);
    expect(isValidSeq(42)).toBe(true);
    expect(isValidSeq(0)).toBe(false);
    expect(isValidSeq(-1)).toBe(false);
    expect(isValidSeq(1.5)).toBe(false);
    expect(isValidSeq(Number.NaN)).toBe(false);
    expect(isValidSeq(undefined)).toBe(false);
  });
});

describe('getContentEquivalenceKey', () => {
  it('returns the same key for byte-identical assistant events with different seqs', () => {
    const turnId = 'turn-restamp';
    const original = makeAssistantEvent({ seq: 75, text: 'duplicated answer', timestamp: 9_999 });
    const restamped = makeAssistantEvent({ seq: 77, text: 'duplicated answer', timestamp: 9_999 });

    expect(getContentEquivalenceKey(turnId, original)).toBe(
      getContentEquivalenceKey(turnId, restamped),
    );
  });

  it('returns the same key for byte-identical result events with different seqs', () => {
    const turnId = 'turn-result-restamp';
    const usage = { 'claude-opus-4-7': { inputTokens: 100, outputTokens: 200, providersSeen: [] } };
    const original = makeResultEvent({
      seq: 76,
      text: 'final',
      timestamp: 10_000,
      model: 'claude-opus-4-7',
      modelUsage: usage,
      turnEndReason: 'completed',
    });
    const restamped = makeResultEvent({
      seq: 78,
      text: 'final',
      timestamp: 10_000,
      model: 'claude-opus-4-7',
      modelUsage: usage,
      turnEndReason: 'completed',
    });

    expect(getContentEquivalenceKey(turnId, original)).toBe(
      getContentEquivalenceKey(turnId, restamped),
    );
  });

  it('produces different keys for distinct text at the same timestamp', () => {
    const turnId = 'turn-distinct-text';
    const first = makeAssistantEvent({ timestamp: 5_000, text: 'first' });
    const second = makeAssistantEvent({ timestamp: 5_000, text: 'second' });

    expect(getContentEquivalenceKey(turnId, first)).not.toBe(
      getContentEquivalenceKey(turnId, second),
    );
  });

  it('produces different keys for tool events with distinct toolUseIds at the same timestamp', () => {
    const turnId = 'turn-tool';
    const first = makeToolEvent({ timestamp: 6_000, toolUseId: 'tool-1' });
    const second = makeToolEvent({ timestamp: 6_000, toolUseId: 'tool-2' });

    expect(getContentEquivalenceKey(turnId, first)).not.toBe(
      getContentEquivalenceKey(turnId, second),
    );
  });

  it('produces different keys for tool start vs end at the same timestamp', () => {
    const turnId = 'turn-tool-stage';
    const start = makeToolEvent({ timestamp: 6_500, stage: 'start' });
    const end = makeToolEvent({ timestamp: 6_500, stage: 'end' });

    expect(getContentEquivalenceKey(turnId, start)).not.toBe(
      getContentEquivalenceKey(turnId, end),
    );
  });

  it('returns null for event types outside the content-equivalence scope', () => {
    const turnId = 'turn-status';
    const status = makeStatusEvent({ seq: 1 });
    expect(getContentEquivalenceKey(turnId, status)).toBeNull();
  });

  it('is stable across modelUsage key insertion order on result events', () => {
    const turnId = 'turn-order-stability';
    const usageA = {
      a: { inputTokens: 1, outputTokens: 2, providersSeen: [] },
      b: { inputTokens: 3, outputTokens: 4, providersSeen: [] },
    };
    const usageB = {
      b: { inputTokens: 3, outputTokens: 4, providersSeen: [] },
      a: { inputTokens: 1, outputTokens: 2, providersSeen: [] },
    };
    const left = makeResultEvent({ modelUsage: usageA });
    const right = makeResultEvent({ modelUsage: usageB });

    expect(getContentEquivalenceKey(turnId, left)).toBe(
      getContentEquivalenceKey(turnId, right),
    );
  });
});

describe('unionEventsByIdentity content-equivalence dedup', () => {
  it('collapses byte-identical restamped assistant events with different seqs', () => {
    const turnId = 'turn-assistant-restamp';
    const onContentEquivalentRestampCollapsed = vi.fn();
    const original = makeAssistantEvent({ seq: 75, text: 'echo', timestamp: 1_111 });
    const restamped = makeAssistantEvent({ seq: 77, text: 'echo', timestamp: 1_111 });

    const unioned = unionEventsByIdentity(turnId, [original], [restamped], {
      onContentEquivalentRestampCollapsed,
    });

    expect(unioned).toEqual([original]);
    expect(onContentEquivalentRestampCollapsed).toHaveBeenCalledTimes(1);
    expect(onContentEquivalentRestampCollapsed).toHaveBeenCalledWith({
      turnId,
      droppedSeq: 77,
      retainedSeq: 75,
    });
  });

  it('collapses byte-identical restamped result events with different seqs', () => {
    const turnId = 'turn-result-restamp';
    const onContentEquivalentRestampCollapsed = vi.fn();
    const usage = { 'claude-opus-4-7': { inputTokens: 100, outputTokens: 200, providersSeen: [] } };
    const original = makeResultEvent({
      seq: 76,
      text: 'final',
      timestamp: 2_222,
      model: 'claude-opus-4-7',
      modelUsage: usage,
      turnEndReason: 'completed',
    });
    const restamped = makeResultEvent({
      seq: 78,
      text: 'final',
      timestamp: 2_222,
      model: 'claude-opus-4-7',
      modelUsage: usage,
      turnEndReason: 'completed',
    });

    const unioned = unionEventsByIdentity(turnId, [original], [restamped], {
      onContentEquivalentRestampCollapsed,
    });

    expect(unioned).toEqual([original]);
    expect(onContentEquivalentRestampCollapsed).toHaveBeenCalledTimes(1);
    expect(onContentEquivalentRestampCollapsed).toHaveBeenCalledWith({
      turnId,
      droppedSeq: 78,
      retainedSeq: 76,
    });
  });

  it('collapses byte-identical restamped tool events with the same toolUseId and stage', () => {
    const turnId = 'turn-tool-restamp';
    const onContentEquivalentRestampCollapsed = vi.fn();
    const original = makeToolEvent({
      seq: 80,
      toolUseId: 'tool-1',
      stage: 'end',
      timestamp: 3_333,
      detail: 'detail',
    });
    const restamped = makeToolEvent({
      seq: 82,
      toolUseId: 'tool-1',
      stage: 'end',
      timestamp: 3_333,
      detail: 'detail',
    });

    const unioned = unionEventsByIdentity(turnId, [original], [restamped], {
      onContentEquivalentRestampCollapsed,
    });

    expect(unioned).toEqual([original]);
    expect(onContentEquivalentRestampCollapsed).toHaveBeenCalledTimes(1);
  });

  it('does NOT collapse same-ms tool events with distinct toolUseIds', () => {
    const turnId = 'turn-tool-parallel';
    const onContentEquivalentRestampCollapsed = vi.fn();
    const a = makeToolEvent({ seq: 5, toolUseId: 'tool-a', timestamp: 4_444 });
    const b = makeToolEvent({ seq: 6, toolUseId: 'tool-b', timestamp: 4_444 });

    const unioned = unionEventsByIdentity(turnId, [a], [b], {
      onContentEquivalentRestampCollapsed,
    });

    expect(unioned).toEqual([a, b]);
    expect(onContentEquivalentRestampCollapsed).not.toHaveBeenCalled();
  });

  it('does NOT collapse same-timestamp assistant events with distinct text', () => {
    const turnId = 'turn-assistant-burst';
    const onContentEquivalentRestampCollapsed = vi.fn();
    const a = makeAssistantEvent({ seq: 10, timestamp: 5_555, text: 'chunk-1' });
    const b = makeAssistantEvent({ seq: 11, timestamp: 5_555, text: 'chunk-2' });

    const unioned = unionEventsByIdentity(turnId, [a], [b], {
      onContentEquivalentRestampCollapsed,
    });

    expect(unioned).toEqual([a, b]);
    expect(onContentEquivalentRestampCollapsed).not.toHaveBeenCalled();
  });

  it('preserves legacy fallback behavior unchanged for non-content-equivalence events', () => {
    const turnId = 'turn-legacy-untouched';
    const baseA = makeStatusEvent({ seq: 1 });
    const baseB = makeStatusEvent({ seq: 2, timestamp: 1_500 });
    const incoming = makeStatusEvent({ seq: 3, timestamp: 1_600 });

    const unioned = unionEventsByIdentity(turnId, [baseA, baseB], [incoming]);

    expect(unioned).toEqual([baseA, baseB, incoming]);
  });
});

describe('dropContentEquivalentRestamps', () => {
  it('drops the later content-equivalent assistant event and emits the callback', () => {
    const turnId = 'turn-restamp-direct';
    const original = makeAssistantEvent({ seq: 75, text: 'twice', timestamp: 8_888 });
    const restamped = makeAssistantEvent({ seq: 77, text: 'twice', timestamp: 8_888 });
    const onContentEquivalentRestampCollapsed = vi.fn();

    const result = dropContentEquivalentRestamps(turnId, [original, restamped], {
      onContentEquivalentRestampCollapsed,
    });

    expect(result).toEqual([original]);
    expect(onContentEquivalentRestampCollapsed).toHaveBeenCalledWith({
      turnId,
      droppedSeq: 77,
      retainedSeq: 75,
    });
  });

  it('leaves non-content-equivalence events untouched', () => {
    const turnId = 'turn-direct-passthrough';
    const status = makeStatusEvent({ seq: 1 });
    const result = dropContentEquivalentRestamps(turnId, [status]);
    expect(result).toEqual([status]);
  });
});

describe('LazyContextAccumulator seq stamping', () => {
  it('stamps missing seq values on appendEvent monotonically', async () => {
    const accumulator = await createSeqStampingAccumulator('turn-append');
    const first = accumulator.appendEvent(makeStatusEvent());
    const second = accumulator.appendEvent(makeAssistantEvent());

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it('preserves existing seq and advances counter for subsequent appends', async () => {
    const accumulator = await createSeqStampingAccumulator('turn-existing-seq');
    const existing = accumulator.appendEvent(makeStatusEvent({ seq: 10 }));
    const next = accumulator.appendEvent(makeStatusEvent());

    expect(existing.seq).toBe(10);
    expect(next.seq).toBe(11);
  });

  it('shares one monotonic sequence between stampSeq and appendEvent', async () => {
    const accumulator = await createSeqStampingAccumulator('turn-shared-counter');
    const deltaStamped = accumulator.stampSeq({
      type: 'assistant_delta',
      text: 'delta',
      timestamp: 5_000,
    });
    const appended = accumulator.appendEvent(makeStatusEvent());
    const nextDelta = accumulator.stampSeq({
      type: 'assistant_delta',
      text: 'delta-2',
      timestamp: 5_001,
    });

    expect(deltaStamped.seq).toBe(1);
    expect(appended.seq).toBe(2);
    expect(nextDelta.seq).toBe(3);
  });

  it('preserves seq passed to stampSeq and bumps later appendEvent seq', async () => {
    const accumulator = await createSeqStampingAccumulator('turn-stamp-existing');
    const stamped = accumulator.stampSeq({
      type: 'assistant_delta',
      text: 'delta',
      timestamp: 6_000,
      seq: 25,
    });
    const appended = accumulator.appendEvent(makeStatusEvent());

    expect(stamped.seq).toBe(25);
    expect(appended.seq).toBe(26);
  });

  it('appendEvent stamps a positive integer seq (runtime assertion of branded contract)', async () => {
    // Runtime portion: `appendEvent` always returns an event carrying a
    // positive integer `seq`. The compile-time branded-type contract is
    // enforced separately by `lint:ts` — `LazyContextAccumulator.appendEvent`'s
    // signature returns `SequencedAgentEvent<T>`, and `PersistUserQuestionAnsweredFn`
    // requires the same brand. See
    // docs-private/postmortems/260502_persist_user_question_answered_unstamped_postmortem.md.
    const accumulator = await createSeqStampingAccumulator('turn-brand');
    const stamped = accumulator.appendEvent(makeStatusEvent());
    expect(isValidSeq(stamped.seq)).toBe(true);
  });
});
