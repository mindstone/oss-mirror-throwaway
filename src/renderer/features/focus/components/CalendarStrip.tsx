/**
 * CalendarStrip — Compact 7-day timeline ribbon
 *
 * Each day shows a label, date, and a stacked density bar representing
 * the ratio of solo/internal/external meetings. Today gets an accent.
 * Compact and beautiful — the shape of your week at a glance.
 *
 * Receives the full CachedMeeting[] and filters to Mon–Sun internally.
 */

import { useMemo } from 'react';
import type { CachedMeeting } from '@shared/ipc/channels/calendar';
import { classifyMeetingType, extractDomainFromCalendarSource, type MeetingType } from '../../../../core/services/meetingTypeClassifier';
import styles from './CalendarStrip.module.css';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

interface DayData {
  label: string;
  date: number;
  isToday: boolean;
  solo: number;
  internal: number;
  external: number;
  total: number;
  totalHours: number;
}

export interface CalendarStripProps {
  meetings: CachedMeeting[];
  compact?: boolean;
  /** Week offset relative to current week. 0 = this week, -1 = last week, etc. */
  weekOffset?: number;
}

function getWeekMonday(offset: number): Date {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() + mondayOffset + offset * 7);
  return monday;
}

function buildWeekData(meetings: CachedMeeting[], weekOffset: number, userDomain?: string): DayData[] {
  const monday = getWeekMonday(weekOffset);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekData: DayData[] = [];

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(monday);
    dayDate.setDate(monday.getDate() + i);
    const nextDay = new Date(dayDate);
    nextDay.setDate(dayDate.getDate() + 1);

    let solo = 0, internal = 0, external = 0, totalHours = 0;

    for (const m of meetings) {
      const start = new Date(m.startTime);
      if (start < dayDate || start >= nextDay) continue;

      const type = classifyMeetingType(m, userDomain);
      const hours = Math.max(0, (new Date(m.endTime).getTime() - start.getTime()) / (1000 * 60 * 60));
      totalHours += hours;

      if (type === 'solo') solo++;
      else if (type === 'internal') internal++;
      else external++;
    }

    weekData.push({
      label: DAY_LABELS[i],
      date: dayDate.getDate(),
      isToday: weekOffset === 0 && dayDate.getTime() === today.getTime(),
      solo,
      internal,
      external,
      total: solo + internal + external,
      totalHours,
    });
  }

  return weekData;
}

export function CalendarStrip({ meetings, weekOffset = 0 }: CalendarStripProps) {
  const userDomain = useMemo(() => {
    for (const m of meetings) {
      const domain = extractDomainFromCalendarSource(m.calendarSource);
      if (domain) return domain;
    }
    return undefined;
  }, [meetings]);

  const weekData = useMemo(() => buildWeekData(meetings, weekOffset, userDomain), [meetings, weekOffset, userDomain]);

  const typesPresent = useMemo(() => {
    const types = new Set<MeetingType>();
    for (const day of weekData) {
      if (day.solo > 0) types.add('solo');
      if (day.internal > 0) types.add('internal');
      if (day.external > 0) types.add('external');
    }
    return types;
  }, [weekData]);

  const maxTotal = useMemo(() => Math.max(...weekData.map(d => d.total), 1), [weekData]);

  return (
    <div data-testid="calendar-strip">
      <div className={styles.strip}>
        {weekData.map(day => {
          const barScale = day.total / maxTotal;
          return (
            <div
              key={day.label}
              className={`${styles.dayColumn}${day.isToday ? ` ${styles.dayColumnToday}` : ''}`}
            >
              {day.isToday && <div className={styles.todayAccent} />}

              <p className={`${styles.dayLabel}${day.isToday ? ` ${styles.dayLabelToday}` : ''}`}>
                {day.label}
              </p>
              <p className={`${styles.dayDate}${day.isToday ? ` ${styles.dayDateToday}` : ''}`}>
                {day.date}
              </p>

              {/* Stacked density bar */}
              <div className={`${styles.densityBar}${day.total === 0 ? ` ${styles.densityBarEmpty}` : ''}`}>
                {day.total > 0 && (
                  <>
                    {day.external > 0 && (
                      <div
                        className={`${styles.densitySegment} ${styles.densitySegmentExternal}`}
                        style={{ flex: day.external * barScale }}
                      />
                    )}
                    {day.internal > 0 && (
                      <div
                        className={`${styles.densitySegment} ${styles.densitySegmentInternal}`}
                        style={{ flex: day.internal * barScale }}
                      />
                    )}
                    {day.solo > 0 && (
                      <div
                        className={`${styles.densitySegment} ${styles.densitySegmentSolo}`}
                        style={{ flex: day.solo * barScale }}
                      />
                    )}
                  </>
                )}
              </div>

              <p
                className={`${styles.meetingCount}${day.isToday ? ` ${styles.meetingCountToday}` : ''}${day.total === 0 ? ` ${styles.meetingCountZero}` : ''}`}
              >
                {day.total}
              </p>
            </div>
          );
        })}
      </div>

      {typesPresent.size > 0 && (
        <div className={styles.legend}>
          {typesPresent.has('external') && (
            <span className={styles.legendItem}>
              <span className={`${styles.legendDot} ${styles.meetingTypeExternal}`} />
              External
            </span>
          )}
          {typesPresent.has('internal') && (
            <span className={styles.legendItem}>
              <span className={`${styles.legendDot} ${styles.meetingTypeInternal}`} />
              Internal
            </span>
          )}
          {typesPresent.has('solo') && (
            <span className={styles.legendItem}>
              <span className={`${styles.legendDot} ${styles.meetingTypeSolo}`} />
              Solo
            </span>
          )}
        </div>
      )}
    </div>
  );
}
