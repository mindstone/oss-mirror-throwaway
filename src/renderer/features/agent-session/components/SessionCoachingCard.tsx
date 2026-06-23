/**
 * Session Coaching Card
 *
 * A gentle nudge when the user returns to a completed conversation.
 * Design philosophy: Subtle, scannable, dismissible.
 * The insight IS the interface - no decorative elements.
 */

import { useState } from 'react';
import { X, ChevronRight } from 'lucide-react';
import type { SessionCoachingEvaluation } from '@shared/types';
import { Tooltip } from '@renderer/components/ui';
import styles from './SessionCoachingCard.module.css';

type SessionCoachingCardProps = {
  evaluation: SessionCoachingEvaluation;
  onAct: (prompt: string) => void;
  onDismiss: (reason?: SessionCoachingEvaluation['dismissalReason']) => void;
};

export const SessionCoachingCard = ({
  evaluation,
  onAct,
  onDismiss
}: SessionCoachingCardProps) => {
  const [collapsed, setCollapsed] = useState(false);
  const { primaryInsight } = evaluation;

  if (collapsed) {
    return (
      <button
        type="button"
        className={styles.collapsed}
        onClick={() => setCollapsed(false)}
      >
        <span className={styles.collapsedIcon}>💡</span>
        <span className={styles.collapsedText}>Show reflection</span>
      </button>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.accent} aria-hidden />
      
      <div className={styles.body}>
        <p className={styles.header}>Based on this conversation, you might want to:</p>
        <p className={styles.insight}>{primaryInsight.insight}</p>
        
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primaryAction}
            onClick={() => onAct(primaryInsight.continuationPrompt)}
          >
            Explore this
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            className={styles.secondaryAction}
            onClick={() => setCollapsed(true)}
          >
            Later
          </button>
          <button
            type="button"
            className={styles.secondaryAction}
            onClick={() => onDismiss()}
          >
            Ignore
          </button>
        </div>
      </div>

      <Tooltip content="Ignore">
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => onDismiss()}
          aria-label="Ignore"
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
};
