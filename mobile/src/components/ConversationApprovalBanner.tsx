import { memo, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useApprovalStore } from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../theme/colors';
import { useApprovalActions } from '../hooks/useApprovalActions';
import { ToolApprovalCard, StagedCallCard, MemoryApprovalCard } from './ApprovalCards';
import { useApprovalSheet } from './approval/ApprovalSheetProvider';

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 12,
    },
    errorText: {
      fontSize: 12,
      color: colors.error,
      textAlign: 'center',
    },
  });
}

type Props = {
  sessionId: string;
};

export const ConversationApprovalBanner = memo(function ConversationApprovalBanner({ sessionId }: Props) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  const allToolApprovals = useApprovalStore((state) => state.toolApprovals);
  const allStagedCalls = useApprovalStore((state) => state.stagedCalls);
  const allMemoryApprovals = useApprovalStore((state) => state.memoryApprovals);
  const fetchPending = useApprovalStore((state) => state.fetchPending);

  const toolApprovals = useMemo(
    () => allToolApprovals.filter((a) => a.sessionId === sessionId),
    [allToolApprovals, sessionId],
  );

  const stagedCalls = useMemo(
    () => allStagedCalls.filter((c) => c.sessionId === sessionId),
    [allStagedCalls, sessionId],
  );

  const memoryApprovals = useMemo(
    () => allMemoryApprovals.filter((a) => a.originalSessionId === sessionId && !a.staged),
    [allMemoryApprovals, sessionId],
  );

  useEffect(() => {
    void fetchPending();
  }, [fetchPending]);

  const {
    handleApprove,
    handleDeny,
    handleExecute,
    handleReject,
    approveMemoryWrite,
    skipMemoryWrite,
    actionError,
  } = useApprovalActions();

  // F-D-R2-8 — banner cards can open the rich detail sheet via the
  // global approval sheet provider. The host is currently rendered by
  // the inbox tab; RN Modal presents above the entire app so this
  // works regardless of which screen is on top.
  const { openApproval } = useApprovalSheet();

  if (toolApprovals.length === 0 && stagedCalls.length === 0 && memoryApprovals.length === 0) return null;

  return (
    <View testID="conversation-approval-banner" style={s.container}>
      {actionError && <Text testID="conversation-approval-error" style={s.errorText}>{actionError}</Text>}
      {toolApprovals.map((approval) => (
        <ToolApprovalCard
          key={approval.toolUseID}
          approval={approval}
          onApprove={(allowForSession) => void handleApprove(approval.toolUseID, allowForSession)}
          onDeny={() => void handleDeny(approval.toolUseID)}
          onOpen={() => openApproval('tool', approval.toolUseID)}
        />
      ))}
      {stagedCalls.map((call) => (
        <StagedCallCard
          key={call.id}
          call={call}
          onExecute={() => void handleExecute(call.id)}
          onReject={() => void handleReject(call.id)}
          onOpen={() => openApproval('staged-call', call.id)}
        />
      ))}
      {memoryApprovals.map((approval) => (
        <MemoryApprovalCard
          key={approval.toolUseId}
          approval={approval}
          onSave={() => void approveMemoryWrite(approval)}
          onSkip={() => void skipMemoryWrite(approval)}
          onOpen={() => openApproval('memory', approval.toolUseId)}
        />
      ))}
    </View>
  );
});
