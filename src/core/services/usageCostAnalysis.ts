/**
 * Usage Cost Analysis — Pure Business Logic
 *
 * Category grouping, cost projection, and per-active-day averaging
 * extracted from the usage IPC handlers. These are pure functions
 * with a single import of const data from the cost category registry.
 *
 * @see src/main/ipc/usageHandlers.ts — handler registration that calls these
 * @see src/shared/costCategories.ts — single source of truth for category→group mapping
 * @see docs/plans/260330_strengthen_de_electronification.md — Stage 4
 */

import { COST_GROUP_KEYS, groupForCategory } from '@shared/costCategories';

// Re-export from @shared so existing core consumers continue to work
export {
  AUTH_METHOD_DISPLAY,
  calculateSubscriptionSavings,
  type SubscriptionSavings,
} from '@shared/utils/authMethodDisplay';

/**
 * Group raw ledger categories into meaningful user-facing buckets.
 * Combines duplicates and related categories for clarity.
 *
 * Uses the COST_CATEGORY_REGISTRY for group lookup; unknown categories
 * gracefully fall to 'housekeeping'.
 */
export function groupCategories(byCategory: Record<string, number>): Record<string, number> {
  const groups: Record<string, number> = Object.fromEntries(
    COST_GROUP_KEYS.map((key) => [key, 0])
  );

  for (const [cat, cost] of Object.entries(byCategory)) {
    const group = groupForCategory(cat);
    groups[group] += cost;
  }

  return groups;
}

/**
 * Calculate projected monthly cost using min(daysSinceFirstUsage, periodDays) as denominator.
 * - New user (2 days since first use, 7-day view) → effectiveDays = 2
 * - Established user (30+ days, 7-day view) → effectiveDays = 7 (includes weekends/zeros)
 */
export function calculateProjection(
  currentPeriodCost: number,
  oldestEntryTimestamp: number | null,
  periodDays: number
): { projectedMonthCost: number; effectiveDays: number; daysSinceFirstUsage: number } | null {
  if (!oldestEntryTimestamp || currentPeriodCost <= 0) return null;

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const daysSinceFirstUsage = Math.max(
    1,
    Math.ceil((Date.now() - oldestEntryTimestamp) / MS_PER_DAY)
  );
  const effectiveDays = Math.min(daysSinceFirstUsage, periodDays);
  const projectedMonthCost = (currentPeriodCost / effectiveDays) * 30;

  return { projectedMonthCost, effectiveDays, daysSinceFirstUsage };
}

/**
 * Calculate average cost per active day (days with spend > 0).
 */
export function calculateAvgPerActiveDay(
  dailyCosts: Array<{ date: string; cost: number }>
): { avgCostPerActiveDay: number | null; activeDayCount: number } {
  const activeDays = dailyCosts.filter((d) => d.cost > 0);
  const activeDayCount = activeDays.length;
  const avgCostPerActiveDay =
    activeDayCount > 0
      ? activeDays.reduce((sum, d) => sum + d.cost, 0) / activeDayCount
      : null;

  return { avgCostPerActiveDay, activeDayCount };
}
