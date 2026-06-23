/**
 * Community Win Card
 *
 * Celebrates a session win and offers to share it with the Rebels community.
 * Design philosophy: Celebrate first, ask second. Warm amber accent, stat-card feel.
 * State machine: eligible → composing → preview → shared
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { X, ExternalLink, Copy, ChevronRight } from 'lucide-react';
import type { CommunityShareEligibility, CommunitySharePreview, CommunityShareCardState } from '@shared/types';
import { Tooltip } from '@renderer/components/ui';
import styles from './CommunityWinCard.module.css';

type CommunityWinCardProps = {
  eligibility: CommunityShareEligibility;
  onPreviewAndShare: () => Promise<CommunitySharePreview | null>;
  onOpenDiscourse: () => Promise<void>;
  onDismiss: () => void;
  onOptOut: () => void;
};

const AUTO_DISMISS_MS = 8_000;

export const CommunityWinCard = ({
  eligibility,
  onPreviewAndShare,
  onOpenDiscourse,
  onDismiss,
  onOptOut
}: CommunityWinCardProps) => {
  const [collapsed, setCollapsed] = useState(false);
  const [cardState, setCardState] = useState<CommunityShareCardState>('eligible');
  const [preview, setPreview] = useState<CommunitySharePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOptOutConfirmation, setShowOptOutConfirmation] = useState(false);
  const autoDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss after share
  useEffect(() => {
    if (cardState === 'shared') {
      autoDismissTimer.current = setTimeout(onDismiss, AUTO_DISMISS_MS);
    }
    return () => {
      if (autoDismissTimer.current) clearTimeout(autoDismissTimer.current);
    };
  }, [cardState, onDismiss]);

  const handlePreviewAndShare = useCallback(async () => {
    setCardState('composing');
    setError(null);
    try {
      const result = await onPreviewAndShare();
      if (result) {
        setPreview(result);
        setCardState('preview');
      } else {
        setError('Could not compose the post. Try again?');
        setCardState('eligible');
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Something went wrong. Try again?');
      setCardState('eligible');
    }
  }, [onPreviewAndShare]);

  const handleOpenDiscourse = useCallback(async () => {
    try {
      await onOpenDiscourse();
      setCardState('shared');
    } catch {
      setError('Could not open the browser. Try again?');
    }
  }, [onOpenDiscourse]);

  const handleOptOut = useCallback(() => {
    setShowOptOutConfirmation(true);
    setTimeout(() => {
      onOptOut();
    }, 1500);
  }, [onOptOut]);

  // Collapsed state
  if (collapsed) {
    return (
      <button
        type="button"
        className={styles.collapsed}
        onClick={() => setCollapsed(false)}
      >
        <span className={styles.collapsedIcon}>🏆</span>
        <span className={styles.collapsedText}>Show community share</span>
      </button>
    );
  }

  // Opt-out confirmation (brief inline message before hiding)
  if (showOptOutConfirmation) {
    return (
      <div className={styles.card}>
        <div className={styles.accent} aria-hidden />
        <div className={styles.body}>
          <p className={styles.optOutConfirmation}>
            Understood. Your wins stay between us.
          </p>
        </div>
      </div>
    );
  }

  // Shared state: confirmation after browser opened
  if (cardState === 'shared') {
    return (
      <div className={styles.card}>
        <div className={styles.accent} aria-hidden />
        <div className={styles.body}>
          <p className={styles.confirmationState}>
            Copied to clipboard. Discourse is waiting.
          </p>
          <button
            type="button"
            className={styles.confirmationLink}
            onClick={handleOpenDiscourse}
          >
            Open Show &amp; Tell
            <ExternalLink size={12} />
          </button>
        </div>
        <Tooltip content="Close">
          <button
            type="button"
            className={styles.dismiss}
            onClick={onDismiss}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>
    );
  }

  // Preview state: composed post ready for review
  if (cardState === 'preview' && preview) {
    return (
      <div className={styles.card}>
        <div className={styles.accent} aria-hidden />
        <div className={styles.body}>
          <div className={styles.previewSection}>
            <p className={styles.previewTitle}>{preview.title}</p>
            <div className={styles.previewBody}>{preview.body}</div>
          </div>
          <p className={styles.privacyNote}>
            Nothing is posted until you click Post in your browser.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryAction}
              onClick={handleOpenDiscourse}
            >
              <Copy size={13} />
              Copy &amp; Open Show &amp; Tell
              <ExternalLink size={13} />
            </button>
            <button
              type="button"
              className={styles.secondaryAction}
              onClick={() => {
                setCardState('eligible');
                setPreview(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
        <Tooltip content="Dismiss">
          <button
            type="button"
            className={styles.dismiss}
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>
    );
  }

  // Eligible / Composing state (initial card)
  return (
    <div className={styles.card}>
      <div className={styles.accent} aria-hidden />

      <div className={styles.body}>
        <p className={styles.heroStat}>~{eligibility.timeSavedFormatted}</p>
        <p className={styles.heroUnit}>saved</p>
        <p className={styles.quip}>{eligibility.quip}</p>
        <p className={`${styles.sharePrompt} ${styles.staggeredEntrance}`}>
          Other Rebels might find this useful. Anonymized, naturally.
        </p>

        {error && <p className={styles.errorMessage}>{error}</p>}

        <div className={`${styles.actions} ${styles.staggeredEntrance}`}>
          <button
            type="button"
            className={styles.primaryAction}
            disabled={cardState === 'composing'}
            onClick={handlePreviewAndShare}
          >
            {cardState === 'composing' ? (
              <>
                Drafting your story
                <span className={styles.loadingState}>
                  <span />
                  <span />
                  <span />
                </span>
              </>
            ) : (
              <>
                Preview &amp; Share
                <ChevronRight size={14} />
              </>
            )}
          </button>
          <button
            type="button"
            className={styles.secondaryAction}
            onClick={() => setCollapsed(true)}
          >
            Not this time
          </button>
          <button
            type="button"
            className={styles.tertiaryAction}
            onClick={handleOptOut}
          >
            Don&apos;t ask about sharing
          </button>
        </div>
      </div>

      <Tooltip content="Dismiss">
        <button
          type="button"
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
};
