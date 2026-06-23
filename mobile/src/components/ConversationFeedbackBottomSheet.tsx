import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as cloudClient from '@rebel/cloud-client';
import { slugifyChip } from '@shared/data/conversationFeedbackChips';

import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { radius, spacing } from '../theme/tokens';
import { ApprovalSheetShell } from './approval/ApprovalSheetShell';
import { ConversationFeedbackChips } from './ConversationFeedbackChips';
import { ConversationStarRating, type ConversationStarValue } from './ConversationStarRating';
import { Pressable } from './Pressable';

const typography = createTypography(true);
const MAX_COMMENT_LENGTH = 1500;

type RatingBucket = 'negative' | 'neutral' | 'positive';

type RatingBucketCopy = {
  title: string;
  subtitle: string;
  textareaLabel: string;
  placeholder: string;
};

type ToastOptions = {
  title: string;
  description?: string;
  variant?: 'destructive';
};

const RATING_BUCKET_COPY: Record<RatingBucket, RatingBucketCopy> = {
  negative: {
    title: 'Tell us what went wrong',
    subtitle: 'A short note is required so we fix the right thing. Diagnostics are optional if this looked broken.',
    textareaLabel: 'What needs fixing?',
    placeholder: 'e.g., It missed the source I gave it and invented a deadline.',
  },
  neutral: {
    title: 'What would make it better?',
    subtitle: 'Three stars means close, not done. A short note tells us where it missed.',
    textareaLabel: 'What was missing?',
    placeholder: 'e.g., It was mostly right, but needed more detail on the rollout risks.',
  },
  positive: {
    title: 'What made it work?',
    subtitle: 'A short note is required. Tell us what to repeat, before we start guessing.',
    textareaLabel: 'What should Rebel repeat?',
    placeholder: 'e.g., It used the right sources, kept the tone sharp, and saved me an hour.',
  },
};

export interface ConversationFeedbackBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  sessionId: string;
  rating: ConversationStarValue;
  anchorMessageId?: string | null;
  anchorTurnId?: string | null;
  anchorMessageIndex?: number | null;
  onSubmitted?: () => void;
  showToast?: (options: ToastOptions) => void;
}

function bucketForRating(rating: ConversationStarValue): RatingBucket {
  if (rating <= 2) return 'negative';
  if (rating === 3) return 'neutral';
  return 'positive';
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    section: {
      gap: spacing.xs,
    },
    sectionLabel: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    sectionHelper: {
      ...typography.caption,
      color: colors.textSecondary,
    },
    ratingSummaryWrap: {
      gap: spacing.xs,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      color: colors.textPrimary,
      minHeight: 120,
      textAlignVertical: 'top',
      paddingHorizontal: spacing.sm + 4,
      paddingVertical: spacing.sm + 4,
      ...typography.bodySmall,
    },
    counter: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    validationText: {
      ...typography.caption,
      color: colors.error,
      fontWeight: '600',
    },
    diagnosticsBox: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.sm + 4,
      paddingVertical: spacing.sm + 4,
      gap: spacing.xs,
    },
    diagnosticsToggle: {
      minHeight: 44,
      borderRadius: radius.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
    },
    diagnosticsToggleText: {
      ...typography.bodySmall,
      color: colors.textPrimary,
      fontWeight: '600',
    },
    footer: {
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'flex-end',
      marginTop: spacing.xs,
    },
    buttonBase: {
      minHeight: 44,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
    },
    cancelButton: {
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    cancelText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    sendButton: {
      borderColor: colors.accent,
      backgroundColor: colors.accent,
    },
    sendButtonDisabled: {
      opacity: 0.45,
    },
    sendText: {
      ...typography.bodySmall,
      fontWeight: '700',
      color: '#fff',
    },
  });
}

