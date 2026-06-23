/**
 * Pending Transcripts Store
 *
 * Tracks meeting bot transcripts that are waiting to be fetched.
 * Uses electron-store for persistence with demo mode support.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import type { PendingTranscript, PendingTranscriptStatus, TranscriptQuality, AsyncUpgradeStatus } from '@shared/ipc/channels/meetingBot';

const log = createScopedLogger({ service: 'meeting-bot' });

/** Store version for migrations */
const STORE_VERSION = 1;

/** How long to keep pending transcripts before expiry (7 days) */
const EXPIRY_DAYS = 7;

/** Maximum number of pending transcripts to keep */
const MAX_PENDING = 50;

/**
 * Maximum time to poll for async transcript upgrade (3 hours).
 * Recall.ai async transcription typically completes in 10-30 minutes.
 * 3 hours provides generous buffer for backlogs while catching stuck jobs.
 */
const ASYNC_UPGRADE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/** Maximum number of save attempts before giving up (increased from 3 for better resilience) */
const MAX_SAVE_ATTEMPTS = 6;

/**
 * Max time to retry saving a transcript before giving up (24 hours).
 * Defined near the top because the retry-window logic (resetTransientFailedTranscripts,
 * ensureRetryWindowStarted) references it before the backoff constants below.
 */
const MAX_RETRY_HOURS = 24;

/** Store schema */
type PendingTranscriptsState = {
  version: number;
  transcripts: PendingTranscript[];
}

const createDefaultState = (): PendingTranscriptsState => ({
  version: STORE_VERSION,
  transcripts: [],
});

/** Lazy-initialized store instance */
let _store: KeyValueStore<PendingTranscriptsState> | null = null;
const getStore = (): KeyValueStore<PendingTranscriptsState> => {
  if (!_store) {
    _store = createStore<PendingTranscriptsState>({
      name: 'meeting-bot-pending',
      defaults: createDefaultState(),
    });
    migrateStagedSentinelValues(_store);
  }
  return _store;
};

/**
 * Idempotent migration: convert legacy `staged:...` sentinel values in `savedPath`
 * to the proper `stagedForReview` boolean flag.
 *
 * Before this fix, the sensitivity guard stored `staged:${spacePath}` in `savedPath`,
 * which downstream consumers incorrectly treated as a real filesystem path.
 */
function migrateStagedSentinelValues(store: KeyValueStore<PendingTranscriptsState>): void {
  const state = store.store;
  let migrated = 0;

  const updated = state.transcripts.map(t => {
    if (t.savedPath?.startsWith('staged:')) {
      migrated++;
      log.info({ botId: t.botId, oldSavedPath: t.savedPath }, 'Migrating staged sentinel value to stagedForReview flag');
      return { ...t, savedPath: undefined, stagedForReview: true };
    }
    return t;
  });

  if (migrated > 0) {
    store.store = { ...state, transcripts: updated };
    log.info({ migrated }, 'Completed staged sentinel value migration');
  }
}

/**
 * Build the structured, secret-free audit payload for a terminal `failed`
 * transition. Josh's operational-specialist F2 requirement: `failed` must mean
 * "retries exhausted", never "a recoverable transcript was silently abandoned",
 * so we record whether a saved or live transcript path still exists alongside the
 * retry-exhaustion bookkeeping. Logs paths' PRESENCE (booleans), never the path
 * strings, transcript content, or tokens.
 */
function buildTerminalFailureAuditFields(
  t: PendingTranscript,
  reason: string,
  terminalClass: 'attempts_exhausted' | 'retry_window_exhausted' | 'permanent' | 'stale_cleanup' | 'other',
): Record<string, unknown> {
  return {
    botId: t.botId,
    saveAttempts: t.saveAttempts ?? 0,
    retryWindowStartedAt: t.retryWindowStartedAt,
    lastRetryAt: t.lastRetryAt,
    consecutiveErrors: t.consecutiveErrors ?? 0,
    terminalReason: reason,
    terminalClass,
    // Recoverability audit: does a transcript path survive this terminal state?
    // If true, a recoverable transcript may have been abandoned — investigate.
    hasSavedPath: Boolean(t.savedPath),
    hasLiveTranscriptPath: Boolean(t.liveTranscriptPath),
    stagedForReview: Boolean(t.stagedForReview),
  };
}

/**
 * Classify a terminal `failed` reason into a small, stable set of classes for
 * observability (so dashboards/log queries can bucket terminal failures without
 * parsing free-text reasons). Conservative: anything unrecognised is 'other'.
 */
