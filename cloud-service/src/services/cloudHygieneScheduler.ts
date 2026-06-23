import { createScopedLogger } from '@core/logger';
import { fireAndForget } from '@shared/utils/fireAndForget';
import {
  runCloudDataHygiene,
  type HygieneResult,
} from '@core/services/cloudDataHygieneService';

const log = createScopedLogger({ service: 'cloud-hygiene-scheduler' });

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_START_DELAY_MS = 30_000;

export interface CloudHygieneSchedulerOptions {
  dataPath: string;
  intervalMs?: number;
  runOnStart?: boolean;
  startDelayMs?: number;
}

export interface CloudHygieneSchedulerHandle {
  stop(): void;
  getLastResult(): HygieneResult | undefined;
  getNextRunAt(): number | undefined;
  triggerRun(): Promise<HygieneResult>;
}

let cloudHygieneSchedulerHandle: CloudHygieneSchedulerHandle | undefined;

export function getCloudHygieneSchedulerHandle(): CloudHygieneSchedulerHandle | undefined {
  return cloudHygieneSchedulerHandle;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function createFailedHygieneResult(error: unknown, startedAt: number): HygieneResult {
  return {
    deletedSessionFiles: 0,
    deletedSessionBytes: 0,
    removedLegacyFiles: [],
    sessionLogResult: {
      deleted: 0,
      errors: 0,
      remainingCount: 0,
      remainingBytes: 0,
    },
    oldTranscripts: { deleted: 0, errors: 0 },
    errors: [`runCloudDataHygiene failed: ${formatError(error)}`],
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

export function startCloudHygieneScheduler(
  options: CloudHygieneSchedulerOptions,
): CloudHygieneSchedulerHandle {
  const intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const runOnStart = options.runOnStart ?? true;
  const startDelayMs = Math.max(0, options.startDelayMs ?? DEFAULT_START_DELAY_MS);

  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let startupRunAt: number | undefined;
  let intervalRunAt: number | undefined;
  let nextRunAt: number | undefined;
  let lastResult: HygieneResult | undefined;
  let inFlightRun: Promise<HygieneResult> | undefined;
  let stopped = false;
  let handleRef: CloudHygieneSchedulerHandle | undefined;

  const recomputeNextRunAt = (): void => {
    if (stopped) {
      nextRunAt = undefined;
      return;
    }

    if (typeof startupRunAt === 'number' && typeof intervalRunAt === 'number') {
      nextRunAt = Math.min(startupRunAt, intervalRunAt);
      return;
    }

    nextRunAt = startupRunAt ?? intervalRunAt;
  };

  const runOnce = async (): Promise<HygieneResult> => {
    const startedAt = Date.now();
    try {
      const result = await runCloudDataHygiene(options.dataPath);
      lastResult = result;
      return result;
    } catch (error) {
      const fallback = createFailedHygieneResult(error, startedAt);
      lastResult = fallback;
      log.warn({ error: formatError(error), dataPath: options.dataPath }, 'Cloud hygiene run failed');
      return fallback;
    } finally {
      inFlightRun = undefined;
      recomputeNextRunAt();
    }
  };

  const triggerRun = (): Promise<HygieneResult> => {
    if (inFlightRun) return inFlightRun;
    inFlightRun = runOnce();
    return inFlightRun;
  };

  const stop = (): void => {
    stopped = true;

    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }

    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = undefined;
    }

    startupRunAt = undefined;
    intervalRunAt = undefined;
    recomputeNextRunAt();

    if (cloudHygieneSchedulerHandle === handleRef) {
      cloudHygieneSchedulerHandle = undefined;
    }
  };

  const handle: CloudHygieneSchedulerHandle = {
    stop,
    getLastResult: () => lastResult,
    getNextRunAt: () => nextRunAt,
    triggerRun,
  };
  handleRef = handle;

  if (cloudHygieneSchedulerHandle) {
    cloudHygieneSchedulerHandle.stop();
  }

  if (runOnStart) {
    startupRunAt = Date.now() + startDelayMs;
    startupTimer = setTimeout(() => {
      startupRunAt = undefined;
      recomputeNextRunAt();
      fireAndForget(triggerRun(), 'cloud.hygieneScheduler.startupRun');
    }, startDelayMs);
  }

  intervalRunAt = Date.now() + intervalMs;
  intervalTimer = setInterval(() => {
    intervalRunAt = Date.now() + intervalMs;
    recomputeNextRunAt();
    fireAndForget(triggerRun(), 'cloud.hygieneScheduler.intervalRun');
  }, intervalMs);

  recomputeNextRunAt();

  cloudHygieneSchedulerHandle = handle;
  log.info({ runOnStart, startDelayMs, intervalMs }, 'Cloud hygiene scheduler started');

  return handle;
}
