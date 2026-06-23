import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";

import type { CachedMeeting } from "../meetingCacheStore";
import {
  filterMeetingsToCurrentWeek,
  formatTime12hInTz,
  formatDateShortInTz,
  getDayOfWeekInTz,
  getDayNameInTz,
  getCurrentWeekBounds,
  getWeekBoundsForOffset,
  getMonthBoundsForOffset,
  getIsoWeekKeyInTz,
} from "../calendarTimeUtils";

/** Use UTC for deterministic tests regardless of host timezone. */
const TZ = "UTC";

function makeMeeting(
  overrides: Partial<CachedMeeting> & { startTime: string },
): CachedMeeting {
  return {
    id: overrides.id ?? `meeting-${Math.random().toString(36).slice(2)}`,
    calendarEventId: overrides.calendarEventId ?? "evt-1",
    calendarSource: overrides.calendarSource ?? "google:[external-email]",
    title: overrides.title ?? "Test Meeting",
    startTime: overrides.startTime,
    endTime:
      overrides.endTime ??
      new Date(
        new Date(overrides.startTime).getTime() + 60 * 60 * 1000,
      ).toISOString(),
    participants: overrides.participants ?? ["Alice", "Bob"],
    participantEmails: overrides.participantEmails,
    prepPath: overrides.prepPath,
    meetingUrl: overrides.meetingUrl,
    colorId: overrides.colorId,
  };
}

const FIXED_NOW = new Date("2026-04-08T14:00:00Z");
const { weekStart: WEEK_START } = getCurrentWeekBounds(FIXED_NOW, TZ);

