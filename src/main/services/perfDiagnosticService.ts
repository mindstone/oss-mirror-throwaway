/**
 * Periodic performance diagnostic for the main process.
 *
 * Extracted from `src/main/index.ts` (Stage 1 of
 * `docs/plans/260423_secondary_process_cpu_observability.md`). Restores
 * visibility into background CPU by:
 *
 * - Throttling (instead of pausing) on blur AND minimize. Foreground cadence
 *   preserved at 5 min; blurred / minimized cadence is 120 s.
 * - Including GPU lifecycle counters (`blurDisposalCount`, `focusWarmUpCount`,
 *   etc.) so blur→focus GPU churn is attributable.
 * - Computing lifetime-CPU delta (`cpuMsSinceLast`) per process so we can see
 *   high-average-low-instant CPU patterns that `percentCPUUsage` alone misses.
 * - Preserving the `msg: "Memory diagnostic"` log line and all existing fields
 *   (additive-only) — existing log consumers keep working.
 *
 * Seams exposed for later stages:
 *  - `scheduler`, `getRamSnapshot`, `getAppMetrics`, `getGpuLifecycle`,
 *    `getVisibilityKind` — injectable dependencies used by the payload builder.
 *  - `getRendererPerfSummary` (Stage 3) — populated when a renderer long-task
 *    summary arrives via the existing `log:event` relay. Defaults to reading
 *    the module-local cache in `rendererPerfMonitorService`; `null` when no
 *    summary has been cached or the cached entry is older than 10 min.
 *  - `getEventLoopLag` (Stage 2) — default returns `null`; the Stage 2 service
 *    will replace this with a real `perf_hooks.monitorEventLoopDelay` sampler.
 *
 * Fail-observable contract (from the plan):
 *  - GPU lifecycle provider that throws ⇒ `gpuLifecycle: { status: 'unavailable', error }`
 *    in the payload; the emission still succeeds.
 *  - `app.getAppMetrics()` throwing ⇒ logged warn + degraded payload
 *    (`processes: []`, `totalCpuPercent: 0`, `cpuMsSinceLast: null`).
 *  - First observation of a PID ⇒ `cpuMsSinceLast: null` (never `0`).
 *
 * Renderer-related fields — independent origins (no coupled-null guarantee):
 *  - `rendererSnapshot`: passed through from `RamSnapshot.rendererSnapshot`.
 *    This is the renderer-reported self-stats (V8 heap, loaded sessions /
 *    messages) cached via IPC from the renderer's own periodic memory
 *    diagnostic. `null` when no snapshot has been received or the latest is
 *    stale (>10 min old — see `ramTelemetryService.captureRamSnapshot`).
 *  - `rendererCpuMsSinceLast`: derived independently from the main-process
 *    `app.getAppMetrics()` row labelled `mainUI` (or `hiddenRenderer:PID`
 *    when the window is minimized / hidden). `null` on first tick for that
 *    PID, when the row is absent, or when the metrics call failed.
 *
 *  These two fields can diverge transiently: a minimized renderer may have
 *  `rendererSnapshot: null` (renderer paused its self-reporting) while the
 *  main-process metrics still report CPU for that PID, and vice-versa
 *  during the ~10 min staleness window. Consumers should treat them as
 *  independent signals.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type { ProcessMetric } from 'electron';

import { getElectronModule } from '@core/lazyElectron';
import { createScopedLogger } from '@core/logger';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import type { EventLoopLagSample } from '@core/services/eventLoopLagService';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { getDataPath } from '@core/utils/dataPaths';
import {
  DARWIN_OPEN_MAX_FD,
  _resetFdPressureStateForTesting,
  assessFdPressureBand,
  getCachedOpenFileSoftLimit,
  readFdPressure,
  selectNextFdPressureBand,
  type FdPressureBand,
} from '@core/utils/fdPressure';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import {
  superMcpHttpManager,
  type SuperMcpStatsStatus,
  type SuperMcpSubprocessInfo,
} from '@core/services/superMcpHttpManager';
import { getErrorReporter } from '@core/errorReporter';

/**
 * Module-level logger used ONLY by the default fallbacks
 * (`defaultTriggerSuperMcpStatsFetch`, `defaultGetSuperMcpStats`) so their
 * silent-catch paths can still surface failures at debug level. The main
 * tick flow passes `opts.logger` through explicitly.
 */
const perfDiagnosticDefaultLogger = createScopedLogger({
  scope: 'perfDiagnosticService',
});

import {
  captureRamSnapshot,
  type ProcessSnapshot,
  type RamSnapshot,
} from './ramTelemetryService';
import {
  getLastRendererPerfSummary,
  type RendererPerfSummary,
} from './rendererPerfMonitorService';
import {
  createThrottledInterval,
  getVisibilityState as getSchedulerVisibilityState,
  getBlurState as getSchedulerBlurState,
  registerBackgroundConsumerWatchdogSignalListener,
  type BackgroundConsumerWatchdogSignal,
  type IntervalBlurOptions,
} from './visibilityAwareScheduler';
import { getGpuLifecycleMetrics } from './embeddingService';

// ── Constants ────────────────────────────────────────────────────────

/** Foreground cadence — preserved from the pre-extraction inline diagnostic. */
export const MEMORY_LOG_INTERVAL_MS = 5 * 60 * 1000;
/** Cadence applied when the app is blurred or minimized. */
export const MEMORY_LOG_BACKGROUND_INTERVAL_MS = 120_000;

// Dev-only leak-trend buffer depth. Under the variable cadence introduced by
// Stage 1 (5 min foreground, 120 s blurred / minimized), 12 samples can span
// anywhere from ~24 min (sustained blur) to ~60 min (sustained focus). The
// `analyzeMemoryTrend` timestamps normalize the growth rate to MB/hour, so
// the window length is only a coarse cap — not a strict "1 hour" guarantee.
const MAX_MEMORY_HISTORY = 12;
const LEAK_GROWTH_THRESHOLD_MB = 100; // Warn if any process grows >100MB
const LEAK_GROWTH_RATE_MB_PER_HOUR = 50; // Warn if growth rate exceeds this
const LEAK_CONSECUTIVE_THRESHOLD = 3; // Require 3 consecutive increases to flag

// ── FU-5: short-window / peak CPU + sustained-high-idle-CPU warning ──
//
// Why this exists: the interval-average CPU (`totalCpuPercent`, derived from
// Electron's `percentCPUUsage` summed over the 5 min foreground / 120 s
// blurred diagnostic interval) divides bursty core-pinning by the long wall
// window and averages it down ~10×. A 30%-of-a-core idle hotspot (120% peaks)
// reported as 5–14% averaged. The instant (short-window) sample + the
// between-emit peak tracker catch the bursts the average smooths away; the
// sustained-high-idle-CPU warning is the proactive alarm that makes the next
// such regression self-report. See `docs/project/APP_PERFORMANCE_AND_MEMORY.md`
// (Periodic Memory Diagnostic + Live Profiling sections) and
// `docs/plans/260529_perf-idle-fs-walk/PLAN.md` (FU-5).

/**
 * Wall window (ms) used for the short-window "instant" CPU sample: two
 * `getAppMetrics()` snapshots this far apart, with per-process CPU% derived
 * from the `cumulativeCPUUsage` (seconds) delta ÷ window. Long enough to be
 * accurate against scheduler jitter, short enough that a burst isn't averaged
 * away. Also the window used by each peak-tracker sample.
 */
export const INSTANT_CPU_WINDOW_MS = 1500;

/**
 * Cadence of the lightweight between-emit peak sampler. ~12 s keeps the
 * sampling cost negligible (a `getAppMetrics()` pair is sync + cheap) while
 * giving ~25 samples per 5 min foreground interval / ~10 per 120 s blurred
 * interval — enough to catch a sustained burst the single instant sample and
 * the interval-average both miss.
 */
export const PEAK_SAMPLE_INTERVAL_MS = 12_000;

/**
 * Sustained-high-idle-CPU warning thresholds. The warning fires only when
 * total CPU stays above the threshold across N consecutive peak samples
 * WHILE IDLE (no active agent turn), and is throttled so it can't spam.
 */
const SUSTAINED_HIGH_IDLE_CPU_PERCENT_THRESHOLD = 40; // >40% of one core
const SUSTAINED_HIGH_IDLE_CPU_CONSECUTIVE_SAMPLES = 3; // ~36 s at 12 s cadence
const SUSTAINED_HIGH_IDLE_CPU_WARN_THROTTLE_MS = 10 * 60 * 1000; // ≤1 warn / 10 min

const AUTO_INCIDENT_CAPTURE_FLAG = 'REBEL_AUTO_PERF_INCIDENT_CAPTURE';
const AUTO_INCIDENT_EVENT_LOOP_P50_THRESHOLD_MS = 10;
const AUTO_INCIDENT_EVENT_LOOP_SUSTAINED_MS = 2 * 60 * 1000;
const AUTO_INCIDENT_WRITABLE_SCAN_REQUESTS_RATE5M_THRESHOLD = 30;
const AUTO_INCIDENT_CAPTURE_THROTTLE_MS = 30 * 60 * 1000;
const AUTO_INCIDENT_MAX_RECORDS = 20;

// ── Types ────────────────────────────────────────────────────────────

export interface ProcessMemorySnapshot {
  pid: number;
  type: string;
  label: string;
  workingSetMB: number;
}

export interface MemorySnapshot {
  timestamp: number;
  mainProcess: { heapUsedMB: number; rssMB: number };
  processes: ProcessMemorySnapshot[];
}

/** A `ProcessSnapshot` enriched with lifetime-CPU delta (additive-only). */
export interface PerfProcessSnapshot extends ProcessSnapshot {
  /**
   * CPU time (ms) consumed since the previous diagnostic tick. `null` on the
   * first observation of a PID (no previous reference point).
   *
   * Computation precedence (check Electron typing):
   * 1. `app.getAppMetrics()[i].cpu.cumulativeCPUUsage` (seconds) delta × 1000.
   * 2. Fallback: `cpuPercent * cadenceMs / 100`.
   */
  cpuMsSinceLast: number | null;
  /**
   * FU-5: short-window ("instant") CPU% for this process, derived from two
   * `getAppMetrics()` snapshots `INSTANT_CPU_WINDOW_MS` apart
   * (`cumulativeCPUUsage` delta ÷ window). Distinct from `cpuPercent`, which
   * is Electron's interval-average over the long diagnostic cadence. `null`
   * when the instant sample is unavailable (metrics call failed, PID absent
   * from one of the two snapshots, or `cumulativeCPUUsage` missing). Additive
   * — never replaces `cpuPercent`.
   */
  cpuPercentInstant?: number | null;
  /**
   * Out-of-band subprocess-usage sampler status (Stage 1 of
   * `docs/plans/260424_observability_followups.md`). Populated ONLY on the
   * super-mcp synth row — Electron-managed rows from `app.getAppMetrics()`
   * never carry this field. Discriminates between a real '0' reading (`'ok'`)
   * and a failed / unavailable sampler (`'timeout' | 'error' | 'unavailable'`)
   * so consumers can't mistake placeholder zeros for genuine idle.
   */
  cpuStatus?: SubprocessCpuStatus;
}

/** Status discriminant for out-of-band subprocess usage samples (Stage 1 follow-up). */
export type SubprocessCpuStatus = 'ok' | 'timeout' | 'error' | 'unavailable';

/**
 * Result of sampling CPU % + working-set bytes for an arbitrary subprocess
 * PID (i.e., one `app.getAppMetrics()` can't see — super-mcp et al.).
 *
 * `cpuPercent` and `workingSetMB` are `null` on any non-`'ok'` status so
 * consumers never silently treat a failed sample as genuine zero.
 */
export interface SubprocessUsageSample {
  /**
   * Average CPU % over the interval since the previous diagnostic tick (or
   * lifetime average from process start on the first tick after spawn).
   * Mapped from pidusage's delta-CPU computation over a 10-minute `maxage`
   * window — so both the 5 min foreground and 120 s blurred / minimized
   * cadences stay inside the cache window and produce interval-delta values
   * rather than silent lifetime-average fallback.
   *
   * **Known caveats:**
   * - A sample gap longer than `maxage` (10 min) — typically caused by OS
   *   sleep / resume, a long event-loop stall, or timer clamping — falls
   *   back to lifetime-average CPU for the next single sample, then resumes
   *   interval-delta on the tick after that. Acceptable noise for a
   *   diagnostic channel; would need per-sample timestamp-gap tracking to
   *   eliminate.
   * - PID reuse within the 10 min history window (rare on darwin/linux,
   *   slightly less rare on Windows) can contaminate the first post-restart
   *   sample with stale history from the prior process. The PID-change
   *   clear in the tick path only fires when `superMcpLifecycle.pid`
   *   actually differs from the previous sample's PID, so a same-PID
   *   restart bypasses it. Documented as a known limitation rather than
   *   fixed, because detecting same-PID reuse would require tracking
   *   `ctime` from pidusage's output, which pidusage v4 does expose but
   *   can itself be stale across reuse.
   *
   * null on non-'ok' status.
   */
  cpuPercent: number | null;
  /** null on non-'ok' status. */
  workingSetMB: number | null;
  status: SubprocessCpuStatus;
}

/**
 * DI seam (Stage 1 of `docs/plans/260424_observability_followups.md`):
 * samples CPU % + working-set bytes for an arbitrary PID out of band from
 * `app.getAppMetrics()`. Default implementation wraps `pidusage(pid)` in a
 * 1 s AbortController. Tests override via `PerfDiagnosticDeps.sampleSubprocessUsage`.
 *
 * Contract:
 * - MUST NEVER throw. A thrown underlying sampler is caught and mapped to
 *   `status: 'error'` with null numeric fields.
 * - Timeout ⇒ `status: 'timeout'`.
 * - PID no longer exists (ENOENT / ESRCH / "No matching pid found") ⇒
 *   `status: 'unavailable'` — the subprocess restarted, this is a normal
 *   observable state, not a sampler failure.
 */
export type SampleSubprocessUsage = (pid: number) => Promise<SubprocessUsageSample>;

/** Tri-state visibility derived from the visibility + blur scheduler. */
export type VisibilityKind = 'focused' | 'blurred' | 'minimized';

/** GPU lifecycle payload with fail-observable status. */
export type GpuLifecyclePayload =
  | {
      status: 'ok';
      blurDisposalCount: number;
      focusWarmUpCount: number;
      lastBlurDisposalAt: number | null;
      lastFocusWarmUpAt: number | null;
    }
  | { status: 'unavailable'; error: string };

/**
 * File-descriptor / handle snapshot — REBEL-1HF.
 *
 * The bug investigation showed that aggregate Windows file-descriptor
 * pressure (no single leak; just dozens of file-touching subsystems
 * sustained over hours) was exhausting the process FD budget. We had no
 * direct visibility into FD/handle counts, so symptoms surfaced as
 * downstream EMFILE errors across many stores and the audio writer
 * before we could attribute the saturation. This payload field gives us
 * a leading indicator on every diagnostic tick.
 *
 * Discriminants (per platform):
 *
 * - `posix` — entries enumerated from the platform FD directory:
 *   `/dev/fd` on darwin and `/proc/self/fd` on linux.
 * - `unsupported` — explicit win32 unsupported path (Node has no raw
 *   user-mode fd/handle enumeration without native helpers).
 * - `unavailable` — sampler threw, returned malformed data, or the
 *   platform doesn't surface FD info via the supported path.
 *
 * Always present in the payload (stable shape). Numeric fields are
 * `null` on `unavailable`. Failure to sample never aborts the tick.
 */
/**
 * Discriminated union for the FD/handle snapshot carried in
 * `PerfDiagnosticPayload.fdSnapshot`. Named `PayloadFdSnapshot` to avoid
 * collision with the flat `interface FdSnapshot` used by the standalone
 * `captureFdSnapshot()` / `emitFdSnapshot()` log line (from the FD
 * telemetry Phase 1 work on origin/dev).
 */
export type PayloadFdSnapshot =
  | {
      status: 'posix';
      /** FD directory entry count (`/dev/fd` on darwin, `/proc/self/fd` on linux). */
      openFdCount: number;
      /** Highest numeric FD entry observed in the same pass. */
      maxFdNumber: number;
      /** libuv active-handle count (sockets, timers, pipes, …). */
      activeHandleCount: number;
      /** libuv active-request count (in-flight async ops). */
      activeRequestCount: number;
      /** Aggregate active-resource count from `process.getActiveResourcesInfo()`. */
      activeResourceCount: number;
      /** Per-resource-type counts from `process.getActiveResourcesInfo()`. */
      activeResourceTypes: Record<string, number>;
    }
  | {
      status: 'unsupported';
      reason: string;
    }
  | { status: 'unavailable'; error: string };

