/**
 * Time Saved Store
 *
 * Persists time saved estimates and aggregates using electron-store.
 * Provides weekly/monthly aggregation for the dashboard.
 */

import type { KeyValueStore } from '@core/store';
import type { TimeSavedEstimate, TimeSavedTaskType, TopSessionInfo, ImpactLevel } from '@shared/types';
import { IMPACT_MULTIPLIERS } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { migrateStore, shouldEnterReadOnlyMode, type VersionedData, type MigrationFn, type MigrationResult } from '../utils/storeMigration';
import { loadStoreSafely, isLoadFailedReadOnly, resolveConfStorePath, safeCreateStore } from '../utils/loadStoreSafely';
import { getIncrementalSessionStore } from './incrementalSessionStore';

const log = createScopedLogger({ service: 'timeSavedStore' });

let timeSavedReadOnlyMode = false;

// ─────────────────────────────────────────────────────────────────────────────
// Midpoint Calculation Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get raw midpoint (unweighted) from an estimate.
 * Use for display thresholds and raw analytics.
 */
export const getRawMidpoint = (estimate: TimeSavedEstimate): number => {
  return (estimate.lowMinutes + estimate.highMinutes) / 2;
};

/**
 * Get weighted midpoint from an estimate, applying impact multiplier.
 * Use for aggregates and user-facing totals.
 */
export const getWeightedMidpoint = (estimate: TimeSavedEstimate): number => {
  const raw = getRawMidpoint(estimate);
  const impact = estimate.impact ?? 'unknown';
  const multiplier = IMPACT_MULTIPLIERS[impact] ?? 1.0;
  return raw * multiplier;
};

/**
 * Check if an estimate has high impact (critical or high).
 * Used for UI badge display.
 */
export const isHighImpact = (estimate: TimeSavedEstimate): boolean => {
  return estimate.impact === 'critical' || estimate.impact === 'high';
};

/**
 * Get the highest impact level from a list of entries.
 */
const getHighestImpact = (entries: TimeSavedEntry[]): ImpactLevel | undefined => {
  const impactPriority: ImpactLevel[] = ['critical', 'high', 'medium', 'low', 'trivial', 'unknown'];
  for (const level of impactPriority) {
    if (entries.some(e => (e.estimate.impact ?? 'unknown') === level)) {
      return level;
    }
  }
  return undefined;
};

export interface TimeSavedEntry {
  turnId: string;
  sessionId: string;
  estimate: TimeSavedEstimate;
  timestamp: number;
}

export interface WeeklyAggregate {
  weekStartDate: string; // ISO date string (Monday)
  totalMinutes: number;
  sessionCount: number;
}

export interface TimeSavedAggregates {
  currentWeek: WeeklyAggregate;
  lastWeek: WeeklyAggregate;
  currentMonth: { totalMinutes: number; sessionCount: number };
  allTime: { totalMinutes: number; sessionCount: number };
}

// Re-export TopSessionInfo for convenience (canonical definition in @shared/types)
export type { TopSessionInfo } from '@shared/types';

export type TimeSavedStoreState = {
  version: number;
  entries: TimeSavedEntry[];
  aggregates: TimeSavedAggregates;
  acknowledgedMilestones: number[]; // Minutes milestones user has seen (60, 600, 1440, etc.)
  hasSeenFirstEstimate: boolean;
  dailyTotals: Record<string, number>; // ISO date (YYYY-MM-DD) -> minutes
  firstBigWinShown: boolean; // Has 2h/day celebration been shown?
  firstWeekShown: boolean; // Has 5-day/5h celebration been shown?
  firstHighImpactShown?: boolean; // Has first high-impact toast been shown?
};

