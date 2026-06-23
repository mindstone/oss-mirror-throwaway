import type {
  Scheduler,
  SchedulerTimerHandle,
  VisibilityDeferralOptions,
  VisibilityDeferralResult,
} from '@core/scheduler';

export class StandaloneScheduler implements Scheduler {
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
    return true;
  }

  async deferUntilVisible(
    _options: VisibilityDeferralOptions = {},
  ): Promise<VisibilityDeferralResult> {
    return 'visible';
  }
}
