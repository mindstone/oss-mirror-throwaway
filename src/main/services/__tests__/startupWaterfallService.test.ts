/**
 * Unit tests for startupWaterfallService.
 *
 * Covers Stage 1 acceptance criteria from
 * docs/plans/260420_perf_observability_and_low_risk_wins.md:
 *  - `markStartup()` is a no-op when REBEL_PERF_MODE !== '1'
 *  - When mode is on, marks append with monotonic elapsedMs
 *  - `getWaterfall()` returns the array
 *  - `_resetForTesting()` clears both `marks` and `performance.mark()` entries
 *  - `logWaterfall()` does not throw when marks are empty
 *
 * IS_PERF_MODE is captured at module load, so each test uses `vi.resetModules()`
 * + `vi.stubEnv()` BEFORE the dynamic import to control the gate deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('startupWaterfallService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('when REBEL_PERF_MODE !== "1"', () => {
    it('markStartup is a no-op (no marks accumulate)', async () => {
      vi.stubEnv('REBEL_PERF_MODE', '0');
      const mod = await import('../startupWaterfallService');
      mod.markStartup('alpha');
      mod.markStartup('beta');
      expect(mod.getWaterfall()).toEqual([]);
    });

    it('markStartup is a no-op when env var is unset', async () => {
      vi.stubEnv('REBEL_PERF_MODE', '');
      const mod = await import('../startupWaterfallService');
      mod.markStartup('x');
      expect(mod.getWaterfall()).toEqual([]);
    });
  });

  describe('when REBEL_PERF_MODE === "1"', () => {
    it('marks append with monotonic elapsedMs', async () => {
      vi.stubEnv('REBEL_PERF_MODE', '1');
      const mod = await import('../startupWaterfallService');
      mod._resetForTesting();

      mod.markStartup('first');
      // Small delay so the second mark is measurably later.
      await new Promise((resolve) => setTimeout(resolve, 2));
      mod.markStartup('second');
      await new Promise((resolve) => setTimeout(resolve, 2));
      mod.markStartup('third');

      const waterfall = mod.getWaterfall();
      expect(waterfall).toHaveLength(3);
      expect(waterfall[0].name).toBe('first');
      expect(waterfall[1].name).toBe('second');
      expect(waterfall[2].name).toBe('third');
      // Monotonic (non-decreasing) elapsedMs.
      expect(waterfall[1].elapsedMs).toBeGreaterThanOrEqual(waterfall[0].elapsedMs);
      expect(waterfall[2].elapsedMs).toBeGreaterThanOrEqual(waterfall[1].elapsedMs);
      // deltaMs == elapsedMs for the first mark (prev = 0).
      expect(waterfall[0].deltaMs).toBe(waterfall[0].elapsedMs);
      // deltaMs is elapsed-diff between marks.
      expect(waterfall[1].deltaMs).toBe(waterfall[1].elapsedMs - waterfall[0].elapsedMs);
      expect(waterfall[2].deltaMs).toBe(waterfall[2].elapsedMs - waterfall[1].elapsedMs);
    });

    it('getWaterfall returns a copy (mutations do not leak into module state)', async () => {
      vi.stubEnv('REBEL_PERF_MODE', '1');
      const mod = await import('../startupWaterfallService');
      mod._resetForTesting();

      mod.markStartup('only');
      const snapshot = mod.getWaterfall();
      snapshot.push({ name: 'injected', elapsedMs: 999_999, deltaMs: 999_999 });
      expect(mod.getWaterfall()).toHaveLength(1);
      expect(mod.getWaterfall()[0].name).toBe('only');
    });

    it('_resetForTesting clears marks array', async () => {
      vi.stubEnv('REBEL_PERF_MODE', '1');
      const mod = await import('../startupWaterfallService');
      mod._resetForTesting();

      mod.markStartup('foo');
      mod.markStartup('bar');
      expect(mod.getWaterfall()).toHaveLength(2);

      mod._resetForTesting();
      expect(mod.getWaterfall()).toEqual([]);
    });

    it('_resetForTesting clears performance.mark entries', async () => {
      vi.stubEnv('REBEL_PERF_MODE', '1');
      const mod = await import('../startupWaterfallService');
      const { performance } = await import('node:perf_hooks');
      mod._resetForTesting();

      mod.markStartup('unique-test-mark-name');
      // performance.mark() call recorded while perf mode on.
      const before = performance.getEntriesByName('startup:unique-test-mark-name');
      expect(before.length).toBeGreaterThan(0);

      mod._resetForTesting();
      const after = performance.getEntriesByName('startup:unique-test-mark-name');
      expect(after).toHaveLength(0);
    });

    it('logWaterfall does not throw when marks are empty', async () => {
      vi.stubEnv('REBEL_PERF_MODE', '1');
      const mod = await import('../startupWaterfallService');
      mod._resetForTesting();
      expect(() => mod.logWaterfall()).not.toThrow();
    });

    it('logWaterfall does not throw when marks are present', async () => {
      vi.stubEnv('REBEL_PERF_MODE', '1');
      const mod = await import('../startupWaterfallService');
      mod._resetForTesting();
      mod.markStartup('one');
      mod.markStartup('two');
      expect(() => mod.logWaterfall()).not.toThrow();
    });

    it('logWaterfall clears both performance marks AND the in-memory marks array', async () => {
      vi.stubEnv('REBEL_PERF_MODE', '1');
      const mod = await import('../startupWaterfallService');
      mod._resetForTesting();
      mod.markStartup('waterfall-clear-a');
      mod.markStartup('waterfall-clear-b');

      expect(mod.getWaterfall().length).toBe(2);
      expect(performance.getEntriesByName('startup:waterfall-clear-a').length).toBeGreaterThan(0);

      mod.logWaterfall();

      // Both the module-level marks array and the performance.mark() entries
      // must be cleared — otherwise HMR / window recreation replays stale data.
      expect(mod.getWaterfall()).toHaveLength(0);
      expect(performance.getEntriesByName('startup:waterfall-clear-a')).toHaveLength(0);
      expect(performance.getEntriesByName('startup:waterfall-clear-b')).toHaveLength(0);

      // A second logWaterfall must be a no-op (marks.length === 0 short-circuit).
      expect(() => mod.logWaterfall()).not.toThrow();
    });
  });
});
