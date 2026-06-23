import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';
import { EMAIL_INSTANCE_CONNECTOR_TYPES } from '../../utils/mcpInstanceUtils';
import { matchesNetworkCodeOrMessage } from '../../utils/networkErrorClass';

// =============================================================================
// Prep-skip sentinel & guards
// =============================================================================

/** Sentinel value set on prepPath to mark a meeting as "skip prep". */
export const SKIPPED_PREP_SENTINEL = '__skipped__';

/** True when prepPath is the skip-prep sentinel (not a real file). */
export function isSkippedPrep(prepPath?: string): boolean {
  return prepPath === SKIPPED_PREP_SENTINEL;
}

/** True when prepPath points to a real prep document (truthy, non-empty, not sentinel). */
export function hasRealPrepPath(prepPath?: string): prepPath is string {
  return !!prepPath?.trim() && !isSkippedPrep(prepPath);
}

// =============================================================================
// Structured sync issues (typed at the writer chokepoints)
// =============================================================================

/**
 * Closed-set connector base name a sync issue can reference. Drawn from
 * `EMAIL_INSTANCE_CONNECTOR_TYPES` so display names and the Settings
 * "View Connector" deep-link derive from a value that can never be a raw
 * account slug or email (zod-enum: out-of-set values are a parse error).
 */
export const SyncIssueConnectorSchema = z.enum(EMAIL_INSTANCE_CONNECTOR_TYPES);
export type SyncIssueConnector = z.infer<typeof SyncIssueConnectorSchema>;

/**
 * Coarse cause of a sync failure, used to pick HONEST remediation copy
 * (260617_calendar-cache-transient-debounce): `network` = the calendar service
 * was unreachable (DNS/timeout/offline — a transient blip that usually
 * self-heals, so "check your connection" would be misleading); `account` = a
 * connection/permission problem the user may actually need to act on. Closed
 * enum, no PII — safe to ride the health-check display projection.
 */
export const SyncIssueCauseSchema = z.enum(['network', 'account']);
export type SyncIssueCause = z.infer<typeof SyncIssueCauseSchema>;

/** Length cap applied to `detail` at construction (scrub-don't-reject). */
export const SYNC_ISSUE_DETAIL_MAX_LENGTH = 256;

/**
 * Typed replacement for the legacy free-form `syncWarnings` strings
 * (260611_calendar-followups Stage 2). Persisted on `MeetingCache` as an
 * additive optional field — NO store version bump (Design Call 1).
 *
 * PRIVACY CONTRACT:
 * - No raw email and no connector-instance slug is ever persisted: the
 *   `makeSyncIssue` factory (the sole construction path) scrubs
 *   email-shaped substrings and instance slugs out of `detail`.
 * - `detail` is DIAGNOSTICS-ONLY: it must never be interpolated into
 *   user-visible message/remediation copy — display strings derive from
 *   `kind` + `connector` (+ counts) only (see `renderSyncIssue`).
 * - `accountRef` carries an email DOMAIN only, never a full address/slug.
 */
export const SyncIssueSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('auth_transient'),
    provider: z.literal('google'),
    connector: z.literal('GoogleWorkspace'),
    /** Email domain only (e.g. "mindstone.com"), never a full address or slug. */
    accountRef: z.string().max(SYNC_ISSUE_DETAIL_MAX_LENGTH).optional(),
  }),
  z.object({
    kind: z.literal('calendar_fetch_failed'),
    provider: z.enum(['google', 'microsoft']),
    connector: SyncIssueConnectorSchema,
    /** Scrubbed raw error message — diagnostics only, never display copy. */
    detail: z.string().max(SYNC_ISSUE_DETAIL_MAX_LENGTH).optional(),
    /** network vs account — drives honest remediation copy (additive, optional). */
    cause: SyncIssueCauseSchema.optional(),
  }),
  z.object({
    kind: z.literal('account_sync_failed'),
    provider: z.enum(['google', 'microsoft']),
    connector: SyncIssueConnectorSchema,
    detail: z.string().max(SYNC_ISSUE_DETAIL_MAX_LENGTH).optional(),
    /** network vs account — drives honest remediation copy (additive, optional). */
    cause: SyncIssueCauseSchema.optional(),
  }),
  z.object({
    /** Free-form model-authored warning, wrapped at the bridge chokepoint. */
    kind: z.literal('bridge_reported'),
    detail: z.string().max(SYNC_ISSUE_DETAIL_MAX_LENGTH).optional(),
  }),
  z.object({
    kind: z.literal('validation_skipped'),
    count: z.number(),
  }),
]);