const getWeekStartDate = (date: Date = new Date()): string => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Monday start
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  // Use local date format (not toISOString which converts to UTC)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const getMonthStartDate = (date: Date = new Date()): string => {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  // Use local date format (not toISOString which converts to UTC)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const getLocalDateString = (timestamp: number): string => {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const createDefaultAggregates = (): TimeSavedAggregates => {
  const now = new Date();
  const lastWeek = new Date(now);
  lastWeek.setDate(lastWeek.getDate() - 7);
  
  return {
    currentWeek: { weekStartDate: getWeekStartDate(now), totalMinutes: 0, sessionCount: 0 },
    lastWeek: { weekStartDate: getWeekStartDate(lastWeek), totalMinutes: 0, sessionCount: 0 },
    currentMonth: { totalMinutes: 0, sessionCount: 0 },
    allTime: { totalMinutes: 0, sessionCount: 0 }
  };
};

const CURRENT_STORE_VERSION = 3;
const MAX_TIME_SAVED_ENTRIES = 5000;

const createDefaultState = (): TimeSavedStoreState => ({
  version: CURRENT_STORE_VERSION,
  entries: [],
  aggregates: createDefaultAggregates(),
  acknowledgedMilestones: [],
  hasSeenFirstEstimate: false,
  dailyTotals: {},
  firstBigWinShown: false,
  firstWeekShown: false
});

// Migration from v1 to v2: Add dailyTotals, firstBigWinShown, firstWeekShown
const migrateV1ToV2: MigrationFn<TimeSavedStoreState> = (data) => {
  const entries = data.entries ?? [];
  const dailyTotals: Record<string, number> = {};
  
  for (const entry of entries) {
    const date = getLocalDateString(entry.timestamp);
    const midpoint = (entry.estimate.lowMinutes + entry.estimate.highMinutes) / 2;
    dailyTotals[date] = (dailyTotals[date] ?? 0) + midpoint;
  }
  
  return {
    ...data,
    version: 2,
    dailyTotals,
    firstBigWinShown: false,
    firstWeekShown: false
  };
};

// Migration from v2 to v3: Add impact field to existing entries (default: 'unknown' @ 1.0x)
const migrateV2ToV3: MigrationFn<TimeSavedStoreState> = (data) => {
  const entries = (data.entries ?? []).map(entry => ({
    ...entry,
    estimate: {
      ...entry.estimate,
      // Existing entries get 'unknown' impact, which has 1.0x multiplier
      // This preserves historical totals exactly
      impact: entry.estimate.impact ?? 'unknown' as const
    }
  }));
  
  return {
    ...data,
    version: 3,
    entries
  };
};

// IMPORTANT: Migration keys are SOURCE versions (fromVersion), not target versions
// e.g., key 1 = migration from v1 to v2, key 2 = migration from v2 to v3
const TIME_SAVED_MIGRATIONS: Record<number, MigrationFn<TimeSavedStoreState>> = {
  1: migrateV1ToV2,
  2: migrateV2ToV3
};

let _timeSavedStore: KeyValueStore<TimeSavedStoreState> | null = null;
let _timeSavedStoreInitialized = false;
const getTimeSavedStore = (): KeyValueStore<TimeSavedStoreState> => {
  if (!_timeSavedStore) {
    // Guard CONSTRUCTION: conf throws at construct time on a corrupt file.
    const created = safeCreateStore<TimeSavedStoreState>(
      { name: 'time-saved', defaults: createDefaultState() },
      createDefaultState(),
    );
    _timeSavedStore = created.store;
    if (created.loadFailed) {
      timeSavedReadOnlyMode = true;
      _timeSavedStoreInitialized = true;
    }
  }
  if (!_timeSavedStoreInitialized) {
    _timeSavedStoreInitialized = true;
    const store = _timeSavedStore;
    // Guard the `.store` read + migrate: a thrown load (corrupt JSON / schema /
    // decrypt / transient IO) must NEVER reset+persist over real data — and must
    // not crash init. Classify ENOENT (fresh init) vs existing-but-unreadable
    // (preserve raw + back up + latch read-only).
    const guarded = loadStoreSafely<MigrationResult<VersionedData>>(
      'time-saved',
      resolveConfStorePath('time-saved'),
      () =>
        migrateStore(store.store as VersionedData, {
          storeName: 'time-saved',
          currentVersion: CURRENT_STORE_VERSION,
          migrations: TIME_SAVED_MIGRATIONS as unknown as Record<number, MigrationFn<VersionedData>>,
          createDefault: createDefaultState as () => VersionedData
        }), // path resolved independently below
      // Consumed only on `absent` (genuine fresh init → writable); `load-failed`
      // short-circuits before reading shouldPersist.
      () => ({
        data: createDefaultState() as unknown as VersionedData,
        status: 'fresh' as const,
        fromVersion: null,
        toVersion: CURRENT_STORE_VERSION,
        backupPath: null,
        shouldPersist: true,
      }),
    );

    if (isLoadFailedReadOnly(guarded)) {
      timeSavedReadOnlyMode = true;
    } else {
      const migrationResult = guarded.data;
      if (migrationResult.shouldPersist && migrationResult.status !== 'future_version') {
        store.store = migrationResult.data as TimeSavedStoreState;
        log.info(
          { status: migrationResult.status, fromVersion: migrationResult.fromVersion, toVersion: migrationResult.toVersion },
          'Time saved store initialized'
        );
      }

      // Read-only on future_version AND corrupted (in-memory defaults; real data
      // preserved on disk — block later writes so they can't clobber it).
      timeSavedReadOnlyMode = shouldEnterReadOnlyMode(migrationResult);
      if (migrationResult.status === 'future_version') {
        log.warn(
          { dataVersion: migrationResult.fromVersion, currentVersion: CURRENT_STORE_VERSION },
          'Time saved data from newer version, entering read-only mode'
        );
      }
    }
  }
  return _timeSavedStore;
};

