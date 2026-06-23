/**
 * FocusContextCard — Compact visual context card for Focus-origin conversations.
 *
 * Rendered at the top of the conversation transcript (before the virtualizer)
 * when `currentSessionOrigin === 'focus'`. Shows either the week widget
 * (CalendarStrip + goals) or month widget (MonthLensCard + goals) depending
 * on session title.
 *
 * @see docs/plans/260407_focus_goals_redesign.md — Stage 3
 */

import { useMemo } from 'react';
import { CalendarStrip } from './CalendarStrip';
import { MonthLensCard } from './MonthLensCard';
import { useMeetingCache } from '../../usecases/hooks/useMeetingCache';
import { useSpaceGoals } from '../hooks/useSpaceGoals';
import { useSessionStore } from '../../agent-session/store/sessionStore';
import styles from './FocusContextCard.module.css';

export function FocusContextCard() {
  const origin = useSessionStore((s) => s.currentSessionOrigin);
  const title = useSessionStore((s) => s.currentSessionTitle);

  const isFocus = origin === 'focus';
  const isMeetingPrep = isFocus && title.includes('Meeting Prep');
  const isMonth = isFocus && title.includes('Month');
  const { meetings } = useMeetingCache(false, isFocus);
  const { spaceGoals } = useSpaceGoals(isFocus);

  const personalGoals = useMemo(
    () => {
      const personal = spaceGoals.find(s => s.isPersonal);
      return personal?.goals ?? [];
    },
    [spaceGoals],
  );

  if (!isFocus || isMeetingPrep) return null;

  return (
    <div className={styles.card} data-testid="focus-context-card">
      {isMonth ? (
        <>
          <p className={styles.label}>Your month at a glance</p>
          <MonthLensCard enabled />
        </>
      ) : (
        <>
          <p className={styles.label}>Your week at a glance</p>
          <CalendarStrip meetings={meetings ?? []} compact />
        </>
      )}

      {personalGoals.length > 0 && (
        <div className={styles.goalsList}>
          <p className={styles.goalsLabel}>Active goals</p>
          <ul className={styles.goals}>
            {personalGoals.map((g, idx) => (
              <li key={idx} className={styles.goalItem}>
                {g.goal}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
