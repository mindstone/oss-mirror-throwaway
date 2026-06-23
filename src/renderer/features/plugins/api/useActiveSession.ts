/**
 * useActiveSession Hook
 *
 * Returns a reactive snapshot of the session the user is currently viewing,
 * or `null` when:
 *   - The user is not viewing a conversation (`showConversation === false`)
 *   - The current session is private (`privateMode === true`)
 *   - No current session exists
 *
 * Uses `useSyncExternalStore` for consistent snapshot semantics,
 * matching the pattern in `useConversations`.
 *
 * @see docs/plans/260408_plugin_conversation_api_expansion.md (D1, FM5, FM6, FM13)
 */

import { useSyncExternalStore } from 'react';
import { getSessionStoreState, subscribeToSessionStore } from '@renderer/features/agent-session/store/sessionStore';
import { mapSummaryToConversation } from './conversationMapper';
import type { ActiveSession } from './types';

let cachedActiveSession: ActiveSession | null = null;
let cachedSnapshotKey: string | null = null;

function getActiveSessionSnapshot(): ActiveSession | null {
  const state = getSessionStoreState();

  // Build a snapshot key from the values that affect our output.
  // This ensures referential stability when nothing has changed.
  const { currentSessionId, showConversation, sessionSummaries, privateMode } = state;
  const snapshotKey = `${currentSessionId}|${showConversation}|${privateMode}|${sessionSummaries.length}`;

  if (snapshotKey === cachedSnapshotKey) {
    // Quick check — if the key is the same, verify the summary data hasn't changed
    // by comparing the relevant summary's fields
    const summary = sessionSummaries.find(s => s.id === currentSessionId);
    if (!summary && cachedActiveSession === null) return cachedActiveSession;
    if (summary && cachedActiveSession && summary.updatedAt === cachedActiveSession.updatedAt
      && summary.title === cachedActiveSession.title
      && summary.isBusy === cachedActiveSession.isBusy
      && summary.activeTurnId === cachedActiveSession.activeTurnId
      && (summary.doneAt ?? null) === cachedActiveSession.doneAt
      && summary.starredAt === cachedActiveSession.starredAt
      && summary.deletedAt === cachedActiveSession.deletedAt
      && summary.resolvedAt === cachedActiveSession.resolvedAt) {
      return cachedActiveSession;
    }
  }

  cachedSnapshotKey = snapshotKey;

  // Not viewing a conversation → null
  if (!showConversation) {
    cachedActiveSession = null;
    return null;
  }

  // Current session is private → null
  if (privateMode) {
    cachedActiveSession = null;
    return null;
  }

  // Find the current session in summaries
  const summary = sessionSummaries.find(s => s.id === currentSessionId);
  if (!summary) {
    cachedActiveSession = null;
    return null;
  }

  // Double-check: summary-level privateMode (belt-and-suspenders)
  if (summary.privateMode === true) {
    cachedActiveSession = null;
    return null;
  }

  cachedActiveSession = {
    ...mapSummaryToConversation(summary),
    activeTurnId: summary.activeTurnId,
    isCurrentSession: true,
  };
  return cachedActiveSession;
}

/**
 * Returns the currently-viewed session as an `ActiveSession`, or `null`.
 *
 * Reactive: re-renders when the current session changes, when session
 * metadata updates, or when the user navigates away from conversations.
 */
export function useActiveSession(): ActiveSession | null {
  return useSyncExternalStore(
    subscribeToSessionStore,
    getActiveSessionSnapshot,
    () => null, // SSR fallback
  );
}
