/**
 * Focus Surface IPC Handlers
 *
 * Wires Focus IPC channels to the goalsStore service.
 * Feature flag gate: when `settings.experimental.focusEnabled` is false,
 * handlers return empty/error responses.
 *
 * For mutation handlers (create/update/delete), triggers frontmatter
 * projection after the store mutation for backward compatibility with
 * agent prompts.
 *
 * @see src/core/services/goalsStore.ts
 * @see src/shared/ipc/channels/focus.ts
 * @see docs/plans/260406_focus_phase2_surface_shell.md
 */

import { registerHandler } from './utils/registerHandler';
import { focusChannels } from '@shared/ipc/channels/focus';
import { createScopedLogger } from '@core/logger';
import { getSettings, updateSettings } from '@core/services/settingsStore';
import {
  getGoals,
  getStoreMetadata,
  createGoal,
  updateGoal,
  deleteGoal,
  markGoalsReviewed,
  migrateFromFrontmatter,
  projectToFrontmatter,
} from '@core/services/goalsStore';
import { classifyMeetingType, extractDomainFromCalendarSource } from '@core/services/meetingTypeClassifier';
import { getCachedMeetings } from '@core/services/meetingCacheStore';
import { computeGoalAlignment } from '@core/services/goalAlignmentService';
import { DateTime } from 'luxon';
import { filterMeetingsToCurrentWeek, getCurrentWeekBounds, getIsoWeekKeyInTz, getWeekBoundsForOffset, getMonthBoundsForOffset } from '@core/services/calendarTimeUtils';
import type { PrepEnrichment } from '@core/services/prepAlignmentTypes';
import { getMeetingsInRange } from '../services/meetingHistoryStore';
import { resolveAllSpaceGoals, resolveAllSpaceGoalsDetailed } from '../services/focusGoalsResolver';
import { scanPrepDocsInRange } from '../services/prepDocScanner';
import { scanSpaces } from '../services/spaceService';
import { writeFileAtomic } from '../utils/atomicFs';

const log = createScopedLogger({ service: 'focusHandlers' });

/** Check whether the Focus experimental feature flag is enabled. */
function isFocusEnabled(): boolean {
  try {
    const settings = getSettings();
    return settings.experimental?.focusEnabled === true;
  } catch {
    return false;
  }
}

/** Get the core directory from settings, or null if not set. */
function getCoreDirectory(): string | null {
  try {
    const settings = getSettings();
    return settings.coreDirectory || null;
  } catch {
    return null;
  }
}

/** Fire-and-forget frontmatter projection after a mutation. */
function triggerProjection(): void {
  const coreDir = getCoreDirectory();
  if (!coreDir) return;

  projectToFrontmatter(coreDir, { writeFileAtomic }).catch(err => {
    log.warn({ err }, 'Failed to project goals to frontmatter');
  });
}

