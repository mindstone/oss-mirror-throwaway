import { createSlidingWindowRateLimiter } from './pluginRateLimiter';

const aiRateLimiter = createSlidingWindowRateLimiter(60_000, 10);

export function checkRateLimit(pluginId: string): { allowed: boolean; retryAfterMs?: number } {
  return aiRateLimiter.check(pluginId);
}

export function recordCall(pluginId: string): void {
  aiRateLimiter.record(pluginId);
}

export function _resetForTesting(): void {
  aiRateLimiter._resetForTesting();
}
