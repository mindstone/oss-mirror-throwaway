/**
 * CommunityWhisper - Minimal inline teaser for community content
 *
 * Shown when coaching is heavy (2+) and community content exists.
 * Single line that doesn't compete with coaching but maintains "alive" feeling.
 */

import { ExternalLink, MessageCircle } from 'lucide-react';
import type { CommunityHighlight } from '@shared/types';
import styles from './CommunityWhisper.module.css';

interface CommunityWhisperProps {
  highlight: CommunityHighlight;
}

export function CommunityWhisper({ highlight }: CommunityWhisperProps) {
  const handleClick = () => {
    window.appApi.openUrl(highlight.url);
  };

  return (
    <button
      type="button"
      className={styles.whisper}
      onClick={handleClick}
    >
      <span className={styles.whisperLabel}>From the Rebels:</span>
      <span className={styles.whisperTitle}>"{highlight.title}"</span>
      <span className={styles.whisperMeta}>
        <MessageCircle size={11} />
        {highlight.replyCount}
      </span>
      <ExternalLink size={11} className={styles.whisperArrow} />
    </button>
  );
}
