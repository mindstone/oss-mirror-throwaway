/**
 * Lazy Context Accumulator
 *
 * Stores raw events in an array per-turn (pushed in-place, O(1) per event).
 * Derives ConversationStateShape lazily — only when getConversationShape() is called.
 * Caches the derived shape; invalidates on next appendEvent().
 *
 * Uses the shared updateConversationWithEvent from conversationState.ts
 * for derivation — zero logic duplication with the renderer path.
 *
 * Also maintains an `executedToolCalls` side-table populated automatically
 * from `tool` events. The side-table is used by recovery handlers that need
 * to know which tools ran in the turn (e.g. to decide whether an auto-retry
 * after a streaming cap breach might re-execute a destructive operation).
 * See docs/plans/260423_agent_to_tool_file_ref_sentinel.md § Stage 2.
 */

import type { AgentEvent } from '@shared/types';
import type { ConversationStateShape } from '@shared/utils/conversationState';
import { createScopedLogger } from '@core/logger';
import { updateConversationWithEvent } from '@shared/utils/conversationState';
import { isValidSeq, type SequencedAgentEvent } from '@shared/utils/eventIdentity';
import { getSessionSeqIndex } from './sessionSeqIndex';

const log = createScopedLogger({ service: 'lazyContextAccumulator' });

/**
 * Built-in tool annotation map. Matches the MCP annotation shape
 * (`readOnlyHint` / `destructiveHint` / `idempotentHint`) so the side-table
 * presents a uniform view for both built-ins and MCP `use_tool` calls.
 *
 * Only tools the core distributes itself are listed here. MCP tools'
 * annotations may be populated by a later explicit `recordExecutedTool` call
 * from the caller that knows them (e.g. after the `use_tool` response
 * returns annotations). If annotations are unknown, the field is left empty.
 */
const BUILT_IN_TOOL_ANNOTATIONS: Record<string, {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}> = {
  Read: { readOnlyHint: true },
  Grep: { readOnlyHint: true },
  Glob: { readOnlyHint: true },
  LS: { readOnlyHint: true },
  WebFetch: { readOnlyHint: true },
  WebSearch: { readOnlyHint: true },
  SearchFiles: { readOnlyHint: true },
  rebel_search_files: { readOnlyHint: true },
  Write: { destructiveHint: true },
  Edit: { destructiveHint: true },
  MultiEdit: { destructiveHint: true },
  NotebookEdit: { destructiveHint: true },
  Bash: { destructiveHint: true },
};

/**
 * Record of a tool call that was dispatched during the turn. Populated
 * from tool-use-start events by `appendEvent` (built-in and MCP tools
 * alike) and optionally enriched with annotations from
 * `recordExecutedToolAnnotations` when the caller learns them later.
 */
export interface ExecutedToolRecord {
  toolName: string;
  toolUseId: string | undefined;
  /** MCP-style tool annotations. Empty for unknown MCP tools until enriched. */
  annotations: Record<string, unknown>;
  /** Unix epoch ms when the tool start was observed. */
  timestamp: number;
}

const createInitialConversationShape = (turnId: string): ConversationStateShape => ({
  messages: [],
  eventsByTurn: {},
  activeTurnId: turnId,
  focusedTurnId: null,
  isBusy: true,
  lastError: null,
  lastErrorSource: null,
  terminatedTurnIds: new Set(),
});

export const replayConversationShapeFromScratch = (
  turnId: string,
  events: readonly AgentEvent[],
): ConversationStateShape => {
  let state = createInitialConversationShape(turnId);
  for (const event of events) {
    // Mirror appendEvent's chokepoint: thinking_delta is never accumulated
    // (manifest persistence.mainAccumulator:false), so the from-scratch
    // reference must skip it too to stay a faithful model of getConversationShape.
    if (event.type === 'thinking_delta') continue;
    state = updateConversationWithEvent(state, turnId, event);
  }
  return state;
};

export class LazyContextAccumulator {
  private turnId: string;
  private sessionId: string | undefined;
  private events: AgentEvent[] = [];
  private cachedShape: ConversationStateShape | null = null;
  private nextSeq = 1;
  private executedToolCalls: ExecutedToolRecord[] = [];

