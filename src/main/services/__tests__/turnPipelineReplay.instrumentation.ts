/**
 * Turn Pipeline Replay — S2-G instrumentation helpers (R2 opt-in assertions)
 *
 * This module is additive by design: existing fixture-driven replay tests remain
 * unchanged, and new assertions consume these helpers explicitly per test.
 *
 * Timing dependency note: R1 Stage 2 shipped on 2026-04-29 (`242a9377d`) and
 * introduced `turnPhase.entry` / `turnPhase.exit` debug events across replay
 * fixtures. To keep S2-G resilient to that baseline shift (and future R1 Stage 3
 * timing/log shifts), `aggregateLogCounts()` filters `event: 'turnPhase.*'` by
 * default. Callers can disable that filter when needed.
 *
 * Pino convention assumption: replay harness log args follow repository policy
 * `log.warn({ data }, 'message')` (structured object first, message second).
 * Event-name extraction therefore reads `args[0].event` when the first arg is an
 * object.
 */

import type { RecordedCall, RecordedSideEffects } from './turnPipelineReplay.harness';

type ReplayLogLevel = 'info' | 'warn' | 'error' | 'debug';

const REPLAY_LOG_LEVELS: ReadonlyArray<ReplayLogLevel> = ['info', 'warn', 'error', 'debug'];

/**
 * Sentinel returned by `aggregateLogCounts` (and `assertEventOrdering`'s default
 * selector) when a recorded call cannot be associated with a structured event
 * name — e.g. a string-first pino call that violates the repo's pino arg-order
 * convention, or a log entry without an `event` field.
 *
 * Exported so tests/callers can reference the sentinel rather than the literal
 * `'<unknown>'` magic string.
 */
export const UNKNOWN_EVENT_BUCKET = '<unknown>';

export interface AggregateLogCountsOptions {
  /**
   * Default `true` to keep assertions fixture-impact-tolerant across phase-boundary
   * logging changes (`turnPhase.entry` / `turnPhase.exit`).
   */
  readonly filterTurnPhase?: boolean;
}

export interface AggregateLogCountsResult {
  readonly byLevel: Record<ReplayLogLevel, number>;
  readonly byEvent: Record<string, number>;
  readonly total: number;
  readonly filteredOut: number;
}

export interface PersistenceWriteCountResult {
  readonly total: number;
  readonly byMethod: Record<string, number>;
}

export interface EventOrderingResult {
  readonly ok: boolean;
  readonly missing: string[];
  readonly outOfOrder: ReadonlyArray<{ event: string; expectedAfter: string }>;
}

/**
 * Optional selector for `assertEventOrdering`. When provided, the helper uses
 * the selector's return value as the ordering key for each call instead of
 * `call.method`. Used to lift the actual `AgentEvent.type` out of
 * `recordEvent('dispatchAgentEvent', [win, turnId, event])`-style wiring,
 * where every call's `method` is `'dispatchAgentEvent'` and the event type
 * lives in `args[2].type`.
 *
 * Return `undefined` to skip the call (the call is treated as untracked).
 */
export type AssertEventOrderingExtractKey = (call: RecordedCall) => string | undefined;

export interface AssertEventOrderingOptions {
  readonly extractKey?: AssertEventOrderingExtractKey;
}

/**
 * Built-in selector that lifts the AgentEvent type out of the conventional
 * `recordEvent('dispatchAgentEvent', [win, turnId, event])` wiring used in
 * `turnPipelineReplay.test.ts`. Returns `undefined` for non-event surfaces or
 * malformed wiring so the caller can pass it as an `extractKey` and have it
 * silently skip irrelevant calls.
 */
export const dispatchAgentEventTypeSelector: AssertEventOrderingExtractKey = (call) => {
  if (call.surface !== 'event') return undefined;
  if (call.method !== 'dispatchAgentEvent') return undefined;
  const eventArg = call.args[2];
  if (!eventArg || typeof eventArg !== 'object' || Array.isArray(eventArg)) return undefined;
  const type = (eventArg as Record<string, unknown>).type;
  return typeof type === 'string' && type.length > 0 ? type : undefined;
};

