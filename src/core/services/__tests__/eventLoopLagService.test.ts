/**
 * Tests for `eventLoopLagService` (Stage 2 of
 * `docs/plans/260423_secondary_process_cpu_observability.md`).
 *
 * Covered:
 *  1. `sample()` returns full `status: 'ok'` shape with ns → ms conversion.
 *  2. `sample()` calls `reset()` on the histogram each tick.
 *  3. `windowDurationMs` monotonically increases across successive samples.
 *  4. Init failure: thrown `_createHistogramForTesting` → `status: 'unavailable'`,
 *     exactly one warn logged.
 *  5. Real `monitorEventLoopDelay` integration smoke (`mean < 25ms` on an
 *     idle loop). Skipped when `CI=true` is set to avoid flake.
 *  6. `dispose()` is idempotent.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';

import { startEventLoopLagMonitor, type EventLoopLagSample } from '../eventLoopLagService';

// ── Helpers ──────────────────────────────────────────────────────────

/** Minimal pino-shaped logger stub. */
const stubLogger = (): Logger => {
  const fn = vi.fn();
  return {
    info: fn,
    warn: fn,
    error: fn,
    debug: fn,
    fatal: fn,
    trace: fn,
    silent: fn,
    child: vi.fn(() => stubLogger()),
    level: 'info',
    isLevelEnabled: () => true,
  } as unknown as Logger;
};

interface FakeHistogram {
  percentile: (n: number) => number;
  max: number;
  min: number;
  mean: number;
  reset: () => void;
  enable?: () => boolean;
  disable?: () => boolean;
  __resetCount: number;
}

/** Fake histogram matching the narrow surface used by the service. */
const makeFakeHistogram = (initial: {
  p50?: number;
  p95?: number;
  p99?: number;
  max?: number;
  min?: number;
  mean?: number;
} = {}): FakeHistogram => {
  const fake: FakeHistogram = {
    percentile: vi.fn((n: number) => {
      switch (n) {
        case 50:
          return initial.p50 ?? 2_000_000;
        case 95:
          return initial.p95 ?? 5_000_000;
        case 99:
          return initial.p99 ?? 10_000_000;
        default:
          return 0;
      }
    }),
    max: initial.max ?? 12_000_000,
    min: initial.min ?? 1_000_000,
    mean: initial.mean ?? 3_000_000,
    reset: vi.fn(),
    enable: vi.fn(() => true),
    disable: vi.fn(() => true),
    __resetCount: 0,
  };
  // Track resets inline so we can assert per-tick.
  (fake.reset as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
    fake.__resetCount += 1;
  });
  return fake;
};

// ── Tests ────────────────────────────────────────────────────────────

describe('eventLoopLagService — sample()', () => {
  it('returns the full ok-shape with ns→ms conversion', () => {
    const fake = makeFakeHistogram({
      p50: 2_000_000, // 2 ms
      p95: 5_000_000, // 5 ms
      p99: 10_000_000, // 10 ms
      max: 12_000_000, // 12 ms
      min: 1_000_000, // 1 ms
      mean: 3_000_000, // 3 ms
    });

    const monitor = startEventLoopLagMonitor({
      _createHistogramForTesting: () => fake as never,
    });

    const sample = monitor.sample();
    expect(sample.status).toBe('ok');
    if (sample.status !== 'ok') throw new Error('unreachable');

    expect(sample.p50).toBe(2);
    expect(sample.p95).toBe(5);
    expect(sample.p99).toBe(10);
    expect(sample.max).toBe(12);
    expect(sample.min).toBe(1);
    expect(sample.mean).toBe(3);
    expect(sample.windowDurationMs).toBeGreaterThanOrEqual(0);

    monitor.dispose();
  });

  it('calls reset() on the histogram each tick', () => {
    const fake = makeFakeHistogram();
    const monitor = startEventLoopLagMonitor({
      _createHistogramForTesting: () => fake as never,
    });

    expect(fake.__resetCount).toBe(0);
    monitor.sample();
    expect(fake.__resetCount).toBe(1);
    monitor.sample();
    expect(fake.__resetCount).toBe(2);
    monitor.sample();
    expect(fake.__resetCount).toBe(3);

    monitor.dispose();
  });

  it('windowDurationMs increases between successive samples', async () => {
    const fake = makeFakeHistogram();
    const monitor = startEventLoopLagMonitor({
      _createHistogramForTesting: () => fake as never,
    });

    const first = monitor.sample();
    // Non-zero real elapsed time so windowDurationMs is meaningful on both ticks.
    await new Promise((r) => setTimeout(r, 5));
    const second = monitor.sample();

    // First tick: windowDurationMs is ~(time from startEventLoopLagMonitor()
    // call to first sample()) — typically tiny but ≥0.
    expect(first.windowDurationMs).toBeGreaterThanOrEqual(0);
    // Second tick: ≥5ms (we waited 5ms).
    expect(second.windowDurationMs).toBeGreaterThanOrEqual(4);

    monitor.dispose();
  });
});