/**
 * Emission shape for `superMcpChildStats` — Stage 4b of
 * `docs/plans/260423_secondary_process_cpu_observability.md`.
 *
 * Extends `SuperMcpStatsSnapshot`'s status alphabet with:
 *   - `'unavailable'` — manager not running AND no prior cache to serve.
 *   - `'stale'`       — manager stopped (M1 invalidated), but we preserved
 *                       the last `'ok'` snapshot from the previous up-state
 *                       to aid triage. Status is overridden on emission
 *                       only; the stored cache status is still the fetch
 *                       outcome (`'ok' | 'error' | 'timeout' | 'unsupported'`).
 *
 * `stats_age_ms` is derived from
 * `superMcpHttpManager.getLastStatsFetchAt()` on each tick so operators
 * can spot stale caches without parsing the embedded `at` field.
 *
 * `last_good_age_ms` is derived from
 * `superMcpHttpManager.getLastGoodStatsAt()` on each tick — lets operators
 * distinguish a fresh `'ok'` from a stale `'ok'` followed by silent
 * failures (Stage 4b M5 refinement).
 *
 * Present on every diagnostic tick:
 *   - `status: 'unavailable'` when the manager is not running and no cache
 *      has ever been recorded;
 *   - `status: 'stale'` when the manager is not running but a previous
 *      successful cache is still held (post M1 invalidation, this only
 *      occurs in the brief window before the exit handler fires — but
 *      the emission contract stays honest either way);
 *   - otherwise the cache's status passes through verbatim.
 */
export interface SuperMcpChildStatsEmission {
  status: SuperMcpStatsStatus | 'unavailable' | 'stale';
  /** ms epoch when the cached snapshot was captured (from `SuperMcpStatsSnapshot.at`). */
  at?: number;
  /** Opaque /stats response body when `status === 'ok'` or `'stale'`. */
  payload?: unknown;
  /** HTTP status code when the poll hit a non-2xx response. */
  httpStatus?: number;
  /** Error message when the poll failed. */
  lastErr?: string;
  /** ms since `lastStatsFetchAt`; null when no fetch has completed. */
  stats_age_ms: number | null;
  /**
   * ms since `lastGoodStatsAt` (the last fetch with `status: 'ok'` for
   * the current subprocess lifetime). `null` when no successful fetch
   * has completed for the current subprocess.
   */
  last_good_age_ms: number | null;
}

export interface AutomationSchedulerStateStats {
  sizeKB: number;
  runCount: number;
}

export interface PeakCpuProcess {
  label: string;
  pid: number;
  cpuPercent: number;
}

/**
 * FU-5: short-window ("instant") CPU sample taken right before each
 * diagnostic emit. Two `getAppMetrics()` snapshots `INSTANT_CPU_WINDOW_MS`
 * apart, per-process CPU% from `cumulativeCPUUsage` delta ÷ window.
 *
 * - `status: 'ok'` — both snapshots succeeded; `totalCpuPercent` /
 *   `topProcess` populated.
 * - `status: 'unavailable'` — a snapshot failed or carried no usable
 *   `cumulativeCPUUsage` (numeric fields null). Distinguishes a genuine 0%
 *   reading from a failed sample.
 */
export type InstantCpuSample =
  | {
      status: 'ok';
      /** Sum of per-process instant CPU% (one process can exceed 100% / core). */
      totalCpuPercent: number;
      /** Wall window (ms) actually elapsed between the two snapshots. */
      windowMs: number;
      /** Timestamp from the second snapshot; identifies when the sample peaked. */
      sampleAtMs: number;
      topProcess: PeakCpuProcess | null;
      /** Top processes by instant CPU% for this sample, capped at three. */
      topProcesses: PeakCpuProcess[];
    }
  | { status: 'unavailable' };

export interface PerfDiagnosticPayload {
  // CPU aggregate (quick filter for high-CPU logs)
  totalCpuPercent: number;
  topCpuProcess: { label: string; cpuPercent: number } | null;
  /**
   * FU-5: short-window ("instant") total CPU% — sum of per-process instant
   * CPU% from a two-snapshot `getAppMetrics()` pair taken right before this
   * emit. Catches bursty core-pinning that `totalCpuPercent` (interval-
   * average) divides by the long diagnostic window and smooths away. `null`
   * when the instant sample was unavailable. Additive — `totalCpuPercent`
   * is unchanged.
   */
  totalCpuPercentInstant: number | null;
  /**
   * FU-5: peak total instant CPU% seen across the lightweight between-emit
   * peak sampler (cadence `PEAK_SAMPLE_INTERVAL_MS`) since the previous emit,
   * folded together with the pre-emit instant sample. Captures sustained
   * bursts that both the interval-average and a single instant reading miss.
   * `null` when no peak sample was captured this interval (e.g. first emit
   * before the sampler ran, or all samples were unavailable).
   */
  totalCpuPercentPeak: number | null;
  /**
   * Timestamp of the sample that produced `totalCpuPercentPeak`. This is a
   * peak-sample instant, not continuous profiling.
   */
  peakAtMs: number | null;
  /** Top processes at `peakAtMs`, ordered by instant CPU%, capped at three. */
  peakTopProcesses: PeakCpuProcess[];
  // V8 heap (main process)
  heapUsedMB: number;
  heapTotalMB: number;
  externalMB: number;
  rssMB: number;
  // Per-process breakdown with cpuMsSinceLast (additive field)
  processes: PerfProcessSnapshot[];
  // Platform context for Windows vs macOS filtering
  platform: NodeJS.Platform;
  // Agent turn registry (potential leak source)
  registryActiveTurns: number;
  registryContextAccumulators: number;
  registryContextTotalEvents: number;
  registryLargestContextEvents: number;
  registrySecurityDenials: number;
  registryToolCalls: number;
  // Automation scheduler state (known bloat)
  automationRunCount: number | null;
  automationStateSizeKB: number | null;
  // Ancillary counters
  settingsNormalization: unknown;
  isKnownPluginCounters: unknown;
  scanSpacePluginsCounters: unknown;
  scanSpacesCounters: unknown;
  // New top-level keys (Stage 1 additive)
  /**
   * Nominal cadence (ms) the scheduler is using **at emit time** —
   * `foregroundMs` when `blurState === 'focused'`, otherwise `backgroundMs`.
   *
   * This is NOT elapsed time since the previous emission. On transitions
   * (focus → blur, focus-return catch-up) a tick can land earlier or later
   * than `cadenceMs` would suggest. For elapsed-time analysis across log
   * entries, compute `time[N] − time[N-1]` directly.
   */
  cadenceMs: number;
  blurState: VisibilityKind;
  gpuLifecycle: GpuLifecyclePayload;
  rendererCpuMsSinceLast: number | null;
  rendererSnapshot: RamSnapshot['rendererSnapshot'];
  // Log-line stable tag used by existing consumers
  profilerChannel: 'perf-summary';
  // Extensibility seams populated by later stages (Stage 2 / 3 / 4).
  // Present but null by default so shape is stable.
  eventLoopDelay: EventLoopLagSample | null;
  /**
   * Renderer long-task + input-lag 60 s batch summary (Stage 3). Populated
   * from the main-side `rendererPerfMonitorService` cache, which ingests
   * `log:event` messages tagged `profilerChannel: 'perf-summary'`.
   * `null` when no summary has been cached or the cached entry is stale.
   */
  rendererPerfSummary: RendererPerfSummary | null;
  /**
   * Super-MCP subprocess identity + lifecycle stats (Stage 4a). Always
   * present in the payload; `null` when the provider is not wired or its
   * getter threw (the fail-observable path logs a warn).
   *
   * When `isRunning && pid !== null`, a companion `super-mcp` row is also
   * synthesised into `processes[]` so the subprocess appears alongside
   * Electron-managed processes in log greps.
   *
   * Subprocess CPU / RSS on the synth row is populated via the out-of-band
   * `sampleSubprocessUsage` sampler (Stage 1 of
   * `docs/plans/260424_observability_followups.md`). The synth row carries
   * a `cpuStatus: 'ok' | 'timeout' | 'error' | 'unavailable'` discriminant
   * so failed samples are distinguishable from real-0 readings.
   *
   * `lastRestartReason` (Stage 2 of the 260424 follow-up) is threaded
   * through as part of the `SuperMcpSubprocessInfo` shape — it attributes
   * the most recent restart to its trigger site (debounced workspace
   * change, idle-restart drain, reconfigure, post-resume recovery,
   * circuit-breaker-reset retry). `null` on first start / after clean stop.
   */
  superMcpLifecycle: SuperMcpSubprocessInfo | null;
  /**
   * Super-MCP per-child /stats snapshot (Stage 4b). Populated via
   * fire-and-forget polling from `SuperMcpHttpManager.fetchStats()` — the
   * diagnostic reads whatever the most recent cache holds, plus
   * `stats_age_ms` for operator visibility into cache freshness.
   *
   * Always present. `status: 'unavailable'` when the manager is not
   * running or no fetch has ever completed. Per-child CPU / RSS is NOT
   * reported here (Node's `process.resourceUsage()` is self-only); use
   * PIDs from `payload.children[].pid` with a superproject-side sampler.
   */
  superMcpChildStats: SuperMcpChildStatsEmission;
  /**
   * File-descriptor / handle snapshot (REBEL-1HF). Emitted on every tick
   * with a stable shape. See `PayloadFdSnapshot` for the per-platform
   * discriminants and a note on why we capture this.
   */
  fdSnapshot: PayloadFdSnapshot;
}

type StressAlarmTriggerReason =
  | 'event_loop_delay_sustained'
  | 'scan_spaces_writable_requests_rate5m';
type AutoIncidentTriggerReason =
  | 'watchdog_stuck_active_turn_signal'
  | 'watchdog_leaked_active_turn_signal';

interface AutoIncidentWatchdogSignal {
  reason: 'stuck_active_turn_signal' | 'leaked_active_turn_signal';
  stuckTurnId: string | null;
  consumerId: string;
  observedAtMs: number;
  pauseDurationMs: number;
  turnIds: string[];
}

interface AutoIncidentCaptureInput {
  capturedAtMs: number;
  triggerReasons: AutoIncidentTriggerReason[];
  stressAlarmTriggerReasons: StressAlarmTriggerReason[];
  watchdog: AutoIncidentWatchdogSignal;
  payload: PerfDiagnosticPayload;
  eventLoopP50Ms: number | null;
  writableScanRequestsRate5m: number | null;
}

interface AutoIncidentCaptureResult {
  incidentPath: string;
  rendererMemoryPath: string;
  cpuProfilePath: string | null;
}

export interface PerfDiagnosticDeps {
  /** Pino logger used by `startPerfDiagnostic`. Required. */
  logger: Logger;
  /** Scheduler factory. Default: `createThrottledInterval`. */
  scheduler?: (
    cb: () => void | Promise<void>,
    foregroundMs: number,
    backgroundMs: number,
    opts?: IntervalBlurOptions,
  ) => () => void;
  /** RAM snapshot provider. Default: `captureRamSnapshot`. */
  getRamSnapshot?: () => RamSnapshot;
  /** Raw Electron app metrics — required to read `cumulativeCPUUsage`. */
  getAppMetrics?: () => ProcessMetric[];
  /** GPU lifecycle metrics provider. Default: `getGpuLifecycleMetrics`. */
  getGpuLifecycle?: () => {
    blurDisposalCount: number;
    focusWarmUpCount: number;
    lastBlurDisposalAt: number | null;
    lastFocusWarmUpAt: number | null;
  };
  /** Derived focused / blurred / minimized state. Default: from `visibilityAwareScheduler`. */
  getVisibilityKind?: () => VisibilityKind;
  /**
   * Renderer perf-summary accessor (Stage 3). Default: reads the
   * `rendererPerfMonitorService` cache via `getLastRendererPerfSummary()`.
   */
  getRendererPerfSummary?: () => RendererPerfSummary | null;
  /** Event loop lag accessor (Stage 2). Default: `null`. */
  getEventLoopLag?: () => EventLoopLagSample | null;
  /**
   * Super-MCP lifecycle accessor (Stage 4a). Default: `null`. When wired,
   * populates `superMcpLifecycle` on the payload and synthesises a
   * `super-mcp` row in `processes[]` while the subprocess is running.
   *
   * Fail-observable: if the getter throws, the payload emits
   * `superMcpLifecycle: null` (no synth row) and a warn is logged.
   */
  getSuperMcpLifecycle?: () => SuperMcpSubprocessInfo | null;
  /**
   * Out-of-band subprocess usage sampler (Stage 1 of
   * `docs/plans/260424_observability_followups.md`). Populates the super-mcp
   * synth row's `workingSetMB` / `cpuPercent` / `cpuStatus` fields. Default
   * implementation wraps `pidusage(pid)` in a 1 s AbortController; tests
   * inject a deterministic sampler.
   *
   * Fail-observable per `SampleSubprocessUsage` contract — never throws.
   * Invoked only when the super-mcp PID is NOT already present in
   * `app.getAppMetrics()` (i.e. the synth-row path); skipped otherwise to
   * preserve the M4 "PID-already-in-appMetrics" breadcrumb.
   */
  sampleSubprocessUsage?: SampleSubprocessUsage;
  /**
   * Super-MCP /stats cache accessor (Stage 4b). Default wiring reads
   * `superMcpHttpManager.getLastStatsCache()` and returns
   * `{ status: 'unavailable' }` when the manager isn't running / no
   * fetch has completed yet. Always returns a value; never throws.
   *
   * The seam is split from `triggerSuperMcpStatsFetch` below so that
   * tests can inject a canned snapshot without having to simulate the
   * async poll pipeline.
   */
  getSuperMcpStats?: () => SuperMcpChildStatsEmission;
  /**
   * Kick off the next-tick async `/stats` poll (Stage 4b). Fire-and-forget:
   * invoked synchronously before `buildPerfDiagnosticPayload` so this tick
   * reads whatever the previous tick's poll produced. Default wiring calls
   * `superMcpHttpManager.fetchStats()` and swallows rejections.
   *
   * Defensive debug-log on rejection: `fetchStats()` is documented to never
   * throw, but we log-and-continue if it ever does.
   */
  triggerSuperMcpStatsFetch?: () => void;
  /**
   * File-descriptor / handle snapshot accessor (REBEL-1HF). Default:
   * `defaultGetFdSnapshot` — enumerates `/dev/fd` on darwin or
   * `/proc/self/fd` on linux, returns explicit `unsupported` on win32,
   * and maps read failures to `unavailable`. Tests inject deterministic
   * snapshots via this seam.
   *
   * Fail-observable: must never throw — internal try/catch maps any
   * sampler failure to `{ status: 'unavailable', error }`.
   */
  getFdSnapshot?: () => PayloadFdSnapshot;
  /** Automation scheduler state stats provider. Default: `null`. */
  getAutomationSchedulerStats?: () => AutomationSchedulerStateStats | null;
  /** Agent turn registry diagnostics. Default: `agentTurnRegistry.getDiagnostics()`. */
  getAgentTurnRegistryDiagnostics?: () => ReturnType<typeof agentTurnRegistry.getDiagnostics>;
  /** Settings normalization stats provider. Default: `null`. */
  getSettingsNormalizationStats?: () => unknown;
  /** Windowed settings normalization stats provider. Default: `null`. */
  getSettingsNormalizationWindowedStats?: () => unknown;
  /** Hot-path counters from `ipc/plugins/shared`. Default: `null`. */
  getIsKnownPluginCounters?: () => unknown;
  /** Plugin-space scan counters. Default: `null`. */
  getScanSpacePluginsCounters?: () => unknown;
  /** Windowed plugin-space scan counters. Default: `null`. */
  getScanSpacePluginsWindowedCounters?: () => unknown;
  /** Space-scan counters. Default: `null`. */
  getScanSpacesCounters?: () => unknown;
  /** Windowed space-scan counters. Default: `null`. */
  getScanSpacesWindowedCounters?: () => unknown;
  /**
   * Feature flag seam for auto perf-incident capture (Stage 5.3). Default:
   * `process.env.REBEL_AUTO_PERF_INCIDENT_CAPTURE === '1'`.
   */
  isAutoIncidentCaptureEnabled?: () => boolean;
  /**
   * Incident-capture seam for tests. Default: writes an incident JSON record
   * plus renderer-memory snapshot and captures a main CPU profile on demand.
   */
  captureAutoIncident?: (input: AutoIncidentCaptureInput) => Promise<AutoIncidentCaptureResult>;
  /**
   * Watchdog signal seam for tests. Default: consumes a pending watchdog
   * signal emitted by `visibilityAwareScheduler` branches.
   */
  consumeAutoIncidentWatchdogSignal?: () => BackgroundConsumerWatchdogSignal | null;
  /** Time provider seam for deterministic tests. Default: `Date.now()`. */
  nowMs?: () => number;
  /**
   * FU-5: async delay seam used by the short-window instant CPU sample (the
   * gap between the two `getAppMetrics()` snapshots) and by the between-emit
   * peak sampler's timer. Default: a `setTimeout`-based promise / unref'd
   * `setInterval`. Tests inject a deterministic resolver so no wall time is
   * spent and no busy sleep blocks the main thread.
   */
  sleepMs?: (ms: number) => Promise<void>;
  /**
   * FU-5: light recurring timer seam for the between-emit peak sampler.
   * Returns a stop function. Default: unref'd `setInterval` at
   * `PEAK_SAMPLE_INTERVAL_MS`. Tests inject a manual trigger.
   */
  schedulePeakSampler?: (cb: () => void | Promise<void>, intervalMs: number) => () => void;
  // ── REBEL_PERF_MODE=1 extras (unchanged behaviour, preserved for parity) ──
  /** Default: `null` (skip auxiliary log lines). */
  getEmbeddingLifecycleStats?: () => unknown;
  getIndexerStats?: () => unknown;
  getTombstoneStats?: () => unknown;
  /** Default: `process.env.REBEL_PERF_MODE === '1'`. */
  perfModeEnabled?: () => boolean;
  /** Enable dev-only leak-trend analysis. Default: reads `app.isPackaged` lazily when undefined. */
  isDev?: boolean;
  /** Foreground cadence (ms). Default: `MEMORY_LOG_INTERVAL_MS`. */
  foregroundMs?: number;
  /** Blurred / minimized cadence (ms). Default: `MEMORY_LOG_BACKGROUND_INTERVAL_MS`. */
  backgroundMs?: number;
  /** Catch-up priority on focus return. Default: `8`. */
  catchUpPriority?: number;
}