function classifyTerminalReason(
  reason: string | undefined,
): 'attempts_exhausted' | 'retry_window_exhausted' | 'permanent' | 'stale_cleanup' | 'other' {
  if (!reason) return 'other';
  if (reason.includes('max save attempts')) return 'attempts_exhausted';
  if (reason.includes('max retry duration')) return 'retry_window_exhausted';
  if (reason.includes('403') || reason.includes('404') || reason.includes('expired') || reason.includes('not found')) {
    return 'permanent';
  }
  if (reason.includes('Stale bot cleanup')) return 'stale_cleanup';
  return 'other';
}

/**
 * Get current state.
 */
export function getPendingTranscriptsState(): PendingTranscriptsState {
  return getStore().store;
}

/**
 * Save state.
 */
function saveState(state: PendingTranscriptsState): void {
  getStore().store = state;
}

/**
 * Get all pending transcripts.
 */
export function getPendingTranscripts(): PendingTranscript[] {
  const state = getPendingTranscriptsState();
  return state.transcripts;
}

/**
 * Get a specific pending transcript by bot ID.
 */
export function getPendingTranscript(botId: string): PendingTranscript | undefined {
  const state = getPendingTranscriptsState();
  return state.transcripts.find(t => t.botId === botId);
}

/**
 * Add a new pending transcript.
 */
export function addPendingTranscript(transcript: Omit<PendingTranscript, 'createdAt' | 'expiresAt'>): void {
  const state = getPendingTranscriptsState();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const newTranscript: PendingTranscript = {
    ...transcript,
    createdAt: now,
    expiresAt,
  };

  // Remove duplicates and add new
  const filtered = state.transcripts.filter(t => t.botId !== transcript.botId);
  const updated = [newTranscript, ...filtered].slice(0, MAX_PENDING);

  saveState({
    ...state,
    transcripts: updated,
  });

  log.info({ botId: transcript.botId, meetingTitle: transcript.meetingTitle }, 'Added pending transcript');
}

/**
 * Update status of a pending transcript.
 */
export function updatePendingTranscriptStatus(
  botId: string,
  status: PendingTranscriptStatus,
  errorMessage?: string
): void {
  const state = getPendingTranscriptsState();
  let terminalAudit: Record<string, unknown> | undefined;
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      // For failed status, also set failureReason for forensics
      const failureReason = status === 'failed' ? errorMessage : t.failureReason;
      // Emit a structured, auditable record on every terminal `failed` transition
      // (Josh F2: a `failed` transcript must be auditable as "retries exhausted",
      // never a silently-abandoned recoverable one). Computed from the PRE-update
      // snapshot so attempts/window/path state reflects what led to the failure.
      if (status === 'failed') {
        terminalAudit = buildTerminalFailureAuditFields(t, errorMessage ?? 'unknown', classifyTerminalReason(errorMessage));
      }
      return { ...t, status, errorMessage, failureReason };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
  if (terminalAudit) {
    log.warn(terminalAudit, 'Transcript reached terminal failed state');
  }
  log.debug({ botId, status, errorMessage }, 'Updated pending transcript status');
}

/**
 * Mark a pending transcript as saved.
 */
export function markTranscriptSaved(botId: string, savedPath: string): void {
  const state = getPendingTranscriptsState();
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      return { ...t, savedPath };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
  log.info({ botId, savedPath }, 'Marked transcript as saved');
}

/**
 * Mark a pending transcript as staged for sensitivity review.
 * Sets `stagedForReview: true` without touching `savedPath`, preserving the
 * invariant that `savedPath` only contains real filesystem paths.
 */
export function markTranscriptStaged(botId: string): void {
  const state = getPendingTranscriptsState();
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      return { ...t, stagedForReview: true };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
  log.info({ botId }, 'Marked transcript as staged for sensitivity review');
}

/**
 * Increment save attempts for a pending transcript.
 */
export function incrementSaveAttempts(botId: string): number {
  const state = getPendingTranscriptsState();
  let newAttempts = 0;
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      newAttempts = (t.saveAttempts ?? 0) + 1;
      return { ...t, saveAttempts: newAttempts };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
  return newAttempts;
}

/**
 * Increment consecutive error count for a transcript (for stale bot cleanup).
 * Returns the new count.
 */
