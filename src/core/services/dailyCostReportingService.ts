/**
 * Daily Cost Reporting Service
 *
 * Reports aggregated costs from the local cost ledger to analytics
 * for org-level cost analysis.
 *
 * Design:
 * - Reads from cost-ledger.jsonl (source of truth)
 * - Groups entries by UTC date
 * - Sends one "Daily Cost Summary" event per unreported day
 * - Only reports completed days (yesterday and earlier)
 * - Uses idempotency key for deduplication
 * - Fire-and-forget pattern (non-blocking)
 *
 * @see docs/plans/finished/260131_daily_cost_summary_analytics.md
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { getTracker } from '@core/tracking';
import { getSettings } from '@core/services/settingsStore';
import { getCategorizedCostSummary } from './costLedgerService';
import { groupCategories, calculateSubscriptionSavings } from './usageCostAnalysis';

const log = createScopedLogger({ service: 'dailyCostReporting' });

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Maximum number of days to backfill on first run (to avoid overwhelming analytics) */
const MAX_BACKFILL_DAYS = 90;

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

type DailyCostReportingState = {
  /** Last reported UTC date string (e.g., '2026-01-30'), or null if never reported */
  lastReportedDateUTC: string | null;
};

let _store: KeyValueStore<DailyCostReportingState> | null = null;
const getStore = () => _store ??= createStore<DailyCostReportingState>({
  name: 'daily-cost-reporting-state',
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
 * Get the start of a UTC day as a timestamp.
 */
const getStartOfDayUTC = (dateStr: string): number => {
  return new Date(`${dateStr}T00:00:00.000Z`).getTime();
};

/**
 * Get the end of a UTC day as a timestamp.
 */
const getEndOfDayUTC = (dateStr: string): number => {
  return new Date(`${dateStr}T23:59:59.999Z`).getTime();
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
    log.debug({ err }, 'Settings unavailable while building daily cost account attribution');
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

const buildDailySummaryAnalyticsProperties = (
  dateStr: string,
  byModel: Record<string, number>
): Record<string, string> => {
  try {
    return {
      byModel: JSON.stringify(byModel),
    };
  } catch (err) {
    log.warn({ err, date: dateStr }, 'Failed to serialize by-model daily cost summary');
    return {};
  }
};

// -----------------------------------------------------------------------------
// Main Function
// -----------------------------------------------------------------------------

/**
 * Report any unreported daily cost summaries to analytics.
 *
 * This function:
 * 1. Determines which days need to be reported (since last report, up to yesterday)
 * 2. Limits backfill to MAX_BACKFILL_DAYS on first run
 * 3. For each unreported day, reads the ledger and sends a summary event
 * 4. Updates the watermark after each successful send
 *
 * Fire-and-forget: errors are logged but don't throw.
 */
export const reportUnreportedCosts = async (): Promise<void> => {
  // Skip if analytics client is unavailable (disabled or no credentials).
  // Note: we use analyticsClientAvailable() instead of analyticsEnabled() because
  // this service runs at startup before the RudderStack probe completes. The client
  // can queue events during 'pending' state — they'll be delivered after the flush.
  if (!getTracker().isAvailable()) {
    log.debug('Analytics client not available, skipping daily cost reporting');
    return;
  }

  const lastReported = getStore().get('lastReportedDateUTC');
  const yesterdayUTC = getYesterdayUTC();

  // Determine the start date for reporting
  let startDate: string;
  if (lastReported) {
    // Start from the day after last reported
    const lastReportedDate = new Date(`${lastReported}T00:00:00.000Z`);
    lastReportedDate.setUTCDate(lastReportedDate.getUTCDate() + 1);
    startDate = lastReportedDate.toISOString().split('T')[0];
  } else {
    // First run: limit backfill to MAX_BACKFILL_DAYS
    startDate = getDateDaysAgo(MAX_BACKFILL_DAYS);
    log.info({ startDate, maxDays: MAX_BACKFILL_DAYS }, 'First run, limiting backfill');
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
      // Get cost summary for this specific day
      const summary = await getCategorizedCostSummary({
        startTs: getStartOfDayUTC(dateStr),
        endTs: getEndOfDayUTC(dateStr),
      });

      // Skip days with no costs (don't send empty events)
      if (summary.entryCount === 0) {
        log.debug({ date: dateStr }, 'Skipping day with no costs');
        // Still update watermark so we don't re-check this day
        getStore().set('lastReportedDateUTC', dateStr);
        continue;
      }

      // Grouped UX categories (matches local Usage tab grouping)
      const byCategoryGrouped = groupCategories(summary.byCategory);

      // Three-way cost partition by auth method
      const savings = calculateSubscriptionSavings(summary.byAuthMethod);

      // Send the event
      getTracker().track('Daily Cost Summary', {
        ...getAccountAttributionProperties(),
        date: dateStr,
        totalCostUsd: summary.total,
        turnCount: summary.turnCount,
        entryCount: summary.entryCount,
        byCategory: summary.byCategory,
        byAutomationType: summary.byAutomationType,
        byAuthMethod: summary.byAuthMethod,
        ...(Object.keys(summary.byOpenRouterProvider).length > 0
          ? { byOpenRouterProvider: summary.byOpenRouterProvider }
          : {}),
        ...buildDailySummaryAnalyticsProperties(dateStr, summary.byModel),

        // Grouped UX categories
        byCategoryGrouped,

        // Daily token totals
        totalInputTokens: summary.totalInputTokens,
        totalOutputTokens: summary.totalOutputTokens,
        totalCacheReadTokens: summary.totalCacheReadTokens,
        totalCacheCreationTokens: summary.totalCacheCreationTokens,
        totalPromptTokens: summary.totalPromptTokens,

        // Subscription savings split (privacy-safe: only aggregate dollar amounts).
        // userPaidUsd is known out-of-pocket only; unattributable cost (the 'unknown'
        // bucket) is reported separately so it neither inflates userPaid nor is lost.
        subscriptionCoveredUsd: savings.subscriptionCoveredUsd,
        userPaidUsd: savings.actualCostUsd,
        freeUsd: savings.freeUsd,
        unclassifiedUsd: savings.unclassifiedUsd,

        // Usage density (count only, no session IDs)
        activeSessionCount: summary.activeSessionCount,

        idempotencyKey: `cost-${anonymousId}-${dateStr}`,
      });

      // Update watermark immediately (enqueued = success)
      getStore().set('lastReportedDateUTC', dateStr);
      reportedCount++;

      log.debug(
        { date: dateStr, cost: summary.total, entries: summary.entryCount },
        'Sent daily cost summary'
      );
    } catch (err) {
      // Log but don't throw - stop processing to avoid skipping this day
      // On next startup, we'll retry from this day
      log.warn({ err, date: dateStr }, 'Failed to report daily cost summary, will retry on next startup');
      break;
    }
  }

  if (reportedCount > 0) {
    log.info({ reportedCount, lastDate: yesterdayUTC }, 'Daily cost reporting complete');
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
