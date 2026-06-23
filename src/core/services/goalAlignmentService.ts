/**
 * Goal-Calendar Alignment Service
 *
 * Pure function that computes duration-based alignment between user goals
 * (from space README frontmatter) and calendar meetings. Used by the
 * Focus "Time & Goals" visualization.
 *
 * Algorithm: Extract keywords from goal text + why fields, match against
 * meeting titles via word intersection. Same approach as
 * `focusPrepDataAssembler.ts` (findGoalMeetingAlignment) but returns
 * duration-based structured data for UI rendering.
 *
 * Coverage model: one meeting can match multiple goals. "Unaligned" =
 * meetings matching zero goals (exclusive).
 *
 * @see src/core/services/focusPrepDataAssembler.ts — original keyword matching
 * @see docs/plans/260409_focus_time_vs_goals_visualization.md
 */

import type { SpaceGoals } from './spaceGoalsTypes';
import type { MeetingUtility, PrepEnrichment } from './prepAlignmentTypes';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

/** Minimal meeting shape for alignment computation. */
export interface AlignmentMeetingLike {
  title: string;
  startTime: string;
  endTime: string;
}

/** Per-goal alignment result. */
export interface GoalAlignmentEntry {
  goalText: string;
  spaceName: string;
  isPersonal: boolean;
  alignedHours: number;
  alignedMeetingCount: number;
  /** Capped at 5 titles to prevent payload bloat. */
  alignedMeetingTitles: string[];
  status: 'matched' | 'no_matches' | 'no_usable_keywords';
}

/** Full alignment computation result. */
export interface GoalAlignmentResult {
  goals: GoalAlignmentEntry[];
  totalMeetingHours: number;
  totalMeetingCount: number;
  unalignedHours: number;
  unalignedCount: number;
  preppedMeetingCount: number;
  excludedAsNoiseCount: number;
  granularity: 'week' | 'month';
}

/** Maximum meeting titles to include per goal (prevents payload bloat). */
const MAX_TITLES_PER_GOAL = 5;

/** Threshold in hours — meetings spanning 24+ hours are treated as all-day events. */
const ALL_DAY_THRESHOLD_HOURS = 24;

// ─────────────────────────────────────────────────────────────
// Keyword extraction (same algorithm as focusPrepDataAssembler)
// ─────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that',
  'these', 'those', 'my', 'your', 'our', 'their', 'its', 'i', 'me',
  'we', 'us', 'you', 'he', 'she', 'it', 'they', 'them', 'not', 'no',
  'so', 'if', 'up', 'out', 'get', 'make', 'more', 'also', 'just',
]);

/**
 * Extract meaningful keywords from text.
 * Words > 2 chars, lowercased, non-alphanumeric stripped, stop words filtered.
 */
function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ─────────────────────────────────────────────────────────────
// Duration helpers
// ─────────────────────────────────────────────────────────────

function getMeetingDurationHours(m: AlignmentMeetingLike): number {
  const start = new Date(m.startTime).getTime();
  const end = new Date(m.endTime).getTime();
  if (isNaN(start) || isNaN(end)) return 0;
  return Math.max(0, (end - start) / (1000 * 60 * 60));
}

function isAllDayEvent(m: AlignmentMeetingLike): boolean {
  return getMeetingDurationHours(m) >= ALL_DAY_THRESHOLD_HOURS;
}

/**
 * Normalize an ISO timestamp to epoch ms for robust comparison.
 * Handles format differences: with/without milliseconds, timezone offsets vs Z, etc.
 */
function normalizeTimestampKey(isoString: string): string {
  const ms = new Date(isoString).getTime();
  return isNaN(ms) ? isoString : String(ms);
}

