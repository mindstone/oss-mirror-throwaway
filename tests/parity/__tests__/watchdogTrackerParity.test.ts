import { describe, expect, it } from 'vitest';
import * as coreWatchdog from '@core/services/watchdog/watchdogTracker';
import * as mainWatchdog from '@main/services/watchdogTracker';

type WatchdogModule = Pick<
  typeof coreWatchdog,
  | 'WatchdogTracker'
  | 'WATCHDOG_THRESHOLDS'
  | 'WATCHDOG_THRESHOLDS_SUBAGENT'
  | 'AUTO_ABORT_MS'
  | 'STREAMING_STALL_ABORT_MS'
  | 'formatWatchdogAutoAbortMessage'
>;

function runSharedScenario(module: WatchdogModule): {
  normalLevel: number;
  subagentLevelBefore: number;
  subagentLevelAfter: number;
  shouldAbortAtStreamingThreshold: boolean;
} {
  const t0 = 1_000_000;
  const tracker = new module.WatchdogTracker(t0);

  const normal = tracker.check(t0 + module.WATCHDOG_THRESHOLDS[0] + 1);

  tracker.onMessage({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: {} }] },
  }, t0 + 100);

  const subagentBefore = tracker.check(t0 + 35_100);
  const subagentAfter = tracker.check(t0 + module.WATCHDOG_THRESHOLDS_SUBAGENT[0] + 102);

  const freshTracker = new module.WatchdogTracker(t0);
  const abortResult = freshTracker.check(t0 + module.STREAMING_STALL_ABORT_MS + 1);

  return {
    normalLevel: normal.level,
    subagentLevelBefore: subagentBefore.level,
    subagentLevelAfter: subagentAfter.level,
    shouldAbortAtStreamingThreshold: abortResult.shouldAbort,
  };
}

describe('watchdog tracker parity', () => {
  it('desktop shim and core implementation expose identical constants and behavior', () => {
    expect(mainWatchdog.WATCHDOG_THRESHOLDS).toEqual(coreWatchdog.WATCHDOG_THRESHOLDS);
    expect(mainWatchdog.WATCHDOG_THRESHOLDS_SUBAGENT).toEqual(coreWatchdog.WATCHDOG_THRESHOLDS_SUBAGENT);
    expect(mainWatchdog.AUTO_ABORT_MS).toBe(coreWatchdog.AUTO_ABORT_MS);
    expect(mainWatchdog.STREAMING_STALL_ABORT_MS).toBe(coreWatchdog.STREAMING_STALL_ABORT_MS);
    expect(mainWatchdog.formatWatchdogAutoAbortMessage()).toBe(
      coreWatchdog.formatWatchdogAutoAbortMessage(),
    );

    expect(runSharedScenario(mainWatchdog)).toEqual(runSharedScenario(coreWatchdog));
  });
});
