import { memo, useState, useCallback } from 'react';
import { CheckCircle2, ChevronDown } from 'lucide-react';
import type { InboxItem } from '@shared/types';
import styles from './RebelHandledSection.module.css';

export type RebelHandledSectionProps = {
  items: InboxItem[];
  onOpenSession?: (sessionId: string) => void;
};

function getRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

const RebelHandledSectionComponent = ({ items, onOpenSession }: RebelHandledSectionProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className={styles.section}>
      <button
        type="button"
        className={styles.header}
        onClick={toggleExpanded}
        aria-expanded={isExpanded}
        aria-label={`Handled by Rebel, ${items.length} items`}
      >
        <ChevronDown
          size={14}
          className={`${styles.chevron} ${!isExpanded ? styles.chevronCollapsed : ''}`}
        />
        <span className={styles.label}>Handled by Rebel</span>
        {!isExpanded && (
          <span className={styles.summary}>
            {items.length} {items.length === 1 ? 'item' : 'items'} completed today
          </span>
        )}
      </button>
      {isExpanded && (
        <div className={styles.items}>
          {items.map(item => (
            <div key={item.id} className={styles.item}>
              {(() => {
                const executingSessionId = item.executingSessionId;
                return (
                  <>
              <CheckCircle2 size={14} className={styles.checkIcon} />
              <span className={styles.itemTitle}>{item.title}</span>
              <span className={styles.itemTime}>
                {item.archivedAt ? getRelativeTime(item.archivedAt) : ''}
              </span>
              {executingSessionId && onOpenSession && (
                <button
                  type="button"
                  className={styles.viewLink}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenSession(executingSessionId);
                  }}
                >
                  View conversation
                </button>
              )}
                  </>
                );
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const RebelHandledSection = memo(RebelHandledSectionComponent);
RebelHandledSection.displayName = 'RebelHandledSection';
