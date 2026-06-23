/**
 * Module-level "current session" event storage + version-counter subsystem for
 * the renderer session store.
 *
 * Extracted from `sessionStore.ts` (behavior-preserving Stage 5). The
 * `currentSessionEvents` Map lives outside Zustand for O(1) in-place append
 * (Zustand holds only an `eventsByTurnVersion` change-notification counter). The
 * synchronous version counter + microtask-coalesced notifier + perf counters +
 * `bumpVersion` stay CO-LOCATED here (they are co-mutated and order-sensitive).
 * All append/remove/get/set accessors live here behind the canonical API.
 *
 * `sessionStore.ts` imports `bumpVersion`, `registerEventsVersionNotifier`, and
 * `flushPendingEventsVersionNotification` for its action closure, re-exports the
 * externally-consumed accessors so the canonical `.../store/sessionStore` import
 * path keeps resolving, and reads the Map for leak diagnostics via the
 * encapsulated `getCurrentSessionEventsMapForDiagnostics` accessor.
 *
 * @see ./sessionStore.ts — the store implementation that drives this subsystem
 * @see ./validationTelemetry.ts — shouldDropForeignIngressEvent cross-session guard
 * @see docs/plans/260622_refactor-session-store/PLAN.md — extraction plan
 */
import type { AgentEvent } from "@shared/types";
import {
  deriveTurnLiveness,
  type DerivedLiveness,
} from "@core/services/conversationState";
import {
  createRendererLocalTerminalEvent,
  createRendererOptimisticTurnStartedEvent,
  isRendererOptimisticTurnStartedEvent,
  stripRendererOnlyEventsByTurnForEgress,
} from "./rendererLocalEventEgress";
import type { ValidatedSessionWriteScope } from "@shared/utils/eventSessionValidation";
import type {
  EventsVersionCounters,
  EventIngressProvenance,
  CurrentSessionProjectedLivenessCache,
} from "./sessionStoreTypes";
import { shouldDropForeignIngressEvent } from "./validationTelemetry";
import { ignoreBestEffortCleanup } from "@shared/utils/intentionalSwallow";

// ---------------------------------------------------------------------------
// Current session event storage — external to Zustand
// (PERF: eliminates per-event object spread + array spread in Zustand state)
//
// Previously, every agent event created { ...state.eventsByTurn, [turnId]: [...events, event] }
// inside Zustand's set(). Each intermediate state object was retained by React closures and
// subscribeWithSelector, causing 4+ GB memory bloat with long conversations.
//
// Now: events live in this module-level Map. Zustand holds only an `eventsByTurnVersion`
// counter for change notification. Arrays are mutated in place via push() for O(1) append
// (instead of O(n) copy-on-write). Change detection uses eventsByTurnVersion; useTurnData
// clones per deferred batch for downstream memo invalidation.
//
// Invariants:
// - appendEventToCurrentSession pushes in place → O(1) per event
// - setCurrentSessionEvents clones arrays on import → prevents shared mutation with source
// - getCurrentSessionEvents() / getCurrentSessionEventsForTurn() return shared references
//   (read-only contract — callers must NOT push into returned arrays)
// - useTurnData.turnEvents produces a new array reference per deferred version bump
//
// The `eventsByTurn` field in Zustand state (from ConversationStateShape) is always `{}`.
// Use getCurrentSessionEvents() / getCurrentSessionEventsForTurn() to read events.
//
// Stage 5 (260508 active-work rebuild) — synchronous counter / microtask-coalesced
// notification split:
// - `currentSessionEventsVersion` is the canonical synchronous counter. `bumpVersion()`
//   increments it and schedules a single microtask that fans the latest value out to
//   Zustand subscribers via `useSessionStore.setState({ eventsByTurnVersion })`. Tool
//   flurries (5–20 synchronous bumps per tick) collapse to one Zustand notification.
// - `getCurrentSessionEventsVersion()` exposes the synchronous counter for
//   `useSyncExternalStore(subscribe, getCurrentSessionEventsVersion)` callers that need
//   tearing-free per-event reads. The `subscribe` callback may register against the
//   Zustand notification (which lags by ≤1 microtask); `getSnapshot` reads the counter
//   directly so consumers see every increment.
// - `flushPendingEventsVersionNotification()` synchronously drains a pending bump. It
//   is wired at boundary points (terminal turn events, queue drain, session switch,
//   reset, history-open, persistence read, beforeunload) so persistence, history loads,
//   and quit-time saves observe the correct trailing version.
// - `useDeferredValue(eventsByTurnVersion)` consumers (see
//   `useAgentSessionEngine.ts:371`) read the Zustand-stored coalesced value
//   intentionally — the double-deferral (microtask + React deferred) is acceptable for
//   UI consumers that already opted into stale-while-pending semantics. Consumers
//   needing synchronous correctness must use `useSyncExternalStore` with the counter
//   getter above.
// ---------------------------------------------------------------------------
const currentSessionEvents = new Map<string, AgentEvent[]>();
let currentSessionEventsVersion = 0;
let pendingEventsVersionNotification = false;
let scheduledEventsVersionMicrotask = false;

