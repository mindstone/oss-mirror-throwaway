/**
 * useTodayStream - Aggregates + prioritises Today items
 *
 * Combines meetings (from useMeetingCache), inbox items
 * (from useHomepageInboxItems), and recent automation runs
 * (from useRecentAutomationRuns) into a single prioritised stream,
 * capped at 5 items. Supports dismissing items so overflow items
 * fill the gap.
 */

import { useMemo, useState, useEffect } from 'react';
import type { UseMeetingCacheResult } from '../../usecases/hooks/useMeetingCache';
import type { UseHomepageInboxResult } from './useHomepageInboxItems';
import { useRecentAutomationRuns } from './useRecentAutomationRuns';
import { partitionByUrgency, HIGH_IMPORTANCE_KEYWORDS } from '../utils/prioritisation';
import { classifyInboxTier, compareInboxPriority, looksLikeFyi, stripLeadingEmoji, shouldRedirectToCoach } from '../utils/inboxTiers';
import { filterInboxViewItems } from '../../inbox/utils/filterInboxViewItems';
import { formatSourceSubtitle } from '@renderer/utils/formatSourceLabel';
import { isTranscriptSource, deriveContextPlaceholder } from '@rebel/shared';
import { hasRealPrepPath } from '@shared/ipc/channels/calendar';
import type { CachedMeeting } from '@shared/ipc/channels/calendar';
import type { InboxItem as SharedInboxItem } from '@shared/types';
import type { RecentAutomationItem } from './useRecentAutomationRuns';
import type { TodayItem } from '../types';

const MAX_TODAY_ITEMS = 5;

/**
 * Inbox items without any time signal (relevantDate / dueBy) older than this
 * threshold are excluded from the Today stream. They remain in the full Inbox.
 */
const STALE_INBOX_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Module-level tracker for meetings that have been prepped during this app session.
 * Survives component remounts but resets on full app reload (which is fine —
 * on reload the meeting cache will have prepPath set from disk).
 */
const preppedMeetingIds = new Set<string>();

/** Mark a meeting as prepped (called when a background prep session starts). */
export function markMeetingPrepped(meetingId: string): void {
  preppedMeetingIds.add(meetingId);
}

export type { TodayItemType, TodayItem } from '../types';

/** How long after a meeting starts we keep a prepped meeting visible for review */
const PREPPED_MEETING_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

/** How far in advance to show meetings with high-importance keyword matches */
const MEETING_LOOKAHEAD_HIGH_MS = 3 * 60 * 60 * 1000; // 3 hours
/** How far in advance to show routine internal meetings */
const MEETING_LOOKAHEAD_DEFAULT_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Whether a meeting passes the importance-based time gate.
 * External-attendee and already-prepped meetings always pass.
 * Keyword-matched meetings pass within 3h, routine meetings within 2h.
 */
function passesMeetingTimeGate(item: TodayItem): boolean {
  if (item.hasPrep || item.hasExternalAttendees) return true;
  const startMs = typeof item.startTime === 'string'
    ? new Date(item.startTime).getTime()
    : item.startTime ?? 0;
  const timeUntil = startMs - Date.now();
  if (timeUntil <= 0) return true;
  const titleLower = item.title.toLowerCase();
  const hasHighKeyword = HIGH_IMPORTANCE_KEYWORDS.some(kw => titleLower.includes(kw));
  const lookahead = hasHighKeyword ? MEETING_LOOKAHEAD_HIGH_MS : MEETING_LOOKAHEAD_DEFAULT_MS;
  return timeUntil <= lookahead;
}

