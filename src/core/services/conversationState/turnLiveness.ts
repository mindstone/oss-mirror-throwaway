/**
 * Canonical turn-liveness projection: the single `@core` derivation of
 * `idle | running | terminal | interrupted` from the synced event log.
 *
 * @see ../../../../docs/project/UI_CONVERSATIONS.md — Turn-liveness projection (Intent & Design Rationale)
 * @see ../../../../docs/plans/260530_turn_liveness_projection.md — full design + invariants
 */
import { applyEventToRuntime, createRuntimeState, isTurnStale } from '@core/services/agentTurnReducer/runtime';
import { isValidSeq } from '@shared/utils/eventIdentity';
import type { AgentEvent } from '@shared/types';

export type TurnLivenessStatus = 'idle' | 'running' | 'terminal' | 'interrupted';

export type TurnLivenessSnapshot = {
  status: TurnLivenessStatus;
  activeTurnId: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
};

declare const derivedLivenessBrand: unique symbol;

export interface DerivedLiveness extends TurnLivenessSnapshot {
  readonly [derivedLivenessBrand]: 'DerivedLiveness';
}

export type TurnAdmissionOrder =
  | ReadonlyMap<string, number>
  | Readonly<Record<string, number | undefined>>;

export interface DeriveTurnLivenessOptions {
  /**
   * Optional stale scalar carried on snapshots today. Used only for read-path
   * compatibility recovery; the event stream remains the source of truth.
   */
  declaredActiveTurnId?: string | null;
  /**
   * Optional external admission tiebreak from turn registry. This must be
   * sourced independently from the event ordering being computed.
   */
  turnAdmissionOrder?: TurnAdmissionOrder;
}

type TurnOrderingContext = {
  turnId: string;
  admissionOrder: number | null;
  firstEventTimestamp: number;
  turnInsertionIndex: number;
};

type OrderedEvent = {
  turnId: string;
  event: AgentEvent;
  timestamp: number;
  hasValidSeq: boolean;
  seq: number;
  turnOrder: TurnOrderingContext;
  globalInsertionIndex: number;
};

type RunningTurnCandidate = {
  turnId: string;
  startedAt: number;
  lastActivityAt: number;
};

type TurnEventSnapshot = {
  eventsRef: AgentEvent[];
  length: number;
  turnOrder: TurnOrderingContext;
};

type OrderedProjection = {
  orderedEvents: OrderedEvent[];
  runtime: ReturnType<typeof createRuntimeState>;
  hasAnyTerminalEvent: boolean;
};

type IncrementalProjectionCache = OrderedProjection & {
  turnSnapshotsById: Map<string, TurnEventSnapshot>;
  nextGlobalInsertionIndex: number;
};

type DeriveTurnLivenessPerfStats = {
  fullRebuilds: number;
  incrementalUpdates: number;
  tailOnlyFolds: number;
  fullRefoldsAfterIncrementalInsert: number;
  foldedEventCount: number;
};

const deriveTurnLivenessPerfStats: DeriveTurnLivenessPerfStats = {
  fullRebuilds: 0,
  incrementalUpdates: 0,
  tailOnlyFolds: 0,
  fullRefoldsAfterIncrementalInsert: 0,
  foldedEventCount: 0,
};

let incrementalProjectionCache: IncrementalProjectionCache | null = null;

const TERMINAL_TYPES = new Set<AgentEvent['type']>(['result', 'error']);

const getAdmissionOrder = (
  turnId: string,
  source?: TurnAdmissionOrder,
): number | null => {
  if (!source) return null;
  const raw = source instanceof Map
    ? source.get(turnId)
    : (source as Readonly<Record<string, number | undefined>>)[turnId];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || !Number.isFinite(raw)) {
    return null;
  }
  return raw;
};

