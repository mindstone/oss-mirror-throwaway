/**
 * Inbox tier classification and within-tier sorting for the homepage Today stream.
 *
 * Items are classified into three tiers based on actionability:
 *   - Act:    concrete deliverable (draft, clarifying question, urgent flag)
 *   - Review: important items without a concrete deliverable
 *   - FYI:    informational context — routed to Coach section, not Today stream
 *
 * Within each tier, items are sorted by deadline proximity:
 *   overdue dueBy > future dueBy > future relevantDate > past relevantDate > addedAt
 */

import type { InboxItem } from '../types/inbox';

// ─── FYI detection ──────────────────────────────────────────────────────────
// Moved from useTodayStream.ts — shared between tier classification and
// the inboxItemToTodayItem conversion (which sets isImportant).

const FYI_TITLE_PREFIXES = ['fyi:', 'fyi ', 'heads up:'];
const FYI_TITLE_PHRASES = ['context if needed', '\u2014 context', '\u2014 fyi', 'just so you know', 'no action needed'];

/** Strip leading emoji characters and whitespace from a string */
export function stripLeadingEmoji(text: string): string {
  return text.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]+\s*/gu, '').trim();
}

/**
 * Whether an inbox item looks like informational FYI content rather than
 * an action item. Returns false if the item has any action signal
 * (draft, clarifying question, urgent flag) — those always escape FYI.
 */
export function looksLikeFyi(title: string, item: InboxItem): boolean {
  if (item.draft?.trim() || item.clarifyingQuestion || item.urgent) return false;
  const lower = title.toLowerCase();
  if (FYI_TITLE_PREFIXES.some(prefix => lower.startsWith(prefix))) return true;
  return FYI_TITLE_PHRASES.some(phrase => lower.includes(phrase));
}

// ─── Coach redirect detection ───────────────────────────────────────────────
// Insight/non-actionable prefixes that belong in the Coach section, not Today.
// Normally redirected at write-time (inboxStore.validateInboxItem), but items
// created before the redirect was deployed can still exist in the inbox.
// Shared between useTodayStream (exclusion) and HomepagePanel (routing to Coach).

const COACH_REDIRECT_PREFIXES = [
  'insight:', 'learning:', 'win:', 'recap:',
  'summary:', 'note:', 'decision:', 'context:',
  'highlight:', 'takeaway:', 'reflection:',
];

export function shouldRedirectToCoach(title: string): boolean {
  const stripped = stripLeadingEmoji(title).toLowerCase();
  return COACH_REDIRECT_PREFIXES.some(prefix => stripped.startsWith(prefix));
}

// ─── Tier classification ────────────────────────────────────────────────────

export type InboxTier = 'act' | 'review' | 'fyi';

/**
 * Classify an inbox item into an actionability tier.
 *
 * - **Act**: has a draft to send, a clarifying question to answer, or is flagged urgent.
 * - **FYI**: explicitly `important === false`, or matches FYI title patterns
 *   (with no action signals). Note: `looksLikeFyi` has escape hatches for
 *   draft/clarifyingQuestion/urgent, so those always win over FYI patterns.
 * - **Review**: everything else (important by default).
 */
export function classifyInboxTier(item: InboxItem): InboxTier {
  if (item.draft?.trim() || item.clarifyingQuestion || item.urgent) return 'act';

  const cleanTitle = stripLeadingEmoji(item.title);
  if (item.important === false || looksLikeFyi(cleanTitle, item)) return 'fyi';

  return 'review';
}

// ─── Within-tier sorting ────────────────────────────────────────────────────

interface SortBucket {
  /** Lower bucket = higher priority */
  bucket: number;
  /** Within same bucket, lower ms = higher priority */
  ms: number;
}

/**
 * Assign a sort bucket to an inbox item based on deadline proximity.
 *
 * Bucket 0: overdue dueBy (past due = highest priority, recently overdue first)
 * Bucket 1: future dueBy (sooner deadline = higher)
 * Bucket 2: future relevantDate (sooner = higher)
 * Bucket 3: past relevantDate (more recent = higher — soft demotion, not removal)
 * Bucket 4: addedAt only (more recent = higher)
 */
function inboxSortBucket(item: InboxItem, now: number): SortBucket {
  if (item.dueBy != null) {
    if (item.dueBy <= now) return { bucket: 0, ms: now - item.dueBy };
    return { bucket: 1, ms: item.dueBy - now };
  }
  if (item.relevantDate != null) {
    if (item.relevantDate > now) return { bucket: 2, ms: item.relevantDate - now };
    return { bucket: 3, ms: now - item.relevantDate };
  }
  return { bucket: 4, ms: item.addedAt ? (now - item.addedAt) : Infinity };
}

/**
 * Compare two inbox items for within-tier sort order.
 * Returns negative if `a` should come first.
 */
export function compareInboxPriority(a: InboxItem, b: InboxItem, now: number): number {
  const aKey = inboxSortBucket(a, now);
  const bKey = inboxSortBucket(b, now);
  if (aKey.bucket !== bKey.bucket) return aKey.bucket - bKey.bucket;
  return aKey.ms - bKey.ms;
}
