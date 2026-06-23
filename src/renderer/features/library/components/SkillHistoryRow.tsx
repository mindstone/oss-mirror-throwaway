import { Loader2, RotateCcw, Copy, History } from 'lucide-react';
import { Button, Badge } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import styles from './SkillHistoryRow.module.css';

interface SkillHistoryRowProps {
  timestampLabel: string;
  actorLabel: string;
  summary: string;
  isSummaryPending: boolean;
  isSelected: boolean;
  isPreviewLoading: boolean;
  isRestorePending: boolean;
  isRestoring: boolean;
  isForking: boolean;
  isRestoredVersion: boolean;
  onSelect: () => void;
  onRestore: () => void;
  onFork: () => void;
}

export function SkillHistoryRow({
  timestampLabel,
  actorLabel,
  summary,
  isSummaryPending,
  isSelected,
  isPreviewLoading,
  isRestorePending,
  isRestoring,
  isForking,
  isRestoredVersion,
  onSelect,
  onRestore,
  onFork,
}: SkillHistoryRowProps) {
  const actionsReachable = isSelected || isRestorePending;

  const handleSelectableKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };

  return (
    <div
      className={cn(
        styles.row,
        isSelected && styles.rowSelected,
        isRestorePending && styles.rowRestorePending,
      )}
      role="group"
      aria-label={`Version ${timestampLabel}`}
    >
      <div
        className={styles.selectableTop}
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={handleSelectableKeyDown}
        aria-pressed={isSelected}
      >
        <div className={styles.header}>
          <div className={styles.meta}>
            <span className={styles.timestamp}>{timestampLabel}</span>
            <span className={styles.dot}>·</span>
            <span className={styles.actor}>{actorLabel}</span>
          </div>
          <div className={styles.badges}>
            {isRestoredVersion && (
              <Badge variant="outline" size="sm" className={styles.badge}>
                Restored
              </Badge>
            )}
            {isPreviewLoading && (
              <Badge variant="muted" size="sm" className={styles.badge}>
                <Loader2 size={11} className={styles.spinner} />
                Loading
              </Badge>
            )}
          </div>
        </div>

        <div className={styles.summaryRow}>
          {isSummaryPending ? (
            <>
              <Loader2 size={12} className={styles.pendingIcon} />
              <span className={styles.pendingSummary}>Computing...</span>
            </>
          ) : (
            <>
              <History size={12} className={styles.summaryIcon} />
              <span className={styles.summary}>{summary}</span>
            </>
          )}
        </div>
      </div>

      <div className={styles.actions}>
        <Button
          variant={isRestorePending ? 'default' : 'ghost'}
          size="sm"
          className={styles.actionButton}
          tabIndex={actionsReachable ? 0 : -1}
          onClick={(event) => {
            event.stopPropagation();
            onRestore();
          }}
          disabled={isRestoring || isForking}
        >
          {isRestoring ? <Loader2 size={14} className={styles.spinner} /> : <RotateCcw size={14} />}
          {isRestorePending ? 'Confirm restore' : 'Restore this version'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={styles.actionButton}
          tabIndex={actionsReachable ? 0 : -1}
          onClick={(event) => {
            event.stopPropagation();
            onFork();
          }}
          disabled={isRestoring || isForking}
        >
          {isForking ? <Loader2 size={14} className={styles.spinner} /> : <Copy size={14} />}
          Save as new skill
        </Button>
      </div>
    </div>
  );
}