const compareTurnOrder = (left: TurnOrderingContext, right: TurnOrderingContext): number => {
  const leftHasAdmissionOrder = left.admissionOrder !== null;
  const rightHasAdmissionOrder = right.admissionOrder !== null;

  if (leftHasAdmissionOrder && rightHasAdmissionOrder) {
    const byAdmissionOrder = (left.admissionOrder as number) - (right.admissionOrder as number);
    if (byAdmissionOrder !== 0) return byAdmissionOrder;
  } else if (leftHasAdmissionOrder !== rightHasAdmissionOrder) {
    return leftHasAdmissionOrder ? -1 : 1;
  }

  if (left.firstEventTimestamp !== right.firstEventTimestamp) {
    return left.firstEventTimestamp - right.firstEventTimestamp;
  }

  return left.turnInsertionIndex - right.turnInsertionIndex;
};

const compareOrderedEvents = (left: OrderedEvent, right: OrderedEvent): number => {
  if (left.hasValidSeq && right.hasValidSeq) {
    if (left.seq !== right.seq) {
      return left.seq - right.seq;
    }
    const byTurnOrder = compareTurnOrder(left.turnOrder, right.turnOrder);
    if (byTurnOrder !== 0) return byTurnOrder;
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }
    return left.globalInsertionIndex - right.globalInsertionIndex;
  }

  if (left.hasValidSeq !== right.hasValidSeq) {
    return left.hasValidSeq ? -1 : 1;
  }

  const byTurnOrder = compareTurnOrder(left.turnOrder, right.turnOrder);
  if (byTurnOrder !== 0) return byTurnOrder;

  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }

  // Same-timestamp legacy events keep stable insertion order.
  return left.globalInsertionIndex - right.globalInsertionIndex;
};

const buildTurnOrderById = (
  turnEntries: Array<[string, AgentEvent[]]>,
  turnAdmissionOrder?: TurnAdmissionOrder,
): Map<string, TurnOrderingContext> => {
  const turnOrderById = new Map<string, TurnOrderingContext>();
  for (let index = 0; index < turnEntries.length; index += 1) {
    const [turnId, events] = turnEntries[index];
    const firstEventTimestamp = events.length > 0
      ? events[0]?.timestamp ?? Number.POSITIVE_INFINITY
      : Number.POSITIVE_INFINITY;
    turnOrderById.set(turnId, {
      turnId,
      admissionOrder: getAdmissionOrder(turnId, turnAdmissionOrder),
      firstEventTimestamp,
      turnInsertionIndex: index,
    });
  }
  return turnOrderById;
};

const toOrderedEvent = (
  turnId: string,
  event: AgentEvent,
  turnOrder: TurnOrderingContext,
  globalInsertionIndex: number,
): OrderedEvent => ({
  turnId,
  event,
  timestamp: event.timestamp,
  hasValidSeq: isValidSeq(event.seq),
  seq: isValidSeq(event.seq) ? event.seq : Number.POSITIVE_INFINITY,
  turnOrder,
  globalInsertionIndex,
});

const toSortedEvents = (
  eventsByTurn: Record<string, AgentEvent[]>,
  turnAdmissionOrder?: TurnAdmissionOrder,
): OrderedEvent[] => {
  const turnEntries = Object.entries(eventsByTurn);
  const turnOrderById = buildTurnOrderById(turnEntries, turnAdmissionOrder);

  const ordered: OrderedEvent[] = [];
  let insertionIndex = 0;
  for (const [turnId, events] of turnEntries) {
    const turnOrder = turnOrderById.get(turnId);
    if (!turnOrder) continue;

    for (const event of events) {
      ordered.push(toOrderedEvent(turnId, event, turnOrder, insertionIndex));
      insertionIndex += 1;
    }
  }

  ordered.sort(compareOrderedEvents);
  return ordered;
};

const foldOrderedEvents = (
  orderedEvents: OrderedEvent[],
): Pick<OrderedProjection, 'runtime' | 'hasAnyTerminalEvent'> => {
  let runtime = createRuntimeState();
  let hasAnyTerminalEvent = false;
  for (const orderedEvent of orderedEvents) {
    runtime = applyEventToRuntime(runtime, orderedEvent.turnId, orderedEvent.event);
    if (TERMINAL_TYPES.has(orderedEvent.event.type)) {
      hasAnyTerminalEvent = true;
    }
  }
  return { runtime, hasAnyTerminalEvent };
};