export function incrementConsecutiveErrors(botId: string): number {
  const state = getPendingTranscriptsState();
  let newCount = 0;
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      newCount = (t.consecutiveErrors ?? 0) + 1;
      return { ...t, consecutiveErrors: newCount };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
  return newCount;
}

/**
 * Reset consecutive error count for a transcript (on successful status check).
 */
export function resetConsecutiveErrors(botId: string): void {
  const state = getPendingTranscriptsState();
  const updated = state.transcripts.map(t => {
    if (t.botId === botId && t.consecutiveErrors) {
      return { ...t, consecutiveErrors: 0 };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
}

/**
 * Update last retry timestamp for a transcript (for infinite retry prevention).
 */
export function updateLastRetryAt(botId: string): void {
  const state = getPendingTranscriptsState();
  const now = new Date().toISOString();
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      return { ...t, lastRetryAt: now };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
}

/**
 * Remove a pending transcript by bot ID.
 */
export function removePendingTranscript(botId: string): boolean {
  const state = getPendingTranscriptsState();
  const before = state.transcripts.length;
  const filtered = state.transcripts.filter(t => t.botId !== botId);

  if (filtered.length === before) {
    return false;
  }

  saveState({ ...state, transcripts: filtered });
  log.debug({ botId }, 'Removed pending transcript');
  return true;
}

/** How long to keep scheduled bots that never activated (24 hours) */
const STALE_SCHEDULED_HOURS = 24;

/**
 * Clean up expired transcripts and stale scheduled bots.
 */
export function cleanupExpiredTranscripts(): number {
  const state = getPendingTranscriptsState();
  const now = Date.now();
  const staleScheduledThreshold = now - STALE_SCHEDULED_HOURS * 60 * 60 * 1000;
  const before = state.transcripts.length;

  // Failed transcripts are kept for 7 days for forensics, then cleaned up
  const failedRetentionDays = 7;
  const failedCleanupThreshold = now - failedRetentionDays * 24 * 60 * 60 * 1000;

  const filtered = state.transcripts.filter(t => {
    // Remove expired transcripts
    const expiresAt = new Date(t.expiresAt).getTime();
    if (expiresAt <= now) {
      return false;
    }
    
    // Remove stale scheduled bots that never activated (scheduled time > 24 hours ago)
    // These are bots for meetings that were cancelled or had wrong URLs
    // Use scheduledAt (not createdAt) to handle far-future scheduled bots correctly
    if (t.status === 'scheduled') {
      const scheduledAt = new Date(t.scheduledAt).getTime();
      if (scheduledAt < staleScheduledThreshold) {
        log.debug(
          { botId: t.botId, meetingTitle: t.meetingTitle, scheduledAt: t.scheduledAt },
          'Removing stale scheduled bot (scheduled time > 24h ago, never activated)'
        );
        return false;
      }
    }

    // Remove failed transcripts after 7 days (they were kept for forensics, now can be cleaned)
    if (t.status === 'failed') {
      const createdAt = new Date(t.createdAt).getTime();
      if (createdAt < failedCleanupThreshold) {
        log.debug(
          { botId: t.botId, meetingTitle: t.meetingTitle, failureReason: t.failureReason, createdAt: t.createdAt },
          'Removing failed transcript after 7-day retention period'
        );
        return false;
      }
    }
    
    return true;
  });

  if (filtered.length < before) {
    saveState({ ...state, transcripts: filtered });
    const removed = before - filtered.length;
    log.info({ removed }, 'Cleaned up expired/stale pending transcripts');
    return removed;
  }

  return 0;
}

/**
 * Reset failed transcripts for retry on startup.
 * Resets all failed transcripts created within the last 7 days (while KV data is still alive).
 * Permanent failures (expired bots, 404s) will re-fail quickly on the next poll cycle.
 * Returns the number of transcripts reset.
 *
 * RETRY-WINDOW SEMANTICS (the storm fix):
 * Previously this rebaselined `retryWindowStartedAt` to `now` on EVERY startup,
 * so a chronically-failing transcript's MAX_RETRY_HOURS cap never elapsed — every
 * app restart handed it a fresh 24h window and it retried forever (the amplifier
 * during the DNS-starvation outage, since restarts were frequent). Now the window
 * is PRESERVED across restarts. Only when the prior window has ALREADY exhausted
 * (≥ MAX_RETRY_HOURS old) do we grant a genuine second-chance rebaseline — that
 * covers the legitimate "we shipped a code fix, give it one more 24h run" case
 * without letting the clock reset on every boot. Attempt-based exhaustion
 * (`saveAttempts >= MAX_SAVE_ATTEMPTS`) is still fully cleared, since a code-fix
 * reset is a fresh start for the attempt counter.
 */
export function resetTransientFailedTranscripts(): number {
  const state = getPendingTranscriptsState();
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const maxRetryAgeMs = MAX_RETRY_HOURS * 60 * 60 * 1000;
  let resetCount = 0;

  const updated = state.transcripts.map(t => {
    if (t.status !== 'failed') return t;

    // Don't retry if created more than 7 days ago (KV data is gone)
    const createdAt = new Date(t.createdAt).getTime();
    if (now - createdAt > SEVEN_DAYS_MS) return t;

    // Decide whether the EXISTING retry-duration window has already exhausted.
    // If it has (or there is no window yet — a transcript that failed without ever
    // arming one), grant a fresh window. Otherwise PRESERVE the existing window so
    // the MAX_RETRY_HOURS cap keeps counting from the first failure across restarts.
    const priorWindowStart = resolveRetryWindowStartMs(t);
    const priorWindowExhausted = now - priorWindowStart > maxRetryAgeMs;
    const hadWindow = Boolean(t.retryWindowStartedAt);
    const grantFreshWindow = priorWindowExhausted || !hadWindow;

    log.info(
      {
        botId: t.botId,
        failureReason: t.failureReason,
        saveAttempts: t.saveAttempts,
        priorWindowExhausted,
        grantFreshWindow,
      },
      'Resetting failed transcript for retry on startup'
    );
    resetCount++;
    return {
      ...t,
      status: 'ready' as const,
      saveAttempts: 0,
      consecutiveErrors: 0,
      // Clearing lastRetryAt + nextRetryAt makes the reset transcript eligible on
      // the next poll. The retry-duration window, however, is preserved unless the
      // prior window already exhausted — so a chronically-failing transcript can
      // actually reach `markExhaustedTranscriptsAsFailed` at MAX_RETRY_HOURS instead
      // of being handed an infinite series of fresh 24h windows by repeated restarts.
      lastRetryAt: undefined,
      nextRetryAt: undefined,
      retryWindowStartedAt: grantFreshWindow
        ? new Date(now).toISOString()
        : t.retryWindowStartedAt,
      failureReason: undefined,
      errorMessage: undefined,
    };
  });

  if (resetCount > 0) {
    saveState({ ...state, transcripts: updated });
  }
  return resetCount;
}

/**
 * Anchor the retry-duration window to the FIRST failure.
 *
 * Idempotent: sets `retryWindowStartedAt = now` only when it is absent. Once set
 * it is never moved forward by repeated failures, so the MAX_RETRY_HOURS cap is
 * measured from the first failure and a chronically-failing transcript actually
 * exhausts to `failed` (instead of resetting its clock on every retry). The only
 * place the window is legitimately rebaselined is a genuine second-chance reset
 * in {@link resetTransientFailedTranscripts}, and only after the prior window
 * already exhausted.
 */
export function ensureRetryWindowStarted(botId: string): void {
  const state = getPendingTranscriptsState();
  const index = state.transcripts.findIndex(t => t.botId === botId);
  if (index === -1) return;

  const transcript = state.transcripts[index];
  if (transcript.retryWindowStartedAt) {
    return; // already anchored — never move it forward
  }

  state.transcripts[index] = { ...transcript, retryWindowStartedAt: new Date().toISOString() };
  saveState(state);
  log.debug({ botId, retryWindowStartedAt: state.transcripts[index].retryWindowStartedAt }, 'Anchored retry-duration window to first failure');
}

/**
 * Update calendar info for a pending transcript (retroactive enrichment).
 * Called when calendar cache populates after a bot was sent without calendar linkage.
 */
export function updatePendingTranscriptCalendarInfo(
  botId: string,
  info: { calendarEventId?: string; calendarSource?: string; meetingTitle?: string }
): void {
  const state = getPendingTranscriptsState();
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      return {
        ...t,
        calendarEventId: info.calendarEventId ?? t.calendarEventId,
        calendarSource: info.calendarSource ?? t.calendarSource,
        meetingTitle: info.meetingTitle ?? t.meetingTitle,
      };
    }
    return t;
  });
  saveState({ ...state, transcripts: updated });
}