// Registry of per-store setState shims that must be notified when the
// coalesced `eventsByTurnVersion` microtask fires. The production path uses a
// single `useSessionStore` singleton; unit-test files create independent
// stores via `createSessionStore()`, and each one registers its own shim
// here so that tests observe the same trailing-edge semantics as production.
const eventsVersionNotifiers = new Set<(version: number) => void>();

export const registerEventsVersionNotifier = (
  notifier: (version: number) => void,
): (() => void) => {
  eventsVersionNotifiers.add(notifier);
  return () => {
    eventsVersionNotifiers.delete(notifier);
  };
};

// Phase 6 remediation (260508 Stage 5): perf counter state declared BEFORE
// `notifyEventsVersionSubscribers` and `bumpVersion` so the callsites pass
// `no-use-before-define`. `perfCountersEnabled` defaults to whatever the
// build-time env declares; tests opt in via `setEventsVersionPerfCountersEnabled`.
let perfCountersEnabled: boolean = (() => {
  try {
    if (
      typeof process !== "undefined" &&
      (process as { env?: Record<string, string | undefined> }).env
        ?.REBEL_PERF_MODE === "1"
    ) {
      return true;
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: "currentSessionEvents.perfCountersEnabled.processEnv",
      reason: "process may be undefined in pure browser contexts",
    });
  }
  try {
    const meta = import.meta as unknown as {
      env?: Record<string, string | undefined>;
    };
    if (meta?.env?.VITE_PERFORMANCE === "true") return true;
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: "currentSessionEvents.perfCountersEnabled.importMetaEnv",
      reason: "import.meta.env may be unavailable in this context",
    });
  }
  return false;
})();

let perfVersionBumps = 0;
let perfScheduledNotifications = 0;
let perfActualNotifications = 0;

/**
 * Phase 6 remediation (260508 Stage 5): expose the eventsByTurnVersion
 * coalescing counters for ongoing observability. Counters increment only
 * when `perfCountersEnabled` is true (driven by `REBEL_PERF_MODE=1` or
 * `VITE_PERFORMANCE=true` at module load, or `setEventsVersionPerfCountersEnabled`
 * for tests). `coalescingRatio = scheduledNotifications / max(versionBumps, 1)`
 * — a value of 1.0 means every bump scheduled its own microtask (no
 * coalescing); a value approaching 0 means many bumps collapsed into a
 * single Zustand notification.
 *
 * @internal Re-exported from `./sessionStore` and consumed only by the
 * coalescing test (sessionStore.eventsVersionCoalescing.test.ts) — the perf
 * counters are introspection seams, not a production API. Tagged so knip's
 * production leg does not flag them as tested-only exports; the default leg
 * still tracks them (statically imported by the test). Was masked by
 * `ignoreExportsUsedInFile` while colocated in sessionStore.ts pre-Stage-5.
 */
export const getEventsVersionCounters = (): EventsVersionCounters => ({
  versionBumps: perfVersionBumps,
  scheduledNotifications: perfScheduledNotifications,
  actualNotifications: perfActualNotifications,
  coalescingRatio:
    perfScheduledNotifications / Math.max(perfVersionBumps, 1),
});

/** @internal Test-only counter reset; see {@link getEventsVersionCounters}. */
export const resetEventsVersionCounters = (): void => {
  perfVersionBumps = 0;
  perfScheduledNotifications = 0;
  perfActualNotifications = 0;
};

/** @internal Test-only perf-counter toggle; see {@link getEventsVersionCounters}. */
export const setEventsVersionPerfCountersEnabled = (enabled: boolean): void => {
  perfCountersEnabled = enabled;
};

