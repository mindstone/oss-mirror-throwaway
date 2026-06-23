export interface TeamRateLimiterOptions {
  refillPerSecond?: number;
  burstCapacity?: number;
  maxBuckets?: number;
  bucketTtlMs?: number;
  now?: () => number;
}

export interface TeamRateLimitResult {
  allowed: boolean;
  retryAfter: number;
  remaining: number;
}

interface TeamBucket {
  tokens: number;
  updatedAt: number;
  lastAccessedAt: number;
}

const DEFAULT_REFILL_PER_SECOND = 5;
const DEFAULT_BURST_CAPACITY = 60;
const DEFAULT_MAX_BUCKETS = 10_000;
const DEFAULT_BUCKET_TTL_MS = 60 * 60 * 1000;

export class TeamRateLimiter {
  private readonly refillPerSecond: number;
  private readonly burstCapacity: number;
  private readonly maxBuckets: number;
  private readonly bucketTtlMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, TeamBucket>();

  constructor(options: TeamRateLimiterOptions = {}) {
    this.refillPerSecond = options.refillPerSecond ?? DEFAULT_REFILL_PER_SECOND;
    this.burstCapacity = options.burstCapacity ?? DEFAULT_BURST_CAPACITY;
    this.maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
    this.bucketTtlMs = options.bucketTtlMs ?? DEFAULT_BUCKET_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  consume(teamId: string): TeamRateLimitResult {
    const now = this.now();
    this.evictExpired(now);
    const bucket = this.refill(teamId, now);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfter: 0, remaining: Math.floor(bucket.tokens) };
    }

    const tokensNeeded = 1 - bucket.tokens;
    const retryAfter = Math.max(1, Math.ceil(tokensNeeded / this.refillPerSecond));
    return { allowed: false, retryAfter, remaining: 0 };
  }

  reset(): void {
    this.buckets.clear();
  }

  getBucketCountForTesting(): number {
    return this.buckets.size;
  }

  private refill(teamId: string, now: number): TeamBucket {
    const existing = this.buckets.get(teamId);
    if (!existing) {
      this.evictLruIfNeeded();
      const bucket = { tokens: this.burstCapacity, updatedAt: now, lastAccessedAt: now };
      this.buckets.set(teamId, bucket);
      return bucket;
    }

    const elapsedSeconds = Math.max(0, (now - existing.updatedAt) / 1000);
    existing.tokens = Math.min(
      this.burstCapacity,
      existing.tokens + elapsedSeconds * this.refillPerSecond,
    );
    existing.updatedAt = now;
    existing.lastAccessedAt = now;
    this.buckets.delete(teamId);
    this.buckets.set(teamId, existing);
    return existing;
  }

  private evictExpired(now: number): void {
    for (const [teamId, bucket] of this.buckets) {
      if (now - bucket.lastAccessedAt <= this.bucketTtlMs) {
        continue;
      }
      this.buckets.delete(teamId);
    }
  }

  private evictLruIfNeeded(): void {
    while (this.buckets.size >= this.maxBuckets) {
      const oldestKey = this.buckets.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.buckets.delete(oldestKey);
    }
  }
}

export const slackWebhookTeamRateLimiter = new TeamRateLimiter();
export const slackWebhookIpRateLimiter = new TeamRateLimiter({
  refillPerSecond: 200 / 60,
  burstCapacity: 200,
});
