/**
 * Daily Time Saved Reporting Service
 *
 * Reports aggregated time-saved estimates from the local store to analytics
 * for org-level analysis. Mirrors the Daily Cost Summary pattern.
 *
 * Design:
 * - Reads from timeSavedStore entries (source of truth)
 * - Groups entries by UTC date (despite store using local dates for UI)
 * - Sends one "Daily Time Saved Summary" event per unreported day
 * - Only reports completed days (yesterday UTC and earlier)
 * - Uses idempotency key for deduplication
 * - Fire-and-forget pattern (non-blocking)
 *
 * @see docs/project/TIME_SAVED.md
 * @see docs/project/ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { getTracker } from '@core/tracking';
import { getSettings } from '@core/services/settingsStore';
import { getTimeSavedState, getWeightedMidpoint, getRawMidpoint, type TimeSavedEntry } from './timeSavedStore';
import type { TimeSavedTaskType } from '@shared/types';

const log = createScopedLogger({ service: 'dailyTimeSavedReporting' });

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Maximum number of days to backfill on first run (to avoid overwhelming analytics) */
const MAX_BACKFILL_DAYS = 90;

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

type DailyTimeSavedReportingState = {
  /** Last reported UTC date string (e.g., '2026-01-30'), or null if never reported */
  lastReportedDateUTC: string | null;
};

let _store: KeyValueStore<DailyTimeSavedReportingState> | null = null;
const getStore = () => _store ??= createStore<DailyTimeSavedReportingState>({
  name: 'daily-time-saved-reporting-state',
  defaults: {
    lastReportedDateUTC: null,
  },
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Get yesterday's UTC date string (the most recent complete day).
 */
const getYesterdayUTC = (): string => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return yesterday.toISOString().split('T')[0];
};

/**
 * Get the UTC date string N days ago from today.
 */
const getDateDaysAgo = (daysAgo: number): string => {
  const now = new Date();
  const target = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return target.toISOString().split('T')[0];
};

/**
 * Convert a timestamp to UTC date string (YYYY-MM-DD).
 */
const timestampToUTCDate = (timestamp: number): string => {
  return new Date(timestamp).toISOString().split('T')[0];
};

const normalizeText = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const slugifyAccountName = (value: string): string => (
  value
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
);

const getAccountAttributionProperties = (): Record<string, string> => {
  try {
    const settings = getSettings();
    const userEmail = normalizeText(settings.userEmail)?.toLowerCase() ?? null;
    const companyName = normalizeText(settings.companyName);
    const companySlug = companyName ? slugifyAccountName(companyName) : null;

    return {
      ...(userEmail ? { email: userEmail, user_email: userEmail } : {}),
      ...(companyName
        ? {
            company_name: companyName,
            account_name: companyName,
          }
        : {}),
      ...(companySlug
        ? {
            company_slug: companySlug,
            account_slug: companySlug,
          }
        : {}),
    };
  } catch (err) {
    log.debug({ err }, 'Settings unavailable while building time-saved account attribution');
    return {};
  }
};

/**
 * Get all UTC dates between two dates (inclusive).
 */
const getDateRange = (startDate: string, endDate: string): string[] => {
  const dates: string[] = [];
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);

  const current = new Date(start);
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
};

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface DailyTimeSavedSummary {
  totalMinutes: number; // Weighted (impact-adjusted)
  rawMinutes: number; // Unweighted (for backward compatibility)
  lowMinutes: number;
  highMinutes: number;
  entryCount: number;
  sessionCount: number;
  byTaskType: Record<TimeSavedTaskType, number>;
  byConfidence: { low: number; medium: number; high: number };
  byImpact: { trivial: number; low: number; medium: number; high: number; critical: number; unknown: number };
  // Calibration signals
  impactWeightingRatio: number; // totalMinutes / rawMinutes (how much weighting shifted the total)
  lowConfidenceShare: number; // Fraction of raw minutes from low-confidence estimates (0-1)
  highImpactSessionCount: number; // Sessions with at least one critical/high impact entry
}

// -----------------------------------------------------------------------------
// Aggregation
// -----------------------------------------------------------------------------

/**
 * Aggregate time-saved entries for a specific UTC date.
 */