/**
 * Read-only check that GUARANTEES the store has loaded/migrated first.
 *
 * `timeSavedReadOnlyMode` defaults to `false` and is only set during
 * `getTimeSavedStore()`'s one-time init. A writer that reads the bare flag as
 * the FIRST touch (no prior read) would see a stale `false` and bypass the
 * corrupted/future-version guard, clobbering real on-disk data. Forcing init
 * here (which sets the flag) before returning it makes every guard
 * first-touch-safe by construction. Use this in EVERY writer instead of the
 * raw flag.
 */
const isTimeSavedReadOnly = (): boolean => {
  getTimeSavedStore();
  return timeSavedReadOnlyMode;
};

/**
 * Get IDs of all deleted sessions from the session store.
 * Used to exclude deleted sessions from time-saved calculations.
 */
const getDeletedSessionIds = (): Set<string> => {
  try {
    // Time-saved aggregates are user-facing; keep the default filtered view.
    const sessions = getIncrementalSessionStore().listSessions();
    const deletedIds = new Set<string>();
    for (const session of sessions) {
      if (session.deletedAt) {
        deletedIds.add(session.id);
      }
    }
    return deletedIds;
  } catch (error) {
    log.warn({ error }, 'Failed to get deleted session IDs, returning empty set');
    return new Set();
  }
};

/**
 * Filter entries to exclude those from deleted sessions.
 */
const filterOutDeletedSessions = (entries: TimeSavedEntry[]): TimeSavedEntry[] => {
  const deletedIds = getDeletedSessionIds();
  if (deletedIds.size === 0) return entries;
  return entries.filter(entry => !deletedIds.has(entry.sessionId));
};

const recalculateAggregates = (entries: TimeSavedEntry[]): TimeSavedAggregates => {
  const now = new Date();
  const currentWeekStart = getWeekStartDate(now);
  const lastWeekDate = new Date(now);
  lastWeekDate.setDate(lastWeekDate.getDate() - 7);
  const lastWeekStart = getWeekStartDate(lastWeekDate);
  const currentMonthStart = getMonthStartDate(now);

  const aggregates = createDefaultAggregates();

  for (const entry of entries) {
    const entryDate = new Date(entry.timestamp);
    const entryWeekStart = getWeekStartDate(entryDate);
    const entryMonthStart = getMonthStartDate(entryDate);
    // Use weighted midpoint for aggregates (impact-adjusted)
    const midpoint = getWeightedMidpoint(entry.estimate);

    // All time
    aggregates.allTime.totalMinutes += midpoint;
    aggregates.allTime.sessionCount += 1;

    // Current week
    if (entryWeekStart === currentWeekStart) {
      aggregates.currentWeek.totalMinutes += midpoint;
      aggregates.currentWeek.sessionCount += 1;
    }

    // Last week
    if (entryWeekStart === lastWeekStart) {
      aggregates.lastWeek.totalMinutes += midpoint;
      aggregates.lastWeek.sessionCount += 1;
    }

    // Current month
    if (entryMonthStart === currentMonthStart) {
      aggregates.currentMonth.totalMinutes += midpoint;
      aggregates.currentMonth.sessionCount += 1;
    }
  }

  return aggregates;
};

