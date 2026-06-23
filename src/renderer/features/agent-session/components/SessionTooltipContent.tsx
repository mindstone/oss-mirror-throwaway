import { memo } from 'react';
import { Sparkles } from 'lucide-react';
import type { AgentSessionSidebarEntry } from '../types';
import { formatAbsoluteTimestamp } from '@renderer/utils/formatters';
import { formatCostCompact } from '@shared/utils/usageFormatters';
import styles from './SessionTooltipContent.module.css';

type SessionTooltipContentProps = {
  entry: AgentSessionSidebarEntry;
  /** Whether this session is indexed for semantic search */
  isSemanticIndexed?: boolean;
};

export const SessionTooltipContent = memo(({ entry, isSemanticIndexed }: SessionTooltipContentProps) => {
  const hasMultipleMessages = entry.messageCount > 1;
  const showLastMessage = hasMultipleMessages && entry.lastMessagePreview;

  return (
    <div className={styles.container}>
      <div className={styles.title}>{entry.title}</div>

      {entry.firstMessagePreview && (
        <div className={styles.messageBlock}>
          <span className={styles.messageLabel}>
            {hasMultipleMessages ? 'First:' : 'Message:'}
          </span>
          <span className={styles.messageText}>{entry.firstMessagePreview}</span>
        </div>
      )}

      {showLastMessage && (
        <div className={styles.messageBlock}>
          <span className={styles.messageLabel}>Latest:</span>
          <span className={styles.messageText}>{entry.lastMessagePreview}</span>
        </div>
      )}

      <div className={styles.metadata}>
        <span>{entry.messageCount} message{entry.messageCount !== 1 ? 's' : ''}</span>
        <span className={styles.separator}>·</span>
        <span>{formatAbsoluteTimestamp(entry.timestamp)}</span>
        {entry.totalCostUsd != null && entry.totalCostUsd > 0 && (
          <>
            <span className={styles.separator}>·</span>
            <span>{formatCostCompact(entry.totalCostUsd)}</span>
          </>
        )}
        {isSemanticIndexed !== undefined && (
          <>
            <span className={styles.separator}>·</span>
            <span className={isSemanticIndexed ? styles.indexedStatus : styles.notIndexedStatus}>
              <Sparkles size={10} aria-hidden />
              {isSemanticIndexed ? 'Indexed' : 'Not indexed'}
            </span>
          </>
        )}
      </div>
    </div>
  );
});

SessionTooltipContent.displayName = 'SessionTooltipContent';
