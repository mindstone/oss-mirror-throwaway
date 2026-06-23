import { useEffect, useMemo, useState } from 'react';
import { useInboxStore, type InboxItem } from '@rebel/cloud-client';
import { ChevronDownIcon, XIcon } from './icons';
import styles from './HandledByRebelCard.module.css';

const DISMISS_STORAGE_KEY = 'web-companion:handled-by-rebel:dismissed-day';

function getDayKey(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function readDismissedDayKey(): string | null {
  try {
    return localStorage.getItem(DISMISS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeDismissedDayKey(dayKey: string): void {
  try {
    localStorage.setItem(DISMISS_STORAGE_KEY, dayKey);
  } catch {
    // Ignore storage write errors (private mode / disabled storage).
  }
}

function clearDismissedDayKey(): void {
  try {
    localStorage.removeItem(DISMISS_STORAGE_KEY);
  } catch {
    // Ignore storage clear errors.
  }
}

function getDisplayTitle(item: InboxItem): string {
  const title = item.title?.trim();
  if (title) return title;

  const text = item.text?.trim();
  return text || 'Untitled';
}

export function HandledByRebelCard() {
  const items = useInboxStore((s) => s.items);
  const todayKey = getDayKey(Date.now());

  const handledItems = useMemo(
    () =>
      items.filter(
        (item) =>
          item.autoCompleted === true
          && typeof item.completedAt === 'number'
          && getDayKey(item.completedAt) === todayKey,
      ),
    [items, todayKey],
  );

  const [dismissedDayKey, setDismissedDayKey] = useState<string | null>(() => readDismissedDayKey());
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (dismissedDayKey && dismissedDayKey !== todayKey) {
      setDismissedDayKey(null);
      clearDismissedDayKey();
    }
  }, [dismissedDayKey, todayKey]);

  useEffect(() => {
    setIsExpanded(false);
  }, [todayKey]);

  const count = handledItems.length;
  const isDismissedForToday = dismissedDayKey === todayKey;

  if (count === 0 || isDismissedForToday) return null;

  const summaryText = `While you were away, Rebel handled ${count} item${count === 1 ? '' : 's'}.`;
  const quipText =
    count === 1
      ? 'Consider it done. That one is off your plate.'
      : `Consider it done. All ${count} of them.`;

  return (
    <section className={styles.card} data-testid="home-handled-by-rebel-card">
      <div className={styles.header}>
        <button
          type="button"
          className={styles.summaryButton}
          data-testid="home-handled-by-rebel-toggle"
          onClick={() => setIsExpanded((current) => !current)}
        >
          <div className={styles.summaryRow}>
            <p className={styles.summaryText}>{summaryText}</p>
            <span className={`${styles.chevron} ${isExpanded ? styles.chevronExpanded : ''}`}>
              <ChevronDownIcon size={14} />
            </span>
          </div>
          <p className={styles.quip}>{quipText}</p>
        </button>

        <button
          type="button"
          className={styles.dismissButton}
          data-testid="home-handled-by-rebel-dismiss"
          onClick={() => {
            setDismissedDayKey(todayKey);
            writeDismissedDayKey(todayKey);
            setIsExpanded(false);
          }}
          aria-label="Dismiss handled by Rebel card"
        >
          <XIcon size={14} />
        </button>
      </div>

      {isExpanded && (
        <ul className={styles.titlesList}>
          {handledItems.map((item, index) => (
            <li key={`${item.id}-${index}`} className={styles.titleItem}>
              {getDisplayTitle(item)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