/** Create a Date at {dayOffset} days from WEEK_START, at {hour}:00 in UTC. */
function dayInWeek(dayOffset: number, hour = 10): Date {
  const date = new Date(WEEK_START);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

// ---------------------------------------------------------------------------
// New timezone-aware utility tests
// ---------------------------------------------------------------------------

describe("formatTime12hInTz", () => {
  it("formats UTC time correctly in Europe/London during BST", () => {
    // The triggering bug: UTC "12:00" should show "1:00 PM" in BST
    expect(formatTime12hInTz("2026-04-09T12:00:00Z", "Europe/London")).toBe(
      "1:00 PM",
    );
  });

  it("formats time in UTC", () => {
    expect(formatTime12hInTz("2026-04-09T14:30:00Z", "UTC")).toBe("2:30 PM");
  });

  it("formats midnight as 12:00 AM", () => {
    expect(formatTime12hInTz("2026-04-09T00:00:00Z", "UTC")).toBe("12:00 AM");
  });

  it("handles non-hour offset timezone (Asia/Kolkata = UTC+5:30)", () => {
    // 12:00 UTC → 5:30 PM IST
    expect(formatTime12hInTz("2026-04-09T12:00:00Z", "Asia/Kolkata")).toBe(
      "5:30 PM",
    );
  });
});

describe("formatDateShortInTz", () => {
  it("formats date in the given timezone", () => {
    const d = new Date("2026-04-09T00:00:00Z");
    expect(formatDateShortInTz(d, "UTC")).toBe("Apr 9");
  });

  it("handles day boundary crossing with timezone", () => {
    // Just before midnight UTC on Apr 8 — in UTC+1 it's Apr 9
    const d = new Date("2026-04-08T23:30:00Z");
    expect(formatDateShortInTz(d, "Europe/London")).toBe("Apr 9");
    expect(formatDateShortInTz(d, "UTC")).toBe("Apr 8");
  });
});

describe("getDayOfWeekInTz", () => {
  it("returns correct day index for UTC", () => {
    // 2026-04-09 is a Thursday
    const d = new Date("2026-04-09T12:00:00Z");
    expect(getDayOfWeekInTz(d, "UTC")).toBe(4); // Thursday
  });

  it("handles day boundary crossing", () => {
    // Late Sunday night UTC → already Monday in UTC+1
    const d = new Date("2026-04-12T23:30:00Z"); // Sunday in UTC
    expect(getDayOfWeekInTz(d, "UTC")).toBe(0); // Sunday
    expect(getDayOfWeekInTz(d, "Europe/London")).toBe(1); // Monday in BST
  });
});

describe("getDayNameInTz", () => {
  it("returns the full day name", () => {
    const d = new Date("2026-04-09T12:00:00Z");
    expect(getDayNameInTz(d, "UTC")).toBe("Thursday");
  });
});

// ---------------------------------------------------------------------------
// Updated existing tests (now pass timeZone)
// ---------------------------------------------------------------------------

describe("getCurrentWeekBounds", () => {
  it("returns a Monday-to-Sunday range for the current week", () => {
    const { weekStart, weekEnd } = getCurrentWeekBounds(FIXED_NOW, TZ);

    const startDt = DateTime.fromJSDate(weekStart, { zone: TZ });
    const endDt = DateTime.fromJSDate(weekEnd, { zone: TZ });
    expect(startDt.weekday).toBe(1); // Monday
    expect(endDt.weekday).toBe(7); // Sunday (luxon: 7=Sunday)
    expect(startDt.hour).toBe(0);
    expect(startDt.minute).toBe(0);
    expect(endDt.hour).toBe(23);
    expect(endDt.minute).toBe(59);
  });

  it("computes correct boundaries in America/New_York near week boundary", () => {
    // Sunday 2026-04-12 23:00 Eastern = Monday 2026-04-13 03:00 UTC
    // In Eastern: still Sunday → week of Apr 6. In UTC: already Monday → week of Apr 13.
    const sundayNightEastern = new Date("2026-04-13T03:00:00Z"); // Mon 3am UTC = Sun 11pm ET
    const { weekStart, weekEnd } = getCurrentWeekBounds(
      sundayNightEastern,
      "America/New_York",
    );

    const startDt = DateTime.fromJSDate(weekStart, {
      zone: "America/New_York",
    });
    const endDt = DateTime.fromJSDate(weekEnd, { zone: "America/New_York" });

    // Should be the week of Monday Apr 6 (since it's still Sunday in ET)
    expect(startDt.weekday).toBe(1); // Monday
    expect(startDt.hour).toBe(0);
    expect(startDt.month).toBe(4);
    expect(startDt.day).toBe(6);
    expect(endDt.weekday).toBe(7); // Sunday
    expect(endDt.day).toBe(12);
  });

  it("computes correct boundaries in Asia/Kolkata (UTC+5:30)", () => {
    // 2026-04-08 21:00 UTC = 2026-04-09 02:30 IST (Thursday in IST)
    const date = new Date("2026-04-08T21:00:00Z");
    const { weekStart } = getCurrentWeekBounds(date, "Asia/Kolkata");

    const startDt = DateTime.fromJSDate(weekStart, { zone: "Asia/Kolkata" });
    expect(startDt.weekday).toBe(1); // Monday
    expect(startDt.hour).toBe(0);
    expect(startDt.day).toBe(6); // Monday Apr 6
  });

  it("throws on invalid timezone", () => {
    expect(() => getCurrentWeekBounds(new Date(), "Invalid/Zone")).toThrow(
      "Invalid IANA timezone",
    );
  });
});

describe("filterMeetingsToCurrentWeek", () => {
  it("keeps only meetings within the current Monday-to-Sunday window", () => {
    const previousWeekDate = new Date(WEEK_START);
    previousWeekDate.setUTCDate(previousWeekDate.getUTCDate() - 7);
    previousWeekDate.setUTCHours(10, 0, 0, 0);

    const nextWeekDate = new Date(WEEK_START);
    nextWeekDate.setUTCDate(nextWeekDate.getUTCDate() + 7);
    nextWeekDate.setUTCHours(10, 0, 0, 0);

    const meetings = [
      makeMeeting({
        startTime: previousWeekDate.toISOString(),
        title: "Previous week",
      }),
      makeMeeting({
        startTime: dayInWeek(2, 9).toISOString(),
        title: "This week",
      }),
      makeMeeting({
        startTime: nextWeekDate.toISOString(),
        title: "Next week",
      }),
    ];

    expect(
      filterMeetingsToCurrentWeek(meetings, FIXED_NOW, TZ).map(
        (meeting) => meeting.title,
      ),
    ).toEqual(["This week"]);
  });

  it("includes meetings that start on Monday and Sunday boundaries", () => {
    const meetings = [
      makeMeeting({
        startTime: dayInWeek(0, 0).toISOString(),
        title: "Monday",
      }),
      makeMeeting({
        startTime: dayInWeek(6, 23).toISOString(),
        title: "Sunday",
      }),
    ];

    expect(filterMeetingsToCurrentWeek(meetings, FIXED_NOW, TZ)).toHaveLength(
      2,
    );
  });
});

// ---------------------------------------------------------------------------
// Offset-based period bounds
// ---------------------------------------------------------------------------

describe("getWeekBoundsForOffset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fix time to 2026-04-08 14:00 UTC (a Wednesday)
    vi.setSystemTime(new Date("2026-04-08T14:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offset 0 matches getCurrentWeekBounds for current time", () => {
    const fromOffset = getWeekBoundsForOffset(0, TZ);
    const fromDirect = getCurrentWeekBounds(new Date(), TZ);
    expect(fromOffset.start.getTime()).toBe(fromDirect.weekStart.getTime());
    expect(fromOffset.end.getTime()).toBe(fromDirect.weekEnd.getTime());
  });

  it("all offsets produce Monday-to-Sunday bounds", () => {
    for (const offset of [-2, -1, 0, 1, 2]) {
      const { start, end } = getWeekBoundsForOffset(offset, TZ);
      const startDt = DateTime.fromJSDate(start, { zone: TZ });
      const endDt = DateTime.fromJSDate(end, { zone: TZ });
      expect(startDt.weekday).toBe(1); // Monday
      expect(endDt.weekday).toBe(7); // Sunday (luxon: 7=Sunday)
      expect(startDt.hour).toBe(0);
      expect(startDt.minute).toBe(0);
      expect(endDt.hour).toBe(23);
      expect(endDt.minute).toBe(59);
      expect(endDt.second).toBe(59);
      expect(endDt.millisecond).toBe(999);
    }
  });

  it("adjacent offsets are exactly 7 days apart", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    for (const offset of [-2, -1, 0, 1]) {
      const curr = getWeekBoundsForOffset(offset, TZ);
      const next = getWeekBoundsForOffset(offset + 1, TZ);
      // Luxon computes boundaries in the target timezone, so adjacent weeks
      // are exactly 7 calendar days (168h) apart when using UTC. In non-UTC
      // timezones with DST, the wall-clock spacing is still 7 calendar days
      // but the UTC ms difference may be 167h or 169h around DST transitions.
      const diffDays = Math.round(
        (next.start.getTime() - curr.start.getTime()) / DAY_MS,
      );
      expect(diffDays).toBe(7);
    }
  });

  it("offset -1 end is exactly 1ms before offset 0 start", () => {
    const prev = getWeekBoundsForOffset(-1, TZ);
    const curr = getWeekBoundsForOffset(0, TZ);
    expect(curr.start.getTime() - prev.end.getTime()).toBe(1);
  });
});

