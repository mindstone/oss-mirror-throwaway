/**
 * StagedFileApprovalSheet — detail bottom sheet for `CloudStagedToolCall`-
 * backed staged-file approvals.
 *
 * Rendered when the user taps a staged-file card in the inbox. Shows:
 *  - Space name + file path + summary (card-in-card continuity with the tap)
 *  - A visual diff (via `MobileDiffView`, first user-visible mount)
 *  - `ConflictCallout` with Keep-mine / Keep-theirs / Resolve-with-Rebel
 *    when `hasConflict` is true
 *  - Primary Save / Discard / Keep-Private buttons
 *
 * Stage D of `docs/plans/260417_approval_consolidation_closeout.md`. Data
 * fetching is delegated to the shared `useApprovalContent` hook (Stage 2)
 * so staged + remote content is loaded once. The sheet is purely
 * presentational — action side effects flow through callbacks the inbox
 * host binds to `useStagedFilesStore`.
 *
 * Capability-token integration: when the user taps Keep-mine / Keep-theirs
 * / Resolve-with-Rebel on a conflict, the sheet delegates to the host's
 * handlers which mint a fresh capability token via the store before each
 * resolve call (Stage B). Pre-minted tokens are never reused — every tap
 * rings a new one so the server can one-time-use-revoke them.
 *
 * Cross-surface sync: the host observes `stagedFiles` from the store and
 * closes the sheet when the selected file is removed (another session
 * resolved the item). The sheet itself is stateless re: "am I still
 * valid?" — the host decides.
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
  type StagedFile,
} from '@rebel/cloud-client';
import { legacyMissingLocation } from '@rebel/shared';

import { useColors, type ColorTokens } from '../../theme/colors';
import { createTypography } from '../../theme/typography';
import { hapticMedium, hapticWarning } from '../../utils/haptics';
import { useMobileApprovalTransport } from '../../transport/mobileApprovalTransport';
import { ApprovalSheetShell } from './ApprovalSheetShell';
import { ConflictCallout } from './ConflictCallout';
import { MobileDiffView } from './MobileDiffView';
import { PrincipleOptionsPicker } from './PrincipleOptionsPicker';
import { FileLocationBadge } from '../FileLocationBadge';

type PickerMode = 'none' | 'save-always' | 'deny-always';

const typography = createTypography(true);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StagedFileApprovalSheetProps {
  file: StagedFile | null;
  visible: boolean;
  onClose: () => void;
  /** Save (publish) — fires `useStagedFilesStore.publishFile`. */
  onPublish: (file: StagedFile) => void;
  /** Discard the staged change entirely. */
  onDiscard: (file: StagedFile) => void;
  /** Keep the staged file private — don't publish, keep it local. */
  onKeepPrivate: (file: StagedFile) => void;
  /**
   * Kick off the conversational conflict-resolution flow (host mints token,
   * builds seed prompt, navigates to session).
   */
  onResolveWithRebel: (file: StagedFile) => void;
  /** Direct "keep my staged version" — host mints token + calls resolveConflict. */
  onKeepMine: (file: StagedFile) => void;
  /** Direct "keep the remote version" — host mints token + calls resolveConflict. */
  onKeepTheirs: (file: StagedFile) => void;
  /** Global online state — disables conflict + publish actions when offline. */
  isOnline: boolean;
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
    sectionTitle: {
      ...typography.overline,
      fontSize: 13,
      fontWeight: '700',
      color: colors.textTertiary,
      letterSpacing: 1.5,
    },
    diffWrapper: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 10,
      backgroundColor: colors.surface,
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
    actions: {
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
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const StagedFileApprovalSheet = memo(function StagedFileApprovalSheet({
  file,
  visible,
  onClose,
  onPublish,
  onDiscard,
  onKeepPrivate,
  onResolveWithRebel,
  onKeepMine,
  onKeepTheirs,
  isOnline,
}: StagedFileApprovalSheetProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const transport = useMobileApprovalTransport();

  // F-D-R2-4 (cross-surface close animation) — snapshot the last
  // non-null file so that when the store drops the item mid-animation
  // the sheet can keep rendering through the slide-out. The host flips
  // `visible` to false on the same tick the store drops the item; if
  // we early-returned `null` here the Modal would unmount before the
  // animation could play. With the snapshot we keep rendering the
  // previous file content while the Modal animates out, then return
  // null on the next idle render once animation is complete.
  const lastFileRef = useRef<StagedFile | null>(null);
  if (file) lastFileRef.current = file;
  const renderFile = file ?? lastFileRef.current;

  // F-D-R2-3 — reset local picker mode when the host swaps to a new file.
  const fileIdentity = file?.id ?? null;
  const [pickerMode, setPickerMode] = useState<PickerMode>('none');
  useEffect(() => {
    setPickerMode('none');
  }, [fileIdentity]);

  // S4 — in-flight disable for primary-action buttons.
  const [isSubmitting, setIsSubmitting] = useState(false);
  useEffect(() => {
    setIsSubmitting(false);
  }, [fileIdentity]);

  const {
    staged,
    original,
    loading: contentLoading,
    error: contentError,
    isNewFile,
    refetch: refetchContent,
  } = useApprovalContent(file, {
    readStagedContent: (id) =>
      ipcCall<{ content: string | null; error?: string }>(
        'memory:staging-get-content',
        { id },
      ),
    readWorkspaceFile: (path) => readWorkspaceFile(path),
  });

  // F-D-R2-10 — safety-prompt blocked path. When the staged file was
  // blocked by Safety Rules we expose Allow-always / Deny-always
  // actions that open the shared PrincipleOptionsPicker. Mirrors the
  // desktop `StagedFilePreviewDialog` wiring.
  const isSafetyPromptBlocked = renderFile?.blockedBy === 'safety_prompt';
  const location = useMemo(() => {
    if (!renderFile) return null;
    return renderFile.location ?? legacyMissingLocation({
      legacyPath: renderFile.spacePath || renderFile.realPath,
      spaceName: renderFile.spaceName,
    });
  }, [renderFile]);
  const blockedAction = useMemo(() => {
    if (!renderFile || !isSafetyPromptBlocked) return null;
    return buildMemoryBlockedAction({
      spaceName: renderFile.spaceName,
      filePath: renderFile.realPath,
      sharing: renderFile.sharing,
      spacePath: renderFile.spacePath,
      location: location ?? undefined,
      contentSummary: renderFile.summary,
    });
  }, [location, renderFile, isSafetyPromptBlocked]);

  const handlePublishInternal = useCallback(() => {
    if (!renderFile) return;
    setIsSubmitting(true);
    onPublish(renderFile);
  }, [renderFile, onPublish]);

  const handleDiscardInternal = useCallback(() => {
    if (!renderFile) return;
    setIsSubmitting(true);
    onDiscard(renderFile);
  }, [renderFile, onDiscard]);

  const allowPicker = usePrincipleOptions({
    transport,
    blockedAction,
    effectiveToolId: null,
    direction: 'allow',
    // Picker success = user opted for durable allow rule → publish the file.
    onApprove: handlePublishInternal,
  });

  const denyPicker = usePrincipleOptions({
    transport,
    blockedAction,
    effectiveToolId: null,
    direction: 'deny',
    onApprove: handlePublishInternal,
    // Picker success (deny direction) = user opted for durable deny rule → discard.
    onDeny: handleDiscardInternal,
  });

  const openSaveAlways = useCallback(() => {
    setPickerMode('save-always');
    allowPicker.startGeneration();
  }, [allowPicker]);

  const openDenyAlways = useCallback(() => {
    setPickerMode('deny-always');
    denyPicker.startGeneration();
  }, [denyPicker]);

  const disabled = !isOnline;

  // Nothing to render yet — no `file` prop AND no prior snapshot. First
  // render before the host populates `file`, or never-opened.
  if (!renderFile) {
    return null;
  }

  const hasConflict = renderFile.hasConflict === true;

  return (
    <ApprovalSheetShell
      visible={visible}
      onClose={onClose}
      title="Review staged change"
      testID="staged-file-approval-sheet"
    >
      {location ? <FileLocationBadge location={location} /> : null}
      <View style={s.metaRow}>
        <Feather name="clock" size={12} color={colors.textTertiary} />
        <Text testID="staged-file-approval-sheet-staged-at" style={s.metaText}>
          Staged {formatRelativeTime(renderFile.stagedAt)}
        </Text>
      </View>

      <Text style={s.summary}>{renderFile.summary}</Text>

      {hasConflict ? (
        <ConflictCallout
          onResolveWithRebel={() => onResolveWithRebel(renderFile)}
          onKeepMine={() => onKeepMine(renderFile)}
          onKeepTheirs={() => onKeepTheirs(renderFile)}
          isOnline={isOnline}
        />
      ) : null}

      <Text style={s.sectionTitle}>Changes</Text>
      {contentLoading ? (
        <View testID="staged-file-approval-sheet-loading" style={s.loadingRow}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={s.loadingText}>Loading content…</Text>
        </View>
      ) : contentError ? (
        <View testID="staged-file-approval-sheet-error" style={s.errorBlock}>
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
            testID="staged-file-approval-sheet-error-retry"
            style={s.outlineButton}
            onPress={refetchContent}
            accessibilityRole="button"
            accessibilityLabel="Try loading the current version again"
            activeOpacity={0.7}
          >
            <Text style={s.outlineText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={s.diffWrapper}>
          <MobileDiffView
            before={original ?? ''}
            after={staged ?? ''}
            expanded
          />
          {isNewFile ? (
            <Text testID="staged-file-approval-sheet-new-file" style={s.metaText}>
              New file
            </Text>
          ) : null}
        </View>
      )}

      {/* F-D-R2-10 — safety-prompt blocked: principle pickers. */}
      {isSafetyPromptBlocked && pickerMode === 'save-always' ? (
        <PrincipleOptionsPicker
          {...allowPicker}
          key={`allow-${renderFile.id}`}
          testIDPrefix="staged-file-approval-sheet-allow-picker"
        />
      ) : null}

      {isSafetyPromptBlocked && pickerMode === 'deny-always' ? (
        <PrincipleOptionsPicker
          {...denyPicker}
          key={`deny-${renderFile.id}`}
          testIDPrefix="staged-file-approval-sheet-deny-picker"
        />
      ) : null}

      <View style={s.actions}>
        <TouchableOpacity
          testID="staged-file-approval-sheet-discard"
          style={[s.outlineButton, isSubmitting && s.primaryButtonDisabled]}
          onPress={() => {
            hapticWarning();
            handleDiscardInternal();
          }}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Discard staged change"
          accessibilityState={{ disabled: isSubmitting }}
          activeOpacity={0.7}
        >
          <Text style={s.outlineText}>Discard</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="staged-file-approval-sheet-keep-private"
          style={[s.outlineButton, isSubmitting && s.primaryButtonDisabled]}
          onPress={() => {
            hapticMedium();
            setIsSubmitting(true);
            onKeepPrivate(renderFile);
          }}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Keep staged change private"
          accessibilityState={{ disabled: isSubmitting }}
          activeOpacity={0.7}
        >
          <Text style={s.outlineText}>Keep private</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="staged-file-approval-sheet-save"
          style={[
            s.primaryButton,
            (disabled || hasConflict || isSubmitting) && s.primaryButtonDisabled,
          ]}
          onPress={() => {
            hapticMedium();
            handlePublishInternal();
          }}
          disabled={disabled || hasConflict || isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Save staged change"
          accessibilityState={{ disabled: disabled || hasConflict || isSubmitting }}
          activeOpacity={0.8}
        >
          <Feather name="check" size={14} color="#fff" />
          <Text style={s.primaryText}>Save</Text>
        </TouchableOpacity>
      </View>

      {/*
       * F-D-R2-10 — safety-prompt "always" actions. Only shown when a
       * picker isn't already open; mirrors MemoryApprovalSheet's row.
       */}
      {isSafetyPromptBlocked && pickerMode === 'none' && !hasConflict ? (
        <View style={s.actions}>
          <TouchableOpacity
            testID="staged-file-approval-sheet-deny-always"
            style={s.outlineButton}
            onPress={openDenyAlways}
            accessibilityRole="button"
            accessibilityLabel="Deny and remember this rule"
            activeOpacity={0.7}
          >
            <Text style={s.outlineText}>Deny always</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="staged-file-approval-sheet-save-always"
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

StagedFileApprovalSheet.displayName = 'StagedFileApprovalSheet';

export default StagedFileApprovalSheet;
