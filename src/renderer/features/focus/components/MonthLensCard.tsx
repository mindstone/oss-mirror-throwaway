/**
 * MonthLensCard — Compact month insights matching CalendarStrip + WeekInsightsBar
 *
 * Layout: horizontal week strip (with legend, current-week highlight, normalized
 * bars) + stat blocks row (with week-over-week deltas). Mirrors the weekly view's
 * CalendarStrip + WeekInsightsBar pairing exactly.
 */

import { useMemo } from 'react';
import { useMonthStats } from '../hooks/useMonthStats';
import type { MonthStats } from '../hooks/useMonthStats';
import styles from './MonthLensCard.module.css';

interface MonthLensCardProps {
  enabled: boolean;
  monthOffset?: number;
}

type MeetingType = 'solo' | 'internal' | 'external';

function getCurrentWeekLabel(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() + mondayOffset);
  const month = monday.toLocaleDateString('en-US', { month: 'short' });
  const day = monday.getDate();
  return `Week of ${month} ${day}`;
}

function formatDelta(diff: number, suffix: string): string | null {
  if (diff === 0) return null;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff}${suffix} vs prev week`;
}

function formatHours(hours: number): string {
  if (hours === 0) return '0h';
  if (hours < 1) return `${Math.round(hours * 60)}min`;
  return `${hours}h`;
}

const WORK_HOURS_PER_WEEK = 40;

function computeDeltas(stats: MonthStats) {
  const weeks = stats.meetingsByWeek;
  if (weeks.length < 2) return { meetingDelta: null, focusDelta: null, meetingDeltaPositive: false, focusDeltaPositive: false };

  const currentWeekLabel = getCurrentWeekLabel();
  let currentIdx = weeks.findIndex(w => w.weekLabel === currentWeekLabel);
  if (currentIdx < 0) currentIdx = weeks.length - 1;
  if (currentIdx === 0) return { meetingDelta: null, focusDelta: null, meetingDeltaPositive: false, focusDeltaPositive: false };

  const curr = weeks[currentIdx];
  const prev = weeks[currentIdx - 1];
  const currActual = curr.internal + curr.external;
  const prevActual = prev.internal + prev.external;
  const currFocus = Math.max(0, Math.round((WORK_HOURS_PER_WEEK - curr.meetingHours) * 10) / 10);
  const prevFocus = Math.max(0, Math.round((WORK_HOURS_PER_WEEK - prev.meetingHours) * 10) / 10);

  return {
    meetingDelta: formatDelta(currActual - prevActual, ''),
    focusDelta: formatDelta(Math.round((currFocus - prevFocus) * 10) / 10, 'h'),
    meetingDeltaPositive: currActual < prevActual,
    focusDeltaPositive: currFocus > prevFocus,
  };
}

export function MonthLensCard({ enabled, monthOffset = 0 }: MonthLensCardProps) {
  const { stats, isLoading, error, refresh } = useMonthStats(enabled, monthOffset);

  const currentWeekLabel = useMemo(() => monthOffset === 0 ? getCurrentWeekLabel() : null, [monthOffset]);

  const typesPresent = useMemo(() => {
    if (!stats) return new Set<MeetingType>();
    const types = new Set<MeetingType>();
    for (const w of stats.meetingsByWeek) {
      if (w.solo > 0) types.add('solo');
      if (w.internal > 0) types.add('internal');
      if (w.external > 0) types.add('external');
    }
    return types;
  }, [stats]);

  const maxCount = useMemo(() => {
    if (!stats) return 1;
    return Math.max(...stats.meetingsByWeek.map(w => w.meetingCount), 1);
  }, [stats]);

  const deltas = useMemo(() => {
    if (!stats) return { meetingDelta: null, focusDelta: null, meetingDeltaPositive: false, focusDeltaPositive: false };
    return computeDeltas(stats);
  }, [stats]);

  if (isLoading) {
    return (
      <div className={styles.container} data-testid="month-lens-card">
        <div className={styles.statsRow}>
          <div className={`${styles.statBlock} ${styles.statBlockSkeleton}`} />
          <div className={`${styles.statBlock} ${styles.statBlockSkeleton}`} />
          <div className={`${styles.statBlock} ${styles.statBlockSkeleton}`} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container} data-testid="month-lens-card">
        <p className={styles.textMuted}>
          {error}{' '}
          <button type="button" className={styles.retryLink} onClick={refresh}>Try again</button>
        </p>
      </div>
    );
  }

  if (!stats || (stats.dataSpanDays < 7 && stats.totalMeetings === 0)) {
    return (
      <div className={styles.container} data-testid="month-lens-card">
        <p className={styles.textMuted}>
          {monthOffset === 0
            ? 'Your month view will fill in as Rebel learns your calendar patterns.'
            : 'No meeting data available for this month.'}
        </p>
      </div>
    );
  }

  const focusHoursPerWeek = stats.deepWorkHoursEstimate;
  const weekCount = Math.max(stats.meetingsByWeek.length, 1);
  const actualMeetings = stats.internalTotal + stats.externalTotal;
  const avgMeetingsPerWeek = Math.round(actualMeetings / weekCount);
  // Meeting hours per week = 40h - focus hours (excludes solo blocks, matches WeekInsightsBar logic)
  const meetingHoursPerWeek = Math.round((WORK_HOURS_PER_WEEK - focusHoursPerWeek) * 10) / 10;
  const meetingPercent = meetingHoursPerWeek > 0
    ? Math.round((meetingHoursPerWeek / WORK_HOURS_PER_WEEK) * 100)
    : 0;

  return (
    <div className={styles.container} data-testid="month-lens-card">
      {/* ── Per-week horizontal strip (mirrors CalendarStrip) ── */}
      {stats.meetingsByWeek.length > 0 && (
        <>
          <div className={styles.weekStrip}>
            {stats.meetingsByWeek.map(week => {
              const isCurrent = currentWeekLabel !== null && week.weekLabel === currentWeekLabel;
              const barScale = week.meetingCount / maxCount;
              return (
                <div
                  key={week.weekLabel}
                  className={`${styles.weekColumn}${isCurrent ? ` ${styles.weekColumnCurrent}` : ''}`}
                >
                  {isCurrent && <div className={styles.currentAccent} />}
                  <span className={`${styles.weekLabel}${isCurrent ? ` ${styles.weekLabelCurrent}` : ''}`}>
                    {week.weekLabel.replace('Week of ', '')}
                  </span>
                  <span className={`${styles.weekCount}${isCurrent ? ` ${styles.weekCountCurrent}` : ''}${week.meetingCount === 0 ? ` ${styles.weekCountZero}` : ''}`}>
                    {week.meetingCount}
                  </span>
                  <span className={styles.weekHours}>{week.meetingHours}h</span>
                  <div className={`${styles.miniBar}${week.meetingCount === 0 ? ` ${styles.miniBarEmpty}` : ''}`}>
                    {week.meetingCount > 0 && (
                      <>
                        {week.external > 0 && <div className={styles.miniBarExternal} style={{ flex: week.external * barScale }} />}
                        {week.internal > 0 && <div className={styles.miniBarInternal} style={{ flex: week.internal * barScale }} />}
                        {week.solo > 0 && <div className={styles.miniBarSolo} style={{ flex: week.solo * barScale }} />}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {typesPresent.size > 0 && (
            <div className={styles.legend}>
              {typesPresent.has('external') && (
                <span className={styles.legendItem}>
                  <span className={`${styles.legendDot} ${styles.legendDotExternal}`} />
                  External
                </span>
              )}
              {typesPresent.has('internal') && (
                <span className={styles.legendItem}>
                  <span className={`${styles.legendDot} ${styles.legendDotInternal}`} />
                  Internal
                </span>
              )}
              {typesPresent.has('solo') && (
                <span className={styles.legendItem}>
                  <span className={`${styles.legendDot} ${styles.legendDotSolo}`} />
                  Solo
                </span>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Stat blocks row (mirrors WeekInsightsBar with deltas) ── */}
      <div className={styles.statsRow}>
        <div className={`${styles.statBlock}${meetingPercent >= 50 ? ` ${styles.statBlockWarning}` : ''}`}>
          <span className={styles.statNumber}>
            ~{formatHours(meetingHoursPerWeek)}
            {deltas.meetingDelta && (
              <span className={`${styles.statDelta}${deltas.meetingDeltaPositive ? ` ${styles.statDeltaPositive}` : ''}`}>
                {deltas.meetingDelta}
              </span>
            )}
          </span>
          <span className={styles.statLabel}>
            Meetings / Week · {avgMeetingsPerWeek} avg
            {meetingPercent >= 50 && (
              <span className={styles.statWarning}> · {meetingPercent}%</span>
            )}
          </span>
        </div>

        <div className={styles.statBlock}>
          <span className={styles.statNumber}>
            ~{formatHours(focusHoursPerWeek)}
            {deltas.focusDelta && (
              <span className={`${styles.statDelta}${deltas.focusDeltaPositive ? ` ${styles.statDeltaPositive}` : ''}`}>
                {deltas.focusDelta}
              </span>
            )}
          </span>
          <span className={styles.statLabel}>Focus Time / Week · {100 - meetingPercent}%</span>
        </div>

        <div className={styles.statBlock}>
          <div className={styles.typePills}>
            {stats.externalTotal > 0 && (
              <span className={`${styles.pill} ${styles.pillExternal}`}>{stats.externalTotal} ext</span>
            )}
            {stats.internalTotal > 0 && (
              <span className={`${styles.pill} ${styles.pillInternal}`}>{stats.internalTotal} int</span>
            )}
            {stats.soloTotal > 0 && (
              <span className={`${styles.pill} ${styles.pillSolo}`}>{stats.soloTotal} solo</span>
            )}
          </div>
          <span className={styles.statLabel}>Type Split</span>
        </div>
      </div>
    </div>
  );
}
