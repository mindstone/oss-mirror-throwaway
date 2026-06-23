/**
 * Daily Spark Scheduler
 *
 * Hourly visibility-aware check that regenerates the Daily Spark batch when:
 * - the user's current week (computed against their local timezone) differs
 *   from the stored batch's `weekStartIso`, AND
 * - it is Monday and local time has reached the daily-refresh hour (08:00),
 *   AND
 * - the user's `dailySparkMode` is not 'off'.
 *
 * On-demand generation (`generateDailySparkNow`) bypasses Monday/hour gates
 * but still respects mode === 'off'.
 *
 * NO-LOG RULE: This file must never log spark `body` content. Format names,
 * ids, timing, errors are fine — spark text is not.
 *
 * @see docs/plans/260512_daily_spark.md
 */

import { createPausableInterval } from './visibilityAwareScheduler';
import {
  generateDailySparkBatch,
  type DailySparkServiceDeps,
} from '@core/services/dailySparkService';
import { addBatch, getCurrentBatch } from '@core/services/dailySparkStore';
import {
  computeWeekStartIso,
  isDailySparkBatchStale,
  isMonday,
  type DailySparkMode,
  type DailySparkWeeklyBatch,
  DEFAULT_DAILY_SPARK_MODE,
} from '@core/dailySparkTypes';
import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { CodexDisconnectedBtsError } from '@core/services/behindTheScenesClient';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'dailySparkScheduler' });

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 20_000;
const DAILY_REFRESH_HOUR = 8;

export interface DailySparkSchedulerDeps extends DailySparkServiceDeps {
  getSettings: () => AppSettings;
  broadcastDailySparkUpdated: () => void;
}

let deps: DailySparkSchedulerDeps | null = null;
let cleanup: (() => void) | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;

export function initializeDailySparkScheduler(d: DailySparkSchedulerDeps): void {
  deps = d;

  initialTimer = setTimeout(() => {
    initialTimer = null;
    fireAndForget(checkAndGenerate(), 'dailySparkScheduler.line59');
  }, INITIAL_DELAY_MS);

  cleanup = createPausableInterval(() => checkAndGenerate(), CHECK_INTERVAL_MS, {
    pauseOnBlur: true,
    catchUpPriority: 8,
  });
  log.info('Daily spark scheduler initialized');
}

export function shutdownDailySparkScheduler(): void {
  if (initialTimer !== null) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  cleanup?.();
  cleanup = null;
  deps = null;
  isRunning = false;
}

function getMode(settings: AppSettings): DailySparkMode {
  return settings.dailySparkMode ?? DEFAULT_DAILY_SPARK_MODE;
}

function localHour(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const value = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // `en-US` with hour12=false emits '24' at midnight on some engines.
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 0;
  return parsed === 24 ? 0 : parsed;
}

/** Whether the scheduled check should produce a new batch right now. */
export function shouldRegenerate(
  now: Date,
  tz: string,
  mode: DailySparkMode,
  currentBatch: DailySparkWeeklyBatch | null,
): boolean {
  if (mode === 'off') return false;
  if (!isMonday(now, tz)) return false;
  if (localHour(now, tz) < DAILY_REFRESH_HOUR) return false;
  return isDailySparkBatchStale(currentBatch?.weekStartIso ?? null, now, tz);
}

/**
 * On-demand generation triggered by user/dev/QA action.
 * Bypasses Monday/hour gates but respects `dailySparkMode === 'off'`.
 */
export async function generateDailySparkNow(): Promise<DailySparkWeeklyBatch | null> {
  if (!deps) return null;
  if (isRunning) return null;

  const settings = deps.getSettings();
  const mode = getMode(settings);
  if (mode === 'off') {
    log.info('On-demand daily spark skipped — mode is off');
    return null;
  }

  isRunning = true;
  try {
    const tz = deps.timeZone;
    const weekStartIso = computeWeekStartIso(new Date(), tz);
    const isFirstAppearance = getCurrentBatch() === null;

    log.info({ weekStartIso, isFirstAppearance }, 'On-demand daily spark generation requested');
    const batch = await generateDailySparkBatch(deps, settings, {
      weekStartIso,
      isFirstAppearance,
    });

    if (batch) {
      addBatch(batch);
      deps.broadcastDailySparkUpdated();
      log.info(
        { weekStartIso: batch.weekStartIso, toneGauge: batch.toneGauge, sparkCount: batch.sparks.length },
        'On-demand daily spark batch stored',
      );
    } else {
      log.warn('On-demand daily spark generation returned null');
    }
    return batch;
  } catch (error) {
    if (error instanceof CodexDisconnectedBtsError) {
      throw error;
    }
    log.error({ error }, 'On-demand daily spark generation failed');
    return null;
  } finally {
    isRunning = false;
  }
}

async function checkAndGenerate(): Promise<void> {
  if (isRunning || !deps) return;

  const settings = deps.getSettings();
  const mode = getMode(settings);
  if (mode === 'off') {
    log.debug('Daily spark scheduled check skipped — mode is off');
    return;
  }

  const now = new Date();
  const tz = deps.timeZone;
  const currentBatch = getCurrentBatch();

  if (!shouldRegenerate(now, tz, mode, currentBatch)) {
    log.debug(
      { mode, weekStartIso: currentBatch?.weekStartIso ?? null, hour: localHour(now, tz) },
      'Daily spark not due — skipping',
    );
    return;
  }

  isRunning = true;
  try {
    const weekStartIso = computeWeekStartIso(now, tz);
    const isFirstAppearance = currentBatch === null;
    log.info({ weekStartIso, isFirstAppearance }, 'Scheduled daily spark generation starting');
    const batch = await generateDailySparkBatch(deps, settings, { weekStartIso, isFirstAppearance });
    if (batch) {
      addBatch(batch);
      deps.broadcastDailySparkUpdated();
      log.info(
        { weekStartIso: batch.weekStartIso, toneGauge: batch.toneGauge, sparkCount: batch.sparks.length },
        'Scheduled daily spark batch stored',
      );
    } else {
      log.warn('Scheduled daily spark generation returned null — preserving previous batch');
    }
  } catch (error) {
    if (error instanceof CodexDisconnectedBtsError) {
      log.warn({ reason: 'codex-disconnected' }, 'Daily spark scheduled run blocked by Codex auth');
      return;
    }
    log.error({ error }, 'Scheduled daily spark generation failed');
  } finally {
    isRunning = false;
  }
}