/**
 * Get all pending transcripts that need status check.
 * Returns transcripts with status: scheduled, in_meeting, processing
 */
export function getTranscriptsNeedingCheck(): PendingTranscript[] {
  const state = getPendingTranscriptsState();
  return state.transcripts.filter(
    t => t.status === 'scheduled' || t.status === 'in_meeting' || t.status === 'processing'
  );
}

/**
 * Linear backoff intervals for save retries (in milliseconds).
 * Aligned with POLL_INTERVAL_MS (5 min) so retries happen at predictable poll cycles.
 * Total retry window: ~105 minutes (1.75 hours) before giving up.
 */
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BACKOFF_INTERVALS_MS = [
  POLL_INTERVAL_MS,      // 5 min - first retry
  POLL_INTERVAL_MS * 2,  // 10 min
  POLL_INTERVAL_MS * 3,  // 15 min
  POLL_INTERVAL_MS * 4,  // 20 min
  POLL_INTERVAL_MS * 5,  // 25 min
  POLL_INTERVAL_MS * 6,  // 30 min
];

/**
 * Baseline (epoch ms) for the MAX_RETRY_HOURS retry-duration window: the recovery
 * rebaseline (`retryWindowStartedAt`) when present and valid, else `createdAt`.
 * Falls back to createdAt if `retryWindowStartedAt` is missing or unparseable — a
 * corrupted reset timestamp must NOT silently disable the retry-age cap.
 */
