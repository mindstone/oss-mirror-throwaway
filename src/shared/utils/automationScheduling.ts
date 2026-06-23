/**
 * Pure scheduling utilities for automation definitions.
 *
 * Extracted from src/main/services/automationScheduler.ts so both
 * the desktop scheduler and the cloud scheduler can share the same
 * deterministic scheduling logic.
 *
 * These functions depend only on `luxon` and standard Date math —
 * no Electron or Node-specific APIs.
 */

import { DateTime } from 'luxon';
import type { AutomationDefinition } from '../types';
import type { AutomationScheduleUnbranded } from '../ipc/schemas/automations';

type ScheduleWithoutBrand = AutomationScheduleUnbranded;

/**
 * Parse an "HH:mm" time string into numeric hours and minutes.
 */
export const parseTime = (time: string): { hours: number; minutes: number } => {
  const [h, m] = time.split(':');
  const hours = Number.parseInt(h ?? '0', 10);
  const minutes = Number.parseInt(m ?? '0', 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    throw new Error(`Invalid schedule time: ${time}`);
  }
  return { hours: Math.max(0, Math.min(23, hours)), minutes: Math.max(0, Math.min(59, minutes)) };
};

/**
 * Set time on a date using Luxon for DST-correct handling.
 * Optionally accepts an IANA timezone string for cloud scheduling.
 */
export const setTime = (date: Date, hours: number, minutes: number, timezone?: string): Date => {
  const dt = timezone
    ? DateTime.fromJSDate(date).setZone(timezone).set({ hour: hours, minute: minutes, second: 0, millisecond: 0 })
    : DateTime.fromJSDate(date).set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
  return dt.toJSDate();
};

/**
 * Add days to a date using Luxon for DST-correct date math.
 */
export const addDays = (date: Date, days: number): Date => {
  return DateTime.fromJSDate(date).plus({ days }).toJSDate();
};

/**
 * Subtract days from a date using Luxon for DST-correct date math.
 */
export const subtractDays = (date: Date, days: number): Date => {
  return DateTime.fromJSDate(date).minus({ days }).toJSDate();
};

/**
 * Get the last day-of-month for the given date.
 */
export const lastDayOfMonth = (date: Date): number => {
  const test = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return test.getDate();
};

/**
 * Calculate the next scheduled run time for an automation.
 * Uses Luxon for DST-correct date math.
 *
 * @param definition - The automation definition with schedule configuration
 * @param from - The timestamp to calculate from (usually Date.now())
 * @param timezone - Optional IANA timezone override (used by cloud scheduler)
 * @returns The next run timestamp in milliseconds, or null if not schedulable
 */
