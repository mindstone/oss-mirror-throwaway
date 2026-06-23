import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateAvgPerActiveDay, calculateProjection, groupCategories } from '@core/services/usageCostAnalysis';
import { COST_CATEGORY_REGISTRY, COST_GROUP_KEYS } from '@shared/costCategories';
import type { CategorizedCostSummary } from '@core/services/costLedgerService';
import { registerUsageHandlers } from '../usageHandlers';

const mockRegisterHandler = vi.fn();
const mockGetCostSummary = vi.fn();
const mockGetCategorizedCostSummary = vi.fn();
const mockGetUsageInsights = vi.fn();
const mockGetDailyBreakdown = vi.fn();
const mockGetCostWaterfallByOutcome = vi.fn();

 
vi.mock('../utils/registerHandler', () => ({
  registerHandler: (...args: unknown[]) => mockRegisterHandler(...args),
}));

 
vi.mock('../../services/costLedgerService', () => ({
  getCostSummary: (...args: unknown[]) => mockGetCostSummary(...args),
  getCategorizedCostSummary: (...args: unknown[]) => mockGetCategorizedCostSummary(...args),
  getUsageInsights: (...args: unknown[]) => mockGetUsageInsights(...args),
  getDailyBreakdown: (...args: unknown[]) => mockGetDailyBreakdown(...args),
}));

 
vi.mock('@core/services/diagnostics/costWaterfall', () => ({
  getCostWaterfallByOutcome: (...args: unknown[]) => mockGetCostWaterfallByOutcome(...args),
}));

/**
 * Tests for usage calculation logic - specifically the projection formula.
 * These are critical because incorrect formulas can mislead users about their spending.
 * 
 * The key insight tested here:
 * - Projection uses min(daysSinceFirstUsage, periodDays) as denominator
 * - This handles both new users (short history) and established users (full period)
 */

