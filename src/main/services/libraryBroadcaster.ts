/**
 * Library Broadcaster
 *
 * Subscribes to workspaceWatcherService events and broadcasts debounced
 * `library:changed` notifications to the renderer for UI refresh.
 *
 * Debounce strategy:
 * - True trailing debounce: wait for WATCHER_DEBOUNCE_MS of silence before notifying
 * - MAX_WAIT_MS caps maximum delay during sustained activity (cloud sync, npm install)
 */

import path from 'node:path';
import { logger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import type {
  LibraryChangedEventPayload as SharedLibraryChangedEventPayload,
  LibraryChangedSource,
  LibraryChangedWriterKind,
} from '@shared/ipc/channels/library';
import { broadcastToAllWindows } from '../utils/broadcastHelpers';
import { workspaceWatcherService } from './workspaceWatcherService';

const WATCHER_DEBOUNCE_MS = 8_000;
const MAX_WAIT_MS = 30_000;
const MAX_WAIT_BACKOFF_CAP_MS = 5 * 60_000;
const IS_PERF_MODE = process.env.REBEL_PERF_MODE === '1';

type LibraryChangedEventPayload = Omit<SharedLibraryChangedEventPayload, 'timestamp' | 'source'>;

class LibraryBroadcaster {
  private debounceTimer: NodeJS.Timeout | null = null;
  private maxWaitTimer: NodeJS.Timeout | null = null;
  private pendingEventCount = 0;
  private pendingTreeEventCount = 0;
  private hasTreeChanges = false;
  private lastChangedPath: string | null = null;
  private lastWriterKind: LibraryChangedWriterKind = 'file-watcher';

  // Adaptive backoff: during sustained event storms (cloud-storage re-sync,
  // bulk file operations) the trailing debounce never reaches a quiet period
  // and we end up firing the MAX_WAIT_MS ceiling repeatedly. Each MAX_WAIT
  // flush triggers a renderer-side library tree walk; if the storm outlasts
  // the walk, the Library tab never settles. Doubling MAX_WAIT_MS on each
  // consecutive ceiling flush (capped at MAX_WAIT_BACKOFF_CAP_MS) reduces
  // emit frequency proportional to storm duration. Resets to MAX_WAIT_MS as
  // soon as a quiet WATCHER_DEBOUNCE_MS flush fires.
  private consecutiveMaxWaitFlushes = 0;
  private currentMaxWaitMs = MAX_WAIT_MS;

  // Diagnostic counters
  private totalEventsCount = 0;
  private eventStartTime: number | null = null;

  // Store listener refs for cleanup (CRITICAL: never use removeAllListeners on shared emitter)
  private listeners = {
    fileAdded: (filePath: string) => this.enqueueWatcherEvent({ affectsTree: true, writerKind: 'file-watcher', changedPath: filePath }),
    fileRemoved: (filePath: string) => this.enqueueWatcherEvent({ affectsTree: true, writerKind: 'file-watcher', changedPath: filePath }),
    dirAdded: (dirPath: string) => this.enqueueWatcherEvent({ affectsTree: true, writerKind: 'file-watcher', changedPath: dirPath }),
    dirRemoved: (dirPath: string) => this.enqueueWatcherEvent({ affectsTree: true, writerKind: 'file-watcher', changedPath: dirPath }),
    fileChanged: (filePath: string) => this.enqueueWatcherEvent({ affectsTree: false, writerKind: 'file-watcher', changedPath: filePath }),
  };

  /**
   * Start listening to workspace watcher events.
   * Idempotent - safe to call multiple times.
   */
  public start(): void {
    // Clean up any existing listeners first (idempotency)
    this.stop();

    // Reset diagnostic counters
    this.totalEventsCount = 0;
    this.eventStartTime = null;

    workspaceWatcherService.on('file:added', this.listeners.fileAdded);
    workspaceWatcherService.on('file:removed', this.listeners.fileRemoved);
    workspaceWatcherService.on('dir:added', this.listeners.dirAdded);
    workspaceWatcherService.on('dir:removed', this.listeners.dirRemoved);
    workspaceWatcherService.on('file:changed', this.listeners.fileChanged);

    logger.debug('Library broadcaster started');
  }

  /**
   * Stop listening and clean up timers.
   */
  public stop(): void {
    // Log event stats for diagnostics
    if (this.totalEventsCount > 0 && this.eventStartTime) {
      const durationSec = (Date.now() - this.eventStartTime) / 1000;
      const rate = durationSec > 0 ? this.totalEventsCount / durationSec : 0;
      logger.info(
        { totalEvents: this.totalEventsCount, durationSec: Math.round(durationSec), eventsPerSec: rate.toFixed(2) },
        'Library broadcaster session summary'
      );
    }

    // Clear timers
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }

    // Remove only OUR listeners, not other subscribers'
    workspaceWatcherService.off('file:added', this.listeners.fileAdded);
    workspaceWatcherService.off('file:removed', this.listeners.fileRemoved);
    workspaceWatcherService.off('dir:added', this.listeners.dirAdded);
    workspaceWatcherService.off('dir:removed', this.listeners.dirRemoved);
    workspaceWatcherService.off('file:changed', this.listeners.fileChanged);

    this.pendingEventCount = 0;
    this.pendingTreeEventCount = 0;
    this.hasTreeChanges = false;
    this.lastChangedPath = null;
    this.lastWriterKind = 'file-watcher';
    this.consecutiveMaxWaitFlushes = 0;
    this.currentMaxWaitMs = MAX_WAIT_MS;

    logger.debug('Library broadcaster stopped');
  }

  public broadcast(event: LibraryChangedEventPayload, source: LibraryChangedSource): void {
    if (source === 'user') {
      this.emitNow(event, source);
      return;
    }
    this.enqueueWatcherEvent(event);
  }

  private enqueueWatcherEvent(event: LibraryChangedEventPayload): void {
    this.pendingEventCount++;
    this.totalEventsCount++;
    this.lastChangedPath = event.changedPath ?? null;
    this.lastWriterKind = event.writerKind ?? 'file-watcher';

    // Track first event time for rate calculation
    if (!this.eventStartTime) {
      this.eventStartTime = Date.now();
    }

    if (event.affectsTree) {
      this.hasTreeChanges = true;
      this.pendingTreeEventCount++;

      // Log tree-affecting file paths in dev:perf mode for diagnosing watcher cascades
      if (IS_PERF_MODE) {
        logger.debug(
          { profilerChannel: 'library-watcher', filePath: event.changedPath, affectsTree: event.affectsTree },
          'Tree-affecting watcher event'
        );
      }
    }

    this.scheduleNotification();
  }

  private normalizeChangedPath(changedPathRaw: string | null | undefined): string | undefined {
    if (!changedPathRaw) {
      return undefined;
    }
    let changedPath = changedPathRaw;
    const coreDirectory = getSettings().coreDirectory;
    if (changedPath && coreDirectory && path.isAbsolute(changedPath)) {
      const relativePath = path.relative(coreDirectory, changedPath);
      if (relativePath && relativePath !== '.' && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..') {
        changedPath = relativePath;
      }
    }
    return changedPath;
  }

  private emitNow(event: LibraryChangedEventPayload, source: LibraryChangedSource): void {
    const changedPath = this.normalizeChangedPath(event.changedPath);
    logger.debug({ affectsTree: event.affectsTree, source, writerKind: event.writerKind ?? 'editor' }, 'Library changed, notifying renderer');
    broadcastToAllWindows('library:changed', {
      timestamp: Date.now(),
      affectsTree: event.affectsTree,
      writerKind: event.writerKind ?? 'editor',
      changedPath,
      source,
    });
  }

  private scheduleNotification(): void {
    // True trailing debounce: reset the quiet timer on every event
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Start max-wait timer on first event of a burst, using the current
    // (potentially backed-off) ceiling. Backoff state is updated in flush().
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        this.flush('max-wait');
      }, this.currentMaxWaitMs);
    }

    this.debounceTimer = setTimeout(() => {
      this.flush('debounce');
    }, WATCHER_DEBOUNCE_MS);
  }

  private flush(source: 'debounce' | 'max-wait' = 'debounce'): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }

    if (source === 'max-wait') {
      this.consecutiveMaxWaitFlushes++;
      const nextMaxWait = MAX_WAIT_MS * Math.pow(2, this.consecutiveMaxWaitFlushes);
      this.currentMaxWaitMs = Math.min(nextMaxWait, MAX_WAIT_BACKOFF_CAP_MS);
    } else {
      this.consecutiveMaxWaitFlushes = 0;
      this.currentMaxWaitMs = MAX_WAIT_MS;
    }

    const eventCount = this.pendingEventCount;
    const treeEventCount = this.pendingTreeEventCount;
    this.pendingEventCount = 0;
    this.pendingTreeEventCount = 0;

    if (eventCount === 0) return;

    const affectsTree = this.hasTreeChanges;
    this.hasTreeChanges = false;
    const changedPath = this.normalizeChangedPath(this.lastChangedPath);
    this.lastChangedPath = null;
    const writerKind = this.lastWriterKind;
    this.lastWriterKind = 'file-watcher';

    logger.debug(
      {
        eventCount,
        treeEventCount,
        affectsTree,
        source,
        nextMaxWaitMs: this.currentMaxWaitMs,
        consecutiveMaxWaitFlushes: this.consecutiveMaxWaitFlushes,
      },
      'Library changed, notifying renderer',
    );
    broadcastToAllWindows('library:changed', {
      timestamp: Date.now(),
      affectsTree,
      writerKind,
      changedPath,
      source: 'watcher',
    });
  }

  /**
   * Get event statistics for diagnostics bundle.
   */
  public getStats(): { totalEvents: number; durationSec: number; eventsPerSec: number } | null {
    if (!this.eventStartTime || this.totalEventsCount === 0) {
      return null;
    }
    const durationSec = (Date.now() - this.eventStartTime) / 1000;
    return {
      totalEvents: this.totalEventsCount,
      durationSec: Math.round(durationSec),
      eventsPerSec: durationSec > 0 ? Number((this.totalEventsCount / durationSec).toFixed(2)) : 0,
    };
  }
}

export const libraryBroadcaster = new LibraryBroadcaster();
