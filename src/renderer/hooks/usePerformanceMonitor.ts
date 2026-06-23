/**
 * Unified renderer performance monitor (Stage 3 of
 * `docs/plans/260423_secondary_process_cpu_observability.md`).
 *
 * Replaces the dev-only `useDevPerformanceMonitor` with three modes:
 *
 * - `mode: 'dev'`  — 10 s console.warn summaries (previous dev behaviour).
 * - `mode: 'prod'` — 60 s batched summaries emitted to main via the
 *                    existing `log:event` relay. PII-scrubbed attribution;
 *                    zero traffic when the bucket is empty.
 * - `mode: 'off'`  — no-op; observer / listener / timer are never installed.
 *
 * The prod-mode emission piggybacks on the existing renderer-log bridge
 * (no new IPC channel). Main-side `rendererPerfMonitorService` picks up
 * the `profilerChannel: 'perf-summary'` context tag and caches the summary
 * for inclusion in the periodic perf diagnostic.
 */

import { useEffect } from 'react';
import type { RendererLogPayload } from '@shared/types';
import { scrubAttribution, type ScrubbedAttribution } from './performanceMonitor/scrubAttribution';

export { formatLongTaskAttribution } from './performanceMonitor/scrubAttribution';

// ── Tunables ─────────────────────────────────────────────────────────
export const DEV_FLUSH_INTERVAL_MS = 10_000;
export const PROD_FLUSH_INTERVAL_MS = 60_000;
const LONG_TASK_THRESHOLD_MS = 50;
const INPUT_LAG_THRESHOLD_MS = 100;

// ── Types ────────────────────────────────────────────────────────────

export type PerfMonitorMode = 'dev' | 'prod' | 'off';

export interface UsePerformanceMonitorOptions {
  mode: PerfMonitorMode;
  /**
   * Emitter used in `prod` mode. Unused in `dev` / `off`. Must accept a
   * RendererLogPayload; `source` is filled in by the caller/preload.
   */
  emitLog?: (payload: RendererLogPayload) => void;
}

interface StatSummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface PerfBucket {
  longTasks: number[];
  inputLags: number[];
  /** Prod-mode only: scrubbed attribution counts. */
  attributionCounts: Map<string, { category: ScrubbedAttribution['category']; labelPath: string | null; count: number }>;
  /** Dev-mode only: free-form attribution strings for top-source label. */
  rawAttributions: string[];
  startMs: number;
}

function createBucket(startMs: number): PerfBucket {
  return {
    longTasks: [],
    inputLags: [],
    attributionCounts: new Map(),
    rawAttributions: [],
    startMs,
  };
}

function summarize(arr: number[]): StatSummary | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const pickAt = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
    return Math.round(sorted[idx] ?? 0);
  };
  return {
    count: arr.length,
    p50Ms: pickAt(0.5),
    p95Ms: pickAt(0.95),
    maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
  };
}

// ── Dev-mode helpers (console.warn summaries) ───────────────────────

function formatStatString(s: StatSummary): string {
  return `${s.count}x (p50=${s.p50Ms}ms p95=${s.p95Ms}ms max=${s.maxMs}ms)`;
}

function mostCommonRawAttribution(attributions: string[]): string | null {
  if (attributions.length === 0) return null;
  const counts = new Map<string, number>();
  let top: string | null = null;
  let topCount = 0;
  for (const a of attributions) {
    const c = (counts.get(a) ?? 0) + 1;
    counts.set(a, c);
    if (c > topCount) {
      top = a;
      topCount = c;
    }
  }
  return top;
}

// ── Hook ─────────────────────────────────────────────────────────────

/**
 * Mount at app root. Safe to call once; do not mount from child components.
 */