/**
 * Result of an attempted entry write. Live callers (the BTS-driven estimator)
 * can ignore this; the backfill service uses it to keep an accurate per-turn
 * outcome ledger so a re-run is safe and idempotent.
 */
export type AddTimeSavedEntryResult =
  | { added: true; timestamp: number }
  | { added: false; reason: 'read_only' | 'duplicate' };

interface AddTimeSavedEntryOptions {
  /**
   * Backfill/recovery callers pass the original turn timestamp so that the
   * resulting entry lands in the correct weekly/monthly bucket. Live calls
   * (the default fire-and-forget path) omit this and default to `Date.now()`.
   */
  timestamp?: number;
  /**
   * Tagged in debug logs so backfill writes can be distinguished from live
   * writes when triaging.
   */
  source?: 'live' | 'backfill';
}

const writeTimeSavedEntry = (
  turnId: string,
  sessionId: string,
  estimate: TimeSavedEstimate,
  options: AddTimeSavedEntryOptions = {},
): AddTimeSavedEntryResult => {
  // `isTimeSavedReadOnly()` forces load/migration first so a first-touch write
  // (no prior read) sees the correct flag, not a stale `false`.
  if (isTimeSavedReadOnly()) {
    log.debug('Time saved store in read-only mode, skipping entry');
    return { added: false, reason: 'read_only' };
  }
  const state = getTimeSavedStore().store;

  // Per-turn dedup: an entry already exists for this turnId. This is the
  // safety net that makes backfill idempotent — re-running the backfill
  // script will not double-count any turn the estimator has already covered
  // (whether that was a forward run or an earlier backfill pass).
  if (state.entries.some((existing) => existing.turnId === turnId)) {
    log.debug({ turnId, sessionId, source: options.source ?? 'live' }, 'Time saved entry already exists for turn, skipping');
    return { added: false, reason: 'duplicate' };
  }

  const timestamp = options.timestamp ?? Date.now();
  const entry: TimeSavedEntry = {
    turnId,
    sessionId,
    estimate,
    timestamp,
  };

  const entries = [...state.entries, entry];
  // Keep a generous bound to prevent unbounded growth without corrupting the
  // all-time metric. The previous 1000-entry cap was too low once backfill
  // recovered missed turns, and could silently drop older all-time history.
  const trimmedEntries = entries.slice(-MAX_TIME_SAVED_ENTRIES);

  const aggregates = recalculateAggregates(trimmedEntries);

  // Update daily totals using the *entry's* timestamp, not Date.now(). For
  // backfill this is critical: a recovered entry from last Tuesday must
  // bucket into last Tuesday, not today. Daily-totals pruning still anchors
  // on today so old buckets outside the 90-day window remain pruned.
  const entryDate = getLocalDateString(timestamp);
  const rawMidpoint = getRawMidpoint(estimate);
  const dailyTotals = {
    ...state.dailyTotals,
    [entryDate]: (state.dailyTotals[entryDate] ?? 0) + rawMidpoint,
  };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 90);
  const cutoffStr = getLocalDateString(cutoffDate.getTime());
  const prunedDailyTotals: Record<string, number> = {};
  for (const [date, minutes] of Object.entries(dailyTotals)) {
    if (date >= cutoffStr) {
      prunedDailyTotals[date] = minutes;
    }
  }

  getTimeSavedStore().store = {
    ...state,
    entries: trimmedEntries,
    aggregates,
    dailyTotals: prunedDailyTotals,
    hasSeenFirstEstimate: true,
  };

  log.debug(
    { turnId, sessionId, rawMidpoint, entryDate, source: options.source ?? 'live' },
    'Added time saved entry',
  );

  return { added: true, timestamp };
};

