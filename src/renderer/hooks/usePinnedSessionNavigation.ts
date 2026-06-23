import { useGlobalHotkey } from './useGlobalHotkey';

/**
 * Minimal session info needed for pinned navigation.
 * Sessions are navigable if they have content (messages or draft).
 */
export interface PinnedSession {
  id: string;
  isHistory?: boolean;
  /** Number of messages in the session */
  messageCount?: number;
  /** Whether the session has draft text content */
  hasDraft?: boolean;
}

/**
 * Options for the usePinnedSessionNavigation hook.
 */
export interface UsePinnedSessionNavigationOptions {
  /** Array of pinned sessions to cycle through */
  pinnedSessions: PinnedSession[];
  /** Currently active session ID, or null if none */
  currentSessionId: string | null;
  /** Callback to open a session (should be draft-protected) */
  onOpenSession: (sessionId: string) => void;
}

/**
 * Check if a session has navigable content (messages or draft).
 * Draft-only sessions with no messages are still valid navigation targets.
 */
const hasNavigableContent = (session: PinnedSession): boolean => {
  // Session with messages is always navigable
  if ((session.messageCount ?? 0) > 0) return true;
  // Draft-only session is navigable
  if (session.hasDraft) return true;
  // History sessions are navigable (fallback for backwards compatibility)
  return Boolean(session.isHistory);
};

/**
 * Hook for keyboard navigation through pinned sessions.
 *
 * Provides Ctrl+Tab (cycle forward) and Ctrl+Shift+Tab (cycle backward)
 * hotkeys for quickly switching between pinned sessions.
 *
 * The hook uses callback injection for `onOpenSession` to preserve
 * draft-guard behavior - the caller passes in a draft-protected handler.
 *
 * Sessions are navigable if they have content (messages or draft).
 *
 * @example
 * // In App.tsx
 * const pinnedFavorites = useMemo(
 *   () => sidebarAgentSessions.filter((s) => s.isActive),
 *   [sidebarAgentSessions]
 * );
 *
 * usePinnedSessionNavigation({
 *   pinnedSessions: pinnedFavorites,
 *   currentSessionId,
 *   onOpenSession: handleOpenHistorySession, // draft-protected handler
 * });
 */
export function usePinnedSessionNavigation({
  pinnedSessions,
  currentSessionId,
  onOpenSession,
}: UsePinnedSessionNavigationOptions): void {
  // Ctrl+Tab to cycle forward through pinned sessions
  useGlobalHotkey(
    'ctrl+tab',
    () => {
      // Need at least 2 pinned sessions to cycle
      if (pinnedSessions.length < 2) return;
      const currentIndex = pinnedSessions.findIndex((s) => s.id === currentSessionId);
      // Find next pinned session that isn't the current one
      const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % pinnedSessions.length;
      const targetSession = pinnedSessions[nextIndex];
      // Only switch if target is different from current and has navigable content
      if (targetSession && targetSession.id !== currentSessionId && hasNavigableContent(targetSession)) {
        onOpenSession(targetSession.id);
      }
    },
    [pinnedSessions, currentSessionId, onOpenSession]
  );

  // Shift+Ctrl+Tab to cycle backward through pinned sessions
  useGlobalHotkey(
    'ctrl+shift+tab',
    () => {
      // Need at least 2 pinned sessions to cycle
      if (pinnedSessions.length < 2) return;
      const currentIndex = pinnedSessions.findIndex((s) => s.id === currentSessionId);
      // Find previous pinned session that isn't the current one
      const prevIndex = currentIndex <= 0 ? pinnedSessions.length - 1 : currentIndex - 1;
      const targetSession = pinnedSessions[prevIndex];
      // Only switch if target is different from current and has navigable content
      if (targetSession && targetSession.id !== currentSessionId && hasNavigableContent(targetSession)) {
        onOpenSession(targetSession.id);
      }
    },
    [pinnedSessions, currentSessionId, onOpenSession]
  );
}