describe('usageHandlers calculation logic', () => {
  describe('projection formula: min(daysSinceFirstUsage, periodDays)', () => {
    // Use fake timers to avoid flaky date calculations
    beforeEach(() => {
      vi.useFakeTimers();
      // Set a fixed time: 2026-01-23 12:00:00 UTC
      vi.setSystemTime(new Date('2026-01-23T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * NEW USER SCENARIO:
     * User started 2 days ago, spent $10, viewing 7-day period
     * 
     * Expected: Use 2 days as denominator
     * - effectiveDays = min(2, 7) = 2
     * - projection = $10 / 2 * 30 = $150/mo
     */
    it('should use days since first usage for new users (short history)', () => {
      // 2 days ago from fixed time
      const twoDaysAgo = new Date('2026-01-21T12:00:00Z').getTime();
      const result = calculateProjection(10, twoDaysAgo, 7);

      expect(result).not.toBeNull();
      expect(result!.daysSinceFirstUsage).toBe(2);
      expect(result!.effectiveDays).toBe(2); // min(2, 7) = 2
      expect(result!.projectedMonthCost).toBeCloseTo(150, 0); // $10 / 2 * 30
    });

    /**
     * ESTABLISHED USER SCENARIO:
     * User started 45 days ago, spent $7 in last 7 days, viewing 7-day period
     * 
     * Expected: Use 7 days as denominator (full period)
     * - effectiveDays = min(45, 7) = 7
     * - projection = $7 / 7 * 30 = $30/mo
     * 
     * This correctly accounts for weekend/rest day patterns
     */
    it('should use period days for established users (long history)', () => {
      // 45 days ago from fixed time
      const fortyFiveDaysAgo = new Date('2025-12-09T12:00:00Z').getTime();
      const result = calculateProjection(7, fortyFiveDaysAgo, 7);

      expect(result).not.toBeNull();
      expect(result!.daysSinceFirstUsage).toBe(45);
      expect(result!.effectiveDays).toBe(7); // min(45, 7) = 7
      expect(result!.projectedMonthCost).toBeCloseTo(30, 0); // $7 / 7 * 30
    });

    /**
     * EDGE CASE: Brand new user (same day)
     * Should use 1 day minimum to avoid division by zero
     */
    it('should use minimum 1 day for brand new users', () => {
      // 1 hour ago (same day)
      const oneHourAgo = new Date('2026-01-23T11:00:00Z').getTime();
      const result = calculateProjection(5, oneHourAgo, 7);

      expect(result).not.toBeNull();
      expect(result!.daysSinceFirstUsage).toBe(1);
      expect(result!.effectiveDays).toBe(1);
      expect(result!.projectedMonthCost).toBeCloseTo(150, 0); // $5 / 1 * 30
    });

    /**
     * EDGE CASE: 30-day view for established user
     */
    it('should handle 30-day period correctly', () => {
      // 60 days ago
      const sixtyDaysAgo = new Date('2025-11-24T12:00:00Z').getTime();
      const result = calculateProjection(60, sixtyDaysAgo, 30);

      expect(result!.effectiveDays).toBe(30); // min(60, 30) = 30
      expect(result!.projectedMonthCost).toBeCloseTo(60, 0); // $60 / 30 * 30
    });

    /**
     * 24H VIEW SCENARIO:
     * Established user with long history, viewing the rolling 24h period.
     *
     * Expected: Use 1 day as denominator so the projection is cost × 30.
     * This is an explicit product choice for the new Last 24h filter.
     */
    it('should use a one-day denominator for the 24h view', () => {
      const thirtyDaysAgo = new Date('2025-12-24T12:00:00Z').getTime();
      const result = calculateProjection(4, thirtyDaysAgo, 1);

      expect(result).not.toBeNull();
      expect(result!.daysSinceFirstUsage).toBe(30);
      expect(result!.effectiveDays).toBe(1);
      expect(result!.projectedMonthCost).toBeCloseTo(120, 0); // $4 / 1 * 30
    });

    /**
     * EDGE CASE: No cost should return null
     */
    it('should return null when no cost in period', () => {
      const sevenDaysAgo = new Date('2026-01-16T12:00:00Z').getTime();
      const result = calculateProjection(0, sevenDaysAgo, 7);

      expect(result).toBeNull();
    });

    /**
     * EDGE CASE: Missing oldest entry timestamp should return null
     */
    it('should return null when oldest entry timestamp is missing', () => {
      const result = calculateProjection(10, null, 7);
      expect(result).toBeNull();
    });
  });

  describe('average cost per active day calculation', () => {
    /**
     * TYPICAL SCENARIO: 5 active days out of 7
     * $10 total spent over 5 days = $2/day average
     */
    it('should calculate average excluding zero-cost days', () => {
      const dailyCosts = [
        { date: '2026-01-17', cost: 2 },
        { date: '2026-01-18', cost: 2 },
        { date: '2026-01-20', cost: 2 },
        { date: '2026-01-21', cost: 2 },
        { date: '2026-01-22', cost: 2 },
        // Note: Jan 19 and 23 are missing (weekend) - $0 days not in array
      ];

      const result = calculateAvgPerActiveDay(dailyCosts);

      expect(result.activeDayCount).toBe(5);
      expect(result.avgCostPerActiveDay).toBeCloseTo(2, 2); // $10 / 5 = $2
    });

    /**
     * EDGE CASE: No active days
     */
    it('should return null when no active days', () => {
      const result = calculateAvgPerActiveDay([]);

      expect(result.activeDayCount).toBe(0);
      expect(result.avgCostPerActiveDay).toBeNull();
    });

    /**
     * EDGE CASE: Days with zero cost (if somehow included in array)
     */
    it('should filter out days with zero cost', () => {
      const dailyCosts = [
        { date: '2026-01-17', cost: 5 },
        { date: '2026-01-18', cost: 0 }, // Should be excluded
        { date: '2026-01-19', cost: 5 },
      ];

      const result = calculateAvgPerActiveDay(dailyCosts);

      expect(result.activeDayCount).toBe(2);
      expect(result.avgCostPerActiveDay).toBeCloseTo(5, 2); // $10 / 2 = $5
    });
  });

  describe('category grouping logic', () => {
    /**
     * Tests the actual exported groupCategories function from usageHandlers.ts.
     * This ensures regressions are caught if someone changes the grouping logic.
     */

    /**
     * Unknown categories should go to housekeeping
     */
    it('should put unknown categories in housekeeping', () => {
      const rawCategories = {
        agent: 5,
        unknownNewCategory: 3,
      };

      const grouped = groupCategories(rawCategories);

      expect(grouped.conversations).toBe(5);
      expect(grouped.housekeeping).toBe(3);
    });

    it('should map council category to conversations', () => {
      const grouped = groupCategories({ council: 2.5 });
      expect(grouped.conversations).toBe(2.5);
      expect(grouped.housekeeping).toBe(0);
    });

    it('should map adhoc-model category to conversations', () => {
      const grouped = groupCategories({ 'adhoc-model': 1.75 });
      expect(grouped.conversations).toBe(1.75);
      expect(grouped.housekeeping).toBe(0);
    });

    /**
     * All known categories should be properly grouped
     */
    it('should keep existing category mappings correct (regression guard)', () => {
      const rawCategories = {
        // Conversations
        agent: 10,
        conversation: 5,
        chat: 3,
        // Automations
        automation: 4,
        // File Intelligence
        enhancement: 2,
        fileIndex: 1,
        semantic: 1,
        // Safety
        safety: 2,
        memoryWrite: 1,
        // Memory & Notes
        memory: 1,
        coaching: 1,
        scratchpad: 1,
        spacesSynthesis: 1,
        // Housekeeping (via default)
        metadata: 0.5,
        quip: 0.1,
      };

      const grouped = groupCategories(rawCategories);

      expect(grouped.conversations).toBe(18); // 10+5+3
      expect(grouped.automations).toBe(4);
      expect(grouped.fileIntelligence).toBe(4); // 2+1+1
      expect(grouped.safetyChecks).toBe(3); // 2+1
      expect(grouped.memoryNotes).toBe(4); // 1+1+1+1
      expect(grouped.housekeeping).toBeCloseTo(0.6, 1); // 0.5+0.1
    });

    /**
     * CONTRACT TEST: Every known category in the registry maps to a valid group.
     * Catches regressions when new categories are added to the registry but
     * the grouping logic silently falls through to a wrong bucket.
     */
    it('should classify every known category into a valid group', () => {
      for (const cat of Object.keys(COST_CATEGORY_REGISTRY)) {
        const result = groupCategories({ [cat]: 1.0 });
        const nonZero = Object.entries(result).filter(([, v]) => v > 0);
        expect(nonZero).toHaveLength(1);
        // The non-zero entry should be a valid group key
        expect(COST_GROUP_KEYS).toContain(nonZero[0][0]);
      }
    });
  });
});

describe('registerUsageHandlers', () => {
  beforeEach(() => {
    mockRegisterHandler.mockClear();
    mockGetCostSummary.mockReset();
    mockGetCategorizedCostSummary.mockReset();
    mockGetUsageInsights.mockReset();
    mockGetDailyBreakdown.mockReset();
    mockGetCostWaterfallByOutcome.mockReset();
  });

  it('passes byModel through the usage:get-cost-summary IPC response', async () => {
    mockGetCostSummary.mockResolvedValue({
      totalCostUsd: 4.5,
      entryCount: 3,
      oldestEntry: 1000,
      newestEntry: 3000,
    });
    mockGetCategorizedCostSummary.mockResolvedValue({
      total: 4.5,
      byCategory: { agent: 4.5 },
      byModel: {
        'claude-sonnet-4-6': 3.5,
        'claude-haiku-4-5': 1.0,
      },
      entryCount: 3,
      turnCount: 2,
      byAutomationType: {},
      byAuthMethod: {},
      byOpenRouterProvider: {},
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalPromptTokens: 0,
      activeSessionCount: 0,
    } satisfies CategorizedCostSummary);

    registerUsageHandlers();

    const summaryRegistration = mockRegisterHandler.mock.calls.find(
      ([channel]) => channel === 'usage:get-cost-summary'
    );
    expect(summaryRegistration).toBeTruthy();

    const handler = summaryRegistration?.[1] as (event: unknown, request: unknown) => Promise<unknown>;
    const result = await handler(null, { since: 1234 }) as Record<string, unknown>;

    expect(mockGetCostSummary).toHaveBeenCalledWith({ since: 1234 });
    expect(mockGetCategorizedCostSummary).toHaveBeenCalledWith({ startTs: 1234 });
    expect(result.byModel).toEqual({
      'claude-sonnet-4-6': 3.5,
      'claude-haiku-4-5': 1.0,
    });
  });

  it('passes periodDays=1 through usage:get-insights and preserves the 24h projection behavior', async () => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;

    mockGetUsageInsights.mockResolvedValue({
      topSession: null,
      topTurn: null,
      currentPeriodCost: 2,
      previousPeriodCost: 1,
      currentPeriodTurnCount: 4,
      peakDay: null,
      dailyCosts: [{ date: '2026-01-23', cost: 2 }],
    });
    mockGetCostSummary.mockResolvedValue({
      totalCostUsd: 10,
      entryCount: 5,
      oldestEntry: tenDaysAgo,
      newestEntry: Date.now(),
    });

    registerUsageHandlers();

    const insightsRegistration = mockRegisterHandler.mock.calls.find(
      ([channel]) => channel === 'usage:get-insights'
    );
    expect(insightsRegistration).toBeTruthy();

    const handler = insightsRegistration?.[1] as (event: unknown, request: unknown) => Promise<{
      comparison: { currentPeriodCost: number; previousPeriodCost: number; percentChange: number | null };
      projectedMonthCost: number | null;
      projectionBasis: { effectiveDays: number; daysSinceFirstUsage: number; periodDays: number } | null;
    }>;

    const result = await handler(null, { periodDays: 1 });

    expect(mockGetUsageInsights).toHaveBeenCalledWith({ periodDays: 1 });
    expect(mockGetCostSummary).toHaveBeenCalledWith({});
    expect(result.comparison).toEqual({
      currentPeriodCost: 2,
      previousPeriodCost: 1,
      percentChange: 100,
    });
    expect(result.projectionBasis).toMatchObject({
      effectiveDays: 1,
      periodDays: 1,
    });
    expect(result.projectedMonthCost).toBeCloseTo(60, 0); // $2 / 1 * 30
  });

  it('passes since through usage:get-cost-waterfall', async () => {
    const waterfall = {
      buckets: {},
      total: { totalUsd: 0, count: 0 },
      orphans: { resolutionLost: 0, resolutionUnmatched: 0 },
    };
    mockGetCostWaterfallByOutcome.mockResolvedValue(waterfall);

    registerUsageHandlers();

    const waterfallRegistration = mockRegisterHandler.mock.calls.find(
      ([channel]) => channel === 'usage:get-cost-waterfall'
    );
    expect(waterfallRegistration).toBeTruthy();

    const handler = waterfallRegistration?.[1] as (event: unknown, request: unknown) => Promise<unknown>;
    const result = await handler(null, { since: 1234 });

    expect(mockGetCostWaterfallByOutcome).toHaveBeenCalledWith({ since: 1234 });
    expect(result).toBe(waterfall);
  });
});
