/**
 * Focus Context Assembler
 *
 * Assembles Focus-specific context (calendar, goals, narrative) into a
 * structured preamble string for injection into the first user message
 * of a Focus conversation. Pure function — no side effects, no async.
 *
 * @see docs/plans/260406_focus_phase4_conversational_planning.md
 */

import type { Goal } from "../goalTypes";
import { createScopedLogger } from "../logger";
import {
  filterMeetingsToCurrentWeek,
  formatTime12hInTz,
  formatDateShortInTz,
  getDayOfWeekInTz,
} from "./calendarTimeUtils";
import { hasRealPrepPath } from "./meetingCacheStore";
import type { CachedMeeting } from "./meetingCacheStore";
import type { SpaceGoals } from "./spaceGoalsReader";

const log = createScopedLogger({ service: "focusContextAssembler" });

const MAX_MEETINGS = 30;

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildCalendarSection(
  meetings: CachedMeeting[],
  now: Date,
  timeZone: string,
): string | null {
  const weekMeetings = filterMeetingsToCurrentWeek(meetings, now, timeZone);

  if (weekMeetings.length === 0) return null;

  // Sort all by start time
  const sorted = [...weekMeetings].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  );

  const truncated = sorted.length > MAX_MEETINGS;
  const displayed = truncated ? sorted.slice(0, MAX_MEETINGS) : sorted;
  const totalCount = weekMeetings.length;

  // Group by day
  const byDay = new Map<string, CachedMeeting[]>();
  for (const m of displayed) {
    const d = new Date(m.startTime);
    const key = `${DAY_NAMES[getDayOfWeekInTz(d, timeZone)]}, ${formatDateShortInTz(d, timeZone)}`;
    const existing = byDay.get(key) ?? [];
    existing.push(m);
    byDay.set(key, existing);
  }

  // Sort days by their first meeting's date
  const sortedDays = [...byDay.entries()].sort((a, b) => {
    const aFirst = new Date(a[1][0].startTime).getTime();
    const bFirst = new Date(b[1][0].startTime).getTime();
    return aFirst - bFirst;
  });

  const dayBlocks = sortedDays.map(([dayLabel, dayMeetings]) => {
    const meetingLines = dayMeetings.map((m) => {
      const start = formatTime12hInTz(m.startTime, timeZone);
      const end = formatTime12hInTz(m.endTime, timeZone);
      const count = m.participants.length;
      const parts = [
        `  - "${m.title}" ${start}–${end}, ${count} participant${count !== 1 ? "s" : ""}`,
      ];
      if (hasRealPrepPath(m.prepPath)) {
        parts[0] += ", has prep document";
      }
      return parts[0];
    });
    return `${dayLabel}:\n${meetingLines.join("\n")}`;
  });

  let body = `${totalCount} meeting${totalCount !== 1 ? "s" : ""} this week:\n\n${dayBlocks.join("\n\n")}`;

  if (truncated) {
    body += `\n\n... and ${totalCount - MAX_MEETINGS} more meeting${totalCount - MAX_MEETINGS !== 1 ? "s" : ""}`;
  }

  return `<calendar-this-week>\n${body}\n</calendar-this-week>`;
}

function buildGoalsSection(goals: Goal[]): string | null {
  const active = goals.filter((g) => g.status === "active");

  if (active.length === 0) return null;

  const goalLines = active.map((g) => {
    const parts = [`- "${g.text}"`];
    if (g.why) parts.push(`  Why: ${g.why}`);
    if (g.outcome) parts.push(`  Desired outcome: ${g.outcome}`);
    if (g.obstacle) parts.push(`  Main obstacle: ${g.obstacle}`);
    if (g.plan) parts.push(`  Plan: ${g.plan}`);
    return parts.join("\n");
  });

  return `<goals>\n${active.length} active goal${active.length !== 1 ? "s" : ""}:\n${goalLines.join("\n")}\n</goals>`;
}

/**
 * Build goals section from SpaceGoals[] — includes space attribution.
 * Used by the space-aware server-injection assembler for richer context.
 */