export type SyncIssue = z.infer<typeof SyncIssueSchema>;

/**
 * Email-shaped substrings (the W2-W5 leak class — full addresses in
 * err.message). Also matches URL-encoded `%40` separators: Google calendarIds
 * in events-path URLs are URL-encoded emails, so an API error echoing the
 * request URL carries `user%40domain.com` (Phase 7, DA-F5).
 */
const EMAIL_SHAPED_SUBSTRING = /[A-Za-z0-9][A-Za-z0-9._%+-]*(?:@|%40)[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}/g;

/** Connector-instance slugs (e.g. `GoogleWorkspace-teammember-mindstone-com`) — slugified emails. */
const CONNECTOR_INSTANCE_SLUG = new RegExp(
  `(?:${EMAIL_INSTANCE_CONNECTOR_TYPES.join('|')})-[A-Za-z0-9][A-Za-z0-9-]*`,
  'g',
);

function scrubIdentifyingSubstrings(text: string): string {
  return text
    .replace(CONNECTOR_INSTANCE_SLUG, '[connector-instance]')
    .replace(EMAIL_SHAPED_SUBSTRING, '[email]');
}

function capDetailLength(text: string): string {
  return text.length <= SYNC_ISSUE_DETAIL_MAX_LENGTH
    ? text
    : `${text.slice(0, SYNC_ISSUE_DETAIL_MAX_LENGTH - 1)}…`;
}

/**
 * Scrub + cap a free-text sync string: email-shaped substrings and
 * connector-instance slugs out, length capped. The SINGLE scrub used by
 * `makeSyncIssue` (detail/accountRef), the `recordSyncError` write
 * chokepoint (persisted `lastSyncError` — Phase 7, DA-F4), and the
 * health-check read belt for legacy `lastSyncError` values persisted
 * before the write-side scrub existed.
 */
export function scrubSyncDetailText(text: string): string {
  return capDetailLength(scrubIdentifyingSubstrings(text));
}

/**
 * Sole construction path for `SyncIssue` ([GPT-F1/DA/RS-F1] amendment): ALL
 * writers construct through this factory, which scrubs email-shaped
 * substrings and connector-instance slugs out of the free-text fields and
 * caps their length (scrub-don't-reject). Defense-in-depth alongside the
 * display-derivation rule (`detail` never reaches user-visible copy).
 */
export function makeSyncIssue<T extends SyncIssue>(issue: T): T {
  const scrubbed: SyncIssue = { ...issue };
  if ('detail' in scrubbed && typeof scrubbed.detail === 'string') {
    scrubbed.detail = scrubSyncDetailText(scrubbed.detail);
  }
  if ('accountRef' in scrubbed && typeof scrubbed.accountRef === 'string') {
    scrubbed.accountRef = scrubSyncDetailText(scrubbed.accountRef);
  }
  return scrubbed as T;
}

/**
 * Classify a sync error as `network` (the calendar service was unreachable — a
 * transient blip that usually self-heals) vs `account` (a connection/permission
 * problem the user may need to act on), so remediation copy can be honest
 * (260617_calendar-cache-transient-debounce). The network code/message set and
 * the cause-chain walk now live in the shared `networkErrorClass` util
 * (260618_arthur-offline-resilience) — single source of truth, reused by the
 * auth-heartbeat log-storm hygiene. Defaults to `account` when unsure, so a
 * genuine connection problem is never softened into "just a network blip".
 */
export function classifySyncErrorCause(error: unknown): SyncIssueCause {
  return matchesNetworkCodeOrMessage(error) ? 'network' : 'account';
}

// =============================================================================
// Schemas & types
// =============================================================================

/** Schema for meeting transcript status */
export const MeetingTranscriptStatusSchema = z.enum([
  'upcoming',
  'in_progress',
  'captured',
  'missed',
  'failed',
  'declined',
]);

export type MeetingTranscriptStatus = z.infer<typeof MeetingTranscriptStatusSchema>;

/** Schema for meeting history entry (subset for UI) */
export const MeetingHistoryEntrySchema = z.object({
  id: z.string(),
  calendarEventId: z.string(),
  title: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  transcriptStatus: MeetingTranscriptStatusSchema,
  transcriptPath: z.string().optional(),
  botScheduled: z.boolean(),
});

