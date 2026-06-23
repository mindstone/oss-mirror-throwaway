/**
 * humanizeApprovalText
 *
 * Transforms extracted source-capture metadata into a natural-language approval
 * prompt so users see "Share Q3 Review meeting notes with your General space?"
 * instead of "Rebel wants to save 260418_1430_meeting_q3-review.md to Mindstone
 * General".
 *
 * Returns null when humanisation cannot be applied — missing description,
 * missing source type, missing space name, or an unrecognised source type —
 * so the caller can fall back to its existing raw-filename messaging. This
 * is the graceful-degradation path required by the planning doc: the new
 * copy is purely additive.
 *
 * Templates and context-line conventions follow `docs/plans/260418_source_capture_chief_of_staff_only.md`
 * section C2 (Humanisation logic).
 */

import type { SourceMetadata } from './extractSourceMetadata';

export interface HumanizedApproval {
  /** Main approval-card headline. Ends with a question mark. */
  actionText: string;
  /** Optional secondary line with participants/date context. */
  contextLine?: string;
}

/** Abbreviated month names in British English, matching the design doc ("18 Apr"). */
const MONTH_ABBREV = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Format a list of participant names using the Oxford-comma-with-"and" form:
 *   []                              -> ""
 *   ["Jane"]                        -> "Jane"
 *   ["Jane", "Bob"]                 -> "Jane and Bob"
 *   ["Jane", "Bob", "Carol"]        -> "Jane, Bob, and Carol"
 */
function formatParticipants(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/**
 * Convert an ISO-like date ("YYYY-MM-DD...") into "d MMM" (e.g. "18 Apr").
 * Returns null when the input is missing or malformed, keeping the caller's
 * context line safely omitted rather than showing a confusing partial date.
 */
function formatOccurredDate(occurredAt?: string): string | null {
  if (!occurredAt) return null;
  const match = occurredAt.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${day} ${MONTH_ABBREV[month - 1]}`;
}

/**
 * Build the main headline for a source-capture approval card.
 * Returns null when the source type is not one of the recognised templates,
 * signalling fallback to existing messaging.
 */
function buildActionText(description: string, sourceType: string, spaceName: string): string | null {
  switch (sourceType) {
    case 'meeting':
      return `Share ${description} meeting notes with your ${spaceName} space?`;
    case 'email':
      return `Share ${description} email thread with your ${spaceName} space?`;
    case 'thread':
    case 'slack':
    case 'messaging_thread':
      return `Share ${description} thread with your ${spaceName} space?`;
    case 'doc':
    case 'pdf':
    case 'notion':
    case 'web':
      return `Share ${description} with your ${spaceName} space?`;
    default:
      return null;
  }
}

/**
 * Build the optional context line below the headline, e.g.
 *   "From a meeting with Jane, Bob, and Carol on 18 Apr"
 *   "Email thread from 18 Apr"
 *   "Captured on 18 Apr"
 *
 * Returns undefined when there is not enough structured context to say
 * anything useful — better to omit than to produce "From a meeting on undefined".
 */
function buildContextLine(meta: SourceMetadata): string | undefined {
  const dateLabel = formatOccurredDate(meta.occurredAt);

  if (meta.sourceType === 'meeting') {
    const participants = meta.participants && meta.participants.length > 0
      ? formatParticipants(meta.participants)
      : null;
    if (participants && dateLabel) {
      return `From a meeting with ${participants} on ${dateLabel}`;
    }
    if (participants) {
      return `From a meeting with ${participants}`;
    }
    if (dateLabel) {
      return `From a meeting on ${dateLabel}`;
    }
    return undefined;
  }

  if (meta.sourceType === 'email') {
    return dateLabel ? `Email thread from ${dateLabel}` : undefined;
  }

  return dateLabel ? `Captured on ${dateLabel}` : undefined;
}

/**
 * Humanise a source-capture approval using its metadata and the destination space.
 *
 * Returns null when:
 * - description is missing (no readable title available)
 * - sourceType is missing (template cannot be chosen)
 * - spaceName is empty (the "...with your <space> space?" phrase would read awkwardly)
 * - sourceType is not one of the recognised templates
 *
 * On null, the caller must fall back to its existing approval-card text.
 */
export function humanizeApprovalText(
  meta: SourceMetadata,
  spaceName: string,
): HumanizedApproval | null {
  const { description, sourceType } = meta;
  if (!description || !sourceType || !spaceName) return null;

  const actionText = buildActionText(description, sourceType, spaceName);
  if (!actionText) return null;

  const contextLine = buildContextLine(meta);
  return contextLine ? { actionText, contextLine } : { actionText };
}
