import { useCallback, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { AgentTurnMessage, AgentSessionSummary } from '@shared/types';
import type { AgentSessionSidebarEntry } from '../types';
import { useTimeoutRef } from '@renderer/hooks/useTimeoutRef';

const DELETE_ANIMATION_DURATION_MS = 250;

export type PendingDeleteSession = {
  id: string;
  title: string;
  timestamp: number | null;
  messageCount: number;
  isActive: boolean;
  willStopRun: boolean;
  queuedMessageCount: number;
  origin?: 'manual' | 'automation' | 'mcp-tool' | 'inbound-trigger' | 'plugin' | 'role' | 'focus' | 'browser-extension' | 'operator-personalisation';
};

type UseSessionDeleteDialogOptions = {
  sessionSummaries: AgentSessionSummary[];
  currentSessionId: string;
  currentSessionSidebarEntry: AgentSessionSidebarEntry | null;
  isBusy: boolean;
  queuedMessageCount: number;
  sidebarAgentSessions: AgentSessionSidebarEntry[];
  messages: AgentTurnMessage[];
  executeSessionDeletion: (sessionId: string) => void;
};

type UseSessionDeleteDialogResult = {
  pendingDeleteSession: PendingDeleteSession | null;
  deletingSessionId: string | null;
  requestDeleteSession: (sessionId: string, event?: ReactMouseEvent) => void;
  confirmDeleteSession: () => void;
  cancelDeleteSession: () => void;
};

export const useSessionDeleteDialog = ({
  sessionSummaries,
  currentSessionId,
  currentSessionSidebarEntry,
  isBusy,
  queuedMessageCount,
  sidebarAgentSessions,
  messages,
  executeSessionDeletion
}: UseSessionDeleteDialogOptions): UseSessionDeleteDialogResult => {
  const [pendingDeleteSession, setPendingDeleteSession] = useState<PendingDeleteSession | null>(
    null
  );
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const deleteTimeout = useTimeoutRef();

  const requestDeleteSession = useCallback(
    (sessionId: string, event?: ReactMouseEvent) => {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }

      const summary = sessionSummaries.find((s) => s.id === sessionId);
      const sidebarEntry = sidebarAgentSessions.find((entry) => entry.id === sessionId);
      const currentEntryFallback =
        sessionId === currentSessionId ? currentSessionSidebarEntry : undefined;
      const title =
        summary?.title || sidebarEntry?.title || currentEntryFallback?.title || 'Untitled conversation';
      const timestamp =
        summary?.updatedAt ??
        summary?.createdAt ??
        sidebarEntry?.timestamp ??
        currentEntryFallback?.timestamp ??
        null;
      const origin = summary?.origin ?? sidebarEntry?.origin ?? currentEntryFallback?.origin;
      const messageCount =
        summary?.messageCount ?? (sessionId === currentSessionId ? messages.length : 0);
      const isActiveSession = sessionId === currentSessionId;

      setPendingDeleteSession({
        id: sessionId,
        title,
        timestamp,
        messageCount,
        isActive: isActiveSession,
        willStopRun: isActiveSession && isBusy,
        queuedMessageCount: isActiveSession ? queuedMessageCount : 0,
        origin
      });
    },
    [
      sessionSummaries,
      currentSessionId,
      currentSessionSidebarEntry,
      isBusy,
      messages.length,
      queuedMessageCount,
      sidebarAgentSessions
    ]
  );

  const confirmDeleteSession = useCallback(() => {
    if (!pendingDeleteSession) {
      return;
    }
    const targetId = pendingDeleteSession.id;
    setPendingDeleteSession(null);
    setDeletingSessionId(targetId);
    deleteTimeout.set(() => {
      setDeletingSessionId(null);
      executeSessionDeletion(targetId);
    }, DELETE_ANIMATION_DURATION_MS);
  }, [deleteTimeout, executeSessionDeletion, pendingDeleteSession]);

  const cancelDeleteSession = useCallback(() => {
    setPendingDeleteSession(null);
  }, []);

  return {
    pendingDeleteSession,
    deletingSessionId,
    requestDeleteSession,
    confirmDeleteSession,
    cancelDeleteSession
  };
};
