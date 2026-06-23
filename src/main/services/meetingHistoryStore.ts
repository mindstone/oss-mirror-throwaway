/**
 * Meeting History Store
 *
 * Tracks calendar meetings and their transcript outcomes.
 * Provides a unified view of "what meetings existed" and "what was captured".
 * 
 * Key concepts:
 * - Calendar is source of truth for "what meetings existed"
 * - Transcripts are source of truth for "what was captured"
 * - Meeting history joins these two data sources
 * - Uses collision-safe IDs: `${calendarSource}:${calendarEventId}:${startTime}`
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { onTranscriptSaved, type TranscriptSavedEvent } from './meetingBot/transcriptEventBus';
import { urlsMatchSameMeeting, isWithinDedupWindow } from './meetingBot/urlUtils';
import { getCachedMeetings, onMeetingCacheUpdated, type CachedMeeting } from './meetingCacheStore';
import { getPendingTranscripts } from './meetingBot/pendingTranscriptsStore';

const log = createScopedLogger({ service: 'meeting-history' });

/** Store version for migrations */
const STORE_VERSION = 1;

/** Retention period in days */
const RETENTION_DAYS = 30;

/** Maximum entries to prevent unbounded growth */
const MAX_ENTRIES = 500;

/**
 * Transcript status for a meeting.
 */
export type MeetingTranscriptStatus =
  | 'upcoming'      // Meeting hasn't started yet
  | 'in_progress'   // Meeting is happening now
  | 'pending'       // Meeting ended, bot still processing
  | 'captured'      // Transcript saved successfully
  | 'missed'        // Meeting ended with no transcript
  | 'declined'      // User explicitly declined capture
  | 'external'      // Handled by external provider (Fireflies/Fathom)
  | 'failed'        // Bot failed (rejected, error, etc.)
  | 'cancelled';    // Meeting was removed from calendar

/**
 * Source of the transcript.
 */
export type TranscriptSource =
  | 'recall'        // Recall.ai cloud bot
  | 'local'         // Local recording via Desktop SDK
  | 'fireflies'     // Imported from Fireflies
  | 'fathom'        // Imported from Fathom
  | 'plaud'         // Plaud device recording
  | 'limitless'     // Limitless device recording
  | 'manual';       // User uploaded/linked manually

/**
 * A meeting history entry linking calendar events to transcripts.
 */
export interface MeetingHistoryEntry {
  /** Collision-safe ID: `${calendarSource}:${calendarEventId}:${startTime}` */
  id: string;
  /** Calendar event ID from the provider */
  calendarEventId: string;
  /** Calendar source (google, microsoft) */
  calendarSource: string;
  /** Meeting title */
  title: string;
  /** Meeting start time (ISO 8601) */
  startTime: string;
  /** Meeting end time (ISO 8601) */
  endTime: string;
  /** Video call URL if available */
  meetingUrl?: string;
  /** List of participant emails/names */
  participants: string[];
  /** List of participant emails from calendar provider (lowercased). */
  participantEmails?: string[];
  /** Current transcript status */
  transcriptStatus: MeetingTranscriptStatus;
  /** Path to saved transcript file */
  transcriptPath?: string;
  /** Source of the transcript */
  transcriptSource?: TranscriptSource;
  /** Was a bot scheduled for this meeting? */
  botScheduled: boolean;
  /** When bot was scheduled (if applicable) */
  botScheduledAt?: string;
  /** Bot ID if one was sent */
  botId?: string;
  /** When user declined capture */
  declinedAt?: string;
  /** Reason for declining */
  declinedReason?: 'user_dismissed' | 'external_provider' | 'local_recording';
  /** Entry creation time */
  createdAt: string;
  /** Last update time */
  updatedAt: string;
}

/** Store schema - uses Record for O(1) upserts */
type MeetingHistoryStoreShape = {
  version: number;
  entries: Record<string, MeetingHistoryEntry>;
  lastReconciliationAt?: string;
}

