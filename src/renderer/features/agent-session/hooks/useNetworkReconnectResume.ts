/**
 * useNetworkReconnectResume
 *
 * Watches network connectivity status and provides functions to resume
 * pending network-failed turns when connectivity is restored.
 *
 * This hook works in conjunction with:
 * - Stage 1: Attachment cache infrastructure (main process)
 * - Stage 2: Multi-session pending turn state in session store
 * - Stage 3: Detection logic in processAgentEvent
 * - Stage 4: ResumeConversationsModal for UI
 *
 * Safety:
 * - Only retries turns that were safe (no tool events)
 * - Attachments are cached to disk and restored on resume
 * - Event-driven session switching (store subscription, not hardcoded delay)
 * - Limits retries to MAX_NETWORK_RETRIES per turn
 * - Respects abort signal for cancellation
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOnlineStatus } from '@renderer/hooks/useOnlineStatus';
import { useSessionStore } from '../store/sessionStore';
import type { PendingNetworkRetryTurn } from '../store/sessionStore';
import type { ResumeProgress } from '@renderer/components/ResumeConversationsModal';
import type { AnyAttachmentPayload } from '@shared/types';
import { useShallow } from 'zustand/shallow';

/** Maximum number of retry attempts per turn before giving up */
const MAX_NETWORK_RETRIES = 3;

/** Timeout for waiting for session switch (5 seconds) */
const SESSION_SWITCH_TIMEOUT_MS = 5000;

export interface UseNetworkReconnectResumeOptions {
  /** Show toast notification to user */
  showToast: (options: { title: string }) => void;
  /** Submit a queued message to a specific session */
  submitQueuedMessage: (
    text: string,
    source: 'text' | 'voice',
    attachments?: AnyAttachmentPayload[],
    options?: { targetSessionId?: string }
  ) => Promise<void> | void;
  /** Clear interrupted turn data (removes incomplete assistant messages/events) */
  clearInterruptedTurnData: (turnId: string) => void;
  /** Open a history session by ID */
  openHistorySession: (sessionId: string) => void;
}

export interface UseNetworkReconnectResumeResult {
  /** Whether the modal should be shown */
  shouldShowModal: boolean;
  /** Pending turns available for resume */
  pendingTurns: PendingNetworkRetryTurn[];
  /** Resume all pending turns with progress callback */
  resumeAll: (
    onProgress: (progress: ResumeProgress) => void,
    abortSignal: AbortSignal
  ) => Promise<void>;
  /** Handle "I'll Handle This Manually" - close modal, user will go to conversations themselves */
  handleManually: () => void;
  /** Close the modal (after completion) */
  closeModal: () => void;
}

// Export the interface for type reference elsewhere if needed
export type { PendingNetworkRetryTurn };

/**
 * Wait for session to switch by subscribing to store changes.
 *
 * Race condition fix: Check-Subscribe-Check pattern to avoid missing
 * transitions that happen in the gap between check and subscribe.
 * Timer leak fix: Always clear timeout via centralized cleanup.
 * Abort support: Cleans up all listeners on external cancellation.
 */
const waitForSessionSwitch = (
  targetSessionId: string,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<boolean> => {
  return new Promise((resolve) => {
    // Early abort check
    if (abortSignal?.aborted) {
      resolve(false);
      return;
    }

    // Early check: if already on target, resolve immediately
    if (useSessionStore.getState().currentSessionId === targetSessionId) {
      resolve(true);
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let resolved = false;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      // Explicitly remove abort listener to prevent memory leak
      // ({ once: true } only removes if abort fires, not on other resolution paths)
      abortSignal?.removeEventListener('abort', onAbort);
    };

    const resolveWith = (value: boolean) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    };

    // Store onAbort reference so we can remove the listener in cleanup
    function onAbort() {
      resolveWith(false);
    }

    // Set up abort listener
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    // Set up timeout
    timeout = setTimeout(() => {
      resolveWith(false);
    }, timeoutMs);

    // Subscribe to session changes
    unsubscribe = useSessionStore.subscribe(
      (state) => state.currentSessionId,
      (currentId) => {
        if (currentId === targetSessionId) {
          resolveWith(true);
        }
      }
    );

    // CRITICAL: Check again AFTER subscribing to catch transitions
    // that happened in the gap between the first check and subscribe.
    // Zustand subscriptions only fire on CHANGES, so if the session
    // switched to target between check and subscribe, we'd miss it.
    if (useSessionStore.getState().currentSessionId === targetSessionId) {
      resolveWith(true);
    }
  });
};

/**
 * Hook to manage network reconnect resume flow.
 *
 * Should be called in App.tsx alongside useInterruptedSessionResume.
 * Provides modal state and resume functions.
 */
