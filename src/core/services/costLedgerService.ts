/**
 * Cost Ledger Service
 *
 * Append-only JSONL ledger for persistent cost tracking.
 * Costs survive session deletion, compaction, and pruning.
 *
 * Design:
 * - JSONL format for O(1) appends (no file rewrite needed)
 * - Stream-based reading for O(1) memory aggregation
 * - Fire-and-forget appends (non-blocking main thread)
 * - Graceful handling of corrupted entries
 *
 * @see docs/plans/finished/251224_cost_ledger_implementation.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { getTracker } from '@core/tracking';
import { getDataPath } from '@core/utils/dataPaths';
import { readFileLines } from '@core/utils/readLines';
import { getModelPricing } from '@shared/utils/pricingCalculator';
import { classifySessionKind, isInternalLedgerKind } from '@shared/sessionKind';
import { appendDiagnosticEvent, getDiagnosticEventsLedgerReader } from './diagnosticEventsLedger';
import {
  isTurnOutcome,
  type TurnOutcome,
} from '@shared/costOutcome';
import {
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_EVENTS_BYTES,
  type DiagnosticEventEntry,
} from './diagnostics/manifest';

// Re-export AuxiliaryCostCategory from the single-source-of-truth registry
// so existing consumers (behindTheScenesClient, etc.) continue to work.
export type { AuxiliaryCostCategory } from '@shared/costCategories';

const log = createScopedLogger({ service: 'costLedger' });


/**
 * A single entry in the cost ledger.
 *
 * Required fields:
 * - `ts`: Unix timestamp in milliseconds
 * - `cost`: Cost in USD (e.g., 0.0234)
 *
 * Optional fields:
 * - `sid`: Session ID for attribution/drill-down
 * - `tid`: Turn ID for attribution/drill-down
 * - `cat`: Category of the cost entry (defaults to 'agent' if absent)
 * - `m`: Model name used (for debugging unexpected costs)
 *
 * Note: `cat` is typed as `string` (not `AuxiliaryCostCategory`) because we allow
 * unknown categories when reading for forward compatibility. Use `AuxiliaryCostCategory`
 * when writing (via TrackingOptions) to ensure type safety at write time.
 */
export interface CostLedgerEntry {
  /** Stable join key for late outcome resolution. Absent on legacy rows. */
  costEntryId?: string;
  ts: number; // Unix timestamp (ms)
  cost: number; // USD (e.g., 0.0234)
  sid?: string; // Session ID (optional pointer for drill-down)
  tid?: string; // Turn ID (optional pointer for drill-down)
  cat?: string; // Category (absent = implicit 'agent') - string for forward compat
  m?: string; // Model name for debugging
  mu?: Record<string, {
    in: number;
    out: number;
    cacheR?: number;
    cacheC?: number;
    cost?: number;
  }>;
  /** Auth method used ('api-key' | 'oauth-token'). String for forward compat. Undefined for pre-migration entries. */
  auth?: string;
  /** Input tokens (absent for BTS entries and pre-migration entries) */
  inTok?: number;
  /** Output tokens (absent for BTS entries and pre-migration entries) */
  outTok?: number;
  /** Cache read input tokens */
  cacheReadTok?: number;
  /** Cache creation input tokens */
  cacheCreateTok?: number;
  /** True when cost is estimated from token counts, not server-calculated */
  est?: boolean;
  /** Number of tool calls in the agentic loop (proxy for iteration count) */
  toolCalls?: number;
  /** OpenRouter upstream provider that served the request (e.g. 'Anthropic', 'Google'). Only present for OpenRouter-routed turns. */
  orProvider?: string;
  /** Outcome taxonomy used by wasted-spend / cost waterfall diagnostics. Absent on legacy or late-resolve rows. */
  outcome?: TurnOutcome;
}

export interface AppendCostEntryResult {
  costEntryId: string;
}

export type CostOutcomePolicy = 'turn_bearing' | 'auxiliary' | 'late_resolve';

export interface CostSummary {
  totalCostUsd: number;
  entryCount: number;
  oldestEntry: number | null; // timestamp of earliest entry
  newestEntry: number | null; // timestamp of latest entry
}

export interface CostSummaryOptions {
  since?: number; // Only include entries >= this timestamp
}

export const MAX_OUTCOME_RESOLUTION_LAG_MS = 60_000;

export interface CostEntryWithResolvedOutcome extends CostLedgerEntry {
  resolvedOutcome: TurnOutcome;
}

/**
 * Options for category-aware cost aggregation.
 */
export interface CategorizedCostSummaryOptions {
  startTs?: number; // Only include entries >= this timestamp
  endTs?: number; // Only include entries <= this timestamp
  categories?: string[]; // Only include entries with these categories
  excludeCategories?: string[]; // Exclude entries with these categories
}

/**
 * Category-aware cost summary response.
 */