/** Build a normalized lookup map from prep enrichments keyed by epoch ms. */
function buildNormalizedPrepMap(
  prepEnrichments: Map<string, PrepEnrichment> | undefined
): Map<string, PrepEnrichment> | undefined {
  if (!prepEnrichments || prepEnrichments.size === 0) return undefined;
  const normalized = new Map<string, PrepEnrichment>();
  for (const [key, value] of prepEnrichments) {
    normalized.set(normalizeTimestampKey(key), value);
  }
  return normalized;
}

function getGoalCompositeKey(spaceName: string, goalText: string): string {
  return `${spaceName}::${goalText}`;
}

function hasKeywordOverlap(meetingKeywords: Set<string>, goalKeywords: Set<string>): boolean {
  for (const keyword of meetingKeywords) {
    if (goalKeywords.has(keyword)) return true;
  }
  return false;
}

function getPreppedMeetingHandling(utility: MeetingUtility, goalAlignmentCount: number): {
  includeInTotals: boolean;
  excludedAsNoise: boolean;
} {
  switch (utility) {
    case 'productive':
      return { includeInTotals: true, excludedAsNoise: false };
    case 'travel':
      return { includeInTotals: goalAlignmentCount > 0, excludedAsNoise: false };
    case 'blocker':
    case 'noise':
      return { includeInTotals: false, excludedAsNoise: true };
    default: {
      const unreachable: never = utility;
      throw new Error(`Unhandled meeting utility: ${unreachable}`);
    }
  }
}

interface GoalAccumulator {
  goalText: string;
  spaceName: string;
  isPersonal: boolean;
  keywords: Set<string>;
  alignedHours: number;
  alignedMeetingCount: number;
  alignedMeetingTitles: string[];
}

