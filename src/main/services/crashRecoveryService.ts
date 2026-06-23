/**
 * Crash Recovery Service
 *
 * Detects unclean shutdowns from the previous session and reports them to Sentry
 * with recent logs attached. This gives developers visibility into crashes that
 * users may not report.
 *
 * Called early in startup, after Sentry and graceful shutdown are initialized.
 * Includes cooldown to prevent Sentry flood in crash loops.
 *
 * IMPORTANT: This service must never throw - all errors are caught and logged
 * to prevent the very crash loops we're trying to detect.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { wasCleanExit } from './gracefulShutdown';
import { exportRecentLogs } from './logExportService';
import { captureMainMessageWithLogs } from '../sentry';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'crashRecovery' });

// Cooldown to prevent Sentry flood in crash loops (1 hour)
const COOLDOWN_MS = 60 * 60 * 1000;

// Lazy-initialized store to avoid module-load-time throws
let cooldownStore: KeyValueStore<{ lastReported: number }> | null = null;
function getCooldownStore(): KeyValueStore<{ lastReported: number }> {
  if (!cooldownStore) {
    cooldownStore = createStore<{ lastReported: number }>({ name: 'crash-recovery-cooldown' });
  }
  return cooldownStore;
}

// Use large window to capture logs even if restart is delayed.
// exportRecentLogs will naturally only return logs that exist on disk.
const LOG_WINDOW_MINUTES = 60;

/**
 * Check if we're within the cooldown period from a previous crash report.
 */
function isInCooldown(): boolean {
  const lastReported = getCooldownStore().get('lastReported', 0);
  return Date.now() - lastReported < COOLDOWN_MS;
}

/**
 * Report unclean shutdown to Sentry with recent logs attached.
 * Call this early in startup, after Sentry is initialized.
 *
 * IMPORTANT: This function must never throw - it's fire-and-forget on startup.
 * All errors are caught and logged to prevent crash loops.
 */
export async function reportUncleanShutdownIfNeeded(): Promise<void> {
  try {
    // Skip if last exit was clean
    if (wasCleanExit()) {
      return;
    }

    // Skip if in cooldown (prevents flood in crash loops)
    if (isInCooldown()) {
      log.info('Skipping crash report - within cooldown period');
      return;
    }

    log.info('Detected unclean shutdown from previous session, reporting to Sentry');

    // Read recent logs from disk (large window, truncated to attachment limit)
    const logs = await exportRecentLogs({
      logWindowMinutes: LOG_WINDOW_MINUTES,
      maxLinesPerFile: 1000,
      filterLevel: 'all',
    });

    // Combine all log files into single NDJSON string
    const logsText = logs.files.map(f => f.content).join('\n');

    // Send to Sentry with attachment (truncation handled in sentry.ts)
    captureMainMessageWithLogs(
      'Unclean shutdown detected from previous session',
      logsText,
      {
        level: 'warning',
        tags: {
          area: 'startup',
          component: 'crash-recovery',
          crash_detection: 'automatic',
        },
        extra: {
          logTimeWindow: `${LOG_WINDOW_MINUTES} minutes`,
          logLines: logs.totalLines,
          logFiles: logs.files.map(f => f.filename),
        },
      }
    );

    // Update cooldown timestamp
    getCooldownStore().set('lastReported', Date.now());
    log.info({ logLines: logs.totalLines }, 'Crash report sent to Sentry');
  } catch (error) {
    // CRITICAL: Never throw from this function - it would cause crash loop
    log.warn({ err: error }, 'Failed to report unclean shutdown to Sentry');
  }
}
