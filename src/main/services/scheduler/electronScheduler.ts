// CORE-MOVE-EXEMPT: Desktop scheduler adapter depends on Electron window visibility state.
import type {
  Scheduler,
  SchedulerTimerHandle,
  VisibilityDeferralOptions,
  VisibilityDeferralResult,
} from '@core/scheduler';
import {
  getVisibilityState,
  isAppCurrentlyBlurred,
} from '../visibilityAwareScheduler';

const DEFAULT_VISIBILITY_POLL_INTERVAL_MS = 1000;

export class ElectronScheduler implements Scheduler {
  registerTimeout(callback: () => void, delayMs: number): SchedulerTimerHandle {
    return setTimeout(callback, Math.max(0, delayMs));
  }

  registerInterval(callback: () => void, intervalMs: number): SchedulerTimerHandle {
    return setInterval(callback, Math.max(0, intervalMs));
  }

  clear(timer: SchedulerTimerHandle): void {
    clearTimeout(timer);
  }

  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    });
  }

  isVisible(): boolean {
    const visibility = getVisibilityState();
    return !visibility.isHidden && !isAppCurrentlyBlurred();
  }

  async deferUntilVisible(
    options: VisibilityDeferralOptions = {},
  ): Promise<VisibilityDeferralResult> {
    if (this.isVisible()) return 'visible';

    const pollIntervalMs = Math.max(
      1,
      options.pollIntervalMs ?? DEFAULT_VISIBILITY_POLL_INTERVAL_MS,
    );
    const deadline = options.timeoutMs == null
      ? null
      : this.now() + Math.max(0, options.timeoutMs);

    while (!this.isVisible()) {
      if (options.signal?.aborted) return 'aborted';
      if (deadline !== null && this.now() >= deadline) return 'timeout';
      await this.sleep(pollIntervalMs);
    }

    return options.signal?.aborted ? 'aborted' : 'visible';
  }
}
