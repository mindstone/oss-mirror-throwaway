import { useEffect, useId } from 'react';
import { formatHistoryTimestamp } from '@renderer/utils/formatters';
import { Button } from '@renderer/components/ui';
import { isAutomationSession } from '@shared/sessionKind';
import styles from './SessionDeleteDialog.module.css';

type SessionDeleteDialogProps = {
  sessionId: string;
  sessionTitle: string;
  sessionTimestamp: number | null;
  messageCount: number;
  isActive: boolean;
  willStopRun: boolean;
  queuedMessageCount: number;
  onCancel: () => void;
  onConfirm: () => void;
};

const buildMetadataLabel = (messageCount: number, timestamp: number | null): string => {
  const segments: string[] = [];
  if (Number.isFinite(messageCount)) {
    segments.push(`${messageCount} message${messageCount === 1 ? '' : 's'}`);
  }
  if (typeof timestamp === 'number') {
    segments.push(`Updated ${formatHistoryTimestamp(timestamp)}`);
  }
  return segments.join(' • ');
};

export const SessionDeleteDialog = ({
  sessionId,
  sessionTitle,
  sessionTimestamp,
  messageCount,
  isActive,
  willStopRun,
  queuedMessageCount,
  onCancel,
  onConfirm
}: SessionDeleteDialogProps) => {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const metadataLabel = buildMetadataLabel(messageCount, sessionTimestamp);
  const warnings: string[] = [];
  const originBadge = isAutomationSession(sessionId)
    ? { label: 'Automation', className: styles.originBadge }
    : null;

  if (isActive && willStopRun) {
    warnings.push('Current agent run will be stopped.');
  } else if (isActive) {
    warnings.push('This is the conversation you are viewing.');
  }

  if (queuedMessageCount > 0) {
    warnings.push(`Clears ${queuedMessageCount} queued message${queuedMessageCount === 1 ? '' : 's'}.`);
  }

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={onCancel}
    >
      <div className={styles.dialog} onClick={(event) => event.stopPropagation()}>
        <header className={styles.header}>
          <div className={styles.icon} aria-hidden>
            🗑️
          </div>
          <div className={styles.heading}>
            <span className={styles.overline}>Delete conversation</span>
            <h2 id={titleId} className={styles.title}>
              “{sessionTitle || 'Untitled conversation'}”
            </h2>
            <div className={styles.meta}>
              {originBadge ? <span className={originBadge.className}>{originBadge.label}</span> : null}
              {metadataLabel ? <span>{metadataLabel}</span> : null}
            </div>
          </div>
        </header>
        <div className={styles.body} id={descriptionId}>
          <p className={styles.lede}>
            Deleting removes this transcript, steps, and tool history forever. This cannot be undone.
          </p>
          {warnings.length > 0 ? (
            <ul className={styles.warningList}>
              {warnings.map((warning) => (
                <li key={warning} className={styles.warningItem}>
                  <span className={styles.warningDot} aria-hidden />
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <footer className={styles.actions}>
          <Button variant="ghost" onClick={onCancel}>
            Keep conversation
          </Button>
          <Button className={styles.deleteButton} onClick={onConfirm}>
            Delete forever
          </Button>
        </footer>
      </div>
    </div>
  );
};

SessionDeleteDialog.displayName = 'SessionDeleteDialog';
