import { memo, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Switch,
} from 'react-native';
import type {
  ToolApproval,
  MemoryWriteApproval,
  CloudStagedToolCall,
} from '@rebel/cloud-client';
import { legacyMissingLocation } from '@rebel/shared';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { FileLocationBadge } from './FileLocationBadge';

const typography = createTypography(true);
const EVAL_ERROR_FRIENDLY_TEXT = 'The safety check did not finish, so nothing has run. It will not keep trying in the background.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalItem =
  | { kind: 'tool'; data: ToolApproval }
  | { kind: 'staged'; data: CloudStagedToolCall };

// ---------------------------------------------------------------------------
// Card styles factory
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 16,
      gap: 10,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 3,
      elevation: 2,
    },
    cardHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    headerMain: {
      flex: 1,
      minWidth: 0,
      marginRight: 12,
    },
    toolName: { ...typography.body, fontWeight: '700', color: colors.textPrimary },
    timestamp: { ...typography.caption, color: colors.textTertiary },
    reason: { ...typography.bodySmall, color: colors.textSecondary },
    pathText: { ...typography.caption, color: colors.textTertiary },
    riskBadge: {
      backgroundColor: 'rgba(251, 191, 36, 0.2)',
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    riskHigh: { backgroundColor: 'rgba(239, 68, 68, 0.2)' },
    riskText: {
      ...typography.overline,
      fontWeight: '700',
      color: colors.textSecondary,
    },
    inputPreview: {
      backgroundColor: colors.background,
      borderRadius: 8,
      padding: 10,
    },
    inputText: {
      ...typography.caption,
      color: colors.textSecondary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    actions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
    denyButton: {
      borderRadius: 8,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    denyText: { ...typography.bodySmall, fontWeight: '600', color: colors.textSecondary },
    approveButton: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 18,
      paddingVertical: 10,
    },
    approveText: { ...typography.bodySmall, fontWeight: '600', color: '#fff' },
    categoryBadge: {
      backgroundColor: colors.surface,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
      alignSelf: 'flex-start',
    },
    categoryText: {
      ...typography.overline,
      color: colors.textTertiary,
    },
    detailsToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingVertical: 4,
    },
    detailsToggleText: {
      ...typography.bodySmall,
      fontSize: 13,
      fontWeight: '600',
      color: colors.accent,
    },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    switchLabel: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.textSecondary,
    },
  });
}

// ---------------------------------------------------------------------------
// ToolApprovalCard
// ---------------------------------------------------------------------------

