import { memo, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { formatRelativeTime, type StagedFile } from '@rebel/cloud-client';
import { legacyMissingLocation } from '@rebel/shared';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { ConflictCallout } from './approval/ConflictCallout';
import { FileLocationBadge } from './FileLocationBadge';

const typography = createTypography(true);

type Props = {
  file: StagedFile;
  onPublish: () => void;
  onDiscard: () => void;
  onKeepPrivate: () => void;
  /**
   * Invoked when the user taps "Resolve with Rebel" on a conflicting
   * file. The caller is expected to build the seed prompt via
   * `buildConversationalResolutionPrompt` and navigate with
   * `?prefill=<seed>`. Optional — omitting it hides the
   * "Resolve with Rebel" action and falls back to the legacy
   * "Conflict" badge-only rendering.
   */
  onResolveWithRebel?: (file: StagedFile) => void;
  /** Direct "keep my staged version" dispatch (fires `resolveConflict(id, 'keep-staged')`). */
  onKeepMine?: (file: StagedFile) => void;
  /** Direct "keep the remote version" dispatch (fires `resolveConflict(id, 'keep-real')`). */
  onKeepTheirs?: (file: StagedFile) => void;
  /** When false, disables primary/secondary conflict actions with a "Requires online" hint. */
  isOnline?: boolean;
  /**
   * Open-for-details handler (Stage D). Tapping anywhere on the card body
   * (outside the action buttons + conflict callout) routes to the sheet
   * host. Inline actions still work as quick-actions.
   */
  onOpen?: (file: StagedFile) => void;
};

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
      gap: 12,
    },
    timestamp: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    headerMain: {
      flex: 1,
      minWidth: 0,
    },
    summary: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    conflictBadge: {
      alignSelf: 'flex-start',
      backgroundColor: `${colors.warning}33`,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    conflictText: {
      ...typography.overline,
      fontWeight: '700',
      color: colors.warning,
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
    saveButton: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 18,
      paddingVertical: 10,
    },
    saveText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: '#fff',
    },
  });
}

export const StagedFileCard = memo(function StagedFileCard({
  file,
  onPublish,
  onDiscard,
  onKeepPrivate,
  onResolveWithRebel,
  onKeepMine,
  onKeepTheirs,
  isOnline = true,
  onOpen,
}: Props) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const stagedTime = useMemo(() => formatRelativeTime(file.stagedAt), [file.stagedAt]);
  const location = useMemo(() => {
    return file.location ?? legacyMissingLocation({
      legacyPath: file.spacePath || file.realPath,
      spaceName: file.spaceName,
    });
  }, [file]);

  // Show the conflict callout when the file conflicts AND the caller has
  // opted-in by passing handlers for the conflict flow. Otherwise fall
  // back to the legacy "Conflict" badge-only rendering (keeps backward
  // compat for consumers that haven't wired the new IPC yet).
  const showConflictCallout =
    file.hasConflict === true
    && onResolveWithRebel !== undefined
    && onKeepMine !== undefined
    && onKeepTheirs !== undefined;

  const handleOpenPress = onOpen ? () => onOpen(file) : undefined;

  return (
    <TouchableOpacity
      testID={`staged-file-card-${file.id}`}
      style={s.card}
      onPress={handleOpenPress}
      activeOpacity={handleOpenPress ? 0.7 : 1}
      disabled={!handleOpenPress}
      accessibilityRole="button"
      accessibilityLabel={`Review staged change in ${file.spaceName}`}
    >
      <View style={s.cardHeader}>
        <View style={s.headerMain}>
          <FileLocationBadge location={location} />
        </View>
        <Text style={s.timestamp}>{stagedTime}</Text>
      </View>
      <Text style={s.summary}>{file.summary}</Text>

      {file.hasConflict && !showConflictCallout ? (
        <View style={s.conflictBadge}>
          <Text style={s.conflictText}>Conflict</Text>
        </View>
      ) : null}

      {showConflictCallout ? (
        <ConflictCallout
          onResolveWithRebel={() => onResolveWithRebel!(file)}
          onKeepMine={() => onKeepMine!(file)}
          onKeepTheirs={() => onKeepTheirs!(file)}
          isOnline={isOnline}
        />
      ) : null}

      <View style={s.actions}>
        <TouchableOpacity
          testID={`staged-file-discard-${file.id}`}
          style={s.outlineButton}
          onPress={onDiscard}
          activeOpacity={0.7}
        >
          <Text style={s.outlineText}>Discard</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`staged-file-keep-private-${file.id}`}
          style={s.outlineButton}
          onPress={onKeepPrivate}
          activeOpacity={0.7}
        >
          <Text style={s.outlineText}>Keep Private</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`staged-file-save-${file.id}`}
          style={s.saveButton}
          onPress={onPublish}
          activeOpacity={0.7}
        >
          <Text style={s.saveText}>Save</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
});
