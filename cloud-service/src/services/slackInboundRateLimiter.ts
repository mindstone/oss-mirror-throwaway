import crypto from 'node:crypto';
import { createScopedLogger, type Logger } from '@core/logger';

export interface SlackInboundRateLimiterOptions {
  tokensPerWindow?: number;
  windowMs?: number;
  cleanupIntervalMs?: number;
  maxBuckets?: number;
  logger?: Pick<Logger, 'debug'>;
  now?: () => number;
}

export interface SlackInboundRateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

interface PrincipalBucket {
  tokens: number;
  lastRefilledAt: number;
  lastSeen: number;
}

const DEFAULT_TOKENS_PER_WINDOW = 10;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_BUCKETS = 1_000;
const log = createScopedLogger({ service: 'slackInboundRateLimiter' });

function positiveNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (typeof value !== 'number' || value <= 0) return fallback;
  return value;
}

function hashPrincipalKey(principalKey: string): string {
  return crypto.createHash('sha256').update(principalKey).digest('hex').slice(0, 12);
}

export class SlackInboundRateLimiter {
  private readonly tokensPerWindow: number;
  private readonly windowMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly maxBuckets: number;
  private readonly logger: Pick<Logger, 'debug'>;
  private readonly now: () => number;
  private readonly buckets = new Map<string, PrincipalBucket>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options: SlackInboundRateLimiterOptions = {}) {
    this.tokensPerWindow = positiveNumber(options.tokensPerWindow, DEFAULT_TOKENS_PER_WINDOW);
    this.windowMs = positiveNumber(options.windowMs, DEFAULT_WINDOW_MS);
    this.cleanupIntervalMs = positiveNumber(options.cleanupIntervalMs, DEFAULT_CLEANUP_INTERVAL_MS);
    this.maxBuckets = positiveNumber(options.maxBuckets, DEFAULT_MAX_BUCKETS);
    this.logger = options.logger ?? log;
    this.now = options.now ?? Date.now;
    this.cleanupTimer = setInterval(() => {
      this.evictStaleBuckets(this.now());
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  consume(principalKey: string, isOwner: boolean): SlackInboundRateLimitResult {
    if (isOwner) {
      return { allowed: true };
    }

    const now = this.now();
    const bucket = this.refillBucket(principalKey, now);
    bucket.lastSeen = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    const missingTokens = 1 - bucket.tokens;
    const retryAfterMs = Math.max(
      1,
      Math.ceil((missingTokens / this.tokensPerWindow) * this.windowMs),
    );
    return { allowed: false, retryAfterMs };
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
  }

  getBucketCountForTesting(): number {
    return this.buckets.size;
  }

  private refillBucket(principalKey: string, now: number): PrincipalBucket {
    const existing = this.buckets.get(principalKey);
    if (!existing) {
      if (this.buckets.size >= this.maxBuckets) {
        this.evictLeastRecentlySeenBucket();
      }
      const bucket: PrincipalBucket = {
        tokens: this.tokensPerWindow,
        lastRefilledAt: now,
        lastSeen: now,
      };
      this.buckets.set(principalKey, bucket);
      return bucket;
    }

    const elapsedMs = Math.max(0, now - existing.lastRefilledAt);
    if (elapsedMs > 0) {
      const refillTokens = (elapsedMs / this.windowMs) * this.tokensPerWindow;
      existing.tokens = Math.min(this.tokensPerWindow, existing.tokens + refillTokens);
      existing.lastRefilledAt = now;
    }
    return existing;
  }

  private evictStaleBuckets(now: number): void {
    const staleThresholdMs = this.windowMs * 2;
    for (const [principalKey, bucket] of this.buckets) {
      if (now - bucket.lastSeen > staleThresholdMs) {
        this.buckets.delete(principalKey);
      }
    }
  }

  private evictLeastRecentlySeenBucket(): void {
    let oldestPrincipalKey: string | null = null;
    let oldestLastSeen = Number.POSITIVE_INFINITY;
    for (const [principalKey, bucket] of this.buckets) {
      if (bucket.lastSeen >= oldestLastSeen) continue;
      oldestLastSeen = bucket.lastSeen;
      oldestPrincipalKey = principalKey;
    }
    if (!oldestPrincipalKey) return;
    this.buckets.delete(oldestPrincipalKey);
    this.logger.debug({
      event: 'slack_inbound_rate_limiter_evicted',
      bucketCount: this.buckets.size,
      evictedPrincipalKeyHash: hashPrincipalKey(oldestPrincipalKey),
    }, 'slack_inbound_rate_limiter_evicted');
  }
}

export const slackInboundRateLimiter = new SlackInboundRateLimiter();
