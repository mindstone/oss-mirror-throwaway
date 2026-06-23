/**
 * Background-session event buffering subsystem for the renderer session store.
 *
 * Extracted from `sessionStore.ts` (behavior-preserving Stage 6). Instead of
 * cloning the `loadedSessions` Map on every intermediate event for background
 * sessions, events are accumulated here in the module-level
 * `backgroundEventBuffers` Map and flushed all at once on terminal events
 * (result/error) or on session switch. The buffering helpers, the per-turn
 * union/persist helpers, and the renderer breadcrumb recorders that observe the
 * history-reducer union all live here.
 *
 * `sessionStore.ts` imports the symbols its action closure calls directly
 * (`updatePendingQuestionEventSnapshots`, `bufferBackgroundEvent`,
 * `takeBackgroundEventBuffer`, `applyBufferedEventUnionToSession`,
 * `persistBufferedEventUnionForSession`) and re-exports the externally-consumed
 * helpers so the canonical `.../store/sessionStore` import path keeps resolving.
 * The buffer Map is read for leak diagnostics (in `./leakDiagnostics`, Stage 7)
 * via the encapsulated `getBackgroundEventBuffersForDiagnostics` accessor — no
 * direct cross-module Map access.
 *
 * @see ./sessionStore.ts — the store implementation that drives this subsystem
 * @see ./currentSessionEvents.ts — the sibling current-session event store
 * @see docs/plans/260622_refactor-session-store/PLAN.md — extraction plan
 */
import type { AgentEvent } from "@shared/types";
import type { AgentSessionWithRuntime } from "../types";
import { historyReducer } from "./reducers";
import { REPLAY_OPTIONS } from "@shared/utils/conversationState";
import { stripRendererOnlyEventsForEgress } from "./rendererLocalEventEgress";
import { hashSessionIdForBreadcrumb } from "@shared/utils/hashSessionIdForBreadcrumb";
import { recordRendererBreadcrumb } from "@renderer/src/sentry";
import { ignoreBestEffortCleanup } from "@shared/utils/intentionalSwallow";
import type {
  BufferedEvent,
  PendingQuestionEventSnapshot,
} from "./sessionStoreTypes";

// Background session event accumulator (PERF: batches cacheSession calls)
//
// Instead of cloning the loadedSessions Map on every intermediate event for
// background sessions, we accumulate events and flush them all at once on
// terminal events (result/error) or session switch.
//
// Events are stored as {turnId, event} tuples because a session can receive
// events from multiple turns (e.g. retry/restart), and historyReducer needs
// the correct turnId for each event.
// ---------------------------------------------------------------------------
const MAX_BUFFERED_EVENTS_PER_SESSION = 500;
const backgroundEventBuffers = new Map<string, BufferedEvent[]>();

export const updatePendingQuestionEventSnapshots = (
  current: Record<string, PendingQuestionEventSnapshot[]>,
  sessionId: string,
  turnId: string,
  event: AgentEvent,
): Record<string, PendingQuestionEventSnapshot[]> => {
  if (event.type !== 'user_question' && event.type !== 'user_question_answered') {
    return current;
  }

  const existing = current[sessionId] ?? [];
  let nextForSession = existing;

  if (event.type === 'user_question') {
    nextForSession = [
      ...existing.filter((entry) => entry.event.batchId !== event.batchId),
      { turnId, event },
    ];
  } else {
    nextForSession = existing.filter((entry) => entry.event.batchId !== event.batchId);
  }

  if (nextForSession === existing) {
    return current;
  }

  const next = { ...current };
  if (nextForSession.length > 0) {
    next[sessionId] = nextForSession;
  } else {
    delete next[sessionId];
  }
  return next;
};

/** Accumulate an event for a background session. */
export const bufferBackgroundEvent = (
  sessionId: string,
  turnId: string,
  event: AgentEvent,
): void => {
  const existing = backgroundEventBuffers.get(sessionId);
  if (existing) {
    if (existing.length >= MAX_BUFFERED_EVENTS_PER_SESSION) {
      existing.shift(); // Drop oldest to prevent unbounded growth
    }
    existing.push({ turnId, event });
  } else {
    backgroundEventBuffers.set(sessionId, [{ turnId, event }]);
  }
};

/** Take and clear buffered events for a session. */
export const takeBackgroundEventBuffer = (
  sessionId: string,
): BufferedEvent[] => {
  const events = backgroundEventBuffers.get(sessionId) ?? [];
  backgroundEventBuffers.delete(sessionId);
  return events;
};

export const groupBufferedEventsByTurn = (
  bufferedEvents: readonly BufferedEvent[],
): Map<string, AgentEvent[]> => {
  const grouped = new Map<string, AgentEvent[]>();
  for (const { turnId, event } of bufferedEvents) {
    const existing = grouped.get(turnId);
    if (existing) {
      existing.push(event);
    } else {
      grouped.set(turnId, [event]);
    }
  }
  return grouped;
};

const recordEventDedupActivatedBreadcrumb = (
  turnId: string,
  dedupedCount: number,
): void => {
  if (dedupedCount <= 0) return;
  recordRendererBreadcrumb({
    category: 'event-dedup-activated',
    data: {
      turnId: hashSessionIdForBreadcrumb(turnId),
      dedupedCount,
    },
  });
};

