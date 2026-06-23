import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Tooltip } from '@renderer/components/ui';
import {
  ConversationFeedbackGetResponseSchema,
  type ConversationVote,
} from '@shared/ipc/schemas';
import { ConversationStarRating } from './ConversationStarRating';
import { ConversationFeedbackDialog } from './ConversationFeedbackDialog';
import styles from './ConversationFeedbackPrompt.module.css';

type ConversationFeedbackPromptProps = {
  sessionId: string;
  isBusy: boolean;
  messageCount: number;
  isOnboardingCoachActive?: boolean;
  anchorMessageId?: string;
  anchorTurnId?: string | null;
  anchorMessageIndex?: number;
  className?: string;
  showToast?: (options: { title: string; description?: string; variant?: 'destructive' }) => void;
};

function parseConversationVotes(response: unknown): ConversationVote[] | null {
  const parsed = ConversationFeedbackGetResponseSchema.safeParse(response);
  if (!parsed.success) {
    console.error('Invalid conversation feedback state:', parsed.error);
    return null;
  }
  return parsed.data.votes;
}

export function ConversationFeedbackPrompt({
  sessionId,
  isBusy,
  messageCount,
  isOnboardingCoachActive = false,
  anchorMessageId,
  anchorTurnId,
  anchorMessageIndex,
  className,
  showToast,
}: ConversationFeedbackPromptProps) {
  const [votes, setVotes] = useState<ConversationVote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasLoadError, setHasLoadError] = useState(false);
  const [draftRating, setDraftRating] = useState<1 | 2 | 3 | 4 | 5>(3);
  const [dialogOpen, setDialogOpen] = useState(false);
  const ratingGroupContainerRef = useRef<HTMLDivElement | null>(null);

  const canRender = useMemo(() => {
    if (!sessionId) return false;
    if (isBusy) return false;
    if (isOnboardingCoachActive) return false;
    return true;
  }, [isBusy, isOnboardingCoachActive, sessionId]);

  const loadVotes = useCallback(async (): Promise<void> => {
    const api = window.feedbackApi;
    if (!api) {
      setHasLoadError(true);
      setLoaded(true);
      return;
    }

    const state = await api.conversationGet({ sessionId });
    const parsedVotes = parseConversationVotes(state);
    if (!parsedVotes) {
      setVotes([]);
      setHasLoadError(true);
      setLoaded(true);
      return;
    }

    setVotes(parsedVotes);
    setHasLoadError(false);
    setLoaded(true);
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!canRender) {
        setVotes([]);
        setHasLoadError(false);
        setLoaded(false);
        return;
      }

      setLoaded(false);
      try {
        await loadVotes();
        if (cancelled) return;
      } catch (e) {
        console.error('Failed to load conversation feedback state:', e);
        if (cancelled) return;
        setHasLoadError(true);
        setLoaded(true);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [canRender, loadVotes, sessionId]);

  useEffect(() => {
    setDialogOpen(false);
  }, [sessionId]);

  const messageCountBucket = useMemo(() => {
    if (messageCount <= 0) return '0';
    if (messageCount <= 5) return '1-5';
    if (messageCount <= 15) return '6-15';
    if (messageCount <= 40) return '16-40';
    return '40+';
  }, [messageCount]);

  const latestVote = votes[0] ?? null;
  const historyCount = votes.length;
  const shouldShowHistoryPill = historyCount >= 2;
  const historyPreview = votes.slice(0, 5);
  const olderVoteCount = Math.max(0, historyCount - historyPreview.length);
  const historyTitle = `Rated ${historyCount} times`;
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }), []);

  const handleSelectRating = useCallback((rating: 1 | 2 | 3 | 4 | 5) => {
    setDraftRating(rating);
    setDialogOpen(true);
  }, []);

  const refreshVotesAfterSubmit = useCallback(async () => {
    try {
      await loadVotes();
    } catch (error) {
      console.error('Failed to refresh conversation feedback votes:', error);
      setHasLoadError(true);
    }
  }, [loadVotes]);

  const handleDialogOpenChange = useCallback((open: boolean) => {
    setDialogOpen(open);
    if (open) return;

    const requestedRating = draftRating;
    requestAnimationFrame(() => {
      const target = ratingGroupContainerRef.current?.querySelector<HTMLButtonElement>(
        `[data-rating="${requestedRating}"]`,
      );
      target?.focus();
    });
  }, [draftRating]);

  if (!canRender || !loaded || hasLoadError) {
    return null;
  }

  return (
    <div className={`${styles.container} ${className ?? ''}`} aria-label="Conversation feedback prompt">
      <span className={styles.label}>How was this response?</span>
      <div ref={ratingGroupContainerRef} className={styles.ratingGroup}>
        <ConversationStarRating
          value={latestVote?.rating ?? null}
          onSelect={handleSelectRating}
          size="sm"
          testIdPrefix="conversation-feedback-stars"
        />
      </div>
      {shouldShowHistoryPill ? (
        <Tooltip
          delayShow={0}
          maxWidth="280px"
          content={(
            <div className={styles.historyTooltip} data-testid="conversation-feedback-history-tooltip">
              <p className={styles.historyTitle}>{historyTitle}</p>
              <ul className={styles.historyList}>
                {historyPreview.map((vote) => (
                  <li
                    key={vote.voteId}
                    className={styles.historyListItem}
                    data-testid="conversation-feedback-history-item"
                  >
                    {vote.rating} {vote.rating === 1 ? 'star' : 'stars'} · {timeFormatter.format(vote.ratedAt)}
                  </li>
                ))}
              </ul>
              {olderVoteCount > 0 ? (
                <p className={styles.historyOlder}>{`+${olderVoteCount} older`}</p>
              ) : null}
            </div>
          )}
        >
          <Button
            type="button"
            variant="outline"
            size="xs"
            className={styles.historyPill}
            data-testid="conversation-feedback-history-pill"
          >
            {historyCount}×
          </Button>
        </Tooltip>
      ) : null}

      <ConversationFeedbackDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        sessionId={sessionId}
        draftRating={draftRating}
        anchorMessageId={anchorMessageId}
        anchorTurnId={anchorTurnId ?? undefined}
        anchorMessageIndex={anchorMessageIndex}
        messageCountBucket={messageCountBucket}
        showToast={showToast}
        onSubmitted={refreshVotesAfterSubmit}
      />
    </div>
  );
}