export const ToolApprovalCard = memo(function ToolApprovalCard({
  approval,
  onApprove,
  onDeny,
  onOpen,
}: {
  approval: ToolApproval;
  onApprove: (allowForSession: boolean) => void;
  onDeny: () => void;
  /**
   * Optional open-for-details handler (Stage D). When provided, tapping the
   * card body routes to the sheet host. Inline Accept/Deny/details-toggle
   * still work as quick-actions — opening the sheet is for users who want
   * the full review flow with principle picker etc.
   */
  onOpen?: () => void;
}) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [showDetails, setShowDetails] = useState(false);
  const [allowForSession, setAllowForSession] = useState(false);
  const canAllowForSession = approval.blockedBy !== 'eval_error';

  useEffect(() => {
    if (!canAllowForSession) setAllowForSession(false);
  }, [canAllowForSession]);

  return (
    <TouchableOpacity
      testID={`approvals-tool-card-${approval.toolUseID}`}
      style={s.card}
      onPress={onOpen}
      activeOpacity={onOpen ? 0.7 : 1}
      disabled={!onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Review tool call ${approval.toolName}`}
    >
      <View style={s.cardHeader}>
        <Text style={s.toolName}>{approval.toolName}</Text>
        <Text style={s.timestamp}>
          {new Date(approval.timestamp).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
      </View>
      {approval.reason && <Text style={s.reason}>{approval.reason}</Text>}
      {approval.blockedBy === 'eval_error' ? <Text style={s.reason}>{EVAL_ERROR_FRIENDLY_TEXT}</Text> : null}
      <TouchableOpacity
        testID={`approvals-tool-details-toggle-${approval.toolUseID}`}
        style={s.detailsToggle}
        onPress={() => setShowDetails(!showDetails)}
        activeOpacity={0.7}
      >
        <Text style={s.detailsToggleText}>
          {showDetails ? 'Hide input details' : 'View input details'}
        </Text>
      </TouchableOpacity>
      {showDetails && (
        <View style={s.inputPreview}>
          <Text style={s.inputText}>
            {JSON.stringify(approval.input, null, 2)}
          </Text>
        </View>
      )}
      {canAllowForSession ? (
        <View style={s.switchRow}>
          <Text style={s.switchLabel}>Allow for session</Text>
          <Switch
            testID={`approvals-tool-allow-session-switch-${approval.toolUseID}`}
            value={allowForSession}
            onValueChange={setAllowForSession}
            trackColor={{ false: colors.border, true: colors.accent }}
            thumbColor="#fff"
          />
        </View>
      ) : null}
      <View style={s.actions}>
        <TouchableOpacity
          testID={`approvals-reject-button-${approval.toolUseID}`}
          style={s.denyButton}
          onPress={onDeny}
          activeOpacity={0.7}
        >
          <Text style={s.denyText}>{approval.blockedBy === 'eval_error' ? 'Cancel this' : 'Deny'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`approvals-approve-button-${approval.toolUseID}`}
          style={s.approveButton}
          onPress={() => onApprove(allowForSession)}
          activeOpacity={0.7}
        >
          <Text style={s.approveText}>{approval.blockedBy === 'eval_error' ? 'Do it once' : 'Approve'}</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
});

// ---------------------------------------------------------------------------
// StagedCallCard
// ---------------------------------------------------------------------------

export const StagedCallCard = memo(function StagedCallCard({
  call,
  onExecute,
  onReject,
  onOpen,
}: {
  call: CloudStagedToolCall;
  onExecute: () => void;
  onReject: () => void;
  /** Optional open-for-details handler (Stage D). */
  onOpen?: () => void;
}) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [showDetails, setShowDetails] = useState(false);

  return (
    <TouchableOpacity
      testID={`approvals-staged-card-${call.id}`}
      style={s.card}
      onPress={onOpen}
      activeOpacity={onOpen ? 0.7 : 1}
      disabled={!onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Review ${call.displayName}`}
    >
      <View style={s.cardHeader}>
        <Text style={s.toolName}>{call.displayName}</Text>
        <View testID={`approvals-risk-badge-${call.id}`} style={[s.riskBadge, call.riskLevel === 'high' && s.riskHigh]}>
          <Text style={s.riskText}>{call.riskLevel}</Text>
        </View>
      </View>
      {call.toolCategory && (
        <View style={s.categoryBadge}>
          <Text style={s.categoryText}>{call.toolCategory}</Text>
        </View>
      )}
      {call.reason && <Text style={s.reason}>{call.reason}</Text>}
      {call.blockedBy === 'eval_error' ? <Text style={s.reason}>{EVAL_ERROR_FRIENDLY_TEXT}</Text> : null}
      <TouchableOpacity
        testID={`approvals-staged-details-toggle-${call.id}`}
        style={s.detailsToggle}
        onPress={() => setShowDetails(!showDetails)}
        activeOpacity={0.7}
      >
        <Text style={s.detailsToggleText}>
          {showDetails ? 'Hide input details' : 'View input details'}
        </Text>
      </TouchableOpacity>
      {showDetails && (
        <View style={s.inputPreview}>
          <Text style={s.inputText}>
            {JSON.stringify(call.mcpPayload.args, null, 2)}
          </Text>
        </View>
      )}
      <View style={s.actions}>
        <TouchableOpacity
          testID={`approvals-reject-button-${call.id}`}
          style={s.denyButton}
          onPress={onReject}
          activeOpacity={0.7}
        >
          <Text style={s.denyText}>{call.blockedBy === 'eval_error' ? 'Cancel this' : 'Reject'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`approvals-approve-button-${call.id}`}
          style={s.approveButton}
          onPress={onExecute}
          activeOpacity={0.7}
        >
          <Text style={s.approveText}>{call.blockedBy === 'eval_error' ? 'Do it once' : 'Run'}</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
});

// ---------------------------------------------------------------------------
// MemoryApprovalCard
// ---------------------------------------------------------------------------

export const MemoryApprovalCard = memo(function MemoryApprovalCard({
  approval,
  onSave,
  onSkip,
  onOpen,
}: {
  approval: MemoryWriteApproval;
  onSave: () => void;
  onSkip: () => void;
  /** Optional open-for-details handler (Stage D). */
  onOpen?: () => void;
}) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [showPreview, setShowPreview] = useState(false);
  const hasPreview = Boolean(approval.contentPreview);
  const location = useMemo(() => {
    return approval.location ?? legacyMissingLocation({
      legacyPath: approval.spacePath || approval.filePath,
      spaceName: approval.spaceName,
    });
  }, [approval]);

  return (
    <TouchableOpacity
      testID={`approvals-memory-card-${approval.toolUseId}`}
      style={s.card}
      onPress={onOpen}
      activeOpacity={onOpen ? 0.7 : 1}
      disabled={!onOpen}
      accessibilityRole="button"
      accessibilityLabel={`Review memory update ${approval.spaceName}`}
    >
      <View style={s.cardHeader}>
        <View style={s.headerMain}>
          <FileLocationBadge location={location} />
        </View>
        <Text style={s.timestamp}>
          {new Date(approval.timestamp).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
      </View>
      <Text style={s.reason}>{approval.summary}</Text>

      {hasPreview && (
        <TouchableOpacity
          testID={`approvals-memory-preview-toggle-${approval.toolUseId}`}
          style={s.detailsToggle}
          onPress={() => setShowPreview(!showPreview)}
          activeOpacity={0.7}
        >
          <Text style={s.detailsToggleText}>
            {showPreview ? 'Hide content preview' : 'View content preview'}
          </Text>
        </TouchableOpacity>
      )}

      {showPreview && approval.contentPreview && (
        <View style={s.inputPreview}>
          <Text style={s.inputText}>{approval.contentPreview}</Text>
        </View>
      )}

      <View style={s.actions}>
        <TouchableOpacity
          testID={`approvals-memory-skip-button-${approval.toolUseId}`}
          style={s.denyButton}
          onPress={onSkip}
          activeOpacity={0.7}
        >
          <Text style={s.denyText}>Skip</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`approvals-memory-save-button-${approval.toolUseId}`}
          style={s.approveButton}
          onPress={onSave}
          activeOpacity={0.7}
        >
          <Text style={s.approveText}>Save</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
});
