import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HygieneResult } from '@core/services/cloudDataHygieneService';

const mockRunCloudDataHygiene = vi.fn();
const mockLogWarn = vi.fn();
const mockLogInfo = vi.fn();

vi.mock('@core/services/cloudDataHygieneService', () => ({
  runCloudDataHygiene: (...args: unknown[]) => mockRunCloudDataHygiene(...args),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    warn: (...args: unknown[]) => mockLogWarn(...args),
    info: (...args: unknown[]) => mockLogInfo(...args),
  }),
}));

import {
  getCloudHygieneSchedulerHandle,
  startCloudHygieneScheduler,
} from '../cloudHygieneScheduler';

function buildResult(overrides: Partial<HygieneResult> = {}): HygieneResult {
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
    errors: [],
    durationMs: 5,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('cloudHygieneScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockRunCloudDataHygiene.mockResolvedValue(buildResult());
  });

  afterEach(() => {
    getCloudHygieneSchedulerHandle()?.stop();
    vi.useRealTimers();
  });

  it('start(runOnStart=true) does not run synchronously', () => {
    const handle = startCloudHygieneScheduler({
      dataPath: '/tmp/data',
      runOnStart: true,
      startDelayMs: 30_000,
      intervalMs: 60_000,
    });

    expect(mockRunCloudDataHygiene).not.toHaveBeenCalled();
    expect(handle.getLastResult()).toBeUndefined();
    expect(handle.getNextRunAt()).toBeTypeOf('number');
  });

  it('triggers startup run after startDelayMs', async () => {
    const firstResult = buildResult({ deletedSessionFiles: 3 });
    mockRunCloudDataHygiene.mockResolvedValueOnce(firstResult);

    const handle = startCloudHygieneScheduler({
      dataPath: '/tmp/data',
      runOnStart: true,
      startDelayMs: 30_000,
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockRunCloudDataHygiene).toHaveBeenCalledTimes(1);
    expect(mockRunCloudDataHygiene).toHaveBeenCalledWith('/tmp/data');
    expect(handle.getLastResult()).toEqual(firstResult);
  });

  it('triggers periodic runs on interval', async () => {
    mockRunCloudDataHygiene
      .mockResolvedValueOnce(buildResult({ deletedSessionFiles: 1 }))
      .mockResolvedValueOnce(buildResult({ deletedSessionFiles: 2 }));

    const handle = startCloudHygieneScheduler({
      dataPath: '/tmp/data',
      runOnStart: true,
      startDelayMs: 1_000,
      intervalMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockRunCloudDataHygiene).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockRunCloudDataHygiene).toHaveBeenCalledTimes(2);
    expect(handle.getLastResult()?.deletedSessionFiles).toBe(2);
    expect(handle.getNextRunAt()).toBeTypeOf('number');
  });

  it('stop() prevents scheduled runs but manual triggerRun still works', async () => {
    const handle = startCloudHygieneScheduler({
      dataPath: '/tmp/data',
      runOnStart: true,
      startDelayMs: 1_000,
      intervalMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockRunCloudDataHygiene).toHaveBeenCalledTimes(1);

    handle.stop();
    expect(handle.getNextRunAt()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockRunCloudDataHygiene).toHaveBeenCalledTimes(1);

    await handle.triggerRun();
    expect(mockRunCloudDataHygiene).toHaveBeenCalledTimes(2);
    expect(handle.getNextRunAt()).toBeUndefined();
  });

  it('dedupes concurrent triggerRun calls while a run is in flight', async () => {
    const deferred = createDeferred<HygieneResult>();
    mockRunCloudDataHygiene.mockReturnValueOnce(deferred.promise);

    const handle = startCloudHygieneScheduler({
      dataPath: '/tmp/data',
      runOnStart: false,
      intervalMs: 60_000,
    });

    const first = handle.triggerRun();
    const second = handle.triggerRun();

    expect(first).toBe(second);
    expect(mockRunCloudDataHygiene).toHaveBeenCalledTimes(1);

    deferred.resolve(buildResult({ deletedSessionFiles: 9 }));
    const resolved = await first;
    expect(resolved.deletedSessionFiles).toBe(9);
  });

  it('continues scheduling after a run throws', async () => {
    mockRunCloudDataHygiene
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(buildResult({ deletedSessionFiles: 4 }));

    const handle = startCloudHygieneScheduler({
      dataPath: '/tmp/data',
      runOnStart: true,
      startDelayMs: 1_000,
      intervalMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockRunCloudDataHygiene).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(handle.getLastResult()?.errors[0]).toContain('boom');

    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockRunCloudDataHygiene).toHaveBeenCalledTimes(2);
    expect(handle.getLastResult()?.deletedSessionFiles).toBe(4);
  });
});
