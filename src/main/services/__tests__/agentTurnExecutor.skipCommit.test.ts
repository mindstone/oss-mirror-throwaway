import { describe, expect, it } from 'vitest';
import { applyWatchdogApprovalWaitCommitGate } from '../agentTurnExecutor';
import { WatchdogTracker } from '../watchdogTracker';

describe('agentTurnExecutor approval-wait skipCommit gate', () => {
  it('keeps tracker level unchanged when approval-wait skips watchdog escalation', () => {
    const t0 = 1000000;
    const watchdog = new WatchdogTracker(t0);

    const checkResult = watchdog.check(t0 + 35_000, true);
    expect(checkResult.escalated).toBe(true);
    expect(checkResult.level).toBe(1);

    const skippedForApprovalWait = applyWatchdogApprovalWaitCommitGate({
      watchdog,
      checkResult,
      now: t0 + 35_000,
      isWaitingForUser: true,
      watchdogAbortsDuringApprovalWait: false,
    });

    expect(skippedForApprovalWait).toBe(true);
    expect(watchdog.watchdogLevel).toBe(0);
    expect(watchdog.maxWatchdogLevel).toBe(0);
    expect(watchdog.fired).toBe(false);
  });

  it('re-evaluates from prior level when approval clears on the next tick (no double-bump)', () => {
    const t0 = 1000000;
    const watchdog = new WatchdogTracker(t0);

    const skippedTickResult = watchdog.check(t0 + 35_000, true);
    const skippedForApprovalWait = applyWatchdogApprovalWaitCommitGate({
      watchdog,
      checkResult: skippedTickResult,
      now: t0 + 35_000,
      isWaitingForUser: true,
      watchdogAbortsDuringApprovalWait: false,
    });
    expect(skippedForApprovalWait).toBe(true);
    expect(watchdog.watchdogLevel).toBe(0);

    const postApprovalResult = watchdog.check(t0 + 40_000, true);
    expect(postApprovalResult.escalated).toBe(true);
    expect(postApprovalResult.level).toBe(1);

    const skippedAfterApprovalClears = applyWatchdogApprovalWaitCommitGate({
      watchdog,
      checkResult: postApprovalResult,
      now: t0 + 40_000,
      isWaitingForUser: false,
      watchdogAbortsDuringApprovalWait: false,
    });
    expect(skippedAfterApprovalClears).toBe(false);
    expect(watchdog.watchdogLevel).toBe(1);
    expect(watchdog.maxWatchdogLevel).toBe(1);
  });
});