export interface CategorizedCostSummary {
  total: number; // Total cost across all matching entries
  byCategory: Record<string, number>; // Cost broken down by category
  byModel: Record<string, number>; // Cost broken down by model
  entryCount: number; // Total number of matching entries
  turnCount: number; // Entries where cat is 'agent' or absent (for UI "Turns" label)
  byAutomationType: Record<string, number>; // Automation costs by type (for tooltip breakdown)
  byAuthMethod: Record<string, number>; // Cost broken down by auth method
  byOpenRouterProvider: Record<string, number>; // Cost broken down by OpenRouter upstream provider
  totalInputTokens: number; // Sum of inTok across all matching entries
  totalOutputTokens: number; // Sum of outTok across all matching entries
  totalCacheReadTokens: number; // Sum of cacheReadTok across all matching entries
  totalCacheCreationTokens: number; // Sum of cacheCreateTok across all matching entries
  totalPromptTokens: number; // input + cacheRead + cacheCreation
  activeSessionCount: number; // Unique non-internal session IDs
}

/** Zero-value CategorizedCostSummary. Use for error fallbacks and test defaults. */
export const EMPTY_CATEGORIZED_COST_SUMMARY: CategorizedCostSummary = {
  total: 0,
  byCategory: {},
  byModel: {},
  entryCount: 0,
  turnCount: 0,
  byAutomationType: {},
  byAuthMethod: {},
  byOpenRouterProvider: {},
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  totalPromptTokens: 0,
  activeSessionCount: 0,
};

/**
 * Options for getting usage insights (top session, top turn, etc.)
 */
export interface UsageInsightsOptions {
  periodDays: number; // Number of days to analyze
}

/**
 * Top session info from the ledger.
 */
export interface TopSessionInfo {
  sessionId: string;
  cost: number;
  timestamp: number; // Most recent entry timestamp for this session
}

/**
 * Top turn info from the ledger.
 */
export interface TopTurnInfo {
  turnId: string;
  sessionId: string | null;
  cost: number;
  timestamp: number;
}

/**
 * Daily cost aggregation for peak day detection.
 */
export interface DailyCost {
  date: string; // YYYY-MM-DD
  cost: number;
}

/**
 * Usage insights from the ledger.
 */
export interface UsageInsights {
  topSession: TopSessionInfo | null;
  topTurn: TopTurnInfo | null;
  currentPeriodCost: number;
  previousPeriodCost: number;
  currentPeriodTurnCount: number;
  peakDay: DailyCost | null;
  dailyCosts: DailyCost[]; // For calculating projection
}

// -----------------------------------------------------------------------------
// Daily breakdown types
// -----------------------------------------------------------------------------

/**
 * A single day's aggregated cost data from the ledger.
 * Used for the Usage tab daily breakdown table and CSV export.
 */
export interface DailyBreakdownEntry {
  date: string;        // YYYY-MM-DD
  cost: number;
  turns: number;       // entries where cat is 'agent', 'conversation', or absent
  totalEntries: number;
  inTok: number;
  outTok: number;
  cacheReadTok: number;
  cacheCreateTok: number;
}

export interface DailyBreakdownOptions {
  startTs?: number;
  endTs?: number;
}

// -----------------------------------------------------------------------------
// Path helpers (exported for testability)
// -----------------------------------------------------------------------------

let ledgerPathOverride: string | null = null;

/**
 * Get the path to the cost ledger file.
 * Uses app.getPath('userData') by default.
 */
const getLedgerPath = (): string => {
  if (ledgerPathOverride) {
    return ledgerPathOverride;
  }
  return path.join(getDataPath(), 'cost-ledger.jsonl');
};

/**
 * Override the ledger path (for testing).
 * Pass null to reset to default.
 */
export const setLedgerPathOverride = (pathOverride: string | null): void => {
  ledgerPathOverride = pathOverride;
};

const UNATTRIBUTED_MODEL_KEY = 'unattributed';
type CompactModelUsageMap = NonNullable<CostLedgerEntry['mu']>;
type CompactModelUsageEntry = CompactModelUsageMap[string];

const addCostToBreakdown = (
  breakdown: Record<string, number>,
  key: string,
  amount: number
): void => {
  if (!(amount > 0)) {
    return;
  }

  breakdown[key] = (breakdown[key] ?? 0) + amount;
};

const estimateModelUsageCost = (
  model: string,
  usage: CompactModelUsageEntry
): number | null => {
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) {
    return usage.cost;
  }

  const pricing = getModelPricing(model);
  if (!pricing) {
    return null;
  }

  return (pricing.output * usage.out) + (pricing.input * usage.in);
};

