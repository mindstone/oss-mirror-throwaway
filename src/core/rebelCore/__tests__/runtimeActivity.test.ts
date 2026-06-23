import type { RawContentBlockDelta, RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  BetaRawContentBlockDelta,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shouldSuppressLevel1WatchdogCapture } from '@core/services/watchdog/watchdogTracker';
import {
  KNOWN_ANTHROPIC_BETA_DELTA_TYPES,
  KNOWN_ANTHROPIC_DELTA_TYPES,
  KNOWN_ANTHROPIC_STREAM_EVENT_TYPES,
  mapAnthropicStreamEvent,
  mapOpenAIChatChunk,
  mapOpenAIResponsesEvent,
  type RuntimeActivityEvent,
  serializeRuntimeActivityForTelemetry,
} from '../runtimeActivity';

// eslint-disable-next-line @typescript-eslint/naming-convention -- naming matches Stage 0 drift-gate requirement
type _DeltaCoverage = Exclude<RawContentBlockDelta['type'], typeof KNOWN_ANTHROPIC_DELTA_TYPES[number]>;
type DeltaCoverageAssert = _DeltaCoverage extends never ? true : never;
const _deltaCoverageAssert: DeltaCoverageAssert = true;
void _deltaCoverageAssert;

// eslint-disable-next-line @typescript-eslint/naming-convention -- naming matches Stage 0 drift-gate requirement
type _StreamEventCoverage = Exclude<RawMessageStreamEvent['type'], typeof KNOWN_ANTHROPIC_STREAM_EVENT_TYPES[number]>;
type StreamEventCoverageAssert = _StreamEventCoverage extends never ? true : never;
const _streamEventCoverageAssert: StreamEventCoverageAssert = true;
void _streamEventCoverageAssert;

// eslint-disable-next-line @typescript-eslint/naming-convention -- naming matches Stage 2 beta drift-gate requirement
type _BetaDeltaCoverage = Exclude<BetaRawContentBlockDelta['type'], typeof KNOWN_ANTHROPIC_BETA_DELTA_TYPES[number]>;
type BetaDeltaCoverageAssert = _BetaDeltaCoverage extends never ? true : never;
const _betaDeltaCoverageAssert: BetaDeltaCoverageAssert = true;
void _betaDeltaCoverageAssert;

// eslint-disable-next-line @typescript-eslint/naming-convention -- naming matches Stage 2 drift-gate requirement
type _LifecycleSubkindCoverage = Extract<RuntimeActivityEvent, { kind: 'lifecycle' }>['subkind'];
type LifecycleCancelledCoverageAssert = Extract<_LifecycleSubkindCoverage, 'cancelled'> extends never ? never : true;
const _lifecycleCancelledCoverageAssert: LifecycleCancelledCoverageAssert = true;
void _lifecycleCancelledCoverageAssert;
type LifecycleAbortedCoverageAssert = Extract<_LifecycleSubkindCoverage, 'aborted'> extends never ? never : true;
const _lifecycleAbortedCoverageAssert: LifecycleAbortedCoverageAssert = true;
void _lifecycleAbortedCoverageAssert;
type LifecycleSupersededCoverageAssert = Extract<_LifecycleSubkindCoverage, 'superseded'> extends never ? never : true;
const _lifecycleSupersededCoverageAssert: LifecycleSupersededCoverageAssert = true;
void _lifecycleSupersededCoverageAssert;

type ActivityExpectation = RuntimeActivityEvent & {
  expectedSuppress: boolean;
};