/** Resolved deps for `buildPerfDiagnosticPayload`. All providers are non-optional here. */
export interface ResolvedPayloadDeps {
  getRamSnapshot: () => RamSnapshot;
  getAppMetrics: () => ProcessMetric[];
  getGpuLifecycle: () => {
    blurDisposalCount: number;
    focusWarmUpCount: number;
    lastBlurDisposalAt: number | null;
    lastFocusWarmUpAt: number | null;
  };
  getVisibilityKind: () => VisibilityKind;
  getRendererPerfSummary: () => RendererPerfSummary | null;
  getEventLoopLag: () => EventLoopLagSample | null;
  getSuperMcpLifecycle: () => SuperMcpSubprocessInfo | null;
  sampleSubprocessUsage: SampleSubprocessUsage;
  getSuperMcpStats: () => SuperMcpChildStatsEmission;
  getFdSnapshot: () => PayloadFdSnapshot;
  getAutomationSchedulerStats: () => AutomationSchedulerStateStats | null;
  getAgentTurnRegistryDiagnostics: () => ReturnType<typeof agentTurnRegistry.getDiagnostics>;
  getSettingsNormalizationStats: () => unknown;
  getSettingsNormalizationWindowedStats: () => unknown;
  getIsKnownPluginCounters: () => unknown;
  getScanSpacePluginsCounters: () => unknown;
  getScanSpacePluginsWindowedCounters: () => unknown;
  getScanSpacesCounters: () => unknown;
  getScanSpacesWindowedCounters: () => unknown;
  /** Foreground cadence (ms). */
  foregroundMs: number;
  /** Blurred / minimized cadence (ms). */
  backgroundMs: number;
  /** FU-5: async delay used by the short-window instant CPU sample. */
  sleepMs: (ms: number) => Promise<void>;
  /** FU-5: monotonic-ish time provider for the instant sample window. */
  nowMs: () => number;
  /**
   * FU-5: peak-tracker state shared across ticks + the between-emit peak
   * sampler. Reading the payload drains the accumulated peak (folding in the
   * pre-emit instant sample) and resets it for the next interval. Pass the
   * shared module instance in production; tests inject a fresh one.
   */
  peakTracker: CpuPeakTracker;
  /**
   * Module-local cpuDelta store. Mutated as a side effect of payload building:
   * PIDs no longer present are pruned; current PIDs' latest cumulativeCPUSec is
   * recorded for next tick. Pass in the shared map (`cpuDeltaStore`) for
   * production use; tests inject a fresh map for isolation.
   */
  cpuDeltaStore: Map<number, number>;
  logger: Logger;
}

export interface PerfDiagnosticHandle {
  /** Stop the periodic diagnostic and release scheduler resources. */
  dispose(): void;
}

// ── FU-5: short-window instant CPU + peak tracker ─────────────────────

/**
 * Take a short-window ("instant") CPU sample: two `getAppMetrics()`
 * snapshots `windowMs` apart, with per-process CPU% derived from the
 * `cumulativeCPUUsage` (seconds) delta ÷ wall window. This is the reading
 * the long interval-average can't see — a process pinning a core for the
 * window reports ~100%+ here even when the 5 min average is single-digit.
 *
 * Cheap + non-blocking: `getAppMetrics()` is sync; the gap between the two
 * reads is an awaited async sleep (NOT a busy loop), so the main thread is
 * free for the ~1.5 s window. Never throws — a failed metrics read maps to
 * `status: 'unavailable'` so a failed sample is never mistaken for genuine 0.
 *
 * Process labelling: rows are keyed by PID; the `topProcess.label` is the
 * raw Electron `ProcessMetric.type` (we don't have the RAM-snapshot label
 * map here, and re-deriving it would couple this helper to
 * `ramTelemetryService` for marginal gain). The PID is the durable key; the
 * per-process `cpuPercentInstant` enrichment in the payload uses PID join.
 */
export async function sampleInstantCpu(
  getAppMetrics: () => ProcessMetric[],
  sleepMs: (ms: number) => Promise<void>,
  nowMs: () => number,
  logger: Logger,
  windowMs: number = INSTANT_CPU_WINDOW_MS,
): Promise<{ sample: InstantCpuSample; perPidPercent: Map<number, number> }> {
  const unavailable = {
    sample: { status: 'unavailable' as const },
    perPidPercent: new Map<number, number>(),
  };
  let first: ProcessMetric[];
  let startMs: number;
  try {
    first = getAppMetrics();
    startMs = nowMs();
  } catch (err) {
    logger.warn({ err }, 'perfDiagnostic: instant CPU first snapshot failed');
    return unavailable;
  }
  const firstCpu = new Map<number, number>();
  for (const m of first) {
    if (typeof m.cpu.cumulativeCPUUsage === 'number' && Number.isFinite(m.cpu.cumulativeCPUUsage)) {
      firstCpu.set(m.pid, m.cpu.cumulativeCPUUsage);
    }
  }

  await sleepMs(windowMs);

  let second: ProcessMetric[];
  let endMs: number;
  try {
    second = getAppMetrics();
    endMs = nowMs();
  } catch (err) {
    logger.warn({ err }, 'perfDiagnostic: instant CPU second snapshot failed');
    return unavailable;
  }

  const elapsedMs = endMs - startMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    // Clock glitch / zero window — can't divide. Don't emit garbage.
    return unavailable;
  }

  const perPidPercent = new Map<number, number>();
  let total = 0;
  let topPid: number | null = null;
  let topPercent = -1;
  let topLabel = '';
  let anyMeasured = false;
  const topProcesses: PeakCpuProcess[] = [];
  for (const m of second) {
    const prev = firstCpu.get(m.pid);
    const curr = m.cpu.cumulativeCPUUsage;
    if (
      prev === undefined ||
      typeof curr !== 'number' ||
      !Number.isFinite(curr)
    ) {
      continue; // PID absent from the first snapshot or no usable counter.
    }
    const deltaSec = curr - prev;
    if (!Number.isFinite(deltaSec) || deltaSec < 0) {
      continue; // Restart / clock glitch — skip rather than emit a negative.
    }
    anyMeasured = true;
    // CPU% of one core = (cpu-seconds consumed / wall-seconds) × 100.
    const percent = Math.round(((deltaSec * 1000) / elapsedMs) * 100 * 10) / 10;
    perPidPercent.set(m.pid, percent);
    topProcesses.push({ label: m.type, pid: m.pid, cpuPercent: percent });
    total += percent;
    if (percent > topPercent) {
      topPercent = percent;
      topPid = m.pid;
      topLabel = m.type;
    }
  }

  if (!anyMeasured) {
    // No PID appeared in BOTH snapshots with a usable counter (e.g. first
    // emit after start where cumulativeCPUUsage was absent). Honest null.
    return unavailable;
  }

  return {
    sample: {
      status: 'ok',
      totalCpuPercent: Math.round(total * 10) / 10,
      windowMs: elapsedMs,
      sampleAtMs: endMs,
      topProcess: topPid !== null ? { label: topLabel, pid: topPid, cpuPercent: topPercent } : null,
      topProcesses: normalizePeakTopProcesses(topProcesses),
    },
    perPidPercent,
  };
}

/**
 * Result of folding the pre-emit instant sample + the between-emit peak
 * samples on each diagnostic emit. `drainForEmit` returns this and resets
 * the accumulator for the next interval.
 */
export interface CpuPeakDrainResult {
  /** Peak total instant CPU% across all samples this interval; `null` if none. */
  totalCpuPercentPeak: number | null;
  /** Timestamp of the sample that produced the peak; `null` if none. */
  peakAtMs: number | null;
  /** Whether the sustained-high-idle-CPU warning should fire this emit. */
  shouldWarnSustainedHighIdleCpu: boolean;
  /** Snapshot of the top process at the peak sample (for the warning log). */
  peakTopProcess: PeakCpuProcess | null;
  /** Top processes at the peak sample, ordered by instant CPU%, capped at three. */
  peakTopProcesses: PeakCpuProcess[];
  /** Consecutive idle-over-threshold sample count at drain time. */
  consecutiveHighIdleSamples: number;
}

/**
 * Lightweight peak tracker fed by the between-emit peak sampler and the
 * pre-emit instant sample. Tracks:
 *  - The max total instant CPU% seen since the last emit (`totalCpuPercentPeak`).
 *  - A consecutive-sample streak of "total CPU > threshold WHILE IDLE", which
 *    drives the sustained-high-idle-CPU warning.
 *
 * Idle is decided by the caller (passes `idle`) so the tracker stays pure of
 * registry coupling. All state is reset on `drainForEmit` (peak) — except the
 * idle streak + warn-throttle, which persist across emits because the
 * sustained-high-CPU condition can span multiple peak-sample intervals and the
 * throttle must outlive a single emit.
 */
export class CpuPeakTracker {
  private peakTotal: number | null = null;
  private peakAtMs: number | null = null;
  private peakTopProcesses: PeakCpuProcess[] = [];
  private consecutiveHighIdle = 0;
  private lastWarnAtMs: number | null = null;

  /**
   * Record one CPU sample.
   * @param totalCpuPercent total instant CPU% for the sample (`null` skips peak update).
   * @param idle whether the app was idle (no active agent turn) at sample time.
   * @param topProcesses top processes at this sample, for peak attribution.
   * @param sampleAtMs timestamp of this instant sample.
   */
  record(
    totalCpuPercent: number | null,
    idle: boolean,
    topProcesses: readonly PeakCpuProcess[] | null,
    sampleAtMs: number | null,
  ): void {
    if (totalCpuPercent !== null && Number.isFinite(totalCpuPercent)) {
      if (this.peakTotal === null || totalCpuPercent > this.peakTotal) {
        this.peakTotal = totalCpuPercent;
        this.peakAtMs = Number.isFinite(sampleAtMs) ? sampleAtMs : null;
        this.peakTopProcesses = normalizePeakTopProcesses(topProcesses);
      }
      // Idle streak: only count a sample toward the streak when we both
      // measured CPU AND the app was idle. An active turn (or an
      // unmeasurable sample) breaks the streak — high CPU during a turn is
      // expected work, not the idle-hotspot signal this warning is for.
      if (idle && totalCpuPercent > SUSTAINED_HIGH_IDLE_CPU_PERCENT_THRESHOLD) {
        this.consecutiveHighIdle += 1;
      } else {
        this.consecutiveHighIdle = 0;
      }
    } else if (!idle) {
      // An active turn always breaks the idle streak even if CPU is unmeasured.
      this.consecutiveHighIdle = 0;
    }
  }

  /**
   * Drain for a diagnostic emit. Folds in the pre-emit instant sample, decides
   * whether the throttled sustained-high-idle-CPU warning should fire, then
   * resets the peak (but preserves the idle streak + throttle so a condition
   * spanning multiple emits keeps building / stays throttled).
   */
  drainForEmit(
    instantTotalCpuPercent: number | null,
    idle: boolean,
    instantTopProcesses: readonly PeakCpuProcess[] | null,
    instantAtMs: number | null,
    nowMs: number,
  ): CpuPeakDrainResult {
    // Fold the pre-emit instant sample into both the peak and the idle streak.
    this.record(instantTotalCpuPercent, idle, instantTopProcesses, instantAtMs);

    const totalCpuPercentPeak = this.peakTotal;
    const peakAtMs = this.peakAtMs;
    const peakTopProcesses = this.peakTopProcesses;
    const peakTopProcess = peakTopProcesses[0] ?? null;
    const consecutiveHighIdleSamples = this.consecutiveHighIdle;

    let shouldWarn = false;
    if (consecutiveHighIdleSamples >= SUSTAINED_HIGH_IDLE_CPU_CONSECUTIVE_SAMPLES) {
      const throttledOut =
        this.lastWarnAtMs !== null &&
        nowMs - this.lastWarnAtMs < SUSTAINED_HIGH_IDLE_CPU_WARN_THROTTLE_MS;
      if (!throttledOut) {
        shouldWarn = true;
        this.lastWarnAtMs = nowMs;
      }
    }

    // Reset the peak for the next interval; idle streak + throttle persist.
    this.peakTotal = null;
    this.peakAtMs = null;
    this.peakTopProcesses = [];

    return {
      totalCpuPercentPeak,
      peakAtMs,
      shouldWarnSustainedHighIdleCpu: shouldWarn,
      peakTopProcess,
      peakTopProcesses,
      consecutiveHighIdleSamples,
    };
  }

  /** Test-only: reset all state including the idle streak + warn throttle. */
  _resetForTesting(): void {
    this.peakTotal = null;
    this.peakAtMs = null;
    this.peakTopProcesses = [];
    this.consecutiveHighIdle = 0;
    this.lastWarnAtMs = null;
  }
}

// ── Module-level state ───────────────────────────────────────────────

/** Dev-only: memory-history buffer for leak trend analysis. */
const memoryHistory: MemorySnapshot[] = [];

/**
 * FU-5: shared peak tracker for the periodic diagnostic. Fed by the
 * between-emit peak sampler (started in `startPerfDiagnostic`) and drained
 * on each emit by `buildPerfDiagnosticPayload`.
 */
const cpuPeakTracker = new CpuPeakTracker();

/**
 * PID → previous-tick `cumulativeCPUUsage` (seconds). Used to compute
 * `cpuMsSinceLast`. Stale entries (PIDs that disappear) are pruned each tick.
 *
 * Exposed as module state so tests can inspect / reset it.
 *
 * Known limitation (PID reuse): if the OS reuses a PID between ticks AND the
 * new process's first-observed `cumulativeCPUUsage` exceeds the previous
 * process's final value for the same PID, the delta is attributed to the
 * wrong process. This is rare within a single session (PIDs are typically
 * assigned monotonically over a wide range), and the pruning step already
 * removes a PID the tick it disappears. Stage 4a's process-identity tracking
 * (label + start-time) will fully close this gap; not worth the added
 * complexity for Stage 1.
 */
const cpuDeltaStore: Map<number, number> = new Map();

/**
 * Module-scope state for the super-mcp subprocess usage sampler (Stage 1
 * refinement, 260424 follow-up). Tracks just enough history across ticks
 * to:
 *  - Call `pidusage.clear(previousPid)` when super-mcp restarts with a new
 *    PID, preventing pidusage's internal history store from accumulating
 *    stale entries (the default `maxage` of 60 s is too short for our
 *    5 min / 120 s cadences, so we explicitly pass `maxage: 10 * 60 * 1000`
 *    and pair it with active purging on PID change — see M1 of the
 *    260424 refinement).
 *  - Emit one log line per `cpuStatus` transition (degrade ↔ recover)
 *    instead of per-tick — matches the `superMcpHttpManager.fetchStats()`
 *    transition-logging pattern (260423 Stage 4b M4).
 *  - Warn once when sampling has been `'unavailable'` for 10 consecutive
 *    ticks with the same PID (platform-issue signal, not a restart race).
 *
 * All of these are intentionally module-scope rather than per-tick state:
 * they're part of the long-running sampler's behavioural contract, reset
 * only on process exit or `_resetPerfDiagnosticStateForTesting()`.
 */