describe("getMonthBoundsForOffset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T14:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offset 0 returns current month (April 2026)", () => {
    const { start, end } = getMonthBoundsForOffset(0, TZ);
    const startDt = DateTime.fromJSDate(start, { zone: TZ });
    const endDt = DateTime.fromJSDate(end, { zone: TZ });
    expect(startDt.month).toBe(4); // April
    expect(startDt.day).toBe(1);
    expect(startDt.hour).toBe(0);
    expect(endDt.month).toBe(4);
    expect(endDt.day).toBe(30); // April has 30 days
    expect(endDt.hour).toBe(23);
    expect(endDt.minute).toBe(59);
    expect(endDt.second).toBe(59);
    expect(endDt.millisecond).toBe(999);
  });

  it("offset -1 returns previous month (March 2026)", () => {
    const { start, end } = getMonthBoundsForOffset(-1, TZ);
    const startDt = DateTime.fromJSDate(start, { zone: TZ });
    const endDt = DateTime.fromJSDate(end, { zone: TZ });
    expect(startDt.month).toBe(3); // March
    expect(startDt.day).toBe(1);
    expect(endDt.month).toBe(3);
    expect(endDt.day).toBe(31); // March has 31 days
  });

  it("offset +1 returns next month (May 2026)", () => {
    const { start, end } = getMonthBoundsForOffset(1, TZ);
    const startDt = DateTime.fromJSDate(start, { zone: TZ });
    const endDt = DateTime.fromJSDate(end, { zone: TZ });
    expect(startDt.month).toBe(5); // May
    expect(startDt.day).toBe(1);
    expect(endDt.month).toBe(5);
    expect(endDt.day).toBe(31); // May has 31 days
  });

  it("handles February correctly (non-leap year)", () => {
    // offset -2 from April 2026 = February 2026 (not a leap year)
    const { start, end } = getMonthBoundsForOffset(-2, TZ);
    const startDt = DateTime.fromJSDate(start, { zone: TZ });
    const endDt = DateTime.fromJSDate(end, { zone: TZ });
    expect(startDt.month).toBe(2); // February
    expect(startDt.day).toBe(1);
    expect(endDt.month).toBe(2);
    expect(endDt.day).toBe(28);
  });

  it("handles year boundary crossing", () => {
    // offset -4 from April 2026 = December 2025
    const { start, end } = getMonthBoundsForOffset(-4, TZ);
    const startDt = DateTime.fromJSDate(start, { zone: TZ });
    const endDt = DateTime.fromJSDate(end, { zone: TZ });
    expect(startDt.year).toBe(2025);
    expect(startDt.month).toBe(12); // December
    expect(startDt.day).toBe(1);
    expect(endDt.day).toBe(31);
  });

  it("start is always first of month at midnight", () => {
    for (const offset of [-2, -1, 0, 1, 2]) {
      const { start } = getMonthBoundsForOffset(offset, TZ);
      const startDt = DateTime.fromJSDate(start, { zone: TZ });
      expect(startDt.day).toBe(1);
      expect(startDt.hour).toBe(0);
      expect(startDt.minute).toBe(0);
      expect(startDt.second).toBe(0);
    }
  });

  it("end is always last day at 23:59:59.999", () => {
    for (const offset of [-2, -1, 0, 1, 2]) {
      const { end } = getMonthBoundsForOffset(offset, TZ);
      const endDt = DateTime.fromJSDate(end, { zone: TZ });
      expect(endDt.hour).toBe(23);
      expect(endDt.minute).toBe(59);
      expect(endDt.second).toBe(59);
      expect(endDt.millisecond).toBe(999);
      // Verify it's actually the last day: next day in the zone is the 1st
      const nextDay = endDt.plus({ days: 1 });
      expect(nextDay.day).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Week bucketing
// ---------------------------------------------------------------------------

describe("getIsoWeekKeyInTz", () => {
  it("returns Monday date string for a mid-week date", () => {
    // 2026-04-08 (Wednesday) → Monday is 2026-04-06
    const wed = new Date("2026-04-08T12:00:00Z");
    expect(getIsoWeekKeyInTz(wed, "UTC")).toBe("2026-04-06");
  });

  it("returns same-day for a Monday", () => {
    const mon = new Date("2026-04-06T12:00:00Z");
    expect(getIsoWeekKeyInTz(mon, "UTC")).toBe("2026-04-06");
  });

  it("returns previous Monday for a Sunday", () => {
    // 2026-04-12 (Sunday) → Monday is 2026-04-06
    const sun = new Date("2026-04-12T12:00:00Z");
    expect(getIsoWeekKeyInTz(sun, "UTC")).toBe("2026-04-06");
  });

  it("respects timezone when date straddles day boundary", () => {
    // 2026-04-13 03:00 UTC = 2026-04-12 23:00 Eastern (Sunday)
    // In UTC: Monday Apr 13 → week of Apr 13
    // In Eastern: Sunday Apr 12 → week of Apr 6
    const d = new Date("2026-04-13T03:00:00Z");
    expect(getIsoWeekKeyInTz(d, "UTC")).toBe("2026-04-13");
    expect(getIsoWeekKeyInTz(d, "America/New_York")).toBe("2026-04-06");
  });

  it("handles Asia/Kolkata (UTC+5:30) correctly", () => {
    // 2026-04-05 20:00 UTC = 2026-04-06 01:30 IST (Monday)
    // In UTC: Sunday Apr 5 → week of Mar 30
    // In IST: Monday Apr 6 → week of Apr 6
    const d = new Date("2026-04-05T20:00:00Z");
    expect(getIsoWeekKeyInTz(d, "UTC")).toBe("2026-03-30");
    expect(getIsoWeekKeyInTz(d, "Asia/Kolkata")).toBe("2026-04-06");
  });
});
