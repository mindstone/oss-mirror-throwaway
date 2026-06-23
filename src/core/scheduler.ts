export type SchedulerTimerHandle = ReturnType<typeof setTimeout>;

export interface VisibilityDeferralOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type VisibilityDeferralResult = 'visible' | 'timeout' | 'aborted';

export interface Scheduler {
  registerTimeout(callback: () => void, delayMs: number): SchedulerTimerHandle;
  registerInterval(callback: () => void, intervalMs: number): SchedulerTimerHandle;
  clear(timer: SchedulerTimerHandle): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  isVisible(): boolean;
  deferUntilVisible(options?: VisibilityDeferralOptions): Promise<VisibilityDeferralResult>;
}

export type SchedulerFactory = () => Scheduler;

let _factory: SchedulerFactory | undefined;
let _instance: Scheduler | undefined;

export function setSchedulerFactory(factory: SchedulerFactory): void {
  _factory = factory;
  _instance = undefined;
}

export function getScheduler(): Scheduler {
  if (_instance) return _instance;
  if (!_factory) {
    throw new Error('Scheduler not initialized. Call setSchedulerFactory() before use.');
  }
  _instance = _factory();
  return _instance;
}
