import { createScopedLogger } from '@core/logger';

const logger = createScopedLogger({ service: 'app-bridge.pair-event-bus' });

export type PairEventType = 'paired' | 'code-expired' | 'session-ended';

export interface PairEvent {
  type: PairEventType;
  /**
   * Used by the renderer-driven connector status translator in `appBridgeManager`
   * to disambiguate `session-ended` into user-facing verbs (`cancelled` vs silent step-7 cleanup).
   */
  cause?: 'ttl-expired' | 'user-reset' | 'step7-cleanup' | 'paired';
  pairSessionId: string;
  tokenFingerprint?: string;
  emittedAt: number;
}

type PairEventHandler = (event: PairEvent) => void;

interface PairEventSessionState {
  events: PairEvent[];
  subscribers: Set<PairEventHandler>;
}

const MAX_REPLAY_EVENTS = 5;
// Replay window must outlast the pair-code TTL (10min, see pairingStore.ts)
// so that `paired`, `code-expired`, or `session-ended` events are still
// replayable when the agent re-subscribes in STEP 3's next-turn wait. Without
// this, a delayed user reply could silently miss the real pairing event and
// sit in a pointless wait loop until the active-session TTL expires.
const REPLAY_TTL_MS = 11 * 60_000;

export class PairEventBus {
  private readonly sessions = new Map<string, PairEventSessionState>();

  subscribe(pairSessionId: string, handler: PairEventHandler): () => void {
    const state = this.getOrCreateState(pairSessionId);
    state.subscribers.add(handler);
    state.events = this.pruneEvents(state.events, Date.now());

    return () => {
      const current = this.sessions.get(pairSessionId);
      if (!current) {
        return;
      }
      current.subscribers.delete(handler);
      current.events = this.pruneEvents(current.events, Date.now());
      if (current.events.length === 0 && current.subscribers.size === 0) {
        this.sessions.delete(pairSessionId);
      }
    };
  }

  emit(event: PairEvent): void {
    const state = this.getOrCreateState(event.pairSessionId);
    state.events = this.pruneEvents(state.events, event.emittedAt);
    state.events.push(event);
    if (state.events.length > MAX_REPLAY_EVENTS) {
      state.events.splice(0, state.events.length - MAX_REPLAY_EVENTS);
    }
    this.sessions.set(event.pairSessionId, state);

    const subscribers = [...state.subscribers];
    for (const handler of subscribers) {
      try {
        handler(event);
      } catch (err) {
        logger.error(
          { pairSessionId: event.pairSessionId, eventType: event.type, err },
          'PairEventBus subscriber threw an error',
        );
      }
    }
  }

  getReplay(pairSessionId: string): PairEvent[] {
    const state = this.sessions.get(pairSessionId);
    if (!state) {
      return [];
    }
    state.events = this.pruneEvents(state.events, Date.now());
    if (state.events.length === 0 && state.subscribers.size === 0) {
      this.sessions.delete(pairSessionId);
      return [];
    }
    return [...state.events];
  }

  private getOrCreateState(pairSessionId: string): PairEventSessionState {
    const existing = this.sessions.get(pairSessionId);
    if (existing) {
      return existing;
    }

    const created: PairEventSessionState = {
      events: [],
      subscribers: new Set<PairEventHandler>(),
    };
    this.sessions.set(pairSessionId, created);
    return created;
  }

  private pruneEvents(
    events: PairEvent[],
    now: number,
  ): PairEvent[] {
    return events.filter((event) => now - event.emittedAt <= REPLAY_TTL_MS);
  }
}
