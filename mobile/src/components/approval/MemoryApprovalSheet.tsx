/**
 * MemoryApprovalSheet — detail bottom sheet for memory-write approvals.
 *
 * Shows the memory content (current vs proposed), the block reason when
 * Safety Rules blocked the write, and Save / Skip actions. When the user
 * picks "Always" the PrincipleOptionsPicker handles the durable-rule
 * creation flow (all 5 generation states per `usePrincipleOptions`).
 *
 * Stage D of `docs/plans/260417_approval_consolidation_closeout.md`.
 *
 * Blocked vs clean-pass paths:
 *   - Clean-pass (not blocked): Save / Skip only. No principle picker.
 *   - Blocked: Save-always / Skip-always each expand an inline
 *     PrincipleOptionsPicker. The picker appears on demand so users
 *     tapping "Save" once aren't penalized with an extra generation.
 *
 * Copy bias — short + Rebel voice:
 *   - Title: "Review memory update"
 *   - Actions: Save, Skip, Save always, Skip always
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import {
  buildMemoryBlockedAction,
  formatRelativeTime,
  ipcCall,
  readWorkspaceFile,
  useApprovalContent,
  usePrincipleOptions,
  type MemoryWriteApproval,
} from '@rebel/cloud-client';
import { legacyMissingLocation } from '@rebel/shared';

import { useColors, type ColorTokens } from '../../theme/colors';
import { createTypography } from '../../theme/typography';
import { hapticMedium, hapticWarning } from '../../utils/haptics';
import { useMobileApprovalTransport } from '../../transport/mobileApprovalTransport';
import { ApprovalSheetShell } from './ApprovalSheetShell';
import { MobileDiffView } from './MobileDiffView';
import { PrincipleOptionsPicker } from './PrincipleOptionsPicker';
import { FileLocationBadge } from '../FileLocationBadge';

const typography = createTypography(true);

type PickerMode = 'none' | 'save-always' | 'skip-always';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MemoryApprovalSheetProps {
  approval: MemoryWriteApproval | null;
  visible: boolean;
  onClose: () => void;
  /** Save (approve) — fires `approveMemoryWrite`. */
  onSave: (approval: MemoryWriteApproval) => void;
  /** Skip (deny) — fires `skipMemoryWrite`. */
  onSkip: (approval: MemoryWriteApproval) => void;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    summary: {
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
    pathText: {
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
    contentBlock: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 10,
      backgroundColor: colors.surface,
    },
    blockedBlock: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: `${colors.warning}55`,
      backgroundColor: `${colors.warning}11`,
      padding: 12,
      gap: 6,
    },
    blockedTitle: {
      ...typography.bodySmall,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    blockedText: {
      ...typography.caption,
      color: colors.textSecondary,
    },
    errorBlock: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: `${colors.error}55`,
      backgroundColor: `${colors.error}11`,
      padding: 12,
    },
    errorText: {
      ...typography.bodySmall,
      color: colors.error,
    },
    loadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
    },
    loadingText: {
      ...typography.bodySmall,
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
    plainText: {
      ...typography.body,
      fontSize: 14,
      color: colors.textPrimary,
    },
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const MemoryApprovalSheet = memo(function MemoryApprovalSheet({
  approval,
  visible,
  onClose,
  onSave,
  onSkip,
}: MemoryApprovalSheetProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const transport = useMobileApprovalTransport();
  const [pickerMode, setPickerMode] = useState<PickerMode>('none');

  // F-D-R2-4 (cross-surface close animation) — snapshot the last
  // non-null approval so the Modal can finish its slide-out even after
  // the store drops the item. See StagedFileApprovalSheet for the full
  // rationale.
  const lastApprovalRef = useRef<MemoryWriteApproval | null>(null);
  if (approval) lastApprovalRef.current = approval;
  const renderApproval = approval ?? lastApprovalRef.current;

  // F-D-R2-3 — reset local picker mode when the host swaps to a new
  // approval. The inline PrincipleOptionsPicker is remounted via
  // `key={approval.toolUseId}` below so the hook state also resets;
  // this effect keeps the local "which Always path opened" flag in
  // sync so a stale `save-always` doesn't linger across approvals.
  const approvalId = approval?.toolUseId ?? null;
  useEffect(() => {
    setPickerMode('none');
  }, [approvalId]);

  const {
    original,
    loading: contentLoading,
    error: contentError,
    refetch: refetchContent,
  } = useApprovalContent(approval, {
    readStagedContent: (id) =>
      ipcCall<{ content: string | null; error?: string }>(
        'memory:staging-get-content',
        { id },
      ),
    readWorkspaceFile: (path) => readWorkspaceFile(path),
  });

  const proposedContent = renderApproval?.contentPreview ?? '';
  const location = useMemo(() => {
    if (!renderApproval) return null;
    return renderApproval.location ?? legacyMissingLocation({
      legacyPath: renderApproval.spacePath || renderApproval.filePath,
      spaceName: renderApproval.spaceName,
    });
  }, [renderApproval]);

  // Blocked-action context for the principle picker. Null when Safety Rules
  // didn't block this write (clean-pass path — no picker needed).
  const blockedAction = useMemo(() => {
    if (!renderApproval) return null;
    if (renderApproval.blockedBy === 'unknown') return null;
    return buildMemoryBlockedAction({
      spaceName: renderApproval.spaceName,
      filePath: renderApproval.filePath,
      sharing: renderApproval.sharing,
      spacePath: renderApproval.spacePath,
      location: location ?? undefined,
      contentSummary: renderApproval.summary,
    });
  }, [location, renderApproval]);

  // S4 — track in-flight state so primary-action buttons disable
  // between tap and resolution. Resets when the approval identity
  // changes (new sheet = new submit session).
  const [isSubmitting, setIsSubmitting] = useState(false);
  useEffect(() => {
    setIsSubmitting(false);
  }, [approvalId]);

  const handleAllowSuccess = useCallback(() => {
    if (!renderApproval) return;
    setIsSubmitting(true);
    onSave(renderApproval);
    onClose();
  }, [renderApproval, onSave, onClose]);

  const handleDenySuccess = useCallback(() => {
    if (!renderApproval) return;
    setIsSubmitting(true);
    onSkip(renderApproval);
    onClose();
  }, [renderApproval, onSkip, onClose]);

  const allowPicker = usePrincipleOptions({
    transport,
    blockedAction,
    effectiveToolId: null,
    direction: 'allow',
    onApprove: handleAllowSuccess,
  });

  const denyPicker = usePrincipleOptions({
    transport,
    blockedAction,
    effectiveToolId: null,
    direction: 'deny',
    onApprove: handleAllowSuccess,
    onDeny: handleDenySuccess,
  });

  const openSaveAlways = useCallback(() => {
    setPickerMode('save-always');
    allowPicker.startGeneration();
  }, [allowPicker]);

  const openSkipAlways = useCallback(() => {
    setPickerMode('skip-always');
    denyPicker.startGeneration();
  }, [denyPicker]);

  if (!renderApproval) {
    return null;
  }

  const isBlocked = blockedAction !== null;
  const blockReason = blockedAction?.blockReason ?? renderApproval.blockedBy;

  return (
    <ApprovalSheetShell
      visible={visible}
      onClose={onClose}
      title="Review memory update"
      testID="memory-approval-sheet"
    >
      {location ? <FileLocationBadge location={location} /> : null}
      <View style={s.metaRow}>
        <Feather name="clock" size={12} color={colors.textTertiary} />
        <Text testID="memory-approval-sheet-timestamp" style={s.metaText}>
          {formatRelativeTime(renderApproval.timestamp)}
        </Text>
      </View>

      <Text style={s.summary}>{renderApproval.summary}</Text>

      {isBlocked ? (
        <View testID="memory-approval-sheet-blocked" style={s.blockedBlock}>
          <Text style={s.blockedTitle}>Blocked by Safety Rules</Text>
          <Text style={s.blockedText}>{blockReason}</Text>
        </View>
      ) : null}

      <Text style={s.sectionTitle}>Proposed content</Text>
      {contentLoading ? (
        <View testID="memory-approval-sheet-loading" style={s.loadingRow}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={s.loadingText}>Loading current version…</Text>
        </View>
      ) : contentError ? (
        <View testID="memory-approval-sheet-error" style={s.errorBlock}>
          <Text style={s.errorText}>
            Couldn&apos;t load the current version — {contentError.kind === 'permission'
              ? 'permission denied.'
              : contentError.kind === 'network'
                ? 'network error.'
                : contentError.kind === 'binary'
                  ? "the file isn't previewable here."
                  : 'try again.'}
          </Text>
          {/* S5 — retry affordance for content-fetch failure. */}
          <TouchableOpacity
            testID="memory-approval-sheet-error-retry"
            style={s.outlineButton}
            onPress={refetchContent}
            accessibilityRole="button"
            accessibilityLabel="Try loading the current version again"
            activeOpacity={0.7}
          >
            <Text style={s.outlineText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : original && proposedContent ? (
        <View style={s.contentBlock}>
          <MobileDiffView before={original} after={proposedContent} expanded />
        </View>
      ) : (
        <View style={s.contentBlock}>
          <Text testID="memory-approval-sheet-content" style={s.plainText}>
            {proposedContent || '(No content)'}
          </Text>
        </View>
      )}

      {pickerMode === 'save-always' ? (
        <PrincipleOptionsPicker
          {...allowPicker}
          key={`allow-${renderApproval.toolUseId}`}
          testIDPrefix="memory-approval-sheet-allow-picker"
        />
      ) : null}

      {pickerMode === 'skip-always' ? (
        <PrincipleOptionsPicker
          {...denyPicker}
          key={`deny-${renderApproval.toolUseId}`}
          testIDPrefix="memory-approval-sheet-deny-picker"
        />
      ) : null}

      <View style={s.actionsPrimaryRow}>
        <TouchableOpacity
          testID="memory-approval-sheet-skip"
          style={[s.outlineButton, isSubmitting && s.primaryButtonDisabled]}
          onPress={() => {
            hapticWarning();
            handleDenySuccess();
          }}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Skip memory update"
          accessibilityState={{ disabled: isSubmitting }}
          activeOpacity={0.7}
        >
          <Text style={s.outlineText}>Skip</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="memory-approval-sheet-save"
          style={[s.primaryButton, isSubmitting && s.primaryButtonDisabled]}
          onPress={() => {
            hapticMedium();
            handleAllowSuccess();
          }}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Save memory update"
          accessibilityState={{ disabled: isSubmitting }}
          activeOpacity={0.8}
        >
          <Feather name="check" size={14} color="#fff" />
          <Text style={s.primaryText}>Save</Text>
        </TouchableOpacity>
      </View>

      {isBlocked && pickerMode === 'none' ? (
        <View style={s.actionsAlwaysRow}>
          <TouchableOpacity
            testID="memory-approval-sheet-skip-always"
            style={s.outlineButton}
            onPress={openSkipAlways}
            accessibilityRole="button"
            accessibilityLabel="Skip memory update and remember this rule"
            activeOpacity={0.7}
          >
            <Text style={s.outlineText}>Skip always</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="memory-approval-sheet-save-always"
            style={s.outlineButton}
            onPress={openSaveAlways}
            accessibilityRole="button"
            accessibilityLabel="Save and remember this rule"
            activeOpacity={0.7}
          >
            <Text style={s.outlineText}>Save always</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </ApprovalSheetShell>
  );
});

MemoryApprovalSheet.displayName = 'MemoryApprovalSheet';

export default MemoryApprovalSheet;