export const ConversationFeedbackBottomSheet = memo(function ConversationFeedbackBottomSheet({
  visible,
  onClose,
  sessionId,
  rating,
  anchorMessageId,
  anchorTurnId,
  anchorMessageIndex,
  onSubmitted,
  showToast,
}: ConversationFeedbackBottomSheetProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [comment, setComment] = useState('');
  const [selectedChips, setSelectedChips] = useState<string[]>([]);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const bucket = bucketForRating(rating);
  const copy = RATING_BUCKET_COPY[bucket];
  const diagnosticsVisible = rating <= 2;
  const trimmedComment = comment.trim();
  const canSubmit = trimmedComment.length > 0 && !isSubmitting;
  const sendButtonDisabled = !canSubmit;

  const resetForm = useCallback(() => {
    setComment('');
    setSelectedChips([]);
    setIncludeDiagnostics(false);
    setAttemptedSubmit(false);
    setIsSubmitting(false);
  }, []);

  useEffect(() => {
    if (!visible) return;
    resetForm();
  }, [rating, resetForm, sessionId, visible]);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  const handleToggleChip = useCallback((chipLabel: string) => {
    setSelectedChips((current) => (
      current.includes(chipLabel)
        ? current.filter((chip) => chip !== chipLabel)
        : [...current, chipLabel]
    ));
  }, []);

  const handleSubmit = useCallback(async () => {
    setAttemptedSubmit(true);
    if (!trimmedComment || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await cloudClient.ipcCall('feedback:conversation-rate', {
        sessionId,
        rating,
        comment: trimmedComment,
        chips: selectedChips.map(slugifyChip),
        anchorMessageId: anchorMessageId ?? undefined,
        anchorTurnId: anchorTurnId ?? undefined,
        anchorMessageIndex: anchorMessageIndex ?? undefined,
        includeDiagnostics: diagnosticsVisible ? includeDiagnostics : false,
      });

      showToast?.({
        title: 'Rating sent',
        description: 'Thanks. This gives us something to work with.',
      });

      onSubmitted?.();
      handleClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not send rating';
      showToast?.({
        title: 'Could not send rating',
        description: message,
        variant: 'destructive',
      });
      setIsSubmitting(false);
    }
  }, [
    anchorMessageId,
    anchorMessageIndex,
    anchorTurnId,
    diagnosticsVisible,
    handleClose,
    includeDiagnostics,
    isSubmitting,
    onSubmitted,
    rating,
    selectedChips,
    sessionId,
    showToast,
    trimmedComment,
  ]);

  return (
    <ApprovalSheetShell
      visible={visible}
      onClose={handleClose}
      title={copy.title}
      subtitle={copy.subtitle}
      testID="conversation-feedback-sheet"
    >
      <View style={s.ratingSummaryWrap}>
        <Text style={s.sectionLabel}>Selected rating</Text>
        <ConversationStarRating
          value={rating}
          interactive={false}
          testIDPrefix="conversation-feedback-summary-stars"
        />
      </View>

      <View style={s.section}>
        <Text style={s.sectionLabel}>What played into the rating?</Text>
        <Text style={s.sectionHelper}>Pick any that apply.</Text>
        <ConversationFeedbackChips
          rating={rating}
          selectedChips={selectedChips}
          onToggleChip={handleToggleChip}
          disabled={isSubmitting}
        />
      </View>

      <View style={s.section}>
        <Text style={s.sectionLabel}>{copy.textareaLabel}</Text>
        <TextInput
          testID="conversation-feedback-comment-input"
          value={comment}
          onChangeText={(nextValue) => {
            if (nextValue.length > MAX_COMMENT_LENGTH) return;
            setComment(nextValue);
          }}
          placeholder={copy.placeholder}
          placeholderTextColor={colors.textTertiary}
          multiline
          editable={!isSubmitting}
          style={s.input}
          accessibilityLabel={copy.textareaLabel}
        />
        <Text style={s.sectionHelper}>Required. One sentence is enough.</Text>
        <Text style={s.counter}>{comment.length}/{MAX_COMMENT_LENGTH}</Text>
        {attemptedSubmit && trimmedComment.length === 0 ? (
          <Text testID="conversation-feedback-inline-validation" style={s.validationText}>
            Add a short note before sending.
          </Text>
        ) : null}
      </View>

      {diagnosticsVisible ? (
        <View testID="conversation-feedback-diagnostics-section" style={s.section}>
          <Text style={s.sectionLabel}>Help us investigate</Text>
          <View style={s.diagnosticsBox}>
            <TouchableOpacity
              testID="conversation-feedback-diagnostics-toggle"
              style={s.diagnosticsToggle}
              onPress={() => setIncludeDiagnostics((current) => !current)}
              disabled={isSubmitting}
              accessibilityRole="checkbox"
              accessibilityLabel="Include diagnostic logs"
              accessibilityState={{ checked: includeDiagnostics, disabled: isSubmitting }}
              activeOpacity={0.8}
            >
              <Feather
                name={includeDiagnostics ? 'check-square' : 'square'}
                size={16}
                color={includeDiagnostics ? colors.accent : colors.textTertiary}
              />
              <Text style={s.diagnosticsToggleText}>Include diagnostic logs</Text>
            </TouchableOpacity>
            <Text style={s.sectionHelper}>
              Diagnostics may contain sensitive information. Attach them only if this looked broken.
            </Text>
          </View>
        </View>
      ) : null}

      <View style={s.footer}>
        <TouchableOpacity
          testID="conversation-feedback-cancel-button"
          style={[s.buttonBase, s.cancelButton]}
          onPress={handleClose}
          disabled={isSubmitting}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          accessibilityState={{ disabled: isSubmitting }}
          activeOpacity={0.8}
        >
          <Text style={s.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Pressable
          testID="conversation-feedback-send-button"
          style={[s.buttonBase, s.sendButton, sendButtonDisabled && s.sendButtonDisabled]}
          onPress={handleSubmit}
          disabled={sendButtonDisabled}
          haptic={false}
          accessibilityRole="button"
          accessibilityLabel="Send rating"
          accessibilityState={{ disabled: sendButtonDisabled }}
        >
          <Text style={s.sendText}>{isSubmitting ? 'Sending…' : 'Send rating'}</Text>
        </Pressable>
      </View>
    </ApprovalSheetShell>
  );
});

ConversationFeedbackBottomSheet.displayName = 'ConversationFeedbackBottomSheet';

export default ConversationFeedbackBottomSheet;