export function useNetworkReconnectResume({
  showToast: _showToast,
  submitQueuedMessage,
  clearInterruptedTurnData,
  openHistorySession,
}: UseNetworkReconnectResumeOptions): UseNetworkReconnectResumeResult {
  const isOnline = useOnlineStatus();
  const wasOnlineRef = useRef(isOnline);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Store selectors - use useShallow to prevent infinite loops from object/array references
  // Select the raw object, then derive pendingTurns via useMemo
  const pendingNetworkRetryTurns = useSessionStore(
    useShallow((state) => state.pendingNetworkRetryTurns)
  );

  // Derive sorted array and count from the raw data
  const pendingTurns = useMemo(() => {
    const turns = Object.values(pendingNetworkRetryTurns);
    return turns.sort((a, b) => a.failedAt - b.failedAt);
  }, [pendingNetworkRetryTurns]);

  const pendingTurnCount = pendingTurns.length;

  // Store actions
  const setIsResuming = useSessionStore((state) => state.setIsResuming);
  const clearPendingTurnForSession = useSessionStore((state) => state.clearPendingTurnForSession);
  const setPendingTurnForSession = useSessionStore((state) => state.setPendingTurnForSession);

  // Detect offline→online transition and open modal if there are pending turns
  useEffect(() => {
    const wasOffline = !wasOnlineRef.current;
    wasOnlineRef.current = isOnline;

    // Open modal when coming back online with pending turns
    if (wasOffline && isOnline && pendingTurnCount > 0 && !isModalOpen) {
      setIsModalOpen(true);
    }
  }, [isOnline, pendingTurnCount, isModalOpen]);

  // Also open modal if pending turns exist when hook first mounts (app restart case)
  useEffect(() => {
    if (isOnline && pendingTurnCount > 0 && !isModalOpen) {
      setIsModalOpen(true);
    }
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting isOnline/pendingTurnCount/isModalOpen so restart recovery prompt opens only on initial mount
  }, []);

  const shouldShowModal = isModalOpen;

  // Resume all pending turns
  const resumeAll = useCallback(
    async (
      onProgress: (progress: ResumeProgress) => void,
      abortSignal: AbortSignal
    ) => {
      setIsResuming(true);

      try {
        const turns = useSessionStore.getState().getAllPendingTurns();

        for (const turn of turns) {
          // Check abort signal
          if (abortSignal.aborted) {
            onProgress({ sessionId: turn.sessionId, status: 'cancelled' });
            continue;
          }

          // Check if still online
          if (!navigator.onLine) {
            onProgress({ sessionId: turn.sessionId, status: 'failed', error: 'Went offline' });
            continue;
          }

          // Check if session still exists (use summaries for existence check)
          const sessionExists = useSessionStore
            .getState()
            .sessionSummaries.some((s) => s.id === turn.sessionId);
          if (!sessionExists) {
            onProgress({
              sessionId: turn.sessionId,
              status: 'failed',
              error: 'Conversation deleted',
            });
            clearPendingTurnForSession(turn.sessionId, true);
            continue;
          }

          // Check retry count
          if (turn.retryCount >= MAX_NETWORK_RETRIES) {
            onProgress({
              sessionId: turn.sessionId,
              status: 'failed',
              error: 'Max retries exceeded',
            });
            clearPendingTurnForSession(turn.sessionId, true);
            continue;
          }

          // Load cached attachments if any
          onProgress({ sessionId: turn.sessionId, status: 'loading' });
          let attachments: AnyAttachmentPayload[] | undefined;

          if (turn.attachmentCacheIds && turn.attachmentCacheIds.length > 0) {
            try {
              const result = await window.agentApi.loadCachedAttachments({
                cacheIds: turn.attachmentCacheIds,
              });
              const successfulLoads = result.results.filter((r) => r.success && r.payload);
              if (successfulLoads.length !== turn.attachmentCacheIds.length) {
                // Some attachments failed to load - skip this turn
                onProgress({
                  sessionId: turn.sessionId,
                  status: 'failed',
                  error: 'Attachments unavailable',
                });
                continue;
              }
              attachments = successfulLoads.map((r) => r.payload as AnyAttachmentPayload);
            } catch {
              onProgress({
                sessionId: turn.sessionId,
                status: 'failed',
                error: "Couldn't reload the attachments",
              });
              continue;
            }
          }

          // Switch to session
          onProgress({ sessionId: turn.sessionId, status: 'switching' });
          // eslint-disable-next-line no-restricted-syntax -- openHistorySession-justified: this `openHistorySession` is the injected callback param (wired by App.tsx to reconnectOpenHistorySession), not the raw engine; a bare-identifier selector cannot distinguish them. Sanctioned reconnect-resume path (PM 260416).
          openHistorySession(turn.sessionId);

          // Wait for session switch (pass abort signal for cleanup on cancellation)
          const switched = await waitForSessionSwitch(
            turn.sessionId,
            SESSION_SWITCH_TIMEOUT_MS,
            abortSignal
          );
          if (!switched) {
            onProgress({
              sessionId: turn.sessionId,
              status: 'failed',
              error: 'Switch timeout',
            });
            // Increment retry count
            setPendingTurnForSession(turn.sessionId, {
              ...turn,
              retryCount: turn.retryCount + 1,
            });
            continue;
          }

          // Check abort again after waiting
          if (abortSignal.aborted) {
            onProgress({ sessionId: turn.sessionId, status: 'cancelled' });
            continue;
          }

          // Clear interrupted turn data
          clearInterruptedTurnData(turn.turnId);

          // Submit the message
          try {
            await Promise.resolve(submitQueuedMessage(turn.userMessageText, 'text', attachments, {
              targetSessionId: turn.sessionId,
            }));
            // Success - clear pending and delete cache
            clearPendingTurnForSession(turn.sessionId, true);
            onProgress({ sessionId: turn.sessionId, status: 'done' });
          } catch {
            onProgress({
              sessionId: turn.sessionId,
              status: 'failed',
              error: 'Submit failed',
            });
            // Increment retry count
            setPendingTurnForSession(turn.sessionId, {
              ...turn,
              retryCount: turn.retryCount + 1,
            });
          }
        }
      } finally {
        setIsResuming(false);
      }
    },
    [
      setIsResuming,
      clearPendingTurnForSession,
      setPendingTurnForSession,
      clearInterruptedTurnData,
      openHistorySession,
      submitQueuedMessage,
    ]
  );

  const handleManually = useCallback(() => {
    // User chose to handle manually - just close the modal
    // Pending turns remain so they can still be found in history
    setIsModalOpen(false);
  }, []);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  return {
    shouldShowModal,
    pendingTurns,
    resumeAll,
    handleManually,
    closeModal,
  };
}
