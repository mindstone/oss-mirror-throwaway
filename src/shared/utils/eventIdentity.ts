import type { AgentEvent } from '@shared/types';
import { invariant } from './invariant';

/**
 * Content-addressable event identity for deduplication.
 *
 * Primary: (turnId, seq) — stamped by `LazyContextAccumulator.appendEvent`.
 * Fallback: (turnId, type, timestamp) — for legacy events without `seq`.
 *
 * Used by Stage 3 UNION-by-identity dedup at session-switch / late-load /
 * terminal-event reception to merge accumulator-buffered events with
 * disk-persisted events without dropping or duplicating.
 */
export type EventIdentity = string;

/**
 * Branded type marking events that have been stamped with a positive
 * integer `seq` by `LazyContextAccumulator.appendEvent` (the canonical
 * authority).
 *
 * Used at boundary surfaces — `agent:event` IPC broadcast, cloud
 * `eventsByTurn` persistence — that require a sequenced event for
 * cross-surface rehydration parity (the `(turnId, seq)` content-
 * addressable identity invariant). Passing an unstamped `AgentEvent` to a
 * surface typed as `SequencedAgentEvent<…>` is a TypeScript error,
 * eliminating the variable-swap bug class fixed in commit `d154d6146`
 * (see
 * `docs-private/postmortems/260502_persist_user_question_answered_unstamped_postmortem.md`,
 * Prevention action #1 — type constraint).
 *
 * Brand mechanism follows the existing `readonly __brand: '<Name>'`
 * convention used in `BareToolId`, `ComposerWireMarkdown`, etc. Only
 * `LazyContextAccumulator.appendEvent` (and the `assertEventHasSeq`
 * predicate after a runtime check) should mint the brand.
 *
 * Generic over `T` so callers can preserve the discriminated-union
 * narrowing of `AgentEvent` (e.g.
 * `SequencedAgentEvent<Extract<AgentEvent, { type: 'user_question_answered' }>>`).
 */
export type SequencedAgentEvent<T extends AgentEvent = AgentEvent> = T & {
  seq: number;
  readonly __brand: 'SequencedAgentEvent';
};

export type LegacyFallbackIdentityUsage = {
  turnId: string;
  legacyEventCount: number;
};

export type SeqGapRange = {
  start: number;
  end: number;
};

export type ContentEquivalentRestampCollapsed = {
  turnId: string;
  droppedSeq: number | null;
  retainedSeq: number | null;
};

export type UnionEventsByIdentityOptions = {
  onLegacyFallbackIdentityUsed?: (params: LegacyFallbackIdentityUsage) => void;
  onSeqGapDetected?: (params: { turnId: string; gaps: SeqGapRange[] }) => void;
  onContentEquivalentRestampCollapsed?: (
    params: ContentEquivalentRestampCollapsed,
  ) => void;
};

export function isValidSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Compute the content-addressable identity for `event` within `turnId`.
 *
 * INVARIANT: per-session seq is monotonically increasing but NOT necessarily
 * contiguous. `assistant_delta` and `thinking_delta` events stamp+broadcast
 * seq values but are not persisted (`agentEventDispatcher.ts` +
 * `agentTurnSubmissionService.ts`); filtered transient events and legacy
 * migration paths can also leave persisted gaps. Identity equality is the
 * only contract — do NOT treat seq gaps as dropped events. The gap-detection
 * breadcrumb in `unionEventsByIdentity` is observability only and must not
 * trigger repair logic.
 *
 * See JSDoc on `AgentSession.maxSeq` for the same invariant from the
 * persistence side.
 */
export function getEventIdentity(turnId: string, event: AgentEvent): EventIdentity {
  if (isValidSeq(event.seq)) {
    return `${turnId}:seq:${event.seq}`;
  }
  // Legacy fallback — sunset in Stage 6 deferred plan after migration sweep.
  const timestamp = event.timestamp ?? '';
  return `${turnId}:type:${event.type}:ts:${timestamp}`;
}

function usesLegacyFallbackIdentity(event: AgentEvent): boolean {
  return !isValidSeq(event.seq);
}

