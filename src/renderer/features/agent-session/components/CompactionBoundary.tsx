import { memo, useState, useCallback } from 'react';
import { ChevronDown, Database } from 'lucide-react';
import type { CompactionBoundary as CompactionBoundaryType } from '@shared/types';
import styles from './CompactionBoundary.module.css';

export type CompactionBoundaryProps = {
  boundary: CompactionBoundaryType;
  messageCount: number;
};

const CompactionBoundaryComponent = ({ boundary }: CompactionBoundaryProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const messagesCompacted = boundary.afterMessageIndex + 1;

  return (
    <div className={styles.boundary}>
      <div className={styles.divider}>
        <div className={styles.line} />
        <button
          type="button"
          className={styles.label}
          onClick={handleToggle}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Hide compaction summary' : 'Show compaction summary'}
        >
          <Database className={styles.labelIcon} aria-hidden />
          <span>Context compacted ({messagesCompacted} messages)</span>
          <ChevronDown
            className={styles.chevron}
            data-expanded={isExpanded}
            aria-hidden
          />
        </button>
        <div className={styles.line} />
      </div>

      {isExpanded && (
        <div className={styles.summaryPanel}>
          <div className={styles.summaryHeader}>
            <span>Compaction Summary</span>
            {boundary.depth > 1 && (
              <span className={styles.depthBadge}>Pass {boundary.depth}</span>
            )}
          </div>
          <div className={styles.summaryText}>{boundary.summary}</div>
        </div>
      )}
    </div>
  );
};

export const CompactionBoundary = memo(CompactionBoundaryComponent);
CompactionBoundary.displayName = 'CompactionBoundary';
