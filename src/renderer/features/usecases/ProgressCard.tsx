// Goals intentionally removed from The Spark — Focus is the canonical home.
// See docs/plans/260407_focus_goals_redesign.md
import { Sparkles, Timer } from 'lucide-react';
import { useHeroChoice } from '../homepage/hooks/useHeroChoice';
import { useTimeSavedData, formatTimeSavedCompact } from '@renderer/hooks/useProgressData';
import styles from './ProgressCard.module.css';

export function ProgressCard() {
  const { weekSummary } = useHeroChoice();
  const timeSavedData = useTimeSavedData();

  const hasWeekSummary = Boolean(weekSummary?.trim());

  return (
    <section className={styles.section} data-testid="spark-progress-card">
      <div className={styles.card}>
        <div className={styles.summaryBlock}>
          <span className={styles.summaryLabel}>
            <Sparkles size={14} />
            This week
          </span>
          <p className={styles.summaryText}>
            {hasWeekSummary
              ? weekSummary
              : "I'm still building a clearer read on your week."}
          </p>
        </div>

        {timeSavedData && (
          <div className={styles.contentGrid}>
            <div className={styles.column}>
              <span className={styles.columnLabel}>
                <Timer size={14} />
                Stats
              </span>
              <div className={styles.stats}>
                <div className={styles.statItem}>
                  <span className={styles.statValue}>{formatTimeSavedCompact(timeSavedData.totalMinutes)}</span>
                  <span className={styles.statLabel}>saved this week</span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statValue}>{timeSavedData.sessionCount}</span>
                  <span className={styles.statLabel}>sessions</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