/**
 * Deterministically serialize an unknown value (typically a `modelUsage`
 * record) for use in a content-equivalence key. Object keys are sorted at
 * every depth so two equivalent records produce the same string regardless
 * of insertion order. Falls back to `String(value)` for non-serialisable
 * inputs so the key is still stable per-input.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalStringify(item)).join(',') + ']';
  }
  try {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0),
    );
    return (
      '{' +
      entries
        .map(([key, val]) => JSON.stringify(key) + ':' + canonicalStringify(val))
        .join(',') +
      '}'
    );
  } catch {
    return JSON.stringify(String(value));
  }
}

/**
 * Per-type canonical content-equivalence key.
 *
 * Designed as a SECONDARY dedup pass on top of `getEventIdentity` so that
 * byte-identical events whose `seq` has been restamped by upstream sync paths
 * (cloud-echo, `stampMissingEventSeq`, compaction-then-reapply) collapse to
 * one row. Returning `null` for an event type means "no content-equivalence
 * key" — those types fall back to the seq/legacy identity only.
 *
 * BYTE-PRESERVATION INVARIANT
 * ---------------------------
 * This key set assumes restamps are payload-preserving — i.e., the same
 * logical event re-emitted by an upstream sync path carries an identical
 * payload (only `seq` changes). The current restampers
 * (`stampMissingEventSeq`, cloud-echo merge, compaction-then-reapply) all
 * satisfy this. If a future code path needs to ENRICH an already-emitted
 * `result` or `tool` event (e.g., late-arriving usage backfill, post-hoc
 * `fallbacks`, BTS metric injection), it MUST be implemented as an
 * in-place update of the existing event row — NOT as a second emission at
 * the same `(timestamp, …)`. A second emission carrying differing
 * non-discriminator fields would be silently collapsed onto the first
 * (less-enriched) copy under the current key set.
 *
 * To support a true second-emission enrichment pattern, either widen the
 * key set below to include the enrichment fields, or move that emitter
 * onto an in-place mutation API.
 *
 * Type-specific discriminators:
 *  - `assistant`: timestamp + text. Distinct text at the same timestamp stays
 *    distinct (e.g. rapid bursts), so legitimate distinct content is not
 *    over-collapsed.
 *  - `result`: timestamp + text + model + modelUsage signature + turnEndReason.
 *    Schema fields intentionally EXCLUDED from the key (assumed
 *    byte-preserving across restamps; see invariant above): `usage`,
 *    `planningModel`, `toolMetrics`, `outputShapeMetrics`,
 *    `subAgentMetrics`, `thinkingEffort`, `authMethod`, `fallbacks`.
 *  - `tool`: timestamp + toolName + toolUseId + stage + isError + detail.
 *    `toolUseId` and `stage` are mandatory discriminators: a start and end
 *    for the same toolUseId have different stages, and two parallel tool
 *    invocations at the same ms have distinct toolUseIds. Schema fields
 *    intentionally EXCLUDED (assumed byte-preserving across restamps):
 *    `parentToolUseId`, `outputChars`, `imageContent`, `mcpAppUiMeta`,
 *    `toolResult`, `_origin`.
 *
 * See diagnosis doc:
 * `docs-private/investigations/260513_duplicate_result_text_in_message_bubble.md` § 9.
 */
export type ContentEquivalenceKey = string;

export function getContentEquivalenceKey(
  turnId: string,
  event: AgentEvent,
): ContentEquivalenceKey | null {
  switch (event.type) {
    case 'assistant':
      return canonicalStringify({
        kind: 'ce:assistant',
        turnId,
        timestamp: event.timestamp,
        text: event.text,
      });
    case 'result':
      return canonicalStringify({
        kind: 'ce:result',
        turnId,
        timestamp: event.timestamp,
        text: event.text,
        model: event.model ?? null,
        modelUsage: event.modelUsage ?? null,
        turnEndReason: event.turnEndReason ?? null,
      });
    case 'tool':
      return canonicalStringify({
        kind: 'ce:tool',
        turnId,
        timestamp: event.timestamp,
        toolName: event.toolName,
        toolUseId: event.toolUseId ?? null,
        stage: event.stage,
        isError: event.isError ?? null,
        detail: event.detail,
      });
    default:
      return null;
  }
}

function detectSeqGaps(events: AgentEvent[]): SeqGapRange[] {
  const uniqueSeqs = Array.from(
    new Set(
      events
        .map((event) => event.seq)
        .filter((seq): seq is number => isValidSeq(seq)),
    ),
  ).sort((a, b) => a - b);

  if (uniqueSeqs.length < 2) {
    return [];
  }

  const gaps: SeqGapRange[] = [];
  for (let index = 1; index < uniqueSeqs.length; index += 1) {
    const previous = uniqueSeqs[index - 1];
    const current = uniqueSeqs[index];
    if (current - previous <= 1) {
      continue;
    }
    gaps.push({
      start: previous + 1,
      end: current - 1,
    });
  }

  return gaps;
}

/** Idempotent dedup-by-identity. Preserves order of first occurrence. */
export function dedupEventsByIdentity(turnId: string, events: AgentEvent[]): AgentEvent[] {
  const seen = new Set<EventIdentity>();
  const out: AgentEvent[] = [];
  for (const event of events) {
    const id = getEventIdentity(turnId, event);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(event);
    }
  }
  return out;
}