const buildCostIncurredAnalyticsProperties = (
  entry: CostLedgerEntry
): Record<string, string | number | null | object> => {
  const modelUsageEntries = entry.mu ? Object.entries(entry.mu) : [];
  if (modelUsageEntries.length < 2) {
    return {
      pricingModelResolved: entry.m ?? modelUsageEntries[0]?.[0] ?? null,
    };
  }

  try {
    let primaryModel: string | null = null;
    let primaryModelCost = Number.NEGATIVE_INFINITY;

    for (const [model, usage] of modelUsageEntries) {
      const estimatedCost = estimateModelUsageCost(model, usage);
      if (estimatedCost !== null && estimatedCost > primaryModelCost) {
        primaryModel = model;
        primaryModelCost = estimatedCost;
      }
    }

    const analyticsProperties: Record<string, string | number | null | object> = {
      pricingModelResolved: null,
      modelCount: modelUsageEntries.length,
      modelBreakdownJson: JSON.stringify(entry.mu),
    };

    if (primaryModel) {
      analyticsProperties.primaryModel = primaryModel;
    }

    log.debug(
      {
        sessionId: entry.sid,
        turnId: entry.tid,
        modelCount: modelUsageEntries.length,
        primaryModel,
        models: modelUsageEntries.map(([model]) => model),
      },
      'Prepared multi-model cost analytics properties'
    );

    return analyticsProperties;
  } catch (err) {
    log.warn(
      {
        err,
        sessionId: entry.sid,
        turnId: entry.tid,
        modelCount: modelUsageEntries.length,
      },
      'Failed to prepare multi-model cost analytics properties'
    );
    return {};
  }
};

const attributeEntryCostByModel = (
  entry: CostLedgerEntry,
  byModel: Record<string, number>
): void => {
  const modelUsageEntries = entry.mu ? Object.entries(entry.mu) : [];

  if (modelUsageEntries.length === 0) {
    if (entry.m) {
      addCostToBreakdown(byModel, entry.m, entry.cost);
    }
    return;
  }

  let explicitCostTotal = 0;
  const entriesWithoutCost: Array<[string, NonNullable<CostLedgerEntry['mu']>[string]]> = [];

  for (const [model, usage] of modelUsageEntries) {
    if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) {
      explicitCostTotal += usage.cost;
      addCostToBreakdown(byModel, model, usage.cost);
      continue;
    }

    entriesWithoutCost.push([model, usage]);
  }

  if (entriesWithoutCost.length === 0) {
    return;
  }

  const remainingCost =
    explicitCostTotal > 0 ? Math.max(entry.cost - explicitCostTotal, 0) : entry.cost;
  if (!(remainingCost > 0)) {
    return;
  }

  const weightedEntries: Array<{ model: string; weight: number }> = [];
  const unpricedModels: string[] = [];

  for (const [model, usage] of entriesWithoutCost) {
    const pricing = getModelPricing(model);
    if (!pricing) {
      unpricedModels.push(model);
      continue;
    }
    const weight = (pricing.output * usage.out) + (pricing.input * usage.in);
    weightedEntries.push({ model, weight });
  }

  const totalWeight = weightedEntries.reduce((sum, weightedEntry) => sum + weightedEntry.weight, 0);

  if (totalWeight > 0) {
    // Distribute remaining cost proportionally to priced models.
    // If some models lack pricing, put their share in unattributed.
    const pricedShare = unpricedModels.length > 0
      ? remainingCost * (weightedEntries.length / entriesWithoutCost.length)
      : remainingCost;
    const unpricedShare = remainingCost - pricedShare;

    for (const weightedEntry of weightedEntries) {
      addCostToBreakdown(
        byModel,
        weightedEntry.model,
        pricedShare * (weightedEntry.weight / totalWeight)
      );
    }

    if (unpricedShare > 0) {
      addCostToBreakdown(byModel, UNATTRIBUTED_MODEL_KEY, unpricedShare);
    }

    log.debug(
      {
        sessionId: entry.sid,
        turnId: entry.tid,
        modelCount: modelUsageEntries.length,
        remainingCost,
        pricedModels: weightedEntries.map(({ model }) => model),
        unpricedModels,
      },
      'Attributed multi-model ledger cost using pricing-weighted estimation'
    );
    return;
  }

  if (weightedEntries.length > 0) {
    const evenShare = remainingCost / entriesWithoutCost.length;
    for (const [model] of entriesWithoutCost) {
      addCostToBreakdown(byModel, model, evenShare);
    }

    log.debug(
      {
        sessionId: entry.sid,
        turnId: entry.tid,
        modelCount: modelUsageEntries.length,
        remainingCost,
        models: entriesWithoutCost.map(([model]) => model),
      },
      'Attributed multi-model ledger cost evenly because pricing weights were zero'
    );
    return;
  }

  log.warn(
    {
      sessionId: entry.sid,
      turnId: entry.tid,
      modelCount: modelUsageEntries.length,
      remainingCost,
      models: entriesWithoutCost.map(([model]) => model),
    },
    'Unable to attribute multi-model ledger cost to priced models; using unattributed bucket'
  );
  addCostToBreakdown(byModel, UNATTRIBUTED_MODEL_KEY, remainingCost);
};

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/**
 * Validate that a parsed object is a valid CostLedgerEntry.
 *
 * Checks:
 * - `ts` is a finite non-negative number (required)
 * - `cost` is a finite non-negative number (required)
 * - `sid`, `tid`, `cat`, `m` are strings if present (optional)
 *
 * Note: We don't validate that `cat` is a valid AuxiliaryCostCategory value
 * to allow forward compatibility with new categories added in future versions.
 */
