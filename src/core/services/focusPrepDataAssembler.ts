/**
 * Focus Prep Data Assembler
 *
 * Pre-computes structured data for Focus automation prompts (weekly prep,
 * monthly review). All meeting classification, week-over-week comparison,
 * goal-meeting alignment, and time analysis happens here — not in the LLM.
 *
 * Pure functions, no side effects, no async. Takes raw data, returns
 * structured text blocks ready for prompt injection.
 *
 * @see src/core/services/meetingTypeClassifier.ts
 * @see src/core/services/calendarTimeUtils.ts
 * @see src/core/services/focusContextAssembler.ts
 */

import type { Goal } from '../goalTypes';
import { classifyMeetingType, extractDomainFromCalendarSource, type MeetingType } from './meetingTypeClassifier';
import { DateTime } from 'luxon';
import { getCurrentWeekBounds, getDayOfWeekInTz, getIsoWeekKeyInTz } from './calendarTimeUtils';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface MeetingLike {
  id?: string;
  title: string;
  startTime: string;
  endTime: string;
  participants: string[];
  participantEmails?: string[];
  calendarSource?: string;
}

interface MeetingTypeCounts {
  total: number;
  solo: number;
  internal: number;
  external: number;
  totalHours: number;
  /** Hours in actual meetings (internal + external), excluding solo blocks */
  meetingHours: number;
}

interface WeekComparison {
  thisWeek: MeetingTypeCounts;
  lastWeek: MeetingTypeCounts;
  deltas: {
    totalMeetings: number;
    solo: number;
    internal: number;
    external: number;
    totalHours: number;
  };
}

interface DayBreakdown {
  day: string;
  meetingCount: number;
  hours: number;
  backToBackStretch: number;
  meetings: Array<{
    title: string;
    startTime: string;
    endTime: string;
    type: MeetingType;
    participants: number;
  }>;
}

export interface WeeklyPrepData {
  weekComparison: WeekComparison;
  dayBreakdowns: DayBreakdown[];
  goalAlignmentHints: Array<{
    goalText: string;
    potentialMeetings: string[];
    hasCalendarTime: boolean;
  }>;
  longestBackToBack: { day: string; hours: number } | null;
  busiestDay: { day: string; count: number; hours: number } | null;
  lightestDay: { day: string; count: number } | null;
  recurringMeetings: string[];
}

export interface MonthlyReviewData {
  weekByWeekBreakdown: Array<{
    weekLabel: string;
    counts: MeetingTypeCounts;
  }>;
  monthTotals: MeetingTypeCounts;
  goalProgress: {
    active: number;
    completed: number;
    dropped: number;
    created: number;
    stalled: string[];
  };
  trends: {
    meetingVolumeDirection: 'increasing' | 'decreasing' | 'stable';
    externalRatioDirection: 'increasing' | 'decreasing' | 'stable';
    averageWeeklyHours: number;
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function getMeetingDurationHours(m: MeetingLike): number {
  const start = new Date(m.startTime).getTime();
  const end = new Date(m.endTime).getTime();
  return Math.max(0, (end - start) / (1000 * 60 * 60));
}

function classifyMeetings(meetings: MeetingLike[], userDomain?: string): MeetingTypeCounts {
  let solo = 0, internal = 0, external = 0, totalHours = 0, meetingHours = 0;
  for (const m of meetings) {
    const type = classifyMeetingType(m, userDomain);
    const hours = getMeetingDurationHours(m);
    totalHours += hours;
    if (type === 'solo') {
      solo++;
    } else if (type === 'internal') {
      internal++;
      meetingHours += hours;
    } else {
      external++;
      meetingHours += hours;
    }
  }
  return {
    total: meetings.length,
    solo,
    internal,
    external,
    totalHours: Math.round(totalHours * 10) / 10,
    meetingHours: Math.round(meetingHours * 10) / 10,
  };
}

function calculateBackToBackStretch(dayMeetings: Array<{ startTime: string; endTime: string }>): number {
  if (dayMeetings.length < 2) return 0;
  const sorted = [...dayMeetings].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );

  let maxStretch = 0;
  let currentStretch = 1;
  const GAP_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = new Date(sorted[i - 1].endTime).getTime();
    const currStart = new Date(sorted[i].startTime).getTime();
    if (currStart - prevEnd <= GAP_THRESHOLD_MS) {
      currentStretch++;
    } else {
      maxStretch = Math.max(maxStretch, currentStretch);
      currentStretch = 1;
    }
  }
  maxStretch = Math.max(maxStretch, currentStretch);

