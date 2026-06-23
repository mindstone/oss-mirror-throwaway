import type { IframeMessageMethod, RateLimitTier } from '@shared/types/agent';
import { TRUST_POLICIES } from './trustPolicies';

export interface RateLimitScope {
  sourcePackageId: string;
  sessionId: string;
  conversationId: string;
  iframeInstanceId: string;
}

export type RateLimitCheckResult =
  | { ok: true }
  | {
      ok: false;
      tier: RateLimitTier;
      retryAfterMs: number;
      attemptCount: number;
      timeSinceFirstAttemptMs: number;
    };

const hitBuckets = new Map<string, number[]>();

function prune(bucketKey: string, windowMs: number, now: number): number[] {
  const active = (hitBuckets.get(bucketKey) ?? []).filter((timestamp) => timestamp > now - windowMs);
  hitBuckets.set(bucketKey, active);
  return active;
}

function buildTierKey(scope: RateLimitScope, method: IframeMessageMethod, tier: RateLimitTier): string {
  switch (tier) {
    case 'iframe':
      return `${method}\u0000iframe\u0000${scope.iframeInstanceId}`;
    case 'conversation':
      return `${method}\u0000conversation\u0000${scope.sourcePackageId}\u0000${scope.conversationId}`;
    case 'session':
      return `${method}\u0000session\u0000${scope.sourcePackageId}\u0000${scope.sessionId}`;
    case 'aggregate':
      return `aggregate\u0000${scope.sessionId}\u0000${scope.conversationId}`;
    default: {
      const exhaustive: never = tier;
      return exhaustive;
    }
  }
}

function checkTier(
  scope: RateLimitScope,
  method: IframeMessageMethod,
  tier: RateLimitTier,
  limit: number | undefined,
  windowMs: number,
  now: number,
): RateLimitCheckResult {
  if (!limit || limit <= 0) {
    return { ok: true };
  }

  const key = buildTierKey(scope, method, tier);
  const active = prune(key, windowMs, now);
  if (active.length < limit) {
    return { ok: true };
  }

  const oldest = active[0] ?? now;
  return {
    ok: false,
    tier,
    retryAfterMs: Math.max(oldest + windowMs - now, 0),
    attemptCount: active.length + 1,
    timeSinceFirstAttemptMs: Math.max(now - oldest, 0),
  };
}

export function checkLimit(scope: RateLimitScope, method: IframeMessageMethod): RateLimitCheckResult {
  const policy = TRUST_POLICIES[method];
  const now = Date.now();
  const tiers: Array<[RateLimitTier, number | undefined]> = [
    ['iframe', policy.rateLimit.iframe],
    ['conversation', policy.rateLimit.conversation],
    ['session', policy.rateLimit.session],
    ['aggregate', policy.rateLimit.aggregate],
  ];

  for (const [tier, limit] of tiers) {
    const result = checkTier(scope, method, tier, limit, policy.windowMs, now);
    if (!result.ok) {
      return result;
    }
  }

  return { ok: true };
}

export function recordHit(scope: RateLimitScope, method: IframeMessageMethod): void {
  const policy = TRUST_POLICIES[method];
  const now = Date.now();
  const tiers: Array<[RateLimitTier, number | undefined]> = [
    ['iframe', policy.rateLimit.iframe],
    ['conversation', policy.rateLimit.conversation],
    ['session', policy.rateLimit.session],
    ['aggregate', policy.rateLimit.aggregate],
  ];

  for (const [tier, limit] of tiers) {
    if (!limit || limit <= 0) continue;
    const key = buildTierKey(scope, method, tier);
    const active = prune(key, policy.windowMs, now);
    active.push(now);
    hitBuckets.set(key, active);
  }
}

export function _resetRateLimiterForTests(): void {
  hitBuckets.clear();
}
