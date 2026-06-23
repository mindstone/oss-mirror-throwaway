/**
 * WeekInsightsBar — Compact computed insights shown below the CalendarStrip.
 *
 * Replaces the static "You have 12 meetings this week" summary with
 * pre-computed structured data: meeting type split, hours, week-over-week
 * delta, and goal alignment warnings. No LLM calls — all computed.
 *
 * Goals are accepted as simple frontmatter-format objects (personal goals only,
 * for calendar alignment checks). No status filtering needed — all passed goals
 * are treated as active.
 *
 * @see docs/plans/260407_focus_goals_redesign.md — Stage 3
 */

import { useCallback, useMemo } from 'react';
import { Info, RotateCcw, X } from 'lucide-react';
import type { CachedMeeting } from '@shared/ipc/channels/calendar';
import { isSkippedPrep } from '@shared/ipc/channels/calendar';
import { classifyMeetingType, extractDomainFromCalendarSource } from '../../../../core/services/meetingTypeClassifier';
import { getWeekBoundsForOffset } from '../../../../core/services/calendarTimeUtils';
import { useSettingsSafe } from '../../settings/SettingsProvider';
import { Tooltip } from '../../../components/ui/Tooltip';
import { Button } from '../../../components/ui/Button';
import styles from './WeekInsightsBar.module.css';

interface WeekInsightsBarProps {
  meetings: CachedMeeting[];
  /** Week offset relative to current week. 0 = this week, -1 = last week, etc. */
  weekOffset?: number;
  onStartConversation?: (prompt: string) => void;
  onStartPrepConversation?: (prompt: string) => void;
}

interface TypeCounts {
  solo: number;
  internal: number;
  external: number;
  meetingHours: number;
  soloHours: number;
}

const WORK_HOURS_PER_WEEK = 40;

function classifyMeetingsInRange(
  meetings: CachedMeeting[],
  startMs: number,
  endMs: number,
  userDomain?: string,
): TypeCounts {
  let solo = 0, internal = 0, external = 0, meetingHours = 0, soloHours = 0;

  for (const m of meetings) {
    const ms = new Date(m.startTime).getTime();
    if (ms < startMs || ms > endMs) continue;

    const type = classifyMeetingType(m, userDomain);
    const durationHours = Math.max(0, (new Date(m.endTime).getTime() - ms) / (1000 * 60 * 60));

    if (type === 'solo') {
      solo++;
      soloHours += durationHours;
    } else if (type === 'internal') {
      internal++;
      meetingHours += durationHours;
    } else {
      external++;
      meetingHours += durationHours;
    }
  }

  return {
    solo, internal, external,
    meetingHours: Math.round(meetingHours * 10) / 10,
    soloHours: Math.round(soloHours * 10) / 10,
  };
}

function formatMeetingDelta(diff: number): string | null {
  if (diff === 0) return null;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff} vs last week`;
}

function formatHoursDelta(diff: number): string | null {
  if (diff === 0) return null;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${formatHours(Math.abs(diff))} vs last week`;
}

function formatMeetingForPrompt(m: CachedMeeting): string {
  const title = m.title || 'Untitled meeting';
  const date = new Date(m.startTime);
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getDay()];
  const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const startTime = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endTime = new Date(m.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `- ${title} — ${dayName} ${dateStr}, ${startTime}–${endTime}`;
}

function buildPrepPrompt(unpreppedMeetings: CachedMeeting[]): string {
  const lines = unpreppedMeetings.map(formatMeetingForPrompt).join('\n');
  return `I need to prep for the following meetings:\n${lines}\n\nHelp me get ready for them.`;
}

function detectUserDomain(meetings: CachedMeeting[]): string | undefined {
  for (const m of meetings) {
    if (m.calendarSource) {
      const domain = extractDomainFromCalendarSource(m.calendarSource);
      if (domain) return domain;
    }
  }
  return undefined;
}

function hasRealPrep(prepPath?: string): boolean {
  return !!prepPath?.trim() && !isSkippedPrep(prepPath);
}

