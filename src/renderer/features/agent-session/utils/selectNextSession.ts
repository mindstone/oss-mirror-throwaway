/**
 * selectNextSession.ts
 *
 * Pure utility function for selecting the next session to switch to after marking done.
 * Designed for testability and reusability.
 *
 * Selection logic:
 * 1. Active sessions first (isActive, excluding starred), excluding the done one
 * 2. Prefer "ready" sessions (not busy, has messages) - waiting for user input
 * 3. Sort by most recently updated
 * 4. Fall back to any Active session (even if busy)
 * 5. Then try Favorites (starred) with same logic
 * 6. Return null if nothing found (caller should start fresh)
 */

import type { AgentSessionSidebarEntry } from '../types';
import type { SessionSections } from '../hooks/useSessionHistoryView';

export interface SelectNextSessionOptions {
  /** The ID of the session being marked done (to exclude from candidates) */
  doneSessionId: string;
  /** Session sections from useSessionHistoryView */
  sections: SessionSections;
}

export interface SelectNextSessionResult {
  /** The selected session, or null if none found */
  session: AgentSessionSidebarEntry | null;
  /** Why this session was selected (for debugging/analytics) */
  reason: 'ready-active' | 'busy-active' | 'ready-favorite' | 'busy-favorite' | 'none';
}

/**
 * Check if a session is "ready" - agent finished, waiting for user input.
 * A session is ready if it's not busy AND has at least one message.
 */
const isSessionReady = (entry: AgentSessionSidebarEntry): boolean => {
  return entry.status === 'ready' && entry.messageCount > 0;
};

/**
 * Sort sessions by updatedAt (timestamp field), most recent first.
 */
const sortByMostRecent = (a: AgentSessionSidebarEntry, b: AgentSessionSidebarEntry): number => {
  return b.timestamp - a.timestamp;
};

/**
 * Select the next session to switch to after marking done.
 *
 * Priority order:
 * 1. Ready Active session (most recent)
 * 2. Any Active session (most recent, even if busy)
 * 3. Ready Favorite session (most recent)
 * 4. Any Favorite session (most recent, even if busy)
 * 5. null (no suitable session found)
 */
export function selectNextSession({
  doneSessionId,
  sections,
}: SelectNextSessionOptions): SelectNextSessionResult {
  // Get candidates, excluding the done session
  const activeCandidates = sections.activeSessions
    .filter((s) => s.id !== doneSessionId)
    .sort(sortByMostRecent);

  const favoriteCandidates = sections.starredSessions
    .filter((s) => s.id !== doneSessionId)
    .sort(sortByMostRecent);

  // 1. Try ready Active sessions first
  const readyActive = activeCandidates.find(isSessionReady);
  if (readyActive) {
    return { session: readyActive, reason: 'ready-active' };
  }

  // 2. Fall back to any Active session (even if busy)
  const anyActive = activeCandidates[0];
  if (anyActive) {
    return { session: anyActive, reason: 'busy-active' };
  }

  // 3. Try ready Favorites
  const readyFavorite = favoriteCandidates.find(isSessionReady);
  if (readyFavorite) {
    return { session: readyFavorite, reason: 'ready-favorite' };
  }

  // 4. Fall back to any Favorite
  const anyFavorite = favoriteCandidates[0];
  if (anyFavorite) {
    return { session: anyFavorite, reason: 'busy-favorite' };
  }

  // 5. No suitable session found
  return { session: null, reason: 'none' };
}
