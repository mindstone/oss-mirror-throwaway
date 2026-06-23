/**
 * Calendar–Inbox Matching
 *
 * Pure functions that match inbox items to calendar events using metadata signals.
 * No LLM calls — purely deterministic, suitable for running on every render cycle.
 */

export interface CalendarEventForMatching {
  title: string;
  participants?: string[];
  startTime: string;
  endTime: string;
}

export interface InboxItemForMatching {
  id: string;
  title: string;
  tags?: string[];
  source?: { kind: string; meetingTitle?: string };
}

const BUSINESS_STOPWORDS = new Set([
  'meeting', 'sync', 'standup', 'stand-up', 'review', 'update', 'weekly',
  'monthly', 'daily', 'team', 'agenda', 'notes', 'check-in', 'checkin',
  'catch-up', 'catchup', 'brief', 'briefing', 'session', 'call', 'chat',
  'discussion', 'huddle', 'retro', 'retrospective', 'planning', 'grooming',
  'refinement', 'sprint', 'kickoff', 'kick-off', 'wrap-up', 'wrapup',
  'all-hands', 'allhands', 'townhall', 'town-hall', 'office-hours',
]);

const ENGLISH_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that',
  'these', 'those', 'it', 'its', 'my', 'your', 'our', 'their', 'about',
  'up', 'out', 'if', 'not', 'no', 'so', 'as', 'into', 'than', 'then',
  'just', 'also', 'more', 'some', 'any', 'all', 'each', 'every', 'both',
  'few', 'most', 'other', 'new', 'old',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function significantTokens(text: string): Set<string> {
  const tokens = tokenize(text);
  return new Set(tokens.filter(t =>
    !ENGLISH_STOPWORDS.has(t) && !BUSINESS_STOPWORDS.has(t)
  ));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const JACCARD_THRESHOLD = 0.3;

/**
 * Check if an inbox item is relevant to a specific calendar event.
 *
 * Matching strategy (ordered by confidence, short-circuits on first match):
 * 1. Source match: item.source.meetingTitle appears in event.title (or vice versa)
 * 2. Full participant name match: participant display name appears in item.title
 * 3. Title keyword overlap: Jaccard similarity ≥ 0.3 on significant tokens
 */
export function isItemRelevantToMeeting(
  item: InboxItemForMatching,
  meeting: CalendarEventForMatching,
): boolean {
  if (item.source?.kind === 'meeting' && item.source.meetingTitle) {
    const sourceLower = item.source.meetingTitle.toLowerCase();
    const meetingLower = meeting.title.toLowerCase();
    if (meetingLower.includes(sourceLower) || sourceLower.includes(meetingLower)) {
      return true;
    }
  }

  if (meeting.participants) {
    const itemTitleLower = item.title.toLowerCase();
    for (const participant of meeting.participants) {
      const nameLower = participant.toLowerCase().trim();
      if (nameLower.length < 5) continue;
      const namePattern = new RegExp(`\\b${nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (namePattern.test(item.title)) {
        return true;
      }
    }
  }

  const itemTokens = significantTokens(item.title);
  const meetingTokens = significantTokens(meeting.title);
  if (jaccardSimilarity(itemTokens, meetingTokens) >= JACCARD_THRESHOLD) {
    return true;
  }

  return false;
}

/**
 * Find all calendar events that match a given inbox item.
 */
export function findCalendarMatchesForItem(
  item: InboxItemForMatching,
  todaysMeetings: CalendarEventForMatching[],
): CalendarEventForMatching[] {
  return todaysMeetings.filter(meeting => isItemRelevantToMeeting(item, meeting));
}

/**
 * Compute the set of inbox item IDs that match any of today's meetings.
 * Intended to be called once per render cycle (not per item).
 */
export function computeCalendarMatchedIds(
  items: InboxItemForMatching[],
  todaysMeetings: CalendarEventForMatching[],
): Set<string> {
  if (todaysMeetings.length === 0) return new Set();

  const matched = new Set<string>();
  for (const item of items) {
    for (const meeting of todaysMeetings) {
      if (isItemRelevantToMeeting(item, meeting)) {
        matched.add(item.id);
        break;
      }
    }
  }
  return matched;
}