const ANTHROPIC_CASES: Array<{
  name: string;
  event: RawMessageStreamEvent;
  expected: {
    kind: 'token-delta' | 'lifecycle';
    subkind:
      | 'text'
      | 'tool-input'
      | 'citations'
      | 'thinking'
      | 'signature'
      | 'message-start'
      | 'message-delta'
      | 'message-stop'
      | 'content-block-start'
      | 'content-block-stop';
    rawEventType: string;
  };
}> = [
  {
    name: 'text_delta',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hello' },
    } as unknown as RawMessageStreamEvent,
    expected: { kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta' },
  },
  {
    name: 'input_json_delta',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"a":' },
    } as unknown as RawMessageStreamEvent,
    expected: { kind: 'token-delta', subkind: 'tool-input', rawEventType: 'input_json_delta' },
  },
  {
    name: 'citations_delta',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'citations_delta' },
    } as unknown as RawMessageStreamEvent,
    expected: { kind: 'token-delta', subkind: 'citations', rawEventType: 'citations_delta' },
  },
  {
    name: 'thinking_delta',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'hmm' },
    } as unknown as RawMessageStreamEvent,
    expected: { kind: 'token-delta', subkind: 'thinking', rawEventType: 'thinking_delta' },
  },
  {
    name: 'signature_delta',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig' },
    } as unknown as RawMessageStreamEvent,
    expected: { kind: 'token-delta', subkind: 'signature', rawEventType: 'signature_delta' },
  },
  {
    name: 'message_start',
    event: { type: 'message_start' } as unknown as RawMessageStreamEvent,
    expected: { kind: 'lifecycle', subkind: 'message-start', rawEventType: 'message_start' },
  },
  {
    name: 'message_delta',
    event: { type: 'message_delta' } as unknown as RawMessageStreamEvent,
    expected: { kind: 'lifecycle', subkind: 'message-delta', rawEventType: 'message_delta' },
  },
  {
    name: 'message_stop',
    event: { type: 'message_stop' } as unknown as RawMessageStreamEvent,
    expected: { kind: 'lifecycle', subkind: 'message-stop', rawEventType: 'message_stop' },
  },
  {
    name: 'content_block_start',
    event: { type: 'content_block_start' } as unknown as RawMessageStreamEvent,
    expected: { kind: 'lifecycle', subkind: 'content-block-start', rawEventType: 'content_block_start' },
  },
  {
    name: 'content_block_stop',
    event: { type: 'content_block_stop' } as unknown as RawMessageStreamEvent,
    expected: { kind: 'lifecycle', subkind: 'content-block-stop', rawEventType: 'content_block_stop' },
  },
];

const OPENAI_RESPONSES_CASES = [
  ['response.created', 'lifecycle', 'response-created'],
  ['response.in_progress', 'lifecycle', 'response-in-progress'],
  ['response.completed', 'lifecycle', 'response-completed'],
  ['response.failed', 'lifecycle', 'response-failed'],
  ['response.incomplete', 'lifecycle', 'response-failed'],
  ['response.output_text.delta', 'token-delta', 'text'],
  ['response.reasoning_summary_text.delta', 'token-delta', 'thinking'],
  ['response.reasoning.delta', 'token-delta', 'thinking'],
  ['response.function_call_arguments.delta', 'token-delta', 'tool-input'],
  ['response.function_call.arguments.delta', 'token-delta', 'tool-input'],
  ['response.audio.delta', 'token-delta', 'audio'],
  ['response.audio_transcript.delta', 'token-delta', 'audio'],
  ['response.refusal.delta', 'token-delta', 'refusal'],
  ['response.output_item.added', 'lifecycle', 'output-item-added'],
  ['response.output_item.done', 'lifecycle', 'output-item-done'],
  ['response.content_part.added', 'lifecycle', 'content-part-added'],
  ['response.content_part.done', 'lifecycle', 'content-part-done'],
  ['response.reasoning_summary_part.added', 'lifecycle', 'reasoning-summary-part-added'],
  ['response.reasoning_summary_part.done', 'lifecycle', 'reasoning-summary-part-done'],
  ['response.reasoning_summary_text.done', 'lifecycle', 'reasoning-summary-text-done'],
  ['response.code_interpreter_call.in_progress', 'tool-event', 'tool-call-in-progress'],
  ['response.web_search_call.in_progress', 'tool-event', 'tool-call-in-progress'],
  ['response.code_interpreter_call.completed', 'tool-event', 'tool-call-completed'],
  ['response.web_search_call.completed', 'tool-event', 'tool-call-completed'],
  ['error', 'lifecycle', 'error'],
] as const;

