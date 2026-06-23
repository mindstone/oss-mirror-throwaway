/**
 * Calendar Sync Scheduler
 *
 * Simple background timer that runs direct calendar sync every 15 minutes.
 * This replaces the LLM-based automation for Google/Microsoft calendars.
 *
 * Features:
 * - In-flight lock to prevent concurrent syncs
 * - Graceful start/stop for settings toggle
 * - Direct API calls (no MCP or LLM)
 */

import { createScopedLogger } from '@core/logger';
import { performDirectCalendarSync } from './directCalendarSync';
import { createBatteryThrottledInterval } from './visibilityAwareScheduler';
import { autoScheduleMeetingBots } from './meetingBot/autoScheduleService';
import { invalidateExpiredMeetingPrep } from './heroChoiceScheduler';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'calendarSyncScheduler' });

const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const BATTERY_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes on battery

let cleanupInterval: (() => void) | null = null;
let isSyncing = false;
let isStarted = false;

/**
 * Run a single sync cycle with lock protection.
 */
async function runDirectSync(): Promise<void> {
  // Skip if already syncing (in-flight lock)
  if (isSyncing) {
    log.debug('Skipping sync - already in progress');
    return;
  }

  isSyncing = true;
  try {
    log.debug('Running direct calendar sync');
    const result = await performDirectCalendarSync();

    log.info({
      meetingCount: result.meetings.length,
      googleAccounts: result.googleAccounts,
      microsoftAccounts: result.microsoftAccounts,
      // Counts only: result.errors strings can embed account slugs (PII) and
      // scoped-logger lines forward to Sentry as breadcrumbs.
      errors: result.errors.length,
      reauthSkippedAccounts: result.reauthRequiredAccounts
    }, 'Direct calendar sync completed');

    // Dismiss hero card meeting_prep candidates whose meeting has started
    try {
      invalidateExpiredMeetingPrep();
    } catch (err) {
      log.warn({ err }, 'Failed to invalidate expired meeting prep candidates');
    }

    // Auto-schedule meeting bots for upcoming meetings (best-effort)
    try {
      const scheduleResult = await autoScheduleMeetingBots();
      if (scheduleResult.scheduled > 0) {
        log.info(
          { scheduled: scheduleResult.scheduled, skipped: scheduleResult.skipped },
          'Auto-scheduled meeting bots after direct calendar sync'
        );
      }
    } catch (scheduleError) {
      log.warn({ err: scheduleError }, 'Auto-schedule after direct calendar sync failed');
    }
  } catch (error) {
    log.error({ err: error }, 'Direct calendar sync failed');
  } finally {
    isSyncing = false;
  }
}

/**
 * Start the background calendar sync timer.
 * Runs immediately and then every 15 minutes.
 */
export async function startDirectCalendarSync(): Promise<void> {
  if (isStarted) {
    log.warn('Direct calendar sync already started');
    return;
  }

  isStarted = true;
  log.info('Starting direct calendar sync scheduler');

  // Run immediately on startup
  fireAndForget(runDirectSync(), 'calendarSyncScheduler.line90');

  // Then every 15 minutes (30 min on battery)
  cleanupInterval = createBatteryThrottledInterval(runDirectSync, SYNC_INTERVAL_MS, BATTERY_SYNC_INTERVAL_MS);
  log.info({ intervalMs: SYNC_INTERVAL_MS, batteryIntervalMs: BATTERY_SYNC_INTERVAL_MS }, 'Direct calendar sync timer started');
}

/**
 * Stop the background calendar sync timer.
 * Waits for any in-flight sync to complete.
 */
export async function stopDirectCalendarSync(): Promise<void> {
  if (!isStarted) {
    return;
  }

  log.info('Stopping direct calendar sync scheduler');

  if (cleanupInterval) {
    cleanupInterval();
    cleanupInterval = null;
  }

  // Wait for any in-flight sync to complete (max 30 seconds)
  const maxWait = 30000;
  const start = Date.now();
  while (isSyncing && Date.now() - start < maxWait) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (isSyncing) {
    log.warn('Stopping while sync still in progress');
  }

  isStarted = false;
  log.info('Direct calendar sync scheduler stopped');
}

/**
 * Trigger an immediate sync (for manual refresh).
 * Respects the in-flight lock.
 */
export async function triggerDirectCalendarSync(): Promise<void> {
  log.info('Manual calendar sync triggered');
  await runDirectSync();
}

/**
 * Check if the scheduler is currently running.
 */
export function isDirectCalendarSyncRunning(): boolean {
  return isStarted;
}
