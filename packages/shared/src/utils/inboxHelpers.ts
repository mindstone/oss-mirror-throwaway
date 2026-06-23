import type { InboxItem } from '../types/inbox';
import { derivePriorityLevel, PRIORITY_SORT_RANK } from './inboxStatusLabels';
import { getTemporalGroup, computeTemporalBoundaries, type ConcreteTemporalGroup } from './temporalGroup';

/**
 * Derive the Eisenhower quadrant display label for an inbox item.
 * Returns null when neither urgent nor important flags are explicitly set.
 *
 * @deprecated Use getStatusLabel() from inboxStatusLabels instead. Kept for mobile backwards compatibility.
 */
export function getQuadrantLabel(item: InboxItem): string | null {
  if (item.urgent && item.important) return 'Do Now';
  if (!item.urgent && item.important) return 'Schedule';
  if (item.urgent && !item.important) return 'Delegate';
  if (!item.urgent && !item.important && (item.important === false || item.urgent === false))
    return 'Consider';
  return null;
}

/**
 * Sorting priority for inbox items. Lower = higher priority.
 * Executing items float to top (0), then Eisenhower quadrants (1-4).
 *
 * @deprecated Eisenhower UI removed in FOX-2760. Use sortInboxItems instead. Kept for mobile backwards compatibility.
 */
export function getQuadrantPriority(item: InboxItem): number {
  if (item.executingSessionId) return 0;
  if (item.urgent && item.important) return 1;
  if (item.important) return 2;
  if (item.urgent) return 3;
  return 4;
}

const TEMPORAL_RANK: Record<ConcreteTemporalGroup, number> = {
  'due-today': 0,
  'due-this-week': 1,
  'upcoming': 2,
};

/**
 * Sort inbox items for display in the Actions view.
 * Canonical sort used by desktop, mobile, and web-companion.
 *
 * 1. Priority (urgent > high > medium > low via derivePriorityLevel)
 * 2. Drafts within the same priority band (ready for quick approval)
 * 3. Temporal group rank (due-today > due-this-week > upcoming)
 * 4. Due date ascending (soonest first), then addedAt descending (newest first)
 */
export function sortInboxItems(items: InboxItem[]): InboxItem[] {
  const boundaries = computeTemporalBoundaries();
  return [...items].sort((a, b) => {
    const priorityDiff = PRIORITY_SORT_RANK[derivePriorityLevel(a)] - PRIORITY_SORT_RANK[derivePriorityLevel(b)];
    if (priorityDiff !== 0) return priorityDiff;

    const aDraft = a.draft?.trim() ? 1 : 0;
    const bDraft = b.draft?.trim() ? 1 : 0;
    if (aDraft !== bDraft) return bDraft - aDraft;

    const aGroup = getTemporalGroup(a, boundaries);
    const bGroup = getTemporalGroup(b, boundaries);
    const groupDiff = TEMPORAL_RANK[aGroup] - TEMPORAL_RANK[bGroup];
    if (groupDiff !== 0) return groupDiff;

    const aHasDue = typeof a.dueBy === 'number';
    const bHasDue = typeof b.dueBy === 'number';

    if (aHasDue && bHasDue) return a.dueBy! - b.dueBy!;
    if (aHasDue && !bHasDue) return -1;
    if (!aHasDue && bHasDue) return 1;

    return b.addedAt - a.addedAt;
  });
}
