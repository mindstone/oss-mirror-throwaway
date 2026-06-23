/**
 * ToolApprovalSheet — detail bottom sheet for tool-call approvals.
 *
 * Rendered when the user taps a tool-approval card in the inbox. Shows:
 *  - Tool name + optional package badge + risk badge
 *  - Reason (from safety evaluation)
 *  - JSON input preview
 *  - Approve / Deny primary actions
 *  - Approve-always / Deny-always — expand an inline PrincipleOptionsPicker
 *    covering all 5 `usePrincipleOptions` states.
 *
 * Stage D of `docs/plans/260417_approval_consolidation_closeout.md`.
 *
 * The "Allow for session" switch from `ToolApprovalCard` is preserved on
 * the card itself — this sheet is for DEEPER review (always rules,
 * input inspection). Users who just want a quick Yes/No should still be
 * able to use the card inline actions without opening the sheet.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import {
  usePrincipleOptions,
  type ToolApproval,
} from '@rebel/cloud-client';

import { useColors, type ColorTokens } from '../../theme/colors';
import { createTypography } from '../../theme/typography';
import { hapticMedium, hapticWarning } from '../../utils/haptics';
import { useMobileApprovalTransport } from '../../transport/mobileApprovalTransport';
import { ApprovalSheetShell } from './ApprovalSheetShell';
import { PrincipleOptionsPicker } from './PrincipleOptionsPicker';

const typography = createTypography(true);
const EVAL_ERROR_FRIENDLY_TEXT = 'The safety check did not finish, so nothing has run. It will not keep trying in the background.';

type PickerMode = 'none' | 'approve-always' | 'deny-always';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ToolApprovalSheetProps {
  approval: ToolApproval | null;
  visible: boolean;
  onClose: () => void;
  /** Approve (allow once) — fires `respondToApproval(id, true, allowForSession)`. */
  onApprove: (approval: ToolApproval, allowForSession: boolean) => void;
  /** Deny — fires `respondToApproval(id, false)`. */
  onDeny: (approval: ToolApproval) => void;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    toolRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    riskBadge: {
      backgroundColor: `${colors.warning}22`,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    riskBadgeHigh: {
      backgroundColor: `${colors.error}22`,
    },
    riskBadgeLow: {
      backgroundColor: `${colors.success}22`,
    },
    riskText: {
      ...typography.overline,
      fontWeight: '700',
      color: colors.textSecondary,
    },
    reason: {
      ...typography.bodySmall,
      color: colors.textPrimary,
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    metaText: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    sectionTitle: {
      ...typography.overline,
      fontSize: 13,
      fontWeight: '700',
      color: colors.textTertiary,
      letterSpacing: 1.5,
    },
    jsonBlock: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 10,
      backgroundColor: colors.surface,
    },
    jsonText: {
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 12,
      lineHeight: 18,
      color: colors.textSecondary,
    },
    actionsPrimaryRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      justifyContent: 'flex-end',
    },
    actionsAlwaysRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      justifyContent: 'flex-end',
    },
    outlineButton: {
      borderRadius: 8,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    outlineText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    primaryButton: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 18,
      paddingVertical: 10,
      flexDirection: 'row',
      gap: 6,
      alignItems: 'center',
    },
    primaryButtonDisabled: { opacity: 0.5 },
    primaryText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: '#fff',
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRiskBadgeStyle(
  risk: ToolApproval['riskLevel'] | undefined,
  styles: ReturnType<typeof createStyles>,
) {
  if (risk === 'high') return [styles.riskBadge, styles.riskBadgeHigh];
  if (risk === 'low') return [styles.riskBadge, styles.riskBadgeLow];
  return styles.riskBadge;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ToolApprovalSheet = memo(function ToolApprovalSheet({
  approval,
  visible,
  onClose,
  onApprove,
  onDeny,
}: ToolApprovalSheetProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const transport = useMobileApprovalTransport();
  const [pickerMode, setPickerMode] = useState<PickerMode>('none');

  // F-D-R2-4 (cross-surface close animation) — snapshot the last
  // non-null approval so the Modal can finish its slide-out even after
  // the store drops the item. See StagedFileApprovalSheet for the full
  // rationale.
  const lastApprovalRef = useRef<ToolApproval | null>(null);
  if (approval) lastApprovalRef.current = approval;
  const renderApproval = approval ?? lastApprovalRef.current;

  // F-D-R2-3 — reset local picker mode when the host swaps to a new
  // approval. The inline PrincipleOptionsPicker is remounted via
  // `key={approval.toolUseID}` below so the hook state resets too.
  const approvalId = approval?.toolUseID ?? null;
  useEffect(() => {
    setPickerMode('none');
  }, [approvalId]);

  // S4 — track in-flight state so primary-action buttons disable
  // between tap and resolution.
  const [isSubmitting, setIsSubmitting] = useState(false);
  useEffect(() => {
    setIsSubmitting(false);
  }, [approvalId]);

  // Blocked-action context for the picker. For tool approvals the safety
  // system surfaces a `reason` — mirror that into the `blockReason` so the
  // picker can generate on-topic suggestions.
  const blockedAction = useMemo(() => {
    if (!renderApproval) return null;
    return {
      toolName: renderApproval.toolName,
      toolInput: renderApproval.input,
      blockReason: renderApproval.reason ?? `Tool call: ${renderApproval.toolName}`,
    };
  }, [renderApproval]);

  const handleApproveSuccess = useCallback(() => {
    if (!renderApproval) return;
    setIsSubmitting(true);
    // Approve-always via the picker implies session-wide + durable rule — the
    // picker has already written the rule; we don't also need to pass
    // `allowForSession=true` to the base respondToApproval call.
    onApprove(renderApproval, false);
    onClose();
  }, [renderApproval, onApprove, onClose]);

  const handleDenySuccess = useCallback(() => {
    if (!renderApproval) return;
    setIsSubmitting(true);
    onDeny(renderApproval);
    onClose();
  }, [renderApproval, onDeny, onClose]);

  const approvePicker = usePrincipleOptions({
    transport,
    blockedAction,
    effectiveToolId: renderApproval?.toolName ?? null,
    packageName: renderApproval?.packageName,
    direction: 'allow',
    onApprove: handleApproveSuccess,
  });

  const denyPicker = usePrincipleOptions({
    transport,
    blockedAction,
    effectiveToolId: renderApproval?.toolName ?? null,
    packageName: renderApproval?.packageName,
    direction: 'deny',
    onApprove: handleApproveSuccess,
    onDeny: handleDenySuccess,
  });

  const openApproveAlways = useCallback(() => {
    setPickerMode('approve-always');
    approvePicker.startGeneration();
  }, [approvePicker]);

  const openDenyAlways = useCallback(() => {
    setPickerMode('deny-always');
    denyPicker.startGeneration();
  }, [denyPicker]);

  // S6 — memoize JSON serialization keyed on input identity. Re-serializing
  // on every unrelated render (haptics, picker mode, etc.) is wasteful for
  // tool inputs that can be hundreds of lines.
  const inputPreview = useMemo(
    () => (renderApproval ? JSON.stringify(renderApproval.input, null, 2) : ''),
    [renderApproval],
  );

  if (!renderApproval) {
    return null;
  }

  const subtitle = renderApproval.conversationTitle ?? renderApproval.packageName ?? undefined;
  const isEvalError = renderApproval.blockedBy === 'eval_error';
  const showRuleActions = !isEvalError;
  const canApproveAlways = showRuleActions && renderApproval.allowPermanentTrust !== false;

  return (
    <ApprovalSheetShell
      visible={visible}
      onClose={onClose}
      title="Review tool call"
      subtitle={subtitle}
      testID="tool-approval-sheet"
    >
      <View style={s.toolRow}>
        <Text style={typography.body}>{renderApproval.toolName}</Text>
        {renderApproval.riskLevel ? (
          <View
            testID="tool-approval-sheet-risk-badge"
            style={getRiskBadgeStyle(renderApproval.riskLevel, s)}
          >
            <Text style={s.riskText}>{renderApproval.riskLevel}</Text>
          </View>
        ) : null}
      </View>

      {renderApproval.reason ? <Text style={s.reason}>{renderApproval.reason}</Text> : null}
      {isEvalError ? <Text style={s.reason}>{EVAL_ERROR_FRIENDLY_TEXT}</Text> : null}

      <Text style={s.sectionTitle}>Input</Text>
      <View style={s.jsonBlock}>
        <Text testID="tool-approval-sheet-input" style={s.jsonText}>
          {inputPreview}
        </Text>
      </View>

      {pickerMode === 'approve-always' ? (
        <PrincipleOptionsPicker
          {...approvePicker}
          key={`allow-${renderApproval.toolUseID}`}
          testIDPrefix="tool-approval-sheet-allow-picker"
        />
      ) : null}

      {pickerMode === 'deny-always' ? (
        <PrincipleOptionsPicker
          {...denyPicker}
          key={`deny-${renderApproval.toolUseID}`}
          testIDPrefix="tool-approval-sheet-deny-picker"
        />
      ) : null}

      <View style={s.actionsPrimaryRow}>
        <TouchableOpacity
          testID="tool-approval-sheet-deny"
          style={[s.outlineButton, isSubmitting && s.primaryButtonDisabled]}
          onPress={() => {
            hapticWarning();
            handleDenySuccess();
          }}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Deny tool call"
          accessibilityState={{ disabled: isSubmitting }}
          activeOpacity={0.7}
        >
          <Text style={s.outlineText}>{isEvalError ? 'Cancel this' : 'Deny'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="tool-approval-sheet-approve"
          style={[s.primaryButton, isSubmitting && s.primaryButtonDisabled]}
          onPress={() => {
            hapticMedium();
            handleApproveSuccess();
          }}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Approve tool call"
          accessibilityState={{ disabled: isSubmitting }}
          activeOpacity={0.8}
        >
          <Feather name="check" size={14} color="#fff" />
          <Text style={s.primaryText}>{isEvalError ? 'Do it once' : 'Approve'}</Text>
        </TouchableOpacity>
      </View>

      {pickerMode === 'none' && showRuleActions ? (
        <View style={s.actionsAlwaysRow}>
          <TouchableOpacity
            testID="tool-approval-sheet-deny-always"
            style={s.outlineButton}
            onPress={openDenyAlways}
            accessibilityRole="button"
            accessibilityLabel="Deny tool call and remember"
            activeOpacity={0.7}
          >
            <Text style={s.outlineText}>Deny always</Text>
          </TouchableOpacity>
          {canApproveAlways ? (
            <TouchableOpacity
              testID="tool-approval-sheet-approve-always"
              style={s.outlineButton}
              onPress={openApproveAlways}
              accessibilityRole="button"
              accessibilityLabel="Approve tool call and remember"
              activeOpacity={0.7}
            >
              <Text style={s.outlineText}>Approve always</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </ApprovalSheetShell>
  );
});

ToolApprovalSheet.displayName = 'ToolApprovalSheet';

export default ToolApprovalSheet;