function meetingToTodayItem(meeting: CachedMeeting): TodayItem | null {
  const now = Date.now();
  const startMs = new Date(meeting.startTime).getTime();
  const hasPrep = hasRealPrepPath(meeting.prepPath) || preppedMeetingIds.has(meeting.id);

  if (now > startMs) {
    // Meeting has started. Keep it if it has prep to review (grace period).
    // Unprepped meetings are filtered out — you can't prep mid-meeting.
    if (!hasPrep || now > startMs + PREPPED_MEETING_GRACE_PERIOD_MS) return null;
  }

  // Solo meetings (focus blocks, personal time holds) have no one to prep for — skip them.
  // Check both participants (display names) and participantEmails (accepted attendees)
  // since participants can be empty if attendees lack display names in the calendar.
  if (meeting.participants.length === 0 && (meeting.participantEmails?.length ?? 0) === 0) return null;

  // Simple heuristic: if any participant email has a different domain, they're "external"
  const emails = meeting.participantEmails ?? [];
  const domains = emails.length > 0
    ? emails.map(e => e.split('@')[1]?.toLowerCase()).filter(Boolean)
    : meeting.participants.filter(p => p.includes('@')).map(p => p.split('@')[1]?.toLowerCase());
  const uniqueDomains = new Set(domains);
  const hasExternalAttendees = uniqueDomains.size > 1;

  // If prep exists, show "Review" so the user can review their prep (dismissable via X).
  // If no prep yet, show "Prep" to kick one off.
  return {
    id: `meeting-${meeting.id}`,
    type: 'meeting',
    title: meeting.title,
    startTime: meeting.startTime,
    endTime: meeting.endTime,
    hasExternalAttendees,
    ctaLabel: hasPrep ? 'Review' : 'Prep',
    ctaAction: hasRealPrepPath(meeting.prepPath) ? 'open-file' : 'meeting-prep',
    ctaPath: hasRealPrepPath(meeting.prepPath) ? meeting.prepPath : undefined,
    ctaPrompt: `Prep me for my meeting "${meeting.title}". Use the meeting-prep skill.`,
    hasPrep,
    contextPlaceholder: 'What should I focus on?',
    originalItemId: meeting.id,
  };
}

/** Truncate text to `max` chars, appending "\u2026" when the original is longer. */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max).trimEnd() + '\u2026' : text;
}

/** Strip common markdown formatting for plain-text display */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/^#+\s*/gm, '');
}

/**
 * Extract a subtitle from inbox item text that adds info beyond the title.
 * If the text just repeats the title, returns undefined.
 */
function extractSubtitle(title: string, text: string | undefined): string | undefined {
  if (!text) return undefined;

  const cleanText = stripMarkdown(stripLeadingEmoji(text)).trim();
  const cleanTitle = title.toLowerCase().replace(/[^\w\s]/g, '').trim();

  // Check if text starts with the title (common pattern: text = title + more content)
  const cleanTextLower = cleanText.toLowerCase().replace(/[^\w\s]/g, '').trim();
  if (cleanTextLower.startsWith(cleanTitle)) {
    // Strip the title prefix and get the remaining content
    const remainder = cleanText.slice(title.length).replace(/^[\s:—\-–·|]+/, '').trim();
    return remainder.length > 10 ? truncate(remainder, 500) : undefined;
  }

  // Text is genuinely different from the title — use it
  return cleanText.length > 10 ? truncate(cleanText, 500) : undefined;
}

const LONG_TITLE_THRESHOLD = 60;
const MIN_SPLIT_SEGMENT = 15;

/**
 * Convert title-cased text to sentence case.
 * Preserves all-caps words (acronyms like MCP, API) and the pronoun "I".
 */
function toSentenceCase(text: string): string {
  if (!text) return text;
  return text.split(' ').map((word, i) => {
    if (i === 0) return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
    if (/^I([''\u2019](m|ve|ll|d))?$/.test(word)) return word;
    return word.toLowerCase();
  }).join(' ');
}

/**
 * Split a long title into title + subtitle at a natural break point.
 * Targets patterns like "Learning: Full insight text — continuation".
 * Both halves are normalised to sentence case when the source is title-cased.
 * Returns null if no clean split is found.
 */
function splitLongTitle(title: string): { title: string; subtitle: string } | null {
  if (title.length <= LONG_TITLE_THRESHOLD) return null;

  const words = title.split(/\s+/);
  const upperStarts = words.filter(w => w.length > 0 && /^[A-Z]/.test(w)).length;
  const isTitleCase = upperStarts > words.length * 0.6;
  const fix = isTitleCase ? toSentenceCase : (s: string) => s;

  // Prefer em-dash splits — these are natural clause boundaries
  for (const sep of [' \u2014 ', ' \u2013 ', ' - ']) {
    const idx = title.indexOf(sep);
    if (idx >= MIN_SPLIT_SEGMENT && idx < title.length - MIN_SPLIT_SEGMENT) {
      return { title: fix(title.slice(0, idx)), subtitle: fix(title.slice(idx + sep.length)) };
    }
  }

  // Word-boundary fallback: split around char 55-65 at a space
  let splitPos = title.lastIndexOf(' ', 65);
  if (splitPos < 25) splitPos = title.indexOf(' ', 50);
  if (splitPos > 0 && splitPos < title.length - MIN_SPLIT_SEGMENT) {
    return { title: fix(title.slice(0, splitPos)), subtitle: fix(title.slice(splitPos + 1)) };
  }

  return null;
}

