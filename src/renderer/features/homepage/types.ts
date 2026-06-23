/**
 * Shared types for the homepage feature.
 *
 * Extracted to break the circular dependency between useTodayStream
 * and prioritisation (both need TodayItem).
 */

export type TodayItemType = 'meeting' | 'inbox' | 'automation' | 'role';

export interface TodayItem {
  id: string;
  type: TodayItemType;
  title: string;
  /** Short description or context */
  subtitle?: string;
  /** For meetings: start time (ISO string or epoch ms) */
  startTime?: string | number;
  /** For meetings: end time (ISO string or epoch ms) */
  endTime?: string | number;
  /** For automations: when the result was generated */
  timestamp?: number;
  /** Meeting: has external (non-org) attendees */
  hasExternalAttendees?: boolean;
  /** Inbox: requires user action (has draft, clarifying question, or urgent flag) */
  isDirect?: boolean;
  /** Inbox: urgent flag */
  isUrgent?: boolean;
  /** Inbox: matters for goals/values (important flag) */
  isImportant?: boolean;
  /** CTA label (e.g., "Prep", "Review", "Decide", "Send") */
  ctaLabel: string;
  /** Action to execute on CTA click */
  ctaAction: 'meeting-prep' | 'open-file' | 'navigate';
  /** Optional path or navigation target for the CTA */
  ctaPath?: string;
  /** Original prompt for meeting prep CTA */
  ctaPrompt?: string;
  /** Whether this meeting has been prepped (file saved or session completed) */
  hasPrep?: boolean;
  /** Placeholder text for context input (shown when card is expanded) */
  contextPlaceholder?: string;
  /** Original item ID for voice mic routing */
  originalItemId?: string;
}