export function registerFocusHandlers(): void {
  // ── Get goals ───────────────────────────────────────────────────
  const getGoalsChannel = focusChannels['focus:get-goals'];
  registerHandler(getGoalsChannel.channel, async () => {
    if (!isFocusEnabled()) {
      return {
        goals: [],
        lastWeeklyReview: null,
        lastMonthlyReview: null,
        migratedFromFrontmatterAt: null,
      };
    }
    const goals = getGoals();
    const metadata = getStoreMetadata();
    return { goals, ...metadata };
  });

  // ── Create goal ─────────────────────────────────────────────────
  const createGoalChannel = focusChannels['focus:create-goal'];
  registerHandler(createGoalChannel.channel, async (_event, ...args) => {
    if (!isFocusEnabled()) {
      throw new Error('Focus is not enabled');
    }
    const input = createGoalChannel.request.parse(args[0]);
    const goal = createGoal(input);
    triggerProjection();
    return { goal };
  });

  // ── Update goal ─────────────────────────────────────────────────
  const updateGoalChannel = focusChannels['focus:update-goal'];
  registerHandler(updateGoalChannel.channel, async (_event, ...args) => {
    if (!isFocusEnabled()) {
      throw new Error('Focus is not enabled');
    }
    const { id, ...input } = updateGoalChannel.request.parse(args[0]);
    const goal = updateGoal(id, input);
    if (goal) {
      triggerProjection();
    }
    return { goal };
  });

  // ── Delete goal ─────────────────────────────────────────────────
  const deleteGoalChannel = focusChannels['focus:delete-goal'];
  registerHandler(deleteGoalChannel.channel, async (_event, ...args) => {
    if (!isFocusEnabled()) {
      throw new Error('Focus is not enabled');
    }
    const { id } = deleteGoalChannel.request.parse(args[0]);
    const success = deleteGoal(id);
    if (success) {
      triggerProjection();
    }
    return { success };
  });

  // ── Review goals ────────────────────────────────────────────────
  const reviewGoalsChannel = focusChannels['focus:review-goals'];
  registerHandler(reviewGoalsChannel.channel, async () => {
    if (!isFocusEnabled()) {
      throw new Error('Focus is not enabled');
    }
    markGoalsReviewed();
    return { success: true };
  });

  // ── Migrate from frontmatter ────────────────────────────────────
  const migrateChannel = focusChannels['focus:migrate-from-frontmatter'];
  registerHandler(migrateChannel.channel, async () => {
    if (!isFocusEnabled()) {
      return { migrated: false, goalCount: 0 };
    }
    const coreDir = getCoreDirectory();
    if (!coreDir) {
      log.warn('No core directory configured, cannot migrate from frontmatter');
      return { migrated: false, goalCount: 0 };
    }
    return await migrateFromFrontmatter(coreDir);
  });

  // ── Get month stats ─────────────────────────────────────────────
  const monthStatsChannel = focusChannels['focus:get-month-stats'];
  registerHandler(monthStatsChannel.channel, async (_event, ...args) => {
    const emptyResponse = {
      totalMeetings: 0, totalMeetingHoursEstimate: 0, meetingsByWeek: [],
      transcriptsCaptured: 0, goalsCreated: 0, goalsCompleted: 0,
      goalsDropped: 0, activeGoalCount: 0, lastReviewedAt: null,
      dataSpanDays: 0, oldestEntryAt: null,
      soloTotal: 0, internalTotal: 0, externalTotal: 0,
      deepWorkHoursEstimate: 0, meetingVolumeTrend: 'stable' as const,
      stalledGoals: [] as string[],
    };

    if (!isFocusEnabled()) return emptyResponse;

    try {
      const { monthOffset: rawMonthOffset } = monthStatsChannel.request.parse(args[0] ?? {});
      const monthOffset = rawMonthOffset != null
        ? Math.round(Math.max(-12, Math.min(12, rawMonthOffset)))
        : 0;

      const now = Date.now();
      const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const WORK_HOURS_PER_WEEK = 40;

      // Time window: calendar month bounds for non-zero offset, rolling ±2wk for current
      let windowStart: Date;
      let windowEnd: Date;
      if (monthOffset !== 0) {
        const bounds = getMonthBoundsForOffset(monthOffset, userTimeZone);
        windowStart = bounds.start;
        windowEnd = bounds.end;
      } else {
        windowStart = new Date(now - 14 * 24 * 60 * 60 * 1000);
        windowEnd = new Date(now + 14 * 24 * 60 * 60 * 1000);
      }

      // Past meetings from history, future from cache
      const pastMeetings = windowStart.getTime() < now
        ? getMeetingsInRange(windowStart, new Date(Math.min(windowEnd.getTime(), now)))
        : [];
      const cache = getCachedMeetings();
      const futureMeetings = (cache?.meetings ?? []).filter(m => {
        const ms = new Date(m.startTime).getTime();
        return ms > now && ms >= windowStart.getTime() && ms <= windowEnd.getTime();
      });
      const meetings = [...pastMeetings, ...futureMeetings];

      // Detect user domain for meeting type classification
      const firstSource = meetings.find(m => m.calendarSource)?.calendarSource;
      const userDomain = firstSource ? extractDomainFromCalendarSource(firstSource) : undefined;

      // Per-week buckets with type breakdown
      const weekBuckets = new Map<string, {
        count: number; hours: number; solo: number; internal: number; external: number;
      }>();
      let totalHours = 0;
      let nonSoloHours = 0;
      let transcriptsCaptured = 0;
      let oldestEntryMs: number | null = null;
      let soloTotal = 0, internalTotal = 0, externalTotal = 0;

      for (const meeting of meetings) {
        const startMs = new Date(meeting.startTime).getTime();
        const endMs = new Date(meeting.endTime).getTime();
        const durationHours = Math.max(0, (endMs - startMs) / (1000 * 60 * 60));
        totalHours += durationHours;

        if ('transcriptStatus' in meeting && meeting.transcriptStatus === 'captured') transcriptsCaptured++;
        if (oldestEntryMs === null || startMs < oldestEntryMs) oldestEntryMs = startMs;

        const meetingType = classifyMeetingType(meeting, userDomain);
        if (meetingType === 'solo') {
          soloTotal++;
        } else if (meetingType === 'internal') {
          internalTotal++;
          nonSoloHours += durationHours;
        } else {
          externalTotal++;
          nonSoloHours += durationHours;
        }

        const weekKey = getIsoWeekKeyInTz(new Date(meeting.startTime), userTimeZone);

        const bucket = weekBuckets.get(weekKey) ?? { count: 0, hours: 0, solo: 0, internal: 0, external: 0 };
        bucket.count++;
        bucket.hours += durationHours;
        if (meetingType === 'solo') bucket.solo++;
        else if (meetingType === 'internal') bucket.internal++;
        else bucket.external++;
        weekBuckets.set(weekKey, bucket);
      }

      const meetingsByWeek = Array.from(weekBuckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekKey, bucket]) => {
          const weekLabel = `Week of ${DateTime.fromISO(weekKey, { zone: userTimeZone, locale: 'en-US' }).toFormat('MMM d')}`;
          return {
            weekLabel,
            meetingCount: bucket.count,
            meetingHours: Math.round(bucket.hours * 10) / 10,
            solo: bucket.solo,
            internal: bucket.internal,
            external: bucket.external,
          };
        });

      // Meeting volume trend
      const weeklyTotals = meetingsByWeek.map(w => w.meetingCount);
      let meetingVolumeTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
      if (weeklyTotals.length >= 2) {
        const firstHalf = weeklyTotals.slice(0, Math.ceil(weeklyTotals.length / 2));
        const secondHalf = weeklyTotals.slice(Math.ceil(weeklyTotals.length / 2));
        const avgFirst = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
        const avgSecond = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
        const diff = avgSecond - avgFirst;
        if (diff > 1) meetingVolumeTrend = 'increasing';
        else if (diff < -1) meetingVolumeTrend = 'decreasing';
      }

      // Deep work = work week minus actual meetings (solo blocks are focus time, not meetings)
      const weeksCount = meetingsByWeek.length || 1;
      const avgWeeklyMeetingHours = nonSoloHours / weeksCount;
      const deepWorkHoursEstimate = Math.round(Math.max(0, WORK_HOURS_PER_WEEK - avgWeeklyMeetingHours) * 10) / 10;

      const dataSpanDays = oldestEntryMs !== null
        ? Math.round((now - oldestEntryMs) / (1000 * 60 * 60 * 24)) : 0;

      // Goals — read from space README frontmatter (frontmatter-first design)
      // Lifecycle fields (goalsCreated/completed/dropped) are intentionally zeroed out
      // since frontmatter has no timestamps/status. This is an accepted tradeoff —
      // goals are living context, not tracked KPIs.
      const spaceGoals = await resolveAllSpaceGoals();
      const allFrontmatterGoals = spaceGoals.flatMap(sg => sg.goals);

      return {
        totalMeetings: meetings.length,
        totalMeetingHoursEstimate: Math.round(totalHours * 10) / 10,
        meetingsByWeek,
        transcriptsCaptured,
        goalsCreated: 0,       // Not tracked in frontmatter-first design
        goalsCompleted: 0,     // Not tracked in frontmatter-first design
        goalsDropped: 0,       // Not tracked in frontmatter-first design
        activeGoalCount: allFrontmatterGoals.length,
        lastReviewedAt: null,  // Not tracked in frontmatter-first design
        dataSpanDays,
        oldestEntryAt: oldestEntryMs,
        soloTotal,
        internalTotal,
        externalTotal,
        deepWorkHoursEstimate,
        meetingVolumeTrend,
        stalledGoals: [],      // Not tracked in frontmatter-first design
      };
    } catch (err) {
      log.warn({ err }, 'Failed to compute month stats');
      return emptyResponse;
    }
  });

  // ── Get all space goals (frontmatter-first) ─────────────────────
  const getAllSpaceGoalsChannel = focusChannels['focus:get-all-space-goals'];
  registerHandler(getAllSpaceGoalsChannel.channel, async () => {
    if (!isFocusEnabled()) {
      return { spaces: [], parseErrors: [] };
    }

    try {
      const { withGoals, spacesWithoutGoals } = await resolveAllSpaceGoalsDetailed();

      const settings = getSettings();
      const dismissedPaths = settings.dismissedFocusGoalSpaces ?? [];
      const dismissed = new Set(dismissedPaths);
      const spaces = withGoals.filter(sg => !dismissed.has(sg.spacePath));

      return { spaces, parseErrors: [], dismissedPaths, spacesWithoutGoals };
    } catch (err) {
      log.warn({ err }, 'Failed to get all space goals');
      return { spaces: [], parseErrors: [], dismissedPaths: [], spacesWithoutGoals: [] };
    }
  });

  // ── Dismiss space goals ─────────────────────────────────────────
  const dismissChannel = focusChannels['focus:dismiss-space-goals'];
  registerHandler(dismissChannel.channel, async (_event, ...args) => {
    if (!isFocusEnabled()) {
      throw new Error('Focus is not enabled');
    }

    const { spacePath } = dismissChannel.request.parse(args[0]);
    const settings = getSettings();
    const current = settings.dismissedFocusGoalSpaces ?? [];

    if (!current.includes(spacePath)) {
      updateSettings({ dismissedFocusGoalSpaces: [...current, spacePath] });
    }

    return { success: true };
  });

  // ── Restore space goals ─────────────────────────────────────────
  const restoreChannel = focusChannels['focus:restore-space-goals'];
  registerHandler(restoreChannel.channel, async (_event, ...args) => {
    if (!isFocusEnabled()) {
      throw new Error('Focus is not enabled');
    }

    const { spacePath } = restoreChannel.request.parse(args[0]);
    const settings = getSettings();
    const current = settings.dismissedFocusGoalSpaces ?? [];

    updateSettings({
      dismissedFocusGoalSpaces: current.filter(p => p !== spacePath),
    });

    return { success: true };
  });

  // ── Get goal-calendar alignment ─────────────────────────────────
  const goalAlignmentChannel = focusChannels['focus:get-goal-alignment'];
  registerHandler(goalAlignmentChannel.channel, async (_event, ...args) => {
    const makeEmpty = (g: 'week' | 'month') => ({
      goals: [] as Array<{
        goalText: string; spaceName: string; isPersonal: boolean;
        alignedHours: number; alignedMeetingCount: number;
        alignedMeetingTitles: string[]; status: 'matched' | 'no_matches' | 'no_usable_keywords';
      }>,
      totalMeetingHours: 0,
      totalMeetingCount: 0,
      unalignedHours: 0,
      unalignedCount: 0,
      preppedMeetingCount: 0,
      excludedAsNoiseCount: 0,
      granularity: g,
    });

    const { granularity, weekOffset: rawWeekOffset, monthOffset: rawMonthOffset } = goalAlignmentChannel.request.parse(args[0]);

    if (!isFocusEnabled()) return makeEmpty(granularity);

    try {

      // Resolve goals, filtered by dismissed spaces (matches GoalsSidebar behavior)
      const allSpaceGoals = await resolveAllSpaceGoals();
      const settings = getSettings();
      const dismissedPaths = new Set(settings.dismissedFocusGoalSpaces ?? []);
      const filteredGoals = allSpaceGoals.filter(sg => !dismissedPaths.has(sg.spacePath));

      // Get meetings based on granularity, shifted by optional offsets
      const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      let meetings: Array<{ title: string; startTime: string; endTime: string }>;
      let prepScanStartDate: Date;
      let prepScanEndDate: Date;
      if (granularity === 'week') {
        const now = new Date();
        const effectiveWeekOffset = rawWeekOffset ?? 0;

        if (effectiveWeekOffset === 0) {
          // Current week: use meeting cache (existing behavior)
          const cache = getCachedMeetings();
          meetings = filterMeetingsToCurrentWeek(cache?.meetings ?? [], now, userTimeZone);
          const { weekStart, weekEnd } = getCurrentWeekBounds(now, userTimeZone);
          prepScanStartDate = weekStart;
          prepScanEndDate = weekEnd;
        } else {
          // Offset week: combine history + cache for target range
          const { start, end } = getWeekBoundsForOffset(effectiveWeekOffset, userTimeZone);
          prepScanStartDate = start;
          prepScanEndDate = end;
          const nowMs = Date.now();
          const pastMeetings = start.getTime() < nowMs
            ? getMeetingsInRange(start, new Date(Math.min(end.getTime(), nowMs)))
            : [];
          const cache = getCachedMeetings();
          const futureMeetings = (cache?.meetings ?? []).filter(m => {
            const ms = new Date(m.startTime).getTime();
            return ms > nowMs && ms >= start.getTime() && ms <= end.getTime();
          });
          meetings = [...pastMeetings, ...futureMeetings];
        }
      } else {
        const effectiveMonthOffset = rawMonthOffset ?? 0;

        if (effectiveMonthOffset === 0) {
          // Current month: rolling ±2 week window (existing behavior)
          const now = Date.now();
          prepScanStartDate = new Date(now - 14 * 24 * 60 * 60 * 1000);
          prepScanEndDate = new Date(now + 14 * 24 * 60 * 60 * 1000);
          const pastMeetings = getMeetingsInRange(prepScanStartDate, new Date(now));
          const cache = getCachedMeetings();
          const futureMeetings = (cache?.meetings ?? []).filter(m => {
            const ms = new Date(m.startTime).getTime();
            return ms > now && ms <= prepScanEndDate.getTime();
          });
          meetings = [...pastMeetings, ...futureMeetings];
        } else {
          // Offset month: calendar month bounds
          const { start, end } = getMonthBoundsForOffset(effectiveMonthOffset, userTimeZone);
          prepScanStartDate = start;
          prepScanEndDate = end;
          const nowMs = Date.now();
          const pastMeetings = start.getTime() < nowMs
            ? getMeetingsInRange(start, new Date(Math.min(end.getTime(), nowMs)))
            : [];
          const cache = getCachedMeetings();
          const futureMeetings = (cache?.meetings ?? []).filter(m => {
            const ms = new Date(m.startTime).getTime();
            return ms > nowMs && ms >= start.getTime() && ms <= end.getTime();
          });
          meetings = [...pastMeetings, ...futureMeetings];
        }
      }

      let prepEnrichments: Map<string, PrepEnrichment> | undefined;
      const coreDirectory = getCoreDirectory();
      if (coreDirectory) {
        try {
          // Prep docs are saved under the Chief-of-Staff space (via determineTargetSpace),
          // NOT directly under coreDirectory. Resolve the CoS space path for scanning.
          // Read-only: CoS path lookup must not mutate frontmatter.
          // See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
          const spaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
          const cosSpace = spaces.find(s => s.type === 'chief-of-staff');
          const prepBasePath = cosSpace?.absolutePath ?? coreDirectory;
          prepEnrichments = scanPrepDocsInRange(prepBasePath, prepScanStartDate, prepScanEndDate);
        } catch (err) {
          log.warn({ err, granularity }, 'Failed to scan prep doc enrichments. Falling back to keyword alignment');
          prepEnrichments = new Map();
        }
      }

      return computeGoalAlignment(filteredGoals, meetings, granularity, prepEnrichments);
    } catch (err) {
      log.warn({ err }, 'Failed to compute goal alignment');
      throw new Error('Failed to compute goal alignment');
    }
  });
}