/**
 * Homepage variant of the CTA resolver — returns label + prompt.
 * The Inbox view uses `resolveInboxCtaLabel` (same priority chain, "Review" default).
 * @see src/renderer/features/inbox/utils/resolveInboxCtaLabel.ts
 */
export function resolveInboxCta(item: SharedInboxItem): { label: string; prompt: string } {
  const cleanTitle = stripLeadingEmoji(item.title);
  const textSnippet = item.text ? item.text.slice(0, 300) : '';

  if (item.draft?.trim()) {
    return {
      label: 'Review',
      prompt: `Review this draft and help me finalise it: "${cleanTitle}". Draft: ${item.draft.slice(0, 300)}`,
    };
  }

  if (item.clarifyingQuestion) {
    return {
      label: 'Review',
      prompt: `Review this and help me decide what to do: "${cleanTitle}". Rebel's question: ${item.clarifyingQuestion}. ${textSnippet}`,
    };
  }

  if (isTranscriptSource(item.source?.label)) {
    return {
      label: 'Review',
      prompt: `Summarise the key points and action items from: "${cleanTitle}". ${textSnippet}`,
    };
  }

  return {
    label: 'Review',
    prompt: `Review this action item and help me decide what to do: "${cleanTitle}". ${textSnippet}`,
  };
}

function inboxItemToTodayItem(item: SharedInboxItem): TodayItem {
  const isUrgent = item.urgent === true;
  const isDirect = !!(item.draft?.trim()) || !!item.clarifyingQuestion || isUrgent;
  const cleanTitle = stripLeadingEmoji(item.title);
  const sourceLabel = item.source?.label;

  // Importance: trust the upstream field, but downgrade if the item clearly
  // looks like FYI content with no action signals (catches cases where the
  // upstream agent forgot to set important=false).
  const isImportant = looksLikeFyi(cleanTitle, item) ? false : item.important !== false;

  const { label: ctaLabel, prompt: ctaPrompt } = resolveInboxCta(item);

  // Subtitle hints at what clicking the CTA does
  let displayTitle = cleanTitle;
  let subtitle: string | undefined;
  if (item.draft?.trim()) {
    subtitle = sourceLabel
      ? `${formatSourceSubtitle(sourceLabel)} · Draft ready to send`
      : 'Draft ready to send';
  } else if (item.clarifyingQuestion) {
    subtitle = truncate(item.clarifyingQuestion, 500);
  } else {
    const extracted = extractSubtitle(cleanTitle, item.text);
    subtitle = extracted
      ?? (sourceLabel ? formatSourceSubtitle(sourceLabel) : undefined);
  }

  // Fallback: derive subtitle from references when source.label is missing.
  // This gives inbox items created without a source a meaningful context line.
  if (!subtitle) {
    const [ref] = item.references ?? [];
    if (ref) {
    let refLabel = ref.label;
    if (!refLabel && ref.kind === 'url') {
      try { refLabel = new URL(ref.url).hostname.replace('www.', ''); } catch { /* malformed URL */ }
    }
    if (!refLabel && ref.kind === 'workspace') {
      refLabel = ref.path.split('/').pop();
    }
    if (refLabel) subtitle = formatSourceSubtitle(refLabel);
    }
  }

  // Long titles with no subtitle lose content to single-line truncation.
  // Split at a natural break point so the subtitle (2-line wrap) shows the rest.
  if (!subtitle) {
    const split = splitLongTitle(cleanTitle);
    if (split) {
      displayTitle = split.title;
      subtitle = split.subtitle;
    }
  }

  return {
    id: `inbox-${item.id}`,
    type: 'inbox',
    title: displayTitle,
    subtitle,
    timestamp: item.addedAt,
    isDirect,
    isUrgent,
    isImportant,
    ctaLabel,
    ctaAction: 'meeting-prep',
    ctaPrompt,
    contextPlaceholder: deriveContextPlaceholder(item),
    originalItemId: item.id,
  };
}

