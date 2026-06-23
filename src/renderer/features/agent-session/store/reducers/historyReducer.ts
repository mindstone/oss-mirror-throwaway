import type { AgentEvent, AgentSession } from "@shared/types";
import type { AgentSessionWithRuntime } from "../../types";
import {
  updateConversationWithEvent,
  deriveInteractionTimestamp,
  type ConversationStateShape,
  type ConversationUpdateOptions,
} from "@core/services/agentTurnReducer/conversation";
import {
  getContentEquivalenceKey,
  getEventIdentity,
  unionEventsByIdentity,
} from '@shared/utils/eventIdentity';
import {
  applyEventToRuntime,
  createRuntimeState,
} from "@core/services/agentTurnReducer/runtime";
import { stripSessionForEgress } from '../rendererLocalEventEgress';

/**
 * Process an event on a single session and return the updated session.
 * Used for updating sessions in the LRU cache (lazy loading).
 */
export const updateSessionWithEvent = (
  session: AgentSessionWithRuntime,
  turnId: string,
  event: AgentEvent,
  options?: ConversationUpdateOptions,
): AgentSessionWithRuntime => {
  const conversationState: ConversationStateShape = {
    messages: session.messages,
    eventsByTurn: session.eventsByTurn,
    activeTurnId: session.activeTurnId ?? null,
    focusedTurnId: null,
    isBusy: session.isBusy ?? Boolean(session.activeTurnId),
    lastError: session.lastError ?? null,
    lastErrorSource: null,
    terminatedTurnIds: session.terminatedTurnIds instanceof Set ? session.terminatedTurnIds : new Set(),
  };

  const updatedConversation = updateConversationWithEvent(
    conversationState,
    turnId,
    event,
    options,
  );
  const nextRuntime = applyEventToRuntime(
    session.runtime ?? createRuntimeState(),
    turnId,
    event,
  );

  const previousTimestamp =
    session.updatedAt ?? session.createdAt ?? event.timestamp;
  const updatedAt = deriveInteractionTimestamp(
    updatedConversation.messages,
    previousTimestamp,
  );

  // Mark session as resolved when turn completes
  const isTerminalEvent = event.type === "result" || event.type === "error";
  const resolvedAt = isTerminalEvent ? event.timestamp : session.resolvedAt;

  return {
    ...session,
    messages: updatedConversation.messages,
    eventsByTurn: updatedConversation.eventsByTurn,
    // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Replay reducer applies conversation projection output directly; persisted writes are later stamped from event history.
    activeTurnId: updatedConversation.activeTurnId,
    // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Replay/normalize event application uses projected busy scalar from updateConversationWithEvent.
    isBusy: updatedConversation.isBusy,
    lastError: updatedConversation.lastError,
    terminatedTurnIds: updatedConversation.terminatedTurnIds,
    updatedAt,
    runtime: nextRuntime,
    resolvedAt,
  };
};

export type ApplyTurnEventUnionOptions = ConversationUpdateOptions & {
  onDedupActivated?: (params: { turnId: string; dedupedCount: number }) => void;
  onLegacyFallbackIdentityUsed?: (params: {
    turnId: string;
    legacyEventCount: number;
  }) => void;
  onSeqGapDetected?: (params: {
    turnId: string;
    gaps: Array<{ start: number; end: number }>;
  }) => void;
  onContentEquivalentRestampCollapsed?: (params: {
    turnId: string;
    droppedSeq: number | null;
    retainedSeq: number | null;
  }) => void;
};

/**
 * Merge a batch of replayed events into a turn using identity-based UNION.
 *
 * Keeps `updateSessionWithEvent` as the live-event path and reuses it here for
 * the novel (non-duplicate) events only, so callers can replay buffered
 * batches in a single reducer call.
 */
export const applyTurnEventUnion = (
  session: AgentSessionWithRuntime,
  turnId: string,
  events: AgentEvent[],
  options?: ApplyTurnEventUnionOptions,
): AgentSessionWithRuntime => {
  if (events.length === 0) return session;

  const {
    onDedupActivated,
    onLegacyFallbackIdentityUsed,
    onSeqGapDetected,
    onContentEquivalentRestampCollapsed,
    ...conversationOptions
  } = options ?? {};
  const baseEvents = session.eventsByTurn[turnId] ?? [];
  const unionedEvents = unionEventsByIdentity(turnId, baseEvents, events, {
    onLegacyFallbackIdentityUsed,
    onSeqGapDetected,
    onContentEquivalentRestampCollapsed,
  });

  const baseIdentities = new Set(baseEvents.map((event) => getEventIdentity(turnId, event)));
  const baseContentKeys = new Set(
    baseEvents
      .map((event) => getContentEquivalenceKey(turnId, event))
      .filter((key): key is string => key !== null),
  );
  const novelSeqSeen = new Set(baseIdentities);
  const novelContentSeen = new Set(baseContentKeys);
  const novelEvents: AgentEvent[] = [];
  let dedupedCount = 0;

  for (const event of events) {
    const identity = getEventIdentity(turnId, event);
    if (baseIdentities.has(identity)) {
      dedupedCount += 1;
    }
    if (novelSeqSeen.has(identity)) {
      continue;
    }
    const contentKey = getContentEquivalenceKey(turnId, event);
    if (contentKey !== null && novelContentSeen.has(contentKey)) {
      continue;
    }
    novelSeqSeen.add(identity);
    if (contentKey !== null) novelContentSeen.add(contentKey);
    novelEvents.push(event);
  }

  if (dedupedCount > 0) {
    onDedupActivated?.({ turnId, dedupedCount });
  }

  let updatedSession = session;
  for (const event of novelEvents) {
    updatedSession = updateSessionWithEvent(
      updatedSession,
      turnId,
      event,
      conversationOptions,
    );
  }

  const nextTurnEvents = updatedSession.eventsByTurn[turnId] ?? [];
  if (
    nextTurnEvents.length !== unionedEvents.length ||
    nextTurnEvents.some((event, index) => event !== unionedEvents[index])
  ) {
    return {
      ...updatedSession,
      eventsByTurn: {
        ...updatedSession.eventsByTurn,
        [turnId]: unionedEvents,
      },
    };
  }

  return updatedSession;
};

export const addOrUpdateHistorySession = (
  sessions: AgentSessionWithRuntime[],
  session: AgentSessionWithRuntime,
  prepend = true,
): AgentSessionWithRuntime[] => {
  const filtered = sessions.filter((s) => s.id !== session.id);
  return prepend ? [session, ...filtered] : [...filtered, session];
};

export const removeHistorySession = (
  sessions: AgentSessionWithRuntime[],
  sessionId: string,
): AgentSessionWithRuntime[] => sessions.filter((s) => s.id !== sessionId);

export const softDeleteSession = (
  sessions: AgentSessionWithRuntime[],
  sessionId: string,
): AgentSessionWithRuntime[] => {
  const timestamp = Date.now();
  return sessions.map((session) =>
    session.id === sessionId
      ? // Force clean state when deleting - turn is still stopped via fire-and-forget,
        // but the snapshot in Trash should not show as busy/active
        { ...session, deletedAt: timestamp, isBusy: false, activeTurnId: null }
      : session,
  );
};

export const restoreSession = (
  sessions: AgentSessionWithRuntime[],
  sessionId: string,
): AgentSessionWithRuntime[] => {
  return sessions.map((session) =>
    session.id === sessionId ? { ...session, deletedAt: null } : session,
  );
};

export const stripRuntimeFromSessions = (
  sessions: AgentSessionWithRuntime[],
): AgentSession[] => sessions.map((session) => stripSessionForEgress(session));