const recordLegacyFallbackIdentityBreadcrumb = (
  turnId: string,
  legacyEventCount: number,
): void => {
  if (legacyEventCount <= 0) return;
  recordRendererBreadcrumb({
    category: 'event-identity-legacy-fallback',
    data: {
      turnIdHash: hashSessionIdForBreadcrumb(turnId),
      legacyEventCount,
    },
  });
};

const recordSeqGapDetectedBreadcrumb = (
  turnId: string,
  gaps: Array<{ start: number; end: number }>,
): void => {
  if (gaps.length === 0) return;
  const gapRanges = gaps.map((gap) => (
    gap.start === gap.end ? `${gap.start}` : `${gap.start}-${gap.end}`
  ));
  recordRendererBreadcrumb({
    category: 'event-identity-seq-gap',
    data: {
      turnIdHash: hashSessionIdForBreadcrumb(turnId),
      gapCount: gaps.length,
      gapRanges,
    },
  });
};

const recordContentEquivalentRestampCollapsedBreadcrumb = (
  turnId: string,
  droppedSeq: number | null,
  retainedSeq: number | null,
): void => {
  recordRendererBreadcrumb({
    category: 'event-content-equivalent-restamp-collapsed',
    data: {
      turnIdHash: hashSessionIdForBreadcrumb(turnId),
      droppedSeq,
      retainedSeq,
    },
  });
};

export const unionEventsForTurnInSession = (
  session: AgentSessionWithRuntime,
  turnId: string,
  events: AgentEvent[],
): AgentSessionWithRuntime => {
  if (events.length === 0) return session;
  return historyReducer.applyTurnEventUnion(session, turnId, events, {
    ...REPLAY_OPTIONS,
    onDedupActivated: ({ turnId: dedupTurnId, dedupedCount }) => {
      recordEventDedupActivatedBreadcrumb(dedupTurnId, dedupedCount);
    },
    onLegacyFallbackIdentityUsed: ({ turnId: legacyTurnId, legacyEventCount }) => {
      recordLegacyFallbackIdentityBreadcrumb(legacyTurnId, legacyEventCount);
    },
    onSeqGapDetected: ({ turnId: gapTurnId, gaps }) => {
      recordSeqGapDetectedBreadcrumb(gapTurnId, gaps);
    },
    onContentEquivalentRestampCollapsed: ({ turnId: collapsedTurnId, droppedSeq, retainedSeq }) => {
      recordContentEquivalentRestampCollapsedBreadcrumb(collapsedTurnId, droppedSeq, retainedSeq);
    },
  });
};

export const applyBufferedEventUnionToSession = (
  session: AgentSessionWithRuntime,
  bufferedEvents: readonly BufferedEvent[],
): AgentSessionWithRuntime => {
  let updated = session;
  const grouped = groupBufferedEventsByTurn(bufferedEvents);
  for (const [turnId, events] of grouped) {
    updated = unionEventsForTurnInSession(updated, turnId, events);
  }
  return updated;
};

export const persistTurnEventUnionForSession = (
  sessionId: string,
  turnId: string,
  events: AgentEvent[],
): void => {
  if (events.length === 0) return;
  const sanitizedEvents = stripRendererOnlyEventsForEgress(events);
  if (sanitizedEvents.length === 0) {
    return;
  }
  window.sessionsApi.applyTurnEventUnion({
    sessionId,
    turnId,
    events: sanitizedEvents,
  })
    .then((result) => {
      if (result && !result.success) {
        console.warn(
          `[sessionStore] turn-event union persist failed for ${sessionId}:${turnId}`,
          result?.error,
        );
      }
    })
    .catch((err) => {
      // Fire-and-forget persist rejection: the renderer intentionally continues.
      // The original (single console.warn) is preserved below so observability is
      // unchanged; ignoreBestEffortCleanup additionally records the swallow intent
      // for the rebel-silent-swallow rule. In the renderer (no sinks injected) it
      // adds one low-severity console.debug line — an accepted, reviewer-blessed
      // cost of satisfying the lint rule without an eslint-disable escape hatch.
      ignoreBestEffortCleanup(err, {
        operation: 'backgroundEventBuffer.persistTurnEventUnionForSession',
        reason: 'fire-and-forget turn-event union persist; rejection is logged via console.warn and the renderer continues',
        severity: 'debug',
      });
      console.warn(
        `[sessionStore] turn-event union persist rejected for ${sessionId}:${turnId}`,
        err,
      );
    });
};

export const persistBufferedEventUnionForSession = (
  sessionId: string,
  bufferedEvents: readonly BufferedEvent[],
): void => {
  const grouped = groupBufferedEventsByTurn(bufferedEvents);
  for (const [turnId, events] of grouped) {
    persistTurnEventUnionForSession(sessionId, turnId, events);
  }
};

/**
 * Encapsulated read-accessor for leak diagnostics (Stage 7 `leakDiagnostics.ts`
 * reads buffered-event counts/bytes through this, never the raw Map). Returns a
 * read-only view so callers cannot mutate the buffer out-of-band.
 */
export const getBackgroundEventBuffersForDiagnostics = (): ReadonlyMap<
  string,
  BufferedEvent[]
> => backgroundEventBuffers;