function resolveRetryWindowStartMs(t: Pick<PendingTranscript, 'retryWindowStartedAt' | 'createdAt'>): number {
  if (t.retryWindowStartedAt) {
    const rebaseline = new Date(t.retryWindowStartedAt).getTime();
    if (!Number.isNaN(rebaseline)) return rebaseline;
  }
  return new Date(t.createdAt).getTime();
}

/**
 * Mark transcripts as failed if they've exhausted retry attempts or exceeded max retry duration.
 * Called during polling to ensure exhausted transcripts get proper failed status for forensics.
 */
export function markExhaustedTranscriptsAsFailed(): number {
  const state = getPendingTranscriptsState();
  const now = Date.now();
  const maxRetryAge = MAX_RETRY_HOURS * 60 * 60 * 1000;
  let markedCount = 0;

  const updated = state.transcripts.map(t => {
    // Only check ready transcripts that haven't been saved (and aren't staged for review)
    if (t.status !== 'ready' || t.savedPath || t.stagedForReview) return t;

    // Check if exceeded max attempts
    if ((t.saveAttempts ?? 0) >= MAX_SAVE_ATTEMPTS) {
      const reason = `Exceeded max save attempts (${t.saveAttempts})`;
      // Structured, auditable terminal record (Josh F2): includes whether a saved/
      // live transcript path still exists so "failed" can never silently mean a
      // recoverable transcript was abandoned.
      log.warn(
        buildTerminalFailureAuditFields(t, reason, 'attempts_exhausted'),
        'Transcript reached terminal failed state - exceeded max save attempts'
      );
      markedCount++;
      return { ...t, status: 'failed' as const, failureReason: reason };
    }

    // Check if exceeded max retry duration. Measure from the first-failure anchor
    // (retryWindowStartedAt) when present, else from creation. Gate on EITHER an
    // explicit anchor OR a prior retry (`lastRetryAt`): the anchor is preserved
    // across restarts (resetTransientFailedTranscripts no longer rebaselines it),
    // so an exhausted window must be able to fail the transcript even immediately
    // after a restart cleared `lastRetryAt`, before the next attempt re-sets it.
    if (t.retryWindowStartedAt || t.lastRetryAt) {
      const retryWindowStart = resolveRetryWindowStartMs(t);
      if (now - retryWindowStart > maxRetryAge) {
        const reason = 'Exceeded max retry duration (24h)';
        log.warn(
          buildTerminalFailureAuditFields(t, reason, 'retry_window_exhausted'),
          'Transcript reached terminal failed state - exceeded max retry duration (24h)'
        );
        markedCount++;
        return { ...t, status: 'failed' as const, failureReason: reason };
      }
    }

    return t;
  });

  if (markedCount > 0) {
    saveState({ ...state, transcripts: updated });
  }

  return markedCount;
}

/**
 * Get all transcripts that are ready but haven't been saved yet.
 * Used for retry logic on startup and during polling.
 * 
 * Filters out transcripts that:
 * - Have exceeded MAX_SAVE_ATTEMPTS
 * - Are still in backoff period (nextRetryAt > now)
 * - Have been retrying for more than MAX_RETRY_HOURS (prevents infinite loops for persistent errors)
 */