export type MeetingHistoryEntry = z.infer<typeof MeetingHistoryEntrySchema>;

/** Schema for a cached meeting from calendar MCPs */
export const CachedMeetingSchema = z.object({
  /** Composite ID: calendarSource:eventId */
  id: z.string(),
  /** Provider's event ID */
  calendarEventId: z.string(),
  /** Calendar provider (google, microsoft) */
  calendarSource: z.string(),
  /** Provider calendar ID when known */
  calendarId: z.string().optional(),
  /** Meeting title */
  title: z.string(),
  /** ISO 8601 datetime */
  startTime: z.string(),
  /** ISO 8601 datetime */
  endTime: z.string(),
  /** Video call URL if available */
  meetingUrl: z.string().optional(),
  /** List of participant names/emails */
  participants: z.array(z.string()),
  /** List of participant emails, when available from provider */
  participantEmails: z.array(z.string()).optional(),
  /** Path to prep file if it exists */
  prepPath: z.string().optional(),
});

export type CachedMeeting = z.infer<typeof CachedMeetingSchema>;

export const AvailableCalendarSchema = z.object({
  id: z.string(),
  name: z.string(),
  isPrimary: z.boolean(),
  provider: z.enum(['google', 'microsoft']),
  accountEmail: z.string(),
});

export type AvailableCalendar = z.infer<typeof AvailableCalendarSchema>;

/** Response schema for cached meetings */
export const MeetingCacheResponseSchema = z.object({
  success: z.boolean(),
  meetings: z.array(CachedMeetingSchema),
  populatedAt: z.number().nullable(),
  lastSyncError: z.string().optional(),
  /** Warnings from calendar sources that failed during sync */
  syncWarnings: z.array(z.string()).optional(),
  isStale: z.boolean(),
});

export type MeetingCacheResponse = z.infer<typeof MeetingCacheResponseSchema>;

export const calendarChannels = {
  'calendar:get-cached-meetings': defineInvokeChannel({
    channel: 'calendar:get-cached-meetings',
    request: z.object({
      /** If true, return only today's meetings */
      todayOnly: z.boolean().optional(),
    }),
    response: MeetingCacheResponseSchema,
    description: 'Get cached meetings from the 24h meeting cache',
  }),

  'calendar:list-available-calendars': defineInvokeChannel({
    channel: 'calendar:list-available-calendars',
    request: z.object({
      calendarSource: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      calendars: z.array(AvailableCalendarSchema),
      error: z.string().optional(),
    }),
    description: 'List available calendars for a connected calendar account',
  }),

  'calendar:trigger-sync': defineInvokeChannel({
    channel: 'calendar:trigger-sync',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      message: z.string().optional(),
    }),
    description: 'Manually trigger a calendar sync (normally runs every 2h)',
  }),

  'calendar:get-meeting-history-status': defineInvokeChannel({
    channel: 'calendar:get-meeting-history-status',
    request: z.object({
      /** Meetings to look up (calendarSource + calendarEventId pairs) */
      meetings: z.array(z.object({
        calendarSource: z.string(),
        calendarEventId: z.string(),
      })),
    }),
    response: z.object({
      /** Map of calendarEventId -> transcript status */
      statuses: z.record(z.string(), MeetingTranscriptStatusSchema),
    }),
    description: 'Get transcript status for meetings by their calendar source and event IDs',
  }),

  'calendar:get-missed-meetings': defineInvokeChannel({
    channel: 'calendar:get-missed-meetings',
    request: z.object({
      /** Number of days to look back (default 7) */
      days: z.number().optional(),
    }),
    response: z.object({
      meetings: z.array(MeetingHistoryEntrySchema),
      count: z.number(),
    }),
    description: 'Get meetings that were missed (no transcript) in the past N days',
  }),

  'calendar:skip-meeting-prep': defineInvokeChannel({
    channel: 'calendar:skip-meeting-prep',
    request: z.object({
      meetingId: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Mark a meeting as skipped for prep by setting sentinel prepPath',
  }),

  'calendar:unskip-meeting-prep': defineInvokeChannel({
    channel: 'calendar:unskip-meeting-prep',
    request: z.object({
      meetingId: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Remove skip-prep sentinel from a meeting, restoring it to needing prep',
  }),
};

export type CalendarChannels = typeof calendarChannels;
