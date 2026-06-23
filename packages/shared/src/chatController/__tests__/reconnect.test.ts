import { describe, expect, it, vi } from 'vitest';
import {
  createReconnectLadder,
  DEFAULT_RECONNECT_BACKOFF_MS,
} from '../reconnect';

describe('createReconnectLadder', () => {
  it('uses 0/1000/2000/4000 backoff timings before giving up', async () => {
    vi.useFakeTimers();
    try {
      const scheduledOffsets: number[] = [];
      const giveUpError = new Error('attempt 4 failed');
      const onGiveUp = vi.fn();
      const startAt = Date.now();

      const ladder = createReconnectLadder({
        clock: () => Date.now(),
        onAttemptScheduled: (_attempt, nextAttemptAtMs) => {
          scheduledOffsets.push(nextAttemptAtMs - startAt);
        },
        onGiveUp,
      });

      ladder.start((attempt) => {
        throw attempt === 4 ? giveUpError : new Error(`attempt ${attempt} failed`);
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);

      expect(scheduledOffsets).toEqual([0, 1_000, 3_000, 7_000]);
      expect(onGiveUp).toHaveBeenCalledWith(giveUpError);
      expect(ladder.currentAttempt()).toBeNull();
      expect(ladder.disposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops after a successful second attempt', async () => {
    vi.useFakeTimers();
    try {
      const attempts: number[] = [];
      const onGiveUp = vi.fn();
      const ladder = createReconnectLadder({ onGiveUp });

      ladder.start((attempt) => {
        attempts.push(attempt);
        if (attempt === 1) {
          throw new Error('first attempt failed');
        }
      });

      expect(attempts).toEqual([1]);
      expect(ladder.currentAttempt()).toBe(2);

      await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_BACKOFF_MS[0]);

      expect(attempts).toEqual([1, 2]);
      expect(onGiveUp).not.toHaveBeenCalled();
      expect(ladder.currentAttempt()).toBeNull();
      expect(ladder.disposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel clears the pending timer', async () => {
    vi.useFakeTimers();
    try {
      const clearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => {
        clearTimeout(timer);
      });
      const attempts: number[] = [];
      const ladder = createReconnectLadder({
        clearTimer,
      });

      ladder.start((attempt) => {
        attempts.push(attempt);
        throw new Error('retry me');
      });

      expect(ladder.currentAttempt()).toBe(2);
      ladder.cancel();

      await vi.runAllTimersAsync();

      expect(attempts).toEqual([1]);
      expect(clearTimer).toHaveBeenCalledTimes(1);
      expect(ladder.currentAttempt()).toBeNull();
      expect(ladder.disposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('short-circuits on retry:false and calls onGiveUp immediately', async () => {
    const giveUpError = new Error('do not retry');
    const onGiveUp = vi.fn();
    const ladder = createReconnectLadder({ onGiveUp });

    ladder.start(() => ({ retry: false, error: giveUpError }));
    await vi.waitFor(() => {
      expect(onGiveUp).toHaveBeenCalledWith(giveUpError);
    });

    expect(ladder.currentAttempt()).toBeNull();
    expect(ladder.disposed).toBe(true);
  });

  it('handles rejected attempts without leaving an unhandled rejection behind', async () => {
    const giveUpError = new Error('promise rejected');
    const onGiveUp = vi.fn();
    const ladder = createReconnectLadder({
      backoffMs: [],
      onGiveUp,
    });

    ladder.start(async () => Promise.reject(giveUpError));
    await vi.waitFor(() => {
      expect(onGiveUp).toHaveBeenCalledWith(giveUpError);
    });

    expect(ladder.currentAttempt()).toBeNull();
    expect(ladder.disposed).toBe(true);
  });

  it('swallows onGiveUp callback throws instead of retrying twice', async () => {
    const giveUpError = new Error('stop here');
    const onGiveUp = vi.fn(() => {
      throw new Error('callback exploded');
    });
    const ladder = createReconnectLadder({
      backoffMs: [],
      onGiveUp,
    });

    ladder.start(() => {
      throw giveUpError;
    });

    await vi.waitFor(() => {
      expect(onGiveUp).toHaveBeenCalledTimes(1);
      expect(onGiveUp).toHaveBeenCalledWith(giveUpError);
    });

    expect(ladder.currentAttempt()).toBeNull();
    expect(ladder.disposed).toBe(true);
  });
});