let lastSampledPid: number | null = null;
let lastSampleStatus: SubprocessCpuStatus | null = null;
let consecutiveUnavailableCount = 0;
let persistentUnavailableWarned = false;
let eventLoopLagBreachSinceMs: number | null = null;
let lastAutoIncidentCaptureAtMs: number | null = null;
let autoIncidentCaptureInFlight = false;
let pendingAutoIncidentWatchdogSignal: AutoIncidentWatchdogSignal | null = null;

function normalizeAutoIncidentWatchdogSignal(
  signal: BackgroundConsumerWatchdogSignal | null,
): AutoIncidentWatchdogSignal | null {
  if (!signal) {
    return null;
  }
  if (signal.reason !== 'stuck_active_turn_signal' && signal.reason !== 'leaked_active_turn_signal') {
    return null;
  }
  return {
    reason: signal.reason,
    stuckTurnId: signal.stuckTurnId,
    consumerId: signal.consumerId,
    observedAtMs: signal.observedAtMs,
    pauseDurationMs: signal.pauseDurationMs,
    turnIds: signal.turnIds,
  };
}

function queueAutoIncidentWatchdogSignal(signal: BackgroundConsumerWatchdogSignal): void {
  const normalized = normalizeAutoIncidentWatchdogSignal(signal);
  if (!normalized) {
    return;
  }
  if (autoIncidentCaptureInFlight || pendingAutoIncidentWatchdogSignal !== null) {
    perfDiagnosticDefaultLogger.debug(
      {
        consumerId: normalized.consumerId,
        reason: normalized.reason,
        stuckTurnId: normalized.stuckTurnId,
      },
      'perfDiagnostic: auto-incident watchdog signal dropped (capture already pending or in flight)',
    );
    return;
  }
  pendingAutoIncidentWatchdogSignal = normalized;
}

function consumePendingAutoIncidentWatchdogSignal(): BackgroundConsumerWatchdogSignal | null {
  const signal = pendingAutoIncidentWatchdogSignal;
  pendingAutoIncidentWatchdogSignal = null;
  return signal;
}

registerBackgroundConsumerWatchdogSignalListener(queueAutoIncidentWatchdogSignal);

// ── Public API ───────────────────────────────────────────────────────

/**
 * Start the periodic performance diagnostic.
 *
 * Returns a handle with `dispose()` that stops the underlying throttled
 * interval. Safe to call once per process.
 */
export function startPerfDiagnostic(opts: PerfDiagnosticDeps): PerfDiagnosticHandle {
  const resolved = resolveDeps(opts);
  const scheduler = opts.scheduler ?? createThrottledInterval;

  const foregroundMs = opts.foregroundMs ?? MEMORY_LOG_INTERVAL_MS;
  const backgroundMs = opts.backgroundMs ?? MEMORY_LOG_BACKGROUND_INTERVAL_MS;
  const catchUpPriority = opts.catchUpPriority ?? 8;

  const stopScheduler = scheduler(
    async () => {
      await runPerfDiagnosticTick(resolved, opts);
    },
    foregroundMs,
    backgroundMs,
    {
      blurThrottleMs: backgroundMs,
      catchUpPriority,
    },
  );

  // FU-5: lightweight between-emit peak sampler. Takes a short instant CPU
  // sample at a modest cadence and folds the total into the shared peak
  // tracker (with idle state) so a sustained burst between two diagnostic
  // emits is captured in `totalCpuPercentPeak` and can trip the
  // sustained-high-idle-CPU warning. Cheap: one `getAppMetrics()` pair per
  // tick, an awaited (non-blocking) ~1.5 s sleep, no main-thread block.
  const schedulePeakSampler = opts.schedulePeakSampler ?? defaultSchedulePeakSampler;
  const getAgentTurnRegistryDiagnostics =
    opts.getAgentTurnRegistryDiagnostics ?? (() => agentTurnRegistry.getDiagnostics());
  let peakSampleInFlight = false;
  const stopPeakSampler = schedulePeakSampler(async () => {
    if (peakSampleInFlight) return; // Skip overlap if a sample is still running.
    peakSampleInFlight = true;
    try {
      const { sample } = await sampleInstantCpu(
        resolved.getAppMetrics,
        resolved.sleepMs,
        resolved.nowMs,
        resolved.logger,
      );
      const idle = isIdle(getAgentTurnRegistryDiagnostics);
      if (sample.status === 'ok') {
        resolved.peakTracker.record(
          sample.totalCpuPercent,
          idle,
          sample.topProcesses,
          sample.sampleAtMs,
        );
      } else {
        // Unmeasured sample: still let an active turn break the idle streak.
        resolved.peakTracker.record(null, idle, null, null);
      }
    } catch (err) {
      resolved.logger.debug({ err }, 'perfDiagnostic: peak sampler tick failed');
    } finally {
      peakSampleInFlight = false;
    }
  }, PEAK_SAMPLE_INTERVAL_MS);

  const dispose = (): void => {
    stopScheduler();
    stopPeakSampler();
    resolved.peakTracker._resetForTesting();
    // Iter-2 hardening (GPT should): clear module-scope sampler state on
    // dispose so a dev-mode HMR reload or post-crash re-`startPerfDiagnostic`
    // starts from the same clean slate as first-boot. Transition logging,
    // unavailable-streak, and last-sampled-PID tracking are module-scope by
    // design (see comments at their declaration); this dispose hook keeps
    // that safe across handle lifecycle boundaries without making the state
    // per-instance (which would require plumbing it through a lot of test
    // helpers for no steady-state gain).
    lastSampledPid = null;
    lastSampleStatus = null;
    consecutiveUnavailableCount = 0;
    persistentUnavailableWarned = false;
  };

  return { dispose };
}

/**
 * Pure payload builder exposed for tests.
 *
 * - Mutates `deps.cpuDeltaStore` (records current cumulative CPU for next
 *   tick; prunes PIDs not seen this tick).
 * - Catches and downgrades GPU lifecycle errors per the fail-observable
 *   contract.
 * - Awaits the out-of-band subprocess usage sampler (Stage 1 of
 *   `docs/plans/260424_observability_followups.md`) when a super-mcp
 *   synth row needs CPU / RSS population. The sampler is contractually
 *   never-throw, but we still wrap it in a try/catch as defence-in-depth
 *   and map a thrown sampler to `cpuStatus: 'error'`.
 */
export async function buildPerfDiagnosticPayload(
  deps: ResolvedPayloadDeps,
): Promise<PerfDiagnosticPayload> {
  const ramSnapshot = deps.getRamSnapshot();
  const appMetrics = safeGetAppMetrics(deps.getAppMetrics, deps.logger);
  const blurState = deps.getVisibilityKind();
  const cadenceMs = blurState === 'focused' ? deps.foregroundMs : deps.backgroundMs;

  // Build PID → cumulativeCPUUsage (seconds, from Electron — optional per typings).
  const currentCumulativeCpu = new Map<number, number | undefined>();
  for (const m of appMetrics) {
    currentCumulativeCpu.set(m.pid, m.cpu.cumulativeCPUUsage);
  }

  // FU-5: short-window ("instant") CPU sample taken right before this emit.
  // Two `getAppMetrics()` snapshots `INSTANT_CPU_WINDOW_MS` apart; per-process
  // CPU% from the `cumulativeCPUUsage` delta ÷ window. This is the reading the
  // interval-average smooths away — a core-pinning idle hotspot shows here.
  // Never throws (fail-observable). The await is a non-blocking sleep.
  const { sample: instantSample, perPidPercent: instantPerPid } = await sampleInstantCpu(
    deps.getAppMetrics,
    deps.sleepMs,
    deps.nowMs,
    deps.logger,
  );
  const totalCpuPercentInstant =
    instantSample.status === 'ok' ? instantSample.totalCpuPercent : null;

  // Enrich snapshot.processes with cpuMsSinceLast (by PID) + cpuPercentInstant.
  const processes: PerfProcessSnapshot[] = ramSnapshot.processes.map((p) => ({
    ...p,
    cpuMsSinceLast: computeCpuMsSinceLast(
      p.pid,
      p.cpuPercent,
      currentCumulativeCpu.get(p.pid),
      cadenceMs,
      deps.cpuDeltaStore,
    ),
    cpuPercentInstant: instantPerPid.get(p.pid) ?? null,
  }));

  // Stage 4a: super-mcp lifecycle — fail-observable + synth `processes[]` row.
  //
  // Note: Blurred/minimized cadence (120s) may undersample the 60s
  // circuit-breaker cooldown window. Manager-side warn logs remain the
  // reliable signal for circuit-breaker activation; this payload provides
  // post-hoc state inspection, not live alerting.
  const superMcpLifecycle = collectSuperMcpLifecycle(deps.getSuperMcpLifecycle, deps.logger);
  if (
    superMcpLifecycle !== null &&
    superMcpLifecycle.isRunning &&
    superMcpLifecycle.pid !== null
  ) {
    const existingRow = processes.find((p) => p.pid === superMcpLifecycle.pid);
    if (!existingRow) {
      // Stage 1 (260424 follow-up): sample CPU / RSS out of band from
      // `app.getAppMetrics()` via the injected `sampleSubprocessUsage`
      // seam. Contract: never throws. `cpuStatus` is a new discriminant
      // that makes failed-sample vs. real-0 distinguishable on the synth
      // row. `cpuMsSinceLast` stays null — pidusage's `cpu` is a %, not
      // a lifetime counter, so there is no delta to compute here.
      //
      // Stage 1 refinement (M1 / S3 / S4): detect PID changes and fold
      // the sample result into the module-scope transition / streak
      // tracking state BEFORE recording the new `lastSampledPid`.
      const currentPid = superMcpLifecycle.pid;
      const pidChanged = lastSampledPid !== null && lastSampledPid !== currentPid;

      const rawSample = await collectSubprocessUsage(
        deps.sampleSubprocessUsage,
        currentPid,
        deps.logger,
      );

      // S2: defensive check — a future injected seam could return garbage.
      // `collectSubprocessUsage` already normalises thrown samplers, but a
      // returned `undefined` / `null` / missing-status value slips through.
      // Coerce to an explicit 'error' so the synth row still reads honestly.
      const sample: SubprocessUsageSample =
        rawSample != null && typeof rawSample.status === 'string'
          ? rawSample
          : { cpuPercent: null, workingSetMB: null, status: 'error' };
      if (sample !== rawSample) {
        deps.logger.debug(
          { rawSample, pid: currentPid },
          'perfDiagnostic: sampleSubprocessUsage returned malformed result; coerced to error',
        );
      }

      // S3: transition logging — one entry per status change, never per-tick.
      // `null → X` (first sample) is silent on both sides; matches the
      // `superMcpHttpManager.fetchStats()` pattern (260423 Stage 4b M4).
      //
      // Iter-2 fix (GPT review M1): a super-mcp restart changes `currentPid`
      // AND almost always starts with a fresh sampling attempt. The old
      // PID's last status is no longer meaningful — comparing against it
      // would fire a spurious "degraded" / "recovered" log attributed to a
      // process that has already exited. Reset the transition-log state on
      // PID change BEFORE computing `prevStatus` so the new PID's first
      // sample is silent (null → X), matching the first-boot contract.
      if (pidChanged) {
        lastSampleStatus = null;
      }
      const prevStatus = lastSampleStatus;
      if (prevStatus !== null && prevStatus !== sample.status) {
        if (prevStatus === 'ok') {
          deps.logger.warn(
            { status: sample.status, pid: currentPid },
            'perfDiagnostic: super-mcp CPU sampling degraded',
          );
        } else if (sample.status === 'ok') {
          deps.logger.info(
            { previousStatus: prevStatus, pid: currentPid },
            'perfDiagnostic: super-mcp CPU sampling recovered',
          );
        }
      }

      // S4: streak tracking — warn once when sampling has been stuck on
      // 'unavailable' for 10 consecutive ticks WITH THE SAME PID. A PID
      // change legitimately resets the streak (each restart is a fresh
      // sampling attempt). The warn fires exactly once per streak.
      if (pidChanged) {
        consecutiveUnavailableCount = 0;
        persistentUnavailableWarned = false;
      }
      if (sample.status === 'unavailable') {
        consecutiveUnavailableCount += 1;
        if (consecutiveUnavailableCount >= 10 && !persistentUnavailableWarned) {
          deps.logger.warn(
            { pid: currentPid, consecutiveUnavailableCount },
            'perfDiagnostic: super-mcp CPU sample has been "unavailable" for 10 consecutive ticks with stable PID — possible platform issue',
          );
          persistentUnavailableWarned = true;
        }
      } else {
        consecutiveUnavailableCount = 0;
        persistentUnavailableWarned = false;
      }

      lastSampleStatus = sample.status;
      lastSampledPid = currentPid;

      processes.push({
        pid: currentPid,
        type: 'subprocess',
        label: 'super-mcp',
        workingSetMB: sample.workingSetMB ?? 0,
        cpuPercent: sample.cpuPercent ?? 0,
        cpuMsSinceLast: null,
        cpuStatus: sample.status,
      });
    } else {
      // M4: if `app.getAppMetrics()` already produced a row for this PID,
      // operators need to know we suppressed the synth row — otherwise a
      // mislabelled existing row (or a genuine renderer PID collision) is
      // silently invisible. Log once per tick at debug. Do NOT sample in
      // this branch — the Electron row already carries real CPU / RSS.
      deps.logger.debug(
        { pid: superMcpLifecycle.pid, existingLabel: existingRow.label },
        'perfDiagnostic: super-mcp PID already present in appMetrics; synth row skipped',
      );
    }
  }

  // Prune stale entries: PIDs present in cpuDeltaStore but no longer reported.
  const currentPids = new Set(currentCumulativeCpu.keys());
  for (const pid of Array.from(deps.cpuDeltaStore.keys())) {
    if (!currentPids.has(pid)) {
      deps.cpuDeltaStore.delete(pid);
    }
  }

  // Aggregate CPU metrics (over the raw app metrics — matches pre-extraction semantics).
  const totalCpuPercent =
    Math.round(appMetrics.reduce((sum, m) => sum + m.cpu.percentCPUUsage, 0) * 10) / 10;
  const topCpuProcess =
    processes.length > 0
      ? processes.reduce((max, p) => (p.cpuPercent > max.cpuPercent ? p : max), processes[0])
      : null;

  // GPU lifecycle — fail-observable: catch throws → status: 'unavailable'.
  const gpuLifecycle = collectGpuLifecycle(deps.getGpuLifecycle, deps.logger);

  // Renderer lifetime-CPU — derived from the main-process metric row for the
  // user-facing renderer. The label depends on window visibility:
  //   - visible          → 'mainUI'
  //   - minimized/hidden → 'hiddenRenderer:PID'
  // (see `ramTelemetryService.buildProcessLabelMap`). We match both so the
  // field stays populated in exactly the background state this diagnostic
  // is meant to illuminate — previously it silently dropped to null on blur.
  // `gpuWorker` / `exportRenderer` / `renderer:PID` rows are intentionally
  // excluded: those are not the user-facing renderer.
  const rendererRow = processes.find(
    (p) => p.label === 'mainUI' || p.label.startsWith('hiddenRenderer:'),
  );
  const rendererCpuMsSinceLast = rendererRow ? rendererRow.cpuMsSinceLast : null;

  const registryDiag = deps.getAgentTurnRegistryDiagnostics();

  // FU-5: fold the pre-emit instant sample into the shared peak tracker,
  // resolve the peak for this interval, and decide whether the throttled
  // sustained-high-idle-CPU warning should fire. Idle is gated on
  // `registryActiveTurns === 0` — high CPU during an active agent turn is
  // expected work, not the idle-hotspot signal this warning is for.
  //
  // The instant top-process labels here come from the per-PID instant join
  // against the labelled `processes[]` rows (richer than the raw metric
  // `type`), falling back to the raw instant sample labels.
  const idle = registryDiag.turnCount === 0;
  const instantTopProcesses = resolveInstantTopProcesses(processes, instantPerPid, instantSample);
  const instantAtMs = instantSample.status === 'ok' ? instantSample.sampleAtMs : null;
  const peakDrain = deps.peakTracker.drainForEmit(
    totalCpuPercentInstant,
    idle,
    instantTopProcesses,
    instantAtMs,
    deps.nowMs(),
  );
  if (peakDrain.shouldWarnSustainedHighIdleCpu) {
    deps.logger.warn(
      {
        profilerChannel: 'perf-summary',
        totalCpuPercentPeak: peakDrain.totalCpuPercentPeak,
        peakAtMs: peakDrain.peakAtMs,
        peakTopProcesses: peakDrain.peakTopProcesses,
        totalCpuPercentInstant,
        totalCpuPercent,
        topProcess: peakDrain.peakTopProcess,
        consecutiveHighIdleSamples: peakDrain.consecutiveHighIdleSamples,
        thresholdPercent: SUSTAINED_HIGH_IDLE_CPU_PERCENT_THRESHOLD,
        registryActiveTurns: registryDiag.turnCount,
        platform: process.platform,
      },
      'Sustained high idle CPU detected',
    );
  }

  const automationStats = deps.getAutomationSchedulerStats();
  const settingsNormalizationStats = deps.getSettingsNormalizationStats();
  const settingsNormalizationWindowedStats = deps.getSettingsNormalizationWindowedStats();
  const scanSpacePluginsCounters = deps.getScanSpacePluginsCounters();
  const scanSpacePluginsWindowedCounters = deps.getScanSpacePluginsWindowedCounters();
  const scanSpacesCounters = deps.getScanSpacesCounters();
  const scanSpacesWindowedCounters = deps.getScanSpacesWindowedCounters();

  return {
    profilerChannel: 'perf-summary',
    // V8 heap (main process)
    heapUsedMB: ramSnapshot.mainProcess.heapUsedMB,
    heapTotalMB: ramSnapshot.mainProcess.heapTotalMB,
    externalMB: ramSnapshot.mainProcess.externalMB,
    rssMB: ramSnapshot.mainProcess.rssMB,
    // CPU aggregate
    totalCpuPercent,
    totalCpuPercentInstant,
    totalCpuPercentPeak: peakDrain.totalCpuPercentPeak,
    peakAtMs: peakDrain.peakAtMs,
    peakTopProcesses: peakDrain.peakTopProcesses,
    topCpuProcess: topCpuProcess
      ? { label: topCpuProcess.label, cpuPercent: topCpuProcess.cpuPercent }
      : null,
    processes,
    platform: process.platform,
    // Registry
    registryActiveTurns: registryDiag.turnCount,
    registryContextAccumulators: registryDiag.contextAccumulatorCount,
    registryContextTotalEvents: registryDiag.contextAccumulatorTotalEvents,
    registryLargestContextEvents: registryDiag.largestContextAccumulatorEvents,
    registrySecurityDenials: registryDiag.securityDenialCount,
    registryToolCalls: registryDiag.toolCallCount,
    // Automation scheduler
    automationRunCount: automationStats ? automationStats.runCount : null,
    automationStateSizeKB: automationStats ? automationStats.sizeKB : null,
    // Ancillary counters
    settingsNormalization: buildSettingsNormalizationDiagnostics(
      settingsNormalizationStats,
      settingsNormalizationWindowedStats,
    ),
    isKnownPluginCounters: deps.getIsKnownPluginCounters(),
    scanSpacePluginsCounters: buildHotPathDiagnostics(
      scanSpacePluginsCounters,
      scanSpacePluginsWindowedCounters,
      { discoveredCounter: 'requests' },
    ),
    scanSpacesCounters: buildScanSpacesDiagnostics(
      scanSpacesCounters,
      scanSpacesWindowedCounters,
    ),
    // Stage 1 additive keys
    cadenceMs,
    blurState,
    gpuLifecycle,
    rendererCpuMsSinceLast,
    rendererSnapshot: ramSnapshot.rendererSnapshot,
    // Seams for future stages (stable shape; null-default)
    eventLoopDelay: deps.getEventLoopLag(),
    rendererPerfSummary: deps.getRendererPerfSummary(),
    superMcpLifecycle,
    superMcpChildStats: collectSuperMcpChildStats(deps.getSuperMcpStats, deps.logger),
    // REBEL-1HF: file-descriptor / handle snapshot for FD-pressure triage.
    fdSnapshot: collectFdSnapshot(deps.getFdSnapshot, deps.logger),
  };
}