export function getTranscriptsNeedingSave(): PendingTranscript[] {
  const state = getPendingTranscriptsState();
  const now = Date.now();
  const maxRetryAge = MAX_RETRY_HOURS * 60 * 60 * 1000;
  
  return state.transcripts.filter(t => {
    // Must be ready and not yet saved
    if (t.status !== 'ready' || t.savedPath) return false;

    // Staged transcripts are awaiting sensitivity review, not a save retry
    if (t.stagedForReview) return false;
    
    // Check attempt count
    if ((t.saveAttempts ?? 0) >= MAX_SAVE_ATTEMPTS) return false;
    
    // Check if still in backoff period
    if (t.nextRetryAt && new Date(t.nextRetryAt).getTime() > now) {
      log.debug(
        { botId: t.botId, nextRetryAt: t.nextRetryAt, saveAttempts: t.saveAttempts },
        'Skipping transcript save - still in backoff period'
      );
      return false;
    }
    
    // Check if retrying for too long (prevents infinite loops for persistent "transient" errors).
    // Baseline is the first-failure anchor (retryWindowStartedAt) when present, else createdAt.
    // Gate on EITHER the anchor OR a prior retry: the anchor is preserved across restarts, so an
    // exhausted window must stop further saves even right after a restart cleared `lastRetryAt`.
    if (t.retryWindowStartedAt || t.lastRetryAt) {
      const retryWindowStart = resolveRetryWindowStartMs(t);
      if (now - retryWindowStart > maxRetryAge) {
        log.debug(
          { botId: t.botId, createdAt: t.createdAt, retryWindowStartedAt: t.retryWindowStartedAt, lastRetryAt: t.lastRetryAt },
          'Skipping transcript save - exceeded max retry duration'
        );
        return false;
      }
    }
    
    return true;
  });
}

/**
 * Calculate and set the next retry time based on current attempt count.
 * Uses linear backoff aligned with polling interval.
 *
 * Liveness: wake owner is meetingBotService's 5-min poll (meetingBotService.ts:3246-3248,
 * started at boot index.ts:2688). `getTranscriptsNeedingSave` filters on `nextRetryAt`;
 * BACKOFF_INTERVALS_MS must stay ≥ poll cadence.
 */
export function setNextRetryTime(botId: string): void {
  const state = getPendingTranscriptsState();
  const index = state.transcripts.findIndex(t => t.botId === botId);
  if (index === -1) return;
  
  const transcript = state.transcripts[index];
  const attempts = transcript.saveAttempts ?? 0;
  const backoffMs = BACKOFF_INTERVALS_MS[Math.min(attempts, BACKOFF_INTERVALS_MS.length - 1)];
  const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
  
  state.transcripts[index] = { ...transcript, nextRetryAt };
  saveState(state);
  
  log.debug(
    { botId, attempts, backoffMs, nextRetryAt },
    'Set next retry time for transcript'
  );
}

/**
 * Update transcript quality and recording ID for a pending transcript.
 */
export function updateTranscriptQuality(
  botId: string,
  quality: TranscriptQuality,
  recordingId?: string
): void {
  const state = getPendingTranscriptsState();
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      return { ...t, transcriptQuality: quality, recordingId: recordingId ?? t.recordingId };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
  log.debug({ botId, quality, recordingId }, 'Updated transcript quality');
}

/**
 * Update coach selection for a pending transcript.
 * Called when user selects a coach during a meeting, persists for restart recovery.
 */
export function updatePendingTranscriptCoachSelection(
  botId: string,
  selection: { coachSkillPath: string; companionSessionId: string } | null
): void {
  const state = getPendingTranscriptsState();
  const index = state.transcripts.findIndex(t => t.botId === botId);
  
  if (index === -1) {
    log.debug({ botId }, 'Cannot update coach selection - transcript not found');
    return;
  }
  
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      if (selection === null) {
        // Clear the selection
        const { coachSkillPath: _coachSkillPath, companionSessionId: _companionSessionId, ...rest } = t;
        return rest;
      }
      return { ...t, coachSkillPath: selection.coachSkillPath, companionSessionId: selection.companionSessionId };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
  log.debug({ botId, selection }, 'Updated coach selection for restart recovery');
}

/**
 * Update presence mode for a pending transcript.
 * Called when user changes participation mode, persists for restart recovery.
 */