/**
 * Drop content-equivalent restamps from `events` while preserving order.
 *
 * Runs as a SECONDARY pass after seq/legacy identity dedup so byte-identical
 * `assistant`/`result`/`tool` events whose `seq` was restamped by upstream
 * sync paths collapse to a single row. Events with no content-equivalence
 * key (`getContentEquivalenceKey` returns `null`) pass through untouched.
 *
 * The first occurrence wins; later restamps are dropped and reported via
 * `options.onContentEquivalentRestampCollapsed`.
 */
function dedupContentEquivalentRestamps(
  turnId: string,
  events: AgentEvent[],
  options?: UnionEventsByIdentityOptions,
): AgentEvent[] {
  const retained = new Map<ContentEquivalenceKey, AgentEvent>();
  const out: AgentEvent[] = [];
  for (const event of events) {
    const key = getContentEquivalenceKey(turnId, event);
    if (key === null) {
      out.push(event);
      continue;
    }
    const existing = retained.get(key);
    if (existing) {
      options?.onContentEquivalentRestampCollapsed?.({
        turnId,
        droppedSeq: isValidSeq(event.seq) ? event.seq : null,
        retainedSeq: isValidSeq(existing.seq) ? existing.seq : null,
      });
      continue;
    }
    retained.set(key, event);
    out.push(event);
  }
  return out;
}

/** UNION two event lists by identity. Preserves order: base events first, then incoming events not already in base. */
export function unionEventsByIdentity(
  turnId: string,
  baseEvents: AgentEvent[],
  incomingEvents: AgentEvent[],
  options?: UnionEventsByIdentityOptions,
): AgentEvent[] {
  const seen = new Set<EventIdentity>();
  const out: AgentEvent[] = [];
  let legacyEventCount = 0;
  for (const event of baseEvents) {
    if (usesLegacyFallbackIdentity(event)) {
      legacyEventCount += 1;
    }
    const id = getEventIdentity(turnId, event);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(event);
    }
  }
  for (const event of incomingEvents) {
    if (usesLegacyFallbackIdentity(event)) {
      legacyEventCount += 1;
    }
    const id = getEventIdentity(turnId, event);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(event);
    }
  }
  if (legacyEventCount > 0) {
    options?.onLegacyFallbackIdentityUsed?.({ turnId, legacyEventCount });
  }

  const deduped = dedupContentEquivalentRestamps(turnId, out, options);

  const gaps = detectSeqGaps(deduped);
  if (gaps.length > 0) {
    options?.onSeqGapDetected?.({ turnId, gaps });
  }

  return deduped;
}

/**
 * Content-equivalence-only dedup pass on a single ordered list. Used by
 * callsites (e.g. cloud-push merge in `sessionMergeUtils.ts`) that already
 * perform their own seq/legacy identity merge and need the same restamp
 * defense as `unionEventsByIdentity`. Preserves order; first occurrence wins.
 */
export function dropContentEquivalentRestamps(
  turnId: string,
  events: AgentEvent[],
  options?: Pick<UnionEventsByIdentityOptions, 'onContentEquivalentRestampCollapsed'>,
): AgentEvent[] {
  return dedupContentEquivalentRestamps(turnId, events, options);
}

/** Replace this turn's event list with a known superset (e.g., from accumulator). Used by `turnCheckpointService.mergeTurnIntoSession` once Stage 0 lands. */
export function replaceTurnEventsFromSuperset(
  _turnId: string,
  superset: AgentEvent[],
): AgentEvent[] {
  return [...superset];
}

/**
 * Defensive runtime check used at IPC boundary in dev. Logs + returns
 * false in prod (fail-soft). When this returns `true`, the event is
 * narrowed to `SequencedAgentEvent<T>` so callers using
 * `if (assertEventHasSeq(e, 'context'))` get the brand without an
 * explicit cast — see prevention action #1 in
 * `docs-private/postmortems/260502_persist_user_question_answered_unstamped_postmortem.md`.
 *
 * Note: when called as an expression-statement (e.g.
 * `assertEventHasSeq(event, 'context');`) TypeScript will not narrow the
 * binding. Use the predicate form when you also want compile-time
 * narrowing.
 */
export function assertEventHasSeq<T extends AgentEvent>(
  event: T | null | undefined,
  context: string,
): event is SequencedAgentEvent<T> {
  // Tolerate null/undefined event objects: a missing event is itself a
  // boundary violation — surface it as "missing seq" rather than letting
  // the property access throw a TypeError that would mask the real issue.
  if (event && isValidSeq(event.seq)) return true;
  const reason =
    event == null
      ? 'absent-event'
      : event.seq === undefined
        ? 'missing'
        : 'invalid';
  const eventType = event?.type ?? 'unknown';
  const message = `[eventIdentity] event ${reason} seq at ${context} (type=${eventType})`;
  if (process.env.NODE_ENV !== 'production') {
    invariant(false, message);
  }
  // Fail-soft in production: log and continue.
  console.warn(message);
  return false;
}
