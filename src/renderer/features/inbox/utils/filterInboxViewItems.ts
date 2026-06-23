import type { InboxItem } from '@shared/types';
import {
  deriveInboxStatus,
  derivePriorityLevel,
  shouldRedirectToCoach,
  stripLeadingEmoji,
  type PriorityLevel,
} from '@rebel/shared';
import { isWinsLearningsSource } from '@shared/utils/inboxQualityPatterns';
import type { ViewMode } from '../components/InboxFilterDropdown';

const ACTIVE_STATUSES = new Set(['active', 'executing']);
const ARCHIVED_STATUSES = new Set(['completed', 'dismissed']);

// SYNC: must match FYI_TITLE_PREFIXES/FYI_TITLE_PHRASES in packages/shared/src/utils/inboxTiers.ts
const FYI_TITLE_PREFIXES = ['fyi:', 'fyi ', 'heads up:'];
const FYI_TITLE_PHRASES = ['context if needed', '\u2014 context', '\u2014 fyi', 'just so you know', 'no action needed'];

// Non-actionable content emoji: celebrations (🏆🎉⭐🌟🥇🥈🥉) and insights (💡)
const NON_ACTIONABLE_EMOJI = /^[\u{1F3C6}\u{1F389}\u{2B50}\u{1F31F}\u{1F947}\u{1F948}\u{1F949}\u{1F4A1}]\s*/u;

// Informational prefixes that indicate non-actionable content (ideas, announcements,
// informational briefings) beyond what shouldRedirectToCoach covers.
const INFORMATIONAL_PREFIXES = ['look ahead:', 'product idea:', 'new:', 'watch for:'];

function matchesFyiTitlePattern(title: string): boolean {
  const lower = title.toLowerCase();
  return FYI_TITLE_PREFIXES.some(p => lower.startsWith(p))
    || FYI_TITLE_PHRASES.some(p => lower.includes(p));
}

function matchesInformationalPrefix(title: string): boolean {
  const lower = title.toLowerCase();
  return INFORMATIONAL_PREFIXES.some(p => lower.startsWith(p));
}

/**
 * Whether an inbox item is non-actionable and should be excluded from the Actions view.
 *
 * Unlike the shared `looksLikeFyi` (which treats urgency as an action signal for
 * the Today stream), this function only lets prepared content (draft/clarifyingQuestion)
 * override non-actionable classification. Urgency alone doesn't make a win, FYI,
 * or insight into an action item.
 */
function isNonActionableItem(item: InboxItem): boolean {
  if (shouldRedirectToCoach(item.title)) return true;

  if (isWinsLearningsSource(item.source)) return true;

  if (item.draft?.trim() || item.clarifyingQuestion) return false;

  const cleanTitle = stripLeadingEmoji(item.title);
  if (matchesFyiTitlePattern(cleanTitle)) return true;
  if (matchesInformationalPrefix(cleanTitle)) return true;
  if (NON_ACTIONABLE_EMOJI.test(item.title)) return true;

  return false;
}

/**
 * Filters inbox items based on view mode, search query, tag selection,
 * and priority filter. Uses `status` field (with fallback to `archived`
 * via `deriveInboxStatus`) for view partitioning.
 */
export function filterInboxViewItems(
  items: InboxItem[],
  viewMode: ViewMode,
  searchQuery: string,
  selectedTags: Set<string>,
  priorityFilter?: Set<PriorityLevel>,
): InboxItem[] {
  let result: InboxItem[];

  switch (viewMode) {
    case 'active':
      result = items.filter(i => ACTIVE_STATUSES.has(deriveInboxStatus(i)));
      break;
    case 'done':
      result = items.filter(i => deriveInboxStatus(i) === 'completed');
      break;
    case 'dismissed':
      result = items.filter(i => deriveInboxStatus(i) === 'dismissed');
      break;
    case 'archived':
      result = items.filter(i => ARCHIVED_STATUSES.has(deriveInboxStatus(i)));
      break;
    default:
      result = [];
  }

  if (viewMode === 'active') {
    result = result.filter(item => !item.autoCompleted);
  }

  result = result.filter(item => !isNonActionableItem(item));

  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase().trim();
    result = result.filter(item =>
      item.title.toLowerCase().includes(q) ||
      item.text?.toLowerCase().includes(q) ||
      item.draft?.toLowerCase().includes(q) ||
      (item.tags?.some(t => t.includes(q)) ?? false)
    );
  }

  if (selectedTags.size > 0) {
    result = result.filter(item =>
      item.tags?.some(t => selectedTags.has(t)) ?? false
    );
  }

  if (priorityFilter && priorityFilter.size > 0) {
    result = result.filter(item => priorityFilter.has(derivePriorityLevel(item)));
  }

  return result;
}
