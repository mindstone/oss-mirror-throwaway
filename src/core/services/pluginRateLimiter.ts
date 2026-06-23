export interface SlidingWindowRateLimiter {
  check(id: string): { allowed: boolean; retryAfterMs?: number };
  record(id: string): void;
  _resetForTesting(): void;
}

export function createSlidingWindowRateLimiter(
  windowMs: number,
  maxCalls: number,
): SlidingWindowRateLimiter {
  const callTimestamps = new Map<string, number[]>();

  const pruneExpired = (id: string, now: number): number[] => {
    const timestamps = callTimestamps.get(id);
    if (!timestamps || timestamps.length === 0) {
      return [];
    }

    const windowStart = now - windowMs;
    const active = timestamps.filter((timestamp) => timestamp > windowStart);
    callTimestamps.set(id, active);
    return active;
  };

  return {
    check(id: string): { allowed: boolean; retryAfterMs?: number } {
      const now = Date.now();
      const activeTimestamps = pruneExpired(id, now);

      if (activeTimestamps.length < maxCalls) {
        return { allowed: true };
      }

      const oldestInWindow = activeTimestamps[0];
      const retryAfterMs = oldestInWindow + windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    },

    record(id: string): void {
      const now = Date.now();
      const timestamps = callTimestamps.get(id) ?? [];
      timestamps.push(now);
      callTimestamps.set(id, timestamps);
    },

    _resetForTesting(): void {
      callTimestamps.clear();
    },
  };
}