export function updatePendingTranscriptPresenceMode(
  botId: string,
  mode: 'silent' | 'coach' | 'participant'
): void {
  const state = getPendingTranscriptsState();
  const index = state.transcripts.findIndex(t => t.botId === botId);

  if (index === -1) {
    log.debug({ botId }, 'Cannot update presence mode - transcript not found');
    return;
  }

  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      return { ...t, presenceMode: mode };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
  log.debug({ botId, mode }, 'Updated presence mode for restart recovery');
}

/**
 * Persist serialized conversation state for a pending transcript.
 * Called when a meeting ends so state can survive app restart until transcript save.
 */
export function updatePendingTranscriptConversationState(
  botId: string,
  conversationState: string | null
): void {
  const state = getPendingTranscriptsState();
  const index = state.transcripts.findIndex(t => t.botId === botId);

  if (index === -1) {
    log.debug({ botId }, 'Cannot update conversation state - transcript not found');
    return;
  }

  const updated = state.transcripts.map(t => {
    if (t.botId !== botId) {
      return t;
    }

    if (conversationState == null) {
      return { ...t, conversationState: undefined };
    }

    return { ...t, conversationState };
  });

  saveState({ ...state, transcripts: updated });
  log.debug({ botId, hasConversationState: conversationState != null }, 'Updated conversation state for restart recovery');
}

/**
 * Update relay bot ID for a pending transcript.
 * Called immediately after bot creation to persist relay info for restart recovery.
 */
export function updateRelayBotId(botId: string, relayBotId: string): void {
  const state = getPendingTranscriptsState();
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      return { ...t, relayBotId };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
  log.debug({ botId, relayBotId }, 'Updated relay bot ID for restart recovery');
}

/**
 * Update recording start time for a pending transcript.
 * Called when bot transitions to recording state, persists for duration display after restart.
 */
export function updateRecordingStartTime(botId: string, recordingStartTimeMs: number): void {
  const state = getPendingTranscriptsState();
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      return { ...t, recordingStartTimeMs };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
  log.debug({ botId, recordingStartTimeMs }, 'Updated recording start time for restart recovery');
}

/**
 * Update live transcript path for a pending transcript.
 * Called when the first caption is written to disk during a meeting.
 * This path is used for:
 * - Agent access to live transcript during meeting
 * - Upgrade path when Recall transcript becomes available
 * - Restart recovery (continue appending to existing file)
 */
export function updateLiveTranscriptPath(botId: string, liveTranscriptPath: string): void {
  const state = getPendingTranscriptsState();
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      return { ...t, liveTranscriptPath };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
  log.info({ botId, liveTranscriptPath }, 'Updated live transcript path');
}

/**
 * Update async upgrade status for a pending transcript.
 * When transitioning to a polling state ('pending', 'processing', 'ready') for the first time,
 * also sets asyncUpgradeStartedAt for timeout tracking.
 */
export function updateAsyncUpgradeStatus(botId: string, status: AsyncUpgradeStatus): void {
  const state = getPendingTranscriptsState();
  const now = new Date().toISOString();
  
  const updated = state.transcripts.map(t => {
    if (t.botId === botId) {
      const isPollingState = status === 'pending' || status === 'processing' || status === 'ready';
      const wasNotPolling = !t.asyncUpgradeStartedAt;
      
      // Set asyncUpgradeStartedAt when first entering a polling state
      if (isPollingState && wasNotPolling) {
        return { ...t, asyncUpgradeStatus: status, asyncUpgradeStartedAt: now };
      }
      
      return { ...t, asyncUpgradeStatus: status };
    }
    return t;
  });

  saveState({ ...state, transcripts: updated });
  log.debug({ botId, status }, 'Updated async upgrade status');
}

/**
 * Get all transcripts that need async upgrade polling.
 * Returns transcripts where:
 * - savedPath exists (initial captions transcript was saved)
 * - transcriptQuality is 'captions'
 * - asyncUpgradeStatus is 'pending', 'processing', or 'ready'
 * - Has not timed out (asyncUpgradeStartedAt within timeout window)
 */
