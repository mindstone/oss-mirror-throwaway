/**
 * Daily Spark Store
 *
 * Persists weekly Daily Spark batches and user feedback counts.
 * Capped at MAX_DAILY_SPARK_BATCHES (4) batches, newest first.
 *
 * NO-LOG RULE: This file must never log a spark `body` or `captionOverride`.
 * Format names, ids, timing, and counts are fine — spark text is not.
 *
 * @see docs/plans/260512_daily_spark.md
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import {
  computeWeekStartIso,
  MAX_DAILY_SPARK_BATCHES,
  type DailySpark,
  type DailySparkFormat,
  type DailySparkStoreState,
  type DailySparkWeeklyBatch,
  type FormatFeedbackCounts,
} from '@core/dailySparkTypes';

const log = createScopedLogger({ service: 'dailySparkStore' });

const createDefaultState = (): DailySparkStoreState => ({
  batches: [],
  formatFeedback: {},
});

let _store: KeyValueStore<DailySparkStoreState> | null = null;

function getStore(): KeyValueStore<DailySparkStoreState> {
  if (!_store) {
    _store = createStore<DailySparkStoreState>({
      name: 'daily-spark',
      defaults: createDefaultState(),
    });
  }
  return _store;
}

function readBatches(): DailySparkWeeklyBatch[] {
  return getStore().get('batches') ?? [];
}

function writeBatches(batches: DailySparkWeeklyBatch[]): void {
  getStore().set('batches', batches);
}

function readFormatFeedback(): FormatFeedbackCounts {
  return getStore().get('formatFeedback') ?? {};
}

function writeFormatFeedback(counts: FormatFeedbackCounts): void {
  getStore().set('formatFeedback', counts);
}

/** Returns the most recent batch (newest first), or null if none stored. */
export function getCurrentBatch(): DailySparkWeeklyBatch | null {
  const batches = readBatches();
  return batches.length > 0 ? batches[0] : null;
}

/** Locate the spark whose `dayIso` matches the supplied date in the current batch. */
export function getTodaySpark(
  now: Date,
  tz: string,
): { spark: DailySpark | null; isFirstAppearance: boolean } {
  const current = getCurrentBatch();
  if (!current) return { spark: null, isFirstAppearance: false };

  const weekStart = computeWeekStartIso(now, tz);
  if (current.weekStartIso !== weekStart) {
    return { spark: null, isFirstAppearance: false };
  }

  const todayIso = formatLocalIsoDate(now, tz);
  const match = current.sparks.find(
    (s) => s.dayIso === todayIso && s.dismissedAt === undefined,
  );

  return {
    spark: match ?? null,
    isFirstAppearance: current.isFirstAppearanceWeek,
  };
}

/** Prepend a new batch and cap retention. Older duplicate weekStartIso entries are dropped. */
export function addBatch(batch: DailySparkWeeklyBatch): void {
  const existing = readBatches().filter((b) => b.weekStartIso !== batch.weekStartIso);
  const next = [batch, ...existing].slice(0, MAX_DAILY_SPARK_BATCHES);
  writeBatches(next);
  log.info(
    {
      weekStartIso: batch.weekStartIso,
      sparkCount: batch.sparks.length,
      toneGauge: batch.toneGauge,
      sourceModel: batch.sourceModel,
      promptVersion: batch.promptVersion,
      totalBatches: next.length,
    },
    'Added daily spark batch',
  );
}

/** Stamp `revealedAt` on the matching spark if found in the current batch. */
export function markRevealed(sparkId: string): void {
  const batches = readBatches();
  if (batches.length === 0) return;

  const current = batches[0];
  let mutated = false;
  const updatedSparks = current.sparks.map((s) => {
    if (s.id !== sparkId || s.revealedAt !== undefined) return s;
    mutated = true;
    return { ...s, revealedAt: Date.now() };
  });

  if (!mutated) return;

  batches[0] = { ...current, sparks: updatedSparks };
  writeBatches(batches);
  log.info({ sparkId, weekStartIso: current.weekStartIso }, 'Marked daily spark revealed');
}

/** Dismiss today's spark only (no future days affected). */
export function dismissToday(sparkId: string): boolean {
  const batches = readBatches();
  if (batches.length === 0) return false;

  const current = batches[0];
  let mutated = false;
  const updatedSparks = current.sparks.map((s) => {
    if (s.id !== sparkId || s.dismissedAt !== undefined) return s;
    mutated = true;
    return { ...s, dismissedAt: Date.now() };
  });

  if (!mutated) return false;

  batches[0] = { ...current, sparks: updatedSparks };
  writeBatches(batches);
  log.info({ sparkId, weekStartIso: current.weekStartIso }, 'Dismissed daily spark for today');
  return true;
}

/**
 * Stamp `less_like_this` feedback on the matching spark and increment the
 * format counter. Spark text is never read or logged here.
 */
export function recordLessLikeThis(sparkId: string): boolean {
  const batches = readBatches();
  if (batches.length === 0) return false;

  const current = batches[0];
  const target = current.sparks.find(
    (s) => s.id === sparkId && s.feedback !== 'less_like_this',
  );
  if (!target) return false;

  const format: DailySparkFormat = target.format;
  const updatedSparks = current.sparks.map((s) =>
    s.id === sparkId && s.feedback !== 'less_like_this'
      ? { ...s, feedback: 'less_like_this' as const }
      : s,
  );

  batches[0] = { ...current, sparks: updatedSparks };
  writeBatches(batches);

  const counts: FormatFeedbackCounts = { ...readFormatFeedback() };
  const currentCount = counts[format] ?? 0;
  counts[format] = currentCount + 1;
  writeFormatFeedback(counts);

  log.info(
    { sparkId, format, weekStartIso: current.weekStartIso, newCount: counts[format] },
    'Recorded less_like_this feedback',
  );
  return true;
}

/** Read the format feedback counters. */
export function getFormatFeedback(): FormatFeedbackCounts {
  return { ...readFormatFeedback() };
}

/** Reset module-level cache. Test helper. */
export function _resetStore(): void {
  _store = null;
}

// ---------------------------------------------------------------------------
// Local helpers (kept private to the store)
// ---------------------------------------------------------------------------

function formatLocalIsoDate(date: Date, tz: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
