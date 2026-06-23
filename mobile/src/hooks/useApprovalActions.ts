import { useApprovalActions as useBaseApprovalActions } from '@rebel/cloud-client';
import { hapticSuccess, hapticWarning } from '../utils/haptics';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';

export function useApprovalActions() {
  return useBaseApprovalActions({
    onSuccess: hapticSuccess,
    onWarning: hapticWarning,
    getContinuationTurnMetadata: (targetSessionId: string) => {
      const recordingState = useActiveRecordingStore.getState();
      if (
        !recordingState.isActive
        || recordingState.companionSessionId !== targetSessionId
      ) {
        return {};
      }
      return {
        meetingSessionId: recordingState.cloudSessionId ?? undefined,
        recordingActive: true,
      };
    },
  });
}
