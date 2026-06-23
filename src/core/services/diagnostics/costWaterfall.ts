import { createScopedLogger } from '@core/logger';
import {
  getCostEntriesWithResolvedOutcomes,
  type CostEntryWithResolvedOutcome,
} from '@core/services/costLedgerService';
import { getDiagnosticEventsLedgerReader } from '@core/services/diagnosticEventsLedger';
import {
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_EVENTS_BYTES,
  type DiagnosticEventEntry,
} from '@core/services/diagnostics/manifest';
import type { TurnOutcome } from '@shared/costOutcome';

const log = createScopedLogger({ service: 'costWaterfall' });

const TURN_OUTCOME_KINDS = [
  'success',
  'aborted',
  'quota',
  'safety_eval_rejected',
  'tool_budget',
  'failed',
  'auxiliary_success',
  'auxiliary_failed',
  'legacy_unknown',
] as const satisfies readonly TurnOutcome['kind'][];

export interface CostWaterfallBucket {
  totalUsd: number;
  count: number;
  lastTs: number;
}

export interface CostWaterfallTotal {
  totalUsd: number;
  count: number;
}

export interface CostWaterfallOrphans {
  resolutionLost: number;
  resolutionUnmatched: number;
}

export interface CostWaterfall {
  buckets: Record<TurnOutcome['kind'], CostWaterfallBucket>;
  total: CostWaterfallTotal;
  orphans: CostWaterfallOrphans;
}

export interface CostWaterfallByOutcomeOptions {
  since: number;
}

const createEmptyBuckets = (): Record<TurnOutcome['kind'], CostWaterfallBucket> => {
  const buckets = {} as Record<TurnOutcome['kind'], CostWaterfallBucket>;
  for (const kind of TURN_OUTCOME_KINDS) {
    buckets[kind] = {
      totalUsd: 0,
      count: 0,
      lastTs: 0,
    };
  }
  return buckets;
};

const countResolutionOrphans = (
  events: readonly DiagnosticEventEntry[],
): CostWaterfallOrphans => {
  let resolutionLost = 0;
  let resolutionUnmatched = 0;

  for (const event of events) {
    if (event.kind === 'cost_outcome_resolution_lost') {
      resolutionLost += 1;
      continue;
    }
    if (event.kind === 'cost_outcome_resolution_unmatched') {
      resolutionUnmatched += 1;
    }
  }

  return { resolutionLost, resolutionUnmatched };
};

async function readResolutionOrphans(): Promise<CostWaterfallOrphans> {
  const reader = getDiagnosticEventsLedgerReader();
  if (!reader) return { resolutionLost: 0, resolutionUnmatched: 0 };

  try {
    const events = await reader.readRecent({
      limit: MAX_DIAGNOSTIC_EVENTS,
      maxBytes: MAX_DIAGNOSTIC_EVENTS_BYTES,
    });
    return countResolutionOrphans(events);
  } catch (err) {
    log.warn({ err }, 'Failed to read cost outcome orphan diagnostics for waterfall');
    return { resolutionLost: 0, resolutionUnmatched: 0 };
  }
}

export function aggregateCostWaterfall(
  entries: readonly CostEntryWithResolvedOutcome[],
  orphans: CostWaterfallOrphans = { resolutionLost: 0, resolutionUnmatched: 0 },
): CostWaterfall {
  const buckets = createEmptyBuckets();
  const total: CostWaterfallTotal = {
    totalUsd: 0,
    count: 0,
  };

  for (const entry of entries) {
    const kind = entry.resolvedOutcome.kind;
    const bucket = buckets[kind];
    bucket.totalUsd += entry.cost;
    bucket.count += 1;
    bucket.lastTs = Math.max(bucket.lastTs, entry.ts);
    total.totalUsd += entry.cost;
    total.count += 1;
  }

  return {
    buckets,
    total,
    orphans: { ...orphans },
  };
}

export async function getCostWaterfallByTurn(turnId: string): Promise<CostWaterfall> {
  const entries = await getCostEntriesWithResolvedOutcomes();
  const matchingEntries = entries.filter((entry) => entry.tid === turnId);
  const orphans = await readResolutionOrphans();
  return aggregateCostWaterfall(matchingEntries, orphans);
}

export async function getCostWaterfallByOutcome(
  opts: CostWaterfallByOutcomeOptions,
): Promise<CostWaterfall> {
  const entries = await getCostEntriesWithResolvedOutcomes({ since: opts.since });
  const orphans = await readResolutionOrphans();
  return aggregateCostWaterfall(entries, orphans);
}
