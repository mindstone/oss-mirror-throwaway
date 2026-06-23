// @vitest-environment happy-dom
/**
 * React-hook tests for `usePerformanceMonitor` (Stage 3 of
 * `docs/plans/260423_secondary_process_cpu_observability.md`).
 *
 * Covers:
 *   - Prod mode emits ONE batch per flush interval when long tasks arrive.
 *   - Zero traffic → zero emissions (bucket empty → no send).
 *   - Observer disconnects on unmount.
 *   - batchId monotonically increases across emissions.
 *   - Dev mode uses console.warn summaries, not emitLog.
 *   - Off mode never installs the observer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, setupFakeTimers, cleanupFakeTimers } from '../../test-utils/hookTestHarness';
import { usePerformanceMonitor, PROD_FLUSH_INTERVAL_MS, DEV_FLUSH_INTERVAL_MS } from '../usePerformanceMonitor';
import type { RendererLogPayload } from '@shared/types';

// ── Mock PerformanceObserver ────────────────────────────────────────

type PerfObserverCallback = (list: { getEntries: () => PerformanceEntry[] }) => void;

interface FakeObserver {
  callback: PerfObserverCallback;
  observed: boolean;
  disconnected: boolean;
}

let activeObservers: FakeObserver[] = [];

class MockPerformanceObserver {
  public observed = false;
  public disconnected = false;
  constructor(public callback: PerfObserverCallback) {
    const self = this as unknown as FakeObserver;
    activeObservers.push(self);
  }
  observe(_opts: { type: string; buffered?: boolean }): void {
    this.observed = true;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

function emitLongTasks(durations: number[]): void {
  const entries: PerformanceEntry[] = durations.map((duration, i) => ({
    name: 'self',
    duration,
    startTime: 1000 + i * 100,
    entryType: 'longtask',
    toJSON: () => ({}),
    // Provide attribution to exercise scrubAttribution in prod mode
    attribution: [{ containerType: 'window', containerSrc: '/app/main.js', containerName: '' }],
  }) as unknown as PerformanceEntry);
  for (const o of activeObservers) {
    if (!o.disconnected) {
      o.callback({ getEntries: () => entries });
    }
  }
}

// ── Suite ────────────────────────────────────────────────────────────

describe('usePerformanceMonitor — prod mode', () => {
  let originalObserver: typeof PerformanceObserver | undefined;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    activeObservers = [];
    originalObserver = globalThis.PerformanceObserver;
    (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver =
      MockPerformanceObserver as unknown as typeof PerformanceObserver;
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupFakeTimers();
  });

  afterEach(() => {
    cleanupFakeTimers();
    consoleWarnSpy.mockRestore();
    (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver =
      originalObserver as unknown as typeof PerformanceObserver;
  });

  it('emits exactly one batch after the flush interval when long tasks arrive', () => {
    const emitLog = vi.fn<(p: RendererLogPayload) => void>();
    renderHook(() => usePerformanceMonitor({ mode: 'prod', emitLog }));

    emitLongTasks([120, 80, 300]);
    expect(emitLog).not.toHaveBeenCalled();

    vi.advanceTimersByTime(PROD_FLUSH_INTERVAL_MS);
    expect(emitLog).toHaveBeenCalledTimes(1);

    const call = emitLog.mock.calls[0]![0];
    expect(call.level).toBe('info');
    expect(call.message).toBe('Renderer perf summary');
    expect(call.context?.profilerChannel).toBe('perf-summary');
    expect(call.context?.source).toBe('renderer');
    const longTasks = call.context?.longTasks as { count: number };
    expect(longTasks.count).toBe(3);
    expect(call.context?.batchId).toBe(1);
    expect(typeof call.context?.batchStartMs).toBe('number');
    expect(typeof call.context?.batchEndMs).toBe('number');
  });

  it('sends nothing across multiple intervals when bucket is empty', () => {
    const emitLog = vi.fn<(p: RendererLogPayload) => void>();
    renderHook(() => usePerformanceMonitor({ mode: 'prod', emitLog }));

    vi.advanceTimersByTime(PROD_FLUSH_INTERVAL_MS * 5);
    expect(emitLog).not.toHaveBeenCalled();
  });

  it('batchId monotonically increases across emissions', () => {
    const emitLog = vi.fn<(p: RendererLogPayload) => void>();
    renderHook(() => usePerformanceMonitor({ mode: 'prod', emitLog }));

    emitLongTasks([100]);
    vi.advanceTimersByTime(PROD_FLUSH_INTERVAL_MS);
    emitLongTasks([200]);
    vi.advanceTimersByTime(PROD_FLUSH_INTERVAL_MS);
    emitLongTasks([300]);
    vi.advanceTimersByTime(PROD_FLUSH_INTERVAL_MS);

    expect(emitLog).toHaveBeenCalledTimes(3);
    const batchIds = emitLog.mock.calls.map((c) => c[0].context?.batchId);
    expect(batchIds).toEqual([1, 2, 3]);
  });

  it('skips batchId increment for zero-data flushes', () => {
    const emitLog = vi.fn<(p: RendererLogPayload) => void>();
    renderHook(() => usePerformanceMonitor({ mode: 'prod', emitLog }));

    // Flush with no data → no emit → batchId stays at 0 internally.
    vi.advanceTimersByTime(PROD_FLUSH_INTERVAL_MS);
    emitLongTasks([100]);
    vi.advanceTimersByTime(PROD_FLUSH_INTERVAL_MS);
    expect(emitLog).toHaveBeenCalledTimes(1);
    expect(emitLog.mock.calls[0]![0].context?.batchId).toBe(1);
  });

  it('disconnects the PerformanceObserver on unmount', () => {
    const emitLog = vi.fn<(p: RendererLogPayload) => void>();
    const { unmount } = renderHook(() => usePerformanceMonitor({ mode: 'prod', emitLog }));

    expect(activeObservers).toHaveLength(1);
    expect(activeObservers[0]!.disconnected).toBe(false);

    unmount();
    expect(activeObservers[0]!.disconnected).toBe(true);

    // Flush timer should also be cleared — advancing time does nothing.
    emitLongTasks([200]); // into a now-disconnected observer
    vi.advanceTimersByTime(PROD_FLUSH_INTERVAL_MS);
    expect(emitLog).not.toHaveBeenCalled();
  });

  it('includes scrubbed attribution entries (enum category + path-only)', () => {
    const emitLog = vi.fn<(p: RendererLogPayload) => void>();
    renderHook(() => usePerformanceMonitor({ mode: 'prod', emitLog }));

    emitLongTasks([100, 150]);
    vi.advanceTimersByTime(PROD_FLUSH_INTERVAL_MS);

    const call = emitLog.mock.calls[0]![0];
    const attributions = call.context?.attributions as Array<{
      category: string;
      labelPath: string | null;
      count: number;
    }>;
    expect(Array.isArray(attributions)).toBe(true);
    expect(attributions[0]!.category).toBe('script');
    expect(attributions[0]!.labelPath).toBe('/app/main.js');
    expect(attributions[0]!.count).toBe(2);
  });
});

describe('usePerformanceMonitor — dev mode', () => {
  let originalObserver: typeof PerformanceObserver | undefined;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    activeObservers = [];
    originalObserver = globalThis.PerformanceObserver;
    (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver =
      MockPerformanceObserver as unknown as typeof PerformanceObserver;
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setupFakeTimers();
  });

  afterEach(() => {
    cleanupFakeTimers();
    consoleWarnSpy.mockRestore();
    (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver =
      originalObserver as unknown as typeof PerformanceObserver;
  });

  it('logs a [PERF] summary via console.warn and does not call emitLog', () => {
    const emitLog = vi.fn<(p: RendererLogPayload) => void>();
    renderHook(() => usePerformanceMonitor({ mode: 'dev', emitLog }));

    // Startup banner — one call already
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockClear();

    emitLongTasks([100, 120]);
    vi.advanceTimersByTime(DEV_FLUSH_INTERVAL_MS);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy.mock.calls[0]![0]).toMatch(/\[PERF\]/);
    expect(consoleWarnSpy.mock.calls[0]![0]).toMatch(/LongTasks:/);
    expect(emitLog).not.toHaveBeenCalled();
  });
});

describe('usePerformanceMonitor — off mode', () => {
  let originalObserver: typeof PerformanceObserver | undefined;

  beforeEach(() => {
    activeObservers = [];
    originalObserver = globalThis.PerformanceObserver;
    (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver =
      MockPerformanceObserver as unknown as typeof PerformanceObserver;
    setupFakeTimers();
  });

  afterEach(() => {
    cleanupFakeTimers();
    (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver =
      originalObserver as unknown as typeof PerformanceObserver;
  });

  it('never installs the PerformanceObserver nor emits', () => {
    const emitLog = vi.fn<(p: RendererLogPayload) => void>();
    renderHook(() => usePerformanceMonitor({ mode: 'off', emitLog }));

    expect(activeObservers).toHaveLength(0);
    vi.advanceTimersByTime(PROD_FLUSH_INTERVAL_MS);
    expect(emitLog).not.toHaveBeenCalled();
  });
});