  constructor(turnId: string, sessionId?: string) {
    this.turnId = turnId;
    this.sessionId = sessionId;
  }

  setSessionId(sessionId: string | undefined): void {
    this.sessionId = sessionId;
  }

  private resolveSessionId(sessionIdOverride?: string): string | undefined {
    if (typeof sessionIdOverride === 'string' && sessionIdOverride.length > 0) {
      this.sessionId = sessionIdOverride;
    }
    return this.sessionId;
  }

  /**
   * Stamp/normalize the event sequence for this turn.
   *
   * Prefers per-session monotonic sequencing when a session id is known.
   * Falls back to local per-turn sequencing when no session id is available.
   *
   * Preserves existing valid `event.seq` values and updates the active counter.
   * Invalid seq values (e.g. NaN, <=0, non-integer) are treated as missing and
   * re-stamped, with an observable warning.
   */
  stampSeq<T extends AgentEvent>(
    event: T,
    sessionIdOverride?: string,
  ): SequencedAgentEvent<T> {
    const activeSessionId = this.resolveSessionId(sessionIdOverride);

    if (isValidSeq(event.seq)) {
      this.nextSeq = Math.max(this.nextSeq, event.seq + 1);
      if (activeSessionId) {
        getSessionSeqIndex().setSeqFromStorage(activeSessionId, event.seq);
      }
      return event as SequencedAgentEvent<T>;
    }

    if (event.seq !== undefined) {
      log.warn(
        { turnId: this.turnId, sessionId: activeSessionId, eventType: event.type, seq: event.seq },
        'Encountered invalid event seq; re-stamping with next monotonic seq',
      );
    }

    if (activeSessionId) {
      const seq = getSessionSeqIndex().nextSeq(activeSessionId);
      this.nextSeq = Math.max(this.nextSeq, seq + 1);
      return {
        ...event,
        seq,
      } as SequencedAgentEvent<T>;
    }

    const seq = this.nextSeq++;
    return {
      ...event,
      seq,
    } as SequencedAgentEvent<T>;
  }

  /**
   * Append an event to this turn's accumulator.
   *
   * Single canonical `seq` source for all events flowing through this turn's
   * accumulator. Known accumulator-bypass producers (`userQuestionResponseHandler`
   * multi/single-batch answered events + `userQuestionHook`) are ordered to call
   * this before IPC broadcast so renderer payloads inherit the stamped `seq`.
   *
   * Returns a `SequencedAgentEvent<T>` — the branded type — so downstream
   * boundary surfaces (`agent:event` IPC broadcast, cloud `eventsByTurn`
   * persistence) typed against the brand reject unstamped siblings at
   * compile time. See `SequencedAgentEvent` JSDoc and
   * `docs-private/postmortems/260502_persist_user_question_answered_unstamped_postmortem.md`.
   */
  appendEvent<T extends AgentEvent>(event: T, sessionIdOverride?: string): SequencedAgentEvent<T> {
    const stampedEvent = this.stampSeq(event, sessionIdOverride);

    // Stage 2 (canonical chokepoint): `thinking_delta` is transient reasoning
    // stream telemetry — manifest `persistence.mainAccumulator: false`. The
    // shared reducer derives no message/liveness state from it, no history-reload
    // or cloud-catch-up path reads it back, and at high reasoning volume it
    // otherwise dominates the accumulator + persisted `eventsByTurn` (44k rows on
    // one 22-min turn). We still consume a `seq` above (so gaps are legitimate —
    // same as `assistant_delta`; see agent.ts maxSeq + eventIdentity invariants),
    // but never store it. This is THE accumulator-side guarantee: every caller
    // (dispatcher, headless/CLI runner, any future producer) inherits it, so a
    // new persistence path can't silently reintroduce the bloat.
    if (stampedEvent.type === 'thinking_delta') {
      return stampedEvent;
    }

    this.events.push(stampedEvent);
    this.cachedShape = null; // invalidate cache

    // Side-channel: record tool-use-start events in the executed-tools table
    // so recovery handlers can reason about mutation history without replaying
    // the full event list.
    if (stampedEvent.type === 'tool' && stampedEvent.stage === 'start') {
      const toolName = typeof stampedEvent.toolName === 'string' ? stampedEvent.toolName : 'unknown';
      const annotations = BUILT_IN_TOOL_ANNOTATIONS[toolName] ?? {};
      this.executedToolCalls.push({
        toolName,
        toolUseId: typeof stampedEvent.toolUseId === 'string' ? stampedEvent.toolUseId : undefined,
        annotations: { ...annotations },
        timestamp: typeof stampedEvent.timestamp === 'number' ? stampedEvent.timestamp : Date.now(),
      });
    }

    return stampedEvent;
  }

