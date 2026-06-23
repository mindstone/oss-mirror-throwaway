/**
 * Log buffer for capturing recent log entries.
 *
 * This module is extracted from logger.ts to break the circular dependency
 * between logger.ts and sentry.ts:
 *   - logger.ts imports recordMainBreadcrumb from sentry.ts
 *   - sentry.ts imports getRecentLogs from this module
 *
 * By placing the buffer in its own module with no dependencies on logger or
 * sentry, both can safely import from here.
 *
 * PERF: Uses a pre-allocated circular buffer instead of array spread+filter+slice
 * to eliminate GC pressure on every log call. The previous pattern created 3
 * intermediate arrays per call; this implementation does O(1) writes with zero
 * allocations.
 */

export interface LogBufferEntry {
  timestamp: number;
  level: string;
  message: string;
  data?: Record<string, unknown>;
}

// Window of recent logs attached to every Sentry capture (main process).
// Was 10s / 200 entries — far too little context, which is why nearly every
// serious incident had to be diagnosed from the user's full .zip log bundle
// instead of the Sentry event (see docs/plans/260621_monitoring-capture-surface/PLAN.md).
// Enlarged to a ~5-minute / ≤1000-entry tail. This is safe from Sentry's
// `too_large` ingest drop because `formatLogsForAttachment` (src/main/sentry.ts)
// hard-caps the emitted attachment at MAX_LOG_ATTACHMENT_SIZE (100KB, tail).
// (The 60-minute window is a separate, disk-read path used only for the
// unclean-shutdown report — see crashRecoveryService.ts.)
const LOG_BUFFER_WINDOW_MS = 300_000; // 5 minutes
const MAX_BUFFER_ENTRIES = 1000;

// Pre-allocated circular buffer
const buffer: (LogBufferEntry | null)[] = new Array<LogBufferEntry | null>(MAX_BUFFER_ENTRIES).fill(null);
let head = 0;
let count = 0;

/**
 * Add a log entry to the circular buffer. O(1) with zero allocations.
 */
export const addToLogBuffer = (entry: LogBufferEntry): void => {
  buffer[head] = entry;
  head = (head + 1) % MAX_BUFFER_ENTRIES;
  if (count < MAX_BUFFER_ENTRIES) count++;
};

/**
 * Get recent log entries from the buffer.
 * @param windowMs - Time window in milliseconds (default: LOG_BUFFER_WINDOW_MS = 5 minutes)
 * @returns Array of log entries within the time window, oldest first
 */
export const getRecentLogs = (windowMs = LOG_BUFFER_WINDOW_MS): LogBufferEntry[] => {
  const cutoff = Date.now() - windowMs;
  const result: LogBufferEntry[] = [];
  for (let i = 0; i < count; i++) {
    const idx = (head - count + i + MAX_BUFFER_ENTRIES) % MAX_BUFFER_ENTRIES;
    const entry = buffer[idx];
    if (entry && entry.timestamp > cutoff) {
      result.push(entry);
    }
  }
  return result;
};

/**
 * Clear the log buffer. Useful for testing.
 */
export const clearLogBuffer = (): void => {
  buffer.fill(null);
  head = 0;
  count = 0;
};
