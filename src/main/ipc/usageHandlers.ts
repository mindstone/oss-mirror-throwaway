/**
 * Usage Domain IPC Handlers
 *
 * Provides cost summary from the persistent JSONL cost ledger.
 *
 * @see src/main/services/costLedgerService.ts
 * @see docs/plans/finished/251224_cost_ledger_implementation.md
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { registerHandler } from './utils/registerHandler';
import {
  getCostSummary,
  getCategorizedCostSummary,
  getUsageInsights,
  getDailyBreakdown,
} from '../services/costLedgerService';
import { getCostWaterfallByOutcome } from '@core/services/diagnostics/costWaterfall';
import { usageChannels } from '@shared/ipc/channels/usage';
import type { AgentSessionSummary } from '@shared/ipc/schemas/sessions';
import { groupCategories, calculateProjection, calculateAvgPerActiveDay } from '@core/services/usageCostAnalysis';
import { ALL_KNOWN_CATEGORIES } from '@shared/costCategories';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'usageHandlers' });

// Warn once per unknown category to surface drift without log spam
const warnedUnknownCategories = new Set<string>();
function warnOnUnknownCategories(byCategory: Record<string, number>): void {
  for (const cat of Object.keys(byCategory)) {
    if (!ALL_KNOWN_CATEGORIES.has(cat) && !warnedUnknownCategories.has(cat)) {
      warnedUnknownCategories.add(cat);
      log.warn({ category: cat }, 'Unknown cost category encountered — add to COST_CATEGORY_REGISTRY in src/shared/costCategories.ts');
    }
  }
}

export interface UsageHandlerDeps {
  listSessionSummaries?: () => AgentSessionSummary[];
}

export function registerUsageHandlers(deps: UsageHandlerDeps = {}): void {
  const { listSessionSummaries } = deps;
  const costSummaryChannel = usageChannels['usage:get-cost-summary'];

  registerHandler(
    costSummaryChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const validated = costSummaryChannel.request.parse(request);

      // Get both basic summary and categorized breakdown
      const [basicSummary, categorizedSummary] = await Promise.all([
        getCostSummary(validated),
        getCategorizedCostSummary({ startTs: validated.since }),
      ]);

      // Surface unknown categories that need to be added to the registry
      warnOnUnknownCategories(categorizedSummary.byCategory);

      return {
        ...basicSummary,
        turnCount: categorizedSummary.turnCount,
        byCategory: groupCategories(categorizedSummary.byCategory),
        byCategoryRaw: categorizedSummary.byCategory,
        ...(Object.keys(categorizedSummary.byModel).length > 0
          ? { byModel: categorizedSummary.byModel }
          : {}),
        byAuthMethod: categorizedSummary.byAuthMethod,
        byAutomationType: categorizedSummary.byAutomationType,
        totalInputTokens: categorizedSummary.totalInputTokens,
        totalCacheReadTokens: categorizedSummary.totalCacheReadTokens,
        totalCacheCreationTokens: categorizedSummary.totalCacheCreationTokens,
      };
    }
  );

  const insightsChannel = usageChannels['usage:get-insights'];

  registerHandler(
    insightsChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const validated = insightsChannel.request.parse(request);
      const periodDays = validated.periodDays;

      // Get raw insights from ledger
      const insights = await getUsageInsights({ periodDays });

      // Load session summaries to enrich with titles (zero I/O — from in-memory index)
      let sessions: { id: string; title: string | null }[] = [];
      if (listSessionSummaries) {
        try {
          const summaries = listSessionSummaries();
          sessions = summaries.map((s) => ({ id: s.id, title: s.title ?? null }));
        } catch {
          // Sessions may not be available, continue without titles
        }
      }

      // Build session lookup
      const sessionMap = new Map(sessions.map((s) => [s.id, s.title]));

      // Calculate percent change
      let percentChange: number | null = null;
      if (insights.previousPeriodCost > 0) {
        percentChange = Math.round(
          ((insights.currentPeriodCost - insights.previousPeriodCost) /
            insights.previousPeriodCost) *
            100
        );
      } else if (insights.currentPeriodCost > 0) {
        // If no previous data but current has data, show as new (no percentage)
        percentChange = null;
      }

      // Calculate average cost per turn
      const avgCostPerTurn =
        insights.currentPeriodTurnCount > 0
          ? insights.currentPeriodCost / insights.currentPeriodTurnCount
          : null;

      // Calculate average cost per active day (days with spend > 0)
      const { avgCostPerActiveDay, activeDayCount } = calculateAvgPerActiveDay(insights.dailyCosts);

      // Calculate projection using corrected formula
      const basicSummaryForOldest = await getCostSummary({});
      const oldestEntryTimestamp = basicSummaryForOldest.oldestEntry;
      const projectionResult = calculateProjection(insights.currentPeriodCost, oldestEntryTimestamp, periodDays);
      const projectedMonthCost = projectionResult?.projectedMonthCost ?? null;
      const projectionBasis = projectionResult
        ? {
            effectiveDays: projectionResult.effectiveDays,
            daysSinceFirstUsage: projectionResult.daysSinceFirstUsage,
            periodDays,
          }
        : null;

      // Enrich top session with title
      const topSession = insights.topSession
        ? {
            sessionId: insights.topSession.sessionId,
            cost: insights.topSession.cost,
            title: sessionMap.get(insights.topSession.sessionId) ?? null,
            timestamp: insights.topSession.timestamp,
          }
        : null;

      // Enrich top turn with session title
      const topTurn = insights.topTurn
        ? {
            turnId: insights.topTurn.turnId,
            sessionId: insights.topTurn.sessionId,
            cost: insights.topTurn.cost,
            timestamp: insights.topTurn.timestamp,
            sessionTitle: insights.topTurn.sessionId
              ? sessionMap.get(insights.topTurn.sessionId) ?? null
              : null,
          }
        : null;

      return {
        topSession,
        topTurn,
        comparison: {
          currentPeriodCost: insights.currentPeriodCost,
          previousPeriodCost: insights.previousPeriodCost,
          percentChange,
        },
        avgCostPerTurn,
        avgCostPerActiveDay,
        activeDayCount,
        peakDay: insights.peakDay,
        projectedMonthCost,
        projectionBasis,
      };
    }
  );

  const dailyBreakdownChannel = usageChannels['usage:get-daily-breakdown'];

  registerHandler(
    dailyBreakdownChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const validated = dailyBreakdownChannel.request.parse(request);
      return getDailyBreakdown({ startTs: validated.since });
    }
  );

  const costWaterfallChannel = usageChannels['usage:get-cost-waterfall'];

  registerHandler(
    costWaterfallChannel.channel,
    async (_event: HandlerInvokeEvent, request: unknown) => {
      const validated = costWaterfallChannel.request.parse(request);
      return getCostWaterfallByOutcome({ since: validated.since ?? 0 });
    }
  );
}