const createDefaultState = (): MeetingHistoryStoreShape => ({
  version: STORE_VERSION,
  entries: {},
});

/** Store instance (lazy-initialized) */
let _store: KeyValueStore<MeetingHistoryStoreShape> | null = null;
const getStore = () => _store ??= createStore<MeetingHistoryStoreShape>({
  name: 'meeting-history',
  defaults: createDefaultState(),
});

/**
 * Get current state.
 */
function getState(): MeetingHistoryStoreShape {
  return getStore().store;
}

/**
 * Save state.
 */
function saveState(state: MeetingHistoryStoreShape): void {
  getStore().store = state;
}

/**
 * Generate a collision-safe meeting ID.
 * Format: `${calendarSource}:${calendarEventId}:${canonicalStartTime}`
 * 
 * This handles:
 * - Same eventId from different calendar providers
 * - Recurring meetings (same eventId, different start times)
 */
export function generateMeetingId(
  calendarSource: string,
  calendarEventId: string,
  startTime: string
): string {
  // Normalize to ISO string for consistent formatting
  const canonicalTime = new Date(startTime).toISOString();
  return `${calendarSource}:${calendarEventId}:${canonicalTime}`;
}

/**
 * Create or update a meeting entry.
 * Uses upsert semantics - merges with existing entry if present.
 */
export function upsertMeetingEntry(
  entry: Partial<MeetingHistoryEntry> & { id: string }
): MeetingHistoryEntry {
  const state = getState();
  const now = new Date().toISOString();
  const existing = state.entries[entry.id];

  const defaults: MeetingHistoryEntry = {
    id: entry.id,
    calendarEventId: '',
    calendarSource: '',
    title: 'Unknown Meeting',
    startTime: now,
    endTime: now,
    participants: [],
    transcriptStatus: 'upcoming',
    botScheduled: false,
    createdAt: now,
    updatedAt: now,
  };

  const updated: MeetingHistoryEntry = {
    ...defaults,
    ...existing,
    ...entry,
    updatedAt: now,
  };

  state.entries[entry.id] = updated;
  saveState(state);

  log.debug({ meetingId: entry.id, status: updated.transcriptStatus }, 'Upserted meeting entry');
  return updated;
}

/**
 * Get a meeting entry by ID.
 */
export function getMeetingEntry(id: string): MeetingHistoryEntry | undefined {
  const state = getState();
  return state.entries[id];
}

/**
 * Get all meetings in a date range.
 * Returns meetings sorted by start time (ascending).
 */
export function getMeetingsInRange(start: Date, end: Date): MeetingHistoryEntry[] {
  const state = getState();
  const startMs = start.getTime();
  const endMs = end.getTime();

  return Object.values(state.entries)
    .filter(entry => {
      const meetingStart = new Date(entry.startTime).getTime();
      return meetingStart >= startMs && meetingStart <= endMs;
    })
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

/**
 * Get meetings that were missed (no transcript captured).
 * Returns meetings that:
 * - Have status 'missed'
 * - Have ended (endTime < now)
 * - Ended after the `since` date
 */
export function getMissedMeetings(since: Date): MeetingHistoryEntry[] {
  const state = getState();
  const now = Date.now();
  const sinceMs = since.getTime();

  return Object.values(state.entries)
    .filter(entry => {
      const endTime = new Date(entry.endTime).getTime();
      return (
        entry.transcriptStatus === 'missed' &&
        endTime < now &&
        endTime >= sinceMs
      );
    })
    .sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime());
}

/**
 * Link a transcript to a meeting.
 */
export function linkTranscript(
  meetingId: string,
  transcriptPath: string,
  source: TranscriptSource
): void {
  const entry = getMeetingEntry(meetingId);
  if (!entry) {
    log.warn({ meetingId }, 'Cannot link transcript: meeting entry not found');
    return;
  }

  upsertMeetingEntry({
    id: meetingId,
    transcriptStatus: 'captured',
    transcriptPath,
    transcriptSource: source,
  });

  log.info({ meetingId, transcriptPath, source }, 'Linked transcript to meeting');
}