const buildTurnSnapshots = (
  turnEntries: Array<[string, AgentEvent[]]>,
  turnOrderById: Map<string, TurnOrderingContext>,
): Map<string, TurnEventSnapshot> => {
  const snapshots = new Map<string, TurnEventSnapshot>();
  for (const [turnId, events] of turnEntries) {
    const turnOrder = turnOrderById.get(turnId);
    if (!turnOrder) continue;
    snapshots.set(turnId, {
      eventsRef: events,
      length: events.length,
      turnOrder,
    });
  }
  return snapshots;
};

const findInsertionIndex = (
  orderedEvents: OrderedEvent[],
  needle: OrderedEvent,
): number => {
  let low = 0;
  let high = orderedEvents.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const current = orderedEvents[mid];
    if (!current) break;
    if (compareOrderedEvents(current, needle) <= 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};

const buildProjectionFromScratch = (
  eventsByTurn: Record<string, AgentEvent[]>,
  turnAdmissionOrder?: TurnAdmissionOrder,
): OrderedProjection => {
  const turnEntries = Object.entries(eventsByTurn);
  const turnOrderById = buildTurnOrderById(turnEntries, turnAdmissionOrder);
  const orderedEvents = toSortedEvents(eventsByTurn, turnAdmissionOrder);
  const folded = foldOrderedEvents(orderedEvents);
  incrementalProjectionCache = {
    orderedEvents,
    runtime: folded.runtime,
    hasAnyTerminalEvent: folded.hasAnyTerminalEvent,
    turnSnapshotsById: buildTurnSnapshots(turnEntries, turnOrderById),
    nextGlobalInsertionIndex: orderedEvents.length,
  };
  deriveTurnLivenessPerfStats.fullRebuilds += 1;
  deriveTurnLivenessPerfStats.foldedEventCount += orderedEvents.length;
  return {
    orderedEvents,
    runtime: folded.runtime,
    hasAnyTerminalEvent: folded.hasAnyTerminalEvent,
  };
};

const tryBuildProjectionIncrementally = (
  eventsByTurn: Record<string, AgentEvent[]>,
  turnAdmissionOrder?: TurnAdmissionOrder,
): OrderedProjection | null => {
  const previous = incrementalProjectionCache;
  if (!previous) return null;

  const turnEntries = Object.entries(eventsByTurn);
  if (previous.turnSnapshotsById.size > turnEntries.length) {
    return null;
  }

  const turnOrderById = buildTurnOrderById(turnEntries, turnAdmissionOrder);
  const knownTurnIds = new Set(turnEntries.map(([turnId]) => turnId));
  for (const cachedTurnId of previous.turnSnapshotsById.keys()) {
    if (!knownTurnIds.has(cachedTurnId)) {
      return null;
    }
  }

  const appendedEvents: OrderedEvent[] = [];
  let nextGlobalInsertionIndex = previous.nextGlobalInsertionIndex;

  for (let index = 0; index < turnEntries.length; index += 1) {
    const [turnId, events] = turnEntries[index];
    const turnOrder = turnOrderById.get(turnId);
    if (!turnOrder) return null;

    const cached = previous.turnSnapshotsById.get(turnId);
    if (!cached) {
      if (index < previous.turnSnapshotsById.size) {
        return null;
      }
      for (const event of events) {
        appendedEvents.push(
          toOrderedEvent(turnId, event, turnOrder, nextGlobalInsertionIndex),
        );
        nextGlobalInsertionIndex += 1;
      }
      continue;
    }

    if (cached.eventsRef !== events) {
      return null;
    }
    if (events.length < cached.length) {
      return null;
    }
    if (
      cached.turnOrder.admissionOrder !== turnOrder.admissionOrder
      || cached.turnOrder.turnInsertionIndex !== turnOrder.turnInsertionIndex
      || (cached.length > 0 && cached.turnOrder.firstEventTimestamp !== turnOrder.firstEventTimestamp)
    ) {
      return null;
    }

    for (let eventIndex = cached.length; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex];
      if (!event) continue;
      appendedEvents.push(
        toOrderedEvent(turnId, event, turnOrder, nextGlobalInsertionIndex),
      );
      nextGlobalInsertionIndex += 1;
    }
  }

  if (appendedEvents.length === 0) {
    return {
      runtime: previous.runtime,
      hasAnyTerminalEvent: previous.hasAnyTerminalEvent,
      orderedEvents: previous.orderedEvents,
    };
  }

  deriveTurnLivenessPerfStats.incrementalUpdates += 1;

  const nextOrderedEvents = [...previous.orderedEvents];
  let tailOnlyInsert = true;
  for (const appendedEvent of appendedEvents) {
    const tail = nextOrderedEvents[nextOrderedEvents.length - 1];
    if (!tail || compareOrderedEvents(tail, appendedEvent) <= 0) {
      nextOrderedEvents.push(appendedEvent);
      continue;
    }
    tailOnlyInsert = false;
    const insertionIndex = findInsertionIndex(nextOrderedEvents, appendedEvent);
    nextOrderedEvents.splice(insertionIndex, 0, appendedEvent);
  }

  let runtime = previous.runtime;
  let hasAnyTerminalEvent = previous.hasAnyTerminalEvent;
  if (tailOnlyInsert) {
    for (const appendedEvent of appendedEvents) {
      runtime = applyEventToRuntime(runtime, appendedEvent.turnId, appendedEvent.event);
      if (TERMINAL_TYPES.has(appendedEvent.event.type)) {
        hasAnyTerminalEvent = true;
      }
    }
    deriveTurnLivenessPerfStats.tailOnlyFolds += 1;
    deriveTurnLivenessPerfStats.foldedEventCount += appendedEvents.length;
  } else {
    const refolded = foldOrderedEvents(nextOrderedEvents);
    runtime = refolded.runtime;
    hasAnyTerminalEvent = refolded.hasAnyTerminalEvent;
    deriveTurnLivenessPerfStats.fullRefoldsAfterIncrementalInsert += 1;
    deriveTurnLivenessPerfStats.foldedEventCount += nextOrderedEvents.length;
  }

  incrementalProjectionCache = {
    orderedEvents: nextOrderedEvents,
    runtime,
    hasAnyTerminalEvent,
    turnSnapshotsById: buildTurnSnapshots(turnEntries, turnOrderById),
    nextGlobalInsertionIndex,
  };
  return { orderedEvents: nextOrderedEvents, runtime, hasAnyTerminalEvent };
};

