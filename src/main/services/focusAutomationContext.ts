/**
 * Focus Automation Context Builder
 *
 * Gathers calendar, goals, and meeting history data and pre-computes
 * structured analytics for Focus automation prompts. Runs in main process.
 *
 * The output is a single 'focusData' key injected via eventContext into the
 * automation prompt. The assembler in @core does the pure computation;
 * this module handles data gathering from stores.
 *
 * Goals are read from space README frontmatter via spaceGoalsReader
 * (frontmatter-first design — see docs/plans/260407_focus_goals_redesign.md).
 *
 * @see src/core/services/focusPrepDataAssembler.ts — pure computation
 * @see src/main/services/automationScheduler.ts — injection point
 * @see src/main/services/focusGoalsResolver.ts — shared space goal resolution
 */

import path from 'node:path';
import { DateTime } from 'luxon';
import { createScopedLogger } from '@core/logger';
import { getCachedMeetings } from '@core/services/meetingCacheStore';
import { getSettings } from '@core/services/settingsStore';
import { getCurrentWeekBounds } from '@core/services/calendarTimeUtils';
import {
  assembleWeeklyPrepData,
  assembleMonthlyReviewData,
  formatWeeklyPrepDataForPrompt,
  formatMonthlyReviewDataForPrompt,
  extractDomainFromCalendarSource,
} from '@core/services/focusPrepDataAssembler';
import type { Goal } from '@core/goalTypes';
import type { SpaceGoals } from '@core/services/spaceGoalsReader';
import { getMeetingsInRange } from './meetingHistoryStore';
import { resolveAllSpaceGoals } from './focusGoalsResolver';
import { findPrepDocPaths } from './prepDocScanner';
import { scanSpaces } from './spaceService';

const log = createScopedLogger({ service: 'focusAutomationContext' });

/**
 * Flatten SpaceGoals[] to Goal[] for focusPrepDataAssembler compatibility.
 *
 * Intentionally loses lifecycle fields (status/timestamps) — frontmatter-first
 * design means goals don't have store-level lifecycle tracking.
 * All goals are treated as active with fabricated timestamps.
 */
function flattenSpaceGoalsForAssembler(spaceGoals: SpaceGoals[]): Goal[] {
  // Frontmatter has no lifecycle timestamps. Use values that produce neutral metrics:
  // - createdAt: 0 → nothing appears "recently created" (correct: we don't know)
  // - updatedAt: now → nothing appears "stalled" (acceptable: no data to judge)
  // - status: active → completed/dropped counts stay 0 (correct: frontmatter only has active goals)
  const now = Date.now();
  return spaceGoals.flatMap(sg => sg.goals.map(g => ({
    id: `${sg.spacePath}/${g.goal}`.slice(0, 36),
    text: g.goal,
    why: g.why,
    status: 'active' as const,
    createdAt: 0,
    updatedAt: now,
  })));
}

/**
 * Build pre-computed context for a Focus automation.
 * Returns a Record suitable for merging into the automation's eventContext.
 */
export async function buildFocusAutomationContext(
  systemType: 'focus-weekly-prep' | 'focus-monthly-review'
): Promise<{ focusData: string; targetPeriodStart: number }> {
  // Compute period anchor — independent of goals/calendar data, so do it outside try/catch
  const now = new Date();
  const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let targetPeriodStart: number;
  if (systemType === 'focus-weekly-prep') {
    const { weekStart } = getCurrentWeekBounds(now, userTimeZone);
    targetPeriodStart = weekStart.getTime();
  } else {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    monthStart.setHours(0, 0, 0, 0);
    targetPeriodStart = monthStart.getTime();
  }

  try {
    const spaceGoals = await resolveAllSpaceGoals();
    const goals = flattenSpaceGoalsForAssembler(spaceGoals);
    const userDomain = detectUserDomain();
    const coreDirectory = getCoreDirectory();

    // Prep docs are saved under the Chief-of-Staff space (via determineTargetSpace),
    // NOT directly under coreDirectory. Resolve CoS space path for prep doc scanning.
    let prepBasePath = coreDirectory;
    if (coreDirectory) {
      try {
        // Read-only: CoS path lookup must not mutate frontmatter.
        // See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
        const spaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
        const cosSpace = spaces.find(s => s.type === 'chief-of-staff');
        if (cosSpace) prepBasePath = cosSpace.absolutePath;
      } catch (err) {
        log.warn({ err }, 'Failed to resolve CoS space path for prep docs, falling back to coreDirectory');
      }
    }

    if (systemType === 'focus-weekly-prep') {
      return { focusData: buildWeeklyContext(goals, spaceGoals, prepBasePath, userDomain), targetPeriodStart };
    }
    return { focusData: buildMonthlyContext(goals, spaceGoals, prepBasePath, userDomain), targetPeriodStart };
  } catch (err) {
    log.warn({ err, systemType }, 'Failed to build focus automation context — automation will run without pre-computed data');
    return { focusData: '', targetPeriodStart };
  }
}

