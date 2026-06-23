import type { SessionRuntimeState } from '../../utils/runtimeState';
import { formatDurationShort, formatHistoryTimestamp, formatTimestamp } from '@renderer/utils/formatters';
import type { InsightTurnSummary } from '../types';
import styles from '../WorkSurface.module.css';

type RunsPanelProps = {
  turnSummaries: InsightTurnSummary[];
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  currentRuntime: SessionRuntimeState;
  isBusy: boolean;
};

const getStatusLabel = (summary: InsightTurnSummary, isLive: boolean) => {
  if (isLive) return 'Live';
  if (summary.status === 'error') return 'Error';
  if (summary.status === 'complete') return 'Complete';
  return 'Queued';
};

export const RunsPanel = ({
  turnSummaries,
  selectedTurnId,
  onSelectTurn,
  currentRuntime,
  isBusy
}: RunsPanelProps) => {
  if (turnSummaries.length === 0) {
    return (
      <aside className={styles.runNavigatorColumn} aria-label="Runs">
        <header className={styles.runNavigatorHeader}>
          <h4>Runs</h4>
        </header>
        <div className="empty-state">
          <strong>No runs yet</strong>
          <span>Launch a session to populate recent runs.</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className={styles.runNavigatorColumn} aria-label="Runs">
      <header className={styles.runNavigatorHeader}>
        <div>
          <h4>Runs</h4>
          <p>Select a run to inspect its steps.</p>
        </div>
        <span className={styles.runNavigatorCount}>{turnSummaries.length}</span>
      </header>
      <ul className={styles.runNavigatorList}>
        {turnSummaries.map((summary) => {
          const isSelected = summary.turnId === selectedTurnId;
          const isLive = currentRuntime.activeTurnId === summary.turnId && isBusy;
          const timeLabel = formatTimestamp(summary.startedAt) || formatHistoryTimestamp(summary.startedAt);
          const durationMs = Math.max(0, summary.lastTimestamp - summary.startedAt);
          const statusLabel = getStatusLabel(summary, isLive);
          const durationLabel = durationMs > 0 ? formatDurationShort(durationMs) : '—';

          return (
            <li key={summary.turnId}>
              <button
                type="button"
                className={[
                  styles.runNavigatorButton,
                  isSelected ? styles.runNavigatorButtonSelected : '',
                  summary.status === 'error' ? styles.runNavigatorButtonError : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  if (!isSelected) {
                    onSelectTurn(summary.turnId);
                  }
                }}
                aria-pressed={isSelected}
              >
                <div className={styles.runNavigatorTitleRow}>
                  <span className={styles.runNavigatorLabel}>{summary.label}</span>
                  <time>{timeLabel}</time>
                </div>
                <div className={styles.runNavigatorMeta}>
                  <span className={styles.runNavigatorStatus} data-status={statusLabel.toLowerCase()}>
                    <span aria-hidden className={styles.runNavigatorStatusDot} />
                    {statusLabel}
                  </span>
                  <span className={styles.runNavigatorDuration}>{durationLabel}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
};