const OPENAI_RESPONSES_CASE_EXPECTATIONS: ActivityExpectation[] = OPENAI_RESPONSES_CASES.map(
  ([eventType, kind, subkind]) => {
    const expectedSuppress = kind === 'token-delta' || subkind === 'tool-call-in-progress';
    return { kind, subkind, rawEventType: eventType, expectedSuppress } as ActivityExpectation;
  },
);

const ANTHROPIC_DELTA_EXPECTATIONS: Array<{
  deltaType: typeof KNOWN_ANTHROPIC_BETA_DELTA_TYPES[number];
  event: BetaRawMessageStreamEvent;
  expected: ActivityExpectation;
}> = [
  {
    deltaType: 'text_delta',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hello' },
    } as unknown as BetaRawMessageStreamEvent,
    expected: { kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta', expectedSuppress: true },
  },
  {
    deltaType: 'input_json_delta',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"a":' },
    } as unknown as BetaRawMessageStreamEvent,
    expected: { kind: 'token-delta', subkind: 'tool-input', rawEventType: 'input_json_delta', expectedSuppress: true },
  },
  {
    deltaType: 'citations_delta',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'citations_delta' },
    } as unknown as BetaRawMessageStreamEvent,
    expected: { kind: 'token-delta', subkind: 'citations', rawEventType: 'citations_delta', expectedSuppress: true },
  },
  {
    deltaType: 'thinking_delta',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'hmm' },
    } as unknown as BetaRawMessageStreamEvent,
    expected: { kind: 'token-delta', subkind: 'thinking', rawEventType: 'thinking_delta', expectedSuppress: true },
  },
  {
    deltaType: 'signature_delta',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig' },
    } as unknown as BetaRawMessageStreamEvent,
    expected: { kind: 'token-delta', subkind: 'signature', rawEventType: 'signature_delta', expectedSuppress: true },
  },
  {
    deltaType: 'compaction_delta',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'compaction_delta' },
    } as unknown as BetaRawMessageStreamEvent,
    expected: { kind: 'unknown', rawEventType: 'compaction_delta', expectedSuppress: false },
  },
];

const ANTHROPIC_STREAM_EVENT_EXPECTATIONS: Array<{
  eventType: typeof KNOWN_ANTHROPIC_STREAM_EVENT_TYPES[number];
  event: RawMessageStreamEvent;
  expected: ActivityExpectation;
}> = [
  {
    eventType: 'message_start',
    event: { type: 'message_start' } as unknown as RawMessageStreamEvent,
    expected: { kind: 'lifecycle', subkind: 'message-start', rawEventType: 'message_start', expectedSuppress: false },
  },
  {
    eventType: 'message_delta',
    event: { type: 'message_delta' } as unknown as RawMessageStreamEvent,
    expected: { kind: 'lifecycle', subkind: 'message-delta', rawEventType: 'message_delta', expectedSuppress: false },
  },
  {
    eventType: 'message_stop',
    event: { type: 'message_stop' } as unknown as RawMessageStreamEvent,
    expected: { kind: 'lifecycle', subkind: 'message-stop', rawEventType: 'message_stop', expectedSuppress: false },
  },
  {
    eventType: 'content_block_start',
    event: { type: 'content_block_start' } as unknown as RawMessageStreamEvent,
    expected: { kind: 'lifecycle', subkind: 'content-block-start', rawEventType: 'content_block_start', expectedSuppress: false },
  },
  {
    eventType: 'content_block_delta',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hello' },
    } as unknown as RawMessageStreamEvent,
    expected: { kind: 'token-delta', subkind: 'text', rawEventType: 'text_delta', expectedSuppress: true },
  },
  {
    eventType: 'content_block_stop',
    event: { type: 'content_block_stop' } as unknown as RawMessageStreamEvent,
    expected: { kind: 'lifecycle', subkind: 'content-block-stop', rawEventType: 'content_block_stop', expectedSuppress: false },
  },
];