function detectUserDomain(): string | undefined {
  try {
    const settings = getSettings();
    const calendarSource = settings.calendar?.connectedCalendars?.[0]?.source;
    if (calendarSource) {
      return extractDomainFromCalendarSource(calendarSource);
    }
    // Fallback: try to extract from any cached meeting's calendarSource
    const cache = getCachedMeetings();
    if (cache?.meetings?.[0]?.calendarSource) {
      return extractDomainFromCalendarSource(cache.meetings[0].calendarSource);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function getCoreDirectory(): string | null {
  try {
    const settings = getSettings();
    return settings.coreDirectory || null;
  } catch {
    return null;
  }
}

function formatGoalsSummarySection(spaceGoals: SpaceGoals[]): string {
  const lines = spaceGoals.flatMap(space =>
    space.goals.map(goal => {
      const quotedGoal = JSON.stringify(goal.goal);
      if (goal.why?.trim()) {
        return `- ${space.spaceName}: ${quotedGoal} (why: ${goal.why.trim()})`;
      }
      return `- ${space.spaceName}: ${quotedGoal}`;
    })
  );

  if (lines.length === 0) {
    return `### User's Current Goals (for classification reference)
- No goals found in current space READMEs.`;
  }

  return `### User's Current Goals (for classification reference)
${lines.join('\n')}`;
}

function toRelativePortablePath(coreDirectory: string, prepPath: string): string {
  const relativePath = path.isAbsolute(prepPath)
    ? path.relative(coreDirectory, prepPath)
    : prepPath;
  return relativePath.split(path.sep).join('/');
}

function buildPrepDocsSection(prepBasePath: string | null, startDate: Date, endDate: Date): string | null {
  if (!prepBasePath) {
    return null;
  }

  try {
    const prepDocs = findPrepDocPaths(prepBasePath, startDate, endDate);
    if (prepDocs.length === 0) {
      return null;
    }

    const lines = prepDocs.map(doc => {
      const relativePath = toRelativePortablePath(prepBasePath, doc.path);
      return `- ${relativePath} | ${doc.title} | ${doc.meetingStartTime} | enrichment: ${doc.hasEnrichment ? 'yes' : 'no'}`;
    });

    return `### Meeting Prep Documents

The following meeting prep documents exist for meetings in this period.
For each one that does NOT already have goal alignment enrichment, classify
the meeting and call the \`focus_enrich_meeting_prep\` tool.

${lines.join('\n')}`;
  } catch (err) {
    log.warn({ err }, 'Failed to collect prep doc metadata for automation context');
    return null;
  }
}

function buildWeeklyContext(
  goals: Goal[],
  spaceGoals: SpaceGoals[],
  prepBasePath: string | null,
  userDomain?: string
): string {
  const now = new Date();
  const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { weekStart, weekEnd } = getCurrentWeekBounds(now, userTimeZone);

  // This week: from meeting cache (upcoming/current week)
  const cache = getCachedMeetings();
  const thisWeekMeetings = (cache?.meetings ?? []).filter(m => {
    const ms = new Date(m.startTime).getTime();
    return ms >= weekStart.getTime() && ms <= weekEnd.getTime();
  });

  // Last week: from meeting history (past data)
  // Derive from weekStart using luxon calendar math — NOT ms subtraction (DST-unsafe)
  const lastWeekDt = DateTime.fromJSDate(weekStart, { zone: userTimeZone }).minus({ weeks: 1 });
  const lastWeekStart = lastWeekDt.startOf('week').toJSDate();
  const lastWeekEnd = lastWeekDt.endOf('week').toJSDate();
  const lastWeekMeetings = getMeetingsInRange(lastWeekStart, lastWeekEnd);

  const data = assembleWeeklyPrepData(thisWeekMeetings, lastWeekMeetings, goals, userDomain, userTimeZone);

  log.info({
    thisWeekMeetings: thisWeekMeetings.length,
    lastWeekMeetings: lastWeekMeetings.length,
    goals: goals.length,
    hasUserDomain: Boolean(userDomain),
  }, 'Built weekly prep context');

  const sections: string[] = [
    formatWeeklyPrepDataForPrompt(data),
    formatGoalsSummarySection(spaceGoals),
  ];

  const prepSection = buildPrepDocsSection(prepBasePath, lastWeekStart, weekEnd);
  if (prepSection) {
    sections.push(prepSection);
  }

  return sections.join('\n\n');
}

function buildMonthlyContext(
  goals: Goal[],
  spaceGoals: SpaceGoals[],
  prepBasePath: string | null,
  userDomain?: string
): string {
  const now = new Date();
  const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const twoWeeksAhead = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  // Rolling 4-week window: ~2 weeks back (history) + ~2 weeks ahead (upcoming)
  const pastMeetings = getMeetingsInRange(twoWeeksAgo, now);
  const cache = getCachedMeetings();
  const futureMeetings = (cache?.meetings ?? []).filter(m => {
    const ms = new Date(m.startTime).getTime();
    return ms > now.getTime() && ms <= twoWeeksAhead.getTime();
  });
  const allMeetings = [...pastMeetings, ...futureMeetings];

  const data = assembleMonthlyReviewData(allMeetings, goals, userDomain, now, userTimeZone);

  log.info({
    pastMeetings: pastMeetings.length,
    futureMeetings: futureMeetings.length,
    goals: goals.length,
    weeks: data.weekByWeekBreakdown.length,
  }, 'Built monthly review context (±2 week window)');

  const sections: string[] = [
    formatMonthlyReviewDataForPrompt(data),
    formatGoalsSummarySection(spaceGoals),
  ];

  const prepSection = buildPrepDocsSection(prepBasePath, twoWeeksAgo, twoWeeksAhead);
  if (prepSection) {
    sections.push(prepSection);
  }

  return sections.join('\n\n');
}
