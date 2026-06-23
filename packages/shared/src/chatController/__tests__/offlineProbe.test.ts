import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OFFLINE_PROBE_INTERVAL_MS,
  runOfflineProbeLoop,
} from '../offlineProbe';

describe('runOfflineProbeLoop', () => {
  it('stops on the first successful probe and reports the winning attempt', async () => {
    vi.useFakeTimers();
    try {
      const attempts: number[] = [];
      const onOnline = vi.fn();
      const probe = vi
        .fn<() => Promise<boolean>>()
        .mockImplementation(async () => {
          attempts.push(attempts.length + 1);
          return attempts.length >= 3;
        });

      runOfflineProbeLoop({
        probe,
        onOnline,
      });

      await Promise.resolve();
      expect(probe).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_PROBE_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_PROBE_INTERVAL_MS);

      expect(probe).toHaveBeenCalledTimes(3);
      expect(attempts).toEqual([1, 2, 3]);
      expect(onOnline).toHaveBeenCalledWith(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after 12 unsuccessful attempts', async () => {
    vi.useFakeTimers();
    try {
      const onGaveUp = vi.fn();
      const probe = vi.fn(async () => false);

      runOfflineProbeLoop({
        probe,
        onGaveUp,
      });

      for (let attempt = 1; attempt < 12; attempt += 1) {
        await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_PROBE_INTERVAL_MS);
      }

      expect(probe).toHaveBeenCalledTimes(12);
      expect(onGaveUp).toHaveBeenCalledWith(12);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels cleanly through AbortSignal', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const probe = vi.fn(async () => false);
      const onGaveUp = vi.fn();
      const loop = runOfflineProbeLoop({
        probe,
        signal: controller.signal,
        onGaveUp,
      });

      controller.abort();
      await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_PROBE_INTERVAL_MS * 3);

      expect(loop.running).toBe(false);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(onGaveUp).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows callback throws so the probe loop does not recurse into an unhandled rejection', async () => {
    vi.useFakeTimers();
    try {
      const onGaveUp = vi.fn(() => {
        throw new Error('give-up callback exploded');
      });
      const probe = vi.fn(async () => false);

      runOfflineProbeLoop({
        probe,
        maxAttempts: 1,
        onGaveUp,
      });

      await Promise.resolve();

      expect(probe).toHaveBeenCalledTimes(1);
      expect(onGaveUp).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