const CHAT_COMPLETION_CHUNK_EXPECTATIONS: Array<{
  name: string;
  chunk: { choices: Array<{ finish_reason: string | null }> };
  expected: ActivityExpectation;
}> = [
  {
    name: 'finish_reason null',
    chunk: { choices: [{ finish_reason: null }] },
    expected: { kind: 'token-delta', subkind: 'text', rawEventType: 'chat.completion.chunk', expectedSuppress: true },
  },
  {
    name: 'finish_reason undefined',
    chunk: { choices: [{ finish_reason: undefined }] } as unknown as { choices: Array<{ finish_reason: string | null }> },
    expected: { kind: 'token-delta', subkind: 'text', rawEventType: 'chat.completion.chunk', expectedSuppress: true },
  },
  {
    name: 'finish_reason empty string (F30 — non-compliant proxy)',
    chunk: { choices: [{ finish_reason: '' }] },
    expected: { kind: 'token-delta', subkind: 'text', rawEventType: 'chat.completion.chunk', expectedSuppress: true },
  },
  {
    name: 'finish_reason stop',
    chunk: { choices: [{ finish_reason: 'stop' }] },
    expected: { kind: 'lifecycle', subkind: 'chat-chunk-final', rawEventType: 'chat.completion.chunk', expectedSuppress: false },
  },
  {
    name: 'finish_reason length',
    chunk: { choices: [{ finish_reason: 'length' }] },
    expected: { kind: 'lifecycle', subkind: 'chat-chunk-final', rawEventType: 'chat.completion.chunk', expectedSuppress: false },
  },
  {
    name: 'finish_reason tool_calls',
    chunk: { choices: [{ finish_reason: 'tool_calls' }] },
    expected: { kind: 'lifecycle', subkind: 'chat-chunk-final', rawEventType: 'chat.completion.chunk', expectedSuppress: false },
  },
  {
    name: 'finish_reason content_filter',
    chunk: { choices: [{ finish_reason: 'content_filter' }] },
    expected: { kind: 'lifecycle', subkind: 'chat-chunk-final', rawEventType: 'chat.completion.chunk', expectedSuppress: false },
  },
];

function expectActivityWithoutSuppression(
  actual: RuntimeActivityEvent,
  expected: ActivityExpectation,
): void {
  const { expectedSuppress: _expectedSuppress, ...expectedActivity } = expected;
  void _expectedSuppress;
  expect(actual).toEqual(expectedActivity);
}

function extractOpenAIResponsesMapperCasesFromRuntimeActivitySource(): string[] {
  const source = readFileSync(new URL('../runtimeActivity.ts', import.meta.url), 'utf8');
  const mapperBody = source
    .split('export function mapOpenAIResponsesEvent(eventType: string): RuntimeActivityEvent {')[1]
    ?.split('export function mapOpenAIChatChunk')[0];
  expect(mapperBody).toBeDefined();
  return Array.from(mapperBody?.matchAll(/case '([^']+)':/g) ?? [], ([, eventType]) => eventType);
}

