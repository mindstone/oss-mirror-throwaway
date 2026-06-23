import { useEffect, useRef, useState, useCallback } from 'react';
import type { AgentSessionSummary } from '@shared/types';
import { isBackgroundConversationSession } from '@shared/sessionKind';

/**
 * Grace period (ms) before a busy→idle transition triggers an unread marker.
 * Absorbs brief toggles between sequential turns (compaction, approval
 * continuation, system continuation) so the blue dot only appears for
 * genuinely completed responses.
 */
export const UNREAD_RESPONSE_GRACE_MS = 500;

/**
 * Tracks sessions that completed a response while the user wasn't viewing them.
 *
 * Detection: when a session transitions from isBusy=true → isBusy=false
 * and it isn't the currently viewed session, a grace-period timer starts.
 * If the session stays idle past UNREAD_RESPONSE_GRACE_MS, it's marked as
 * having an unread response. If the session becomes busy again (next turn),
 * becomes the current session (user opens it), or disappears from summaries,
 * the timer is cancelled.
 *
 * Clearing: when the user navigates to a session (it becomes currentSessionId),
 * the unread flag is removed.
 *
 * Scope: foreground conversations only (background kinds are excluded by session id).
 * Persistence: in-memory only — cleared on app restart.
 */
export function useUnreadResponses(
 sessionSummaries: AgentSessionSummary[],
 currentSessionId: string,
): { unreadSessionIds: Set<string>; clearUnread: (sessionId: string) => void } {
  const prevBusyRef = useRef<Map<string, boolean>>(new Map());
  const pendingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const summariesRef = useRef(sessionSummaries);
  summariesRef.current = sessionSummaries;
  const currentSessionRef = useRef(currentSessionId);
  currentSessionRef.current = currentSessionId;
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const prevBusy = prevBusyRef.current;
    const pendingTimers = pendingTimersRef.current;

    const currentIds = new Set<string>();
    for (const summary of sessionSummaries) {
      currentIds.add(summary.id);
      if (isBackgroundConversationSession(summary.id)) continue;

      const wasBusy = prevBusy.get(summary.id) ?? false;

      if (wasBusy && !summary.isBusy && summary.id !== currentSessionId) {
        // busy→idle transition detected — schedule grace-period timer
        // Replace any existing timer for this session (prevents duplicates on rapid flapping)
        const existingTimer = pendingTimers.get(summary.id);
        if (existingTimer != null) clearTimeout(existingTimer);

        const sid = summary.id;
        const timer = setTimeout(() => {
          pendingTimers.delete(sid);
          // Re-check latest state via refs to guard against boundary races
          // where the timer fires in the same tick as a cancelling state change
          const latestSummary = summariesRef.current.find(s => s.id === sid);
          if (!latestSummary || latestSummary.isBusy || sid === currentSessionRef.current) return;
          setUnreadIds((prev) => {
            if (prev.has(sid)) return prev;
            const next = new Set(prev);
            next.add(sid);
            return next;
          });
        }, UNREAD_RESPONSE_GRACE_MS);
        pendingTimers.set(summary.id, timer);
      } else if (summary.isBusy) {
        // Session became busy again — cancel pending unread timer
        const busyTimer = pendingTimers.get(summary.id);
        if (busyTimer != null) {
          clearTimeout(busyTimer);
          pendingTimers.delete(summary.id);
        }
      }

      // Cancel timer if session is now the current session
      if (summary.id === currentSessionId) {
        const currentTimer = pendingTimers.get(summary.id);
        if (currentTimer != null) {
          clearTimeout(currentTimer);
          pendingTimers.delete(summary.id);
        }
      }

      prevBusy.set(summary.id, summary.isBusy);
    }

    // Prune entries for sessions that no longer exist
    for (const id of prevBusy.keys()) {
      if (!currentIds.has(id)) {
        prevBusy.delete(id);
        // Cancel any pending timer for removed sessions
        const timer = pendingTimers.get(id);
        if (timer != null) {
          clearTimeout(timer);
          pendingTimers.delete(id);
        }
      }
    }

    // Clear unread for current session (immediate — no grace period needed)
    setUnreadIds((prev) => {
      if (prev.has(currentSessionId)) {
        const next = new Set(prev);
        next.delete(currentSessionId);
        return next;
      }
      return prev;
    });
  }, [sessionSummaries, currentSessionId]);

  // Clean up all pending timers on unmount
  useEffect(() => {
    const timers = pendingTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const clearUnread = useCallback((sessionId: string) => {
    // Also cancel any pending timer when explicitly clearing
    const timer = pendingTimersRef.current.get(sessionId);
    if (timer != null) {
      clearTimeout(timer);
      pendingTimersRef.current.delete(sessionId);
    }
    setUnreadIds((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  return { unreadSessionIds: unreadIds, clearUnread };
}