/**
 * Internal helper: run one tick of the diagnostic. Exported for direct
 * invocation in integration-style tests (rather than waiting on the scheduler).
 *
 * Async because `buildPerfDiagnosticPayload` awaits the out-of-band
 * subprocess usage sampler (Stage 1 of 260424 follow-up).
 */
export async function runPerfDiagnosticTick(
  resolved: ResolvedPayloadDeps,
  opts: PerfDiagnosticDeps,
): Promise<void> {
  const mem = process.memoryUsage();

  // Stage 4b: kick off the next-tick /stats poll fire-and-forget BEFORE
  // building the payload. This tick reads whatever the previous tick's
  // fetch produced. `triggerSuperMcpStatsFetch` is a synchronous seam
  // that internally dispatches `void mgr.fetchStats().catch(...)`.
  const triggerStatsFetch = opts.triggerSuperMcpStatsFetch ?? defaultTriggerSuperMcpStatsFetch;
  try {
    triggerStatsFetch();
  } catch (err) {
    // Defense in depth — the default trigger can never throw synchronously,
    // but an injected seam could. Debug-log and continue.
    opts.logger.debug({ err }, 'perfDiagnostic: triggerSuperMcpStatsFetch threw');
  }

  // Build payload first — this also updates module-scoped CPU-delta state.
  const payload = await buildPerfDiagnosticPayload(resolved);

  // Dev-only: track memory history + analyze for leaks.
  const isDev = opts.isDev ?? !getIsPackaged();
  if (isDev) {
    const snapshot: MemorySnapshot = {
      timestamp: Date.now(),
      mainProcess: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
      },
      processes: payload.processes.map((p) => ({
        pid: p.pid,
        type: p.type,
        label: p.label,
        workingSetMB: p.workingSetMB,
      })),
    };
    memoryHistory.push(snapshot);
    if (memoryHistory.length > MAX_MEMORY_HISTORY) {
      memoryHistory.shift();
    }

    const analysis = analyzeMemoryTrend();
    if (analysis) {
      opts.logger.warn(
        {
          leakingProcesses: analysis.leaking.map((p) => p.label),
          sampleCount: memoryHistory.length,
          timeSpanMinutes: Math.round(
            (memoryHistory[memoryHistory.length - 1].timestamp - memoryHistory[0].timestamp) /
              60000,
          ),
        },
        `⚠️ MEMORY LEAK DETECTED - Sustained growth in: ${analysis.leaking
          .map((p) => p.label)
          .join(', ')}\n${analysis.report}`,
      );
    }
  }

  opts.logger.info(payload, 'Memory diagnostic');
  addFdSnapshotBreadcrumb(payload.fdSnapshot, opts.logger);

  const consumeAutoIncidentWatchdogSignal = opts.consumeAutoIncidentWatchdogSignal
    ?? consumePendingAutoIncidentWatchdogSignal;
  const watchdogSignal = consumeAutoIncidentWatchdogSignal();
  void maybeCaptureAutoIncident(payload, opts, watchdogSignal).catch((err) => {
    opts.logger.warn(
      {
        err,
        watchdogReason: watchdogSignal?.reason ?? null,
        stuckTurnId: watchdogSignal?.stuckTurnId ?? null,
      },
      'perfDiagnostic: detached auto incident capture crashed',
    );
  });

  // FD / handle snapshot — production-on, low overhead. Provides the
  // observability needed to verify the LanceDB read-table FD-leak fix
  // (see `docs-private/investigations/260428_emfile_fd_leak.md`) and to spot
  // future native-resource leaks before they cascade into EMFILE storms.
  // Cadence is implicitly the diagnostic tick cadence (5 min foreground /
  // 120 s blurred / minimized), which satisfies the "every 5 minutes (low
  // overhead)" requirement from the Phase 1 plan.
  //
  // MCP correlation: pass the super-mcp restart count (cheap to read from
  // the existing lifecycle accessor) so consumers can correlate handle
  // growth with subprocess churn without dragging Phase 2 work into this
  // PR. Phase 2 may extend with mcpClient reconnect counts / serverCount
  // / toolCount when those become reachable without new dependencies.
  emitFdSnapshot(opts.logger, {
    superMcpRestartCount: payload.superMcpLifecycle?.restartCount ?? null,
  }, payload.fdSnapshot);
  maybeCaptureFdPressureBand(payload.fdSnapshot, opts.logger);

  // REBEL_PERF_MODE=1: emit auxiliary lifecycle diagnostics (unchanged).
  const perfModeEnabled =
    opts.perfModeEnabled?.() ?? process.env.REBEL_PERF_MODE === '1';
  if (perfModeEnabled) {
    const embeddingLifecycle = opts.getEmbeddingLifecycleStats?.();
    if (embeddingLifecycle !== undefined) {
      opts.logger.info(
        { profilerChannel: 'embedding-lifecycle', embeddingLifecycle },
        'Embedding lifecycle diagnostic',
      );
    }
    const indexerStats = opts.getIndexerStats?.();
    if (indexerStats !== undefined) {
      opts.logger.info(
        { profilerChannel: 'perf-summary', indexerStats },
        'Indexer lifecycle diagnostic',
      );
    }
    const tombstoneStats = opts.getTombstoneStats?.();
    if (tombstoneStats !== undefined) {
      opts.logger.info(
        { profilerChannel: 'perf-summary', tombstoneStats },
        'Tombstone lifecycle diagnostic',
      );
    }
  }
}

// ── Internals ────────────────────────────────────────────────────────

interface WindowedDiagnosticCounter {
  rate5m: number;
  cumulative: number;
}

type GenericCounterRecord = Record<string, unknown>;

