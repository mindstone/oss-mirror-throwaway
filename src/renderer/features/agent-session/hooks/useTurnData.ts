import { useCallback, useMemo, useRef } from 'react';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import { TURN_ID_FALLBACK } from '@renderer/constants';
import { formatTimestamp, createMessageSnippet } from '@renderer/utils/formatters';
import { buildTurnStepContextMap, type TurnStepContext } from '../utils/turnStepContext';
import { buildSubAgentTimeline, type SubAgentTimeline } from '../utils/subAgentTimeline';
import type { InsightTurnSummary } from '../work-surface/types';

export type UseTurnDataOptions = {
  eventsByTurn: Record<string, AgentEvent[]>;
  messages: AgentTurnMessage[];
  focusedTurnId: string | null;
};

export type UseTurnDataResult = {
  /** Step context data for each turn (used by InsightsDrawer, ConversationPane) */
  turnStepContextByTurn: Record<string, TurnStepContext>;
  /** Summary data for turn list sidebar */
  turnSummaries: InsightTurnSummary[];
  /** Sub-agent timeline for each turn */
  subAgentTimelineByTurn: Map<string, SubAgentTimeline>;
  /** Currently visible turn ID (active or latest) */
  visibleTurnId: string;
  /** Selected turn ID (null if fallback) */
  selectedTurnId: string | null;
  /** Resolves a message to its associated turn ID */
  resolveTurnIdForMessage: (message: AgentTurnMessage) => string | null;
  /** Assistant events for the visible turn */
  assistantEvents: AgentEvent[];
  /** Assistant steps for the visible turn */
  assistantSteps: AgentEvent[];
  /** All events for the visible turn (including status events) */
  turnEvents: AgentEvent[];
};

/**
 * Hook for processing turn event data into derived structures.
 * Transforms raw events into turn summaries, step contexts, and timelines.
 */