// F31: inter-module drift gate — every OpenAI Responses event-type that
// `codexResponsesTranslator.ts` actively handles in its `translateEvent`
// switch must also be classified by `mapOpenAIResponsesEvent`. If the
// translator gains a new case but the mapper is not updated, the runtime
// activity classifier returns `kind: 'unknown'` (fail-closed) and Sentry
// emits `unmapped_stream_event=true`. This test catches that drift at
// build time instead of in production telemetry.
function extractCodexResponsesTranslatorEventTypes(): string[] {
  const source = readFileSync(
    new URL('../../services/codexResponsesTranslator.ts', import.meta.url),
    'utf8',
  );
  const translateEventBody = source
    .split('translateEvent(eventType: string, eventData: Record<string, unknown>): string | null {')[1]
    ?.split('\n    },\n  };\n}');
  expect(translateEventBody?.[0]).toBeDefined();
  return Array.from(
    translateEventBody?.[0]?.matchAll(/case '([^']+)':/g) ?? [],
    ([, eventType]) => eventType,
  );
}

describe('runtimeActivity', () => {
  describe('mapAnthropicStreamEvent', () => {
    it.each(ANTHROPIC_CASES)('maps $name', ({ event, expected }) => {
      const mapped = mapAnthropicStreamEvent(event);
      expect(mapped).toEqual(expected);
    });

    it('maps unknown SDK variants to unknown instead of throwing', () => {
      const unknownEvent = { type: 'future_unknown_delta' } as unknown as RawMessageStreamEvent;
      expect(() => mapAnthropicStreamEvent(unknownEvent)).not.toThrow();

      const mapped = mapAnthropicStreamEvent(unknownEvent);
      expect(mapped).toEqual({ kind: 'unknown', rawEventType: 'future_unknown_delta' });
    });

    it('content_block_delta with unknown inner delta.type maps to unknown without throwing', () => {
      const event = {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'future_unknown_delta' },
      } as unknown as RawMessageStreamEvent;
      expect(() => mapAnthropicStreamEvent(event)).not.toThrow();
      const mapped = mapAnthropicStreamEvent(event);
      expect(mapped.kind).toBe('unknown');
      expect(mapped.rawEventType).toBe('future_unknown_delta');
    });

    it('content_block_delta with missing delta returns unknown preserving envelope identity', () => {
      const event = { type: 'content_block_delta', index: 0 } as unknown as RawMessageStreamEvent;
      const mapped = mapAnthropicStreamEvent(event);
      expect(mapped.kind).toBe('unknown');
      expect(mapped.rawEventType).toBe('content_block_delta');
    });

    it('content_block_delta with non-string delta.type returns unknown preserving envelope identity', () => {
      const event = {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 123 },
      } as unknown as RawMessageStreamEvent;
      const mapped = mapAnthropicStreamEvent(event);
      expect(mapped.kind).toBe('unknown');
      expect(mapped.rawEventType).toBe('content_block_delta');
    });
  });

  describe('canonical taxonomy walk — anthropic', () => {
    it.each(ANTHROPIC_DELTA_EXPECTATIONS)(
      'maps RawContentBlockDelta/BetaRawContentBlockDelta $deltaType and classifies suppression',
      ({ event, expected }) => {
        const mapped = mapAnthropicStreamEvent(event);
        expectActivityWithoutSuppression(mapped, expected);
        expect(shouldSuppressLevel1WatchdogCapture(mapped)).toBe(expected.expectedSuppress);
      },
    );

    it.each(ANTHROPIC_STREAM_EVENT_EXPECTATIONS)(
      'maps RawMessageStreamEvent $eventType and classifies suppression',
      ({ event, expected }) => {
        const mapped = mapAnthropicStreamEvent(event);
        expectActivityWithoutSuppression(mapped, expected);
        expect(shouldSuppressLevel1WatchdogCapture(mapped)).toBe(expected.expectedSuppress);
      },
    );
  });

  describe('mapOpenAIResponsesEvent', () => {
    it.each(OPENAI_RESPONSES_CASES)('maps %s', (eventType, expectedKind, expectedSubkind) => {
      const mapped = mapOpenAIResponsesEvent(eventType);
      expect(mapped).toEqual({
        kind: expectedKind,
        subkind: expectedSubkind,
        rawEventType: eventType,
      });
    });

    it('maps unknown events to kind=unknown', () => {
      const mapped = mapOpenAIResponsesEvent('vendor.unknown.event');
      expect(mapped.kind).toBe('unknown');
      expect(mapped.rawEventType).toBe('vendor.unknown.event');
    });
  });

  describe('canonical taxonomy walk — openai responses', () => {
    it('covers every curated mapOpenAIResponsesEvent case in runtimeActivity.ts', () => {
      expect(new Set(OPENAI_RESPONSES_CASES.map(([eventType]) => eventType))).toEqual(
        new Set(extractOpenAIResponsesMapperCasesFromRuntimeActivitySource()),
      );
    });

    it.each(OPENAI_RESPONSES_CASE_EXPECTATIONS)(
      'maps $rawEventType and classifies suppression',
      (expected) => {
        const mapped = mapOpenAIResponsesEvent(expected.rawEventType);
        expectActivityWithoutSuppression(mapped, expected);
        expect(shouldSuppressLevel1WatchdogCapture(mapped)).toBe(expected.expectedSuppress);
      },
    );
  });

  describe('inter-module drift gate — codexResponsesTranslator → mapOpenAIResponsesEvent (F31)', () => {
    it('every event-type handled by codexResponsesTranslator is classified (kind !== unknown)', () => {
      const translatorEventTypes = extractCodexResponsesTranslatorEventTypes();
      expect(translatorEventTypes.length).toBeGreaterThan(0);
      const unclassified = translatorEventTypes.filter(
        (eventType) => mapOpenAIResponsesEvent(eventType).kind === 'unknown',
      );
      expect(unclassified).toEqual([]);
    });
  });

  describe('mapOpenAIChatChunk', () => {
    it('maps null finish_reason to token-delta/text', () => {
      expect(mapOpenAIChatChunk({ choices: [{ finish_reason: null }] })).toEqual({
        kind: 'token-delta',
        subkind: 'text',
        rawEventType: 'chat.completion.chunk',
      });
    });

    it('maps undefined finish_reason to token-delta/text', () => {
      const parsed = { choices: [{ finish_reason: undefined }] } as unknown as {
        choices: Array<{ finish_reason: string | null }>;
      };
      expect(mapOpenAIChatChunk(parsed)).toEqual({
        kind: 'token-delta',
        subkind: 'text',
        rawEventType: 'chat.completion.chunk',
      });
    });

    it('maps empty choices to token-delta/text', () => {
      expect(mapOpenAIChatChunk({ choices: [] })).toEqual({
        kind: 'token-delta',
        subkind: 'text',
        rawEventType: 'chat.completion.chunk',
      });
    });

    it('maps empty-string finish_reason to token-delta/text (F30)', () => {
      expect(mapOpenAIChatChunk({ choices: [{ finish_reason: '' }] })).toEqual({
        kind: 'token-delta',
        subkind: 'text',
        rawEventType: 'chat.completion.chunk',
      });
    });

    it('maps non-null finish_reason to lifecycle/chat-chunk-final', () => {
      expect(mapOpenAIChatChunk({ choices: [{ finish_reason: 'stop' }] })).toEqual({
        kind: 'lifecycle',
        subkind: 'chat-chunk-final',
        rawEventType: 'chat.completion.chunk',
      });
    });

    it.each(['length', 'tool_calls', 'content_filter'] as const)(
      'maps %s finish_reason to lifecycle/chat-chunk-final',
      (finishReason) => {
        expect(mapOpenAIChatChunk({ choices: [{ finish_reason: finishReason }] })).toEqual({
          kind: 'lifecycle',
          subkind: 'chat-chunk-final',
          rawEventType: 'chat.completion.chunk',
        });
      },
    );
  });

  describe('canonical taxonomy walk — chat completions', () => {
    it.each(CHAT_COMPLETION_CHUNK_EXPECTATIONS)(
      'maps chat.completion.chunk $name and classifies suppression',
      ({ chunk, expected }) => {
        const mapped = mapOpenAIChatChunk(chunk);
        expectActivityWithoutSuppression(mapped, expected);
        expect(shouldSuppressLevel1WatchdogCapture(mapped)).toBe(expected.expectedSuppress);
      },
    );
  });

  describe('round-trip preservation (F3)', () => {
    it.each(ANTHROPIC_DELTA_EXPECTATIONS)(
      'serializes Anthropic delta $deltaType back to the canonical raw string',
      ({ event, expected }) => {
        expect(serializeRuntimeActivityForTelemetry(mapAnthropicStreamEvent(event))).toBe(expected.rawEventType);
      },
    );

    it.each(ANTHROPIC_STREAM_EVENT_EXPECTATIONS)(
      'serializes Anthropic stream event $eventType back to the mapped raw string',
      ({ event, expected }) => {
        expect(serializeRuntimeActivityForTelemetry(mapAnthropicStreamEvent(event))).toBe(expected.rawEventType);
      },
    );

    it.each(OPENAI_RESPONSES_CASE_EXPECTATIONS)(
      'serializes OpenAI Responses event $rawEventType back to the canonical raw string',
      (expected) => {
        expect(serializeRuntimeActivityForTelemetry(mapOpenAIResponsesEvent(expected.rawEventType))).toBe(expected.rawEventType);
      },
    );

    it.each(CHAT_COMPLETION_CHUNK_EXPECTATIONS)(
      'serializes chat.completion.chunk $name back to the canonical raw string',
      ({ chunk, expected }) => {
        expect(serializeRuntimeActivityForTelemetry(mapOpenAIChatChunk(chunk))).toBe(expected.rawEventType);
      },
    );
  });

  describe('serializeRuntimeActivityForTelemetry', () => {
    it.each(ANTHROPIC_CASES)('round-trips canonical Anthropic raw event type for $name', ({ event, expected }) => {
      const serialized = serializeRuntimeActivityForTelemetry(mapAnthropicStreamEvent(event));
      expect(serialized).toBe(expected.rawEventType);
    });

    it.each(OPENAI_RESPONSES_CASES)('round-trips canonical OpenAI raw event type for %s', (eventType) => {
      const serialized = serializeRuntimeActivityForTelemetry(mapOpenAIResponsesEvent(eventType));
      expect(serialized).toBe(eventType);
    });

    it('round-trips chat chunk raw event type for non-final chunk', () => {
      const serialized = serializeRuntimeActivityForTelemetry(
        mapOpenAIChatChunk({ choices: [{ finish_reason: null }] }),
      );
      expect(serialized).toBe('chat.completion.chunk');
    });

    it('round-trips chat chunk raw event type for final chunk', () => {
      const serialized = serializeRuntimeActivityForTelemetry(
        mapOpenAIChatChunk({ choices: [{ finish_reason: 'stop' }] }),
      );
      expect(serialized).toBe('chat.completion.chunk');
    });

    it('returns null for null input', () => {
      expect(serializeRuntimeActivityForTelemetry(null)).toBeNull();
    });

    it('round-trips synthesized lifecycle terminal event types for cancelled/superseded/aborted', () => {
      expect(
        serializeRuntimeActivityForTelemetry({
          kind: 'lifecycle',
          subkind: 'cancelled',
          rawEventType: 'turn.cancelled',
        }),
      ).toBe('turn.cancelled');
      expect(
        serializeRuntimeActivityForTelemetry({
          kind: 'lifecycle',
          subkind: 'superseded',
          rawEventType: 'turn.superseded',
        }),
      ).toBe('turn.superseded');
      expect(
        serializeRuntimeActivityForTelemetry({
          kind: 'lifecycle',
          subkind: 'aborted',
          rawEventType: 'turn.aborted',
        }),
      ).toBe('turn.aborted');
    });
  });
});
