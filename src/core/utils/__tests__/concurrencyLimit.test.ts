import { describe, expect, it } from 'vitest';
import { mapWithConcurrencyLimit } from '../concurrencyLimit';

/**
 * These tests pin the guarantees that `incrementalSessionStore`'s bounded
 * fan-outs rely on for EXACT semantics preservation (see
 * docs/plans/260617_session-store-fanout-bound/PLAN.md). The session-store
 * load path depends on: (1) result order matching input order, (2) per-item
 * `null` returns passing through positionally, and (3) the limiter NOT
 * swallowing mapper errors (reject-fast parity with `Promise.all`). A future
 * edit to the util that broke any of these would silently corrupt session
 * load/save ordering — the index-collapse incident class.
 */

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrencyLimit', () => {
  it('preserves result order even when later items resolve before earlier ones', async () => {
    const input = [0, 1, 2, 3, 4, 5];
    // Earlier indices take LONGER to resolve, so completion order is reversed.
    const results = await mapWithConcurrencyLimit(input, 8, async (n) => {
      await tick((input.length - n) * 5);
      return n * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it('passes the index to the mapper aligned with output position', async () => {
    const input = ['a', 'b', 'c'];
    const results = await mapWithConcurrencyLimit(input, 2, async (item, index) => `${index}:${item}`);
    expect(results).toEqual(['0:a', '1:b', '2:c']);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const input = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrencyLimit(input, 4, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(5);
      inFlight -= 1;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    // And it should actually use the available parallelism (not serialize).
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('passes per-item null returns through positionally (load-path try/catch->null semantics)', async () => {
    // Mirrors loadFromNewFormat: a mapper that returns null for "failed" items.
    const input = [{ id: 'ok1' }, { id: 'bad' }, { id: 'ok2' }];
    const results = await mapWithConcurrencyLimit(input, 8, async (entry) =>
      entry.id === 'bad' ? null : entry.id,
    );
    expect(results).toEqual(['ok1', null, 'ok2']);
    expect(results.filter((s): s is string => s !== null)).toEqual(['ok1', 'ok2']);
  });

  it('rejects when a mapper throws (reject-fast parity with Promise.all), without swallowing the error', async () => {
    const input = [1, 2, 3, 4];
    await expect(
      mapWithConcurrencyLimit(input, 2, async (n) => {
        if (n === 3) throw new Error('boom on 3');
        await tick(1);
        return n;
      }),
    ).rejects.toThrow('boom on 3');
  });

  it('serializes with N=1', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const input = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrencyLimit(input, 1, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(1);
      inFlight -= 1;
      return n;
    });
    expect(maxInFlight).toBe(1);
    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not over-spawn workers when N exceeds item count', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const input = [1, 2, 3];
    await mapWithConcurrencyLimit(input, 100, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(1);
      inFlight -= 1;
      return n;
    });
    // At most items.length can run concurrently.
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('returns an empty array for empty input and never calls the mapper', async () => {
    let called = false;
    const results = await mapWithConcurrencyLimit([] as number[], 8, async (n) => {
      called = true;
      return n;
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it('treats N<1 as serial (limit floored to 1) rather than spawning zero workers', async () => {
    const input = [1, 2, 3];
    const results = await mapWithConcurrencyLimit(input, 0, async (n) => n * 2);
    expect(results).toEqual([2, 4, 6]);
  });
});