const deriveStatus = (args: {
  runtime: ReturnType<typeof createRuntimeState>;
  now: number;
  hasAnyTerminalEvent: boolean;
}): TurnLivenessStatus => {
  const { runtime, now, hasAnyTerminalEvent } = args;
  if (runtime.startedAt !== null && runtime.activeTurnId !== null) {
    return isTurnStale(runtime, now) ? 'interrupted' : 'running';
  }
  if (runtime.terminated || hasAnyTerminalEvent) {
    return 'terminal';
  }
  return 'idle';
};

const foldRuntimeForTurn = (
  turnId: string,
  events: AgentEvent[],
): ReturnType<typeof createRuntimeState> => {
  let runtime = createRuntimeState();
  for (const event of events) {
    runtime = applyEventToRuntime(runtime, turnId, event);
  }
  return runtime;
};

const recoverMostRecentlyActiveTurn = (
  eventsByTurn: Record<string, AgentEvent[]>,
): RunningTurnCandidate | null => {
  let picked: RunningTurnCandidate | null = null;

  for (const [turnId, turnEvents] of Object.entries(eventsByTurn)) {
    const runtime = foldRuntimeForTurn(turnId, turnEvents);
    const lastActivityAt = runtime.lastActivityAt ?? runtime.startedAt;
    if (
      runtime.startedAt === null ||
      runtime.activeTurnId !== turnId ||
      lastActivityAt == null
    ) {
      continue;
    }

    if (picked === null || lastActivityAt > picked.lastActivityAt) {
      picked = {
        turnId,
        startedAt: runtime.startedAt,
        lastActivityAt,
      };
    }
  }

  return picked;
};

