import { DateTime } from 'luxon';
// First luxon import in src/core/ — justified for timezone-aware boundary construction.
// setHours(0,0,0,0) uses the host process timezone, which is wrong when host TZ != user TZ (cloud/mobile).

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Throw early on invalid IANA timezone strings. */
function assertValidTimeZone(tz: string): void {
  if (!DateTime.local({ zone: tz }).isValid) {
    throw new Error(`Invalid IANA timezone: ${tz}`);
  }
}

// ---------------------------------------------------------------------------
// Timezone-aware utilities
// ---------------------------------------------------------------------------

/** Format an ISO datetime string as 12-hour time in the given timezone. e.g. "1:00 PM" */
export function formatTime12hInTz(isoString: string, timeZone: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  });
}

/** Format a Date as a short date string (e.g., "Apr 9") in the given timezone. */
export function formatDateShortInTz(d: Date, timeZone: string): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone });
}

/** Get the day-of-week index (0=Sun..6=Sat) for a Date in the given timezone. */
export function getDayOfWeekInTz(d: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone });
  const dayStr = formatter.format(d);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return dayMap[dayStr] ?? d.getDay();
}

/** Get the day-of-week name (e.g., "Monday") for a Date in the given timezone. */
export function getDayNameInTz(d: Date, timeZone: string): string {
  return d.toLocaleDateString('en-US', { weekday: 'long', timeZone });
}

// ---------------------------------------------------------------------------
// Week bucketing
// ---------------------------------------------------------------------------

/**
 * Get the ISO date string ('YYYY-MM-DD') for the Monday of the ISO week
 * containing `d`, in the given timezone. Used as a bucketing key.
 */
export function getIsoWeekKeyInTz(d: Date, timeZone: string): string {
  assertValidTimeZone(timeZone);
  const dt = DateTime.fromJSDate(d, { zone: timeZone });
  return dt.startOf('week').toFormat('yyyy-MM-dd');
}

// ---------------------------------------------------------------------------
// Week bounds & filtering
// ---------------------------------------------------------------------------

/**
 * Get the Monday 00:00 and Sunday 23:59:59.999 for the week containing `now`.
 * Week starts on Monday (ISO standard).
 *
 * Uses luxon for timezone-aware boundary construction. JS Date.setHours()
 * operates in the host process timezone, which is wrong when host TZ != user TZ
 * (cloud/mobile surfaces).
 */
export function getCurrentWeekBounds(now: Date, timeZone: string): {
  weekStart: Date;
  weekEnd: Date;
} {
  assertValidTimeZone(timeZone);
  const dt = DateTime.fromJSDate(now, { zone: timeZone });
  const weekStart = dt.startOf('week').toJSDate();
  const weekEnd = dt.endOf('week').toJSDate();
  return { weekStart, weekEnd };
}

// ---------------------------------------------------------------------------
// Offset-based period bounds
// ---------------------------------------------------------------------------

/**
 * Get Monday 00:00 to Sunday 23:59:59.999 for the week at the given offset
 * relative to the current week. offset=0 is this week, -1 is last week, +1 is next week.
 *
 * Uses luxon for timezone-aware boundary construction.
 */
export function getWeekBoundsForOffset(offset: number, timeZone: string): { start: Date; end: Date } {
  assertValidTimeZone(timeZone);
  const now = new Date();
  const dt = DateTime.fromJSDate(now, { zone: timeZone }).plus({ weeks: offset });
  const start = dt.startOf('week').toJSDate();
  const end = dt.endOf('week').toJSDate();
  return { start, end };
}

/**
 * Get the first day 00:00 to last day 23:59:59.999 of the calendar month
 * at the given offset relative to the current month.
 * offset=0 is this month, -1 is last month, +1 is next month.
 *
 * Uses luxon for timezone-aware boundary construction.
 */
export function getMonthBoundsForOffset(offset: number, timeZone: string): { start: Date; end: Date } {
  assertValidTimeZone(timeZone);
  const now = new Date();
  const dt = DateTime.fromJSDate(now, { zone: timeZone }).plus({ months: offset });
  const start = dt.startOf('month').toJSDate();
  const end = dt.endOf('month').toJSDate();
  return { start, end };
}

/**
 * Filter meetings to only those within the current week (Mon–Sun).
 */
export function filterMeetingsToCurrentWeek<T extends { startTime: string }>(
  meetings: T[],
  now: Date,
  timeZone: string,
): T[] {
  const { weekStart, weekEnd } = getCurrentWeekBounds(now, timeZone);
  const startMs = weekStart.getTime();
  const endMs = weekEnd.getTime();

  return meetings.filter((meeting) => {
    const meetingStart = new Date(meeting.startTime).getTime();
    return meetingStart >= startMs && meetingStart <= endMs;
  });
}
