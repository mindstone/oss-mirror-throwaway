import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionStore } from '@renderer/features/agent-session/store/sessionStore';
import {
  deregisterPersonalisationSession,
  lookupPersonalisationOperatorId,
  registerPersonalisationSession,
  subscribePersonalisationSessionRegistry,
} from '@renderer/features/operators/state/personalisationSessionRegistry';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface PersonalisationEntry {
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
}

export interface PersonalisationLifecycle {
  isPersonalising(operatorId: string): boolean;
  markStarted(input: { operatorId: string; sessionId: string }): void;
  markEnded(operatorId: string): void;
}

export function usePersonalisationLifecycle(now: () => number = Date.now): PersonalisationLifecycle {
  const [activeByOperatorId, setActiveByOperatorId] = useState<Record<string, PersonalisationEntry>>({});
  const idleTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTrackedActivityRef = useRef<Map<string, number>>(new Map());

  const removeOperator = useCallback((operatorId: string) => {
    const timer = idleTimersRef.current.get(operatorId);
    if (timer) {
      clearTimeout(timer);
      idleTimersRef.current.delete(operatorId);
    }
    lastTrackedActivityRef.current.delete(operatorId);
    setActiveByOperatorId((current) => {
      if (!(operatorId in current)) return current;
      const next = { ...current };
      delete next[operatorId];
      return next;
    });
  }, []);

  const scheduleIdleClear = useCallback((operatorId: string) => {
    const existing = idleTimersRef.current.get(operatorId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      removeOperator(operatorId);
    }, IDLE_TIMEOUT_MS);
    idleTimersRef.current.set(operatorId, timer);
  }, [removeOperator]);

  const markStarted = useCallback(({ operatorId, sessionId }: { operatorId: string; sessionId: string }) => {
    const startedAt = now();
    setActiveByOperatorId((current) => ({
      ...current,
      [operatorId]: { sessionId, startedAt, lastActivityAt: startedAt },
    }));
    lastTrackedActivityRef.current.set(operatorId, startedAt);
    registerPersonalisationSession({ sessionId, operatorId });
  }, [now]);

  const markEnded = useCallback((operatorId: string) => {
    const entry = activeByOperatorId[operatorId];
    if (entry) deregisterPersonalisationSession(entry.sessionId);
    removeOperator(operatorId);
  }, [activeByOperatorId, removeOperator]);

  // Derived membership: hydrate from sessionSummaries + registry so the badge
  // survives panel unmount/remount. We track this in component state so React
  // re-renders when the underlying session-summary set changes (sessions
  // resolved / soft-deleted / created).
  const [derivedActiveOperatorIds, setDerivedActiveOperatorIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const compute = () => {
      const next = new Set<string>();
      const state = useSessionStore.getState() as unknown as {
        sessionSummaries: ReadonlyArray<{ id: string; origin?: string; resolvedAt: number | null; deletedAt: number | null }>;
      };
      for (const summary of state.sessionSummaries) {
        if (summary.origin !== 'operator-personalisation') continue;
        if (summary.resolvedAt !== null || summary.deletedAt !== null) continue;
        const operatorId = lookupPersonalisationOperatorId(summary.id);
        if (operatorId) next.add(operatorId);
      }
      setDerivedActiveOperatorIds((prev) => {
        if (prev.size === next.size) {
          let same = true;
          for (const id of next) {
            if (!prev.has(id)) { same = false; break; }
          }
          if (same) return prev;
        }
        return next;
      });
    };

    compute();
    const unsubscribeStore = useSessionStore.subscribe(compute);
    const unsubscribeRegistry = subscribePersonalisationSessionRegistry(compute);
    return () => {
      unsubscribeStore();
      unsubscribeRegistry();
    };
  }, []);

  const isPersonalising = useCallback((operatorId: string): boolean => {
    if (activeByOperatorId[operatorId]) return true;
    return derivedActiveOperatorIds.has(operatorId);
  }, [activeByOperatorId, derivedActiveOperatorIds]);

  // Keep idle timers in step with the tracked entries; only re-schedule when
  // the matching session's `updatedAt` actually advances. This prevents
  // unrelated store mutations (other sessions changing, summaries replaced
  // wholesale, ephemeral UI state) from extending the idle window.
  useEffect(() => {
    const operatorIds = Object.keys(activeByOperatorId);
    if (operatorIds.length === 0) {
      for (const timer of idleTimersRef.current.values()) {
        clearTimeout(timer);
      }
      idleTimersRef.current.clear();
      lastTrackedActivityRef.current.clear();
      return;
    }

    const reconcile = (state: { sessionSummaries: ReadonlyArray<{ id: string; resolvedAt: number | null; deletedAt: number | null; updatedAt: number }> }) => {
      const knownSessionIds = new Set(state.sessionSummaries.map((summary) => summary.id));
      setActiveByOperatorId((current) => {
        let changed = false;
        const next: Record<string, PersonalisationEntry> = {};
        for (const [operatorId, entry] of Object.entries(current)) {
          const summary = state.sessionSummaries.find((candidate) => candidate.id === entry.sessionId);
          const stillActive = knownSessionIds.has(entry.sessionId)
            && summary !== undefined
            && summary.resolvedAt === null
            && summary.deletedAt === null;
          if (stillActive) {
            const incomingActivity = summary?.updatedAt ?? entry.lastActivityAt;
            const lastTracked = lastTrackedActivityRef.current.get(operatorId);
            if (incomingActivity !== entry.lastActivityAt) {
              next[operatorId] = { ...entry, lastActivityAt: incomingActivity };
              changed = true;
            } else {
              next[operatorId] = entry;
            }
            if (lastTracked === undefined || incomingActivity > lastTracked) {
              lastTrackedActivityRef.current.set(operatorId, incomingActivity);
              scheduleIdleClear(operatorId);
            } else if (!idleTimersRef.current.has(operatorId)) {
              scheduleIdleClear(operatorId);
            }
          } else {
            const timer = idleTimersRef.current.get(operatorId);
            if (timer) {
              clearTimeout(timer);
              idleTimersRef.current.delete(operatorId);
            }
            lastTrackedActivityRef.current.delete(operatorId);
            changed = true;
          }
        }
        return changed ? next : current;
      });
    };

    for (const operatorId of operatorIds) {
      if (!idleTimersRef.current.has(operatorId)) {
        scheduleIdleClear(operatorId);
      }
    }

    const unsubscribe = useSessionStore.subscribe((state) => {
      reconcile(state as unknown as { sessionSummaries: ReadonlyArray<{ id: string; resolvedAt: number | null; deletedAt: number | null; updatedAt: number }> });
    });

    return unsubscribe;
  }, [activeByOperatorId, scheduleIdleClear]);

  useEffect(() => {
    const idleTimers = idleTimersRef.current;
    const lastActivity = lastTrackedActivityRef.current;
    return () => {
      for (const timer of idleTimers.values()) {
        clearTimeout(timer);
      }
      idleTimers.clear();
      lastActivity.clear();
    };
  }, []);

  return {
    isPersonalising,
    markStarted,
    markEnded,
  };
}