  getConversationShape(): ConversationStateShape {
    if (this.cachedShape) return this.cachedShape;

    let state = createInitialConversationShape(this.turnId);

    // O(n) replay. The reducer reads `eventsByTurn[turnId]` in two ways:
    //   1. the terminal-busy guard (any event) — covered here by the
    //      maintained `terminatedTurnIds` Set, so non-terminal steps can be
    //      fed `{}` (kept empty per step so this is NOT the old O(n^2) growth);
    //   2. message *content* recovery in mergeResultMessage / mergeErrorMessage
    //      (result/error only) — those need the real prior history, so terminal
    //      steps are fed the exact prefix `events.slice(0, i)`.
    // The slice is O(i) but paid only on terminal events (≈1–2 per turn), so the
    // whole replay stays O(n) for realistic streams. A pathological stream with
    // O(n) terminal events would be O(n^2) — acceptable; Stage 2 caps volume.
    for (let i = 0; i < this.events.length; i += 1) {
      const event = this.events[i];
      const reducerInputState: ConversationStateShape =
        event.type === 'result' || event.type === 'error'
          ? {
            ...state,
            eventsByTurn: { [this.turnId]: this.events.slice(0, i) },
          }
          : {
            ...state,
            eventsByTurn: {},
          };

      const nextState = updateConversationWithEvent(reducerInputState, this.turnId, event);
      state = {
        ...nextState,
        eventsByTurn: {},
      };
    }

    const snapshot: ConversationStateShape = {
      ...state,
      messages: [...state.messages],
      eventsByTurn: this.events.length > 0 ? { [this.turnId]: [...this.events] } : {},
      terminatedTurnIds: new Set(state.terminatedTurnIds),
    };

    this.cachedShape = snapshot;
    return snapshot;
  }

  getEventCount(): number {
    return this.events.length;
  }

  /**
   * Return a read-only view of the executed tool calls recorded in this turn.
   * The list is in chronological order. Empty if no tools have been dispatched.
   */
  getExecutedToolCalls(): readonly ExecutedToolRecord[] {
    return this.executedToolCalls;
  }

  /**
   * Explicitly record a tool-call annotation set after the fact. Used when
   * the caller learns annotations asynchronously (e.g. MCP `use_tool`
   * response carries annotations that weren't known at dispatch time).
   * Matches on `toolUseId`; if the record doesn't exist yet, the call is a
   * no-op (the tool event will catch it later).
   */
  recordExecutedToolAnnotations(
    toolUseId: string,
    annotations: Record<string, unknown>,
  ): void {
    for (const rec of this.executedToolCalls) {
      if (rec.toolUseId === toolUseId) {
        rec.annotations = { ...rec.annotations, ...annotations };
        return;
      }
    }
  }

  /**
   * Whether any tool executed in this turn is likely to have mutated state.
   * Conservative: returns true when at least one executed tool has
   * `destructiveHint === true` OR `readOnlyHint !== true` (unknown mutability
   * is treated as possibly-mutating). Returns false only when every executed
   * tool is explicitly read-only. Used by recovery-copy selection to decide
   * whether "just retry" is safe after a cap-breach error.
   */
  hasPossiblyMutatingToolCall(): boolean {
    if (this.executedToolCalls.length === 0) return false;
    for (const rec of this.executedToolCalls) {
      if (rec.annotations['destructiveHint'] === true) return true;
      if (rec.annotations['readOnlyHint'] !== true) return true;
    }
    return false;
  }
}
