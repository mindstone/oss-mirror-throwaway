import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as cloudClient from '@rebel/cloud-client';
import { ConversationFeedbackGetResponseSchema, type ConversationVote } from '@shared/ipc/schemas/feedback';

import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { radius, spacing } from '../theme/tokens';
import { ApprovalSheetShell } from './approval/ApprovalSheetShell';
import { ConversationFeedbackBottomSheet } from './ConversationFeedbackBottomSheet';
import { ConversationStarRating, type ConversationStarValue } from './ConversationStarRating';

const typography = createTypography(true);

type ToastOptions = {
  title: string;
  description?: string;
  variant?: 'destructive';
};

export interface ConversationFeedbackPromptProps {
  sessionId: string;
  lastAssistantMessageId: string | null;
  lastAssistantTurnId?: string | null;
  lastAssistantMessageIndex?: number | null;
  isSending?: boolean;
  showToast?: (options: ToastOptions) => void;
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: {
      marginHorizontal: 12,
      marginTop: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.lg,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.sm + 4,
      paddingVertical: spacing.sm + 2,
      gap: spacing.xs + 2,
    },
    lineOne: {
      minHeight: 28,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    label: {
      ...typography.caption,
      color: colors.textSecondary,
      fontWeight: '600',
    },
    historyPill: {
      minHeight: 28,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      paddingHorizontal: spacing.sm + 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    historyPillText: {
      ...typography.caption,
      color: colors.textSecondary,
      fontWeight: '700',
    },
    lineTwo: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
    },
    anchor: {
      ...typography.caption,
      color: colors.textSecondary,
      minWidth: 34,
    },
    starsWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    historyItem: {
      ...typography.bodySmall,
      color: colors.textPrimary,
    },
    historyOlder: {
      ...typography.caption,
      color: colors.textSecondary,
      marginTop: spacing.xs,
    },
    historyContent: {
      gap: spacing.xs + 2,
    },
  });
}

function safeVotesFromResponse(response: unknown): ConversationVote[] {
  const parsed = ConversationFeedbackGetResponseSchema.safeParse(response);
  if (!parsed.success) return [];
  return parsed.data.votes;
}

export const ConversationFeedbackPrompt = memo(function ConversationFeedbackPrompt({
  sessionId,
  lastAssistantMessageId,
  lastAssistantTurnId,
  lastAssistantMessageIndex,
  isSending = false,
  showToast,
}: ConversationFeedbackPromptProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [votes, setVotes] = useState<ConversationVote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [draftRating, setDraftRating] = useState<ConversationStarValue>(3);
  const [feedbackSheetVisible, setFeedbackSheetVisible] = useState(false);
  const [historySheetVisible, setHistorySheetVisible] = useState(false);

  const canRender = useMemo(() => {
    if (!sessionId) return false;
    if (!lastAssistantMessageId) return false;
    if (isSending) return false;
    return true;
  }, [isSending, lastAssistantMessageId, sessionId]);

  const loadVotes = useCallback(async () => {
    const response = await cloudClient.ipcCall('feedback:conversation-get', { sessionId });
    setVotes(safeVotesFromResponse(response));
    setLoadError(false);
    setLoaded(true);
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!canRender) {
        setVotes([]);
        setLoaded(false);
        setLoadError(false);
        return;
      }

      setLoaded(false);
      try {
        await loadVotes();
        if (cancelled) return;
      } catch {
        if (cancelled) return;
        setVotes([]);
        setLoadError(true);
        setLoaded(true);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [canRender, loadVotes]);

  useEffect(() => {
    setFeedbackSheetVisible(false);
    setHistorySheetVisible(false);
  }, [sessionId]);

  const latestVote = votes[0] ?? null;
  const historyCount = votes.length;
  const shouldShowHistoryPill = historyCount >= 2;
  const historyPreview = votes.slice(0, 5);
  const olderVoteCount = Math.max(0, historyCount - historyPreview.length);

  const handleSelectRating = useCallback((rating: ConversationStarValue) => {
    setDraftRating(rating);
    setFeedbackSheetVisible(true);
  }, []);

  const handleSubmitted = useCallback(() => {
    void loadVotes();
  }, [loadVotes]);

  if (!canRender || !loaded || loadError) {
    return null;
  }

  return (
    <>
      <View testID="conversation-feedback-prompt" style={s.container}>
        <View style={s.lineOne}>
          <Text style={s.label}>Rate this conversation</Text>
          {shouldShowHistoryPill ? (
            <TouchableOpacity
              testID="conversation-feedback-history-pill"
              style={s.historyPill}
              onPress={() => setHistorySheetVisible(true)}
              accessibilityRole="button"
              accessibilityLabel={`Rated ${historyCount} times`}
              activeOpacity={0.8}
            >
              <Text style={s.historyPillText}>{historyCount}×</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={s.lineTwo}>
          <Text style={s.anchor}>Bad</Text>
          <View style={s.starsWrap}>
            <ConversationStarRating
              value={latestVote?.rating ?? null}
              onSelect={handleSelectRating}
              testIDPrefix="conversation-feedback-prompt-stars"
            />
          </View>
          <Text style={[s.anchor, { textAlign: 'right' }]}>Great</Text>
        </View>
      </View>

      <ConversationFeedbackBottomSheet
        visible={feedbackSheetVisible}
        onClose={() => setFeedbackSheetVisible(false)}
        sessionId={sessionId}
        rating={draftRating}
        anchorMessageId={lastAssistantMessageId}
        anchorTurnId={lastAssistantTurnId}
        anchorMessageIndex={lastAssistantMessageIndex}
        onSubmitted={handleSubmitted}
        showToast={showToast}
      />

      <ApprovalSheetShell
        visible={historySheetVisible}
        onClose={() => setHistorySheetVisible(false)}
        title="Previous ratings"
        subtitle={`Rated ${historyCount} times`}
        testID="conversation-feedback-history-sheet"
      >
        <View style={s.historyContent}>
          {historyPreview.map((vote) => (
            <Text key={vote.voteId} testID="conversation-feedback-history-item" style={s.historyItem}>
              {vote.rating} {vote.rating === 1 ? 'star' : 'stars'} · {cloudClient.formatRelativeTime(vote.ratedAt)}
            </Text>
          ))}
          {olderVoteCount > 0 ? (
            <Text style={s.historyOlder}>{`+${olderVoteCount} older`}</Text>
          ) : null}
        </View>
      </ApprovalSheetShell>
    </>
  );
});

ConversationFeedbackPrompt.displayName = 'ConversationFeedbackPrompt';

export default ConversationFeedbackPrompt;
