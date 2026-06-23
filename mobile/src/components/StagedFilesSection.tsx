import { memo, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { StagedFile } from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { StagedFileCard } from './StagedFileCard';

const typography = createTypography(true);

type Props = {
  files: StagedFile[];
  onPublishFile: (id: string) => Promise<void>;
  onDiscardFile: (id: string) => Promise<void>;
  onKeepPrivateFile: (id: string) => Promise<void>;
  onPublishAll?: () => Promise<void>;
  onDiscardAll?: () => Promise<void>;
  /** Invoked when the user taps "Resolve with Rebel" on a conflicting file (Stage 6). */
  onResolveWithRebel?: (file: StagedFile) => void;
  /** Invoked when the user taps "Keep mine" on a conflicting file. */
  onKeepMine?: (file: StagedFile) => void;
  /** Invoked when the user taps "Keep theirs" on a conflicting file. */
  onKeepTheirs?: (file: StagedFile) => void;
  /**
   * Open-for-details handler (Stage D). When provided, tapping a staged-file
   * card body opens the detail sheet via the inbox's `ApprovalSheetHost`.
   */
  onOpenFile?: (file: StagedFile) => void;
  /** When false, disables conflict actions with a "Requires online" hint. */
  isOnline?: boolean;
  actionError?: string | null;
};

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    section: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
      gap: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      marginBottom: 4,
    },
    sectionTitle: {
      ...typography.overline,
      fontSize: 13,
      fontWeight: '700',
      color: colors.textTertiary,
      letterSpacing: 1.5,
    },
    errorText: {
      ...typography.caption,
      color: colors.error,
      textAlign: 'center',
    },
    batchActions: {
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

export const StagedFilesSection = memo(function StagedFilesSection({
  files,
  onPublishFile,
  onDiscardFile,
  onKeepPrivateFile,
  onPublishAll,
  onDiscardAll,
  onResolveWithRebel,
  onKeepMine,
  onKeepTheirs,
  onOpenFile,
  isOnline = true,
  actionError,
}: Props) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const showBatchActions = files.length > 1 && (onPublishAll || onDiscardAll);

  if (files.length === 0) {
    return null;
  }

  return (
    <View testID="staged-files-section" style={s.section}>
      <Text style={s.sectionTitle}>Files ready to save</Text>

      {actionError ? <Text style={s.errorText}>{actionError}</Text> : null}

      {showBatchActions ? (
        <View style={s.batchActions}>
          {onDiscardAll ? (
            <TouchableOpacity
              testID="staged-files-discard-all"
              style={s.outlineButton}
              onPress={() => void onDiscardAll()}
              activeOpacity={0.7}
            >
              <Text style={s.outlineText}>Discard All</Text>
            </TouchableOpacity>
          ) : null}
          {onPublishAll ? (
            <TouchableOpacity
              testID="staged-files-save-all"
              style={s.saveButton}
              onPress={() => void onPublishAll()}
              activeOpacity={0.7}
            >
              <Text style={s.saveText}>Save All</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {files.map((file) => (
        <StagedFileCard
          key={file.id}
          file={file}
          onPublish={() => void onPublishFile(file.id)}
          onDiscard={() => void onDiscardFile(file.id)}
          onKeepPrivate={() => void onKeepPrivateFile(file.id)}
          onResolveWithRebel={onResolveWithRebel}
          onKeepMine={onKeepMine}
          onKeepTheirs={onKeepTheirs}
          onOpen={onOpenFile}
          isOnline={isOnline}
        />
      ))}
    </View>
  );
});
