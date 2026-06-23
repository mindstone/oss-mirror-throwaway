/**
 * Main-side cache for renderer perf summaries (Stage 3 of
 * `docs/plans/260423_secondary_process_cpu_observability.md`).
 *
 * The prod renderer perf monitor emits 60 s batches via the existing
 * `log:event` IPC relay (no new channel). This module ingests those
 * payloads from `src/main/index.ts`' `log:event` handler, validates them,
 * and caches the latest. `perfDiagnosticService` reads the cache on each
 * periodic tick.
 *
 * Mirrors the shape of `cacheRendererSnapshot` in `ramTelemetryService`:
 * last-write-wins with a 10-minute staleness cap.
 *
 * Additional idempotent ingestion contract (Stage 3): payloads must have a
 * monotonic `(batchEndMs, batchId)` — older / duplicate deliveries are
 * dropped with a debug log so a late retry can't regress the cache.
 */

import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'rendererPerfMonitor' });

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────

export interface RendererPerfStats {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface RendererPerfAttribution {
  category: 'script' | 'layout' | 'paint' | 'unknown';
  labelPath: string | null;
  count: number;
}

export interface RendererPerfSummary {
  longTasks: RendererPerfStats;
  inputLag: RendererPerfStats;
  batchStartMs: number;
  batchEndMs: number;
  batchId: number;
  attributions?: RendererPerfAttribution[];
}

interface CacheEntry {
  batchEndMs: number;
  batchId: number;
  payload: RendererPerfSummary;
  receivedAtMs: number;
}

// ── Module state ─────────────────────────────────────────────────────

let cache: CacheEntry | null = null;
let shapeWarnEmitted = false;

// ── Validation ───────────────────────────────────────────────────────

function isPositiveNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function parseStats(value: unknown): RendererPerfStats | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const { count, p50Ms, p95Ms, maxMs } = obj;
  if (
    !isPositiveNumber(count) ||
    !isPositiveNumber(p50Ms) ||
    !isPositiveNumber(p95Ms) ||
    !isPositiveNumber(maxMs)
  ) {
    return null;
  }
  return { count, p50Ms, p95Ms, maxMs };
}

function parseAttributions(value: unknown): RendererPerfAttribution[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const out: RendererPerfAttribution[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const { category, labelPath, count } = rec;
    if (
      (category !== 'script' && category !== 'layout' && category !== 'paint' && category !== 'unknown') ||
      !(labelPath === null || typeof labelPath === 'string') ||
      !isPositiveNumber(count)
    ) {
      continue;
    }
    out.push({ category, labelPath: labelPath ?? null, count });
  }
  return out;
}

/**
 * Parse an untrusted context payload into a RendererPerfSummary. Returns
 * `null` if shape-invalid; never throws.
 */
function parseSummary(context: Record<string, unknown>): RendererPerfSummary | null {
  const longTasks = parseStats(context.longTasks);
  const inputLag = parseStats(context.inputLag);
  const batchStartMs = context.batchStartMs;
  const batchEndMs = context.batchEndMs;
  const batchId = context.batchId;

  if (!longTasks || !inputLag) return null;
  if (!isPositiveNumber(batchStartMs) || !isPositiveNumber(batchEndMs)) return null;
  if (!isPositiveNumber(batchId)) return null;
  if (batchEndMs < batchStartMs) return null;

  const attributions = parseAttributions(context.attributions);

  const summary: RendererPerfSummary = {
    longTasks,
    inputLag,
    batchStartMs,
    batchEndMs,
    batchId,
  };
  if (attributions && attributions.length > 0) {
    summary.attributions = attributions;
  }
  return summary;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Ingest a renderer perf summary from the `log:event` relay.
 *
 * Idempotent ingestion contract:
 *   - Accept if `batchEndMs > cache.batchEndMs`, OR
 *     `batchEndMs === cache.batchEndMs && batchId > cache.batchId`.
 *   - Otherwise drop and log at debug (`rendererPerfSampleStale`).
 *
 * Invalid shape: drop; emit a single warn for the first occurrence only
 * (per process lifetime) so repeated bad payloads don't flood the log.
 */
export function cacheRendererPerfSummary(context: Record<string, unknown>): void {
  const summary = parseSummary(context);
  if (!summary) {
    if (!shapeWarnEmitted) {
      shapeWarnEmitted = true;
      log.warn(
        { contextKeys: Object.keys(context) },
        'rendererPerfMonitor: dropped payload with invalid shape',
      );
    }
    return;
  }

  if (cache) {
    const isNewer =
      summary.batchEndMs > cache.batchEndMs ||
      (summary.batchEndMs === cache.batchEndMs && summary.batchId > cache.batchId);
    if (!isNewer) {
      log.debug(
        {
          incomingBatchEndMs: summary.batchEndMs,
          incomingBatchId: summary.batchId,
          cachedBatchEndMs: cache.batchEndMs,
          cachedBatchId: cache.batchId,
        },
        'rendererPerfSampleStale',
      );
      return;
    }
  }

  cache = {
    batchEndMs: summary.batchEndMs,
    batchId: summary.batchId,
    payload: summary,
    receivedAtMs: Date.now(),
  };
}

/**
 * Return the most-recently cached renderer perf summary, or `null` if no
 * summary has been cached or the cached entry is older than `maxAgeMs`.
 *
 * @param maxAgeMs Maximum age relative to `Date.now()`. Default 10 min,
 *   matching `cacheRendererSnapshot`'s staleness cap in ramTelemetryService.
 */
export function getLastRendererPerfSummary(
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): RendererPerfSummary | null {
  if (!cache) return null;
  if (Date.now() - cache.receivedAtMs > maxAgeMs) return null;
  return cache.payload;
}

/** @internal Test-only: clear cached state between tests. */
export function resetRendererPerfCacheForTesting(): void {
  cache = null;
  shapeWarnEmitted = false;
}