export const isValidEntry = (obj: unknown): obj is CostLedgerEntry => {
  if (typeof obj !== 'object' || obj === null) return false;
  const e = obj as Record<string, unknown>;

  // Required fields: ts and cost must be finite non-negative numbers
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts) || e.ts < 0) return false;
  if (typeof e.cost !== 'number' || !Number.isFinite(e.cost) || e.cost < 0) return false;

  // Optional string fields: sid, tid, cat, m
  if (e.costEntryId !== undefined && typeof e.costEntryId !== 'string') return false;
  if (e.sid !== undefined && typeof e.sid !== 'string') return false;
  if (e.tid !== undefined && typeof e.tid !== 'string') return false;
  if (e.cat !== undefined && typeof e.cat !== 'string') return false;
  if (e.m !== undefined && typeof e.m !== 'string') return false;
  if (e.mu !== undefined) {
    if (typeof e.mu !== 'object' || e.mu === null || Array.isArray(e.mu)) return false;

    for (const [model, usage] of Object.entries(e.mu as Record<string, unknown>)) {
      if (typeof model !== 'string') return false;
      if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return false;

      const usageEntry = usage as Record<string, unknown>;
      if (typeof usageEntry.in !== 'number' || !Number.isFinite(usageEntry.in)) return false;
      if (typeof usageEntry.out !== 'number' || !Number.isFinite(usageEntry.out)) return false;
      if (usageEntry.cacheR !== undefined && (typeof usageEntry.cacheR !== 'number' || !Number.isFinite(usageEntry.cacheR))) return false;
      if (usageEntry.cacheC !== undefined && (typeof usageEntry.cacheC !== 'number' || !Number.isFinite(usageEntry.cacheC))) return false;
      if (usageEntry.cost !== undefined && (typeof usageEntry.cost !== 'number' || !Number.isFinite(usageEntry.cost))) return false;
    }
  }
  if (e.auth !== undefined && typeof e.auth !== 'string') return false;

  // Optional token count fields: must be finite numbers if present
  if (e.inTok !== undefined && (typeof e.inTok !== 'number' || !Number.isFinite(e.inTok))) return false;
  if (e.outTok !== undefined && (typeof e.outTok !== 'number' || !Number.isFinite(e.outTok))) return false;
  if (e.cacheReadTok !== undefined && (typeof e.cacheReadTok !== 'number' || !Number.isFinite(e.cacheReadTok))) return false;
  if (e.cacheCreateTok !== undefined && (typeof e.cacheCreateTok !== 'number' || !Number.isFinite(e.cacheCreateTok))) return false;

  // Optional boolean field: est (estimated cost flag)
  if (e.est !== undefined && typeof e.est !== 'boolean') return false;

  // Optional numeric field: toolCalls (iteration count)
  if (e.toolCalls !== undefined && (typeof e.toolCalls !== 'number' || !Number.isFinite(e.toolCalls))) return false;

  // Optional structural outcome field. Missing outcome is accepted for legacy rows
  // and late-resolve rows; malformed or unknown outcome variants are dropped on read.
  if (e.outcome !== undefined && !isTurnOutcome(e.outcome)) return false;

  return true;
};

// -----------------------------------------------------------------------------
// Append (fire-and-forget)
// -----------------------------------------------------------------------------

/**
 * Append a cost entry to the ledger.
 *
 * This is fire-and-forget - it does NOT block the main thread.
 * Errors are logged but not thrown.
 */
export const appendCostEntry = (entry: CostLedgerEntry): AppendCostEntryResult => {
  const costEntryId = entry.costEntryId ?? randomUUID();
  const entryWithId: CostLedgerEntry = {
    ...entry,
    costEntryId,
  };

  // Validate before writing
  if (!isValidEntry(entryWithId)) {
    log.warn({ entry: entryWithId }, 'Attempted to append invalid cost entry, skipping');
    return { costEntryId };
  }

  const line = JSON.stringify(entryWithId) + '\n';
  const filePath = getLedgerPath();

  // Use callback-based appendFile for fire-and-forget (non-blocking)
  fs.appendFile(filePath, line, 'utf8', (err) => {
    if (err) {
      log.warn({ err, filePath }, 'Failed to append cost entry');
    } else {
      log.debug(
        {
          costEntryId: entryWithId.costEntryId,
          ts: entryWithId.ts,
          cost: entryWithId.cost,
          sid: entryWithId.sid,
        },
        'Appended cost entry'
      );
    }
  });

  // Emit an analytics event for every cost entry so reporting matches the ledger.
  // Uses the same getTracker() pattern as dailyCostReportingService, memoryUpdateService, etc.
  try {
    const tracker = getTracker();
    if (tracker.isAvailable()) {
      const analyticsProperties = buildCostIncurredAnalyticsProperties(entryWithId);

      tracker.track('Cost Incurred', {
        costEntryId: entryWithId.costEntryId,
        outcome: entryWithId.outcome,
        costUsd: entryWithId.cost,
        category: entryWithId.cat ?? 'agent',
        model: entryWithId.m,
        authMethod: entryWithId.auth,
        inputTokens: entryWithId.inTok,
        outputTokens: entryWithId.outTok,
        cacheReadTokens: entryWithId.cacheReadTok,
        cacheCreationTokens: entryWithId.cacheCreateTok,
        estimated: entryWithId.est,
        toolCalls: entryWithId.toolCalls,
        ...(entryWithId.orProvider ? { openRouterProvider: entryWithId.orProvider } : {}),
        ...analyticsProperties,
      });
    }
  } catch (err) {
    log.warn(
      { err, sessionId: entryWithId.sid, turnId: entryWithId.tid },
      'Failed to emit cost analytics event'
    );
    // Fire-and-forget — never block cost ledger writes
  }

  return { costEntryId };
};

