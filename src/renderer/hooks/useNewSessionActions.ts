import { useCallback } from 'react';

/**
 * Configuration for the useNewSessionActions hook.
 * All dependencies are stable callbacks from the parent component.
 */
interface UseNewSessionActionsConfig {
  resetSessionState: () => string;
  setActiveSurface: (surface: string) => void;
  setShowConversation: (show: boolean) => void;
  setIsTextMode: (mode: boolean) => void;
  setFlowHistoryOpen: (open: boolean) => void;
  /** Flushes any debounced composer draft writes before the current session is reset. */
  flushComposerDraft?: () => void;
}

interface StartFreshSessionOptions {
  /** When true, opens the flow history sidebar alongside the new session */
  showHistory?: boolean;
}

/**
 * Thin hook that encapsulates the common "start fresh session + navigate" sequence.
 *
 * The 4-line pattern `resetSessionState() → setActiveSurface('sessions') →
 * setShowConversation(true) → setIsTextMode(true)` is duplicated across 10+ callbacks
 * in App.tsx. This hook provides a single `startFreshSession()` primitive that handles
 * the reset + navigation, while each caller retains its unique domain logic (prompt
 * building, meta setting, draft injection, submitQueuedMessage, etc.).
 *
 * CRITICAL: `startFreshSession()` returns the sessionId. Callers that send a message
 * after reset MUST pass `targetSessionId: sessionId` explicitly to avoid stale closure
 * issues (React hasn't re-rendered yet when submitQueuedMessage is called).
 */
export function useNewSessionActions(config: UseNewSessionActionsConfig) {
  const {
    resetSessionState,
    setActiveSurface,
    setShowConversation,
    setIsTextMode,
    setFlowHistoryOpen,
    flushComposerDraft,
  } = config;

  const startFreshSession = useCallback(
    (options?: StartFreshSessionOptions): string => {
      flushComposerDraft?.();
      const sessionId = resetSessionState();
      setActiveSurface('sessions');
      setShowConversation(true);
      setIsTextMode(true);
      if (options?.showHistory) setFlowHistoryOpen(true);
      return sessionId;
    },
    [
      flushComposerDraft,
      resetSessionState,
      setActiveSurface,
      setShowConversation,
      setIsTextMode,
      setFlowHistoryOpen,
    ]
  );

  return { startFreshSession };
}
