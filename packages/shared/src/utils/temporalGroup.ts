import type { InboxItem } from '../types/inbox';
import { isPriorityPinnedToToday } from './inboxStatusLabels';

export type TemporalGroup = 'all' | 'due-today' | 'due-this-week' | 'upcoming';

/** The concrete groups an item can belong to (excludes the 'all' filter tab). */
export type ConcreteTemporalGroup = Exclude<TemporalGroup, 'all'>;

const FRESH_ACTION_MS = 7 * 24 * 60 * 60 * 1000;

export type TemporalBoundaries = {
  nowMs: number;
  todayStartMs: number;
  todayEndMs: number;
  weekEndMs: number;
  weekStartMs: number;
};

/**
 * Pre-compute day boundaries once per render cycle instead of per-item.
 *
 * "This Week" ends at midnight Saturday (i.e. end of Friday), anchored to the
 * work week. On Saturday/Sunday the boundary extends to the following Friday
 * so items don't collapse into "Today" over the weekend.
 */
export function computeTemporalBoundaries(now?: Date): TemporalBoundaries {
  const d = now ?? new Date();
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  // Day-of-week: 0 = Sunday, 1 = Monday, ..., 5 = Friday, 6 = Saturday
  const dow = todayStart.getDay();
  // Days until end of Friday (midnight Saturday).
  // Mon(1)→4, Tue(2)→3, Wed(3)→2, Thu(4)→1, Fri(5)→0 (today IS Friday, so weekEnd = todayEnd),
  // Sat(6)→6 (next Friday), Sun(0)→5 (next Friday).
  const daysToFriday = dow === 0 ? 5 : dow === 6 ? 6 : (5 - dow);
  const weekEnd = new Date(todayEnd);
  weekEnd.setDate(weekEnd.getDate() + daysToFriday);

  // weekStart: Monday of the current week (for addedAt-based fallback).
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - daysFromMonday);

  return {
    nowMs: d.getTime(),
    todayStartMs: todayStart.getTime(),
    todayEndMs: todayEnd.getTime(),
    weekEndMs: weekEnd.getTime(),
    weekStartMs: weekStart.getTime(),
  };
}

/**
 * Determine which temporal group an item belongs to.
 *
 * Priority order:
 * 1. Top priority → always Today
 * 2. `dueBy` — explicit user schedule/deadline boundaries
 * 3. Calendar match → Today (today's meetings relate to this item)
 * 4. Fresh draft/clarifyingQuestion (≤ 7 days old) → Today
 * 5. `relevantDate` — deadline proxy, same boundaries as dueBy
 * 6. Old draft/clarifyingQuestion (> 7 days, no deadline) → This Week (nudge)
 * 7. `addedAt` — arrival-based fallback
 */
export function getTemporalGroup(
  item: {
    dueBy?: number;
    addedAt: number;
    urgent?: boolean;
    important?: boolean;
    actions?: InboxItem['actions'];
    category?: InboxItem['category'];
    draft?: string;
    clarifyingQuestion?: string;
    relevantDate?: number;
  },
  boundaries?: TemporalBoundaries,
  options?: { calendarMatchedIds?: Set<string>; itemId?: string },
): ConcreteTemporalGroup {
  if (isPriorityPinnedToToday(item)) return 'due-today';

  const b = boundaries ?? computeTemporalBoundaries();

  if (typeof item.dueBy === 'number' && Number.isFinite(item.dueBy)) {
    if (item.dueBy < b.todayEndMs) return 'due-today';
    if (item.dueBy < b.weekEndMs) return 'due-this-week';
    return 'upcoming';
  }

  if (options?.calendarMatchedIds && options.itemId && options.calendarMatchedIds.has(options.itemId)) {
    return 'due-today';
  }

  const hasActionSignal = !!(item.draft?.trim() || item.clarifyingQuestion?.trim());
  const isFresh = (b.nowMs - item.addedAt) <= FRESH_ACTION_MS;

  if (hasActionSignal && isFresh) return 'due-today';

  if (typeof item.relevantDate === 'number' && Number.isFinite(item.relevantDate)) {
    if (item.relevantDate < b.todayEndMs) return 'due-today';
    if (item.relevantDate < b.weekEndMs) return 'due-this-week';
    return 'upcoming';
  }

  if (hasActionSignal) return 'due-this-week';

  if (item.addedAt >= b.todayStartMs) return 'due-today';
  if (item.addedAt >= b.weekStartMs) return 'due-this-week';
  return 'upcoming';
}

/**
 * Inverse of `getTemporalGroup()` — given a target group, compute the `dueBy`
 * timestamp that will reliably place an item there.
 *
 * Always returns a concrete timestamp (never null) so the item also gets a
 * sensible "Due {date}" badge on the card.
 */
export function getScheduleDueBy(
  targetGroup: ConcreteTemporalGroup,
  boundaries?: TemporalBoundaries,
): number {
  const b = boundaries ?? computeTemporalBoundaries();
  switch (targetGroup) {
    case 'due-today':
      return b.todayEndMs - 1;
    case 'due-this-week':
      return b.weekEndMs - 1;
    case 'upcoming':
      return b.weekEndMs;
  }
}

export const TEMPORAL_GROUP_ORDER: TemporalGroup[] = ['due-today', 'due-this-week', 'upcoming', 'all'];

export const TEMPORAL_GROUP_META: Record<TemporalGroup, {
  label: string;
  emptyMessage: string;
}> = {
  all: {
    label: 'All',
    emptyMessage: '',
  },
  'due-today': {
    label: 'Today',
    emptyMessage: 'Nothing for today. Enjoy the calm.',
  },
  'due-this-week': {
    label: 'This Week',
    emptyMessage: 'Nothing else this week.',
  },
  upcoming: {
    label: 'Later',
    emptyMessage: '',
  },
};

export function groupByTemporal(
  items: InboxItem[],
  calendarMatchedIds?: Set<string>,
): Map<ConcreteTemporalGroup, InboxItem[]> {
  const boundaries = computeTemporalBoundaries();
  const groups = new Map<ConcreteTemporalGroup, InboxItem[]>([
    ['due-today', []],
    ['due-this-week', []],
    ['upcoming', []],
  ]);
  for (const item of items) {
    const group = getTemporalGroup(item, boundaries, {
      calendarMatchedIds,
      itemId: item.id,
    });
    groups.get(group)!.push(item);
  }
  return groups;
}
