import type { RawContentBlockDelta, RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
/**
 * RuntimeActivityEvent — typed discriminated union for liveness signals
 * produced by provider stream-event mappers (Anthropic, OpenAI Responses,
 * OpenAI Chat, Codex).
 *
 * Consumed by:
 * - `shouldSuppressLevel1WatchdogCapture` in `src/main/services/watchdogTracker.ts`
 *   (level-1 Sentry-capture gate; reads the typed event directly).
 * - `agentTurnExecutor`'s `rawStreamTracker` (records last activity for
 *   diagnostic telemetry; emits synthetic terminal
 *   `'cancelled'`/`'superseded'`/`'aborted'` subkinds at stream-loop
 *   termination).
 *
 * IPC parity invariant: `serializeRuntimeActivityForTelemetry(...)` returns
 * `event.rawEventType` (a plain string) which is mirrored on the wire as the
 * `rawStreamLastEventType: string | null` IPC field — defined in
 * `src/shared/ipc/schemas/agent.ts`, `src/shared/contracts/agentEventManifest.ts`,
 * `src/shared/types/agent.ts`. Adding new union members (e.g. `'cancelled'`,
 * `'superseded'`, `'aborted'`) introduces new wire values but preserves the
 * field shape, so
 * existing renderer telemetry consumers remain compatible.
 *
 * See `docs/project/REBEL_CORE.md` for higher-level architecture context and
 * `docs/plans/260503_s7_runtime_activity_event_migration_completion.md` for
 * the migration history.
 */
import type {
  BetaRawContentBlockDelta,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

export const KNOWN_ANTHROPIC_DELTA_TYPES = [
  'text_delta',
  'input_json_delta',
  'citations_delta',
  'thinking_delta',
  'signature_delta',
] as const;

export const KNOWN_ANTHROPIC_STREAM_EVENT_TYPES = [
  'message_start',
  'message_delta',
  'message_stop',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
] as const;

export const KNOWN_ANTHROPIC_BETA_DELTA_TYPES = [
  ...KNOWN_ANTHROPIC_DELTA_TYPES,
  'compaction_delta',
] as const;

export type AnthropicStreamEventForMapping =
  | RawMessageStreamEvent
  | BetaRawMessageStreamEvent;

export type RuntimeActivityEvent =
  | TokenDeltaActivity
  | LifecycleActivity
  | ToolEventActivity
  | UnknownActivity;

export interface TokenDeltaActivity {
  kind: 'token-delta';
  subkind: 'text' | 'thinking' | 'tool-input' | 'citations' | 'signature' | 'audio' | 'refusal';
  rawEventType: string;
}

export interface LifecycleActivity {
  kind: 'lifecycle';
  /**
   * Terminal subkinds that the typed-mapper functions never produce; emitted
   * synthetically by the executor at stream-loop termination to mark the
   * lifecycle's end. `cancelled` = user-initiated stop (UI cancel button or
   * external signal abort without a superseded reason). `superseded` = newer
   * turn admission (`signal.reason === 'superseded'`) displaced this turn.
   * `aborted` = programmatic auto-abort (watchdog-driven REBEL-NQ termination
   * after sustained silence). Natural completion does not produce these —
   * existing producer events (`message-stop`, `response-completed`,
   * `chat-chunk-final`) cover that path.
   *
   * Precedence: when both watchdog auto-abort and signal abort are true (race
   * between watchdog firing and user/superseded signal), `aborted` wins — the
   * watchdog already made the deterministic decision to abort. When signal
   * abort is true without watchdog, `signal.reason === 'superseded'` maps to
   * `superseded`; otherwise `cancelled`. Tri-state precedence: watchdog >
   * superseded > cancelled.
   */
  subkind:
    | 'message-start'
    | 'message-delta'
    | 'message-stop'
    | 'content-block-start'
    | 'content-block-stop'
    | 'response-created'
    | 'response-in-progress'
    | 'response-completed'
    | 'response-failed'
    | 'output-item-added'
    | 'output-item-done'
    | 'content-part-added'
    | 'content-part-done'
    | 'reasoning-summary-part-added'
    | 'reasoning-summary-part-done'
    | 'reasoning-summary-text-done'
    | 'chat-chunk-final'
    | 'error'
    | 'cancelled'
    | 'superseded'
    | 'aborted';
  rawEventType: string;
}

export interface ToolEventActivity {
  kind: 'tool-event';
  subkind: 'tool-call-in-progress' | 'tool-call-completed';
  rawEventType: string;
}

export interface UnknownActivity {
  kind: 'unknown';
  rawEventType: string;
}

const CHAT_COMPLETION_CHUNK_EVENT_TYPE = 'chat.completion.chunk';

function getRawEventType(value: unknown): string {
  if (!value || typeof value !== 'object') return 'unknown_event';
  const maybeType = (value as { type?: unknown }).type;
  return typeof maybeType === 'string' ? maybeType : 'unknown_event';
}

// rebel-assert-never-allow: specialised mapper returns UnknownActivity instead of throwing for forward-compatible runtime event handling.
function assertNeverWithUnknown(value: never, rawEventType: string): UnknownActivity {
  void value;
  return {
    kind: 'unknown',
    rawEventType,
  };
}

function mapAnthropicContentBlockDelta(
  delta: RawContentBlockDelta | BetaRawContentBlockDelta,
): RuntimeActivityEvent {
  switch (delta.type) {
    case 'text_delta':
      return { kind: 'token-delta', subkind: 'text', rawEventType: delta.type };
    case 'input_json_delta':
      return { kind: 'token-delta', subkind: 'tool-input', rawEventType: delta.type };
    case 'citations_delta':
      return { kind: 'token-delta', subkind: 'citations', rawEventType: delta.type };
    case 'thinking_delta':
      return { kind: 'token-delta', subkind: 'thinking', rawEventType: delta.type };
    case 'signature_delta':
      return { kind: 'token-delta', subkind: 'signature', rawEventType: delta.type };
    case 'compaction_delta':
      return { kind: 'unknown', rawEventType: delta.type };
  }

  return assertNeverWithUnknown(delta, getRawEventType(delta));
}

export function mapAnthropicStreamEvent(
  event: AnthropicStreamEventForMapping,
): RuntimeActivityEvent {
  switch (event.type) {
    case 'content_block_delta': {
      const delta = (event as { delta?: unknown }).delta;
      if (!delta || typeof (delta as { type?: unknown }).type !== 'string') {
        return { kind: 'unknown', rawEventType: 'content_block_delta' };
      }
      return mapAnthropicContentBlockDelta(
        (event as { delta: RawContentBlockDelta | BetaRawContentBlockDelta }).delta,
      );
    }
    case 'message_start':
      return { kind: 'lifecycle', subkind: 'message-start', rawEventType: event.type };
    case 'message_delta':
      return { kind: 'lifecycle', subkind: 'message-delta', rawEventType: event.type };
    case 'message_stop':
      return { kind: 'lifecycle', subkind: 'message-stop', rawEventType: event.type };
    case 'content_block_start':
      return { kind: 'lifecycle', subkind: 'content-block-start', rawEventType: event.type };
    case 'content_block_stop':
      return { kind: 'lifecycle', subkind: 'content-block-stop', rawEventType: event.type };
  }

  return assertNeverWithUnknown(event, getRawEventType(event));
}

export function mapOpenAIResponsesEvent(eventType: string): RuntimeActivityEvent {
  // Source: https://platform.openai.com/docs/api-reference/responses-streaming
  // Last reviewed: 2026-05-02
  // Drift policy: when an unmapped raw event-type produces a Sentry capture
  // with unmapped_stream_event=true, add it to this table within one beta cycle.
  switch (eventType) {
    case 'response.created':
      return { kind: 'lifecycle', subkind: 'response-created', rawEventType: eventType };
    case 'response.in_progress':
      return { kind: 'lifecycle', subkind: 'response-in-progress', rawEventType: eventType };
    case 'response.completed':
      return { kind: 'lifecycle', subkind: 'response-completed', rawEventType: eventType };
    case 'response.failed':
    case 'response.incomplete':
      return { kind: 'lifecycle', subkind: 'response-failed', rawEventType: eventType };
    case 'response.output_text.delta':
      return { kind: 'token-delta', subkind: 'text', rawEventType: eventType };
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning.delta':
      return { kind: 'token-delta', subkind: 'thinking', rawEventType: eventType };
    case 'response.function_call_arguments.delta':
    case 'response.function_call.arguments.delta':
      return { kind: 'token-delta', subkind: 'tool-input', rawEventType: eventType };
    case 'response.audio.delta':
    case 'response.audio_transcript.delta':
      return { kind: 'token-delta', subkind: 'audio', rawEventType: eventType };
    case 'response.refusal.delta':
      return { kind: 'token-delta', subkind: 'refusal', rawEventType: eventType };
    case 'response.output_item.added':
      return { kind: 'lifecycle', subkind: 'output-item-added', rawEventType: eventType };
    case 'response.output_item.done':
      return { kind: 'lifecycle', subkind: 'output-item-done', rawEventType: eventType };
    case 'response.content_part.added':
      return { kind: 'lifecycle', subkind: 'content-part-added', rawEventType: eventType };
    case 'response.content_part.done':
      return { kind: 'lifecycle', subkind: 'content-part-done', rawEventType: eventType };
    case 'response.reasoning_summary_part.added':
      return { kind: 'lifecycle', subkind: 'reasoning-summary-part-added', rawEventType: eventType };
    case 'response.reasoning_summary_part.done':
      return { kind: 'lifecycle', subkind: 'reasoning-summary-part-done', rawEventType: eventType };
    case 'response.reasoning_summary_text.done':
      return { kind: 'lifecycle', subkind: 'reasoning-summary-text-done', rawEventType: eventType };
    case 'response.code_interpreter_call.in_progress':
    case 'response.web_search_call.in_progress':
      return { kind: 'tool-event', subkind: 'tool-call-in-progress', rawEventType: eventType };
    case 'response.code_interpreter_call.completed':
    case 'response.web_search_call.completed':
      return { kind: 'tool-event', subkind: 'tool-call-completed', rawEventType: eventType };
    case 'error':
      return { kind: 'lifecycle', subkind: 'error', rawEventType: eventType };
    default:
      return { kind: 'unknown', rawEventType: eventType };
  }
}

export function mapOpenAIChatChunk(parsed: {
  choices: Array<{ finish_reason: string | null }>;
}): RuntimeActivityEvent {
  const finishReason = parsed.choices?.[0]?.finish_reason;
  // F30: treat empty-string finish_reason as not-finished — non-compliant
  // proxies (vLLM, OpenRouter, LocalAI) sometimes emit '' for in-flight chunks
  // where the spec mandates `null`. Classifying '' as final lifecycle would
  // suppress the level-1 watchdog gate during active streaming.
  if (finishReason == null || finishReason === '') {
    return { kind: 'token-delta', subkind: 'text', rawEventType: CHAT_COMPLETION_CHUNK_EVENT_TYPE };
  }
  return { kind: 'lifecycle', subkind: 'chat-chunk-final', rawEventType: CHAT_COMPLETION_CHUNK_EVENT_TYPE };
}

export function serializeRuntimeActivityForTelemetry(event: RuntimeActivityEvent | null): string | null {
  return event === null ? null : event.rawEventType;
}