function asRecord(value: unknown): GenericCounterRecord | null {
  return typeof value === 'object' && value !== null ? value as GenericCounterRecord : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toWindowedCounter(
  cumulativeValue: unknown,
  windowedValue?: unknown,
): WindowedDiagnosticCounter {
  const windowedRecord = asRecord(windowedValue);
  const explicitCumulative = asNumber(cumulativeValue);
  const windowedCumulative = asNumber(windowedRecord?.cumulative);
  const rate5m = asNumber(windowedRecord?.rate5m) ?? 0;
  return {
    rate5m,
    cumulative: explicitCumulative ?? windowedCumulative ?? 0,
  };
}

function buildSettingsNormalizationDiagnostics(
  cumulativeStats: unknown,
  windowedStats: unknown,
): {
  calls: WindowedDiagnosticCounter;
  writes: WindowedDiagnosticCounter;
} {
  const cumulative = asRecord(cumulativeStats);
  const windowed = asRecord(windowedStats);
  return {
    calls: toWindowedCounter(cumulative?.calls, windowed?.calls),
    writes: toWindowedCounter(cumulative?.writes, windowed?.writes),
  };
}

function buildHotPathDiagnostics(
  cumulativeStats: unknown,
  windowedStats: unknown,
  options?: { discoveredCounter?: string },
): Record<string, unknown> | null {
  const cumulative = asRecord(cumulativeStats);
  const windowed = asRecord(windowedStats);
  if (!cumulative && !windowed) return null;

  const diagnostics = {
    requests: toWindowedCounter(cumulative?.requests, windowed?.requests),
    hits: toWindowedCounter(cumulative?.hits, windowed?.hits),
    misses: toWindowedCounter(cumulative?.misses, windowed?.misses),
    inflightJoins: toWindowedCounter(cumulative?.inflightJoins, windowed?.inflightJoins),
    underlyingFetches: toWindowedCounter(cumulative?.underlyingFetches, windowed?.underlyingFetches),
    fetchErrors: toWindowedCounter(cumulative?.fetchErrors, windowed?.fetchErrors),
    maxConcurrentInflight: toWindowedCounter(
      cumulative?.maxConcurrentInflight,
      windowed?.maxConcurrentInflight,
    ),
  };

  if (!options?.discoveredCounter) {
    return diagnostics;
  }

  return {
    ...diagnostics,
    discovered: {
      name: options.discoveredCounter,
      value: diagnostics[options.discoveredCounter as keyof typeof diagnostics] ?? null,
    },
  };
}

function buildScanSpacesDiagnostics(
  cumulativeStats: unknown,
  windowedStats: unknown,
): {
  readOnly: Record<string, WindowedDiagnosticCounter> | null;
  writable: Record<string, WindowedDiagnosticCounter> | null;
} | null {
  const cumulative = asRecord(cumulativeStats);
  const windowed = asRecord(windowedStats);

  const readOnly = buildHotPathDiagnostics(cumulative?.readOnly, windowed?.readOnly);
  const writable = buildHotPathDiagnostics(cumulative?.writable, windowed?.writable);

  if (!readOnly && !writable) return null;

  const readOnlyRecord = readOnly as Record<string, WindowedDiagnosticCounter> | null;
  const writableRecord = writable as Record<string, WindowedDiagnosticCounter> | null;

  return {
    readOnly: readOnlyRecord
      ? {
          ...readOnlyRecord,
          cacheHits: readOnlyRecord.hits,
          coalescedHits: readOnlyRecord.inflightJoins,
        }
      : null,
    writable: writableRecord
      ? {
          ...writableRecord,
          cacheHits: writableRecord.hits,
          coalescedHits: writableRecord.inflightJoins,
        }
      : null,
  };
}

function defaultIsAutoIncidentCaptureEnabled(): boolean {
  return process.env[AUTO_INCIDENT_CAPTURE_FLAG] === '1';
}

function readEventLoopP50Ms(eventLoopDelay: EventLoopLagSample | null): number | null {
  if (!eventLoopDelay || eventLoopDelay.status !== 'ok') {
    return null;
  }
  return eventLoopDelay.p50;
}

function readWritableScanRequestsRate5m(scanSpacesCounters: unknown): number | null {
  const counters = asRecord(scanSpacesCounters);
  const writable = asRecord(counters?.writable);
  const requests = asRecord(writable?.requests);
  return asNumber(requests?.rate5m);
}

async function rotateAutoIncidentRecords(incidentDir: string): Promise<void> {
  try {
    const files = await fs.readdir(incidentDir);
    const incidentFiles = files
      .filter((file) => file.startsWith('perf-incident-') && file.endsWith('.json') && !file.includes('.renderer-memory.'))
      .sort();

    if (incidentFiles.length <= AUTO_INCIDENT_MAX_RECORDS) {
      return;
    }

    const toDelete = incidentFiles.slice(0, incidentFiles.length - AUTO_INCIDENT_MAX_RECORDS);
    for (const file of toDelete) {
      await fs.unlink(path.join(incidentDir, file)).catch(() => {});
      const companion = file.replace(/\.json$/, '.renderer-memory.json');
      await fs.unlink(path.join(incidentDir, companion)).catch(() => {});
    }
  } catch (err) {
    perfDiagnosticDefaultLogger.debug({ err }, 'perfDiagnostic: failed to rotate auto-incident records');
  }
}

async function defaultCaptureAutoIncident(
  input: AutoIncidentCaptureInput,
): Promise<AutoIncidentCaptureResult> {
  const incidentDir = path.join(getDataPath(), 'perf-incidents');
  await fs.mkdir(incidentDir, { recursive: true });

  const fileSafeTimestamp = new Date(input.capturedAtMs).toISOString().replace(/[:.]/g, '-');
  const baseName = `perf-incident-${fileSafeTimestamp}`;

  const ramSnapshot = captureRamSnapshot();
  const rendererMemoryPath = path.join(incidentDir, `${baseName}.renderer-memory.json`);
  await fs.writeFile(
    rendererMemoryPath,
    JSON.stringify({
      capturedAtMs: input.capturedAtMs,
      rendererSnapshot: ramSnapshot.rendererSnapshot,
      mainProcess: ramSnapshot.mainProcess,
      totals: ramSnapshot.totals,
      registry: ramSnapshot.registry,
      powerSaveBlocker: ramSnapshot.powerSaveBlocker,
    }, null, 2),
  );

  let cpuProfilePath: string | null = null;
  try {
    const { captureOnDemand } = await import('./cpuProfilerService');
    cpuProfilePath = await captureOnDemand();
  } catch (err) {
    perfDiagnosticDefaultLogger.warn({ err }, 'perfDiagnostic: failed to capture on-demand CPU profile');
  }

  const incidentPath = path.join(incidentDir, `${baseName}.json`);
  await fs.writeFile(
    incidentPath,
    JSON.stringify({
      capturedAtMs: input.capturedAtMs,
      triggerReasons: input.triggerReasons,
      stressAlarmTriggerReasons: input.stressAlarmTriggerReasons,
      watchdog: {
        reason: input.watchdog.reason,
        stuckTurnId: input.watchdog.stuckTurnId,
        consumerId: input.watchdog.consumerId,
        observedAtMs: input.watchdog.observedAtMs,
        pauseDurationMs: input.watchdog.pauseDurationMs,
        turnIds: input.watchdog.turnIds,
      },
      thresholds: {
        eventLoopP50Ms: AUTO_INCIDENT_EVENT_LOOP_P50_THRESHOLD_MS,
        eventLoopSustainedMs: AUTO_INCIDENT_EVENT_LOOP_SUSTAINED_MS,
        writableScanRequestsRate5m: AUTO_INCIDENT_WRITABLE_SCAN_REQUESTS_RATE5M_THRESHOLD,
        throttleMs: AUTO_INCIDENT_CAPTURE_THROTTLE_MS,
      },
      observed: {
        eventLoopP50Ms: input.eventLoopP50Ms,
        writableScanRequestsRate5m: input.writableScanRequestsRate5m,
      },
      artifacts: {
        cpuProfilePath,
        rendererMemoryPath,
      },
      perfSummary: {
        totalCpuPercent: input.payload.totalCpuPercent,
        topCpuProcess: input.payload.topCpuProcess,
        eventLoopDelay: input.payload.eventLoopDelay,
        scanSpacesCounters: input.payload.scanSpacesCounters,
        settingsNormalization: input.payload.settingsNormalization,
        processes: input.payload.processes,
      },
    }, null, 2),
  );

  await rotateAutoIncidentRecords(incidentDir);

  return {
    incidentPath,
    rendererMemoryPath,
    cpuProfilePath,
  };
}

async function maybeCaptureAutoIncident(
  payload: PerfDiagnosticPayload,
  opts: PerfDiagnosticDeps,
  watchdogSignalCandidate: BackgroundConsumerWatchdogSignal | null,
): Promise<void> {
  const isEnabled = opts.isAutoIncidentCaptureEnabled?.() ?? defaultIsAutoIncidentCaptureEnabled();
  if (!isEnabled) {
    eventLoopLagBreachSinceMs = null;
    return;
  }

  const now = opts.nowMs?.() ?? Date.now();
  const eventLoopP50Ms = readEventLoopP50Ms(payload.eventLoopDelay);
  let eventLoopTrigger = false;
  if (eventLoopP50Ms !== null && eventLoopP50Ms > AUTO_INCIDENT_EVENT_LOOP_P50_THRESHOLD_MS) {
    if (eventLoopLagBreachSinceMs === null) {
      eventLoopLagBreachSinceMs = now;
    }
    eventLoopTrigger = now - eventLoopLagBreachSinceMs >= AUTO_INCIDENT_EVENT_LOOP_SUSTAINED_MS;
  } else {
    eventLoopLagBreachSinceMs = null;
  }

  const writableScanRequestsRate5m = readWritableScanRequestsRate5m(payload.scanSpacesCounters);
  const writableScanTrigger = writableScanRequestsRate5m !== null &&
    writableScanRequestsRate5m > AUTO_INCIDENT_WRITABLE_SCAN_REQUESTS_RATE5M_THRESHOLD;

  const stressAlarmTriggerReasons: StressAlarmTriggerReason[] = [];
  if (eventLoopTrigger) {
    stressAlarmTriggerReasons.push('event_loop_delay_sustained');
  }
  if (writableScanTrigger) {
    stressAlarmTriggerReasons.push('scan_spaces_writable_requests_rate5m');
  }
  if (stressAlarmTriggerReasons.length > 0) {
    opts.logger.warn(
      {
        profilerChannel: 'perf-stress-alarm',
        triggerReasons: stressAlarmTriggerReasons,
        eventLoopP50Ms,
        writableScanRequestsRate5m,
      },
      'perfDiagnostic: stress alarm triggered',
    );
  }

  const watchdogSignal = normalizeAutoIncidentWatchdogSignal(watchdogSignalCandidate);
  if (!watchdogSignal) {
    return;
  }

  const triggerReasons: AutoIncidentTriggerReason[] = [
    watchdogSignal.reason === 'stuck_active_turn_signal'
      ? 'watchdog_stuck_active_turn_signal'
      : 'watchdog_leaked_active_turn_signal',
  ];

  if (autoIncidentCaptureInFlight) {
    opts.logger.debug(
      { triggerReasons, watchdogReason: watchdogSignal.reason, stuckTurnId: watchdogSignal.stuckTurnId },
      'perfDiagnostic: auto-incident capture already in flight; skipping duplicate trigger',
    );
    return;
  }

  if (lastAutoIncidentCaptureAtMs !== null) {
    const sinceLastCaptureMs = now - lastAutoIncidentCaptureAtMs;
    if (sinceLastCaptureMs < AUTO_INCIDENT_CAPTURE_THROTTLE_MS) {
      opts.logger.debug(
        {
          triggerReasons,
          watchdogReason: watchdogSignal.reason,
          stuckTurnId: watchdogSignal.stuckTurnId,
          sinceLastCaptureMs,
          throttleRemainingMs: AUTO_INCIDENT_CAPTURE_THROTTLE_MS - sinceLastCaptureMs,
        },
        'perfDiagnostic: auto-incident capture throttled',
      );
      return;
    }
  }

  autoIncidentCaptureInFlight = true;
  lastAutoIncidentCaptureAtMs = now;
  const captureAutoIncident = opts.captureAutoIncident ?? defaultCaptureAutoIncident;
  try {
    const result = await captureAutoIncident({
      capturedAtMs: now,
      triggerReasons,
      stressAlarmTriggerReasons,
      watchdog: watchdogSignal,
      payload,
      eventLoopP50Ms,
      writableScanRequestsRate5m,
    });
    opts.logger.warn(
      {
        triggerReasons,
        stressAlarmTriggerReasons,
        watchdogReason: watchdogSignal.reason,
        stuckTurnId: watchdogSignal.stuckTurnId,
        watchdogConsumerId: watchdogSignal.consumerId,
        watchdogObservedAtMs: watchdogSignal.observedAtMs,
        eventLoopP50Ms,
        writableScanRequestsRate5m,
        incidentPath: result.incidentPath,
        rendererMemoryPath: result.rendererMemoryPath,
        cpuProfilePath: result.cpuProfilePath,
      },
      'perfDiagnostic: auto incident capture completed',
    );
  } catch (err) {
    opts.logger.warn(
      {
        err,
        triggerReasons,
        stressAlarmTriggerReasons,
        watchdogReason: watchdogSignal.reason,
        stuckTurnId: watchdogSignal.stuckTurnId,
        watchdogConsumerId: watchdogSignal.consumerId,
        watchdogObservedAtMs: watchdogSignal.observedAtMs,
        eventLoopP50Ms,
        writableScanRequestsRate5m,
      },
      'perfDiagnostic: auto incident capture failed',
    );
  } finally {
    autoIncidentCaptureInFlight = false;
  }
}

function resolveDeps(opts: PerfDiagnosticDeps): ResolvedPayloadDeps {
  const foregroundMs = opts.foregroundMs ?? MEMORY_LOG_INTERVAL_MS;
  const backgroundMs = opts.backgroundMs ?? MEMORY_LOG_BACKGROUND_INTERVAL_MS;

  return {
    getRamSnapshot: opts.getRamSnapshot ?? captureRamSnapshot,
    getAppMetrics: opts.getAppMetrics ?? defaultGetAppMetrics,
    getGpuLifecycle: opts.getGpuLifecycle ?? getGpuLifecycleMetrics,
    getVisibilityKind: opts.getVisibilityKind ?? defaultGetVisibilityKind,
    getRendererPerfSummary:
      opts.getRendererPerfSummary ?? (() => getLastRendererPerfSummary()),
    getEventLoopLag: opts.getEventLoopLag ?? (() => null),
    getSuperMcpLifecycle: opts.getSuperMcpLifecycle ?? (() => null),
    sampleSubprocessUsage: opts.sampleSubprocessUsage ?? defaultSampleSubprocessUsage,
    getSuperMcpStats: opts.getSuperMcpStats ?? defaultGetSuperMcpStats,
    getFdSnapshot: opts.getFdSnapshot ?? defaultGetFdSnapshot,
    getAutomationSchedulerStats: opts.getAutomationSchedulerStats ?? (() => null),
    getAgentTurnRegistryDiagnostics:
      opts.getAgentTurnRegistryDiagnostics ?? (() => agentTurnRegistry.getDiagnostics()),
    getSettingsNormalizationStats: opts.getSettingsNormalizationStats ?? (() => null),
    getSettingsNormalizationWindowedStats: opts.getSettingsNormalizationWindowedStats ?? (() => null),
    getIsKnownPluginCounters: opts.getIsKnownPluginCounters ?? (() => null),
    getScanSpacePluginsCounters: opts.getScanSpacePluginsCounters ?? (() => null),
    getScanSpacePluginsWindowedCounters: opts.getScanSpacePluginsWindowedCounters ?? (() => null),
    getScanSpacesCounters: opts.getScanSpacesCounters ?? (() => null),
    getScanSpacesWindowedCounters: opts.getScanSpacesWindowedCounters ?? (() => null),
    foregroundMs,
    backgroundMs,
    sleepMs: opts.sleepMs ?? defaultSleepMs,
    nowMs: opts.nowMs ?? Date.now,
    peakTracker: cpuPeakTracker,
    cpuDeltaStore,
    logger: opts.logger,
  };
}

/**
 * FU-5: default async delay used by the short-window instant CPU sample and
 * the peak-sampler timer gap. A `setTimeout`-based promise — NOT a busy loop —
 * so the ~1.5 s window between the two `getAppMetrics()` reads leaves the
 * main thread free.
 */
function defaultSleepMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * FU-5: default light recurring timer for the between-emit peak sampler. An
 * unref'd `setInterval` so it never keeps the process alive on its own.
 */
function defaultSchedulePeakSampler(
  cb: () => void | Promise<void>,
  intervalMs: number,
): () => void {
  const handle = setInterval(() => {
    void Promise.resolve(cb()).catch((err: unknown) => {
      // The peak-sampler callback already swallows + debug-logs its own
      // errors; this is belt-and-braces so a rejected promise never becomes
      // an unhandledRejection.
      ignoreBestEffortCleanup(err, {
        operation: 'perfDiagnostic.peakSamplerTimer',
        reason: 'callback rejected; already handled internally',
      });
    });
  }, intervalMs);
  // `unref` is available on Node timers (not in some test runtimes' fake
  // timer shims) — guard so this stays safe under vitest fake timers.
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as { unref: () => void }).unref();
  }
  return () => clearInterval(handle);
}

/**
 * FU-5: idle = no active agent turn. Used to gate the sustained-high-idle-CPU
 * warning (high CPU during a turn is expected work, not the idle hotspot).
 */
function isIdle(
  getAgentTurnRegistryDiagnostics: () => ReturnType<typeof agentTurnRegistry.getDiagnostics>,
): boolean {
  try {
    return getAgentTurnRegistryDiagnostics().turnCount === 0;
  } catch (err) {
    // If we can't read the registry, assume NOT idle so the sustained-high-idle-CPU
    // warning can't false-fire during an unobservable state.
    ignoreBestEffortCleanup(err, {
      operation: 'perfDiagnostic.isIdle',
      reason: 'assume-not-idle-when-agent-turn-registry-unreadable',
      owner: 'main.perfDiagnosticService',
    });
    return false;
  }
}

/**
 * FU-5: resolve the top instant-CPU processes for the warning log. Prefers the
 * labelled `processes[]` row joined by PID against the instant per-PID map
 * (richer label than the raw metric `type`); falls back to the raw instant
 * sample labels. Empty when no instant sample was available.
 */
function normalizePeakTopProcesses(
  topProcesses: readonly PeakCpuProcess[] | null,
): PeakCpuProcess[] {
  if (!topProcesses || topProcesses.length === 0) {
    return [];
  }

  return [...topProcesses]
    .filter((p) => Number.isFinite(p.pid) && Number.isFinite(p.cpuPercent) && p.cpuPercent > 0)
    .sort((a, b) => b.cpuPercent - a.cpuPercent)
    .slice(0, 3)
    .map((p) => ({
      label: p.label,
      pid: p.pid,
      cpuPercent: p.cpuPercent,
    }));
}

function resolveInstantTopProcesses(
  processes: PerfProcessSnapshot[],
  instantPerPid: Map<number, number>,
  instantSample: InstantCpuSample,
) : PeakCpuProcess[] {
  if (instantSample.status !== 'ok') {
    return [];
  }

  const rawLabelByPid = new Map(instantSample.topProcesses.map((p) => [p.pid, p.label]));
  const labelledByPid = new Map(processes.map((p) => [p.pid, p.label]));
  const joined = [...instantPerPid.entries()].map(([pid, cpuPercent]) => ({
    label: labelledByPid.get(pid) ?? rawLabelByPid.get(pid) ?? `pid:${pid}`,
    pid,
    cpuPercent,
  }));
  return normalizePeakTopProcesses(joined.length > 0 ? joined : instantSample.topProcesses);
}

/**
 * Default Stage 4b fire-and-forget trigger. `fetchStats()` is documented
 * to never reject, but `.catch` is still here as defence-in-depth so a
 * bug never propagates into the tick flow. S1 refinement: surface any
 * unexpected rejection at debug level — silent catches are a bug per
 * the fail-observable contract.
 */
function defaultTriggerSuperMcpStatsFetch(): void {
  void superMcpHttpManager.fetchStats().catch((err: unknown) => {
    perfDiagnosticDefaultLogger.debug(
      { err: String(err) },
      'perfDiagnostic: super-mcp stats fetch trigger threw',
    );
  });
}

/**
 * @internal exported for tests — see
 * `src/main/services/__tests__/perfDiagnosticService.test.ts`.
 * Default Stage 4b seam implementation: read the manager's cached /stats
 * snapshot and attach `stats_age_ms` / `last_good_age_ms` derived from
 * the manager's completion timestamps.
 *
 * Emission matrix:
 *  - manager running + cache present      → pass cache status through.
 *  - manager running + cache null         → `'unavailable'` (first tick).
 *  - manager NOT running + cache present  → `'stale'` (M2 refinement — a
 *      valid cache exists from the previous up-state; surface it for
 *      triage so operators can still see the last known children /
 *      router data).
 *  - manager NOT running + cache null     → `'unavailable'`.
 *
 * Per Stage 4b M1, the exit handler invalidates the cache — so under
 * normal teardown the second-from-last case only occurs briefly
 * (between `isRunning = false` in `stop()` and the exit event firing).
 * The emission contract stays honest either way.
 *
 * Never throws. Consumers get a stable-shape payload on every tick.
 */
export function defaultGetSuperMcpStats(): SuperMcpChildStatsEmission {
  try {
    const info = superMcpHttpManager.getSubprocessInfo();
    const cache = superMcpHttpManager.getLastStatsCache();
    const fetchAt = superMcpHttpManager.getLastStatsFetchAt();
    const goodAt = superMcpHttpManager.getLastGoodStatsAt();
    const now = Date.now();
    const statsAgeMs = fetchAt !== null ? Math.max(0, now - fetchAt) : null;
    const lastGoodAgeMs = goodAt !== null ? Math.max(0, now - goodAt) : null;

    if (!info.isRunning) {
      if (cache === null) {
        return { status: 'unavailable', stats_age_ms: null, last_good_age_ms: null };
      }
      // Preserve the cached payload but flag it as stale — operator can
      // still inspect last-known children / router while the subprocess
      // is down.
      return {
        status: 'stale',
        at: cache.at,
        ...(cache.payload !== undefined ? { payload: cache.payload } : {}),
        ...(cache.httpStatus !== undefined ? { httpStatus: cache.httpStatus } : {}),
        ...(cache.lastErr !== undefined ? { lastErr: cache.lastErr } : {}),
        stats_age_ms: statsAgeMs,
        last_good_age_ms: lastGoodAgeMs,
      };
    }

    if (cache === null) {
      return {
        status: 'unavailable',
        stats_age_ms: statsAgeMs,
        last_good_age_ms: lastGoodAgeMs,
      };
    }
    return {
      status: cache.status,
      at: cache.at,
      ...(cache.payload !== undefined ? { payload: cache.payload } : {}),
      ...(cache.httpStatus !== undefined ? { httpStatus: cache.httpStatus } : {}),
      ...(cache.lastErr !== undefined ? { lastErr: cache.lastErr } : {}),
      stats_age_ms: statsAgeMs,
      last_good_age_ms: lastGoodAgeMs,
    };
  } catch (err) {
    // Absolute defence in depth — shouldn't happen (all reads are pure
    // state access). S1 refinement: surface at debug level — the upstream
    // `collectSuperMcpChildStats` never sees this because we catch it
    // here, so we need our own breadcrumb.
    perfDiagnosticDefaultLogger.debug(
      { err: String(err) },
      'perfDiagnostic: super-mcp stats getter inner catch fired',
    );
    return { status: 'unavailable', stats_age_ms: null, last_good_age_ms: null };
  }
}

function defaultGetVisibilityKind(): VisibilityKind {
  const { isHidden, isHeadless } = getSchedulerVisibilityState();
  if (isHeadless) return 'focused';
  if (isHidden) return 'minimized';
  const { isBlurred } = getSchedulerBlurState();
  return isBlurred ? 'blurred' : 'focused';
}

/**
 * Stable per-process identifier for the FD snapshot stream. Generated once
 * at module init and reused for every emission so log consumers can group
 * snapshots by app launch (matters for trend analysis across restarts —
 * same activeHandles series across two different `launchId`s is two runs,
 * not one growing leak).
 *
 * Generated lazily so a test that imports the module and immediately
 * stubs `crypto.randomUUID` doesn't see this constant. Module-scope
 * non-`null` after the first `getModuleLaunchId()` call.
 */
