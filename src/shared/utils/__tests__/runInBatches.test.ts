import { describe, expect, it, vi } from 'vitest';
import { runInBatches } from '../runInBatches';

describe('runInBatches', () => {
  it('limits concurrency to batch size', async () => {
    vi.useFakeTimers();

    let inFlight = 0;
    let maxInFlight = 0;

    const tasks = Array.from({ length: 7 }, (_, i) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return i;
    });

    const promise = runInBatches(tasks, 3);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(maxInFlight).toBe(3);

    vi.useRealTimers();
  });

  it('throws for invalid batch sizes', async () => {
    await expect(runInBatches([], 0)).rejects.toThrow('batchSize must be a positive number');
  });
});