export function aggregateLogCounts(
  records: RecordedSideEffects,
  options: AggregateLogCountsOptions = {},
): AggregateLogCountsResult {
  const byLevel: Record<ReplayLogLevel, number> = {
    info: 0,
    warn: 0,
    error: 0,
    debug: 0,
  };
  const byEvent: Record<string, number> = {};
  const filterTurnPhase = options.filterTurnPhase ?? true;
  let total = 0;
  let filteredOut = 0;

  for (const call of records.timeline) {
    if (call.surface !== 'log') continue;
    if (!isReplayLogLevel(call.method)) continue;

    const eventName = extractLogEventName(call);
    if (filterTurnPhase && eventName.startsWith('turnPhase.')) {
      filteredOut += 1;
      continue;
    }

    byLevel[call.method] += 1;
    byEvent[eventName] = (byEvent[eventName] ?? 0) + 1;
    total += 1;
  }

  return { byLevel, byEvent, total, filteredOut };
}

export function countPersistenceWrites(records: RecordedSideEffects): PersistenceWriteCountResult {
  let total = 0;
  const byMethod: Record<string, number> = {};

  for (const call of records.timeline) {
    if (call.surface !== 'persistence') continue;
    total += 1;
    byMethod[call.method] = (byMethod[call.method] ?? 0) + 1;
  }

  return { total, byMethod };
}

export function assertEventOrdering(
  records: RecordedSideEffects,
  orderedEventTypes: ReadonlyArray<string>,
  options: AssertEventOrderingOptions = {},
): EventOrderingResult {
  const firstByEvent = new Map<string, number>();
  const lastByEvent = new Map<string, number>();
  const trackedEvents = new Set(orderedEventTypes);
  const extractKey = options.extractKey ?? defaultExtractKey;

  for (const call of records.timeline) {
    const key = extractKey(call);
    if (key === undefined) continue;
    if (!trackedEvents.has(key)) continue;
    if (!firstByEvent.has(key)) {
      firstByEvent.set(key, call.sequence);
    }
    lastByEvent.set(key, call.sequence);
  }

  const missing = orderedEventTypes.filter(eventType => !firstByEvent.has(eventType));
  const outOfOrder: Array<{ event: string; expectedAfter: string }> = [];

  for (let i = 0; i < orderedEventTypes.length - 1; i += 1) {
    const expectedAfter = orderedEventTypes[i];
    const event = orderedEventTypes[i + 1];
    const expectedAfterLastIndex = lastByEvent.get(expectedAfter);
    const eventFirstIndex = firstByEvent.get(event);

    if (expectedAfterLastIndex === undefined || eventFirstIndex === undefined) {
      continue;
    }
    if (eventFirstIndex <= expectedAfterLastIndex) {
      outOfOrder.push({ event, expectedAfter });
    }
  }

  return {
    ok: missing.length === 0 && outOfOrder.length === 0,
    missing,
    outOfOrder,
  };
}

function isReplayLogLevel(method: string): method is ReplayLogLevel {
  return (REPLAY_LOG_LEVELS as ReadonlyArray<string>).includes(method);
}

function extractLogEventName(call: RecordedCall): string {
  const [firstArg] = call.args;
  if (!firstArg || typeof firstArg !== 'object' || Array.isArray(firstArg)) {
    return UNKNOWN_EVENT_BUCKET;
  }

  const event = (firstArg as Record<string, unknown>).event;
  if (typeof event !== 'string' || event.length === 0) {
    return UNKNOWN_EVENT_BUCKET;
  }
  return event;
}

/**
 * Default ordering-key selector — returns `call.method` for any surface.
 * Suitable for log-method ordering and persistence-method ordering. For
 * AgentEvent-type ordering, pass `dispatchAgentEventTypeSelector` (or a
 * custom selector) via `options.extractKey`.
 */
const defaultExtractKey: AssertEventOrderingExtractKey = (call) => call.method;