function buildSpaceGoalsSection(spaceGoals: SpaceGoals[]): string | null {
  const totalGoals = spaceGoals.reduce((sum, sg) => sum + sg.goals.length, 0);
  if (totalGoals === 0) return null;

  const spaceBlocks = spaceGoals.map((sg) => {
    const goalLines = sg.goals.map((g) => {
      const parts = [`- "${g.goal}"`];
      if (g.why) parts.push(`  Why: ${g.why}`);
      return parts.join("\n");
    });
    return `${sg.spaceName}:\n${goalLines.join("\n")}`;
  });

  const spaceCount = spaceGoals.length;
  const header = `${totalGoals} active goal${totalGoals !== 1 ? "s" : ""} across ${spaceCount} space${spaceCount !== 1 ? "s" : ""}:`;

  return `<goals>\n${header}\n\n${spaceBlocks.join("\n\n")}\n</goals>`;
}

function buildNarrativeSection(narrative?: string): string | null {
  if (!narrative?.trim()) return null;
  return `<week-narrative>\n${narrative.trim()}\n</week-narrative>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const FOCUS_PREAMBLE = `[FOCUS CONVERSATION]

The user started this conversation from the Focus surface — their strategic planning view. They want to discuss their week, goals, or time allocation. You have their current context below.`;

const FOCUS_CLOSING = `Respond conversationally. Help with planning, meeting audit, time allocation, or goal progress — whatever the user asks about.`;

const FOCUS_EMPTY_PREAMBLE = `[FOCUS CONVERSATION]

The user started this conversation from the Focus surface — their strategic planning view. They want to discuss their week, goals, or time allocation.

No calendar data, goals, or week narrative are available yet. Help them get started — ask what they'd like to plan or discuss.`;

/**
 * Assemble Focus-specific context from meetings, goals, and narrative
 * into a structured preamble string for injection into a user message.
 *
 * Returns a simplified preamble when no data sections are available.
 *
 * Used by the renderer-side useFocusConversation hook for backward compatibility.
 */
export function assembleFocusContext(
  meetings: CachedMeeting[],
  goals: Goal[],
  narrative: string | undefined,
  now: Date,
  timeZone: string,
): string {
  const calendarSection = buildCalendarSection(meetings, now, timeZone);
  const goalsSection = buildGoalsSection(goals);
  const narrativeSection = buildNarrativeSection(narrative);

  const sections = [calendarSection, goalsSection, narrativeSection].filter(
    Boolean,
  );

  if (sections.length === 0) {
    log.warn("No Focus context data available — using empty preamble");
    return FOCUS_EMPTY_PREAMBLE;
  }

  const contextBlock = `<focus-context>\n${sections.join("\n\n")}\n</focus-context>`;

  return `${FOCUS_PREAMBLE}\n\n${contextBlock}\n\n${FOCUS_CLOSING}`;
}

/**
 * Assemble raw Focus context for injection with space-aware goals.
 *
 * Returns raw content WITHOUT the outer `<focus-context>` XML wrapper
 * (buildUserMessageContext adds that). Accepts SpaceGoals[] for richer
 * space-attributed goal display.
 *
 * Returns null if no context data is available.
 *
 * @see docs/plans/260407_focus_goals_redesign.md — Stage 6 migration
 */
export function assembleFocusContextForInjectionV2(
  meetings: CachedMeeting[],
  spaceGoals: SpaceGoals[],
  now: Date,
  timeZone: string,
): string | null {
  const calendarSection = buildCalendarSection(meetings, now, timeZone);
  const goalsSection = buildSpaceGoalsSection(spaceGoals);

  const sections = [calendarSection, goalsSection].filter(Boolean);

  if (sections.length === 0) {
    log.warn("No Focus context data available for injection");
    return null;
  }

  const parts = [
    "[FOCUS CONVERSATION]",
    "",
    "The user started this conversation from the Focus surface — their strategic planning view.",
    "They want to discuss their week, goals, or time allocation. You have their current context below.",
    "",
    ...sections,
    "",
    "Respond conversationally. Help with planning, meeting audit, time allocation, or goal progress — whatever the user asks about.",
  ];

  return parts.join("\n");
}