  // Convert stretch count to hours using actual times
  if (maxStretch < 2) return 0;
  // Find the longest consecutive block's duration
  let longestBlockHours = 0;
  let blockStart = new Date(sorted[0].startTime).getTime();
  let blockEnd = new Date(sorted[0].endTime).getTime();

  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = new Date(sorted[i - 1].endTime).getTime();
    const currStart = new Date(sorted[i].startTime).getTime();
    if (currStart - prevEnd <= GAP_THRESHOLD_MS) {
      blockEnd = new Date(sorted[i].endTime).getTime();
    } else {
      longestBlockHours = Math.max(longestBlockHours, (blockEnd - blockStart) / (1000 * 60 * 60));
      blockStart = currStart;
      blockEnd = new Date(sorted[i].endTime).getTime();
    }
  }
  longestBlockHours = Math.max(longestBlockHours, (blockEnd - blockStart) / (1000 * 60 * 60));

  return Math.round(longestBlockHours * 10) / 10;
}

function findGoalMeetingAlignment(
  goals: Goal[],
  meetings: MeetingLike[],
): Array<{ goalText: string; potentialMeetings: string[]; hasCalendarTime: boolean }> {
  const active = goals.filter(g => g.status === 'active');
  if (active.length === 0) return [];

  return active.map(goal => {
    const goalWords = extractKeywords(goal.text);
    const planWords = goal.plan ? extractKeywords(goal.plan) : [];
    const allWords = new Set([...goalWords, ...planWords]);

    const matching = meetings.filter(m => {
      const titleWords = extractKeywords(m.title);
      return titleWords.some(w => allWords.has(w));
    });

    return {
      goalText: goal.text,
      potentialMeetings: matching.map(m => m.title),
      hasCalendarTime: matching.length > 0,
    };
  });
}

function extractKeywords(text: string): string[] {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that',
    'these', 'those', 'my', 'your', 'our', 'their', 'its', 'i', 'me',
    'we', 'us', 'you', 'he', 'she', 'it', 'they', 'them', 'not', 'no',
    'so', 'if', 'up', 'out', 'get', 'make', 'more', 'also', 'just',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function detectRecurringMeetings(meetings: MeetingLike[]): string[] {
  const titleCounts = new Map<string, number>();
  for (const m of meetings) {
    const normalized = m.title.toLowerCase().trim();
    titleCounts.set(normalized, (titleCounts.get(normalized) ?? 0) + 1);
  }
  return Array.from(titleCounts.entries())
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([title]) => title);
}

function determineTrend(values: number[]): 'increasing' | 'decreasing' | 'stable' {
  if (values.length < 2) return 'stable';
  const first = values.slice(0, Math.ceil(values.length / 2));
  const second = values.slice(Math.ceil(values.length / 2));
  const avgFirst = first.reduce((s, v) => s + v, 0) / first.length;
  const avgSecond = second.reduce((s, v) => s + v, 0) / second.length;
  const diff = avgSecond - avgFirst;
  if (Math.abs(diff) < 1) return 'stable';
  return diff > 0 ? 'increasing' : 'decreasing';
}

// ─────────────────────────────────────────────────────────────
// Public: Weekly Prep Data
// ─────────────────────────────────────────────────────────────

/**
 * Assemble pre-computed data for the weekly prep automation.
 *
 * @param thisWeekMeetings - Meetings for the current week (from meeting cache)
 * @param lastWeekMeetings - Meetings from the previous week (from meeting history)
 * @param goals - All goals from the goals store
 * @param userDomain - User's email domain for internal/external classification
 */