export function resolveCostEntryOutcome(
  entry: CostLedgerEntry,
  resolutionEvents: readonly DiagnosticEventEntry[],
  nowMs = Date.now(),
): TurnOutcome {
  if (entry.outcome) return entry.outcome;
  if (!entry.costEntryId) return { kind: 'legacy_unknown' };

  const resolution = resolutionEvents
    .filter((event): event is Extract<DiagnosticEventEntry, { kind: 'cost_outcome_resolution' }> =>
      event.kind === 'cost_outcome_resolution' &&
      event.data.costEntryId === entry.costEntryId &&
      Math.abs(event.ts - entry.ts) <= MAX_OUTCOME_RESOLUTION_LAG_MS
    )
    .sort((a, b) => b.ts - a.ts)[0];

  if (resolution) return resolution.data.outcome;

  const lagMs = nowMs - entry.ts;
  if (lagMs > MAX_OUTCOME_RESOLUTION_LAG_MS) {
    appendDiagnosticEvent({
      kind: 'cost_outcome_resolution_lost',
      data: {
        costEntryId: entry.costEntryId,
        lagMs,
        rotationStraddled: true,
      },
    });
  }

  return { kind: 'legacy_unknown' };
}

/**
 * Read cost entries and apply late outcome resolutions from the diagnostic
 * event ledger. The diagnostic-events reader is rotation-aware (`.jsonl` then
 * `.jsonl.old`), so this join survives the common single-rotation race.
 */
export async function getCostEntriesWithResolvedOutcomes(options?: {
  since?: number;
  nowMs?: number;
}): Promise<CostEntryWithResolvedOutcome[]> {
  const filePath = getLedgerPath();
  if (!fs.existsSync(filePath)) return [];

  const diagnosticReader = getDiagnosticEventsLedgerReader();
  const resolutionEvents = diagnosticReader
    ? await diagnosticReader.readRecent({
      limit: MAX_DIAGNOSTIC_EVENTS,
      maxBytes: MAX_DIAGNOSTIC_EVENTS_BYTES,
    })
    : [];
  const matchedCostEntryIds = new Set<string>();
  const entries: CostEntryWithResolvedOutcome[] = [];

  try {
    await readFileLines(filePath, (line) => {
      if (!line.trim()) return;

      try {
        const parsed: unknown = JSON.parse(line);
        if (!isValidEntry(parsed)) {
          log.warn({ line: line.slice(0, 100) }, 'Skipping invalid ledger entry');
          return;
        }
        if (options?.since != null && parsed.ts < options.since) return;

        const resolvedOutcome = resolveCostEntryOutcome(parsed, resolutionEvents, options?.nowMs);
        if (parsed.costEntryId) {
          matchedCostEntryIds.add(parsed.costEntryId);
        }
        entries.push({ ...parsed, resolvedOutcome });
      } catch {
        log.warn({ line: line.slice(0, 100) }, 'Skipping malformed ledger line (invalid JSON)');
      }
    }, {
      encoding: 'utf-8',
      crlfDelay: Number.POSITIVE_INFINITY,
    });
  } catch (err) {
    log.warn({ err, filePath }, 'Error reading cost ledger with resolved outcomes');
    return [];
  }

  for (const event of resolutionEvents) {
    if (
      event.kind === 'cost_outcome_resolution' &&
      !matchedCostEntryIds.has(event.data.costEntryId)
    ) {
      appendDiagnosticEvent({
        kind: 'cost_outcome_resolution_unmatched',
        data: {
          costEntryId: event.data.costEntryId,
          outcome: event.data.outcome,
        },
      });
    }
  }

  return entries;
}

// -----------------------------------------------------------------------------
// Read & Aggregate (stream-based, O(1) memory)
// -----------------------------------------------------------------------------

/**
 * Get a summary of cost data from the ledger.
 *
 * Uses stream-based reading for O(1) memory usage.
 * Corrupted or invalid entries are skipped (logged as warnings).
 *
 * @param options.since - Only include entries with ts >= this value
 */
