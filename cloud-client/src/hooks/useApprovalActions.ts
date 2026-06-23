import { useCallback, useState } from 'react';
import { buildContinuationMessage } from '@rebel/shared';
import { createAgentTurnSocket, ipcCall } from '../cloudClient';
import { useApprovalStore } from '../stores/approvalStore';
import { useStagedFilesStore } from '../stores/stagedFilesStore';
import type { MemoryWriteApproval } from '../types';
import type { CloudMeetingSessionId } from '../types/liveMeetingIds';

export type ContinuationTurnMetadata = {
  /** Cloud meeting session id (branded — a local recording id cannot be passed). */
  meetingSessionId?: CloudMeetingSessionId;
  recordingActive?: boolean;
};

function generateClientTurnId(): string {
  const globalCrypto = (globalThis as typeof globalThis & {
    crypto?: { randomUUID?: () => string };
  }).crypto;
  if (globalCrypto?.randomUUID) {
    return globalCrypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type ApprovalActionCallbacks = {
  onSuccess?: () => void;
  onWarning?: () => void;
  /**
   * Optional injector for meeting metadata on approval-triggered continuation turns.
   * Mobile provides this from its active recording store to avoid cloud-client
   * importing mobile-only modules.
   */
  getContinuationTurnMetadata?: (targetSessionId: string) => ContinuationTurnMetadata;
};

interface MemoryWriteApprovalResponse {
  success: boolean;
  originalSessionId?: string;
  filePath?: string;
  spaceName?: string;
  content?: string;
}

function sendContinuationTurn(
  sessionId: string,
  prompt: string,
  continuationTurnMetadata?: ContinuationTurnMetadata,
): void {
  const turnRequest: {
    sessionId: string;
    prompt: string;
    clientTurnId: string;
    isSystemContinuation: true;
    meetingSessionId?: string;
    recordingActive?: boolean;
  } = {
    sessionId,
    prompt,
    clientTurnId: generateClientTurnId(),
    isSystemContinuation: true,
  };
  if (continuationTurnMetadata?.recordingActive === true) {
    turnRequest.recordingActive = true;
    if (continuationTurnMetadata.meetingSessionId) {
      turnRequest.meetingSessionId = continuationTurnMetadata.meetingSessionId;
    }
  }

  createAgentTurnSocket(
    turnRequest,
    () => {
      // Fire-and-forget continuation socket; session updates come through EventBridge.
    },
    () => {
      // Surface-level errors are handled by session refresh/events after the turn attempt.
    },
  );
}

/**
 * Shared approval action handlers with optional success/warning callbacks and error state.
 */
export function useApprovalActions(config?: ApprovalActionCallbacks) {
  const respondToApproval = useApprovalStore((s) => s.respondToApproval);
  const executeStagedCall = useApprovalStore((s) => s.executeStagedCall);
  const rejectStagedCall = useApprovalStore((s) => s.rejectStagedCall);
  const [actionError, setActionError] = useState<string | null>(null);
  const onSuccess = config?.onSuccess;
  const onWarning = config?.onWarning;
  const getContinuationTurnMetadata = config?.getContinuationTurnMetadata;

  const clearError = useCallback(() => setActionError(null), []);

  const handleApprove = useCallback(
    async (toolUseID: string, allowForSession: boolean) => {
      setActionError(null);
      onSuccess?.();
      try {
        await respondToApproval(toolUseID, true, allowForSession);
      } catch {
        setActionError('Failed to approve. Please try again.');
      }
    },
    [onSuccess, respondToApproval],
  );

  const handleDeny = useCallback(
    async (toolUseID: string) => {
      setActionError(null);
      onWarning?.();
      try {
        await respondToApproval(toolUseID, false);
      } catch {
        setActionError('Failed to deny. Please try again.');
      }
    },
    [onWarning, respondToApproval],
  );

  const handleExecute = useCallback(
    async (id: string) => {
      setActionError(null);
      onSuccess?.();
      try {
        await executeStagedCall(id);
      } catch {
        setActionError('Failed to execute. Please try again.');
      }
    },
    [executeStagedCall, onSuccess],
  );

  const handleReject = useCallback(
    async (id: string) => {
      setActionError(null);
      onWarning?.();
      try {
        await rejectStagedCall(id);
      } catch {
        setActionError('Failed to reject. Please try again.');
      }
    },
    [onWarning, rejectStagedCall],
  );

  const approveMemoryWrite = useCallback(
    async (approval: MemoryWriteApproval) => {
      setActionError(null);
      onSuccess?.();
      try {
        if (approval.staged) {
          let stagedFile = useStagedFilesStore.getState().files.find(
            (file) => file.toolUseId === approval.toolUseId,
          );

          // If not found in local state, refresh and retry — store may be stale
          if (!stagedFile) {
            await useStagedFilesStore.getState().fetchStagedFiles();
            stagedFile = useStagedFilesStore.getState().files.find(
              (file) => file.toolUseId === approval.toolUseId,
            );
          }

          if (stagedFile) {
            const result = await ipcCall<{ status: string; error?: string; conflict?: unknown }>(
              'memory:staging-publish',
              { id: stagedFile.id },
            );

            if (result.status === 'success' || result.status === 'already-resolved') {
              useApprovalStore.getState().handleMemoryEvent('memory:write-approval-resolved', [
                { toolUseId: approval.toolUseId },
              ]);
            } else if (result.status === 'conflict') {
              setActionError('File has a conflict — review in Actions.');
              return;
            } else {
              throw new Error(result.error || 'Failed to publish staged file');
            }
          } else {
            useApprovalStore.getState().handleMemoryEvent('memory:write-approval-resolved', [
              { toolUseId: approval.toolUseId },
            ]);
          }

          // Skip continuation for staged items (FM #15): content is already in CoS pending,
          // publishing happens through the staged file flow. Sending a continuation would
          // trigger a duplicate write.
          return;
        }

        const result = await ipcCall<MemoryWriteApprovalResponse>('memory:write-approval-response', {
          toolUseId: approval.toolUseId,
          approved: true,
        });

        if (!result?.success) {
          throw new Error('Memory approval response failed');
        }

        // Optimistically remove from store so card disappears immediately
        useApprovalStore.getState().handleMemoryEvent('memory:write-approval-resolved', [
          { toolUseId: approval.toolUseId },
        ]);

        // Only use the full content from the IPC response — never the truncated preview
        const continuationContent = result.content;
        if (!continuationContent) {
          throw new Error('Missing continuation content from server');
        }

        const continuationMessage = buildContinuationMessage([{
          spaceName: result.spaceName ?? approval.spaceName,
          filePath: result.filePath ?? approval.filePath,
          content: continuationContent,
        }]);
        const targetSessionId = result.originalSessionId ?? approval.originalSessionId;

        sendContinuationTurn(
          targetSessionId,
          continuationMessage,
          getContinuationTurnMetadata?.(targetSessionId),
        );
      } catch {
        setActionError('Failed to save memory. Please try again.');
      }
    },
    [getContinuationTurnMetadata, onSuccess],
  );

  const skipMemoryWrite = useCallback(
    async (approval: MemoryWriteApproval) => {
      setActionError(null);
      onWarning?.();
      try {
        const result = await ipcCall<MemoryWriteApprovalResponse>('memory:write-approval-response', {
          toolUseId: approval.toolUseId,
          approved: false,
        });
        if (!result?.success) {
          throw new Error('Memory skip response failed');
        }
      } catch {
        setActionError('Failed to skip memory save. Please try again.');
      }
    },
    [onWarning],
  );

  return {
    handleApprove,
    handleDeny,
    handleExecute,
    handleReject,
    approveMemoryWrite,
    skipMemoryWrite,
    actionError,
    clearError,
  };
}