const notifyEventsVersionSubscribers = (): void => {
  const v = currentSessionEventsVersion;
  if (perfCountersEnabled) perfActualNotifications += 1;
  for (const fn of eventsVersionNotifiers) {
    fn(v);
  }
};

export const bumpVersion = (): void => {
  currentSessionEventsVersion += 1;
  if (perfCountersEnabled) perfVersionBumps += 1;
  pendingEventsVersionNotification = true;
  if (!scheduledEventsVersionMicrotask) {
    scheduledEventsVersionMicrotask = true;
    if (perfCountersEnabled) perfScheduledNotifications += 1;
    queueMicrotask(() => {
      scheduledEventsVersionMicrotask = false;
      if (pendingEventsVersionNotification) {
        pendingEventsVersionNotification = false;
        notifyEventsVersionSubscribers();
      }
    });
  }
};

/**
 * Synchronously drain any pending `eventsByTurnVersion` Zustand notification.
 * Boundary points (terminal turn events, queue drain, session switch, reset,
 * history-open, persistence read, beforeunload) call this before reading
 * persistable state so subscribers (persistence, history) observe the
 * trailing-edge counter value rather than waiting for the next microtask.
 */
export const flushPendingEventsVersionNotification = (): void => {
  if (pendingEventsVersionNotification) {
    pendingEventsVersionNotification = false;
    notifyEventsVersionSubscribers();
  }
};

export const appendEventToCurrentSession = (
  turnId: string,
  event: AgentEvent,
  provenance?: EventIngressProvenance,
): void => {
  // Stage 19a: fail-closed cross-session guard at the W3 module-level Map
  // ingress. Only enforced when the caller supplies provenance; the legacy
  // 2-arg signature is preserved for tests and version-coalescing callers.
  if (provenance && shouldDropForeignIngressEvent(turnId, event, provenance)) {
    return;
  }
  const existing = currentSessionEvents.get(turnId);
  if (existing) {
    existing.push(event);
  } else {
    currentSessionEvents.set(turnId, [event]);
  }
  bumpVersion();
};

export const appendRendererOptimisticTurnStartedEvent = (
  turnId: string,
  timestamp: number = Date.now(),
): void => {
  appendEventToCurrentSession(
    turnId,
    createRendererOptimisticTurnStartedEvent(timestamp),
  );
};

export const appendRendererLocalTerminalEvent = (
  turnId: string,
  timestamp: number = Date.now(),
  errorMessage: string = 'Turn interrupted locally',
): void => {
  appendEventToCurrentSession(
    turnId,
    createRendererLocalTerminalEvent(timestamp, errorMessage),
  );
};

export const removeRendererOptimisticTurnStartedEvent = (
  turnId: string,
): boolean => {
  const existing = currentSessionEvents.get(turnId);
  if (!existing || existing.length === 0) {
    return false;
  }
  const filtered = existing.filter(
    (event) => !isRendererOptimisticTurnStartedEvent(event),
  );
  if (filtered.length === existing.length) {
    return false;
  }
  if (filtered.length === 0) {
    currentSessionEvents.delete(turnId);
  } else {
    currentSessionEvents.set(turnId, filtered);
  }
  bumpVersion();
  return true;
};

export const removeAllRendererOptimisticTurnStartedEvents = (): boolean => {
  let removedAny = false;
  for (const [turnId, events] of currentSessionEvents.entries()) {
    const filtered = events.filter(
      (event) => !isRendererOptimisticTurnStartedEvent(event),
    );
    if (filtered.length === events.length) {
      continue;
    }
    removedAny = true;
    if (filtered.length === 0) {
      currentSessionEvents.delete(turnId);
    } else {
      currentSessionEvents.set(turnId, filtered);
    }
  }
  if (removedAny) {
    bumpVersion();
  }
  return removedAny;
};

export const getCurrentSessionEvents = (): Record<string, AgentEvent[]> => {
  return Object.fromEntries(currentSessionEvents);
};

export const getCurrentSessionEventsForTurn = (
  turnId: string,
): AgentEvent[] => {
  return currentSessionEvents.get(turnId) ?? [];
};

export const getCurrentSessionEventsVersion = (): number => {
  return currentSessionEventsVersion;
};

