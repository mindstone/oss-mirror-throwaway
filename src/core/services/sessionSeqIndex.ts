import type { AgentEvent, AgentSession } from '@shared/types';
import { isValidSeq } from '@shared/utils/eventIdentity';

export function getMaxSeqFromSession(session: Pick<AgentSession, 'eventsByTurn' | 'maxSeq'>): number {
  let maxSeq = isValidSeq(session.maxSeq) ? session.maxSeq : 0;
  const eventsByTurn = session.eventsByTurn ?? {};

  for (const events of Object.values(eventsByTurn)) {
    for (const event of events) {
      if (isValidSeq(event.seq) && event.seq > maxSeq) {
        maxSeq = event.seq;
      }
    }
  }

  return maxSeq;
}

class SessionSeqIndex {
  private readonly maxSeqBySession = new Map<string, number>();

  getCurrentSeq(sessionId: string): number {
    return this.maxSeqBySession.get(sessionId) ?? 0;
  }

  setSeqFromStorage(sessionId: string, persistedMaxSeq: number | null | undefined): void {
    if (!isValidSeq(persistedMaxSeq)) return;
    const current = this.getCurrentSeq(sessionId);
    if (persistedMaxSeq > current) {
      this.maxSeqBySession.set(sessionId, persistedMaxSeq);
    }
  }

  nextSeq(sessionId: string): number {
    const next = this.getCurrentSeq(sessionId) + 1;
    this.maxSeqBySession.set(sessionId, next);
    return next;
  }

  hydrateFromSessions(sessions: AgentSession[]): void {
    for (const session of sessions) {
      this.setSeqFromStorage(session.id, getMaxSeqFromSession(session));
    }
  }

  deleteSession(sessionId: string): void {
    this.maxSeqBySession.delete(sessionId);
  }

  resetForTests(): void {
    this.maxSeqBySession.clear();
  }
}

const sessionSeqIndexSingleton = new SessionSeqIndex();

type MissingSeqEventRef = {
  turnId: string;
  eventIndex: number;
  timestamp: number;
};

export function getSessionSeqIndex(): SessionSeqIndex {
  return sessionSeqIndexSingleton;
}

export function stampEventSeq(sessionId: string, event: AgentEvent): AgentEvent & { seq: number } {
  const seq = sessionSeqIndexSingleton.nextSeq(sessionId);
  return {
    ...event,
    seq,
  };
}

/**
 * Stamps missing event.seq values in deterministic order and updates session.maxSeq.
 * Existing seq values are preserved.
 */
export function stampMissingEventSeq(session: AgentSession): AgentSession {
  const existingMaxSeq = getMaxSeqFromSession(session);
  sessionSeqIndexSingleton.setSeqFromStorage(session.id, existingMaxSeq);

  const missing: MissingSeqEventRef[] = [];
  for (const [turnId, events] of Object.entries(session.eventsByTurn ?? {})) {
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex];
      if (!isValidSeq(event.seq)) {
        missing.push({
          turnId,
          eventIndex,
          timestamp: typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
            ? event.timestamp
            : Number.MAX_SAFE_INTEGER,
        });
      }
    }
  }

  if (missing.length === 0) {
    const maxSeq = Math.max(existingMaxSeq, sessionSeqIndexSingleton.getCurrentSeq(session.id));
    if (maxSeq <= 0 || session.maxSeq === maxSeq) {
      return session;
    }
    return {
      ...session,
      maxSeq,
    };
  }

  missing.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.turnId !== b.turnId) return a.turnId.localeCompare(b.turnId);
    return a.eventIndex - b.eventIndex;
  });

  const nextEventsByTurn: Record<string, AgentEvent[]> = { ...(session.eventsByTurn ?? {}) };
  const clonedTurns = new Set<string>();
  for (const ref of missing) {
    if (!clonedTurns.has(ref.turnId)) {
      nextEventsByTurn[ref.turnId] = [...(nextEventsByTurn[ref.turnId] ?? [])];
      clonedTurns.add(ref.turnId);
    }
    const turnEvents = nextEventsByTurn[ref.turnId];
    const existingEvent = turnEvents?.[ref.eventIndex];
    if (!existingEvent) continue;
    if (isValidSeq(existingEvent.seq)) continue;
    turnEvents[ref.eventIndex] = {
      ...existingEvent,
      seq: sessionSeqIndexSingleton.nextSeq(session.id),
    };
  }

  const maxSeq = Math.max(
    getMaxSeqFromSession({ ...session, eventsByTurn: nextEventsByTurn }),
    sessionSeqIndexSingleton.getCurrentSeq(session.id),
  );
  return {
    ...session,
    eventsByTurn: nextEventsByTurn,
    maxSeq: maxSeq > 0 ? maxSeq : undefined,
  };
}

export function resetSessionSeqIndexForTests(): void {
  sessionSeqIndexSingleton.resetForTests();
}
