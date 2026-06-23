import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from '@renderer/components/ui';
import { chipsForRating, slugifyChip } from '@shared/data/conversationFeedbackChips';
import { tracking } from '@renderer/src/tracking';
import { ConversationFeedbackChips } from './ConversationFeedbackChips';

type ConversationFeedbackDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  draftRating: ConversationFeedbackRating;
  anchorMessageId?: string;
  anchorTurnId?: string;
  anchorMessageIndex?: number;
  messageCountBucket?: string;
  onSubmitted?: () => void;
  showToast?: (options: { title: string; description?: string; variant?: 'destructive' }) => void;
};

const MAX_COMMENT_LENGTH = 1500;
type ConversationFeedbackRating = 1 | 2 | 3 | 4 | 5;

type RatingBucketCopy = {
  title: string;
  subtitle: string;
  textareaLabel: string;
  placeholder: string;
};

const RATING_BUCKET_COPY: Record<'negative' | 'neutral' | 'positive', RatingBucketCopy> = {
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

function bucketForRating(rating: ConversationFeedbackRating): 'negative' | 'neutral' | 'positive' {
  if (rating <= 2) return 'negative';
  if (rating === 3) return 'neutral';
  return 'positive';
}

function deriveSentimentForTracking(rating: ConversationFeedbackRating): 'positive' | 'neutral' | 'negative' {
  if (rating <= 2) return 'negative';
  if (rating === 3) return 'neutral';
  return 'positive';
}

export function ConversationFeedbackDialog({
  open,
  onOpenChange,
  sessionId,
  draftRating,
  anchorMessageId,
  anchorTurnId,
  anchorMessageIndex,
  messageCountBucket,
  onSubmitted,
  showToast,
}: ConversationFeedbackDialogProps) {
  const [comment, setComment] = useState('');
  const [selectedChips, setSelectedChips] = useState<string[]>([]);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);
  const [commentInteracted, setCommentInteracted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const helperTextId = useId();
  const counterTextId = useId();
  const validationTextId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const diagnosticsVisible = draftRating <= 2;
  const bucketKey = bucketForRating(draftRating);
  const bucketCopy = RATING_BUCKET_COPY[bucketKey];
  const availableChips = useMemo(
    () => chipsForRating(draftRating),
    [draftRating],
  );
  const summaryStars = useMemo(
    () => Array.from({ length: 5 }, (_, index) => (index + 1) as ConversationFeedbackRating),
    [],
  );
  const trimmedComment = comment.trim();
  const canSubmit = trimmedComment.length >= 1 && !isSubmitting;

  const resetForm = useCallback(() => {
    setComment('');
    setSelectedChips([]);
    setIncludeDiagnostics(false);
    setDiagnosticsExpanded(false);
    setAttemptedSubmit(false);
    setCommentInteracted(false);
    setIsSubmitting(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    resetForm();
  }, [draftRating, open, resetForm, sessionId]);

  useEffect(() => {
    if (diagnosticsVisible) return;
    setIncludeDiagnostics(false);
    setDiagnosticsExpanded(false);
  }, [diagnosticsVisible]);

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        resetForm();
      }
      onOpenChange(newOpen);
    },
    [onOpenChange, resetForm]
  );

  const shouldShowInlineValidation = attemptedSubmit && trimmedComment.length === 0;
  const shouldMarkTextareaInvalid = shouldShowInlineValidation && commentInteracted;
  const textareaDescribedBy = [helperTextId, counterTextId, shouldShowInlineValidation ? validationTextId : null]
    .filter(Boolean)
    .join(' ');

  const handleToggleChip = useCallback((label: string) => {
    setSelectedChips((current) => (
      current.includes(label)
        ? current.filter((chip) => chip !== label)
        : [...current, label]
    ));
  }, []);

  const handleSubmit = useCallback(async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    setAttemptedSubmit(true);
    setError(null);

    if (!trimmedComment) {
      return;
    }

    setIsSubmitting(true);

    try {
      const feedbackApi = window.feedbackApi;
      if (!feedbackApi) {
        throw new Error('Feedback system unavailable');
      }

      let diagnosticsMarkdown: string | undefined;
      if (diagnosticsVisible && includeDiagnostics) {
        const diagnosticsExport = await window.systemHealthApi.healthExportWithLogs({
          logWindowMinutes: 15,
        });
        if (!diagnosticsExport.content) {
          throw new Error('Could not include diagnostic logs');
        }
        diagnosticsMarkdown = diagnosticsExport.content;
      }

      let voteSequence = 1;
      try {
        const state = await feedbackApi.conversationGet({ sessionId });
        voteSequence = state.votes.length + 1;
      } catch {
        voteSequence = 1;
      }

      await feedbackApi.conversationRate({
        sessionId,
        rating: draftRating,
        comment: trimmedComment,
        chips: selectedChips,
        anchorMessageId,
        anchorTurnId,
        anchorMessageIndex,
        includeDiagnostics: diagnosticsVisible && includeDiagnostics,
        diagnosticsMarkdown,
      });

      tracking.conversation.feedbackSubmitted(sessionId, draftRating, {
        voteSequence,
        sentiment: deriveSentimentForTracking(draftRating),
        chips: selectedChips.map(slugifyChip),
        hasComment: true,
        includeDiagnostics: diagnosticsVisible && includeDiagnostics,
        messageCountBucket: messageCountBucket ?? 'unknown',
      });

      showToast?.({
        title: 'Rating sent',
        description: 'Thanks. This gives us something to work with.',
      });

      handleOpenChange(false);
      onSubmitted?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not send rating';
      if (mountedRef.current) {
        setError(message);
      }
      showToast?.({ title: 'Could not send rating', description: message, variant: 'destructive' });
    } finally {
      if (mountedRef.current) {
        setIsSubmitting(false);
      }
    }
  }, [
    anchorMessageId,
    anchorMessageIndex,
    anchorTurnId,
    diagnosticsVisible,
    draftRating,
    handleOpenChange,
    includeDiagnostics,
    messageCountBucket,
    onSubmitted,
    selectedChips,
    sessionId,
    showToast,
    trimmedComment,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="md">
        <DialogHeader onClose={() => handleOpenChange(false)}>
          <DialogTitle>{bucketCopy.title}</DialogTitle>
          <DialogDescription>{bucketCopy.subtitle}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} data-testid="conversation-feedback-form">
          <DialogBody>
            <div className="space-y-4">
              <div style={{ pointerEvents: 'none' }}>
                <p className="mb-2 text-xs text-muted-foreground">Selected rating</p>
                <div className="flex items-center gap-1" aria-hidden="true">
                  {summaryStars.map((star) => {
                    const isFilled = star <= draftRating;
                    return (
                      <Star
                        key={star}
                        size={18}
                        className={isFilled ? 'text-primary fill-current' : 'text-muted-foreground'}
                        aria-hidden="true"
                      />
                    );
                  })}
                </div>
              </div>

              <section className="space-y-2">
                <Label>What played into the rating?</Label>
                <p className="text-xs text-muted-foreground">Pick any that apply.</p>
                <ConversationFeedbackChips
                  availableChips={availableChips}
                  selectedChips={selectedChips}
                  onToggle={handleToggleChip}
                />
              </section>

              <section className="space-y-2">
                <Label htmlFor="conversation-feedback-comment">{bucketCopy.textareaLabel}</Label>
                <Textarea
                  id="conversation-feedback-comment"
                  value={comment}
                  required
                  aria-describedby={textareaDescribedBy}
                  aria-invalid={shouldMarkTextareaInvalid || undefined}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    if (nextValue.length > MAX_COMMENT_LENGTH) return;
                    setComment(nextValue);
                    setCommentInteracted(true);
                    if (attemptedSubmit) {
                      setError(null);
                    }
                  }}
                  onBlur={() => setCommentInteracted(true)}
                  rows={4}
                  disabled={isSubmitting}
                  placeholder={bucketCopy.placeholder}
                />
                <p id={helperTextId} className="text-xs text-muted-foreground">
                  Required. One sentence is enough.
                </p>
                <p id={counterTextId} className="text-xs text-muted-foreground">
                  {comment.length}/{MAX_COMMENT_LENGTH}
                </p>
                {shouldShowInlineValidation ? (
                  <div id={validationTextId} role="alert" aria-live="polite" className="text-sm text-destructive">
                    Add a short note before sending.
                  </div>
                ) : null}
              </section>

              {diagnosticsVisible ? (
                <section className="space-y-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-expanded={diagnosticsExpanded}
                    onClick={() => setDiagnosticsExpanded((current) => !current)}
                  >
                    Help us investigate
                  </Button>
                  {diagnosticsExpanded ? (
                    <div className="space-y-2 rounded-md border border-border/60 px-3 py-2">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={includeDiagnostics}
                          onChange={(event) => setIncludeDiagnostics(event.target.checked)}
                          disabled={isSubmitting}
                        />
                        <span>Include diagnostic logs</span>
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Diagnostics may contain sensitive information. Attach them only if this looked broken.
                      </p>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {error ? (
                <div className="text-sm text-destructive" role="alert" aria-live="polite">
                  {error}
                </div>
              ) : null}
            </div>
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => handleOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? 'Sending…' : 'Send rating'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

ConversationFeedbackDialog.displayName = 'ConversationFeedbackDialog';