export const getCostSummary = async (options?: CostSummaryOptions): Promise<CostSummary> => {
  const filePath = getLedgerPath();
  const emptySummary: CostSummary = {
    totalCostUsd: 0,
    entryCount: 0,
    oldestEntry: null,
    newestEntry: null,
  };

  // Handle missing file gracefully
  if (!fs.existsSync(filePath)) {
    return emptySummary;
  }

  let totalCostUsd = 0;
  let entryCount = 0;
  let minTs: number | null = null;
  let maxTs: number | null = null;

  try {
    await readFileLines(filePath, (line) => {
      // Skip empty lines
      if (!line.trim()) return;

      try {
        const parsed: unknown = JSON.parse(line);

        if (!isValidEntry(parsed)) {
          log.warn({ line: line.slice(0, 100) }, 'Skipping invalid ledger entry');
          return;
        }

        // Apply time filter if specified (use != null to handle since: 0)
        if (options?.since != null && parsed.ts < options.since) {
          return;
        }

        totalCostUsd += parsed.cost;
        entryCount++;

        if (minTs === null || parsed.ts < minTs) {
          minTs = parsed.ts;
        }
        if (maxTs === null || parsed.ts > maxTs) {
          maxTs = parsed.ts;
        }
      } catch {
        log.warn({ line: line.slice(0, 100) }, 'Skipping malformed ledger line (invalid JSON)');
      }
    }, {
      encoding: 'utf-8',
      crlfDelay: Number.POSITIVE_INFINITY,
    });
  } catch (err) {
    log.warn({ err, filePath }, 'Error reading cost ledger, returning empty summary');
    return emptySummary;
  }

  return {
    totalCostUsd,
    entryCount,
    oldestEntry: minTs,
    newestEntry: maxTs,
  };
};

/**
 * Get a category-aware summary of cost data from the ledger.
 *
 * Uses stream-based reading for O(1) memory usage.
 * Corrupted or invalid entries are skipped (logged as warnings).
 *
 * @param options.startTs - Only include entries with ts >= this value
 * @param options.endTs - Only include entries with ts <= this value
 * @param options.categories - Only include entries with these categories (if not specified, include all)
 * @param options.excludeCategories - Exclude entries with these categories
 */
export const getCategorizedCostSummary = async (
  options?: CategorizedCostSummaryOptions
): Promise<CategorizedCostSummary> => {
  const filePath = getLedgerPath();
  const emptySummary = { ...EMPTY_CATEGORIZED_COST_SUMMARY };

  // Handle missing file gracefully
  if (!fs.existsSync(filePath)) {
    return emptySummary;
  }

  let total = 0;
  const byCategory: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const byAutomationType: Record<string, number> = {};
  const byAuthMethod: Record<string, number> = {};
  const byOpenRouterProvider: Record<string, number> = {};
  let entryCount = 0;
  let turnCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  const uniqueSids = new Set<string>();

  // Prepare category filters as Sets for O(1) lookup
  const includeCategories = options?.categories ? new Set(options.categories) : null;
  const excludeCategories = options?.excludeCategories ? new Set(options.excludeCategories) : null;

  try {
    await readFileLines(filePath, (line) => {
      // Skip empty lines
      if (!line.trim()) return;

      try {
        const parsed: unknown = JSON.parse(line);

        if (!isValidEntry(parsed)) {
          log.warn({ line: line.slice(0, 100) }, 'Skipping invalid ledger entry');
          return;
        }

        // Apply time range filter (use != null to handle startTs: 0)
        if (options?.startTs != null && parsed.ts < options.startTs) {
          return;
        }
        if (options?.endTs != null && parsed.ts > options.endTs) {
          return;
        }

        // Determine effective category (absent means 'agent')
        const effectiveCategory = parsed.cat ?? 'agent';

        // Apply category filters
        if (includeCategories && !includeCategories.has(effectiveCategory)) {
          return;
        }
        if (excludeCategories && excludeCategories.has(effectiveCategory)) {
          return;
        }

        // Aggregate
        total += parsed.cost;
        entryCount++;
        byCategory[effectiveCategory] = (byCategory[effectiveCategory] ?? 0) + parsed.cost;
        attributeEntryCostByModel(parsed, byModel);

        // Aggregate by auth method (pre-migration entries default to 'unknown')
        const effectiveAuth = parsed.auth ?? 'unknown';
        byAuthMethod[effectiveAuth] = (byAuthMethod[effectiveAuth] ?? 0) + parsed.cost;

        // Aggregate by OpenRouter upstream provider (only present for OR-routed turns)
        if (parsed.orProvider) {
          byOpenRouterProvider[parsed.orProvider] = (byOpenRouterProvider[parsed.orProvider] ?? 0) + parsed.cost;
        }

        // Track automation costs by type (for tooltip breakdown)
        // Session ID format: automation-{type}--{uuid} or legacy automation-{type}
        if (effectiveCategory === 'automation' && parsed.sid) {
          const automationType = parseAutomationType(parsed.sid);
          if (automationType) {
            byAutomationType[automationType] = (byAutomationType[automationType] ?? 0) + parsed.cost;
          }
        }

        // Count turns: user-initiated turns ('agent' legacy, 'conversation' current)
        if (effectiveCategory === 'agent' || effectiveCategory === 'conversation') {
          turnCount++;
        }

        // Accumulate token totals (use ?? 0 to prevent NaN poisoning)
        totalInputTokens += parsed.inTok ?? 0;
        totalOutputTokens += parsed.outTok ?? 0;
        totalCacheReadTokens += parsed.cacheReadTok ?? 0;
        totalCacheCreationTokens += parsed.cacheCreateTok ?? 0;

        // Track unique non-internal session IDs
        if (parsed.sid && !isInternalSession(parsed.sid)) {
          uniqueSids.add(parsed.sid);
        }
      } catch {
        log.warn({ line: line.slice(0, 100) }, 'Skipping malformed ledger line (invalid JSON)');
      }
    }, {
      encoding: 'utf-8',
      crlfDelay: Number.POSITIVE_INFINITY,
    });
  } catch (err) {
    log.warn({ err, filePath }, 'Error reading cost ledger, returning empty summary');
    return emptySummary;
  }

  const totalPromptTokens = totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens;

  return {
    total,
    byCategory,
    byModel,
    entryCount,
    turnCount,
    byAutomationType,
    byAuthMethod,
    byOpenRouterProvider,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalPromptTokens,
    activeSessionCount: uniqueSids.size,
  };
};