/**
 * Mark a meeting as failed (bot error).
 */
export function markFailed(meetingId: string): void {
  upsertMeetingEntry({
    id: meetingId,
    transcriptStatus: 'failed',
  });
}

/**
 * Get all meeting entries (for debugging/export).
 */
export function getAllMeetingEntries(): MeetingHistoryEntry[] {
  const state = getState();
  return Object.values(state.entries)
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
}

/**
 * Get meeting history stats.
 */
export function getMeetingHistoryStats(): {
  total: number;
  captured: number;
  missed: number;
  upcoming: number;
  lastReconciliationAt?: string;
} {
  const state = getState();
  const entries = Object.values(state.entries);

  return {
    total: entries.length,
    captured: entries.filter(e => e.transcriptStatus === 'captured').length,
    missed: entries.filter(e => e.transcriptStatus === 'missed').length,
    upcoming: entries.filter(e => e.transcriptStatus === 'upcoming').length,
    lastReconciliationAt: state.lastReconciliationAt,
  };
}

/**
 * Update last reconciliation timestamp.
 */
export function updateLastReconciliationAt(): void {
  const state = getState();
  state.lastReconciliationAt = new Date().toISOString();
  saveState(state);
}

/**
 * Clean up old entries beyond retention period.
 * Also enforces MAX_ENTRIES cap.
 */
export function cleanupOldEntries(): { removed: number } {
  const state = getState();
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = Object.values(state.entries);

  // Filter out expired entries (keep those with transcripts longer)
  const retained = entries.filter(entry => {
    const endTime = new Date(entry.endTime).getTime();
    // Keep if not expired
    if (endTime > cutoffMs) return true;
    // Keep if has transcript (user might still want it)
    if (entry.transcriptPath) return true;
    return false;
  });

  // Sort by start time descending and cap at MAX_ENTRIES
  retained.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  const capped = retained.slice(0, MAX_ENTRIES);

  // Rebuild entries map
  const newEntries: Record<string, MeetingHistoryEntry> = {};
  for (const entry of capped) {
    newEntries[entry.id] = entry;
  }

  const removed = entries.length - capped.length;
  if (removed > 0) {
    state.entries = newEntries;
    saveState(state);
    log.info({ removed, remaining: capped.length }, 'Cleaned up old meeting history entries');
  }

  return { removed };
}

/**
 * Clear all entries (for testing/reset).
 */
export function clearMeetingHistory(): void {
  getStore().clear();
  log.info('Cleared meeting history store');
}

/**
 * Find meeting by calendar event ID (for reconciliation).
 * Returns the most recent matching entry if multiple exist (recurring meetings).
 */
export function findMeetingByCalendarEvent(
  calendarSource: string,
  calendarEventId: string
): MeetingHistoryEntry | undefined {
  const state = getState();
  const matches = Object.values(state.entries)
    .filter(e => e.calendarSource === calendarSource && e.calendarEventId === calendarEventId)
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  return matches[0];
}

// ============================================================================
// Reconciliation Logic
// ============================================================================

/**
 * Check if there's an active pending bot for a meeting URL.
 * Used by reconciliation to avoid marking meetings as "missed" when a bot is actively recording.
 * 
 * Bug 3 fix: The reconciliation logic was marking meetings as "missed" even when a bot
 * was actively recording, because it only checked `botScheduled` on the meeting entry,
 * not the actual pending bots store.
 * 
 * Reviewer fix: Added time window check to avoid false positives from stale bots
 * with the same recurring meeting URL.
 */
