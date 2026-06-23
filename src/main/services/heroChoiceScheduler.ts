/**
 * Hero Choice Scheduler
 *
 * Runs a once-daily Hero Choice LLM call to produce ranked recommendations.
 * Uses a 1-hour check interval with visibility-aware pausing.
 *
 * Staleness logic:
 * - No previous result → stale (first run)
 * - Last result before 8AM today and it's now past 8AM → stale (daily refresh)
 * - Last result >12h old → stale (catch-up for apps closed overnight)
 *
 * On failure: logs error, preserves last successful result, retries next interval.
 *
 * @see docs/plans/260315_spark_redesign.md
 */

import { createPausableInterval } from './visibilityAwareScheduler';
import { generateHeroChoice } from '@core/services/heroChoiceService';
import { addHeroChoiceEntry, getCurrentHeroChoice, dismissExpiredMeetingPrep } from '@core/services/heroChoiceStore';
import { isHeroChoiceStale } from '@core/heroChoiceTypes';
import type { HeroChoiceContextDeps } from '@core/services/heroChoiceContextAssembler';
import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { CodexDisconnectedBtsError } from '@core/services/behindTheScenesClient';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'heroChoiceScheduler' });

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 15_000; // 15 seconds after startup

export interface HeroChoiceSchedulerDeps extends HeroChoiceContextDeps {
  getSettings: () => AppSettings;
  broadcastHeroChoiceUpdated: () => void;
}

let deps: HeroChoiceSchedulerDeps | null = null;
let cleanup: (() => void) | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;

/**
 * Re-export for backward compatibility with tests that import from the scheduler.
 * Canonical implementation lives in `@core/heroChoiceTypes`.
 */
export const isStale = isHeroChoiceStale;

export function initializeHeroChoiceScheduler(d: HeroChoiceSchedulerDeps): void {
  deps = d;

  // Initial check after short delay (let app fully start)
  initialTimer = setTimeout(() => {
    initialTimer = null;
    fireAndForget(checkAndGenerate(), 'heroChoiceScheduler.line53');
  }, INITIAL_DELAY_MS);

  // Periodic check (pauses when app hidden, catch-up on visible)
  cleanup = createPausableInterval(() => checkAndGenerate(), CHECK_INTERVAL_MS, { pauseOnBlur: true, catchUpPriority: 7 });
  log.info('Hero choice scheduler initialized');
}

/**
 * Check for and auto-dismiss expired meeting_prep candidates.
 * Called after calendar sync to ensure stale meeting preps are removed.
 */
export function invalidateExpiredMeetingPrep(): void {
  if (!deps) return;
  const dismissed = dismissExpiredMeetingPrep();
  if (dismissed > 0) {
    deps.broadcastHeroChoiceUpdated();
  }
}

export function shutdownHeroChoiceScheduler(): void {
  if (initialTimer !== null) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  cleanup?.();
  cleanup = null;
  deps = null;
}

/**
 * On-demand generation triggered by user action (prompt card CTA).
 * Bypasses staleness check — always generates fresh recommendations.
 * Returns the stored entry on success, or null on failure.
 */
export async function generateHeroChoiceNow(): Promise<import('@core/heroChoiceTypes').HeroChoiceEntry | null> {
  if (!deps) return null;
  if (isRunning) return null;

  // Efficiency Mode parity: the periodic `checkAndGenerate` already skips when
  // `heroChoiceRunMode !== 'automatic'` (which Efficiency Mode forces to `off`),
  // but the on-demand path was previously running the LLM call regardless of
  // that gate. When the user has explicitly turned Hero Choice off, an on-demand
  // request should be a no-op rather than a quiet override.
  // See `docs/plans/260524_performance_mode.md`.
  const runMode = deps.getSettings().heroChoiceRunMode ?? 'ask';
  if (runMode === 'off') {
    log.info({ runMode }, 'On-demand hero choice request ignored (run mode is off)');
    return null;
  }

  isRunning = true;
  try {
    log.info('On-demand hero choice generation requested');
    const result = await generateHeroChoice(deps, deps.getSettings());

    if (result) {
      addHeroChoiceEntry(result);
      deps.broadcastHeroChoiceUpdated();
      log.info({ candidateCount: result.candidates.length }, 'On-demand hero choice generated');
      return getCurrentHeroChoice();
    }
    return null;
  } catch (error) {
    if (error instanceof CodexDisconnectedBtsError) {
      throw error;
    }
    log.error({ error }, 'On-demand hero choice generation failed');
    return null;
  } finally {
    isRunning = false;
  }
}

async function checkAndGenerate(): Promise<void> {
  if (isRunning || !deps) return;

  const runMode = deps.getSettings().heroChoiceRunMode ?? 'ask';
  if (runMode !== 'automatic') {
    log.debug({ runMode }, 'Hero choice auto-generation skipped (run mode is not automatic)');
    return;
  }

  const current = getCurrentHeroChoice();
  const lastGeneratedAt = current?.result.generatedAt ?? null;

  if (!isHeroChoiceStale(lastGeneratedAt)) {
    log.debug({ lastGeneratedAt }, 'Hero choice is fresh, skipping');
    return;
  }

  isRunning = true;
  try {
    log.info('Generating hero choice');
    const result = await generateHeroChoice(deps, deps.getSettings());

    if (result) {
      addHeroChoiceEntry(result);
      deps.broadcastHeroChoiceUpdated();
      log.info({ candidateCount: result.candidates.length }, 'Hero choice generated and stored');
    } else {
      log.warn('Hero choice generation returned null — preserving previous result');
    }
  } catch (error) {
    log.error({ error }, 'Hero choice generation failed');
  } finally {
    isRunning = false;
  }
}