const aggregateEntriesForDate = (
  entries: TimeSavedEntry[],
  targetDate: string
): DailyTimeSavedSummary | null => {
  const dateEntries = entries.filter(
    (entry) => timestampToUTCDate(entry.timestamp) === targetDate
  );

  if (dateEntries.length === 0) {
    return null;
  }

  const sessions = new Set<string>();
  const highImpactSessions = new Set<string>();
  let totalMinutes = 0;
  let rawMinutes = 0;
  let lowMinutes = 0;
  let highMinutes = 0;
  let lowConfidenceRawMinutes = 0;

  const byTaskType: Record<TimeSavedTaskType, number> = {
    research: 0,
    writing: 0,
    coordination: 0,
    analysis: 0,
    automation: 0,
    mixed: 0,
  };

  const byConfidence = { low: 0, medium: 0, high: 0 };
  const byImpact = { trivial: 0, low: 0, medium: 0, high: 0, critical: 0, unknown: 0 };

  for (const entry of dateEntries) {
    const { estimate, sessionId } = entry;
    const weightedMidpoint = getWeightedMidpoint(estimate);
    const rawMidpoint = getRawMidpoint(estimate);
    const impact = estimate.impact ?? 'unknown';

    sessions.add(sessionId);
    if (impact === 'critical' || impact === 'high') {
      highImpactSessions.add(sessionId);
    }
    totalMinutes += weightedMidpoint;
    rawMinutes += rawMidpoint;
    lowMinutes += estimate.lowMinutes;
    highMinutes += estimate.highMinutes;
    if (estimate.confidence === 'low') {
      lowConfidenceRawMinutes += rawMidpoint;
    }
    byTaskType[estimate.taskType] += weightedMidpoint;
    byConfidence[estimate.confidence] += weightedMidpoint;
    byImpact[impact] += rawMidpoint; // Track raw minutes by impact level
  }

  return {
    totalMinutes,
    rawMinutes,
    lowMinutes,
    highMinutes,
    entryCount: dateEntries.length,
    sessionCount: sessions.size,
    byTaskType,
    byConfidence,
    byImpact,
    impactWeightingRatio: rawMinutes > 0 ? Math.round((totalMinutes / rawMinutes) * 100) / 100 : 1.0,
    lowConfidenceShare: rawMinutes > 0 ? Math.round((lowConfidenceRawMinutes / rawMinutes) * 100) / 100 : 0,
    highImpactSessionCount: highImpactSessions.size,
  };
};

// -----------------------------------------------------------------------------
// Main Function
// -----------------------------------------------------------------------------

/**
 * Report any unreported daily time-saved summaries to analytics.
 *
 * This function:
 * 1. Determines which days need to be reported (since last report, up to yesterday UTC)
 * 2. Limits backfill to MAX_BACKFILL_DAYS on first run
 * 3. For each unreported day, reads entries and sends a summary event
 * 4. Updates the watermark after each successful send
 *
 * Fire-and-forget: errors are logged but don't throw.
 */
