import { describe, it, expect, vi } from 'vitest';
import { CoalescedCache } from '../coalescedCache';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

describe('CoalescedCache', () => {
  it('coalesces concurrent misses into one underlying fetch and returns the same value to all callers', async () => {
    const pending = deferred<string>();
    let now = 100;
    let fetchCount = 0;
    const cache = new CoalescedCache<string>({ ttlMs: 50, now: () => now });

    const fetcher = vi.fn(async () => {
      fetchCount += 1;
      return pending.promise;
    });

    const p1 = cache.get('alpha', fetcher);
    const p2 = cache.get('alpha', fetcher);
    const p3 = cache.get('alpha', fetcher);

    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetchCount).toBe(1);
    expect(cache.snapshot()).toEqual({ entries: 0, inflight: 1 });

    pending.resolve('ready');
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['ready', 'ready', 'ready']);
    expect(cache.snapshot()).toEqual({ entries: 1, inflight: 0 });

    now += 10;
    await expect(cache.get('alpha', vi.fn(async () => 'unused'))).resolves.toBe('ready');
  });

  it('clears the inflight slot after rejection, retries on the next call, and fires onError once', async () => {
    const errors: unknown[] = [];
    const first = deferred<string>();
    let fetchCount = 0;
    const cache = new CoalescedCache<string>({
      ttlMs: 100,
      onError: (_key, err) => {
        errors.push(err);
      },
    });

    const fetcher = vi.fn(async () => {
      fetchCount += 1;
      return first.promise;
    });

    const p1 = cache.get('alpha', fetcher);
    const p2 = cache.get('alpha', fetcher);
    await flushMicrotasks();
    expect(fetchCount).toBe(1);

    first.reject(new Error('boom'));
    await expect(Promise.all([p1, p2])).rejects.toThrow('boom');
    expect(errors).toHaveLength(1);
    expect(cache.snapshot()).toEqual({ entries: 0, inflight: 0 });

    const retryFetcher = vi.fn(async () => {
      fetchCount += 1;
      return 'recovered';
    });

    await expect(cache.get('alpha', retryFetcher)).resolves.toBe('recovered');
    expect(fetchCount).toBe(2);
    expect(retryFetcher).toHaveBeenCalledTimes(1);
    expect(cache.snapshot()).toEqual({ entries: 1, inflight: 0 });
  });

  it('coalesces synchronous fetcher throws through the shared rejection path', async () => {
    let fetchCount = 0;
    const cache = new CoalescedCache<string>({ ttlMs: 100 });

    const fetcher = vi.fn(() => {
      fetchCount += 1;
      throw new Error('sync boom');
    });

    const p1 = cache.get('sync', fetcher);
    const p2 = cache.get('sync', fetcher);

    await expect(Promise.all([p1, p2])).rejects.toThrow('sync boom');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetchCount).toBe(1);
    expect(cache.snapshot()).toEqual({ entries: 0, inflight: 0 });
  });

  it('measures TTL from resolve time rather than miss time', async () => {
    const pending = deferred<string>();
    let now = 100;
    let fetchCount = 0;
    const cache = new CoalescedCache<string>({ ttlMs: 50, now: () => now });

    const first = cache.get('ttl', async () => {
      fetchCount += 1;
      return pending.promise;
    });

    await flushMicrotasks();
    now = 500;
    pending.resolve('value');
    await expect(first).resolves.toBe('value');

    now = 530;
    await expect(cache.get('ttl', async () => {
      fetchCount += 1;
      return 'should-not-run';
    })).resolves.toBe('value');

    now = 551;
    await expect(cache.get('ttl', async () => {
      fetchCount += 1;
      return 'refetched';
    })).resolves.toBe('refetched');
    expect(fetchCount).toBe(2);
  });

  it('drops stale results when invalidate happens during an inflight fetch', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let fetchCount = 0;
    const cache = new CoalescedCache<string>({ ttlMs: 100 });

    const stalePromise = cache.get('alpha', async () => {
      fetchCount += 1;
      return first.promise;
    });
    await flushMicrotasks();
    expect(cache.snapshot()).toEqual({ entries: 0, inflight: 1 });

    cache.invalidate('alpha');
    expect(cache.snapshot()).toEqual({ entries: 0, inflight: 0 });

    const freshPromise = cache.get('alpha', async () => {
      fetchCount += 1;
      return second.promise;
    });
    await flushMicrotasks();
    expect(fetchCount).toBe(2);
    expect(cache.snapshot()).toEqual({ entries: 0, inflight: 1 });

    first.resolve('stale');
    await expect(stalePromise).resolves.toBe('stale');
    expect(cache.snapshot()).toEqual({ entries: 0, inflight: 1 });

    second.resolve('fresh');
    await expect(freshPromise).resolves.toBe('fresh');
    expect(cache.snapshot()).toEqual({ entries: 1, inflight: 0 });

    await expect(cache.get('alpha', async () => {
      fetchCount += 1;
      return 'unexpected';
    })).resolves.toBe('fresh');
    expect(fetchCount).toBe(2);
  });

  it('isolates business logic from throwing hooks on miss, inflight, hit, and error paths', async () => {
    const inflight = deferred<string>();
    const cache = new CoalescedCache<string>({
      ttlMs: 100,
      onMiss: () => {
        throw new Error('miss hook');
      },
      onInflight: () => {
        throw new Error('inflight hook');
      },
      onHit: () => {
        throw new Error('hit hook');
      },
      onError: () => {
        throw new Error('error hook');
      },
    });

    const first = cache.get('hooked', async () => inflight.promise);
    const second = cache.get('hooked', async () => 'unused');
    await flushMicrotasks();
    inflight.resolve('value');

    await expect(Promise.all([first, second])).resolves.toEqual(['value', 'value']);
    await expect(cache.get('hooked', async () => 'unused')).resolves.toBe('value');

    cache.invalidate('hooked');
    await expect(cache.get('hooked', async () => {
      throw new Error('expected failure');
    })).rejects.toThrow('expected failure');
  });

  it('evicts the oldest resolved entry when maxEntries is exceeded', async () => {
    let fetchCount = 0;
    const cache = new CoalescedCache<string>({ ttlMs: 100, maxEntries: 2 });

    await expect(cache.get('a', async () => {
      fetchCount += 1;
      return 'A';
    })).resolves.toBe('A');
    await expect(cache.get('b', async () => {
      fetchCount += 1;
      return 'B';
    })).resolves.toBe('B');
    await expect(cache.get('c', async () => {
      fetchCount += 1;
      return 'C';
    })).resolves.toBe('C');

    expect(cache.snapshot()).toEqual({ entries: 2, inflight: 0 });

    await expect(cache.get('b', async () => {
      fetchCount += 1;
      return 'unexpected';
    })).resolves.toBe('B');
    await expect(cache.get('c', async () => {
      fetchCount += 1;
      return 'unexpected';
    })).resolves.toBe('C');
    await expect(cache.get('a', async () => {
      fetchCount += 1;
      return 'A2';
    })).resolves.toBe('A2');

    expect(fetchCount).toBe(4);
  });

  it('clear removes cached and inflight state without letting stale results repopulate the cache', async () => {
    const pending = deferred<string>();
    let fetchCount = 0;
    const cache = new CoalescedCache<string>({ ttlMs: 100 });

    expect(cache.snapshot()).toEqual({ entries: 0, inflight: 0 });

    const stale = cache.get('alpha', async () => {
      fetchCount += 1;
      return pending.promise;
    });
    await flushMicrotasks();
    expect(cache.snapshot()).toEqual({ entries: 0, inflight: 1 });

    cache.clear();
    expect(cache.snapshot()).toEqual({ entries: 0, inflight: 0 });

    pending.resolve('stale');
    await expect(stale).resolves.toBe('stale');
    expect(cache.snapshot()).toEqual({ entries: 0, inflight: 0 });

    await expect(cache.get('alpha', async () => {
      fetchCount += 1;
      return 'fresh';
    })).resolves.toBe('fresh');
    expect(fetchCount).toBe(2);
    expect(cache.snapshot()).toEqual({ entries: 1, inflight: 0 });
  });

  it('treats resolved undefined as a cache hit value rather than a miss', async () => {
    let fetchCount = 0;
    const cache = new CoalescedCache<string | undefined>({ ttlMs: 100 });

    await expect(cache.get('undef', async () => {
      fetchCount += 1;
      return undefined;
    })).resolves.toBeUndefined();

    await expect(cache.get('undef', async () => {
      fetchCount += 1;
      return 'unexpected';
    })).resolves.toBeUndefined();

    expect(fetchCount).toBe(1);
  });

  it('reports snapshot state correctly across hit, miss, and inflight hook paths', async () => {
    const pending = deferred<string>();
    const hooks = {
      onHit: vi.fn(),
      onMiss: vi.fn(),
      onInflight: vi.fn(),
      onError: vi.fn(),
    };
    const cache = new CoalescedCache<string>({ ttlMs: 100, ...hooks });

    const first = cache.get('snap', async () => pending.promise);
    const second = cache.get('snap', async () => 'unused');
    await flushMicrotasks();

    expect(cache.snapshot()).toEqual({ entries: 0, inflight: 1 });
    expect(hooks.onMiss).toHaveBeenCalledWith('snap');
    expect(hooks.onInflight).toHaveBeenCalledWith('snap');

    pending.resolve('value');
    await expect(Promise.all([first, second])).resolves.toEqual(['value', 'value']);
    expect(cache.snapshot()).toEqual({ entries: 1, inflight: 0 });

    await expect(cache.get('snap', async () => 'unused')).resolves.toBe('value');
    expect(hooks.onHit).toHaveBeenCalledWith('snap');
    expect(hooks.onError).not.toHaveBeenCalled();
  });
});
