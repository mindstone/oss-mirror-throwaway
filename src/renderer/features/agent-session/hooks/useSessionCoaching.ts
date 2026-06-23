/**
 * Session Coaching Hook
 *
 * Listens for coaching reflections from the main process and provides
 * coaching data for the current session.
 */

import { useEffect, useState } from 'react';
import type { SessionCoachingEvaluation } from '@shared/types';
import { useSessionStore } from '../store/sessionStore';

type CoachingListener = (sessionId: string, evaluation: SessionCoachingEvaluation) => void;

// Module-level state for cross-component sharing
const coachingBySession: Map<string, SessionCoachingEvaluation> = new Map();
const listeners: Set<CoachingListener> = new Set();
let ipcListenerInitialized = false;

/** Cap to prevent unbounded growth in long-running sessions. Oldest entries evicted first. */
const MAX_COACHING_CACHE = 50;

/** Evict oldest entries when cache exceeds cap. Map iterates in insertion order. */
const pruneCoachingCache = (): void => {
  if (coachingBySession.size <= MAX_COACHING_CACHE) return;
  const toDelete = coachingBySession.size - MAX_COACHING_CACHE;
  let deleted = 0;
  for (const key of coachingBySession.keys()) {
    if (deleted >= toDelete) break;
    coachingBySession.delete(key);
    deleted++;
  }
};

const notifyListeners = (sessionId: string, evaluation: SessionCoachingEvaluation): void => {
  listeners.forEach(listener => listener(sessionId, evaluation));
};

const initializeIpcListener = (): void => {
  if (ipcListenerInitialized) return;
  ipcListenerInitialized = true;

  window.api.onCoachingReflection(({ sessionId, evaluation }) => {
    coachingBySession.set(sessionId, evaluation);
    pruneCoachingCache();
    notifyListeners(sessionId, evaluation);
  });
};

/**
 * Hook to get coaching data for a specific session.
 * Automatically updates when new coaching arrives.
 */
export const useSessionCoaching = (sessionId: string | null): SessionCoachingEvaluation | null => {
  const [coaching, setCoaching] = useState<SessionCoachingEvaluation | null>(null);

  useEffect(() => {
    // Initialize global IPC listener
    initializeIpcListener();

    // Subscribe to updates
    const listener: CoachingListener = (id, evaluation) => {
      if (id === sessionId) {
        setCoaching(evaluation);
      }
    };
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }, [sessionId]);

  // Fetch coaching when session changes
  useEffect(() => {
    let cancelled = false;

    if (!sessionId) {
      setCoaching(null);
      return;
    }

    // Check cache first
    const cached = coachingBySession.get(sessionId);
    if (cached) {
      setCoaching(cached);
      return;
    }

    // Fetch from main process
    window.api.getCoachingForSession(sessionId)
      .then(({ evaluation }) => {
        if (cancelled) return;
        if (evaluation) {
          const typed = evaluation as SessionCoachingEvaluation;
          coachingBySession.set(sessionId, typed);
          pruneCoachingCache();
          setCoaching(typed);
        } else {
          setCoaching(null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to fetch coaching for session:', err);
        setCoaching(null);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return coaching;
};

/**
 * Hook to get coaching data for the current session from the store.
 */
export const useCurrentSessionCoaching = (): SessionCoachingEvaluation | null => {
  const currentSessionId = useSessionStore(state => state.currentSessionId);
  return useSessionCoaching(currentSessionId);
};

/**
 * Update coaching state - persists to main process and updates local cache.
 * Triggers sidebar refresh via the coaching reflection event.
 */
export const updateCoachingState = async (
  sessionId: string,
  state: SessionCoachingEvaluation['state'],
  dismissalReason?: SessionCoachingEvaluation['dismissalReason']
): Promise<void> => {
  // Update local cache immediately for instant UI feedback
  const evaluation = coachingBySession.get(sessionId);
  if (evaluation) {
    const updated: SessionCoachingEvaluation = {
      ...evaluation,
      state,
      ...(dismissalReason && { dismissalReason })
    };
    coachingBySession.set(sessionId, updated);
    pruneCoachingCache();
    notifyListeners(sessionId, updated);
  }

  // Persist to main process
  try {
    await window.api.updateCoachingState(sessionId, state, dismissalReason);
  } catch (error) {
    console.error('Failed to persist coaching state:', error);
  }
};

/** Dev:perf diagnostic — number of cached coaching evaluations. */
export const getCoachingCacheSize = (): number => coachingBySession.size;