export function useTurnData({
  eventsByTurn,
  messages,
  focusedTurnId
}: UseTurnDataOptions): UseTurnDataResult {
  const orderedTurns = useMemo(() => Object.keys(eventsByTurn), [eventsByTurn]);

  // PERF FIX: Use per-turn caching to avoid recomputing unchanged turns.
  // Previously this computed context for every turn on each eventsByTurn change.
  // Now we cache per-turn and only recompute when a turn's events actually change.
  // Cache key uses events.length + last event timestamp to detect both appends and in-place updates.
  const turnStepContextCache = useMemo(() => new Map<string, { context: TurnStepContext; cacheKey: string }>(), []);

  // Build cache key from events array - length + last timestamp catches most changes
  const buildCacheKey = useCallback((events: AgentEvent[]): string => {
    const lastTimestamp = events.length > 0 ? events[events.length - 1].timestamp : 0;
    return `${events.length}:${lastTimestamp}`;
  }, []);

  // PERF FIX: Preserve wrapper object reference when all per-turn caches hit.
  // This prevents downstream consumers from re-rendering when eventsByTurn changes
  // but all individual turn data is unchanged.
  const prevTurnStepContextRef = useRef<Record<string, TurnStepContext> | null>(null);

  const turnStepContextByTurn = useMemo<Record<string, TurnStepContext>>(() => {
    const turnIds = Object.keys(eventsByTurn).filter(
      id => id !== TURN_ID_FALLBACK && eventsByTurn[id]?.length > 0
    );

    // Bound cache size to prevent unbounded memory growth across many session switches.
    // Unlike the old per-session pruning, this preserves entries from recently viewed sessions
    // so switching back gets cache hits with stable object references.
    const MAX_CACHED_TURNS = 300;
    if (turnStepContextCache.size > MAX_CACHED_TURNS) {
      const currentTurnIds = new Set(turnIds);
      const keysToEvict: string[] = [];
      for (const cachedTurnId of turnStepContextCache.keys()) {
        if (!currentTurnIds.has(cachedTurnId)) keysToEvict.push(cachedTurnId);
        if (turnStepContextCache.size - keysToEvict.length <= MAX_CACHED_TURNS) break;
      }
      for (const k of keysToEvict) turnStepContextCache.delete(k);
    }

    // Check if we can return the previous reference (all cache hits, same turn set)
    let allCacheHits = true;
    for (const turnId of turnIds) {
      const events = eventsByTurn[turnId];
      const cacheKey = buildCacheKey(events);
      const cached = turnStepContextCache.get(turnId);
      if (!cached || cached.cacheKey !== cacheKey) {
        allCacheHits = false;
        break;
      }
    }

    const prevContext = prevTurnStepContextRef.current;
    if (allCacheHits && prevContext) {
      const prevKeys = Object.keys(prevContext);
      if (prevKeys.length === turnIds.length && turnIds.every(id => id in prevContext)) {
        return prevContext;
      }
    }

    // Build fresh result, reusing cached inner objects for reference stability
    const result: Record<string, TurnStepContext> = {};
    
    for (const turnId of turnIds) {
      const events = eventsByTurn[turnId];
      const cacheKey = buildCacheKey(events);
      const cached = turnStepContextCache.get(turnId);
      
      if (cached && cached.cacheKey === cacheKey) {
        result[turnId] = cached.context;
        continue;
      }
      
      const context = buildTurnStepContextMap({ [turnId]: events })[turnId];
      if (context) {
        turnStepContextCache.set(turnId, { context, cacheKey });
        result[turnId] = context;
      }
    }
    
    prevTurnStepContextRef.current = result;
    return result;
  }, [eventsByTurn, buildCacheKey, turnStepContextCache]);

  const fallbackUserTurnAssignments = useMemo(() => {
    const assignments = new Map<string, string>();
    if (orderedTurns.length === 0) {
      return assignments;
    }

    const explicitlyMappedTurns = new Set(
      messages
        .filter(
          (message): message is AgentTurnMessage & { turnId: string } =>
            message.role === 'user' &&
            typeof message.turnId === 'string' &&
            message.turnId !== TURN_ID_FALLBACK &&
            Boolean(eventsByTurn[message.turnId])
        )
        .map((message) => message.turnId)
    );

    const availableTurns = orderedTurns
      .filter((turnId) => turnId !== TURN_ID_FALLBACK && eventsByTurn[turnId]?.length)
      .filter((turnId) => !explicitlyMappedTurns.has(turnId))
      .map((turnId) => ({
        turnId,
        startedAt: eventsByTurn[turnId]?.[0]?.timestamp ?? Number.POSITIVE_INFINITY
      }))
      .sort((a, b) => a.startedAt - b.startedAt);

    const fallbackUserMessages = messages
      .filter((message) => message.role === 'user' && message.turnId === TURN_ID_FALLBACK)
      .sort((a, b) => a.createdAt - b.createdAt);

    const limit = Math.min(availableTurns.length, fallbackUserMessages.length);
    for (let index = 0; index < limit; index += 1) {
      assignments.set(fallbackUserMessages[index].id, availableTurns[index].turnId);
    }

    return assignments;
  }, [eventsByTurn, messages, orderedTurns]);

  const resolveTurnIdForMessage = useCallback(
    (message: AgentTurnMessage): string | null => {
      // If message has a valid turnId with events, return it (full interaction available)
      if (message.turnId && message.turnId !== TURN_ID_FALLBACK && eventsByTurn[message.turnId]) {
        return message.turnId;
      }
      // For non-user messages, return turnId even without events.
      // This allows status lookups (timeSaved, memoryUpdate) after compaction
      // when events are cleared but status maps are preserved.
      if (message.role !== 'user') {
        return message.turnId && message.turnId !== TURN_ID_FALLBACK
          ? message.turnId
          : null;
      }
      // For user messages, try fallback assignment (legacy support)
      const assignedTurnId = fallbackUserTurnAssignments.get(message.id);
      if (assignedTurnId && eventsByTurn[assignedTurnId]) {
        return assignedTurnId;
      }
      return null;
    },
    [eventsByTurn, fallbackUserTurnAssignments]
  );

  const visibleTurnId = useMemo(() => {
    if (focusedTurnId) return focusedTurnId;
    if (orderedTurns.length > 0) {
      return orderedTurns[orderedTurns.length - 1];
    }
    return TURN_ID_FALLBACK;
  }, [focusedTurnId, orderedTurns]);

  const selectedTurnId = visibleTurnId === TURN_ID_FALLBACK ? null : visibleTurnId;

  // Clone the turn events array so downstream useMemo deps ([turnEvents]) see a new
  // reference on each deferred version bump. With push-in-place in sessionStore,
  // eventsByTurn[turnId] returns the same array — this clone runs once per deferred
  // batch (~4-10/sec during activity), NOT per event.
  const turnEvents = useMemo(
    () => {
      const events = eventsByTurn[visibleTurnId];
      return events ? [...events] : [];
    },
    [eventsByTurn, visibleTurnId]
  );

  // PERF FIX: Use per-turn caching for sub-agent timelines.
  // Same pattern as turnStepContextByTurn - cache by turnId with composite cache key.
  const subAgentTimelineCache = useMemo(() => new Map<string, { timeline: SubAgentTimeline; cacheKey: string }>(), []);

  // PERF FIX: Preserve wrapper Map reference when all per-turn caches hit.
  const prevSubAgentTimelineRef = useRef<Map<string, SubAgentTimeline> | null>(null);

  const subAgentTimelineByTurn = useMemo(() => {
    const turnIds = Object.keys(eventsByTurn).filter(
      id => id !== TURN_ID_FALLBACK && eventsByTurn[id]?.length > 0
    );

    // Bound cache size (same pattern as turnStepContextCache above)
    const MAX_CACHED_TIMELINES = 300;
    if (subAgentTimelineCache.size > MAX_CACHED_TIMELINES) {
      const currentTurnIds = new Set(turnIds);
      const keysToEvict: string[] = [];
      for (const cachedTurnId of subAgentTimelineCache.keys()) {
        if (!currentTurnIds.has(cachedTurnId)) keysToEvict.push(cachedTurnId);
        if (subAgentTimelineCache.size - keysToEvict.length <= MAX_CACHED_TIMELINES) break;
      }
      for (const k of keysToEvict) subAgentTimelineCache.delete(k);
    }

    // Check if we can return the previous reference (all cache hits, same turn set)
    let allCacheHits = true;
    for (const turnId of turnIds) {
      const events = eventsByTurn[turnId];
      const cacheKey = buildCacheKey(events);
      const cached = subAgentTimelineCache.get(turnId);
      if (!cached || cached.cacheKey !== cacheKey) {
        allCacheHits = false;
        break;
      }
    }

    const prevTimelines = prevSubAgentTimelineRef.current;
    if (allCacheHits && prevTimelines) {
      if (prevTimelines.size === turnIds.length && turnIds.every(id => prevTimelines.has(id))) {
        return prevTimelines;
      }
    }

    // Build fresh result, reusing cached inner objects for reference stability
    const map = new Map<string, SubAgentTimeline>();
    
    for (const turnId of turnIds) {
      const events = eventsByTurn[turnId];
      const cacheKey = buildCacheKey(events);
      const cached = subAgentTimelineCache.get(turnId);
      
      if (cached && cached.cacheKey === cacheKey) {
        map.set(turnId, cached.timeline);
        continue;
      }
      
      // Cache miss - compute fresh timeline
      const context = turnStepContextByTurn[turnId];
      const timeline = buildSubAgentTimeline(events, context);
      if (timeline) {
        subAgentTimelineCache.set(turnId, { timeline, cacheKey });
        map.set(turnId, timeline);
      }
    }

    prevSubAgentTimelineRef.current = map;
    return map;
  }, [eventsByTurn, turnStepContextByTurn, buildCacheKey, subAgentTimelineCache]);

  const userMessagesByTurn = useMemo(() => {
    const map = new Map<string, AgentTurnMessage>();
    for (const message of messages) {
      if (message.role !== 'user') {
        continue;
      }
      const resolvedTurnId = resolveTurnIdForMessage(message);
      if (resolvedTurnId && !map.has(resolvedTurnId)) {
        map.set(resolvedTurnId, message);
      }
    }
    return map;
  }, [messages, resolveTurnIdForMessage]);

  const turnSummaries = useMemo<InsightTurnSummary[]>(() => {
    if (orderedTurns.length === 0) return [];
    return orderedTurns
      .map((turnId) => {
        if (turnId === TURN_ID_FALLBACK) return null;
        const events = eventsByTurn[turnId];
        if (!events || events.length === 0) return null;

        const userMessage = userMessagesByTurn.get(turnId);
        const startedAt = userMessage?.createdAt ?? events[0].timestamp;
        const lastTimestamp = events[events.length - 1]?.timestamp ?? startedAt;

        let status: InsightTurnSummary['status'] = 'running';
        if (events.some((event) => event.type === 'error')) {
          status = 'error';
        } else if (events.some((event) => event.type === 'result')) {
          status = 'complete';
        }

        const fallbackLabel = formatTimestamp(startedAt) || 'Untitled run';
        const label = userMessage ? createMessageSnippet(userMessage.text, 52) : `Run at ${fallbackLabel}`;

        return {
          turnId,
          label,
          startedAt,
          lastTimestamp,
          status
        } as InsightTurnSummary;
      })
      .filter((summary): summary is InsightTurnSummary => Boolean(summary))
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }, [eventsByTurn, orderedTurns, userMessagesByTurn]);

  const assistantEvents = useMemo(
    () => turnEvents.filter((event) => event.type === 'assistant'),
    [turnEvents]
  );

  const visibleTurnContext = useMemo(() => {
    if (visibleTurnId === TURN_ID_FALLBACK) {
      return undefined;
    }
    return turnStepContextByTurn[visibleTurnId];
  }, [turnStepContextByTurn, visibleTurnId]);

  const assistantSteps = useMemo(
    () => visibleTurnContext?.assistantSteps ?? [],
    [visibleTurnContext]
  );

  return {
    turnStepContextByTurn,
    turnSummaries,
    subAgentTimelineByTurn,
    visibleTurnId,
    selectedTurnId,
    resolveTurnIdForMessage,
    assistantEvents,
    assistantSteps,
    /** All events for the visible turn (including status events) */
    turnEvents,
  };
}
