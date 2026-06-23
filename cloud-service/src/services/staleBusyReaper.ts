import { createScopedLogger } from '@core/logger';
import { fireAndForget } from '@shared/utils/fireAndForget';
import {
  sweepStaleBusySessions,
  STALE_BUSY_GRACE_PERIOD_MS,
  type StaleBusyReaperEngineDeps,
} from '@core/services/continuity/staleBusyReaperEngine';
import type { CloudServiceDeps } from '../bootstrap';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';

const log = createScopedLogger({ service: 'cloud-stale-busy-reaper' });

const SWEEP_INTERVAL_MS = 60_000;

type StaleBusyReaperDeps = Pick<
  CloudServiceDeps,
  'listSessions' | 'getSession' | 'upsertSession' | 'getActiveTurnController'
> &
  StaleBusyReaperEngineDeps;

let intervalTimer: ReturnType<typeof setInterval> | null = null;
let depsRef: StaleBusyReaperDeps | null = null;
let isRunning = false;

async function runSweep(): Promise<void> {
  if (isRunning) {
    log.debug('Skipping stale busy sweep; previous run still in progress');
    return;
  }

  const deps = depsRef;
  if (!deps) {
    return;
  }

  isRunning = true;
  try {
    const correctedIds = await sweepStaleBusySessions(deps);
    for (const sessionId of correctedIds) {
      cloudEventBroadcaster.broadcast('cloud:session-changed', {
        sessionId,
        action: 'upserted',
      });
    }
  } finally {
    isRunning = false;
  }
}

export function startStaleBusyReaper(deps: StaleBusyReaperDeps): void {
  if (intervalTimer) {
    return;
  }

  depsRef = deps;
  intervalTimer = setInterval(() => {
    fireAndForget(runSweep(), 'cloud.staleBusyReaper.runSweep');
  }, SWEEP_INTERVAL_MS);
  intervalTimer.unref?.();

  log.info(
    { intervalMs: SWEEP_INTERVAL_MS, gracePeriodMs: STALE_BUSY_GRACE_PERIOD_MS },
    'Stale busy reaper started',
  );
}

export function stopStaleBusyReaper(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }

  depsRef = null;
  isRunning = false;
  log.info('Stale busy reaper stopped');
}