export const addTimeSavedEntry = (
  turnId: string,
  sessionId: string,
  estimate: TimeSavedEstimate
): AddTimeSavedEntryResult => {
  // Fire-and-forget for the live BTS path, but the result is now propagated so
  // the analytics emit can fire ONLY on a persisted write (added: true) — a
  // duplicate/read-only rejection must not emit a `Time Saved Estimated` event,
  // preserving the one-event-per-persisted-turn guardrail. Callers that don't
  // care can still ignore the return value.
  return writeTimeSavedEntry(turnId, sessionId, estimate, { source: 'live' });
};

/**
 * Timestamp-preserving recovery write. Used by the time-saved backfill service
 * to replay missed estimates from prior weeks while keeping the original turn
 * timestamp so weekly/monthly aggregates and daily totals stay correct.
 *
 * Returns a result describing whether the entry was added or skipped. Skipped
 * outcomes (`duplicate`, `read_only`) are non-errors — backfill expects them
 * during re-runs and during version-protected periods.
 *
 * See `docs-private/investigations/260520_time_saved_zero_or_missing.md`.
 */
export const addTimeSavedEntryAt = (
  turnId: string,
  sessionId: string,
  estimate: TimeSavedEstimate,
  timestamp: number,
): AddTimeSavedEntryResult => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    log.warn({ turnId, sessionId, timestamp }, 'Refusing addTimeSavedEntryAt with non-finite/non-positive timestamp');
    return { added: false, reason: 'duplicate' };
  }
  return writeTimeSavedEntry(turnId, sessionId, estimate, { timestamp, source: 'backfill' });
};

/**
 * Lookup helper used by the backfill scanner so it can avoid re-estimating
 * turns already represented in the store. Returns true if any entry has the
 * given turnId. Cheap O(N) scan — fine for the ~hundreds-to-low-thousands
 * entry counts we expect.
 */
export const hasTimeSavedEntryForTurn = (turnId: string): boolean => {
  const { entries } = getTimeSavedStore().store;
  return entries.some((entry) => entry.turnId === turnId);
};

/**
 * Most recent persisted entry timestamp, or null if the store is empty.
 * The backfill scanner defaults its lower-bound cutoff to this value so a
 * re-run after a successful backfill only looks at turns newer than what
 * was already recovered.
 */
export const getLatestEntryTimestamp = (): number | null => {
  const { entries } = getTimeSavedStore().store;
  if (entries.length === 0) return null;
  let latest = entries[0].timestamp;
  for (const entry of entries) {
    if (entry.timestamp > latest) latest = entry.timestamp;
  }
  return latest;
};

export const getTimeSavedAggregates = (): TimeSavedAggregates => {
  const state = getTimeSavedStore().store;
  
  // Filter out deleted sessions - they shouldn't count toward time saved
  const activeEntries = filterOutDeletedSessions(state.entries);
  
  // Recalculate in case week/month has changed since last update
  const aggregates = recalculateAggregates(activeEntries);
  
  return aggregates;
};

export const getTimeSavedState = (): TimeSavedStoreState => {
  return getTimeSavedStore().store;
};

export const acknowledgeMilestone = (minutes: number): void => {
  if (isTimeSavedReadOnly()) return;
  const state = getTimeSavedStore().store;
  if (!state.acknowledgedMilestones.includes(minutes)) {
    getTimeSavedStore().store = {
      ...state,
      acknowledgedMilestones: [...state.acknowledgedMilestones, minutes]
    };
    log.info({ minutes }, 'Milestone acknowledged');
  }
};

// Milestones in minutes: 1h, 10h, 1day, 50h, 100h, 1week, 1month, 1year, 10years
const MILESTONES = [60, 600, 1440, 3000, 6000, 10080, 43200, 525600, 5256000];

export const getNextUnacknowledgedMilestone = (): number | null => {
  const state = getTimeSavedStore().store;
  const aggregates = getTimeSavedAggregates();
  const totalMinutes = aggregates.allTime.totalMinutes;
  
  for (const milestone of MILESTONES) {
    if (totalMinutes >= milestone && !state.acknowledgedMilestones.includes(milestone)) {
      return milestone;
    }
  }
  
  return null;
};