/**
 * Parse automation type from a session ID.
 * Handles two formats:
 * - automation-{type}--{uuid} (new format)
 * - automation-{type} (legacy format, no UUID suffix)
 *
 * Returns the automation type, or null if the session ID doesn't match the pattern.
 */
function parseAutomationType(sessionId: string): string | null {
  const sessionKind = classifySessionKind(sessionId);
  if (sessionKind !== 'automation' && sessionKind !== 'automation-insight') return null;

  // Remove 'automation-' prefix
  const rest = sessionId.slice('automation-'.length);

  // Check for new format with '--' separator
  const separatorIndex = rest.indexOf('--');
  if (separatorIndex !== -1) {
    return rest.slice(0, separatorIndex);
  }

  // Legacy format: the rest is the type (e.g., 'calendar-sync')
  return rest;
}

/**
 * Check if a session ID belongs to an internal/background session that should be
 * excluded from "Most expensive conversation" / "Costliest single turn" records.
 *
 * These sessions don't appear in the user's conversation history, so showing them
 * in usage records would be confusing.
 */
export const isInternalSession = (sessionId: string): boolean => {
  const kind = classifySessionKind(sessionId);
  return isInternalLedgerKind(kind) && kind !== 'meeting-qa' && kind !== 'meeting-analysis';
};

/**
 * Get usage insights from the ledger (top session, top turn, comparisons).
 *
 * Reads the entire ledger once to extract:
 * - Most expensive session (by aggregated cost)
 * - Most expensive single turn
 * - Current vs previous period costs for comparison
 * - Peak day
 * - Daily costs for projection calculation
 *
 * @param options.periodDays - Number of days to analyze (e.g., 7 or 30)
 */
