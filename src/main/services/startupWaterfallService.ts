import { performance } from 'node:perf_hooks';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'startupWaterfall' });

const IS_PERF_MODE = process.env.REBEL_PERF_MODE === '1';
const startTime = Date.now(); // captured at module load time

interface StartupMark {
  name: string;
  elapsedMs: number; // from module load (≈process start)
  deltaMs: number; // from previous mark
}

const marks: StartupMark[] = [];

export function markStartup(name: string): void {
  if (!IS_PERF_MODE) return;

  const elapsedMs = Date.now() - startTime;
  const prevElapsed = marks.length > 0 ? marks[marks.length - 1].elapsedMs : 0;
  const deltaMs = elapsedMs - prevElapsed;

  marks.push({ name, elapsedMs, deltaMs });
  performance.mark(`startup:${name}`);
}

export function getWaterfall(): StartupMark[] {
  return [...marks];
}

export function logWaterfall(): void {
  if (!IS_PERF_MODE || marks.length === 0) return;

  log.info(
    {
      profilerChannel: 'startup-waterfall',
      totalMs: marks.length > 0 ? marks[marks.length - 1].elapsedMs : 0,
      markCount: marks.length,
      waterfall: marks,
    },
    `Startup waterfall: ${marks.length} milestones, total ${marks[marks.length - 1]?.elapsedMs ?? 0}ms`
  );

  // Clear both `performance.mark()` entries AND the in-memory marks array so
  // HMR/window recreation does not replay stale milestones on subsequent logs.
  for (const mark of marks) {
    performance.clearMarks(`startup:${mark.name}`);
  }
  marks.length = 0;
}

/**
 * Test-only: clear all accumulated marks + any `performance.mark()` entries
 * that were written for them. Without this, module-level state leaks across
 * tests (marks array survives between tests and produces flaky assertions).
 */
export function _resetForTesting(): void {
  for (const mark of marks) {
    performance.clearMarks(`startup:${mark.name}`);
  }
  marks.length = 0;
}