function automationRunToTodayItem(item: RecentAutomationItem): TodayItem {
  let subtitle: string;
  if (item.failed) {
    subtitle = item.error
      ? `Failed: ${truncate(item.error, 200)}`
      : 'Failed — check the output for details';
  } else if (item.hadBlocks) {
    subtitle = 'Completed with some blocks';
  } else {
    subtitle = 'Ran successfully';
  }

  return {
    id: `automation-${item.runId}`,
    type: 'automation',
    title: item.name,
    subtitle,
    timestamp: item.completedAt,
    isUrgent: item.failed,
    ctaLabel: 'Review',
    ctaAction: 'navigate',
    ctaPath: item.sessionId,
  };
}

/** Per-source loading status for the Today stream */
export interface TodaySourceStatus {
  meetingsLoading: boolean;
  inboxLoading: boolean;
}

export interface UseTodayStreamResult {
  items: TodayItem[];
  /** Items that scored below the urgency threshold — shown as low-key suggestions */
  suggestions: TodayItem[];
  totalCount: number;
  isLoading: boolean;
  isEmpty: boolean;
  /** Per-source loading states for granular loading indicators */
  sourceStatus: TodaySourceStatus;
}

export interface UseTodayStreamOptions {
  dismissedIds?: Set<string>;
  meetingCache: UseMeetingCacheResult;
  inboxResult: UseHomepageInboxResult;
  /** When false, pauses internal data sources (automation subscription). */
  enabled?: boolean;
}