export const getTimeSavedBySession = (): Record<string, number> => {
  const { entries } = getTimeSavedStore().store;
  const activeEntries = filterOutDeletedSessions(entries);
  const bySession: Record<string, number> = {};
  
  for (const entry of activeEntries) {
    const midpoint = getWeightedMidpoint(entry.estimate);
    bySession[entry.sessionId] = (bySession[entry.sessionId] ?? 0) + midpoint;
  }
  
  return bySession;
};

/**
 * Get time saved summary for a specific session.
 * Returns total weighted midpoint minutes and highest impact level.
 * Used by community share to evaluate eligibility.
 */
export const getSessionTimeSavedSummary = (sessionId: string): { totalMinutes: number; highestImpact: ImpactLevel | undefined } => {
  const { entries } = getTimeSavedStore().store;
  const sessionEntries = entries.filter(e => e.sessionId === sessionId);
  
  if (sessionEntries.length === 0) {
    return { totalMinutes: 0, highestImpact: undefined };
  }
  
  let totalMinutes = 0;
  for (const entry of sessionEntries) {
    totalMinutes += getWeightedMidpoint(entry.estimate);
  }
  
  const highestImpact = getHighestImpact(sessionEntries);
  
  return { totalMinutes, highestImpact };
};

export const hasSeenFirstEstimate = (): boolean => {
  return getTimeSavedStore().store.hasSeenFirstEstimate;
};

export const getTrackingSince = (): number | null => {
  const { entries } = getTimeSavedStore().store;
  const activeEntries = filterOutDeletedSessions(entries);
  if (activeEntries.length === 0) return null;
  
  // Find the earliest entry timestamp from non-deleted sessions
  let earliest = activeEntries[0].timestamp;
  for (const entry of activeEntries) {
    if (entry.timestamp < earliest) {
      earliest = entry.timestamp;
    }
  }
  return earliest;
};

export const markFirstEstimateSeen = (): void => {
  if (isTimeSavedReadOnly()) return;
  const state = getTimeSavedStore().store;
  if (!state.hasSeenFirstEstimate) {
    getTimeSavedStore().store = { ...state, hasSeenFirstEstimate: true };
  }
};

export type WeeklyTrend = 'up' | 'steady' | null;

export const calculateWeeklyTrend = (): WeeklyTrend => {
  const aggregates = getTimeSavedAggregates();
  const { currentWeek, lastWeek } = aggregates;
  
  if (lastWeek.totalMinutes === 0) {
    return null; // No data to compare
  }
  
  // Prorate last week's total based on current day of week
  const now = new Date();
  const dayOfWeek = now.getDay() || 7; // 1-7 (Mon-Sun)
  const proratedLastWeek = (lastWeek.totalMinutes / 7) * dayOfWeek;
  
  if (currentWeek.totalMinutes > proratedLastWeek * 1.1) {
    return 'up';
  }
  if (currentWeek.totalMinutes >= proratedLastWeek * 0.9) {
    return 'steady';
  }
  
  // Behind pace - don't show negative indicator
  return null;
};

// --- Milestone Celebration Helpers ---

export const getTodayMinutes = (): number => {
  const state = getTimeSavedStore().store;
  const activeEntries = filterOutDeletedSessions(state.entries);
  const today = getLocalDateString(Date.now());
  
  // Calculate today's minutes from active entries only (excluding deleted sessions)
  let todayMinutes = 0;
  for (const entry of activeEntries) {
    const entryDate = getLocalDateString(entry.timestamp);
    if (entryDate === today) {
      const midpoint = getWeightedMidpoint(entry.estimate);
      todayMinutes += midpoint;
    }
  }
  return todayMinutes;
};

