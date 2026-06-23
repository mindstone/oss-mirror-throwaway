/**
 * CommunitySection - "Conversation Starter" card
 *
 * Shows community highlight from the Rebels forum.
 * Designed as a visually distinct invitation at the bottom of The Spark.
 * Cards open browser on click.
 */

import { ArrowRight, MessageCircle, Sparkles } from 'lucide-react';
import type { CommunityHighlight } from '@shared/types';
import { tracking } from '@renderer/src/tracking';
import styles from './CommunitySection.module.css';

interface CommunitySectionProps {
  highlight: CommunityHighlight | null;
}

export function CommunitySection({ highlight }: CommunitySectionProps) {
  if (!highlight) return null;

  const handleClick = () => {
    tracking.spark.communityHighlightClicked(highlight.title, highlight.id);
    window.appApi.openUrl(highlight.url);
  };

  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <h3 className={styles.sectionTitle}>From the Rebels</h3>
        <p className={styles.sectionSubtitle}>
          Where Rebel users share what's working, what isn't, and the occasional existential musing.
        </p>
      </header>
      <button
        type="button"
        className={styles.card}
        onClick={handleClick}
      >
        <div className={styles.cardHeader}>
          <Sparkles size={20} className={styles.sparkIcon} />
          <span className={styles.cardLabel}>Conversation starter</span>
        </div>
        <h3 className={styles.cardTitle}>{highlight.title}</h3>
        <div className={styles.cardMeta}>
          <span className={styles.cardAuthor}>by {highlight.author}</span>
          <span className={styles.cardReplies}>
            <MessageCircle size={12} />
            {highlight.replyCount} {highlight.replyCount === 1 ? 'reply' : 'replies'}
          </span>
        </div>
        <div className={styles.cardCta}>
          Join the discussion
          <ArrowRight size={14} className={styles.ctaArrow} />
        </div>
      </button>
    </section>
  );
}