export function usePerformanceMonitor(opts: UsePerformanceMonitorOptions): void {
  const { mode, emitLog } = opts;

  useEffect(() => {
    if (mode === 'off') return;
    if (mode === 'prod' && typeof emitLog !== 'function') {
      // Prod mode without an emitter is a programming error — degrade to
      // no-op rather than silently dropping data, so the caller notices.
      console.warn('[PERF] usePerformanceMonitor: prod mode requires emitLog; degrading to no-op');
      return;
    }

    let bucket = createBucket(Date.now());
    let batchId = 0;

    // Layer 1: Long Task Observer
    let longTaskObserver: PerformanceObserver | null = null;
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration < LONG_TASK_THRESHOLD_MS) continue;
            bucket.longTasks.push(entry.duration);

            if (mode === 'prod') {
              const scrubbed = scrubAttribution(entry);
              const key = `${scrubbed.category}|${scrubbed.labelPath ?? ''}`;
              const existing = bucket.attributionCounts.get(key);
              if (existing) {
                existing.count += 1;
              } else {
                bucket.attributionCounts.set(key, {
                  category: scrubbed.category,
                  labelPath: scrubbed.labelPath,
                  count: 1,
                });
              }
            } else {
              // Dev: keep the legacy free-form attribution string.
              const first = (entry as unknown as { attribution?: Array<{
                containerType?: string;
                containerSrc?: string;
                containerName?: string;
              }> }).attribution?.[0];
              if (first) {
                const t = first.containerType || 'unknown';
                const label = first.containerName || first.containerSrc || '';
                bucket.rawAttributions.push(label ? `${t}(${label})` : t);
              }
            }
          }
        });
        longTaskObserver.observe({ type: 'longtask', buffered: true });
      } catch {
        // longtask entry type not supported — silently skip (same behaviour
        // as the legacy dev hook).
      }
    }

    // Layer 2: Input Event Latency (keydown → rAF delta).
    const onKeydown = (e: KeyboardEvent) => {
      const ts = e.timeStamp;
      requestAnimationFrame(() => {
        const totalLag = performance.now() - ts;
        if (totalLag >= INPUT_LAG_THRESHOLD_MS) {
          bucket.inputLags.push(totalLag);
        }
      });
    };
    document.addEventListener('keydown', onKeydown, { passive: true });

    // Periodic flush
    const flushIntervalMs = mode === 'dev' ? DEV_FLUSH_INTERVAL_MS : PROD_FLUSH_INTERVAL_MS;
    const flushTimer = setInterval(() => {
      const prev = bucket;
      const batchEndMs = Date.now();
      bucket = createBucket(batchEndMs);

      const hasData = prev.longTasks.length > 0 || prev.inputLags.length > 0;
      if (!hasData) {
        // Zero traffic → zero emissions. Per Stage 3 contract.
        return;
      }

      batchId += 1;
      const longTaskStats = summarize(prev.longTasks);
      const inputLagStats = summarize(prev.inputLags);

      if (mode === 'dev') {
        const parts: string[] = ['[PERF]'];
        if (longTaskStats) {
          const topAttr = mostCommonRawAttribution(prev.rawAttributions);
          parts.push(
            `LongTasks: ${formatStatString(longTaskStats)}${topAttr ? ` source=${topAttr}` : ''}`,
          );
        }
        if (inputLagStats) {
          parts.push(`InputLag(>${INPUT_LAG_THRESHOLD_MS}ms): ${formatStatString(inputLagStats)}`);
        }
        console.warn(parts.join(' | '));
        return;
      }

      // mode === 'prod' — emit via log:event (no new channel).
      if (!emitLog) return; // Guarded at the top, but appease TS narrowing.

      // Serialise attribution counts as a bounded array (cap at 10 entries
      // sorted by count) so a pathological burst can't bloat the log line.
      const attributions = Array.from(prev.attributionCounts.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map((a) => ({ category: a.category, labelPath: a.labelPath, count: a.count }));

      const context: Record<string, unknown> = {
        profilerChannel: 'perf-summary',
        source: 'renderer',
        longTasks: longTaskStats ?? { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
        inputLag: inputLagStats ?? { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
        batchStartMs: prev.startMs,
        batchEndMs,
        batchId,
      };
      if (attributions.length > 0) {
        context.attributions = attributions;
      }

      try {
        emitLog({
          level: 'info',
          message: 'Renderer perf summary',
          timestamp: batchEndMs,
          context,
        });
      } catch {
        // Swallow emit failures silently — perf telemetry must never crash
        // the renderer; the log bridge already has its own error swallow.
      }
    }, flushIntervalMs);

    if (mode === 'dev') {
      console.warn('[PERF] Dev performance monitor active (long tasks + input latency)');
    }

    return () => {
      longTaskObserver?.disconnect();
      document.removeEventListener('keydown', onKeydown);
      clearInterval(flushTimer);
    };
  }, [mode, emitLog]);
}