export const getCurrentWeekDailyTotals = (): Record<string, number> => {
  const state = getTimeSavedStore().store;
  const activeEntries = filterOutDeletedSessions(state.entries);
  const now = new Date();
  const weekStartStr = getWeekStartDate(now);
  // Parse as local time (not UTC) by appending time component
  const weekStartDate = new Date(weekStartStr + 'T00:00:00');
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setDate(weekEndDate.getDate() + 7);

  // Calculate daily totals from active entries only (excluding deleted sessions)
  const activeDailyTotals: Record<string, number> = {};
  for (const entry of activeEntries) {
    const entryDate = new Date(entry.timestamp);
    if (entryDate >= weekStartDate && entryDate < weekEndDate) {
      const dateStr = getLocalDateString(entry.timestamp);
      const midpoint = getWeightedMidpoint(entry.estimate);
      activeDailyTotals[dateStr] = (activeDailyTotals[dateStr] ?? 0) + midpoint;
    }
  }

  const result: Record<string, number> = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStartDate);
    d.setDate(d.getDate() + i);
    const dateStr = getLocalDateString(d.getTime());
    result[dateStr] = activeDailyTotals[dateStr] ?? 0;
  }
  return result;
};

export const getDaysSinceFirstUse = (): number => {
  const firstUse = getTrackingSince();
  if (!firstUse) return 0;
  const now = Date.now();
  const diffMs = now - firstUse;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
};

export const shouldShowFirstBigWin = (): boolean => {
  const state = getTimeSavedStore().store;
  if (state.firstBigWinShown) return false;
  const todayMinutes = getTodayMinutes();
  return todayMinutes >= 120; // 2 hours
};

export const shouldShowFirstWeek = (): boolean => {
  const state = getTimeSavedStore().store;
  if (state.firstWeekShown) return false;
  const days = getDaysSinceFirstUse();
  // Use filtered aggregates to exclude deleted sessions
  const aggregates = getTimeSavedAggregates();
  const totalMinutes = aggregates.allTime.totalMinutes;
  return days >= 5 && totalMinutes >= 300; // 5 days AND 5 hours
};

export const markFirstBigWinShown = (): void => {
  if (isTimeSavedReadOnly()) return;
  const state = getTimeSavedStore().store;
  if (!state.firstBigWinShown) {
    getTimeSavedStore().store = { ...state, firstBigWinShown: true };
    log.info('First big win celebration marked as shown');
  }
};

export const markFirstWeekShown = (): void => {
  if (isTimeSavedReadOnly()) return;
  const state = getTimeSavedStore().store;
  if (!state.firstWeekShown) {
    getTimeSavedStore().store = { ...state, firstWeekShown: true };
    log.info('First week celebration marked as shown');
  }
};

export const shouldShowFirstHighImpact = (): boolean => {
  const state = getTimeSavedStore().store;
  return !state.firstHighImpactShown;
};

export const markFirstHighImpactShown = (): void => {
  if (isTimeSavedReadOnly()) return;
  const state = getTimeSavedStore().store;
  if (!state.firstHighImpactShown) {
    getTimeSavedStore().store = { ...state, firstHighImpactShown: true };
    log.info('First high-impact toast marked as shown');
  }
};

// --- Top Sessions Helpers ---

/**
 * Aggregates entries by sessionId and returns top sessions by total minutes.
 * For taskType and reasoning, uses values from the largest-minute entry for that session.
 */
