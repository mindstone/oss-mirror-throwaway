import { afterEach, describe, expect, it, vi } from 'vitest';

import { WindowedCounter } from '../perfCounters';

describe('WindowedCounter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports rolling rate5m + cumulative counts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const counter = new WindowedCounter();

    // 100 increments across 6 minutes (3.6s apart).
    for (let index = 0; index < 100; index += 1) {
      counter.increment();
      vi.advanceTimersByTime(3_600);
    }

    const snapshot = counter.snapshot();
    expect(snapshot.cumulative).toBe(100);
    // Last 5 minutes of a 6-minute run contain 83 events.
    expect(snapshot.rate5m).toBe(83);
  });
});
