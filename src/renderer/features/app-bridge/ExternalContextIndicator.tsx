/**
 * ExternalContextIndicator
 *
 * "Held for you" banner shown above the composer when intent messages
 * arrived from the browser extension during an active turn and are
 * sitting in the main-process `pendingInputBuffer`.
 *
 * Shows a count, the most recent preview, and a dismiss button that
 * clears the local renderer state only (the main-process buffer still
 * drains on turn completion). The indicator auto-hides once the
 * `intent:buffer-drained` broadcast reports `remaining: 0`.
 *
 * Stage 7 scope: presentational only. No action on click other than
 * dismiss. Buffered messages are replayed into the session by the main
 * process on turn completion — the user doesn't need to do anything.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md Stage 7
 */

import { memo } from 'react';
import { Clock3, X } from 'lucide-react';
import styles from './ExternalContextIndicator.module.css';

export interface ExternalContextIndicatorProps {
  /** Number of messages currently held. When 0 the component returns null. */
  queueSize: number;
  /** First 120 chars of the most recent buffered message — for context. */
  lastPreview?: string;
  /** Hostname of the originating tab, shown as a small badge. */
  hostname?: string;
  /** Human-readable source label for non-browser surfaces such as Office. */
  sourceLabel?: string;
  /** Called when the user dismisses the indicator (doesn't cancel the drain). */
  onDismiss?: () => void;
}

const ExternalContextIndicatorComponent = ({
  queueSize,
  lastPreview,
  hostname,
  sourceLabel,
  onDismiss,
}: ExternalContextIndicatorProps) => {
  if (queueSize <= 0) return null;

  const countLabel =
    queueSize === 1
      ? '1 message held for you'
      : `${queueSize} messages held for you`;
  const source = sourceLabel ?? hostname;

  return (
    <div
      className={styles.wrapper}
      data-testid="external-context-indicator"
      role="status"
      aria-live="polite"
    >
      <div className={styles.inner}>
        <Clock3 size={14} className={styles.icon} aria-hidden="true" />
        <div className={styles.text}>
          <span className={styles.count}>{countLabel}</span>
          {source && (
            <span className={styles.host} data-testid="external-context-indicator-host">
              from {source}
            </span>
          )}
          {lastPreview && (
            <span className={styles.preview} title={lastPreview}>
              {lastPreview}
            </span>
          )}
        </div>
        {onDismiss && (
          <button
            type="button"
            className={styles.dismiss}
            onClick={onDismiss}
            aria-label="Dismiss held messages indicator"
            data-testid="external-context-indicator-dismiss"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
};

export const ExternalContextIndicator = memo(ExternalContextIndicatorComponent);
ExternalContextIndicator.displayName = 'ExternalContextIndicator';