function hasActivePendingBot(meetingUrl: string | undefined, meetingStartTime?: string): boolean {
  if (!meetingUrl) return false;
  
  const pendingBots = getPendingTranscripts();
  const now = new Date().toISOString();
  
  return pendingBots.some(bot => {
    // Only consider active bots (not failed/saved)
    if (bot.status === 'failed' || bot.savedPath) return false;
    // Match by URL
    if (!bot.meetingUrl || !urlsMatchSameMeeting(meetingUrl, bot.meetingUrl)) return false;
    // If we have a meeting start time, also check time window to avoid stale bot false positives
    if (meetingStartTime && bot.scheduledAt) {
      return isWithinDedupWindow(bot.scheduledAt, meetingStartTime);
    }
    // For in_meeting bots without time info, check they were created recently (within 4 hours)
    if (bot.createdAt) {
      return isWithinDedupWindow(bot.createdAt, now, 4 * 60 * 60 * 1000);
    }
    return true;
  });
}

/**
 * Match a transcript to a calendar meeting.
 * 
 * Priority 1: calendarEventId match (exact, no ambiguity)
 * Priority 2: URL + time window (reuse existing dedup logic)
 */
export function matchTranscriptToMeeting(
  transcript: { calendarEventId?: string; meetingUrl?: string; startTime: string },
  meeting: CachedMeeting
): boolean {
  // Priority 1: calendar_event_id match (exact, no ambiguity)
  if (transcript.calendarEventId && meeting.calendarEventId) {
    return transcript.calendarEventId === meeting.calendarEventId;
  }

  // Priority 2: URL + time window (reuse existing dedup logic)
  if (transcript.meetingUrl && meeting.meetingUrl) {
    return urlsMatchSameMeeting(transcript.meetingUrl, meeting.meetingUrl) &&
           isWithinDedupWindow(transcript.startTime, meeting.startTime);
  }

  return false;
}

/**
 * Find a matching calendar meeting for a transcript.
 * Searches the calendar cache for a meeting that matches the transcript.
 */
export function findMatchingCalendarMeeting(
  transcript: { calendarEventId?: string; meetingUrl?: string; startTime: string }
): CachedMeeting | undefined {
  const cache = getCachedMeetings();
  if (!cache) return undefined;

  return cache.meetings.find(meeting => matchTranscriptToMeeting(transcript, meeting));
}

/**
 * Reconcile calendar meetings with meeting history.
 * Creates/updates history entries for calendar meetings.
 * 
 * Called after calendar sync to ensure all calendar meetings have history entries.
 */