export function calculateNextRunAt(
  definition: AutomationDefinition,
  from: number,
  timezone?: string,
): number | null {
  if (!definition.enabled) {
    return null;
  }

  const tz = timezone ?? definition.timezone;
  const now = new Date(from);
  const schedule: ScheduleWithoutBrand = definition.schedule;

  switch (schedule.type) {
    case 'event':
      // Event-triggered automations don't have a scheduled time
      return null;
    case 'hourly': {
      const minute = Math.max(0, Math.min(59, schedule.minute ?? 0));
      const base = new Date(now.getTime());
      base.setSeconds(0, 0);
      base.setMinutes(minute);
      if (base.getTime() <= now.getTime()) {
        base.setHours(base.getHours() + 1);
      }
      return base.getTime();
    }
    case 'daily': {
      // Collect and dedupe all times
      const allTimes = [...new Set([schedule.time, ...(schedule.additionalTimes ?? [])])];

      // Find nearest future time across all candidates
      let nearestFuture: number | null = null;
      for (const timeStr of allTimes) {
        const { hours, minutes } = parseTime(timeStr);
        let candidate = setTime(now, hours, minutes, tz);
        if (candidate.getTime() <= now.getTime()) {
          candidate = addDays(candidate, 1); // Tomorrow if past
        }
        if (nearestFuture === null || candidate.getTime() < nearestFuture) {
          nearestFuture = candidate.getTime();
        }
      }
      return nearestFuture;
    }
    case 'every_n_days': {
      const interval = Math.max(1, schedule.intervalDays || 1);
      const { hours, minutes } = parseTime(schedule.time);

      // Fail-closed: if anchorDate is missing, we can't compute a correct schedule
      if (!schedule.anchorDate) {
        return null;
      }

      const anchorBase = DateTime.fromISO(schedule.anchorDate).toJSDate();
      const anchorWithTime = setTime(anchorBase, hours, minutes, tz);

      // If anchor is in the future, return it directly
      if (anchorWithTime.getTime() > now.getTime()) {
        return anchorWithTime.getTime();
      }

      // Calculate days since anchor using Luxon for DST-correct day difference
      const anchorDt = DateTime.fromJSDate(anchorWithTime);
      const nowDt = DateTime.fromJSDate(now);
      const daysSinceAnchor = Math.floor(nowDt.diff(anchorDt, 'days').days);

      // Find next occurrence
      const cyclesPassed = Math.floor(daysSinceAnchor / interval);
      const nextCycleStart = (cyclesPassed + 1) * interval;
      const candidate = addDays(anchorWithTime, nextCycleStart);
      return candidate.getTime();
    }
    case 'weekly': {
      const days = schedule.daysOfWeek?.length ? schedule.daysOfWeek : [now.getDay()];
      const normalized = [...new Set(days.map((day) => ((day % 7) + 7) % 7))].sort((a, b) => a - b);
      const { hours, minutes } = parseTime(schedule.time);
      for (let offset = 0; offset < 7; offset += 1) {
        const day = (now.getDay() + offset) % 7;
        if (normalized.includes(day)) {
          const candidate = setTime(addDays(now, offset), hours, minutes, tz);
          if (candidate.getTime() > now.getTime()) {
            return candidate.getTime();
          }
        }
      }
      return setTime(addDays(now, 7), hours, minutes, tz).getTime();
    }
    case 'monthly': {
      const days = schedule.daysOfMonth?.length ? schedule.daysOfMonth : [now.getDate()];
      const uniqueDays = [...new Set(days)].map((day) => Math.min(31, Math.max(1, day))).sort((a, b) => a - b);
      const { hours, minutes } = parseTime(schedule.time);

      // Search up to 24 months forward to find a valid run date
      for (let monthOffset = 0; monthOffset < 24; monthOffset++) {
        const monthDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
        const monthLastDay = lastDayOfMonth(monthDate);

        for (const day of uniqueDays) {
          let actualDay: number;
          if (day > monthLastDay) {
            if (schedule.runOnLastDayIfShorter) {
              actualDay = monthLastDay;
            } else {
              continue;
            }
          } else {
            actualDay = day;
          }

          const candidate = setTime(
            new Date(monthDate.getFullYear(), monthDate.getMonth(), actualDay),
            hours,
            minutes,
            tz,
          );
          if (candidate.getTime() > now.getTime()) {
            return candidate.getTime();
          }
        }
      }
      return null;
    }
    case 'once': {
      // If already ran successfully, don't schedule again (prevents double-fire)
      if (definition.lastRunStatus === 'success' || definition.lastRunStatus === 'completed_with_blocks') {
        return null;
      }
      const dt = DateTime.fromISO(schedule.dateTime, { zone: tz ?? 'local' });
      const targetMs = dt.toMillis();
      if (targetMs > from) {
        return targetMs;
      }
      // Past dateTime but never ran — return it so the scheduler fires immediately
      // (e.g. agent took too long creating the automation and dateTime passed)
      if (!definition.lastRunAt) {
        return targetMs;
      }
      return null;
    }
    default: {
      // Exhaustiveness check: if a new branch is added to `AutomationSchedule`
      // without a corresponding `case`, this assignment fails to compile.
      // The runtime fallthrough still returns `null` (defense in depth — see
      // R6 Active Constraint 7 in docs/plans/260427_refactor_schedule_algebra.md).
      const _exhaustive: never = schedule;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Calculate the most recent time this automation should have run
 * (inverse of calculateNextRunAt).
 * Uses Luxon for DST-correct date math.
 *
 * @param definition - The automation definition with schedule configuration
 * @param from - The timestamp to calculate from (usually Date.now())
 * @param timezone - Optional IANA timezone override (used by cloud scheduler)
 * @returns The most recent scheduled run timestamp, or null if none before 'from'
 */
export function calculateMostRecentScheduledTime(
  definition: AutomationDefinition,
  from: number,
  timezone?: string,
): number | null {
  if (!definition.enabled) {
    return null;
  }

  const tz = timezone ?? definition.timezone;
  const now = new Date(from);
  const schedule: ScheduleWithoutBrand = definition.schedule;

  switch (schedule.type) {
    case 'event':
      return null;
    case 'hourly': {
      const minute = Math.max(0, Math.min(59, schedule.minute ?? 0));
      const base = new Date(now.getTime());
      base.setSeconds(0, 0);
      base.setMinutes(minute);
      if (base.getTime() > now.getTime()) {
        base.setHours(base.getHours() - 1);
      }
      return base.getTime();
    }
    case 'daily': {
      const allTimes = [...new Set([schedule.time, ...(schedule.additionalTimes ?? [])])];

      let mostRecentPast: number | null = null;
      for (const timeStr of allTimes) {
        const { hours, minutes } = parseTime(timeStr);
        let candidate = setTime(now, hours, minutes, tz);
        if (candidate.getTime() > now.getTime()) {
          candidate = subtractDays(candidate, 1);
        }
        if (mostRecentPast === null || candidate.getTime() > mostRecentPast) {
          mostRecentPast = candidate.getTime();
        }
      }
      return mostRecentPast;
    }
    case 'every_n_days': {
      const interval = Math.max(1, schedule.intervalDays || 1);
      const { hours, minutes } = parseTime(schedule.time);

      // Fail-closed: if anchorDate is missing, we can't compute a correct schedule
      if (!schedule.anchorDate) {
        return null;
      }

      const anchor = setTime(DateTime.fromISO(schedule.anchorDate).toJSDate(), hours, minutes, tz);
      const anchorDt = DateTime.fromJSDate(anchor);
      const nowDt = DateTime.fromJSDate(now);
      const diffDays = nowDt.diff(anchorDt, 'days').days;
      if (diffDays < 0) {
        return null;
      }
      const completeCycles = Math.floor(diffDays / interval);
      const candidate = addDays(anchor, completeCycles * interval);
      if (candidate.getTime() > now.getTime()) {
        return addDays(anchor, (completeCycles - 1) * interval).getTime();
      }
      return candidate.getTime();
    }
    case 'weekly': {
      const days = schedule.daysOfWeek?.length ? schedule.daysOfWeek : [now.getDay()];
      const normalized = [...new Set(days.map((day) => ((day % 7) + 7) % 7))].sort((a, b) => a - b);
      const { hours, minutes } = parseTime(schedule.time);
      for (let offset = 0; offset < 7; offset += 1) {
        const checkDate = subtractDays(now, offset);
        const day = checkDate.getDay();
        if (normalized.includes(day)) {
          const candidate = setTime(checkDate, hours, minutes, tz);
          if (candidate.getTime() <= now.getTime()) {
            return candidate.getTime();
          }
        }
      }
      return setTime(subtractDays(now, 7), hours, minutes, tz).getTime();
    }
    case 'monthly': {
      const days = schedule.daysOfMonth?.length ? schedule.daysOfMonth : [now.getDate()];
      const uniqueDays = [...new Set(days)].map((day) => Math.min(31, Math.max(1, day))).sort((a, b) => b - a);
      const { hours, minutes } = parseTime(schedule.time);

      for (let monthOffset = 0; monthOffset < 24; monthOffset++) {
        const monthDate = new Date(now.getFullYear(), now.getMonth() - monthOffset, 1);
        const monthLastDay = lastDayOfMonth(monthDate);

        for (const day of uniqueDays) {
          let actualDay: number;
          if (day > monthLastDay) {
            if (schedule.runOnLastDayIfShorter) {
              actualDay = monthLastDay;
            } else {
              continue;
            }
          } else {
            actualDay = day;
          }

          const candidate = setTime(
            new Date(monthDate.getFullYear(), monthDate.getMonth(), actualDay),
            hours,
            minutes,
            tz,
          );
          if (candidate.getTime() <= now.getTime()) {
            return candidate.getTime();
          }
        }
      }
      return null;
    }
    case 'once': {
      const dt = DateTime.fromISO(schedule.dateTime, { zone: tz ?? 'local' });
      return dt.toMillis() <= from ? dt.toMillis() : null;
    }
    default: {
      // Exhaustiveness check — see comment on the matching branch in
      // `calculateNextRunAt`. Runtime fallthrough preserved as defense in depth.
      const _exhaustive: never = schedule;
      void _exhaustive;
      return null;
    }
  }
}
