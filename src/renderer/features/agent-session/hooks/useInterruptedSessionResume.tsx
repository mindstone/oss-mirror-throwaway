/**
 * useInterruptedSessionResume
 *
 * Scans for sessions that were interrupted when the app closed and provides
 * modal state for the user to choose which sessions to resume.
 *
 * When resuming, the conversation history is preserved (including partial work
 * and tool results from the interrupted turn). A modified message is submitted
 * that combines the original user message with a recovery preamble, letting
 * the agent self-assess what was done and continue from where it left off.
 *
 * This replaces the previous auto-resume/toast approach. All interrupted
 * sessions (with or without tool events) go through the same modal flow.
 *
 * Loop protection:
 * - Clear interruptedTurnId BEFORE attempting resume
 * - Use ref to prevent double-run on mount
 */

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import type { AgentSession, AgentSessionSummary } from '@shared/types';

/** Delay before checking for interrupted sessions (ms) - allows app to fully initialize */
const RESUME_CHECK_DELAY_MS = 1000;

/** Recovery preamble appended to the original user message on resume */
const RECOVERY_PREAMBLE =
  '\n\n[Note: We got interrupted last time while working on this. Please check what\'s already been done and continue from where we left off.]';

export interface InterruptedSessionInfo {
  sessionId: string;
  title: string;
  userMessageText: string;
  hasToolEvents: boolean;
  hasAttachments: boolean;
}

export interface UseInterruptedSessionResumeOptions {
  /** Session summaries for detecting interrupted sessions (includes interruptedTurnId) */
  sessionSummaries: AgentSessionSummary[];
  /** Navigate to a specific session by ID (may be async) */
  navigateToSession: (sessionId: string) => void | Promise<void>;
  /** Resume the turn - opens session and submits modified message (may be async) */
  resumeTurn: (session: AgentSession, modifiedMessageText: string) => void | Promise<void>;
}

export interface UseInterruptedSessionResumeResult {
  /** Whether the modal should be shown */
  shouldShowModal: boolean;
  /** Interrupted sessions available for resume */
  interruptedSessions: InterruptedSessionInfo[];
  /** Whether a resume operation is currently in progress */
  isResuming: boolean;
  /** Resume a single session by ID */
  resumeSession: (sessionId: string) => Promise<void>;
  /** Resume all interrupted sessions */
  resumeAll: () => Promise<void>;
  /** Dismiss a single session (clear its interrupted flag) */
  dismissSession: (sessionId: string) => Promise<void>;
  /** Dismiss all and close modal */
  dismissAll: () => void;
  /** Close the modal */
  closeModal: () => void;
}

/**
 * Build the modified message for recovery: original message + recovery preamble.
 */
export function buildRecoveryMessage(originalText: string): string {
  return originalText + RECOVERY_PREAMBLE;
}

/**
 * Hook to detect and handle interrupted sessions on app startup via modal.
 *
 * Should be called after sessions are loaded and the app is ready.
 * Processes sessions with interruptedTurnId set by the main process on load.
 */
