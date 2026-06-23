/**
 * Priority scoring for Today stream items
 *
 * Items are scored across three dimensions:
 *   1. Time sensitivity (weight: high)   — how soon does this need attention?
 *   2. Importance signal (weight: medium) — external attendees, @mentions, keywords
 *   3. Staleness (weight: low)           — items seen multiple sessions get a slight boost
 *
 * Phase 1 heuristic: external attendees + keywords for meetings,
 * source-type for inbox. Iterate based on user feedback.
 */

import type { TodayItem } from '../types';

export const HIGH_IMPORTANCE_KEYWORDS = ['client', 'review', 'board', '1:1', 'kickoff', 'exec', 'planning'];
const ROUTINE_KEYWORDS = ['standup', 'sync'];
const IMPORTANCE_KEYWORDS = [...HIGH_IMPORTANCE_KEYWORDS, ...ROUTINE_KEYWORDS];

/** Score time sensitivity: 0-100 (higher = more urgent) */
function scoreTimeSensitivity(item: TodayItem): number {
  const now = Date.now();

  if (item.type === 'meeting') {
    const startMs = typeof item.startTime === 'string'
      ? new Date(item.startTime).getTime()
      : item.startTime ?? now + 24 * 60 * 60 * 1000;
    const diff = startMs - now;

    // Already started or past → highest urgency
    if (diff <= 0) return 95;
    // Within 15 minutes
    if (diff < 15 * 60 * 1000) return 90;
    // Within 30 minutes
    if (diff < 30 * 60 * 1000) return 80;
    // Within 1 hour
    if (diff < 60 * 60 * 1000) return 60;
    // Within 2 hours
    if (diff < 2 * 60 * 60 * 1000) return 50;
    // Later today — still a calendar commitment the user accepted
    return 30;
  }

  if (item.type === 'automation') {
    // Fresher automation results are more urgent
    if (!item.timestamp) return 30;
    const age = now - item.timestamp;
    if (age < 10 * 60 * 1000) return 70; // < 10 min ago
    if (age < 60 * 60 * 1000) return 50; // < 1 hour ago
    return 25;
  }

  // Inbox items: score by recency so fresh items surface higher
  if (item.type === 'inbox') {
    if (!item.timestamp) return 35;
    const age = now - item.timestamp;
    if (age < 30 * 60 * 1000) return 55;    // < 30 min old
    if (age < 2 * 60 * 60 * 1000) return 40; // < 2 hours
    if (age < 8 * 60 * 60 * 1000) return 30; // < 8 hours
    return 20;                                // older
  }

  return 35;
}

/** Score importance: 0-50 (higher = more important) */
function scoreImportance(item: TodayItem): number {
  if (item.type === 'meeting') {
    let score = 15;
    // Prepped meetings get an importance boost — keep them visible for review
    if (item.hasPrep) score += 15;
    // External attendees boost importance
    if (item.hasExternalAttendees) score += 20;
    // Title keywords boost importance
    const titleLower = item.title.toLowerCase();
    if (IMPORTANCE_KEYWORDS.some(kw => titleLower.includes(kw))) score += 10;
    return Math.min(score, 50);
  }

  if (item.type === 'inbox') {
    let score = 10;
    if (item.isDirect) score += 15;     // Actionable items (draft, clarifying question, urgent)
    if (item.isImportant) score += 10;  // Matters for goals/values (important flag)
    if (item.isUrgent) score += 10;     // Source-flagged urgency
    return Math.min(score, 50);
  }

  if (item.type === 'automation') {
    let score = 20;
    if (item.isUrgent) score += 15;   // Failed automations are more important to review
    return Math.min(score, 50);
  }

  return 20;
}

/** Score staleness: 0-10 (items seen multiple times get a small boost) */
function scoreStaleness(_item: TodayItem): number {
  // Phase 1: no staleness tracking yet — return 0
  return 0;
}

/** Compute composite priority score for a Today item */
export function computePriority(item: TodayItem): number {
  const timeSensitivity = scoreTimeSensitivity(item) * 0.6;  // weight: high
  const importance = scoreImportance(item) * 0.3;             // weight: medium
  const staleness = scoreStaleness(item) * 0.1;              // weight: low
  return timeSensitivity + importance + staleness;
}

/**
 * Items scoring at or above this threshold are genuinely time-sensitive
 * or important enough to warrant "needs your attention today" framing.
 * Below this, items are shown as low-key suggestions.
 *
 * Calibrated so that: meetings within ~2hrs, actionable inbox items
 * (drafts, decisions, urgent), and recent failed automations pass;
 * FYI context items and stale reviews don't.
 */
export const URGENCY_THRESHOLD = 35;

export interface PartitionedItems {
  urgent: TodayItem[];
  suggestions: TodayItem[];
}

/**
 * Split items into urgent (above threshold) and suggestions (below).
 * Together they always fill up to maxTotal slots: urgent items take
 * priority, suggestions fill the remaining space.
 */
export function partitionByUrgency(
  items: TodayItem[],
  maxTotal = 5,
): PartitionedItems {
  const scored = [...items]
    .map(item => ({ item, score: computePriority(item) }))
    .sort((a, b) => b.score - a.score);

  const urgent: TodayItem[] = [];
  const suggestions: TodayItem[] = [];

  for (const { item, score } of scored) {
    if (score >= URGENCY_THRESHOLD && urgent.length < maxTotal) {
      urgent.push(item);
    } else if (urgent.length + suggestions.length < maxTotal) {
      suggestions.push(item);
    }
  }

  return { urgent, suggestions };
}