export function reconcileCalendarMeetings(meetings: CachedMeeting[]): {
  created: number;
  updated: number;
} {
  let created = 0;
  let updated = 0;
  const now = Date.now();

  for (const meeting of meetings) {
    const id = generateMeetingId(meeting.calendarSource, meeting.calendarEventId, meeting.startTime);
    const existing = getMeetingEntry(id);

    if (!existing) {
      // Create new entry for this calendar meeting
      const meetingStart = new Date(meeting.startTime).getTime();
      const meetingEnd = new Date(meeting.endTime).getTime();

      // Determine initial status based on time
      // Bug 3 fix: Also check for active pending bots when creating new entries
      let status: MeetingTranscriptStatus = 'upcoming';
      if (meetingEnd < now) {
        // Check if there's an active bot for this meeting URL (with time window)
        if (hasActivePendingBot(meeting.meetingUrl, meeting.startTime)) {
          status = 'in_progress'; // Bot is recording, not missed
        } else {
          status = 'missed'; // Past meeting with no transcript yet
        }
      } else if (meetingStart <= now && now <= meetingEnd) {
        status = 'in_progress';
      }

      upsertMeetingEntry({
        id,
        calendarEventId: meeting.calendarEventId,
        calendarSource: meeting.calendarSource,
        title: meeting.title,
        startTime: meeting.startTime,
        endTime: meeting.endTime,
        meetingUrl: meeting.meetingUrl,
        participants: meeting.participants,
        participantEmails: meeting.participantEmails,
        transcriptStatus: status,
        botScheduled: false,
      });
      created++;
    } else {
      // Update existing entry - refresh title/participants but preserve transcript status
      const meetingStart = new Date(meeting.startTime).getTime();
      const meetingEnd = new Date(meeting.endTime).getTime();

      // Only update status if it's a time-based status (not captured/missed with transcript)
      let newStatus = existing.transcriptStatus;
      if (existing.transcriptStatus === 'upcoming' || existing.transcriptStatus === 'in_progress') {
        if (meetingEnd < now && !existing.transcriptPath) {
          // Bug 3 fix: Don't mark as missed if:
          // 1. A bot is scheduled on this entry, OR
          // 2. There's an active pending bot for this meeting URL (with time window)
          const hasActiveBot = existing.botScheduled || hasActivePendingBot(meeting.meetingUrl, meeting.startTime);
          if (!hasActiveBot) {
            newStatus = 'missed';
          }
          // If bot is active, keep as 'in_progress' to indicate bot may deliver transcript
        } else if (meetingStart <= now && now <= meetingEnd) {
          newStatus = 'in_progress';
        }
      }

      upsertMeetingEntry({
        id,
        title: meeting.title,
        participants: meeting.participants,
        participantEmails: meeting.participantEmails,
        meetingUrl: meeting.meetingUrl,
        transcriptStatus: newStatus,
      });
      updated++;
    }
  }

  if (created > 0 || updated > 0) {
    updateLastReconciliationAt();
    log.info({ created, updated }, 'Reconciled calendar meetings with history');
  }

  return { created, updated };
}

// ============================================================================
// Event Bus Integration
// ============================================================================

/** Unsubscribe function for event bus listener */
let unsubscribeFromEventBus: (() => void) | null = null;

/** Unsubscribe function for cache update listener */
let unsubscribeFromCacheUpdates: (() => void) | null = null;

/**
 * Map TranscriptSourceSystem to TranscriptSource.
 */
function mapSourceSystemToSource(sourceSystem: TranscriptSavedEvent['sourceSystem']): TranscriptSource {
  switch (sourceSystem) {
    case 'recall':
      return 'recall';
    case 'desktop_sdk':
      return 'local';
    case 'fireflies':
      return 'fireflies';
    case 'fathom':
      return 'fathom';
    case 'plaud':
      return 'plaud';
    case 'limitless':
      return 'limitless';
    case 'quick_capture':
      return 'local';
    case 'mobile-recording':
      return 'manual';
    default: {
      const _exhaustive: never = sourceSystem;
      return _exhaustive;
    }
  }
}

/**
 * Handle transcript saved event - attempt to link to a meeting entry.
 */