const asDerivedLiveness = (snapshot: TurnLivenessSnapshot): DerivedLiveness =>
  Object.freeze(snapshot) as unknown as DerivedLiveness;

/**
 * Canonical liveness projection for the EVENTS path.
 *
 * Notes:
 * - Folds a single globally ordered event stream through one session runtime.
 * - Keeps deterministic ordering under legacy/missing seq and duplicate seqs.
 * - Accepts an independent admission-order tiebreak (from turn registry) and
 *   falls back to first-event timestamp + stable insertion order.
 */
export function deriveTurnLiveness(
  eventsByTurn: Record<string, AgentEvent[]> | null | undefined,
  now: number = Date.now(),
  options?: DeriveTurnLivenessOptions,
): DerivedLiveness {
  const eventMap = eventsByTurn ?? {};
  if (Object.keys(eventMap).length === 0) {
    incrementalProjectionCache = {
      orderedEvents: [],
      runtime: createRuntimeState(),
      hasAnyTerminalEvent: false,
      turnSnapshotsById: new Map<string, TurnEventSnapshot>(),
      nextGlobalInsertionIndex: 0,
    };
    return asDerivedLiveness({
      status: 'idle',
      activeTurnId: null,
      startedAt: null,
      lastActivityAt: null,
    });
  }

  const projection = tryBuildProjectionIncrementally(eventMap, options?.turnAdmissionOrder)
    ?? buildProjectionFromScratch(eventMap, options?.turnAdmissionOrder);
  let runtime = projection.runtime;
  const hasAnyTerminalEvent = projection.hasAnyTerminalEvent;

  // Compatibility with snapshot recovery behavior in sessionStore:
  // 1) If a declared active turn is still genuinely active, preserve it.
  // 2) If declared active is stale (or absent/null) and the global fold ends
  //    idle, recover the most-recently-active turn via per-turn runtime scans.
  const declaredActiveTurnId = options?.declaredActiveTurnId ?? null;
  if (declaredActiveTurnId) {
    const declaredRuntime = foldRuntimeForTurn(
      declaredActiveTurnId,
      eventMap[declaredActiveTurnId] ?? [],
    );
    if (
      declaredRuntime.startedAt !== null &&
      declaredRuntime.activeTurnId === declaredActiveTurnId
    ) {
      runtime = declaredRuntime;
    }
  }

  if (runtime.activeTurnId === null) {
    const recovered = recoverMostRecentlyActiveTurn(eventMap);
    if (recovered !== null) {
      runtime = createRuntimeState({
        startedAt: recovered.startedAt,
        lastActivityAt: recovered.lastActivityAt,
        activeTurnId: recovered.turnId,
        terminated: false,
      });
    }
  }

  return asDerivedLiveness({
    status: deriveStatus({ runtime, now, hasAnyTerminalEvent }),
    activeTurnId: runtime.activeTurnId,
    startedAt: runtime.startedAt,
    lastActivityAt: runtime.lastActivityAt,
  });
}

export const __getDeriveTurnLivenessPerfStats = (): DeriveTurnLivenessPerfStats => ({
  ...deriveTurnLivenessPerfStats,
});

export const __resetDeriveTurnLivenessPerfStats = (): void => {
  deriveTurnLivenessPerfStats.fullRebuilds = 0;
  deriveTurnLivenessPerfStats.incrementalUpdates = 0;
  deriveTurnLivenessPerfStats.tailOnlyFolds = 0;
  deriveTurnLivenessPerfStats.fullRefoldsAfterIncrementalInsert = 0;
  deriveTurnLivenessPerfStats.foldedEventCount = 0;
  incrementalProjectionCache = null;
};
