import type { AgentSessionSidebarEntry } from '../types';
import { isBackgroundConversationSession } from '@shared/sessionKind';

export type SidebarFilter = 'all' | 'active' | 'done' | 'starred' | 'trash';

const VALID_SIDEBAR_FILTERS: SidebarFilter[] = ['all', 'active', 'done', 'starred', 'trash'];

/** Fallback tab when nothing valid is stored. */
export const DEFAULT_SIDEBAR_FILTER: SidebarFilter = 'active';

/**
 * Resolves a persisted sidebar-filter value into a valid {@link SidebarFilter},
 * applying the read-time rename migration `'archived' → 'done'` (260614
 * done-state rename). Returns {@link DEFAULT_SIDEBAR_FILTER} for missing or
 * unrecognised values so returning users with a legacy/invalid value land on a
 * sensible tab rather than a blank one.
 */
export function resolveSidebarFilter(stored: string | null | undefined): SidebarFilter {
  // Legacy: the Done tab's enum value was 'archived' before the rename.
  const migrated = stored === 'archived' ? 'done' : stored;
  if (migrated && VALID_SIDEBAR_FILTERS.includes(migrated as SidebarFilter)) {
    return migrated as SidebarFilter;
  }
  return DEFAULT_SIDEBAR_FILTER;
}

/**
 * A history session with no messages, no draft, and not currently busy.
 * These are stale leftovers that shouldn't clutter the Active list.
 */
export const isStaleEmptySession = (e: AgentSessionSidebarEntry): boolean =>
  e.isHistory && e.messageCount === 0 && !e.hasDraft && e.status !== 'thinking';

/**
 * Membership test for the secondary "active" surfaces that live OUTSIDE the
 * sidebar tab filter — the collapsed pinned-tabs strip (`pinnedFavorites` in
 * App.tsx) and the mark-done auto-switch next-in-list picker. These include
 * active + non-deleted entries (starred ones too, unlike the Active tab) but,
 * like every Active surface, must exclude background (app-initiated) kinds so
 * automation / meeting-analysis / use-case-discovery runs never surface there.
 * See `EXCLUDED_FROM_ACTIVE_KINDS` in `@shared/sessionKind`.
 */
export const isActiveNavEntry = (e: AgentSessionSidebarEntry): boolean =>
  e.isActive && !e.isDeleted && !isBackgroundConversationSession(e.id);

export type FilteredSessionList = {
  entries: AgentSessionSidebarEntry[];
  starredCount: number;
};

/**
 * Filters and sorts sidebar entries based on the active filter.
 * Starred items float to the top within each view.
 *
 * Active and Starred are mutually exclusive: starred conversations only
 * appear under the Starred filter, never in Active (even though they're pinned).
 *
 * Input entries are expected to be pre-sorted by the hook (pinned-first, then timestamp desc).
 * This function partitions starred to the front while preserving the existing order within each group.
 *
 * `alwaysIncludeId` — if set, ensures this entry appears in the result even if
 * it wouldn't normally pass the filter/recency criteria (e.g. the current session).
 */
export function filterSessionList(
  sidebarEntries: AgentSessionSidebarEntry[],
  filter: SidebarFilter,
  recencyCutoff?: number | null,
  alwaysIncludeId?: string | null,
): FilteredSessionList {
  let filtered: AgentSessionSidebarEntry[];
  switch (filter) {
    case 'all':
      filtered = sidebarEntries
        .filter((e) => !e.isDeleted)
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp || a.title.localeCompare(b.title));
      break;
    case 'active':
      filtered = sidebarEntries.filter(
        (e) =>
          !e.isDeleted &&
          e.isActive &&
          !e.isStarred &&
          !isStaleEmptySession(e) &&
          !isBackgroundConversationSession(e.id),
      );
      break;
    case 'done':
      filtered = sidebarEntries.filter((e) => !e.isDeleted && !e.isActive);
      break;
    case 'starred':
      filtered = sidebarEntries.filter((e) => !e.isDeleted && e.isStarred);
      break;
    case 'trash':
      // Trash is sorted purely by when each item was deleted (most recently
      // deleted first) — independent of the pinned-first / updatedAt ordering
      // the hook applies to the live views. Fall back to updatedAt then title
      // for legacy entries that predate the deletedAt timestamp.
      filtered = sidebarEntries
        .filter((e) => e.isDeleted)
        .slice()
        .sort(
          (a, b) =>
            (b.deletedAt ?? b.timestamp) - (a.deletedAt ?? a.timestamp) ||
            a.title.localeCompare(b.title),
        );
      break;
  }

  if (recencyCutoff != null && filter !== 'trash') {
    filtered = filtered.filter((e) => e.timestamp >= recencyCutoff);
  }

  // Guarantee the always-include entry is present (e.g. current session)
  // but only for recency cutoff bypass — don't force it into a category it doesn't belong to.
  if (alwaysIncludeId && !filtered.some((e) => e.id === alwaysIncludeId)) {
    const missing = sidebarEntries.find((e) => e.id === alwaysIncludeId);
    if (missing && !missing.isDeleted) {
      // Only include if it was excluded by recency cutoff, not by category mismatch
      const matchesCategory = (() => {
        switch (filter) {
          case 'all': return true;
          case 'active':
            return Boolean(missing.isActive) && !isBackgroundConversationSession(missing.id);
          case 'done': return !missing.isActive;
          case 'starred': return Boolean(missing.isStarred);
          case 'trash': return Boolean(missing.isDeleted);
        }
      })();
      if (matchesCategory) {
        filtered.push(missing);
      }
    }
  }

  // 'all' and 'trash' keep their own ordering (recency / date-deleted desc)
  // rather than floating starred items to the top.
  if (filter === 'all' || filter === 'trash') {
    return {
      entries: filtered,
      starredCount: filtered.filter((entry) => entry.isStarred).length,
    };
  }

  const starred: AgentSessionSidebarEntry[] = [];
  const nonStarred: AgentSessionSidebarEntry[] = [];
  for (const entry of filtered) {
    if (entry.isStarred) {
      starred.push(entry);
    } else {
      nonStarred.push(entry);
    }
  }

  const entries = [...starred, ...nonStarred];
  return { entries, starredCount: starred.length };
}