function applyPrepAlignmentToGoalEntries(
  enrichment: PrepEnrichment,
  meeting: AlignmentMeetingLike,
  durationHours: number,
  goalIndicesByCompositeKey: Map<string, number[]>,
  goalEntries: GoalAccumulator[],
): boolean {
  const matchedGoalIndices = new Set<number>();

  for (const pair of enrichment.goalAlignment) {
    const matchingIndices = goalIndicesByCompositeKey.get(getGoalCompositeKey(pair.space, pair.goal));
    if (!matchingIndices) continue;
    for (const index of matchingIndices) {
      matchedGoalIndices.add(index);
    }
  }

  for (const index of matchedGoalIndices) {
    const goalEntry = goalEntries[index];
    goalEntry.alignedHours += durationHours;
    goalEntry.alignedMeetingCount += 1;
    if (goalEntry.alignedMeetingTitles.length < MAX_TITLES_PER_GOAL) {
      goalEntry.alignedMeetingTitles.push(meeting.title);
    }
  }

  return matchedGoalIndices.size > 0;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Compute duration-based alignment between goals and meetings.
 *
 * Pure function — no side effects, no Electron imports.
 *
 * @param spaceGoals - Goals grouped by space (from resolveAllSpaceGoals)
 * @param meetings - Calendar meetings to match against
 * @param granularity - Whether this is a week or month computation (passed through)
 */
export function computeGoalAlignment(
  spaceGoals: SpaceGoals[],
  meetings: AlignmentMeetingLike[],
  granularity: 'week' | 'month',
  prepEnrichments?: Map<string, PrepEnrichment>,
): GoalAlignmentResult {
  // Filter out all-day events
  const usableMeetings = meetings.filter(m => !isAllDayEvent(m));

  // Flatten goals from all spaces and pre-compute keyword sets.
  const goalEntries: GoalAccumulator[] = [];
  const goalIndicesByCompositeKey = new Map<string, number[]>();

  for (const space of spaceGoals) {
    for (const g of space.goals) {
      const goalWords = extractKeywords(g.goal);
      const whyWords = g.why ? extractKeywords(g.why) : [];
      const allGoalWords = new Set<string>([...goalWords, ...whyWords]);

      const goalIndex = goalEntries.length;
      goalEntries.push({
        goalText: g.goal,
        spaceName: space.spaceName,
        isPersonal: space.isPersonal,
        keywords: allGoalWords,
        alignedHours: 0,
        alignedMeetingCount: 0,
        alignedMeetingTitles: [],
      });

      const key = getGoalCompositeKey(space.spaceName, g.goal);
      const existingIndices = goalIndicesByCompositeKey.get(key);
      if (existingIndices) {
        existingIndices.push(goalIndex);
      } else {
        goalIndicesByCompositeKey.set(key, [goalIndex]);
      }
    }
  }

  let totalMeetingHours = 0;
  let unalignedHours = 0;
  let unalignedCount = 0;
  let preppedMeetingCount = 0;
  let excludedAsNoiseCount = 0;

  // Normalize prep enrichment keys for robust timestamp matching
  const normalizedEnrichments = buildNormalizedPrepMap(prepEnrichments);

  // Two-pass execution per meeting:
  // 1) If prep enrichment exists, use it as source of truth.
  //    If prep goals are stale (no match found), fall through to keyword matching.
  // 2) Otherwise fallback to keyword matching.
  for (const meeting of usableMeetings) {
    const durationHours = getMeetingDurationHours(meeting);
    const meetingKey = normalizeTimestampKey(meeting.startTime);
    const prepEnrichment = normalizedEnrichments?.get(meetingKey);

    if (prepEnrichment) {
      preppedMeetingCount += 1;

      const { includeInTotals, excludedAsNoise } = getPreppedMeetingHandling(
        prepEnrichment.meetingUtility,
        prepEnrichment.goalAlignment.length,
      );

      if (excludedAsNoise) {
        excludedAsNoiseCount += 1;
      }

      if (!includeInTotals) {
        continue;
      }

      totalMeetingHours += durationHours;
      const matched = applyPrepAlignmentToGoalEntries(
        prepEnrichment,
        meeting,
        durationHours,
        goalIndicesByCompositeKey,
        goalEntries,
      );
      if (matched) {
        continue;
      }
      // Stale enrichment: goal tuples didn't match any current goal.
      // Fall through to keyword matching so the meeting isn't lost.
    } else {
      totalMeetingHours += durationHours;
    }

    const meetingKeywordSet = new Set(extractKeywords(meeting.title));
    let matchedByKeyword = false;

    for (const goalEntry of goalEntries) {
      if (goalEntry.keywords.size === 0) continue;
      if (!hasKeywordOverlap(meetingKeywordSet, goalEntry.keywords)) continue;

      matchedByKeyword = true;
      goalEntry.alignedHours += durationHours;
      goalEntry.alignedMeetingCount += 1;
      if (goalEntry.alignedMeetingTitles.length < MAX_TITLES_PER_GOAL) {
        goalEntry.alignedMeetingTitles.push(meeting.title);
      }
    }

    if (!matchedByKeyword) {
      unalignedHours += durationHours;
      unalignedCount += 1;
    }
  }

  const finalGoalEntries: GoalAlignmentEntry[] = goalEntries.map(goalEntry => ({
    goalText: goalEntry.goalText,
    spaceName: goalEntry.spaceName,
    isPersonal: goalEntry.isPersonal,
    alignedHours: roundHours(goalEntry.alignedHours),
    alignedMeetingCount: goalEntry.alignedMeetingCount,
    alignedMeetingTitles: goalEntry.alignedMeetingTitles,
    status: goalEntry.alignedMeetingCount > 0
      ? 'matched'
      : goalEntry.keywords.size === 0
        ? 'no_usable_keywords'
        : 'no_matches',
  }));

  return {
    goals: finalGoalEntries,
    totalMeetingHours: roundHours(totalMeetingHours),
    totalMeetingCount: usableMeetings.length,
    unalignedHours: roundHours(unalignedHours),
    unalignedCount,
    preppedMeetingCount,
    excludedAsNoiseCount,
    granularity,
  };
}

/** Round to 1 decimal place for consistent display. */
function roundHours(hours: number): number {
  return Math.round(hours * 10) / 10;
}