export function getTranscriptsNeedingAsyncUpgrade(): PendingTranscript[] {
  const state = getPendingTranscriptsState();
  const now = Date.now();

  return state.transcripts.filter(t => {
    // Must have been saved with captions quality
    if (!t.savedPath || t.transcriptQuality !== 'captions') return false;
    
    // Must be in a polling state
    const status = t.asyncUpgradeStatus;
    if (status !== 'pending' && status !== 'processing' && status !== 'ready') return false;
    
    // Check timeout based on asyncUpgradeStartedAt
    if (t.asyncUpgradeStartedAt) {
      const startedAt = new Date(t.asyncUpgradeStartedAt).getTime();
      // Handle invalid dates gracefully (treat as not timed out)
      if (!isNaN(startedAt) && now - startedAt > ASYNC_UPGRADE_TIMEOUT_MS) {
        return false; // Will be handled by getTimedOutAsyncUpgrades()
      }
    }
    
    return true;
  });
}

/**
 * Get all transcripts that have timed out waiting for async upgrade.
 * Returns transcripts where:
 * - savedPath exists (initial captions transcript was saved)
 * - transcriptQuality is 'captions'
 * - asyncUpgradeStatus is 'pending', 'processing', or 'ready'
 * - asyncUpgradeStartedAt has exceeded the timeout threshold
 */
export function getTimedOutAsyncUpgrades(): PendingTranscript[] {
  const state = getPendingTranscriptsState();
  const now = Date.now();

  return state.transcripts.filter(t => {
    // Must have been saved with captions quality
    if (!t.savedPath || t.transcriptQuality !== 'captions') return false;
    
    // Must be in a polling state (not already complete, failed, or timed_out)
    const status = t.asyncUpgradeStatus;
    if (status !== 'pending' && status !== 'processing' && status !== 'ready') return false;
    
    // Must have asyncUpgradeStartedAt set and exceeded timeout
    if (!t.asyncUpgradeStartedAt) return false;
    
    const startedAt = new Date(t.asyncUpgradeStartedAt).getTime();
    // Handle invalid dates gracefully (don't mark as timed out)
    if (isNaN(startedAt)) return false;
    
    return now - startedAt > ASYNC_UPGRADE_TIMEOUT_MS;
  });
}

/**
 * Mark a transcript as having analysis triggered.
 */
export function markAnalysisTriggered(botId: string): void {
  const state = getPendingTranscriptsState();
  const transcripts = state.transcripts.map((t) =>
    t.botId === botId ? { ...t, analysisTriggered: new Date().toISOString() } : t
  );
  saveState({ ...state, transcripts });
}

/**
 * Mark a transcript's analysis as completed.
 */
export function markAnalysisCompleted(botId: string): void {
  const state = getPendingTranscriptsState();
  const transcripts = state.transcripts.map((t) =>
    t.botId === botId ? { ...t, analysisCompleted: true } : t
  );
  saveState({ ...state, transcripts });
}

/**
 * Schedule analysis for a transcript (10 min delay for async upgrade to complete).
 */
export function scheduleAnalysis(botId: string, delayMs: number = 10 * 60 * 1000): void {
  const state = getPendingTranscriptsState();
  const scheduledAt = new Date(Date.now() + delayMs).toISOString();
  const transcripts = state.transcripts.map((t) =>
    t.botId === botId ? { ...t, scheduledAnalysisAt: scheduledAt } : t
  );
  saveState({ ...state, transcripts });
  log.debug({ botId, scheduledAt }, 'Scheduled analysis');
}

/** Analysis is considered stale if triggered more than 5 minutes ago */
const ANALYSIS_STALE_MINUTES = 5;

/**
 * Get all transcripts that have been saved but need analysis.
 * Returns transcripts where:
 * - savedPath exists (transcript was saved)
 * - analysisCompleted is NOT true
 * - scheduledAnalysisAt has passed (if set) OR no scheduledAnalysisAt
 * - Either: never triggered, OR triggered but stale (>5 min, likely crashed)
 */
export function getTranscriptsNeedingAnalysis(): PendingTranscript[] {
  const state = getPendingTranscriptsState();
  const staleThreshold = Date.now() - ANALYSIS_STALE_MINUTES * 60 * 1000;
  const now = Date.now();

  return state.transcripts.filter((t) => {
    // Must have been saved
    if (!t.savedPath) return false;

    // If already completed, skip
    if (t.analysisCompleted) return false;

    // If scheduled for later, skip until that time
    if (t.scheduledAnalysisAt) {
      const scheduledTime = new Date(t.scheduledAnalysisAt).getTime();
      if (scheduledTime > now) return false;
    }

    // If never triggered, needs analysis
    if (!t.analysisTriggered) return true;

    // If triggered but stale (app might have crashed), re-trigger
    const triggeredAt = new Date(t.analysisTriggered).getTime();
    return triggeredAt < staleThreshold;
  });
}
