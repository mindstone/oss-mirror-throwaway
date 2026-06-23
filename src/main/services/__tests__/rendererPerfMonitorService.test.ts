/**
 * Tests for `rendererPerfMonitorService` (Stage 3 of
 * `docs/plans/260423_secondary_process_cpu_observability.md`).
 *
 * Covers:
 *   1. Valid payload caches and is retrievable.
 *   2. Stale by `batchEndMs` is dropped (debug log).
 *   3. Stale by `batchId` (same batchEndMs, lower id) dropped.
 *   4. Invalid shape drops with a single warn (subsequent bad payloads silent).
 *   5. `getLastRendererPerfSummary(maxAgeMs)` returns null once exceeded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { warn, debug, info, error } = vi.hoisted(() => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({ warn, debug, info, error, trace: vi.fn(), fatal: vi.fn() }),
}));

import {
  cacheRendererPerfSummary,
  getLastRendererPerfSummary,
  resetRendererPerfCacheForTesting,
  type RendererPerfSummary,
} from '../rendererPerfMonitorService';

const makeValid = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  profilerChannel: 'perf-summary',
  source: 'renderer',
  longTasks: { count: 4, p50Ms: 60, p95Ms: 180, maxMs: 220 },
  inputLag: { count: 2, p50Ms: 120, p95Ms: 150, maxMs: 150 },
  batchStartMs: 1_000_000,
  batchEndMs: 1_060_000,
  batchId: 1,
  ...overrides,
});

describe('rendererPerfMonitorService — ingestion', () => {
  beforeEach(() => {
    resetRendererPerfCacheForTesting();
    warn.mockReset();
    debug.mockReset();
    info.mockReset();
    error.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caches a valid payload and returns it on read', () => {
    cacheRendererPerfSummary(makeValid());
    const cached = getLastRendererPerfSummary();
    expect(cached).not.toBeNull();
    expect(cached?.longTasks).toEqual({ count: 4, p50Ms: 60, p95Ms: 180, maxMs: 220 });
    expect(cached?.batchId).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops stale payload (batchEndMs smaller than cached)', () => {
    cacheRendererPerfSummary(makeValid({ batchEndMs: 2_000_000, batchId: 5 }));
    cacheRendererPerfSummary(makeValid({ batchEndMs: 1_500_000, batchId: 99 }));
    const cached = getLastRendererPerfSummary();
    expect(cached?.batchEndMs).toBe(2_000_000);
    expect(cached?.batchId).toBe(5);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]![1]).toBe('rendererPerfSampleStale');
  });

  it('drops stale by batchId tie-break (same batchEndMs, lower id)', () => {
    cacheRendererPerfSummary(makeValid({ batchEndMs: 2_000_000, batchId: 7 }));
    cacheRendererPerfSummary(makeValid({ batchEndMs: 2_000_000, batchId: 3 }));
    expect(getLastRendererPerfSummary()?.batchId).toBe(7);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        incomingBatchId: 3,
        cachedBatchId: 7,
      }),
      'rendererPerfSampleStale',
    );
  });

  it('accepts newer batchId when batchEndMs is equal', () => {
    cacheRendererPerfSummary(makeValid({ batchEndMs: 2_000_000, batchId: 7 }));
    cacheRendererPerfSummary(makeValid({ batchEndMs: 2_000_000, batchId: 8 }));
    expect(getLastRendererPerfSummary()?.batchId).toBe(8);
  });

  it('drops invalid shape and warns only once', () => {
    cacheRendererPerfSummary({ bogus: true });
    expect(warn).toHaveBeenCalledTimes(1);
    // Subsequent invalid payloads stay silent
    cacheRendererPerfSummary({ also: 'bad' });
    cacheRendererPerfSummary({ and: 'another' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getLastRendererPerfSummary()).toBeNull();
  });

  it('invalid shape does not disturb a previously-cached good entry', () => {
    cacheRendererPerfSummary(makeValid({ batchId: 10 }));
    cacheRendererPerfSummary({ bogus: true });
    expect(getLastRendererPerfSummary()?.batchId).toBe(10);
  });

  it('attributions array is preserved when present and well-formed', () => {
    cacheRendererPerfSummary(
      makeValid({
        attributions: [
          { category: 'script', labelPath: '/app/main.js', count: 3 },
          { category: 'unknown', labelPath: null, count: 1 },
        ],
      }),
    );
    const cached = getLastRendererPerfSummary()!;
    expect(cached.attributions).toEqual([
      { category: 'script', labelPath: '/app/main.js', count: 3 },
      { category: 'unknown', labelPath: null, count: 1 },
    ]);
  });

  it('malformed attribution entries are filtered, not fatal', () => {
    cacheRendererPerfSummary(
      makeValid({
        attributions: [
          { category: 'script', labelPath: '/ok.js', count: 2 },
          { category: 'script', labelPath: '/bad.js', count: -1 }, // negative count rejected
          null,
          { category: 'bogus', labelPath: '/x.js', count: 1 }, // invalid category
        ],
      }),
    );
    const cached = getLastRendererPerfSummary()!;
    expect(cached.attributions).toEqual([
      { category: 'script', labelPath: '/ok.js', count: 2 },
    ]);
  });
});

describe('rendererPerfMonitorService — staleness', () => {
  beforeEach(() => {
    resetRendererPerfCacheForTesting();
    warn.mockReset();
    debug.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null once past maxAgeMs (custom)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 1, 12, 0, 0));
    cacheRendererPerfSummary(makeValid());
    expect(getLastRendererPerfSummary(1)).not.toBeNull();

    vi.advanceTimersByTime(5);
    expect(getLastRendererPerfSummary(1)).toBeNull();
  });

  it('returns null after default 10 min window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 1, 12, 0, 0));
    cacheRendererPerfSummary(makeValid());
    expect(getLastRendererPerfSummary()).not.toBeNull();
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(getLastRendererPerfSummary()).toBeNull();
  });

  it('resetRendererPerfCacheForTesting clears state and re-arms warn', () => {
    cacheRendererPerfSummary({ bogus: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    resetRendererPerfCacheForTesting();
    cacheRendererPerfSummary({ still: 'bad' });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

// Ensure the type export is usable
const _t: RendererPerfSummary | null = null;
void _t;