export const reportUnreportedTimeSaved = async (): Promise<void> => {
  // Skip if analytics client is unavailable (disabled or no credentials).
  // Note: we use analyticsClientAvailable() instead of analyticsEnabled() because
  // this service runs at startup before the RudderStack probe completes. The client
  // can queue events during 'pending' state — they'll be delivered after the flush.
  if (!getTracker().isAvailable()) {
    log.debug('Analytics client not available, skipping daily time-saved reporting');
    return;
  }

  const lastReported = getStore().get('lastReportedDateUTC');
  const yesterdayUTC = getYesterdayUTC();

  // Get all entries from the store (capped at 1000)
  const state = getTimeSavedState();
  const entries = state.entries;

  if (entries.length === 0) {
    log.debug('No time-saved entries, skipping reporting');
    return;
  }

  // Find the earliest entry date to avoid backfilling beyond available data
  const earliestEntryDate = entries.reduce((earliest, entry) => {
    const entryDate = timestampToUTCDate(entry.timestamp);
    return entryDate < earliest ? entryDate : earliest;
  }, timestampToUTCDate(entries[0].timestamp));

  // Determine the start date for reporting
  let startDate: string;
  if (lastReported) {
    // Start from the day after last reported
    const lastReportedDate = new Date(`${lastReported}T00:00:00.000Z`);
    lastReportedDate.setUTCDate(lastReportedDate.getUTCDate() + 1);
    startDate = lastReportedDate.toISOString().split('T')[0];
  } else {
    // First run: limit backfill to MAX_BACKFILL_DAYS, but not before earliest entry
    const maxBackfillDate = getDateDaysAgo(MAX_BACKFILL_DAYS);
    startDate = maxBackfillDate > earliestEntryDate ? maxBackfillDate : earliestEntryDate;
    log.info({ startDate, earliestEntryDate, maxDays: MAX_BACKFILL_DAYS }, 'First run, limiting backfill');
  }

  // Check if there's anything to report
  if (startDate > yesterdayUTC) {
    log.debug({ lastReported, yesterday: yesterdayUTC }, 'No unreported days');
    return;
  }

  // Get the list of days to report
  const daysToReport = getDateRange(startDate, yesterdayUTC);
  log.info({ count: daysToReport.length, from: startDate, to: yesterdayUTC }, 'Reporting unreported days');

  const anonymousId = getTracker().getAnonymousId();
  let reportedCount = 0;

  for (const dateStr of daysToReport) {
    try {
      // Get time-saved summary for this specific day
      const summary = aggregateEntriesForDate(entries, dateStr);

      // Skip days with no entries (don't send empty events)
      if (!summary) {
        log.debug({ date: dateStr }, 'Skipping day with no time-saved entries');
        // Still update watermark so we don't re-check this day
        getStore().set('lastReportedDateUTC', dateStr);
        continue;
      }

      // Send the event (no `reasoning` field - reviewer flagged it as potentially sensitive)
      getTracker().track('Daily Time Saved Summary', {
        ...getAccountAttributionProperties(),
        date: dateStr,
        totalMinutes: summary.totalMinutes, // Weighted (impact-adjusted)
        rawMinutes: summary.rawMinutes, // Unweighted (for backward compatibility)
        lowMinutes: summary.lowMinutes,
        highMinutes: summary.highMinutes,
        entryCount: summary.entryCount,
        sessionCount: summary.sessionCount,
        byTaskType: summary.byTaskType,
        byConfidence: summary.byConfidence,
        byImpact: summary.byImpact, // Raw minutes by impact level
        impactWeightingRatio: summary.impactWeightingRatio, // totalMinutes / rawMinutes
        lowConfidenceShare: summary.lowConfidenceShare, // Fraction of raw minutes from low-confidence estimates
        highImpactSessionCount: summary.highImpactSessionCount, // Sessions with critical/high impact entries
        idempotencyKey: `time-saved-${anonymousId}-${dateStr}`,
      });

      // Update watermark immediately (enqueued = success)
      getStore().set('lastReportedDateUTC', dateStr);
      reportedCount++;

      log.debug(
        { date: dateStr, totalMinutes: summary.totalMinutes, entries: summary.entryCount },
        'Sent daily time-saved summary'
      );
    } catch (err) {
      // Log but don't throw - stop processing to avoid skipping this day
      // On next startup, we'll retry from this day
      log.warn({ err, date: dateStr }, 'Failed to report daily time-saved summary, will retry on next startup');
      break;
    }
  }

  if (reportedCount > 0) {
    log.info({ reportedCount, lastDate: yesterdayUTC }, 'Daily time-saved reporting complete');
  }
};

// -----------------------------------------------------------------------------
// Testing Helpers
// -----------------------------------------------------------------------------

/**
 * Reset the watermark (for testing only).
 */
export const _resetWatermarkForTesting = (): void => {
  getStore().delete('lastReportedDateUTC');
};

/**
 * Get the current watermark (for testing only).
 */
export const _getWatermarkForTesting = (): string | null => {
  return getStore().get('lastReportedDateUTC') ?? null;
};

/**
 * Set the watermark (for testing only).
 */
export const _setWatermarkForTesting = (date: string | null): void => {
  if (date) {
    getStore().set('lastReportedDateUTC', date);
  } else {
    getStore().delete('lastReportedDateUTC');
  }
};