export function useInterruptedSessionResume({
  sessionSummaries,
  navigateToSession: _navigateToSession,
  resumeTurn,
}: UseInterruptedSessionResumeOptions): UseInterruptedSessionResumeResult {
  // Track whether we've already scanned for interrupted sessions
  const hasProcessedRef = useRef(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [interruptedSessions, setInterruptedSessions] = useState<InterruptedSessionInfo[]>([]);
  const [isResuming, setIsResuming] = useState(false);
  // Concurrency guard — prevents multiple resumeAll invocations
  const isResumingRef = useRef(false);
  // Track sessions already being resumed to prevent duplicate submissions
  const resumedSessionIdsRef = useRef<Set<string>>(new Set());
  // Keep full session objects for resume (keyed by sessionId)
  const fullSessionsRef = useRef<Map<string, AgentSession>>(new Map());
  // Clear interruptedTurnId from a session via IPC
  const clearInterruptedFlag = useCallback(async (session: AgentSession): Promise<void> => {
    try {
      const updatedSession: AgentSession = {
        ...session,
        interruptedTurnId: null,
      };
      await window.sessionsApi.upsert(updatedSession as Parameters<typeof window.sessionsApi.upsert>[0]);
    } catch (error) {
      console.error('[useInterruptedSessionResume] Failed to clear interruptedTurnId:', error);
    }
  }, []);

  // Scan for interrupted sessions after delay
  useEffect(() => {
    if (hasProcessedRef.current) return;

    const interruptedSummaries = sessionSummaries.filter(
      (s) => s.interruptedTurnId && s.deletedAt == null && !s.isCorrupted
    );
    if (interruptedSummaries.length === 0) return;

    hasProcessedRef.current = true;

    const timeoutId = setTimeout(async () => {
      const sessions: InterruptedSessionInfo[] = [];
      const fullSessions = new Map<string, AgentSession>();

      for (const summary of interruptedSummaries) {
        try {
          const fullSession = await window.sessionsApi.get({ id: summary.id });
          if (!fullSession || !fullSession.interruptedTurnId) continue;

          // Skip sessions that already have an active turn running — the interrupted
          // turn flag may be stale from a prior load while the session has since been
          // resumed (e.g., cloud-synced session that was re-opened on desktop).
          if (fullSession.isBusy || fullSession.activeTurnId) continue;

          const userMessage = fullSession.messages.find(
            (m) => m.turnId === fullSession.interruptedTurnId && m.role === 'user'
          );
          if (!userMessage) continue;

          const events = fullSession.eventsByTurn[fullSession.interruptedTurnId] ?? [];
          const hasToolEvents = events.some((e) => e.type === 'tool');
          const hasAttachments = (userMessage.attachments?.length ?? 0) > 0;

          fullSessions.set(summary.id, fullSession);
          sessions.push({
            sessionId: summary.id,
            title: fullSession.title || 'Untitled conversation',
            userMessageText: userMessage.text,
            hasToolEvents,
            hasAttachments,
          });
        } catch (err) {
          console.error('[useInterruptedSessionResume] Failed to load session:', summary.id, err);
        }
      }

      if (sessions.length > 0) {
        fullSessionsRef.current = fullSessions;
        setInterruptedSessions(sessions);
        setIsModalOpen(true);
      }
    }, RESUME_CHECK_DELAY_MS);

    return () => clearTimeout(timeoutId);
  }, [sessionSummaries]);

  const resumeSession = useCallback(async (sessionId: string) => {
    // Guard: skip if this session is already being resumed
    if (resumedSessionIdsRef.current.has(sessionId)) return;
    resumedSessionIdsRef.current.add(sessionId);

    const fullSession = fullSessionsRef.current.get(sessionId);
    if (!fullSession) return;

    try {
      // Clear the interrupted flag FIRST (loop protection)
      await clearInterruptedFlag(fullSession);

      const userMessage = fullSession.messages.find(
        (m) => m.turnId === fullSession.interruptedTurnId && m.role === 'user'
      );
      if (!userMessage) return;

      console.warn('[useInterruptedSessionResume] Resuming session', {
        sessionId,
        title: fullSession.title,
        messagePreview: userMessage.text.slice(0, 80),
      });

      // Submit modified message (original + recovery preamble)
      // Conversation history is preserved — agent can see what was done
      const modifiedMessage = buildRecoveryMessage(userMessage.text);
      await resumeTurn(fullSession, modifiedMessage);

      // Remove from list
      setInterruptedSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
    } catch (error) {
      console.error('[useInterruptedSessionResume] Failed to resume session:', sessionId, error);
      // Allow retry on failure
      resumedSessionIdsRef.current.delete(sessionId);
    }
  }, [clearInterruptedFlag, resumeTurn]);

  const resumeAll = useCallback(async () => {
    // Concurrency guard — prevent multiple simultaneous resumeAll calls
    if (isResumingRef.current) return;
    isResumingRef.current = true;
    setIsResuming(true);

    try {
      // Resume each session sequentially (avoid overwhelming the system)
      const sessionIds = interruptedSessions.map((s) => s.sessionId);
      console.warn('[useInterruptedSessionResume] Resume all requested', {
        count: sessionIds.length,
        sessionIds: sessionIds.map((id) => id.slice(0, 30)),
      });
      for (const sessionId of sessionIds) {
        await resumeSession(sessionId);
      }
    } finally {
      isResumingRef.current = false;
      setIsResuming(false);
      resumedSessionIdsRef.current.clear();
      setIsModalOpen(false);
    }
  }, [interruptedSessions, resumeSession]);

  const dismissSession = useCallback(async (sessionId: string) => {
    const fullSession = fullSessionsRef.current.get(sessionId);
    if (fullSession) {
      await clearInterruptedFlag(fullSession);
    }
    setInterruptedSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
    fullSessionsRef.current.delete(sessionId);
  }, [clearInterruptedFlag]);

  const dismissAll = useCallback(() => {
    // Clear all interrupted flags
    for (const [, session] of fullSessionsRef.current) {
      void clearInterruptedFlag(session);
    }
    fullSessionsRef.current.clear();
    setInterruptedSessions([]);
    setIsModalOpen(false);
  }, [clearInterruptedFlag]);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  // Auto-close modal when all sessions have been handled
  const shouldShowModal = isModalOpen && interruptedSessions.length > 0;

  return useMemo(() => ({
    shouldShowModal,
    interruptedSessions,
    isResuming,
    resumeSession,
    resumeAll,
    dismissSession,
    dismissAll,
    closeModal,
  }), [shouldShowModal, interruptedSessions, isResuming, resumeSession, resumeAll, dismissSession, dismissAll, closeModal]);
}