export function assembleWeeklyPrepData(
  thisWeekMeetings: MeetingLike[],
  lastWeekMeetings: MeetingLike[],
  goals: Goal[],
  userDomain: string | undefined,
  timeZone: string,
): WeeklyPrepData {
  const thisWeekCounts = classifyMeetings(thisWeekMeetings, userDomain);
  const lastWeekCounts = classifyMeetings(lastWeekMeetings, userDomain);

  // Day-by-day breakdown
  const byDay = new Map<number, MeetingLike[]>();
  for (const m of thisWeekMeetings) {
    const day = getDayOfWeekInTz(new Date(m.startTime), timeZone);
    const existing = byDay.get(day) ?? [];
    existing.push(m);
    byDay.set(day, existing);
  }

  const dayBreakdowns: DayBreakdown[] = [];
  for (const [dayNum, dayMeetings] of byDay.entries()) {
    const sorted = [...dayMeetings].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    );
    const hours = sorted.reduce((sum, m) => sum + getMeetingDurationHours(m), 0);
    dayBreakdowns.push({
      day: DAY_NAMES[dayNum],
      meetingCount: sorted.length,
      hours: Math.round(hours * 10) / 10,
      backToBackStretch: calculateBackToBackStretch(sorted),
      meetings: sorted.map(m => ({
        title: m.title,
        startTime: m.startTime,
        endTime: m.endTime,
        type: classifyMeetingType(m, userDomain),
        participants: m.participants.length,
      })),
    });
  }

  // Sort by weekday order (Monday first)
  dayBreakdowns.sort((a, b) => {
    const aIdx = (DAY_NAMES.indexOf(a.day as typeof DAY_NAMES[number]) + 6) % 7;
    const bIdx = (DAY_NAMES.indexOf(b.day as typeof DAY_NAMES[number]) + 6) % 7;
    return aIdx - bIdx;
  });

  // Find extremes
  const busiest = dayBreakdowns.reduce<DayBreakdown | null>(
    (max, d) => (!max || d.meetingCount > max.meetingCount ? d : max), null
  );
  const lightest = dayBreakdowns.reduce<DayBreakdown | null>(
    (min, d) => (!min || d.meetingCount < min.meetingCount ? d : min), null
  );
  const longestB2B = dayBreakdowns.reduce<{ day: string; hours: number } | null>(
    (max, d) => (!max || d.backToBackStretch > max.hours
      ? { day: d.day, hours: d.backToBackStretch } : max), null
  );

  return {
    weekComparison: {
      thisWeek: thisWeekCounts,
      lastWeek: lastWeekCounts,
      deltas: {
        totalMeetings: thisWeekCounts.total - lastWeekCounts.total,
        solo: thisWeekCounts.solo - lastWeekCounts.solo,
        internal: thisWeekCounts.internal - lastWeekCounts.internal,
        external: thisWeekCounts.external - lastWeekCounts.external,
        totalHours: Math.round((thisWeekCounts.totalHours - lastWeekCounts.totalHours) * 10) / 10,
      },
    },
    dayBreakdowns,
    goalAlignmentHints: findGoalMeetingAlignment(goals, thisWeekMeetings),
    longestBackToBack: longestB2B && longestB2B.hours > 0 ? longestB2B : null,
    busiestDay: busiest ? { day: busiest.day, count: busiest.meetingCount, hours: busiest.hours } : null,
    lightestDay: lightest ? { day: lightest.day, count: lightest.meetingCount } : null,
    recurringMeetings: detectRecurringMeetings([...thisWeekMeetings, ...lastWeekMeetings]),
  };
}

// ─────────────────────────────────────────────────────────────
// Public: Monthly Review Data
// ─────────────────────────────────────────────────────────────

/**
 * Assemble pre-computed data for the monthly review automation.
 *
 * @param meetings - All meetings from the past 30 days (from meeting history)
 * @param goals - All goals from the goals store
 * @param userDomain - User's email domain for internal/external classification
 */
