/**
 * Transcript Event Bus
 *
 * A simple pub/sub system for transcript-related events in the main process.
 * Used to trigger automations when meeting transcripts are saved.
 *
 * Follows the Set+unsubscribe pattern used elsewhere in the codebase
 * (see inboxStore.ts, userTasksStore.ts for similar patterns).
 */

import { createScopedLogger } from '@core/logger';
import type { TranscriptSourceSystem } from '@shared/types';
import type {
  TranscriptSavedEvent,
  TranscriptDistributionReadyEvent,
} from '@shared/types/transcript';

const log = createScopedLogger({ service: 'transcript-event-bus' });

// Re-exported for backward compatibility with existing consumers.
export type { TranscriptSourceSystem } from '@shared/types';
export type { TranscriptSavedEvent, TranscriptDistributionReadyEvent } from '@shared/types/transcript';

type TranscriptSavedListener = (event: TranscriptSavedEvent) => void;

const listeners = new Set<TranscriptSavedListener>();

/**
 * Subscribe to transcript saved events.
 * @param listener Callback invoked when a transcript is saved
 * @returns Unsubscribe function
 */
export function onTranscriptSaved(listener: TranscriptSavedListener): () => void {
  listeners.add(listener);
  log.debug({ listenerCount: listeners.size }, 'Transcript event listener added');
  return () => {
    listeners.delete(listener);
    log.debug({ listenerCount: listeners.size }, 'Transcript event listener removed');
  };
}

/**
 * Emit a transcript saved event to all listeners.
 * @param event The transcript saved event
 */
export function emitTranscriptSaved(event: TranscriptSavedEvent): void {
  log.info(
    {
      sourceSystem: event.sourceSystem,
      sourceUid: event.sourceUid,
      filePath: event.filePath,
      alreadyExists: event.alreadyExists,
      listenerCount: listeners.size,
    },
    'Emitting transcript saved event'
  );

  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      log.error({ error }, 'Transcript event listener threw an error');
    }
  }
}

// ---------------------------------------------------------------------------
// Deferred event support — for staged transcripts awaiting approval
// ---------------------------------------------------------------------------

import { canonicalizePath } from '../safety/cosPendingService';

/** In-memory map of deferred events, keyed by canonicalized destination path. */
const deferredEvents = new Map<string, TranscriptSavedEvent>();

/**
 * Store a deferred transcript event for later emission (when staged file is approved).
 * The event is keyed by the canonicalized destination path so it can be matched
 * at publish time regardless of casing/separator differences.
 */
export function deferTranscriptSaved(canonicalDestPath: string, event: TranscriptSavedEvent): void {
  const key = canonicalizePath(canonicalDestPath);
  deferredEvents.set(key, event);
  log.info(
    { key, sourceSystem: event.sourceSystem, sourceUid: event.sourceUid },
    'Deferred transcript saved event for staged file'
  );
}

/**
 * Emit a previously deferred transcript event (after publish). Returns true if
 * the event was found in memory and emitted, false otherwise.
 */
export function emitDeferredTranscriptSaved(canonicalDestPath: string, actualFilePath?: string): boolean {
  const key = canonicalizePath(canonicalDestPath);
  const event = deferredEvents.get(key);
  if (!event) return false;

  deferredEvents.delete(key);
  log.info(
    { key, sourceSystem: event.sourceSystem, sourceUid: event.sourceUid },
    'Emitting deferred transcript saved event after approval'
  );
  emitTranscriptSaved({
    ...event,
    filePath: actualFilePath ?? event.filePath,
    alreadyExists: false,
    timestamp: Date.now(),
  });
  return true;
}

/**
 * Remove a deferred event without emitting (e.g. when a staged file is discarded).
 */
export function removeDeferredTranscriptSaved(canonicalDestPath: string): boolean {
  const key = canonicalizePath(canonicalDestPath);
  const deleted = deferredEvents.delete(key);
  if (deleted) {
    log.debug({ key }, 'Removed deferred transcript event (file discarded or kept private)');
  }
  return deleted;
}

/**
 * Reconstruct and emit a transcript event from frontmatter metadata JSON.
 * Used as a fallback when the in-memory deferred event was lost (e.g. app restart
 * between staging and approval).
 */
export function emitTranscriptSavedFromMeta(filePath: string, metaJson: string): boolean {
  try {
    const meta = JSON.parse(metaJson) as
      Partial<TranscriptSavedEvent> & { sourceSystem?: TranscriptSourceSystem };
    if (!meta.sourceSystem || !meta.sourceUid) {
      log.warn({ filePath }, 'Transcript meta missing required fields, cannot reconstruct event');
      return false;
    }
    const event: TranscriptSavedEvent = {
      sourceSystem: meta.sourceSystem,
      sourceUid: meta.sourceUid,
      filePath,
      spacePath: meta.spacePath,
      meetingTitle: meta.meetingTitle ?? 'Meeting',
      startTime: meta.startTime ?? new Date().toISOString(),
      participants: meta.participants ?? [],
      duration: meta.duration ?? 0,
      alreadyExists: false,
      timestamp: Date.now(),
      meetingUrl: meta.meetingUrl,
      calendarEventId: meta.calendarEventId,
    };
    log.info(
      { filePath, sourceSystem: event.sourceSystem, sourceUid: event.sourceUid },
      'Emitting transcript saved event from frontmatter metadata'
    );
    emitTranscriptSaved(event);
    return true;
  } catch (error) {
    log.warn({ error, filePath }, 'Failed to parse transcript metadata JSON');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Distribution-ready event — fires when transcript is at final quality
// ---------------------------------------------------------------------------

type DistributionReadyListener = (event: TranscriptDistributionReadyEvent) => void;

const distributionListeners = new Set<DistributionReadyListener>();

/**
 * Subscribe to transcript distribution-ready events.
 * These fire when a transcript has reached its final quality and is ready
 * to be evaluated for distribution to other spaces.
 */
export function onTranscriptDistributionReady(listener: DistributionReadyListener): () => void {
  distributionListeners.add(listener);
  log.debug({ listenerCount: distributionListeners.size }, 'Distribution-ready listener added');
  return () => {
    distributionListeners.delete(listener);
    log.debug({ listenerCount: distributionListeners.size }, 'Distribution-ready listener removed');
  };
}

/**
 * Emit a transcript distribution-ready event.
 * For Recall: fires after async upgrade completes (or times out).
 * For all other sources: fires immediately after save (already final quality).
 */
export function emitTranscriptDistributionReady(event: TranscriptDistributionReadyEvent): void {
  log.info(
    {
      sourceSystem: event.sourceSystem,
      sourceUid: event.sourceUid,
      filePath: event.filePath,
      listenerCount: distributionListeners.size,
    },
    'Emitting transcript distribution-ready event'
  );

  for (const listener of distributionListeners) {
    try {
      listener(event);
    } catch (error) {
      log.error({ error }, 'Distribution-ready listener threw an error');
    }
  }
}