export const getUsageInsights = async (options: UsageInsightsOptions): Promise<UsageInsights> => {
  const filePath = getLedgerPath();
  const now = Date.now();
  const periodMs = options.periodDays * 24 * 60 * 60 * 1000;
  const currentPeriodStart = now - periodMs;
  const previousPeriodStart = currentPeriodStart - periodMs;

  const emptyInsights: UsageInsights = {
    topSession: null,
    topTurn: null,
    currentPeriodCost: 0,
    previousPeriodCost: 0,
    currentPeriodTurnCount: 0,
    peakDay: null,
    dailyCosts: [],
  };

  if (!fs.existsSync(filePath)) {
    return emptyInsights;
  }

  // Aggregation state
  const sessionCosts: Map<string, { cost: number; timestamp: number }> = new Map();
  let topTurn: TopTurnInfo | null = null;
  let currentPeriodCost = 0;
  let previousPeriodCost = 0;
  let currentPeriodTurnCount = 0;
  const dailyCostsMap: Map<string, number> = new Map();

  try {
    await readFileLines(filePath, (line) => {
      if (!line.trim()) return;

      try {
        const parsed: unknown = JSON.parse(line);
        if (!isValidEntry(parsed)) return;

        const effectiveCategory = parsed.cat ?? 'agent';
        // User-initiated turns: 'agent' (legacy) or 'conversation' (current)
        const isAgentTurn = effectiveCategory === 'agent' || effectiveCategory === 'conversation';

        // Period comparison (all categories)
        if (parsed.ts >= currentPeriodStart) {
          currentPeriodCost += parsed.cost;
          if (isAgentTurn) currentPeriodTurnCount++;

          // Daily aggregation for peak day (current period only)
          const dateStr = new Date(parsed.ts).toISOString().split('T')[0];
          dailyCostsMap.set(dateStr, (dailyCostsMap.get(dateStr) ?? 0) + parsed.cost);
        } else if (parsed.ts >= previousPeriodStart) {
          previousPeriodCost += parsed.cost;
        }

        // Only track top session/turn for agent turns (not auxiliary costs)
        if (!isAgentTurn) return;

        // Aggregate session costs ONLY for entries within the current period
        // This ensures "Last 7 Days" shows costs FROM that period, not all-time
        if (parsed.sid && parsed.ts >= currentPeriodStart) {
          const existing = sessionCosts.get(parsed.sid);
          if (existing) {
            existing.cost += parsed.cost;
            if (parsed.ts > existing.timestamp) {
              existing.timestamp = parsed.ts;
            }
          } else {
            sessionCosts.set(parsed.sid, { cost: parsed.cost, timestamp: parsed.ts });
          }
        }

        // Track top turn (within current period, excluding internal sessions)
        if (parsed.ts >= currentPeriodStart && parsed.tid) {
          const isInternal = parsed.sid && isInternalSession(parsed.sid);
          if (!isInternal && (!topTurn || parsed.cost > topTurn.cost)) {
            topTurn = {
              turnId: parsed.tid,
              sessionId: parsed.sid ?? null,
              cost: parsed.cost,
              timestamp: parsed.ts,
            };
          }
        }
      } catch {
        // Skip malformed lines
      }
    }, {
      encoding: 'utf-8',
      crlfDelay: Number.POSITIVE_INFINITY,
    });
  } catch (err) {
    log.warn({ err, filePath }, 'Error reading cost ledger for insights');
    return emptyInsights;
  }

  // Find top session (excluding internal/automation sessions)
  // Note: sessionCosts already only contains entries from currentPeriod (filtered during aggregation)
  let topSession: TopSessionInfo | null = null;
  for (const [sessionId, data] of sessionCosts) {
    // Skip internal sessions - they don't appear in conversation history
    if (isInternalSession(sessionId)) continue;

    if (!topSession || data.cost > topSession.cost) {
      topSession = {
        sessionId,
        cost: data.cost,
        timestamp: data.timestamp,
      };
    }
  }

  // Convert daily costs map to sorted array and find peak
  const dailyCosts: DailyCost[] = Array.from(dailyCostsMap.entries())
    .map(([date, cost]) => ({ date, cost }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let peakDay: DailyCost | null = null;
  for (const day of dailyCosts) {
    if (!peakDay || day.cost > peakDay.cost) {
      peakDay = day;
    }
  }

  return {
    topSession,
    topTurn,
    currentPeriodCost,
    previousPeriodCost,
    currentPeriodTurnCount,
    peakDay,
    dailyCosts,
  };
};

/**
 * Get daily breakdown of costs from the ledger.
 *
 * Streams the ledger and aggregates costs, turns, and token counts by date.
 * Used for the Usage tab daily breakdown table and CSV export.
 *
 * Results are sorted by date descending (most recent first).
 *
 * @param options.startTs - Only include entries with ts >= this value
 * @param options.endTs - Only include entries with ts <= this value
 */
export const getDailyBreakdown = async (
  options?: DailyBreakdownOptions
): Promise<DailyBreakdownEntry[]> => {
  const filePath = getLedgerPath();

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const dailyMap = new Map<
    string,
    { cost: number; turns: number; totalEntries: number; inTok: number; outTok: number; cacheReadTok: number; cacheCreateTok: number }
  >();

  try {
    await readFileLines(filePath, (line) => {
      if (!line.trim()) return;

      try {
        const parsed: unknown = JSON.parse(line);
        if (!isValidEntry(parsed)) return;

        // Apply time range filters
        if (options?.startTs != null && parsed.ts < options.startTs) return;
        if (options?.endTs != null && parsed.ts > options.endTs) return;

        const dateStr = new Date(parsed.ts).toISOString().split('T')[0];
        const effectiveCategory = parsed.cat ?? 'agent';
        const isTurn =
          effectiveCategory === 'agent' || effectiveCategory === 'conversation';

        const existing = dailyMap.get(dateStr);
        if (existing) {
          existing.cost += parsed.cost;
          existing.totalEntries++;
          if (isTurn) existing.turns++;
          existing.inTok += parsed.inTok ?? 0;
          existing.outTok += parsed.outTok ?? 0;
          existing.cacheReadTok += parsed.cacheReadTok ?? 0;
          existing.cacheCreateTok += parsed.cacheCreateTok ?? 0;
        } else {
          dailyMap.set(dateStr, {
            cost: parsed.cost,
            turns: isTurn ? 1 : 0,
            totalEntries: 1,
            inTok: parsed.inTok ?? 0,
            outTok: parsed.outTok ?? 0,
            cacheReadTok: parsed.cacheReadTok ?? 0,
            cacheCreateTok: parsed.cacheCreateTok ?? 0,
          });
        }
      } catch {
        // Skip malformed lines
      }
    }, {
      encoding: 'utf-8',
      crlfDelay: Number.POSITIVE_INFINITY,
    });
  } catch (err) {
    log.warn({ err, filePath }, 'Error reading cost ledger for daily breakdown');
    return [];
  }

  // Convert to array, sorted by date descending
  return Array.from(dailyMap.entries())
    .map(([date, data]) => ({
      date,
      cost: data.cost,
      turns: data.turns,
      totalEntries: data.totalEntries,
      inTok: data.inTok,
      outTok: data.outTok,
      cacheReadTok: data.cacheReadTok,
      cacheCreateTok: data.cacheCreateTok,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
};