describe('eventLoopLagService — histogram read failure', () => {
  it('when percentile() throws: returns unavailable, still resets, next sample behaves normally', () => {
    const fake = makeFakeHistogram();
    // First call throws; subsequent calls behave normally.
    let call = 0;
    (fake.percentile as unknown as ReturnType<typeof vi.fn>).mockImplementation((n: number) => {
      call += 1;
      if (call === 1) {
        throw new Error('percentile exploded');
      }
      switch (n) {
        case 50:
          return 2_000_000;
        case 95:
          return 5_000_000;
        case 99:
          return 10_000_000;
        default:
          return 0;
      }
    });

    const monitor = startEventLoopLagMonitor({
      _createHistogramForTesting: () => fake as never,
    });

    // First sample: percentile throws → status: 'unavailable'.
    expect(fake.__resetCount).toBe(0);
    const first = monitor.sample();
    expect(first.status).toBe('unavailable');
    if (first.status !== 'unavailable') throw new Error('unreachable');
    expect(first.error).toContain('percentile exploded');
    // M1 contract: reset() still ran despite the read throw.
    expect(fake.__resetCount).toBe(1);

    // Second sample: percentile succeeds → status: 'ok', reset() ran again.
    const second = monitor.sample();
    expect(second.status).toBe('ok');
    expect(fake.__resetCount).toBe(2);

    monitor.dispose();
  });

  it('when reset() throws: does not propagate; logs a warn', () => {
    const logger = stubLogger();
    const warnFn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    const fake = makeFakeHistogram();
    (fake.reset as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      fake.__resetCount += 1;
      throw new Error('reset exploded');
    });

    const monitor = startEventLoopLagMonitor({
      logger,
      _createHistogramForTesting: () => fake as never,
    });

    expect(() => monitor.sample()).not.toThrow();
    // reset() attempted exactly once and the warn was emitted.
    expect(fake.__resetCount).toBe(1);
    expect(warnFn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('reset'),
    );

    monitor.dispose();
  });
});

describe('eventLoopLagService — sample() after dispose()', () => {
  it('returns { status: "unavailable", error: "monitor disposed", windowDurationMs: 0 } with no log', () => {
    const logger = stubLogger();
    const warnFn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    const fake = makeFakeHistogram();

    const monitor = startEventLoopLagMonitor({
      logger,
      _createHistogramForTesting: () => fake as never,
    });

    // Healthy sample first.
    const ok = monitor.sample();
    expect(ok.status).toBe('ok');

    // Dispose, then sample() again.
    monitor.dispose();

    // Clear any warns produced up to this point (there shouldn't be any from
    // the healthy path, but we're explicit about the "no log" assertion).
    warnFn.mockClear();

    const afterDispose = monitor.sample();
    expect(afterDispose.status).toBe('unavailable');
    if (afterDispose.status !== 'unavailable') throw new Error('unreachable');
    expect(afterDispose.error).toBe('monitor disposed');
    expect(afterDispose.windowDurationMs).toBe(0);

    // Disposed is terminal: no log emitted on this path.
    expect(warnFn).not.toHaveBeenCalled();
  });
});

describe('eventLoopLagService — init failure', () => {
  it('returns a degraded monitor and logs one warn when _createHistogramForTesting throws', () => {
    const logger = stubLogger();
    const warnFn = logger.warn as unknown as ReturnType<typeof vi.fn>;

    const monitor = startEventLoopLagMonitor({
      logger,
      _createHistogramForTesting: () => {
        throw new Error('histogram init exploded');
      },
    });

    // Exactly one warn.
    expect(warnFn).toHaveBeenCalledTimes(1);
    expect(warnFn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('eventLoopLagService'),
    );

    const sample: EventLoopLagSample = monitor.sample();
    expect(sample.status).toBe('unavailable');
    if (sample.status !== 'unavailable') throw new Error('unreachable');
    expect(sample.error).toContain('histogram init exploded');
    expect(sample.windowDurationMs).toBe(0);

    // Subsequent samples still degrade; no additional warns are emitted.
    monitor.sample();
    monitor.sample();
    expect(warnFn).toHaveBeenCalledTimes(1);

    monitor.dispose();
  });

  it('does not throw when dispose is called on a degraded monitor', () => {
    const monitor = startEventLoopLagMonitor({
      _createHistogramForTesting: () => {
        throw new Error('boom');
      },
    });
    expect(() => monitor.dispose()).not.toThrow();
  });
});

describe('eventLoopLagService — dispose()', () => {
  it('is idempotent: calling dispose twice does not throw', () => {
    const fake = makeFakeHistogram();
    const monitor = startEventLoopLagMonitor({
      _createHistogramForTesting: () => fake as never,
    });

    expect(() => {
      monitor.dispose();
      monitor.dispose();
    }).not.toThrow();

    // disable() called at most once (second dispose() is a no-op).
    const disableFn = fake.disable as unknown as ReturnType<typeof vi.fn>;
    expect(disableFn).toHaveBeenCalledTimes(1);
  });
});

// ── Integration smoke ────────────────────────────────────────────────

// Skip on CI where the busy-runner may cause false positives (the acceptance
// bound is 25 ms mean, matching the plan's Stage 2 idle-loop expectation).
const skipOnCI = process.env.CI === 'true' || process.env.CI === '1';
describe.skipIf(skipOnCI)('eventLoopLagService — real monitorEventLoopDelay integration', () => {
  it('reports mean < 25 ms on an idle loop after ~200ms', async () => {
    const monitor = startEventLoopLagMonitor();
    // Let the histogram accumulate on an idle loop.
    await new Promise((r) => setTimeout(r, 200));
    const sample = monitor.sample();
    expect(sample.status).toBe('ok');
    if (sample.status !== 'ok') throw new Error('unreachable');
    expect(sample.mean).toBeLessThan(25);
    expect(sample.windowDurationMs).toBeGreaterThanOrEqual(150);
    monitor.dispose();
  });
});