let MODULE_LAUNCH_ID: string | null = null;
function getModuleLaunchId(): string {
  if (MODULE_LAUNCH_ID === null) {
    try {
      // crypto.randomUUID is available since Node 14.17 / 16.0; covers
      // every supported runtime. Fall back to a timestamp-based id if
      // the API is missing on a future bump that drops it.
      MODULE_LAUNCH_ID = (
        globalThis as unknown as { crypto?: { randomUUID?: () => string } }
      ).crypto?.randomUUID?.() ?? `launch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    } catch {
      MODULE_LAUNCH_ID = `launch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }
  return MODULE_LAUNCH_ID;
}

/**
 * Module-scope flag: have we already promoted the "both handle APIs
 * unavailable" log line to `warn`? After the first warn we drop further
 * occurrences to `info` to avoid log spam — the degraded path is now
 * observable in production-default log levels (the prior `debug`-only
 * emission was invisible on default-`info` log levels). One-shot reset
 * via `_resetPerfDiagnosticStateForTesting()`.
 */
let loggedDegradation = false;
/** Stage 3: once-per-escalation-band-per-process dedup latch. */
const emittedFdPressureBands = new Set<FdPressureBand>();

/**
 * MCP correlation dimensions for the FD snapshot. Kept as a separate
 * input to `captureFdSnapshot` so the helper stays a pure function: the
 * caller is responsible for fetching the data (cheap getters from
 * existing services) and passing it in.
 *
 * Fields:
 *  - `superMcpRestartCount`: from `superMcpHttpManager.getSubprocessInfo().restartCount`
 *    (subprocess restarts this process; the closest available signal to
 *    "MCP HTTP transport reconnects" without instrumenting `mcpClient.ts`).
 *  - `reconnectCount`, `serverCount`, `toolCount`: TODO — not currently
 *    reachable from `perfDiagnosticService` without a new dependency on
 *    `toolIndexService` / `mcpClient`. Defer until Phase 2 telemetry
 *    decides whether MCP is the residual leak source. The trend analysis
 *    on `activeHandles` / `activeResources` is the primary signal.
 */
export interface FdMcpCorrelation {
  superMcpRestartCount: number | null;
}

/**
 * Shape of a file-descriptor / handle snapshot, used by `captureFdSnapshot`
 * and emitted under the `'perf.fd_snapshot'` log line.
 *
 * Fields:
 *  - `activeHandles`: count from the private `process._getActiveHandles()`
 *    API — kept as a cross-check signal (not the primary). `null` when the
 *    API is unavailable in the runtime (e.g., a future Node bump that
 *    drops the private accessor).
 *  - `activeResources`: count from the public
 *    `process.getActiveResourcesInfo()` — primary signal. `null` when the
 *    API is unavailable.
 *  - `activeResourceTypes`: per-type breakdown from
 *    `getActiveResourcesInfo()` (e.g., `{ TCPSocketWrap: 3, ... }`). The
 *    raw array can be hundreds of entries on a leaking system; the type
 *    histogram captures the diagnostic signal at low log-line size. `null`
 *    when the API is unavailable.
 *  - `platform`: surfaced for cross-platform filtering (the EMFILE cascade
 *    is Windows-specific in our incident data).
 *  - `processUptimeSec`: `process.uptime()` rounded to int seconds. Lets
 *    consumers interpret a high handle count as "after 24 h uptime"
 *    rather than a fresh-boot blip.
 *  - `launchId`: stable per-process UUID. Lets consumers group snapshots
 *    by app launch — a series of growing handle counts under the same
 *    `launchId` is a leak; under different `launchId`s it's two runs.
 *  - `mcp`: cheap MCP correlation dimensions. See `FdMcpCorrelation`.
 *    Phase 2 may extend with `reconnectCount` / `serverCount` /
 *    `toolCount` if those become reachable without new deps.
 */
export interface FdSnapshot {
  activeHandles: number | null;
  activeResources: number | null;
  activeResourceTypes: Record<string, number> | null;
  platform: NodeJS.Platform;
  processUptimeSec: number;
  launchId: string;
  mcp: FdMcpCorrelation;
  fdSnapshotStatus?: PayloadFdSnapshot['status'];
  openFdCount?: number | null;
  maxFdNumber?: number | null;
  fdSnapshotError?: string | null;
  fdSnapshotReason?: string | null;
}

/**
 * Capture a one-shot snapshot of active handles + active async resources,
 * augmented with process uptime, launch UUID, and cheap MCP correlation
 * dimensions.
 *
 * Pure function (no logging). The `emitFdSnapshot` helper below wires it
 * into the diagnostic tick. Exported for tests + future ad-hoc callers.
 *
 * Cross-platform: both `_getActiveHandles` and `getActiveResourcesInfo` are
 * supported on macOS / Linux / Windows. `_getActiveHandles` is a private
 * API and could disappear in a future Node release — guard accordingly.
 *
 * @param mcp Cheap MCP correlation dims fetched by the caller. Defaults
 *   to all-null when not provided so the helper stays useful for ad-hoc
 *   diagnostic callers that don't have an MCP context.
 */
export function captureFdSnapshot(
  mcp: FdMcpCorrelation = { superMcpRestartCount: null },
): FdSnapshot {
  let activeHandles: number | null = null;
  let activeResources: number | null = null;
  let activeResourceTypes: Record<string, number> | null = null;

  // Cross-check signal: private `_getActiveHandles` returns the JS-visible
  // libuv handle list. Treat its absence as "degraded, keep going".
  const getActiveHandlesFn = (
    process as unknown as { _getActiveHandles?: () => unknown[] }
  )._getActiveHandles;
  if (typeof getActiveHandlesFn === 'function') {
    try {
      const handles = getActiveHandlesFn.call(process);
      if (Array.isArray(handles)) {
        activeHandles = handles.length;
      }
    } catch {
      // Stay silent here — the caller logs. We never want this helper to
      // throw and abort the tick.
      activeHandles = null;
    }
  }

  // Primary signal: stable public API since Node 17.3 / 16.14.
  if (typeof process.getActiveResourcesInfo === 'function') {
    try {
      const resources = process.getActiveResourcesInfo();
      if (Array.isArray(resources)) {
        activeResources = resources.length;
        const counts: Record<string, number> = {};
        for (const type of resources) {
          counts[type] = (counts[type] ?? 0) + 1;
        }
        activeResourceTypes = counts;
      }
    } catch {
      activeResources = null;
      activeResourceTypes = null;
    }
  }

  return {
    activeHandles,
    activeResources,
    activeResourceTypes,
    platform: process.platform,
    processUptimeSec: Math.round(process.uptime()),
    launchId: getModuleLaunchId(),
    mcp,
  };
}

/**
 * Emit an `'perf.fd_snapshot'` log line at `info` level. Production-on,
 * low overhead, no flag required.
 *
 * Degraded fallback: if both APIs are missing (`activeHandles` AND
 * `activeResources` are null) we promote the FIRST occurrence to `warn`
 * (so the degradation is visible at production-default log levels — the
 * prior `debug`-only emission was invisible) and demote subsequent
 * emissions to `info` to avoid spam. The silent-failure rule is still
 * satisfied: the entry IS emitted on every tick.
 *
 * @param mcp Cheap MCP correlation dims fetched by the caller (e.g. from
 *   `superMcpHttpManager.getSubprocessInfo().restartCount`). Defaults to
 *   all-null when not provided so the helper stays useful for ad-hoc
 *   diagnostic callers that don't have an MCP context.
 */
export function emitFdSnapshot(
  logger: Logger,
  mcp: FdMcpCorrelation = { superMcpRestartCount: null },
  fdSnapshot?: PayloadFdSnapshot,
): void {
  try {
    const snapshot = withFdSnapshotContext(captureFdSnapshot(mcp), fdSnapshot);
    if (snapshot.activeHandles === null && snapshot.activeResources === null) {
      // Degraded path: warn-once-then-info so the operator sees it without
      // log-spam on a runtime that simply doesn't expose the APIs.
      if (!loggedDegradation) {
        loggedDegradation = true;
        logger.warn(
          snapshot,
          'perf.fd_snapshot degraded — both handle APIs unavailable (subsequent ticks will log at info)',
        );
      } else {
        logger.info(snapshot, 'perf.fd_snapshot (degraded — both handle APIs unavailable)');
      }
      return;
    }
    logger.info(snapshot, 'perf.fd_snapshot');
  } catch (err) {
    // Defensive: captureFdSnapshot is contractually non-throwing, but a
    // bug must surface rather than silently break the diagnostic.
    logger.warn({ err }, 'perf.fd_snapshot emission failed');
  }
}

function withFdSnapshotContext(
  snapshot: FdSnapshot,
  fdSnapshot?: PayloadFdSnapshot,
): FdSnapshot {
  if (!fdSnapshot) {
    return snapshot;
  }
  if (fdSnapshot.status === 'posix') {
    return {
      ...snapshot,
      fdSnapshotStatus: 'posix',
      openFdCount: fdSnapshot.openFdCount,
      maxFdNumber: fdSnapshot.maxFdNumber,
      fdSnapshotError: null,
      fdSnapshotReason: null,
    };
  }
  if (fdSnapshot.status === 'unsupported') {
    return {
      ...snapshot,
      fdSnapshotStatus: 'unsupported',
      openFdCount: null,
      maxFdNumber: null,
      fdSnapshotError: null,
      fdSnapshotReason: fdSnapshot.reason,
    };
  }
  return {
    ...snapshot,
    fdSnapshotStatus: 'unavailable',
    openFdCount: null,
    maxFdNumber: null,
    fdSnapshotError: fdSnapshot.error,
    fdSnapshotReason: null,
  };
}

function topResourceTypes(
  activeResourceTypes: Record<string, number>,
  limit: number,
): Record<string, number> {
  if (limit <= 0) return {};
  const sorted = Object.entries(activeResourceTypes)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  return Object.fromEntries(sorted);
}

function addFdSnapshotBreadcrumb(
  fdSnapshot: PayloadFdSnapshot,
  logger: Logger,
): void {
  try {
    if (fdSnapshot.status === 'posix') {
      getErrorReporter().addBreadcrumb({
        category: 'perf.fd_snapshot',
        message: 'perf.fd_snapshot',
        level: 'info',
        data: {
          status: fdSnapshot.status,
          openFdCount: fdSnapshot.openFdCount,
          maxFdNumber: fdSnapshot.maxFdNumber,
          activeHandleCount: fdSnapshot.activeHandleCount,
          activeRequestCount: fdSnapshot.activeRequestCount,
          topActiveResourceTypes: topResourceTypes(fdSnapshot.activeResourceTypes, 3),
        },
      });
      return;
    }

    if (fdSnapshot.status === 'unsupported') {
      getErrorReporter().addBreadcrumb({
        category: 'perf.fd_snapshot',
        message: 'perf.fd_snapshot',
        level: 'info',
        data: {
          status: fdSnapshot.status,
          reason: fdSnapshot.reason,
        },
      });
      return;
    }

    getErrorReporter().addBreadcrumb({
      category: 'perf.fd_snapshot',
      message: 'perf.fd_snapshot',
      level: 'warning',
      data: {
        status: fdSnapshot.status,
      },
    });
  } catch (err) {
    logger.debug({ err }, 'perfDiagnostic: fd snapshot breadcrumb emit failed');
  }
}

function maybeCaptureFdPressureBand(
  fdSnapshot: PayloadFdSnapshot,
  logger: Logger,
): void {
  if (fdSnapshot.status !== 'posix') {
    return;
  }

  const openFileSoftLimit = getCachedOpenFileSoftLimit();
  const assessment = assessFdPressureBand({
    platform: process.platform,
    openFdCount: fdSnapshot.openFdCount,
    maxFdNumber: fdSnapshot.maxFdNumber,
    softLimit: openFileSoftLimit,
  });
  const nextBand = selectNextFdPressureBand({
    assessment,
    seenBands: emittedFdPressureBands,
  });
  if (nextBand === null) {
    return;
  }
  emittedFdPressureBands.add(nextBand.band);

  const condition = nextBand.band === 90
    ? 'fd_pressure_critical'
    : 'fd_pressure_elevated';
  const isCritical = nextBand.band === 90;
  const extra = {
    band: nextBand.band,
    triggerAxes: nextBand.triggerAxes,
    countAxisRatio: nextBand.countAxisRatio,
    numberAxisRatio: nextBand.numberAxisRatio,
    openFdCount: fdSnapshot.openFdCount,
    maxFdNumber: fdSnapshot.maxFdNumber,
    openFileSoftLimit,
    openMaxLimit: process.platform === 'darwin' ? DARWIN_OPEN_MAX_FD : null,
    activeHandleCount: fdSnapshot.activeHandleCount,
    activeRequestCount: fdSnapshot.activeRequestCount,
    activeResourceCount: fdSnapshot.activeResourceCount,
    topActiveResourceTypes: topResourceTypes(fdSnapshot.activeResourceTypes, 5),
  };

  if (isCritical) {
    logger.warn(
      {
        condition,
        ...extra,
      },
      'perfDiagnostic: fd pressure critical band reached',
    );
  } else {
    logger.info(
      {
        condition,
        ...extra,
      },
      'perfDiagnostic: fd pressure elevated band reached',
    );
  }

  try {
    getErrorReporter().addBreadcrumb({
      category: 'perf.fd_pressure',
      message: condition,
      level: isCritical ? 'warning' : 'info',
      data: {
        band: nextBand.band,
        triggerAxes: nextBand.triggerAxes,
        openFdCount: fdSnapshot.openFdCount,
        maxFdNumber: fdSnapshot.maxFdNumber,
      },
    });
  } catch (err) {
    logger.debug({ err }, 'perfDiagnostic: fd pressure breadcrumb emit failed');
  }

  const error = new Error(`fd pressure ${nextBand.band}% band reached`);
  if (isCritical) {
    captureKnownCondition('fd_pressure_critical', { extra }, error);
    return;
  }
  captureKnownCondition('fd_pressure_elevated', { extra }, error);
}

function defaultGetAppMetrics(): ProcessMetric[] {
  // Use lazy Electron accessor so this module stays safe to import in tests /
  // cloud contexts. In the packaged app this resolves to the real Electron
  // module after app-ready (guaranteed at `startPerfDiagnostic()` call time).
  const electron = getElectronModule();
  if (!electron) return [];
  return electron.app.getAppMetrics();
}

function getIsPackaged(): boolean {
  const electron = getElectronModule();
  return electron?.app.isPackaged === true;
}

function safeGetAppMetrics(
  provider: () => ProcessMetric[],
  logger: Logger,
): ProcessMetric[] {
  try {
    return provider();
  } catch (err) {
    // Non-fatal: fall back to empty metrics. Missing cumulativeCPUUsage will
    // surface as `cpuMsSinceLast: null` rather than silently as 0.
    logger.warn({ err }, 'perfDiagnostic: getAppMetrics failed');
    return [];
  }
}

function computeCpuMsSinceLast(
  pid: number,
  cpuPercent: number,
  cumulativeCpuSec: number | undefined,
  cadenceMs: number,
  store: Map<number, number>,
): number | null {
  // Preferred: cumulativeCPUUsage delta (seconds) × 1000.
  if (typeof cumulativeCpuSec === 'number' && Number.isFinite(cumulativeCpuSec)) {
    const prev = store.get(pid);
    store.set(pid, cumulativeCpuSec);
    if (prev === undefined) {
      // First tick for this PID — no previous reference point.
      return null;
    }
    const deltaSec = cumulativeCpuSec - prev;
    if (!Number.isFinite(deltaSec) || deltaSec < 0) {
      // Negative / NaN deltas (process restart, clock glitch) — don't pretend
      // to know. Surface as null.
      return null;
    }
    return Math.round(deltaSec * 1000);
  }

  // Fallback: cpuPercent × cadenceMs / 100. Use the store to distinguish
  // first-observation (null) from subsequent ticks.
  if (!store.has(pid)) {
    // Use NaN as a sentinel in the store so we can still detect 'known' PIDs
    // without overwriting a real cumulativeCpu value. We only write NaN when
    // cumulativeCpu is absent; next call will read it and proceed.
    store.set(pid, Number.NaN);
    return null;
  }
  return Math.round((cpuPercent * cadenceMs) / 100);
}

function collectGpuLifecycle(
  getter: () => {
    blurDisposalCount: number;
    focusWarmUpCount: number;
    lastBlurDisposalAt: number | null;
    lastFocusWarmUpAt: number | null;
  },
  logger: Logger,
): GpuLifecyclePayload {
  try {
    const m = getter();
    if (
      m == null ||
      typeof m.blurDisposalCount !== 'number' ||
      typeof m.focusWarmUpCount !== 'number'
    ) {
      logger.warn(
        { metrics: m },
        'perfDiagnostic: GPU lifecycle metrics unavailable (missing or malformed)',
      );
      return {
        status: 'unavailable',
        error: 'GPU lifecycle metrics missing or malformed',
      };
    }
    return {
      status: 'ok',
      blurDisposalCount: m.blurDisposalCount,
      focusWarmUpCount: m.focusWarmUpCount,
      lastBlurDisposalAt: m.lastBlurDisposalAt,
      lastFocusWarmUpAt: m.lastFocusWarmUpAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'perfDiagnostic: GPU lifecycle metrics getter threw');
    return { status: 'unavailable', error: msg };
  }
}

/**
 * Fail-observable wrapper around the super-mcp lifecycle getter (Stage 4a).
 *
 * - Returns the provider's result as-is when the getter succeeds.
 * - Catches and downgrades a thrown error to `null` + a single warn log,
 *   preserving the Stage 1–2 contract that the diagnostic tick never aborts
 *   on a provider failure.
 * - Null-return from the provider (e.g., not wired) passes through as `null`
 *   so `superMcpLifecycle: null` is stable regardless of cause.
 */
function collectSuperMcpLifecycle(
  getter: () => SuperMcpSubprocessInfo | null,
  logger: Logger,
): SuperMcpSubprocessInfo | null {
  try {
    return getter();
  } catch (err) {
    logger.warn({ err }, 'perfDiagnostic: super-mcp lifecycle getter threw');
    return null;
  }
}

/**
 * Fail-observable wrapper around the FD snapshot getter (REBEL-1HF). The
 * default sampler is contractually never-throw, but we wrap here as
 * defence-in-depth so an injected seam (test, future variant) that throws
 * can't abort the diagnostic tick. A thrown sampler maps to
 * `{ status: 'unavailable', error }` so the payload always carries the
 * field.
 */
function collectFdSnapshot(
  getter: () => PayloadFdSnapshot,
  logger: Logger,
): PayloadFdSnapshot {
  try {
    return getter();
  } catch (err) {
    logger.warn({ err }, 'perfDiagnostic: fdSnapshot getter threw');
    return {
      status: 'unavailable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Default FD/handle snapshot sampler — REBEL-1HF.
 *
 * Per-platform behaviour:
 *
 * - darwin/linux: read raw FD pressure from `readFdPressure()` using the
 *   platform-native directory (`/dev/fd` or `/proc/self/fd`) and add
 *   libuv/resource counters for context.
 * - win32: explicit `unsupported` (no raw user-mode fd enumeration in Node
 *   without native modules). Windows pressure remains observable through the
 *   existing handle/resource snapshots (`perf.fd_snapshot`) and graceful-fs
 *   EMFILE telemetry.
 *
 * Never throws. Any failure maps to `{ status: 'unavailable', error }`.
 *
 * @internal Exported for tests so the default impl can be exercised end-to-end.
 */
export function defaultGetFdSnapshot(): PayloadFdSnapshot {
  try {
    const pressure = readFdPressure();
    if (pressure.status === 'ok') {
      const { activeHandleCount, activeRequestCount } = readLibUvCounts();
      const { activeResourceCount, activeResourceTypes } = readActiveResourceCounts();
      return {
        status: 'posix',
        openFdCount: pressure.openFdCount,
        maxFdNumber: pressure.maxFdNumber,
        activeHandleCount,
        activeRequestCount,
        activeResourceCount,
        activeResourceTypes,
      };
    }
    if (pressure.status === 'unsupported') {
      return {
        status: 'unsupported',
        reason: pressure.reason,
      };
    }
    return {
      status: 'unavailable',
      error: pressure.error,
    };
  } catch (err) {
    return {
      status: 'unavailable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read libuv handle / request counts via the `process._getActive*` APIs.
 * These are internal Node functions but they've been stable for years and
 * are widely used by handle-leak diagnostic tools. Returns zeros if the
 * APIs are missing for any reason.
 */
function readLibUvCounts(): { activeHandleCount: number; activeRequestCount: number } {
  const proc = process as unknown as {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };
  let activeHandleCount = 0;
  let activeRequestCount = 0;
  try {
    activeHandleCount = proc._getActiveHandles?.().length ?? 0;
  } catch {
    activeHandleCount = 0;
  }
  try {
    activeRequestCount = proc._getActiveRequests?.().length ?? 0;
  } catch {
    activeRequestCount = 0;
  }
  return { activeHandleCount, activeRequestCount };
}

/**
 * Read active-resource counts from `process.getActiveResourcesInfo()`.
 *
 * Returns zeros / empty map if the API is absent or throws.
 */
function readActiveResourceCounts(): {
  activeResourceCount: number;
  activeResourceTypes: Record<string, number>;
} {
  let activeResourceCount = 0;
  let activeResourceTypes: Record<string, number> = {};
  try {
    const proc = process as unknown as {
      getActiveResourcesInfo?: () => string[];
    };
    const resources = proc.getActiveResourcesInfo?.();
    if (Array.isArray(resources)) {
      activeResourceCount = resources.length;
      activeResourceTypes = resources.reduce<Record<string, number>>(
        (acc, label) => {
          if (typeof label === 'string') {
            acc[label] = (acc[label] ?? 0) + 1;
          }
          return acc;
        },
        {},
      );
    }
  } catch {
    activeResourceCount = 0;
    activeResourceTypes = {};
  }
  return { activeResourceCount, activeResourceTypes };
}

/**
 * Fail-observable wrapper around the Stage 1 subprocess usage sampler
 * (260424 follow-up). The sampler contract is already never-throw, but we
 * wrap here as defence-in-depth so a bug in an injected seam can't abort
 * the tick. A thrown sampler maps to `status: 'error'` + logged warn.
 */
async function collectSubprocessUsage(
  sampler: SampleSubprocessUsage,
  pid: number,
  logger: Logger,
): Promise<SubprocessUsageSample> {
  try {
    return await sampler(pid);
  } catch (err) {
    logger.warn({ err, pid }, 'perfDiagnostic: sampleSubprocessUsage threw');
    return { cpuPercent: null, workingSetMB: null, status: 'error' };
  }
}

/**
 * Default Stage 1 subprocess usage sampler (260424 follow-up). Wraps the
 * `pidusage(pid)` promise API in a 1 s AbortController so a Windows `wmic`
 * stall can't block the diagnostic tick. Maps known error classes to their
 * status discriminants:
 *
 *  - AbortController timeout  → `status: 'timeout'`
 *  - ENOENT / ESRCH / "No matching pid" (POSIX)             → `status: 'unavailable'`
 *  - ERROR_INVALID_PARAMETER / errno 87 (Windows)           → `status: 'unavailable'`
 *  - EPERM (POSIX — subprocess gone OR briefly elevated)    → `status: 'unavailable'`
 *      EPERM is ambiguous: either the target PID briefly disappeared, OR
 *      we lost permission to read it (e.g. super-mcp transiently elevated).
 *      Both produce the same "can't sample right now" operator signal; we
 *      map to 'unavailable' rather than 'error' so transient permission
 *      denials don't look like sampler bugs. Persistent EPERM surfaces via
 *      the S4 "10 consecutive unavailable" streak warning.
 *  - Malformed stat (NaN / non-number cpu or memory, or negative values)
 *                                                          → `status: 'error'` + warn
 *  - Anything else                                          → `status: 'error'` (logged at warn)
 *
 * pidusage v4 returns `Promise<Stat>` when no callback is provided. Its
 * `.cpu` is a percentage (0–100 × vcore); `.memory` is bytes.
 *
 * **CPU % semantics** (Stage 1 refinement M1):
 * pidusage computes CPU as `(currentCumulativeCpuMs − previousCumulativeCpuMs) / elapsedWallTime`
 * only when a previous sample exists in its internal cache within `maxage`.
 * The library default `maxage` is 60 s; our diagnostic cadence is 5 min
 * foreground / 120 s blurred — so at the default every tick the previous
 * sample has already expired and pidusage silently falls back to *lifetime
 * average CPU since process start*. We pass `maxage: 10 * 60 * 1000` (10
 * minutes) so both cadences stay inside the window and the returned `.cpu`
 * is a true interval delta.
 *
 * **PID-reset guard**: when super-mcp's PID changes between ticks (restart),
 * we call `pidusage.clear(previousPid)` before sampling the new PID. This
 * prevents pidusage's internal bookkeeping from carrying stale history for
 * a defunct PID — especially relevant on Windows where pidusage spawns a
 * long-lived `wmic`/`Get-Process` worker.
 *
 * @internal Exported for tests so the default impl can be exercised end-to-end.
 */
export async function defaultSampleSubprocessUsage(
  pid: number,
): Promise<SubprocessUsageSample> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1000);
  try {
    const pidusage = (await import('pidusage')).default;

    // M1 (PID-reset guard): if super-mcp restarted with a new PID between
    // ticks, purge pidusage's internal cache so the first sample of the new
    // PID doesn't see stale history from the defunct one. pidusage's real
    // `clear()` API (as of v4) takes no arguments and wipes the entire
    // per-PID history map — there is no per-PID variant in the library.
    // This is fine for our usage because the ONLY PID we sample via this
    // path is super-mcp's, so "clear everything" == "clear super-mcp's old
    // entry". `pidusage.clear` is documented as non-throwing; belt-and-
    // braces catch remains as defence in depth.
    if (lastSampledPid !== null && lastSampledPid !== pid) {
      try {
        pidusage.clear();
      } catch (clearErr) {
        perfDiagnosticDefaultLogger.debug(
          { err: clearErr, previousPid: lastSampledPid, pid },
          'perfDiagnostic: pidusage.clear() threw on PID reset',
        );
      }
    }

    // Race the pidusage promise against the abort signal. pidusage v4 has no
    // native AbortController support, so we wrap its promise and reject on
    // abort. The underlying `ps` / `wmic` / `/proc` read still completes
    // (no kill), but the diagnostic tick proceeds without waiting for it.
    //
    // M1 (maxage): pass `10 * 60 * 1000` so the 5 min / 120 s cadences
    // produce interval-delta CPU %, not lifetime-average fallback. See
    // the JSDoc "CPU % semantics" note above.
    const abortedPromise = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(new Error('pidusage sample aborted (timeout)'));
        return;
      }
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error('pidusage sample aborted (timeout)')),
        { once: true },
      );
    });
    const stat = await Promise.race([
      pidusage(pid, { maxage: 10 * 60 * 1000 }),
      abortedPromise,
    ]);

    // S1: malformed-stat NaN guard. pidusage is documented to always
    // return finite, non-negative numbers — but a bad OS-specific fallback
    // (Windows `Get-Process`, `ps` on exotic platforms) could surface NaN
    // / -1 / string. Treat as sampler failure rather than emitting
    // garbage numbers up into the log payload.
    if (
      stat == null ||
      typeof stat.cpu !== 'number' ||
      !Number.isFinite(stat.cpu) ||
      stat.cpu < 0 ||
      typeof stat.memory !== 'number' ||
      !Number.isFinite(stat.memory) ||
      stat.memory < 0
    ) {
      perfDiagnosticDefaultLogger.warn(
        { stat, pid },
        'perfDiagnostic: pidusage returned malformed stat; mapped to status:error',
      );
      return { cpuPercent: null, workingSetMB: null, status: 'error' };
    }

    return {
      cpuPercent: Math.round(stat.cpu * 10) / 10,
      workingSetMB: Math.round(stat.memory / 1024 / 1024),
      status: 'ok',
    };
  } catch (err) {
    if (controller.signal.aborted) {
      return { cpuPercent: null, workingSetMB: null, status: 'timeout' };
    }
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const errno = (err as NodeJS.ErrnoException | undefined)?.errno;
    const message = err instanceof Error ? err.message : String(err);
    // M2 expanded error-code coverage:
    //   POSIX      — ENOENT / ESRCH (process gone), EPERM (gone OR denied)
    //   Windows    — ERROR_INVALID_PARAMETER / errno 87 (PID invalid)
    //   pidusage   — "No matching pid" thrown from its own PID validation
    if (
      code === 'ENOENT' ||
      code === 'ESRCH' ||
      code === 'EPERM' ||
      code === 'ERROR_INVALID_PARAMETER' ||
      errno === 87 ||
      message.includes('No matching pid')
    ) {
      // Subprocess vanished (or we briefly lost permission) between the
      // lifecycle snapshot and this sample — normal observable state on
      // restart, not a sampler failure.
      return { cpuPercent: null, workingSetMB: null, status: 'unavailable' };
    }
    perfDiagnosticDefaultLogger.warn(
      { err, pid },
      'perfDiagnostic: pidusage sampler threw',
    );
    return { cpuPercent: null, workingSetMB: null, status: 'error' };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fail-observable wrapper around the super-mcp /stats getter (Stage 4b).
 *
 * - Returns the getter's result verbatim when it succeeds.
 * - On throw, logs a warn and returns a defensive `{ status: 'unavailable' }`
 *   so every payload still carries the `superMcpChildStats` field
 *   (per the Stage 1 "payload never omits" contract).
 */
function collectSuperMcpChildStats(
  getter: () => SuperMcpChildStatsEmission,
  logger: Logger,
): SuperMcpChildStatsEmission {
  try {
    return getter();
  } catch (err) {
    logger.warn({ err }, 'perfDiagnostic: super-mcp stats getter threw');
    return { status: 'unavailable', stats_age_ms: null, last_good_age_ms: null };
  }
}

/**
 * Dev-only: analyse memory history for sustained growth patterns.
 * Preserved from the pre-extraction inline diagnostic.
 */
export function analyzeMemoryTrend(
  history: MemorySnapshot[] = memoryHistory,
): { leaking: ProcessMemorySnapshot[]; report: string } | null {
  if (history.length < 4) return null; // Need at least 4 samples (20 min)

  const oldest = history[0];
  const newest = history[history.length - 1];
  const timeDeltaHours = (newest.timestamp - oldest.timestamp) / (1000 * 60 * 60);
  if (timeDeltaHours < 0.25) return null; // Need at least 15 min of data

  const leaking: ProcessMemorySnapshot[] = [];
  const reportLines: string[] = [];

  for (const newestProc of newest.processes) {
    const oldestProc = oldest.processes.find((p) => p.label === newestProc.label);
    if (!oldestProc) continue;

    const growthMB = newestProc.workingSetMB - oldestProc.workingSetMB;
    const growthRatePerHour = growthMB / timeDeltaHours;

    // Consecutive-growth check: walk back from newest, count streak.
    let consecutiveIncreases = 0;
    for (let i = history.length - 1; i > 0; i--) {
      const prev = history[i - 1].processes.find((p) => p.label === newestProc.label);
      const curr = history[i].processes.find((p) => p.label === newestProc.label);
      if (prev && curr && curr.workingSetMB > prev.workingSetMB) {
        consecutiveIncreases++;
      } else {
        break;
      }
    }

    const isLeaking =
      growthMB > LEAK_GROWTH_THRESHOLD_MB &&
      growthRatePerHour > LEAK_GROWTH_RATE_MB_PER_HOUR &&
      consecutiveIncreases >= LEAK_CONSECUTIVE_THRESHOLD;

    if (isLeaking) {
      leaking.push(newestProc);
      reportLines.push(
        `  ${newestProc.label}: ${oldestProc.workingSetMB}MB -> ${newestProc.workingSetMB}MB ` +
          `(+${Math.round(growthMB)}MB, ${Math.round(growthRatePerHour)}MB/hr)`,
      );
    }
  }

  if (leaking.length === 0) return null;
  return { leaking, report: reportLines.join('\n') };
}

// ── Test-only accessors (prefixed with `_`) ──────────────────────────

/** @internal Test-only: clear module state between tests. */
export function _resetPerfDiagnosticStateForTesting(): void {
  memoryHistory.length = 0;
  cpuDeltaStore.clear();
  // Stage 1 refinement (260424): also reset the subprocess-usage sampler's
  // cross-tick state so test ordering can't leak through.
  lastSampledPid = null;
  lastSampleStatus = null;
  consecutiveUnavailableCount = 0;
  persistentUnavailableWarned = false;
  eventLoopLagBreachSinceMs = null;
  lastAutoIncidentCaptureAtMs = null;
  autoIncidentCaptureInFlight = false;
  pendingAutoIncidentWatchdogSignal = null;
  // EMFILE Phase 1 review fix-up: reset FD-snapshot module-scope state so
  // the warn-once degraded-path flag is clean between tests, and the
  // launch UUID can be re-derived (some tests stub crypto.randomUUID).
  loggedDegradation = false;
  MODULE_LAUNCH_ID = null;
  emittedFdPressureBands.clear();
  _resetFdPressureStateForTesting();
  // FU-5: reset the shared CPU peak tracker (peak + idle streak + throttle).
  cpuPeakTracker._resetForTesting();
}