export function assembleMonthlyReviewData(
  meetings: MeetingLike[],
  goals: Goal[],
  userDomain: string | undefined,
  now: Date,
  timeZone: string,
): MonthlyReviewData {
  // Bucket meetings into weeks
  const weekBuckets = new Map<string, MeetingLike[]>();
  for (const m of meetings) {
    const weekKey = getIsoWeekKeyInTz(new Date(m.startTime), timeZone);
    const existing = weekBuckets.get(weekKey) ?? [];
    existing.push(m);
    weekBuckets.set(weekKey, existing);
  }

  const weekByWeekBreakdown = Array.from(weekBuckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekKey, weekMeetings]) => {
      const weekLabel = `Week of ${DateTime.fromISO(weekKey, { zone: timeZone, locale: 'en-US' }).toFormat('MMM d')}`;
      return {
        weekLabel,
        counts: classifyMeetings(weekMeetings, userDomain),
      };
    });

  const monthTotals = classifyMeetings(meetings, userDomain);

  // Goal progress
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const active = goals.filter(g => g.status === 'active');
  const completed = goals.filter(
    g => g.status === 'completed' && g.updatedAt >= thirtyDaysAgo.getTime()
  );
  const dropped = goals.filter(
    g => g.status === 'dropped' && g.updatedAt >= thirtyDaysAgo.getTime()
  );
  const created = goals.filter(g => g.createdAt >= thirtyDaysAgo.getTime());

  // Stalled goals: active goals not updated in 14+ days
  const twoWeeksAgo = now.getTime() - 14 * 24 * 60 * 60 * 1000;
  const stalled = active
    .filter(g => g.updatedAt < twoWeeksAgo)
    .map(g => g.text);

  // Trends
  const weeklyTotals = weekByWeekBreakdown.map(w => w.counts.total);
  const weeklyExternal = weekByWeekBreakdown.map(w =>
    w.counts.total > 0 ? w.counts.external / w.counts.total : 0
  );
  const avgWeeklyHours = weekByWeekBreakdown.length > 0
    ? weekByWeekBreakdown.reduce((sum, w) => sum + w.counts.totalHours, 0) / weekByWeekBreakdown.length
    : 0;

  return {
    weekByWeekBreakdown,
    monthTotals,
    goalProgress: {
      active: active.length,
      completed: completed.length,
      dropped: dropped.length,
      created: created.length,
      stalled,
    },
    trends: {
      meetingVolumeDirection: determineTrend(weeklyTotals),
      externalRatioDirection: determineTrend(weeklyExternal),
      averageWeeklyHours: Math.round(avgWeeklyHours * 10) / 10,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Public: Format for prompt injection
// ─────────────────────────────────────────────────────────────

function formatDelta(value: number, label: string): string {
  if (value === 0) return `${label}: same as last week`;
  const sign = value > 0 ? '+' : '';
  return `${label}: ${sign}${value} vs last week`;
}

/**
 * Format weekly prep data as a structured text block for prompt injection.
 */
export function formatWeeklyPrepDataForPrompt(data: WeeklyPrepData): string {
  const sections: string[] = [];

  // Week-over-week comparison
  const { thisWeek, lastWeek, deltas } = data.weekComparison;
  sections.push(`## Pre-Computed Week Data

### This Week Overview
- Total meetings: ${thisWeek.total} (${thisWeek.solo} solo blocks, ${thisWeek.internal} internal, ${thisWeek.external} external)
- Total meeting hours: ${thisWeek.totalHours}h

### Last Week (for comparison)
- Total meetings: ${lastWeek.total} (${lastWeek.solo} solo, ${lastWeek.internal} internal, ${lastWeek.external} external)
- Total meeting hours: ${lastWeek.totalHours}h

### Week-over-Week Changes
- ${formatDelta(deltas.totalMeetings, 'Total meetings')}
- ${formatDelta(deltas.external, 'External (client/partner-facing)')}
- ${formatDelta(deltas.internal, 'Internal')}
- ${formatDelta(deltas.solo, 'Solo blocks')}
- ${formatDelta(deltas.totalHours, 'Meeting hours')}`);

  // Day-by-day
  if (data.dayBreakdowns.length > 0) {
    const dayLines = data.dayBreakdowns.map(d => {
      const types = d.meetings.reduce<Record<string, number>>((acc, m) => {
        acc[m.type] = (acc[m.type] ?? 0) + 1;
        return acc;
      }, {});
      const typeSummary = Object.entries(types).map(([t, c]) => `${c} ${t}`).join(', ');
      const b2b = d.backToBackStretch > 0 ? ` | back-to-back: ${d.backToBackStretch}h` : '';
      return `- ${d.day}: ${d.meetingCount} meetings, ${d.hours}h (${typeSummary})${b2b}`;
    });
    sections.push(`### Day-by-Day Breakdown\n${dayLines.join('\n')}`);
  }

  if (data.busiestDay) {
    sections.push(`- Busiest day: ${data.busiestDay.day} (${data.busiestDay.count} meetings, ${data.busiestDay.hours}h)`);
  }
  if (data.lightestDay && data.dayBreakdowns.length > 1) {
    sections.push(`- Lightest day: ${data.lightestDay.day} (${data.lightestDay.count} meetings)`);
  }
  if (data.longestBackToBack) {
    sections.push(`- Longest back-to-back stretch: ${data.longestBackToBack.day}, ${data.longestBackToBack.hours}h without a break`);
  }

  // Goal-meeting alignment
  if (data.goalAlignmentHints.length > 0) {
    const alignmentLines = data.goalAlignmentHints.map(hint => {
      if (hint.hasCalendarTime) {
        return `- "${hint.goalText}" — possibly connected to: ${hint.potentialMeetings.join(', ')}`;
      }
      return `- "${hint.goalText}" — NO meetings this week appear connected to this goal`;
    });
    sections.push(`### Goal-Calendar Alignment\n${alignmentLines.join('\n')}`);
  }

  // Recurring meetings
  if (data.recurringMeetings.length > 0) {
    sections.push(`### Recurring Meetings (appeared multiple times over past 2 weeks)\n${data.recurringMeetings.map(t => `- ${t}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

/**
 * Format monthly review data as a structured text block for prompt injection.
 */
export function formatMonthlyReviewDataForPrompt(data: MonthlyReviewData): string {
  const sections: string[] = [];

  // Month totals
  sections.push(`## Pre-Computed Month Data

### Month Overview (past 30 days)
- Total meetings: ${data.monthTotals.total} (${data.monthTotals.solo} solo, ${data.monthTotals.internal} internal, ${data.monthTotals.external} external)
- Total meeting hours: ${data.monthTotals.totalHours}h
- Average weekly hours in meetings: ${data.trends.averageWeeklyHours}h`);

  // Week-by-week
  if (data.weekByWeekBreakdown.length > 0) {
    const weekLines = data.weekByWeekBreakdown.map(w =>
      `- ${w.weekLabel}: ${w.counts.total} meetings (${w.counts.solo} solo, ${w.counts.internal} internal, ${w.counts.external} external), ${w.counts.totalHours}h`
    );
    sections.push(`### Week-by-Week Breakdown\n${weekLines.join('\n')}`);
  }

  // Trends
  sections.push(`### Trends
- Meeting volume: ${data.trends.meetingVolumeDirection}
- External meeting ratio: ${data.trends.externalRatioDirection}`);

  // Goal progress
  const gp = data.goalProgress;
  sections.push(`### Goal Progress (past 30 days)
- Active goals: ${gp.active}
- Completed this month: ${gp.completed}
- Dropped this month: ${gp.dropped}
- Created this month: ${gp.created}
- Stalled (no updates in 14+ days): ${gp.stalled.length > 0 ? gp.stalled.map(s => `"${s}"`).join(', ') : 'none'}`);

  return sections.join('\n\n');
}

// Re-export for use in automation pipeline
export { extractDomainFromCalendarSource, getCurrentWeekBounds, type MeetingType };
