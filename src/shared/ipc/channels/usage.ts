import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

const CostWaterfallBucketSchema = z.object({
  totalUsd: z.number(),
  count: z.number(),
  lastTs: z.number(),
});

const CostWaterfallOutcomeSchema = z.enum([
  'success',
  'aborted',
  'quota',
  'safety_eval_rejected',
  'tool_budget',
  'failed',
  'auxiliary_success',
  'auxiliary_failed',
  'legacy_unknown',
]);

const CostWaterfallSchema = z.object({
  buckets: z.record(CostWaterfallOutcomeSchema, CostWaterfallBucketSchema),
  total: z.object({
    totalUsd: z.number(),
    count: z.number(),
  }),
  orphans: z.object({
    resolutionLost: z.number(),
    resolutionUnmatched: z.number(),
  }),
});

/**
 * Usage IPC Channels
 *
 * Provides cost summary data from the persistent JSONL cost ledger.
 *
 * @see src/main/services/costLedgerService.ts
 * @see docs/plans/finished/251224_cost_ledger_implementation.md
 */

export const usageChannels = {
  'usage:get-cost-summary': defineInvokeChannel({
    channel: 'usage:get-cost-summary',
    request: z.object({
      since: z.number().optional(),
    }),
    response: z.object({
      totalCostUsd: z.number(),
      entryCount: z.number(),
      turnCount: z.number(),
      oldestEntry: z.number().nullable(),
      newestEntry: z.number().nullable(),
      byCategory: z.record(z.string(), z.number()),
      byCategoryRaw: z.record(z.string(), z.number()),
      byModel: z.record(z.string(), z.number()).optional(),
      byAuthMethod: z.record(z.string(), z.number()),
      // Automation costs broken down by automation type (for tooltip)
      byAutomationType: z.record(z.string(), z.number()),
      // Cache token totals for cache efficiency display
      totalInputTokens: z.number().optional(),
      totalCacheReadTokens: z.number().optional(),
      totalCacheCreationTokens: z.number().optional(),
    }),
    description: 'Get cost summary from persistent cost ledger',
  }),

  'usage:get-insights': defineInvokeChannel({
    channel: 'usage:get-insights',
    request: z.object({
      periodDays: z.number(), // e.g., 7 or 30
    }),
    response: z.object({
      // Most expensive session
      topSession: z
        .object({
          sessionId: z.string(),
          cost: z.number(),
          title: z.string().nullable(), // null if session deleted
          timestamp: z.number(),
        })
        .nullable(),
      // Most expensive single turn
      topTurn: z
        .object({
          turnId: z.string(),
          sessionId: z.string().nullable(),
          cost: z.number(),
          timestamp: z.number(),
          sessionTitle: z.string().nullable(),
        })
        .nullable(),
      // Period comparison
      comparison: z.object({
        currentPeriodCost: z.number(),
        previousPeriodCost: z.number(),
        percentChange: z.number().nullable(), // null if no previous data
      }),
      // Averages
      avgCostPerTurn: z.number().nullable(),
      // Average cost per active day (days with spend > 0)
      avgCostPerActiveDay: z.number().nullable(),
      // Number of active days (days with spend > 0)
      activeDayCount: z.number(),
      // Peak day
      peakDay: z
        .object({
          date: z.string(), // YYYY-MM-DD
          cost: z.number(),
        })
        .nullable(),
      // Projection (rolling 30 days extrapolated)
      projectedMonthCost: z.number().nullable(),
      // Projection basis for tooltip
      projectionBasis: z
        .object({
          effectiveDays: z.number(),
          daysSinceFirstUsage: z.number(),
          periodDays: z.number(),
        })
        .nullable(),
    }),
    description: 'Get usage insights: top session, top turn, comparisons, projections',
  }),

  'usage:get-daily-breakdown': defineInvokeChannel({
    channel: 'usage:get-daily-breakdown',
    request: z.object({
      since: z.number().optional(),
    }),
    response: z.array(
      z.object({
        date: z.string(),
        cost: z.number(),
        turns: z.number(),
        totalEntries: z.number(),
        inTok: z.number(),
        outTok: z.number(),
        cacheReadTok: z.number(),
        cacheCreateTok: z.number(),
      })
    ),
    description: 'Get daily cost breakdown from persistent cost ledger',
  }),

  'usage:get-cost-waterfall': defineInvokeChannel({
    channel: 'usage:get-cost-waterfall',
    request: z.object({
      since: z.number().optional(),
    }),
    response: CostWaterfallSchema,
    description: 'Get spend-quality cost waterfall grouped by turn outcome',
  }),
};
