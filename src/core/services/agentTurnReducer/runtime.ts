import type { AgentEvent } from '@shared/types';

export type SessionRuntimeState = {
  startedAt: number | null;
  lastActivityAt: number | null;
  activeTurnId: string | null;
  /** True after error/result terminates the turn. Prevents post-terminal events
   *  (status, tool, assistant) from re-priming the runtime as active. */
  terminated: boolean;
};

export const createRuntimeState = (
  overrides?: Partial<SessionRuntimeState>
): SessionRuntimeState => ({
  startedAt: null,
  lastActivityAt: null,
  activeTurnId: null,
  terminated: false,
  ...overrides
});

export const cloneRuntimeState = (
  runtime?: SessionRuntimeState | null
): SessionRuntimeState => (runtime ? { ...runtime } : createRuntimeState());

export const applyEventToRuntime = (
  runtime: SessionRuntimeState,
  turnId: string,
  event: AgentEvent
): SessionRuntimeState => {
  if (event.type === 'result' || event.type === 'error') {
    // Only clear active turn state if this terminal event is for the currently
    // active turn (or no turn is active). A late result/error from a previous
    // turn (e.g., deny-and-retry AskUserQuestion) must NOT reset state set by
    // a newer turn's turn_started event.
    if (runtime.activeTurnId === turnId || runtime.activeTurnId === null) {
      return {
        startedAt: null,
        lastActivityAt: event.timestamp,
        activeTurnId: null,
        terminated: true
      };
    }
    // Late terminal event from a different turn — only update timestamp
    return {
      ...runtime,
      lastActivityAt: event.timestamp,
    };
  }

  // turn_started unconditionally primes the runtime for the new turn lifecycle.
  // It bypasses both the terminated guard (which is session-scoped, not turn-scoped —
  // a prior turn's result/error sets terminated=true but that must not block a
  // legitimate new turn) and the cross-turn guard (after turn_superseded, the old
  // activeTurnId persists and would reject the new turn's events).
  // Safety: turn_started is only emitted synchronously at the start of executeAgentTurn(),
  // so it's always the first event for a turn and cannot be a late/stale event.
  if (event.type === 'turn_started') {
    return {
      startedAt: event.timestamp,
      lastActivityAt: event.timestamp,
      activeTurnId: turnId,
      terminated: false,
    };
  }

  if (event.type === 'assistant' || event.type === 'status' || event.type === 'tool') {
    // Post-terminal guard: if this turn already terminated (error/result processed),
    // do NOT re-prime the runtime as active. Only update lastActivityAt.
    if (runtime.terminated) {
      return {
        ...runtime,
        lastActivityAt: event.timestamp
      };
    }

    // Guard against late events from a different turn overwriting the current active turn.
    // This prevents timer corruption when events arrive out-of-order.
    if (runtime.activeTurnId !== null && runtime.activeTurnId !== turnId) {
      return {
        ...runtime,
        lastActivityAt: event.timestamp
      };
    }

    const startedAt = runtime.startedAt ?? event.timestamp;
    return {
      startedAt,
      lastActivityAt: event.timestamp,
      activeTurnId: turnId,
      terminated: false
    };
  }

  return {
    ...runtime,
    lastActivityAt: event.timestamp
  };
};

export const primeRuntimeForTurn = (
  turnId: string,
  startedAt: number
): SessionRuntimeState =>
  createRuntimeState({
    startedAt,
    lastActivityAt: startedAt,
    activeTurnId: turnId,
    terminated: false
  });

/**
 * Threshold for considering an active turn "stale" (5 minutes).
 * Active turns receive events every few seconds; if the last event
 * is older than this, the turn was almost certainly interrupted
 * (app crash, force-quit) and the main process is no longer running it.
 */
export const STALE_TURN_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Check whether a runtime's active turn is stale (interrupted and no longer running).
 * Returns true if the runtime indicates an active turn but the last activity
 * is older than STALE_TURN_THRESHOLD_MS relative to `now`.
 */
export const isTurnStale = (
  runtime: SessionRuntimeState,
  now: number = Date.now()
): boolean => {
  if (runtime.startedAt === null) return false;
  const lastActivity = runtime.lastActivityAt ?? runtime.startedAt;
  return (now - lastActivity) > STALE_TURN_THRESHOLD_MS;
};