function formatHours(hours: number): string {
  if (hours === 0) return '0h';
  if (hours < 1) return `${Math.round(hours * 60)}min`;
  return `${hours}h`;
}

export function WeekInsightsBar({
  meetings,
  weekOffset = 0,
  onStartConversation,
  onStartPrepConversation,
}: WeekInsightsBarProps) {
  const settingsCtx = useSettingsSafe();
  const prepSkippedTitles = useMemo(
    () => settingsCtx?.settings?.calendar?.prepSkippedTitles ?? [],
    [settingsCtx?.settings?.calendar?.prepSkippedTitles],
  );

  const skippedMeetingIds = useMemo(
    () => settingsCtx?.settings?.calendar?.skippedMeetingIds ?? [],
    [settingsCtx?.settings?.calendar?.skippedMeetingIds],
  );

  const handleToggleSkipMeeting = useCallback(async (meetingId: string, currentlySkipped: boolean) => {
    try {
      if (currentlySkipped) {
        await window.calendarApi.unskipMeetingPrep({ meetingId });
      } else {
        await window.calendarApi.skipMeetingPrep({ meetingId });
      }
      // Update local settings so the UI reflects the change immediately
      // (IPC updates main process settings, but renderer won't see it until re-fetch)
      void settingsCtx?.saveSettingsWith?.((draft) => {
        const existing = draft.calendar?.skippedMeetingIds ?? [];
        return {
          ...draft,
          calendar: {
            ...draft.calendar,
            skippedMeetingIds: currentlySkipped
              ? existing.filter(id => id !== meetingId)
              : existing.includes(meetingId) ? existing : [...existing, meetingId],
          },
        };
      });
    } catch {
      // Silent fail — sentinel not critical
    }
  }, [settingsCtx]);

  const handleToggleSkipTitle = useCallback((title: string, currentlySkipped: boolean) => {
    const lower = title.toLowerCase();
    void settingsCtx?.saveSettingsWith?.((draft) => ({
      ...draft,
      calendar: {
        ...draft.calendar,
        prepSkippedTitles: currentlySkipped
          ? (draft.calendar?.prepSkippedTitles ?? []).filter(t => t.toLowerCase() !== lower)
          : [...(draft.calendar?.prepSkippedTitles ?? []), title],
      },
    }));
  }, [settingsCtx]);

  const insights = useMemo(() => {
    const userDomain = detectUserDomain(meetings);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { start: weekStart, end: weekEnd } = getWeekBoundsForOffset(weekOffset, tz);
    const { start: lastWeekStart, end: lastWeekEnd } = getWeekBoundsForOffset(weekOffset - 1, tz);
    const currentWeekStartMs = weekStart.getTime();
    const currentWeekEndMs = weekEnd.getTime();
    const lastWeekStartMs = lastWeekStart.getTime();
    const lastWeekEndMs = lastWeekEnd.getTime();

    const counts = classifyMeetingsInRange(
      meetings,
      currentWeekStartMs,
      currentWeekEndMs,
      userDomain,
    );

    // All non-solo meetings without a real prep document (includes skipped ones for tooltip display)
    const allUnpreppedList = meetings.filter((m) => {
      const ms = new Date(m.startTime).getTime();
      if (ms < currentWeekStartMs || ms > currentWeekEndMs) return false;
      if (classifyMeetingType(m, userDomain) === 'solo') return false;
      if (hasRealPrep(m.prepPath)) return false;
      return true;
    }).sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

    // Build a set of skipped meeting IDs (sentinel + ID-based + title-based)
    const skippedIdSet = new Set(skippedMeetingIds);
    const skippedTitleSet = new Set(prepSkippedTitles.map(t => t.toLowerCase()));
    const skippedSet = new Set<string>();
    for (const m of allUnpreppedList) {
      if (isSkippedPrep(m.prepPath) || skippedIdSet.has(m.id) || skippedTitleSet.has(m.title.toLowerCase())) {
        skippedSet.add(m.id);
      }
    }

    // Active list = not skipped (used for count + prep prompt)
    const activeList = allUnpreppedList.filter(m => !skippedSet.has(m.id));

    const groupedAll = new Map<string, CachedMeeting[]>();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    for (const m of allUnpreppedList) {
      const date = new Date(m.startTime);
      const dayName = days[date.getDay()];
      const dateStr = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const label = `${dayName}, ${dateStr}`;
      let bucket = groupedAll.get(label);
      if (!bucket) {
        bucket = [];
        groupedAll.set(label, bucket);
      }
      bucket.push(m);
    }
    const previousCounts = classifyMeetingsInRange(
      meetings,
      lastWeekStartMs,
      lastWeekEndMs,
      userDomain,
    );
    const total = counts.solo + counts.internal + counts.external;
    // Solo blocks ARE focus time, not meeting time
    const focusHours = Math.max(0, Math.round((WORK_HOURS_PER_WEEK - counts.meetingHours) * 10) / 10);
    const previousFocusHours = Math.max(
      0,
      Math.round((WORK_HOURS_PER_WEEK - previousCounts.meetingHours) * 10) / 10,
    );
    const meetingPercent = counts.meetingHours > 0 ? Math.round((counts.meetingHours / WORK_HOURS_PER_WEEK) * 100) : 0;
    const hasLastWeekData = meetings.some((meeting) => new Date(meeting.startTime).getTime() <= lastWeekEndMs);

    const actualMeetings = counts.internal + counts.external;
    const previousActualMeetings = previousCounts.internal + previousCounts.external;
    const meetingDelta = hasLastWeekData ? formatMeetingDelta(actualMeetings - previousActualMeetings) : null;
    const meetingDeltaPositive = hasLastWeekData && actualMeetings < previousActualMeetings;
    const focusDelta = hasLastWeekData
      ? formatHoursDelta(Math.round((focusHours - previousFocusHours) * 10) / 10)
      : null;
    const focusDeltaPositive = hasLastWeekData && focusHours > previousFocusHours;

    // Track title frequency for "Skip all" affordance on recurring meetings
    const titleCounts = new Map<string, number>();
    for (const m of allUnpreppedList) {
      const key = m.title.toLowerCase();
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }

    return {
      counts,
      total,
      focusHours,
      meetingPercent,
      meetingDelta,
      meetingDeltaPositive,
      focusDelta,
      focusDeltaPositive,
      activeList,
      allUnpreppedList,
      groupedAll,
      activeCount: activeList.length,
      skippedSet,
      titleCounts,
    };
  }, [meetings, weekOffset, prepSkippedTitles, skippedMeetingIds]);

  if (insights.total === 0) {
    return (
      <p className={styles.emptyLine}>
        No meetings on your calendar this week. A clear week is a rare gift.
      </p>
    );
  }

  const {
    counts,
    focusHours,
    meetingPercent,
    meetingDelta,
    meetingDeltaPositive,
    focusDelta,
    focusDeltaPositive,
    activeList,
    allUnpreppedList,
    groupedAll,
    activeCount,
    skippedSet,
    titleCounts,
  } = insights;
  const hasAnyUnprepped = allUnpreppedList.length > 0;
  const actualMeetings = counts.internal + counts.external;
  const focusPercent = 100 - meetingPercent;

  return (
    <div className={styles.container} data-testid="week-insights-bar">
      {/* KPI stat blocks row */}
      <div className={styles.statsRow}>
        {/* Meetings stat */}
        <div className={`${styles.statBlock}${meetingPercent >= 50 ? ` ${styles.statBlockWarning}` : ''}`}>
          <span className={styles.statNumber}>
            {actualMeetings}
            {meetingDelta && (
              <span className={`${styles.statDelta}${meetingDeltaPositive ? ` ${styles.statDeltaPositive}` : ''}`}>
                {meetingDelta}
              </span>
            )}
          </span>
          <span className={styles.statLabel}>
            {actualMeetings === 1 ? 'Meeting' : 'Meetings'} · {formatHours(counts.meetingHours)}
          </span>
          {meetingPercent >= 50 && (
            <span className={styles.statWarning}>{meetingPercent}% of week</span>
          )}
          {hasAnyUnprepped && (
            <Tooltip
              interactive={true}
              content={
                <div className={styles.prepTooltipContent}>
                  <div className={styles.prepTooltipScroll}>
                    {Array.from(groupedAll.entries()).map(([day, dayMeetings]) => (
                      <div key={day} className={styles.prepTooltipDayGroup}>
                        <div className={styles.prepTooltipDay}>{day}</div>
                        {dayMeetings.map((m) => {
                          const time = new Date(m.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                          const isSkipped = skippedSet.has(m.id);
                          const titleKey = m.title.toLowerCase();
                          const isTitleSkipped = prepSkippedTitles.some(t => t.toLowerCase() === titleKey);
                          const isRecurring = (titleCounts.get(titleKey) ?? 0) >= 2;
                          return (
                            <div key={m.id} className={`${styles.prepTooltipMeeting}${isSkipped ? ` ${styles.prepTooltipMeetingSkipped}` : ''}`}>
                              <span className={styles.prepTooltipTime}>{time}</span>
                              <span className={styles.prepTooltipTitle}>{m.title || 'Untitled'}</span>
                              {isRecurring && (
                                <button
                                  type="button"
                                  className={`${styles.skipAllButton}${isTitleSkipped ? ` ${styles.skipAllButtonActive}` : ''}`}
                                  onClick={() => handleToggleSkipTitle(m.title, isTitleSkipped)}
                                  title={isTitleSkipped ? `Resume prepping "${m.title}"` : `Always skip "${m.title}"`}
                                >
                                  {isTitleSkipped ? 'Unskip all' : 'Skip all'}
                                </button>
                              )}
                              <button
                                type="button"
                                className={`${styles.skipButton}${isSkipped ? ` ${styles.skipButtonActive}` : ''}`}
                                onClick={() => handleToggleSkipMeeting(m.id, isSkipped)}
                                title={isSkipped ? 'Restore prep for this meeting' : 'Skip prep for this meeting'}
                              >
                                {isSkipped ? <RotateCcw size={11} /> : <X size={12} />}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  <div className={styles.prepTooltipAction}>
                    {onStartConversation && (
                      <>
                        <button
                          type="button"
                          className={styles.customizeLink}
                          onClick={() => onStartConversation(
                            'I want to customize how meeting prep works. Use the @customise-and-extend-skill skill to help me adjust the meeting-prep skill.'
                          )}
                          title="Customize meeting prep behavior"
                        >
                          <Info size={12} />
                        </button>
                        {activeCount > 0 && onStartPrepConversation && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onStartPrepConversation(buildPrepPrompt(activeList))}
                          >
                            Prep remaining
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              }
            >
              <button type="button" className={`${styles.statWarning} ${styles.prepTrigger}`}>
                {activeCount > 0
                  ? `${activeCount} need prep`
                  : 'All skipped'}
              </button>
            </Tooltip>
          )}
        </div>

        {/* Focus time stat */}
        <div className={styles.statBlock}>
          <span className={styles.statNumber}>
            ~{formatHours(focusHours)}
            {focusDelta && (
              <span className={`${styles.statDelta}${focusDeltaPositive ? ` ${styles.statDeltaPositive}` : ''}`}>
                {focusDelta}
              </span>
            )}
          </span>
          <span className={styles.statLabel}>Focus Time · {focusPercent}%</span>
        </div>

        {/* Type split stat */}
        <div className={styles.statBlock}>
          <div className={styles.typePills}>
            {counts.external > 0 && (
              <span className={`${styles.pill} ${styles.pillExternal}`}>
                {counts.external} ext
              </span>
            )}
            {counts.internal > 0 && (
              <span className={`${styles.pill} ${styles.pillInternal}`}>
                {counts.internal} int
              </span>
            )}
            {counts.solo > 0 && (
              <span className={`${styles.pill} ${styles.pillSolo}`}>
                {counts.solo} solo
              </span>
            )}
          </div>
          <span className={styles.statLabel}>Type Split</span>
        </div>
      </div>

    </div>
  );
}