export const subscribeToCurrentSessionEventsVersion = (
  onStoreChange: () => void,
): (() => void) => registerEventsVersionNotifier(() => {
  onStoreChange();
});

export const getCurrentSessionEventsForEgress = (): Record<string, AgentEvent[]> =>
  stripRendererOnlyEventsByTurnForEgress(getCurrentSessionEvents());

// `deriveTurnLiveness` depends on wall-clock staleness, so this cache must
// periodically re-evaluate even when no new event arrives.
const CURRENT_SESSION_LIVENESS_CACHE_BUCKET_MS = 5_000;

let currentSessionProjectedLivenessCache: CurrentSessionProjectedLivenessCache | null = null;

export const getCurrentSessionProjectedLiveness = (
  declaredActiveTurnId: string | null,
): DerivedLiveness => {
  const normalizedDeclaredTurnId = declaredActiveTurnId ?? null;
  const version = getCurrentSessionEventsVersion();
  const now = Date.now();
  const timeBucket = Math.floor(now / CURRENT_SESSION_LIVENESS_CACHE_BUCKET_MS);
  const cached = currentSessionProjectedLivenessCache;
  if (
    cached &&
    cached.version === version &&
    cached.declaredActiveTurnId === normalizedDeclaredTurnId &&
    cached.timeBucket === timeBucket
  ) {
    return cached.liveness;
  }
  const projected = deriveTurnLiveness(getCurrentSessionEvents(), now, {
    declaredActiveTurnId: normalizedDeclaredTurnId,
  });
  currentSessionProjectedLivenessCache = {
    version,
    declaredActiveTurnId: normalizedDeclaredTurnId,
    timeBucket,
    liveness: projected,
  };
  return projected;
};

export const setCurrentSessionEvents = (
  events: Record<string, AgentEvent[]>,
  /**
   * Stage 19b: validated bulk-import scope. The branded `scope` is the
   * unforgeable proof the caller ran the cross-session validator (minted only
   * by `beginValidatedSessionWrite`). Omitting it is the explicit, opt-in
   * UNVALIDATED path — used only for same-session resync (e.g.
   * version-coalescing edit, where the events are already the current
   * session's own). Supplying a plain `{ currentSessionId, source }` object is
   * a COMPILE error (the brand cannot be forged). ACCURATE scope: because
   * `scope` is OPTIONAL, this does not force a NEW cross-session ingress caller
   * to validate — that universal guarantee is the deferred `*LocalUnchecked`
   * named-API split (see eventSessionValidation.ts brand JSDoc).
   */
  scope?: ValidatedSessionWriteScope,
): void => {
  currentSessionEvents.clear();
  for (const [turnId, turnEvents] of Object.entries(events)) {
    let toImport = turnEvents;
    if (scope) {
      // Stage 19a: per-event cross-session guard for the bulk-import callers
      // (session-switch / cache-hit merge / history hydration / ingest).
      // Drop any event whose own provenance sessionId is foreign to the
      // target; legacy (no-sessionId) events pass. Provenance for these
      // callers lives ON the event, so we let the validator read it.
      toImport = turnEvents.filter(
        (event) => !shouldDropForeignIngressEvent(turnId, event, { scope }),
      );
    }
    // Clone to prevent push-in-place from mutating the source session's arrays
    currentSessionEvents.set(turnId, [...toImport]);
  }
  bumpVersion();
};

export const clearCurrentSessionEvents = (): void => {
  currentSessionEvents.clear();
  bumpVersion();
};

export const removeCurrentSessionEventTurn = (turnId: string): void => {
  currentSessionEvents.delete(turnId);
  bumpVersion();
};

export const initCurrentSessionEventTurn = (turnId: string): void => {
  if (!currentSessionEvents.has(turnId)) {
    currentSessionEvents.set(turnId, []);
    bumpVersion();
  }
};

export const hasCurrentSessionEvents = (): boolean => {
  return currentSessionEvents.size > 0;
};

/**
 * Read-only view of the currentSessionEvents Map for diagnostics. Callers must
 * treat the returned Map (and its arrays) as read-only; it is the live Map so
 * the leak diagnostics observe accurate counts/bytes without a copy.
 */
export const getCurrentSessionEventsMapForDiagnostics = (): ReadonlyMap<
  string,
  AgentEvent[]
> => currentSessionEvents;
