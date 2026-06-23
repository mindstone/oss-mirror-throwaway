/**
 * Session Privacy Guard
 *
 * Target-session-scoped privacy check for plugin APIs.
 * Replaces the current-session-only `isPrivateSession()` pattern
 * so that privacy checks work for cross-session operations
 * (lifecycle events, `useConversation(id)`, etc.).
 *
 * Safe default: returns `true` (private) if session is not found.
 *
 * @see docs/plans/260408_plugin_conversation_api_expansion.md (D6, FM1)
 */

import { getSessionStoreState } from '@renderer/features/agent-session/store/sessionStore';

/**
 * Check whether a specific session is private.
 *
 * Looks up the session in `sessionSummaries` by ID.
 * Returns `true` if the session has `privateMode === true` or
 * if the session is not found (safe default — treat unknown as private).
 */
export function isSessionPrivate(sessionId: string): boolean {
  try {
    const { sessionSummaries } = getSessionStoreState();
    const summary = sessionSummaries.find(s => s.id === sessionId);
    if (!summary) return true; // Not found → treat as private (safe default)
    return summary.privateMode === true;
  } catch {
    // Store not ready → treat as private (safe default)
    return true;
  }
}
