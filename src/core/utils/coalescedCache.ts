// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Generic kept for the Stage 3 public API: callers use CoalescedCacheOptions<V> alongside CoalescedCache<V>.
export interface CoalescedCacheOptions<V> {
  ttlMs: number;
  now?: () => number;
  onHit?: (key: string) => void;
  onMiss?: (key: string) => void;
  onInflight?: (key: string) => void;
  onError?: (key: string, err: unknown) => void;
  maxEntries?: number;
}

type HookName = 'onHit' | 'onMiss' | 'onInflight' | 'onError';

export class CoalescedCache<V> {
  private readonly results = new Map<string, { value: V; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<V>>();
  private readonly generation = new Map<string, number>();
  private clearGeneration = 0;

  constructor(private readonly opts: CoalescedCacheOptions<V>) {}

  async get(key: string, fetcher: () => Promise<V>): Promise<V> {
    const now = this.opts.now?.() ?? Date.now();
    const cached = this.results.get(key);
    if (cached && cached.expiresAt > now) {
      this.safeHook('onHit', key);
      return cached.value;
    }

    const existing = this.inflight.get(key);
    if (existing) {
      this.safeHook('onInflight', key);
      return existing;
    }

    this.safeHook('onMiss', key);
    const myGeneration = this.generation.get(key) ?? 0;
    const myClearGeneration = this.clearGeneration;
    const p = Promise.resolve()
      .then(fetcher)
      .then((value) => {
        const generationUnchanged = (this.generation.get(key) ?? 0) === myGeneration;
        const cacheStillCurrent = this.clearGeneration === myClearGeneration;
        if (generationUnchanged && cacheStillCurrent) {
          this.evictIfFull();
          this.results.set(key, {
            value,
            expiresAt: (this.opts.now?.() ?? Date.now()) + this.opts.ttlMs,
          });
        }
        return value;
      })
      .catch((err) => {
        this.safeHook('onError', key, err);
        throw err;
      })
      .finally(() => {
        if (this.inflight.get(key) === p) {
          this.inflight.delete(key);
        }
      });

    this.inflight.set(key, p);
    return p;
  }

  invalidate(key: string): void {
    this.results.delete(key);
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    this.inflight.delete(key);
  }

  clear(): void {
    this.clearGeneration += 1;
    this.results.clear();
    this.inflight.clear();
    this.generation.clear();
  }

  snapshot(): { entries: number; inflight: number } {
    return {
      entries: this.results.size,
      inflight: this.inflight.size,
    };
  }

  private evictIfFull(): void {
    const max = this.opts.maxEntries ?? 256;
    if (this.results.size < max) {
      return;
    }

    const firstKey = this.results.keys().next().value;
    if (firstKey !== undefined) {
      this.results.delete(firstKey);
    }
  }

  private safeHook(name: HookName, key: string, err?: unknown): void {
    try {
      if (name === 'onError') {
        this.opts.onError?.(key, err);
        return;
      }

      this.opts[name]?.(key);
    } catch {
      // Observability hooks must never break cache correctness.
    }
  }
}