const aggregateTopSessions = (entries: TimeSavedEntry[], limit: number): TopSessionInfo[] => {
  // Group entries by session first (for highestImpact calculation)
  const entriesBySession = new Map<string, TimeSavedEntry[]>();
  for (const entry of entries) {
    const existing = entriesBySession.get(entry.sessionId) ?? [];
    existing.push(entry);
    entriesBySession.set(entry.sessionId, existing);
  }

  // Track aggregate data per session
  const sessionMap = new Map<string, {
    totalMinutes: number;
    entryCount: number;
    largestEntryMinutes: number;
    largestEntryTaskType: TimeSavedTaskType;
    largestEntryReasoning: string | undefined;
    largestEntryReasoningDetail: string | undefined;
    largestEntryTimestamp: number; // For tie-breaking: use most recent
    latestTimestamp: number; // Most recent entry timestamp (for display)
    highestImpact: ImpactLevel | undefined;
  }>();

  for (const entry of entries) {
    const midpoint = getWeightedMidpoint(entry.estimate);
    const existing = sessionMap.get(entry.sessionId);

    if (!existing) {
      const sessionEntries = entriesBySession.get(entry.sessionId) ?? [];
      sessionMap.set(entry.sessionId, {
        totalMinutes: midpoint,
        entryCount: 1,
        largestEntryMinutes: midpoint,
        largestEntryTaskType: entry.estimate.taskType,
        largestEntryReasoning: entry.estimate.reasoning,
        largestEntryReasoningDetail: entry.estimate.reasoningDetail,
        largestEntryTimestamp: entry.timestamp,
        latestTimestamp: entry.timestamp,
        highestImpact: getHighestImpact(sessionEntries)
      });
    } else {
      existing.totalMinutes += midpoint;
      existing.entryCount += 1;
      
      // Track the most recent timestamp across all entries
      if (entry.timestamp > existing.latestTimestamp) {
        existing.latestTimestamp = entry.timestamp;
      }
      
      // Update largest entry: prefer higher minutes, or if tied, most recent
      if (midpoint > existing.largestEntryMinutes || 
          (midpoint === existing.largestEntryMinutes && entry.timestamp > existing.largestEntryTimestamp)) {
        existing.largestEntryMinutes = midpoint;
        existing.largestEntryTaskType = entry.estimate.taskType;
        existing.largestEntryReasoning = entry.estimate.reasoning;
        existing.largestEntryReasoningDetail = entry.estimate.reasoningDetail;
        existing.largestEntryTimestamp = entry.timestamp;
      }
    }
  }

  // Convert to array and sort by totalMinutes descending
  const sorted = Array.from(sessionMap.entries())
    .map(([sessionId, data]) => ({
      sessionId,
      totalMinutes: data.totalMinutes,
      taskType: data.largestEntryTaskType,
      reasoning: data.largestEntryReasoning,
      reasoningDetail: data.largestEntryReasoningDetail,
      entryCount: data.entryCount,
      latestTimestamp: data.latestTimestamp,
      highestImpact: data.highestImpact
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes);

  return sorted.slice(0, limit);
};

/**
 * Get top sessions for the current week, sorted by total minutes saved.
 * Uses the same week bucketing as dailyTotals for consistency.
 * Excludes soft-deleted sessions. Note: orphaned sessions (hard-deleted or system)
 * may still be returned - UI should filter these by checking session existence.
 * We over-fetch (3x limit) to ensure enough valid sessions remain after UI filtering.
 */
export const getWeekTopSessions = (limit = 5): TopSessionInfo[] => {
  const { entries } = getTimeSavedStore().store;
  const activeEntries = filterOutDeletedSessions(entries);
  const now = new Date();
  const currentWeekStart = getWeekStartDate(now);

  // Filter to current week entries
  const weekEntries = activeEntries.filter(entry => {
    const entryWeekStart = getWeekStartDate(new Date(entry.timestamp));
    return entryWeekStart === currentWeekStart;
  });

  // Over-fetch to account for orphaned sessions that will be filtered in UI
  return aggregateTopSessions(weekEntries, limit * 3);
};

/**
 * Get top sessions for a specific day, sorted by total minutes saved.
 * Uses the same date bucketing as dailyTotals for consistency.
 * Excludes soft-deleted sessions. Note: orphaned sessions (hard-deleted or system)
 * may still be returned - UI should filter these by checking session existence.
 * We over-fetch (3x limit) to ensure enough valid sessions remain after UI filtering.
 * @param date - Date string in YYYY-MM-DD format (local time)
 */
export const getDayTopSessions = (date: string, limit = 3): TopSessionInfo[] => {
  const { entries } = getTimeSavedStore().store;
  const activeEntries = filterOutDeletedSessions(entries);

  // Filter to entries matching the given date
  const dayEntries = activeEntries.filter(entry => {
    const entryDate = getLocalDateString(entry.timestamp);
    return entryDate === date;
  });

  // Over-fetch to account for orphaned sessions that will be filtered in UI
  return aggregateTopSessions(dayEntries, limit * 3);
};