function handleTranscriptSaved(event: TranscriptSavedEvent): void {
  if (event.alreadyExists) {
    log.debug({ sourceUid: event.sourceUid }, 'Transcript already exists, skipping history update');
    return;
  }

  const source = mapSourceSystemToSource(event.sourceSystem);

  log.info(
    {
      sourceSystem: event.sourceSystem,
      sourceUid: event.sourceUid,
      filePath: event.filePath,
      meetingTitle: event.meetingTitle,
      startTime: event.startTime,
    },
    'Transcript saved event received, attempting to link to meeting'
  );

  // Try to find a matching calendar meeting using calendarEventId or meetingUrl
  const matchingMeeting = findMatchingCalendarMeeting({
    calendarEventId: event.calendarEventId,
    meetingUrl: event.meetingUrl,
    startTime: event.startTime,
  });

  if (matchingMeeting) {
    // Found a matching calendar meeting - link the transcript
    const meetingId = generateMeetingId(
      matchingMeeting.calendarSource,
      matchingMeeting.calendarEventId,
      matchingMeeting.startTime
    );

    // Ensure the meeting entry exists (upsert) before linking
    // This handles the case where a transcript arrives before calendar reconciliation
    const existing = getMeetingEntry(meetingId);
    if (!existing) {
      upsertMeetingEntry({
        id: meetingId,
        calendarEventId: matchingMeeting.calendarEventId,
        calendarSource: matchingMeeting.calendarSource,
        title: matchingMeeting.title,
        startTime: matchingMeeting.startTime,
        endTime: matchingMeeting.endTime,
        meetingUrl: matchingMeeting.meetingUrl,
        participants: matchingMeeting.participants,
        transcriptStatus: 'captured',
        transcriptPath: event.filePath,
        transcriptSource: source,
        botScheduled: event.sourceSystem === 'recall',
      });
    } else {
      // Entry exists, just link the transcript
      linkTranscript(meetingId, event.filePath, source);
    }

    log.info(
      { meetingId, filePath: event.filePath, meetingTitle: matchingMeeting.title },
      'Linked transcript to calendar meeting'
    );
  } else {
    // No matching calendar meeting - create an orphan entry
    // This handles transcripts from meetings not in the calendar (e.g., ad-hoc calls)
    const orphanId = `orphan:${event.sourceUid}:${new Date(event.startTime).toISOString()}`;
    
    upsertMeetingEntry({
      id: orphanId,
      calendarEventId: '',
      calendarSource: 'unknown',
      title: event.meetingTitle,
      startTime: event.startTime,
      endTime: event.startTime, // Unknown end time
      participants: event.participants,
      transcriptStatus: 'captured',
      transcriptPath: event.filePath,
      transcriptSource: source,
      botScheduled: event.sourceSystem === 'recall',
    });

    log.info(
      { orphanId, filePath: event.filePath, meetingTitle: event.meetingTitle },
      'Created orphan meeting entry for transcript without calendar match'
    );
  }
}

/**
 * Initialize meeting history store.
 * Call this on app startup after services are ready.
 * 
 * - Subscribes to transcript event bus for automatic linking
 * - Subscribes to calendar cache updates for reconciliation
 * - Runs initial reconciliation if cache is already populated
 * - Runs cleanup of old entries
 */
export function initializeMeetingHistoryStore(): void {
  // Subscribe to transcript events for automatic linking
  if (!unsubscribeFromEventBus) {
    unsubscribeFromEventBus = onTranscriptSaved(handleTranscriptSaved);
    log.info('Subscribed to transcript event bus');
  }

  // Subscribe to calendar cache updates for reconciliation
  if (!unsubscribeFromCacheUpdates) {
    unsubscribeFromCacheUpdates = onMeetingCacheUpdated((meetings) => {
      reconcileCalendarMeetings(meetings);
    });
    log.info('Subscribed to calendar cache updates');
  }

  // Run initial reconciliation if cache is already populated
  // (handles case where calendar sync ran before this init)
  const cache = getCachedMeetings();
  if (cache && cache.meetings.length > 0) {
    const { created, updated } = reconcileCalendarMeetings(cache.meetings);
    log.info({ created, updated }, 'Initial reconciliation from existing cache');
  }

  // Clean up old entries
  const { removed } = cleanupOldEntries();
  if (removed > 0) {
    log.info({ removed }, 'Cleaned up old meeting history entries on startup');
  }

  const stats = getMeetingHistoryStats();
  log.info(stats, 'Meeting history store initialized');
}

/**
 * Shutdown meeting history store.
 * Call this on app quit to clean up subscriptions.
 */
export function shutdownMeetingHistoryStore(): void {
  if (unsubscribeFromEventBus) {
    unsubscribeFromEventBus();
    unsubscribeFromEventBus = null;
    log.info('Unsubscribed from transcript event bus');
  }

  if (unsubscribeFromCacheUpdates) {
    unsubscribeFromCacheUpdates();
    unsubscribeFromCacheUpdates = null;
    log.info('Unsubscribed from calendar cache updates');
  }
}