export function useTodayStream({ dismissedIds, meetingCache, inboxResult, enabled = true }: UseTodayStreamOptions): UseTodayStreamResult {
  const { meetings, isLoading: meetingsLoading } = meetingCache;
  const { items: inboxItems, isLoading: inboxLoading } = inboxResult;
  const { items: automationItems, isLoading: automationsLoading } = useRecentAutomationRuns(enabled);

  // Tick every 60s so time-sensitive ordering (overdue promotion, meeting filtering) stays fresh
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const { items, suggestions } = useMemo(() => {
    const hasDismissals = dismissedIds != null && dismissedIds.size > 0;

    const PER_SOURCE_CAP = 3;

    // All future meetings (excludes started/solo, but not time-gated).
    const allFutureMeetings = meetings
      .map(meetingToTodayItem)
      .filter((item): item is TodayItem => item !== null && !(hasDismissals && dismissedIds.has(item.id)))
      .sort((a, b) => {
        const aMs = typeof a.startTime === 'string' ? new Date(a.startTime).getTime() : (a.startTime ?? Infinity);
        const bMs = typeof b.startTime === 'string' ? new Date(b.startTime).getTime() : (b.startTime ?? Infinity);
        return aMs - bMs;
      });

    // Time-gated subset: only meetings that are important enough or close enough
    // to warrant a slot in the main pool (external attendees, prep, keywords, or within 2-3h).
    const allMeetingItems = allFutureMeetings.filter(passesMeetingTimeGate);

    const now = Date.now();

    // autoCompleted is filtered at loading level (useHomepageInboxItems); kept here as defense-in-depth.
    // Meeting-sourced inbox items are excluded: calendar meeting cards already
    // provide Prep/Review CTAs, so showing them again as actions is redundant.
    // We check both source.kind and category since either may be set independently.
    const actionsViewInboxItems = filterInboxViewItems(inboxItems, 'active', '', new Set())
      .filter(item => {
        if (item.executingSessionId || item.autoCompleted) return false;
        if (hasDismissals && dismissedIds.has(`inbox-${item.id}`)) return false;
        return true;
      });
    const candidateInboxItems = actionsViewInboxItems
      .filter(item => {
        if (item.source?.kind === 'meeting' || item.category === 'meeting-action') return false;
        if (shouldRedirectToCoach(item.title)) return false;
        return true;
      });

    // Primary Today inbox items still prefer currently relevant work.
    const filteredInboxItems = candidateInboxItems.filter(item => {
      if (item.relevantDate != null && item.relevantDate < now) return false;
      if (item.relevantDate == null && item.dueBy == null && item.addedAt < now - STALE_INBOX_THRESHOLD_MS) return false;
      return true;
    });

    // Backfill pool: stale/expired actions remain eligible only when the stream
    // would otherwise have empty slots. This keeps Today filled without pulling
    // in deferred meetings too early.
    const staleBackfillItems = candidateInboxItems.filter(item => {
      if (item.relevantDate != null && item.relevantDate < now) return true;
      if (item.relevantDate == null && item.dueBy == null && item.addedAt < now - STALE_INBOX_THRESHOLD_MS) return true;
      return false;
    });

    // Classify each inbox item into actionability tiers.
    // FYI items are lowest priority but kept for backfill when the stream is sparse.
    const actItems: SharedInboxItem[] = [];
    const reviewItems: SharedInboxItem[] = [];
    const fyiItems: SharedInboxItem[] = [];
    for (const item of filteredInboxItems) {
      const tier = classifyInboxTier(item);
      if (tier === 'act') actItems.push(item);
      else if (tier === 'review') reviewItems.push(item);
      else fyiItems.push(item);
    }

    actItems.sort((a, b) => compareInboxPriority(a, b, now));
    reviewItems.sort((a, b) => compareInboxPriority(a, b, now));
    fyiItems.sort((a, b) => compareInboxPriority(a, b, now));
    staleBackfillItems.sort((a, b) => compareInboxPriority(a, b, now));
    const actTodayItems = actItems.map(inboxItemToTodayItem);
    const reviewTodayItems = reviewItems.map(inboxItemToTodayItem);
    const fyiTodayItems = fyiItems.map(inboxItemToTodayItem);
    const staleBackfillTodayItems = staleBackfillItems.map(inboxItemToTodayItem);

    const allAutomationTodayItems = automationItems
      .map(automationRunToTodayItem)
      .filter((item) => !(hasDismissals && dismissedIds.has(item.id)));

    // Hard cap per source — no overflow. Remaining slots go to inbox items.
    const cappedMeetings = allMeetingItems.slice(0, PER_SOURCE_CAP);
    const cappedAutomations = allAutomationTodayItems.slice(0, PER_SOURCE_CAP);
    const sourcePool = [...cappedMeetings, ...cappedAutomations];

    const partitioned = partitionByUrgency(sourcePool, MAX_TODAY_ITEMS);

    // Fill remaining slots with inbox items by tier:
    // Act → urgent (concrete actions), Review → suggestions
    let totalUsed = partitioned.urgent.length + partitioned.suggestions.length;
    let actItemsAdded = 0;

    if (totalUsed < MAX_TODAY_ITEMS && actTodayItems.length > 0) {
      const actToAdd = actTodayItems.slice(0, MAX_TODAY_ITEMS - totalUsed);
      partitioned.urgent.push(...actToAdd);
      actItemsAdded = actToAdd.length;
      totalUsed += actItemsAdded;
    }

    if (totalUsed < MAX_TODAY_ITEMS && reviewTodayItems.length > 0) {
      const reviewToAdd = reviewTodayItems.slice(0, MAX_TODAY_ITEMS - totalUsed);
      partitioned.suggestions.push(...reviewToAdd);
      totalUsed += reviewToAdd.length;
    }

    // FYI backfill: when higher-priority items don't fill the stream,
    // surface FYI inbox items as suggestions to keep the homepage useful.
    if (totalUsed < MAX_TODAY_ITEMS && fyiTodayItems.length > 0) {
      const fyiToAdd = fyiTodayItems.slice(0, MAX_TODAY_ITEMS - totalUsed);
      partitioned.suggestions.push(...fyiToAdd);
      totalUsed += fyiToAdd.length;
    }

    // Stale/expired inbox backfill: if the stream is still sparse, prefer older
    // action items over deferred meetings. These are shown as low-priority suggestions.
    if (totalUsed < MAX_TODAY_ITEMS && staleBackfillTodayItems.length > 0) {
      const staleToAdd = staleBackfillTodayItems.slice(0, MAX_TODAY_ITEMS - totalUsed);
      partitioned.suggestions.push(...staleToAdd);
      totalUsed += staleToAdd.length;
    }

    // Final backfill: align with the broader Actions surface so Today reaches
    // five cards when there are still active action items worth surfacing.
    if (totalUsed < MAX_TODAY_ITEMS && actionsViewInboxItems.length > 0) {
      const usedIds = new Set([
        ...partitioned.urgent.map(item => item.id),
        ...partitioned.suggestions.map(item => item.id),
      ]);
      const broaderBackfill = actionsViewInboxItems
        .map(inboxItemToTodayItem)
        .filter(item => !usedIds.has(item.id));
      if (broaderBackfill.length > 0) {
        const extraToAdd = broaderBackfill.slice(0, MAX_TODAY_ITEMS - totalUsed);
        partitioned.suggestions.push(...extraToAdd);
        totalUsed += extraToAdd.length;
      }
    }

    // Act slot guarantee: Act items represent concrete user actions (drafts,
    // decisions) and should not be completely invisible when they exist.
    if (actTodayItems.length > 0 && actItemsAdded === 0) {
      const topAct = actTodayItems[0];
      if (!topAct) {
        return { items: partitioned.urgent, suggestions: partitioned.suggestions };
      }
      let displaced = false;

      // Try displacing a non-meeting suggestion first (least disruptive)
      if (!displaced && partitioned.suggestions.length > 0) {
        for (let i = partitioned.suggestions.length - 1; i >= 0; i--) {
          const suggestion = partitioned.suggestions[i];
          if (suggestion && suggestion.type !== 'meeting') {
            partitioned.suggestions[i] = topAct;
            displaced = true;
            break;
          }
        }
      }

      // Fall back to displacing a non-meeting urgent item
      if (!displaced) {
        for (let i = partitioned.urgent.length - 1; i >= 0; i--) {
          const urgentItem = partitioned.urgent[i];
          if (urgentItem && urgentItem.type !== 'meeting') {
            partitioned.urgent[i] = topAct;
            displaced = true;
            break;
          }
        }
      }
    }

    // Meeting slot guarantee: if a meeting already passes the time gate, don't let
    // it disappear entirely behind automations and inbox backfill.
    const allResults = [...partitioned.urgent, ...partitioned.suggestions];
    const hasMeetingInResults = allResults.some(i => i.type === 'meeting');
    if (!hasMeetingInResults && allMeetingItems.length > 0) {
      const topMeeting = allMeetingItems[0];
      if (!topMeeting) {
        return { items: partitioned.urgent, suggestions: partitioned.suggestions };
      }
      if (allResults.length < MAX_TODAY_ITEMS) {
        partitioned.suggestions.push(topMeeting);
      } else if (partitioned.suggestions.length > 0) {
        partitioned.suggestions[partitioned.suggestions.length - 1] = topMeeting;
      } else {
        partitioned.urgent[partitioned.urgent.length - 1] = topMeeting;
      }
    }

    return { items: partitioned.urgent, suggestions: partitioned.suggestions };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick forces periodic re-eval for time-sensitive ordering
  }, [meetings, inboxItems, automationItems, dismissedIds, tick]);

  const totalCount = useMemo(() => {
    const activeIds = new Set<string>();

    for (const meeting of meetings) {
      const asItem = meetingToTodayItem(meeting);
      if (asItem) activeIds.add(asItem.id);
    }

    for (const inboxItem of filterInboxViewItems(inboxItems, 'active', '', new Set())) {
      if (inboxItem.executingSessionId || inboxItem.autoCompleted) {
        continue;
      }
      if (inboxItem.source?.kind === 'meeting' || inboxItem.category === 'meeting-action') continue;
      if (shouldRedirectToCoach(inboxItem.title)) continue;
      activeIds.add(`inbox-${inboxItem.id}`);
    }

    for (const automationItem of automationItems) {
      activeIds.add(`automation-${automationItem.runId}`);
    }

    let activeDismissedCount = 0;
    if (dismissedIds && dismissedIds.size > 0) {
      for (const id of dismissedIds) {
        if (activeIds.has(id)) activeDismissedCount += 1;
      }
    }

    return Math.max(0, activeIds.size - activeDismissedCount);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick forces periodic re-eval
  }, [meetings, inboxItems, automationItems, dismissedIds, tick]);

  const isLoading = meetingsLoading || inboxLoading || automationsLoading;

  const sourceStatus: TodaySourceStatus = useMemo(
    () => ({ meetingsLoading, inboxLoading }),
    [meetingsLoading, inboxLoading],
  );

  return {
    items,
    suggestions,
    totalCount,
    isLoading,
    isEmpty: items.length === 0 && suggestions.length === 0 && !isLoading,
    sourceStatus,
  };
}
