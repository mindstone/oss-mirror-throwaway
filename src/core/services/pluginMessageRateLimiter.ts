import { createSlidingWindowRateLimiter } from './pluginRateLimiter';

const messageRateLimiter = createSlidingWindowRateLimiter(60_000, 5);

export function checkMessageRateLimit(pluginId: string): { allowed: boolean; retryAfterMs?: number } {
  return messageRateLimiter.check(pluginId);
}

export function recordMessageCall(pluginId: string): void {
  messageRateLimiter.record(pluginId);
}

export function _resetForTesting(): void {
  messageRateLimiter._resetForTesting();
}
